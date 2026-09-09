/**
 * CSV → HTML table (ported from lib/converters/csv-to-html.js, ADR-100).
 * Strategies: table (a bare <table> with thead/tbody, for embedding),
 * styled (a complete HTML page with a stylesheet), sortable (the styled
 * page plus click-to-sort on the column headers, numeric when both cells
 * parse as numbers). Cell text is escaped; TSV is read through the same
 * delimiter detection as csv-to-json.
 */

import type { Converter, ExecuteResult } from '../types.js';
import { parseDelimited, resolveDelimiter } from './csv-to-json.js';

const DEFAULT_TITLE = 'CSV Data Table';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A <table> with a <thead> of the headers and a <tbody> of the rows; `sortable` marks the headers clickable. */
export function buildHtmlTable(headers: string[], dataRows: string[][], sortable = false): string {
  const thStyle = sortable ? ' style="cursor:pointer;user-select:none"' : '';
  const thead = '  <thead>\n    <tr>\n' + headers.map((h) => `      <th${thStyle}>${escapeHtml(h)}</th>`).join('\n') + '\n    </tr>\n  </thead>';
  const tbody =
    '  <tbody>\n' +
    dataRows.map((row) => '    <tr>\n' + headers.map((_, i) => `      <td>${escapeHtml(row[i] ?? '')}</td>`).join('\n') + '\n    </tr>').join('\n') +
    '\n  </tbody>';
  return `<table>\n${thead}\n${tbody}\n</table>`;
}

function pageStyle(sortable: boolean): string {
  return `
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
      ${sortable ? 'thead th { cursor: pointer; user-select: none; }' : ''}
      ${sortable ? 'thead th:hover { background: #495057; }' : ''}
      ${sortable ? 'thead th::after { content: " \\2195"; opacity: 0.4; font-size: 0.75em; }' : ''}
    </style>`;
}

/** Click a header to sort its column — numerically when both cells parse, else by locale; click again to flip. */
export const SORT_SCRIPT = `
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
    </script>`;

/** The table as a complete page: viewport meta, the stylesheet, and the sort script when asked. */
export function wrapDocument(tableHtml: string, sortable: boolean, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>${pageStyle(sortable)}
</head>
<body>
${tableHtml}${sortable ? SORT_SCRIPT : ''}
</body>
</html>`;
}

export const csvToHtml: Converter = {
  spec: {
    id: 'csv-to-html',
    title: 'CSV to HTML',
    description: 'Rows become an HTML table: bare for embedding, a styled page, or a styled page whose headers sort on click.',
    from: ['csv', 'tsv'],
    to: ['html'],
    engine: 'pure',
    strategies: [
      { id: 'table', description: 'A bare <table> with <thead> and <tbody>.', when: 'The table goes into an existing page or template.' },
      { id: 'styled', description: 'A complete HTML page with a stylesheet around the table.', when: 'The result should open on its own in a browser.' },
      { id: 'sortable', description: 'The styled page plus click-to-sort on every column header.', when: 'People will explore the data — sort by one column, then another.' },
    ],
    defaultStrategy: 'table',
    options: [
      { name: 'delimiter', type: 'string', description: 'Field delimiter; "\\t" for TSV. Detected from the first line when omitted.' },
      { name: 'title', type: 'string', description: 'Page title for the styled and sortable strategies.', default: DEFAULT_TITLE },
    ],
  },
  async execute(input, strategy, options): Promise<ExecuteResult> {
    const delimiter = resolveDelimiter(input, options['delimiter']);
    const rows = parseDelimited(input, delimiter);
    if (rows.length < 2) throw new Error('CSV must contain at least a header row and one data row');
    const headers = rows[0] as string[];
    const dataRows = rows.slice(1);
    const sortable = strategy === 'sortable';
    const table = buildHtmlTable(headers, dataRows, sortable);
    const title = typeof options['title'] === 'string' && options['title'].length > 0 ? options['title'] : DEFAULT_TITLE;
    const output = strategy === 'table' ? table : wrapDocument(table, sortable, title);
    const ragged = dataRows.filter((r) => r.length !== headers.length).length;
    return {
      output,
      stats: { rowCount: dataRows.length, columnCount: headers.length, delimiter: delimiter === '\t' ? 'tab' : delimiter, isDocument: strategy !== 'table' },
      ...(ragged > 0 ? { warnings: [`${ragged} row(s) have a different number of fields than the header`] } : {}),
    };
  },
};
