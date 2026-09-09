/**
 * Jupyter notebook → Python script (ported from
 * lib/converters/jupyter-to-python.js, ADR-100). Strategies: code-only
 * (code cells, nothing else), with-comments (markdown cells become
 * # comments between the code), executable (imports hoisted, sorted and
 * de-duplicated, def/class blocks at module level, everything else under
 * an `if __name__ == "__main__":` guard). IPython magics and shell escapes
 * (`%…`, `%%…`, `!…`) are not Python, so they are commented out and
 * counted in a warning — the original let them through.
 */

import type { Converter, ExecuteResult } from '../types.js';
import { cellSource, cellType, kernelLanguage, parseNotebook, type CellType } from './jupyter-to-md.js';

const SHEBANG = '#!/usr/bin/env python3';

/**
 * A whole-line Python import: `import a`, `import a.b as c, d`,
 * `from x import y`, an optional trailing comment. The original's pattern
 * stopped at the first token, so `import numpy as np` never hoisted.
 */
export const IMPORT_PATTERN = /^\s*(import\s+[\w.]+(\s+as\s+\w+)?(\s*,\s*[\w.]+(\s+as\s+\w+)?)*|from\s+\S+\s+import\s+.+?)(\s*#.*)?\s*$/;

/** A line that IPython would run, not Python: `%magic`, `%%cell magic`, `!shell`. */
export const MAGIC_PATTERN = /^\s*[%!]/;

export interface PreparedCell {
  type: CellType;
  source: string;
}

/** Comment out magic and shell lines, keeping their indentation. */
export function commentOutMagics(source: string): { text: string; count: number } {
  let count = 0;
  const lines = source.split('\n').map((line) => {
    if (!MAGIC_PATTERN.test(line)) return line;
    count += 1;
    return line.replace(/^(\s*)/, '$1# ');
  });
  return { text: lines.join('\n'), count };
}

export function buildCodeOnly(cells: readonly PreparedCell[]): string {
  const lines = [SHEBANG, ''];
  for (const cell of cells) {
    if (cell.type !== 'code' || cell.source.trim().length === 0) continue;
    lines.push(cell.source, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function buildWithComments(cells: readonly PreparedCell[]): string {
  const lines = [SHEBANG, ''];
  for (const cell of cells) {
    if (cell.source.trim().length === 0) continue;
    if (cell.type === 'markdown') {
      for (const line of cell.source.split('\n')) {
        const trimmed = line.trimEnd();
        lines.push(trimmed.length > 0 ? `# ${trimmed}` : '#');
      }
      lines.push('');
    } else if (cell.type === 'code') {
      lines.push(cell.source, '');
    }
    // raw cells are dropped, as in the original
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Split module-level code into definitions (def / class / async def, with
 * the decorators above them and their indented bodies) and the statements
 * that run. Exported for tests.
 */
export function separateDefinitions(lines: readonly string[]): { definitions: string[]; executable: string[] } {
  const definitions: string[] = [];
  const executable: string[] = [];
  let inDefinition = false;
  let defIndent = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;
    if (/^(def |class |async def |@)/.test(trimmed)) {
      inDefinition = true;
      defIndent = indent;
      definitions.push(line);
      continue;
    }
    if (inDefinition) {
      if (trimmed.length === 0 || indent > defIndent) {
        definitions.push(line);
        continue;
      }
      inDefinition = false;
      definitions.push('');
    }
    executable.push(line);
  }
  return { definitions, executable };
}

export function buildExecutable(cells: readonly PreparedCell[]): { script: string; imports: number } {
  const imports = new Set<string>();
  const mainCode: string[] = [];
  for (const cell of cells) {
    if (cell.type !== 'code' || cell.source.trim().length === 0) continue;
    for (const line of cell.source.split('\n')) {
      if (IMPORT_PATTERN.test(line)) imports.add(line.trim());
      else mainCode.push(line);
    }
    mainCode.push('');
  }
  const lines = [SHEBANG, '"""', 'Converted from Jupyter Notebook.', '"""', ''];
  if (imports.size > 0) {
    const sorted = [...imports].sort((a, b) => {
      const aFrom = a.startsWith('from');
      const bFrom = b.startsWith('from');
      if (aFrom !== bFrom) return aFrom ? 1 : -1;
      return a.localeCompare(b);
    });
    lines.push(...sorted, '');
  }
  const { definitions, executable } = separateDefinitions(mainCode);
  if (definitions.length > 0) lines.push('', ...definitions);
  lines.push('', 'if __name__ == "__main__":');
  const body = executable.some((line) => line.trim().length > 0) ? executable : [];
  for (const line of body) lines.push(line.trim().length === 0 ? '' : `    ${line}`);
  const hasStatement = body.some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith('#');
  });
  if (!hasStatement) lines.push('    pass');
  lines.push('');
  return { script: lines.join('\n'), imports: imports.size };
}

export const jupyterToPython: Converter = {
  spec: {
    id: 'jupyter-to-python',
    title: 'Jupyter notebook to Python',
    description: 'The notebook as a Python script: code cells alone, with the prose as comments, or restructured into a runnable module.',
    from: ['ipynb'],
    to: ['py'],
    engine: 'pure',
    strategies: [
      { id: 'code-only', description: 'Code cells only, in order, under a shebang.', when: 'Only the executable code is wanted.' },
      { id: 'with-comments', description: 'Markdown cells become # comments between the code cells.', when: 'The prose gives the code its context — review, archival.' },
      { id: 'executable', description: 'Imports hoisted and de-duplicated, definitions at module level, the rest under an if __name__ == "__main__" guard.', when: 'The result should run as a script or import as a module.' },
    ],
    defaultStrategy: 'code-only',
  },
  async execute(input, strategy): Promise<ExecuteResult> {
    const notebook = parseNotebook(input);
    const kernel = kernelLanguage(notebook);
    const counts = { code: 0, markdown: 0, raw: 0 };
    let magics = 0;
    const cells: PreparedCell[] = notebook.cells.map((cell) => {
      const type = cellType(cell);
      const raw = cellSource(cell);
      if (type === 'markdown') counts.markdown += 1;
      else if (type === 'raw') counts.raw += 1;
      if (type !== 'code') return { type, source: raw };
      counts.code += 1;
      const { text, count } = commentOutMagics(raw);
      magics += count;
      return { type, source: text };
    });
    let output: string;
    let importsHoisted = 0;
    switch (strategy) {
      case 'with-comments':
        output = buildWithComments(cells);
        break;
      case 'executable': {
        const built = buildExecutable(cells);
        output = built.script;
        importsHoisted = built.imports;
        break;
      }
      case 'code-only':
      default:
        output = buildCodeOnly(cells);
        break;
    }
    const warnings: string[] = [];
    if (kernel.toLowerCase() !== 'python') {
      warnings.push(`Notebook kernel language is "${kernel}", not python; the script may not be valid Python`);
    }
    if (counts.code === 0) warnings.push('Notebook has no code cells');
    if (magics > 0) warnings.push(`${magics} IPython magic/shell line(s) commented out`);
    return {
      output,
      stats: {
        cellCount: notebook.cells.length,
        codeCells: counts.code,
        markdownCells: counts.markdown,
        rawCells: counts.raw,
        kernelLanguage: kernel,
        magicsCommented: magics,
        importsHoisted,
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
};
