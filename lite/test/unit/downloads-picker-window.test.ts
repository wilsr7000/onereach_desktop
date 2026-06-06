/**
 * picker-window single-instance + lifecycle tests.
 *
 * Electron is mocked with a tiny stub BrowserWindow that records
 * loadFile + show + close + destroy + listener registration. The
 * picker module wires everything through this stub; we drive the
 * Promise plumbing by emulating the events Electron would normally
 * fire.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.mock is hoisted above ALL imports + top-level declarations, so
// the FakeBrowserWindow used inside the mock factory must also be
// hoisted via vi.hoisted(). We expose it on a shared object so the
// tests below can read .instances + emit lifecycle events.
const fake = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = [];
    destroyed = false;
    shown = false;
    loadedFile: string | null = null;
    loadQuery: Record<string, string> | null = null;
    listeners = new Map<string, Listener[]>();
    ctor: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.ctor = opts;
      fake.FakeBrowserWindow.instances.push(this);
    }
    loadFile(p: string, opts?: { query?: Record<string, string> }): Promise<void> {
      this.loadedFile = p;
      this.loadQuery = opts?.query ?? null;
      return Promise.resolve();
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
    removeListener(event: string, listener: Listener): this {
      const arr = this.listeners.get(event) ?? [];
      this.listeners.set(
        event,
        arr.filter((l) => l !== listener)
      );
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const l of [...(this.listeners.get(event) ?? [])]) {
        l(...args);
      }
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    destroy(): void {
      this.destroyed = true;
      this.emit('closed');
    }
    close(): void {
      this.destroy();
    }
    focus(): void {
      /* noop */
    }
    show(): void {
      this.shown = true;
    }
    getBounds(): { x: number; y: number; width: number; height: number } {
      return { x: 0, y: 0, width: 420, height: 540 };
    }
    setBounds(): void {
      /* noop */
    }
  }
  return { FakeBrowserWindow };
});

vi.mock('electron', () => ({
  BrowserWindow: fake.FakeBrowserWindow,
}));

import {
  openSpacePicker,
  readBootstrap,
  resolvePicker,
  _hasActivePickerForTesting,
  _resetPickerForTesting,
} from '../../downloads/picker-window.js';
import type { PickerBootstrap } from '../../downloads/types.js';

const bootstrap: PickerBootstrap = {
  download: {
    fileName: 'notes.md',
    mimeType: 'text/markdown',
    kind: 'text',
    totalBytes: 1234,
    source: 'webContents:1',
  },
  spaces: [
    { id: 'sp-1', name: 'Inbox' },
    { id: 'sp-2', name: 'Reading' },
  ],
};

describe('picker-window', () => {
  beforeEach(() => {
    fake.FakeBrowserWindow.instances = [];
    _resetPickerForTesting();
  });

  it('opens a picker window, loads the HTML with ?dl=<id>, and tracks active state', async () => {
    const promise = openSpacePicker(
      {
        parent: null,
        htmlPath: '/tmp/picker.html',
        preloadPath: '/tmp/preload.js',
        downloadId: 'dl-xyz',
      },
      bootstrap
    );

    expect(_hasActivePickerForTesting()).toBe(true);
    expect(fake.FakeBrowserWindow.instances.length).toBe(1);
    const win = fake.FakeBrowserWindow.instances[0]!;
    expect(win.loadedFile).toBe('/tmp/picker.html');
    expect(win.loadQuery).toEqual({ dl: 'dl-xyz' });
    // Capture-time bootstrap is readable by the IPC handler.
    expect(readBootstrap('dl-xyz')).toBe(bootstrap);

    // resolvePicker settles the outer promise with the user pick.
    resolvePicker('dl-xyz', { spaceId: 'sp-2', spaceName: 'Reading' });
    const result = await promise;
    expect(result).toEqual({ spaceId: 'sp-2', spaceName: 'Reading' });

    // Window is closed + active state is cleared.
    expect(_hasActivePickerForTesting()).toBe(false);
  });

  it('closing the window without a resolve treats it as a cancel', async () => {
    const promise = openSpacePicker(
      {
        parent: null,
        htmlPath: '/tmp/p.html',
        preloadPath: '/tmp/pre.js',
        downloadId: 'dl-1',
      },
      bootstrap
    );
    const win = fake.FakeBrowserWindow.instances[0]!;
    win.emit('closed');
    const result = await promise;
    expect(result).toBeNull();
    expect(_hasActivePickerForTesting()).toBe(false);
  });

  it('single-instance: a second open call returns null without spawning another window', async () => {
    const first = openSpacePicker(
      {
        parent: null,
        htmlPath: '/p.html',
        preloadPath: '/p.js',
        downloadId: 'dl-A',
      },
      bootstrap
    );
    expect(fake.FakeBrowserWindow.instances.length).toBe(1);
    const second = await openSpacePicker(
      {
        parent: null,
        htmlPath: '/p.html',
        preloadPath: '/p.js',
        downloadId: 'dl-B',
      },
      bootstrap
    );
    expect(second).toBeNull();
    expect(fake.FakeBrowserWindow.instances.length).toBe(1);
    // Resolve the first so the outer promise doesn't dangle.
    resolvePicker('dl-A', null);
    await first;
  });

  it('readBootstrap returns null when no payload is stashed for that downloadId', () => {
    expect(readBootstrap('unknown-id')).toBeNull();
  });

  it('resolvePicker is a no-op for unknown downloadIds', () => {
    expect(() => resolvePicker('nope', null)).not.toThrow();
  });

  it('passes a parent through to the BrowserWindow ctor when present', async () => {
    // The picker keys "parent present?" off the option value being non-null,
    // so a plain object is enough to assert wiring.
    const fakeParent = new fake.FakeBrowserWindow({});
    const promise = openSpacePicker(
      {
        parent: fakeParent as unknown as Electron.BrowserWindow,
        htmlPath: '/p.html',
        preloadPath: '/p.js',
        downloadId: 'dl-P',
      },
      bootstrap
    );
    // First instance is the parent, second is the picker.
    expect(fake.FakeBrowserWindow.instances.length).toBe(2);
    const picker = fake.FakeBrowserWindow.instances[1]!;
    expect(picker.ctor['parent']).toBe(fakeParent);
    resolvePicker('dl-P', null);
    await promise;
  });
});
