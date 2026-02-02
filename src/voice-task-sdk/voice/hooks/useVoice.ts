/**
 * useVoice Hook - Main voice input hook for React applications
 * 
 * Provides a simple interface to start/stop voice recognition and
 * receive transcripts.
 */

import { useEffect, useCallback, useSyncExternalStore, useRef } from 'react'
import type { UseVoiceOptions, UseVoiceReturn, SpeechManagerConfig } from '../types'
import { createSpeechManager, type SpeechManager } from '../services/speechManager'
import { createVoiceStore, type VoiceStore } from '../stores/useVoiceStore'

// Singleton instances per config (keyed by apiKey for now)
const managers = new Map<string, SpeechManager>()
const stores = new Map<string, VoiceStore>()

// Callback registries to allow updating callbacks without recreating managers
const callbackRegistries = new Map<string, {
  onTranscript?: (transcript: string) => void
  onError?: (error: Error) => void
}>()

export interface UseVoiceConfig extends UseVoiceOptions {
  apiKey: string
  preferredBackend?: 'realtime' | 'whisper'
  language?: string
}

function getOrCreateInstances(config: UseVoiceConfig): { manager: SpeechManager; store: VoiceStore } {
  const key = config.apiKey

  if (!stores.has(key)) {
    stores.set(key, createVoiceStore())
  }
  const store = stores.get(key)!

  // Initialize callback registry if not exists
  if (!callbackRegistries.has(key)) {
    callbackRegistries.set(key, {})
  }

  if (!managers.has(key)) {
    const managerConfig: SpeechManagerConfig = {
      apiKey: config.apiKey,
      preferredBackend: config.preferredBackend,
      language: config.language,
      onTranscript: (transcript, isFinal) => {
        if (isFinal) {
          store.getState().setTranscript(transcript)
          store.getState().setInterimTranscript('')
          // Use callback from registry (always up-to-date)
          callbackRegistries.get(key)?.onTranscript?.(transcript)
        } else {
          store.getState().setInterimTranscript(transcript)
        }
      },
      onError: (error) => {
        store.getState().setError(error.message)
        // Use callback from registry (always up-to-date)
        callbackRegistries.get(key)?.onError?.(error)
      },
      onStateChange: (state) => {
        if (state.status) {
          store.getState().setStatus(state.status)
        }
        if (state.connectionState) {
          store.getState().setConnectionState(state.connectionState)
        }
      },
      onVolumeChange: (volume) => {
        store.getState().setVolume(volume)
      },
    }

    managers.set(key, createSpeechManager(managerConfig))
  }

  return { manager: managers.get(key)!, store }
}

export function useVoice(config: UseVoiceConfig): UseVoiceReturn {
  const { manager, store } = getOrCreateInstances(config)

  // Update callback registry with latest callbacks on each render
  // This fixes the stale closure bug where callbacks were captured at creation time
  const registry = callbackRegistries.get(config.apiKey)
  if (registry) {
    registry.onTranscript = config.onTranscript
    registry.onError = config.onError
  }

  // Subscribe to store changes
  const state = useSyncExternalStore(
    store.subscribe,
    () => store.getState(),
    () => store.getState()
  )

  const start = useCallback(async () => {
    store.getState().setError(null)
    store.getState().setTranscript('')
    store.getState().setInterimTranscript('')

    try {
      await manager.start()
      store.getState().setListening(true)
    } catch (error) {
      store.getState().setError(error instanceof Error ? error.message : 'Failed to start')
      throw error
    }
  }, [manager, store])

  const stop = useCallback(() => {
    manager.stop()
    store.getState().setListening(false)
  }, [manager, store])

  const toggle = useCallback(async () => {
    if (state.isListening) {
      stop()
    } else {
      await start()
    }
  }, [state.isListening, start, stop])

  // Auto-start if configured
  useEffect(() => {
    if (config.autoStart) {
      start().catch(console.error)
    }

    return () => {
      // Don't stop on unmount - let the manager persist
      // User should explicitly call stop()
    }
  }, [config.autoStart, start])

  return {
    // State
    status: state.status,
    isListening: state.isListening,
    isSpeaking: state.isSpeaking,
    transcript: state.transcript,
    interimTranscript: state.interimTranscript,
    error: state.error,
    volume: state.volume,

    // Controls
    start,
    stop,
    toggle,
  }
}

/**
 * Cleanup function to destroy all voice instances
 * Call this when the app unmounts
 */
export function cleanupVoice(): void {
  for (const manager of managers.values()) {
    manager.destroy()
  }
  managers.clear()
  stores.clear()
  callbackRegistries.clear()
}
