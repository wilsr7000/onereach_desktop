/**
 * JsonToHtmlAgent
 *
 * @description Converts JSON data to HTML. Supports table rendering for arrays
 *   of objects, tree rendering for nested structures, and syntax-highlighted
 *   pretty-print for raw JSON display.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/json-to-html
 *
 * @agent converter:json-to-html
 * @from json
 * @to   html
 * @modes symbolic
 *
 * @strategies
 *   - table  : Render JSON array of objects as HTML table
 *   - tree   : Render nested JSON as collapsible tree view
 *   - pretty : Syntax-highlighted <pre> block of formatted JSON
 *
 * @input  {string} JSON content
 * @output {string} HTML content
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class JsonToHtmlAgent extends BaseConverterAgent {
  constructor(config = {}) {
    super(config);

    this.id = 'converter:json-to-html';
    this.name = 'JSON to HTML';
    this.description = 'Converts JSON data to HTML tables, tree views, or syntax-highlighted display';
    this.from = ['json'];
    this.to = ['html'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'table',
        description: 'Render JSON array of objects as an HTML table with headers',
        when: 'Input is an array of flat objects suitable for tabular display',
        engine: 'manual-builder',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Clean semantic HTML table',
      },
      {
        id: 'tree',
        description: 'Render nested JSON as a collapsible HTML tree view',
        when: 'Input has deep nesting that benefits from a tree layout',
        engine: 'manual-builder',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Interactive tree representation of JSON structure',
      },
      {
        id: 'pretty',
        description: 'Syntax-highlighted formatted JSON in a <pre> block',
        when: 'Raw JSON display is needed with color coding for readability',
        engine: 'manual-builder',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Developer-friendly syntax-highlighted JSON view',
      },
    ];
  }

  /**
   * @param {string} input - JSON content
   * @param {string} strategy - 'table' | 'tree' | 'pretty'
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy) {
    const start = Date.now();
    const data = typeof input === 'string' ? JSON.parse(input) : input;
    let output;

    switch (strategy) {
      case 'table':
        output = this._buildTable(data);
        break;
      case 'tree':
        output = this._buildTree(data);
        break;
      default: // pretty
        output = this._buildPretty(data);
        break;
    }

    return { output, duration: Date.now() - start };
  }

  _buildTable(data) {
    const items = Array.isArray(data) ? data : [data];
    if (items.length === 0) return '<table><tbody><tr><td>Empty array</td></tr></tbody></table>';

    const allKeys = new Set();
    for (const item of items) {
      if (item && typeof item === 'object') {
        Object.keys(item).forEach((k) => allKeys.add(k));
      }
    }
    const headers = [...allKeys];

    const esc = (v) =>
      String(v == null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    const thead = `<thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>`;
    const rows = items.map((item) => {
      const cells = headers.map((h) => {
        const val = item && typeof item === 'object' ? item[h] : '';
        const display = typeof val === 'object' ? JSON.stringify(val) : val;
        return `<td>${esc(display)}</td>`;
      });
      return `<tr>${cells.join('')}</tr>`;
    });
    const tbody = `<tbody>${rows.join('\n')}</tbody>`;
    return `<table>\n${thead}\n${tbody}\n</table>`;
  }

  _buildTree(data, depth = 0) {
    const indent = '  '.repeat(depth);
    const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    if (data === null || data === undefined) return `${indent}<span class="json-null">null</span>`;
    if (typeof data === 'boolean') return `${indent}<span class="json-bool">${data}</span>`;
    if (typeof data === 'number') return `${indent}<span class="json-num">${data}</span>`;
    if (typeof data === 'string') return `${indent}<span class="json-str">"${esc(data)}"</span>`;

    if (Array.isArray(data)) {
      if (data.length === 0) return `${indent}<span class="json-bracket">[]</span>`;
      const items = data.map((v, _i) => `${indent}  <li>${this._buildTree(v, depth + 1)}</li>`).join('\n');
      return `<ul class="json-array">\n${items}\n${indent}</ul>`;
    }

    if (typeof data === 'object') {
      const keys = Object.keys(data);
      if (keys.length === 0) return `${indent}<span class="json-bracket">{}</span>`;
      const entries = keys
        .map(
          (k) => `${indent}  <li><span class="json-key">${esc(k)}</span>: ${this._buildTree(data[k], depth + 1)}</li>`
        )
        .join('\n');
      return `<ul class="json-object">\n${entries}\n${indent}</ul>`;
    }

    return `${indent}<span>${esc(String(data))}</span>`;
  }

  _buildPretty(data) {
    const formatted = JSON.stringify(data, null, 2);
    const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Simple syntax highlighting via regex
    const highlighted = esc(formatted)
      .replace(/"([^"]+)"(?=\s*:)/g, '<span class="json-key">"$1"</span>')
      .replace(/:\s*"([^"]*)"/g, ': <span class="json-str">"$1"</span>')
      .replace(/:\s*(\d+\.?\d*)/g, ': <span class="json-num">$1</span>')
      .replace(/:\s*(true|false)/g, ': <span class="json-bool">$1</span>')
      .replace(/:\s*(null)/g, ': <span class="json-null">$1</span>');

    return `<pre class="json-pretty"><code>${highlighted}</code></pre>`;
  }

  async _structuralChecks(input, output) {
    const issues = [];
    if (typeof output !== 'string' || output.trim().length === 0) {
      issues.push({
        code: 'EMPTY_OUTPUT',
        severity: 'error',
        message: 'Output HTML is empty',
        fixable: false,
      });
    }
    return issues;
  }
}

module.exports = { JsonToHtmlAgent };
