/**
 * Auth-window Chrome-disguise tests.
 *
 * Why this exists: Google's "Sign in with Google" flow refuses
 * embedded webviews (UA contains "Electron") with the
 * `disallowed_useragent` page. The auth window has to claim a plain
 * Chrome UA. This test pins the helper's output shape so a future
 * refactor doesn't accidentally re-introduce the literal "Electron"
 * substring.
 *
 * The implementation lives in `lite/auth/window.ts` and is invoked
 * automatically when `createAuthWindow` runs in production. The
 * helper itself isn't exported (it's an internal detail of the
 * window factory), so we drive it through `createAuthWindow` with a
 * stub `BrowserWindow` ctor.
 */

import { describe, it, expect, vi } from 'vitest';
import { createAuthWindow } from '../../auth/window.js';
import { ENVIRONMENT_CONFIGS } from '../../auth/types.js';

interface FakeWebContents {
  ua: string | null;
  setUserAgent: (s: string) => void;
  on: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  session: object;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
}

interface FakeWindow {
  isDestroyed: () => boolean;
  close: () => void;
  show: () => void;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  webContents: FakeWebContents;
  isMinimized: () => boolean;
  loadURL: ReturnType<typeof vi.fn>;
}

function makeStubBrowserWindowCtor(): {
  ctor: typeof import('electron').BrowserWindow;
  createdWindows: FakeWindow[];
} {
  const createdWindows: FakeWindow[] = [];
  class StubBrowserWindow {
    public webContents: FakeWebContents = {
      ua: null,
      setUserAgent(s: string) {
        this.ua = s;
      },
      on: vi.fn(),
      loadURL: vi.fn(),
      // The real Session is irrelevant here; the production code
      // tries `webContents.session` first, falls back to
      // `electronSession.fromPartition`. Returning a plain object
      // makes disguiseSession's `webRequest` access throw -- which
      // the production code catches in its try/finally.
      session: {},
      setWindowOpenHandler: vi.fn(),
    };
    public isDestroyed = (): boolean => false;
    public close = (): void => undefined;
    public show = (): void => undefined;
    public on = vi.fn();
    public once = vi.fn();
    public isMinimized = (): boolean => false;
    public loadURL = vi.fn().mockResolvedValue(undefined);

    constructor(_opts: unknown) {
      createdWindows.push(this as unknown as FakeWindow);
    }
  }
  return {
    ctor: StubBrowserWindow as unknown as typeof import('electron').BrowserWindow,
    createdWindows,
  };
}

describe('createAuthWindow - Chrome user-agent disguise', () => {
  it('sets a Chrome user agent on the auth window webContents', () => {
    const { ctor, createdWindows } = makeStubBrowserWindowCtor();
    const config = ENVIRONMENT_CONFIGS['edison'];
    if (config === undefined) throw new Error('test env not found');

    createAuthWindow('edison', config, { windowCtor: ctor });

    expect(createdWindows).toHaveLength(1);
    const ua = createdWindows[0]?.webContents.ua;
    expect(ua).not.toBeNull();
    expect(typeof ua).toBe('string');
    // Critical: the UA must NOT mention Electron, or Google's
    // embedded-webview blocker fires.
    expect(ua ?? '').not.toMatch(/electron/i);
    expect(ua ?? '').toMatch(/Chrome\/\d+/);
    expect(ua ?? '').toMatch(/Safari\/537\.36/);
  });

  it('Mozilla prefix mirrors a real Chrome (browser-detection libraries look for it)', () => {
    const { ctor, createdWindows } = makeStubBrowserWindowCtor();
    const config = ENVIRONMENT_CONFIGS['edison'];
    if (config === undefined) throw new Error('test env not found');

    createAuthWindow('edison', config, { windowCtor: ctor });

    expect(createdWindows[0]?.webContents.ua ?? '').toMatch(/^Mozilla\/5\.0/);
  });
});
