/**
 * JSON → Markdown (ported from lib/converters/json-to-md.js, ADR-100).
 * Strategies: table (an array of objects becomes a pipe table under the
 * union of their keys; data without keys falls back to a JSON code
 * block), yaml-block (the data as YAML in a fenced block, through
 * js-yaml), list (a nested bullet list with the keys in bold). Any JSON
 * value is accepted — a scalar renders as itself.
 */

import { dump } from 'js-yaml';
import type { Converter, ExecuteResult } from '../types.js';
import { escapeMdCell } from './csv-to-md.js';
import { parseJson } from './json-to-csv.js';

type JsonObject = Record<string, unknown>;

function isObjectLike(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null;
}

/** The keys of every plain object in the list, in first-seen order (arrays and scalars contribute none). */
export function collectKeys(items: unknown[]): string[] {
  const keys = new Set<string>();
  for (const item of items) {
    if (isObjectLike(item) && !Array.isArray(item)) for (const k of Object.keys(item)) keys.add(k);
  }
  return [...keys];
}

/** A pipe table over the union of keys; an empty array or keyless data gets a fallback. */
export function buildTable(data: unknown): string {
  const items: unknown[] = Array.isArray(data) ? data : [data];
  if (items.length === 0) return '*Empty array*\n';
  const headers = collectKeys(items);
  if (headers.length === 0) return '```json\n' + JSON.stringify(data, null, 2) + '\n```\n';
  const headerRow = `| ${headers.map(escapeMdCell).join(' | ')} |`;
  const separatorRow = `| ${headers.map(() => '---').join(' | ')} |`;
  const dataRows = items.map((item) => {
    const cells = headers.map((h) => {
      const val = isObjectLike(item) ? item[h] : '';
      if (val === null || val === undefined) return '';
      return escapeMdCell(typeof val === 'object' ? JSON.stringify(val) : String(val));
    });
    return `| ${cells.join(' | ')} |`;
  });
  return [headerRow, separatorRow, ...dataRows].join('\n') + '\n';
}

/** The data as YAML in a fenced block. */
export function buildYamlBlock(data: unknown): string {
  return '```yaml\n' + dump(data, { indent: 2, lineWidth: 120 }) + '```\n';
}

function scalarText(value: unknown): string {
  return value === null || value === undefined ? '*null*' : String(value);
}

/** A nested bullet list: keys in bold, array items as plain bullets, nulls in italics. */
export function buildList(data: unknown, depth = 0): string {
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  const nest = (value: unknown): void => {
    const nested = buildList(value, depth + 1);
    if (nested.length > 0) lines.push(nested);
  };
  if (Array.isArray(data)) {
    for (const item of data as unknown[]) {
      if (isObjectLike(item)) {
        lines.push(`${indent}-`);
        nest(item);
      } else {
        lines.push(`${indent}- ${scalarText(item)}`);
      }
    }
  } else if (isObjectLike(data)) {
    for (const [key, value] of Object.entries(data)) {
      if (isObjectLike(value)) {
        lines.push(`${indent}- **${key}**:`);
        nest(value);
      } else {
        lines.push(`${indent}- **${key}**: ${scalarText(value)}`);
      }
    }
  } else {
    lines.push(`${indent}- ${scalarText(data)}`);
  }
  return lines.join('\n');
}

export const jsonToMd: Converter = {
  spec: {
    id: 'json-to-md',
    title: 'JSON to Markdown',
    description: 'JSON as a Markdown table, a fenced YAML block, or a nested bullet list.',
    from: ['json'],
    to: ['md'],
    engine: 'pure',
    strategies: [
      { id: 'table', description: 'An array of objects becomes a pipe table under the union of their keys.', when: 'The data is a list of flat records.' },
      { id: 'yaml-block', description: 'The data as YAML inside a fenced code block.', when: 'The structure matters more than a grid, and YAML reads better than JSON.' },
      { id: 'list', description: 'A nested bullet list, keys in bold.', when: 'The data is deeply nested and a tree reads best.' },
    ],
    defaultStrategy: 'table',
  },
  async execute(input, strategy, _options): Promise<ExecuteResult> {
    const data = parseJson(input);
    const warnings: string[] = [];
    let output: string;
    let stats: Record<string, string | number | boolean>;
    switch (strategy) {
      case 'yaml-block':
        try {
          output = buildYamlBlock(data);
        } catch (err) {
          output = '```json\n' + JSON.stringify(data, null, 2) + '\n```\n';
          warnings.push(`YAML rendering failed (${err instanceof Error ? err.message : String(err)}); emitted a JSON block instead`);
        }
        stats = { lines: output.split('\n').length - 1 };
        break;
      case 'list':
        output = buildList(data);
        stats = { entries: Array.isArray(data) ? data.length : isObjectLike(data) ? Object.keys(data).length : 1 };
        break;
      case 'table':
      default: {
        const items: unknown[] = Array.isArray(data) ? data : [data];
        const headers = collectKeys(items);
        output = buildTable(data);
        stats = { rowCount: items.length, columnCount: headers.length, isTable: headers.length > 0 };
        break;
      }
    }
    return { output, stats, ...(warnings.length > 0 ? { warnings } : {}) };
  },
};
