/**
 * JupyterToPythonAgent
 *
 * @description Converts Jupyter Notebook (.ipynb) JSON into a Python script.
 *   Supports extracting only code cells, converting markdown cells to comments,
 *   and producing an executable script with import consolidation.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/jupyter-to-python
 *
 * @agent converter:jupyter-to-python
 * @from ipynb
 * @to   py, python
 *
 * @modes symbolic
 *
 * @strategies
 *   - code-only      : Extract only code cells, drop everything else
 *   - with-comments  : Convert markdown cells to Python comments
 *   - executable     : Consolidate imports at top and add if __name__ guard
 *
 * @evaluation
 *   Structural: output must be a non-empty string with valid Python syntax
 *   (no obvious structural errors).
 *
 * @input  {string|Object} Jupyter notebook JSON (string or parsed object).
 * @output {string} Python script.
 *
 * @example
 *   const { JupyterToPythonAgent } = require('./jupyter-to-python');
 *   const agent = new JupyterToPythonAgent();
 *   const result = await agent.convert(notebookJsonString);
 *   // result.output => '#!/usr/bin/env python3\nimport pandas as pd\n...'
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

/**
 * Regex to detect Python import statements.
 * @private
 */
const IMPORT_PATTERN = /^\s*(import\s+\S+|from\s+\S+\s+import\s+.+)$/;

class JupyterToPythonAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:jupyter-to-python';
    this.name = 'Jupyter to Python';
    this.description = 'Converts Jupyter Notebook (.ipynb) into a Python script';
    this.from = ['ipynb'];
    this.to = ['py', 'python'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'code-only',
        description: 'Extract only code cells, dropping markdown and output',
        when: 'Only the executable code is needed; documentation not required',
        engine: 'json-parser',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Clean code extraction; may lose context without comments',
      },
      {
        id: 'with-comments',
        description: 'Convert markdown cells to Python comments between code cells',
        when: 'Documentation context is important; code review or archival',
        engine: 'json-parser',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Code with contextual comments from notebook markdown',
      },
      {
        id: 'executable',
        description: 'Consolidate imports at top and wrap in if __name__ == "__main__" guard',
        when: 'Output needs to be a runnable Python script or module',
        engine: 'json-parser',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Production-ready Python script with proper structure',
      },
    ];
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Convert a Jupyter Notebook into a Python script.
   *
   * @param {string|Object} input - Notebook JSON (string or parsed)
   * @param {string} strategy - Strategy ID: 'code-only' | 'with-comments' | 'executable'
   * @param {Object} [options] - Additional options
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const startTime = Date.now();

    // Parse notebook JSON
    const notebook = this._parseNotebook(input);

    if (!notebook || !Array.isArray(notebook.cells)) {
      throw new Error('Invalid Jupyter Notebook: missing cells array');
    }

    let output;

    switch (strategy) {
      case 'code-only':
        output = this._buildCodeOnly(notebook);
        break;
      case 'with-comments':
        output = this._buildWithComments(notebook);
        break;
      case 'executable':
        output = this._buildExecutable(notebook);
        break;
      default:
        output = this._buildCodeOnly(notebook);
    }

    const cellCounts = this._countCells(notebook);

    return {
      output,
      metadata: {
        strategy,
        totalCells: notebook.cells.length,
        codeCells: cellCounts.code,
        markdownCells: cellCounts.markdown,
        rawCells: cellCounts.raw,
        outputLength: output.length,
        kernelLanguage: this._getKernelLanguage(notebook),
      },
      duration: Date.now() - startTime,
      strategy,
    };
  }

  // ===========================================================================
  // STRUCTURAL CHECKS
  // ===========================================================================

  /**
   * Validate Python output.
   *
   * @param {string|Object} input - Original notebook
   * @param {string} output - Python script
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
        message: 'Python output is empty',
        fixable: true,
      });
      return issues;
    }

    // Check for common Python syntax issues
    const syntaxIssues = this._checkPythonSyntax(output);
    issues.push(...syntaxIssues);

    // For executable strategy, verify __name__ guard
    if (strategy === 'executable') {
      if (!output.includes('__name__') || !output.includes('__main__')) {
        issues.push({
          code: 'MISSING_MAIN_GUARD',
          severity: 'warning',
          message: 'Executable strategy output missing if __name__ == "__main__" guard',
          fixable: true,
        });
      }
    }

    return issues;
  }

  // ===========================================================================
  // STRATEGY BUILDERS
  // ===========================================================================

  /**
   * Extract code cells only.
   * @private
   */
  _buildCodeOnly(notebook) {
    const lines = ['#!/usr/bin/env python3', ''];
    const codeCells = notebook.cells.filter(c => c.cell_type === 'code');

    for (let i = 0; i < codeCells.length; i++) {
      const source = this._getCellSource(codeCells[i]);
      if (source.trim().length === 0) continue;

      lines.push(source);
      lines.push('');
    }

    return lines.join('\n').trimEnd() + '\n';
  }

  /**
   * Convert with markdown cells as comments.
   * @private
   */
  _buildWithComments(notebook) {
    const lines = ['#!/usr/bin/env python3', ''];

    for (const cell of notebook.cells) {
      const source = this._getCellSource(cell);
      if (source.trim().length === 0) continue;

      if (cell.cell_type === 'markdown') {
        // Convert markdown to Python comments
        const commentLines = source.split('\n').map(line => {
          const trimmed = line.trimEnd();
          return trimmed.length > 0 ? `# ${trimmed}` : '#';
        });
        lines.push(...commentLines);
        lines.push('');
      } else if (cell.cell_type === 'code') {
        lines.push(source);
        lines.push('');
      }
      // Skip raw cells
    }

    return lines.join('\n').trimEnd() + '\n';
  }

  /**
   * Build executable script with consolidated imports and __name__ guard.
   * @private
   */
  _buildExecutable(notebook) {
    const imports = new Set();
    const setupCode = [];
    const mainCode = [];

    for (const cell of notebook.cells) {
      if (cell.cell_type !== 'code') continue;

      const source = this._getCellSource(cell);
      if (source.trim().length === 0) continue;

      const cellLines = source.split('\n');

      for (const line of cellLines) {
        if (IMPORT_PATTERN.test(line)) {
          imports.add(line.trim());
        } else {
          mainCode.push(line);
        }
      }

      // Add blank line between cells
      mainCode.push('');
    }

    // Build the script
    const lines = ['#!/usr/bin/env python3', '"""', `Converted from Jupyter Notebook.`, '"""', ''];

    // Consolidated imports
    if (imports.size > 0) {
      // Sort: stdlib imports first, then third-party
      const importList = [...imports].sort((a, b) => {
        const aIsFrom = a.startsWith('from');
        const bIsFrom = b.startsWith('from');
        if (aIsFrom !== bIsFrom) return aIsFrom ? 1 : -1;
        return a.localeCompare(b);
      });

      for (const imp of importList) {
        lines.push(imp);
      }
      lines.push('');
    }

    // Functions and class definitions go outside main guard
    const { definitions, executable } = this._separateDefinitions(mainCode);

    if (definitions.length > 0) {
      lines.push('');
      lines.push(...definitions);
    }

    // Main guard
    lines.push('');
    lines.push('if __name__ == "__main__":');

    if (executable.length > 0) {
      // Indent executable code
      for (const line of executable) {
        const trimmed = line;
        if (trimmed.trim().length === 0) {
          lines.push('');
        } else {
          lines.push(`    ${trimmed}`);
        }
      }
    } else {
      lines.push('    pass');
    }

    lines.push('');

    return lines.join('\n');
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  /**
   * Parse notebook from string or return as-is if already an object.
   * @private
   */
  _parseNotebook(input) {
    if (typeof input === 'string') {
      try {
        return JSON.parse(input);
      } catch (err) {
        throw new Error(`Failed to parse Jupyter Notebook JSON: ${err.message}`);
      }
    }
    if (input && typeof input === 'object') {
      return input;
    }
    throw new Error('Input must be a Jupyter Notebook JSON string or object');
  }

  /**
   * Get cell source as a single string.
   * Jupyter cells can have source as a string or array of strings.
   * @private
   */
  _getCellSource(cell) {
    const source = cell.source;
    if (typeof source === 'string') return source;
    if (Array.isArray(source)) return source.join('');
    return '';
  }

  /**
   * Count cells by type.
   * @private
   */
  _countCells(notebook) {
    const counts = { code: 0, markdown: 0, raw: 0 };
    for (const cell of notebook.cells) {
      if (cell.cell_type === 'code') counts.code++;
      else if (cell.cell_type === 'markdown') counts.markdown++;
      else if (cell.cell_type === 'raw') counts.raw++;
    }
    return counts;
  }

  /**
   * Get the kernel language from notebook metadata.
   * @private
   */
  _getKernelLanguage(notebook) {
    return notebook?.metadata?.kernelspec?.language ||
           notebook?.metadata?.language_info?.name ||
           'python';
  }

  /**
   * Separate function/class definitions from executable code.
   * @private
   */
  _separateDefinitions(lines) {
    const definitions = [];
    const executable = [];
    let inDefinition = false;
    let defIndent = 0;

    for (const line of lines) {
      const trimmed = line.trim();

      // Detect function/class definition start
      if (/^(def |class |async def )/.test(trimmed)) {
        inDefinition = true;
        defIndent = line.length - line.trimStart().length;
        definitions.push(line);
        continue;
      }

      if (inDefinition) {
        // Check if we're still inside the definition (indented or blank)
        const currentIndent = line.length - line.trimStart().length;
        if (trimmed.length === 0 || currentIndent > defIndent) {
          definitions.push(line);
          continue;
        }
        // We've left the definition
        inDefinition = false;
        definitions.push('');
      }

      executable.push(line);
    }

    return { definitions, executable };
  }

  /**
   * Basic Python syntax checks.
   * @private
   */
  _checkPythonSyntax(code) {
    const issues = [];

    // Check for unmatched parentheses
    let parenCount = 0;
    let bracketCount = 0;
    let braceCount = 0;
    let inString = false;
    let stringChar = '';

    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      const prev = i > 0 ? code[i - 1] : '';

      if (inString) {
        if (ch === stringChar && prev !== '\\') inString = false;
        continue;
      }

      if ((ch === '"' || ch === "'") && prev !== '\\') {
        // Check for triple quotes
        if (code.substring(i, i + 3) === ch.repeat(3)) {
          const endIdx = code.indexOf(ch.repeat(3), i + 3);
          if (endIdx > -1) {
            i = endIdx + 2;
            continue;
          }
        }
        inString = true;
        stringChar = ch;
        continue;
      }

      if (ch === '#') {
        // Skip to end of line
        const newline = code.indexOf('\n', i);
        i = newline > -1 ? newline : code.length;
        continue;
      }

      if (ch === '(') parenCount++;
      if (ch === ')') parenCount--;
      if (ch === '[') bracketCount++;
      if (ch === ']') bracketCount--;
      if (ch === '{') braceCount++;
      if (ch === '}') braceCount--;
    }

    if (parenCount !== 0) {
      issues.push({
        code: 'UNMATCHED_PARENS',
        severity: 'warning',
        message: `Unmatched parentheses (balance: ${parenCount})`,
        fixable: false,
      });
    }

    if (bracketCount !== 0) {
      issues.push({
        code: 'UNMATCHED_BRACKETS',
        severity: 'warning',
        message: `Unmatched brackets (balance: ${bracketCount})`,
        fixable: false,
      });
    }

    if (braceCount !== 0) {
      issues.push({
        code: 'UNMATCHED_BRACES',
        severity: 'warning',
        message: `Unmatched braces (balance: ${braceCount})`,
        fixable: false,
      });
    }

    return issues;
  }
}

module.exports = { JupyterToPythonAgent };
