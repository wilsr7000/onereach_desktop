/**
 * Whisper Speech Service - Batch transcription fallback
 * 
 * Records audio chunks and sends them to the Whisper API for transcription.
 * Used as a fallback when Realtime API is unavailable or for longer recordings.
 * 
 * Preferred: provide config.transcribeFn (from window.ai.transcribe) to route
 * through the centralized ai-service with retry, fallback, and cost tracking.
 */

import type { SpeechService, WhisperConfig, VoiceState } from '../types'

const DEFAULT_MODEL = 'whisper-1'

export function createWhisperSpeechService(config: WhisperConfig): SpeechService {
  const {
    apiKey,
    model = DEFAULT_MODEL,
    language = 'en',
    onTranscript,
    onError,
    onStateChange,
    onVolumeChange,
    chunkDurationMs = 5000,
    minChunkDurationMs = 1000,
    maxSilenceMs = 2000,
    transcribeFn,
  } = config

  let mediaStream: MediaStream | null = null
  let mediaRecorder: MediaRecorder | null = null
  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let chunks: Blob[] = []
  let active = false
  let chunkTimer: ReturnType<typeof setTimeout> | null = null
  let silenceTimer: ReturnType<typeof setTimeout> | null = null
  let lastSpeechTime = 0

  const state: Partial<VoiceState> = {
    status: 'idle',
    connectionState: 'connected', // No persistent connection for Whisper
    volume: 0,
  }

  function updateState(updates: Partial<VoiceState>): void {
    Object.assign(state, updates)
    onStateChange?.(updates)
  }

  function handleError(error: Error): void {
    console.error('[whisperSpeech] Error:', error.message)
    updateState({ status: 'error' })
    onError?.(error)
  }

  async function transcribeChunk(audioBlob: Blob): Promise<void> {
    if (audioBlob.size === 0) return

    updateState({ status: 'processing' })

    try {
      let result: { text: string }

      if (transcribeFn) {
        // Preferred: use IPC-proxied transcription via centralized ai-service
        const arrayBuffer = await audioBlob.arrayBuffer()
        result = await transcribeFn(arrayBuffer, { language, filename: 'audio.webm' })
      } else if (typeof window !== 'undefined' && (window as any).ai?.transcribe) {
        // Fallback: use window.ai.transcribe IPC bridge
        console.warn('[whisperSpeech] Using window.ai.transcribe fallback. Provide config.transcribeFn for best results.')
        const arrayBuffer = await audioBlob.arrayBuffer()
        result = await (window as any).ai.transcribe(arrayBuffer, { language, filename: 'audio.webm' })
      } else {
        throw new Error(
          '[whisperSpeech] No transcription method available. ' +
          'Provide config.transcribeFn or ensure window.ai.transcribe is available via preload.'
        )
      }

      if (result.text) {
        onTranscript?.(result.text.trim(), true)
      }

      if (active) {
        updateState({ status: 'listening' })
      }
    } catch (error) {
      handleError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  function scheduleChunkTranscription(): void {
    if (chunkTimer) {
      clearTimeout(chunkTimer)
    }

    chunkTimer = setTimeout(() => {
      if (chunks.length > 0 && active) {
        const audioBlob = new Blob(chunks, { type: 'audio/webm' })
        chunks = []
        transcribeChunk(audioBlob)
      }
      
      if (active) {
        scheduleChunkTranscription()
      }
    }, chunkDurationMs)
  }

  function checkSilence(): void {
    if (!analyser) return

    const dataArray = new Uint8Array(analyser.frequencyBinCount)
    analyser.getByteFrequencyData(dataArray)
    const average = dataArray.reduce((a, b) => a + b) / dataArray.length
    const normalizedVolume = average / 255

    onVolumeChange?.(normalizedVolume)

    // Detect speech vs silence
    const isSpeaking = normalizedVolume > 0.05

    if (isSpeaking) {
      lastSpeechTime = Date.now()
      
      if (silenceTimer) {
        clearTimeout(silenceTimer)
        silenceTimer = null
      }
    } else if (lastSpeechTime > 0) {
      // Check for silence timeout
      const silenceDuration = Date.now() - lastSpeechTime

      if (silenceDuration >= maxSilenceMs && chunks.length > 0) {
        // End of utterance - transcribe now
        if (chunkTimer) {
          clearTimeout(chunkTimer)
        }
        
        const audioBlob = new Blob(chunks, { type: 'audio/webm' })
        chunks = []
        transcribeChunk(audioBlob)
        lastSpeechTime = 0
        
        scheduleChunkTranscription()
      }
    }
  }

  async function start(): Promise<void> {
    if (active) return

    active = true
    chunks = []
    lastSpeechTime = 0
    updateState({ status: 'listening' })

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      })

      // Setup audio context for volume analysis
      audioContext = new AudioContext()
      const source = audioContext.createMediaStreamSource(mediaStream)
      analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)

      // Setup media recorder
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'

      mediaRecorder = new MediaRecorder(mediaStream, { mimeType })

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data)
        }
      }

      mediaRecorder.onerror = (event) => {
        handleError(new Error('MediaRecorder error'))
      }

      // Start recording in small chunks
      mediaRecorder.start(500)

      // Schedule periodic transcription
      scheduleChunkTranscription()

      // Start silence detection loop
      const silenceLoop = setInterval(() => {
        if (active) {
          checkSilence()
        } else {
          clearInterval(silenceLoop)
        }
      }, 100)
    } catch (error) {
      handleError(error instanceof Error ? error : new Error('Microphone access denied'))
      throw error
    }
  }

  function stop(): void {
    active = false
    updateState({ status: 'idle' })

    if (chunkTimer) {
      clearTimeout(chunkTimer)
      chunkTimer = null
    }

    if (silenceTimer) {
      clearTimeout(silenceTimer)
      silenceTimer = null
    }

    // Transcribe any remaining audio
    if (chunks.length > 0) {
      const audioBlob = new Blob(chunks, { type: 'audio/webm' })
      chunks = []
      transcribeChunk(audioBlob)
    }

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop()
    }
    mediaRecorder = null

    if (analyser) {
      analyser.disconnect()
      analyser = null
    }

    if (audioContext) {
      audioContext.close()
      audioContext = null
    }

    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop())
      mediaStream = null
    }
  }

  function isActive(): boolean {
    return active
  }

  function getState(): Partial<VoiceState> {
    return { ...state }
  }

  function destroy(): void {
    stop()
  }

  return {
    start,
    stop,
    isActive,
    getState,
    destroy,
  }
}
