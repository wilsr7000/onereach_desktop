/**
 * XlsxToJsonAgent
 *
 * @description Converts XLSX (Excel) files to JSON using the `exceljs` library.
 *   Supports header-row-to-object mapping, raw 2D arrays, and a typed mode
 *   that infers number, date, and boolean types from cell values.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/xlsx-to-json
 *
 * @strategies
 *   - rows-as-objects : First row becomes keys, remaining rows become objects
 *   - raw-arrays      : Returns 2D array of arrays (no header inference)
 *   - typed           : Like rows-as-objects but infers number, date, and boolean types
 *
 * @example
 *   const { XlsxToJsonAgent } = require('./xlsx-to-json');
 *   const agent = new XlsxToJsonAgent();
 *   const result = await agent.convert(xlsxBuffer);
 *   // result.output => [{ "Name": "Alice", "Age": 30 }, ...]
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class XlsxToJsonAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:xlsx-to-json';
    this.name = 'XLSX to JSON';
    this.description = 'Converts XLSX (Excel) files to JSON using exceljs';
    this.from = ['xlsx'];
    this.to = ['json'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'rows-as-objects',
        description: 'First row becomes property keys, remaining rows become objects',
        when: 'Spreadsheet has a clear header row with column names',
        engine: 'exceljs',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Clean JSON objects with meaningful keys from headers',
      },
      {
        id: 'raw-arrays',
        description: 'Returns raw 2D array of arrays without header inference',
        when: 'No clear header row or need raw positional data',
        engine: 'exceljs',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Faithful representation of raw cell data',
      },
      {
        id: 'typed',
        description: 'Like rows-as-objects but infers number, date, and boolean types from values',
        when: 'Need typed JSON output with proper numbers, dates, and booleans instead of strings',
        engine: 'exceljs',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Properly typed JSON with number, date, and boolean inference',
      },
    ];
  }

  /**
   * Execute the XLSX-to-JSON conversion.
   *
   * @param {Buffer} input - XLSX file buffer to convert
   * @param {string} strategy - Strategy ID: 'rows-as-objects' | 'raw-arrays' | 'typed'
   * @param {Object} [options] - Additional conversion options
   * @param {string} [options.sheet] - Specific sheet name to convert (default: first)
   * @param {boolean} [options.allSheets] - Convert all sheets (output keyed by sheet name)
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const start = Date.now();
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(input);

    let output;

    if (options.allSheets) {
      const result = {};
      for (const sheet of workbook.worksheets) {
        result[sheet.name] = this._convertSheet(sheet, strategy);
      }
      output = result;
    } else {
      const sheet = options.sheet ? workbook.getWorksheet(options.sheet) : workbook.worksheets[0];

      if (!sheet) {
        throw new Error(`Worksheet not found: ${options.sheet || 'no worksheets in workbook'}`);
      }

      output = this._convertSheet(sheet, strategy);
    }

    // Serialize to JSON string for consistent output
    const jsonString = JSON.stringify(output, null, 2);

    return {
      output: jsonString,
      metadata: {
        strategy,
        inputLength: input.length,
        outputLength: jsonString.length,
        sheetCount: workbook.worksheets.length,
        recordCount: Array.isArray(output) ? output.length : Object.keys(output).length,
        mimeType: 'application/json',
        extension: 'json',
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  /**
   * Convert a single worksheet to JSON based on the strategy.
   * @private
   */
  _convertSheet(sheet, strategy) {
    switch (strategy) {
      case 'raw-arrays':
        return this._sheetToRawArrays(sheet);
      case 'typed':
        return this._sheetToTypedObjects(sheet);
      case 'rows-as-objects':
      default:
        return this._sheetToObjects(sheet);
    }
  }

  /**
   * Convert sheet to array of objects using first row as headers.
   * @private
   */
  _sheetToObjects(sheet) {
    const rows = this._extractRows(sheet);
    if (rows.length < 2) return rows.length === 1 ? [Object.fromEntries(rows[0].map((h, _i) => [h, null]))] : [];

    const headers = rows[0].map((h, i) => String(h || `Column${i + 1}`));
    const objects = [];

    for (let i = 1; i < rows.length; i++) {
      const obj = {};
      for (let j = 0; j < headers.length; j++) {
        obj[headers[j]] = rows[i][j] !== undefined ? String(rows[i][j]) : '';
      }
      objects.push(obj);
    }

    return objects;
  }

  /**
   * Convert sheet to raw 2D arrays.
   * @private
   */
  _sheetToRawArrays(sheet) {
    return this._extractRows(sheet).map((row) => row.map((cell) => String(cell)));
  }

  /**
   * Convert sheet to typed objects, inferring numbers, dates, and booleans.
   * @private
   */
  _sheetToTypedObjects(sheet) {
    const rows = this._extractRows(sheet);
    if (rows.length < 2) return [];

    const headers = rows[0].map((h, i) => String(h || `Column${i + 1}`));
    const objects = [];

    for (let i = 1; i < rows.length; i++) {
      const obj = {};
      for (let j = 0; j < headers.length; j++) {
        obj[headers[j]] = this._inferType(rows[i][j]);
      }
      objects.push(obj);
    }

    return objects;
  }

  /**
   * Extract all rows from a worksheet as arrays of raw values.
   * @private
   */
  _extractRows(sheet) {
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        while (cells.length < colNumber - 1) cells.push('');
        cells.push(this._getCellValue(cell));
      });
      rows.push(cells);
    });
    return rows;
  }

  /**
   * Get the raw value from a cell, handling various exceljs cell types.
   * @private
   */
  _getCellValue(cell) {
    if (cell.value === null || cell.value === undefined) return '';
    if (cell.value instanceof Date) return cell.value.toISOString();
    if (typeof cell.value === 'object') {
      if (cell.value.result !== undefined) return cell.value.result;
      if (cell.value.richText) return cell.value.richText.map((r) => r.text || '').join('');
      if (cell.value.text) return cell.value.text;
      return JSON.stringify(cell.value);
    }
    return cell.value;
  }

  /**
   * Infer the JavaScript type of a cell value string.
   * @private
   */
  _inferType(value) {
    if (value === null || value === undefined || value === '') return null;

    // Already a typed value from exceljs
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value;
    if (value instanceof Date) return value.toISOString();

    const str = String(value).trim();

    // Boolean inference
    if (str.toLowerCase() === 'true') return true;
    if (str.toLowerCase() === 'false') return false;

    // Number inference (handles integers, floats, negatives)
    if ((/^-?\d+(\.\d+)?$/.test(str) && !str.startsWith('0')) || str === '0') {
      const num = Number(str);
      if (!isNaN(num) && isFinite(num)) return num;
    }

    // Leading-zero numbers stay as strings (zip codes, IDs, etc.)

    // Date inference (ISO format)
    if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
      const date = new Date(str);
      if (!isNaN(date.getTime())) return date.toISOString();
    }

    return str;
  }

  /**
   * Structural checks for XLSX-to-JSON conversion output.
   *
   * Validates that the output is valid JSON containing data.
   *
   * @param {Buffer} input - Original XLSX buffer
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
        message: `Expected JSON string output, got ${typeof output}`,
        fixable: true,
      });
      return issues;
    }

    if (output.trim().length === 0) {
      issues.push({
        code: 'OUTPUT_EMPTY',
        severity: 'error',
        message: 'JSON output is empty',
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

    // Check that parsed result has content
    if (Array.isArray(parsed) && parsed.length === 0) {
      issues.push({
        code: 'EMPTY_ARRAY',
        severity: 'warning',
        message: 'JSON output is an empty array (workbook may have no data rows)',
        fixable: false,
      });
    }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0) {
      issues.push({
        code: 'EMPTY_OBJECT',
        severity: 'warning',
        message: 'JSON output is an empty object',
        fixable: false,
      });
    }

    return issues;
  }
}

module.exports = { XlsxToJsonAgent };
