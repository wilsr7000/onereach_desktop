/**
 * Unified Speech Manager
 * 
 * Manages speech-to-text services with automatic fallback:
 * 1. Primary: OpenAI Realtime API (WebSocket streaming)
 * 2. Fallback: OpenAI Whisper API (batch transcription)
 * 
 * Provides a consistent interface regardless of which backend is used.
 */

import { RealtimeSpeechService, RealtimeEvent } from './realtimeSpeech'
import { WhisperSpeechService, WhisperEvent } from './whisperSpeech'

export type SpeechBackend = 'realtime' | 'whisper' | 'none'

export type SpeechEventType =
  | 'connected'
  | 'disconnected'
  | 'transcript_interim'
  | 'transcript_final'
  | 'error'
  | 'speech_started'
  | 'speech_stopped'
  | 'backend_changed'

export interface SpeechEvent {
  type: SpeechEventType
  transcript?: string
  error?: string
  backend?: SpeechBackend
}

export type SpeechEventCallback = (event: SpeechEvent) => void

interface SpeechManagerConfig {
  onEvent: SpeechEventCallback
  language?: string
  preferredBackend?: SpeechBackend
  deviceId?: string | null  // Specific microphone device ID (e.g., for AirPods)
}

class SpeechManager {
  private realtimeService: RealtimeSpeechService | null = null
  private whisperService: WhisperSpeechService | null = null
  private config: SpeechManagerConfig
  private currentBackend: SpeechBackend = 'none'
  private apiKey: string | null = null
  private isActive = false
  private accumulatedTranscript = ''

  constructor(config: SpeechManagerConfig) {
    this.config = config
  }

  /**
   * Initialize with API key from localStorage or parameter
   */
  initialize(apiKey?: string): boolean {
    this.apiKey = apiKey || localStorage.getItem('playbook-openai-key')
    
    if (!this.apiKey) {
      console.warn('[SpeechManager] No API key available')
      this.config.onEvent({
        type: 'error',
        error: 'OpenAI API key not configured'
      })
      return false
    }

    console.log('[SpeechManager] Initialized with API key')
    return true
  }

  /**
   * Start listening using the best available backend
   */
  async startListening(): Promise<boolean> {
    
    if (!this.apiKey) {
      if (!this.initialize()) {
        return false
      }
    }

    this.isActive = true
    this.accumulatedTranscript = ''

    // Use Realtime API only (no Whisper fallback)
    console.log('[SpeechManager] Starting Realtime API (no fallback)...')
    const success = await this.tryRealtimeBackend()
    if (!success) {
      console.error('[SpeechManager] Realtime API failed - no fallback available')
      this.config.onEvent({ type: 'error', error: 'Realtime API connection failed' })
    }
    return success
  }

  /**
   * Try to start the Realtime API backend
   */
  private async tryRealtimeBackend(): Promise<boolean> {
    console.log('[SpeechManager] Attempting Realtime backend...')
    
    if (!this.apiKey) {
      console.log('[SpeechManager] No API key for Realtime')
      return false
    }

    try {
      console.log('[SpeechManager] Creating RealtimeSpeechService...')
      this.realtimeService = new RealtimeSpeechService({
        apiKey: this.apiKey,
        language: this.config.language,
        onEvent: (event) => this.handleRealtimeEvent(event),
        deviceId: this.config.deviceId
      })

      console.log('[SpeechManager] Connecting to Realtime API...')
      const connected = await this.realtimeService.connect()
      
      if (connected) {
        this.currentBackend = 'realtime'
        this.config.onEvent({
          type: 'backend_changed',
          backend: 'realtime'
        })
        console.log('[SpeechManager] ✅ Using Realtime backend')
        return true
      } else {
        console.log('[SpeechManager] Realtime connect() returned false')
      }
    } catch (error) {
      console.error('[SpeechManager] ❌ Realtime backend failed:', error)
      this.realtimeService?.disconnect()
      this.realtimeService = null
    }

    return false
  }

  /**
   * Try to start the Whisper API backend
   */
  private async tryWhisperBackend(): Promise<boolean> {
    if (!this.apiKey) return false

    try {
      this.whisperService = new WhisperSpeechService({
        apiKey: this.apiKey,
        language: this.config.language,
        onEvent: (event) => this.handleWhisperEvent(event),
        silenceDuration: 1200, // Wait 1.2s of silence before finalizing
        chunkInterval: 2000, // Send chunks every 2 seconds for real-time
        deviceId: this.config.deviceId
      })

      const started = await this.whisperService.startRecording()
      
      if (started) {
        this.currentBackend = 'whisper'
        this.config.onEvent({
          type: 'connected',
          backend: 'whisper'
        })
        this.config.onEvent({
          type: 'backend_changed',
          backend: 'whisper'
        })
        console.log('[SpeechManager] Using Whisper backend')
        return true
      }
    } catch (error) {
      console.error('[SpeechManager] Whisper backend failed:', error)
      this.whisperService?.stopRecording()
      this.whisperService = null
    }

    return false
  }

  /**
   * Handle events from Realtime service
   */
  private handleRealtimeEvent(event: RealtimeEvent) {
    switch (event.type) {
      case 'connected':
        this.config.onEvent({ type: 'connected', backend: 'realtime' })
        break

      case 'disconnected':
        // No fallback - just report disconnection
        console.log('[SpeechManager] Realtime disconnected')
        this.config.onEvent({ type: 'disconnected' })
        break

      case 'transcript':
        this.config.onEvent({ 
          type: 'transcript_interim', 
          transcript: event.transcript 
        })
        break

      case 'transcript_final':
        if (event.transcript) {
          this.accumulatedTranscript += (this.accumulatedTranscript ? ' ' : '') + event.transcript
          this.config.onEvent({ 
            type: 'transcript_final', 
            transcript: event.transcript 
          })
        }
        break

      case 'speech_started':
        this.config.onEvent({ type: 'speech_started' })
        break

      case 'speech_stopped':
        this.config.onEvent({ type: 'speech_stopped' })
        break

      case 'error':
        console.error('[SpeechManager] Realtime error:', event.error)
        this.config.onEvent({ type: 'error', error: event.error })
        // No fallback - just report the error
        break
    }
  }

  /**
   * Handle events from Whisper service
   */
  private handleWhisperEvent(event: WhisperEvent) {
    switch (event.type) {
      case 'recording_started':
        this.config.onEvent({ type: 'connected', backend: 'whisper' })
        break

      case 'recording_stopped':
        this.config.onEvent({ type: 'disconnected' })
        break

      case 'transcript_partial':
        // Partial transcripts during speech - show as interim
        if (event.transcript) {
          // Update accumulated (replace with latest partial)
          this.accumulatedTranscript = event.transcript
          this.config.onEvent({ 
            type: 'transcript_interim', 
            transcript: event.transcript 
          })
        }
        break

      case 'transcript':
        // Final transcript after silence - this is the complete segment
        if (event.transcript) {
          this.accumulatedTranscript = event.transcript
          this.config.onEvent({ 
            type: 'transcript_final', 
            transcript: event.transcript 
          })
        }
        break

      case 'speech_detected':
        this.config.onEvent({ type: 'speech_started' })
        break

      case 'silence_detected':
        this.config.onEvent({ type: 'speech_stopped' })
        break

      case 'error':
        this.config.onEvent({ type: 'error', error: event.error })
        break
    }
  }

  /**
   * Stop listening and clean up
   */
  stopListening() {
    console.log('[SpeechManager] Stopping...')
    this.isActive = false

    if (this.realtimeService) {
      this.realtimeService.disconnect()
      this.realtimeService = null
    }

    if (this.whisperService) {
      this.whisperService.stopRecording()
      this.whisperService = null
    }

    this.currentBackend = 'none'
    this.config.onEvent({ type: 'disconnected' })
  }

  /**
   * Get the current backend being used
   */
  getCurrentBackend(): SpeechBackend {
    return this.currentBackend
  }

  /**
   * Check if currently listening
   */
  getIsListening(): boolean {
    return this.isActive
  }

  /**
   * Get accumulated transcript
   */
  getAccumulatedTranscript(): string {
    return this.accumulatedTranscript
  }

  /**
   * Clear accumulated transcript
   */
  clearTranscript() {
    this.accumulatedTranscript = ''
  }

  /**
   * Check if speech is currently detected
   */
  getIsSpeaking(): boolean {
    if (this.whisperService) {
      return this.whisperService.getIsSpeaking()
    }
    return false
  }

  /**
   * Set TTS playing state (for barge-in detection)
   */
  setTTSPlaying(playing: boolean) {
    if (this.whisperService) {
      this.whisperService.setTTSPlaying(playing)
    }
    if (this.realtimeService) {
      this.realtimeService.setTTSPlaying(playing)
    }
  }
  
  /**
   * Set callback for barge-in detection (user speaks during TTS)
   * When triggered, this callback should stop TTS playback
   */
  setBargeInCallback(callback: (() => void) | null) {
    if (this.whisperService) {
      this.whisperService.setBargeInCallback(callback)
    }
    if (this.realtimeService) {
      this.realtimeService.setBargeInCallback(callback)
    }
  }
}

// Singleton instance
let speechManagerInstance: SpeechManager | null = null

export function getSpeechManager(config?: SpeechManagerConfig): SpeechManager {
  if (!speechManagerInstance && config) {
    speechManagerInstance = new SpeechManager(config)
  } else if (!speechManagerInstance) {
    throw new Error('SpeechManager not initialized')
  }
  return speechManagerInstance
}

export function createSpeechManager(config: SpeechManagerConfig): SpeechManager {
  speechManagerInstance = new SpeechManager(config)
  return speechManagerInstance
}

export { SpeechManager }
export default SpeechManager

