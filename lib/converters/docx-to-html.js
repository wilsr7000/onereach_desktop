/**
 * DocxToHtmlAgent
 *
 * @description Converts DOCX (Word) files to HTML using the `mammoth` library.
 *   Supports standard conversion, style-preserving conversion that retains
 *   more of the original document formatting, and a clean mode that produces
 *   minimal semantic HTML.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/docx-to-html
 *
 * @strategies
 *   - mammoth : Standard mammoth.convertToHtml() with default mapping
 *   - styled  : Preserves more styling (colors, alignment) via custom style map
 *   - clean   : Produces minimal semantic HTML, stripping non-essential tags
 *
 * @example
 *   const { DocxToHtmlAgent } = require('./docx-to-html');
 *   const agent = new DocxToHtmlAgent();
 *   const result = await agent.convert(docxBuffer);
 *   // result.output => '<h1>Title</h1><p>Content here...</p>'
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class DocxToHtmlAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:docx-to-html';
    this.name = 'DOCX to HTML';
    this.description = 'Converts DOCX (Word) files to HTML using mammoth';
    this.from = ['docx'];
    this.to = ['html'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'mammoth',
        description: 'Standard mammoth.convertToHtml() with default style mapping',
        when: 'Standard conversion for well-formed Word documents',
        engine: 'mammoth',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Good HTML output with standard semantic elements',
      },
      {
        id: 'styled',
        description: 'Preserves more styling via a custom mammoth style map',
        when: 'Document has important formatting (colors, alignment, custom styles) to retain',
        engine: 'mammoth',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Higher fidelity to original document styling',
      },
      {
        id: 'clean',
        description: 'Produces minimal semantic HTML, stripping non-essential elements',
        when: 'Need clean HTML without extra wrapper divs, spans, or style attributes',
        engine: 'mammoth',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Cleanest HTML output, best for further processing',
      },
    ];
  }

  /**
   * Execute the DOCX-to-HTML conversion.
   *
   * @param {Buffer} input - DOCX file buffer to convert
   * @param {string} strategy - Strategy ID: 'mammoth' | 'styled' | 'clean'
   * @param {Object} [options] - Additional conversion options
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const start = Date.now();
    const mammoth = require('mammoth');
    let output;

    switch (strategy) {
      case 'styled': {
        output = await this._executeStyled(input, mammoth);
        break;
      }
      case 'clean': {
        output = await this._executeClean(input, mammoth);
        break;
      }
      case 'mammoth':
      default: {
        const result = await mammoth.convertToHtml({ buffer: input });
        output = result.value;
        break;
      }
    }

    return {
      output,
      metadata: {
        strategy,
        inputLength: input.length,
        outputLength: output.length,
        mimeType: 'text/html',
        extension: 'html',
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  /**
   * Styled: use a custom style map to preserve more formatting.
   * @private
   */
  async _executeStyled(input, mammoth) {
    const styleMap = [
      "p[style-name='Title'] => h1.doc-title:fresh",
      "p[style-name='Subtitle'] => h2.doc-subtitle:fresh",
      "p[style-name='Heading 1'] => h1:fresh",
      "p[style-name='Heading 2'] => h2:fresh",
      "p[style-name='Heading 3'] => h3:fresh",
      "p[style-name='Heading 4'] => h4:fresh",
      "r[style-name='Strong'] => strong",
      "r[style-name='Emphasis'] => em",
      "p[style-name='Quote'] => blockquote > p:fresh",
      "p[style-name='Intense Quote'] => blockquote.intense > p:fresh",
      "p[style-name='List Paragraph'] => li:fresh",
    ];

    const result = await mammoth.convertToHtml({
      buffer: input,
      styleMap: styleMap,
    });

    return result.value;
  }

  /**
   * Clean: produce minimal semantic HTML by stripping unnecessary elements.
   * @private
   */
  async _executeClean(input, mammoth) {
    const result = await mammoth.convertToHtml({ buffer: input });
    let html = result.value;

    // Remove empty paragraphs
    html = html.replace(/<p>\s*<\/p>/g, '');

    // Remove empty spans
    html = html.replace(/<span>\s*<\/span>/g, '');

    // Remove style attributes
    html = html.replace(/\s+style="[^"]*"/g, '');

    // Remove class attributes
    html = html.replace(/\s+class="[^"]*"/g, '');

    // Collapse multiple blank lines in source
    html = html.replace(/\n{3,}/g, '\n\n');

    // Remove unnecessary wrapper elements
    html = html.replace(/<div>\s*([\s\S]*?)\s*<\/div>/g, '$1');

    return html.trim();
  }

  /**
   * Structural checks for DOCX-to-HTML conversion output.
   *
   * Validates that the output is a non-empty string containing HTML tags.
   *
   * @param {Buffer} input - Original DOCX buffer
   * @param {*} output - Conversion output to validate
   * @param {string} strategy - Strategy that was used
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, strategy) {
    const issues = [];

    if (typeof output !== 'string') {
      issues.push({
        code: 'OUTPUT_NOT_STRING',
        severity: 'error',
        message: `Expected string output, got ${typeof output}`,
        fixable: true,
      });
      return issues;
    }

    if (output.trim().length === 0) {
      issues.push({
        code: 'OUTPUT_EMPTY',
        severity: 'error',
        message: 'HTML output is empty',
        fixable: true,
      });
      return issues;
    }

    // Check that output contains at least one HTML tag
    const htmlTagPattern = /<[a-z][a-z0-9]*[\s>]/i;
    if (!htmlTagPattern.test(output)) {
      issues.push({
        code: 'NO_HTML_TAGS',
        severity: 'error',
        message: 'Output does not contain any recognizable HTML tags',
        fixable: true,
      });
    }

    return issues;
  }
}

module.exports = { DocxToHtmlAgent };
