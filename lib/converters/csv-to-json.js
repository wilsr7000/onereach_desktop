/**
 * CsvToJsonAgent
 *
 * @description Converts CSV content to JSON. Supports automatic type inference,
 *   string-only mode for preserving raw values, and nested grouping by column.
 *   Handles quoted fields, commas within quotes, and multi-line values.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/csv-to-json
 *
 * @strategies
 *   - auto-type   : Infers types (number, boolean, null) from CSV values
 *   - string-only : Keeps all values as raw strings with no type coercion
 *   - nested      : Groups rows by the first column, producing nested JSON objects
 *
 * @example
 *   const { CsvToJsonAgent } = require('./csv-to-json');
 *   const agent = new CsvToJsonAgent();
 *   const result = await agent.convert('name,age\nAlice,30\nBob,25');
 *   // result.output => '[{"name":"Alice","age":30},{"name":"Bob","age":25}]'
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class CsvToJsonAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:csv-to-json';
    this.name = 'CSV to JSON';
    this.description = 'Converts CSV content to JSON with type inference, string-only, or nested grouping modes';
    this.from = ['csv'];
    this.to = ['json'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'auto-type',
        description: 'Infers types from values: numbers, booleans, null are coerced automatically',
        when: 'Input contains numeric, boolean, or null-like values that should be typed',
        engine: 'manual-parser',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'High for structured data with mixed types',
      },
      {
        id: 'string-only',
        description: 'Keeps all CSV values as raw strings without any type coercion',
        when: 'Values must remain as strings (e.g., zip codes, IDs with leading zeros)',
        engine: 'manual-parser',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Lossless string representation',
      },
      {
        id: 'nested',
        description: 'Groups rows by the first column into nested objects',
        when: 'First column represents a category or group key for hierarchical output',
        engine: 'manual-parser',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Good for categorical data that benefits from grouping',
      },
    ];
  }

  /**
   * Execute the CSV-to-JSON conversion.
   *
   * @param {string} input - CSV content to convert
   * @param {string} strategy - Strategy ID: 'auto-type' | 'string-only' | 'nested'
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
      case 'auto-type': {
        const items = dataRows.map((row) => {
          const obj = {};
          headers.forEach((header, i) => {
            obj[header] = this._inferType(row[i]);
          });
          return obj;
        });
        output = JSON.stringify(items, null, 2);
        break;
      }

      case 'string-only': {
        const items = dataRows.map((row) => {
          const obj = {};
          headers.forEach((header, i) => {
            obj[header] = row[i] !== undefined ? row[i] : '';
          });
          return obj;
        });
        output = JSON.stringify(items, null, 2);
        break;
      }

      case 'nested': {
        const groupKey = headers[0];
        const grouped = {};
        dataRows.forEach((row) => {
          const key = row[0] || 'ungrouped';
          if (!grouped[key]) {
            grouped[key] = [];
          }
          const obj = {};
          headers.slice(1).forEach((header, i) => {
            obj[header] = this._inferType(row[i + 1]);
          });
          grouped[key].push(obj);
        });
        output = JSON.stringify({ groupedBy: groupKey, groups: grouped }, null, 2);
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
          i++; // skip escaped quote
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
          if (ch === '\r') i++; // skip \n in \r\n
        } else {
          field += ch;
        }
      }
    }

    // Push last field and row
    current.push(field.trim());
    if (current.some((f) => f.length > 0)) {
      rows.push(current);
    }

    return rows;
  }

  /**
   * Attempt to infer the JavaScript type of a CSV value.
   *
   * @param {string} value - Raw string value from CSV
   * @returns {string|number|boolean|null} Typed value
   * @private
   */
  _inferType(value) {
    if (value === undefined || value === '') return null;

    const trimmed = value.trim();
    if (trimmed === '') return null;

    // Boolean
    if (trimmed.toLowerCase() === 'true') return true;
    if (trimmed.toLowerCase() === 'false') return false;

    // Null
    if (trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'none') return null;

    // Integer
    if (/^-?\d+$/.test(trimmed)) {
      const parsed = parseInt(trimmed, 10);
      if (Number.isSafeInteger(parsed)) return parsed;
    }

    // Float
    if (/^-?\d+\.\d+$/.test(trimmed)) {
      const parsed = parseFloat(trimmed);
      if (Number.isFinite(parsed)) return parsed;
    }

    return trimmed;
  }

  /**
   * Structural checks for CSV-to-JSON conversion output.
   *
   * Validates that the output is valid JSON, contains an array (or grouped object),
   * and is non-empty.
   *
   * @param {string} input - Original CSV input
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

    // Validate JSON
    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch (e) {
      issues.push({
        code: 'INVALID_JSON',
        severity: 'error',
        message: `Output is not valid JSON: ${e.message}`,
        fixable: true,
      });
      return issues;
    }

    // For auto-type and string-only, output should be an array
    if (strategy !== 'nested') {
      if (!Array.isArray(parsed)) {
        issues.push({
          code: 'NOT_ARRAY',
          severity: 'error',
          message: 'Expected JSON array output for this strategy',
          fixable: true,
        });
        return issues;
      }

      if (parsed.length === 0) {
        issues.push({
          code: 'EMPTY_ARRAY',
          severity: 'error',
          message: 'JSON array is empty, expected at least one data row',
          fixable: true,
        });
      }
    }

    // For nested, output should be an object with groups
    if (strategy === 'nested') {
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        issues.push({
          code: 'NOT_OBJECT',
          severity: 'error',
          message: 'Expected nested object output for nested strategy',
          fixable: true,
        });
      } else if (!parsed.groups || Object.keys(parsed.groups).length === 0) {
        issues.push({
          code: 'EMPTY_GROUPS',
          severity: 'error',
          message: 'Nested output has no groups',
          fixable: true,
        });
      }
    }

    return issues;
  }
}

module.exports = { CsvToJsonAgent };
