/**
 * HtmlToTextAgent
 *
 * @description Converts HTML content to plain text. Supports full tag stripping,
 *   readable block-structure-preserving conversion, and article-extraction mode
 *   that isolates main content while ignoring navigation and footer elements.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/html-to-text
 *
 * @agent converter:html-to-text
 * @from html
 * @to   text
 * @modes symbolic
 *
 * @strategies
 *   - strip    : Remove all HTML tags, returning raw text
 *   - readable : Preserve block structure as newlines, strip inline tags
 *   - article  : Extract main content from <article> or <main>, ignore nav/footer
 *
 * @evaluation
 *   Structural checks verify the output is a non-empty string with no
 *   remaining HTML tags.
 *
 * @input  {string} HTML content
 * @output {string} Plain text
 *
 * @example
 *   const { HtmlToTextAgent } = require('./html-to-text');
 *   const agent = new HtmlToTextAgent();
 *   const result = await agent.convert('<p>Hello <b>world</b></p>');
 *   // result.output => 'Hello world'
 *
 * @dependencies None (pure string manipulation)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

/**
 * Common HTML entity map for decoding.
 * @private
 */
const HTML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&ndash;': '\u2013',
  '&mdash;': '\u2014',
  '&laquo;': '\u00AB',
  '&raquo;': '\u00BB',
  '&copy;': '\u00A9',
  '&reg;': '\u00AE',
  '&trade;': '\u2122',
  '&hellip;': '\u2026',
};

class HtmlToTextAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:html-to-text';
    this.name = 'HTML to Text';
    this.description = 'Converts HTML content to plain text via tag stripping, readable conversion, or article extraction';
    this.from = ['html'];
    this.to = ['text'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'strip',
        description: 'Remove all HTML tags, returning raw concatenated text',
        when: 'A quick, no-frills text dump is needed without any formatting',
        engine: 'regex',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Basic text extraction, no structural preservation',
      },
      {
        id: 'readable',
        description: 'Replace block-level tags with newlines, strip inline tags for readable output',
        when: 'The text should preserve paragraph breaks and list structure for human reading',
        engine: 'regex',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Good readability with paragraph and list structure preserved',
      },
      {
        id: 'article',
        description: 'Extract main content from <article> or <main>, ignoring nav, footer, sidebar',
        when: 'Input is a full web page and only the primary article/content is needed',
        engine: 'regex',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Best for noisy web pages, focuses on primary content',
      },
    ];
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Execute the HTML-to-text conversion.
   *
   * @param {string} input - HTML content to convert
   * @param {string} strategy - Strategy ID: 'strip' | 'readable' | 'article'
   * @param {Object} [options] - Additional conversion options
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const start = Date.now();
    let html = typeof input === 'string' ? input : String(input);
    let output;

    switch (strategy) {
      case 'strip': {
        // Remove all tags, decode entities
        output = this._stripAllTags(html);
        break;
      }

      case 'readable': {
        // Remove script/style blocks first
        html = this._removeNonContent(html);

        // Replace block-level tags with newlines to preserve structure
        html = html
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote|pre|section|article|aside|header|footer|main)>/gi, '\n\n')
          .replace(/<(?:hr)\s*\/?>/gi, '\n---\n')
          .replace(/<\/(?:td|th)>/gi, '\t')
          .replace(/<li[^>]*>/gi, '\n- ');

        // Strip remaining tags
        output = this._stripAllTags(html);

        // Normalize whitespace: collapse runs of blank lines
        output = output
          .split('\n')
          .map(line => line.trimEnd())
          .join('\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        break;
      }

      case 'article': {
        // Try to extract content from <article> or <main> first
        let contentHtml = this._extractMainContent(html);

        // Remove non-content sections from the extracted region
        contentHtml = this._removeNonContent(contentHtml);

        // Convert using the readable approach on the extracted content
        contentHtml = contentHtml
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote|pre|section|article|aside|header|footer|main)>/gi, '\n\n')
          .replace(/<(?:hr)\s*\/?>/gi, '\n---\n')
          .replace(/<\/(?:td|th)>/gi, '\t')
          .replace(/<li[^>]*>/gi, '\n- ');

        output = this._stripAllTags(contentHtml);
        output = output
          .split('\n')
          .map(line => line.trimEnd())
          .join('\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        break;
      }

      default:
        output = this._stripAllTags(html);
    }

    return {
      output,
      metadata: {
        strategy,
        inputLength: input.length,
        outputLength: output.length,
        compressionRatio: input.length > 0 ? (output.length / input.length).toFixed(3) : '0',
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  // ===========================================================================
  // STRUCTURAL CHECKS
  // ===========================================================================

  /**
   * Verify the text output meets conversion expectations.
   *
   * @param {string} input - Original HTML input
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
        message: 'Text output is empty',
        fixable: true,
      });
      return issues;
    }

    // No HTML tags should remain in the output
    if (/<[a-z][\s\S]*?>/i.test(output)) {
      issues.push({
        code: 'REMAINING_HTML_TAGS',
        severity: 'error',
        message: 'Output still contains HTML tags that should have been stripped',
        fixable: true,
        suggestedStrategy: 'strip',
      });
    }

    // Warn if output contains HTML entities that were not decoded
    if (/&(?:amp|lt|gt|quot|nbsp|#\d+);/i.test(output)) {
      issues.push({
        code: 'UNDECODED_ENTITIES',
        severity: 'warning',
        message: 'Output contains undecoded HTML entities',
        fixable: true,
      });
    }

    return issues;
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  /**
   * Strip all HTML tags and decode entities.
   * @param {string} html
   * @returns {string}
   * @private
   */
  _stripAllTags(html) {
    // Remove script and style blocks entirely
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');

    // Strip all remaining tags
    text = text.replace(/<[^>]+>/g, '');

    // Decode HTML entities
    text = this._decodeEntities(text);

    // Collapse whitespace within lines
    text = text.replace(/[ \t]+/g, ' ').trim();

    return text;
  }

  /**
   * Remove script, style, nav, footer, header, aside, and comment blocks.
   * @param {string} html
   * @returns {string}
   * @private
   */
  _removeNonContent(html) {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<aside[\s\S]*?<\/aside>/gi, '')
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');
  }

  /**
   * Extract the primary content region from a full HTML page.
   * Looks for <article>, <main>, or <div role="main"> first; falls back to <body>.
   * @param {string} html
   * @returns {string}
   * @private
   */
  _extractMainContent(html) {
    // Try <article> first
    const articleMatch = html.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i);
    if (articleMatch) return articleMatch[1];

    // Try <main>
    const mainMatch = html.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/i);
    if (mainMatch) return mainMatch[1];

    // Try <div role="main">
    const roleMatch = html.match(/<div[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/div>/i);
    if (roleMatch) return roleMatch[1];

    // Fallback: use <body> content
    const bodyMatch = html.match(/<body[\s\S]*?>([\s\S]*?)<\/body>/i);
    if (bodyMatch) return bodyMatch[1];

    // Last resort: return original input
    return html;
  }

  /**
   * Decode common HTML entities and numeric character references.
   * @param {string} text
   * @returns {string}
   * @private
   */
  _decodeEntities(text) {
    // Named entities
    for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
      text = text.split(entity).join(char);
    }

    // Numeric decimal references (&#123;)
    text = text.replace(/&#(\d+);/g, (match, code) => {
      return String.fromCharCode(parseInt(code, 10));
    });

    // Numeric hex references (&#x1A;)
    text = text.replace(/&#x([0-9a-f]+);/gi, (match, code) => {
      return String.fromCharCode(parseInt(code, 16));
    });

    return text;
  }
}

module.exports = { HtmlToTextAgent };
