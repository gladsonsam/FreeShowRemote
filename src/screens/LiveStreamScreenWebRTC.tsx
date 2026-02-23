import React, { useRef, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  RTCPeerConnection,
  RTCView,
  mediaDevices,
  RTCSessionDescription,
  RTCIceCandidate,
} from 'react-native-webrtc';
import { LinearGradient } from 'expo-linear-gradient';
import { FreeShowTheme } from '../theme/FreeShowTheme';
import { useConnection } from '../contexts';

interface LiveStreamScreenProps {
  navigation: any;
  route?: any;
}

const LiveStreamScreenWebRTC: React.FC<LiveStreamScreenProps> = ({ navigation }) => {
  const { t } = useTranslation();
  const { state } = useConnection();
  const { connectionHost } = state;
  
  const [streaming, setStreaming] = useState(false);
  const [localStream, setLocalStream] = useState<any>(null);
  const [signalingUrl, setSignalingUrl] = useState(connectionHost ? `ws://${connectionHost}:8080` : '');
  const [camera, setCamera] = useState<'front' | 'back'>('back');
  const [isMuted, setIsMuted] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  
  // Resolution and zoom options
  type ResolutionPreset = '720p' | '1080p' | '4K';
  const [resolution, setResolution] = useState<ResolutionPreset>('1080p');
  const [zoom, setZoom] = useState(1.0);
  const [maxZoom, setMaxZoom] = useState(1.0);
  
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<any>(null);

  useEffect(() => {
    return () => {
      // Cleanup on unmount
      try {
        stopStreaming();
      } catch (error) {
        console.error('Error during cleanup:', error);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolution presets
  const getResolutionConstraints = (preset: ResolutionPreset) => {
    switch (preset) {
      case '4K':
        return { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } };
      case '1080p':
        return { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
      case '720p':
      default:
        return { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
    }
  };

  const getLocalStream = async (newResolution?: ResolutionPreset, newCamera?: 'front' | 'back') => {
    try {
      const res = newResolution || resolution;
      const cam = newCamera !== undefined ? newCamera : camera;
      const constraints = getResolutionConstraints(res);
      
      const stream = await mediaDevices.getUserMedia({
        audio: true,
        video: {
          facingMode: cam === 'back' ? 'environment' : 'user',
          ...constraints,
        },
      });
      
      // Get max zoom capability if available
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack && videoTrack.getCapabilities) {
        try {
          const capabilities = videoTrack.getCapabilities() as any;
          if (capabilities && capabilities.zoom) {
            setMaxZoom(capabilities.zoom.max || 1.0);
          }
        } catch (e) {
          // Zoom capabilities not available on this device
        }
      }
      
      streamRef.current = stream;
      setLocalStream(stream);
      return stream;
    } catch (error) {
      console.error('Error getting media:', error);
      Alert.alert('Error', 'Failed to access camera/microphone. Please check permissions.');
      throw error;
    }
  };

  // Apply zoom to video track
  const applyZoom = async (newZoom: number) => {
    if (!streamRef.current) return;
    
    const videoTrack = streamRef.current.getVideoTracks()[0];
    if (videoTrack && videoTrack.getConstraints) {
      try {
        await videoTrack.applyConstraints({
          advanced: [{ zoom: Math.min(Math.max(newZoom, 1.0), maxZoom) }],
        });
        setZoom(Math.min(Math.max(newZoom, 1.0), maxZoom));
      } catch (error) {
        console.error('Error applying zoom:', error);
      }
    }
  };

  // Change resolution dynamically
  const changeResolution = async (newResolution: ResolutionPreset) => {
    if (streaming && streamRef.current) {
      // Stop old tracks
      streamRef.current.getTracks().forEach((track: any) => track.stop());
      
      // Get new stream with new resolution
      const newStream = await getLocalStream(newResolution, camera);
      setResolution(newResolution);
      
      // Replace tracks in peer connection and update bitrate
      if (peerConnectionRef.current) {
        const videoTrack = newStream.getVideoTracks()[0];
        const sender = peerConnectionRef.current.getSenders().find((s: any) => 
          s.track && s.track.kind === 'video'
        );
        if (sender && videoTrack) {
          await sender.replaceTrack(videoTrack);
          
          // Update bitrate for new resolution (high quality like DroidCam)
          const bitrate = newResolution === '4K' ? 20000000 : newResolution === '1080p' ? 8000000 : 4000000;
          try {
            const params = sender.getParameters();
            if (params.encodings && params.encodings.length > 0) {
              params.encodings[0].maxBitrate = bitrate;
              await sender.setParameters(params);
            }
            } catch (e) {
              // Bitrate update failed, continue with default
            }
        }
      }
    } else {
      setResolution(newResolution);
    }
  };

  const setupWebRTC = async () => {
    if (!signalingUrl.trim()) {
      Alert.alert('Error', 'Please enter a WebRTC signaling server URL.');
      return;
    }

    // Validate URL format
    const url = signalingUrl.trim();
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      Alert.alert('Invalid URL', 'WebSocket URL must start with ws:// or wss://\n\nExample: ws://192.168.1.100:8080');
      return;
    }

    try {
      const urlObj = new URL(url); // Validate URL format
      // Warn if using wrong port
      const port = urlObj.port || (urlObj.protocol === 'ws:' ? '80' : '443');
      if (port === '8082') {
        Alert.alert(
          'Wrong Port!',
          'You are using port 8082, but the WebSocket signaling server uses port 8080.\n\n' +
          'Port 8082 is for the browser viewer (HTTP), not for the app!\n\n' +
          'Please use: ws://' + urlObj.hostname + ':8080'
        );
        return;
      }
      if (port !== '8080' && !url.includes('wss://')) {
        Alert.alert(
          'Port Warning',
          `You are using port ${port}, but the standard WebSocket signaling port is 8080.\n\n` +
          `Are you sure you want to use port ${port}?\n\n` +
          'Standard: ws://' + urlObj.hostname + ':8080'
        );
        // Don't return, just warn
      }
    } catch (error) {
      Alert.alert('Invalid URL', `Invalid WebSocket URL format.\n\n${url}\n\nExample: ws://192.168.1.100:8080`);
      return;
    }

    setConnectionStatus('connecting');

    try {
      // Get local stream
      const stream = await getLocalStream();

      // Create peer connection with high-quality settings
      const configuration: any = {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
        // Disable adaptive bitrate for local streaming (like DroidCam)
        bundlePolicy: 'max-bundle' as const,
        rtcpMuxPolicy: 'require' as const,
      };

      const pc = new RTCPeerConnection(configuration);
      peerConnectionRef.current = pc;

      // Add tracks to peer connection
      stream.getTracks().forEach((track: any) => {
        const sender = pc.addTrack(track, stream);
        
        // Configure high-quality video encoding for video tracks
        if (track.kind === 'video' && sender) {
          // Set high bitrate for better quality (like DroidCam)
          const bitrate = resolution === '4K' ? 20000000 : resolution === '1080p' ? 8000000 : 4000000; // 20Mbps, 8Mbps, 4Mbps
          
          // Configure sender parameters for high quality
          const params = sender.getParameters();
          if (params.encodings && params.encodings.length > 0) {
            params.encodings[0].maxBitrate = bitrate;
            params.encodings[0].maxFramerate = 30;
            // Prefer H.264 for better quality (less compression artifacts)
            params.codecs = params.codecs || [];
            // Try to use H.264 if available
            try {
              sender.setParameters(params);
            } catch (e) {
              // Encoding parameters not supported, continue with defaults
            }
          }
        }
      });

      // Handle ICE candidates
      (pc as any).addEventListener('icecandidate', (event: any) => {
        if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: 'ice-candidate',
            candidate: event.candidate,
          }));
        }
      });

      (pc as any).addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'connected') {
          setConnectionStatus('connected');
          setStreaming(true);
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          setConnectionStatus('error');
          setStreaming(false);
          Alert.alert('Connection Lost', 'WebRTC connection failed.');
        }
      });

      // Connect to signaling server
      const wsUrl = signalingUrl.trim();
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      
      // Set a connection timeout
      let connectionTimeout: NodeJS.Timeout;
      connectionTimeout = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.close();
          setConnectionStatus('error');
          Alert.alert(
            'Connection Timeout',
            `Failed to connect to signaling server within 10 seconds.\n\nURL: ${wsUrl}\n\nPlease check:\n1. Server is running: npm run webrtc-server\n2. URL is correct\n3. Phone and computer are on same network`
          );
        }
      }, 10000);

      ws.onopen = async () => {
        clearTimeout(connectionTimeout);
        ws.send(JSON.stringify({ type: 'register', role: 'phone' }));

        // Create and send offer with high-quality codec preferences
        const offer = await pc.createOffer({
          offerToReceiveAudio: false,
          offerToReceiveVideo: false,
        });
        
        // Modify SDP to prefer H.264 and set high bitrate
        offer.sdp = offer.sdp?.replace(/a=fmtp:(\d+) (.+)/g, (match: string, fmt: string, params: string) => {
          // Prefer H.264 codec
          if (params.includes('H264')) {
            return match + ';x-google-min-bitrate=4000;x-google-max-bitrate=20000';
          }
          return match;
        }) || offer.sdp;
        
        // Set high bitrate in SDP
        const bitrate = resolution === '4K' ? 20000 : resolution === '1080p' ? 8000 : 4000;
        offer.sdp = offer.sdp?.replace(
          /a=mid:video/g,
          `a=mid:video\r\na=bundle-only`
        ) || offer.sdp;
        
        // Add bandwidth constraints
        if (offer.sdp && !offer.sdp.includes('b=AS:')) {
          offer.sdp = offer.sdp.replace(
            /m=video (\d+)/,
            `m=video $1\r\nb=AS:${bitrate * 1000}`
          );
        }
        
        await pc.setLocalDescription(offer);
        ws.send(JSON.stringify({
          type: 'offer',
          sdp: offer,
        }));
      };

      ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'answer') {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        } else if (data.type === 'ice-candidate') {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } else if (data.type === 'viewer-ready') {
          // Viewer connected, create offer if not already sent
          if (pc.signalingState === 'stable') {
            const offer = await pc.createOffer({
              offerToReceiveAudio: false,
              offerToReceiveVideo: false,
            });
            await pc.setLocalDescription(offer);
            ws.send(JSON.stringify({
              type: 'offer',
              sdp: offer,
            }));
          }
        }
      };

      ws.onerror = (error: any) => {
        clearTimeout(connectionTimeout);
        console.error('WebSocket error:', error);
        setConnectionStatus('error');
        const errorMessage = error?.message || error?.type || 'Connection failed';
        Alert.alert(
          'Connection Error',
          `Failed to connect to signaling server.\n\nURL: ${wsUrl}\n\nError: ${errorMessage}\n\nMake sure:\n1. WebRTC server is running: npm run webrtc-server\n2. URL is correct (ws://IP:8080)\n3. Phone and computer are on same network`
        );
      };

      ws.onclose = (event) => {
        clearTimeout(connectionTimeout);
        if (event.code !== 1000) {
          // Not a normal closure
          setConnectionStatus('error');
          if (event.code === 1006) {
            // Abnormal closure - usually means connection refused or network issue
            Alert.alert(
              'Connection Failed',
              `Could not connect to server.\n\nURL: ${wsUrl}\n\nPlease check:\n1. Server is running: npm run webrtc-server\n2. URL is correct\n3. Firewall allows port 8080\n4. Phone and computer are on same network`
            );
          } else {
            Alert.alert(
              'Connection Closed',
              `WebSocket closed unexpectedly.\n\nCode: ${event.code}\nReason: ${event.reason || 'Unknown'}\n\nCheck if the server is running.`
            );
          }
        } else {
          setConnectionStatus('idle');
        }
        setStreaming(false);
      };

    } catch (error) {
      console.error('Error setting up WebRTC:', error);
      setConnectionStatus('error');
      Alert.alert('Error', 'Failed to start WebRTC stream. ' + (error instanceof Error ? error.message : String(error)));
    }
  };

  const stopStreaming = () => {
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track: any) => track.stop());
        streamRef.current = null;
        setLocalStream(null);
      }

      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
      }

      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      setStreaming(false);
      setConnectionStatus('idle');
    } catch (error) {
      console.error('Error stopping stream:', error);
    }
  };

  const toggleCamera = async () => {
    const newCamera = camera === 'back' ? 'front' : 'back';
    setCamera(newCamera);
    
    if (streamRef.current) {
      // Stop old tracks
      streamRef.current.getTracks().forEach((track: any) => track.stop());
      
      // Get new stream with different camera (keeping current resolution)
      const newStream = await getLocalStream(resolution, newCamera);
      
      // Replace tracks in peer connection
      if (peerConnectionRef.current) {
        const videoTrack = newStream.getVideoTracks()[0];
        const sender = peerConnectionRef.current.getSenders().find((s: any) => 
          s.track && s.track.kind === 'video'
        );
        if (sender && videoTrack) {
          await sender.replaceTrack(videoTrack);
        }
      }
    }
  };

  const toggleMute = () => {
    if (streamRef.current) {
      const audioTracks = streamRef.current.getAudioTracks();
      audioTracks.forEach((track: any) => {
        track.enabled = !track.enabled;
      });
      setIsMuted(!isMuted);
    }
  };

  const getStatusColor = () => {
    switch (connectionStatus) {
      case 'connected':
        return FreeShowTheme.colors.connected;
      case 'connecting':
        return '#FFA500';
      case 'error':
        return FreeShowTheme.colors.disconnected;
      default:
        return FreeShowTheme.colors.textSecondary;
    }
  };

  const getStatusText = () => {
    switch (connectionStatus) {
      case 'connected':
        return 'Live (WebRTC)';
      case 'connecting':
        return 'Connecting...';
      case 'error':
        return 'Error';
      default:
        return 'Ready';
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <StatusBar barStyle="light-content" />
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={styles.backButton}
            accessibilityLabel="Go back"
          >
            <Ionicons name="arrow-back" size={24} color={FreeShowTheme.colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Live Stream (WebRTC)</Text>
          <View style={styles.statusIndicator}>
            <View style={[styles.statusDot, { backgroundColor: getStatusColor() }]} />
            <Text style={[styles.statusText, { color: getStatusColor() }]}>
              {getStatusText()}
            </Text>
          </View>
        </View>

        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* Camera Preview */}
          <View style={styles.previewContainer}>
            {localStream ? (
              <RTCView
                streamURL={localStream.toURL()}
                style={styles.preview}
                mirror={camera === 'front'}
                objectFit="cover"
              />
            ) : (
              <View style={[styles.preview, styles.previewPlaceholder]}>
                <Ionicons name="videocam-off" size={64} color={FreeShowTheme.colors.textSecondary} />
                <Text style={styles.previewPlaceholderText}>Camera preview</Text>
              </View>
            )}
            
            {/* Camera Controls Overlay */}
            {localStream && (
              <View style={styles.controlsOverlay}>
                <TouchableOpacity
                  style={styles.controlButton}
                  onPress={toggleCamera}
                  accessibilityLabel="Switch camera"
                >
                  <Ionicons name="camera-reverse" size={24} color={FreeShowTheme.colors.text} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.controlButton}
                  onPress={toggleMute}
                  accessibilityLabel={isMuted ? 'Unmute microphone' : 'Mute microphone'}
                >
                  <Ionicons
                    name={isMuted ? 'mic-off' : 'mic'}
                    size={24}
                    color={FreeShowTheme.colors.text}
                  />
                </TouchableOpacity>
              </View>
            )}
          </View>

          {/* Camera Controls Section */}
          <View style={styles.configSection}>
            <Text style={styles.sectionTitle}>Camera Settings</Text>
            
            {/* Resolution Selection */}
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Resolution</Text>
              <View style={styles.resolutionButtons}>
                {(['720p', '1080p', '4K'] as ResolutionPreset[]).map((preset) => (
                  <TouchableOpacity
                    key={preset}
                    style={[
                      styles.resolutionButton,
                      resolution === preset && styles.resolutionButtonActive,
                    ]}
                    onPress={() => changeResolution(preset)}
                    disabled={streaming && connectionStatus === 'connecting'}
                  >
                    <Text
                      style={[
                        styles.resolutionButtonText,
                        resolution === preset && styles.resolutionButtonTextActive,
                      ]}
                    >
                      {preset}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={styles.hint}>
                Current: {resolution} ({getResolutionConstraints(resolution).width.ideal}x{getResolutionConstraints(resolution).height.ideal})
              </Text>
            </View>

            {/* Zoom Control */}
            {maxZoom > 1.0 && (
              <View style={styles.inputGroup}>
                <View style={styles.labelRow}>
                  <Text style={styles.label}>Zoom</Text>
                  <Text style={styles.zoomValue}>{zoom.toFixed(1)}x</Text>
                </View>
                <View style={styles.zoomContainer}>
                  <TouchableOpacity
                    style={styles.zoomButton}
                    onPress={() => applyZoom(Math.max(1.0, zoom - 0.5))}
                    disabled={zoom <= 1.0}
                  >
                    <Ionicons name="remove" size={20} color={FreeShowTheme.colors.text} />
                  </TouchableOpacity>
                  <View style={styles.zoomSliderContainer}>
                    <View style={styles.zoomTrack}>
                      <View
                        style={[
                          styles.zoomProgress,
                          { width: `${((zoom - 1) / (maxZoom - 1)) * 100}%` },
                        ]}
                      />
                    </View>
                  </View>
                  <TouchableOpacity
                    style={styles.zoomButton}
                    onPress={() => applyZoom(Math.min(maxZoom, zoom + 0.5))}
                    disabled={zoom >= maxZoom}
                  >
                    <Ionicons name="add" size={20} color={FreeShowTheme.colors.text} />
                  </TouchableOpacity>
                </View>
                <View style={styles.zoomButtonsRow}>
                  <TouchableOpacity
                    style={styles.zoomPresetButton}
                    onPress={() => applyZoom(1.0)}
                  >
                    <Text style={styles.zoomPresetText}>1x</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.zoomPresetButton}
                    onPress={() => applyZoom(2.0)}
                    disabled={maxZoom < 2.0}
                  >
                    <Text style={styles.zoomPresetText}>2x</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.zoomPresetButton}
                    onPress={() => applyZoom(maxZoom)}
                  >
                    <Text style={styles.zoomPresetText}>Max</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>

          {/* Configuration Section */}
          <View style={styles.configSection}>
            <Text style={styles.sectionTitle}>WebRTC Configuration</Text>
            
            <View style={styles.infoBox}>
              <Ionicons name="information-circle" size={20} color={FreeShowTheme.colors.secondary} />
              <Text style={styles.infoText}>
                WebRTC provides ultra-low latency (100-300ms). Your phone streams directly to the viewer via peer-to-peer connection.
              </Text>
            </View>
            
            <View style={styles.inputGroup}>
              <View style={styles.labelRow}>
                <Text style={styles.label}>Signaling Server URL</Text>
                {connectionHost && (
                  <TouchableOpacity
                    onPress={() => setSignalingUrl(`ws://${connectionHost}:8080`)}
                    style={styles.useIpButton}
                  >
                    <Ionicons name="refresh" size={16} color={FreeShowTheme.colors.secondary} />
                    <Text style={styles.useIpText}>Use FreeShow IP</Text>
                  </TouchableOpacity>
                )}
              </View>
              <TextInput
                style={styles.input}
                value={signalingUrl}
                onChangeText={setSignalingUrl}
                placeholder="ws://192.168.1.100:8080"
                placeholderTextColor={FreeShowTheme.colors.textSecondary}
                editable={!streaming}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Text style={styles.hint}>
                WebSocket URL for signaling. Must use port 8080 (NOT 8082).{'\n'}
                Example: ws://192.168.1.100:8080{'\n'}
                Run: npm run webrtc-server (on your computer){'\n'}
                Note: Port 8082 is for the browser viewer, not the app!
              </Text>
            </View>
          </View>
        </ScrollView>

        {/* Control Buttons */}
        <View style={styles.controls}>
          <TouchableOpacity
            style={[
              styles.streamButton,
              streaming ? styles.stopButton : styles.startButton,
            ]}
            onPress={streaming ? stopStreaming : setupWebRTC}
            disabled={connectionStatus === 'connecting'}
            accessibilityLabel={streaming ? 'Stop streaming' : 'Start streaming'}
          >
            <LinearGradient
              colors={
                streaming
                  ? ['#a82727', '#c80000']
                  : [FreeShowTheme.colors.secondary, FreeShowTheme.colors.secondaryDark]
              }
              style={styles.streamButtonGradient}
            >
              <Ionicons
                name={streaming ? 'stop-circle' : 'radio-button-on'}
                size={24}
                color="#fff"
              />
              <Text style={styles.streamButtonText}>
                {streaming ? 'Stop Streaming' : 'Start Streaming'}
              </Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: FreeShowTheme.colors.primary,
  },
  keyboardView: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: FreeShowTheme.spacing.md,
    paddingVertical: FreeShowTheme.spacing.md,
    backgroundColor: FreeShowTheme.colors.primaryDarker,
    borderBottomWidth: 1,
    borderBottomColor: FreeShowTheme.colors.border,
  },
  backButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: FreeShowTheme.borderRadius.md,
    backgroundColor: FreeShowTheme.colors.primaryDarkest,
  },
  headerTitle: {
    fontSize: FreeShowTheme.fontSize.xl,
    fontWeight: '700',
    color: FreeShowTheme.colors.text,
    flex: 1,
    marginLeft: FreeShowTheme.spacing.md,
  },
  statusIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: FreeShowTheme.spacing.xs,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: FreeShowTheme.fontSize.sm,
    fontWeight: '600',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: FreeShowTheme.spacing.md,
  },
  previewContainer: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: FreeShowTheme.borderRadius.lg,
    overflow: 'hidden',
    backgroundColor: FreeShowTheme.colors.primaryDarkest,
    marginBottom: FreeShowTheme.spacing.lg,
  },
  preview: {
    flex: 1,
    backgroundColor: 'black',
  },
  previewPlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  previewPlaceholderText: {
    color: FreeShowTheme.colors.textSecondary,
    marginTop: FreeShowTheme.spacing.sm,
  },
  controlsOverlay: {
    position: 'absolute',
    top: FreeShowTheme.spacing.md,
    right: FreeShowTheme.spacing.md,
    flexDirection: 'row',
    gap: FreeShowTheme.spacing.sm,
  },
  controlButton: {
    width: 44,
    height: 44,
    borderRadius: FreeShowTheme.borderRadius.md,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  configSection: {
    marginBottom: FreeShowTheme.spacing.lg,
  },
  sectionTitle: {
    fontSize: FreeShowTheme.fontSize.lg,
    fontWeight: '700',
    color: FreeShowTheme.colors.text,
    marginBottom: FreeShowTheme.spacing.md,
  },
  infoBox: {
    flexDirection: 'row',
    backgroundColor: FreeShowTheme.colors.primaryDarker,
    borderWidth: 1,
    borderColor: FreeShowTheme.colors.secondary + '40',
    borderRadius: FreeShowTheme.borderRadius.md,
    padding: FreeShowTheme.spacing.md,
    marginBottom: FreeShowTheme.spacing.md,
    gap: FreeShowTheme.spacing.sm,
  },
  infoText: {
    flex: 1,
    fontSize: FreeShowTheme.fontSize.sm,
    color: FreeShowTheme.colors.text,
    lineHeight: 20,
  },
  inputGroup: {
    marginBottom: FreeShowTheme.spacing.md,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: FreeShowTheme.spacing.xs,
  },
  label: {
    fontSize: FreeShowTheme.fontSize.sm,
    fontWeight: '600',
    color: FreeShowTheme.colors.text,
    flex: 1,
  },
  useIpButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: FreeShowTheme.spacing.xs,
    paddingHorizontal: FreeShowTheme.spacing.sm,
    paddingVertical: FreeShowTheme.spacing.xs,
    backgroundColor: FreeShowTheme.colors.secondarySurface,
    borderRadius: FreeShowTheme.borderRadius.sm,
  },
  useIpText: {
    fontSize: FreeShowTheme.fontSize.xs,
    color: FreeShowTheme.colors.secondary,
    fontWeight: '600',
  },
  input: {
    backgroundColor: FreeShowTheme.colors.primaryDarker,
    borderWidth: 1,
    borderColor: FreeShowTheme.colors.border,
    borderRadius: FreeShowTheme.borderRadius.md,
    padding: FreeShowTheme.spacing.md,
    color: FreeShowTheme.colors.text,
    fontSize: FreeShowTheme.fontSize.md,
  },
  hint: {
    fontSize: FreeShowTheme.fontSize.xs,
    color: FreeShowTheme.colors.textSecondary,
    marginTop: FreeShowTheme.spacing.xs,
  },
  controls: {
    padding: FreeShowTheme.spacing.md,
    backgroundColor: FreeShowTheme.colors.primaryDarker,
    borderTopWidth: 1,
    borderTopColor: FreeShowTheme.colors.border,
  },
  streamButton: {
    borderRadius: FreeShowTheme.borderRadius.lg,
    overflow: 'hidden',
  },
  startButton: {},
  stopButton: {},
  streamButtonGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: FreeShowTheme.spacing.md,
    paddingHorizontal: FreeShowTheme.spacing.lg,
    gap: FreeShowTheme.spacing.sm,
  },
  streamButtonText: {
    fontSize: FreeShowTheme.fontSize.lg,
    fontWeight: '700',
    color: '#fff',
  },
  resolutionButtons: {
    flexDirection: 'row',
    gap: FreeShowTheme.spacing.sm,
    marginTop: FreeShowTheme.spacing.xs,
  },
  resolutionButton: {
    flex: 1,
    paddingVertical: FreeShowTheme.spacing.md,
    paddingHorizontal: FreeShowTheme.spacing.md,
    borderRadius: FreeShowTheme.borderRadius.md,
    backgroundColor: FreeShowTheme.colors.primaryDarker,
    borderWidth: 1,
    borderColor: FreeShowTheme.colors.border,
    alignItems: 'center',
  },
  resolutionButtonActive: {
    backgroundColor: FreeShowTheme.colors.secondarySurface,
    borderColor: FreeShowTheme.colors.secondary,
  },
  resolutionButtonText: {
    fontSize: FreeShowTheme.fontSize.md,
    fontWeight: '600',
    color: FreeShowTheme.colors.text,
  },
  resolutionButtonTextActive: {
    color: FreeShowTheme.colors.secondary,
  },
  zoomValue: {
    fontSize: FreeShowTheme.fontSize.md,
    fontWeight: '600',
    color: FreeShowTheme.colors.secondary,
  },
  zoomContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: FreeShowTheme.spacing.sm,
    marginTop: FreeShowTheme.spacing.sm,
  },
  zoomButton: {
    width: 40,
    height: 40,
    borderRadius: FreeShowTheme.borderRadius.md,
    backgroundColor: FreeShowTheme.colors.primaryDarker,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: FreeShowTheme.colors.border,
  },
  zoomSliderContainer: {
    flex: 1,
    height: 40,
    justifyContent: 'center',
  },
  zoomTrack: {
    height: 4,
    backgroundColor: FreeShowTheme.colors.primaryDarker,
    borderRadius: 2,
    position: 'relative',
  },
  zoomProgress: {
    height: '100%',
    backgroundColor: FreeShowTheme.colors.secondary,
    borderRadius: 2,
  },
  zoomButtonsRow: {
    flexDirection: 'row',
    gap: FreeShowTheme.spacing.sm,
    marginTop: FreeShowTheme.spacing.sm,
  },
  zoomPresetButton: {
    flex: 1,
    paddingVertical: FreeShowTheme.spacing.sm,
    paddingHorizontal: FreeShowTheme.spacing.md,
    borderRadius: FreeShowTheme.borderRadius.md,
    backgroundColor: FreeShowTheme.colors.primaryDarker,
    borderWidth: 1,
    borderColor: FreeShowTheme.colors.border,
    alignItems: 'center',
  },
  zoomPresetText: {
    fontSize: FreeShowTheme.fontSize.sm,
    fontWeight: '600',
    color: FreeShowTheme.colors.text,
  },
});

export default LiveStreamScreenWebRTC;
