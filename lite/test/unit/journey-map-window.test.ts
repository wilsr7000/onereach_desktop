/**
 * The Journey Map Builder launcher (ADR-072 phase 2).
 *
 * `spaces-journey-asset.test.ts` reads this file as TEXT and checks the
 * security lines are present. That catches a deletion; it cannot catch a
 * launcher that opens two windows, drops the second "Open in Builder"
 * click on the floor, hands a stale journey id to an unrelated open, or
 * lets the hosted page walk this window somewhere else. Those are
 * behaviours, so they are tested as behaviours here — Electron is a
 * stub, and the module is driven through its real entry points.
 *
 * The window hosts a page we do not build, from a URL that can change
 * without us. Two properties matter most:
 *   - it is sandboxed and carries only the narrow preload, and
 *   - nothing the page does can navigate it or open a window we didn't
 *     sanction.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  type OpenHandler = (details: { url: string }) => { action: string };

  class FakeWebContents {
    sent: Array<{ channel: string; payload: unknown }> = [];
    openHandler: OpenHandler | null = null;
    send(channel: string, payload: unknown): void {
      this.sent.push({ channel, payload });
    }
    setWindowOpenHandler(fn: OpenHandler): void {
      this.openHandler = fn;
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
    ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
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
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown): void => {
      h.state.ipcHandlers.set(channel, fn);
    },
  },
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

type WindowModule = typeof import('../../journey-map-window.js');

/** Fresh module state per test — the launcher is a singleton by design. */
async function load(): Promise<WindowModule> {
  vi.resetModules();
  h.FakeBrowserWindow.instances = [];
  h.state.loadFails = false;
  h.state.workArea = { width: 3000, height: 2000 };
  h.state.opened = [];
  h.state.ipcHandlers = new Map();
  h.state.logged = [];
  return import('../../journey-map-window.js');
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
  it('loads the deployed Builder over https', () => {
    mod.openJourneyMapWindow();
    expect(only().loadedUrl).toBe(mod.JOURNEY_MAP_BUILDER_URL);
    expect(new URL(mod.JOURNEY_MAP_BUILDER_URL).protocol).toBe('https:');
  });

  it('is sandboxed, context-isolated, and carries ONLY the journey preload', () => {
    mod.openJourneyMapWindow();
    const prefs = only().ctor['webPreferences'] as Record<string, unknown>;
    expect(prefs['sandbox']).toBe(true);
    expect(prefs['contextIsolation']).toBe(true);
    expect(prefs['nodeIntegration']).toBe(false);
    expect(prefs['webSecurity']).toBe(true);
    expect(String(prefs['preload'])).toContain('preload-journey-map.js');
    // Not the full bridge: hosted content must never reach window.lite.
    expect(String(prefs['preload'])).not.toContain('preload-lite.js');
  });

  it('keeps its own cookie jar, never the auth partition', () => {
    mod.openJourneyMapWindow();
    const prefs = only().ctor['webPreferences'] as Record<string, unknown>;
    expect(prefs['partition']).toBe('persist:lite-journey-map');
  });

  it('fits the display it opens on, and stays usable on a small one', () => {
    mod.openJourneyMapWindow();
    expect(only().ctor['width']).toBe(1600); // capped on a big display
    expect(only().ctor['height']).toBe(1000);

    h.state.workArea = { width: 1024, height: 700 };
    mod.closeJourneyMapWindow();
    mod.openJourneyMapWindow();
    const small = windows()[1];
    expect(small?.ctor['width']).toBe(944); // 1024 - 80
    expect(small?.ctor['height']).toBe(620);

    h.state.workArea = { width: 400, height: 300 };
    mod.closeJourneyMapWindow();
    mod.openJourneyMapWindow();
    const tiny = windows()[2];
    expect(tiny?.ctor['width']).toBe(800); // floor, not a sliver
    expect(tiny?.ctor['height']).toBe(600);
  });

  it('shows only once the page is ready — no white flash', () => {
    mod.openJourneyMapWindow();
    expect(only().ctor['show']).toBe(false);
    expect(only().shown).toBe(false);
    only().emit('ready-to-show');
    expect(only().shown).toBe(true);
  });

  it('warns instead of throwing when the Builder cannot be reached', async () => {
    h.state.loadFails = true;
    expect(() => mod.openJourneyMapWindow()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.state.logged.some((l) => l.kind === 'warn')).toBe(true);
  });
});

describe('one Builder, not one per click', () => {
  it('focuses the open window instead of opening a second', () => {
    mod.openJourneyMapWindow();
    mod.openJourneyMapWindow();
    mod.openJourneyMapWindow();
    expect(windows()).toHaveLength(1);
    expect(only().focusCount).toBe(2);
    expect(h.state.logged.filter((l) => l.name === 'journey-map.focus')).toHaveLength(2);
  });

  it('un-minimises a hidden window rather than focusing something invisible', () => {
    mod.openJourneyMapWindow();
    only().minimized = true;
    mod.openJourneyMapWindow();
    expect(only().restoreCount).toBe(1);
    expect(only().minimized).toBe(false);
  });

  it('opens a fresh window after the user closes it', () => {
    mod.openJourneyMapWindow();
    only().close();
    mod.openJourneyMapWindow();
    expect(windows()).toHaveLength(2);
  });

  it('does not resurrect a window the user destroyed out from under us', () => {
    mod.openJourneyMapWindow();
    only().destroyed = true; // destroyed without the 'closed' listener firing
    mod.openJourneyMapWindow();
    expect(windows()).toHaveLength(2);
  });
});

describe('"Open in Journey Map Builder" on a specific journey', () => {
  it('hands the id to the page that asks for it, once', () => {
    mod.openJourneyMapWindow({ itemId: 'journey-1' });
    expect(mod.takeJourneyTarget()).toBe('journey-1');
    // Consumed: a reload starts clean instead of reopening a journey the
    // user has moved on from.
    expect(mod.takeJourneyTarget()).toBeNull();
  });

  it('a later plain open does not resurrect the previous target', () => {
    mod.openJourneyMapWindow({ itemId: 'journey-1' });
    mod.closeJourneyMapWindow();
    mod.openJourneyMapWindow();
    expect(mod.takeJourneyTarget()).toBeNull();
  });

  it('a second journey reaches a window that is already open', () => {
    mod.openJourneyMapWindow({ itemId: 'journey-1' });
    mod.openJourneyMapWindow({ itemId: 'journey-2' });
    expect(windows()).toHaveLength(1);
    expect(only().webContents.sent).toEqual([
      { channel: 'lite:journey-map:target', payload: { itemId: 'journey-2' } },
    ]);
  });

  it('focusing with no target stays quiet — no phantom navigation', () => {
    mod.openJourneyMapWindow({ itemId: 'journey-1' });
    mod.openJourneyMapWindow();
    expect(only().webContents.sent).toEqual([]);
  });
});

describe('the takeTarget channel', () => {
  it('is registered once, however many times boot asks', () => {
    mod.registerJourneyMapTargetChannel();
    mod.registerJourneyMapTargetChannel();
    expect([...h.state.ipcHandlers.keys()]).toEqual(['lite:journey-map:takeTarget']);
  });

  it('serves the pending journey to the preload, then forgets it', async () => {
    mod.registerJourneyMapTargetChannel();
    const handler = h.state.ipcHandlers.get('lite:journey-map:takeTarget');
    expect(handler).toBeDefined();
    mod.openJourneyMapWindow({ itemId: 'journey-7' });
    expect(await handler?.()).toBe('journey-7');
    expect(await handler?.()).toBeNull();
  });
});

describe('the hosted page cannot walk this window somewhere else', () => {
  const openWith = (url: string): { action: string } => {
    mod.openJourneyMapWindow();
    const handler = only().webContents.openHandler;
    if (handler === null) throw new Error('no window-open handler installed');
    return handler({ url });
  };

  it('always denies the popup — this window stays on the Builder', () => {
    for (const url of ['https://example.com/', 'file:///etc/passwd', 'not a url']) {
      expect(openWith(url).action).toBe('deny');
      mod.closeJourneyMapWindow();
    }
  });

  it('sends real web links to the OS browser', () => {
    openWith('https://onereach.ai/docs');
    expect(h.state.opened).toEqual(['https://onereach.ai/docs']);
  });

  it('refuses to hand non-web schemes to the OS', () => {
    // shell.openExternal on file:/javascript: is how a hosted page turns
    // a link into local code execution. Only http(s) may leave.
    for (const url of [
      'file:///Applications/Calculator.app',
      'javascript:alert(1)',
      'smb://attacker/share',
      'not a url at all',
    ]) {
      openWith(url);
      mod.closeJourneyMapWindow();
    }
    expect(h.state.opened).toEqual([]);
  });
});
