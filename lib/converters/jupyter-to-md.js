/**
 * JupyterToMdAgent
 *
 * @description Converts Jupyter Notebook (.ipynb) JSON content to Markdown.
 *   Parses the notebook cell structure: code cells become fenced code blocks,
 *   markdown cells are output directly. Supports flat, sectioned, and
 *   output-inclusive conversion strategies.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/jupyter-to-md
 *
 * @strategies
 *   - flat        : Linear output of all cells in order
 *   - sectioned   : Inserts heading dividers between cell groups
 *   - with-output : Includes cell execution outputs as blockquotes
 *
 * @example
 *   const { JupyterToMdAgent } = require('./jupyter-to-md');
 *   const agent = new JupyterToMdAgent();
 *   const result = await agent.convert('{"nbformat":4,"cells":[...]}');
 *   // result.output => '# Title\n\n```python\nprint("hi")\n```\n'
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class JupyterToMdAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:jupyter-to-md';
    this.name = 'Jupyter Notebook to Markdown';
    this.description = 'Converts Jupyter Notebook (.ipynb) JSON to Markdown';
    this.from = ['ipynb'];
    this.to = ['md', 'markdown'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'flat',
        description: 'Linear output of all cells in document order',
        when: 'Simple sequential notebook that reads naturally top to bottom',
        engine: 'custom-parser',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Clean, minimal output',
      },
      {
        id: 'sectioned',
        description: 'Inserts horizontal rules and headings between cell groups',
        when: 'Notebook has logical sections that benefit from visual separation',
        engine: 'custom-parser',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Well-organized with clear section boundaries',
      },
      {
        id: 'with-output',
        description: 'Includes cell execution outputs as blockquotes after code cells',
        when: 'Preserving cell outputs is important for documentation or review',
        engine: 'custom-parser',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Complete representation including execution results',
      },
    ];
  }

  /**
   * Execute the Jupyter-to-Markdown conversion.
   *
   * @param {string} input - Jupyter notebook JSON string
   * @param {string} strategy - Strategy ID: 'flat' | 'sectioned' | 'with-output'
   * @param {Object} [options] - Additional conversion options
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, _options = {}) {
    const start = Date.now();

    // Parse the notebook JSON
    const notebook = typeof input === 'string' ? JSON.parse(input) : input;
    const cells = notebook.cells || [];
    const kernelLang = this._detectKernelLanguage(notebook);

    const parts = [];
    let cellGroup = 'start';

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const source = this._extractSource(cell);

      // For sectioned strategy, detect group transitions
      if (strategy === 'sectioned') {
        const newGroup = cell.cell_type;
        if (i > 0 && newGroup !== cellGroup) {
          parts.push('\n---\n');
        }
        cellGroup = newGroup;
      }

      if (cell.cell_type === 'markdown') {
        parts.push(source);
      } else if (cell.cell_type === 'code') {
        const lang = cell.metadata?.language || kernelLang || '';
        parts.push(`\`\`\`${lang}\n${source}\n\`\`\``);

        // Include outputs for with-output strategy
        if (strategy === 'with-output' && Array.isArray(cell.outputs) && cell.outputs.length > 0) {
          const outputText = this._formatOutputs(cell.outputs);
          if (outputText.trim().length > 0) {
            const quoted = outputText
              .split('\n')
              .map((line) => '> ' + line)
              .join('\n');
            parts.push('\n**Output:**\n' + quoted);
          }
        }
      } else if (cell.cell_type === 'raw') {
        parts.push('```\n' + source + '\n```');
      }
    }

    const output = parts
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return {
      output,
      metadata: {
        strategy,
        inputLength: typeof input === 'string' ? input.length : JSON.stringify(input).length,
        outputLength: output.length,
        cellCount: cells.length,
        kernelLanguage: kernelLang,
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  /**
   * Extract the text source from a notebook cell.
   *
   * Jupyter cells store source as either a string or array of strings.
   *
   * @param {Object} cell - Notebook cell object
   * @returns {string} Cell source content
   * @private
   */
  _extractSource(cell) {
    if (!cell.source) return '';
    if (typeof cell.source === 'string') return cell.source;
    if (Array.isArray(cell.source)) return cell.source.join('');
    return String(cell.source);
  }

  /**
   * Format cell outputs into readable text.
   *
   * Handles stream, execute_result, display_data, and error output types.
   *
   * @param {Object[]} outputs - Array of cell output objects
   * @returns {string} Formatted output text
   * @private
   */
  _formatOutputs(outputs) {
    const parts = [];

    for (const out of outputs) {
      if (out.output_type === 'stream') {
        const text = Array.isArray(out.text) ? out.text.join('') : out.text || '';
        parts.push(text);
      } else if (out.output_type === 'execute_result' || out.output_type === 'display_data') {
        const data = out.data || {};
        if (data['text/plain']) {
          const text = Array.isArray(data['text/plain']) ? data['text/plain'].join('') : data['text/plain'];
          parts.push(text);
        } else if (data['text/html']) {
          parts.push('[HTML output]');
        } else if (data['image/png'] || data['image/jpeg']) {
          parts.push('[Image output]');
        }
      } else if (out.output_type === 'error') {
        const traceback = Array.isArray(out.traceback) ? out.traceback.join('\n') : out.traceback || '';
        // Strip ANSI escape codes
        const clean = traceback.replace(/\x1b\[[0-9;]*m/g, '');
        parts.push(`Error: ${out.ename || 'Unknown'}: ${out.evalue || ''}\n${clean}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Detect the kernel language from notebook metadata.
   *
   * @param {Object} notebook - Parsed notebook object
   * @returns {string} Language identifier (default: 'python')
   * @private
   */
  _detectKernelLanguage(notebook) {
    const meta = notebook.metadata || {};
    if (meta.kernelspec && meta.kernelspec.language) {
      return meta.kernelspec.language;
    }
    if (meta.language_info && meta.language_info.name) {
      return meta.language_info.name;
    }
    return 'python';
  }

  /**
   * Structural checks for Jupyter-to-Markdown conversion output.
   *
   * Validates that the output is a non-empty string containing Markdown content.
   *
   * @param {string} input - Original notebook input
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

    // Verify we got some markdown-like content (headings, code fences, or plain text)
    const hasHeadings = /^#{1,6}\s/m.test(output);
    const hasCodeFences = /^```/m.test(output);
    const hasContent = output.trim().length > 10;

    if (!hasHeadings && !hasCodeFences && !hasContent) {
      issues.push({
        code: 'MINIMAL_CONTENT',
        severity: 'warning',
        message: 'Output contains very little recognizable Markdown content',
        fixable: true,
      });
    }

    // For with-output strategy, warn if no outputs were rendered
    if (strategy === 'with-output' && !output.includes('**Output:**')) {
      // Parse input to check if there were any outputs
      try {
        const nb = typeof input === 'string' ? JSON.parse(input) : input;
        const hasOutputs = (nb.cells || []).some(
          (c) => c.cell_type === 'code' && Array.isArray(c.outputs) && c.outputs.length > 0
        );
        if (hasOutputs) {
          issues.push({
            code: 'OUTPUTS_MISSING',
            severity: 'warning',
            message: 'with-output strategy was used but no outputs appear in the Markdown',
            fixable: true,
          });
        }
      } catch (_e) {
        // Ignore parse errors here
      }
    }

    return issues;
  }
}

module.exports = { JupyterToMdAgent };
