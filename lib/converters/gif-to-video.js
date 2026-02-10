/**
 * GifToVideoAgent
 *
 * @description Converts animated GIF files to video (MP4 or WebM) using FFmpeg.
 *   Supports standard conversion, high-quality mode with higher bitrate, and
 *   loop mode that repeats the GIF content multiple times.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/gif-to-video
 *
 * @agent converter:gif-to-video
 * @from gif
 * @to   mp4, webm
 * @modes symbolic
 *
 * @strategies
 *   - standard     : Convert GIF to MP4 with sensible defaults (yuv420p, faststart)
 *   - high-quality : Higher bitrate and resolution preservation
 *   - loop         : Repeat the GIF N times in the output video
 *
 * @requirements FFmpeg must be available on PATH.
 *
 * @input  {Buffer} GIF file content
 * @output {Buffer} Video file bytes (MP4 or WebM)
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

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr }));
      resolve({ stdout, stderr });
    });
  });
}

class GifToVideoAgent extends BaseConverterAgent {
  constructor(config = {}) {
    super(config);

    this.id = 'converter:gif-to-video';
    this.name = 'GIF to Video';
    this.description = 'Converts animated GIF to MP4 or WebM video using FFmpeg';
    this.from = ['gif'];
    this.to = ['mp4', 'webm'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'standard',
        description: 'Convert GIF to MP4 with yuv420p pixel format and faststart',
        when: 'Standard video output needed from a GIF source',
        engine: 'ffmpeg',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Good compatibility with standard settings',
      },
      {
        id: 'high-quality',
        description: 'Higher bitrate conversion preserving GIF resolution and frame rate',
        when: 'Maximum quality is needed and file size is not a concern',
        engine: 'ffmpeg',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'High-fidelity output with preserved detail',
      },
      {
        id: 'loop',
        description: 'Repeat the GIF content multiple times in the output video',
        when: 'A longer video is needed that loops the GIF animation',
        engine: 'ffmpeg',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Looped video with configurable repeat count',
      },
    ];
  }

  /**
   * @param {Buffer} input - GIF file content
   * @param {string} strategy - 'standard' | 'high-quality' | 'loop'
   * @param {Object} [options]
   * @param {string} [options.format='mp4'] - Output format: 'mp4' | 'webm'
   * @param {number} [options.loopCount=3] - Number of loops for 'loop' strategy
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const start = Date.now();
    const hasFfmpeg = await checkFfmpeg();
    if (!hasFfmpeg) {
      throw new Error('FFmpeg is not available on PATH');
    }

    const format = options.format || 'mp4';
    const tmpDir = os.tmpdir();
    const id = uuidv4();
    const inputPath = path.join(tmpDir, `${id}-input.gif`);
    const outputPath = path.join(tmpDir, `${id}-output.${format}`);

    try {
      fs.writeFileSync(inputPath, input);

      const args = ['-y', '-i', inputPath];

      switch (strategy) {
        case 'high-quality':
          if (format === 'mp4') {
            args.push('-c:v', 'libx264', '-crf', '18', '-preset', 'slow',
              '-pix_fmt', 'yuv420p', '-movflags', 'faststart');
          } else {
            args.push('-c:v', 'libvpx-vp9', '-crf', '20', '-b:v', '0');
          }
          break;

        case 'loop': {
          const loopCount = options.loopCount || 3;
          args.splice(2, 0, '-stream_loop', String(loopCount - 1));
          if (format === 'mp4') {
            args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'faststart');
          } else {
            args.push('-c:v', 'libvpx-vp9');
          }
          break;
        }

        default: // standard
          if (format === 'mp4') {
            args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'faststart');
          } else {
            args.push('-c:v', 'libvpx-vp9');
          }
          break;
      }

      args.push(outputPath);
      await runFfmpeg(args);

      const outputBuffer = fs.readFileSync(outputPath);
      return { output: outputBuffer, duration: Date.now() - start };
    } finally {
      try { fs.unlinkSync(inputPath); } catch { /* ignore */ }
      try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
    }
  }

  async _structuralChecks(input, output) {
    const issues = [];
    if (!Buffer.isBuffer(output)) {
      issues.push({
        code: 'NOT_BUFFER',
        severity: 'error',
        message: 'Output is not a Buffer',
        fixable: false,
      });
    } else if (output.length < 100) {
      issues.push({
        code: 'VIDEO_TOO_SMALL',
        severity: 'error',
        message: 'Video output is suspiciously small',
        fixable: false,
      });
    }
    return issues;
  }
}

module.exports = { GifToVideoAgent };
