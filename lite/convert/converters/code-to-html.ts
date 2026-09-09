/**
 * Source code → syntax-highlighted HTML through highlight.js (ported from
 * lib/converters/code-to-html.js, ADR-100). Only the core engine plus a
 * small, explicit set of languages is bundled. Strategies: highlight (a
 * complete page, GitHub theme), themed (a complete page, dark theme unless
 * `theme` says otherwise), fragment (the bare <pre><code> markup for
 * embedding). The original's `annotated` strategy asked an LLM to comment
 * the code first and is dropped — Lite ports are deterministic.
 */

import hljs from 'highlight.js/lib/core';
import type { LanguageFn } from 'highlight.js';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import type { Converter, ExecuteResult } from '../types.js';

/** The languages Lite registers — a deliberate subset so the bundle stays small. Aliases (js, py, html…) come with them. */
const LANGUAGES: ReadonlyArray<readonly [string, LanguageFn]> = [
  ['javascript', javascript],
  ['typescript', typescript],
  ['python', python],
  ['json', json],
  ['yaml', yaml],
  ['bash', bash],
  ['sql', sql],
  ['xml', xml],
  ['css', css],
  ['markdown', markdown],
  ['go', go],
  ['rust', rust],
  ['java', java],
  ['c', c],
  ['cpp', cpp],
  ['csharp', csharp],
  ['ruby', ruby],
  ['php', php],
  ['plaintext', plaintext],
];

/** Registration key and every alias (js, py, html…) → the key. hljs keeps the display name in `.name`, so the id is kept here. */
const LANGUAGE_IDS: ReadonlyMap<string, string> = (() => {
  const ids = new Map<string, string>();
  for (const [name, language] of LANGUAGES) {
    hljs.registerLanguage(name, language);
    ids.set(name, name);
    for (const alias of hljs.getLanguage(name)?.aliases ?? []) ids.set(alias.toLowerCase(), name);
  }
  return ids;
})();

export function listLanguages(): string[] {
  return LANGUAGES.map(([name]) => name);
}

/** Based on the highlight.js GitHub theme. */
export const GITHUB_THEME_CSS = `.hljs { display: block; overflow-x: auto; padding: 1em; background: #f6f8fa; color: #24292e; }
.hljs-comment, .hljs-quote { color: #6a737d; font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-subst { color: #d73a49; font-weight: 600; }
.hljs-number, .hljs-literal, .hljs-variable, .hljs-template-variable { color: #005cc5; }
.hljs-string, .hljs-doctag { color: #032f62; }
.hljs-title, .hljs-section, .hljs-selector-id { color: #6f42c1; font-weight: 600; }
.hljs-type, .hljs-class .hljs-title { color: #6f42c1; }
.hljs-tag, .hljs-name, .hljs-attribute { color: #22863a; }
.hljs-regexp, .hljs-link { color: #032f62; }
.hljs-symbol, .hljs-bullet { color: #e36209; }
.hljs-built_in, .hljs-builtin-name { color: #005cc5; }
.hljs-meta { color: #735c0f; }
.hljs-deletion { background: #ffeef0; color: #b31d28; }
.hljs-addition { background: #e6ffed; color: #22863a; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 600; }`;

export const DARK_THEME_CSS = `.hljs { display: block; overflow-x: auto; padding: 1em; background: #1e1e1e; color: #d4d4d4; }
.hljs-comment, .hljs-quote { color: #6a9955; font-style: italic; }
.hljs-keyword, .hljs-selector-tag { color: #569cd6; font-weight: 600; }
.hljs-number, .hljs-literal { color: #b5cea8; }
.hljs-string, .hljs-doctag { color: #ce9178; }
.hljs-title, .hljs-section { color: #dcdcaa; font-weight: 600; }
.hljs-type, .hljs-class .hljs-title { color: #4ec9b0; }
.hljs-tag, .hljs-name { color: #569cd6; }
.hljs-attribute { color: #9cdcfe; }
.hljs-regexp { color: #d16969; }
.hljs-built_in { color: #4ec9b0; }
.hljs-meta { color: #c586c0; }`;

export const THEMES: Readonly<Record<string, string>> = { github: GITHUB_THEME_CSS, dark: DARK_THEME_CSS };

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The caller's language, folded to the registered id (js → javascript,
 * html → xml, case-insensitive). Nothing given → null (auto-detect); an
 * unregistered name → plaintext, with the name reported as `unknown`.
 */
export function resolveLanguage(given: unknown): { id: string | null; unknown: string | null } {
  if (typeof given !== 'string' || given.trim().length === 0) return { id: null, unknown: null };
  const name = given.trim().toLowerCase();
  const id = LANGUAGE_IDS.get(name);
  if (id === undefined) return { id: 'plaintext', unknown: name };
  return { id, unknown: null };
}

/** github for highlight, dark for themed, unless `theme` names one of THEMES; an unknown name is reported. */
export function resolveTheme(given: unknown, strategy: string): { theme: string; unknown: string | null } {
  const fallback = strategy === 'themed' ? 'dark' : 'github';
  if (typeof given !== 'string' || given.trim().length === 0) return { theme: fallback, unknown: null };
  const name = given.trim().toLowerCase();
  return Object.hasOwn(THEMES, name) ? { theme: name, unknown: null } : { theme: fallback, unknown: name };
}

export function wrapCodePage(code: string, page: { title: string; language: string; theme: string }): string {
  const dark = page.theme === 'dark';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(page.title)}</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    margin: 0;
    padding: 2rem;
    background: ${dark ? '#121212' : '#fafafa'};
    color: ${dark ? '#e0e0e0' : '#24292e'};
  }
  .code-container {
    max-width: 900px;
    margin: 0 auto;
  }
  .code-header {
    font-size: 0.85em;
    color: ${dark ? '#888' : '#6a737d'};
    padding: 0.5em 0;
    border-bottom: 1px solid ${dark ? '#333' : '#e1e4e8'};
    margin-bottom: 1em;
  }
  pre {
    margin: 0;
    border-radius: 6px;
    font-family: 'SF Mono', 'Fira Code', 'Fira Mono', 'Roboto Mono', Consolas, monospace;
    font-size: 0.9em;
    line-height: 1.5;
  }
${THEMES[page.theme] ?? GITHUB_THEME_CSS}
</style>
</head>
<body>
<div class="code-container">
  <div class="code-header">Language: ${escapeHtml(page.language)}</div>
  ${code}
</div>
</body>
</html>`;
}

export const codeToHtml: Converter = {
  spec: {
    id: 'code-to-html',
    title: 'Code to HTML',
    description: 'Syntax-highlights source code with highlight.js: a complete page in the GitHub or dark theme, or a bare <pre><code> fragment.',
    from: ['code'],
    to: ['html'],
    engine: 'highlight.js',
    strategies: [
      { id: 'highlight', description: 'A complete page, GitHub theme by default; the language is detected when not given.', when: 'Standard code display that should open on its own.' },
      { id: 'themed', description: 'A complete page, dark theme by default (`theme` picks github or dark).', when: 'The page should match a dark design or a chosen theme.' },
      { id: 'fragment', description: 'Only the <pre><code> markup with hljs classes — no page, no stylesheet.', when: 'The result is embedded in a page that carries its own highlight.js theme.' },
    ],
    defaultStrategy: 'highlight',
    options: [
      { name: 'language', type: 'string', description: 'Language id or alias (js, py, ts, html…). Detected among the registered set when omitted; an unknown name renders as plain text.' },
      { name: 'theme', type: 'string', description: '"github" or "dark". Defaults to github for highlight, dark for themed.' },
      { name: 'title', type: 'string', description: 'Page <title> (defaults to "Code — <language>").' },
    ],
  },
  async execute(input, strategy, options): Promise<ExecuteResult> {
    if (input.trim().length === 0) throw new Error('Input must be a non-empty string of source code');
    const warnings: string[] = [];
    const wanted = resolveLanguage(options['language']);
    if (wanted.unknown !== null) {
      warnings.push(`Unknown language "${wanted.unknown}"; rendered as plain text (registered: ${listLanguages().join(', ')})`);
    }
    let language: string;
    let highlighted: { value: string; relevance: number };
    if (wanted.id !== null) {
      language = wanted.id;
      highlighted = hljs.highlight(input, { language, ignoreIllegals: true });
    } else {
      const auto = hljs.highlightAuto(input);
      language = auto.language ?? 'plaintext';
      highlighted = auto;
    }
    const code = `<pre><code class="hljs language-${escapeHtml(language)}">${highlighted.value}</code></pre>`;
    const lines = input.split('\n').length;
    const base = { language, autoDetected: wanted.id === null, relevance: highlighted.relevance, lines };
    if (strategy === 'fragment') {
      return {
        output: code,
        stats: { ...base, theme: 'none', isDocument: false },
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }
    const { theme, unknown: unknownTheme } = resolveTheme(options['theme'], strategy);
    if (unknownTheme !== null) warnings.push(`Unknown theme "${unknownTheme}"; using ${theme} (themes: ${Object.keys(THEMES).join(', ')})`);
    const givenTitle = options['title'];
    const title = typeof givenTitle === 'string' && givenTitle.trim().length > 0 ? givenTitle.trim() : `Code — ${language}`;
    return {
      output: wrapCodePage(code, { title, language, theme }),
      stats: { ...base, theme, isDocument: true },
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
};
