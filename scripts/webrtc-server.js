#!/usr/bin/env node
/**
 * WebRTC signaling server for low-latency streaming from FreeShow Remote app.
 * Run: npm run webrtc-server
 *
 * This server handles WebRTC signaling (SDP exchange) for peer-to-peer video streaming.
 * Expected latency: 100-300ms (much better than RTMP!)
 */

const http = require('http');
const WebSocket = require('ws');
const os = require('os');
const path = require('path');
const fs = require('fs');

const SIGNALING_PORT = 8080;
const HTTP_PORT = 8082; // Changed from 8081 to avoid conflict with Metro bundler

// Store active connections
const connections = new Map();

// WebSocket server for signaling
const wss = new WebSocket.Server({ 
  port: SIGNALING_PORT,
  perMessageDeflate: false // Disable compression for lower latency
});

wss.on('error', (error) => {
  console.error('[WebRTC] WebSocket server error:', error);
});

wss.on('listening', () => {
  console.log(`[WebRTC] WebSocket server listening on port ${SIGNALING_PORT}`);
});

wss.on('connection', (ws, req) => {
  const clientId = `${Date.now()}-${Math.random()}`;
  console.log(`[WebRTC] Client connected: ${clientId} from ${req.socket.remoteAddress}`);
  
  connections.set(clientId, { ws, type: null, peerId: null });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log(`[WebRTC] Message from ${clientId}:`, data.type);

      switch (data.type) {
        case 'offer':
          // Phone is sending offer - forward to viewer
          handleOffer(clientId, data);
          break;
        case 'answer':
          // Viewer is sending answer - forward to phone
          handleAnswer(clientId, data);
          break;
        case 'ice-candidate':
          // ICE candidate - forward to peer
          handleIceCandidate(clientId, data);
          break;
        case 'register':
          // Client registering as phone or viewer
          handleRegister(clientId, data);
          break;
      }
    } catch (error) {
      console.error('[WebRTC] Error handling message:', error);
    }
  });

  ws.on('close', () => {
    console.log(`[WebRTC] Client disconnected: ${clientId}`);
    const conn = connections.get(clientId);
    if (conn && conn.peerId) {
      const peer = connections.get(conn.peerId);
      if (peer) {
        peer.ws.send(JSON.stringify({ type: 'peer-disconnected' }));
      }
    }
    connections.delete(clientId);
  });

  ws.on('error', (error) => {
    console.error(`[WebRTC] WebSocket error for ${clientId}:`, error);
  });
});

function handleRegister(clientId, data) {
  const conn = connections.get(clientId);
  if (!conn) return;

  conn.type = data.role; // 'phone' or 'viewer'
  console.log(`[WebRTC] ${clientId} registered as ${data.role}`);

  // If phone connects, notify any waiting viewers
  if (data.role === 'phone') {
    connections.forEach((peer, peerId) => {
      if (peer.type === 'viewer' && peerId !== clientId) {
        peer.ws.send(JSON.stringify({ type: 'phone-ready' }));
      }
    });
  }

  // If viewer connects, notify phone
  if (data.role === 'viewer') {
    connections.forEach((peer, peerId) => {
      if (peer.type === 'phone' && peerId !== clientId) {
        peer.ws.send(JSON.stringify({ type: 'viewer-ready' }));
      }
    });
  }
}

function handleOffer(clientId, data) {
  const conn = connections.get(clientId);
  if (!conn || conn.type !== 'phone') return;

  // Find a viewer to send the offer to
  connections.forEach((peer, peerId) => {
    if (peer.type === 'viewer' && peerId !== clientId) {
      conn.peerId = peerId;
      peer.peerId = clientId;
      peer.ws.send(JSON.stringify({
        type: 'offer',
        sdp: data.sdp,
        from: clientId,
      }));
      console.log(`[WebRTC] Forwarded offer from phone to viewer`);
    }
  });
}

function handleAnswer(clientId, data) {
  const conn = connections.get(clientId);
  if (!conn || conn.type !== 'viewer') return;

  // Send answer back to phone
  if (conn.peerId) {
    const phone = connections.get(conn.peerId);
    if (phone) {
      phone.ws.send(JSON.stringify({
        type: 'answer',
        sdp: data.sdp,
        from: clientId,
      }));
      console.log(`[WebRTC] Forwarded answer from viewer to phone`);
    }
  }
}

function handleIceCandidate(clientId, data) {
  const conn = connections.get(clientId);
  if (!conn || !conn.peerId) return;

  const peer = connections.get(conn.peerId);
  if (peer) {
    peer.ws.send(JSON.stringify({
      type: 'ice-candidate',
      candidate: data.candidate,
      from: clientId,
    }));
  }
}

// HTTP server for viewer page
const httpServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/viewer.html') {
    const viewerHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>WebRTC Stream Viewer</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      padding: 20px;
      background: #000;
      color: #fff;
      font-family: Arial, sans-serif;
    }
    video {
      width: 100%;
      max-width: 1280px;
      height: auto;
      background: #111;
    }
    .status {
      margin: 10px 0;
      padding: 10px;
      background: #222;
      border-radius: 5px;
    }
    .connected { color: #0f0; }
    .connecting { color: #ff0; }
    .error { color: #f00; }
  </style>
</head>
<body>
  <h1>WebRTC Stream Viewer</h1>
  <div id="status" class="status connecting">Connecting to signaling server...</div>
  <video id="remoteVideo" autoplay playsinline muted></video>
  
  <script>
    const video = document.getElementById('remoteVideo');
    const status = document.getElementById('status');
    const ws = new WebSocket('ws://localhost:${SIGNALING_PORT}');
    let pc = null;
    const configuration = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

    ws.onopen = () => {
      status.textContent = 'Connected. Waiting for stream...';
      status.className = 'status connecting';
      ws.send(JSON.stringify({ type: 'register', role: 'viewer' }));
    };

    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      
      if (data.type === 'phone-ready') {
        status.textContent = 'Phone connected. Waiting for offer...';
      } else if (data.type === 'offer') {
        status.textContent = 'Received offer. Creating answer...';
        await handleOffer(data);
      } else if (data.type === 'ice-candidate') {
        if (pc) {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
      } else if (data.type === 'peer-disconnected') {
        status.textContent = 'Phone disconnected.';
        status.className = 'status error';
        if (pc) {
          pc.close();
          pc = null;
        }
      }
    };

    async function handleOffer(data) {
      pc = new RTCPeerConnection(configuration);
      
      pc.ontrack = (event) => {
        console.log('Received track:', event);
        video.srcObject = event.streams[0];
        status.textContent = 'Streaming!';
        status.className = 'status connected';
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          ws.send(JSON.stringify({
            type: 'ice-candidate',
            candidate: event.candidate
          }));
        }
      };

      pc.onconnectionstatechange = () => {
        console.log('Connection state:', pc.connectionState);
        if (pc.connectionState === 'connected') {
          status.textContent = 'Connected and streaming!';
          status.className = 'status connected';
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          status.textContent = 'Connection lost.';
          status.className = 'status error';
        }
      };

      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      
      ws.send(JSON.stringify({
        type: 'answer',
        sdp: answer
      }));
    }

    ws.onerror = (error) => {
      status.textContent = 'WebSocket error: ' + error;
      status.className = 'status error';
    };

    ws.onclose = () => {
      status.textContent = 'Disconnected from signaling server.';
      status.className = 'status error';
    };
  </script>
</body>
</html>
    `;

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(viewerHtml);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

httpServer.listen(HTTP_PORT, () => {
  const ip = getLocalIP();
  console.log('\n========================================');
  console.log('  WebRTC Signaling Server running!');
  console.log('========================================');
  console.log('');
  console.log('  Signaling: ws://' + ip + ':' + SIGNALING_PORT);
  console.log('  Viewer: http://' + ip + ':' + HTTP_PORT);
  console.log('');
  console.log('  In FreeShow Remote app:');
  console.log('  WebRTC Server: ws://' + ip + ':' + SIGNALING_PORT);
  console.log('');
  console.log('  To view the stream:');
  console.log('  Open in browser: http://localhost:' + HTTP_PORT);
  console.log('  Or: http://' + ip + ':' + HTTP_PORT);
  console.log('');
  console.log('  Expected latency: 100-300ms (much better than RTMP!)');
  console.log('');
  console.log('========================================\n');
});

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}
