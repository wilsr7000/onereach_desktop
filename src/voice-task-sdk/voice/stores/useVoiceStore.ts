/**
 * Voice Store - Zustand store for voice state management
 */

import { createStore } from 'zustand/vanilla'
import type { VoiceStoreState, VoiceStatus, SpeechBackend, VoiceState } from '../types'

const initialState: VoiceState = {
  status: 'idle',
  isListening: false,
  isSpeaking: false,
  transcript: '',
  interimTranscript: '',
  error: null,
  volume: 0,
  backend: 'realtime',
  connectionState: 'disconnected',
}

export function createVoiceStore() {
  return createStore<VoiceStoreState>((set) => ({
    ...initialState,

    setStatus: (status: VoiceStatus) => set({ status }),

    setListening: (isListening: boolean) => set({ 
      isListening,
      status: isListening ? 'listening' : 'idle',
    }),

    setSpeaking: (isSpeaking: boolean) => set({ 
      isSpeaking,
      status: isSpeaking ? 'speaking' : 'idle',
    }),

    setTranscript: (transcript: string) => set({ transcript }),

    setInterimTranscript: (interimTranscript: string) => set({ interimTranscript }),

    setError: (error: string | null) => set({ 
      error,
      status: error ? 'error' : 'idle',
    }),

    setVolume: (volume: number) => set({ volume: Math.max(0, Math.min(1, volume)) }),

    setBackend: (backend: SpeechBackend) => set({ backend }),

    setConnectionState: (connectionState: VoiceState['connectionState']) => set({ connectionState }),

    reset: () => set(initialState),
  }))
}

export type VoiceStore = ReturnType<typeof createVoiceStore>
