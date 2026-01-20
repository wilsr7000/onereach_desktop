/**
 * Voice Module Type Definitions
 */

// ============================================================================
// VOICE STATE
// ============================================================================

export type VoiceStatus = 
  | 'idle'
  | 'listening'
  | 'processing'
  | 'speaking'
  | 'error'

export type SpeechBackend = 'realtime' | 'whisper'

export interface VoiceState {
  status: VoiceStatus
  isListening: boolean
  isSpeaking: boolean
  transcript: string
  interimTranscript: string
  error: string | null
  volume: number
  backend: SpeechBackend
  connectionState: 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
}

// ============================================================================
// SPEECH SERVICE INTERFACES
// ============================================================================

export interface SpeechServiceConfig {
  apiKey: string
  model?: string
  language?: string
  sampleRate?: number
  onTranscript?: (transcript: string, isFinal: boolean) => void
  onError?: (error: Error) => void
  onStateChange?: (state: Partial<VoiceState>) => void
  onVolumeChange?: (volume: number) => void
}

export interface SpeechService {
  start: () => Promise<void>
  stop: () => void
  isActive: () => boolean
  getState: () => Partial<VoiceState>
  destroy: () => void
}

// ============================================================================
// REALTIME API TYPES
// ============================================================================

export interface RealtimeConfig extends SpeechServiceConfig {
  voiceActivityDetection?: boolean
  vadThreshold?: number
  silenceTimeout?: number
}

export interface RealtimeMessage {
  type: string
  [key: string]: unknown
}

// ============================================================================
// WHISPER API TYPES
// ============================================================================

export interface WhisperConfig extends SpeechServiceConfig {
  chunkDurationMs?: number
  minChunkDurationMs?: number
  maxSilenceMs?: number
}

// ============================================================================
// SPEECH MANAGER TYPES
// ============================================================================

export interface SpeechManagerConfig {
  apiKey: string
  preferredBackend?: SpeechBackend
  fallbackEnabled?: boolean
  language?: string
  onTranscript?: (transcript: string, isFinal: boolean) => void
  onError?: (error: Error) => void
  onStateChange?: (state: Partial<VoiceState>) => void
  onVolumeChange?: (volume: number) => void
  realtime?: Partial<RealtimeConfig>
  whisper?: Partial<WhisperConfig>
}

export interface SpeechManager {
  start: () => Promise<void>
  stop: () => void
  isActive: () => boolean
  getState: () => VoiceState
  setBackend: (backend: SpeechBackend) => void
  getBackend: () => SpeechBackend
  destroy: () => void
}

// ============================================================================
// VOICE STORE TYPES
// ============================================================================

export interface VoiceStoreState extends VoiceState {
  // Actions
  setStatus: (status: VoiceStatus) => void
  setListening: (listening: boolean) => void
  setSpeaking: (speaking: boolean) => void
  setTranscript: (transcript: string) => void
  setInterimTranscript: (transcript: string) => void
  setError: (error: string | null) => void
  setVolume: (volume: number) => void
  setBackend: (backend: SpeechBackend) => void
  setConnectionState: (state: VoiceState['connectionState']) => void
  reset: () => void
}

// ============================================================================
// HOOK TYPES
// ============================================================================

export interface UseVoiceOptions {
  autoStart?: boolean
  onTranscript?: (transcript: string) => void
  onError?: (error: Error) => void
}

export interface UseVoiceReturn {
  // State
  status: VoiceStatus
  isListening: boolean
  isSpeaking: boolean
  transcript: string
  interimTranscript: string
  error: string | null
  volume: number
  
  // Controls
  start: () => Promise<void>
  stop: () => void
  toggle: () => Promise<void>
}
