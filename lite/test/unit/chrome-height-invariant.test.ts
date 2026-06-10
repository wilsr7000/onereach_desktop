/**
 * Chrome tab-bar height invariant (drift catcher).
 *
 * The main-window factory positions tab / home-feed WebContentsViews at
 * `y = CHROME_HEIGHT_PX`, filling the content area BELOW the tab bar. If
 * that constant doesn't match the actual `.tab-bar { height }` in
 * chrome.css, those views are mispositioned and clip the bottom of the
 * tab bar (the Spaces button + tab pills) — exactly the regression this
 * test guards against.
 *
 * The equality only holds because the global reset sets
 * `box-sizing: border-box`, so `.tab-bar`'s declared height INCLUDES its
 * 1px bottom border and the content area begins at exactly that y. We
 * assert that too, so a future change to the box model can't silently
 * reintroduce a 1px (or larger) offset.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CHROME_HEIGHT_PX } from '../../main-window/types.js';

const ROOT = resolve(__dirname, '../..');
// Strip /* ... */ comments first so a selector mentioned in prose (e.g.
// in a doc comment) can't be mistaken for a real rule by the scanner.
const CSS = readFileSync(join(ROOT, 'main-window/chrome.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
);

/** Extract the body of a top-level CSS rule by selector (first match). */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `selector ${selector} not found in chrome.css`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  expect(open, `no open brace after ${selector}`).toBeGreaterThan(start);
  expect(close, `no close brace after ${selector}`).toBeGreaterThan(open);
  return css.slice(open + 1, close);
}

describe('chrome tab-bar height invariant', () => {
  it('.tab-bar height in chrome.css matches CHROME_HEIGHT_PX', () => {
    const body = ruleBody(CSS, '.tab-bar {');
    const match = /height:\s*(\d+)px/.exec(body);
    expect(match, '.tab-bar must declare an explicit px height').not.toBeNull();
    const cssHeight = Number(match?.[1]);
    expect(cssHeight).toBe(CHROME_HEIGHT_PX);
  });

  it('.tab-bar flex-basis (if present) also matches CHROME_HEIGHT_PX', () => {
    // `.tab-bar` pins its row with `flex: 0 0 <basis>` — if the basis and
    // the height disagree the rendered bar height is ambiguous.
    const body = ruleBody(CSS, '.tab-bar {');
    const flex = /flex:\s*0\s+0\s+(\d+)px/.exec(body);
    if (flex !== null) {
      expect(Number(flex[1])).toBe(CHROME_HEIGHT_PX);
    }
  });

  it('global box-sizing is border-box (so height includes the border)', () => {
    const body = ruleBody(CSS, '* {');
    expect(body).toMatch(/box-sizing:\s*border-box/);
  });
});
