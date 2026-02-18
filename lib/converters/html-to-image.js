/**
 * HtmlToImageAgent
 *
 * @description Converts HTML content to raster images (PNG/JPG). Uses Electron's
 *   capturePage API for high-fidelity browser rendering when available, with a
 *   sharp-based placeholder fallback for non-Electron environments.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/html-to-image
 *
 * @agent converter:html-to-image
 * @from html
 * @to   png, jpg
 * @modes symbolic
 *
 * @strategies
 *   - viewport  : Capture the visible viewport region at standard dimensions
 *   - full-page : Capture the full scrollable page height
 *
 * @evaluation
 *   Structural checks verify the output is a non-empty Buffer. Additional
 *   checks validate minimum image size to detect blank captures.
 *
 * @input  {string} HTML content
 * @output {Buffer} PNG or JPG image bytes
 *
 * @example
 *   const { HtmlToImageAgent } = require('./html-to-image');
 *   const agent = new HtmlToImageAgent();
 *   const result = await agent.convert('<h1>Hello</h1><p>World</p>');
 *   // result.output => <Buffer 89 50 4E 47 ...>
 *
 * @dependencies Electron (BrowserWindow, capturePage), sharp (fallback)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class HtmlToImageAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:html-to-image';
    this.name = 'HTML to Image';
    this.description = 'Converts HTML content to PNG/JPG using Electron capturePage or sharp fallback';
    this.from = ['html'];
    this.to = ['png', 'jpg'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'viewport',
        description: 'Capture the visible viewport at standard dimensions (1280x800)',
        when: 'A screenshot of the above-the-fold content is sufficient',
        engine: 'electron-capturePage',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Browser-quality rendering of the viewport region',
      },
      {
        id: 'full-page',
        description: 'Capture the full scrollable page by expanding the window height',
        when: 'The entire page content must be captured including below-the-fold sections',
        engine: 'electron-capturePage',
        mode: 'symbolic',
        speed: 'slow',
        quality: 'Complete full-page capture, may produce tall images',
      },
    ];
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Execute the HTML-to-image conversion.
   *
   * @param {string} input - HTML content to render
   * @param {string} strategy - Strategy ID: 'viewport' | 'full-page'
   * @param {Object} [options] - Additional conversion options
   * @param {number} [options.width] - Viewport width in pixels (default 1280)
   * @param {number} [options.height] - Viewport height in pixels (default 800)
   * @param {string} [options.format] - Output format: 'png' | 'jpeg' (default 'png')
   * @param {number} [options.quality] - JPEG quality 0-100 (default 90)
   * @param {number} [options.deviceScaleFactor] - Device pixel ratio (default 2)
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const start = Date.now();
    const html = typeof input === 'string' ? input : String(input);
    const width = options.width || 1280;
    const height = options.height || 800;
    const format = options.format || 'png';

    let imageBuffer;

    // Try Electron-based capture first
    try {
      imageBuffer = await this._captureWithElectron(html, strategy, {
        width,
        height,
        format,
        quality: options.quality || 90,
        deviceScaleFactor: options.deviceScaleFactor || 2,
      });
    } catch (electronErr) {
      // Electron not available; try sharp placeholder fallback
      try {
        imageBuffer = await this._createPlaceholder(html, { width, height, format });
      } catch (sharpErr) {
        throw new Error(
          `HTML-to-image conversion failed. ` +
            `Electron error: ${electronErr.message}. ` +
            `Sharp fallback error: ${sharpErr.message}. ` +
            `Ensure either Electron (main process) or sharp is available.`
        );
      }
    }

    return {
      output: imageBuffer,
      metadata: {
        strategy,
        format,
        width,
        height,
        outputSize: imageBuffer.length,
        usedElectron: !imageBuffer._placeholder,
        inputLength: input.length,
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
   * @param {string} input - Original HTML input
   * @param {*} output - Conversion output to validate
   * @param {string} strategy - Strategy that was used
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, _strategy) {
    const issues = [];

    // Must be a Buffer
    if (!Buffer.isBuffer(output)) {
      issues.push({
        code: 'OUTPUT_NOT_BUFFER',
        severity: 'error',
        message: `Expected Buffer output, got ${typeof output}`,
        fixable: false,
      });
      return issues;
    }

    // Must be non-empty
    if (output.length === 0) {
      issues.push({
        code: 'OUTPUT_EMPTY_BUFFER',
        severity: 'error',
        message: 'Image output buffer is empty',
        fixable: true,
      });
      return issues;
    }

    // Check for valid image signatures (PNG or JPEG)
    const isPng = output[0] === 0x89 && output[1] === 0x50 && output[2] === 0x4e && output[3] === 0x47;
    const isJpeg = output[0] === 0xff && output[1] === 0xd8;
    if (!isPng && !isJpeg) {
      issues.push({
        code: 'INVALID_IMAGE_FORMAT',
        severity: 'warning',
        message: 'Output does not begin with PNG or JPEG magic bytes',
        fixable: true,
      });
    }

    // Warn if suspiciously small
    if (output.length < 1000) {
      issues.push({
        code: 'IMAGE_TOO_SMALL',
        severity: 'warning',
        message: `Image is only ${output.length} bytes, which may indicate a blank capture`,
        fixable: true,
      });
    }

    return issues;
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  /**
   * Capture HTML as an image using Electron's off-screen BrowserWindow.
   *
   * @param {string} html - HTML content
   * @param {string} strategy - 'viewport' or 'full-page'
   * @param {Object} opts - Rendering options
   * @returns {Promise<Buffer>}
   * @private
   */
  async _captureWithElectron(html, strategy, opts) {
    let BrowserWindow;
    try {
      const electron = require('electron');
      BrowserWindow = electron.BrowserWindow;
    } catch (_err) {
      throw new Error('Electron is not available in this environment');
    }

    if (!BrowserWindow) {
      throw new Error('BrowserWindow is not available');
    }

    const win = new BrowserWindow({
      show: false,
      width: opts.width,
      height: opts.height,
      webPreferences: {
        offscreen: true,
        nodeIntegration: false,
        contextIsolation: true,
        deviceScaleFactor: opts.deviceScaleFactor || 2,
      },
    });

    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

      // Wait for rendering to complete
      await new Promise((resolve) => {
        setTimeout(resolve, 800);
      });

      if (strategy === 'full-page') {
        // Expand window to full scrollable height
        const scrollHeight = await win.webContents.executeJavaScript('document.documentElement.scrollHeight');
        win.setSize(opts.width, Math.min(scrollHeight, 16384));
        await new Promise((resolve) => {
          setTimeout(resolve, 300);
        });
      }

      const nativeImage = await win.webContents.capturePage();

      if (opts.format === 'jpeg' || opts.format === 'jpg') {
        return nativeImage.toJPEG(opts.quality || 90);
      }
      return nativeImage.toPNG();
    } finally {
      win.destroy();
    }
  }

  /**
   * Create a placeholder image using sharp when Electron is not available.
   * Renders a simple text representation of the HTML content.
   *
   * @param {string} html - HTML content (used for text overlay)
   * @param {Object} opts - Image options
   * @returns {Promise<Buffer>}
   * @private
   */
  async _createPlaceholder(html, opts) {
    const sharp = require('sharp');

    // Extract a preview text from the HTML
    const previewText = html
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 200);

    const svgContent = `
      <svg width="${opts.width}" height="${opts.height}" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#f5f5f5"/>
        <text x="50%" y="40%" text-anchor="middle" font-family="sans-serif"
              font-size="18" fill="#666">[HTML Render Placeholder]</text>
        <text x="50%" y="55%" text-anchor="middle" font-family="sans-serif"
              font-size="12" fill="#999">${this._escapeXml(previewText.substring(0, 80))}</text>
      </svg>
    `;

    const buffer = await sharp(Buffer.from(svgContent))
      .resize(opts.width, opts.height)
      .toFormat(opts.format === 'jpg' || opts.format === 'jpeg' ? 'jpeg' : 'png')
      .toBuffer();

    // Mark as placeholder for metadata
    buffer._placeholder = true;
    return buffer;
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
    if (typeof input === 'string') {
      const hasImages = /<img\b/i.test(input);
      const hasTables = /<table\b/i.test(input);
      const features = [hasImages && 'images', hasTables && 'tables'].filter(Boolean).join(', ');
      return `HTML content (${input.length} chars)${features ? `, contains ${features}` : ''}. ${metadata.fileName || ''}`.trim();
    }
    return super._describeInput(input, metadata);
  }
}

module.exports = { HtmlToImageAgent };
