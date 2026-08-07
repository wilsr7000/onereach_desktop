/**
 * The Spaces window must enable Chromium's plugin host.
 *
 * Chromium renders PDFs with a PLUGIN, and Electron defaults
 * `webPreferences.plugins` to false. Without it, every
 * `<embed type="application/pdf">` in this window silently fails to
 * instantiate — which is not a cosmetic problem:
 *
 *   - PDF tile previews fell back to a generic extension badge, the
 *     "no preview in tile" complaint that kicked all of this off;
 *   - the detail pane's inline PDF viewer rendered nothing;
 *   - and each failed instantiation logged
 *     "Electron sandboxed_renderer.bundle.js script failed to run"
 *     plus a TypeError from the sandbox bootstrap — twice per refresh
 *     cycle, forever. 104 of them sat in one session log.
 *
 * None of that surfaced as an error to the user. The tiles just looked
 * empty. This test exists because the fix is a single easily-dropped
 * line in a config object, and losing it re-breaks PDFs everywhere in
 * Spaces with no failing test and no visible exception.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const captured: Array<Record<string, unknown>> = [];

vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor(opts: Record<string, unknown>) {
      captured.push(opts);
    }
    webContents = {
      on: (): void => {},
      setWindowOpenHandler: (): void => {},
    };
    isDestroyed(): boolean {
      return false;
    }
    once(): void {}
    on(): void {}
    show(): void {}
    close(): void {}
    focus(): void {}
    restore(): void {}
    isMinimized(): boolean {
      return false;
    }
    setBounds(): void {}
    getBounds(): Record<string, number> {
      return { x: 0, y: 0, width: 1, height: 1 };
    }
    loadFile(): Promise<void> {
      return Promise.resolve();
    }
  },
  screen: {
    getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }],
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
  shell: { openExternal: (): void => {} },
}));

vi.mock('../../kv/api.js', () => ({
  getKVApi: () => ({
    get: async (): Promise<null> => null,
    set: async (): Promise<void> => {},
  }),
}));

async function openWindow(): Promise<Record<string, unknown>> {
  captured.length = 0;
  const mod = await import('../../spaces/window.js');
  mod.createSpacesWindow({
    parent: null,
    htmlPath: '/tmp/spaces.html',
    preloadPath: '/tmp/preload.js',
    loadBounds: async () => null,
    saveBounds: async () => {},
    onDiagnostic: () => {},
  });
  const opts = captured[0];
  expect(opts, 'BrowserWindow was never constructed').toBeDefined();
  mod.closeSpacesWindow();
  return (opts as Record<string, unknown>)['webPreferences'] as Record<string, unknown>;
}

describe('Spaces window webPreferences', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('enables plugins, or every PDF in Spaces renders blank', async () => {
    const prefs = await openWindow();
    expect(
      prefs['plugins'],
      'Chromium renders PDFs via a plugin; Electron defaults this to false'
    ).toBe(true);
  });

  // Enabling the plugin host must not become an excuse to relax the
  // rest of the sandbox — these are the properties that keep a
  // malicious PDF or a compromised renderer contained.
  it('keeps the security posture intact alongside it', async () => {
    const prefs = await openWindow();
    expect(prefs['contextIsolation'], 'context isolation must stay on').toBe(true);
    expect(prefs['sandbox'], 'the renderer must stay sandboxed').toBe(true);
    expect(prefs['nodeIntegration'], 'node must stay out of the renderer').toBe(false);
    expect(prefs['webSecurity'], 'web security must stay on').toBe(true);
  });
});
