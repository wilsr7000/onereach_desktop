/**
 * CodeToMdAgent
 *
 * @description Converts source code into Markdown. Supports wrapping code in
 *   fenced code blocks, adding AI-generated documentation, or splitting code
 *   into function-level sections.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/code-to-md
 *
 * @agent converter:code-to-md
 * @from code, py, js, ts
 * @to   md, markdown
 *
 * @modes symbolic
 *
 * @strategies
 *   - fenced     : Wrap source code in a Markdown fenced code block
 *   - documented : AI adds explanatory Markdown prose around the code
 *   - sectioned  : Split code by functions/classes into separate sections
 *
 * @evaluation
 *   Structural: output must be a non-empty string containing a code fence.
 *
 * @input  {string} Source code content.
 * @output {string} Markdown document.
 *
 * @example
 *   const { CodeToMdAgent } = require('./code-to-md');
 *   const agent = new CodeToMdAgent();
 *   const result = await agent.convert('function hello() { return "world"; }');
 *   // result.output => '```javascript\nfunction hello() ...\n```'
 *
 * @dependencies
 *   - lib/ai-service.js (for documented/sectioned strategies)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');
const { getLogQueue } = require('./../log-event-queue');
const _log = getLogQueue();

/**
 * Language detection heuristics based on common patterns.
 * @private
 */
const LANGUAGE_PATTERNS = [
  { lang: 'python', pattern: /^\s*(import\s+\w|from\s+\w|def\s+\w|class\s+\w.*:)/m },
  { lang: 'javascript', pattern: /^\s*(const\s+|let\s+|var\s+|function\s+|=>|module\.exports|require\()/m },
  { lang: 'typescript', pattern: /^\s*(interface\s+|type\s+\w+\s*=|:\s*(string|number|boolean)|<[A-Z]\w*>)/m },
  { lang: 'java', pattern: /^\s*(public\s+class|private\s+|protected\s+|package\s+\w)/m },
  { lang: 'go', pattern: /^\s*(package\s+\w+|func\s+\w+|import\s*\()/m },
  { lang: 'rust', pattern: /^\s*(fn\s+\w+|let\s+mut|use\s+\w+::|impl\s+)/m },
  { lang: 'ruby', pattern: /^\s*(require\s+'|def\s+\w+|class\s+\w+\s*<|end\s*$)/m },
  { lang: 'cpp', pattern: /^\s*(#include\s*<|namespace\s+\w+|std::)/m },
];

class CodeToMdAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:code-to-md';
    this.name = 'Code to Markdown';
    this.description = 'Converts source code into Markdown with code fences and optional documentation';
    this.from = ['code', 'py', 'js', 'ts'];
    this.to = ['md', 'markdown'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'fenced',
        description: 'Wrap code in a Markdown fenced code block with auto-detected language',
        when: 'Simple code embedding without explanation needed',
        engine: 'string templating',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Clean code block with proper language tag',
      },
      {
        id: 'documented',
        description: 'AI-generated Markdown documentation wrapping the code',
        when: 'Code needs explanation for readers who may not understand it',
        engine: 'llm + string templating',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Code with rich explanatory prose; educational quality',
      },
      {
        id: 'sectioned',
        description: 'Split code by functions/classes into separate Markdown sections',
        when: 'Code has multiple functions or classes; needs structured documentation',
        engine: 'llm + string templating',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Organized sections per function/class; API-doc style',
      },
    ];
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Convert source code into Markdown.
   *
   * @param {string} input - Source code
   * @param {string} strategy - Strategy ID: 'fenced' | 'documented' | 'sectioned'
   * @param {Object} [options] - Additional options
   * @param {string} [options.language] - Language hint
   * @param {string} [options.title] - Document title
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const startTime = Date.now();

    if (typeof input !== 'string' || input.trim().length === 0) {
      throw new Error('Input must be a non-empty string of source code');
    }

    const language = options.language || this._detectLanguage(input);

    let output;

    switch (strategy) {
      case 'fenced':
        output = this._buildFenced(input, language, options);
        break;
      case 'documented':
        output = await this._buildDocumented(input, language, options);
        break;
      case 'sectioned':
        output = await this._buildSectioned(input, language, options);
        break;
      default:
        output = this._buildFenced(input, language, options);
    }

    return {
      output,
      metadata: {
        strategy,
        language,
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
   * Validate Markdown output contains code fences.
   *
   * @param {string} input - Original code
   * @param {string} output - Markdown string
   * @param {string} strategy - Strategy used
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

    // Must contain a code fence
    if (!output.includes('```')) {
      issues.push({
        code: 'MISSING_CODE_FENCE',
        severity: 'error',
        message: 'Output does not contain a Markdown code fence',
        fixable: true,
      });
    }

    // For documented/sectioned, check for explanatory text
    if ((strategy === 'documented' || strategy === 'sectioned') && !output.includes('#')) {
      issues.push({
        code: 'MISSING_DOCUMENTATION',
        severity: 'warning',
        message: 'Documented/sectioned output has no Markdown headings',
        fixable: false,
      });
    }

    return issues;
  }

  // ===========================================================================
  // STRATEGY BUILDERS
  // ===========================================================================

  /**
   * Build simple fenced code block.
   * @private
   */
  _buildFenced(code, language, options) {
    const title = options.title || '';
    const lines = [];

    if (title) {
      lines.push(`# ${title}`, '');
    }

    lines.push(`\`\`\`${language}`, code, '```', '');

    return lines.join('\n');
  }

  /**
   * Build documented Markdown using AI to explain the code.
   * @private
   */
  async _buildDocumented(code, language, options) {
    if (!this._ai) {
      return this._buildFenced(code, language, options);
    }

    try {
      const result = await this._ai.complete(
        `Create a Markdown document that explains and documents the following ${language} code.

Include:
1. A title heading (# Title)
2. A brief overview paragraph explaining what the code does
3. The code in a fenced code block
4. A "How it works" section explaining key parts
5. Any notable patterns or considerations

Code:
\`\`\`${language}
${code}
\`\`\`

Return Markdown only.`,
        { profile: 'fast', feature: 'converter-code-documented', temperature: 0.3 }
      );

      if (result && result.trim().length > 0) {
        // Ensure it contains the original code
        if (!result.includes('```')) {
          return `${result}\n\n\`\`\`${language}\n${code}\n\`\`\`\n`;
        }
        return result;
      }
    } catch (err) {
      console.warn('[code-to-md] Documentation generation failed:', err.message);
    }

    return this._buildFenced(code, language, options);
  }

  /**
   * Build sectioned Markdown using AI to split by functions.
   * @private
   */
  async _buildSectioned(code, language, options) {
    if (!this._ai) {
      return this._buildFenced(code, language, options);
    }

    try {
      const result = await this._ai.complete(
        `Split this ${language} code into sections by function/class/method.
For each section, create a Markdown heading (## FunctionName) followed by:
1. A brief description of what it does
2. The relevant code in a fenced code block

If there are imports/globals, put them in a "## Setup" section.

Code:
\`\`\`${language}
${code}
\`\`\`

Return Markdown only.`,
        { profile: 'fast', feature: 'converter-code-sectioned', temperature: 0.2 }
      );

      if (result && result.includes('```')) {
        return result;
      }
    } catch (err) {
      console.warn('[code-to-md] Sectioned generation failed:', err.message);
    }

    return this._buildFenced(code, language, options);
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  /**
   * Detect programming language from code content.
   * @private
   */
  _detectLanguage(code) {
    for (const { lang, pattern } of LANGUAGE_PATTERNS) {
      if (pattern.test(code)) return lang;
    }
    return 'plaintext';
  }
}

module.exports = { CodeToMdAgent };
