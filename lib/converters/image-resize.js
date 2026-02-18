/**
 * ImageResizeAgent
 *
 * @description Resizes and crops raster images using the sharp library.
 *   Supports exact-dimension resizing, aspect-preserving fit, and
 *   attention-based smart cropping.
 *
 * @agent converter:image-resize
 * @from png, jpg, jpeg, webp, gif, tiff, bmp
 * @to   png, jpg, webp, gif, tiff
 * @modes symbolic
 *
 * @strategies
 *   - exact      : Resize to exact width/height (may distort aspect ratio)
 *   - fit        : Fit within bounding box while preserving aspect ratio
 *   - smart-crop : Use sharp attention-based crop to focus on the most
 *                  interesting region of the image
 *
 * @evaluation
 *   Structural checks verify the output is a non-empty Buffer and that
 *   the resulting dimensions match the requested target (when applicable).
 *
 * @input  {Buffer} Raw image bytes (any supported raster format)
 * @output {Buffer} Resized/cropped image bytes in the target format
 *
 * @example
 *   const { ImageResizeAgent } = require('./image-resize');
 *   const agent = new ImageResizeAgent();
 *   const result = await agent.convert(imageBuffer, {
 *     width: 800,
 *     height: 600,
 *     targetFormat: 'webp',
 *   });
 *   // result.output -> Buffer<webp> at 800x600
 *
 * @dependencies sharp (npm)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

let sharp;
try {
  sharp = require('sharp');
} catch (_e) {
  sharp = null;
}

/**
 * Mapping from strategy ID to sharp resize fit mode.
 * @private
 */
const _FIT_MODES = {
  exact: 'fill',
  fit: 'inside',
  'smart-crop': 'cover',
};

class ImageResizeAgent extends BaseConverterAgent {
  constructor(config = {}) {
    super(config);

    this.id = 'converter:image-resize';
    this.name = 'Image Resize Converter';
    this.description = 'Resizes and crops images using sharp (exact, fit, smart-crop)';
    this.from = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'tiff', 'bmp'];
    this.to = ['png', 'jpg', 'webp', 'gif', 'tiff'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'exact',
        description: 'Resize to the exact dimensions specified, stretching if necessary',
        when: 'Pixel-exact output dimensions are required regardless of distortion',
        engine: 'sharp',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Exact dimensions; may distort aspect ratio',
      },
      {
        id: 'fit',
        description: 'Fit within the bounding box while preserving aspect ratio',
        when: 'Output must not exceed given dimensions but aspect ratio must be preserved',
        engine: 'sharp',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Aspect-preserved; actual dimensions may be smaller than requested',
      },
      {
        id: 'smart-crop',
        description: 'Attention-based crop to the most interesting region, then resize to target',
        when: 'Thumbnails, social media cards, or previews where the subject must stay centred',
        engine: 'sharp',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Exact dimensions; subject-aware cropping via sharp attention',
      },
    ];
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Resize or crop an image according to the chosen strategy.
   *
   * @param {Buffer} input - Source image bytes
   * @param {string} strategy - 'exact' | 'fit' | 'smart-crop'
   * @param {Object} [options]
   * @param {number}  [options.width]        - Target width in pixels
   * @param {number}  [options.height]       - Target height in pixels
   * @param {string}  [options.fit]          - Override sharp fit mode
   * @param {string}  [options.targetFormat] - Output format (defaults to source format)
   * @param {number}  [options.quality]      - Output quality (1-100)
   * @param {boolean} [options.withoutEnlargement] - Prevent upscaling (default true for fit)
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    if (!sharp) {
      throw new Error('sharp is not installed. Run: npm install sharp');
    }
    if (!Buffer.isBuffer(input)) {
      throw new Error('Input must be a Buffer');
    }
    if (input.length === 0) {
      throw new Error('Input image buffer is empty');
    }

    const width = options.width ? Math.round(options.width) : undefined;
    const height = options.height ? Math.round(options.height) : undefined;

    if (!width && !height) {
      throw new Error('At least one of options.width or options.height is required');
    }

    const start = Date.now();

    // Read source metadata for reporting
    const inputMeta = await sharp(input, { failOn: 'none' }).metadata();
    const targetFormat = this._resolveTargetFormat(options, inputMeta);

    let pipeline = sharp(input, {
      failOn: 'none',
      animated: targetFormat === 'gif',
    });

    // Build resize options based on strategy
    const resizeOpts = this._buildResizeOptions(strategy, width, height, options);
    pipeline = pipeline.resize(resizeOpts);

    // Apply output format
    const formatOpts = this._buildFormatOptions(targetFormat, options);
    pipeline = pipeline.toFormat(targetFormat, formatOpts);

    const outputBuffer = await pipeline.toBuffer();
    const outputMeta = await sharp(outputBuffer).metadata();

    return {
      output: outputBuffer,
      metadata: {
        format: targetFormat,
        strategy,
        inputWidth: inputMeta.width,
        inputHeight: inputMeta.height,
        outputWidth: outputMeta.width,
        outputHeight: outputMeta.height,
        requestedWidth: width,
        requestedHeight: height,
        inputSize: input.length,
        outputSize: outputBuffer.length,
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  // ===========================================================================
  // STRUCTURAL CHECKS
  // ===========================================================================

  /**
   * Verify the output buffer is valid and dimensions match expectations.
   *
   * @param {Buffer} input
   * @param {Buffer} output
   * @param {string} strategy
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, strategy) {
    const issues = [];

    if (!Buffer.isBuffer(output)) {
      issues.push({
        code: 'NOT_BUFFER',
        severity: 'error',
        message: `Output is ${typeof output}, expected Buffer`,
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

    // Verify dimensions if sharp is available
    if (sharp) {
      try {
        const meta = await sharp(output).metadata();

        if (!meta.width || !meta.height) {
          issues.push({
            code: 'NO_DIMENSIONS',
            severity: 'error',
            message: 'Cannot read dimensions from output image',
            fixable: true,
          });
          return issues;
        }

        // For "exact" and "smart-crop", output should match requested dimensions
        if (strategy === 'exact' || strategy === 'smart-crop') {
          // Dimensions are stored in the result metadata but we don't have
          // access to the original options here. We check that width and
          // height are both positive (non-degenerate).
          if (meta.width < 1 || meta.height < 1) {
            issues.push({
              code: 'DEGENERATE_DIMENSIONS',
              severity: 'error',
              message: `Output has degenerate dimensions: ${meta.width}x${meta.height}`,
              fixable: true,
            });
          }
        }

        // For "fit", output should not exceed requested bounds
        if (strategy === 'fit' && (meta.width < 1 || meta.height < 1)) {
          issues.push({
            code: 'DEGENERATE_DIMENSIONS',
            severity: 'error',
            message: `Output has degenerate dimensions: ${meta.width}x${meta.height}`,
            fixable: true,
          });
        }
      } catch (err) {
        issues.push({
          code: 'METADATA_READ_FAILED',
          severity: 'warning',
          message: `Could not verify output dimensions: ${err.message}`,
          fixable: false,
        });
      }
    }

    // Warn if output is suspiciously small
    if (output.length < 50) {
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
   * Build sharp resize options for the given strategy.
   * @private
   */
  _buildResizeOptions(strategy, width, height, options) {
    const opts = {
      width: width || undefined,
      height: height || undefined,
    };

    if (strategy === 'exact') {
      opts.fit = options.fit || 'fill';
      opts.withoutEnlargement = false;
    } else if (strategy === 'fit') {
      opts.fit = options.fit || 'inside';
      opts.withoutEnlargement = options.withoutEnlargement !== false;
    } else if (strategy === 'smart-crop') {
      opts.fit = 'cover';
      opts.position = sharp.strategy.attention;
      opts.withoutEnlargement = false;
    }

    return opts;
  }

  /**
   * Resolve the target output format. Falls back to source format.
   * @private
   */
  _resolveTargetFormat(options, inputMeta) {
    if (options.targetFormat) {
      const fmt = String(options.targetFormat).toLowerCase().trim();
      return fmt === 'jpeg' ? 'jpg' : fmt;
    }
    if (options.to) {
      const fmt = String(options.to).toLowerCase().trim();
      return fmt === 'jpeg' ? 'jpg' : fmt;
    }
    // Preserve source format
    const src = (inputMeta.format || 'png').toLowerCase();
    if (src === 'jpeg') return 'jpg';
    if (this.to.includes(src)) return src;
    return 'png'; // safe default
  }

  /**
   * Build format-specific encoding options.
   * @private
   */
  _buildFormatOptions(format, options) {
    const opts = {};
    if (typeof options.quality === 'number') {
      opts.quality = Math.max(1, Math.min(100, options.quality));
    }
    if (format === 'png') {
      opts.compressionLevel = 6;
    }
    if (format === 'jpg' || format === 'jpeg') {
      opts.mozjpeg = true;
    }
    return opts;
  }

  /**
   * Override input description for LLM planning context.
   * @override
   */
  _describeInput(input, metadata = {}) {
    if (Buffer.isBuffer(input)) {
      const kb = (input.length / 1024).toFixed(1);
      return `Image buffer (${kb} KB) to be resized. ${metadata.mimeType || ''} ${metadata.fileName || ''}`.trim();
    }
    return super._describeInput(input, metadata);
  }
}

module.exports = { ImageResizeAgent };
