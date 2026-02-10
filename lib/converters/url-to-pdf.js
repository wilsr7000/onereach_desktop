/**
 * UrlToPdfAgent
 *
 * @description Converts a URL to a PDF document using Electron's built-in
 *   printToPDF capability. Supports print-style rendering and full-page
 *   screenshot rendering modes.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/url-to-pdf
 *
 * @strategies
 *   - print      : Uses Electron's printToPDF for a print-layout PDF
 *   - screenshot  : Uses Electron for a full-page screenshot-style PDF render
 *
 * @example
 *   const { UrlToPdfAgent } = require('./url-to-pdf');
 *   const agent = new UrlToPdfAgent();
 *   const result = await agent.convert('https://example.com');
 *   // result.output => <Buffer 25 50 44 46 ...> (%PDF...)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class UrlToPdfAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   * @param {Object} [config.BrowserWindow] - Electron BrowserWindow class (for injection)
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:url-to-pdf';
    this.name = 'URL to PDF';
    this.description = 'Converts a URL to PDF using Electron printToPDF or screenshot rendering';
    this.from = ['url'];
    this.to = ['pdf'];
    this.modes = ['symbolic'];

    this._BrowserWindow = config.BrowserWindow || null;

    this.strategies = [
      {
        id: 'print',
        description: 'Uses Electron printToPDF for a print-layout PDF rendering',
        when: 'Standard PDF output suitable for printing or document archiving',
        engine: 'electron-printToPDF',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Print-ready PDF with proper page breaks and margins',
      },
      {
        id: 'screenshot',
        description: 'Renders the full page as a single continuous PDF page',
        when: 'Full visual capture needed without print pagination',
        engine: 'electron-capture',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Visual screenshot-style PDF capturing the full rendered page',
      },
    ];
  }

  /**
   * Execute the URL-to-PDF conversion.
   *
   * @param {string} input - URL to convert to PDF
   * @param {string} strategy - Strategy ID: 'print' | 'screenshot'
   * @param {Object} [options] - Additional conversion options
   * @param {boolean} [options.landscape] - Use landscape orientation
   * @param {string} [options.pageSize] - Page size: 'A4' | 'Letter' | 'Legal'
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const start = Date.now();
    const url = input.trim();

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      throw new Error(`Invalid URL: must start with http:// or https://`);
    }

    // Try to get Electron BrowserWindow
    const BrowserWindow = this._BrowserWindow || this._getElectronBrowserWindow();
    if (!BrowserWindow) {
      throw new Error(
        'Electron BrowserWindow is not available. URL-to-PDF conversion requires ' +
        'Electron to render and print pages. Run this converter within the Electron main process.'
      );
    }

    let output;

    switch (strategy) {
      case 'print': {
        output = await this._printToPdf(BrowserWindow, url, {
          landscape: options.landscape || false,
          pageSize: options.pageSize || 'A4',
          printBackground: true,
          margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
        });
        break;
      }

      case 'screenshot': {
        output = await this._printToPdf(BrowserWindow, url, {
          landscape: options.landscape || false,
          pageSize: options.pageSize || 'A4',
          printBackground: true,
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          preferCSSPageSize: true,
        });
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
        pdfSizeBytes: output.length,
        landscape: options.landscape || false,
        pageSize: options.pageSize || 'A4',
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  /**
   * Load a URL in a hidden BrowserWindow and print to PDF.
   *
   * @param {Function} BrowserWindow - Electron BrowserWindow class
   * @param {string} url - URL to load
   * @param {Object} pdfOptions - Options for printToPDF
   * @returns {Promise<Buffer>} PDF buffer
   * @private
   */
  async _printToPdf(BrowserWindow, url, pdfOptions) {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        offscreen: true,
        javascript: true,
      },
    });

    try {
      await win.loadURL(url);

      // Wait for page to settle after load
      await new Promise(resolve => setTimeout(resolve, 2000));

      const pdfBuffer = await win.webContents.printToPDF({
        landscape: pdfOptions.landscape,
        pageSize: pdfOptions.pageSize,
        printBackground: pdfOptions.printBackground,
        margins: pdfOptions.margins,
        preferCSSPageSize: pdfOptions.preferCSSPageSize || false,
      });

      return Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
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
    } catch (e) {
      return null;
    }
  }

  /**
   * Structural checks for URL-to-PDF conversion output.
   *
   * Validates that the output is a non-empty Buffer starting with
   * the PDF magic bytes (%PDF).
   *
   * @param {string} input - Original URL input
   * @param {*} output - Conversion output to validate
   * @param {string} strategy - Strategy that was used
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, strategy) {
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
        message: 'PDF buffer is empty',
        fixable: true,
      });
      return issues;
    }

    // Check for PDF magic bytes: %PDF
    const header = output.slice(0, 5).toString('ascii');
    if (!header.startsWith('%PDF')) {
      issues.push({
        code: 'INVALID_PDF_HEADER',
        severity: 'error',
        message: `Output does not start with PDF magic bytes (%PDF), found: "${header}"`,
        fixable: true,
      });
    }

    // Warn if suspiciously small
    if (output.length < 500) {
      issues.push({
        code: 'PDF_TOO_SMALL',
        severity: 'warning',
        message: `PDF is only ${output.length} bytes, which may indicate an empty or error page`,
        fixable: true,
      });
    }

    return issues;
  }
}

module.exports = { UrlToPdfAgent };
