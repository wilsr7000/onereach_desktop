/**
 * Source code → Markdown (ported from lib/converters/code-to-md.js,
 * ADR-100). One strategy survives the port: fenced — the code in a fenced
 * block whose info string is the language given, inferred from a
 * filename, or detected by pattern (plaintext when nothing matches). The
 * fence grows past any backtick run inside the code. The original's
 * documented and sectioned strategies asked an LLM to write the prose and
 * are dropped — Lite ports are deterministic.
 */

import type { Converter, ExecuteResult } from '../types.js';

/**
 * Detection heuristics, first match wins. The original's order left
 * TypeScript, Rust and Go unreachable behind the JavaScript and Java
 * patterns, and read an ESM `import x from 'y'` as Python; the patterns
 * here are tightened so each language is reachable from its own tells.
 */
export const LANGUAGE_PATTERNS: ReadonlyArray<{ lang: string; pattern: RegExp }> = [
  { lang: 'python', pattern: /^\s*(import\s+[\w.]+(\s*,\s*[\w.]+)*(\s+as\s+\w+)?\s*$|from\s+[\w.]+\s+import\s+|def\s+\w+\s*\(|class\s+\w+.*:\s*$)/m },
  { lang: 'typescript', pattern: /^\s*((export\s+)?(interface\s+\w+|type\s+\w+\s*=|enum\s+\w+)|<[A-Z]\w*>)|:\s*(string|number|boolean)(\[\])?\s*[=,;)|}]/m },
  { lang: 'rust', pattern: /^\s*(fn\s+\w+|let\s+mut|use\s+\w+::|impl\s+)/m },
  { lang: 'go', pattern: /^\s*(package\s+\w+\s*$|func\s+\w+|import\s*\()/m },
  { lang: 'java', pattern: /^\s*(public\s+class|private\s+|protected\s+|package\s+[\w.]+\s*;)/m },
  { lang: 'javascript', pattern: /^\s*(const\s+|let\s+|var\s+|function\s+|=>|module\.exports|require\(|import\s+.+\s+from\s+['"]|export\s+(default|const|function|class)\s)/m },
  { lang: 'ruby', pattern: /^\s*(require\s+'|def\s+\w+|class\s+\w+\s*<|end\s*$)/m },
  { lang: 'cpp', pattern: /^\s*(#include\s*<|namespace\s+\w+|std::)/m },
];

export function detectLanguage(code: string): string {
  for (const { lang, pattern } of LANGUAGE_PATTERNS) {
    if (pattern.test(code)) return lang;
  }
  return 'plaintext';
}

/** File extension → fence info string. */
export const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  py: 'python',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  java: 'java',
  kt: 'kotlin',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  php: 'php',
  swift: 'swift',
  scala: 'scala',
  lua: 'lua',
  pl: 'perl',
  r: 'r',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  sql: 'sql',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  md: 'markdown',
  txt: 'plaintext',
};

const SPECIAL_FILENAMES: Readonly<Record<string, string>> = { dockerfile: 'dockerfile', makefile: 'makefile' };

/** The language a filename implies (by its extension, or a well-known name), or null. */
export function languageFromFilename(filename: string): string | null {
  const base = (filename.split(/[\\/]/).pop() ?? '').toLowerCase();
  if (base.length === 0) return null;
  const special = SPECIAL_FILENAMES[base];
  if (special !== undefined) return special;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  return EXTENSION_LANGUAGES[base.slice(dot + 1)] ?? null;
}

/** A backtick fence longer than any backtick run in the code (at least three). */
export function fenceFor(code: string): string {
  let longest = 0;
  for (const match of code.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

export function buildFenced(code: string, language: string, title: string | null, filename: string | null): string {
  const lines: string[] = [];
  if (title !== null) lines.push(`# ${title}`, '');
  if (filename !== null) lines.push(`\`${filename}\``, '');
  const fence = fenceFor(code);
  lines.push(`${fence}${language}`, code, fence, '');
  return lines.join('\n');
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export const codeToMd: Converter = {
  spec: {
    id: 'code-to-md',
    title: 'Code to Markdown',
    description: 'Wraps source code in a fenced block tagged with its language — given, taken from a filename, or detected.',
    from: ['code'],
    to: ['md'],
    engine: 'pure',
    strategies: [
      { id: 'fenced', description: 'A fenced code block with a language tag, optionally under a title and filename.', when: 'The code goes into a document as is.' },
    ],
    defaultStrategy: 'fenced',
    options: [
      { name: 'language', type: 'string', description: 'Fence info string. When omitted, inferred from the filename, then detected from the code (plaintext when nothing matches).' },
      { name: 'filename', type: 'string', description: 'Shown above the block in inline code; its extension picks the language when `language` is omitted.' },
      { name: 'title', type: 'string', description: 'An H1 above the block.' },
    ],
  },
  async execute(input, _strategy, options): Promise<ExecuteResult> {
    if (input.trim().length === 0) throw new Error('Input must be a non-empty string of source code');
    const code = input.replace(/\n+$/, '');
    const title = optionalString(options['title']);
    const filename = optionalString(options['filename']);
    const given = optionalString(options['language']);
    let language: string;
    let languageSource: 'option' | 'filename' | 'detected' | 'fallback';
    const fromFilename = filename !== null ? languageFromFilename(filename) : null;
    if (given !== null) {
      language = given.toLowerCase();
      languageSource = 'option';
    } else if (fromFilename !== null) {
      language = fromFilename;
      languageSource = 'filename';
    } else {
      language = detectLanguage(code);
      languageSource = language === 'plaintext' ? 'fallback' : 'detected';
    }
    const output = buildFenced(code, language, title, filename);
    return {
      output,
      stats: { language, languageSource, lines: code.split('\n').length },
      ...(languageSource === 'fallback' ? { warnings: ['Language not recognised; fenced as plaintext'] } : {}),
    };
  },
};
