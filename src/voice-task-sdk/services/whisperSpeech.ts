/**
 * Whisper Speech Service - Continuous Mode (via unified ai-service)
 * 
 * Real-time speech-to-text using the centralized AI service.
 * Accumulates ALL audio and sends the complete file each time.
 * Tracks the last transcript to only emit new content.
 * 
 * Supports an optional `transcribeFn` in config for IPC-proxied
 * transcription via ai-service. Falls back to direct fetch if not provided.
 */

export type WhisperEventType = 
  | 'recording_started'
  | 'recording_stopped'
  | 'transcript'
  | 'transcript_partial'
  | 'error'
  | 'speech_detected'
  | 'silence_detected'

export interface WhisperEvent {
  type: WhisperEventType
  transcript?: string
  error?: string
}

export type WhisperEventCallback = (event: WhisperEvent) => void

/**
 * Optional IPC-proxied transcription function.
 * When provided, audio is sent to the main process via IPC and transcribed
 * through the centralized ai-service (with retry, cost tracking, etc.).
 * The function receives an ArrayBuffer of audio data and returns { text }.
 */
type TranscribeFn = (audioArrayBuffer: ArrayBuffer, opts: {
  language?: string
  filename?: string
}) => Promise<{ text: string }>

interface WhisperSpeechConfig {
  apiKey: string
  language?: string
  onEvent: WhisperEventCallback
  silenceThreshold?: number
  silenceDuration?: number
  chunkInterval?: number
  deviceId?: string | null  // Specific microphone device ID
  transcribeFn?: TranscribeFn  // Preferred: IPC-proxied ai-service transcription
}

export class WhisperSpeechService {
  private mediaRecorder: MediaRecorder | null = null
  private audioChunks: Blob[] = []
  private stream: MediaStream | null = null
  private config: WhisperSpeechConfig
  private isRecording = false
  private audioContext: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private isProcessing = false

  // Voice activity detection
  private vadInterval: NodeJS.Timeout | null = null
  private isSpeaking = false
  private silenceTimer: NodeJS.Timeout | null = null
  
  // Real-time chunking
  private chunkTimer: NodeJS.Timeout | null = null
  
  // Track transcripts to emit only new content
  private lastFullTranscript = ''
  private lastEmittedLength = 0
  
  // Minimum bytes for valid audio
  private readonly MIN_VALID_SIZE = 15000
  
  // Common Whisper hallucinations to filter out
  private readonly HALLUCINATION_PHRASES = [
    'thank you',
    'thanks',
    'bye',
    'goodbye',
    'thank you very much',
    'thanks for watching',
    'thanks for listening',
    'see you',
    'see you next time',
    'subscribe',
    'like and subscribe',
    'you',
    'bye bye',
    'bye-bye',
    'okay',
    'ok',
    'thanks for tuning in',
    'i\'ll see you soon',
    'see you soon',
    'okay bye',
    'okay. bye',
    'thank you. bye',
    'thank you bye',
    'um',
    'uh',
    'hmm',
    'ah',
    'oh',
    'so',
    'yeah',
    'yes',
    'no',
    'the end',
    'music',
    '[music]',
    '♪',
    '...',
    'silence',
    'inaudible',
  ]
  
  // Cooldown after restart to prevent invalid transcriptions
  private restartTime = 0
  private readonly RESTART_COOLDOWN_MS = 2000
  
  // Track recorder instance to ignore data from old recorders
  private recorderInstance = 0
  
  // Flag to track TTS playback for barge-in detection
  private isTTSPlaying = false
  
  // Callback for barge-in detection (user speaks during TTS)
  private onBargeIn: (() => void) | null = null

  constructor(config: WhisperSpeechConfig) {
    this.config = {
      silenceThreshold: config.silenceThreshold ?? 0.015,
      silenceDuration: config.silenceDuration ?? 1500,
      chunkInterval: config.chunkInterval ?? 2500,
      ...config
    }
  }

  /**
   * Start recording audio from microphone
   */
  async startRecording(): Promise<boolean> {
    if (this.isRecording) return true
    
    try {
      // Build audio constraints with optional device selection
      const audioConstraints: MediaTrackConstraints = {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
      }
      
      // Use specific device if provided (e.g., AirPods)
      if (this.config.deviceId) {
        audioConstraints.deviceId = { exact: this.config.deviceId }
        console.log('[WhisperSpeech] Using specific microphone:', this.config.deviceId)
      }
      
      this.stream = await navigator.mediaDevices.getUserMedia({ 
        audio: audioConstraints
      })

      this.setupVoiceActivityDetection()

      const mimeType = this.getSupportedMimeType()
      this.mediaRecorder = new MediaRecorder(this.stream, { 
        mimeType,
        audioBitsPerSecond: 128000
      })

      // Reset state for new recording session
      this.audioChunks = []
      this.lastFullTranscript = ''
      this.lastEmittedLength = 0
      this.recorderInstance++
      
      const currentInstance = this.recorderInstance

      this.mediaRecorder.ondataavailable = (event) => {
        // Only accept data from the current recorder instance
        if (event.data.size > 0 && currentInstance === this.recorderInstance) {
          this.audioChunks.push(event.data)
        }
      }

      this.mediaRecorder.onstop = async () => {
        // Process any remaining audio on stop
        if (this.audioChunks.length > 0 && !this.isProcessing) {
          await this.transcribeCurrentAudio(true)
        }
      }

      // Get data every 500ms
      this.mediaRecorder.start(500)
      this.isRecording = true
      
      console.log('[WhisperSpeech] Recording started')
      this.config.onEvent({ type: 'recording_started' })
      
      return true
    } catch (error) {
      console.error('[WhisperSpeech] Failed to start recording:', error)
      this.config.onEvent({ 
        type: 'error', 
        error: error instanceof Error ? error.message : 'Failed to start recording' 
      })
      return false
    }
  }

  /**
   * Check if text is likely a Whisper hallucination
   */
  private isHallucination(text: string): boolean {
    // Remove punctuation and normalize
    const normalized = text.toLowerCase().replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim()
    
    // Check exact matches
    if (this.HALLUCINATION_PHRASES.includes(normalized)) {
      return true
    }
    
    // Check if any hallucination phrase is contained
    for (const phrase of this.HALLUCINATION_PHRASES) {
      if (normalized === phrase || normalized.startsWith(phrase + ' ') || normalized.endsWith(' ' + phrase)) {
        return true
      }
    }
    
    const words = normalized.split(/\s+/)
    
    // Very short text with hallucination words
    if (words.length <= 3) {
      const hallucinationWords = ['thank', 'thanks', 'bye', 'goodbye', 'okay', 'ok', 'you', 'see', 'soon']
      if (words.every(w => hallucinationWords.includes(w))) {
        console.log('[WhisperSpeech] Detected short hallucination:', text)
        return true
      }
    }
    
    // Check for repeated words (e.g., "Bye. Bye. Bye. Bye.")
    if (words.length >= 2) {
      const uniqueWords = new Set(words)
      if (uniqueWords.size <= 2 && words.length >= 3) {
        console.log('[WhisperSpeech] Detected repeated word hallucination:', text)
        return true
      }
    }
    
    // Check for repeated phrases (another hallucination pattern)
    if (words.length >= 4) {
      const firstHalf = words.slice(0, Math.floor(words.length / 2)).join(' ')
      const secondHalf = words.slice(Math.floor(words.length / 2)).join(' ')
      if (firstHalf === secondHalf) {
        console.log('[WhisperSpeech] Detected repeated phrase hallucination:', text)
        return true
      }
    }
    
    return false
  }

  private getSupportedMimeType(): string {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
      'audio/wav'
    ]

    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        console.log('[WhisperSpeech] Using MIME type:', type)
        return type
      }
    }

    return 'audio/webm'
  }

  private setupVoiceActivityDetection() {
    if (!this.stream) return

    this.audioContext = new AudioContext()
    const source = this.audioContext.createMediaStreamSource(this.stream)
    this.analyser = this.audioContext.createAnalyser()
    this.analyser.fftSize = 512
    this.analyser.smoothingTimeConstant = 0.8
    source.connect(this.analyser)

    this.vadInterval = setInterval(() => {
      this.checkVoiceActivity()
    }, 100)
  }

  private checkVoiceActivity() {
    if (!this.analyser) return

    const dataArray = new Uint8Array(this.analyser.frequencyBinCount)
    this.analyser.getByteFrequencyData(dataArray)

    const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length
    const normalizedVolume = average / 255

    const wasSpeaking = this.isSpeaking
    this.isSpeaking = normalizedVolume > (this.config.silenceThreshold ?? 0.015)

    // Speech started
    if (this.isSpeaking && !wasSpeaking) {
      this.clearSilenceTimer()
      this.startChunkTimer()
      
      // BARGE-IN: If TTS is playing and user starts speaking, interrupt it
      if (this.isTTSPlaying && this.onBargeIn) {
        console.log('[WhisperSpeech] BARGE-IN detected - user interrupting TTS')
        this.onBargeIn()
        this.isTTSPlaying = false
      }
      
      this.config.onEvent({ type: 'speech_detected' })
    }

    // Speech stopped
    if (!this.isSpeaking && wasSpeaking) {
      this.startSilenceTimer()
    }
  }

  private startChunkTimer() {
    this.stopChunkTimer()
    
    // Send transcription periodically while speaking
    this.chunkTimer = setInterval(() => {
      if (this.isSpeaking && this.audioChunks.length > 0) {
        this.transcribeCurrentAudio(false)
      }
    }, this.config.chunkInterval ?? 2500)
  }

  private stopChunkTimer() {
    if (this.chunkTimer) {
      clearInterval(this.chunkTimer)
      this.chunkTimer = null
    }
  }

  private startSilenceTimer() {
    this.clearSilenceTimer()
    
    this.silenceTimer = setTimeout(() => {
      if (this.isRecording && !this.isSpeaking && this.audioChunks.length > 0) {
        this.stopChunkTimer()
        this.config.onEvent({ type: 'silence_detected' })
        this.transcribeCurrentAudio(true)
      }
    }, this.config.silenceDuration)
  }

  private clearSilenceTimer() {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = null
    }
  }

  /**
   * Transcribe all accumulated audio
   */
  private async transcribeCurrentAudio(isFinal: boolean): Promise<void> {
    if (this.audioChunks.length === 0 || this.isProcessing) return
    
    // Skip transcription while TTS is playing (to avoid feedback loop)
    if (this.isTTSPlaying) {
      console.log('[WhisperSpeech] TTS playing, skipping transcription')
      return
    }
    
    // Check cooldown period after restart
    const timeSinceRestart = Date.now() - this.restartTime
    if (this.restartTime > 0 && timeSinceRestart < this.RESTART_COOLDOWN_MS) {
      console.log('[WhisperSpeech] In cooldown period, skipping transcription')
      return
    }
    
    // Create blob from ALL chunks (always includes header)
    const audioBlob = new Blob(this.audioChunks, { type: this.audioChunks[0].type })
    
    if (audioBlob.size < this.MIN_VALID_SIZE) {
      console.log('[WhisperSpeech] Audio too small:', audioBlob.size, 'bytes')
      return
    }
    
    this.isProcessing = true
    
    try {
      console.log(`[WhisperSpeech] Transcribing ${isFinal ? 'final' : 'partial'}:`, audioBlob.size, 'bytes')

      const mimeType = audioBlob.type
      let extension = 'webm'
      if (mimeType.includes('ogg')) extension = 'ogg'
      else if (mimeType.includes('mp4')) extension = 'mp4'
      else if (mimeType.includes('wav')) extension = 'wav'
      
      let result: { text: string }

      if (this.config.transcribeFn) {
        // Preferred path: IPC-proxied transcription via centralized ai-service
        // This path provides retry, fallback, circuit breaker, and cost tracking
        console.log('[WhisperSpeech] Using IPC-proxied transcription via ai-service')
        const arrayBuffer = await audioBlob.arrayBuffer()
        result = await this.config.transcribeFn(arrayBuffer, {
          language: this.config.language,
          filename: `audio.${extension}`,
        })
      } else if (typeof window !== 'undefined' && (window as any).ai?.transcribe) {
        // Fallback: use window.ai.transcribe (IPC bridge to centralized ai-service)
        console.warn('[WhisperSpeech] config.transcribeFn not provided, falling back to window.ai.transcribe')
        const arrayBuffer = await audioBlob.arrayBuffer()
        result = await (window as any).ai.transcribe(arrayBuffer, {
          language: this.config.language,
          filename: `audio.${extension}`,
        })
      } else {
        throw new Error(
          '[WhisperSpeech] No transcription method available. ' +
          'Provide config.transcribeFn or ensure window.ai.transcribe is available via preload.'
        )
      }
      
      if (result.text) {
        const fullTranscript = result.text.trim()
        
        // Check if this is a hallucination
        if (this.isHallucination(fullTranscript)) {
          console.log('[WhisperSpeech] Filtered hallucination:', fullTranscript)
          return
        }
        
        if (isFinal) {
          // For final: emit the full transcript and restart fresh
          const newContent = fullTranscript.substring(this.lastEmittedLength).trim()
          if (newContent && !this.isHallucination(newContent)) {
            console.log('[WhisperSpeech] Final transcript:', newContent)
            this.config.onEvent({ type: 'transcript', transcript: newContent })
          }
          
          // RESTART: Clear everything and start fresh recording
          await this.restartRecording()
        } else {
          // For partial: show what's new since last emission
          const newContent = fullTranscript.substring(this.lastEmittedLength).trim()
          if (newContent && newContent !== this.lastFullTranscript && !this.isHallucination(newContent)) {
            this.lastFullTranscript = newContent
            console.log('[WhisperSpeech] Partial transcript:', newContent)
            this.config.onEvent({ type: 'transcript_partial', transcript: newContent })
          }
        }
      }
    } catch (error) {
      console.error('[WhisperSpeech] Transcription error:', error)
      this.config.onEvent({ 
        type: 'error', 
        error: error instanceof Error ? error.message : 'Transcription failed' 
      })
    } finally {
      this.isProcessing = false
    }
  }

  /**
   * Restart recording with fresh state
   */
  private async restartRecording(): Promise<void> {
    console.log('[WhisperSpeech] Restarting recording...')
    
    // Clear any pending timers
    this.clearSilenceTimer()
    this.stopChunkTimer()
    
    // Increment instance FIRST to invalidate old recorder's data
    this.recorderInstance++
    const currentInstance = this.recorderInstance
    
    // Clear state
    this.audioChunks = []
    this.lastFullTranscript = ''
    this.lastEmittedLength = 0
    
    // Set restart time for cooldown
    this.restartTime = Date.now()
    
    // Stop current recorder (any data it sends will be ignored due to instance mismatch)
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop()
    }
    
    // Wait for clean stop
    await new Promise(resolve => setTimeout(resolve, 200))
    
    // Start new recorder if still recording
    if (this.isRecording && this.stream) {
      const mimeType = this.getSupportedMimeType()
      this.mediaRecorder = new MediaRecorder(this.stream, { 
        mimeType,
        audioBitsPerSecond: 128000
      })

      this.mediaRecorder.ondataavailable = (event) => {
        // Only accept data from this recorder instance
        if (event.data.size > 0 && currentInstance === this.recorderInstance) {
          this.audioChunks.push(event.data)
        } else if (event.data.size > 0) {
          console.log('[WhisperSpeech] Ignoring data from old recorder instance')
        }
      }

      this.mediaRecorder.start(500)
      console.log('[WhisperSpeech] Recording restarted fresh (instance', currentInstance, ')')
    }
  }

  /**
   * Stop recording and clean up
   */
  stopRecording() {
    console.log('[WhisperSpeech] Stopping recording...')
    
    this.isRecording = false
    this.clearSilenceTimer()
    this.stopChunkTimer()

    if (this.vadInterval) {
      clearInterval(this.vadInterval)
      this.vadInterval = null
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop()
    }
    this.mediaRecorder = null

    if (this.audioContext) {
      this.audioContext.close()
      this.audioContext = null
    }
    this.analyser = null

    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop())
      this.stream = null
    }

    this.config.onEvent({ type: 'recording_stopped' })
  }

  getIsRecording(): boolean {
    return this.isRecording
  }

  getIsProcessing(): boolean {
    return this.isProcessing
  }

  getIsSpeaking(): boolean {
    return this.isSpeaking
  }

  /**
   * Set TTS playing state - we keep listening for barge-in detection
   */
  setTTSPlaying(playing: boolean) {
    this.isTTSPlaying = playing
    console.log('[WhisperSpeech] TTS playing:', playing, '- listening for barge-in')
  }
  
  /**
   * Set callback for barge-in detection (user speaks during TTS)
   */
  setBargeInCallback(callback: (() => void) | null) {
    this.onBargeIn = callback
  }
}

export default WhisperSpeechService
