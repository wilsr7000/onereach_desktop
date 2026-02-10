/**
 * UrlToTextAgent
 *
 * @description Fetches a URL and extracts plain text content. Supports
 *   article-focused extraction (main content only), full page text, and
 *   structured mode that preserves heading hierarchy.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/url-to-text
 *
 * @strategies
 *   - article    : Extracts main content (article/main) and strips all tags
 *   - full       : Extracts all visible text from the entire page
 *   - structured : Preserves heading hierarchy with indentation and markers
 *
 * @example
 *   const { UrlToTextAgent } = require('./url-to-text');
 *   const agent = new UrlToTextAgent();
 *   const result = await agent.convert('https://example.com');
 *   // result.output => 'Example Domain\n\nThis domain is for use in...'
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class UrlToTextAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:url-to-text';
    this.name = 'URL to Text';
    this.description = 'Fetches a URL and extracts plain text with article, full, or structured modes';
    this.from = ['url'];
    this.to = ['text'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'article',
        description: 'Extracts the main article/content area and strips all HTML to plain text',
        when: 'URL points to an article or blog post and only the body content is needed',
        engine: 'manual-parser',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Clean article text without navigation or chrome',
      },
      {
        id: 'full',
        description: 'Strips all HTML tags from the entire page and returns plain text',
        when: 'All visible text on the page is needed, including navigation and footer',
        engine: 'manual-parser',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Complete text extraction; may include noisy elements',
      },
      {
        id: 'structured',
        description: 'Preserves heading hierarchy with markers (## H2, ### H3) and paragraph breaks',
        when: 'Document structure matters and headings should remain identifiable',
        engine: 'manual-parser',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Structured text with heading levels preserved',
      },
    ];
  }

  /**
   * Execute the URL-to-text conversion.
   *
   * @param {string} input - URL to fetch and extract text from
   * @param {string} strategy - Strategy ID: 'article' | 'full' | 'structured'
   * @param {Object} [options] - Additional conversion options
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const start = Date.now();
    const url = input.trim();

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      throw new Error(`Invalid URL: must start with http:// or https://`);
    }

    // Fetch the HTML
    const html = await this._fetchHtml(url);
    let output;

    switch (strategy) {
      case 'article': {
        const contentHtml = this._extractArticleContent(html);
        output = this._htmlToPlainText(contentHtml);
        break;
      }

      case 'full': {
        // Strip non-content tags but keep everything else
        const cleanHtml = this._stripNonContent(html);
        output = this._htmlToPlainText(cleanHtml);
        break;
      }

      case 'structured': {
        const cleanHtml = this._stripNonContent(html);
        output = this._htmlToStructuredText(cleanHtml);
        break;
      }

      default:
        throw new Error(`Unknown strategy: ${strategy}`);
    }

    // Normalize whitespace
    output = output
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();

    return {
      output,
      metadata: {
        strategy,
        url,
        htmlLength: html.length,
        outputLength: output.length,
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  /**
   * Extract article or main content from HTML.
   *
   * @param {string} html - Full HTML content
   * @returns {string} Extracted content HTML
   * @private
   */
  _extractArticleContent(html) {
    const articleMatch = html.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i);
    if (articleMatch) return articleMatch[1];

    const mainMatch = html.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/i);
    if (mainMatch) return mainMatch[1];

    const roleMainMatch = html.match(/<[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/\w+>/i);
    if (roleMainMatch) return roleMainMatch[1];

    const bodyMatch = html.match(/<body[\s\S]*?>([\s\S]*?)<\/body>/i);
    if (bodyMatch) return bodyMatch[1];

    return html;
  }

  /**
   * Strip non-content elements from HTML.
   *
   * @param {string} html - HTML content
   * @returns {string} Cleaned HTML
   * @private
   */
  _stripNonContent(html) {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');
  }

  /**
   * Convert HTML to plain text by stripping all tags and decoding entities.
   *
   * @param {string} html - HTML content
   * @returns {string} Plain text
   * @private
   */
  _htmlToPlainText(html) {
    let text = html;

    // Add line breaks for block elements
    text = text.replace(/<\/(?:p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/(?:td|th)[^>]*>/gi, '\t');

    // Strip all remaining tags
    text = text.replace(/<[^>]+>/g, '');

    // Decode common HTML entities
    text = this._decodeEntities(text);

    return text;
  }

  /**
   * Convert HTML to structured text preserving heading hierarchy.
   *
   * @param {string} html - HTML content
   * @returns {string} Structured text with heading markers
   * @private
   */
  _htmlToStructuredText(html) {
    let text = html;

    // Convert headings to structured markers
    text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, content) => '\n# ' + content.replace(/<[^>]+>/g, '').trim() + '\n');
    text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, content) => '\n## ' + content.replace(/<[^>]+>/g, '').trim() + '\n');
    text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, content) => '\n### ' + content.replace(/<[^>]+>/g, '').trim() + '\n');
    text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, content) => '\n#### ' + content.replace(/<[^>]+>/g, '').trim() + '\n');
    text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, (_, content) => '\n##### ' + content.replace(/<[^>]+>/g, '').trim() + '\n');
    text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, (_, content) => '\n###### ' + content.replace(/<[^>]+>/g, '').trim() + '\n');

    // Add line breaks for block elements
    text = text.replace(/<\/(?:p|div|li|tr|br|hr)[^>]*>/gi, '\n');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/(?:td|th)[^>]*>/gi, '\t');

    // Convert list items
    text = text.replace(/<li[^>]*>/gi, '  - ');

    // Strip all remaining tags
    text = text.replace(/<[^>]+>/g, '');

    // Decode entities
    text = this._decodeEntities(text);

    return text;
  }

  /**
   * Decode common HTML entities.
   *
   * @param {string} text - Text with HTML entities
   * @returns {string} Decoded text
   * @private
   */
  _decodeEntities(text) {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&mdash;/g, '\u2014')
      .replace(/&ndash;/g, '\u2013')
      .replace(/&hellip;/g, '\u2026')
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
  }

  /**
   * Fetch HTML content from a URL.
   *
   * @param {string} url - URL to fetch
   * @returns {Promise<string>} Raw HTML content
   * @private
   */
  async _fetchHtml(url) {
    if (typeof globalThis.fetch === 'function') {
      const response = await globalThis.fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ConverterAgent/1.0)',
          'Accept': 'text/html,application/xhtml+xml,*/*',
        },
        redirect: 'follow',
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.text();
    }

    return new Promise((resolve, reject) => {
      const lib = url.startsWith('https') ? require('https') : require('http');
      const req = lib.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ConverterAgent/1.0)',
          'Accept': 'text/html,application/xhtml+xml,*/*',
        },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return this._fetchHtml(res.headers.location).then(resolve).catch(reject);
        }
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
          return;
        }
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Structural checks for URL-to-text conversion output.
   *
   * Validates that the output is a non-empty plain text string without
   * remaining HTML tags.
   *
   * @param {string} input - Original URL input
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
        message: `Expected plain text string output, got ${typeof output}`,
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

    // Check for remaining HTML tags (heading markers in structured mode are OK)
    const htmlTagPattern = /<\/?[a-z][a-z0-9]*\b[^>]*>/i;
    if (htmlTagPattern.test(output)) {
      issues.push({
        code: 'REMAINING_HTML_TAGS',
        severity: 'warning',
        message: 'Output still contains HTML tags that should have been stripped',
        fixable: true,
      });
    }

    return issues;
  }
}

module.exports = { UrlToTextAgent };
