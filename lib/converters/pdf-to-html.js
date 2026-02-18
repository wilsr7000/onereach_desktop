/**
 * PdfToHtmlAgent
 *
 * @description Converts PDF documents to HTML using a generative approach.
 *   Extracts raw text via pdf-parse, then uses AI to produce semantic HTML
 *   with appropriate tags, styling, and structure.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/pdf-to-html
 *
 * @agent converter:pdf-to-html
 * @from pdf
 * @to   html
 * @modes generative
 *
 * @strategies
 *   - simple   : Wrap extracted text in basic HTML with paragraph tags
 *   - styled   : AI generates HTML with embedded CSS for visual presentation
 *   - semantic : AI produces proper HTML5 semantic markup (article, section, header, etc.)
 *
 * @evaluation
 *   Structural checks verify the output is a non-empty string containing
 *   HTML tags. Quality is further judged via LLM spot-check (inherited
 *   from BaseConverterAgent).
 *
 * @input  {Buffer} PDF file bytes
 * @output {string} HTML content
 *
 * @example
 *   const { PdfToHtmlAgent } = require('./pdf-to-html');
 *   const agent = new PdfToHtmlAgent();
 *   const result = await agent.convert(pdfBuffer, { strategy: 'semantic' });
 *   // result.output => "<!DOCTYPE html>\n<html>..."
 *
 * @dependencies pdf-parse, lib/ai-service.js (standard profile)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

/**
 * AI system prompts tailored to each HTML generation strategy.
 * @private
 */
const SYSTEM_PROMPTS = {
  simple: [
    'You are a text-to-HTML converter. Wrap the following text in clean, minimal HTML.',
    'Use <p> tags for paragraphs, <br> for line breaks within paragraphs, and <h1>/<h2>/<h3>',
    'for any identifiable headings. Do not add CSS or JavaScript. Do not add any content',
    'that is not present in the source text. Start with <!DOCTYPE html> and include',
    '<html>, <head> with <meta charset="utf-8">, and <body> tags.',
    'Output only the HTML.',
  ].join(' '),

  styled: [
    'You are an expert HTML/CSS developer. Convert the following text into a visually',
    'polished HTML document with embedded CSS in a <style> tag. Use a clean, modern design:',
    '- System font stack (sans-serif), comfortable line-height (1.6)',
    '- Responsive max-width container (800px), centered',
    '- Proper heading hierarchy with visual distinction',
    '- Styled tables with borders and alternating row colors if tables are present',
    '- Code blocks with monospace font and background color',
    '- Print-friendly styles',
    'Do not add JavaScript. Do not add content not present in the source.',
    'Start with <!DOCTYPE html>. Output only the HTML.',
  ].join(' '),

  semantic: [
    'You are a semantic HTML5 specialist. Convert the following text into proper semantic',
    'HTML5 markup. Use the correct elements for their intended purposes:',
    '- <article> for the main document content',
    '- <section> for logical sections with headings',
    '- <header> and <footer> for document header/footer',
    '- <nav> if a table of contents is appropriate',
    '- <aside> for supplementary notes or sidebars',
    '- <figure>/<figcaption> for referenced figures',
    '- <blockquote> for quotations, <cite> for citations',
    '- <dl>/<dt>/<dd> for definition lists',
    '- <time> for dates and times with datetime attributes',
    'Add minimal CSS for readability. Do not add JavaScript.',
    'Do not add content not present in the source. Start with <!DOCTYPE html>.',
    'Output only the HTML.',
  ].join(' '),
};

class PdfToHtmlAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:pdf-to-html';
    this.name = 'PDF to HTML';
    this.description = 'Converts PDFs to HTML using text extraction and AI-generated semantic markup';
    this.from = ['pdf'];
    this.to = ['html'];
    this.modes = ['generative'];

    this.strategies = [
      {
        id: 'simple',
        description: 'Wrap extracted text in basic HTML with paragraph and heading tags',
        when: 'A quick, minimal HTML version is needed without styling or complex structure',
        engine: 'pdf-parse + ai-chat',
        mode: 'generative',
        speed: 'medium',
        quality: 'Basic HTML structure, no styling',
      },
      {
        id: 'styled',
        description: 'AI generates HTML with embedded CSS for polished visual presentation',
        when: 'The HTML will be displayed in a browser and should look professionally styled',
        engine: 'pdf-parse + ai-chat',
        mode: 'generative',
        speed: 'slow',
        quality: 'Visually polished with modern CSS styling',
      },
      {
        id: 'semantic',
        description: 'AI produces proper HTML5 semantic markup with article, section, nav elements',
        when: 'Semantic correctness and accessibility matter (web publishing, screen readers)',
        engine: 'pdf-parse + ai-chat',
        mode: 'generative',
        speed: 'slow',
        quality: 'Semantically rich HTML5 with appropriate landmark elements',
      },
    ];
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Execute the PDF-to-HTML conversion.
   *
   * @param {Buffer} input - PDF file bytes
   * @param {string} strategy - Strategy ID: 'simple' | 'styled' | 'semantic'
   * @param {Object} [options] - Additional conversion options
   * @param {number} [options.maxPages] - Limit number of pages to process
   * @param {number} [options.maxTokens] - Override AI max token limit
   * @param {string} [options.title] - Document title for the HTML <title> tag
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
      throw new Error('AI service is required for PDF-to-HTML conversion');
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

    // Step 2: Use AI to convert to HTML
    const systemPrompt = SYSTEM_PROMPTS[strategy];
    if (!systemPrompt) {
      throw new Error(`Unknown strategy: ${strategy}. Expected one of: ${Object.keys(SYSTEM_PROMPTS).join(', ')}`);
    }

    // Chunk the text if very long to stay within context limits
    const textForAi = rawText.length > 30000 ? rawText.substring(0, 30000) + '\n\n[...truncated...]' : rawText;

    const titleHint = options.title ? `\nThe document title is: "${options.title}".` : '';

    const aiResult = await this._ai.chat({
      profile: 'standard',
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Convert the following PDF text to HTML:${titleHint}\n\n---\n${textForAi}\n---`,
        },
      ],
      maxTokens: options.maxTokens || 4000,
      temperature: 0.2,
      feature: `converter-pdf-to-html-${strategy}`,
    });

    let html = (typeof aiResult === 'string' ? aiResult : aiResult?.content || '').trim();

    // Strip markdown code fences if the AI wrapped the output
    html = html
      .replace(/^```(?:html)?\n?/i, '')
      .replace(/\n?```$/i, '')
      .trim();

    return {
      output: html,
      metadata: {
        strategy,
        pageCount: pdfData.numpages || 0,
        rawTextLength: rawText.length,
        htmlLength: html.length,
        truncated: rawText.length > 30000,
        inputSize: input.length,
        hasDoctype: html.toLowerCase().startsWith('<!doctype'),
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  // ===========================================================================
  // STRUCTURAL CHECKS
  // ===========================================================================

  /**
   * Verify the HTML output meets quality expectations.
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
        message: 'HTML output is empty',
        fixable: true,
      });
      return issues;
    }

    // Must contain HTML tags
    const hasHtmlTags = /<[a-z][\s\S]*?>/i.test(output);
    if (!hasHtmlTags) {
      issues.push({
        code: 'NO_HTML_TAGS',
        severity: 'error',
        message: 'Output does not contain any HTML tags',
        fixable: true,
      });
      return issues;
    }

    // Should have a DOCTYPE declaration
    if (!/<!doctype\s+html/i.test(output)) {
      issues.push({
        code: 'MISSING_DOCTYPE',
        severity: 'warning',
        message: 'HTML output is missing <!DOCTYPE html> declaration',
        fixable: true,
      });
    }

    // Should have <html>, <head>, and <body> tags
    if (!/<html[\s>]/i.test(output)) {
      issues.push({
        code: 'MISSING_HTML_TAG',
        severity: 'warning',
        message: 'HTML output is missing <html> root element',
        fixable: true,
      });
    }

    if (!/<body[\s>]/i.test(output)) {
      issues.push({
        code: 'MISSING_BODY_TAG',
        severity: 'warning',
        message: 'HTML output is missing <body> element',
        fixable: true,
      });
    }

    // Semantic strategy: check for semantic elements
    if (strategy === 'semantic') {
      const semanticTags = ['article', 'section', 'header', 'footer', 'nav', 'aside', 'main'];
      const hasSemanticTags = semanticTags.some((tag) => new RegExp(`<${tag}[\\s>]`, 'i').test(output));
      if (!hasSemanticTags) {
        issues.push({
          code: 'NO_SEMANTIC_TAGS',
          severity: 'warning',
          message: 'Semantic strategy output lacks HTML5 semantic elements (article, section, etc.)',
          fixable: true,
          suggestedStrategy: 'semantic',
        });
      }
    }

    // Styled strategy: check for CSS
    if (strategy === 'styled') {
      if (!/<style[\s>]/i.test(output)) {
        issues.push({
          code: 'NO_STYLE_TAG',
          severity: 'warning',
          message: 'Styled strategy output lacks a <style> tag with CSS',
          fixable: true,
          suggestedStrategy: 'styled',
        });
      }
    }

    // Warn if output is very short relative to input
    if (output.trim().length < 100) {
      issues.push({
        code: 'OUTPUT_TOO_SHORT',
        severity: 'warning',
        message: `HTML output is only ${output.trim().length} characters, possibly incomplete`,
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
      return `PDF buffer (${kb} KB) to be converted to HTML. ${metadata.fileName || ''}`.trim();
    }
    return super._describeInput(input, metadata);
  }
}

module.exports = { PdfToHtmlAgent };
