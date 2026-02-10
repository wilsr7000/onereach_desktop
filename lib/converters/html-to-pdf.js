/**
 * HtmlToPdfAgent
 *
 * @description Converts HTML content to PDF. Primarily uses Electron's built-in
 *   printToPDF capability when running inside the Electron main process.
 *   Supports standard conversion and styled conversion that injects a print
 *   stylesheet before rendering.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/html-to-pdf
 *
 * @agent converter:html-to-pdf
 * @from html
 * @to   pdf
 * @modes symbolic
 *
 * @strategies
 *   - electron : Use Electron BrowserWindow.webContents.printToPDF for native rendering
 *   - styled   : Inject a print-optimised CSS stylesheet before rendering to PDF
 *
 * @evaluation
 *   Structural checks verify the output is a non-empty Buffer that begins with
 *   the PDF magic bytes (%PDF).
 *
 * @input  {string} HTML content
 * @output {Buffer} PDF file bytes
 *
 * @example
 *   const { HtmlToPdfAgent } = require('./html-to-pdf');
 *   const agent = new HtmlToPdfAgent();
 *   const result = await agent.convert('<h1>Report</h1><p>Content here</p>');
 *   // result.output => <Buffer 25 50 44 46 ...>
 *
 * @dependencies Electron (BrowserWindow) - gracefully degrades outside Electron
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

/**
 * Print-optimised CSS injected by the 'styled' strategy.
 * @private
 */
const PRINT_STYLESHEET = `
<style>
  @media print {
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      font-size: 12pt;
      line-height: 1.5;
      color: #000;
      background: #fff;
      margin: 0;
      padding: 20mm;
    }
    nav, footer, header, aside, .no-print { display: none !important; }
    a { color: #000; text-decoration: underline; }
    img { max-width: 100%; height: auto; }
    h1, h2, h3, h4, h5, h6 { page-break-after: avoid; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
    pre, code { font-size: 10pt; background: #f4f4f4; padding: 4px; }
    @page { margin: 15mm; }
  }
</style>
`;

class HtmlToPdfAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:html-to-pdf';
    this.name = 'HTML to PDF';
    this.description = 'Converts HTML content to PDF using Electron printToPDF or styled rendering';
    this.from = ['html'];
    this.to = ['pdf'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'electron',
        description: 'Render HTML in an off-screen Electron BrowserWindow and print to PDF',
        when: 'Running inside Electron and a faithful PDF rendering of the HTML is needed',
        engine: 'electron-printToPDF',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'High-fidelity browser-quality PDF rendering',
      },
      {
        id: 'styled',
        description: 'Inject print-optimised CSS before rendering to PDF via Electron',
        when: 'The HTML lacks print styles and the PDF should be clean and readable',
        engine: 'electron-printToPDF',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Clean print-optimised output with consistent typography',
      },
    ];
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Execute the HTML-to-PDF conversion.
   *
   * @param {string} input - HTML content to convert
   * @param {string} strategy - Strategy ID: 'electron' | 'styled'
   * @param {Object} [options] - Additional conversion options
   * @param {boolean} [options.landscape] - Landscape orientation
   * @param {Object} [options.margins] - Page margins {top, bottom, left, right} in inches
   * @param {string} [options.pageSize] - Paper size: 'A4' | 'Letter' | 'Legal'
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const start = Date.now();
    let html = typeof input === 'string' ? input : String(input);

    // For 'styled' strategy, inject the print stylesheet
    if (strategy === 'styled') {
      if (html.includes('</head>')) {
        html = html.replace('</head>', PRINT_STYLESHEET + '</head>');
      } else if (html.includes('<body')) {
        html = html.replace('<body', PRINT_STYLESHEET + '<body');
      } else {
        html = PRINT_STYLESHEET + html;
      }
    }

    // Attempt Electron rendering
    let pdfBuffer;
    try {
      pdfBuffer = await this._renderWithElectron(html, options);
    } catch (err) {
      // Electron not available or rendering failed
      const message = `PDF rendering unavailable: ${err.message}. ` +
        'Electron BrowserWindow is required for HTML-to-PDF conversion. ' +
        'Ensure this agent is invoked from the Electron main process.';
      throw new Error(message);
    }

    return {
      output: pdfBuffer,
      metadata: {
        strategy,
        inputLength: input.length,
        outputSize: pdfBuffer.length,
        styled: strategy === 'styled',
        pageSize: options.pageSize || 'A4',
        landscape: !!options.landscape,
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  // ===========================================================================
  // STRUCTURAL CHECKS
  // ===========================================================================

  /**
   * Verify the PDF output meets conversion expectations.
   *
   * @param {string} input - Original HTML input
   * @param {*} output - Conversion output to validate
   * @param {string} strategy - Strategy that was used
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, strategy) {
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
        message: 'PDF output buffer is empty',
        fixable: true,
      });
      return issues;
    }

    // Check PDF magic bytes (%PDF)
    const header = output.slice(0, 5).toString('ascii');
    if (!header.startsWith('%PDF')) {
      issues.push({
        code: 'INVALID_PDF_HEADER',
        severity: 'error',
        message: `Output does not start with PDF magic bytes. Got: "${header}"`,
        fixable: true,
      });
    }

    // Warn if suspiciously small (likely a blank page)
    if (output.length < 500) {
      issues.push({
        code: 'PDF_TOO_SMALL',
        severity: 'warning',
        message: `PDF is only ${output.length} bytes, which may indicate a blank page`,
        fixable: true,
      });
    }

    return issues;
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  /**
   * Render HTML to PDF using an off-screen Electron BrowserWindow.
   *
   * @param {string} html - Complete HTML content
   * @param {Object} options - Rendering options
   * @returns {Promise<Buffer>} PDF buffer
   * @private
   */
  async _renderWithElectron(html, options = {}) {
    let BrowserWindow;
    try {
      const electron = require('electron');
      BrowserWindow = electron.BrowserWindow;
    } catch (err) {
      throw new Error('Electron is not available in this environment');
    }

    if (!BrowserWindow) {
      throw new Error('BrowserWindow is not available');
    }

    const win = new BrowserWindow({
      show: false,
      width: 1024,
      height: 768,
      webPreferences: {
        offscreen: true,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

      // Wait for content to settle
      await new Promise(resolve => setTimeout(resolve, 500));

      const pdfOptions = {
        marginsType: 0,
        pageSize: options.pageSize || 'A4',
        printBackground: true,
        landscape: !!options.landscape,
      };

      if (options.margins) {
        pdfOptions.margins = {
          top: options.margins.top || 0.4,
          bottom: options.margins.bottom || 0.4,
          left: options.margins.left || 0.4,
          right: options.margins.right || 0.4,
        };
      }

      const pdfBuffer = await win.webContents.printToPDF(pdfOptions);
      return pdfBuffer;
    } finally {
      win.destroy();
    }
  }

  /**
   * Override input description for LLM planning context.
   * @override
   */
  _describeInput(input, metadata = {}) {
    if (typeof input === 'string') {
      const hasHead = /<head[\s\S]*?>/i.test(input);
      const hasBody = /<body[\s\S]*?>/i.test(input);
      const type = hasHead && hasBody ? 'Full HTML document' : 'HTML fragment';
      return `${type}, ${input.length} characters. ${metadata.fileName || ''}`.trim();
    }
    return super._describeInput(input, metadata);
  }
}

module.exports = { HtmlToPdfAgent };
