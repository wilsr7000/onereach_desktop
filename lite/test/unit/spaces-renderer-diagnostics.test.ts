/**
 * Renderer failure diagnostics for the Spaces window.
 *
 * Motivating incident: "the Spaces window crashes" — and the app had
 * recorded NOTHING. No crash report (the process never died), no
 * main-process error, no renderer log (renderers don't write to the
 * central log at all). A JS exception produced a blank window and zero
 * evidence, which makes the report unactionable.
 *
 * These handlers live in the MAIN process deliberately: they still fire
 * when the renderer's own JS is dead, which is exactly the case a
 * renderer-side handler can't cover.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

type Handler = (...args: unknown[]) => void;

/** Records the webContents listeners the window installs. */
class FakeWebContents {
  handlers = new Map<string, Handler[]>();
  on(event: string, fn: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }
  setWindowOpenHandler(): void {}
  emit(event: string, ...args: unknown[]): void {
    for (const fn of this.handlers.get(event) ?? []) fn(...args);
  }
  has(event: string): boolean {
    return (this.handlers.get(event) ?? []).length > 0;
  }
}

const fakeWin = { webContents: new FakeWebContents(), isDestroyed: () => false };

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = fakeWin.webContents;
    isDestroyed(): boolean {
      return false;
    }
    once(): void {}
    on(): void {}
    setBounds(): void {}
    getBounds(): Record<string, number> {
      return { x: 0, y: 0, width: 1, height: 1 };
    }
    loadFile(): Promise<void> {
      return Promise.resolve();
    }
    show(): void {}
    close(): void {}
    focus(): void {}
    isMinimized(): boolean {
      return false;
    }
    restore(): void {}
  },
  screen: {
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

interface Diagnostic {
  level: string;
  message: string;
  data: Record<string, unknown>;
}

async function openWindowWithDiagnostics(): Promise<{
  wc: FakeWebContents;
  seen: Diagnostic[];
  close: () => void;
}> {
  const seen: Diagnostic[] = [];
  const mod = await import('../../spaces/window.js');
  fakeWin.webContents = new FakeWebContents();
  mod.createSpacesWindow({
    parent: null,
    htmlPath: '/tmp/spaces.html',
    preloadPath: '/tmp/preload.js',
    loadBounds: async () => null,
    saveBounds: async () => {},
    onDiagnostic: (level, message, data) => seen.push({ level, message, data }),
  });
  return { wc: fakeWin.webContents, seen, close: () => mod.closeSpacesWindow() };
}

describe('spaces window renderer diagnostics', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('installs handlers for every silent-failure mode', async () => {
    const { wc, close } = await openWindowWithDiagnostics();
    for (const event of ['render-process-gone', 'unresponsive', 'did-fail-load', 'console-message']) {
      expect(wc.has(event), `no handler for "${event}" — that failure would be silent`).toBe(true);
    }
    close();
  });

  it('reports a dead renderer process with its reason and exit code', async () => {
    const { wc, seen, close } = await openWindowWithDiagnostics();
    wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.level).toBe('error');
    expect(seen[0]?.data['reason']).toBe('crashed');
    expect(seen[0]?.data['exitCode']).toBe(133);
    close();
  });

  it('reports a wedged renderer', async () => {
    const { wc, seen, close } = await openWindowWithDiagnostics();
    wc.emit('unresponsive');
    expect(seen[0]?.message).toContain('unresponsive');
    close();
  });

  it('reports a failed page load', async () => {
    const { wc, seen, close } = await openWindowWithDiagnostics();
    wc.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///missing.html');
    expect(seen[0]?.data['errorDescription']).toBe('ERR_FILE_NOT_FOUND');
    close();
  });

  // Electron changed the console-message signature across majors. Read
  // both shapes so the diagnostic doesn't silently stop working on bump.
  it('captures console errors in the MODERN (details object) signature', async () => {
    const { wc, seen, close } = await openWindowWithDiagnostics();
    wc.emit('console-message', {
      level: 'error',
      message: 'TypeError: x is not a function',
      lineNumber: 42,
      sourceId: 'spaces.js',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.data['text']).toContain('TypeError');
    expect(seen[0]?.data['line']).toBe(42);
    close();
  });

  it('captures console errors in the LEGACY (positional) signature', async () => {
    const { wc, seen, close } = await openWindowWithDiagnostics();
    wc.emit('console-message', {}, 3, 'Uncaught ReferenceError: boom', 7, 'spaces.js');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.data['text']).toContain('ReferenceError');
    close();
  });

  it('ignores non-error console output — logs must not become noise', async () => {
    const { wc, seen, close } = await openWindowWithDiagnostics();
    wc.emit('console-message', { level: 'info', message: 'just a log' });
    wc.emit('console-message', {}, 1, 'a warning', 1, 'spaces.js');
    expect(seen).toHaveLength(0);
    close();
  });

  it('truncates a huge console error rather than flooding the log', async () => {
    const { wc, seen, close } = await openWindowWithDiagnostics();
    wc.emit('console-message', { level: 'error', message: 'x'.repeat(10_000) });
    expect(String(seen[0]?.data['text']).length).toBeLessThanOrEqual(2000);
    close();
  });
});
