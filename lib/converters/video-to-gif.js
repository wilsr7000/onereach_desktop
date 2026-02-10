/**
 * VideoToGifAgent
 *
 * @description Converts video files to animated GIF using FFmpeg's gif
 *   filter chain (palettegen + paletteuse for high-quality output).
 *   Supports clip extraction, AI-driven highlight selection, and
 *   full-video timelapse modes.
 *
 * @extends BaseConverterAgent
 * @see lib/converters/base-converter-agent.js
 *
 * @strategies
 *   - clip:      Convert a specific time range to GIF using caller-supplied
 *                start time and duration.
 *   - highlight: Use the AI service to pick the most interesting segment,
 *                then convert that range. Falls back to the first few seconds
 *                if AI is unavailable.
 *   - timelapse: Speed up the entire video and convert to a compact GIF.
 *
 * @requirements FFmpeg must be available on PATH.
 * @module lib/converters/video-to-gif
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
    execFile('ffmpeg', args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr }));
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Get video duration in seconds using ffprobe.
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

/** GIF89a magic bytes */
const GIF_MAGIC = Buffer.from([0x47, 0x49, 0x46, 0x38]); // "GIF8"

class VideoToGifAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config]
   * @param {Object} [config.ai] - AI service instance (for testing)
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:video-to-gif';
    this.name = 'Video to GIF';
    this.description = 'Convert video clips to animated GIF with high-quality palette';
    this.from = ['mp4', 'webm', 'mov', 'avi', 'mkv'];
    this.to = ['gif'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'clip',
        description: 'Convert a specific time range to GIF',
        when: 'You know the exact start time and duration for the GIF',
        engine: 'ffmpeg (palettegen + paletteuse)',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'High (optimized palette)',
      },
      {
        id: 'highlight',
        description: 'AI picks the most interesting segment, then converts to GIF',
        when: 'You want the best clip but do not know when it occurs',
        engine: 'ffmpeg + ai-service',
        mode: 'symbolic',
        speed: 'slow',
        quality: 'High (AI-selected segment)',
      },
      {
        id: 'timelapse',
        description: 'Speed up the entire video into a compact GIF',
        when: 'You want a quick overview of the full video',
        engine: 'ffmpeg (setpts + palettegen)',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Overview (sped-up)',
      },
    ];
  }

  /**
   * Execute video-to-GIF conversion.
   *
   * @param {string} input - Absolute path to the source video file
   * @param {string} strategy - One of 'clip', 'highlight', 'timelapse'
   * @param {Object} [options]
   * @param {number} [options.start]    - Start time in seconds (clip/highlight). Defaults to 0.
   * @param {number} [options.duration] - Duration in seconds. Defaults to 5.
   * @param {number} [options.fps]      - Frame rate for the GIF. Defaults to 10.
   * @param {number} [options.width]    - Output width in pixels. Defaults to 480. Height scales proportionally.
   * @param {number} [options.speedFactor] - Speed multiplier for timelapse. Defaults to 4.
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const available = await checkFfmpeg();
    if (!available) {
      throw new Error('FFmpeg is not installed or not available on PATH');
    }

    const fps = options.fps || 10;
    const width = options.width || 480;
    const startTime = Date.now();

    switch (strategy) {
      case 'clip':
        return this._convertClip(input, options, fps, width, startTime);
      case 'highlight':
        return this._convertHighlight(input, options, fps, width, startTime);
      case 'timelapse':
        return this._convertTimelapse(input, options, fps, width, startTime);
      default:
        throw new Error(`Unknown strategy: ${strategy}`);
    }
  }

  /**
   * Convert a specified time range to GIF using two-pass palette.
   * @private
   */
  async _convertClip(input, options, fps, width, startTime) {
    const ss = options.start || 0;
    const dur = options.duration || 5;
    const id = uuidv4();
    const palettePath = path.join(os.tmpdir(), `palette-${id}.png`);
    const outPath = path.join(os.tmpdir(), `clip-${id}.gif`);

    try {
      const filters = `fps=${fps},scale=${width}:-1:flags=lanczos`;

      // Pass 1: generate palette
      await runFfmpeg([
        '-y', '-ss', String(ss), '-t', String(dur), '-i', input,
        '-vf', `${filters},palettegen=stats_mode=diff`,
        palettePath,
      ]);

      // Pass 2: produce GIF with palette
      await runFfmpeg([
        '-y', '-ss', String(ss), '-t', String(dur), '-i', input,
        '-i', palettePath,
        '-lavfi', `${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5`,
        outPath,
      ]);

      const buffer = fs.readFileSync(outPath);

      return {
        output: buffer,
        metadata: {
          strategy: 'clip',
          inputPath: input,
          start: ss,
          duration: dur,
          fps,
          width,
          sizeBytes: buffer.length,
        },
        duration: Date.now() - startTime,
        strategy: 'clip',
      };
    } finally {
      try { fs.unlinkSync(palettePath); } catch (_) { /* ignore */ }
      try { fs.unlinkSync(outPath); } catch (_) { /* ignore */ }
    }
  }

  /**
   * Use AI to pick the best segment, then convert to GIF.
   * Falls back to the first few seconds when AI is unavailable.
   * @private
   */
  async _convertHighlight(input, options, fps, width, startTime) {
    let ss = options.start || 0;
    let dur = options.duration || 5;

    // Try AI-based highlight selection
    if (this._ai) {
      try {
        const videoDuration = await getVideoDuration(input);
        const result = await this._ai.json(
          `You are selecting the most visually interesting segment of a ${videoDuration.toFixed(1)}s video for a GIF.
The video is at: ${path.basename(input)}
Suggest the best start time and duration (max 10 seconds) for a highlight GIF.
Return JSON: { "start": <seconds>, "duration": <seconds>, "reasoning": "brief explanation" }`,
          { profile: 'fast', feature: 'video-to-gif-highlight', temperature: 0.3 }
        );
        if (result && typeof result.start === 'number' && typeof result.duration === 'number') {
          ss = Math.max(0, Math.min(result.start, videoDuration - 1));
          dur = Math.min(result.duration, 10, videoDuration - ss);
        }
      } catch (err) {
        console.warn('[video-to-gif] AI highlight selection failed:', err.message);
      }
    }

    return this._convertClip(input, { ...options, start: ss, duration: dur }, fps, width, startTime);
  }

  /**
   * Speed up the entire video into a compact timelapse GIF.
   * @private
   */
  async _convertTimelapse(input, options, fps, width, startTime) {
    const speedFactor = options.speedFactor || 4;
    const id = uuidv4();
    const palettePath = path.join(os.tmpdir(), `palette-tl-${id}.png`);
    const outPath = path.join(os.tmpdir(), `timelapse-${id}.gif`);

    try {
      const ptsFilter = `setpts=${(1 / speedFactor).toFixed(4)}*PTS`;
      const filters = `${ptsFilter},fps=${fps},scale=${width}:-1:flags=lanczos`;

      // Pass 1: palette
      await runFfmpeg([
        '-y', '-i', input,
        '-vf', `${filters},palettegen=stats_mode=diff`,
        palettePath,
      ]);

      // Pass 2: GIF
      await runFfmpeg([
        '-y', '-i', input,
        '-i', palettePath,
        '-lavfi', `${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5`,
        outPath,
      ]);

      const buffer = fs.readFileSync(outPath);

      return {
        output: buffer,
        metadata: {
          strategy: 'timelapse',
          inputPath: input,
          speedFactor,
          fps,
          width,
          sizeBytes: buffer.length,
        },
        duration: Date.now() - startTime,
        strategy: 'timelapse',
      };
    } finally {
      try { fs.unlinkSync(palettePath); } catch (_) { /* ignore */ }
      try { fs.unlinkSync(outPath); } catch (_) { /* ignore */ }
    }
  }

  /**
   * Verify output is a Buffer that starts with GIF magic bytes.
   *
   * @param {string} input - Source video path
   * @param {Buffer} output - GIF buffer
   * @param {string} strategy - Strategy used
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, strategy) {
    const issues = [];

    if (!Buffer.isBuffer(output)) {
      issues.push({
        code: 'OUTPUT_NOT_BUFFER',
        severity: 'error',
        message: `Expected output to be a Buffer (got ${typeof output})`,
        fixable: true,
      });
      return issues;
    }

    if (output.length === 0) {
      issues.push({
        code: 'GIF_EMPTY',
        severity: 'error',
        message: 'GIF buffer is empty',
        fixable: true,
      });
      return issues;
    }

    // Check GIF magic bytes (GIF87a or GIF89a: starts with "GIF8")
    if (output.length >= 4 && output.compare(GIF_MAGIC, 0, 4, 0, 4) !== 0) {
      issues.push({
        code: 'GIF_INVALID_MAGIC',
        severity: 'error',
        message: 'Output does not start with GIF magic bytes',
        fixable: true,
        suggestedStrategy: strategy !== 'clip' ? 'clip' : undefined,
      });
    }

    return issues;
  }
}

module.exports = { VideoToGifAgent };
