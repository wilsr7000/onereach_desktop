/**
 * MdToJupyterAgent
 *
 * @description Converts Markdown content to Jupyter Notebook (.ipynb) JSON format.
 *   Parses Markdown into cells: fenced code blocks become code cells (with
 *   language detection from fence info strings), everything else becomes
 *   markdown cells. Builds a valid nbformat 4 notebook structure.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/md-to-jupyter
 *
 * @strategies
 *   - auto-cell   : Infers cell boundaries from code fences and content blocks
 *   - strict-fence : Only fenced code blocks become code cells; all else is markdown
 *   - annotated    : Adds metadata (tags, collapsed state) to cells based on content
 *
 * @example
 *   const { MdToJupyterAgent } = require('./md-to-jupyter');
 *   const agent = new MdToJupyterAgent();
 *   const result = await agent.convert('# Title\n\n```python\nprint("hi")\n```');
 *   // result.output => '{"nbformat":4,...,"cells":[...]}'
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class MdToJupyterAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:md-to-jupyter';
    this.name = 'Markdown to Jupyter Notebook';
    this.description = 'Converts Markdown content to Jupyter Notebook (.ipynb) JSON format';
    this.from = ['md', 'markdown'];
    this.to = ['ipynb'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'auto-cell',
        description: 'Infers cell boundaries from code fences and content structure',
        when: 'Input mixes prose and code blocks with clear separation',
        engine: 'custom-parser',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Good general-purpose cell detection',
      },
      {
        id: 'strict-fence',
        description: 'Only fenced code blocks become code cells; all other content becomes markdown cells',
        when: 'Input has explicit code fences and you want precise cell boundaries',
        engine: 'custom-parser',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Precise, no false positives on code detection',
      },
      {
        id: 'annotated',
        description: 'Adds metadata tags and collapse state to cells based on content analysis',
        when: 'Output notebook needs organized metadata for navigation and presentation',
        engine: 'custom-parser',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Rich metadata for notebook navigation',
      },
    ];
  }

  /**
   * Execute the Markdown-to-Jupyter conversion.
   *
   * @param {string} input - Markdown content to convert
   * @param {string} strategy - Strategy ID: 'auto-cell' | 'strict-fence' | 'annotated'
   * @param {Object} [options] - Additional conversion options
   * @param {string} [options.kernelLanguage='python'] - Default kernel language
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const start = Date.now();
    const kernelLanguage = options.kernelLanguage || 'python';
    const cells = this._parseCells(input, strategy);

    // Annotate cells with metadata if using annotated strategy
    if (strategy === 'annotated') {
      this._annotateCells(cells);
    }

    const notebook = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: {
          display_name: this._kernelDisplayName(kernelLanguage),
          language: kernelLanguage,
          name: kernelLanguage === 'python' ? 'python3' : kernelLanguage,
        },
        language_info: {
          name: kernelLanguage,
        },
      },
      cells,
    };

    const output = JSON.stringify(notebook, null, 2);

    return {
      output,
      metadata: {
        strategy,
        inputLength: input.length,
        outputLength: output.length,
        cellCount: cells.length,
        codeCellCount: cells.filter(c => c.cell_type === 'code').length,
        markdownCellCount: cells.filter(c => c.cell_type === 'markdown').length,
        kernelLanguage,
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  /**
   * Parse Markdown content into Jupyter notebook cells.
   *
   * @param {string} input - Markdown content
   * @param {string} strategy - Parsing strategy
   * @returns {Object[]} Array of notebook cell objects
   * @private
   */
  _parseCells(input, strategy) {
    const cells = [];
    const lines = input.split('\n');
    let currentBlock = [];
    let inCodeFence = false;
    let fenceLanguage = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fenceMatch = line.match(/^```(\w*)/);

      if (fenceMatch && !inCodeFence) {
        // Starting a code fence
        // Flush any accumulated markdown
        if (currentBlock.length > 0) {
          const content = currentBlock.join('\n').trim();
          if (content.length > 0) {
            cells.push(this._makeMarkdownCell(content));
          }
          currentBlock = [];
        }
        inCodeFence = true;
        fenceLanguage = fenceMatch[1] || '';
      } else if (/^```\s*$/.test(line) && inCodeFence) {
        // Ending a code fence
        const code = currentBlock.join('\n');
        cells.push(this._makeCodeCell(code, fenceLanguage));
        currentBlock = [];
        inCodeFence = false;
        fenceLanguage = '';
      } else if (inCodeFence) {
        currentBlock.push(line);
      } else {
        // For auto-cell strategy, split on headings to create separate cells
        if (strategy === 'auto-cell' && /^#{1,6}\s/.test(line) && currentBlock.length > 0) {
          const content = currentBlock.join('\n').trim();
          if (content.length > 0) {
            cells.push(this._makeMarkdownCell(content));
          }
          currentBlock = [line];
        } else {
          currentBlock.push(line);
        }
      }
    }

    // Flush remaining content
    if (currentBlock.length > 0) {
      const content = currentBlock.join('\n').trim();
      if (content.length > 0) {
        if (inCodeFence) {
          // Unclosed fence: treat as code
          cells.push(this._makeCodeCell(content, fenceLanguage));
        } else {
          cells.push(this._makeMarkdownCell(content));
        }
      }
    }

    return cells;
  }

  /**
   * Create a markdown cell object.
   *
   * @param {string} content - Cell content
   * @returns {Object} Notebook markdown cell
   * @private
   */
  _makeMarkdownCell(content) {
    return {
      cell_type: 'markdown',
      metadata: {},
      source: this._toSourceArray(content),
    };
  }

  /**
   * Create a code cell object.
   *
   * @param {string} content - Cell content
   * @param {string} [language=''] - Code language from fence info string
   * @returns {Object} Notebook code cell
   * @private
   */
  _makeCodeCell(content, language = '') {
    return {
      cell_type: 'code',
      execution_count: null,
      metadata: language ? { language } : {},
      outputs: [],
      source: this._toSourceArray(content),
    };
  }

  /**
   * Convert content to a Jupyter source array (lines ending with \n except the last).
   *
   * @param {string} content - Text content
   * @returns {string[]} Source array
   * @private
   */
  _toSourceArray(content) {
    const lines = content.split('\n');
    return lines.map((line, i) => (i < lines.length - 1 ? line + '\n' : line));
  }

  /**
   * Add metadata annotations to cells (for the 'annotated' strategy).
   *
   * @param {Object[]} cells - Array of notebook cells to annotate in-place
   * @private
   */
  _annotateCells(cells) {
    for (const cell of cells) {
      const source = cell.source.join('');
      const tags = [];

      if (cell.cell_type === 'markdown') {
        if (/^#\s/.test(source)) tags.push('title');
        else if (/^#{2,3}\s/.test(source)) tags.push('section');
        if (/^\s*[-*]\s/.test(source)) tags.push('list');
        if (/!\[/.test(source)) tags.push('has-images');
        if (/\[.*?\]\(.*?\)/.test(source)) tags.push('has-links');
      }

      if (cell.cell_type === 'code') {
        if (/import\s|from\s.*import|require\(/.test(source)) tags.push('imports');
        if (/def\s|function\s|class\s/.test(source)) tags.push('definition');
        if (/print\(|console\.log|display\(/.test(source)) tags.push('output');
        if (source.split('\n').length > 20) {
          cell.metadata.collapsed = true;
          tags.push('long');
        }
      }

      if (tags.length > 0) {
        cell.metadata.tags = tags;
      }
    }
  }

  /**
   * Get display name for a kernel language.
   *
   * @param {string} language - Language identifier
   * @returns {string} Display name
   * @private
   */
  _kernelDisplayName(language) {
    const names = {
      python: 'Python 3',
      javascript: 'JavaScript',
      typescript: 'TypeScript',
      r: 'R',
      julia: 'Julia',
      ruby: 'Ruby',
    };
    return names[language] || language;
  }

  /**
   * Structural checks for Markdown-to-Jupyter conversion output.
   *
   * Validates that the output is valid JSON with the expected nbformat
   * structure and a non-empty cells array.
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
        message: `Expected JSON string output, got ${typeof output}`,
        fixable: true,
      });
      return issues;
    }

    // Verify valid JSON
    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch (err) {
      issues.push({
        code: 'INVALID_JSON',
        severity: 'error',
        message: `Output is not valid JSON: ${err.message}`,
        fixable: true,
      });
      return issues;
    }

    // Verify nbformat field
    if (!parsed.nbformat) {
      issues.push({
        code: 'MISSING_NBFORMAT',
        severity: 'error',
        message: 'Output JSON is missing the nbformat field',
        fixable: true,
      });
    }

    // Verify cells array
    if (!Array.isArray(parsed.cells)) {
      issues.push({
        code: 'MISSING_CELLS',
        severity: 'error',
        message: 'Output JSON is missing the cells array',
        fixable: true,
      });
    } else if (parsed.cells.length === 0) {
      issues.push({
        code: 'EMPTY_CELLS',
        severity: 'warning',
        message: 'Notebook has zero cells',
        fixable: true,
      });
    }

    // Verify cell structure
    if (Array.isArray(parsed.cells)) {
      for (let i = 0; i < parsed.cells.length; i++) {
        const cell = parsed.cells[i];
        if (!cell.cell_type) {
          issues.push({
            code: 'CELL_MISSING_TYPE',
            severity: 'error',
            message: `Cell ${i} is missing cell_type field`,
            fixable: true,
          });
        }
        if (!Array.isArray(cell.source)) {
          issues.push({
            code: 'CELL_MISSING_SOURCE',
            severity: 'error',
            message: `Cell ${i} is missing source array`,
            fixable: true,
          });
        }
      }
    }

    return issues;
  }
}

module.exports = { MdToJupyterAgent };
