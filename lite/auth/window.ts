/**
 * Auth window factory.
 *
 * Per ADR-026, the auth window is dramatically simpler than the full
 * app's GSX window:
 *   - No preload (the OneReach auth page is the renderer; we don't need
 *     `window.lite.*` bridges inside it)
 *   - No toolbar / overlay / flow-context detection
 *   - Strict navigation containment: only `*.onereach.ai` allowed in-window;
 *     external links route to the system browser
 *   - `parent: mainWindow` (not modal) so the window is glued to the
 *     placeholder but doesn't freeze it
 *
 * Borrowed pattern (studied, not imported): per-account session
 * partition shape from `lib/gsx-autologin.js:1063-1120`.
 *
 * Other lite modules MUST NOT import this directly -- the auth store
 * uses it; consumers go through `getAuthApi()`.
 *
 * @internal
 */

import {
  BrowserWindow,
  shell,
  session as electronSession,
  type Session,
} from 'electron';
import type { Environment, EnvironmentConfig } from './types.js';
import { AUTH_EVENTS } from './events.js';

/**
 * Handle to an open auth window. Provides only what the store needs --
 * close, query the loaded URL, attach lifecycle callbacks. Internals
 * (the BrowserWindow itself) stay encapsulated.
 */
export interface AuthWindowHandle {
  /** The Electron partition string the window's session was created from. */
  readonly partition: string;
  /** The most recently navigated URL, for accountId extraction. */
  lastUrl?: string;
  /** Close the window. Idempotent and safe after window destruction. */
  close(): void;
  /** @internal -- accessed by store helpers below. */
  readonly _window?: BrowserWindow;
  /** @internal -- accessed by store helpers below. */
  _firstLoadFired: boolean;
  /** @internal -- accessed by store helpers below. */
  _firstLoadCallback: (() => void) | null;
  /** @internal -- accessed by store helpers below. */
  _closedCallback: (() => void) | null;
}

/**
 * Optional dependencies for `createAuthWindow`. Tests inject a stub
 * BrowserWindow constructor; production passes nothing.
 */
export interface CreateAuthWindowOptions {
  /** Override the parent BrowserWindow (defaults to none). */
  parent?: BrowserWindow | null;
  /**
   * Override the BrowserWindow constructor (for tests). Production
   * uses Electron's BrowserWindow.
   */
  windowCtor?: typeof BrowserWindow;
  /**
   * Optional structured event emitter -- when provided, the window
   * factory emits granular trace events (`auth.window.opened`,
   * `auth.window.nav-start`, `auth.window.nav-finish`, etc.) so the
   * lite event stream tells the whole story of an auth attempt:
   * which page is opened, every redirect, page-load timings, and
   * close.
   */
  emitEvent?: (
    name: string,
    data: unknown,
    level?: 'debug' | 'info' | 'warn' | 'error'
  ) => void;
}

/**
 * Open an auth window pointing at GSX for the given environment.
 *
 * The window:
 *   - Uses `persist:lite-auth-<env>` as its partition (isolated per env)
 *   - Has NO preload (loads only the OneReach auth page; needs no bridges)
 *   - Restricts navigation to `*.onereach.ai`; external links open in shell
 *   - Has `parent` set so it's glued to the placeholder window (not modal)
 */
export function createAuthWindow(
  env: Environment,
  config: EnvironmentConfig,
  opts: CreateAuthWindowOptions = {}
): AuthWindowHandle {
  const partition = `persist:lite-auth-${env}`;
  const Ctor = opts.windowCtor ?? BrowserWindow;

  const win = new Ctor({
    width: 680,
    height: 820,
    minWidth: 560,
    minHeight: 700,
    title: `Sign in to GSX (${env})`,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#ffffff',
    show: false,
    autoHideMenuBar: true,
    ...(opts.parent !== undefined && opts.parent !== null ? { parent: opts.parent } : {}),
    webPreferences: {
      partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  const handle: AuthWindowHandle = {
    partition,
    close: () => {
      try {
        if (!win.isDestroyed()) win.close();
      } catch {
        // best-effort
      }
    },
    _window: win,
    _firstLoadFired: false,
    _firstLoadCallback: null,
    _closedCallback: null,
  };

  const emit = opts.emitEvent ?? ((): void => undefined);

  // Per-navigation timing -- track when the most-recent main-frame
  // navigation started so did-finish-load can report durationMs.
  let mainFrameNavStartedAt = 0;
  let mainFrameNavUrl = '';

  // Record every navigation so the store can read accountId from the
  // most-recent URL when the `or` cookie payload doesn't include it.
  win.webContents.on('did-navigate', (_event, url) => {
    handle.lastUrl = url;
    emit(
      AUTH_EVENTS.WINDOW_NAV_FINISH,
      {
        env,
        url,
        durationMs: mainFrameNavStartedAt > 0 ? Date.now() - mainFrameNavStartedAt : 0,
      },
      'info'
    );
  });
  win.webContents.on('did-navigate-in-page', (_event, url) => {
    handle.lastUrl = url;
    emit(
      AUTH_EVENTS.WINDOW_NAV_FINISH,
      { env, url, durationMs: 0 },
      'info'
    );
  });

  win.webContents.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame) {
      mainFrameNavStartedAt = Date.now();
      mainFrameNavUrl = url;
    }
    emit(
      AUTH_EVENTS.WINDOW_NAV_START,
      { env, url, isMainFrame },
      'info'
    );
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (errorCode === -3) return; // ABORTED -- benign navigation cancel
    if (!isMainFrame) return; // ignore subframe failures
    emit(
      AUTH_EVENTS.WINDOW_NAV_FAIL,
      { env, url: validatedURL || mainFrameNavUrl, errorCode, errorDescription },
      'warn'
    );
  });

  win.webContents.on('page-title-updated', (_event, title) => {
    if (typeof title === 'string' && title.length > 0 && title.length <= 200) {
      emit(AUTH_EVENTS.WINDOW_TITLE, { env, title }, 'info');
    }
  });

  // Navigation containment: deny non-OneReach navigation in-window;
  // route external links to the system browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isOnereachUrl(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOnereachUrl(url)) {
      return { action: 'allow' };
    }
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // First-load callback: store probes for already-set cookies here.
  win.webContents.on('did-finish-load', () => {
    if (handle._firstLoadFired) return;
    handle._firstLoadFired = true;
    const cb = handle._firstLoadCallback;
    if (cb !== null) {
      try {
        cb();
      } catch {
        // best-effort
      }
    }
  });

  win.on('closed', () => {
    emit(
      AUTH_EVENTS.WINDOW_CLOSED,
      { env, ...(handle.lastUrl !== undefined ? { lastUrl: handle.lastUrl } : {}) },
      'info'
    );
    const cb = handle._closedCallback;
    if (cb !== null) {
      try {
        cb();
      } catch {
        // best-effort
      }
    }
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  emit(
    AUTH_EVENTS.WINDOW_OPENED,
    { env, url: config.studioUrl, partition },
    'info'
  );
  void win.loadURL(config.studioUrl);

  return handle;
}

/**
 * Register a callback that fires the first time the window finishes
 * loading. Used by the store to probe for already-set cookies (the
 * "user is still signed in from last session" case).
 *
 * If the first load already fired, the callback runs immediately on
 * the next microtask.
 */
export function onAuthWindowFirstLoad(handle: AuthWindowHandle, cb: () => void): void {
  if (handle._firstLoadFired) {
    queueMicrotask(cb);
    return;
  }
  handle._firstLoadCallback = cb;
}

/**
 * Register a callback that fires when the window is closed (by user
 * or by `close()`). Used by the store to detect cancellation.
 */
export function onAuthWindowClosed(handle: AuthWindowHandle, cb: () => void): void {
  handle._closedCallback = cb;
}

/**
 * Get the Electron Session backing the window's partition. Returns
 * null if the window is destroyed or the session can't be resolved.
 */
export function getAuthWindowSession(handle: AuthWindowHandle): Session | null {
  try {
    if (handle._window !== undefined && handle._window.isDestroyed()) return null;
    return electronSession.fromPartition(handle.partition);
  } catch {
    return null;
  }
}

/** Close the auth window. Convenience for callers that have only the handle. */
export function closeAuthWindow(handle: AuthWindowHandle): void {
  handle.close();
}

function isOnereachUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return host === 'onereach.ai' || host.endsWith('.onereach.ai');
  } catch {
    return false;
  }
}
