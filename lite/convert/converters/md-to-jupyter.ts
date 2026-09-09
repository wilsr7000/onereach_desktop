/**
 * Markdown → Jupyter notebook (ported from lib/converters/md-to-jupyter.js,
 * ADR-100). Fenced code blocks become code cells (the fence's info string
 * is kept as the cell's language), everything else becomes markdown cells.
 * Strategies: auto-cell (prose also splits at headings), strict-fence
 * (only fences make boundaries), annotated (cells tagged by content —
 * title, section, list, imports, definition…; long code cells collapsed).
 * The output is nbformat 4.5, with the per-cell ids that minor version
 * requires (the original wrote 4.5 without them).
 */

import type { Converter, ExecuteResult } from '../types.js';

export interface CellMetadata {
  language?: string;
  tags?: string[];
  collapsed?: boolean;
}

export interface MarkdownCell {
  id: string;
  cell_type: 'markdown';
  metadata: CellMetadata;
  source: string[];
}

export interface CodeCell {
  id: string;
  cell_type: 'code';
  execution_count: null;
  metadata: CellMetadata;
  outputs: unknown[];
  source: string[];
}

export type NotebookCellOut = MarkdownCell | CodeCell;

/** Jupyter's source array: every line keeps its newline except the last. */
export function toSourceArray(content: string): string[] {
  const lines = content.split('\n');
  return lines.map((line, i) => (i < lines.length - 1 ? `${line}\n` : line));
}

export function makeMarkdownCell(id: string, content: string): MarkdownCell {
  return { id, cell_type: 'markdown', metadata: {}, source: toSourceArray(content) };
}

export function makeCodeCell(id: string, content: string, language: string): CodeCell {
  return {
    id,
    cell_type: 'code',
    execution_count: null,
    metadata: language.length > 0 ? { language } : {},
    outputs: [],
    source: toSourceArray(content),
  };
}

/**
 * Markdown → cells. Backtick fences open with ```lang and close with a bare
 * ```; an unclosed fence runs to the end and is reported. auto-cell also
 * starts a new markdown cell at every heading.
 */
export function parseCells(input: string, strategy: string): { cells: NotebookCellOut[]; unclosedFence: boolean } {
  const cells: NotebookCellOut[] = [];
  const nextId = (): string => `cell-${cells.length + 1}`;
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  let block: string[] = [];
  let inFence = false;
  let fenceLanguage = '';
  const flushMarkdown = (): void => {
    const content = block.join('\n').trim();
    if (content.length > 0) cells.push(makeMarkdownCell(nextId(), content));
    block = [];
  };
  for (const line of lines) {
    const opening = /^```(\w*)/.exec(line);
    if (opening !== null && !inFence) {
      flushMarkdown();
      inFence = true;
      fenceLanguage = opening[1] ?? '';
    } else if (inFence && /^```\s*$/.test(line)) {
      cells.push(makeCodeCell(nextId(), block.join('\n'), fenceLanguage));
      block = [];
      inFence = false;
      fenceLanguage = '';
    } else if (inFence) {
      block.push(line);
    } else if (strategy === 'auto-cell' && /^#{1,6}\s/.test(line) && block.length > 0) {
      flushMarkdown();
      block = [line];
    } else {
      block.push(line);
    }
  }
  if (block.length > 0) {
    const content = block.join('\n').trim();
    if (content.length > 0) {
      if (inFence) cells.push(makeCodeCell(nextId(), content, fenceLanguage));
      else cells.push(makeMarkdownCell(nextId(), content));
    }
  }
  return { cells, unclosedFence: inFence };
}

/** Tag cells by what they hold; collapse code cells over 20 lines. Returns how many cells got tags. */
export function annotateCells(cells: NotebookCellOut[]): number {
  let tagged = 0;
  for (const cell of cells) {
    const source = cell.source.join('');
    const tags: string[] = [];
    if (cell.cell_type === 'markdown') {
      if (/^#\s/.test(source)) tags.push('title');
      else if (/^#{2,3}\s/.test(source)) tags.push('section');
      if (/^\s*[-*]\s/.test(source)) tags.push('list');
      if (/!\[/.test(source)) tags.push('has-images');
      if (/\[[^\[\]\n]*\]\([^()\n]*\)/.test(source)) tags.push('has-links');
    } else {
      if (/import\s|from\s.*import|require\(/.test(source)) tags.push('imports');
      if (/def\s|function\s|class\s/.test(source)) tags.push('definition');
      if (/print\(|console\.log|display\(/.test(source)) tags.push('output');
      if (source.split('\n').length > 20) {
        cell.metadata.collapsed = true;
        tags.push('long');
      }
    }
    if (tags.length > 0) {
      cell.metadata.tags = tags;
      tagged += 1;
    }
  }
  return tagged;
}

const KERNEL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  python: 'Python 3',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  r: 'R',
  julia: 'Julia',
  ruby: 'Ruby',
};

export function kernelDisplayName(language: string): string {
  return KERNEL_DISPLAY_NAMES[language] ?? language;
}

export const mdToJupyter: Converter = {
  spec: {
    id: 'md-to-jupyter',
    title: 'Markdown to Jupyter notebook',
    description: 'Fenced code blocks become code cells, prose becomes markdown cells; a valid nbformat 4 notebook.',
    from: ['md'],
    to: ['ipynb'],
    engine: 'pure',
    strategies: [
      { id: 'auto-cell', description: 'Fences make code cells; prose splits into a cell at every heading.', when: 'Prose and code mix and each section should be its own cell.' },
      { id: 'strict-fence', description: 'Only fences make boundaries; all prose between them is one cell.', when: 'Cell boundaries should follow the fences exactly.' },
      { id: 'annotated', description: 'Like strict-fence, plus metadata tags by content (title, section, imports…) and collapsed long code cells.', when: 'The notebook needs tags for navigation or presentation.' },
    ],
    defaultStrategy: 'auto-cell',
    options: [
      { name: 'kernelLanguage', type: 'string', description: 'Kernel language written to the notebook metadata (python selects the python3 kernelspec).', default: 'python' },
    ],
  },
  async execute(input, strategy, options): Promise<ExecuteResult> {
    const given = options['kernelLanguage'];
    const kernel = typeof given === 'string' && given.trim().length > 0 ? given.trim() : 'python';
    const { cells, unclosedFence } = parseCells(input, strategy);
    const taggedCells = strategy === 'annotated' ? annotateCells(cells) : 0;
    const notebook = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: {
          display_name: kernelDisplayName(kernel),
          language: kernel,
          name: kernel === 'python' ? 'python3' : kernel,
        },
        language_info: { name: kernel },
      },
      cells,
    };
    const output = JSON.stringify(notebook, null, 2);
    const codeCells = cells.filter((c) => c.cell_type === 'code').length;
    const warnings: string[] = [];
    if (cells.length === 0) warnings.push('Notebook has zero cells');
    if (unclosedFence) warnings.push('Unclosed code fence; the trailing content became a code cell');
    return {
      output,
      stats: {
        cellCount: cells.length,
        codeCells,
        markdownCells: cells.length - codeCells,
        kernelLanguage: kernel,
        taggedCells,
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
};
