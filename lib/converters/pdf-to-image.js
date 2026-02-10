/**
 * PdfToImageAgent
 *
 * @description Converts PDF documents to raster images (PNG/JPG). Supports
 *   single-page rendering, full multi-page rendering, and thumbnail generation.
 *   Uses external tools (FFmpeg/pdftoppm) when available, with a sharp-based
 *   text-overlay fallback for environments without native PDF renderers.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/pdf-to-image
 *
 * @agent converter:pdf-to-image
 * @from pdf
 * @to   png, jpg
 * @modes symbolic
 *
 * @strategies
 *   - single-page : Render a single page (default: first page) as an image
 *   - all-pages   : Render every page, return an array of image buffers
 *   - thumbnail   : Low-resolution preview of the first page
 *
 * @evaluation
 *   Structural checks verify the output is a non-empty Buffer (single-page/thumbnail)
 *   or a non-empty array of Buffers (all-pages).
 *
 * @input  {Buffer} PDF file bytes
 * @output {Buffer|Buffer[]} Image bytes (single) or array of image bytes (all-pages)
 *
 * @example
 *   const { PdfToImageAgent } = require('./pdf-to-image');
 *   const agent = new PdfToImageAgent();
 *   const result = await agent.convert(pdfBuffer, { strategy: 'thumbnail' });
 *   // result.output => <Buffer 89 50 4E 47 ...>
 *
 * @dependencies sharp, pdf-parse (fallback), child_process (pdftoppm/ffmpeg)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class PdfToImageAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:pdf-to-image';
    this.name = 'PDF to Image';
    this.description = 'Renders PDF pages as PNG/JPG images via pdftoppm, FFmpeg, or sharp fallback';
    this.from = ['pdf'];
    this.to = ['png', 'jpg'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'single-page',
        description: 'Render a single page (default: first) as a high-resolution image',
        when: 'Only one page is needed, such as a cover or specific page reference',
        engine: 'pdftoppm / sharp',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'High resolution rendering of one page',
      },
      {
        id: 'all-pages',
        description: 'Render every page in the PDF as individual images',
        when: 'All pages must be converted, e.g. for a page-by-page image gallery',
        engine: 'pdftoppm / sharp',
        mode: 'symbolic',
        speed: 'slow',
        quality: 'High resolution rendering of all pages',
      },
      {
        id: 'thumbnail',
        description: 'Generate a low-resolution preview thumbnail of the first page',
        when: 'A small preview image is needed for listing or gallery views',
        engine: 'pdftoppm / sharp',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Low resolution, suitable for thumbnails and previews',
      },
    ];
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Execute the PDF-to-image conversion.
   *
   * @param {Buffer} input - PDF file bytes
   * @param {string} strategy - Strategy ID: 'single-page' | 'all-pages' | 'thumbnail'
   * @param {Object} [options] - Additional conversion options
   * @param {number} [options.page] - Page number for single-page (1-based, default 1)
   * @param {string} [options.format] - Output format: 'png' | 'jpeg' (default 'png')
   * @param {number} [options.dpi] - Rendering DPI (default varies by strategy)
   * @param {number} [options.quality] - JPEG quality 0-100 (default 90)
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const start = Date.now();

    if (!Buffer.isBuffer(input)) {
      throw new Error('Input must be a Buffer containing PDF bytes');
    }
    if (input.length === 0) {
      throw new Error('Input PDF buffer is empty');
    }

    const format = options.format || 'png';
    const page = options.page || 1;

    let output;
    let renderMethod = 'unknown';

    switch (strategy) {
      case 'single-page': {
        const dpi = options.dpi || 200;
        try {
          output = await this._renderWithPdftoppm(input, { page, dpi, format, quality: options.quality });
          renderMethod = 'pdftoppm';
        } catch (err) {
          output = await this._renderFallback(input, { page, format, width: 1200, height: 1600 });
          renderMethod = 'sharp-fallback';
        }
        break;
      }

      case 'all-pages': {
        const dpi = options.dpi || 150;
        try {
          output = await this._renderAllWithPdftoppm(input, { dpi, format, quality: options.quality });
          renderMethod = 'pdftoppm';
        } catch (err) {
          // Fallback: render first page only and return as single-element array
          const singlePage = await this._renderFallback(input, { page: 1, format, width: 1200, height: 1600 });
          output = [singlePage];
          renderMethod = 'sharp-fallback-partial';
        }
        break;
      }

      case 'thumbnail': {
        const dpi = options.dpi || 72;
        try {
          const fullPage = await this._renderWithPdftoppm(input, { page: 1, dpi, format, quality: options.quality });
          output = await this._resizeToThumbnail(fullPage, format, options.quality);
          renderMethod = 'pdftoppm+resize';
        } catch (err) {
          output = await this._renderFallback(input, { page: 1, format, width: 300, height: 400 });
          renderMethod = 'sharp-fallback';
        }
        break;
      }

      default:
        throw new Error(`Unknown strategy: ${strategy}`);
    }

    const outputSize = Array.isArray(output)
      ? output.reduce((sum, buf) => sum + buf.length, 0)
      : output.length;

    return {
      output,
      metadata: {
        strategy,
        format,
        renderMethod,
        pageCount: Array.isArray(output) ? output.length : 1,
        outputSize,
        inputSize: input.length,
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  // ===========================================================================
  // STRUCTURAL CHECKS
  // ===========================================================================

  /**
   * Verify the image output meets conversion expectations.
   *
   * @param {Buffer} input - Original PDF input
   * @param {*} output - Conversion output to validate
   * @param {string} strategy - Strategy that was used
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, strategy) {
    const issues = [];

    if (strategy === 'all-pages') {
      // Expect an array of Buffers
      if (!Array.isArray(output)) {
        issues.push({
          code: 'OUTPUT_NOT_ARRAY',
          severity: 'error',
          message: `Expected array of Buffers for all-pages strategy, got ${typeof output}`,
          fixable: true,
        });
        return issues;
      }

      if (output.length === 0) {
        issues.push({
          code: 'OUTPUT_EMPTY_ARRAY',
          severity: 'error',
          message: 'All-pages rendering produced empty array',
          fixable: true,
        });
        return issues;
      }

      // Check each buffer
      for (let i = 0; i < output.length; i++) {
        if (!Buffer.isBuffer(output[i])) {
          issues.push({
            code: 'PAGE_NOT_BUFFER',
            severity: 'error',
            message: `Page ${i + 1} is not a Buffer`,
            fixable: true,
          });
        } else if (output[i].length === 0) {
          issues.push({
            code: 'PAGE_EMPTY',
            severity: 'warning',
            message: `Page ${i + 1} buffer is empty`,
            fixable: true,
          });
        }
      }
    } else {
      // Expect a single Buffer
      if (!Buffer.isBuffer(output)) {
        issues.push({
          code: 'OUTPUT_NOT_BUFFER',
          severity: 'error',
          message: `Expected Buffer output, got ${typeof output}`,
          fixable: false,
        });
        return issues;
      }

      if (output.length === 0) {
        issues.push({
          code: 'OUTPUT_EMPTY_BUFFER',
          severity: 'error',
          message: 'Image output buffer is empty',
          fixable: true,
        });
        return issues;
      }

      // Warn if suspiciously small
      if (output.length < 500) {
        issues.push({
          code: 'IMAGE_TOO_SMALL',
          severity: 'warning',
          message: `Image is only ${output.length} bytes, may be blank or corrupt`,
          fixable: true,
        });
      }
    }

    return issues;
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  /**
   * Render a single PDF page using pdftoppm (poppler-utils).
   *
   * @param {Buffer} pdfBuffer
   * @param {Object} opts
   * @returns {Promise<Buffer>}
   * @private
   */
  async _renderWithPdftoppm(pdfBuffer, opts) {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    const execFileAsync = promisify(execFile);
    const tmpDir = os.tmpdir();
    const tmpInput = path.join(tmpDir, `pdf-render-${Date.now()}.pdf`);
    const tmpOutput = path.join(tmpDir, `pdf-render-${Date.now()}`);

    try {
      fs.writeFileSync(tmpInput, pdfBuffer);

      const args = [
        '-f', String(opts.page || 1),
        '-l', String(opts.page || 1),
        '-r', String(opts.dpi || 150),
        '-singlefile',
      ];

      if (opts.format === 'jpeg' || opts.format === 'jpg') {
        args.push('-jpeg');
        if (opts.quality) args.push('-jpegopt', `quality=${opts.quality}`);
      } else {
        args.push('-png');
      }

      args.push(tmpInput, tmpOutput);

      await execFileAsync('pdftoppm', args);

      const ext = (opts.format === 'jpeg' || opts.format === 'jpg') ? '.jpg' : '.png';
      const outputPath = tmpOutput + ext;

      if (!fs.existsSync(outputPath)) {
        throw new Error('pdftoppm did not produce output file');
      }

      return fs.readFileSync(outputPath);
    } finally {
      // Cleanup temp files
      try { fs.unlinkSync(tmpInput); } catch (e) { /* ignore */ }
      const ext = (opts.format === 'jpeg' || opts.format === 'jpg') ? '.jpg' : '.png';
      try { fs.unlinkSync(tmpOutput + ext); } catch (e) { /* ignore */ }
    }
  }

  /**
   * Render all PDF pages using pdftoppm.
   *
   * @param {Buffer} pdfBuffer
   * @param {Object} opts
   * @returns {Promise<Buffer[]>}
   * @private
   */
  async _renderAllWithPdftoppm(pdfBuffer, opts) {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    const execFileAsync = promisify(execFile);
    const tmpDir = os.tmpdir();
    const prefix = `pdf-all-${Date.now()}`;
    const tmpInput = path.join(tmpDir, `${prefix}.pdf`);
    const tmpOutput = path.join(tmpDir, prefix);

    try {
      fs.writeFileSync(tmpInput, pdfBuffer);

      const args = [
        '-r', String(opts.dpi || 150),
      ];

      if (opts.format === 'jpeg' || opts.format === 'jpg') {
        args.push('-jpeg');
        if (opts.quality) args.push('-jpegopt', `quality=${opts.quality}`);
      } else {
        args.push('-png');
      }

      args.push(tmpInput, tmpOutput);

      await execFileAsync('pdftoppm', args);

      // Collect output files (pdftoppm creates prefix-01.png, prefix-02.png, etc.)
      const ext = (opts.format === 'jpeg' || opts.format === 'jpg') ? '.jpg' : '.png';
      const files = fs.readdirSync(tmpDir)
        .filter(f => f.startsWith(prefix) && f.endsWith(ext) && f !== `${prefix}.pdf`)
        .sort();

      const buffers = files.map(f => fs.readFileSync(path.join(tmpDir, f)));

      // Cleanup output files
      files.forEach(f => {
        try { fs.unlinkSync(path.join(tmpDir, f)); } catch (e) { /* ignore */ }
      });

      if (buffers.length === 0) {
        throw new Error('pdftoppm did not produce any output files');
      }

      return buffers;
    } finally {
      try { fs.unlinkSync(tmpInput); } catch (e) { /* ignore */ }
    }
  }

  /**
   * Fallback: extract text with pdf-parse and render a text-overlay image via sharp.
   *
   * @param {Buffer} pdfBuffer
   * @param {Object} opts
   * @returns {Promise<Buffer>}
   * @private
   */
  async _renderFallback(pdfBuffer, opts) {
    const sharp = require('sharp');
    let previewText = '[PDF Page Preview]';

    try {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(pdfBuffer, { max: opts.page || 1 });
      if (data.text && data.text.trim().length > 0) {
        previewText = data.text.trim().substring(0, 500);
      }
    } catch (e) {
      // If pdf-parse fails, keep the default text
    }

    const width = opts.width || 800;
    const height = opts.height || 1100;

    // Split text into lines for SVG rendering
    const maxLineLen = Math.floor(width / 8);
    const lines = [];
    const words = previewText.split(/\s+/);
    let currentLine = '';
    for (const word of words) {
      if ((currentLine + ' ' + word).length > maxLineLen) {
        lines.push(currentLine.trim());
        currentLine = word;
      } else {
        currentLine += ' ' + word;
      }
      if (lines.length >= 30) break;
    }
    if (currentLine.trim()) lines.push(currentLine.trim());

    const textElements = lines
      .map((line, i) => {
        const escaped = this._escapeXml(line);
        return `<text x="30" y="${60 + i * 20}" font-family="monospace" font-size="12" fill="#333">${escaped}</text>`;
      })
      .join('\n');

    const svgContent = `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#fff"/>
        <rect x="10" y="10" width="${width - 20}" height="${height - 20}" 
              fill="none" stroke="#ddd" stroke-width="1"/>
        <text x="${width / 2}" y="35" text-anchor="middle" 
              font-family="sans-serif" font-size="14" fill="#999">[PDF Render - Page ${opts.page || 1}]</text>
        ${textElements}
      </svg>
    `;

    const format = (opts.format === 'jpeg' || opts.format === 'jpg') ? 'jpeg' : 'png';
    return sharp(Buffer.from(svgContent))
      .resize(width, height)
      .toFormat(format)
      .toBuffer();
  }

  /**
   * Resize an image buffer to thumbnail dimensions.
   *
   * @param {Buffer} imageBuffer
   * @param {string} format
   * @param {number} [quality]
   * @returns {Promise<Buffer>}
   * @private
   */
  async _resizeToThumbnail(imageBuffer, format, quality) {
    const sharp = require('sharp');
    const fmt = (format === 'jpeg' || format === 'jpg') ? 'jpeg' : 'png';
    return sharp(imageBuffer)
      .resize(300, 400, { fit: 'inside' })
      .toFormat(fmt, fmt === 'jpeg' ? { quality: quality || 80 } : {})
      .toBuffer();
  }

  /**
   * Escape special XML characters for SVG text content.
   * @param {string} text
   * @returns {string}
   * @private
   */
  _escapeXml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Override input description for LLM planning context.
   * @override
   */
  _describeInput(input, metadata = {}) {
    if (Buffer.isBuffer(input)) {
      const kb = (input.length / 1024).toFixed(1);
      return `PDF buffer (${kb} KB) to be rendered as image(s). ${metadata.fileName || ''}`.trim();
    }
    return super._describeInput(input, metadata);
  }
}

module.exports = { PdfToImageAgent };
