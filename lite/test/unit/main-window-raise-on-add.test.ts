/**
 * Opening a tab raises the window (2026-08-08 bug report: "added
 * ChatGPT, it did not add a tab"). The tab opened fine — the store
 * count went 1→2 — but the main window stayed buried behind other
 * windows because opening never brought it forward.
 *
 * The raise decision is a pure predicate so the rule is pinned without
 * an Electron BrowserWindow: raise ONLY when the tab count increased.
 */

import { describe, it, expect } from 'vitest';
import { shouldRaiseOnTabChange } from '../../main-window/window.js';

describe('shouldRaiseOnTabChange — raise on open/focus, never on close', () => {
  it('raises when the count increases (a new tab was opened)', () => {
    expect(shouldRaiseOnTabChange(1, 2, 't1', 't2')).toBe(true);
    expect(shouldRaiseOnTabChange(0, 1, null, 't1')).toBe(true);
  });

  it('raises on dedupe-focus: count steady, active tab changed', () => {
    // Clicking a menu entry for an IDW already open focuses its tab —
    // count stays the same but the user still wants the window forward.
    expect(shouldRaiseOnTabChange(2, 2, 't1', 't2')).toBe(true);
  });

  it('does NOT raise when a tab is closed (count drops) — no focus theft', () => {
    // A close shifts the active tab to a sibling; must not raise.
    expect(shouldRaiseOnTabChange(3, 2, 't3', 't2')).toBe(false);
    expect(shouldRaiseOnTabChange(1, 0, 't1', null)).toBe(false);
  });

  it('does NOT raise on a pure URL nav / re-order (count + active steady)', () => {
    expect(shouldRaiseOnTabChange(2, 2, 't1', 't1')).toBe(false);
  });

  it('does NOT raise from the -1 boot sentinel (rehydrate shows on its own)', () => {
    expect(shouldRaiseOnTabChange(-1, 4, null, 't1')).toBe(false);
    expect(shouldRaiseOnTabChange(-1, 1, null, 't1')).toBe(false);
  });
});
