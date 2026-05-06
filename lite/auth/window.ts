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
import { buildPopupHandler, attachPopupLifecycle } from './oauth-popup.js';

/**
 * Build a Chrome user-agent string that matches the Electron-bundled
 * Chromium version, with platform-aware OS string. Google's
 * "Sign in with Google" flow ("WebLiteSignIn" / `disallowed_useragent`
 * check) refuses any UA that contains `Electron` or other webview
 * markers, so the auth window has to advertise itself as plain
 * Chrome -- mirrors `main.js:12575` in the full app.
 */
function chromeUserAgent(): string {
  const chromeVersion = process.versions.chrome ?? '120.0.0.0';
  if (process.platform === 'darwin') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  }
  if (process.platform === 'win32') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

/**
 * Per-session marker to remember which auth partitions already had
 * the header-rewrite hook installed. Re-installing the hook would
 * cause every request to invoke the callback twice.
 */
const REWRITTEN_PARTITIONS = new WeakSet<Session>();

/**
 * Install the Chrome-disguise on a partition session. Idempotent --
 * subsequent calls on the same session are no-ops.
 *
 * Replaces Electron-revealing request headers on every outgoing
 * request from this partition:
 *  - `User-Agent` -> Chrome UA (matches what `setUserAgent` set)
 *  - `Sec-CH-UA` is dropped if it contains "Electron"; Chromium
 *    rebuilds it from defaults on the next request
 *  - Other `X-Electron` / `Electron-Version` style headers stripped
 *    if any happen to leak in
 *
 * Mirrors the full app's `main.js:12579 onBeforeSendHeaders` block.
 */
function disguiseSession(sess: Session, userAgent: string): void {
  if (REWRITTEN_PARTITIONS.has(sess)) return;
  sess.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers: Record<string, string> = { ...details.requestHeaders };
    headers['User-Agent'] = userAgent;
    if (
      typeof headers['Sec-CH-UA'] === 'string' &&
      /electron/i.test(headers['Sec-CH-UA'])
    ) {
      delete headers['Sec-CH-UA'];
      delete headers['Sec-CH-UA-Full-Version'];
      delete headers['Sec-CH-UA-Full-Version-List'];
    }
    delete headers['X-Electron'];
    delete headers['Electron-Version'];
    if (headers['Accept-Language'] === undefined) {
      headers['Accept-Language'] = 'en-US,en;q=0.9';
    }
    callback({ requestHeaders: headers });
  });
  REWRITTEN_PARTITIONS.add(sess);
}

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

  // Disguise the auth window as plain Chrome so Google's
  // "Sign in with Google" flow doesn't refuse credentialing
  // ("disallowed_useragent" / "this browser may not be secure"
  // page on `accounts.google.com/v3/signin`). Default Electron UA
  // contains the literal string `Electron`, which Google blocks.
  // The full app does the same (`main.js:12575`).
  //
  // Test seam: `windowCtor` is overridden in unit tests with a stub
  // that has no `webContents`, so guard the calls.
  try {
    const ua = chromeUserAgent();
    if (typeof win.webContents?.setUserAgent === 'function') {
      win.webContents.setUserAgent(ua);
    }
    // The session associated with this partition exists as soon as
    // the BrowserWindow constructor returns. Apply the header
    // rewriter to it so XHR / OAuth subrequests also carry the
    // Chrome UA -- not just the top-frame navigations.
    if (typeof win.webContents?.session === 'object' && win.webContents.session !== null) {
      disguiseSession(win.webContents.session, ua);
    } else {
      // Fallback: look up the partition session via the global
      // electron `session.fromPartition` API. Same effect.
      disguiseSession(electronSession.fromPartition(partition), ua);
    }
  } catch {
    // best-effort: a UA-rewrite failure here is non-fatal -- the
    // user can still try to sign in with email/password, just not
    // via Google SSO.
  }

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
  // Popup handler: allow OneReach popups (e.g. OneReach's own
  // sign-in flow that pops a child) AND OAuth IdP popups (Google /
  // Microsoft / Apple SSO) in the same partition so cookies land
  // in `persist:lite-auth-<env>`. Anything else routes to the OS
  // default browser via `shell.openExternal`.
  //
  // Prior behavior denied all non-OneReach popups, which silently
  // broke "Sign in with Google" because the popup completed in
  // Safari and the resulting Google session never reached the
  // auth window's partition.
  win.webContents.setWindowOpenHandler(
    buildPopupHandler({
      partition,
      source: `auth-window:${env}`,
      extraAllowPredicate: (url) => isOnereachUrl(url),
      logger: (level, message, data) => {
        emit(
          AUTH_EVENTS.WINDOW_NAV_FINISH,
          { env, popup: true, level, message, ...(data ?? {}) },
          'info'
        );
      },
    })
  );

  // When the popup is created, attach lifecycle helpers so it
  // auto-closes once the OAuth flow returns control to the parent
  // (e.g. Google redirects back to login.onereach.ai after the
  // user authenticates).
  //
  // Also disguise the popup as Chrome -- the parent window's UA was
  // already overridden, but a new BrowserWindow does NOT inherit the
  // parent's `setUserAgent` value. Without this, Google's "Sign in
  // with Google" page (opened in the popup) sees Electron's default
  // UA and shows an indefinite spinner waiting for a credential
  // handshake that never comes. The session-level header rewrite
  // catches HTTP requests, but `navigator.userAgent` (the JS-side
  // value some Google flows check) is set per-webContents, so we
  // also need `setUserAgent` here.
  win.webContents.on('did-create-window', (popup) => {
    try {
      const ua = chromeUserAgent();
      if (typeof popup.webContents?.setUserAgent === 'function') {
        popup.webContents.setUserAgent(ua);
      }
    } catch {
      // best-effort: a UA failure on the popup is non-fatal -- the
      // session-level header rewrite still presents a Chrome UA at
      // the HTTP layer.
    }
    attachPopupLifecycle(win, popup, {
      source: `auth-window:${env}`,
      logger: (level, message, data) => {
        emit(
          AUTH_EVENTS.WINDOW_NAV_FINISH,
          { env, popup: true, level, message, ...(data ?? {}) },
          'info'
        );
      },
    });
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
