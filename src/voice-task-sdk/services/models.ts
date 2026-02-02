/**
 * ============================================================================
 * MODEL CONFIGURATION - Verified Working OpenAI Models
 * ============================================================================
 * 
 * These are the actual OpenAI model identifiers that work with the API.
 * 
 * IMPORTANT NOTES:
 * - For gpt-5.2: Use `max_completion_tokens` instead of `max_tokens`
 * - Realtime API requires specific preview models
 * - TTS and Transcription use dedicated models (tts-1, whisper-1)
 * 
 * ============================================================================
 */

// Primary chat/completion model - USE THIS FOR ALL TEXT GENERATION
// Note: Use max_completion_tokens (not max_tokens) with this model
export const MODEL_CHAT = 'gpt-5.2'

// Realtime voice model for live conversations (WebSocket API)
export const MODEL_REALTIME = 'gpt-4o-realtime-preview-2024-12-17'

// Image generation model
export const MODEL_IMAGE = 'gpt-image-1.5'

// Text-to-speech model (voices: alloy, echo, fable, onyx, nova, shimmer)
export const MODEL_TTS = 'tts-1'

// Speech-to-text/transcription model
export const MODEL_TRANSCRIBE = 'whisper-1'

// Embedding model for semantic search
export const MODEL_EMBEDDING = 'text-embedding-3-large'

/**
 * Helper to get the appropriate model for a task
 */
export function getModel(task: 'chat' | 'realtime' | 'image' | 'tts' | 'transcribe' | 'embedding'): string {
  switch (task) {
    case 'chat': return MODEL_CHAT
    case 'realtime': return MODEL_REALTIME
    case 'image': return MODEL_IMAGE
    case 'tts': return MODEL_TTS
    case 'transcribe': return MODEL_TRANSCRIBE
    case 'embedding': return MODEL_EMBEDDING
    default: return MODEL_CHAT
  }
}

