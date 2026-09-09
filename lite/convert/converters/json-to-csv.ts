/**
 * JSON → CSV (ported from lib/converters/json-to-csv.js, ADR-100).
 * Strategies: flat (nested objects become dot-notation columns, arrays
 * stay as JSON text), top-level (only the scalar top-level keys; nested
 * objects and arrays are skipped). The original's third strategy,
 * custom-columns, had a model choose the columns and is not ported —
 * without the model it was `flat`. A single object is treated as a
 * one-row array; fields holding commas, quotes or line breaks are
 * quoted; rows are joined with "\n".
 */

import type { Converter, ExecuteResult } from '../types.js';

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/** JSON.parse with a plain Error that names the problem. Exported for siblings. */
export function parseJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch (err) {
    throw new Error(`Input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The input as a non-empty list of objects — an array of them, or one object wrapped. */
export function parseJsonRows(input: string): JsonObject[] {
  const data = parseJson(input);
  let list: unknown[];
  if (Array.isArray(data)) list = data;
  else if (isPlainObject(data)) list = [data];
  else throw new Error('Input must be a JSON array or object');
  if (list.length === 0) throw new Error('Input array is empty');
  return list.map((item, i) => {
    if (!isPlainObject(item)) throw new Error(`Input must be an array of objects (item ${i} is ${describeValue(item)})`);
    return item;
  });
}

/** Nested objects become dot-notation keys; arrays are kept as JSON text. */
export function flattenObject(obj: JsonObject, prefix = ''): JsonObject {
  const result: JsonObject = {};
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix.length > 0 ? `${prefix}.${key}` : key;
    if (isPlainObject(val)) Object.assign(result, flattenObject(val, fullKey));
    else if (Array.isArray(val)) result[fullKey] = JSON.stringify(val);
    else result[fullKey] = val;
  }
  return result;
}

/** null and undefined print as nothing, objects as JSON, everything else as itself. */
export function formatCsvValue(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

/** Quote a field holding the delimiter, a quote or a line break; quotes inside are doubled. */
export function escapeCsvField(field: string, delimiter = ','): string {
  const needsQuotes = field.includes(delimiter) || field.includes('"') || field.includes('\r') || field.includes('\n');
  return needsQuotes ? `"${field.replace(/"/g, '""')}"` : field;
}

/** The output delimiter: the option when given ("\\t" spells a tab), else a tab for a tsv target, else a comma. */
export function outputDelimiter(given: unknown, to: string | undefined): string {
  if (typeof given === 'string' && given.length > 0) return given === '\\t' ? '\t' : given;
  return to === 'tsv' ? '\t' : ',';
}

export interface CsvColumns {
  headers: string[];
  rows: unknown[][];
  warnings: string[];
}

/** The columns a strategy exports and the cell values under them, in first-seen key order. */
export function selectColumns(items: JsonObject[], strategy: string): CsvColumns {
  const warnings: string[] = [];
  if (strategy === 'top-level') {
    const headerSet = new Set<string>();
    const nested = new Set<string>();
    for (const item of items) {
      for (const [key, val] of Object.entries(item)) {
        if (val === null || typeof val !== 'object') headerSet.add(key);
        else nested.add(key);
      }
    }
    const headers = [...headerSet];
    const skipped = [...nested].filter((k) => !headerSet.has(k));
    if (skipped.length > 0) warnings.push(`Skipped ${skipped.length} nested field(s): ${skipped.join(', ')}`);
    return { headers, rows: items.map((item) => headers.map((h) => item[h])), warnings };
  }
  const flatItems = items.map((item) => flattenObject(item));
  const headerSet = new Set<string>();
  for (const item of flatItems) for (const k of Object.keys(item)) headerSet.add(k);
  const headers = [...headerSet];
  return { headers, rows: flatItems.map((item) => headers.map((h) => item[h])), warnings };
}

export const jsonToCsv: Converter = {
  spec: {
    id: 'json-to-csv',
    title: 'JSON to CSV',
    description: 'An array of objects becomes rows under a header of their keys; nested objects flattened to dot-notation columns or skipped.',
    from: ['json'],
    to: ['csv', 'tsv'],
    engine: 'pure',
    strategies: [
      { id: 'flat', description: 'Nested objects become dot-notation columns (address.city); arrays stay as JSON text.', when: 'Nothing should be lost — every nested value gets a column.' },
      { id: 'top-level', description: 'Only top-level scalar keys; nested objects and arrays are skipped.', when: 'The records are mostly flat and the nested parts are noise.' },
    ],
    defaultStrategy: 'flat',
    options: [{ name: 'delimiter', type: 'string', description: 'Field delimiter; "\\t" for a tab. A tsv target uses a tab when omitted, csv a comma.' }],
  },
  async execute(input, strategy, options, context): Promise<ExecuteResult> {
    const delimiter = outputDelimiter(options['delimiter'], context?.to);
    const items = parseJsonRows(input);
    const { headers, rows, warnings } = selectColumns(items, strategy);
    if (headers.length === 0) throw new Error('No columns to export (no scalar fields found)');
    const lines = [headers.map((h) => escapeCsvField(h, delimiter)).join(delimiter), ...rows.map((row) => row.map((v) => escapeCsvField(formatCsvValue(v), delimiter)).join(delimiter))];
    const output = lines.join('\n');
    if (headers.length === 1) warnings.push('CSV has a single column');
    return {
      output,
      stats: { rowCount: rows.length, columnCount: headers.length, delimiter: delimiter === '\t' ? 'tab' : delimiter },
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
};
