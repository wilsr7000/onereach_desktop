/**
 * Tools open in a large in-app window, not the OS browser (2026-09-02:
 * "tools in the app opened the web page in chrome. Should have launched
 * an electron window extra large without security stuff so popups and
 * google connect work").
 *
 * Pins: the two open paths (menu click, IPC) go to the tool window; the
 * window is big, on one persistent partition, gets Chrome parity (UA +
 * OAuth-aware popups), keeps the sandbox, and its size math is right.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { toolWindowSize, TOOLS_PARTITION } from '../../tools/browser-window.js';
import { TOOLS_EVENTS } from '../../tools/events.js';

const read = (...candidates: string[]): string => {
  const found = candidates.map((p) => resolve(p)).find((p) => existsSync(p));
  if (found === undefined) throw new Error(`not found: ${candidates.join(', ')}`);
  return readFileSync(found, 'utf8');
};

describe('a tool opens in the app, not in Chrome', () => {
  it('both open paths (menu click, IPC open) go to the tool window; shell.openExternal is gone from tools/main', () => {
    const main = read('tools/main.ts', 'lite/tools/main.ts');
    expect(main).toContain('openToolInBrowser(entry)');
    expect(main).toContain('onOpenEntry: (entry) => openToolInBrowser(entry)');
    expect(main).not.toContain('shell.openExternal(entry.url)');
  });

  it('the window is large: ~92% of the work area, floored at 1280×800, capped at the display', () => {
    expect(toolWindowSize({ width: 2560, height: 1415 })).toEqual({ width: 2355, height: 1302 });
    expect(toolWindowSize({ width: 1440, height: 900 })).toEqual({ width: 1325, height: 828 });
    // A small display: the floor would exceed it — cap at the work area.
    expect(toolWindowSize({ width: 1280, height: 720 })).toEqual({ width: 1280, height: 720 });
  });

  it('one persistent session for every tool, Chrome parity, and the sandbox stays on', () => {
    const src = read('tools/browser-window.ts', 'lite/tools/browser-window.ts');
    expect(TOOLS_PARTITION).toBe('persist:lite-tools');
    expect(src).toContain('partition: TOOLS_PARTITION');
    // Chrome UA + OAuth-aware popup routing + context menu + downloads —
    // the same code the tab browser uses (ADR-063).
    expect(src).toContain("attachChromeParity(win.webContents, { partition: TOOLS_PARTITION })");
    expect(src).not.toContain('shell.openExternal');
    // "Without security stuff" is about popups, not the sandbox.
    expect(src).toContain('contextIsolation: true');
    expect(src).toContain('sandbox: true');
    expect(src).toContain('nodeIntegration: false');
    expect(src).toContain('webSecurity: true');
    expect(src).not.toContain('preload:');
    // Theme guardrail: window chrome colour comes from the theme module.
    expect(src).toContain('backgroundColor: windowBackgroundColor()');
  });

  it('reuses the window per tool and reports both the open and the load', () => {
    const src = read('tools/browser-window.ts', 'lite/tools/browser-window.ts');
    expect(src).toContain('const existing = windows.get(entry.id);');
    expect(src).toContain('existing.focus();');
    expect(TOOLS_EVENTS.BROWSER_OPENED).toBe('tools.browser.opened');
    expect(TOOLS_EVENTS.BROWSER_LOADED).toBe('tools.browser.loaded');
    expect(src).toContain('TOOLS_EVENTS.BROWSER_OPENED');
    expect(src).toContain('TOOLS_EVENTS.BROWSER_LOADED');
  });

  it('the Manage Tools copy no longer promises the OS browser', () => {
    const html = read('tools/manager.html', 'lite/tools/manager.html');
    expect(html).not.toContain('opens the URL in your default browser');
    expect(html).toContain('large window inside the app');
  });
});
