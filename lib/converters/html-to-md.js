/**
 * HtmlToMdAgent
 *
 * @description Converts HTML content to Markdown using the TurndownService library.
 *   Supports standard conversion, semantic-aware conversion that preserves
 *   article/section structure, and aggressive cleanup mode.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/html-to-md
 *
 * @strategies
 *   - turndown  : Standard TurndownService conversion with defaults
 *   - semantic  : Preserves article/section/aside structure as headings and dividers
 *   - clean     : Aggressive cleanup stripping script, style, nav, footer before conversion
 *
 * @example
 *   const { HtmlToMdAgent } = require('./html-to-md');
 *   const agent = new HtmlToMdAgent();
 *   const result = await agent.convert('<h1>Hello</h1><p>World</p>');
 *   // result.output => '# Hello\n\nWorld'
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class HtmlToMdAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:html-to-md';
    this.name = 'HTML to Markdown';
    this.description = 'Converts HTML content to Markdown using TurndownService';
    this.from = ['html'];
    this.to = ['md', 'markdown'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'turndown',
        description: 'Standard TurndownService conversion with sensible defaults',
        when: 'Input is clean HTML content without excessive boilerplate',
        engine: 'turndown',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Good for well-structured HTML',
      },
      {
        id: 'semantic',
        description: 'Preserves semantic HTML5 elements as structural Markdown',
        when: 'Input uses article, section, aside, header, footer elements',
        engine: 'turndown',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'High fidelity for semantic HTML5 documents',
      },
      {
        id: 'clean',
        description: 'Aggressive cleanup: strips scripts, styles, nav, and non-content tags first',
        when: 'Input is a raw web page with navigation, ads, scripts, and other non-content elements',
        engine: 'turndown',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Best for noisy web pages, extracts main content',
      },
    ];
  }

  /**
   * Execute the HTML-to-Markdown conversion.
   *
   * @param {string} input - HTML content to convert
   * @param {string} strategy - Strategy ID: 'turndown' | 'semantic' | 'clean'
   * @param {Object} [options] - Additional conversion options
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const start = Date.now();
    const TurndownService = require('turndown');

    let html = input;
    let output;

    switch (strategy) {
      case 'clean': {
        // Aggressively strip non-content tags before conversion
        html = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<nav[\s\S]*?<\/nav>/gi, '')
          .replace(/<footer[\s\S]*?<\/footer>/gi, '')
          .replace(/<header[\s\S]*?<\/header>/gi, '')
          .replace(/<aside[\s\S]*?<\/aside>/gi, '')
          .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
          .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
          .replace(/<!--[\s\S]*?-->/g, '');

        const turndown = new TurndownService({
          headingStyle: 'atx',
          codeBlockStyle: 'fenced',
          bulletListMarker: '-',
          emDelimiter: '*',
          strongDelimiter: '**',
        });
        output = turndown.turndown(html);
        break;
      }

      case 'semantic': {
        const turndown = new TurndownService({
          headingStyle: 'atx',
          codeBlockStyle: 'fenced',
          bulletListMarker: '-',
          emDelimiter: '*',
          strongDelimiter: '**',
        });

        // Add rules to preserve semantic structure
        turndown.addRule('article', {
          filter: 'article',
          replacement(content, node) {
            return '\n\n---\n\n' + content.trim() + '\n\n---\n\n';
          },
        });

        turndown.addRule('section', {
          filter: 'section',
          replacement(content, node) {
            return '\n\n' + content.trim() + '\n\n';
          },
        });

        turndown.addRule('aside', {
          filter: 'aside',
          replacement(content, node) {
            const lines = content.trim().split('\n').map(l => '> ' + l).join('\n');
            return '\n\n' + lines + '\n\n';
          },
        });

        turndown.addRule('figure', {
          filter: 'figure',
          replacement(content, node) {
            return '\n\n' + content.trim() + '\n\n';
          },
        });

        output = turndown.turndown(html);
        break;
      }

      case 'turndown':
      default: {
        const turndown = new TurndownService({
          headingStyle: 'atx',
          codeBlockStyle: 'fenced',
          bulletListMarker: '-',
          emDelimiter: '*',
          strongDelimiter: '**',
        });
        output = turndown.turndown(html);
        break;
      }
    }

    // Normalize excessive blank lines
    output = output.replace(/\n{3,}/g, '\n\n').trim();

    return {
      output,
      metadata: {
        strategy,
        inputLength: input.length,
        outputLength: output.length,
        tagsStripped: strategy === 'clean',
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  /**
   * Structural checks for HTML-to-Markdown conversion output.
   *
   * Validates that the output is a non-empty string without remaining
   * block-level HTML tags (inline tags like <br> are acceptable).
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
        message: 'Markdown output is empty',
        fixable: true,
      });
      return issues;
    }

    // Check for remaining block-level HTML tags (inline tags are OK)
    const blockTags = /<\/?(?:div|table|thead|tbody|tr|td|th|ul|ol|li|p|h[1-6]|blockquote|pre|form|section|article|nav|header|footer|main|aside)\b[^>]*>/i;
    if (blockTags.test(output)) {
      issues.push({
        code: 'REMAINING_BLOCK_HTML',
        severity: 'warning',
        message: 'Output still contains block-level HTML tags that should have been converted',
        fixable: true,
        suggestedStrategy: 'clean',
      });
    }

    // Check for remaining script or style tags (always an error)
    if (/<script[\s\S]*?>/i.test(output) || /<style[\s\S]*?>/i.test(output)) {
      issues.push({
        code: 'REMAINING_SCRIPT_STYLE',
        severity: 'error',
        message: 'Output contains script or style tags that should have been removed',
        fixable: true,
        suggestedStrategy: 'clean',
      });
    }

    return issues;
  }
}

module.exports = { HtmlToMdAgent };
