/**
 * Speech Manager - Orchestrates speech recognition backends
 * 
 * Manages switching between Realtime and Whisper backends with automatic
 * fallback support.
 */

import type { SpeechManager, SpeechManagerConfig, SpeechBackend, VoiceState, SpeechService } from '../types'
import { createRealtimeSpeechService } from './realtimeSpeech'
import { createWhisperSpeechService } from './whisperSpeech'

// Re-export type for consumers
export type { SpeechManager }

export function createSpeechManager(config: SpeechManagerConfig): SpeechManager {
  const {
    apiKey,
    preferredBackend = 'realtime',
    fallbackEnabled = true,
    language = 'en',
    onTranscript,
    onError,
    onStateChange,
    onVolumeChange,
    realtime = {},
    whisper = {},
  } = config

  let currentBackend: SpeechBackend = preferredBackend
  let service: SpeechService | null = null
  let active = false

  const state: VoiceState = {
    status: 'idle',
    isListening: false,
    isSpeaking: false,
    transcript: '',
    interimTranscript: '',
    error: null,
    volume: 0,
    backend: currentBackend,
    connectionState: 'disconnected',
  }

  function updateState(updates: Partial<VoiceState>): void {
    Object.assign(state, updates)
    onStateChange?.(updates)
  }

  function handleTranscript(transcript: string, isFinal: boolean): void {
    if (isFinal) {
      state.transcript = transcript
      state.interimTranscript = ''
    } else {
      state.interimTranscript = transcript
    }
    onTranscript?.(transcript, isFinal)
  }

  function handleError(error: Error): void {
    state.error = error.message
    updateState({ error: error.message, status: 'error' })

    // Attempt fallback if enabled
    if (fallbackEnabled && currentBackend === 'realtime' && active) {
      console.info('[speechManager] Falling back to Whisper')
      currentBackend = 'whisper'
      state.backend = 'whisper'

      // Recreate service with Whisper
      if (service) {
        service.destroy()
      }
      service = createService('whisper')
      service.start().catch(onError)
    } else {
      onError?.(error)
    }
  }

  function handleVolumeChange(volume: number): void {
    state.volume = volume
    onVolumeChange?.(volume)
  }

  function handleStateChange(updates: Partial<VoiceState>): void {
    Object.assign(state, updates)
    
    // Map status to state flags
    if (updates.status === 'listening') {
      state.isListening = true
      state.isSpeaking = false
    } else if (updates.status === 'speaking') {
      state.isSpeaking = true
      state.isListening = false
    } else if (updates.status === 'idle') {
      state.isListening = false
      state.isSpeaking = false
    }

    onStateChange?.(updates)
  }

  function createService(backend: SpeechBackend): SpeechService {
    const commonConfig = {
      apiKey,
      language,
      onTranscript: handleTranscript,
      onError: handleError,
      onStateChange: handleStateChange,
      onVolumeChange: handleVolumeChange,
    }

    if (backend === 'realtime') {
      return createRealtimeSpeechService({
        ...commonConfig,
        ...realtime,
      })
    } else {
      return createWhisperSpeechService({
        ...commonConfig,
        ...whisper,
      })
    }
  }

  async function start(): Promise<void> {
    if (active) return

    active = true
    currentBackend = preferredBackend
    state.backend = currentBackend
    updateState({ status: 'listening', isListening: true })

    service = createService(currentBackend)

    try {
      await service.start()
    } catch (error) {
      if (fallbackEnabled && currentBackend === 'realtime') {
        console.info('[speechManager] Realtime failed, using Whisper fallback')
        currentBackend = 'whisper'
        state.backend = 'whisper'
        
        service.destroy()
        service = createService('whisper')
        await service.start()
      } else {
        active = false
        throw error
      }
    }
  }

  function stop(): void {
    active = false
    updateState({ status: 'idle', isListening: false })

    if (service) {
      service.stop()
    }
  }

  function isActive(): boolean {
    return active
  }

  function getState(): VoiceState {
    return { ...state }
  }

  function setBackend(backend: SpeechBackend): void {
    if (backend === currentBackend) return

    const wasActive = active

    if (wasActive) {
      stop()
    }

    currentBackend = backend
    state.backend = backend

    if (service) {
      service.destroy()
      service = null
    }

    if (wasActive) {
      start().catch(handleError)
    }
  }

  function getBackend(): SpeechBackend {
    return currentBackend
  }

  function destroy(): void {
    stop()
    
    if (service) {
      service.destroy()
      service = null
    }
  }

  return {
    start,
    stop,
    isActive,
    getState,
    setBackend,
    getBackend,
    destroy,
  }
}
