/**
 * UrlToMdAgent
 *
 * @description Fetches a URL and converts the HTML content to Markdown.
 *   Supports readability mode (extract article content), full page conversion,
 *   and AI-selective mode that identifies the main content area.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/url-to-md
 *
 * @strategies
 *   - readability : Extracts article/main content before converting to Markdown
 *   - full        : Converts the entire page HTML to Markdown
 *   - selective   : AI identifies and extracts the main content area
 *
 * @example
 *   const { UrlToMdAgent } = require('./url-to-md');
 *   const agent = new UrlToMdAgent();
 *   const result = await agent.convert('https://example.com/article');
 *   // result.output => '# Article Title\n\nArticle content...'
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');
const { getLogQueue } = require('./../log-event-queue');
const _log = getLogQueue();

class UrlToMdAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:url-to-md';
    this.name = 'URL to Markdown';
    this.description = 'Fetches a URL and converts its HTML to Markdown with readability, full, or AI-selective modes';
    this.from = ['url'];
    this.to = ['md', 'markdown'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'readability',
        description: 'Extracts article/main content area before converting to Markdown',
        when: 'URL points to an article, blog post, or documentation page',
        engine: 'turndown',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Clean article content without navigation or chrome',
      },
      {
        id: 'full',
        description: 'Converts the entire page HTML to Markdown without filtering',
        when: 'Full page content is needed, including navigation and sidebars',
        engine: 'turndown',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Complete page conversion; may include noisy navigation elements',
      },
      {
        id: 'selective',
        description: 'AI identifies the main content region and converts only that',
        when: 'Page structure is non-standard and heuristic extraction may fail',
        engine: 'turndown + ai',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'AI-curated content selection for best relevance',
      },
    ];
  }

  /**
   * Execute the URL-to-Markdown conversion.
   *
   * @param {string} input - URL to fetch and convert
   * @param {string} strategy - Strategy ID: 'readability' | 'full' | 'selective'
   * @param {Object} [options] - Additional conversion options
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, _options = {}) {
    const start = Date.now();
    const url = input.trim();

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      throw new Error(`Invalid URL: must start with http:// or https://`);
    }

    // Fetch the HTML
    const html = await this._fetchHtml(url);
    const TurndownService = require('turndown');
    let output;

    switch (strategy) {
      case 'readability': {
        // Extract article/main content before converting
        let contentHtml = this._extractArticleContent(html);
        contentHtml = this._stripNonContent(contentHtml);

        const turndown = new TurndownService({
          headingStyle: 'atx',
          codeBlockStyle: 'fenced',
          bulletListMarker: '-',
        });
        output = turndown.turndown(contentHtml);
        break;
      }

      case 'full': {
        // Strip scripts/styles but keep everything else
        const cleanHtml = this._stripNonContent(html);

        const turndown = new TurndownService({
          headingStyle: 'atx',
          codeBlockStyle: 'fenced',
          bulletListMarker: '-',
        });
        output = turndown.turndown(cleanHtml);
        break;
      }

      case 'selective': {
        // Use AI to identify main content
        const cleanHtml = this._stripNonContent(html);
        let contentHtml = cleanHtml;

        if (this._ai) {
          try {
            const htmlSample = cleanHtml.substring(0, 5000);
            const result = await this._ai.chat({
              profile: 'fast',
              feature: 'converter-url-selective',
              temperature: 0,
              messages: [
                {
                  role: 'user',
                  content: `Analyze this HTML and identify the main content area. Extract just the primary content HTML, removing navigation, headers, footers, sidebars, and ads. Return ONLY the HTML of the main content, no explanation.

HTML:
${htmlSample}`,
                },
              ],
            });

            if (result && result.content && result.content.trim().length > 50) {
              contentHtml = result.content.trim();
            }
          } catch (err) {
            console.warn('[url-to-md] AI selective extraction failed:', err.message);
          }
        }

        const turndown = new TurndownService({
          headingStyle: 'atx',
          codeBlockStyle: 'fenced',
          bulletListMarker: '-',
        });
        output = turndown.turndown(contentHtml);
        break;
      }

      default:
        throw new Error(`Unknown strategy: ${strategy}`);
    }

    // Normalize excessive blank lines
    output = output.replace(/\n{3,}/g, '\n\n').trim();

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
   * Looks for <article>, <main>, or role="main" elements.
   *
   * @param {string} html - Full HTML content
   * @returns {string} Extracted content HTML or full HTML if no article found
   * @private
   */
  _extractArticleContent(html) {
    // Try to find <article> content
    const articleMatch = html.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i);
    if (articleMatch) return articleMatch[1];

    // Try <main> content
    const mainMatch = html.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/i);
    if (mainMatch) return mainMatch[1];

    // Try role="main"
    const roleMainMatch = html.match(/<[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/\w+>/i);
    if (roleMainMatch) return roleMainMatch[1];

    // Try common content container IDs/classes
    const contentMatch = html.match(
      /<div[^>]+(?:id|class)=["'][^"']*(?:content|article|post|entry)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
    );
    if (contentMatch) return contentMatch[1];

    // Fallback: return body content
    const bodyMatch = html.match(/<body[\s\S]*?>([\s\S]*?)<\/body>/i);
    if (bodyMatch) return bodyMatch[1];

    return html;
  }

  /**
   * Strip non-content elements (script, style, nav, footer, etc.) from HTML.
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
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');
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
          Accept: 'text/html,application/xhtml+xml,*/*',
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
      const req = lib.get(
        url,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; ConverterAgent/1.0)',
            Accept: 'text/html,application/xhtml+xml,*/*',
          },
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return this._fetchHtml(res.headers.location).then(resolve).catch(reject);
          }
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
            return;
          }
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
          res.on('error', reject);
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Structural checks for URL-to-Markdown conversion output.
   *
   * Validates that the output is a non-empty Markdown string without
   * remaining HTML tags.
   *
   * @param {string} input - Original URL input
   * @param {*} output - Conversion output to validate
   * @param {string} strategy - Strategy that was used
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, _strategy) {
    const issues = [];

    if (typeof output !== 'string') {
      issues.push({
        code: 'OUTPUT_NOT_STRING',
        severity: 'error',
        message: `Expected Markdown string output, got ${typeof output}`,
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

    // Check for remaining block-level HTML tags
    const blockTags =
      /<\/?(?:div|table|thead|tbody|tr|td|th|ul|ol|li|p|h[1-6]|blockquote|pre|form|section|article|nav|header|footer|main|aside)\b[^>]*>/i;
    if (blockTags.test(output)) {
      issues.push({
        code: 'REMAINING_HTML_TAGS',
        severity: 'warning',
        message: 'Output still contains block-level HTML tags',
        fixable: true,
        suggestedStrategy: 'full',
      });
    }

    // Check for remaining script/style
    if (/<script[\s\S]*?>/i.test(output) || /<style[\s\S]*?>/i.test(output)) {
      issues.push({
        code: 'REMAINING_SCRIPT_STYLE',
        severity: 'error',
        message: 'Output contains script or style tags',
        fixable: true,
      });
    }

    return issues;
  }
}

module.exports = { UrlToMdAgent };
