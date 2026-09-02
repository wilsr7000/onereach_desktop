import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Structural guard for lite stylesheets.
 *
 * Twice now (v0.0.57, v0.0.61) a scripted CSS insert produced a doubled
 * selector — `.foo {.foo {` — leaving one brace unclosed. Under CSS
 * nesting semantics the sheet still "parses": every rule after the bad
 * line becomes a nested rule scoped under the broken selector and
 * silently matches nothing. Thousands of lines of styling die with no
 * build error and no console error. This test makes that failure mode
 * mechanical: balanced braces, no unclosed comments, no doubled-anchor
 * lines — for every stylesheet a lite window loads.
 */

/** Every stylesheet a lite window loads (the theme conversion touched them all). */
const SHEETS = [
  'lite/spaces/spaces.css',
  'lite/signature.css',
  'lite/settings/settings.css',
  'lite/main-window/chrome.css',
  'lite/learn/learn.css',
  'lite/bug-report/modal.css',
  'lite/idw/catalog.css',
  'lite/ai-run-times/feed.css',
  'lite/university/tutorials.css',
  'lite/api-docs/index.css',
  'lite/tools/manager.css',
  'lite/help/help.css',
  'lite/downloads/picker.css',
];

interface ScanResult {
  finalDepth: number;
  firstNegativeLine: number | null;
  unclosedCommentLine: number | null;
}

function scan(source: string): ScanResult {
  // Strip comments but keep line numbers; an unterminated comment is
  // itself a finding.
  let unclosedCommentLine: number | null = null;
  let stripped = '';
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf('/*', index);
    if (open === -1) {
      stripped += source.slice(index);
      break;
    }
    stripped += source.slice(index, open);
    const close = source.indexOf('*/', open + 2);
    if (close === -1) {
      unclosedCommentLine = source.slice(0, open).split('\n').length;
      break;
    }
    stripped += '\n'.repeat(source.slice(open, close).split('\n').length - 1);
    index = close + 2;
  }

  let depth = 0;
  let firstNegativeLine: number | null = null;
  let line = 1;
  for (const ch of stripped) {
    if (ch === '\n') line += 1;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth < 0 && firstNegativeLine === null) firstNegativeLine = line;
    }
  }
  return { finalDepth: depth, firstNegativeLine, unclosedCommentLine };
}

describe.each(SHEETS)('stylesheet structure: %s', (sheet) => {
  const source = readFileSync(resolve(__dirname, '../../..', sheet), 'utf-8');

  it('has balanced braces (no rule left unclosed, none over-closed)', () => {
    const result = scan(source);
    expect(result.unclosedCommentLine, 'unterminated /* comment at line').toBeNull();
    expect(result.firstNegativeLine, 'extra } at line').toBeNull();
    expect(result.finalDepth, 'unclosed { rules remaining at EOF').toBe(0);
  });

  it('has no doubled-selector insert artifact (`.x {.x {`)', () => {
    const doubled = source
      .split('\n')
      .map((text, i) => ({ text, line: i + 1 }))
      .filter(({ text }) => /([.#][-\w]+)\s*\{\s*\1\s*\{/.test(text));
    expect(doubled, 'doubled selector+brace on one line').toEqual([]);
  });
});
