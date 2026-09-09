/**
 * JSON → HTML (ported from lib/converters/json-to-html.js, ADR-100).
 * Strategies: table (an array of objects becomes a <table> under the
 * union of their keys), tree (nested <ul> lists with a class per value
 * type, for styling or collapsing), pretty (the formatted JSON in a
 * <pre> block with light syntax-highlighting spans). Text is escaped;
 * any JSON value is accepted.
 */

import type { Converter, ExecuteResult } from '../types.js';
import { parseJson } from './json-to-csv.js';

type JsonObject = Record<string, unknown>;

function isObjectLike(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null;
}

function escapeText(v: unknown): string {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** The keys of every object in the list, in first-seen order. */
export function collectKeys(items: unknown[]): string[] {
  const keys = new Set<string>();
  for (const item of items) if (isObjectLike(item)) for (const k of Object.keys(item)) keys.add(k);
  return [...keys];
}

/** A <table> over the union of keys; objects in cells are shown as JSON. */
export function buildTable(data: unknown): string {
  const items: unknown[] = Array.isArray(data) ? data : [data];
  if (items.length === 0) return '<table><tbody><tr><td>Empty array</td></tr></tbody></table>';
  const headers = collectKeys(items);
  const thead = `<thead><tr>${headers.map((h) => `<th>${escapeText(h)}</th>`).join('')}</tr></thead>`;
  const rows = items.map((item) => {
    const cells = headers.map((h) => {
      const val = isObjectLike(item) ? item[h] : '';
      const display = typeof val === 'object' ? JSON.stringify(val) : val;
      return `<td>${escapeText(display)}</td>`;
    });
    return `<tr>${cells.join('')}</tr>`;
  });
  const tbody = `<tbody>${rows.join('\n')}</tbody>`;
  return `<table>\n${thead}\n${tbody}\n</table>`;
}

/** Nested <ul> lists: json-object / json-array with json-key, json-str, json-num, json-bool, json-null spans. */
export function buildTree(data: unknown, depth = 0): string {
  const indent = '  '.repeat(depth);
  if (data === null || data === undefined) return `${indent}<span class="json-null">null</span>`;
  if (typeof data === 'boolean') return `${indent}<span class="json-bool">${data}</span>`;
  if (typeof data === 'number') return `${indent}<span class="json-num">${data}</span>`;
  if (typeof data === 'string') return `${indent}<span class="json-str">"${escapeText(data)}"</span>`;
  if (Array.isArray(data)) {
    if (data.length === 0) return `${indent}<span class="json-bracket">[]</span>`;
    const items = (data as unknown[]).map((v) => `${indent}  <li>${buildTree(v, depth + 1)}</li>`).join('\n');
    return `<ul class="json-array">\n${items}\n${indent}</ul>`;
  }
  if (isObjectLike(data)) {
    const keys = Object.keys(data);
    if (keys.length === 0) return `${indent}<span class="json-bracket">{}</span>`;
    const entries = keys
      .map((k) => `${indent}  <li><span class="json-key">${escapeText(k)}</span>: ${buildTree(data[k], depth + 1)}</li>`)
      .join('\n');
    return `<ul class="json-object">\n${entries}\n${indent}</ul>`;
  }
  return `${indent}<span>${escapeText(String(data))}</span>`;
}

/** The formatted JSON in a <pre>; keys, strings, numbers, booleans and null wrapped in spans. */
export function buildPretty(data: unknown): string {
  const formatted = JSON.stringify(data, null, 2);
  const highlighted = escapeText(formatted)
    .replace(/"([^"]+)"(?=\s*:)/g, '<span class="json-key">"$1"</span>')
    .replace(/:\s*"([^"]*)"/g, ': <span class="json-str">"$1"</span>')
    .replace(/:\s*(\d+\.?\d*)/g, ': <span class="json-num">$1</span>')
    .replace(/:\s*(true|false)/g, ': <span class="json-bool">$1</span>')
    .replace(/:\s*(null)/g, ': <span class="json-null">$1</span>');
  return `<pre class="json-pretty"><code>${highlighted}</code></pre>`;
}

export const jsonToHtml: Converter = {
  spec: {
    id: 'json-to-html',
    title: 'JSON to HTML',
    description: 'JSON as an HTML table, a nested tree of lists, or a highlighted <pre> block.',
    from: ['json'],
    to: ['html'],
    engine: 'pure',
    strategies: [
      { id: 'table', description: 'An array of objects becomes a <table> under the union of their keys.', when: 'The data is a list of flat records.' },
      { id: 'tree', description: 'Nested <ul> lists with a class per value type (json-key, json-str, json-num…).', when: 'The data is deeply nested; style or collapse it with CSS.' },
      { id: 'pretty', description: 'The formatted JSON in a <pre> with syntax-highlighting spans.', when: 'Developers will read the raw JSON.' },
    ],
    defaultStrategy: 'table',
  },
  async execute(input, strategy, _options): Promise<ExecuteResult> {
    const data = parseJson(input);
    let output: string;
    let stats: Record<string, string | number | boolean>;
    switch (strategy) {
      case 'tree':
        output = buildTree(data);
        stats = { nodes: (output.match(/<li>/g) ?? []).length };
        break;
      case 'pretty':
        output = buildPretty(data);
        stats = { lines: JSON.stringify(data, null, 2).split('\n').length };
        break;
      case 'table':
      default: {
        const items: unknown[] = Array.isArray(data) ? data : [data];
        output = buildTable(data);
        stats = { rowCount: items.length, columnCount: collectKeys(items).length };
        break;
      }
    }
    return { output, stats };
  },
};
