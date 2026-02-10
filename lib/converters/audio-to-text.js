/**
 * AudioToTextConverter
 *
 * @description Transcribes audio files to plain text using either the
 *   centralized AI service (Whisper) or the ElevenLabs-backed
 *   TranscriptionService for speaker-diarized output. Supports chunked
 *   transcription for long-form audio that exceeds API size limits.
 *
 * @agent converter:audio-to-text
 * @from mp3, wav, aac, ogg, flac, m4a, webm
 * @to   text
 *
 * @modes generative
 *
 * @strategies
 *   - whisper   -- Fast transcription via ai.transcribe() (OpenAI Whisper).
 *   - elevenlabs -- Diarized transcription via TranscriptionService (ElevenLabs Scribe).
 *   - chunked   -- Split long audio into segments, transcribe each, concatenate.
 *
 * @evaluation
 *   Structural: output must be a non-empty string.
 *   LLM spot-check: verifies coherence and completeness of transcript.
 *
 * @input  {Buffer|string} Audio buffer or absolute file path.
 * @output {string}        Plain-text transcript.
 *
 * @example
 *   const { AudioToTextConverter } = require('./audio-to-text');
const { getLogQueue } = require('./../log-event-queue');
const log = getLogQueue();
 *   const converter = new AudioToTextConverter();
 *   const result = await converter.convert(audioBuffer, {
 *     language: 'en',
 *   });
 *   log.info('app', result.output); // "Hello, welcome to the meeting..."
 *
 * @dependencies
 *   - lib/ai-service.js (transcribe method -- Whisper profile)
 *   - src/transcription/TranscriptionService.js (ElevenLabs Scribe)
 *   - ffmpeg (for chunked strategy -- splitting audio)
 */

'use strict';

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { BaseConverterAgent } = require('./base-converter-agent');

// Maximum chunk duration in seconds for the chunked strategy
const MAX_CHUNK_SECONDS = 600; // 10 minutes

class AudioToTextConverter extends BaseConverterAgent {
  /**
   * @param {Object} [config]
   * @param {Object}  [config.ai] - AI service override (testing)
   * @param {Object}  [config.transcriptionService] - TranscriptionService override
   * @param {string}  [config.ffmpegPath] - Custom FFmpeg binary path
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:audio-to-text';
    this.name = 'Audio to Text Converter';
    this.description = 'Transcribes audio to plain text using Whisper or ElevenLabs';

    this.from = ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a', 'webm'];
    this.to = ['text'];
    this.modes = ['generative'];

    this.strategies = [
      {
        id: 'whisper',
        description: 'Fast transcription via OpenAI Whisper',
        when: 'Quick single-speaker transcription; files under 25 MB',
        engine: 'openai-whisper',
        mode: 'generative',
        speed: 'fast',
        quality: 'Good for clear speech; no diarization',
      },
      {
        id: 'elevenlabs',
        description: 'Diarized transcription via ElevenLabs Scribe',
        when: 'Multiple speakers; need speaker labels and timestamps',
        engine: 'elevenlabs-scribe',
        mode: 'generative',
        speed: 'medium',
        quality: 'High quality with speaker diarization',
      },
      {
        id: 'chunked',
        description: 'Split long audio into segments and transcribe each',
        when: 'Audio exceeds 25 MB or is longer than 30 minutes',
        engine: 'openai-whisper + ffmpeg',
        mode: 'generative',
        speed: 'slow',
        quality: 'Handles arbitrarily long audio; may lose context at boundaries',
      },
    ];

    this._ffmpegPath = config.ffmpegPath || 'ffmpeg';
    this._transcriptionService = config.transcriptionService || null;
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Run the audio-to-text transcription.
   *
   * @param {Buffer|string} input - Audio buffer or file path
   * @param {string} strategy - One of 'whisper' | 'elevenlabs' | 'chunked'
   * @param {Object} [options]
   * @param {string} [options.language]   - ISO language code (e.g. 'en')
   * @param {boolean} [options.diarize]   - Enable diarization (elevenlabs only)
   * @param {number} [options.numSpeakers] - Expected speaker count
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const startTime = Date.now();

    switch (strategy) {
      case 'whisper':
        return this._executeWhisper(input, options, startTime);
      case 'elevenlabs':
        return this._executeElevenLabs(input, options, startTime);
      case 'chunked':
        return this._executeChunked(input, options, startTime);
      default:
        throw new Error(`Unknown strategy: ${strategy}`);
    }
  }

  // ===========================================================================
  // STRUCTURAL CHECKS
  // ===========================================================================

  /**
   * Verify the transcript is a non-empty string.
   *
   * @param {Buffer|string} input
   * @param {string} output
   * @param {string} strategy
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, strategy) {
    const issues = [];

    if (typeof output !== 'string') {
      issues.push({
        code: 'OUTPUT_NOT_STRING',
        severity: 'error',
        message: `Expected string output, got ${typeof output}`,
        fixable: true,
      });
      return issues;
    }

    if (output.trim().length === 0) {
      issues.push({
        code: 'TRANSCRIPT_EMPTY',
        severity: 'error',
        message: 'Transcription produced an empty string',
        fixable: true,
        suggestedStrategy: strategy === 'whisper' ? 'elevenlabs' : 'whisper',
      });
      return issues;
    }

    // Very short transcripts for non-trivial audio might indicate a problem
    const inputSize = Buffer.isBuffer(input)
      ? input.length
      : (typeof input === 'string' && fs.existsSync(input) ? fs.statSync(input).size : 0);

    // Rough heuristic: 1 MB of audio should produce at least 50 characters
    if (inputSize > 1_000_000 && output.trim().length < 50) {
      issues.push({
        code: 'TRANSCRIPT_SUSPICIOUSLY_SHORT',
        severity: 'warning',
        message: `Transcript is very short (${output.trim().length} chars) for ${(inputSize / 1_000_000).toFixed(1)} MB of audio`,
        fixable: true,
        suggestedStrategy: 'chunked',
      });
    }

    return issues;
  }

  // ===========================================================================
  // STRATEGY IMPLEMENTATIONS
  // ===========================================================================

  /**
   * Whisper strategy: fast transcription via the AI service.
   * @private
   */
  async _executeWhisper(input, options, startTime) {
    if (!this._ai || !this._ai.transcribe) {
      throw new Error('AI service with transcribe() is required for the whisper strategy');
    }

    const audioBuffer = this._ensureBuffer(input);

    const result = await this._ai.transcribe(audioBuffer, {
      language: options.language || undefined,
      feature: 'converter-audio-to-text',
    });

    const transcript = result.text || '';

    return {
      output: transcript,
      metadata: {
        strategy: 'whisper',
        language: result.language || options.language || 'auto',
        model: result.model || 'whisper-1',
        provider: result.provider || 'openai',
        inputSize: audioBuffer.length,
        outputLength: transcript.length,
      },
      duration: Date.now() - startTime,
      strategy: 'whisper',
    };
  }

  /**
   * ElevenLabs strategy: diarized transcription via TranscriptionService.
   * @private
   */
  async _executeElevenLabs(input, options, startTime) {
    const service = this._getTranscriptionService();
    const audioPath = this._ensureFilePath(input);
    const shouldCleanup = Buffer.isBuffer(input);

    try {
      const result = await service.transcribe(audioPath, {
        language: options.language || null,
        diarize: options.diarize !== false,
        numSpeakers: options.numSpeakers || null,
      });

      const transcript = result.text || '';

      return {
        output: transcript,
        metadata: {
          strategy: 'elevenlabs',
          language: result.language || options.language || 'auto',
          speakers: result.speakers || [],
          wordCount: result.words ? result.words.length : 0,
          diarized: true,
          inputSize: Buffer.isBuffer(input) ? input.length : 0,
          outputLength: transcript.length,
        },
        duration: Date.now() - startTime,
        strategy: 'elevenlabs',
      };
    } finally {
      if (shouldCleanup) {
        this._cleanupFile(audioPath);
      }
    }
  }

  /**
   * Chunked strategy: split long audio and transcribe segments.
   * @private
   */
  async _executeChunked(input, options, startTime) {
    if (!this._ai || !this._ai.transcribe) {
      throw new Error('AI service with transcribe() is required for the chunked strategy');
    }

    const audioPath = this._ensureFilePath(input);
    const shouldCleanup = Buffer.isBuffer(input);
    const chunks = [];

    try {
      // Get audio duration
      const duration = await this._getAudioDuration(audioPath);
      const chunkCount = Math.ceil(duration / MAX_CHUNK_SECONDS);

      if (chunkCount <= 1) {
        // Short enough for a single pass
        const audioBuffer = this._ensureBuffer(input);
        const result = await this._ai.transcribe(audioBuffer, {
          language: options.language || undefined,
          feature: 'converter-audio-to-text-chunked',
        });
        return {
          output: result.text || '',
          metadata: {
            strategy: 'chunked',
            chunks: 1,
            totalDuration: duration,
          },
          duration: Date.now() - startTime,
          strategy: 'chunked',
        };
      }

      // Split into chunks
      const chunkPaths = await this._splitAudio(audioPath, chunkCount, duration);
      chunks.push(...chunkPaths);

      // Transcribe each chunk sequentially
      const transcripts = [];
      for (let i = 0; i < chunkPaths.length; i++) {
        const chunkBuffer = fs.readFileSync(chunkPaths[i]);
        const result = await this._ai.transcribe(chunkBuffer, {
          language: options.language || undefined,
          feature: 'converter-audio-to-text-chunked',
        });
        transcripts.push(result.text || '');
      }

      const fullTranscript = transcripts.join(' ').replace(/\s+/g, ' ').trim();

      return {
        output: fullTranscript,
        metadata: {
          strategy: 'chunked',
          chunks: chunkPaths.length,
          totalDuration: duration,
          language: options.language || 'auto',
          outputLength: fullTranscript.length,
        },
        duration: Date.now() - startTime,
        strategy: 'chunked',
      };
    } finally {
      // Clean up chunk files
      for (const chunkPath of chunks) {
        this._cleanupFile(chunkPath);
      }
      if (shouldCleanup) {
        this._cleanupFile(audioPath);
      }
    }
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  /**
   * Ensure input is a Buffer. Read from disk if it's a file path.
   * @private
   */
  _ensureBuffer(input) {
    if (Buffer.isBuffer(input)) return input;
    if (typeof input === 'string' && fs.existsSync(input)) {
      return fs.readFileSync(input);
    }
    throw new Error('Input must be a Buffer or a valid file path');
  }

  /**
   * Ensure input is a file path. Write to temp file if it's a Buffer.
   * @private
   */
  _ensureFilePath(input) {
    if (typeof input === 'string' && fs.existsSync(input)) return input;
    if (Buffer.isBuffer(input)) {
      const tmpPath = path.join(os.tmpdir(), `audio-in-${Date.now()}.audio`);
      fs.writeFileSync(tmpPath, input);
      return tmpPath;
    }
    throw new Error('Input must be a Buffer or a valid file path');
  }

  /**
   * Get audio duration in seconds using FFprobe.
   * @private
   */
  _getAudioDuration(filePath) {
    return new Promise((resolve, reject) => {
      const ffprobe = this._ffmpegPath.replace(/ffmpeg$/, 'ffprobe');
      execFile(ffprobe, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
      ], { timeout: 30000 }, (err, stdout) => {
        if (err) {
          reject(new Error(`FFprobe failed: ${err.message}`));
          return;
        }
        const seconds = parseFloat(stdout.trim());
        resolve(isNaN(seconds) ? 0 : seconds);
      });
    });
  }

  /**
   * Split audio into equal-length chunks using FFmpeg.
   * @private
   */
  _splitAudio(filePath, chunkCount, totalDuration) {
    const chunkDuration = Math.ceil(totalDuration / chunkCount);
    const promises = [];

    for (let i = 0; i < chunkCount; i++) {
      const start = i * chunkDuration;
      const outPath = path.join(os.tmpdir(), `chunk-${Date.now()}-${i}.wav`);

      promises.push(new Promise((resolve, reject) => {
        execFile(this._ffmpegPath, [
          '-i', filePath,
          '-ss', String(start),
          '-t', String(chunkDuration),
          '-acodec', 'pcm_s16le',
          '-ar', '16000',
          '-ac', '1',
          '-y',
          outPath,
        ], { timeout: 60000 }, (err) => {
          if (err) {
            reject(new Error(`Failed to split chunk ${i}: ${err.message}`));
            return;
          }
          resolve(outPath);
        });
      }));
    }

    return Promise.all(promises);
  }

  /**
   * Lazily load the TranscriptionService.
   * @private
   */
  _getTranscriptionService() {
    if (this._transcriptionService) return this._transcriptionService;

    try {
      // TranscriptionService is an ES module; require the path and cache
      const { TranscriptionService } = require('../../src/transcription/TranscriptionService');
      this._transcriptionService = new TranscriptionService();
      return this._transcriptionService;
    } catch (err) {
      throw new Error(
        `TranscriptionService is required for the elevenlabs strategy but could not be loaded: ${err.message}`
      );
    }
  }

  /**
   * Safely remove a temporary file.
   * @private
   */
  _cleanupFile(filePath) {
    if (!filePath) return;
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (_) {
      // Ignore cleanup errors
    }
  }
}

module.exports = { AudioToTextConverter };
