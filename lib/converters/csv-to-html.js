/**
 * CsvToHtmlAgent
 *
 * @description Converts CSV data to HTML tables. Supports basic table output,
 *   styled tables wrapped in a full HTML document with CSS, and sortable tables
 *   with click-to-sort JavaScript included.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/csv-to-html
 *
 * @strategies
 *   - table    : Basic HTML table with thead/tbody structure
 *   - styled   : Full HTML document with embedded CSS for presentation
 *   - sortable : HTML table with click-to-sort JavaScript on column headers
 *
 * @example
 *   const { CsvToHtmlAgent } = require('./csv-to-html');
 *   const agent = new CsvToHtmlAgent();
 *   const result = await agent.convert('name,age\nAlice,30\nBob,25');
 *   // result.output => '<table><thead>...'
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class CsvToHtmlAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:csv-to-html';
    this.name = 'CSV to HTML';
    this.description = 'Converts CSV data to HTML tables with optional styling and sort functionality';
    this.from = ['csv'];
    this.to = ['html'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'table',
        description: 'Basic HTML table with thead and tbody structure',
        when: 'Embedding a table into an existing HTML page or template',
        engine: 'manual-builder',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Clean semantic HTML table',
      },
      {
        id: 'styled',
        description: 'Full HTML document with embedded CSS for styled table presentation',
        when: 'Standalone HTML file needed for viewing or sharing',
        engine: 'manual-builder',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Presentation-ready styled table document',
      },
      {
        id: 'sortable',
        description: 'HTML table with click-to-sort JavaScript on column headers',
        when: 'Interactive table where users need to sort by different columns',
        engine: 'manual-builder',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Interactive sortable table with styled headers',
      },
    ];
  }

  /**
   * Execute the CSV-to-HTML conversion.
   *
   * @param {string} input - CSV content to convert
   * @param {string} strategy - Strategy ID: 'table' | 'styled' | 'sortable'
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
      case 'table': {
        output = this._buildTable(headers, dataRows);
        break;
      }

      case 'styled': {
        const table = this._buildTable(headers, dataRows);
        output = this._wrapInDocument(table, headers.length);
        break;
      }

      case 'sortable': {
        const table = this._buildTable(headers, dataRows, { sortable: true });
        output = this._wrapInDocument(table, headers.length, { sortable: true });
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
   * Build an HTML table string from headers and data rows.
   *
   * @param {string[]} headers - Column headers
   * @param {string[][]} dataRows - Data rows
   * @param {Object} [opts] - Build options
   * @param {boolean} [opts.sortable] - Add sortable cursor styles to headers
   * @returns {string} HTML table string
   * @private
   */
  _buildTable(headers, dataRows, opts = {}) {
    const esc = (val) =>
      String(val).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const thStyle = opts.sortable ? ' style="cursor:pointer;user-select:none"' : '';

    const thead =
      '  <thead>\n    <tr>\n' +
      headers.map((h) => `      <th${thStyle}>${esc(h)}</th>`).join('\n') +
      '\n    </tr>\n  </thead>';

    const tbody =
      '  <tbody>\n' +
      dataRows
        .map(
          (row) =>
            '    <tr>\n' + headers.map((_, i) => `      <td>${esc(row[i] || '')}</td>`).join('\n') + '\n    </tr>'
        )
        .join('\n') +
      '\n  </tbody>';

    return `<table>\n${thead}\n${tbody}\n</table>`;
  }

  /**
   * Wrap an HTML table in a full HTML document with optional CSS and JS.
   *
   * @param {string} tableHtml - The table HTML
   * @param {number} colCount - Number of columns
   * @param {Object} [opts] - Document options
   * @param {boolean} [opts.sortable] - Include sort JavaScript
   * @returns {string} Full HTML document string
   * @private
   */
  _wrapInDocument(tableHtml, colCount, opts = {}) {
    const css = `
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        padding: 2rem;
        background: #f8f9fa;
        color: #212529;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        background: #fff;
        border-radius: 8px;
        overflow: hidden;
        box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      }
      thead th {
        background: #343a40;
        color: #fff;
        padding: 0.75rem 1rem;
        text-align: left;
        font-weight: 600;
        font-size: 0.875rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      tbody td {
        padding: 0.625rem 1rem;
        border-bottom: 1px solid #e9ecef;
        font-size: 0.9rem;
      }
      tbody tr:last-child td { border-bottom: none; }
      tbody tr:hover { background: #f1f3f5; }
      ${opts.sortable ? 'thead th { cursor: pointer; user-select: none; }' : ''}
      ${opts.sortable ? 'thead th:hover { background: #495057; }' : ''}
      ${opts.sortable ? 'thead th::after { content: " \\2195"; opacity: 0.4; font-size: 0.75em; }' : ''}
    </style>`;

    const sortScript = opts.sortable
      ? `
    <script>
      document.querySelectorAll('thead th').forEach((th, colIdx) => {
        let asc = true;
        th.addEventListener('click', () => {
          const tbody = th.closest('table').querySelector('tbody');
          const rows = Array.from(tbody.querySelectorAll('tr'));
          rows.sort((a, b) => {
            const aVal = a.children[colIdx]?.textContent || '';
            const bVal = b.children[colIdx]?.textContent || '';
            const aNum = parseFloat(aVal);
            const bNum = parseFloat(bVal);
            if (!isNaN(aNum) && !isNaN(bNum)) {
              return asc ? aNum - bNum : bNum - aNum;
            }
            return asc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
          });
          rows.forEach(row => tbody.appendChild(row));
          asc = !asc;
        });
      });
    </script>`
      : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CSV Data Table</title>${css}
</head>
<body>
${tableHtml}${sortScript}
</body>
</html>`;
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
   * Structural checks for CSV-to-HTML conversion output.
   *
   * Validates that the output is a non-empty string containing an HTML table.
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
        message: `Expected HTML string output, got ${typeof output}`,
        fixable: true,
      });
      return issues;
    }

    if (output.trim().length === 0) {
      issues.push({
        code: 'OUTPUT_EMPTY',
        severity: 'error',
        message: 'HTML output is empty',
        fixable: true,
      });
      return issues;
    }

    // Must contain <table>
    if (!/<table[\s>]/i.test(output)) {
      issues.push({
        code: 'NO_TABLE_TAG',
        severity: 'error',
        message: 'Output does not contain a <table> element',
        fixable: true,
      });
    }

    // Check for thead and tbody
    if (!/<thead[\s>]/i.test(output)) {
      issues.push({
        code: 'NO_THEAD',
        severity: 'warning',
        message: 'Output table is missing <thead>',
        fixable: true,
      });
    }

    if (!/<tbody[\s>]/i.test(output)) {
      issues.push({
        code: 'NO_TBODY',
        severity: 'warning',
        message: 'Output table is missing <tbody>',
        fixable: true,
      });
    }

    return issues;
  }
}

module.exports = { CsvToHtmlAgent };
