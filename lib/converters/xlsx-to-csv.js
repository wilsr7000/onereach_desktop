/**
 * XlsxToCsvAgent
 *
 * @description Converts XLSX (Excel) files to CSV format using the `exceljs`
 *   library. Supports extracting a single sheet, all sheets as separate CSVs,
 *   or merging all sheets into one combined CSV.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/xlsx-to-csv
 *
 * @strategies
 *   - first-sheet : Exports only the first worksheet as CSV
 *   - all-sheets  : Exports every worksheet as a separate labeled CSV section
 *   - merged      : Merges all sheets into one CSV with a source-sheet column
 *
 * @example
 *   const { XlsxToCsvAgent } = require('./xlsx-to-csv');
 *   const agent = new XlsxToCsvAgent();
 *   const result = await agent.convert(xlsxBuffer);
 *   // result.output => 'Name,Age\nAlice,30\nBob,25\n'
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class XlsxToCsvAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:xlsx-to-csv';
    this.name = 'XLSX to CSV';
    this.description = 'Converts XLSX (Excel) files to CSV format using exceljs';
    this.from = ['xlsx'];
    this.to = ['csv'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'first-sheet',
        description: 'Exports only the first worksheet as a single CSV',
        when: 'Workbook has one main sheet or only the first sheet matters',
        engine: 'exceljs',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Clean CSV from the first worksheet',
      },
      {
        id: 'all-sheets',
        description: 'Exports every worksheet as a separate labeled CSV section',
        when: 'All sheets are important and should be distinguishable in output',
        engine: 'exceljs',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Complete extraction of all worksheets',
      },
      {
        id: 'merged',
        description: 'Merges all sheets into one CSV with a _Sheet column for origin tracking',
        when: 'All sheets share a similar structure and should be combined',
        engine: 'exceljs',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Unified CSV with sheet-of-origin tracking',
      },
    ];
  }

  /**
   * Execute the XLSX-to-CSV conversion.
   *
   * @param {Buffer} input - XLSX file buffer to convert
   * @param {string} strategy - Strategy ID: 'first-sheet' | 'all-sheets' | 'merged'
   * @param {Object} [options] - Additional conversion options
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, _options = {}) {
    const start = Date.now();
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(input);

    let output;

    switch (strategy) {
      case 'all-sheets': {
        output = this._convertAllSheets(workbook);
        break;
      }
      case 'merged': {
        output = this._convertMerged(workbook);
        break;
      }
      case 'first-sheet':
      default: {
        output = this._convertFirstSheet(workbook);
        break;
      }
    }

    return {
      output,
      metadata: {
        strategy,
        inputLength: input.length,
        outputLength: output.length,
        sheetCount: workbook.worksheets.length,
        mimeType: 'text/csv',
        extension: 'csv',
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  /**
   * Convert only the first worksheet to CSV.
   * @private
   */
  _convertFirstSheet(workbook) {
    const sheet = workbook.worksheets[0];
    if (!sheet) return '';
    return this._sheetToCsv(sheet);
  }

  /**
   * Convert all worksheets to labeled CSV sections.
   * @private
   */
  _convertAllSheets(workbook) {
    const parts = [];
    for (const sheet of workbook.worksheets) {
      const csv = this._sheetToCsv(sheet);
      if (csv.trim().length > 0) {
        parts.push(`# Sheet: ${sheet.name}\n${csv}`);
      }
    }
    return parts.join('\n\n');
  }

  /**
   * Merge all worksheets into one CSV with a _Sheet column.
   * @private
   */
  _convertMerged(workbook) {
    const allRows = [];
    let commonHeaders = null;

    for (const sheet of workbook.worksheets) {
      const rows = this._sheetToRows(sheet);
      if (rows.length === 0) continue;

      const headers = rows[0];
      const dataRows = rows.slice(1);

      if (commonHeaders === null) {
        commonHeaders = ['_Sheet', ...headers];
        allRows.push(commonHeaders);
      }

      for (const row of dataRows) {
        // Pad or trim to match header length
        const paddedRow = headers.map((_, i) => (row[i] !== undefined ? row[i] : ''));
        allRows.push([sheet.name, ...paddedRow]);
      }
    }

    if (allRows.length === 0) return '';
    return allRows.map((row) => row.map((cell) => this._escapeCsvCell(cell)).join(',')).join('\n');
  }

  /**
   * Convert a single worksheet to a CSV string.
   * @private
   */
  _sheetToCsv(sheet) {
    const rows = this._sheetToRows(sheet);
    return rows.map((row) => row.map((cell) => this._escapeCsvCell(cell)).join(',')).join('\n');
  }

  /**
   * Extract all rows from a worksheet as arrays of string values.
   * @private
   */
  _sheetToRows(sheet) {
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        // Pad missing columns
        while (cells.length < colNumber - 1) cells.push('');
        cells.push(this._cellToString(cell));
      });
      rows.push(cells);
    });
    return rows;
  }

  /**
   * Convert a cell value to a string representation.
   * @private
   */
  _cellToString(cell) {
    if (cell.value === null || cell.value === undefined) return '';
    if (cell.value instanceof Date) {
      return cell.value.toISOString();
    }
    if (typeof cell.value === 'object') {
      // Rich text, formula result, etc.
      if (cell.value.result !== undefined) return String(cell.value.result);
      if (cell.value.richText) {
        return cell.value.richText.map((r) => r.text || '').join('');
      }
      if (cell.value.text) return cell.value.text;
      return JSON.stringify(cell.value);
    }
    return String(cell.value);
  }

  /**
   * Escape a cell value for CSV output (RFC 4180 compliant).
   * @private
   */
  _escapeCsvCell(value) {
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  /**
   * Structural checks for XLSX-to-CSV conversion output.
   *
   * Validates that the output is a non-empty string containing commas and newlines.
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
        message: `Expected string output, got ${typeof output}`,
        fixable: true,
      });
      return issues;
    }

    if (output.trim().length === 0) {
      issues.push({
        code: 'OUTPUT_EMPTY',
        severity: 'error',
        message: 'CSV output is empty (workbook may have no data)',
        fixable: false,
      });
      return issues;
    }

    if (!output.includes(',')) {
      issues.push({
        code: 'NO_COMMAS',
        severity: 'warning',
        message: 'CSV output does not contain commas (may be single-column data)',
        fixable: false,
      });
    }

    if (!output.includes('\n')) {
      issues.push({
        code: 'SINGLE_LINE',
        severity: 'warning',
        message: 'CSV output is a single line (may have only one row of data)',
        fixable: false,
      });
    }

    return issues;
  }
}

module.exports = { XlsxToCsvAgent };
