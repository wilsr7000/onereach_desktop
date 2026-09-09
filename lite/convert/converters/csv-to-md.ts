/**
 * CSV → Markdown table (ported from lib/converters/csv-to-md.js, ADR-100).
 * Strategies: simple (a plain pipe table), aligned (cells padded so the
 * columns line up in the source). The original's third strategy, summary,
 * put a model-written paragraph under the aligned table and is not
 * ported. Pipes inside cells are escaped and line breaks become <br>, so
 * a quoted field cannot break the table; TSV is read through the same
 * delimiter detection as csv-to-json.
 */

import type { Converter, ExecuteResult } from '../types.js';
import { parseDelimited, resolveDelimiter } from './csv-to-json.js';

/** A cell's text made safe for a table row: pipes escaped, line breaks as <br>. Exported for siblings. */
export function escapeMdCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

/** Header, separator and body rows; `aligned` pads every column to its widest cell. */
export function buildMarkdownTable(headers: string[], dataRows: string[][], aligned: boolean): string {
  const heads = headers.map(escapeMdCell);
  const cell = (row: string[], i: number): string => escapeMdCell(row[i] ?? '');
  const widths = heads.map((h, i) => (aligned ? Math.max(h.length, ...dataRows.map((row) => cell(row, i).length)) : 0));
  const pad = (val: string, i: number): string => val + ' '.repeat(Math.max(0, (widths[i] ?? 0) - val.length));
  const headerRow = `| ${heads.map((h, i) => pad(h, i)).join(' | ')} |`;
  const separatorRow = `| ${widths.map((w) => (aligned ? '-'.repeat(w) : '---')).join(' | ')} |`;
  const bodyRows = dataRows.map((row) => `| ${heads.map((_, i) => pad(cell(row, i), i)).join(' | ')} |`);
  return [headerRow, separatorRow, ...bodyRows].join('\n');
}

export const csvToMd: Converter = {
  spec: {
    id: 'csv-to-md',
    title: 'CSV to Markdown',
    description: 'Rows become a Markdown table under the header row: plain, or padded so the columns line up in the source.',
    from: ['csv', 'tsv'],
    to: ['md'],
    engine: 'pure',
    strategies: [
      { id: 'simple', description: 'A plain pipe table with a --- separator row.', when: 'The table will be rendered, not read as source.' },
      { id: 'aligned', description: 'Cells padded so the columns line up in the raw Markdown.', when: 'People will read the source — a README, a doc, a review.' },
    ],
    defaultStrategy: 'simple',
    options: [{ name: 'delimiter', type: 'string', description: 'Field delimiter; "\\t" for TSV. Detected from the first line when omitted.' }],
  },
  async execute(input, strategy, options): Promise<ExecuteResult> {
    const delimiter = resolveDelimiter(input, options['delimiter']);
    const rows = parseDelimited(input, delimiter);
    if (rows.length < 2) throw new Error('CSV must contain at least a header row and one data row');
    const headers = rows[0] as string[];
    const dataRows = rows.slice(1);
    const output = buildMarkdownTable(headers, dataRows, strategy === 'aligned');
    const ragged = dataRows.filter((r) => r.length !== headers.length).length;
    return {
      output,
      stats: { rowCount: dataRows.length, columnCount: headers.length, delimiter: delimiter === '\t' ? 'tab' : delimiter },
      ...(ragged > 0 ? { warnings: [`${ragged} row(s) have a different number of fields than the header`] } : {}),
    };
  },
};
