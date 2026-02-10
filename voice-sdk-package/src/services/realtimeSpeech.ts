/**
 * OpenAI Realtime Speech Service
 * 
 * Uses WebSocket connection to OpenAI's Realtime API for streaming speech-to-text.
 * Provides real-time transcription as the user speaks.
 * 
 * NOTE: This intentionally uses a direct WebSocket connection rather than
 * routing through the centralized ai-service. Real-time audio streaming
 * requires browser-native WebSocket for acceptable latency. The API key
 * and model are provided via config from the centralized service.
 */

import { MODEL_REALTIME } from '../config/models'

export type RealtimeEventType = 
  | 'connected'
  | 'disconnected'
  | 'transcript'
  | 'transcript_final'
  | 'error'
  | 'speech_started'
  | 'speech_stopped'

export interface RealtimeEvent {
  type: RealtimeEventType
  transcript?: string
  error?: string
}

export type RealtimeEventCallback = (event: RealtimeEvent) => void

interface RealtimeSpeechConfig {
  apiKey: string
  language?: string
  onEvent: RealtimeEventCallback
  deviceId?: string | null  // Specific microphone device ID
}

export class RealtimeSpeechService {
  private ws: WebSocket | null = null
  private mediaRecorder: MediaRecorder | null = null
  private audioContext: AudioContext | null = null
  private stream: MediaStream | null = null
  private config: RealtimeSpeechConfig
  private isConnected = false
  private reconnectAttempts = 0
  private maxReconnectAttempts = 3
  private ttsPlaying = false  // Flag to track TTS playback for barge-in detection
  private onBargeIn: (() => void) | null = null  // Callback when user interrupts TTS

  constructor(config: RealtimeSpeechConfig) {
    this.config = config
  }

  /**
   * Set callback for barge-in detection (user speaks during TTS)
   */
  setBargeInCallback(callback: (() => void) | null) {
    this.onBargeIn = callback
  }

  /**
   * Set TTS playing state - mic stays active but we track for barge-in detection
   */
  setTTSPlaying(playing: boolean) {
    this.ttsPlaying = playing
    console.log('[RealtimeSpeech] TTS playing:', playing, '- listening for barge-in')
  }

  /**
   * Connect to OpenAI Realtime API and start streaming audio
   */
  async connect(): Promise<boolean> {
    try {
      // Get microphone access with optional device selection
      const audioConstraints: MediaTrackConstraints = {
        channelCount: 1,
        sampleRate: 24000,
        echoCancellation: true,
        noiseSuppression: true,
      }
      
      // Use specific device if provided (e.g., AirPods)
      if (this.config.deviceId) {
        audioConstraints.deviceId = { exact: this.config.deviceId }
        console.log('[RealtimeSpeech] Using specific microphone:', this.config.deviceId)
      }
      
      this.stream = await navigator.mediaDevices.getUserMedia({ 
        audio: audioConstraints
      })

      // Create WebSocket connection to OpenAI Realtime API
      // Use the model that supports audio transcription
      const wsUrl = `wss://api.openai.com/v1/realtime?model=${MODEL_REALTIME}`
      
      // Browser WebSockets don't support custom headers, so we use the 
      // subprotocol array to pass authentication (OpenAI supports this)
      const protocols = [
        'realtime',
        `openai-insecure-api-key.${this.config.apiKey}`,
        'openai-beta.realtime-v1'
      ]
      
      console.log('[RealtimeSpeech] Connecting to:', wsUrl)
      this.ws = new WebSocket(wsUrl, protocols)
      
      // Set up binary type for audio data
      this.ws.binaryType = 'arraybuffer'

      return new Promise((resolve, reject) => {
        if (!this.ws) {
          reject(new Error('WebSocket not initialized'))
          return
        }

        this.ws.onopen = () => {
          console.log('[RealtimeSpeech] WebSocket connected')
          this.isConnected = true
          this.reconnectAttempts = 0
          
          // Send authentication and session config
          this.sendSessionConfig()
          
          // Start streaming audio
          this.startAudioStream()
          
          this.config.onEvent({ type: 'connected' })
          resolve(true)
        }

        this.ws.onmessage = (event) => {
          this.handleMessage(event)
        }

        this.ws.onerror = (error) => {
          console.error('[RealtimeSpeech] WebSocket error:', error)
          this.config.onEvent({ 
            type: 'error', 
            error: 'WebSocket connection error' 
          })
          reject(error)
        }

        this.ws.onclose = (event) => {
          console.log('[RealtimeSpeech] WebSocket closed:', event.code, event.reason)
          this.isConnected = false
          this.config.onEvent({ type: 'disconnected' })
          
          // Attempt reconnect if not intentionally closed
          if (event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.attemptReconnect()
          }
        }

        // Timeout if connection takes too long
        setTimeout(() => {
          if (!this.isConnected) {
            this.ws?.close()
            reject(new Error('Connection timeout'))
          }
        }, 10000)
      })
    } catch (error) {
      console.error('[RealtimeSpeech] Connection error:', error)
      this.config.onEvent({ 
        type: 'error', 
        error: error instanceof Error ? error.message : 'Connection failed' 
      })
      return false
    }
  }

  /**
   * Send session configuration to OpenAI
   */
  private sendSessionConfig() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    // Configure for TRANSCRIPTION ONLY - no AI responses
    const sessionConfig = {
      type: 'session.update',
      session: {
        modalities: ['text'],  // Text only - no audio output
        instructions: 'Transcribe audio only. Do not respond.',
        input_audio_format: 'pcm16',
        input_audio_transcription: {
          model: 'whisper-1',
          language: 'en'  // Force English to prevent incorrect language detection
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,  // Higher threshold = less sensitive, reduces false triggers from background noise
          prefix_padding_ms: 500,  // 500ms of audio before speech detection
          silence_duration_ms: 1500,  // 1.5 seconds of silence before considering speech ended (was 600ms - too aggressive)
          create_response: false  // Don't generate AI responses
        }
      }
    }

    this.ws.send(JSON.stringify(sessionConfig))
    console.log('[RealtimeSpeech] Session config sent (transcription-only)')
  }

  /**
   * Start streaming audio from microphone
   */
  private startAudioStream() {
    if (!this.stream || !this.ws) return

    // Create audio context for processing
    this.audioContext = new AudioContext({ sampleRate: 24000 })
    const source = this.audioContext.createMediaStreamSource(this.stream)
    
    // Create script processor for audio data
    const processor = this.audioContext.createScriptProcessor(4096, 1, 1)
    
    processor.onaudioprocess = (e) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
      
      // ALWAYS stream audio - we need it for barge-in detection during TTS
      // Echo cancellation in getUserMedia handles feedback prevention
      const inputData = e.inputBuffer.getChannelData(0)
      
      // Convert float32 to int16 PCM
      const pcm16 = new Int16Array(inputData.length)
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]))
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
      }
      
      // Base64 encode the audio data
      const base64Audio = this.arrayBufferToBase64(pcm16.buffer)
      
      // Send audio to OpenAI
      const audioEvent = {
        type: 'input_audio_buffer.append',
        audio: base64Audio
      }
      
      this.ws.send(JSON.stringify(audioEvent))
    }
    
    source.connect(processor)
    processor.connect(this.audioContext.destination)
    
    console.log('[RealtimeSpeech] Audio streaming started')
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(event: MessageEvent) {
    try {
      const data = JSON.parse(event.data)
      
      // Log all events for debugging (except high-frequency audio events)
      if (!data.type?.includes('audio_buffer')) {
        console.log('[RealtimeSpeech] Received:', data.type, data)
      }

      switch (data.type) {
        case 'session.created':
          console.log('[RealtimeSpeech] Session created:', data.session?.id)
          break

        case 'session.updated':
          console.log('[RealtimeSpeech] Session updated')
          break

        case 'input_audio_buffer.speech_started':
          console.log('[RealtimeSpeech] Speech detected')
          
          // BARGE-IN: If TTS is playing and user starts speaking, interrupt it
          if (this.ttsPlaying && this.onBargeIn) {
            console.log('[RealtimeSpeech] BARGE-IN detected - user interrupting TTS')
            this.onBargeIn()
            // Clear TTS flag since we're interrupting
            this.ttsPlaying = false
          }
          
          this.config.onEvent({ type: 'speech_started' })
          break

        case 'input_audio_buffer.speech_stopped':
          console.log('[RealtimeSpeech] Speech ended')
          this.config.onEvent({ type: 'speech_stopped' })
          // Note: Don't manually commit - OpenAI's server-side VAD automatically 
          // commits the buffer when speech stops (with turn_detection enabled)
          break

        case 'input_audio_buffer.committed':
          console.log('[RealtimeSpeech] Audio buffer committed')
          break

        // Real-time transcription as user speaks
        case 'conversation.item.input_audio_transcription.delta':
          if (data.delta) {
            console.log('[RealtimeSpeech] Transcript delta:', data.delta)
            this.config.onEvent({ 
              type: 'transcript', 
              transcript: data.delta 
            })
          }
          break

        // Final transcription when speech segment completes
        case 'conversation.item.input_audio_transcription.completed':
          if (data.transcript) {
            console.log('[RealtimeSpeech] Transcription complete:', data.transcript)
            this.config.onEvent({ 
              type: 'transcript_final', 
              transcript: data.transcript 
            })
          }
          break

        // Response text transcription (AI speaking back)
        case 'response.audio_transcript.delta':
          if (data.delta) {
            console.log('[RealtimeSpeech] Response transcript:', data.delta)
          }
          break

        case 'error':
          console.error('[RealtimeSpeech] API error:', data.error)
          this.config.onEvent({ 
            type: 'error', 
            error: data.error?.message || JSON.stringify(data.error) || 'API error' 
          })
          break

        default:
          // Log other event types for debugging
          if (data.type && !data.type.includes('response.')) {
            console.log('[RealtimeSpeech] Unhandled event:', data.type)
          }
      }
    } catch (error) {
      console.error('[RealtimeSpeech] Message parse error:', error)
    }
  }

  /**
   * Commit the audio buffer to trigger transcription
   */
  private commitAudioBuffer() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    
    this.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
  }

  /**
   * Convert ArrayBuffer to base64
   */
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
  }

  /**
   * Attempt to reconnect after connection loss
   */
  private attemptReconnect() {
    this.reconnectAttempts++
    console.log(`[RealtimeSpeech] Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`)
    
    setTimeout(() => {
      this.connect()
    }, 1000 * this.reconnectAttempts)
  }

  /**
   * Disconnect and clean up resources
   */
  disconnect() {
    console.log('[RealtimeSpeech] Disconnecting...')
    
    // Stop media recorder
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop()
    }
    this.mediaRecorder = null
    
    // Close audio context
    if (this.audioContext) {
      this.audioContext.close()
      this.audioContext = null
    }
    
    // Stop media stream tracks
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop())
      this.stream = null
    }
    
    // Close WebSocket
    if (this.ws) {
      this.ws.close(1000, 'User disconnected')
      this.ws = null
    }
    
    this.isConnected = false
    this.config.onEvent({ type: 'disconnected' })
  }

  /**
   * Check if currently connected
   */
  getIsConnected(): boolean {
    return this.isConnected
  }
}

export default RealtimeSpeechService

