/**
 * VideoToSummaryAgent
 *
 * @description Generates concise text summaries of video content using a
 *   combination of transcription, frame sampling, and LLM analysis.
 *   Operates in generative mode — every strategy relies on AI to produce
 *   the final summary.
 *
 * @extends BaseConverterAgent
 * @see lib/converters/base-converter-agent.js
 *
 * @strategies
 *   - transcript-summary: Transcribe the audio, then ask the LLM to
 *                         summarize the transcript.
 *   - visual-summary:     Sample key frames, describe each with the
 *                         vision model, then synthesize a summary.
 *   - combined:           Use both transcript and visual descriptions to
 *                         produce a richer, multi-modal summary.
 *
 * @requirements FFmpeg on PATH (audio extraction, frame sampling).
 *   At least one transcription provider API key and an LLM API key.
 * @module lib/converters/video-to-summary
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getLogQueue } = require('./../log-event-queue');
const _log = getLogQueue();

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
    execFile('ffmpeg', args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr }));
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Get video duration in seconds.
 * @param {string} filePath
 * @returns {Promise<number>}
 */
function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffprobe',
      ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath],
      (err, stdout) => {
        if (err) return reject(err);
        const dur = parseFloat(stdout.trim());
        resolve(isNaN(dur) ? 0 : dur);
      }
    );
  });
}

class VideoToSummaryAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config]
   * @param {Object} [config.ai] - AI service instance (for testing)
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:video-to-summary';
    this.name = 'Video to Summary';
    this.description = 'Generate concise text summaries of video content using AI';
    this.from = ['mp4', 'webm', 'mov', 'avi', 'mkv'];
    this.to = ['text'];
    this.modes = ['generative'];

    this.strategies = [
      {
        id: 'transcript-summary',
        description: 'Transcribe the audio then summarize the transcript with an LLM',
        when: 'The video is speech-heavy (talks, meetings, interviews)',
        engine: 'ffmpeg + whisper + llm',
        mode: 'generative',
        speed: 'medium',
        quality: 'Good for dialogue-driven content',
      },
      {
        id: 'visual-summary',
        description: 'Sample key frames, describe them with vision AI, then synthesize a summary',
        when: 'The video is visually driven with little speech (demos, nature, tutorials)',
        engine: 'ffmpeg + vision-llm',
        mode: 'generative',
        speed: 'slow',
        quality: 'Good for visual content',
      },
      {
        id: 'combined',
        description: 'Use both transcript and visual descriptions for a rich multi-modal summary',
        when: 'The video has both meaningful speech and important visuals',
        engine: 'ffmpeg + whisper + vision-llm + llm',
        mode: 'generative',
        speed: 'slow',
        quality: 'Best overall summary quality',
      },
    ];
  }

  /**
   * Execute video summarization.
   *
   * @param {string} input - Absolute path to the source video file
   * @param {string} strategy - One of 'transcript-summary', 'visual-summary', 'combined'
   * @param {Object} [options]
   * @param {string} [options.language]     - ISO language code for transcription
   * @param {number} [options.maxWords]     - Target summary length in words. Defaults to 300.
   * @param {number} [options.sampleFrames] - Number of frames to sample (visual). Defaults to 6.
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    if (!this._ai) {
      throw new Error('AI service is required for video summarization');
    }

    const startTime = Date.now();

    switch (strategy) {
      case 'transcript-summary':
        return this._transcriptSummary(input, options, startTime);
      case 'visual-summary':
        return this._visualSummary(input, options, startTime);
      case 'combined':
        return this._combinedSummary(input, options, startTime);
      default:
        throw new Error(`Unknown strategy: ${strategy}`);
    }
  }

  // =========================================================================
  // Strategy implementations
  // =========================================================================

  /**
   * Transcribe the audio, then ask the LLM to summarize.
   * @private
   */
  async _transcriptSummary(input, options, startTime) {
    const transcript = await this._extractTranscript(input, options);
    const maxWords = options.maxWords || 300;

    const summary = await this._ai.complete(
      `Summarize the following transcript of a video in approximately ${maxWords} words.
Focus on the main topics, key points, and conclusions. Write in clear, concise prose.

TRANSCRIPT:
${transcript}

SUMMARY:`,
      { profile: 'standard', feature: 'video-summary-transcript', maxTokens: 1000 }
    );

    return {
      output: summary.trim(),
      metadata: {
        strategy: 'transcript-summary',
        inputPath: input,
        transcriptLength: transcript.length,
        summaryWordCount: summary.trim().split(/\s+/).length,
      },
      duration: Date.now() - startTime,
      strategy: 'transcript-summary',
    };
  }

  /**
   * Sample key frames, describe with vision model, synthesize summary.
   * @private
   */
  async _visualSummary(input, options, startTime) {
    const sampleCount = options.sampleFrames || 6;
    const maxWords = options.maxWords || 300;

    const frames = await this._sampleFrames(input, sampleCount);
    const descriptions = await this._describeFrames(frames);

    const summary = await this._ai.complete(
      `You are summarizing a video based on sampled frames.
Below are descriptions of ${descriptions.length} frames taken at even intervals.
Write a concise summary (approximately ${maxWords} words) describing what the video shows,
the setting, key subjects, and any apparent narrative or activity.

FRAME DESCRIPTIONS:
${descriptions.map((d, i) => `Frame ${i + 1}: ${d}`).join('\n')}

SUMMARY:`,
      { profile: 'standard', feature: 'video-summary-visual', maxTokens: 1000 }
    );

    return {
      output: summary.trim(),
      metadata: {
        strategy: 'visual-summary',
        inputPath: input,
        framesAnalyzed: descriptions.length,
        summaryWordCount: summary.trim().split(/\s+/).length,
      },
      duration: Date.now() - startTime,
      strategy: 'visual-summary',
    };
  }

  /**
   * Combined transcript + visual summary.
   * @private
   */
  async _combinedSummary(input, options, startTime) {
    const sampleCount = options.sampleFrames || 6;
    const maxWords = options.maxWords || 300;

    // Run transcript and frame extraction in parallel
    const [transcript, frames] = await Promise.all([
      this._extractTranscript(input, options).catch((err) => {
        console.warn('[video-to-summary] Transcript extraction failed:', err.message);
        return '';
      }),
      this._sampleFrames(input, sampleCount).catch((err) => {
        console.warn('[video-to-summary] Frame sampling failed:', err.message);
        return [];
      }),
    ]);

    const descriptions = frames.length > 0 ? await this._describeFrames(frames) : [];

    if (!transcript && descriptions.length === 0) {
      throw new Error('Both transcript extraction and frame sampling failed');
    }

    const transcriptSection = transcript
      ? `TRANSCRIPT:\n${transcript.substring(0, 5000)}\n`
      : '(No transcript available)\n';

    const visualSection =
      descriptions.length > 0
        ? `VISUAL DESCRIPTIONS:\n${descriptions.map((d, i) => `Frame ${i + 1}: ${d}`).join('\n')}\n`
        : '(No visual descriptions available)\n';

    const summary = await this._ai.complete(
      `Summarize this video in approximately ${maxWords} words.
Use both the spoken content and visual context to write a comprehensive summary.

${transcriptSection}
${visualSection}
SUMMARY:`,
      { profile: 'standard', feature: 'video-summary-combined', maxTokens: 1200 }
    );

    return {
      output: summary.trim(),
      metadata: {
        strategy: 'combined',
        inputPath: input,
        hasTranscript: !!transcript,
        framesAnalyzed: descriptions.length,
        summaryWordCount: summary.trim().split(/\s+/).length,
      },
      duration: Date.now() - startTime,
      strategy: 'combined',
    };
  }

  // =========================================================================
  // Shared helpers
  // =========================================================================

  /**
   * Extract a transcript from the video. Tries the AI service transcribe
   * method with audio extracted via FFmpeg.
   * @private
   * @param {string} input - Video file path
   * @param {Object} options
   * @returns {Promise<string>}
   */
  async _extractTranscript(input, options) {
    if (!this._ai || typeof this._ai.transcribe !== 'function') {
      throw new Error('AI service with transcribe() is required for transcript extraction');
    }

    const available = await checkFfmpeg();
    if (!available) {
      throw new Error('FFmpeg is not available (needed for audio extraction)');
    }

    const tempAudio = path.join(os.tmpdir(), `summary-audio-${uuidv4()}.wav`);
    try {
      await runFfmpeg(['-y', '-i', input, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', tempAudio]);

      const audioBuffer = fs.readFileSync(tempAudio);
      const result = await this._ai.transcribe(audioBuffer, {
        profile: 'transcription',
        feature: 'video-summary-transcribe',
        language: options.language,
      });

      return typeof result === 'string' ? result : (result && result.text) || '';
    } finally {
      try {
        fs.unlinkSync(tempAudio);
      } catch (_) {
        /* ignore */
      }
    }
  }

  /**
   * Sample evenly-spaced frames from the video as Buffers.
   * @private
   * @param {string} input - Video file path
   * @param {number} count - Number of frames to sample
   * @returns {Promise<Buffer[]>}
   */
  async _sampleFrames(input, count) {
    const available = await checkFfmpeg();
    if (!available) {
      throw new Error('FFmpeg is not available (needed for frame sampling)');
    }

    let duration = 10;
    try {
      duration = await getVideoDuration(input);
    } catch (_) {
      /* use default */
    }

    const interval = Math.max(1, duration / (count + 1));
    const tmpDir = path.join(os.tmpdir(), `summary-frames-${uuidv4()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      const buffers = [];
      for (let i = 1; i <= count; i++) {
        const ts = Math.min(interval * i, duration - 0.5);
        const outPath = path.join(tmpDir, `frame-${i}.jpg`);
        try {
          await runFfmpeg([
            '-y',
            '-ss',
            String(ts),
            '-i',
            input,
            '-vframes',
            '1',
            '-f',
            'image2',
            '-q:v',
            '3',
            outPath,
          ]);
          buffers.push(fs.readFileSync(outPath));
        } catch (_) {
          // Skip frames that fail to extract
        }
      }
      return buffers;
    } finally {
      // Clean up temp dir
      try {
        const files = fs.readdirSync(tmpDir);
        for (const f of files) {
          try {
            fs.unlinkSync(path.join(tmpDir, f));
          } catch (_) {
            /* ignore */
          }
        }
        fs.rmdirSync(tmpDir);
      } catch (_) {
        /* ignore */
      }
    }
  }

  /**
   * Describe each frame using the vision model.
   * @private
   * @param {Buffer[]} frames - JPEG frame buffers
   * @returns {Promise<string[]>}
   */
  async _describeFrames(frames) {
    if (!this._ai || typeof this._ai.vision !== 'function') {
      return frames.map(() => '(Vision model unavailable)');
    }

    const descriptions = [];
    for (const frame of frames) {
      try {
        const desc = await this._ai.vision(
          frame,
          'Describe this video frame in one sentence. Focus on subjects, actions, and setting.',
          { profile: 'vision', feature: 'video-summary-vision', maxTokens: 150 }
        );
        descriptions.push(typeof desc === 'string' ? desc : (desc && desc.content) || '(no description)');
      } catch (err) {
        descriptions.push(`(Vision failed: ${err.message})`);
      }
    }
    return descriptions;
  }

  /**
   * Verify the summary is a non-empty string of reasonable length.
   *
   * @param {string} input - Source video path
   * @param {string} output - Summary text
   * @param {string} strategy - Strategy used
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, strategy) {
    const issues = [];

    if (typeof output !== 'string') {
      issues.push({
        code: 'OUTPUT_NOT_STRING',
        severity: 'error',
        message: 'Expected output to be a summary string',
        fixable: true,
      });
      return issues;
    }

    const trimmed = output.trim();

    if (trimmed.length === 0) {
      issues.push({
        code: 'SUMMARY_EMPTY',
        severity: 'error',
        message: 'Summary is empty',
        fixable: true,
        suggestedStrategy: strategy !== 'combined' ? 'combined' : undefined,
      });
      return issues;
    }

    const wordCount = trimmed.split(/\s+/).length;

    if (wordCount < 10) {
      issues.push({
        code: 'SUMMARY_TOO_SHORT',
        severity: 'warning',
        message: `Summary is very short (${wordCount} words)`,
        fixable: true,
        suggestedStrategy: strategy !== 'combined' ? 'combined' : undefined,
      });
    }

    if (wordCount > 2000) {
      issues.push({
        code: 'SUMMARY_TOO_LONG',
        severity: 'warning',
        message: `Summary is unusually long (${wordCount} words)`,
        fixable: false,
      });
    }

    return issues;
  }
}

module.exports = { VideoToSummaryAgent };
