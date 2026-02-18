/**
 * ContentToXlsxAgent
 *
 * @description Converts text, CSV, or JSON content to XLSX (Excel) format.
 *   Wraps the existing format-generators/xlsx-generator when available and falls
 *   back to building spreadsheets directly with the `exceljs` npm package.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/content-to-xlsx
 *
 * @strategies
 *   - flat        : Single sheet with all data in a simple table layout
 *   - multi-sheet : Splits data by category or type across multiple sheets
 *   - formatted   : Applies headers, borders, alternating row colors, and auto-width
 *
 * @example
 *   const { ContentToXlsxAgent } = require('./content-to-xlsx');
 *   const agent = new ContentToXlsxAgent();
 *   const result = await agent.convert('Name,Age\nAlice,30\nBob,25');
 *   // result.output => <Buffer 50 4b ...>  (XLSX file buffer)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class ContentToXlsxAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:content-to-xlsx';
    this.name = 'Content to XLSX';
    this.description = 'Converts text, CSV, or JSON content to Excel XLSX format';
    this.from = ['text', 'csv', 'json'];
    this.to = ['xlsx'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'flat',
        description: 'Single sheet with all data in a simple table layout',
        when: 'Input is a single table or list that fits on one sheet',
        engine: 'exceljs',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Simple flat output for straightforward tabular data',
      },
      {
        id: 'multi-sheet',
        description: 'Splits data by category or detected grouping across multiple sheets',
        when: 'Input contains multiple categories, types, or natural groupings',
        engine: 'exceljs',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Organized multi-sheet workbook for categorized data',
      },
      {
        id: 'formatted',
        description: 'Applies styled headers, borders, alternating row colors, and auto-width columns',
        when: 'Output needs to look professional with formatted headers and styling',
        engine: 'exceljs',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Professional-looking spreadsheet with formatting',
      },
    ];
  }

  /**
   * Execute the content-to-XLSX conversion.
   *
   * @param {string|Object} input - Text, CSV string, or JSON content to convert
   * @param {string} strategy - Strategy ID: 'flat' | 'multi-sheet' | 'formatted'
   * @param {Object} [options] - Additional conversion options
   * @param {string} [options.title] - Workbook title / sheet name
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const start = Date.now();
    let output;

    switch (strategy) {
      case 'multi-sheet': {
        output = await this._executeMultiSheet(input, options);
        break;
      }
      case 'formatted': {
        output = await this._executeFormatted(input, options);
        break;
      }
      case 'flat':
      default: {
        output = await this._executeFlat(input, options);
        break;
      }
    }

    return {
      output,
      metadata: {
        strategy,
        inputLength: typeof input === 'string' ? input.length : JSON.stringify(input).length,
        outputLength: output.length,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        extension: 'xlsx',
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  /**
   * Flat: single sheet with all data.
   * @private
   */
  async _executeFlat(input, options) {
    // Try existing generator first
    try {
      const XlsxGenerator = require('../../format-generators/xlsx-generator');
      const generator = new XlsxGenerator();
      const space = { name: options.title || 'Data', description: '' };
      const items = [
        { type: 'text', content: typeof input === 'string' ? input : JSON.stringify(input), metadata: {} },
      ];
      const result = await generator.generate(space, items, { separateSheets: false });
      if (result.success && result.buffer) {
        return result.buffer;
      }
    } catch (_ignored) {
      // Generator not available, fall back
    }

    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Onereach.ai';
    workbook.created = new Date();

    const rows = this._parseInputToRows(input);
    const sheet = workbook.addWorksheet(options.title || 'Sheet1');

    for (const row of rows) {
      sheet.addRow(row);
    }

    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  /**
   * Multi-sheet: group data by a category column or detected grouping.
   * @private
   */
  async _executeMultiSheet(input, options) {
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Onereach.ai';
    workbook.created = new Date();

    const rows = this._parseInputToRows(input);

    if (rows.length < 2) {
      // Not enough data to split; just put on one sheet
      const sheet = workbook.addWorksheet('Sheet1');
      for (const row of rows) {
        sheet.addRow(row);
      }
      return Buffer.from(await workbook.xlsx.writeBuffer());
    }

    const headers = rows[0];
    const dataRows = rows.slice(1);

    // Try to find a category column (first column with fewer unique values than rows)
    let categoryCol = -1;
    for (let c = 0; c < headers.length; c++) {
      const uniqueVals = new Set(dataRows.map((r) => String(r[c] || '')));
      if (uniqueVals.size > 1 && uniqueVals.size <= Math.min(10, Math.ceil(dataRows.length / 2))) {
        categoryCol = c;
        break;
      }
    }

    if (categoryCol >= 0) {
      // Group by category column
      const groups = {};
      for (const row of dataRows) {
        const key = String(row[categoryCol] || 'Other');
        if (!groups[key]) groups[key] = [];
        groups[key].push(row);
      }

      for (const [groupName, groupRows] of Object.entries(groups)) {
        const safeName = groupName.replace(/[\\/*?[\]:]/g, '_').substring(0, 31);
        const sheet = workbook.addWorksheet(safeName || 'Sheet');
        sheet.addRow(headers);
        for (const row of groupRows) {
          sheet.addRow(row);
        }
      }
    } else {
      // No good category column; put all on one sheet
      const sheet = workbook.addWorksheet(options.title || 'Data');
      for (const row of rows) {
        sheet.addRow(row);
      }
    }

    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  /**
   * Formatted: styled headers, borders, alternating rows, auto-width.
   * @private
   */
  async _executeFormatted(input, options) {
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Onereach.ai';
    workbook.created = new Date();

    const rows = this._parseInputToRows(input);
    const sheet = workbook.addWorksheet(options.title || 'Data');

    if (rows.length === 0) {
      return Buffer.from(await workbook.xlsx.writeBuffer());
    }

    // Add header row
    const headerRow = sheet.addRow(rows[0]);
    headerRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2B579A' } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' },
      };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });

    // Add data rows with alternating colors
    for (let i = 1; i < rows.length; i++) {
      const dataRow = sheet.addRow(rows[i]);
      dataRow.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
        if (i % 2 === 0) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
        }
      });
    }

    // Auto-fit column widths
    sheet.columns.forEach((column) => {
      let maxLength = 10;
      column.eachCell({ includeEmpty: true }, (cell) => {
        const colLength = cell.value ? String(cell.value).length : 0;
        if (colLength > maxLength) maxLength = colLength;
      });
      column.width = Math.min(maxLength + 2, 50);
    });

    // Freeze header row
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  /**
   * Parse various input formats (CSV string, JSON string, JSON object/array, text)
   * into a 2D array of rows.
   * @private
   */
  _parseInputToRows(input) {
    // If already an array of arrays, return as-is
    if (Array.isArray(input) && input.length > 0 && Array.isArray(input[0])) {
      return input;
    }

    // If array of objects, convert to rows with header row
    if (Array.isArray(input) && input.length > 0 && typeof input[0] === 'object') {
      const allKeys = [...new Set(input.flatMap((obj) => Object.keys(obj)))];
      const rows = [allKeys];
      for (const obj of input) {
        rows.push(allKeys.map((key) => (obj[key] !== undefined ? obj[key] : '')));
      }
      return rows;
    }

    const str = typeof input === 'string' ? input : JSON.stringify(input);

    // Try JSON parse
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) {
        return this._parseInputToRows(parsed);
      }
      if (parsed && typeof parsed === 'object') {
        // Single object: key-value pairs
        return [['Key', 'Value'], ...Object.entries(parsed).map(([k, v]) => [k, String(v)])];
      }
    } catch (_e) {
      // Not JSON
    }

    // Try CSV parse
    if (str.includes(',') && str.includes('\n')) {
      return this._parseCsv(str);
    }

    // Fall back: split by newlines, tab-separated or plain text
    const lines = str.split('\n').filter((l) => l.trim());
    if (lines.some((l) => l.includes('\t'))) {
      return lines.map((l) => l.split('\t'));
    }

    return lines.map((l) => [l.trim()]);
  }

  /**
   * Simple CSV parser handling quoted fields.
   * @private
   */
  _parseCsv(csv) {
    const rows = [];
    const lines = csv.split('\n');

    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const row = [];
      let current = '';
      let inQuotes = false;

      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
          if (ch === '"' && line[i + 1] === '"') {
            current += '"';
            i++;
          } else if (ch === '"') {
            inQuotes = false;
          } else {
            current += ch;
          }
        } else {
          if (ch === '"') {
            inQuotes = true;
          } else if (ch === ',') {
            row.push(current.trim());
            current = '';
          } else {
            current += ch;
          }
        }
      }
      row.push(current.trim());
      rows.push(row);
    }

    return rows;
  }

  /**
   * Structural checks for content-to-XLSX conversion output.
   *
   * Validates that the output is a non-empty Buffer starting with PK (zip)
   * magic bytes, since XLSX files are ZIP archives.
   *
   * @param {string|Object} input - Original input content
   * @param {*} output - Conversion output to validate
   * @param {string} strategy - Strategy that was used
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, _strategy) {
    const issues = [];

    if (!Buffer.isBuffer(output)) {
      issues.push({
        code: 'OUTPUT_NOT_BUFFER',
        severity: 'error',
        message: `Expected Buffer output, got ${typeof output}`,
        fixable: true,
      });
      return issues;
    }

    if (output.length === 0) {
      issues.push({
        code: 'OUTPUT_EMPTY',
        severity: 'error',
        message: 'XLSX buffer is empty',
        fixable: true,
      });
      return issues;
    }

    // XLSX is a ZIP archive; first two bytes must be PK (0x50 0x4B)
    if (output[0] !== 0x50 || output[1] !== 0x4b) {
      issues.push({
        code: 'INVALID_ZIP_MAGIC',
        severity: 'error',
        message: 'Output does not start with PK magic bytes (not a valid XLSX/ZIP file)',
        fixable: true,
      });
    }

    if (output.length < 100) {
      issues.push({
        code: 'OUTPUT_TOO_SMALL',
        severity: 'warning',
        message: `XLSX buffer is suspiciously small (${output.length} bytes)`,
        fixable: false,
      });
    }

    return issues;
  }
}

module.exports = { ContentToXlsxAgent };
