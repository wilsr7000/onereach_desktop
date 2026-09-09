/**
 * CSV → JSON (ported from lib/converters/csv-to-json.js, ADR-100).
 * Strategies: auto-type (numbers / booleans / null inferred),
 * string-only (every value stays a string), nested (rows grouped by the
 * first column). Quoted fields, embedded commas and newlines, and
 * doubled quotes are handled; blank lines are skipped.
 */

import type { Converter, ExecuteResult } from '../types.js';

/** Parse delimited text into rows of trimmed fields. Exported for tests and siblings. */
export function parseDelimited(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;
  const len = text.length;
  for (let i = 0; i < len; i += 1) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      current.push(field.trim());
      field = '';
    } else if (ch === '\n' || (ch === '\r' && next === '\n')) {
      current.push(field.trim());
      if (current.some((f) => f.length > 0)) rows.push(current);
      current = [];
      field = '';
      if (ch === '\r') i += 1;
    } else if (ch === '\r') {
      current.push(field.trim());
      if (current.some((f) => f.length > 0)) rows.push(current);
      current = [];
      field = '';
    } else {
      field += ch;
    }
  }
  current.push(field.trim());
  if (current.some((f) => f.length > 0)) rows.push(current);
  return rows;
}

/** "30" → 30, "true" → true, "null" → null, else the trimmed string. */
export function inferType(value: string | undefined): string | number | boolean | null {
  if (value === undefined || value === '') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const lower = trimmed.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (lower === 'null' || lower === 'none') return null;
  if (/^-?\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?\d+\.\d+$/.test(trimmed)) {
    const n = Number.parseFloat(trimmed);
    if (Number.isFinite(n)) return n;
  }
  return trimmed;
}

export const csvToJson: Converter = {
  spec: {
    id: 'csv-to-json',
    title: 'CSV to JSON',
    description: 'Rows become objects keyed by the header row; values typed, kept as strings, or grouped by the first column.',
    from: ['csv', 'tsv'],
    to: ['json'],
    engine: 'pure',
    strategies: [
      { id: 'auto-type', description: 'Numbers, booleans and null are typed; everything else stays a string.', when: 'The data is mixed and downstream code wants real numbers.' },
      { id: 'string-only', description: 'Every value stays exactly the string in the file.', when: 'Zip codes, ids with leading zeros, anything where "007" must stay "007".' },
      { id: 'nested', description: 'Rows are grouped under the first column\'s value.', when: 'The first column is a category and a tree reads better than a list.' },
    ],
    defaultStrategy: 'auto-type',
    options: [
      { name: 'delimiter', type: 'string', description: 'Field delimiter; "\\t" for TSV. Detected from the first line when omitted.' },
      { name: 'indent', type: 'number', description: 'JSON indentation (0 for compact).', default: 2 },
    ],
  },
  async execute(input, strategy, options): Promise<ExecuteResult> {
    const delimiter = resolveDelimiter(input, options['delimiter']);
    const rows = parseDelimited(input, delimiter);
    if (rows.length < 2) throw new Error('CSV must contain a header row and at least one data row');
    const headers = rows[0] as string[];
    const dataRows = rows.slice(1);
    const indentRaw = options['indent'];
    const indent = typeof indentRaw === 'number' && Number.isFinite(indentRaw) ? Math.max(0, Math.min(8, Math.floor(indentRaw))) : 2;
    const space = indent === 0 ? undefined : indent;
    let output: string;
    switch (strategy) {
      case 'string-only':
        output = JSON.stringify(
          dataRows.map((row) => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? '']))),
          null,
          space
        );
        break;
      case 'nested': {
        const groupKey = headers[0] as string;
        const groups: Record<string, Array<Record<string, unknown>>> = {};
        for (const row of dataRows) {
          const key = row[0] !== undefined && row[0].length > 0 ? row[0] : 'ungrouped';
          const obj: Record<string, unknown> = {};
          headers.slice(1).forEach((h, i) => {
            obj[h] = inferType(row[i + 1]);
          });
          (groups[key] ??= []).push(obj);
        }
        output = JSON.stringify({ groupedBy: groupKey, groups }, null, space);
        break;
      }
      case 'auto-type':
      default:
        output = JSON.stringify(
          dataRows.map((row) => Object.fromEntries(headers.map((h, i) => [h, inferType(row[i])]))),
          null,
          space
        );
        break;
    }
    const ragged = dataRows.filter((r) => r.length !== headers.length).length;
    return {
      output,
      stats: { rowCount: dataRows.length, columnCount: headers.length, delimiter: delimiter === '\t' ? 'tab' : delimiter },
      ...(ragged > 0 ? { warnings: [`${ragged} row(s) have a different number of fields than the header`] } : {}),
    };
  },
};

/** The caller's delimiter, else tab when the first line has tabs and no commas, else comma. */
export function resolveDelimiter(input: string, given: unknown): string {
  if (typeof given === 'string' && given.length > 0) return given === '\\t' ? '\t' : given;
  const first = input.split(/\r?\n/, 1)[0] ?? '';
  if (first.includes('\t') && !first.includes(',')) return '\t';
  if (first.includes(';') && !first.includes(',')) return ';';
  return ',';
}
