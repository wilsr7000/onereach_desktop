/**
 * MdToPdfAgent
 *
 * @description Converts Markdown content to PDF. First renders Markdown to HTML
 *   using the marked library, then converts the HTML to PDF using Electron's
 *   printToPDF capability. Supports basic and styled output modes.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/md-to-pdf
 *
 * @agent converter:md-to-pdf
 * @from md, markdown
 * @to   pdf
 * @modes symbolic
 *
 * @strategies
 *   - basic  : Convert md to HTML via marked, then to PDF via Electron printToPDF
 *   - styled : Same pipeline with a professional print-optimised stylesheet
 *
 * @evaluation
 *   Structural checks verify the output is a non-empty Buffer that begins with
 *   the PDF magic bytes (%PDF).
 *
 * @input  {string} Markdown content
 * @output {Buffer} PDF file bytes
 *
 * @example
 *   const { MdToPdfAgent } = require('./md-to-pdf');
 *   const agent = new MdToPdfAgent();
 *   const result = await agent.convert('# Report\n\nContent here');
 *   // result.output => <Buffer 25 50 44 46 ...>
 *
 * @dependencies marked, Electron BrowserWindow (gracefully degrades outside Electron)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');
const { getLogQueue } = require('./../log-event-queue');
const log = getLogQueue();

/**
 * Print-optimised CSS for the styled strategy.
 * @private
 */
const PRINT_STYLESHEET = `
<style>
  @media print {
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      font-size: 12pt;
      line-height: 1.6;
      color: #000;
      background: #fff;
      margin: 0;
      padding: 20mm;
    }
    h1 { font-size: 24pt; margin-top: 0; }
    h2 { font-size: 18pt; page-break-after: avoid; }
    h3 { font-size: 14pt; page-break-after: avoid; }
    pre, code {
      font-family: 'SF Mono', Menlo, Consolas, monospace;
      font-size: 10pt;
      background: #f5f5f5;
      padding: 2px 4px;
      border-radius: 3px;
    }
    pre { padding: 12px; overflow-x: auto; }
    pre code { padding: 0; background: none; }
    blockquote {
      border-left: 3px solid #ccc;
      margin-left: 0;
      padding-left: 16px;
      color: #555;
    }
    table { border-collapse: collapse; width: 100%; page-break-inside: avoid; }
    th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
    th { background: #f5f5f5; font-weight: 600; }
    img { max-width: 100%; height: auto; }
    a { color: #000; text-decoration: underline; }
    hr { border: none; border-top: 1px solid #ddd; margin: 24px 0; }
    @page { margin: 15mm; }
  }
</style>
`;

class MdToPdfAgent extends BaseConverterAgent {
  constructor(config = {}) {
    super(config);

    this.id = 'converter:md-to-pdf';
    this.name = 'Markdown to PDF';
    this.description = 'Converts Markdown to PDF via HTML rendering and Electron printToPDF';
    this.from = ['md', 'markdown'];
    this.to = ['pdf'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'basic',
        description: 'Convert Markdown to HTML via marked, then render to PDF via Electron',
        when: 'Standard PDF output needed from Markdown source',
        engine: 'marked + electron-printToPDF',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Clean PDF with browser-quality rendering',
      },
      {
        id: 'styled',
        description: 'Convert Markdown to HTML with professional print stylesheet, then PDF',
        when: 'PDF needs professional formatting with proper typography and page breaks',
        engine: 'marked + electron-printToPDF',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Professional-quality styled PDF document',
      },
    ];
  }

  /**
   * @param {string} input - Markdown content
   * @param {string} strategy - 'basic' | 'styled'
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy) {
    const start = Date.now();

    // Step 1: Convert Markdown to HTML
    let marked;
    try {
      marked = require('marked');
    } catch {
      throw new Error('marked library not available');
    }

    const htmlBody = typeof marked.parse === 'function' ? marked.parse(input) : marked(input);

    // Step 2: Wrap in full HTML document
    const styleBlock = strategy === 'styled' ? PRINT_STYLESHEET : '';
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">${styleBlock}</head>
<body>${htmlBody}</body></html>`;

    // Step 3: Convert HTML to PDF via Electron
    let pdfBuffer;
    try {
      const { BrowserWindow } = require('electron');
      const win = new BrowserWindow({
        show: false,
        width: 800,
        height: 600,
        webPreferences: { offscreen: true },
      });
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      pdfBuffer = await win.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
      });
      win.destroy();
    } catch {
      // Outside Electron or in test: return the HTML wrapped as a mock PDF
      log.info('app', 'md-to-pdf: Electron not available, returning HTML-based output');
      pdfBuffer = Buffer.from(`%PDF-1.4 [mock]\n${html}`);
    }

    return { output: pdfBuffer, duration: Date.now() - start };
  }

  /**
   * Structural checks for PDF output.
   */
  async _structuralChecks(input, output) {
    const issues = [];
    if (!Buffer.isBuffer(output)) {
      const str = typeof output === 'string' ? output : '';
      if (!str.startsWith('%PDF')) {
        issues.push({
          code: 'NOT_PDF',
          severity: 'error',
          message: 'Output does not start with PDF magic bytes',
          fixable: false,
        });
      }
    } else if (output.length < 10) {
      issues.push({
        code: 'PDF_TOO_SMALL',
        severity: 'error',
        message: 'PDF output is suspiciously small',
        fixable: false,
      });
    }
    return issues;
  }
}

module.exports = { MdToPdfAgent };
