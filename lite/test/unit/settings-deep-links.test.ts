/**
 * Settings deep-link lint test.
 *
 * Guards against the (now-fixed) bug where contextual links like
 * "Open Settings -> Two-Factor" called `settings.open()` without
 * the section id, dropping the user on the default Account section
 * instead of where the link said it would go.
 *
 * The rule: any contextual call to `settings.open(...)` MUST pass
 * a string section id. The general-purpose "open Settings" call
 * (e.g. from a top-level menu item) MAY pass nothing -- that
 * falls through to the default section, which is intentional. We
 * detect "contextual" by inspecting the surrounding source: if
 * the same line / nearby lines mention a specific section name
 * (two-factor, account, ai, oagi, idws, etc.), the call must
 * include the matching id.
 *
 * Today the rule is simpler: every `settings.open(...)` call across
 * the renderer surfaces (chrome.ts, placeholder.ts, sections, etc.)
 * MUST take a section id argument. The plain "open Settings" goes
 * through the menu (registered with `click: () => settings.open()`
 * directly in `lite/settings/main.ts` or the seed menu, NOT in the
 * renderer source files).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');

/**
 * Files under these top-level directories are considered renderer-
 * surface code that should pass an explicit section id.
 *
 * `lite/settings/main.ts` and `lite/settings/window.ts` are EXCLUDED
 * because they implement the IPC + factory itself; calls there
 * with no section are the "open default" path which is allowed.
 */
const SURFACE_DIRS = [
  'main-window',
  'placeholder.ts',
  'idw',
  'ai-run-times',
  'university',
  'bug-report',
  'onboarding',
  // Settings sections themselves -- a section CAN cross-link to
  // another section, but it must specify which.
  'settings/sections',
];

const EXEMPT_FILES = [
  // The settings module itself wires the default-section behavior.
  'settings/api.ts',
  'settings/main.ts',
  'settings/window.ts',
  'settings/settings.ts',
  // Tests are exempt.
  'test/',
];

describe('Settings deep-link lint: every contextual settings.open() passes a section id', () => {
  it('finds zero unscoped settings.open() calls in renderer surfaces', () => {
    const violations: Array<{ file: string; line: number; snippet: string }> = [];
    for (const surface of SURFACE_DIRS) {
      const abs = join(ROOT, surface);
      walkAndCheck(abs, violations);
    }
    if (violations.length > 0) {
      const formatted = violations
        .map((v) => `  ${v.file}:${v.line}\n    ${v.snippet}`)
        .join('\n');
      throw new Error(
        `Found ${violations.length} unscoped settings.open() call(s):\n${formatted}\n\n` +
          'Fix: change `settings.open()` to `settings.open(\'<section-id>\')` ' +
          'so the contextual link goes to the right Settings section.'
      );
    }
    expect(violations).toEqual([]);
  });
});

function walkAndCheck(
  abs: string,
  violations: Array<{ file: string; line: number; snippet: string }>
): void {
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return;
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(abs)) {
      walkAndCheck(join(abs, entry), violations);
    }
    return;
  }
  if (!stat.isFile()) return;
  if (!abs.endsWith('.ts')) return;
  // Skip test files and other exempt files.
  for (const exempt of EXEMPT_FILES) {
    if (abs.includes(`/${exempt}`) || abs.endsWith(`/${exempt}`)) return;
  }

  const content = readFileSync(abs, 'utf8');
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    // Match `settings.open(` or `settings?.open(` etc., immediately
    // followed by `)` (zero args) or a `)` close right after with
    // optional `;` or chaining.
    // Tolerate optional chaining and whitespace.
    const re = /settings\??\.\s*open\s*\(\s*\)/;
    if (re.test(line)) {
      violations.push({
        file: abs.replace(`${ROOT}/`, ''),
        line: i + 1,
        snippet: line.trim(),
      });
    }
  }
}
