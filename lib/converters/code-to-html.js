/**
 * CodeToHtmlAgent
 *
 * @description Converts source code into syntax-highlighted HTML using
 *   highlight.js. Supports auto-detection of language, themed output,
 *   and AI-annotated code with explanatory comments.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/code-to-html
 *
 * @agent converter:code-to-html
 * @from code, py, js, ts, java, cpp, rb, go, rs
 * @to   html
 *
 * @modes symbolic
 *
 * @strategies
 *   - highlight : Auto-detect language and apply syntax highlighting
 *   - themed    : Apply a specific highlight.js theme (options.theme)
 *   - annotated : AI adds explanatory comments before highlighting
 *
 * @evaluation
 *   Structural: output must be a non-empty string containing <code> or <pre>.
 *
 * @input  {string} Source code content.
 * @output {string} HTML with syntax-highlighted code.
 *
 * @example
 *   const { CodeToHtmlAgent } = require('./code-to-html');
const { getLogQueue } = require('./../log-event-queue');
const log = getLogQueue();
 *   const agent = new CodeToHtmlAgent();
 *   const result = await agent.convert('function hello() { return "world"; }');
 *   // result.output => '<html>...<pre><code class="hljs">...</code></pre>...</html>'
 *
 * @dependencies
 *   - highlight.js (syntax highlighting)
 *   - lib/ai-service.js (for annotated strategy)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

/**
 * Default CSS theme for syntax highlighting.
 * Based on highlight.js GitHub theme.
 * @private
 */
const DEFAULT_THEME_CSS = `
.hljs { display: block; overflow-x: auto; padding: 1em; background: #f6f8fa; color: #24292e; }
.hljs-comment, .hljs-quote { color: #6a737d; font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-subst { color: #d73a49; font-weight: 600; }
.hljs-number, .hljs-literal, .hljs-variable, .hljs-template-variable { color: #005cc5; }
.hljs-string, .hljs-doctag { color: #032f62; }
.hljs-title, .hljs-section, .hljs-selector-id { color: #6f42c1; font-weight: 600; }
.hljs-type, .hljs-class .hljs-title { color: #6f42c1; }
.hljs-tag, .hljs-name, .hljs-attribute { color: #22863a; }
.hljs-regexp, .hljs-link { color: #032f62; }
.hljs-symbol, .hljs-bullet { color: #e36209; }
.hljs-built_in, .hljs-builtin-name { color: #005cc5; }
.hljs-meta { color: #735c0f; }
.hljs-deletion { background: #ffeef0; color: #b31d28; }
.hljs-addition { background: #e6ffed; color: #22863a; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 600; }
`;

/**
 * Dark theme CSS.
 * @private
 */
const DARK_THEME_CSS = `
.hljs { display: block; overflow-x: auto; padding: 1em; background: #1e1e1e; color: #d4d4d4; }
.hljs-comment, .hljs-quote { color: #6a9955; font-style: italic; }
.hljs-keyword, .hljs-selector-tag { color: #569cd6; font-weight: 600; }
.hljs-number, .hljs-literal { color: #b5cea8; }
.hljs-string, .hljs-doctag { color: #ce9178; }
.hljs-title, .hljs-section { color: #dcdcaa; font-weight: 600; }
.hljs-type, .hljs-class .hljs-title { color: #4ec9b0; }
.hljs-tag, .hljs-name { color: #569cd6; }
.hljs-attribute { color: #9cdcfe; }
.hljs-regexp { color: #d16969; }
.hljs-built_in { color: #4ec9b0; }
.hljs-meta { color: #c586c0; }
`;

/**
 * Available themes.
 * @private
 */
const THEMES = {
  github: DEFAULT_THEME_CSS,
  dark: DARK_THEME_CSS,
};

class CodeToHtmlAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:code-to-html';
    this.name = 'Code to HTML';
    this.description = 'Converts source code into syntax-highlighted HTML';
    this.from = ['code', 'py', 'js', 'ts', 'java', 'cpp', 'rb', 'go', 'rs'];
    this.to = ['html'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'highlight',
        description: 'Auto-detect language and apply syntax highlighting with default theme',
        when: 'Standard code display; language is unknown or mixed',
        engine: 'highlight.js',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Accurate syntax highlighting with auto-detected language',
      },
      {
        id: 'themed',
        description: 'Syntax highlighting with a user-specified theme (dark, github)',
        when: 'User wants a specific visual theme for the code display',
        engine: 'highlight.js',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Themed syntax highlighting; consistent look with design system',
      },
      {
        id: 'annotated',
        description: 'AI adds explanatory comments to the code before highlighting',
        when: 'Code needs documentation or explanation for viewers',
        engine: 'highlight.js + llm',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Annotated, educational code display with inline explanations',
      },
    ];
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Convert source code into syntax-highlighted HTML.
   *
   * @param {string} input - Source code
   * @param {string} strategy - Strategy ID: 'highlight' | 'themed' | 'annotated'
   * @param {Object} [options] - Additional options
   * @param {string} [options.language] - Language hint
   * @param {string} [options.theme] - Theme name for 'themed' strategy
   * @param {string} [options.title] - Title for the HTML document
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const startTime = Date.now();

    if (typeof input !== 'string' || input.trim().length === 0) {
      throw new Error('Input must be a non-empty string of source code');
    }

    const hljs = require('highlight.js');

    let codeToHighlight = input;
    let detectedLanguage = options.language || null;

    // For annotated strategy, use AI to add comments first
    if (strategy === 'annotated' && this._ai) {
      try {
        const annotated = await this._ai.complete(
          `Add clear, concise inline comments to explain this code. 
Do not change the code logic — only add comments.
Return the annotated code only, no surrounding explanation.

${input}`,
          { profile: 'fast', feature: 'converter-code-annotate', temperature: 0.2 }
        );
        if (annotated && annotated.trim().length > 0) {
          codeToHighlight = annotated.trim();
          // Remove code fence if LLM wrapped it
          codeToHighlight = codeToHighlight.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
        }
      } catch (err) {
        console.warn('[code-to-html] Annotation failed, using original code:', err.message);
      }
    }

    // Highlight the code
    let result;
    if (detectedLanguage) {
      try {
        result = hljs.highlight(codeToHighlight, { language: detectedLanguage });
      } catch {
        result = hljs.highlightAuto(codeToHighlight);
      }
    } else {
      result = hljs.highlightAuto(codeToHighlight);
    }

    detectedLanguage = detectedLanguage || result.language || 'plaintext';

    // Select theme CSS
    const themeName = options.theme || (strategy === 'themed' ? 'dark' : 'github');
    const themeCss = THEMES[themeName] || DEFAULT_THEME_CSS;

    const title = options.title || `Code — ${detectedLanguage}`;

    const output = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${this._escHtml(title)}</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    margin: 0;
    padding: 2rem;
    background: ${themeName === 'dark' ? '#121212' : '#fafafa'};
    color: ${themeName === 'dark' ? '#e0e0e0' : '#24292e'};
  }
  .code-container {
    max-width: 900px;
    margin: 0 auto;
  }
  .code-header {
    font-size: 0.85em;
    color: ${themeName === 'dark' ? '#888' : '#6a737d'};
    padding: 0.5em 0;
    border-bottom: 1px solid ${themeName === 'dark' ? '#333' : '#e1e4e8'};
    margin-bottom: 1em;
  }
  pre {
    margin: 0;
    border-radius: 6px;
    font-family: 'SF Mono', 'Fira Code', 'Fira Mono', 'Roboto Mono', Consolas, monospace;
    font-size: 0.9em;
    line-height: 1.5;
  }
  ${themeCss}
</style>
</head>
<body>
<div class="code-container">
  <div class="code-header">Language: ${this._escHtml(detectedLanguage)}${strategy === 'annotated' ? ' (annotated)' : ''}</div>
  <pre><code class="hljs language-${this._escHtml(detectedLanguage)}">${result.value}</code></pre>
</div>
</body>
</html>`;

    return {
      output,
      metadata: {
        strategy,
        language: detectedLanguage,
        theme: themeName,
        annotated: strategy === 'annotated',
        inputLength: input.length,
        outputLength: output.length,
      },
      duration: Date.now() - startTime,
      strategy,
    };
  }

  // ===========================================================================
  // STRUCTURAL CHECKS
  // ===========================================================================

  /**
   * Validate HTML output contains code elements.
   *
   * @param {string} input - Original code
   * @param {string} output - HTML string
   * @param {string} strategy - Strategy used
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, _strategy) {
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

    // Must contain <code> or <pre> elements
    if (!output.includes('<code') && !output.includes('<pre')) {
      issues.push({
        code: 'MISSING_CODE_ELEMENT',
        severity: 'error',
        message: 'Output does not contain <code> or <pre> elements',
        fixable: true,
      });
    }

    // Check that hljs classes are present (syntax highlighting applied)
    if (!output.includes('hljs')) {
      issues.push({
        code: 'NO_SYNTAX_HIGHLIGHT',
        severity: 'warning',
        message: 'Output does not appear to have syntax highlighting classes',
        fixable: true,
      });
    }

    return issues;
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  /**
   * HTML-escape a string.
   * @private
   */
  _escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

module.exports = { CodeToHtmlAgent };
