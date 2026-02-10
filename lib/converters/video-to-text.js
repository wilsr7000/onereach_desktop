/**
 * VideoToTextAgent
 *
 * @description Transcribes spoken content in video files to text. Uses
 *   generative AI models for speech-to-text: OpenAI Whisper via the
 *   centralized AI service, or ElevenLabs Scribe via TranscriptionService.
 *   A hybrid strategy tries the best available provider.
 *
 * @extends BaseConverterAgent
 * @see lib/converters/base-converter-agent.js
 *
 * @strategies
 *   - whisper:    Extract audio then transcribe with OpenAI Whisper
 *                 through the centralized ai.transcribe() API.
 *   - elevenlabs: Use the TranscriptionService (ElevenLabs Scribe) for
 *                 high-quality diarized transcription.
 *   - hybrid:     Try ElevenLabs first, fall back to Whisper on failure.
 *
 * @requirements FFmpeg on PATH (for audio extraction). At least one
 *   transcription provider API key configured.
 * @module lib/converters/video-to-text
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getLogQueue } = require('./../log-event-queue');
const log = getLogQueue();

/**
 * Check whether FFmpeg is available on the system.
 * @returns {Promise<boolean>}
 */
let _ffmpegAvailable = null;
function checkFfmpeg() {
  if (_ffmpegAvailable !== null) return Promise.resolve(_ffmpegAvailable);
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-version'], (err) => {
      _ffmpegAvailable = !err;
      resolve(_ffmpegAvailable);
    });
  });
}

/**
 * Run FFmpeg with the given arguments.
 * @param {string[]} args
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr }));
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Lazily load TranscriptionService. It uses ESM imports so we wrap in a
 * dynamic require with error handling for environments that cannot load it.
 * @returns {Object|null}
 */
let _TranscriptionService = undefined;
function loadTranscriptionService() {
  if (_TranscriptionService !== undefined) return _TranscriptionService;
  try {
    // TranscriptionService is an ESM module; attempt dynamic require
    const mod = require('../../src/transcription/TranscriptionService');
    _TranscriptionService = mod.TranscriptionService || mod.default || null;
  } catch (_) {
    _TranscriptionService = null;
  }
  return _TranscriptionService;
}

class VideoToTextAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config]
   * @param {Object} [config.ai] - AI service instance (for testing)
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:video-to-text';
    this.name = 'Video to Text';
    this.description = 'Transcribe spoken content in video files to text';
    this.from = ['mp4', 'webm', 'mov', 'avi', 'mkv'];
    this.to = ['text'];
    this.modes = ['generative'];

    this.strategies = [
      {
        id: 'whisper',
        description: 'Extract audio and transcribe with OpenAI Whisper',
        when: 'General-purpose transcription with good accuracy',
        engine: 'ffmpeg + openai-whisper',
        mode: 'generative',
        speed: 'medium',
        quality: 'Good (single-speaker, no diarization)',
      },
      {
        id: 'elevenlabs',
        description: 'Transcribe with ElevenLabs Scribe for high-quality diarized output',
        when: 'Multi-speaker content or when speaker labels are needed',
        engine: 'elevenlabs-scribe',
        mode: 'generative',
        speed: 'medium',
        quality: 'High (word-level timestamps, speaker diarization)',
      },
      {
        id: 'hybrid',
        description: 'Try ElevenLabs first, fall back to Whisper if unavailable',
        when: 'Best available transcription is desired with fallback safety',
        engine: 'elevenlabs-scribe / openai-whisper',
        mode: 'generative',
        speed: 'medium',
        quality: 'Best available',
      },
    ];
  }

  /**
   * Execute video-to-text transcription.
   *
   * @param {string} input - Absolute path to the source video file
   * @param {string} strategy - One of 'whisper', 'elevenlabs', 'hybrid'
   * @param {Object} [options]
   * @param {string} [options.language] - ISO language code hint
   * @param {boolean} [options.diarize] - Request speaker diarization (elevenlabs)
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const startTime = Date.now();

    if (strategy === 'elevenlabs') {
      return this._transcribeElevenLabs(input, options, startTime);
    }

    if (strategy === 'whisper') {
      return this._transcribeWhisper(input, options, startTime);
    }

    // hybrid: try ElevenLabs first, fall back to Whisper
    try {
      return await this._transcribeElevenLabs(input, options, startTime);
    } catch (elErr) {
      console.warn('[video-to-text] ElevenLabs failed, falling back to Whisper:', elErr.message);
      try {
        return await this._transcribeWhisper(input, options, startTime);
      } catch (wErr) {
        throw new Error(`Hybrid transcription failed. ElevenLabs: ${elErr.message}. Whisper: ${wErr.message}`);
      }
    }
  }

  /**
   * Transcribe using ElevenLabs Scribe via TranscriptionService.
   * @private
   */
  async _transcribeElevenLabs(input, options, startTime) {
    const TSClass = loadTranscriptionService();
    if (!TSClass) {
      throw new Error('TranscriptionService is not available in this environment');
    }

    const service = new TSClass();
    const result = await service.transcribe(input, {
      language: options.language,
      diarize: options.diarize !== false,
    });

    const transcript = result && (result.text || result.transcript || '');
    if (!transcript) {
      throw new Error('ElevenLabs transcription returned empty result');
    }

    return {
      output: transcript,
      metadata: {
        strategy: 'elevenlabs',
        provider: 'elevenlabs-scribe',
        inputPath: input,
        language: result.language || options.language || 'auto',
        wordCount: transcript.split(/\s+/).length,
        speakers: result.speakers || undefined,
      },
      duration: Date.now() - startTime,
      strategy: 'elevenlabs',
    };
  }

  /**
   * Transcribe using OpenAI Whisper via the centralized AI service.
   * Extracts audio to a temp wav file first.
   * @private
   */
  async _transcribeWhisper(input, options, startTime) {
    if (!this._ai || typeof this._ai.transcribe !== 'function') {
      throw new Error('AI service with transcribe() is required for Whisper strategy');
    }

    const available = await checkFfmpeg();
    if (!available) {
      throw new Error('FFmpeg is not installed or not available on PATH (needed for audio extraction)');
    }

    // Extract audio to temp wav
    const tempAudio = path.join(os.tmpdir(), `whisper-${uuidv4()}.wav`);
    try {
      await runFfmpeg([
        '-y', '-i', input,
        '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
        tempAudio,
      ]);

      const audioBuffer = fs.readFileSync(tempAudio);
      const result = await this._ai.transcribe(audioBuffer, {
        profile: 'transcription',
        feature: 'video-to-text',
        language: options.language,
      });

      const transcript = typeof result === 'string' ? result : (result && result.text) || '';
      if (!transcript) {
        throw new Error('Whisper transcription returned empty result');
      }

      return {
        output: transcript,
        metadata: {
          strategy: 'whisper',
          provider: 'openai-whisper',
          inputPath: input,
          language: options.language || 'auto',
          wordCount: transcript.split(/\s+/).length,
        },
        duration: Date.now() - startTime,
        strategy: 'whisper',
      };
    } finally {
      try { fs.unlinkSync(tempAudio); } catch (_) { /* ignore */ }
    }
  }

  /**
   * Verify the transcript is a non-empty string.
   *
   * @param {string} input - Source video path
   * @param {string} output - Transcript string
   * @param {string} strategy - Strategy used
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, strategy) {
    const issues = [];

    if (typeof output !== 'string') {
      issues.push({
        code: 'OUTPUT_NOT_STRING',
        severity: 'error',
        message: 'Expected output to be a transcript string',
        fixable: true,
      });
      return issues;
    }

    if (output.trim().length === 0) {
      issues.push({
        code: 'TRANSCRIPT_EMPTY',
        severity: 'error',
        message: 'Transcript is empty',
        fixable: true,
        suggestedStrategy: strategy === 'whisper' ? 'elevenlabs' : 'whisper',
      });
    } else if (output.trim().length < 10) {
      issues.push({
        code: 'TRANSCRIPT_TOO_SHORT',
        severity: 'warning',
        message: `Transcript is suspiciously short (${output.trim().length} chars)`,
        fixable: true,
        suggestedStrategy: strategy === 'whisper' ? 'elevenlabs' : 'whisper',
      });
    }

    return issues;
  }
}

module.exports = { VideoToTextAgent };
