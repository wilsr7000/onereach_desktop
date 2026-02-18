/**
 * TextToMdAgent
 *
 * @description Converts plain text to Markdown using generative AI to add
 *   structure, headings, lists, and emphasis. For minimal conversion, splits
 *   into paragraphs without AI. For structure and rich modes, uses the
 *   centralized AI service to intelligently format the text.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/text-to-md
 *
 * @strategies
 *   - minimal   : Simple paragraph splitting without AI involvement
 *   - structure  : AI adds headings, lists, and emphasis to organize content
 *   - rich       : Full AI analysis with semantic headings, nested lists, emphasis, and tables
 *
 * @example
 *   const { TextToMdAgent } = require('./text-to-md');
 *   const agent = new TextToMdAgent();
 *   const result = await agent.convert('Meeting notes from today. We discussed...');
 *   // result.output => '# Meeting Notes\n\nWe discussed...'
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');
const { getLogQueue } = require('./../log-event-queue');
const _log = getLogQueue();

class TextToMdAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:text-to-md';
    this.name = 'Plain Text to Markdown';
    this.description = 'Converts plain text to Markdown using AI-driven structuring';
    this.from = ['text'];
    this.to = ['md', 'markdown'];
    this.modes = ['generative'];

    this.strategies = [
      {
        id: 'minimal',
        description: 'Simple paragraph splitting without AI, wraps in basic Markdown',
        when: 'Input is already well-structured or AI is unavailable',
        engine: 'regex',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Basic paragraph formatting only',
      },
      {
        id: 'structure',
        description: 'AI adds headings, lists, and emphasis to organize the content',
        when: 'Input has implicit structure that would benefit from Markdown formatting',
        engine: 'ai-service',
        mode: 'generative',
        speed: 'medium',
        quality: 'Well-organized with clear hierarchy',
      },
      {
        id: 'rich',
        description: 'Full AI analysis: semantic headings, nested lists, emphasis, code blocks, tables',
        when: 'Input is complex or lengthy and needs comprehensive Markdown formatting',
        engine: 'ai-service',
        mode: 'generative',
        speed: 'slow',
        quality: 'Rich, polished Markdown with full formatting',
      },
    ];
  }

  /**
   * Execute the text-to-Markdown conversion.
   *
   * @param {string} input - Plain text content to convert
   * @param {string} strategy - Strategy ID: 'minimal' | 'structure' | 'rich'
   * @param {Object} [options] - Additional conversion options
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, _options = {}) {
    const start = Date.now();
    let output;

    switch (strategy) {
      case 'minimal': {
        output = this._minimalConvert(input);
        break;
      }

      case 'structure': {
        output = await this._structureConvert(input);
        break;
      }

      case 'rich': {
        output = await this._richConvert(input);
        break;
      }

      default: {
        output = this._minimalConvert(input);
        break;
      }
    }

    return {
      output,
      metadata: {
        strategy,
        inputLength: input.length,
        outputLength: output.length,
        usedAi: strategy !== 'minimal',
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  /**
   * Minimal conversion: split text into paragraphs separated by blank lines.
   *
   * @param {string} text - Plain text input
   * @returns {string} Basic Markdown with paragraph separation
   * @private
   */
  _minimalConvert(text) {
    // Split on double newlines or multiple newlines to detect paragraph breaks
    const paragraphs = text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    return paragraphs.join('\n\n');
  }

  /**
   * Structure conversion: use AI to add headings, lists, and emphasis.
   *
   * @param {string} text - Plain text input
   * @returns {Promise<string>} Structured Markdown
   * @private
   */
  async _structureConvert(text) {
    if (!this._ai) {
      console.warn('[text-to-md] AI service unavailable, falling back to minimal');
      return this._minimalConvert(text);
    }

    try {
      const result = await this._ai.chat({
        profile: 'fast',
        feature: 'converter-text-to-md',
        temperature: 0.3,
        system: `You are a text-to-Markdown formatter. Convert the given plain text into 
well-structured Markdown. Add appropriate headings (##, ###), bullet lists, 
numbered lists, and bold/italic emphasis where they improve readability.

Rules:
- Preserve ALL original content; do not add, remove, or rephrase anything
- Only add Markdown formatting syntax
- Use headings to break logical sections
- Use lists for enumerated or sequential items
- Use bold for key terms or important phrases
- Use italic for emphasis
- Return ONLY the formatted Markdown, no explanations`,
        messages: [{ role: 'user', content: text }],
      });

      const output = result && result.content ? result.content.trim() : null;

      if (output && output.length > 0) {
        return output;
      }

      // Fallback if AI returns empty
      return this._minimalConvert(text);
    } catch (err) {
      console.warn('[text-to-md] AI structure conversion failed:', err.message);
      return this._minimalConvert(text);
    }
  }

  /**
   * Rich conversion: full AI analysis with comprehensive Markdown formatting.
   *
   * @param {string} text - Plain text input
   * @returns {Promise<string>} Richly formatted Markdown
   * @private
   */
  async _richConvert(text) {
    if (!this._ai) {
      console.warn('[text-to-md] AI service unavailable, falling back to minimal');
      return this._minimalConvert(text);
    }

    try {
      const result = await this._ai.chat({
        profile: 'standard',
        feature: 'converter-text-to-md',
        temperature: 0.3,
        system: `You are an expert text-to-Markdown formatter. Convert the given plain text 
into richly formatted, polished Markdown. Apply comprehensive formatting:

1. Add a title heading (#) if the text has a clear topic
2. Add section headings (##, ###) for logical groupings
3. Convert enumerated items to numbered or bullet lists
4. Nest sub-items as indented lists where appropriate
5. Use bold (**) for key terms, names, and important concepts
6. Use italic (*) for emphasis, titles, and foreign terms
7. Use inline code backticks for technical terms, file names, commands
8. Use fenced code blocks for any code or structured data
9. Use tables if the text contains tabular data
10. Use blockquotes for quoted material
11. Add horizontal rules (---) between major sections if helpful

Rules:
- Preserve ALL original content faithfully; do not add or remove information
- Only add Markdown formatting syntax
- The output should be a polished, professional document
- Return ONLY the formatted Markdown, no explanations or preamble`,
        messages: [{ role: 'user', content: text }],
      });

      const output = result && result.content ? result.content.trim() : null;

      if (output && output.length > 0) {
        return output;
      }

      // Fallback if AI returns empty
      return this._minimalConvert(text);
    } catch (err) {
      console.warn('[text-to-md] AI rich conversion failed:', err.message);
      return this._minimalConvert(text);
    }
  }

  /**
   * Structural checks for text-to-Markdown conversion output.
   *
   * Validates that the output is a non-empty string containing some
   * Markdown formatting syntax.
   *
   * @param {string} input - Original plain text input
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

    // Check that output contains some Markdown syntax (for non-minimal strategies)
    if (strategy !== 'minimal') {
      const hasHeadings = /^#{1,6}\s/m.test(output);
      const hasBold = /\*\*[^*]+\*\*/.test(output);
      const hasItalic = /\*[^*]+\*/.test(output);
      const hasLists = /^[\s]*[-*+]\s/m.test(output) || /^[\s]*\d+\.\s/m.test(output);
      const hasCodeBlocks = /```/.test(output);
      const hasInlineCode = /`[^`]+`/.test(output);

      const markdownFeatures = [hasHeadings, hasBold, hasItalic, hasLists, hasCodeBlocks, hasInlineCode];
      const featureCount = markdownFeatures.filter(Boolean).length;

      if (featureCount === 0) {
        issues.push({
          code: 'NO_MARKDOWN_SYNTAX',
          severity: 'warning',
          message: 'Output does not contain any recognizable Markdown formatting',
          fixable: true,
        });
      }

      // For rich strategy, expect more formatting
      if (strategy === 'rich' && featureCount < 2) {
        issues.push({
          code: 'INSUFFICIENT_FORMATTING',
          severity: 'warning',
          message: 'Rich strategy produced output with very little Markdown formatting',
          fixable: true,
        });
      }
    }

    // Check that output preserves reasonable content length
    if (output.length < input.length * 0.5) {
      issues.push({
        code: 'CONTENT_LOSS',
        severity: 'warning',
        message: `Output is significantly shorter than input (${output.length} vs ${input.length} chars)`,
        fixable: true,
      });
    }

    return issues;
  }
}

module.exports = { TextToMdAgent };
