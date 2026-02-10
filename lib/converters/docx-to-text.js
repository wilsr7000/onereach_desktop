/**
 * DocxToTextAgent
 *
 * @description Converts DOCX (Word) files to plain text using the `mammoth` library.
 *   Supports standard raw-text extraction, structure-preserving conversion that
 *   maintains headings and list indentation, and a tables-as-csv mode that
 *   renders tables as comma-separated values inline.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/docx-to-text
 *
 * @strategies
 *   - mammoth       : Standard mammoth.extractRawText() for clean text extraction
 *   - preserving    : Maintains document structure with heading markers and indentation
 *   - tables-as-csv : Extracts tables and renders them as inline CSV blocks
 *
 * @example
 *   const { DocxToTextAgent } = require('./docx-to-text');
 *   const agent = new DocxToTextAgent();
 *   const result = await agent.convert(docxBuffer);
 *   // result.output => 'Hello World\n\nThis is a paragraph...'
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class DocxToTextAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:docx-to-text';
    this.name = 'DOCX to Text';
    this.description = 'Converts DOCX (Word) files to plain text using mammoth';
    this.from = ['docx'];
    this.to = ['text'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'mammoth',
        description: 'Standard mammoth.extractRawText() for clean text extraction',
        when: 'Need simple plain text without any formatting or structural hints',
        engine: 'mammoth',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Clean text extraction, loses all formatting',
      },
      {
        id: 'preserving',
        description: 'Maintains document structure with heading prefixes and list indentation',
        when: 'Want to preserve the document hierarchy and list structure in text form',
        engine: 'mammoth',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Good structural preservation in plain text form',
      },
      {
        id: 'tables-as-csv',
        description: 'Extracts tables and renders them as inline CSV-formatted blocks',
        when: 'Document contains important tables that need to be machine-readable',
        engine: 'mammoth',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Best for documents with tabular data',
      },
    ];
  }

  /**
   * Execute the DOCX-to-text conversion.
   *
   * @param {Buffer} input - DOCX file buffer to convert
   * @param {string} strategy - Strategy ID: 'mammoth' | 'preserving' | 'tables-as-csv'
   * @param {Object} [options] - Additional conversion options
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const start = Date.now();
    const mammoth = require('mammoth');
    let output;

    switch (strategy) {
      case 'preserving': {
        output = await this._executePreserving(input, mammoth);
        break;
      }
      case 'tables-as-csv': {
        output = await this._executeTablesAsCsv(input, mammoth);
        break;
      }
      case 'mammoth':
      default: {
        const result = await mammoth.extractRawText({ buffer: input });
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
        mimeType: 'text/plain',
        extension: 'txt',
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  /**
   * Preserving strategy: convert to HTML first, then extract text with
   * structural markers for headings and lists.
   * @private
   */
  async _executePreserving(input, mammoth) {
    const result = await mammoth.convertToHtml({ buffer: input });
    const html = result.value;

    let text = html;

    // Convert headings to text markers
    text = text.replace(/<h1[^>]*>(.*?)<\/h1>/gi, (_, content) => `\n=== ${this._stripTags(content).toUpperCase()} ===\n`);
    text = text.replace(/<h2[^>]*>(.*?)<\/h2>/gi, (_, content) => `\n--- ${this._stripTags(content)} ---\n`);
    text = text.replace(/<h3[^>]*>(.*?)<\/h3>/gi, (_, content) => `\n### ${this._stripTags(content)}\n`);
    text = text.replace(/<h[4-6][^>]*>(.*?)<\/h[4-6]>/gi, (_, content) => `\n${this._stripTags(content)}\n`);

    // Convert list items with indentation
    text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, (_, content) => `  - ${this._stripTags(content)}\n`);

    // Convert paragraphs
    text = text.replace(/<p[^>]*>(.*?)<\/p>/gi, (_, content) => `${this._stripTags(content)}\n\n`);

    // Convert line breaks
    text = text.replace(/<br\s*\/?>/gi, '\n');

    // Strip remaining HTML tags
    text = this._stripTags(text);

    // Normalize whitespace
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    return text;
  }

  /**
   * Tables-as-CSV strategy: convert to HTML, extract tables as CSV blocks,
   * and keep remaining content as text.
   * @private
   */
  async _executeTablesAsCsv(input, mammoth) {
    const result = await mammoth.convertToHtml({ buffer: input });
    let html = result.value;

    // Extract and convert tables to CSV format
    html = html.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, tableContent) => {
      const rows = [];
      const rowMatches = tableContent.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
      for (const rowHtml of rowMatches) {
        const cells = [];
        const cellMatches = rowHtml.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || [];
        for (const cellHtml of cellMatches) {
          const cellText = this._stripTags(cellHtml.replace(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/i, '$1')).trim();
          // Escape commas and quotes for CSV
          if (cellText.includes(',') || cellText.includes('"') || cellText.includes('\n')) {
            cells.push(`"${cellText.replace(/"/g, '""')}"`);
          } else {
            cells.push(cellText);
          }
        }
        rows.push(cells.join(','));
      }
      return '\n[TABLE]\n' + rows.join('\n') + '\n[/TABLE]\n';
    });

    // Strip remaining HTML
    let text = html;
    text = text.replace(/<p[^>]*>(.*?)<\/p>/gi, (_, content) => `${this._stripTags(content)}\n\n`);
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = this._stripTags(text);
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    return text;
  }

  /**
   * Strip HTML tags from a string.
   * @private
   */
  _stripTags(html) {
    return html.replace(/<[^>]+>/g, '');
  }

  /**
   * Structural checks for DOCX-to-text conversion output.
   *
   * Validates that the output is a non-empty string.
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
        message: 'Text output is empty (document may contain only images or be blank)',
        fixable: false,
      });
    }

    return issues;
  }
}

module.exports = { DocxToTextAgent };
