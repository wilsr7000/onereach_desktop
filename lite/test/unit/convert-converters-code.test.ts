/**
 * The notebook and code converters, strategy by strategy (ADR-100): the
 * full app's expectations for jupyter-to-md, jupyter-to-python,
 * md-to-jupyter, code-to-html and code-to-md, plus the edges the ports
 * handle on purpose — empty notebooks, outputs, magics, unicode, unknown
 * languages.
 */

import { describe, it, expect } from 'vitest';
import { ConverterRegistry } from '../../convert/registry.js';
import { jupyterToMd, parseNotebook, cellSource, kernelLanguage, formatOutputs } from '../../convert/converters/jupyter-to-md.js';
import { jupyterToPython, IMPORT_PATTERN, commentOutMagics, separateDefinitions } from '../../convert/converters/jupyter-to-python.js';
import { mdToJupyter, parseCells, toSourceArray, kernelDisplayName } from '../../convert/converters/md-to-jupyter.js';
import { codeToHtml, listLanguages, resolveLanguage, resolveTheme } from '../../convert/converters/code-to-html.js';
import { codeToMd, detectLanguage, languageFromFilename, fenceFor } from '../../convert/converters/code-to-md.js';

type Cell = Record<string, unknown>;

function notebook(cells: Cell[], metadata: Record<string, unknown> = { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' } }): string {
  return JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata, cells });
}
function code(source: string, extra: Cell = {}): Cell {
  return { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source, ...extra };
}
function markdown(source: string): Cell {
  return { cell_type: 'markdown', metadata: {}, source };
}

/** The full app's jupyter-to-md sample. */
const NOTEBOOK = notebook([
  { cell_type: 'markdown', metadata: {}, source: ['# Title\n', '\n', 'Some text.'] },
  { cell_type: 'code', execution_count: 1, metadata: {}, outputs: [{ output_type: 'stream', name: 'stdout', text: ['Hello World\n'] }], source: ['print("Hello World")'] },
]);
/** The full app's jupyter-to-python sample. */
const ANALYSIS = notebook([
  { cell_type: 'markdown', metadata: {}, source: ['# Data Analysis\n', 'This notebook analyzes sample data.'] },
  { cell_type: 'code', metadata: {}, source: ['import pandas as pd\n', 'import numpy as np'], execution_count: 1, outputs: [] },
  { cell_type: 'code', metadata: {}, source: ['df = pd.DataFrame({"x": [1, 2, 3], "y": [4, 5, 6]})\n', 'print(df.head())'], execution_count: 2, outputs: [] },
]);
const EMPTY = notebook([], {});

describe('jupyter-to-md', () => {
  it('flat: markdown passes through, code becomes a fence tagged with the kernel language', async () => {
    const r = await jupyterToMd.execute(NOTEBOOK, 'flat', {});
    expect(r.output).toBe('# Title\n\nSome text.\n\n```python\nprint("Hello World")\n```');
    expect(r.stats).toMatchObject({ cellCount: 2, codeCells: 1, markdownCells: 1, rawCells: 0, kernelLanguage: 'python', outputsRendered: 0 });
    expect(r.warnings).toBeUndefined();
  });
  it('sectioned: a rule between runs of different cell types', async () => {
    const r = await jupyterToMd.execute(NOTEBOOK, 'sectioned', {});
    expect(r.output).toBe('# Title\n\nSome text.\n\n---\n\n```python\nprint("Hello World")\n```');
    const same = await jupyterToMd.execute(notebook([code('a = 1'), code('b = 2')]), 'sectioned', {});
    expect(same.output).not.toContain('---');
  });
  it('with-output: outputs quoted under their code cell, no dangling quote line', async () => {
    const r = await jupyterToMd.execute(NOTEBOOK, 'with-output', {});
    expect(r.output).toContain('```\n\n**Output:**\n> Hello World');
    expect(r.output.endsWith('> Hello World')).toBe(true);
    expect(r.stats?.['outputsRendered']).toBe(1);
  });
  it('formatOutputs: execute_result text, HTML and image placeholders, errors stripped of ANSI colour', () => {
    const text = formatOutputs([
      { output_type: 'execute_result', data: { 'text/plain': ['42'] } },
      { output_type: 'display_data', data: { 'text/html': '<b>x</b>' } },
      { output_type: 'display_data', data: { 'image/png': 'iVBORw0KGgo=' } },
      { output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['\u001b[0;31mTraceback\u001b[0m', '  line 1'] },
      { output_type: 'display_data', data: { 'application/json': {} } },
      'not an output',
    ]);
    expect(text).toBe('42\n[HTML output]\n[Image output]\nError: ValueError: bad\nTraceback\n  line 1');
  });
  it('with-output warns when no output has a textual form', async () => {
    const nb = notebook([code('x', { outputs: [{ output_type: 'display_data', data: { 'application/json': {} } }] })]);
    const r = await jupyterToMd.execute(nb, 'with-output', {});
    expect(r.output).toBe('```python\nx\n```');
    expect(r.warnings).toEqual(['with-output: no cell output could be rendered as text']);
  });
  it('raw cells are untagged fences; a cell language beats the kernel; language_info is the fallback', async () => {
    const nb = notebook(
      [{ cell_type: 'raw', metadata: {}, source: 'raw text' }, code('1+1', { metadata: { language: 'julia' } }), code('x <- 1')],
      { language_info: { name: 'r' } }
    );
    const r = await jupyterToMd.execute(nb, 'flat', {});
    expect(r.output).toBe('```\nraw text\n```\n\n```julia\n1+1\n```\n\n```r\nx <- 1\n```');
    expect(r.stats).toMatchObject({ rawCells: 1, codeCells: 2, kernelLanguage: 'r' });
  });
  it('readers: kernelLanguage defaults to python; cellSource joins fragments or takes a string', () => {
    expect(kernelLanguage({ cells: [], metadata: {} })).toBe('python');
    expect(cellSource({ source: ['a\n', 'b'] })).toBe('a\nb');
    expect(cellSource({ source: 's' })).toBe('s');
    expect(cellSource({})).toBe('');
    expect(parseNotebook('{"cells": [1, {"cell_type": "code"}]}').cells).toEqual([{}, { cell_type: 'code' }]);
  });
  it('empty notebook: empty output and a warning; unknown cell types are skipped with a warning', async () => {
    const empty = await jupyterToMd.execute(EMPTY, 'flat', {});
    expect(empty.output).toBe('');
    expect(empty.stats?.['cellCount']).toBe(0);
    expect(empty.warnings?.[0]).toMatch(/no cells/);
    const odd = await jupyterToMd.execute(notebook([{ cell_type: 'widget', source: 'x' }, markdown('hi')]), 'flat', {});
    expect(odd.output).toBe('hi');
    expect(odd.warnings).toEqual(['1 cell(s) with an unknown cell_type were skipped']);
  });
  it('magics and unicode survive inside the fence', async () => {
    const r = await jupyterToMd.execute(notebook([code('%matplotlib inline\nprint("héllo ✓")')]), 'flat', {});
    expect(r.output).toBe('```python\n%matplotlib inline\nprint("héllo ✓")\n```');
  });
  it('refuses bad input', async () => {
    await expect(jupyterToMd.execute('not json', 'flat', {})).rejects.toThrow(/Failed to parse Jupyter notebook JSON/);
    await expect(jupyterToMd.execute('[]', 'flat', {})).rejects.toThrow(/expected a JSON object/);
    await expect(jupyterToMd.execute('{"nbformat": 4}', 'flat', {})).rejects.toThrow(/missing cells array/);
  });
});

describe('jupyter-to-python', () => {
  it('code-only: the code cells, in order, under a shebang', async () => {
    const r = await jupyterToPython.execute(ANALYSIS, 'code-only', {});
    expect(r.output).toBe('#!/usr/bin/env python3\n\nimport pandas as pd\nimport numpy as np\n\ndf = pd.DataFrame({"x": [1, 2, 3], "y": [4, 5, 6]})\nprint(df.head())\n');
    expect(r.output).not.toContain('# Data Analysis');
    expect(r.stats).toMatchObject({ cellCount: 3, codeCells: 2, markdownCells: 1, rawCells: 0, kernelLanguage: 'python', magicsCommented: 0, importsHoisted: 0 });
    expect(r.warnings).toBeUndefined();
  });
  it('with-comments: markdown cells become # comments between the code', async () => {
    const r = await jupyterToPython.execute(ANALYSIS, 'with-comments', {});
    expect(r.output).toContain('# # Data Analysis\n# This notebook analyzes sample data.\n\nimport pandas as pd');
    expect(r.output.endsWith('print(df.head())\n')).toBe(true);
  });
  it('executable: imports hoisted, sorted and de-duplicated; the rest runs under a __main__ guard', async () => {
    const sample = await jupyterToPython.execute(ANALYSIS, 'executable', {});
    expect(sample.output.indexOf('import pandas as pd')).toBeLessThan(sample.output.indexOf('pd.DataFrame'));
    expect(sample.output).toContain('if __name__ == "__main__":\n');
    expect(sample.output).toContain('    df = pd.DataFrame({"x": [1, 2, 3], "y": [4, 5, 6]})\n    print(df.head())');
    const nb = notebook([code('import pandas as pd\nimport numpy as np\nfrom os import path\nimport os'), code('import os\nx = path.join("a")\nprint(x)')]);
    const r = await jupyterToPython.execute(nb, 'executable', {});
    expect(r.output).toContain('"""\nConverted from Jupyter Notebook.\n"""\n\nimport numpy as np\nimport os\nimport pandas as pd\nfrom os import path\n');
    expect(r.output.match(/^import os$/gm)).toHaveLength(1);
    expect(r.output).toContain('    x = path.join("a")\n    print(x)');
    expect(r.stats?.['importsHoisted']).toBe(4);
  });
  it('executable: definitions (with their decorators) stay at module level; nothing to run means pass', async () => {
    const nb = notebook([code('import functools\n\n@functools.lru_cache\ndef double(x):\n    return x * 2\n\nclass Box:\n    pass\n\nprint(double(2))')]);
    const r = await jupyterToPython.execute(nb, 'executable', {});
    const at = (s: string): number => r.output.indexOf(s);
    expect(at('@functools.lru_cache')).toBeGreaterThan(at('import functools'));
    expect(at('@functools.lru_cache')).toBeLessThan(at('def double(x):\n    return x * 2'));
    expect(at('class Box:\n    pass')).toBeLessThan(at('if __name__ == "__main__":'));
    expect(r.output).toContain('if __name__ == "__main__":\n\n    print(double(2))');
    const nothing = await jupyterToPython.execute(notebook([code('import os')]), 'executable', {});
    expect(nothing.output).toContain('import os\n');
    expect(nothing.output).toContain('if __name__ == "__main__":\n    pass\n');
  });
  it('magics and shell escapes are commented out with a warning; the modulo operator is untouched', async () => {
    const nb = notebook([code('%matplotlib inline\n!pip install pandas\nimport pandas as pd\n  %time x = 1\ny = x % 2')]);
    const r = await jupyterToPython.execute(nb, 'code-only', {});
    expect(r.output).toContain('# %matplotlib inline\n# !pip install pandas\nimport pandas as pd\n  # %time x = 1\ny = x % 2\n');
    expect(r.warnings).toEqual(['3 IPython magic/shell line(s) commented out']);
    expect(r.stats?.['magicsCommented']).toBe(3);
    expect(commentOutMagics('a\n%%bash\nls')).toEqual({ text: 'a\n# %%bash\nls', count: 1 });
  });
  it('warns on a non-python kernel and on a notebook with no code cells', async () => {
    const r = await jupyterToPython.execute(notebook([code('x <- 1')], { kernelspec: { language: 'R', name: 'ir' } }), 'code-only', {});
    expect(r.warnings).toEqual(['Notebook kernel language is "R", not python; the script may not be valid Python']);
    const empty = await jupyterToPython.execute(EMPTY, 'with-comments', {});
    expect(empty.output).toBe('#!/usr/bin/env python3\n');
    expect(empty.warnings).toEqual(['Notebook has no code cells']);
  });
  it('unicode survives; bad input is refused', async () => {
    const r = await jupyterToPython.execute(notebook([code('print("héllo ✓")')]), 'code-only', {});
    expect(r.output).toContain('print("héllo ✓")');
    await expect(jupyterToPython.execute('nope', 'code-only', {})).rejects.toThrow(/Failed to parse/);
    await expect(jupyterToPython.execute('{"cells": 1}', 'code-only', {})).rejects.toThrow(/missing cells array/);
  });
  it('IMPORT_PATTERN and separateDefinitions', () => {
    for (const line of ['import os', 'import numpy as np', 'import a, b', 'import a.b as c, d', 'from x import y', 'from . import z', '  import re', 'import os  # comment']) {
      expect(IMPORT_PATTERN.test(line), line).toBe(true);
    }
    for (const line of ['importance = 1', '# import os', 'import fs from "fs"', 'import os; os.getcwd()', 'x = 1']) {
      expect(IMPORT_PATTERN.test(line), line).toBe(false);
    }
    expect(separateDefinitions(['def f():', '    return 1', '', 'f()'])).toEqual({ definitions: ['def f():', '    return 1', '', ''], executable: ['f()'] });
  });
});

interface OutCell {
  id: string;
  cell_type: string;
  metadata: { language?: string; tags?: string[]; collapsed?: boolean };
  source: string[];
  execution_count?: number | null;
  outputs?: unknown[];
}
interface OutNotebook {
  nbformat: number;
  nbformat_minor: number;
  metadata: { kernelspec: { display_name: string; language: string; name: string }; language_info: { name: string } };
  cells: OutCell[];
}
const MD = '# Analysis\n\nSome introductory text.\n\n```python\nimport pandas as pd\ndf = pd.read_csv("data.csv")\nprint(df.head())\n```\n\n## Results\n\nThe data shows interesting patterns.';

describe('md-to-jupyter', () => {
  it('auto-cell: valid nbformat 4 with cell ids and a kernelspec; prose splits at headings', async () => {
    const r = await mdToJupyter.execute(MD, 'auto-cell', {});
    const nb = JSON.parse(r.output) as OutNotebook;
    expect(nb.nbformat).toBe(4);
    expect(nb.nbformat_minor).toBe(5);
    expect(nb.metadata.kernelspec).toEqual({ display_name: 'Python 3', language: 'python', name: 'python3' });
    expect(nb.metadata.language_info).toEqual({ name: 'python' });
    expect(nb.cells).toHaveLength(3);
    for (const cell of nb.cells) {
      expect(cell.id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(Array.isArray(cell.source)).toBe(true);
      expect(typeof cell.metadata).toBe('object');
    }
    expect(new Set(nb.cells.map((c) => c.id)).size).toBe(3);
    expect(nb.cells[0]).toMatchObject({ cell_type: 'markdown', source: ['# Analysis\n', '\n', 'Some introductory text.'] });
    expect(nb.cells[1]).toEqual({
      id: 'cell-2',
      cell_type: 'code',
      execution_count: null,
      metadata: { language: 'python' },
      outputs: [],
      source: ['import pandas as pd\n', 'df = pd.read_csv("data.csv")\n', 'print(df.head())'],
    });
    expect(nb.cells[2]?.source.join('')).toBe('## Results\n\nThe data shows interesting patterns.');
    expect(r.stats).toMatchObject({ cellCount: 3, codeCells: 1, markdownCells: 2, kernelLanguage: 'python', taggedCells: 0 });
    expect(r.warnings).toBeUndefined();
  });
  it('strict-fence: only fences make boundaries', async () => {
    const headings = '# One\n\ntext\n\n## Two\n\nmore';
    const strict = JSON.parse((await mdToJupyter.execute(headings, 'strict-fence', {})).output) as OutNotebook;
    expect(strict.cells).toHaveLength(1);
    const auto = JSON.parse((await mdToJupyter.execute(headings, 'auto-cell', {})).output) as OutNotebook;
    expect(auto.cells).toHaveLength(2);
    const nb = JSON.parse((await mdToJupyter.execute(MD, 'strict-fence', {})).output) as OutNotebook;
    const codeCells = nb.cells.filter((c) => c.cell_type === 'code');
    expect(codeCells).toHaveLength(1);
    expect(codeCells[0]?.source.join('')).toContain('import pandas');
  });
  it('annotated: tags by content, long code cells collapsed', async () => {
    const r = await mdToJupyter.execute(MD, 'annotated', {});
    const nb = JSON.parse(r.output) as OutNotebook;
    expect(nb.cells.map((c) => c.metadata.tags)).toEqual([['title'], ['imports', 'output'], ['section']]);
    expect(r.stats?.['taggedCells']).toBe(3);
    const long = ['```js', ...Array.from({ length: 25 }, (_, i) => `const v${i} = ${i};`), '```', '', '- item [x](y) ![i](p)'].join('\n');
    const tagged = JSON.parse((await mdToJupyter.execute(long, 'annotated', {})).output) as OutNotebook;
    expect(tagged.cells[0]?.metadata).toEqual({ language: 'js', collapsed: true, tags: ['long'] });
    expect(tagged.cells[1]?.metadata.tags).toEqual(['list', 'has-images', 'has-links']);
  });
  it('kernelLanguage option names the kernel; display names for the known ones', async () => {
    const r = await mdToJupyter.execute('x', 'auto-cell', { kernelLanguage: 'javascript' });
    const nb = JSON.parse(r.output) as OutNotebook;
    expect(nb.metadata.kernelspec).toEqual({ display_name: 'JavaScript', language: 'javascript', name: 'javascript' });
    expect(r.stats?.['kernelLanguage']).toBe('javascript');
    expect(kernelDisplayName('r')).toBe('R');
    expect(kernelDisplayName('foo')).toBe('foo');
  });
  it('edges: empty input warns, an unclosed fence becomes code with a warning, an untagged fence has no language, CRLF folds', async () => {
    const empty = await mdToJupyter.execute('', 'auto-cell', {});
    expect((JSON.parse(empty.output) as OutNotebook).cells).toEqual([]);
    expect(empty.warnings).toEqual(['Notebook has zero cells']);
    const open = await mdToJupyter.execute('text\n\n```py\nx = 1', 'strict-fence', {});
    const openNb = JSON.parse(open.output) as OutNotebook;
    expect(openNb.cells.map((c) => c.cell_type)).toEqual(['markdown', 'code']);
    expect(openNb.cells[1]).toMatchObject({ metadata: { language: 'py' }, source: ['x = 1'] });
    expect(open.warnings).toEqual(['Unclosed code fence; the trailing content became a code cell']);
    const plain = JSON.parse((await mdToJupyter.execute('```\nplain\n```', 'auto-cell', {})).output) as OutNotebook;
    expect(plain.cells[0]?.metadata).toEqual({});
    const crlf = JSON.parse((await mdToJupyter.execute('a\r\nb\r\n\r\n```\r\nc\r\n```', 'auto-cell', {})).output) as OutNotebook;
    expect(crlf.cells.map((c) => c.source)).toEqual([['a\n', 'b'], ['c']]);
  });
  it('magics and unicode are kept verbatim in code cells; helpers', async () => {
    const nb = JSON.parse((await mdToJupyter.execute('```python\n%matplotlib inline\nprint("héllo ✓")\n```', 'auto-cell', {})).output) as OutNotebook;
    expect(nb.cells[0]?.source).toEqual(['%matplotlib inline\n', 'print("héllo ✓")']);
    expect(toSourceArray('a\nb')).toEqual(['a\n', 'b']);
    expect(toSourceArray('x')).toEqual(['x']);
    expect(parseCells('', 'auto-cell')).toEqual({ cells: [], unclosedFence: false });
  });
  it('round trip: md → ipynb → md gives the Markdown back', async () => {
    const ipynb = (await mdToJupyter.execute(MD, 'auto-cell', {})).output;
    const back = await jupyterToMd.execute(ipynb, 'flat', {});
    expect(back.output).toBe(MD);
  });
});

const PY = 'import os\n\ndef greet(name):\n    return f"hi {name}"\n\nprint(greet(os.getcwd()))\n';

describe('code-to-html', () => {
  it('highlight: a complete page with hljs markup in the GitHub theme, language detected', async () => {
    const r = await codeToHtml.execute(PY, 'highlight', {});
    expect(r.output.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(r.output).toContain('<pre><code class="hljs language-python">');
    expect(r.output).toContain('hljs-keyword');
    expect(r.output).toContain('background: #f6f8fa');
    expect(r.output).toContain('<div class="code-header">Language: python</div>');
    expect(r.output).toContain('<title>Code — python</title>');
    expect(r.stats).toMatchObject({ language: 'python', theme: 'github', autoDetected: true, isDocument: true, lines: 7 });
    expect(r.stats?.['relevance']).toBeGreaterThan(0);
    expect(r.warnings).toBeUndefined();
  });
  it('themed: dark by default; theme picks github; an unknown theme warns and falls back', async () => {
    const dark = await codeToHtml.execute('const x = 1;', 'themed', { language: 'js' });
    expect(dark.output).toContain('background: #1e1e1e');
    expect(dark.output).toContain('background: #121212');
    expect(dark.stats?.['theme']).toBe('dark');
    const github = await codeToHtml.execute('const x = 1;', 'themed', { language: 'js', theme: 'github' });
    expect(github.output).toContain('background: #f6f8fa');
    expect(github.output).not.toContain('#1e1e1e');
    const odd = await codeToHtml.execute('const x = 1;', 'themed', { language: 'js', theme: 'solarized' });
    expect(odd.warnings).toEqual(['Unknown theme "solarized"; using dark (themes: github, dark)']);
    expect(odd.stats?.['theme']).toBe('dark');
    expect(resolveTheme('DARK', 'highlight')).toEqual({ theme: 'dark', unknown: null });
  });
  it('fragment: the bare <pre><code> markup, no page', async () => {
    const r = await codeToHtml.execute('SELECT 1;', 'fragment', { language: 'sql', theme: 'nope' });
    expect(r.output.startsWith('<pre><code class="hljs language-sql">')).toBe(true);
    expect(r.output.endsWith('</code></pre>')).toBe(true);
    expect(r.output).not.toContain('<html');
    expect(r.output).toContain('hljs-keyword');
    expect(r.stats).toMatchObject({ language: 'sql', theme: 'none', isDocument: false, autoDetected: false });
    expect(r.warnings).toBeUndefined();
  });
  it('language aliases fold to the registered id, case-insensitively', async () => {
    expect(resolveLanguage('js')).toEqual({ id: 'javascript', unknown: null });
    expect(resolveLanguage('Py')).toEqual({ id: 'python', unknown: null });
    expect(resolveLanguage('html')).toEqual({ id: 'xml', unknown: null });
    expect(resolveLanguage('c++')).toEqual({ id: 'cpp', unknown: null });
    expect(resolveLanguage('')).toEqual({ id: null, unknown: null });
    expect(resolveLanguage(undefined)).toEqual({ id: null, unknown: null });
    const r = await codeToHtml.execute('let a: number = 1;', 'fragment', { language: ' TS ' });
    expect(r.output).toContain('class="hljs language-typescript"');
    expect(listLanguages()).toHaveLength(19);
    expect(listLanguages()).toEqual(expect.arrayContaining(['javascript', 'python', 'xml', 'plaintext']));
  });
  it('unknown language falls back to plain text with a warning; undetectable text is plain text too', async () => {
    const r = await codeToHtml.execute('+++ --- >>>', 'highlight', { language: 'brainfuck' });
    expect(r.stats).toMatchObject({ language: 'plaintext', autoDetected: false });
    expect(r.warnings?.[0]).toMatch(/^Unknown language "brainfuck"; rendered as plain text \(registered: javascript, /);
    expect(r.output).toContain('<code class="hljs language-plaintext">+++ --- &gt;&gt;&gt;</code>');
    const words = await codeToHtml.execute('lorem ipsum dolor sit amet', 'fragment', {});
    expect(words.stats).toMatchObject({ language: 'plaintext', autoDetected: true, relevance: 0 });
  });
  it('escapes markup in code and title; unicode survives', async () => {
    const r = await codeToHtml.execute('if (a < b && c > "d") {}', 'fragment', { language: 'javascript' });
    expect(r.output).toContain('&lt;');
    expect(r.output).toContain('&amp;&amp;');
    expect(r.output).toContain('&gt;');
    const titled = await codeToHtml.execute('print("héllo wörld ✓")', 'highlight', { language: 'python', title: '<b>Snippet</b>' });
    expect(titled.output).toContain('<title>&lt;b&gt;Snippet&lt;/b&gt;</title>');
    expect(titled.output).toContain('héllo wörld ✓');
  });
  it('refuses blank input', async () => {
    await expect(codeToHtml.execute('  \n ', 'highlight', {})).rejects.toThrow(/non-empty/);
  });
});

describe('code-to-md', () => {
  it('fenced: a fenced block tagged with the detected language', async () => {
    const r = await codeToMd.execute('const x = 1;', 'fenced', {});
    expect(r.output).toBe('```javascript\nconst x = 1;\n```\n');
    expect(r.stats).toEqual({ language: 'javascript', languageSource: 'detected', lines: 1 });
    expect(r.warnings).toBeUndefined();
  });
  it('detectLanguage: each language from its own tells, plaintext otherwise', () => {
    expect(detectLanguage('const x = require("fs"); module.exports = x;')).toBe('javascript');
    expect(detectLanguage('import fs from "fs";\nexport default fs;')).toBe('javascript');
    expect(detectLanguage('import os\nfrom sys import argv\n')).toBe('python');
    expect(detectLanguage('import numpy as np\nprint(np.zeros(3))')).toBe('python');
    expect(detectLanguage('const n: number = 1;')).toBe('typescript');
    expect(detectLanguage('export interface A { x: string }')).toBe('typescript');
    expect(detectLanguage('fn main() {\n    let mut x = 1;\n}')).toBe('rust');
    expect(detectLanguage('package main\n\nfunc main() {}')).toBe('go');
    expect(detectLanguage('package com.x;\n\npublic class A {}')).toBe('java');
    expect(detectLanguage("require 'json'\ndef foo\nend")).toBe('ruby');
    expect(detectLanguage('#include <iostream>')).toBe('cpp');
    expect(detectLanguage('hello world')).toBe('plaintext');
  });
  it('language: the option beats the filename, which beats detection; the filename shows above the block', async () => {
    const named = await codeToMd.execute('x = 1', 'fenced', { filename: 'src/app.py' });
    expect(named.output).toBe('`src/app.py`\n\n```python\nx = 1\n```\n');
    expect(named.stats?.['languageSource']).toBe('filename');
    const given = await codeToMd.execute('x = 1', 'fenced', { filename: 'app.py', language: 'Ruby' });
    expect(given.output).toContain('```ruby\n');
    expect(given.stats?.['languageSource']).toBe('option');
    expect(languageFromFilename('src/a/b.TS')).toBe('typescript');
    expect(languageFromFilename('Dockerfile')).toBe('dockerfile');
    expect(languageFromFilename('notes')).toBeNull();
    expect(languageFromFilename('x.unknownext')).toBeNull();
    expect(languageFromFilename('.bashrc')).toBeNull();
  });
  it('title becomes an H1 above the block', async () => {
    const r = await codeToMd.execute('x = 1', 'fenced', { title: 'Snippet', language: 'python' });
    expect(r.output).toBe('# Snippet\n\n```python\nx = 1\n```\n');
  });
  it('the fence outgrows backtick runs in the code', async () => {
    const r = await codeToMd.execute('const s = `a ${b}`;\n```', 'fenced', { language: 'javascript' });
    expect(r.output.startsWith('````javascript\n')).toBe(true);
    expect(r.output.endsWith('\n````\n')).toBe(true);
    expect(fenceFor('a `b`')).toBe('```');
    expect(fenceFor('```')).toBe('````');
    expect(fenceFor('')).toBe('```');
  });
  it('plaintext fallback warns; trailing newlines are dropped; unicode is kept; blank input is refused', async () => {
    const r = await codeToMd.execute('just words\n\n', 'fenced', {});
    expect(r.output).toBe('```plaintext\njust words\n```\n');
    expect(r.warnings).toEqual(['Language not recognised; fenced as plaintext']);
    expect(r.stats).toMatchObject({ languageSource: 'fallback', lines: 1 });
    const unicode = await codeToMd.execute('print("héllo ✓")', 'fenced', { language: 'python' });
    expect(unicode.output).toContain('print("héllo ✓")');
    await expect(codeToMd.execute('   ', 'fenced', {})).rejects.toThrow(/non-empty/);
  });
});

describe('specs', () => {
  it('register cleanly (canonical formats, known default strategies) and route md → py through ipynb', () => {
    const registry = new ConverterRegistry();
    for (const converter of [jupyterToMd, jupyterToPython, mdToJupyter, codeToHtml, codeToMd]) registry.register(converter);
    expect(registry.resolve('ipynb', 'py')?.steps.map((s) => s.converterId)).toEqual(['jupyter-to-python']);
    expect(registry.resolve('md', 'py')?.steps.map((s) => s.converterId)).toEqual(['md-to-jupyter', 'jupyter-to-python']);
    expect(registry.resolve('code', 'html')?.steps.map((s) => s.converterId)).toEqual(['code-to-html']);
    expect(registry.resolve('code', 'md')?.steps.map((s) => s.converterId)).toEqual(['code-to-md']);
  });
});
