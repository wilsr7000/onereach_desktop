/**
 * Jupyter notebook → Markdown (ported from lib/converters/jupyter-to-md.js,
 * ADR-100). Markdown cells pass through, code cells become fences tagged
 * with the cell's language (else the kernel's), raw cells become untagged
 * fences. Strategies: flat (cells in order), sectioned (a rule between
 * runs of different cell types), with-output (execution outputs quoted
 * under their code cell). The notebook readers are exported for tests and
 * for the sibling jupyter-to-python port.
 */

import type { Converter, ExecuteResult } from '../types.js';

/** A cell as read from .ipynb JSON — every field is whatever the file says. */
export type NotebookCell = Record<string, unknown>;

export interface Notebook {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
}

export type CellType = 'markdown' | 'code' | 'raw' | 'unknown';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Join .ipynb text fragments the way Array#join does (null/undefined vanish). */
function joinText(parts: readonly unknown[], separator = ''): string {
  return parts.map((p) => (typeof p === 'string' ? p : p === null || p === undefined ? '' : String(p))).join(separator);
}

/** A string, or a list of fragments, as one string; anything else is empty. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return joinText(value);
  return '';
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '' && value !== false;
}

/** Parse .ipynb text. Throws on bad JSON, a non-object, or a missing cells array. */
export function parseNotebook(input: string): Notebook {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    throw new Error(`Failed to parse Jupyter notebook JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(parsed)) throw new Error('Invalid Jupyter notebook: expected a JSON object');
  const cells = parsed['cells'];
  if (!Array.isArray(cells)) throw new Error('Invalid Jupyter notebook: missing cells array');
  const metadata = parsed['metadata'];
  return {
    cells: cells.map((c: unknown) => (isRecord(c) ? c : {})),
    metadata: isRecord(metadata) ? metadata : {},
  };
}

export function cellType(cell: NotebookCell): CellType {
  const t = cell['cell_type'];
  if (t === 'markdown') return 'markdown';
  if (t === 'code') return 'code';
  if (t === 'raw') return 'raw';
  return 'unknown';
}

/** A cell's text: .ipynb stores source as a string or a list of line fragments. */
export function cellSource(cell: NotebookCell): string {
  return textOf(cell['source']);
}

/** kernelspec.language, else language_info.name, else python. */
export function kernelLanguage(notebook: Notebook): string {
  const kernelspec = notebook.metadata['kernelspec'];
  if (isRecord(kernelspec)) {
    const language = kernelspec['language'];
    if (typeof language === 'string' && language.length > 0) return language;
  }
  const info = notebook.metadata['language_info'];
  if (isRecord(info)) {
    const name = info['name'];
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return 'python';
}

/**
 * Cell outputs as readable text: streams and text/plain verbatim, a
 * placeholder for HTML and images, errors with their ANSI colour stripped.
 * Outputs with no textual form (application/json…) contribute nothing.
 */
export function formatOutputs(outputs: readonly unknown[]): string {
  const parts: string[] = [];
  for (const out of outputs) {
    if (!isRecord(out)) continue;
    const type = out['output_type'];
    if (type === 'stream') {
      parts.push(textOf(out['text']));
    } else if (type === 'execute_result' || type === 'display_data') {
      const data = isRecord(out['data']) ? out['data'] : {};
      const plain = textOf(data['text/plain']);
      if (plain.length > 0) parts.push(plain);
      else if (present(data['text/html'])) parts.push('[HTML output]');
      else if (present(data['image/png']) || present(data['image/jpeg'])) parts.push('[Image output]');
    } else if (type === 'error') {
      const raw = out['traceback'];
      const traceback = Array.isArray(raw) ? joinText(raw, '\n') : textOf(raw);
      const clean = traceback.replace(/\x1b\[[0-9;]*m/g, '');
      const ename = out['ename'];
      const evalue = out['evalue'];
      const name = typeof ename === 'string' && ename.length > 0 ? ename : 'Unknown';
      const value = typeof evalue === 'string' ? evalue : '';
      parts.push(`Error: ${name}: ${value}\n${clean}`);
    }
  }
  return parts.join('\n');
}

export const jupyterToMd: Converter = {
  spec: {
    id: 'jupyter-to-md',
    title: 'Jupyter notebook to Markdown',
    description: 'Markdown cells pass through, code cells become fenced blocks tagged with the kernel language; outputs can be quoted under their cells.',
    from: ['ipynb'],
    to: ['md'],
    engine: 'pure',
    strategies: [
      { id: 'flat', description: 'Every cell in document order, nothing added.', when: 'The notebook reads naturally top to bottom.' },
      { id: 'sectioned', description: 'A horizontal rule between runs of different cell types.', when: 'Prose and code alternate and the seams should show.' },
      { id: 'with-output', description: 'Execution outputs quoted under their code cells (text, or a placeholder for HTML and images).', when: 'The results matter — documentation, review, the record of a run.' },
    ],
    defaultStrategy: 'flat',
  },
  async execute(input, strategy): Promise<ExecuteResult> {
    const notebook = parseNotebook(input);
    const kernel = kernelLanguage(notebook);
    const parts: string[] = [];
    const counts = { code: 0, markdown: 0, raw: 0, unknown: 0 };
    let outputsPresent = 0;
    let outputsRendered = 0;
    let previousType: CellType | null = null;
    for (let i = 0; i < notebook.cells.length; i += 1) {
      const cell = notebook.cells[i];
      if (cell === undefined) continue;
      const type = cellType(cell);
      const source = cellSource(cell);
      if (strategy === 'sectioned') {
        if (i > 0 && type !== previousType) parts.push('\n---\n');
        previousType = type;
      }
      if (type === 'markdown') {
        counts.markdown += 1;
        parts.push(source);
      } else if (type === 'code') {
        counts.code += 1;
        const metadata = cell['metadata'];
        const own = isRecord(metadata) ? metadata['language'] : undefined;
        const language = typeof own === 'string' && own.length > 0 ? own : kernel;
        parts.push(`\`\`\`${language}\n${source}\n\`\`\``);
        const outputs = cell['outputs'];
        if (Array.isArray(outputs) && outputs.length > 0) {
          outputsPresent += 1;
          if (strategy === 'with-output') {
            const text = formatOutputs(outputs).replace(/\n+$/, '');
            if (text.trim().length > 0) {
              outputsRendered += 1;
              parts.push(`\n**Output:**\n${text.split('\n').map((line) => `> ${line}`).join('\n')}`);
            }
          }
        }
      } else if (type === 'raw') {
        counts.raw += 1;
        parts.push(`\`\`\`\n${source}\n\`\`\``);
      } else {
        counts.unknown += 1;
      }
    }
    const output = parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    const warnings: string[] = [];
    if (notebook.cells.length === 0) warnings.push('Notebook has no cells; the output is empty');
    if (counts.unknown > 0) warnings.push(`${counts.unknown} cell(s) with an unknown cell_type were skipped`);
    if (strategy === 'with-output' && outputsPresent > 0 && outputsRendered === 0) {
      warnings.push('with-output: no cell output could be rendered as text');
    }
    return {
      output,
      stats: {
        cellCount: notebook.cells.length,
        codeCells: counts.code,
        markdownCells: counts.markdown,
        rawCells: counts.raw,
        kernelLanguage: kernel,
        outputsRendered,
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
};
