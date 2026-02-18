/**
 * UrlToHtmlAgent
 *
 * @description Fetches a URL and returns the raw HTML content. Supports
 *   standard HTTP fetch, Spaces API tab capture for richer results,
 *   and a cached mode that checks local cache before fetching.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/url-to-html
 *
 * @strategies
 *   - fetch       : Standard HTTP GET request to retrieve raw HTML
 *   - tab-capture : Uses Spaces API POST /api/capture-tab for rendered HTML
 *   - cached      : Checks local cache first, then falls back to fetch
 *
 * @example
 *   const { UrlToHtmlAgent } = require('./url-to-html');
 *   const agent = new UrlToHtmlAgent();
 *   const result = await agent.convert('https://example.com');
 *   // result.output => '<!DOCTYPE html><html>...'
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');
const { getLogQueue } = require('./../log-event-queue');
const _log = getLogQueue();

// In-memory cache for the cached strategy
const _htmlCache = new Map();

class UrlToHtmlAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   * @param {number} [config.cacheTtlMs] - Cache TTL in milliseconds (default: 5 minutes)
   * @param {string} [config.spacesApiBase] - Spaces API base URL (default: http://localhost:3811)
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:url-to-html';
    this.name = 'URL to HTML';
    this.description = 'Fetches a URL and returns the raw HTML via HTTP, Spaces API, or cache';
    this.from = ['url'];
    this.to = ['html'];
    this.modes = ['symbolic'];

    this._cacheTtlMs = config.cacheTtlMs || 5 * 60 * 1000;
    this._spacesApiBase = config.spacesApiBase || 'http://localhost:3811';

    this.strategies = [
      {
        id: 'fetch',
        description: 'Standard HTTP GET request to retrieve the raw HTML of a page',
        when: 'URL is publicly accessible and raw HTML source is sufficient',
        engine: 'fetch',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Raw server-rendered HTML; may miss JS-rendered content',
      },
      {
        id: 'tab-capture',
        description: 'Uses Spaces API to capture fully rendered HTML from a browser tab',
        when: 'Page uses client-side rendering and raw fetch would miss content',
        engine: 'spaces-api',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Fully rendered HTML including JS-generated content',
      },
      {
        id: 'cached',
        description: 'Returns cached HTML if available and fresh, otherwise fetches new',
        when: 'Same URL may be converted repeatedly and freshness is not critical',
        engine: 'fetch + cache',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Same as fetch, with caching for repeated requests',
      },
    ];
  }

  /**
   * Execute the URL-to-HTML conversion.
   *
   * @param {string} input - URL to fetch
   * @param {string} strategy - Strategy ID: 'fetch' | 'tab-capture' | 'cached'
   * @param {Object} [options] - Additional conversion options
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, _options = {}) {
    const start = Date.now();
    const url = input.trim();

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      throw new Error(`Invalid URL: must start with http:// or https://`);
    }

    let output;

    switch (strategy) {
      case 'fetch': {
        output = await this._fetchHtml(url);
        break;
      }

      case 'tab-capture': {
        output = await this._tabCapture(url);
        break;
      }

      case 'cached': {
        const cached = _htmlCache.get(url);
        if (cached && Date.now() - cached.timestamp < this._cacheTtlMs) {
          output = cached.html;
        } else {
          output = await this._fetchHtml(url);
          _htmlCache.set(url, { html: output, timestamp: Date.now() });
        }
        break;
      }

      default:
        throw new Error(`Unknown strategy: ${strategy}`);
    }

    return {
      output,
      metadata: {
        strategy,
        url,
        inputLength: url.length,
        outputLength: output.length,
        fromCache: strategy === 'cached' && _htmlCache.has(url),
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  /**
   * Fetch HTML content from a URL using built-in fetch or Node https.
   *
   * @param {string} url - URL to fetch
   * @returns {Promise<string>} Raw HTML content
   * @private
   */
  async _fetchHtml(url) {
    // Use global fetch if available (Node 18+), otherwise fall back to https
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

    // Fallback to Node https/http module
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
          // Follow redirects
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
   * Capture rendered HTML from a URL using the Spaces API.
   *
   * @param {string} url - URL to capture
   * @returns {Promise<string>} Rendered HTML content
   * @private
   */
  async _tabCapture(url) {
    const captureUrl = `${this._spacesApiBase}/api/capture-tab`;

    try {
      if (typeof globalThis.fetch === 'function') {
        const response = await globalThis.fetch(captureUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });

        if (!response.ok) {
          throw new Error(`Spaces API returned ${response.status}`);
        }

        const data = await response.json();
        return data.html || data.content || '';
      }
    } catch (err) {
      console.warn('[url-to-html] Tab capture failed, falling back to fetch:', err.message);
    }

    // Fallback to standard fetch
    return this._fetchHtml(url);
  }

  /**
   * Structural checks for URL-to-HTML conversion output.
   *
   * Validates that the output is a non-empty string containing HTML content.
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
        message: `Expected HTML string output, got ${typeof output}`,
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

    // Check for HTML content markers
    const hasHtml = /<html[\s>]/i.test(output);
    const hasBody = /<body[\s>]/i.test(output);
    const hasDiv = /<div[\s>]/i.test(output);

    if (!hasHtml && !hasBody && !hasDiv) {
      issues.push({
        code: 'NO_HTML_MARKERS',
        severity: 'warning',
        message: 'Output does not contain typical HTML markers (<html>, <body>, or <div>)',
        fixable: true,
        suggestedStrategy: 'tab-capture',
      });
    }

    return issues;
  }
}

module.exports = { UrlToHtmlAgent };
