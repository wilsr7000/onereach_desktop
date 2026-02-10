/**
 * VideoToImageAgent
 *
 * @description Extracts still frames from video files using FFmpeg.
 *   Returns either a single Buffer or an array of Buffers depending on
 *   the strategy. Supports thumbnail extraction, key-frame detection,
 *   fixed-interval capture, and extraction at specific timestamps.
 *
 * @extends BaseConverterAgent
 * @see lib/converters/base-converter-agent.js
 *
 * @strategies
 *   - thumbnail:  Extract a single representative frame (10% into the video).
 *   - keyframes:  Extract frames at scene-change boundaries using FFmpeg
 *                 scene-detection filter.
 *   - interval:   Extract one frame every N seconds across the video.
 *   - specific:   Extract frames at caller-supplied timestamps.
 *
 * @requirements FFmpeg must be available on PATH.
 * @module lib/converters/video-to-image
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

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

class VideoToImageAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config]
   * @param {Object} [config.ai] - AI service instance (for testing)
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:video-to-image';
    this.name = 'Video to Image';
    this.description = 'Extract still frames from video files as PNG or JPEG images';
    this.from = ['mp4', 'webm', 'mov', 'avi', 'mkv'];
    this.to = ['png', 'jpg'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'thumbnail',
        description: 'Extract a single representative frame from the video',
        when: 'You need one preview image for the video',
        engine: 'ffmpeg',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Single best-guess frame',
      },
      {
        id: 'keyframes',
        description: 'Extract frames at scene-change boundaries',
        when: 'You want representative frames from each scene',
        engine: 'ffmpeg (scene filter)',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'One frame per scene change',
      },
      {
        id: 'interval',
        description: 'Extract one frame every N seconds',
        when: 'You want evenly-spaced frames across the video',
        engine: 'ffmpeg',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Even temporal sampling',
      },
      {
        id: 'specific',
        description: 'Extract frames at specific timestamps provided by the caller',
        when: 'You know exactly which moments you want captured',
        engine: 'ffmpeg',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Exact requested timestamps',
      },
    ];
  }

  /**
   * Execute frame extraction from a video file.
   *
   * @param {string} input - Absolute path to the source video file
   * @param {string} strategy - One of 'thumbnail', 'keyframes', 'interval', 'specific'
   * @param {Object} [options]
   * @param {string}   [options.outputFormat] - 'png' or 'jpg'. Defaults to 'png'.
   * @param {number}   [options.intervalSeconds] - Seconds between frames (interval strategy). Defaults to 5.
   * @param {number[]} [options.timestamps] - Array of timestamps in seconds (specific strategy).
   * @param {number}   [options.maxFrames] - Cap on number of frames extracted. Defaults to 50.
   * @param {number}   [options.sceneThreshold] - Scene change threshold 0-1 (keyframes). Defaults to 0.3.
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const available = await checkFfmpeg();
    if (!available) {
      throw new Error('FFmpeg is not installed or not available on PATH');
    }

    const fmt = options.outputFormat || options.to || 'png';
    const startTime = Date.now();
    const tmpDir = path.join(os.tmpdir(), `frames-${uuidv4()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      switch (strategy) {
        case 'thumbnail':
          return await this._extractThumbnail(input, tmpDir, fmt, startTime);
        case 'keyframes':
          return await this._extractKeyframes(input, tmpDir, fmt, options, startTime);
        case 'interval':
          return await this._extractInterval(input, tmpDir, fmt, options, startTime);
        case 'specific':
          return await this._extractSpecific(input, tmpDir, fmt, options, startTime);
        default:
          throw new Error(`Unknown strategy: ${strategy}`);
      }
    } catch (err) {
      // Clean up temp dir on failure
      this._cleanupDir(tmpDir);
      throw err;
    }
  }

  /**
   * Extract a single thumbnail at ~10% into the video.
   * @private
   */
  async _extractThumbnail(input, tmpDir, fmt, startTime) {
    let seekTo = 1;
    try {
      const duration = await getVideoDuration(input);
      seekTo = Math.max(0, duration * 0.1);
    } catch (_) { /* use default */ }

    const outPath = path.join(tmpDir, `thumb.${fmt}`);
    await runFfmpeg(['-y', '-ss', String(seekTo), '-i', input, '-vframes', '1', '-f', 'image2', outPath]);

    const buffer = fs.readFileSync(outPath);
    this._cleanupDir(tmpDir);

    return {
      output: buffer,
      metadata: {
        strategy: 'thumbnail',
        inputPath: input,
        format: fmt,
        frameCount: 1,
        timestamp: seekTo,
      },
      duration: Date.now() - startTime,
      strategy: 'thumbnail',
    };
  }

  /**
   * Extract frames at scene-change boundaries.
   * @private
   */
  async _extractKeyframes(input, tmpDir, fmt, options, startTime) {
    const threshold = options.sceneThreshold || 0.3;
    const maxFrames = options.maxFrames || 50;
    const pattern = path.join(tmpDir, `scene-%04d.${fmt}`);

    await runFfmpeg([
      '-y', '-i', input,
      '-vf', `select='gt(scene,${threshold})'`,
      '-vsync', 'vfr',
      '-frames:v', String(maxFrames),
      pattern,
    ]);

    const buffers = this._readFrames(tmpDir, fmt);
    this._cleanupDir(tmpDir);

    return {
      output: buffers.length === 1 ? buffers[0] : buffers,
      metadata: {
        strategy: 'keyframes',
        inputPath: input,
        format: fmt,
        frameCount: buffers.length,
        sceneThreshold: threshold,
      },
      duration: Date.now() - startTime,
      strategy: 'keyframes',
    };
  }

  /**
   * Extract one frame every N seconds.
   * @private
   */
  async _extractInterval(input, tmpDir, fmt, options, startTime) {
    const interval = options.intervalSeconds || 5;
    const maxFrames = options.maxFrames || 50;
    const pattern = path.join(tmpDir, `frame-%04d.${fmt}`);

    await runFfmpeg([
      '-y', '-i', input,
      '-vf', `fps=1/${interval}`,
      '-frames:v', String(maxFrames),
      pattern,
    ]);

    const buffers = this._readFrames(tmpDir, fmt);
    this._cleanupDir(tmpDir);

    return {
      output: buffers.length === 1 ? buffers[0] : buffers,
      metadata: {
        strategy: 'interval',
        inputPath: input,
        format: fmt,
        frameCount: buffers.length,
        intervalSeconds: interval,
      },
      duration: Date.now() - startTime,
      strategy: 'interval',
    };
  }

  /**
   * Extract frames at caller-specified timestamps.
   * @private
   */
  async _extractSpecific(input, tmpDir, fmt, options, startTime) {
    const timestamps = options.timestamps || [0];
    const buffers = [];

    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      const outPath = path.join(tmpDir, `ts-${i}.${fmt}`);
      await runFfmpeg(['-y', '-ss', String(ts), '-i', input, '-vframes', '1', '-f', 'image2', outPath]);
      try {
        buffers.push(fs.readFileSync(outPath));
      } catch (_) {
        // Frame at this timestamp may not exist; skip
      }
    }

    this._cleanupDir(tmpDir);

    return {
      output: buffers.length === 1 ? buffers[0] : buffers,
      metadata: {
        strategy: 'specific',
        inputPath: input,
        format: fmt,
        frameCount: buffers.length,
        timestamps,
      },
      duration: Date.now() - startTime,
      strategy: 'specific',
    };
  }

  /**
   * Read all image files from a directory as Buffers.
   * @private
   */
  _readFrames(dir, fmt) {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith(`.${fmt}`))
      .sort();
    return files.map(f => fs.readFileSync(path.join(dir, f)));
  }

  /**
   * Remove a temporary directory and its contents.
   * @private
   */
  _cleanupDir(dir) {
    try {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* ignore */ }
      }
      fs.rmdirSync(dir);
    } catch (_) { /* ignore */ }
  }

  /**
   * Verify the output is a Buffer or array of non-empty Buffers.
   *
   * @param {string} input - Source video path
   * @param {Buffer|Buffer[]} output - Extracted frame(s)
   * @param {string} strategy - Strategy used
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, strategy) {
    const issues = [];

    const buffers = Array.isArray(output) ? output : [output];

    if (buffers.length === 0) {
      issues.push({
        code: 'NO_FRAMES',
        severity: 'error',
        message: 'No frames were extracted from the video',
        fixable: true,
        suggestedStrategy: strategy === 'keyframes' ? 'interval' : 'thumbnail',
      });
      return issues;
    }

    for (let i = 0; i < buffers.length; i++) {
      const buf = buffers[i];
      if (!Buffer.isBuffer(buf)) {
        issues.push({
          code: 'FRAME_NOT_BUFFER',
          severity: 'error',
          message: `Frame ${i} is not a Buffer (got ${typeof buf})`,
          fixable: true,
        });
      } else if (buf.length === 0) {
        issues.push({
          code: 'FRAME_EMPTY',
          severity: 'error',
          message: `Frame ${i} is an empty buffer`,
          fixable: true,
        });
      }
    }

    return issues;
  }
}

module.exports = { VideoToImageAgent };
