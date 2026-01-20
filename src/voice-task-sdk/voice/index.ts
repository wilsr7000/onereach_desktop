/**
 * Voice Module Exports
 */

// Types
export type {
  VoiceStatus,
  SpeechBackend,
  VoiceState,
  SpeechServiceConfig,
  SpeechService,
  RealtimeConfig,
  WhisperConfig,
  SpeechManagerConfig,
  SpeechManager,
  VoiceStoreState,
  UseVoiceOptions,
  UseVoiceReturn,
} from './types'

// Stores
export { createVoiceStore, type VoiceStore } from './stores/useVoiceStore'

// Services
export { createRealtimeSpeechService, type RealtimeSpeechService } from './services/realtimeSpeech'
export { createWhisperSpeechService } from './services/whisperSpeech'
export { createSpeechManager } from './services/speechManager'

// Hooks
export { useVoice, cleanupVoice, type UseVoiceConfig } from './hooks/useVoice'
