/**
 * CsvToMdAgent
 *
 * @description Converts CSV data to Markdown tables. Supports basic tables,
 *   column-aligned tables with padded cells, and summary mode that appends
 *   an AI-generated paragraph summarizing the data.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/csv-to-md
 *
 * @strategies
 *   - simple  : Basic Markdown table with minimal formatting
 *   - aligned : Column-aligned table with padded cells for readability
 *   - summary : Markdown table followed by an AI-generated data summary paragraph
 *
 * @example
 *   const { CsvToMdAgent } = require('./csv-to-md');
 *   const agent = new CsvToMdAgent();
 *   const result = await agent.convert('name,age\nAlice,30\nBob,25');
 *   // result.output => '| name | age |\n| --- | --- |\n| Alice | 30 |...'
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');
const { getLogQueue } = require('./../log-event-queue');
const _log = getLogQueue();

class CsvToMdAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:csv-to-md';
    this.name = 'CSV to Markdown';
    this.description = 'Converts CSV data to Markdown tables with optional alignment and AI summary';
    this.from = ['csv'];
    this.to = ['md', 'markdown'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'simple',
        description: 'Basic Markdown table with pipe separators and minimal formatting',
        when: 'Quick table rendering with no special formatting requirements',
        engine: 'manual-builder',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Functional Markdown table',
      },
      {
        id: 'aligned',
        description: 'Column-aligned Markdown table with padded cells for visual readability',
        when: 'Output is intended for source-level reading, such as in a README or docs',
        engine: 'manual-builder',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Visually aligned and readable in raw Markdown',
      },
      {
        id: 'summary',
        description: 'Markdown table plus an AI-generated summary paragraph of the data',
        when: 'User wants a human-readable overview of what the data contains',
        engine: 'manual-builder + ai',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Table with contextual AI summary for comprehension',
      },
    ];
  }

  /**
   * Execute the CSV-to-Markdown conversion.
   *
   * @param {string} input - CSV content to convert
   * @param {string} strategy - Strategy ID: 'simple' | 'aligned' | 'summary'
   * @param {Object} [options] - Additional conversion options
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, _options = {}) {
    const start = Date.now();

    const rows = this._parseCsv(input);
    if (rows.length < 2) {
      throw new Error('CSV must contain at least a header row and one data row');
    }

    const headers = rows[0];
    const dataRows = rows.slice(1);
    let output;

    switch (strategy) {
      case 'simple': {
        const headerRow = '| ' + headers.join(' | ') + ' |';
        const separatorRow = '| ' + headers.map(() => '---').join(' | ') + ' |';
        const bodyRows = dataRows.map((row) => '| ' + headers.map((_, i) => row[i] || '').join(' | ') + ' |');
        output = [headerRow, separatorRow, ...bodyRows].join('\n');
        break;
      }

      case 'aligned': {
        // Calculate column widths
        const colWidths = headers.map((h, i) => {
          const values = [h, ...dataRows.map((row) => row[i] || '')];
          return Math.max(...values.map((v) => v.length));
        });

        const pad = (val, width) => val + ' '.repeat(Math.max(0, width - val.length));

        const headerRow = '| ' + headers.map((h, i) => pad(h, colWidths[i])).join(' | ') + ' |';
        const separatorRow = '| ' + colWidths.map((w) => '-'.repeat(w)).join(' | ') + ' |';
        const bodyRows = dataRows.map(
          (row) => '| ' + headers.map((_, i) => pad(row[i] || '', colWidths[i])).join(' | ') + ' |'
        );
        output = [headerRow, separatorRow, ...bodyRows].join('\n');
        break;
      }

      case 'summary': {
        // Build aligned table first
        const colWidths = headers.map((h, i) => {
          const values = [h, ...dataRows.map((row) => row[i] || '')];
          return Math.max(...values.map((v) => v.length));
        });

        const pad = (val, width) => val + ' '.repeat(Math.max(0, width - val.length));

        const headerRow = '| ' + headers.map((h, i) => pad(h, colWidths[i])).join(' | ') + ' |';
        const separatorRow = '| ' + colWidths.map((w) => '-'.repeat(w)).join(' | ') + ' |';
        const bodyRows = dataRows.map(
          (row) => '| ' + headers.map((_, i) => pad(row[i] || '', colWidths[i])).join(' | ') + ' |'
        );

        const table = [headerRow, separatorRow, ...bodyRows].join('\n');

        // Generate AI summary
        let summary = '';
        if (this._ai) {
          try {
            const sampleCsv = input.substring(0, 2000);
            const result = await this._ai.complete(
              `Summarize the following CSV data in 2-3 sentences. Focus on what the data represents, key patterns, and notable values. Do not use markdown formatting in your summary.

CSV data:
${sampleCsv}`,
              { profile: 'fast', feature: 'converter-csv-summary', temperature: 0.3 }
            );
            if (result && result.trim().length > 0) {
              summary = '\n\n' + result.trim();
            }
          } catch (err) {
            console.warn('[csv-to-md] AI summary generation failed:', err.message);
          }
        }

        output = table + summary;
        break;
      }

      default:
        throw new Error(`Unknown strategy: ${strategy}`);
    }

    return {
      output,
      metadata: {
        strategy,
        rowCount: dataRows.length,
        columnCount: headers.length,
        headers,
        inputLength: input.length,
        outputLength: output.length,
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  /**
   * Parse CSV text into an array of row arrays, handling quoted fields.
   *
   * @param {string} text - Raw CSV text
   * @returns {string[][]} Parsed rows
   * @private
   */
  _parseCsv(text) {
    const rows = [];
    let current = [];
    let field = '';
    let inQuotes = false;
    const len = text.length;

    for (let i = 0; i < len; i++) {
      const ch = text[i];
      const next = text[i + 1];

      if (inQuotes) {
        if (ch === '"' && next === '"') {
          field += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          current.push(field.trim());
          field = '';
        } else if (ch === '\n' || (ch === '\r' && next === '\n')) {
          current.push(field.trim());
          if (current.some((f) => f.length > 0)) {
            rows.push(current);
          }
          current = [];
          field = '';
          if (ch === '\r') i++;
        } else {
          field += ch;
        }
      }
    }

    current.push(field.trim());
    if (current.some((f) => f.length > 0)) {
      rows.push(current);
    }

    return rows;
  }

  /**
   * Structural checks for CSV-to-Markdown conversion output.
   *
   * Validates that the output is a non-empty string containing Markdown
   * table syntax (pipe characters and separator rows).
   *
   * @param {string} input - Original CSV input
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

    // Must contain pipe characters (table columns)
    if (!output.includes('|')) {
      issues.push({
        code: 'NO_TABLE_PIPES',
        severity: 'error',
        message: 'Output does not contain pipe characters; not a valid Markdown table',
        fixable: true,
      });
    }

    // Must contain separator row (|---|)
    if (!output.includes('---')) {
      issues.push({
        code: 'NO_SEPARATOR_ROW',
        severity: 'error',
        message: 'Output does not contain a separator row (---); not a valid Markdown table',
        fixable: true,
      });
    }

    return issues;
  }
}

module.exports = { CsvToMdAgent };
