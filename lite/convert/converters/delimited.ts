/**
 * CSV ↔ TSV (ADR-100 Amendment 1). The review found tsv declared as a
 * format that nothing produced: csv → tsv resolved to nothing, and a
 * pipeline through JSON would have retyped the cells on the way. This is
 * the direct edge: every row parsed with the source delimiter and written
 * again with the target's, quoting normalised, cells untouched.
 */

import type { Converter, ExecuteResult } from '../types.js';
import { parseDelimited, resolveDelimiter } from './csv-to-json.js';
import { escapeCsvField } from './json-to-csv.js';

/** Tab for a tsv source unless told otherwise; else the caller's delimiter, else detected from the first line. */
export function inputDelimiter(input: string, given: unknown, from: string | undefined): string {
  if (typeof given === 'string' && given.length > 0) return resolveDelimiter(input, given);
  if (from === 'tsv') return '\t';
  return resolveDelimiter(input, undefined);
}

export const delimited: Converter = {
  spec: {
    id: 'delimited',
    title: 'CSV ↔ TSV',
    description: 'Re-delimits tabular text: comma-separated to tab-separated and back. Cells are kept as they are; quoting is normalised for the target.',
    from: ['csv', 'tsv'],
    to: ['csv', 'tsv'],
    engine: 'pure',
    strategies: [
      { id: 'requote', description: 'Every row parsed and written again with the target delimiter; fields holding it, a quote or a line break are quoted.', when: 'Always — the only strategy.' },
    ],
    defaultStrategy: 'requote',
    options: [{ name: 'delimiter', type: 'string', description: 'Input delimiter ("\\t" for a tab). A tsv source assumes tabs, a csv source is detected from the first line.' }],
  },
  async execute(input, _strategy, options, context): Promise<ExecuteResult> {
    if (input.trim().length === 0) throw new Error('Input is empty');
    const from = inputDelimiter(input, options['delimiter'], context?.from);
    const to = context?.to === 'tsv' ? '\t' : ',';
    const rows = parseDelimited(input, from);
    if (rows.length === 0) throw new Error('No rows found');
    const width = rows[0]?.length ?? 0;
    const ragged = rows.filter((r) => r.length !== width).length;
    const output = rows.map((row) => row.map((cell) => escapeCsvField(cell, to)).join(to)).join('\n');
    return {
      output,
      stats: { rowCount: rows.length, columnCount: width, from: from === '\t' ? 'tab' : from, to: to === '\t' ? 'tab' : to },
      ...(ragged > 0 ? { warnings: [`${ragged} row(s) have a different number of fields than the first row`] } : {}),
    };
  },
};
