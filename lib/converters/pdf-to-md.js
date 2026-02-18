/**
 * PdfToMdAgent
 *
 * @description Converts PDF documents to Markdown using a generative approach.
 *   Extracts raw text via pdf-parse, then uses AI to restructure the content
 *   into clean Markdown with proper headings, lists, tables, and formatting.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/pdf-to-md
 *
 * @agent converter:pdf-to-md
 * @from pdf
 * @to   md, markdown
 * @modes generative
 *
 * @strategies
 *   - structured    : Extract text + AI structures into headings, lists, and paragraphs
 *   - layout-aware  : Preserve tables, columns, and spatial layout in the Markdown
 *   - semantic      : AI identifies logical sections, themes, and hierarchy from content
 *
 * @evaluation
 *   Structural checks verify the output is a non-empty string containing
 *   Markdown heading syntax. Quality is further judged via LLM spot-check
 *   (inherited from BaseConverterAgent).
 *
 * @input  {Buffer} PDF file bytes
 * @output {string} Markdown text
 *
 * @example
 *   const { PdfToMdAgent } = require('./pdf-to-md');
 *   const agent = new PdfToMdAgent();
 *   const result = await agent.convert(pdfBuffer);
 *   // result.output => "# Report Title\n\n## Introduction\n\nLorem ipsum..."
 *
 * @dependencies pdf-parse, lib/ai-service.js (standard profile)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

/**
 * AI system prompts tailored to each structuring strategy.
 * @private
 */
const SYSTEM_PROMPTS = {
  structured: [
    'You are a document structuring expert. Convert the following raw text extracted',
    'from a PDF into clean, well-organised Markdown. Apply proper heading hierarchy',
    '(# for title, ## for sections, ### for subsections). Use bullet lists where',
    'appropriate. Preserve all factual content. Do not add commentary or content',
    'that is not present in the source text. Output only the Markdown.',
  ].join(' '),

  'layout-aware': [
    'You are a document layout analyst. Convert the following raw text extracted',
    'from a PDF into Markdown while carefully preserving the original layout structure.',
    'Pay special attention to:',
    '1. Tables: reconstruct them as Markdown tables with proper alignment.',
    '2. Multi-column layouts: merge columns in reading order.',
    '3. Lists and nested lists: maintain correct indentation.',
    '4. Headers and footers: separate them from body content.',
    '5. Page numbers: remove them.',
    'Preserve all factual content. Output only the Markdown.',
  ].join(' '),

  semantic: [
    'You are a semantic document analyst. Analyse the following raw text extracted',
    'from a PDF and restructure it into Markdown based on semantic meaning, not just',
    'visual layout. Identify logical sections, arguments, themes, and hierarchies.',
    'Create a heading structure that reflects the logical organisation of the content.',
    'Group related paragraphs under appropriate headings. Use blockquotes for quotations,',
    'code blocks for code, and emphasis for key terms. Output only the Markdown.',
  ].join(' '),
};

class PdfToMdAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:pdf-to-md';
    this.name = 'PDF to Markdown';
    this.description = 'Converts PDFs to structured Markdown using text extraction and AI restructuring';
    this.from = ['pdf'];
    this.to = ['md', 'markdown'];
    this.modes = ['generative'];

    this.strategies = [
      {
        id: 'structured',
        description: 'Extract text and use AI to create clean Markdown with headings, lists, and paragraphs',
        when: 'Standard documents (reports, articles, manuals) needing clean Markdown structure',
        engine: 'pdf-parse + ai-chat',
        mode: 'generative',
        speed: 'medium',
        quality: 'Well-structured Markdown with proper heading hierarchy',
      },
      {
        id: 'layout-aware',
        description: 'Preserve tables, columns, and spatial layout in the Markdown output',
        when: 'Documents with complex layouts: tables, multi-column text, forms',
        engine: 'pdf-parse + ai-chat',
        mode: 'generative',
        speed: 'slow',
        quality: 'High fidelity layout preservation including tables and columns',
      },
      {
        id: 'semantic',
        description: 'AI identifies logical sections, themes, and hierarchy from content',
        when: 'Unstructured or poorly formatted PDFs where logical organisation must be inferred',
        engine: 'pdf-parse + ai-chat',
        mode: 'generative',
        speed: 'slow',
        quality: 'Semantically meaningful structure that may differ from visual layout',
      },
    ];
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Execute the PDF-to-Markdown conversion.
   *
   * @param {Buffer} input - PDF file bytes
   * @param {string} strategy - Strategy ID: 'structured' | 'layout-aware' | 'semantic'
   * @param {Object} [options] - Additional conversion options
   * @param {number} [options.maxPages] - Limit number of pages to process
   * @param {number} [options.maxTokens] - Override AI max token limit
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
    if (!this._ai) {
      throw new Error('AI service is required for PDF-to-Markdown conversion');
    }

    // Step 1: Extract raw text via pdf-parse
    const pdfParse = require('pdf-parse');
    const parseOptions = {};
    if (options.maxPages) {
      parseOptions.max = options.maxPages;
    }

    const pdfData = await pdfParse(input, parseOptions);
    const rawText = (pdfData.text || '').trim();

    if (rawText.length === 0) {
      throw new Error(
        'PDF text extraction returned empty text. The PDF may be image-based; consider pdf-to-text with OCR first.'
      );
    }

    // Step 2: Use AI to restructure into Markdown
    const systemPrompt = SYSTEM_PROMPTS[strategy];
    if (!systemPrompt) {
      throw new Error(`Unknown strategy: ${strategy}. Expected one of: ${Object.keys(SYSTEM_PROMPTS).join(', ')}`);
    }

    // Chunk the text if very long to stay within context limits
    const textForAi = rawText.length > 30000 ? rawText.substring(0, 30000) + '\n\n[...truncated...]' : rawText;

    const aiResult = await this._ai.chat({
      profile: 'standard',
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Convert the following PDF text to Markdown:\n\n---\n${textForAi}\n---`,
        },
      ],
      maxTokens: options.maxTokens || 4000,
      temperature: 0.2,
      feature: `converter-pdf-to-md-${strategy}`,
    });

    const markdown = (typeof aiResult === 'string' ? aiResult : aiResult?.content || '').trim();

    return {
      output: markdown,
      metadata: {
        strategy,
        pageCount: pdfData.numpages || 0,
        rawTextLength: rawText.length,
        markdownLength: markdown.length,
        truncated: rawText.length > 30000,
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
   * Verify the Markdown output meets quality expectations.
   *
   * @param {Buffer} input - Original PDF input
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
        message: 'Markdown output is empty',
        fixable: true,
      });
      return issues;
    }

    // Check for Markdown headings (at least one # heading expected)
    const hasHeadings = /^#{1,6}\s+.+/m.test(output);
    if (!hasHeadings) {
      issues.push({
        code: 'NO_HEADINGS',
        severity: 'warning',
        message: 'Markdown output does not contain any headings. Expected at least one heading for structured output.',
        fixable: true,
        suggestedStrategy: 'structured',
      });
    }

    // Check for remaining HTML tags (should be pure Markdown)
    if (/<[a-z][\s\S]*?>/i.test(output)) {
      issues.push({
        code: 'CONTAINS_HTML',
        severity: 'warning',
        message: 'Markdown output contains HTML tags; expected pure Markdown syntax',
        fixable: true,
      });
    }

    // Layout-aware specific: check for table syntax if strategy warrants
    if (strategy === 'layout-aware') {
      const hasTables = /\|.+\|/.test(output) && /\|[\s-:]+\|/.test(output);
      if (!hasTables) {
        issues.push({
          code: 'NO_TABLES',
          severity: 'info',
          message: 'Layout-aware strategy produced no Markdown tables (input may not contain tables)',
          fixable: false,
        });
      }
    }

    // Warn if output is very short relative to input
    if (output.trim().length < 50) {
      issues.push({
        code: 'OUTPUT_TOO_SHORT',
        severity: 'warning',
        message: `Markdown output is only ${output.trim().length} characters, possibly incomplete`,
        fixable: true,
      });
    }

    return issues;
  }

  /**
   * Override input description for LLM planning context.
   * @override
   */
  _describeInput(input, metadata = {}) {
    if (Buffer.isBuffer(input)) {
      const kb = (input.length / 1024).toFixed(1);
      return `PDF buffer (${kb} KB) to be converted to Markdown. ${metadata.fileName || ''}`.trim();
    }
    return super._describeInput(input, metadata);
  }
}

module.exports = { PdfToMdAgent };
