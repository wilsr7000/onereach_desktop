/**
 * Theme-token meta-test.
 *
 * Light is the default theme and Dark is selected by prefers-color-
 * scheme (driven from Settings → Appearance through nativeTheme). That
 * only works if every lite surface paints THROUGH the tokens in
 * lite/signature.css — one bare palette literal in a stylesheet is a
 * pixel that ignores the theme. Before this test, ~2,100 such literals
 * lived across 13 sheets (converted 2026-09-01). This keeps them out:
 *
 *   1. signature.css defines every token in BOTH blocks (light `:root`
 *      and the dark `prefers-color-scheme` block) — a token missing
 *      from one side silently falls back to the other theme's value.
 *   2. No lite stylesheet (or inline <style>) contains a bare hex /
 *      rgb() colour outside a `theme-invariant` region. Black is
 *      allowed everywhere (shadows, scrims, masks, media letterbox);
 *      comments are ignored.
 *   3. Every BrowserWindow factory takes its `backgroundColor` from
 *      `windowBackgroundColor()` — a literal chrome colour flashes the
 *      wrong palette before first paint. Remote light-only surfaces
 *      (auth pages, the paper-themed WISER window) are listed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

const liteRoot = resolve(__dirname, '../..');
const read = (rel: string): string => readFileSync(resolve(liteRoot, rel), 'utf-8');

/** Every stylesheet a lite window loads, plus pages with inline styles. */
export const THEMED_SHEETS = [
  'signature.css',
  'spaces/spaces.css',
  'settings/settings.css',
  'main-window/chrome.css',
  'learn/learn.css',
  'bug-report/modal.css',
  'idw/catalog.css',
  'ai-run-times/feed.css',
  'university/tutorials.css',
  'api-docs/index.css',
  'tools/manager.css',
  'help/help.css',
  'downloads/picker.css',
  'about.html',
  'placeholder.html',
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Lines outside `theme-invariant` regions, with comments blanked. Token
 * DEFINITIONS (`--or-x: #…`) are the one legitimate home of a literal
 * and are skipped in signature.css only — any other sheet defining a
 * palette literal under a local custom property is still an offender.
 */
function themedLines(
  source: string,
  opts: { skipTokenDefinitions: boolean }
): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let invariant = false;
  stripComments(source)
    .split('\n')
    .forEach((text, i) => {
      const raw = source.split('\n')[i] ?? '';
      if (raw.includes('theme-invariant:start')) invariant = true;
      if (raw.includes('theme-invariant:end')) {
        invariant = false;
        return;
      }
      if (invariant || raw.includes('theme-invariant')) return;
      if (opts.skipTokenDefinitions && /^\s*--or-[a-z0-9-]+\s*:/.test(text)) return;
      out.push({ line: i + 1, text });
    });
  return out;
}

const HEX = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
const RGB = /\brgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\b/g;

describe('theme tokens — signature.css', () => {
  const source = read('signature.css');

  function tokenNames(block: string): string[] {
    return Array.from(block.matchAll(/--or-([a-z0-9-]+)\s*:/g), (m) => m[1] ?? '').sort();
  }

  it('the light block is the default :root and the dark block is the media query', () => {
    expect(source).toMatch(/:root\s*\{\s*color-scheme:\s*light;/);
    expect(source).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{\s*color-scheme:\s*dark;/);
  });

  it('light and dark define exactly the same token names', () => {
    const lightStart = source.indexOf(':root {');
    const darkStart = source.indexOf('@media (prefers-color-scheme: dark)');
    const darkEnd = source.indexOf('\n  }\n}', darkStart);
    const light = tokenNames(source.slice(lightStart, darkStart));
    const dark = tokenNames(source.slice(darkStart, darkEnd));
    expect(light.length).toBeGreaterThan(60);
    expect(dark).toEqual(light);
    // Non-colour tokens (type, spacing, motion) belong to the shared
    // block AFTER both palettes, never duplicated per theme.
    for (const name of ['font-sans', 'space-2', 'radius-md', 'text-sm']) {
      expect(light, `${name} is not a palette token`).not.toContain(name);
      expect(source).toContain(`--or-${name}:`);
    }
  });

  it('dark values are the original palette (canvas, accent, text)', () => {
    const darkStart = source.indexOf('@media (prefers-color-scheme: dark)');
    const dark = source.slice(darkStart);
    expect(dark).toContain('--or-bg-canvas: #0e0e10;');
    expect(dark).toContain('--or-accent: #4f8cff;');
    expect(dark).toContain('--or-text-primary: #f4f6fb;');
    expect(dark).toContain('--or-ink-rgb: 255, 255, 255;');
  });

  it('light values are light (canvas near white, ink near black)', () => {
    const light = source.slice(0, source.indexOf('@media (prefers-color-scheme: dark)'));
    expect(light).toMatch(/--or-bg-canvas: #f[0-9a-f]{5};/);
    expect(light).toMatch(/--or-text-primary: #[01][0-9a-f]{5};/);
    expect(light).toMatch(/--or-ink-rgb: \d{1,2}, \d{1,2}, \d{1,2};/);
  });
});

describe.each(THEMED_SHEETS)('theme tokens — no bare palette literal: %s', (sheet) => {
  const source = read(sheet);

  it('paints only through tokens (black and theme-invariant regions excepted)', () => {
    const offenders: string[] = [];
    for (const { line, text } of themedLines(source, {
      skipTokenDefinitions: sheet === 'signature.css',
    })) {
      for (const m of text.matchAll(HEX)) {
        const hex = m[0].toLowerCase();
        if (hex === '#000' || hex === '#000000') continue;
        offenders.push(`${sheet}:${line}: ${m[0]}`);
      }
      for (const m of text.matchAll(RGB)) {
        if (m[1] === '0' && m[2] === '0' && m[3] === '0') continue;
        offenders.push(`${sheet}:${line}: ${m[0]}`);
      }
    }
    expect(offenders, 'bare colour literals (use a --or-* token, or mark a theme-invariant region)').toEqual([]);
  });
});

describe('theme tokens — window chrome', () => {
  /** Windows that load REMOTE light-only pages and keep a literal. */
  const REMOTE_LIGHT_WINDOWS = new Set([
    'auth/window.ts',
    'auth/oauth-popup.ts',
    'wiser-playbooks-window.ts',
  ]);

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'test' || entry.startsWith('dist')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
    }
    return out;
  }

  it('every BrowserWindow backgroundColor comes from windowBackgroundColor()', () => {
    const offenders: string[] = [];
    for (const file of walk(liteRoot)) {
      const rel = relative(liteRoot, file);
      if (REMOTE_LIGHT_WINDOWS.has(rel) || rel === 'theme/main.ts') continue;
      const text = readFileSync(file, 'utf-8');
      for (const m of text.matchAll(/backgroundColor:\s*(['"`]#[0-9a-fA-F]{3,8}['"`])/g)) {
        offenders.push(`${rel}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the theme module owns the two chrome backgrounds and they match the canvas tokens', () => {
    const main = read('theme/main.ts');
    const sig = read('signature.css');
    const dark = /DARK_WINDOW_BACKGROUND = '(#[0-9a-f]{6})'/.exec(main)?.[1];
    const light = /LIGHT_WINDOW_BACKGROUND = '(#[0-9a-f]{6})'/.exec(main)?.[1];
    expect(dark).toBeDefined();
    expect(light).toBeDefined();
    expect(sig).toContain(`--or-bg-canvas: ${light};`);
    expect(sig).toContain(`--or-bg-canvas: ${dark};`);
  });
});
