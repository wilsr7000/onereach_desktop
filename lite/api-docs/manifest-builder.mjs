#!/usr/bin/env node
// @ts-check
/**
 * API docs manifest builder (ADR-035).
 *
 * Walks `lite/<module>/` for every directory, extracts public API +
 * event taxonomy + README, and writes `lite/api-docs/manifest.generated.ts`.
 * Run before esbuild via `npm run lite:build:api-docs-manifest`.
 *
 * Pure script: no runtime side effects beyond writing the output file.
 * Re-run is idempotent.
 *
 * Why a JS script instead of a TS module: it's a build-time tool that
 * runs from `package.json` scripts; keeping it as `.mjs` skips the
 * `tsx` / `ts-node` dependency. The output IS TypeScript so the
 * renderer + tests get static typing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const liteRoot = path.resolve(__dirname, '..');
const outputPath = path.join(__dirname, 'manifest.generated.ts');

// Modules WITHOUT api.ts but worth mentioning in the docs window
// footer. Keep this list small and the reasons specific.
const UNTYPED_MODULES = [
  {
    slug: 'updater',
    title: 'Updater',
    reason:
      'Init-pattern module (no public api.ts). Drives auto-update via electron-updater. See updater/index.ts and the typed event catalog at updater/events.ts (UPDATER_EVENTS).',
  },
  {
    slug: 'menu',
    title: 'Menu',
    reason:
      'Internal-only registry pattern (no public api.ts). Builds the application menu from menu/seed.ts via menu/registry.ts. Events: menu.click, menu.click.failed.',
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Convert a kebab-case slug like "bug-report" to a display title
 * "Bug Report". Single-word slugs uppercase as-is for known acronyms.
 *
 * @param {string} slug
 * @returns {string}
 */
function slugToTitle(slug) {
  if (slug === 'kv') return 'KV';
  if (slug === 'totp') return 'TOTP';
  if (slug === 'oagi' || slug === 'neon') return slug.toUpperCase();
  return slug
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Strip a JSDoc block's `/**`, `*\/`, and per-line `* ` prefixes.
 * Returns the cleaned multi-line content.
 *
 * @param {string} block - The raw JSDoc text (including delimiters).
 * @returns {string}
 */
function stripJsdocDelimiters(block) {
  return block
    .replace(/^\s*\/\*\*\s*/, '')
    .replace(/\s*\*\/\s*$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim();
}

/**
 * Parse a cleaned JSDoc body into description + tags + examples.
 *
 * @param {string} cleaned - Output of stripJsdocDelimiters.
 * @returns {{ description: string; tags: Array<{ tag: string; value: string }>; examples: string[] }}
 */
function parseJsdoc(cleaned) {
  const lines = cleaned.split('\n');
  /** @type {string[]} */
  const descLines = [];
  /** @type {Array<{ tag: string; value: string }>} */
  const tags = [];
  /** @type {string[]} */
  const examples = [];

  /** @type {'description' | 'tag' | 'example'} */
  let mode = 'description';
  /** @type {{ tag: string; value: string } | null} */
  let currentTag = null;
  /** @type {string[]} */
  let currentExample = [];

  const flushTag = () => {
    if (currentTag !== null) {
      currentTag.value = currentTag.value.trim();
      tags.push(currentTag);
      currentTag = null;
    }
  };
  const flushExample = () => {
    if (currentExample.length > 0) {
      examples.push(currentExample.join('\n').trim());
      currentExample = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine;
    const tagMatch = /^@(\w+)(?:\s+(.*))?$/.exec(line.trim());

    if (tagMatch !== null) {
      // Starting a new tag.
      flushTag();
      flushExample();
      const tag = tagMatch[1] ?? '';
      const value = tagMatch[2] ?? '';
      if (tag === 'example') {
        mode = 'example';
        // The text after `@example` (if any) is the first line of the example.
        if (value.length > 0) currentExample.push(value);
      } else {
        mode = 'tag';
        currentTag = { tag, value };
      }
      continue;
    }

    if (mode === 'description') {
      descLines.push(line);
    } else if (mode === 'tag' && currentTag !== null) {
      currentTag.value += '\n' + line;
    } else if (mode === 'example') {
      currentExample.push(line);
    }
  }

  flushTag();
  flushExample();

  // Drop leading/trailing blank lines from description.
  while (descLines.length > 0 && descLines[0]?.trim() === '') descLines.shift();
  while (descLines.length > 0 && descLines[descLines.length - 1]?.trim() === '') descLines.pop();

  // Examples often arrive wrapped in ```language ... ``` fences from
  // the JSDoc author. Strip those if present so the renderer can wrap
  // them in its own <pre><code>.
  const cleanedExamples = examples.map((ex) => {
    const trimmed = ex.trim();
    const fenced = /^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$/.exec(trimmed);
    return fenced !== null ? (fenced[1] ?? '').trim() : trimmed;
  });

  return {
    description: descLines.join('\n').trim(),
    tags,
    examples: cleanedExamples,
  };
}

/**
 * Find the JSDoc block immediately preceding `position` in `source`.
 * Returns null if the prior non-whitespace text is not a JSDoc.
 *
 * @param {string} source
 * @param {number} position - Index in source.
 * @returns {string | null}
 */
function findJsdocBefore(source, position) {
  // Walk backward from position to find the closing `*/` of a JSDoc
  // block. Skip over whitespace; stop if anything else appears first.
  let i = position - 1;
  while (i >= 0 && /\s/.test(source[i] ?? '')) i--;
  if (i < 1 || source[i - 1] !== '*' || source[i] !== '/') return null;
  // Found `*/`. Walk back to find the matching `/**`.
  const end = i + 1;
  let start = i - 2;
  while (start >= 1) {
    if (source[start - 1] === '/' && source[start] === '*' && source[start + 1] === '*') {
      return source.slice(start - 1, end);
    }
    start--;
  }
  return null;
}

/**
 * Find the body of an interface declaration matching the given name.
 * Returns `{ body, jsdoc }` where `body` is the contents between `{`
 * and the matching `}`, and `jsdoc` is the comment block immediately
 * preceding `export interface NAME {` (or null).
 *
 * @param {string} source
 * @param {string} interfaceName
 * @returns {{ body: string; jsdoc: string | null } | null}
 */
function findInterfaceBody(source, interfaceName) {
  const re = new RegExp(`export\\s+interface\\s+${interfaceName}\\b[\\s\\S]*?\\{`);
  const match = re.exec(source);
  if (match === null) return null;
  const openIdx = match.index + match[0].length - 1; // position of `{`
  const jsdoc = findJsdocBefore(source, match.index);

  // Walk forward to find the matching `}`. Track brace depth, skipping
  // string literals and template literals to avoid false matches.
  let depth = 1;
  let i = openIdx + 1;
  /** @type {'' | "'" | '"' | '`'} */
  let inString = '';
  let inLineComment = false;
  let inBlockComment = false;
  while (i < source.length && depth > 0) {
    const c = source[i] ?? '';
    const prev = source[i - 1] ?? '';
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
    } else if (inBlockComment) {
      if (c === '/' && prev === '*') inBlockComment = false;
    } else if (inString !== '') {
      if (c === inString && prev !== '\\') inString = '';
    } else if (c === '/' && source[i + 1] === '/') {
      inLineComment = true;
    } else if (c === '/' && source[i + 1] === '*') {
      inBlockComment = true;
    } else if (c === '"' || c === "'" || c === '`') {
      inString = c;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
    }
    i++;
  }
  if (depth !== 0) return null;
  const body = source.slice(openIdx + 1, i - 1);
  return { body, jsdoc };
}

/**
 * Split an interface body into per-method records. Each method is a
 * (jsdoc?, signature) pair. Signature ends at the first `;` outside
 * braces / strings / comments.
 *
 * @param {string} body
 * @returns {Array<{ jsdoc: string | null; signature: string }>}
 */
function splitMethods(body) {
  /** @type {Array<{ jsdoc: string | null; signature: string }>} */
  const out = [];
  let i = 0;
  while (i < body.length) {
    // Skip whitespace.
    while (i < body.length && /\s/.test(body[i] ?? '')) i++;
    if (i >= body.length) break;

    // Capture an optional JSDoc.
    /** @type {string | null} */
    let jsdoc = null;
    if (body[i] === '/' && body[i + 1] === '*' && body[i + 2] === '*') {
      const start = i;
      i += 3;
      while (i < body.length - 1 && !(body[i] === '*' && body[i + 1] === '/')) i++;
      i += 2;
      jsdoc = body.slice(start, i);
      while (i < body.length && /\s/.test(body[i] ?? '')) i++;
    } else if (body[i] === '/' && body[i + 1] === '*') {
      // Non-JSDoc block comment: skip.
      while (i < body.length - 1 && !(body[i] === '*' && body[i + 1] === '/')) i++;
      i += 2;
      continue;
    } else if (body[i] === '/' && body[i + 1] === '/') {
      // Line comment: skip to EOL.
      while (i < body.length && body[i] !== '\n') i++;
      continue;
    }

    // Capture a signature up to the next top-level `;`. Track
    // braces / parens / strings to avoid false matches inside generic
    // params or argument tuples.
    const sigStart = i;
    let depth = 0;
    /** @type {'' | "'" | '"' | '`'} */
    let inString = '';
    while (i < body.length) {
      const c = body[i] ?? '';
      const prev = body[i - 1] ?? '';
      if (inString !== '') {
        if (c === inString && prev !== '\\') inString = '';
      } else if (c === '"' || c === "'" || c === '`') {
        inString = c;
      } else if (c === '(' || c === '{' || c === '<' || c === '[') {
        depth++;
      } else if (c === ')' || c === '}' || c === '>' || c === ']') {
        depth--;
      } else if (c === ';' && depth === 0) {
        break;
      }
      i++;
    }
    const sigEnd = i;
    const signature = body.slice(sigStart, sigEnd).trim();
    if (signature.length > 0) out.push({ jsdoc, signature });
    i = sigEnd + 1; // skip the `;`
  }
  return out;
}

/**
 * Extract the leading method name from a signature like
 * `set(c: string, k: string, v: unknown): Promise<void>` -> `set`.
 *
 * @param {string} signature
 * @returns {string}
 */
function methodNameFromSignature(signature) {
  const match = /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(signature);
  return match !== null ? (match[1] ?? '') : '';
}

/**
 * Parse a `lite/<module>/api.ts` file into the manifest's `surface`
 * shape. Returns null if no `XApi` interface is found.
 *
 * @param {string} source
 * @returns {{ summary: string; surface: { interfaceName: string; interfaceDescription: string; methods: import('./types.js').MethodDoc[] } | null }}
 */
function parseApiSource(source) {
  // Top-of-file JSDoc = module summary.
  const topJsdocMatch = /^\s*(\/\*\*[\s\S]*?\*\/)/.exec(source);
  const topJsdoc = topJsdocMatch !== null ? (topJsdocMatch[1] ?? '') : '';
  const topParsed = topJsdoc.length > 0 ? parseJsdoc(stripJsdocDelimiters(topJsdoc)) : null;
  const summary = topParsed?.description ?? '';

  // Find the XApi interface.
  const interfaceMatch = /export\s+interface\s+(\w+Api)\b/.exec(source);
  if (interfaceMatch === null) {
    return { summary, surface: null };
  }
  const interfaceName = interfaceMatch[1] ?? '';
  const found = findInterfaceBody(source, interfaceName);
  if (found === null) return { summary, surface: null };

  const interfaceDescription =
    found.jsdoc !== null ? parseJsdoc(stripJsdocDelimiters(found.jsdoc)).description : '';

  /** @type {import('./types.js').MethodDoc[]} */
  const methods = splitMethods(found.body).map(({ jsdoc, signature }) => {
    const parsed = jsdoc !== null ? parseJsdoc(stripJsdocDelimiters(jsdoc)) : null;
    return {
      name: methodNameFromSignature(signature),
      signature,
      description: parsed?.description ?? '',
      tags: parsed?.tags ?? [],
      examples: parsed?.examples ?? [],
    };
  });

  return {
    summary,
    surface: {
      interfaceName,
      interfaceDescription,
      methods,
    },
  };
}

/**
 * Parse a `lite/<module>/events.ts` file into the manifest's `events`
 * shape. Returns null if no `<MODULE>_EVENTS` const is found.
 *
 * @param {string} source
 * @returns {{ constantName: string; count: number; entries: import('./types.js').EventDoc[] } | null}
 */
function parseEventsSource(source) {
  const constMatch = /export\s+const\s+(\w+_EVENTS)\s*=\s*\{([\s\S]*?)\}\s*as\s+const/.exec(source);
  if (constMatch === null) return null;
  const constantName = constMatch[1] ?? '';
  const body = constMatch[2] ?? '';
  /** @type {import('./types.js').EventDoc[]} */
  const entries = [];
  // Match `KEY: 'value',` lines, ignoring comments.
  const entryRe = /([A-Z_][A-Z0-9_]*)\s*:\s*'([^']+)'/g;
  /** @type {RegExpExecArray | null} */
  let m;
  while ((m = entryRe.exec(body)) !== null) {
    const constantKey = m[1];
    const name = m[2];
    if (constantKey === undefined || name === undefined) continue;
    entries.push({ constantKey, name, description: '' });
  }
  return { constantName, count: entries.length, entries };
}

// ─── Main ───────────────────────────────────────────────────────────────

/**
 * Find every immediate subdirectory of liteRoot that contains both
 * `api.ts` and (optionally) `README.md`.
 *
 * @returns {string[]}
 */
function discoverModules() {
  /** @type {string[]} */
  const slugs = [];
  for (const entry of fs.readdirSync(liteRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (entry.name === 'test' || entry.name === 'scripts' || entry.name === 'api-docs') continue;
    const apiPath = path.join(liteRoot, entry.name, 'api.ts');
    if (fs.existsSync(apiPath)) slugs.push(entry.name);
  }
  slugs.sort();
  return slugs;
}

/**
 * Build the manifest object by walking every documented module.
 *
 * @returns {import('./types.js').Manifest}
 */
function build() {
  const slugs = discoverModules();
  /** @type {import('./types.js').ModuleDoc[]} */
  const modules = [];
  for (const slug of slugs) {
    const moduleDir = path.join(liteRoot, slug);
    const apiSource = fs.readFileSync(path.join(moduleDir, 'api.ts'), 'utf-8');
    const { summary, surface } = parseApiSource(apiSource);

    const eventsPath = path.join(moduleDir, 'events.ts');
    const events = fs.existsSync(eventsPath)
      ? parseEventsSource(fs.readFileSync(eventsPath, 'utf-8'))
      : null;

    const readmePath = path.join(moduleDir, 'README.md');
    const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf-8') : null;

    modules.push({
      slug,
      title: slugToTitle(slug),
      summary,
      surface,
      events,
      readme,
    });
  }

  return {
    modules,
    untyped: UNTYPED_MODULES,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Serialize the manifest as a TS module. Uses JSON.stringify for the
 * value with TypeScript-compatible output.
 *
 * @param {import('./types.js').Manifest} manifest
 * @returns {string}
 */
function serialize(manifest) {
  const json = JSON.stringify(manifest, null, 2);
  return [
    '// THIS FILE IS GENERATED. Do not edit by hand.',
    '// Source: lite/api-docs/manifest-builder.mjs',
    '// Run: npm run lite:build:api-docs-manifest',
    '// Per ADR-035, this manifest backs the in-app API Reference window.',
    '',
    "import type { Manifest } from './types.js';",
    '',
    `export const MANIFEST: Manifest = ${json} as const;`,
    '',
  ].join('\n');
}

const manifest = build();
fs.writeFileSync(outputPath, serialize(manifest), 'utf-8');

const moduleSummary = manifest.modules
  .map(
    (m) =>
      `  ${m.slug.padEnd(12)} ${m.surface !== null ? `${m.surface.methods.length} methods` : 'no api.ts'}` +
      `${m.events !== null ? `, ${m.events.count} events` : ''}` +
      `${m.readme !== null ? ', README' : ''}`
  )
  .join('\n');
// eslint-disable-next-line no-console
console.log(
  `[api-docs] manifest written -> ${path.relative(liteRoot, outputPath)}\n` +
    `  modules: ${manifest.modules.length}\n` +
    `  untyped: ${manifest.untyped.length}\n` +
    moduleSummary
);
