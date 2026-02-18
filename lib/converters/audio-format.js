/**
 * AudioFormatConverter
 *
 * @description Converts between audio file formats using FFmpeg as the
 *   underlying engine. Supports direct passthrough conversion, loudness
 *   normalization, and automatic bitrate optimization. Operates entirely
 *   in symbolic mode -- no generative AI is involved.
 *
 * @agent converter:audio-format
 * @from mp3, wav, aac, ogg, flac, m4a
 * @to   mp3, wav, aac, ogg, flac
 *
 * @modes symbolic
 *
 * @strategies
 *   - direct     -- Straight FFmpeg transcode to target codec/container.
 *   - normalized -- Transcode with EBU R128 loudness normalization.
 *   - optimized  -- Auto-select bitrate/sample-rate for best size-to-quality
 *                   ratio based on input analysis.
 *
 * @evaluation
 *   Structural: output Buffer must be non-empty.
 *   No LLM spot-check (symbolic mode).
 *
 * @input  {Buffer|string} Audio buffer or absolute file path.
 * @output {Buffer}        Converted audio buffer in the target format.
 *
 * @example
 *   const { AudioFormatConverter } = require('./audio-format');
 *   const converter = new AudioFormatConverter();
 *   const result = await converter.convert(audioBuffer, {
 *     targetFormat: 'wav',
 *   });
 *   // result.output is a Buffer containing WAV data
 *
 * @dependencies ffmpeg (must be on PATH or configured in settings)
 */

'use strict';

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { BaseConverterAgent } = require('./base-converter-agent');

// Codec map -- maps output extension to FFmpeg codec name
const CODEC_MAP = {
  mp3: 'libmp3lame',
  wav: 'pcm_s16le',
  aac: 'aac',
  ogg: 'libvorbis',
  flac: 'flac',
};

// Recommended bitrates per codec for the "optimized" strategy
const OPTIMIZED_BITRATE = {
  mp3: '192k',
  aac: '128k',
  ogg: '160k',
  flac: null, // lossless -- no bitrate flag
  wav: null, // uncompressed
};

class AudioFormatConverter extends BaseConverterAgent {
  /**
   * @param {Object} [config]
   * @param {Object} [config.ai] - AI service override (testing)
   * @param {string} [config.ffmpegPath] - Custom FFmpeg binary path
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:audio-format';
    this.name = 'Audio Format Converter';
    this.description = 'Converts between audio formats using FFmpeg';

    this.from = ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a'];
    this.to = ['mp3', 'wav', 'aac', 'ogg', 'flac'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'direct',
        description: 'Straight FFmpeg transcode to target codec',
        when: 'Default; quick format conversion with no processing',
        engine: 'ffmpeg',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Same as source (codec-limited)',
      },
      {
        id: 'normalized',
        description: 'Transcode with EBU R128 loudness normalization',
        when: 'Audio levels are inconsistent or too quiet/loud',
        engine: 'ffmpeg',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Normalized to -14 LUFS; good for podcasts/voice',
      },
      {
        id: 'optimized',
        description: 'Auto-select bitrate and sample rate for best size-to-quality ratio',
        when: 'File size matters; distributing audio on the web',
        engine: 'ffmpeg',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Tuned bitrate per codec; smaller files',
      },
    ];

    this._ffmpegPath = config.ffmpegPath || 'ffmpeg';
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Run the audio format conversion.
   *
   * @param {Buffer|string} input - Audio buffer or file path
   * @param {string} strategy - One of 'direct' | 'normalized' | 'optimized'
   * @param {Object} [options]
   * @param {string}  options.targetFormat - Target extension (mp3, wav, ...)
   * @param {string} [options.bitrate]     - Override bitrate (e.g. '256k')
   * @param {number} [options.sampleRate]  - Override sample rate (e.g. 44100)
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const startTime = Date.now();
    const targetFormat = (options.targetFormat || this.to[0]).toLowerCase();

    if (!this.to.includes(targetFormat)) {
      throw new Error(`Unsupported target format: ${targetFormat}`);
    }

    const codec = CODEC_MAP[targetFormat];
    if (!codec) {
      throw new Error(`No codec mapping for format: ${targetFormat}`);
    }

    // Write input to a temp file if it's a Buffer
    const tmpDir = os.tmpdir();
    const inputIsBuffer = Buffer.isBuffer(input);
    const inputPath = inputIsBuffer ? path.join(tmpDir, `convert-in-${Date.now()}.audio`) : input;

    if (inputIsBuffer) {
      fs.writeFileSync(inputPath, input);
    }

    const outputPath = path.join(tmpDir, `convert-out-${Date.now()}.${targetFormat}`);

    try {
      const args = this._buildArgs(inputPath, outputPath, codec, targetFormat, strategy, options);

      await this._runFFmpeg(args);

      const outputBuffer = fs.readFileSync(outputPath);

      return {
        output: outputBuffer,
        metadata: {
          format: targetFormat,
          codec,
          strategy,
          size: outputBuffer.length,
        },
        duration: Date.now() - startTime,
        strategy,
      };
    } finally {
      // Clean up temp files
      this._cleanupFile(inputIsBuffer ? inputPath : null);
      this._cleanupFile(outputPath);
    }
  }

  // ===========================================================================
  // STRUCTURAL CHECKS
  // ===========================================================================

  /**
   * Verify the output buffer is non-empty and reasonably sized.
   *
   * @param {Buffer|string} input
   * @param {Buffer} output
   * @param {string} strategy
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, _strategy) {
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
        code: 'OUTPUT_EMPTY_BUFFER',
        severity: 'error',
        message: 'Output buffer is empty (0 bytes)',
        fixable: true,
      });
      return issues;
    }

    // Sanity check: output should be at least 100 bytes for any real audio
    if (output.length < 100) {
      issues.push({
        code: 'OUTPUT_TOO_SMALL',
        severity: 'warning',
        message: `Output buffer suspiciously small (${output.length} bytes)`,
        fixable: false,
      });
    }

    return issues;
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  /**
   * Build FFmpeg argument array based on strategy.
   * @private
   */
  _buildArgs(inputPath, outputPath, codec, format, strategy, options) {
    const args = ['-i', inputPath, '-y']; // -y to overwrite output

    switch (strategy) {
      case 'normalized': {
        // Two-pass EBU R128 loudness normalization
        args.push('-af', 'loudnorm=I=-14:TP=-1:LRA=11', '-acodec', codec);
        break;
      }

      case 'optimized': {
        args.push('-acodec', codec);
        const bitrate = options.bitrate || OPTIMIZED_BITRATE[format];
        if (bitrate) {
          args.push('-b:a', bitrate);
        }
        if (options.sampleRate) {
          args.push('-ar', String(options.sampleRate));
        } else if (format === 'mp3' || format === 'aac' || format === 'ogg') {
          // Default to 44.1kHz for lossy formats
          args.push('-ar', '44100');
        }
        break;
      }

      case 'direct':
      default: {
        args.push('-acodec', codec);
        if (options.bitrate) {
          args.push('-b:a', options.bitrate);
        }
        if (options.sampleRate) {
          args.push('-ar', String(options.sampleRate));
        }
        break;
      }
    }

    args.push(outputPath);
    return args;
  }

  /**
   * Execute FFmpeg as a child process.
   * @private
   * @param {string[]} args
   * @returns {Promise<string>} stderr output (FFmpeg logs to stderr)
   */
  _runFFmpeg(args) {
    return new Promise((resolve, reject) => {
      execFile(this._ffmpegPath, args, { timeout: 120000 }, (err, stdout, stderr) => {
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

module.exports = { AudioFormatConverter };
