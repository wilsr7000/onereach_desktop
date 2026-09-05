/**
 * The NEON Graph Explorer launcher (Planning menu, 2026-09-04).
 *
 * The window hosts a page we do not build (Graphtester's deployed
 * explorer), from a URL that can change without us. What matters:
 *   - it is sandboxed and carries NO preload — the page gets nothing
 *     from Lite;
 *   - one window, however many times the menu is clicked;
 *   - nothing the page does can navigate it or open a window we
 *     didn't sanction;
 *   - the window keeps the menu's name, not the page's.
 * Electron is a stub; the module is driven through its real entry points.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  type OpenHandler = (details: { url: string }) => { action: string };

  class FakeWebContents {
    openHandler: OpenHandler | null = null;
    listeners: Record<string, (...args: unknown[]) => void> = {};
    setWindowOpenHandler(fn: OpenHandler): void {
      this.openHandler = fn;
    }
    on(event: string, fn: (...args: unknown[]) => void): void {
      this.listeners[event] = fn;
    }
  }

  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = [];
    ctor: Record<string, unknown>;
    webContents = new FakeWebContents();
    destroyed = false;
    minimized = false;
    shown = false;
    focusCount = 0;
    restoreCount = 0;
    loadedUrl: string | null = null;
    listeners = new Map<string, Listener[]>();

    constructor(opts: Record<string, unknown>) {
      this.ctor = opts;
      FakeBrowserWindow.instances.push(this);
    }
    loadURL(url: string): Promise<void> {
      this.loadedUrl = url;
      return state.loadFails
        ? Promise.reject(new Error('ERR_INTERNET_DISCONNECTED'))
        : Promise.resolve();
    }
    on(event: string, listener: Listener): this {
      const arr = this.listeners.get(event) ?? [];
      arr.push(listener);
      this.listeners.set(event, arr);
      return this;
    }
    once(event: string, listener: Listener): this {
      return this.on(event, listener);
    }
    emit(event: string, ...args: unknown[]): void {
      for (const l of [...(this.listeners.get(event) ?? [])]) l(...args);
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    isMinimized(): boolean {
      return this.minimized;
    }
    restore(): void {
      this.minimized = false;
      this.restoreCount += 1;
    }
    focus(): void {
      this.focusCount += 1;
    }
    show(): void {
      this.shown = true;
    }
    close(): void {
      this.destroyed = true;
      this.emit('closed');
    }
  }

  const state = {
    loadFails: false,
    workArea: { width: 3000, height: 2000 },
    opened: [] as string[],
    logged: [] as Array<{ kind: string; name: string; data?: unknown }>,
  };

  return { FakeBrowserWindow, state };
});

vi.mock('electron', () => ({
  BrowserWindow: h.FakeBrowserWindow,
  screen: { getPrimaryDisplay: () => ({ workAreaSize: h.state.workArea }) },
  shell: {
    openExternal: (url: string): Promise<void> => {
      h.state.opened.push(url);
      return Promise.resolve();
    },
  },
  ipcMain: { handle: (): void => undefined },
}));

vi.mock('../../logging/api.js', () => ({
  getLoggingApi: () => ({
    event: (name: string, data?: unknown) => h.state.logged.push({ kind: 'event', name, data }),
    warn: (name: string, message: string, data?: unknown) =>
      h.state.logged.push({ kind: 'warn', name: `${name}:${message}`, data }),
    info: () => undefined,
    error: () => undefined,
  }),
}));

type WindowModule = typeof import('../../neon-explorer-window.js');

/** Fresh module state per test — the launcher is a singleton by design. */
async function load(): Promise<WindowModule> {
  vi.resetModules();
  h.FakeBrowserWindow.instances = [];
  h.state.loadFails = false;
  h.state.workArea = { width: 3000, height: 2000 };
  h.state.opened = [];
  h.state.logged = [];
  return import('../../neon-explorer-window.js');
}

const windows = (): InstanceType<typeof h.FakeBrowserWindow>[] => h.FakeBrowserWindow.instances;
const only = (): InstanceType<typeof h.FakeBrowserWindow> => {
  const [first] = windows();
  if (first === undefined) throw new Error('no window was created');
  return first;
};

let mod: WindowModule;
beforeEach(async () => {
  mod = await load();
});

describe('the window it opens', () => {
  it('loads the deployed explorer over https, from the ioa-explorer public folder', () => {
    mod.openNeonExplorerWindow();
    expect(only().loadedUrl).toBe(mod.NEON_EXPLORER_URL);
    const url = new URL(mod.NEON_EXPLORER_URL);
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('files.edison.api.onereach.ai');
    expect(url.pathname.endsWith('/ioa-explorer/index.html')).toBe(true);
    expect(mod.NEON_EXPLORER_ORIGIN.endsWith('/ioa-explorer/')).toBe(true);
  });

  it('is sandboxed, context-isolated, and carries NO preload at all', () => {
    mod.openNeonExplorerWindow();
    const prefs = only().ctor['webPreferences'] as Record<string, unknown>;
    expect(prefs['sandbox']).toBe(true);
    expect(prefs['contextIsolation']).toBe(true);
    expect(prefs['nodeIntegration']).toBe(false);
    expect(prefs['webSecurity']).toBe(true);
    // The hosted page gets nothing from Lite — no bridge, no narrow one.
    expect(prefs['preload']).toBeUndefined();
  });

  it('keeps its own cookie jar, never the auth partition', () => {
    mod.openNeonExplorerWindow();
    const prefs = only().ctor['webPreferences'] as Record<string, unknown>;
    expect(prefs['partition']).toBe('persist:lite-neon-explorer');
  });

  it('is titled the way the Planning menu names it, and keeps that title', () => {
    mod.openNeonExplorerWindow();
    expect(only().ctor['title']).toBe(mod.NEON_EXPLORER_TITLE);
    expect(mod.NEON_EXPLORER_TITLE).toBe('NEON Graph Explorer');
    // The page calls itself "GSX Digital Twin" — the window does not follow.
    let prevented = false;
    only().emit('page-title-updated', { preventDefault: () => { prevented = true; } }, 'GSX Digital Twin');
    expect(prevented).toBe(true);
  });

  it('fits the display it opens on, and stays usable on a small one', () => {
    mod.openNeonExplorerWindow();
    expect(only().ctor['width']).toBe(1600); // capped on a big display
    expect(only().ctor['height']).toBe(1000);

    h.state.workArea = { width: 1024, height: 700 };
    mod.closeNeonExplorerWindow();
    mod.openNeonExplorerWindow();
    const small = windows()[1];
    expect(small?.ctor['width']).toBe(944); // 1024 - 80
    expect(small?.ctor['height']).toBe(620);

    h.state.workArea = { width: 400, height: 300 };
    mod.closeNeonExplorerWindow();
    mod.openNeonExplorerWindow();
    const tiny = windows()[2];
    expect(tiny?.ctor['width']).toBe(800); // floor, not a sliver
    expect(tiny?.ctor['height']).toBe(600);
  });

  it('shows only once the page is ready — no white flash', () => {
    mod.openNeonExplorerWindow();
    expect(only().ctor['show']).toBe(false);
    expect(only().shown).toBe(false);
    only().emit('ready-to-show');
    expect(only().shown).toBe(true);
  });

  it('warns instead of throwing when the explorer cannot be reached', async () => {
    h.state.loadFails = true;
    expect(() => mod.openNeonExplorerWindow()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state.logged.some((l) => l.kind === 'warn')).toBe(true);
  });

  it('logs the open with the URL it loaded', () => {
    mod.openNeonExplorerWindow();
    expect(h.state.logged).toContainEqual({
      kind: 'event',
      name: 'neon-explorer.open',
      data: { url: mod.NEON_EXPLORER_URL },
    });
  });
});

describe('one explorer, not one per click', () => {
  it('focuses the open window instead of opening a second', () => {
    mod.openNeonExplorerWindow();
    mod.openNeonExplorerWindow();
    mod.openNeonExplorerWindow();
    expect(windows()).toHaveLength(1);
    expect(only().focusCount).toBe(2);
    expect(h.state.logged.filter((l) => l.name === 'neon-explorer.focus')).toHaveLength(2);
  });

  it('un-minimises a hidden window rather than focusing something invisible', () => {
    mod.openNeonExplorerWindow();
    only().minimized = true;
    mod.openNeonExplorerWindow();
    expect(only().restoreCount).toBe(1);
    expect(only().minimized).toBe(false);
  });

  it('opens a fresh window after the user closes it', () => {
    mod.openNeonExplorerWindow();
    only().close();
    mod.openNeonExplorerWindow();
    expect(windows()).toHaveLength(2);
  });

  it('does not resurrect a window the user destroyed out from under us', () => {
    mod.openNeonExplorerWindow();
    only().destroyed = true; // destroyed without the 'closed' listener firing
    mod.openNeonExplorerWindow();
    expect(windows()).toHaveLength(2);
  });
});

describe('the hosted page cannot walk this window somewhere else', () => {
  const openWith = (url: string): { action: string } => {
    mod.openNeonExplorerWindow();
    const handler = only().webContents.openHandler;
    if (handler === null) throw new Error('no window-open handler installed');
    return handler({ url });
  };

  it('always denies the popup — this window stays on the explorer', () => {
    for (const url of ['https://example.com/', 'file:///etc/passwd', 'not a url']) {
      expect(openWith(url).action).toBe('deny');
      mod.closeNeonExplorerWindow();
    }
  });

  it('sends real web links to the OS browser', () => {
    openWith('https://onereach.ai/docs');
    expect(h.state.opened).toEqual(['https://onereach.ai/docs']);
  });

  it('refuses to hand non-web schemes to the OS', () => {
    for (const url of [
      'file:///Applications/Calculator.app',
      'javascript:alert(1)',
      'smb://attacker/share',
      'not a url at all',
    ]) {
      openWith(url);
      mod.closeNeonExplorerWindow();
    }
    expect(h.state.opened).toEqual([]);
  });
});

describe('will-navigate keeps the window on the explorer deployment', () => {
  const navigate = (url: string): { prevented: boolean } => {
    mod.openNeonExplorerWindow();
    const listener = only().webContents.listeners['will-navigate'];
    if (listener === undefined) throw new Error('no will-navigate guard installed');
    let prevented = false;
    listener({ preventDefault: () => { prevented = true; } }, url);
    return { prevented };
  };

  it('allows navigation within the deployment directory', () => {
    const { prevented } = navigate(mod.NEON_EXPLORER_ORIGIN + 'index.html?nocache=1');
    expect(prevented).toBe(false);
    mod.closeNeonExplorerWindow();
  });

  it('blocks foreign http(s) destinations and routes them to the OS browser', () => {
    const before = h.state.opened.length;
    const { prevented } = navigate('https://evil.example.com/take-over');
    expect(prevented).toBe(true);
    expect(h.state.opened.slice(before)).toEqual(['https://evil.example.com/take-over']);
    expect(h.state.logged.some((l) => l.name === 'neon-explorer.navigation-blocked')).toBe(true);
    mod.closeNeonExplorerWindow();
  });

  it('blocks non-web schemes without opening anything', () => {
    const before = h.state.opened.length;
    const { prevented } = navigate('file:///etc/passwd');
    expect(prevented).toBe(true);
    expect(h.state.opened.slice(before)).toEqual([]);
    mod.closeNeonExplorerWindow();
  });
});
