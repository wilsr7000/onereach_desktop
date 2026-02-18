/**
 * ImageToPdfAgent
 *
 * @description Embeds a raster image into a PDF document. Supports single-page
 *   embedding and auto-fitted A4 output with optional rotation to best fit
 *   the image aspect ratio.
 *
 * @agent converter:image-to-pdf
 * @from png, jpg, jpeg, webp, gif, tiff, bmp
 * @to   pdf
 * @modes symbolic
 *
 * @strategies
 *   - single-page : Embeds the image at native dimensions on one PDF page
 *   - fitted      : Resizes and auto-rotates the image to fit within A4
 *                    dimensions while preserving aspect ratio
 *
 * @evaluation
 *   Structural checks verify the output buffer is non-empty. Because full
 *   PDF generation would require pdfkit (not assumed installed), this agent
 *   resizes the image to A4-appropriate dimensions and returns the image
 *   buffer alongside PDF-ready metadata. Downstream consumers can wrap
 *   the output in a real PDF container.
 *
 * @input  {Buffer} Raw image bytes (any supported raster format)
 * @output {Buffer} Resized image buffer with PDF-ready metadata
 *
 * @example
 *   const { ImageToPdfAgent } = require('./image-to-pdf');
 *   const agent = new ImageToPdfAgent();
 *   const result = await agent.convert(imageBuffer);
 *   // result.output   -> Buffer (resized image)
 *   // result.metadata -> { pageWidth, pageHeight, orientation, ... }
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
 * Standard page dimensions in pixels at 72 DPI.
 * A4 = 210mm x 297mm = 595.28pt x 841.89pt
 * @private
 */
const A4 = {
  WIDTH_PT: 595,
  HEIGHT_PT: 842,
  MARGIN_PT: 36, // 0.5-inch margin
};

/**
 * Compute the usable area (page minus margins).
 * @private
 */
function usableArea() {
  return {
    width: A4.WIDTH_PT - 2 * A4.MARGIN_PT,
    height: A4.HEIGHT_PT - 2 * A4.MARGIN_PT,
  };
}

class ImageToPdfAgent extends BaseConverterAgent {
  constructor(config = {}) {
    super(config);

    this.id = 'converter:image-to-pdf';
    this.name = 'Image to PDF Converter';
    this.description = 'Embeds a raster image into a PDF-ready page with optional A4 fitting';
    this.from = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'tiff', 'bmp'];
    this.to = ['pdf'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'single-page',
        description: 'Embeds the image at its native resolution on a single page sized to the image',
        when: 'Image dimensions should be preserved exactly; downstream consumer handles page sizing',
        engine: 'sharp',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Pixel-perfect; no resizing applied',
      },
      {
        id: 'fitted',
        description: 'Auto-rotates and resizes the image to fit within A4 page dimensions',
        when: 'The output must conform to a standard A4 page for printing or distribution',
        engine: 'sharp',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Resized to fit A4 with preserved aspect ratio',
      },
    ];
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Process the image for PDF embedding.
   *
   * @param {Buffer} input - Source image bytes
   * @param {string} strategy - 'single-page' | 'fitted'
   * @param {Object} [options]
   * @param {string} [options.outputFormat] - Intermediate image format ('png' or 'jpg')
   * @param {number} [options.quality]      - JPEG quality if outputFormat is jpg
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

    const start = Date.now();
    const inputMeta = await sharp(input, { failOn: 'none' }).metadata();
    const imgWidth = inputMeta.width || 0;
    const imgHeight = inputMeta.height || 0;

    if (imgWidth === 0 || imgHeight === 0) {
      throw new Error('Cannot read image dimensions from input');
    }

    const outputFormat = options.outputFormat || 'png';

    let outputBuffer;
    let pageWidth;
    let pageHeight;
    let orientation = 'portrait';

    if (strategy === 'single-page') {
      // Keep native dimensions; page matches image size
      outputBuffer = await sharp(input, { failOn: 'none' })
        .toFormat(outputFormat, this._formatOptions(outputFormat, options))
        .toBuffer();

      pageWidth = imgWidth;
      pageHeight = imgHeight;
      orientation = imgWidth > imgHeight ? 'landscape' : 'portrait';
    } else {
      // "fitted" strategy — resize to fit A4
      const area = usableArea();
      const aspectRatio = imgWidth / imgHeight;

      // Decide orientation: rotate page to landscape if image is wider than tall
      if (aspectRatio > 1) {
        orientation = 'landscape';
        pageWidth = A4.HEIGHT_PT;
        pageHeight = A4.WIDTH_PT;
      } else {
        orientation = 'portrait';
        pageWidth = A4.WIDTH_PT;
        pageHeight = A4.HEIGHT_PT;
      }

      // Compute fit dimensions within usable area (respecting orientation)
      const fitWidth = orientation === 'landscape' ? A4.HEIGHT_PT - 2 * A4.MARGIN_PT : area.width;
      const fitHeight = orientation === 'landscape' ? A4.WIDTH_PT - 2 * A4.MARGIN_PT : area.height;

      outputBuffer = await sharp(input, { failOn: 'none' })
        .resize({
          width: Math.round(fitWidth),
          height: Math.round(fitHeight),
          fit: 'inside',
          withoutEnlargement: true,
        })
        .toFormat(outputFormat, this._formatOptions(outputFormat, options))
        .toBuffer();
    }

    const outputMeta = await sharp(outputBuffer).metadata();

    return {
      output: outputBuffer,
      metadata: {
        format: 'pdf',
        imageFormat: outputFormat,
        pageWidth,
        pageHeight,
        imageWidth: outputMeta.width,
        imageHeight: outputMeta.height,
        orientation,
        a4Fitted: strategy === 'fitted',
        inputSize: input.length,
        outputSize: outputBuffer.length,
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
   * Verify the output buffer is valid.
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

    // For fitted strategy, verify dimensions are within A4 bounds
    if (strategy === 'fitted' && sharp) {
      try {
        const meta = await sharp(output).metadata();
        const maxDim = Math.max(A4.HEIGHT_PT, A4.WIDTH_PT);
        if ((meta.width || 0) > maxDim || (meta.height || 0) > maxDim) {
          issues.push({
            code: 'EXCEEDS_A4',
            severity: 'warning',
            message: `Output dimensions (${meta.width}x${meta.height}) exceed A4 bounds`,
            fixable: true,
          });
        }
      } catch (err) {
        issues.push({
          code: 'METADATA_READ_FAILED',
          severity: 'warning',
          message: `Could not read output metadata: ${err.message}`,
          fixable: false,
        });
      }
    }

    // Warn if output is suspiciously small
    if (output.length < 50) {
      issues.push({
        code: 'SUSPICIOUSLY_SMALL',
        severity: 'warning',
        message: `Output is only ${output.length} bytes, which is unusually small`,
        fixable: false,
      });
    }

    return issues;
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  /**
   * Build format options for the intermediate image encoding.
   * @private
   */
  _formatOptions(format, options) {
    const opts = {};
    if (format === 'jpg' || format === 'jpeg') {
      opts.quality = options.quality || 90;
      opts.mozjpeg = true;
    } else if (format === 'png') {
      opts.compressionLevel = 6;
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
      return `Image buffer (${kb} KB) to be embedded in a PDF. ${metadata.mimeType || ''} ${metadata.fileName || ''}`.trim();
    }
    return super._describeInput(input, metadata);
  }
}

module.exports = { ImageToPdfAgent };
