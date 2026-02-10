/**
 * MdToHtmlAgent
 *
 * @description Converts Markdown content to HTML using the `marked` library.
 *   Supports standard, enhanced (GFM, tables, footnotes), and styled
 *   (full HTML document with embedded CSS) conversion strategies.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/md-to-html
 *
 * @strategies
 *   - standard  : Default marked.parse() with sensible defaults
 *   - enhanced  : GFM, tables, line breaks enabled for richer output
 *   - styled    : Wraps output in a full HTML document with basic CSS
 *
 * @example
 *   const { MdToHtmlAgent } = require('./md-to-html');
 *   const agent = new MdToHtmlAgent();
 *   const result = await agent.convert('# Hello\nWorld');
 *   // result.output => '<h1>Hello</h1>\n<p>World</p>\n'
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class MdToHtmlAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:md-to-html';
    this.name = 'Markdown to HTML';
    this.description = 'Converts Markdown content to HTML using the marked library';
    this.from = ['md', 'markdown'];
    this.to = ['html'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'standard',
        description: 'Standard marked.parse() with default options',
        when: 'Input is well-formed Markdown without special extensions',
        engine: 'marked',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Good for typical Markdown documents',
      },
      {
        id: 'enhanced',
        description: 'Enhanced parsing with GFM tables, footnotes, and line breaks',
        when: 'Input uses GitHub-Flavored Markdown features like tables, task lists, or footnotes',
        engine: 'marked',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'High fidelity for GFM-style documents',
      },
      {
        id: 'styled',
        description: 'Full HTML document with embedded CSS stylesheet',
        when: 'Output needs to be a standalone viewable HTML page',
        engine: 'marked',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Complete standalone HTML document with clean typography',
      },
    ];
  }

  /**
   * Execute the Markdown-to-HTML conversion.
   *
   * @param {string} input - Markdown content to convert
   * @param {string} strategy - Strategy ID: 'standard' | 'enhanced' | 'styled'
   * @param {Object} [options] - Additional conversion options
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const start = Date.now();
    const { marked } = require('marked');

    let output;

    switch (strategy) {
      case 'enhanced': {
        marked.setOptions({
          gfm: true,
          tables: true,
          breaks: true,
          pedantic: false,
          smartypants: false,
        });
        output = marked.parse(input);
        break;
      }

      case 'styled': {
        marked.setOptions({
          gfm: true,
          tables: true,
          breaks: true,
        });
        const body = marked.parse(input);
        output = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Converted Document</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif;
    line-height: 1.6;
    max-width: 800px;
    margin: 0 auto;
    padding: 2rem;
    color: #24292e;
    background: #fff;
  }
  h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; font-weight: 600; }
  h1 { font-size: 2em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
  p { margin: 0.5em 0 1em; }
  code { background: #f6f8fa; padding: 0.2em 0.4em; border-radius: 3px; font-size: 0.9em; }
  pre { background: #f6f8fa; padding: 1em; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 4px solid #dfe2e5; margin: 0; padding: 0 1em; color: #6a737d; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #dfe2e5; padding: 0.5em 1em; text-align: left; }
  th { background: #f6f8fa; font-weight: 600; }
  img { max-width: 100%; height: auto; }
  a { color: #0366d6; text-decoration: none; }
  a:hover { text-decoration: underline; }
  ul, ol { padding-left: 2em; }
  hr { border: none; border-top: 1px solid #eaecef; margin: 2em 0; }
</style>
</head>
<body>
${body}
</body>
</html>`;
        break;
      }

      case 'standard':
      default: {
        marked.setOptions({
          gfm: false,
          tables: false,
          breaks: false,
          pedantic: false,
          smartypants: false,
        });
        output = marked.parse(input);
        break;
      }
    }

    return {
      output,
      metadata: {
        strategy,
        inputLength: input.length,
        outputLength: output.length,
        isFullDocument: strategy === 'styled',
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  /**
   * Structural checks for Markdown-to-HTML conversion output.
   *
   * Validates that the output is a non-empty string containing HTML tags.
   *
   * @param {string} input - Original Markdown input
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

    // Check that output contains at least one HTML tag
    const htmlTagPattern = /<[a-z][a-z0-9]*[\s>]/i;
    if (!htmlTagPattern.test(output)) {
      issues.push({
        code: 'NO_HTML_TAGS',
        severity: 'error',
        message: 'Output does not contain any HTML tags',
        fixable: true,
      });
    }

    // For styled strategy, verify full document structure
    if (strategy === 'styled') {
      if (!output.includes('<!DOCTYPE html>') && !output.includes('<html')) {
        issues.push({
          code: 'MISSING_DOCTYPE',
          severity: 'warning',
          message: 'Styled output missing DOCTYPE or html element',
          fixable: true,
        });
      }
      if (!output.includes('<style>') && !output.includes('<style ')) {
        issues.push({
          code: 'MISSING_STYLES',
          severity: 'warning',
          message: 'Styled output missing embedded CSS',
          fixable: true,
        });
      }
    }

    return issues;
  }
}

module.exports = { MdToHtmlAgent };
