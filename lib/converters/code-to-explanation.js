/**
 * CodeToExplanationAgent
 *
 * @description Converts source code into a human-readable explanation using
 *   LLM. Supports high-level overviews, detailed line-by-line breakdowns,
 *   and tutorial-style explanations for educational use.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/code-to-explanation
 *
 * @agent converter:code-to-explanation
 * @from code, py, js, ts, java, cpp
 * @to   text, md
 *
 * @modes generative
 *
 * @strategies
 *   - overview      : High-level explanation of what the code does
 *   - line-by-line  : Detailed walkthrough of each significant line/block
 *   - tutorial      : Teaching-format explanation with concepts and examples
 *
 * @evaluation
 *   Structural: output must be a non-empty string longer than the original code
 *   (an explanation should add information, not compress it).
 *
 * @input  {string} Source code content.
 * @output {string} Plain text or Markdown explanation.
 *
 * @example
 *   const { CodeToExplanationAgent } = require('./code-to-explanation');
 *   const agent = new CodeToExplanationAgent();
 *   const result = await agent.convert('def fib(n):\n  if n <= 1: return n\n  return fib(n-1) + fib(n-2)');
 *   // result.output => 'This code implements a recursive Fibonacci function...'
 *
 * @dependencies
 *   - lib/ai-service.js (chat method for LLM explanation)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class CodeToExplanationAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:code-to-explanation';
    this.name = 'Code to Explanation';
    this.description = 'Converts source code into human-readable explanations using LLM';
    this.from = ['code', 'py', 'js', 'ts', 'java', 'cpp'];
    this.to = ['text', 'md'];
    this.modes = ['generative'];

    this.strategies = [
      {
        id: 'overview',
        description: 'High-level explanation of what the code does and why',
        when: 'Reader wants a quick understanding; code is not too complex',
        engine: 'llm-chat',
        mode: 'generative',
        speed: 'fast',
        quality: 'Concise summary; good for experienced developers reviewing unfamiliar code',
      },
      {
        id: 'line-by-line',
        description: 'Detailed walkthrough of each significant line or code block',
        when: 'Deep understanding needed; debugging or code review context',
        engine: 'llm-chat',
        mode: 'generative',
        speed: 'medium',
        quality: 'Thorough, detailed analysis of every meaningful code construct',
      },
      {
        id: 'tutorial',
        description: 'Teaching-format explanation with concepts, prerequisites, and examples',
        when: 'Reader is learning; educational context or documentation',
        engine: 'llm-chat',
        mode: 'generative',
        speed: 'medium',
        quality: 'Educational, pedagogically structured with progressive complexity',
      },
    ];
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Generate an explanation of the source code.
   *
   * @param {string} input - Source code
   * @param {string} strategy - Strategy ID: 'overview' | 'line-by-line' | 'tutorial'
   * @param {Object} [options] - Additional options
   * @param {string} [options.language] - Language hint
   * @param {string} [options.audience] - Target audience level ('beginner' | 'intermediate' | 'expert')
   * @param {string} [options.outputFormat] - 'text' or 'md' (default: 'md')
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const startTime = Date.now();

    if (!this._ai) {
      throw new Error('AI service is required for code-to-explanation conversion');
    }

    if (typeof input !== 'string' || input.trim().length === 0) {
      throw new Error('Input must be a non-empty string of source code');
    }

    const language = options.language || 'auto-detect';
    const audience = options.audience || 'intermediate';
    const outputFormat = options.outputFormat || 'md';

    let systemPrompt;
    let userPrompt;

    switch (strategy) {
      case 'overview':
        systemPrompt = `You are a senior software engineer explaining code to a colleague.
Provide a clear, high-level explanation of what this code does, its purpose, and key design decisions.
Be concise but thorough. ${outputFormat === 'md' ? 'Use Markdown formatting.' : 'Use plain text.'}`;
        userPrompt = `Explain this ${language !== 'auto-detect' ? language + ' ' : ''}code at a high level:

\`\`\`
${input}
\`\`\`

Audience level: ${audience}`;
        break;

      case 'line-by-line':
        systemPrompt = `You are a code reviewer providing a detailed walkthrough.
Go through the code systematically, explaining what each significant line or block does.
Group related lines together. Highlight important patterns, potential issues, and edge cases.
${outputFormat === 'md' ? 'Use Markdown formatting with code references.' : 'Use plain text.'}`;
        userPrompt = `Provide a detailed line-by-line explanation of this ${language !== 'auto-detect' ? language + ' ' : ''}code:

\`\`\`
${input}
\`\`\`

Audience level: ${audience}`;
        break;

      case 'tutorial':
        systemPrompt = `You are an expert programming instructor creating a tutorial.
Explain this code in a teaching format:
1. Start with prerequisites (what the reader should know)
2. Explain the overall purpose
3. Break down each concept used in the code
4. Walk through the implementation step by step
5. Provide key takeaways and possible exercises

${outputFormat === 'md' ? 'Use Markdown formatting with clear headings and code examples.' : 'Use plain text with clear sections.'}`;
        userPrompt = `Create a tutorial-style explanation of this ${language !== 'auto-detect' ? language + ' ' : ''}code:

\`\`\`
${input}
\`\`\`

Target audience: ${audience}`;
        break;

      default:
        systemPrompt = 'You are a helpful coding assistant. Explain the following code clearly.';
        userPrompt = `Explain this code:\n\n\`\`\`\n${input}\n\`\`\``;
    }

    const result = await this._ai.chat({
      profile: 'standard',
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 4000,
      temperature: 0.3,
      feature: 'converter-code-to-explanation',
    });

    const explanation = result?.content || result || '';

    if (typeof explanation !== 'string' || explanation.trim().length === 0) {
      throw new Error('LLM returned empty explanation');
    }

    return {
      output: explanation.trim(),
      metadata: {
        strategy,
        language,
        audience,
        outputFormat,
        inputLength: input.length,
        outputLength: explanation.length,
        expansionRatio: (explanation.length / input.length).toFixed(2),
      },
      duration: Date.now() - startTime,
      strategy,
    };
  }

  // ===========================================================================
  // STRUCTURAL CHECKS
  // ===========================================================================

  /**
   * Validate the explanation output.
   * An explanation should be longer than the original code.
   *
   * @param {string} input - Original code
   * @param {string} output - Explanation text
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
        message: 'Explanation output is empty',
        fixable: true,
      });
      return issues;
    }

    // Explanation should be longer than the code
    const inputLength = typeof input === 'string' ? input.length : 0;
    if (inputLength > 0 && output.length <= inputLength) {
      issues.push({
        code: 'EXPLANATION_TOO_SHORT',
        severity: 'warning',
        message: `Explanation (${output.length} chars) is not longer than the code (${inputLength} chars)`,
        fixable: true,
        suggestedStrategy: 'line-by-line',
      });
    }

    // For line-by-line and tutorial, check for structure
    if (strategy === 'line-by-line' || strategy === 'tutorial') {
      const lineCount = output.split('\n').length;
      if (lineCount < 5) {
        issues.push({
          code: 'INSUFFICIENT_DETAIL',
          severity: 'warning',
          message: `${strategy} explanation has only ${lineCount} lines — may lack detail`,
          fixable: true,
        });
      }
    }

    return issues;
  }
}

module.exports = { CodeToExplanationAgent };
