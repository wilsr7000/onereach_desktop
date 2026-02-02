/**
 * Realtime Speech Service - OpenAI Realtime API WebSocket integration
 * 
 * Uses WebSocket connection for low-latency streaming transcription.
 * Falls back to Whisper if Realtime API is unavailable.
 */

import type { SpeechService, RealtimeConfig, VoiceState } from '../types'

const REALTIME_API_URL = 'wss://api.openai.com/v1/realtime'
const DEFAULT_MODEL = 'gpt-4o-realtime-preview-2024-10-01'

export interface RealtimeSpeechService extends SpeechService {
  send: (message: unknown) => void
}

export function createRealtimeSpeechService(config: RealtimeConfig): RealtimeSpeechService {
  const {
    apiKey,
    model = DEFAULT_MODEL,
    language = 'en',
    onTranscript,
    onError,
    onStateChange,
    onVolumeChange,
    voiceActivityDetection = true,
    vadThreshold = 0.5,
    silenceTimeout = 1000,
  } = config

  let ws: WebSocket | null = null
  let mediaStream: MediaStream | null = null
  let audioContext: AudioContext | null = null
  let processor: ScriptProcessorNode | null = null
  let analyser: AnalyserNode | null = null
  let active = false
  let reconnectAttempts = 0
  const maxReconnectAttempts = 3

  const state: Partial<VoiceState> = {
    status: 'idle',
    connectionState: 'disconnected',
    volume: 0,
  }

  function updateState(updates: Partial<VoiceState>): void {
    Object.assign(state, updates)
    onStateChange?.(updates)
  }

  function handleMessage(event: MessageEvent): void {
    try {
      const message = JSON.parse(event.data)

      switch (message.type) {
        case 'session.created':
          updateState({ connectionState: 'connected' })
          configureSession()
          break

        case 'input_audio_buffer.speech_started':
          updateState({ status: 'listening' })
          break

        case 'input_audio_buffer.speech_stopped':
          updateState({ status: 'processing' })
          break

        case 'conversation.item.input_audio_transcription.completed':
          if (message.transcript) {
            onTranscript?.(message.transcript, true)
          }
          break

        case 'response.audio_transcript.delta':
          if (message.delta) {
            onTranscript?.(message.delta, false)
          }
          break

        case 'error':
          handleError(new Error(message.error?.message || 'Realtime API error'))
          break
      }
    } catch (error) {
      console.error('[realtimeSpeech] Message parse error:', error)
    }
  }

  function configureSession(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    // Configure session for transcription
    send({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        input_audio_format: 'pcm16',
        input_audio_transcription: {
          model: 'whisper-1',
        },
        turn_detection: voiceActivityDetection ? {
          type: 'server_vad',
          threshold: vadThreshold,
          silence_duration_ms: silenceTimeout,
        } : null,
      },
    })
  }

  function handleError(error: Error): void {
    console.error('[realtimeSpeech] Error:', error.message)
    updateState({ status: 'error' })
    onError?.(error)
  }

  function connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        updateState({ connectionState: 'connecting' })

        const url = `${REALTIME_API_URL}?model=${model}`
        ws = new WebSocket(url, [
          'realtime',
          `openai-insecure-api-key.${apiKey}`,
          'openai-beta.realtime-v1',
        ])

        ws.onopen = () => {
          reconnectAttempts = 0
          resolve()
        }

        ws.onmessage = handleMessage

        ws.onerror = (event) => {
          handleError(new Error('WebSocket error'))
          reject(new Error('WebSocket connection failed'))
        }

        ws.onclose = (event) => {
          updateState({ connectionState: 'disconnected' })

          // Attempt reconnect if not intentionally stopped
          if (active && reconnectAttempts < maxReconnectAttempts) {
            reconnectAttempts++
            updateState({ connectionState: 'reconnecting' })
            setTimeout(() => {
              connect().catch(handleError)
            }, 1000 * reconnectAttempts)
          }
        }
      } catch (error) {
        reject(error)
      }
    })
  }

  async function startAudio(): Promise<void> {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 24000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      })

      audioContext = new AudioContext({ sampleRate: 24000 })
      const source = audioContext.createMediaStreamSource(mediaStream)

      // Create analyser for volume monitoring
      analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)

      // Create processor for sending audio data
      processor = audioContext.createScriptProcessor(4096, 1, 1)
      source.connect(processor)
      processor.connect(audioContext.destination)

      processor.onaudioprocess = (event) => {
        if (!active || !ws || ws.readyState !== WebSocket.OPEN) return

        const inputData = event.inputBuffer.getChannelData(0)
        
        // Convert to 16-bit PCM
        const pcm16 = new Int16Array(inputData.length)
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]))
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
        }

        // Send audio buffer
        send({
          type: 'input_audio_buffer.append',
          audio: btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer))),
        })

        // Update volume
        if (analyser) {
          const dataArray = new Uint8Array(analyser.frequencyBinCount)
          analyser.getByteFrequencyData(dataArray)
          const average = dataArray.reduce((a, b) => a + b) / dataArray.length
          const normalizedVolume = average / 255
          onVolumeChange?.(normalizedVolume)
        }
      }
    } catch (error) {
      throw new Error(`Microphone access denied: ${error}`)
    }
  }

  function stopAudio(): void {
    if (processor) {
      processor.disconnect()
      processor = null
    }

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

  function send(message: unknown): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message))
    }
  }

  async function start(): Promise<void> {
    if (active) return

    active = true
    updateState({ status: 'listening' })

    await connect()
    await startAudio()
  }

  function stop(): void {
    active = false
    updateState({ status: 'idle' })

    stopAudio()

    if (ws) {
      ws.close()
      ws = null
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
    send,
  }
}
