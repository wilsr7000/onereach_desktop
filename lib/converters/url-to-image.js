/**
 * UrlToImageAgent
 *
 * @description Captures a screenshot of a URL as a PNG or JPG image using
 *   Electron's capturePage capability. Supports standard viewport capture,
 *   full-page scroll capture, and mobile viewport rendering.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/url-to-image
 *
 * @strategies
 *   - viewport  : Captures the visible viewport at standard desktop dimensions
 *   - full-page : Scrolls and captures the entire page height
 *   - mobile    : Renders at mobile viewport dimensions (375x812)
 *
 * @example
 *   const { UrlToImageAgent } = require('./url-to-image');
 *   const agent = new UrlToImageAgent();
 *   const result = await agent.convert('https://example.com');
 *   // result.output => <Buffer 89 50 4e 47 ...> (PNG data)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class UrlToImageAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   * @param {Object} [config.BrowserWindow] - Electron BrowserWindow class (for injection)
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:url-to-image';
    this.name = 'URL to Image';
    this.description = 'Captures a URL screenshot as PNG/JPG with viewport, full-page, or mobile modes';
    this.from = ['url'];
    this.to = ['png', 'jpg'];
    this.modes = ['symbolic'];

    this._BrowserWindow = config.BrowserWindow || null;

    this.strategies = [
      {
        id: 'viewport',
        description: 'Captures the visible viewport at standard desktop dimensions (1280x900)',
        when: 'Above-the-fold screenshot of a page at desktop resolution',
        engine: 'electron-capturePage',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Viewport-accurate desktop screenshot',
      },
      {
        id: 'full-page',
        description: 'Scrolls the page and captures the entire content height',
        when: 'Full-length screenshot including all below-the-fold content',
        engine: 'electron-capturePage',
        mode: 'symbolic',
        speed: 'slow',
        quality: 'Complete page capture, may produce very tall images',
      },
      {
        id: 'mobile',
        description: 'Renders at mobile viewport dimensions (375x812, iPhone-style)',
        when: 'Mobile-responsive screenshot is needed',
        engine: 'electron-capturePage',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Mobile-viewport screenshot for responsive testing',
      },
    ];
  }

  /**
   * Execute the URL-to-image conversion.
   *
   * @param {string} input - URL to capture
   * @param {string} strategy - Strategy ID: 'viewport' | 'full-page' | 'mobile'
   * @param {Object} [options] - Additional conversion options
   * @param {string} [options.format] - Image format: 'png' | 'jpeg' (default: 'png')
   * @param {number} [options.quality] - JPEG quality 0-100 (default: 85)
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const start = Date.now();
    const url = input.trim();
    const format = options.format || 'png';
    const quality = options.quality || 85;

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      throw new Error(`Invalid URL: must start with http:// or https://`);
    }

    // Try to get Electron BrowserWindow
    const BrowserWindow = this._BrowserWindow || this._getElectronBrowserWindow();
    if (!BrowserWindow) {
      throw new Error(
        'Electron BrowserWindow is not available. URL-to-image conversion requires ' +
          'Electron to render and capture pages. Run this converter within the Electron main process.'
      );
    }

    let output;
    let dimensions;

    switch (strategy) {
      case 'viewport': {
        const result = await this._captureViewport(BrowserWindow, url, {
          width: 1280,
          height: 900,
          format,
          quality,
        });
        output = result.buffer;
        dimensions = result.dimensions;
        break;
      }

      case 'full-page': {
        const result = await this._captureFullPage(BrowserWindow, url, {
          width: 1280,
          format,
          quality,
        });
        output = result.buffer;
        dimensions = result.dimensions;
        break;
      }

      case 'mobile': {
        const result = await this._captureViewport(BrowserWindow, url, {
          width: 375,
          height: 812,
          deviceScaleFactor: 2,
          format,
          quality,
        });
        output = result.buffer;
        dimensions = result.dimensions;
        break;
      }

      default:
        throw new Error(`Unknown strategy: ${strategy}`);
    }

    return {
      output,
      metadata: {
        strategy,
        url,
        format,
        imageSizeBytes: output.length,
        dimensions,
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  /**
   * Capture a viewport-sized screenshot.
   *
   * @param {Function} BrowserWindow - Electron BrowserWindow class
   * @param {string} url - URL to capture
   * @param {Object} opts - Capture options
   * @returns {Promise<{buffer: Buffer, dimensions: {width: number, height: number}}>}
   * @private
   */
  async _captureViewport(BrowserWindow, url, opts) {
    const win = new BrowserWindow({
      show: false,
      width: opts.width,
      height: opts.height,
      webPreferences: {
        offscreen: true,
        javascript: true,
        deviceScaleFactor: opts.deviceScaleFactor || 1,
      },
    });

    try {
      await win.loadURL(url);

      // Wait for page to settle
      await new Promise((resolve) => {
        setTimeout(resolve, 2000);
      });

      const image = await win.webContents.capturePage();
      const buffer = opts.format === 'jpeg' ? image.toJPEG(opts.quality || 85) : image.toPNG();

      const size = image.getSize();

      return {
        buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
        dimensions: { width: size.width, height: size.height },
      };
    } finally {
      win.destroy();
    }
  }

  /**
   * Capture a full-page screenshot by scrolling to get the full content height.
   *
   * @param {Function} BrowserWindow - Electron BrowserWindow class
   * @param {string} url - URL to capture
   * @param {Object} opts - Capture options
   * @returns {Promise<{buffer: Buffer, dimensions: {width: number, height: number}}>}
   * @private
   */
  async _captureFullPage(BrowserWindow, url, opts) {
    const win = new BrowserWindow({
      show: false,
      width: opts.width,
      height: 900,
      webPreferences: {
        offscreen: true,
        javascript: true,
      },
    });

    try {
      await win.loadURL(url);

      // Wait for initial page load
      await new Promise((resolve) => {
        setTimeout(resolve, 2000);
      });

      // Get the full page height
      const fullHeight = await win.webContents.executeJavaScript(
        'Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)'
      );

      // Resize window to full page height
      const cappedHeight = Math.min(fullHeight, 16384); // Cap at 16k px
      win.setSize(opts.width, cappedHeight);

      // Wait for resize to take effect
      await new Promise((resolve) => {
        setTimeout(resolve, 1000);
      });

      const image = await win.webContents.capturePage();
      const buffer = opts.format === 'jpeg' ? image.toJPEG(opts.quality || 85) : image.toPNG();

      const size = image.getSize();

      return {
        buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
        dimensions: { width: size.width, height: size.height },
      };
    } finally {
      win.destroy();
    }
  }

  /**
   * Attempt to get Electron's BrowserWindow from the main process.
   *
   * @returns {Function|null} BrowserWindow class or null
   * @private
   */
  _getElectronBrowserWindow() {
    try {
      const { BrowserWindow } = require('electron');
      return BrowserWindow;
    } catch (_e) {
      return null;
    }
  }

  /**
   * Structural checks for URL-to-image conversion output.
   *
   * Validates that the output is a non-empty Buffer containing image data.
   *
   * @param {string} input - Original URL input
   * @param {*} output - Conversion output to validate
   * @param {string} strategy - Strategy that was used
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, _strategy) {
    const issues = [];

    if (!Buffer.isBuffer(output)) {
      issues.push({
        code: 'OUTPUT_NOT_BUFFER',
        severity: 'error',
        message: `Expected Buffer output, got ${typeof output}`,
        fixable: true,
      });
      return issues;
    }

    if (output.length === 0) {
      issues.push({
        code: 'OUTPUT_EMPTY',
        severity: 'error',
        message: 'Image buffer is empty',
        fixable: true,
      });
      return issues;
    }

    // Check for PNG magic bytes: 89 50 4E 47 (0x89 P N G)
    const isPng = output[0] === 0x89 && output[1] === 0x50 && output[2] === 0x4e && output[3] === 0x47;
    // Check for JPEG magic bytes: FF D8 FF
    const isJpeg = output[0] === 0xff && output[1] === 0xd8 && output[2] === 0xff;

    if (!isPng && !isJpeg) {
      issues.push({
        code: 'INVALID_IMAGE_HEADER',
        severity: 'error',
        message: 'Output does not have valid PNG or JPEG magic bytes',
        fixable: true,
      });
    }

    // Warn if suspiciously small
    if (output.length < 1000) {
      issues.push({
        code: 'IMAGE_TOO_SMALL',
        severity: 'warning',
        message: `Image is only ${output.length} bytes, which may indicate an error or blank page`,
        fixable: true,
      });
    }

    return issues;
  }
}

module.exports = { UrlToImageAgent };
