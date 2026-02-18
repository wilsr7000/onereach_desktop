/**
 * PdfToTextAgent
 *
 * @description Converts PDF documents to plain text. Supports direct text-layer
 *   extraction via pdf-parse, AI-powered OCR vision for scanned documents, and
 *   a hybrid mode that tries text-layer first and falls back to OCR when the
 *   extracted text is too sparse.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/pdf-to-text
 *
 * @agent converter:pdf-to-text
 * @from pdf
 * @to   text
 * @modes symbolic, generative, hybrid
 *
 * @strategies
 *   - text-layer : Direct text extraction from PDF text layer via pdf-parse
 *   - ocr-vision : Render pages and use AI vision to read text from images
 *   - hybrid     : Try text-layer first, fall back to OCR if yield is < 50 chars/page
 *
 * @evaluation
 *   Structural checks verify the output is a non-empty string and check for
 *   garbled encoding (excessive Unicode replacement characters). Generative
 *   quality is further judged via LLM spot-check for OCR outputs.
 *
 * @input  {Buffer} PDF file bytes
 * @output {string} Extracted plain text
 *
 * @example
 *   const { PdfToTextAgent } = require('./pdf-to-text');
const { getLogQueue } = require('./../log-event-queue');
const log = getLogQueue();
 *   const agent = new PdfToTextAgent();
 *   const result = await agent.convert(pdfBuffer);
 *   // result.output => "Chapter 1\n\nLorem ipsum dolor sit amet..."
 *
 * @dependencies pdf-parse, lib/ai-service.js (vision profile for OCR)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

/**
 * Minimum characters per page to consider text-layer extraction successful.
 * Below this threshold, the hybrid strategy falls back to OCR.
 * @private
 */
const MIN_CHARS_PER_PAGE = 50;

class PdfToTextAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   * @param {number} [config.minCharsPerPage] - Override chars/page threshold for hybrid
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:pdf-to-text';
    this.name = 'PDF to Text';
    this.description = 'Extracts text from PDFs via text-layer parsing, AI OCR vision, or hybrid fallback';
    this.from = ['pdf'];
    this.to = ['text'];
    this.modes = ['symbolic', 'generative', 'hybrid'];

    this._minCharsPerPage = config.minCharsPerPage || MIN_CHARS_PER_PAGE;

    this.strategies = [
      {
        id: 'text-layer',
        description: 'Direct text extraction from the PDF text layer using pdf-parse',
        when: 'The PDF has a native text layer (digitally created, not scanned)',
        engine: 'pdf-parse',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'High fidelity for text-based PDFs, fails on scanned documents',
      },
      {
        id: 'ocr-vision',
        description: 'Send PDF buffer to AI vision for OCR-style text extraction',
        when: 'The PDF is a scanned document or image-based with no text layer',
        engine: 'ai-vision',
        mode: 'generative',
        speed: 'slow',
        quality: 'Handles scanned and image-based PDFs, AI-dependent accuracy',
      },
      {
        id: 'hybrid',
        description: 'Try text-layer first, fall back to OCR if yield is below threshold',
        when: 'Unknown PDF quality; need reliable extraction regardless of text layer presence',
        engine: 'pdf-parse + ai-vision',
        mode: 'hybrid',
        speed: 'medium',
        quality: 'Best overall reliability across all PDF types',
      },
    ];
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Execute the PDF-to-text conversion.
   *
   * @param {Buffer} input - PDF file bytes
   * @param {string} strategy - Strategy ID: 'text-layer' | 'ocr-vision' | 'hybrid'
   * @param {Object} [options] - Additional conversion options
   * @param {number} [options.maxPages] - Limit number of pages to process
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

    let text;
    let actualStrategy = strategy;
    let pageCount = 0;

    switch (strategy) {
      case 'text-layer': {
        const result = await this._extractTextLayer(input, options);
        text = result.text;
        pageCount = result.pageCount;
        break;
      }

      case 'ocr-vision': {
        text = await this._extractWithOcr(input, options);
        break;
      }

      case 'hybrid': {
        // Try text-layer first
        const textLayerResult = await this._extractTextLayer(input, options);
        text = textLayerResult.text;
        pageCount = textLayerResult.pageCount;

        // Check if yield is sufficient
        const charsPerPage = pageCount > 0 ? text.trim().length / pageCount : 0;
        if (charsPerPage < this._minCharsPerPage) {
          // Fall back to OCR
          try {
            text = await this._extractWithOcr(input, options);
            actualStrategy = 'hybrid:ocr-fallback';
          } catch (ocrErr) {
            // If OCR also fails, keep the text-layer result (even if sparse)
            console.warn('[pdf-to-text] OCR fallback failed, keeping text-layer result:', ocrErr.message);
          }
        }
        break;
      }

      default:
        throw new Error(`Unknown strategy: ${strategy}`);
    }

    // Normalize whitespace
    text = text
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return {
      output: text,
      metadata: {
        strategy: actualStrategy,
        pageCount,
        charCount: text.length,
        wordCount: text.split(/\s+/).filter(Boolean).length,
        inputSize: input.length,
      },
      duration: Date.now() - start,
      strategy: actualStrategy,
    };
  }

  // ===========================================================================
  // STRUCTURAL CHECKS
  // ===========================================================================

  /**
   * Verify the text output meets quality expectations.
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
        message: 'Extracted text is empty',
        fixable: true,
        suggestedStrategy: strategy === 'text-layer' ? 'ocr-vision' : undefined,
      });
      return issues;
    }

    // Check for garbled encoding: excessive Unicode replacement characters
    const replacementCount = (output.match(/\uFFFD/g) || []).length;
    const replacementRatio = replacementCount / output.length;
    if (replacementRatio > 0.05) {
      issues.push({
        code: 'GARBLED_ENCODING',
        severity: 'error',
        message: `High ratio of Unicode replacement characters (${(replacementRatio * 100).toFixed(1)}%), indicating encoding issues`,
        fixable: true,
        suggestedStrategy: 'ocr-vision',
      });
    } else if (replacementRatio > 0.01) {
      issues.push({
        code: 'PARTIAL_GARBLED',
        severity: 'warning',
        message: `Some Unicode replacement characters detected (${replacementCount} occurrences)`,
        fixable: true,
      });
    }

    // Check for excessive control characters (excluding newline/tab)
    const controlCount = (output.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) || []).length;
    if (controlCount > 10) {
      issues.push({
        code: 'CONTROL_CHARACTERS',
        severity: 'warning',
        message: `Output contains ${controlCount} unexpected control characters`,
        fixable: true,
      });
    }

    // Warn if very short for a PDF (likely incomplete extraction)
    if (output.trim().length < 20) {
      issues.push({
        code: 'TEXT_TOO_SHORT',
        severity: 'warning',
        message: `Extracted text is only ${output.trim().length} characters, possibly incomplete`,
        fixable: true,
        suggestedStrategy: strategy === 'text-layer' ? 'ocr-vision' : undefined,
      });
    }

    return issues;
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  /**
   * Extract text from the PDF text layer using pdf-parse.
   *
   * @param {Buffer} pdfBuffer
   * @param {Object} options
   * @returns {Promise<{text: string, pageCount: number}>}
   * @private
   */
  async _extractTextLayer(pdfBuffer, options = {}) {
    const pdfParse = require('pdf-parse');
    const parseOptions = {};

    if (options.maxPages) {
      parseOptions.max = options.maxPages;
    }

    const data = await pdfParse(pdfBuffer, parseOptions);
    return {
      text: data.text || '',
      pageCount: data.numpages || 0,
    };
  }

  /**
   * Extract text from PDF using AI vision (OCR-style).
   *
   * @param {Buffer} pdfBuffer
   * @param {Object} options
   * @returns {Promise<string>}
   * @private
   */
  async _extractWithOcr(pdfBuffer, _options = {}) {
    if (!this._ai) {
      throw new Error('AI service is not available. Cannot perform OCR vision extraction.');
    }

    const imageData = pdfBuffer.toString('base64');

    const result = await this._ai.vision(
      imageData,
      'Extract ALL text from this PDF document. Preserve the reading order, paragraph breaks, ' +
        'and any structural formatting (headings, lists, tables). Output only the extracted text ' +
        'with no additional commentary.',
      {
        profile: 'vision',
        system:
          'You are a precise OCR engine. Extract all visible text from the document exactly ' +
          'as it appears. Preserve formatting, line breaks, and reading order. Do not add any ' +
          'commentary or interpretation.',
        maxTokens: 4000,
        temperature: 0,
        feature: 'converter-pdf-to-text-ocr',
      }
    );

    const text = typeof result === 'string' ? result : result?.content || result?.text || String(result);

    return text.trim();
  }

  /**
   * Override input description for LLM planning context.
   * @override
   */
  _describeInput(input, metadata = {}) {
    if (Buffer.isBuffer(input)) {
      const kb = (input.length / 1024).toFixed(1);
      return `PDF buffer (${kb} KB). ${metadata.fileName || ''}`.trim();
    }
    return super._describeInput(input, metadata);
  }
}

module.exports = { PdfToTextAgent };
