/**
 * JSON ⇄ YAML through js-yaml (ported from lib/converters/json-yaml.js,
 * ADR-100). The original sniffed the direction from the input; Lite's
 * registry keys converters by format, so this file exports one converter
 * per direction — `jsonToYaml` and `yamlToJson` — sharing the strategies:
 * standard (one-to-one, keys in their original order) and ordered (object
 * keys sorted alphabetically at every level, for diffs). The original's
 * third strategy, commented, had a model annotate the YAML and is not
 * ported.
 */

import { dump, load } from 'js-yaml';
import type { Converter, ConverterStrategy, ExecuteResult } from '../types.js';
import { parseJson } from './json-to-csv.js';

const STRATEGIES: readonly ConverterStrategy[] = [
  { id: 'standard', description: 'A one-to-one conversion; keys keep their order.', when: 'Plain format conversion.' },
  { id: 'ordered', description: 'Object keys sorted alphabetically at every level.', when: 'Diffs, version control, anything that wants a deterministic key order.' },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Object keys sorted at every level; arrays recurse; dates, buffers and scalars pass through. */
export function sortKeysDeep(data: unknown): unknown {
  if (Array.isArray(data)) return (data as unknown[]).map((item) => sortKeysDeep(item));
  if (isPlainObject(data)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(data).sort()) sorted[key] = sortKeysDeep(data[key]);
    return sorted;
  }
  return data;
}

/** One YAML document, parsed; a plain Error for bad YAML, several documents, or nothing at all. */
export function parseYaml(input: string): unknown {
  if (input.trim().length === 0) throw new Error('Input is empty');
  let data: unknown;
  try {
    data = load(input);
  } catch (err) {
    const reason = err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err);
    throw new Error(`Input is not valid YAML: ${reason}`);
  }
  if (data === undefined) throw new Error('YAML document is empty');
  return data;
}

function clampIndent(raw: unknown, fallback: number, min: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(min, Math.min(8, Math.floor(raw))) : fallback;
}

function shapeStats(data: unknown, sorted: boolean): Record<string, string | number | boolean> {
  if (Array.isArray(data)) return { kind: 'array', entries: data.length, sorted };
  if (isPlainObject(data)) return { kind: 'object', entries: Object.keys(data).length, sorted };
  return { kind: 'scalar', entries: 1, sorted };
}

export const jsonToYaml: Converter = {
  spec: {
    id: 'json-to-yaml',
    title: 'JSON to YAML',
    description: 'JSON as YAML, keys in their original order or sorted.',
    from: ['json'],
    to: ['yaml'],
    engine: 'js-yaml',
    strategies: STRATEGIES,
    defaultStrategy: 'standard',
    options: [
      { name: 'indent', type: 'number', description: 'Spaces per nesting level.', default: 2 },
      { name: 'lineWidth', type: 'number', description: 'Fold long strings at this column; 0 or less never folds.', default: 120 },
    ],
  },
  async execute(input, strategy, options): Promise<ExecuteResult> {
    const ordered = strategy === 'ordered';
    const parsed = parseJson(input);
    const data = ordered ? sortKeysDeep(parsed) : parsed;
    const widthRaw = options['lineWidth'];
    const lineWidth = typeof widthRaw === 'number' && Number.isFinite(widthRaw) ? (widthRaw <= 0 ? -1 : Math.floor(widthRaw)) : 120;
    const output = dump(data, { indent: clampIndent(options['indent'], 2, 1), lineWidth, noRefs: true, sortKeys: ordered });
    return { output, stats: shapeStats(data, ordered) };
  },
};

export const yamlToJson: Converter = {
  spec: {
    id: 'yaml-to-json',
    title: 'YAML to JSON',
    description: 'One YAML document as JSON, keys in their original order or sorted.',
    from: ['yaml'],
    to: ['json'],
    engine: 'js-yaml',
    strategies: STRATEGIES,
    defaultStrategy: 'standard',
    options: [{ name: 'indent', type: 'number', description: 'JSON indentation (0 for compact).', default: 2 }],
  },
  async execute(input, strategy, options): Promise<ExecuteResult> {
    const ordered = strategy === 'ordered';
    const parsed = parseYaml(input);
    const data = ordered ? sortKeysDeep(parsed) : parsed;
    const indent = clampIndent(options['indent'], 2, 0);
    const output = JSON.stringify(data, null, indent === 0 ? undefined : indent);
    return {
      output,
      stats: shapeStats(data, ordered),
      ...(data === null ? { warnings: ['YAML document parsed to null'] } : {}),
    };
  },
};
