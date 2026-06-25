/**
 * New-asset modal pane-visibility invariant (drift catcher).
 *
 * `switchNewAssetMode()` reveals exactly one pane by setting
 * `pane.hidden = (paneMode !== mode)` on every `[data-asset-pane]`. That
 * relies on the `hidden` attribute actually hiding the element.
 *
 * But `.spaces-new-asset-field { display: flex }` has the SAME specificity
 * as the UA rule `[hidden] { display: none }`, and being a later *author*
 * rule it WINS the cascade — so without an explicit
 * `.spaces-new-asset-field[hidden] { display: none }` override, the
 * switched-away panes (Content / File / Agent source + Reachability) stay
 * stacked and visible. That was a real bug observed live in 0.0.20. This
 * test guards the override so it can't silently regress.
 *
 * (Pure CSS-cascade bug: jsdom doesn't compute the cascade, so a renderer
 * unit test can't catch it — hence this source-level invariant, mirroring
 * chrome-height-invariant.test.ts.)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
// Strip /* ... */ comments so a selector mentioned in prose can't be
// mistaken for a real rule by the scanner.
const CSS = readFileSync(join(ROOT, 'spaces/spaces.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
);

/** Extract the body of a top-level CSS rule by selector (first match). */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `selector ${selector} not found in spaces.css`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  expect(open, `no open brace after ${selector}`).toBeGreaterThan(start);
  expect(close, `no close brace after ${selector}`).toBeGreaterThan(open);
  return css.slice(open + 1, close);
}

describe('new-asset modal pane-visibility invariant', () => {
  it('.spaces-new-asset-field declares display: flex (the rule that necessitates the [hidden] override)', () => {
    const body = ruleBody(CSS, '.spaces-new-asset-field {');
    expect(body).toMatch(/display:\s*flex/);
  });

  it('.spaces-new-asset-field[hidden] forces display: none so switched-away panes hide', () => {
    const body = ruleBody(CSS, '.spaces-new-asset-field[hidden] {');
    expect(body).toMatch(/display:\s*none/);
  });
});
