/**
 * AudioToVideoConverter
 *
 * @description Generates video files from audio by creating a visual
 *   representation of the audio content. Uses FFmpeg lavfi filters to
 *   produce waveform, spectrogram, or equalizer-bar visualizations
 *   overlaid on the audio track.
 *
 * @agent converter:audio-to-video
 * @from mp3, wav, aac, ogg, flac
 * @to   mp4, webm
 *
 * @modes hybrid
 *
 * @strategies
 *   - waveform    -- Animated audio waveform visualization.
 *   - spectrogram -- Frequency-domain spectrogram visualization.
 *   - bars        -- Equalizer-style animated bar visualization.
 *
 * @evaluation
 *   Structural: output file must exist and have non-zero size.
 *   LLM spot-check not applicable for binary video output.
 *
 * @input  {Buffer|string} Audio buffer or absolute file path.
 * @output {Buffer}        Video buffer in the target container format.
 *
 * @example
 *   const { AudioToVideoConverter } = require('./audio-to-video');
 *   const converter = new AudioToVideoConverter();
 *   const result = await converter.convert(audioBuffer, {
 *     targetFormat: 'mp4',
 *   });
 *   // result.output is a Buffer containing MP4 video
 *
 * @dependencies ffmpeg (must be on PATH; lavfi filters required)
 */

'use strict';

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { BaseConverterAgent } = require('./base-converter-agent');

// Default video dimensions
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_FPS = 30;

// Background color (dark)
const BG_COLOR = '0x1a1a2e';

class AudioToVideoConverter extends BaseConverterAgent {
  /**
   * @param {Object} [config]
   * @param {Object} [config.ai]         - AI service override (testing)
   * @param {string} [config.ffmpegPath] - Custom FFmpeg binary path
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:audio-to-video';
    this.name = 'Audio to Video Converter';
    this.description = 'Generates video visualizations from audio using FFmpeg lavfi';

    this.from = ['mp3', 'wav', 'aac', 'ogg', 'flac'];
    this.to = ['mp4', 'webm'];
    this.modes = ['hybrid'];

    this.strategies = [
      {
        id: 'waveform',
        description: 'Animated audio waveform visualization',
        when: 'Default; simple and universally recognizable',
        engine: 'ffmpeg-lavfi',
        mode: 'hybrid',
        speed: 'medium',
        quality: 'Clean scrolling waveform on dark background',
      },
      {
        id: 'spectrogram',
        description: 'Frequency-domain spectrogram visualization',
        when: 'Music or complex audio; shows frequency content over time',
        engine: 'ffmpeg-lavfi',
        mode: 'hybrid',
        speed: 'medium',
        quality: 'Colorful frequency heat-map scrolling left to right',
      },
      {
        id: 'bars',
        description: 'Equalizer-style animated bar visualization',
        when: 'Music visualization; classic equalizer look',
        engine: 'ffmpeg-lavfi',
        mode: 'hybrid',
        speed: 'medium',
        quality: 'Animated frequency bars; good for music',
      },
    ];

    this._ffmpegPath = config.ffmpegPath || 'ffmpeg';
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Generate a video visualization from audio.
   *
   * @param {Buffer|string} input - Audio buffer or file path
   * @param {string} strategy - One of 'waveform' | 'spectrogram' | 'bars'
   * @param {Object} [options]
   * @param {string} [options.targetFormat] - 'mp4' or 'webm'
   * @param {number} [options.width]        - Video width in px
   * @param {number} [options.height]       - Video height in px
   * @param {number} [options.fps]          - Frames per second
   * @param {string} [options.bgColor]      - Background hex color (0xRRGGBB)
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const startTime = Date.now();
    const targetFormat = (options.targetFormat || 'mp4').toLowerCase();

    if (!this.to.includes(targetFormat)) {
      throw new Error(`Unsupported target format: ${targetFormat}`);
    }

    const width = options.width || DEFAULT_WIDTH;
    const height = options.height || DEFAULT_HEIGHT;
    const fps = options.fps || DEFAULT_FPS;

    // Write input to a temp file if it's a Buffer
    const tmpDir = os.tmpdir();
    const inputIsBuffer = Buffer.isBuffer(input);
    const inputPath = inputIsBuffer
      ? path.join(tmpDir, `viz-in-${Date.now()}.audio`)
      : input;

    if (inputIsBuffer) {
      fs.writeFileSync(inputPath, input);
    }

    const outputPath = path.join(tmpDir, `viz-out-${Date.now()}.${targetFormat}`);

    try {
      const args = this._buildArgs(inputPath, outputPath, strategy, {
        width,
        height,
        fps,
        targetFormat,
        bgColor: options.bgColor || BG_COLOR,
      });

      await this._runFFmpeg(args);

      const outputBuffer = fs.readFileSync(outputPath);

      return {
        output: outputBuffer,
        metadata: {
          format: targetFormat,
          strategy,
          width,
          height,
          fps,
          size: outputBuffer.length,
        },
        duration: Date.now() - startTime,
        strategy,
      };
    } finally {
      this._cleanupFile(inputIsBuffer ? inputPath : null);
      this._cleanupFile(outputPath);
    }
  }

  // ===========================================================================
  // STRUCTURAL CHECKS
  // ===========================================================================

  /**
   * Verify output is a non-empty Buffer that looks like valid video.
   *
   * @param {Buffer|string} input
   * @param {Buffer} output
   * @param {string} strategy
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, strategy) {
    const issues = [];

    if (!Buffer.isBuffer(output)) {
      issues.push({
        code: 'OUTPUT_NOT_BUFFER',
        severity: 'error',
        message: 'Expected output to be a Buffer',
        fixable: true,
      });
      return issues;
    }

    if (output.length === 0) {
      issues.push({
        code: 'OUTPUT_EMPTY',
        severity: 'error',
        message: 'Output video buffer is empty (0 bytes)',
        fixable: true,
      });
      return issues;
    }

    // Video files should be at least a few KB
    if (output.length < 1024) {
      issues.push({
        code: 'OUTPUT_TOO_SMALL',
        severity: 'warning',
        message: `Output video is suspiciously small (${output.length} bytes)`,
        fixable: true,
        suggestedStrategy: strategy === 'waveform' ? 'bars' : 'waveform',
      });
    }

    // Check for MP4 signature (ftyp box) or WebM signature (EBML header)
    if (output.length >= 8) {
      const hasMP4Sig = output.slice(4, 8).toString('ascii') === 'ftyp';
      const hasWebMSig = output[0] === 0x1A && output[1] === 0x45 && output[2] === 0xDF && output[3] === 0xA3;

      if (!hasMP4Sig && !hasWebMSig) {
        issues.push({
          code: 'INVALID_VIDEO_SIGNATURE',
          severity: 'warning',
          message: 'Output does not have a recognized MP4 or WebM file signature',
          fixable: true,
        });
      }
    }

    return issues;
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  /**
   * Build FFmpeg arguments for the chosen visualization strategy.
   * @private
   */
  _buildArgs(inputPath, outputPath, strategy, opts) {
    const { width, height, fps, targetFormat, bgColor } = opts;
    const size = `${width}x${height}`;

    // Common output options
    const outputOpts = targetFormat === 'webm'
      ? ['-c:v', 'libvpx-vp9', '-c:a', 'libopus', '-b:v', '2M']
      : ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '192k', '-pix_fmt', 'yuv420p'];

    switch (strategy) {
      case 'waveform': {
        return [
          '-i', inputPath,
          '-filter_complex',
          `color=c=${bgColor}:s=${size}:r=${fps}[bg];` +
          `[0:a]showwaves=s=${size}:mode=cline:rate=${fps}:colors=0x16a085|0x2ecc71[waves];` +
          `[bg][waves]overlay=shortest=1[v]`,
          '-map', '[v]',
          '-map', '0:a',
          ...outputOpts,
          '-shortest',
          '-y',
          outputPath,
        ];
      }

      case 'spectrogram': {
        return [
          '-i', inputPath,
          '-filter_complex',
          `color=c=${bgColor}:s=${size}:r=${fps}[bg];` +
          `[0:a]showspectrum=s=${size}:mode=combined:color=intensity:slide=scroll:scale=cbrt[spec];` +
          `[bg][spec]overlay=shortest=1[v]`,
          '-map', '[v]',
          '-map', '0:a',
          ...outputOpts,
          '-shortest',
          '-y',
          outputPath,
        ];
      }

      case 'bars': {
        return [
          '-i', inputPath,
          '-filter_complex',
          `color=c=${bgColor}:s=${size}:r=${fps}[bg];` +
          `[0:a]showfreqs=s=${size}:mode=bar:fscale=log:colors=0xe74c3c|0xf39c12|0x2ecc71|0x3498db[bars];` +
          `[bg][bars]overlay=shortest=1[v]`,
          '-map', '[v]',
          '-map', '0:a',
          ...outputOpts,
          '-shortest',
          '-y',
          outputPath,
        ];
      }

      default:
        throw new Error(`Unknown visualization strategy: ${strategy}`);
    }
  }

  /**
   * Execute FFmpeg as a child process.
   * @private
   * @param {string[]} args
   * @returns {Promise<string>} stderr output
   */
  _runFFmpeg(args) {
    return new Promise((resolve, reject) => {
      execFile(this._ffmpegPath, args, { timeout: 300000 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`FFmpeg failed: ${err.message}\n${stderr}`));
          return;
        }
        resolve(stderr || stdout);
      });
    });
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

module.exports = { AudioToVideoConverter };
