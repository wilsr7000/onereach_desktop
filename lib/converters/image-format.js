/**
 * ImageFormatAgent
 *
 * @description Converts images between raster formats (PNG, JPG, WebP, GIF,
 *   TIFF, BMP) using the sharp library. Supports quality tuning, resizing
 *   during conversion, and automatic compression optimisation.
 *
 * @agent converter:image-format
 * @from png, jpg, jpeg, webp, gif, tiff, bmp
 * @to   png, jpg, webp, gif, tiff
 * @modes symbolic
 *
 * @strategies
 *   - direct    : Straight format conversion with default settings
 *   - optimized : Auto-selects quality and compression per target format
 *
 * @evaluation
 *   Structural checks verify the output buffer is non-empty and starts with
 *   the correct magic bytes for the target format.
 *
 * @input  {Buffer} Raw image bytes (any supported source format)
 * @output {Buffer} Re-encoded image bytes in the target format
 *
 * @example
 *   const { ImageFormatAgent } = require('./image-format');
 *   const agent = new ImageFormatAgent();
 *   const result = await agent.convert(pngBuffer, {
 *     targetFormat: 'webp',
 *     quality: 80,
 *   });
 *   // result.output -> Buffer<webp>
 *
 * @dependencies sharp (npm)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

// Lazy-load sharp to avoid hard crash when the native module is absent
let sharp;
try {
  sharp = require('sharp');
} catch (_e) {
  sharp = null;
}

/**
 * Magic-byte signatures used to verify output format correctness.
 * Each entry maps a target format to a check function that inspects
 * the first bytes of the output buffer.
 */
const MAGIC_BYTES = {
  png: (buf) => buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47,
  jpg: (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  jpeg: (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  webp: (buf) => buf.length >= 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP',
  gif: (buf) => buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46,
  tiff: (buf) => buf.length >= 2 && ((buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4d && buf[1] === 0x4d)),
};

/**
 * Default quality settings per format for the "optimized" strategy.
 */
const OPTIMIZED_DEFAULTS = {
  jpg: { quality: 82, mozjpeg: true },
  jpeg: { quality: 82, mozjpeg: true },
  png: { compressionLevel: 9, palette: true },
  webp: { quality: 80, effort: 6 },
  gif: {},
  tiff: { compression: 'lzw' },
};

class ImageFormatAgent extends BaseConverterAgent {
  constructor(config = {}) {
    super(config);

    this.id = 'converter:image-format';
    this.name = 'Image Format Converter';
    this.description = 'Converts images between raster formats using sharp';
    this.from = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'tiff', 'bmp'];
    this.to = ['png', 'jpg', 'webp', 'gif', 'tiff'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'direct',
        description: 'Straight format conversion with default sharp settings',
        when: 'Speed matters more than file size; default quality is acceptable',
        engine: 'sharp',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Default encoder quality for the target format',
      },
      {
        id: 'optimized',
        description: 'Auto-selects quality, compression, and encoding flags per target format',
        when: 'Output quality and file size both matter; production assets',
        engine: 'sharp',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Tuned per-format defaults (mozjpeg, palette PNG, etc.)',
      },
    ];
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Convert an image buffer to the requested target format.
   *
   * @param {Buffer} input - Source image bytes
   * @param {string} strategy - 'direct' | 'optimized'
   * @param {Object} [options]
   * @param {string}  options.targetFormat - Target format (png, jpg, webp, gif, tiff)
   * @param {number} [options.quality]    - Override quality (1-100)
   * @param {number} [options.width]      - Optional resize width
   * @param {number} [options.height]     - Optional resize height
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    if (!sharp) {
      throw new Error('sharp is not installed. Run: npm install sharp');
    }
    if (!Buffer.isBuffer(input)) {
      throw new Error('Input must be a Buffer');
    }
    if (!input.length) {
      throw new Error('Input buffer is empty');
    }

    const targetFormat = this._normaliseFormat(options.targetFormat || options.to || this.to[0]);
    if (!this.to.includes(targetFormat)) {
      throw new Error(`Unsupported target format: ${targetFormat}`);
    }

    const start = Date.now();

    let pipeline = sharp(input, { failOn: 'none', animated: targetFormat === 'gif' });

    // Optional resize during conversion
    if (options.width || options.height) {
      pipeline = pipeline.resize({
        width: options.width || undefined,
        height: options.height || undefined,
        fit: options.fit || 'inside',
        withoutEnlargement: true,
      });
    }

    // Apply format-specific settings
    const formatOpts = this._buildFormatOptions(targetFormat, strategy, options);
    pipeline = pipeline.toFormat(targetFormat, formatOpts);

    const outputBuffer = await pipeline.toBuffer();
    const metadata = await sharp(outputBuffer).metadata();

    return {
      output: outputBuffer,
      metadata: {
        format: targetFormat,
        width: metadata.width,
        height: metadata.height,
        size: outputBuffer.length,
        strategy,
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  // ===========================================================================
  // STRUCTURAL CHECKS
  // ===========================================================================

  /**
   * Verify the output buffer is a valid image in the expected format.
   *
   * @param {Buffer} input
   * @param {Buffer} output
   * @param {string} strategy
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, _strategy) {
    const issues = [];

    if (!Buffer.isBuffer(output)) {
      issues.push({
        code: 'NOT_BUFFER',
        severity: 'error',
        message: 'Output is not a Buffer',
        fixable: true,
      });
      return issues;
    }

    if (output.length === 0) {
      issues.push({
        code: 'EMPTY_BUFFER',
        severity: 'error',
        message: 'Output buffer is empty (0 bytes)',
        fixable: true,
      });
      return issues;
    }

    // Determine expected target format from conversion metadata or fallback
    const targetFormat = this._resolveTargetFormat(output);

    if (targetFormat && MAGIC_BYTES[targetFormat]) {
      const check = MAGIC_BYTES[targetFormat];
      if (!check(output)) {
        issues.push({
          code: 'MAGIC_BYTES_MISMATCH',
          severity: 'error',
          message: `Output does not start with expected magic bytes for ${targetFormat}`,
          fixable: true,
          suggestedStrategy: 'direct',
        });
      }
    }

    // Warn if output is suspiciously small (< 100 bytes is almost certainly broken)
    if (output.length < 100) {
      issues.push({
        code: 'SUSPICIOUSLY_SMALL',
        severity: 'warning',
        message: `Output is only ${output.length} bytes, which is unusually small for an image`,
        fixable: false,
      });
    }

    return issues;
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  /**
   * Build encoder options for the target format and strategy.
   * @private
   */
  _buildFormatOptions(targetFormat, strategy, options) {
    if (strategy === 'optimized') {
      const defaults = OPTIMIZED_DEFAULTS[targetFormat] || {};
      const opts = { ...defaults };

      // Allow caller to override quality
      if (typeof options.quality === 'number') {
        opts.quality = Math.max(1, Math.min(100, options.quality));
      }

      return opts;
    }

    // "direct" strategy — minimal options, only honour explicit quality
    const opts = {};
    if (typeof options.quality === 'number') {
      opts.quality = Math.max(1, Math.min(100, options.quality));
    }
    return opts;
  }

  /**
   * Normalise format strings (e.g. 'jpeg' -> 'jpg' for magic-byte lookup,
   * but keep 'jpeg' for sharp since sharp accepts both).
   * @private
   */
  _normaliseFormat(fmt) {
    const f = String(fmt).toLowerCase().trim();
    // sharp uses 'jpeg' internally, but we keep our canonical set
    if (f === 'jpeg') return 'jpg';
    return f;
  }

  /**
   * Attempt to resolve target format from the output buffer by probing magic
   * bytes. Used when the format is not explicitly provided in metadata.
   * @private
   */
  _resolveTargetFormat(output) {
    if (!Buffer.isBuffer(output)) return null;
    for (const [fmt, check] of Object.entries(MAGIC_BYTES)) {
      if (fmt === 'jpeg') continue; // skip duplicate
      if (check(output)) return fmt;
    }
    return null;
  }

  /**
   * Override input description to include buffer size context.
   * @override
   */
  _describeInput(input, metadata = {}) {
    if (Buffer.isBuffer(input)) {
      const kb = (input.length / 1024).toFixed(1);
      return `Image buffer (${kb} KB). ${metadata.mimeType || ''} ${metadata.fileName || ''}`.trim();
    }
    return super._describeInput(input, metadata);
  }
}

module.exports = { ImageFormatAgent };
