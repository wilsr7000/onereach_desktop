/**
 * GSX window manager -- the production {@link GsxWindowPort}.
 *
 * Opens standalone BrowserWindows onto studio.<env>.onereach.ai with:
 *
 *   - Partition `persist:lite-gsx-<env>` (stable per env, so the GSX
 *     session sticks across restarts -- mirrors the per-IDW stable
 *     partition decision, and full's `persist:gsx-<env>-<account>`
 *     from `lib/gsx-autologin.js`).
 *   - Auth cookie injection BEFORE loadURL via
 *     `getAuthApi().injectTokenIntoPartition` (ADR-042 idiom -- same
 *     order as `lite/main-window/window.ts` `prepareTabAndLoad`).
 *   - NO preload. Per ADR-038 (and the punch-list Neon finding), pages
 *     we automate never see `window.lite.*`. Everything is driven from
 *     main via `executeJavaScript`.
 *   - Chrome-UA disguise (borrows the `chromeUserAgent`/`disguiseSession`
 *     pattern from `lite/auth/window.ts` -- GSX shares the auth stack
 *     that rejects Electron UAs).
 *   - Navigation containment to *.onereach.ai; window.open is denied
 *     and retargeted into the same window.
 *
 * @internal -- wired into the store by `main.ts` (`initGsx`).
 */

import { BrowserWindow, session as electronSession, type Session } from 'electron';
import type { Environment } from '../auth/types.js';
import { getAuthApi } from '../auth/api.js';
import { getLoggingApi } from '../logging/api.js';
import type { GsxWindowInfo } from './types.js';
import type { GsxWindowPort } from './store.js';
import type { GsxExecutor } from './runner.js';
import { GsxError, GSX_ERROR_CODES } from './errors.js';

/** Stable per-env partition for GSX windows. */
export function gsxPartition(env: Environment): string {
  return `persist:lite-gsx-${env}`;
}

/** Borrow of `lite/auth/window.ts` chromeUserAgent (kept local: that
 *  helper is internal to the auth module and Rule 11 forbids reaching
 *  past its api.ts). */
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

const DISGUISED_SESSIONS = new WeakSet<Session>();

function disguiseSession(sess: Session, userAgent: string): void {
  if (DISGUISED_SESSIONS.has(sess)) return;
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
    callback({ requestHeaders: headers });
  });
  DISGUISED_SESSIONS.add(sess);
}

/** Only OneReach surfaces may be loaded/navigated in a GSX window. */
export function isAllowedGsxUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return host === 'onereach.ai' || host.endsWith('.onereach.ai');
}

interface TrackedWindow {
  windowId: string;
  env: Environment;
  win: BrowserWindow;
}

/** Build the production window port. One instance per app boot. */
export function createGsxWindowPort(): GsxWindowPort {
  const windows = new Map<string, TrackedWindow>();

  function tracked(windowId: string): TrackedWindow {
    const entry = windows.get(windowId);
    if (entry === undefined || entry.win.isDestroyed()) {
      windows.delete(windowId);
      throw new GsxError({
        code: GSX_ERROR_CODES.WINDOW_NOT_FOUND,
        message: `No open GSX window with id ${windowId}`,
        remediation: 'Call openWindow() first, or list windows to find a live id.',
      });
    }
    return entry;
  }

  function requireAllowed(url: string): void {
    if (!isAllowedGsxUrl(url)) {
      throw new GsxError({
        code: GSX_ERROR_CODES.URL_NOT_ALLOWED,
        message: `GSX windows only load https://*.onereach.ai URLs (got ${url.slice(0, 120)})`,
        remediation: 'Pass a studio.<env>.onereach.ai URL or a relative path.',
      });
    }
  }

  async function loadWithAuth(entry: TrackedWindow, url: string): Promise<void> {
    requireAllowed(url);
    // ADR-042: cookies go in BEFORE the navigation so GSX recognizes
    // the session on first paint. Soft-fail (the page falls back to
    // its own login, and the auth module's sign-in flow can recover).
    const injection = await getAuthApi().injectTokenIntoPartition(
      entry.env,
      gsxPartition(entry.env)
    );
    if (!injection.injected) {
      getLoggingApi().warn('gsx', 'auth token injection skipped', {
        env: entry.env,
        reason: injection.reason,
      });
    }
    try {
      await entry.win.loadURL(url);
    } catch (err) {
      throw new GsxError({
        code: GSX_ERROR_CODES.NAVIGATION_FAILED,
        message: `GSX window failed to load ${url.slice(0, 120)}`,
        remediation: 'Check the network and that you are signed in (Settings -> Account).',
        cause: err as Error,
      });
    }
  }

  return {
    async open(opts): Promise<GsxWindowInfo> {
      const partition = gsxPartition(opts.env);
      const ua = chromeUserAgent();
      disguiseSession(electronSession.fromPartition(partition), ua);
      const win = new BrowserWindow({
        width: 1600,
        height: 1000,
        title: opts.title ?? 'GSX',
        webPreferences: {
          partition,
          // No preload -- automated pages must not see window.lite.*.
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      win.webContents.setUserAgent(ua);
      // Contain navigation + swallow popups into the same window.
      win.webContents.setWindowOpenHandler(({ url }) => {
        if (isAllowedGsxUrl(url)) {
          void win.webContents.loadURL(url);
        }
        return { action: 'deny' };
      });
      win.webContents.on('will-navigate', (event, url) => {
        if (!isAllowedGsxUrl(url)) event.preventDefault();
      });
      const windowId = `gsx-${globalThis.crypto.randomUUID().slice(0, 8)}`;
      const entry: TrackedWindow = { windowId, env: opts.env, win };
      windows.set(windowId, entry);
      win.on('closed', () => {
        windows.delete(windowId);
      });
      await loadWithAuth(entry, opts.url);
      return {
        windowId,
        env: opts.env,
        url: win.webContents.getURL(),
        title: win.getTitle(),
      };
    },

    close(windowId): boolean {
      const entry = windows.get(windowId);
      if (entry === undefined) return false;
      windows.delete(windowId);
      if (!entry.win.isDestroyed()) entry.win.close();
      return true;
    },

    list(): GsxWindowInfo[] {
      const out: GsxWindowInfo[] = [];
      for (const entry of windows.values()) {
        if (entry.win.isDestroyed()) continue;
        out.push({
          windowId: entry.windowId,
          env: entry.env,
          url: entry.win.webContents.getURL(),
          title: entry.win.getTitle(),
        });
      }
      return out;
    },

    info(windowId): GsxWindowInfo | null {
      const entry = windows.get(windowId);
      if (entry === undefined || entry.win.isDestroyed()) return null;
      return {
        windowId: entry.windowId,
        env: entry.env,
        url: entry.win.webContents.getURL(),
        title: entry.win.getTitle(),
      };
    },

    async navigate(windowId, url): Promise<void> {
      const entry = tracked(windowId);
      await loadWithAuth(entry, url);
    },

    executor(windowId): GsxExecutor {
      // Resolve the entry lazily on each call so a destroyed window
      // surfaces as GSX_WINDOW_NOT_FOUND, not an Electron crash.
      return {
        exec: (script, userGesture) =>
          tracked(windowId).win.webContents.executeJavaScript(script, userGesture ?? false),
        navigate: async (url) => {
          await loadWithAuth(tracked(windowId), url);
        },
        currentUrl: () => tracked(windowId).win.webContents.getURL(),
      };
    },
  };
}
