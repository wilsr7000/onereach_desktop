/**
 * JsonToCsvAgent
 *
 * @description Converts JSON arrays of objects to CSV format. Supports flat
 *   output with dot-notation for nested fields, top-level-only extraction,
 *   and AI-driven column selection for the most relevant fields.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/json-to-csv
 *
 * @strategies
 *   - flat           : Flattens nested objects with dot-notation column names
 *   - top-level      : Only exports top-level keys, skipping nested objects/arrays
 *   - custom-columns : AI selects the most relevant columns for the output
 *
 * @example
 *   const { JsonToCsvAgent } = require('./json-to-csv');
 *   const agent = new JsonToCsvAgent();
 *   const result = await agent.convert('[{"name":"Alice","age":30}]');
 *   // result.output => 'name,age\nAlice,30'
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');
const { getLogQueue } = require('./../log-event-queue');
const log = getLogQueue();

class JsonToCsvAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:json-to-csv';
    this.name = 'JSON to CSV';
    this.description = 'Converts JSON arrays to CSV with flat, top-level, or AI-selected column modes';
    this.from = ['json'];
    this.to = ['csv'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'flat',
        description: 'Flattens nested objects using dot-notation keys as column headers',
        when: 'Input contains nested objects that should be represented as flat columns',
        engine: 'manual-flattener',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Complete representation of all nested data',
      },
      {
        id: 'top-level',
        description: 'Only includes top-level keys, skipping nested objects and arrays',
        when: 'Only top-level scalar values are needed; nested data can be ignored',
        engine: 'manual-parser',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Clean output for simple structures',
      },
      {
        id: 'custom-columns',
        description: 'AI selects the most relevant columns from the data',
        when: 'Data has many columns and only the most meaningful ones should be exported',
        engine: 'ai-selector',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'Curated column set focused on relevance',
      },
    ];
  }

  /**
   * Execute the JSON-to-CSV conversion.
   *
   * @param {string|Array|Object} input - JSON content (string or parsed) to convert
   * @param {string} strategy - Strategy ID: 'flat' | 'top-level' | 'custom-columns'
   * @param {Object} [options] - Additional conversion options
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const start = Date.now();

    // Parse input if string
    let data = input;
    if (typeof data === 'string') {
      data = JSON.parse(data);
    }

    // Ensure we have an array
    if (!Array.isArray(data)) {
      if (typeof data === 'object' && data !== null) {
        data = [data];
      } else {
        throw new Error('Input must be a JSON array or object');
      }
    }

    if (data.length === 0) {
      throw new Error('Input array is empty');
    }

    let headers;
    let rows;

    switch (strategy) {
      case 'flat': {
        const flatItems = data.map(item => this._flatten(item));
        const headerSet = new Set();
        flatItems.forEach(item => Object.keys(item).forEach(k => headerSet.add(k)));
        headers = [...headerSet];
        rows = flatItems.map(item => headers.map(h => item[h]));
        break;
      }

      case 'top-level': {
        const headerSet = new Set();
        data.forEach(item => {
          Object.entries(item).forEach(([key, val]) => {
            if (val === null || val === undefined || typeof val !== 'object') {
              headerSet.add(key);
            }
          });
        });
        headers = [...headerSet];
        rows = data.map(item => headers.map(h => item[h]));
        break;
      }

      case 'custom-columns': {
        // Use AI to select relevant columns
        const allKeys = new Set();
        const flatItems = data.map(item => this._flatten(item));
        flatItems.forEach(item => Object.keys(item).forEach(k => allKeys.add(k)));
        const allHeaders = [...allKeys];

        let selectedHeaders = allHeaders;
        if (this._ai && allHeaders.length > 5) {
          try {
            const sampleData = JSON.stringify(data.slice(0, 3), null, 2).substring(0, 1500);
            const result = await this._ai.json(
              `You are a data analyst. Given this JSON data sample, select the most relevant columns for a CSV export.
Available columns: ${allHeaders.join(', ')}

Sample data:
${sampleData}

Return JSON: { "columns": ["col1", "col2", ...], "reasoning": "brief explanation" }
Select the most informative and useful columns (typically 5-15).`,
              { profile: 'fast', feature: 'converter-column-select', temperature: 0 }
            );

            if (result && Array.isArray(result.columns) && result.columns.length > 0) {
              selectedHeaders = result.columns.filter(c => allHeaders.includes(c));
              if (selectedHeaders.length === 0) selectedHeaders = allHeaders;
            }
          } catch (err) {
            console.warn('[json-to-csv] AI column selection failed, using all columns:', err.message);
          }
        }

        headers = selectedHeaders;
        rows = flatItems.map(item => headers.map(h => item[h]));
        break;
      }

      default:
        throw new Error(`Unknown strategy: ${strategy}`);
    }

    // Build CSV output
    const csvLines = [
      headers.map(h => this._escapeCsvField(String(h))).join(','),
      ...rows.map(row =>
        row.map(val => this._escapeCsvField(this._formatValue(val))).join(',')
      ),
    ];
    const output = csvLines.join('\n');

    return {
      output,
      metadata: {
        strategy,
        rowCount: rows.length,
        columnCount: headers.length,
        headers,
        inputLength: typeof input === 'string' ? input.length : JSON.stringify(input).length,
        outputLength: output.length,
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  /**
   * Flatten a nested object using dot-notation keys.
   *
   * @param {Object} obj - Object to flatten
   * @param {string} [prefix] - Current key prefix
   * @returns {Object} Flattened object
   * @private
   */
  _flatten(obj, prefix = '') {
    const result = {};

    for (const [key, val] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;

      if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        Object.assign(result, this._flatten(val, fullKey));
      } else if (Array.isArray(val)) {
        result[fullKey] = JSON.stringify(val);
      } else {
        result[fullKey] = val;
      }
    }

    return result;
  }

  /**
   * Format a value for CSV output.
   *
   * @param {*} val - Value to format
   * @returns {string} Formatted string
   * @private
   */
  _formatValue(val) {
    if (val === null || val === undefined) return '';
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  }

  /**
   * Escape a CSV field, quoting when necessary.
   *
   * @param {string} field - Field value to escape
   * @returns {string} Escaped CSV field
   * @private
   */
  _escapeCsvField(field) {
    if (field.includes(',') || field.includes('"') || field.includes('\n') || field.includes('\r')) {
      return '"' + field.replace(/"/g, '""') + '"';
    }
    return field;
  }

  /**
   * Structural checks for JSON-to-CSV conversion output.
   *
   * Validates that the output is a non-empty string containing commas
   * and has a consistent column count across rows.
   *
   * @param {*} input - Original JSON input
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
        message: `Expected CSV string output, got ${typeof output}`,
        fixable: true,
      });
      return issues;
    }

    if (output.trim().length === 0) {
      issues.push({
        code: 'OUTPUT_EMPTY',
        severity: 'error',
        message: 'CSV output is empty',
        fixable: true,
      });
      return issues;
    }

    // Must contain commas (at least header row should have multiple columns)
    if (!output.includes(',')) {
      issues.push({
        code: 'NO_COMMAS',
        severity: 'warning',
        message: 'CSV output contains no commas; may only have one column',
        fixable: false,
      });
    }

    // Check consistent column count
    const lines = output.trim().split('\n').filter(l => l.trim().length > 0);
    if (lines.length >= 2) {
      const headerCount = this._countCsvColumns(lines[0]);
      const inconsistent = lines.slice(1).some(line => this._countCsvColumns(line) !== headerCount);
      if (inconsistent) {
        issues.push({
          code: 'INCONSISTENT_COLUMNS',
          severity: 'warning',
          message: 'Some rows have a different number of columns than the header',
          fixable: true,
        });
      }
    }

    return issues;
  }

  /**
   * Count the number of CSV columns in a line, accounting for quoted fields.
   *
   * @param {string} line - CSV line
   * @returns {number} Column count
   * @private
   */
  _countCsvColumns(line) {
    let count = 1;
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') inQuotes = !inQuotes;
      if (line[i] === ',' && !inQuotes) count++;
    }
    return count;
  }
}

module.exports = { JsonToCsvAgent };
