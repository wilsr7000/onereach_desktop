/**
 * VideoTranscodeAgent
 *
 * @description Converts video files between container formats (mp4, webm, mov)
 *   using FFmpeg. Supports three strategies: fast (stream copy), quality
 *   (full re-encode), and compress (size-optimized re-encode).
 *
 * @extends BaseConverterAgent
 * @see lib/converters/base-converter-agent.js
 *
 * @strategies
 *   - fast:     Copy streams without re-encoding. Near-instant but limited
 *               to compatible codec/container combinations.
 *   - quality:  Full re-encode with high-quality settings (libx264/libvpx-vp9).
 *               Slower but produces optimal output for the target container.
 *   - compress: Re-encode with CRF tuned for smaller file size while
 *               preserving acceptable visual quality.
 *
 * @requirements FFmpeg must be available on PATH.
 * @module lib/converters/video-transcode
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
 * Caches the result after the first call.
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
 * Run FFmpeg with the given arguments and return a promise.
 * @param {string[]} args - FFmpeg CLI arguments
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

/** Codec defaults per output container */
const CODEC_DEFAULTS = {
  mp4:  { vcodec: 'libx264', acodec: 'aac' },
  webm: { vcodec: 'libvpx-vp9', acodec: 'libopus' },
  mov:  { vcodec: 'libx264', acodec: 'aac' },
};

class VideoTranscodeAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config]
   * @param {Object} [config.ai] - AI service instance (for testing)
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:video-transcode';
    this.name = 'Video Transcode';
    this.description = 'Convert video files between container formats using FFmpeg';
    this.from = ['mp4', 'webm', 'mov', 'avi', 'mkv'];
    this.to = ['mp4', 'webm', 'mov'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'fast',
        description: 'Copy streams without re-encoding for near-instant conversion',
        when: 'Codecs are already compatible with the target container',
        engine: 'ffmpeg',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Lossless (no re-encoding)',
      },
      {
        id: 'quality',
        description: 'Full re-encode with high-quality codec settings',
        when: 'Maximum quality is needed or codecs are incompatible',
        engine: 'ffmpeg',
        mode: 'symbolic',
        speed: 'slow',
        quality: 'High (CRF 18 / high bitrate)',
      },
      {
        id: 'compress',
        description: 'Re-encode optimized for smaller file size',
        when: 'File size matters more than perfect quality',
        engine: 'ffmpeg',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Good (CRF 28 / size-optimized)',
      },
    ];
  }

  /**
   * Execute the video transcode conversion.
   *
   * @param {string} input - Absolute path to the source video file
   * @param {string} strategy - One of 'fast', 'quality', 'compress'
   * @param {Object} [options]
   * @param {string} [options.outputFormat] - Target format (mp4, webm, mov). Defaults to mp4.
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const available = await checkFfmpeg();
    if (!available) {
      throw new Error('FFmpeg is not installed or not available on PATH');
    }

    const outputFormat = options.outputFormat || options.to || 'mp4';
    const outFile = path.join(os.tmpdir(), `transcode-${uuidv4()}.${outputFormat}`);
    const startTime = Date.now();

    try {
      const args = this._buildArgs(input, outFile, strategy, outputFormat, options);
      await runFfmpeg(args);

      return {
        output: outFile,
        metadata: {
          strategy,
          inputPath: input,
          outputPath: outFile,
          outputFormat,
        },
        duration: Date.now() - startTime,
        strategy,
      };
    } catch (err) {
      // Clean up partial output on failure
      try { fs.unlinkSync(outFile); } catch (_) { /* ignore */ }
      throw new Error(`FFmpeg transcode failed (${strategy}): ${err.message}`);
    }
  }

  /**
   * Build FFmpeg argument array based on the chosen strategy.
   *
   * @param {string} input  - Source file path
   * @param {string} output - Destination file path
   * @param {string} strategy - Strategy id
   * @param {string} format - Target container format
   * @param {Object} options - Extra options
   * @returns {string[]}
   * @private
   */
  _buildArgs(input, output, strategy, format, options) {
    const base = ['-y', '-i', input];

    if (strategy === 'fast') {
      return [...base, '-c', 'copy', output];
    }

    const codecs = CODEC_DEFAULTS[format] || CODEC_DEFAULTS.mp4;

    if (strategy === 'quality') {
      const vArgs = codecs.vcodec === 'libvpx-vp9'
        ? ['-c:v', codecs.vcodec, '-crf', '18', '-b:v', '0']
        : ['-c:v', codecs.vcodec, '-crf', '18', '-preset', 'slow'];
      return [...base, ...vArgs, '-c:a', codecs.acodec, output];
    }

    // compress
    const vArgs = codecs.vcodec === 'libvpx-vp9'
      ? ['-c:v', codecs.vcodec, '-crf', '35', '-b:v', '0']
      : ['-c:v', codecs.vcodec, '-crf', '28', '-preset', 'faster'];
    return [...base, ...vArgs, '-c:a', codecs.acodec, '-b:a', '96k', output];
  }

  /**
   * Verify the output file exists and has a non-zero size.
   *
   * @param {string} input - Source file path
   * @param {string} output - Output file path
   * @param {string} strategy - Strategy used
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, strategy) {
    const issues = [];

    if (typeof output !== 'string') {
      issues.push({
        code: 'OUTPUT_NOT_PATH',
        severity: 'error',
        message: 'Expected output to be a file path string',
        fixable: false,
      });
      return issues;
    }

    try {
      const stat = fs.statSync(output);
      if (stat.size === 0) {
        issues.push({
          code: 'OUTPUT_ZERO_SIZE',
          severity: 'error',
          message: 'Output file exists but has zero bytes',
          fixable: true,
          suggestedStrategy: strategy === 'fast' ? 'quality' : undefined,
        });
      }
    } catch (err) {
      issues.push({
        code: 'OUTPUT_MISSING',
        severity: 'error',
        message: `Output file does not exist: ${output}`,
        fixable: true,
      });
    }

    return issues;
  }
}

module.exports = { VideoTranscodeAgent };
