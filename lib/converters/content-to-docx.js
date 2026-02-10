/**
 * ContentToDocxAgent
 *
 * @description Converts text, Markdown, or HTML content to DOCX (Word) format.
 *   Wraps the existing format-generators/docx-generator when available and falls
 *   back to building documents directly with the `docx` npm package.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/content-to-docx
 *
 * @strategies
 *   - standard   : Use the existing DocxGenerator with default options
 *   - styled     : Apply a custom template with branded typography and spacing
 *   - structured : Use AI to organize content into logical sections before generating
 *
 * @example
 *   const { ContentToDocxAgent } = require('./content-to-docx');
 *   const agent = new ContentToDocxAgent();
 *   const result = await agent.convert('# Report\n\nFindings here...');
 *   // result.output => <Buffer 50 4b ...>  (DOCX file buffer)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class ContentToDocxAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:content-to-docx';
    this.name = 'Content to DOCX';
    this.description = 'Converts text, Markdown, or HTML content to Word DOCX format';
    this.from = ['text', 'md', 'html'];
    this.to = ['docx'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'standard',
        description: 'Standard conversion using existing DocxGenerator with default options',
        when: 'Input is straightforward text or Markdown that needs a simple Word document',
        engine: 'docx-generator / docx',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Good for typical documents without complex formatting needs',
      },
      {
        id: 'styled',
        description: 'Styled conversion with custom template, branded typography, and spacing',
        when: 'Output needs professional formatting with headers, footers, and consistent styles',
        engine: 'docx',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Professional-looking documents with clean typography',
      },
      {
        id: 'structured',
        description: 'AI organizes content into logical sections before generating DOCX',
        when: 'Input is unstructured or loosely organized and benefits from AI restructuring',
        engine: 'docx + AI',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Best for messy input that needs logical organization',
      },
    ];
  }

  /**
   * Execute the content-to-DOCX conversion.
   *
   * @param {string} input - Text, Markdown, or HTML content to convert
   * @param {string} strategy - Strategy ID: 'standard' | 'styled' | 'structured'
   * @param {Object} [options] - Additional conversion options
   * @param {string} [options.title] - Document title
   * @param {string} [options.author] - Document author
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const start = Date.now();
    let output;

    switch (strategy) {
      case 'structured': {
        output = await this._executeStructured(input, options);
        break;
      }
      case 'styled': {
        output = await this._executeStyled(input, options);
        break;
      }
      case 'standard':
      default: {
        output = await this._executeStandard(input, options);
        break;
      }
    }

    return {
      output,
      metadata: {
        strategy,
        inputLength: input.length,
        outputLength: output.length,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        extension: 'docx',
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  /**
   * Standard conversion: try existing DocxGenerator, fall back to docx package.
   * @private
   */
  async _executeStandard(input, options) {
    // Try existing generator first
    try {
      const DocxGenerator = require('../../format-generators/docx-generator');
      const generator = new DocxGenerator();
      const space = { name: options.title || 'Document', description: '' };
      const items = [{ type: 'text', content: input, metadata: {} }];
      const result = await generator.generate(space, items, {});
      if (result.success && result.buffer) {
        return result.buffer;
      }
    } catch (_ignored) {
      // Generator not available, fall back to docx package
    }

    return this._buildDocxFromContent(input, options);
  }

  /**
   * Styled conversion: build DOCX with custom template styling.
   * @private
   */
  async _executeStyled(input, options) {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
      Header, Footer, PageNumber, BorderStyle } = require('docx');

    const sections = this._parseContentToParagraphs(input, { styled: true });
    const title = options.title || 'Document';

    // Title page content
    const titleParagraphs = [
      new Paragraph({
        children: [new TextRun({ text: title, bold: true, size: 56, font: 'Calibri Light', color: '2B579A' })],
        spacing: { after: 200 },
      }),
      new Paragraph({
        children: [new TextRun({
          text: `Generated ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`,
          size: 20, color: '888888',
        })],
        spacing: { after: 400 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC' } },
      }),
      new Paragraph({ text: '' }),
      ...sections,
    ];

    const doc = new Document({
      creator: options.author || 'Onereach.ai',
      title,
      styles: {
        default: { document: { run: { font: 'Calibri', size: 24 } } },
      },
      sections: [{
        properties: {
          page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
        },
        headers: {
          default: new Header({
            children: [new Paragraph({
              children: [new TextRun({ text: title, italics: true, size: 18, color: '888888' })],
              alignment: AlignmentType.RIGHT,
            })],
          }),
        },
        footers: {
          default: new Footer({
            children: [new Paragraph({
              children: [
                new TextRun({ text: 'Page ', size: 18 }),
                new TextRun({ children: [PageNumber.CURRENT], size: 18 }),
                new TextRun({ text: ' of ', size: 18 }),
                new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18 }),
              ],
              alignment: AlignmentType.CENTER,
            })],
          }),
        },
        children: titleParagraphs,
      }],
    });

    return Packer.toBuffer(doc);
  }

  /**
   * Structured conversion: use AI to organize content, then generate DOCX.
   * @private
   */
  async _executeStructured(input, options) {
    let organizedContent = input;

    if (this._ai) {
      try {
        const result = await this._ai.complete(
          `Reorganize the following content into logical sections with clear headings.
Use Markdown formatting (# for headings, ## for sub-headings, etc.).
Preserve all original information but improve the organization and flow.

Content:
${input.substring(0, 8000)}`,
          { profile: 'fast', feature: 'converter-structure', temperature: 0.3 }
        );
        if (result && result.trim().length > 0) {
          organizedContent = result;
        }
      } catch (_err) {
        // Fall back to original content
      }
    }

    return this._buildDocxFromContent(organizedContent, options);
  }

  /**
   * Build a DOCX buffer from text/Markdown content using the docx package.
   * @private
   */
  async _buildDocxFromContent(input, options = {}) {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');

    const sections = this._parseContentToParagraphs(input, {});
    const title = options.title || 'Document';

    const doc = new Document({
      creator: options.author || 'Onereach.ai',
      title,
      styles: {
        default: { document: { run: { font: 'Calibri', size: 24 } } },
      },
      sections: [{
        properties: {
          page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
        },
        children: sections,
      }],
    });

    return Packer.toBuffer(doc);
  }

  /**
   * Parse text/Markdown into an array of docx Paragraph objects.
   * @private
   */
  _parseContentToParagraphs(input, { styled = false } = {}) {
    const { Paragraph, TextRun, HeadingLevel } = require('docx');
    const paragraphs = [];
    const lines = input.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        paragraphs.push(new Paragraph({ text: '' }));
        continue;
      }

      // Markdown heading detection
      const h1Match = trimmed.match(/^#\s+(.+)$/);
      const h2Match = trimmed.match(/^##\s+(.+)$/);
      const h3Match = trimmed.match(/^###\s+(.+)$/);

      if (h1Match) {
        paragraphs.push(new Paragraph({
          children: [new TextRun({
            text: h1Match[1],
            bold: true,
            size: styled ? 48 : 40,
            font: styled ? 'Calibri Light' : undefined,
            color: styled ? '2B579A' : undefined,
          })],
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 400, after: 200 },
        }));
      } else if (h2Match) {
        paragraphs.push(new Paragraph({
          children: [new TextRun({
            text: h2Match[1],
            bold: true,
            size: styled ? 36 : 32,
            font: styled ? 'Calibri Light' : undefined,
            color: styled ? '5B5B5B' : undefined,
          })],
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 300, after: 150 },
        }));
      } else if (h3Match) {
        paragraphs.push(new Paragraph({
          children: [new TextRun({
            text: h3Match[1],
            bold: true,
            size: styled ? 28 : 26,
          })],
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 200, after: 100 },
        }));
      } else {
        // Regular paragraph - handle inline bold/italic
        const runs = this._parseInlineFormatting(trimmed);
        paragraphs.push(new Paragraph({
          children: runs,
          spacing: { after: 120 },
        }));
      }
    }

    return paragraphs;
  }

  /**
   * Parse basic Markdown inline formatting into TextRun objects.
   * @private
   */
  _parseInlineFormatting(text) {
    const { TextRun } = require('docx');
    const runs = [];
    // Simple split on bold (**...**) and italic (*...*)
    const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
    for (const part of parts) {
      if (part.startsWith('**') && part.endsWith('**')) {
        runs.push(new TextRun({ text: part.slice(2, -2), bold: true, size: 24 }));
      } else if (part.startsWith('*') && part.endsWith('*')) {
        runs.push(new TextRun({ text: part.slice(1, -1), italics: true, size: 24 }));
      } else if (part.length > 0) {
        runs.push(new TextRun({ text: part, size: 24 }));
      }
    }
    if (runs.length === 0) {
      runs.push(new TextRun({ text, size: 24 }));
    }
    return runs;
  }

  /**
   * Structural checks for content-to-DOCX conversion output.
   *
   * Validates that the output is a non-empty Buffer starting with PK (zip)
   * magic bytes, since DOCX files are ZIP archives.
   *
   * @param {string} input - Original text/Markdown input
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
        message: 'DOCX buffer is empty',
        fixable: true,
      });
      return issues;
    }

    // DOCX is a ZIP archive; first two bytes must be PK (0x50 0x4B)
    if (output[0] !== 0x50 || output[1] !== 0x4B) {
      issues.push({
        code: 'INVALID_ZIP_MAGIC',
        severity: 'error',
        message: 'Output does not start with PK magic bytes (not a valid DOCX/ZIP file)',
        fixable: true,
      });
    }

    // Sanity check: a valid DOCX should be at least a few hundred bytes
    if (output.length < 100) {
      issues.push({
        code: 'OUTPUT_TOO_SMALL',
        severity: 'warning',
        message: `DOCX buffer is suspiciously small (${output.length} bytes)`,
        fixable: false,
      });
    }

    return issues;
  }
}

module.exports = { ContentToDocxAgent };
