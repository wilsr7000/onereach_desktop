/**
 * Shared OAuth popup handling for Lite's three popup-aware contexts:
 *  - The OneReach auth window (Google / Microsoft / Apple SSO into OneReach)
 *  - The main-window agent tabs (ChatGPT / Claude / Gemini / etc. signing in)
 *  - The IDW placeholder browser fallback (rollout backstop)
 *
 * The problem this solves: Electron's default `setWindowOpenHandler`
 * deny + `shell.openExternal(url)` pattern routes OAuth popups to
 * the OS default browser. The OAuth flow completes there, but the
 * resulting cookies stay in Safari / Chrome, never reaching the
 * Lite partition that opened the popup. The user-visible result is
 * a tab / auth window that still shows the login screen even
 * though they "signed in".
 *
 * The fix: when the popup target is a known IdP origin, allow it
 * as an in-app child BrowserWindow inheriting the opener's
 * `partition`. Cookies land in the same jar, the OAuth provider's
 * `window.opener.postMessage(...)` and redirect-back-to-parent
 * flows work, and the parent navigates to its post-auth state.
 *
 * Anything NOT on the allowlist still routes to `shell.openExternal`
 * (preserves the security posture of "third-party content can't
 * spawn arbitrary Electron windows").
 *
 * @internal -- consumers go through `buildPopupHandler({...})`.
 */

import { shell, type BrowserWindow, type HandlerDetails } from 'electron';
import { getLoggingApi } from '../logging/api.js';
import { AUTH_EVENTS } from './events.js';

/**
 * Origins that are recognized as OAuth providers. Matched against the
 * URL's `host` (case-insensitive). Subdomains of allowlisted hosts
 * are also accepted (e.g. `accounts.google.com` -> matches; `mail.google.com`
 * does NOT, because we match the full allowlisted host or any
 * subdomain of it).
 *
 * Keep this list intentionally narrow -- it's the trust boundary
 * for "what can spawn a child Electron window in our partition."
 *
 * Adding entries: prefer the most-specific origin (e.g. the
 * `accounts.<provider>` host, NOT the bare provider domain) so
 * non-OAuth pages on the same domain don't get popup privileges.
 */
export const OAUTH_POPUP_ALLOWLIST: ReadonlyArray<string> = Object.freeze([
  // Google (also covers NotebookLM / Gemini / Bard / Workspace login)
  'accounts.google.com',
  'oauth.gle',
  // Microsoft (covers AAD, Office 365, Copilot)
  'login.microsoftonline.com',
  'login.live.com',
  'login.microsoft.com',
  // Apple
  'appleid.apple.com',
  // GitHub OAuth (GitHub Copilot, Cursor, etc.)
  'github.com',
  // Generic SSO providers commonly used by SaaS
  'auth0.com',
  'okta.com',
  'okta-emea.com',
  'amazoncognito.com',
  // Atlassian (Jira / Confluence, sometimes the IdP for SaaS)
  'id.atlassian.com',
  // Slack OAuth
  'slack.com',
  // Zoom OAuth (when an IDW integrates Zoom)
  'accounts.zoom.us',
  // OpenAI's own auth flow (ChatGPT)
  'auth.openai.com',
  'auth0.openai.com',
  // Anthropic (Claude.ai)
  'auth.anthropic.com',
  // X / Twitter login
  'twitter.com',
  'x.com',
]);

/**
 * Returns `true` if the URL's host is on the OAuth allowlist (or a
 * subdomain of an allowlisted host).
 *
 * Returns `false` for malformed URLs, non-http(s) schemes, and any
 * host not on the allowlist.
 */
export function isOAuthPopupUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  for (const allowed of OAUTH_POPUP_ALLOWLIST) {
    if (host === allowed || host.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

export type PopupLogger = (
  level: 'info' | 'warn' | 'error',
  message: string,
  data?: Record<string, unknown>
) => void;

export interface BuildPopupHandlerOptions {
  /**
   * The opener's persistent partition. The popup BrowserWindow
   * inherits this so cookies land in the same jar.
   */
  partition: string;
  /**
   * Optional structured logger -- emits info on allow/deny so
   * popup-related issues are debuggable from the lite log server.
   */
  logger?: PopupLogger;
  /**
   * Optional extra allow predicate -- e.g. the OneReach auth window
   * also wants to allow `*.onereach.ai` popups, on top of the OAuth
   * allowlist. Called BEFORE the OAuth allowlist; truthy result
   * short-circuits to `allow`.
   */
  extraAllowPredicate?: (url: string) => boolean;
  /**
   * Override `shell.openExternal` for tests. Defaults to the real one.
   */
  shellOpenExternal?: (url: string) => void | Promise<void>;
  /**
   * Optional source label for log lines (e.g. `'auth-window:edison'`,
   * `'main-window-tab:t-abc123'`). Helps trace popup origins in
   * the log server.
   */
  source?: string;
}

/**
 * Shape of `setWindowOpenHandler`'s return value. We construct it
 * here instead of importing `WindowOpenHandlerResponse` because
 * that type is part of Electron's internal typings and isn't
 * always re-exported in older Electron releases.
 */
type WindowOpenResponse =
  | { action: 'allow'; overrideBrowserWindowOptions?: Electron.BrowserWindowConstructorOptions }
  | { action: 'deny' };

/**
 * Build a `setWindowOpenHandler` function that:
 *   - Allows OAuth popups (in same partition, sandboxed, no preload)
 *   - Allows extra origins per `extraAllowPredicate`
 *   - Routes everything else to `shell.openExternal`
 *
 * The returned handler is suitable for direct passing to
 * `webContents.setWindowOpenHandler(handler)`.
 *
 * @example
 *   webContents.setWindowOpenHandler(
 *     buildPopupHandler({
 *       partition: tab.partition,
 *       source: `main-window-tab:${tab.id}`,
 *       logger: (level, msg, data) => getLoggingApi()[level]('auth', msg, data),
 *     })
 *   );
 */
export function buildPopupHandler(
  options: BuildPopupHandlerOptions
): (details: HandlerDetails) => WindowOpenResponse {
  const {
    partition,
    logger,
    extraAllowPredicate,
    shellOpenExternal = (url: string): Promise<void> => shell.openExternal(url),
    source,
  } = options;

  return (details: HandlerDetails): WindowOpenResponse => {
    const url = details.url;
    const extraAllow = extraAllowPredicate?.(url) === true;
    const oauthAllow = isOAuthPopupUrl(url);

    if (extraAllow || oauthAllow) {
      const reason = extraAllow ? 'extra-predicate' : 'oauth-allowlist';
      const origin = safeOriginOf(url);
      logger?.('info', 'oauth-popup: allowed in-app child window', {
        url: origin,
        reason,
        ...(source !== undefined ? { source } : {}),
        partition,
      });
      getLoggingApi().event(AUTH_EVENTS.OAUTH_POPUP_ALLOWED, {
        origin,
        reason,
        partition,
        ...(source !== undefined ? { source } : {}),
      });
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 600,
          height: 720,
          autoHideMenuBar: true,
          backgroundColor: '#ffffff',
          webPreferences: {
            partition,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webSecurity: true,
          },
        },
      };
    }

    const deniedOrigin = safeOriginOf(url);
    logger?.('info', 'oauth-popup: routed to OS default browser', {
      url: deniedOrigin,
      ...(source !== undefined ? { source } : {}),
    });
    getLoggingApi().event(AUTH_EVENTS.OAUTH_POPUP_DENIED, {
      origin: deniedOrigin,
      ...(source !== undefined ? { source } : {}),
    });
    void shellOpenExternal(url);
    return { action: 'deny' };
  };
}

/**
 * After a popup is created (via `did-create-window` on the parent),
 * attach lifecycle listeners that auto-close the popup once the
 * OAuth flow completes. Two close triggers:
 *
 *   1. Popup navigates BACK to the parent's origin. This is the
 *      classic "OAuth provider redirects to your callback URL"
 *      pattern. After the popup posts to the opener and / or runs
 *      its `window.close()`, the parent has the auth state; the
 *      popup is just visual chrome.
 *
 *   2. Parent navigates AWAY from its login state (e.g.
 *      `chat.openai.com` lands on `chat.openai.com/c/...`). The
 *      popup is now orphaned visually; close it so the user
 *      isn't left staring at an empty popup.
 *
 * Both triggers are best-effort -- if the popup has already
 * called `window.close()` we no-op.
 *
 * Returns a disposer that detaches all listeners. Callers should
 * invoke it on parent close to avoid leaking listeners across
 * popup lifetimes.
 */
/**
 * After the popup hits the parent's origin (the OAuth callback URL),
 * we give its renderer this many milliseconds to finish post-redirect
 * work before forcing the close. Typical OAuth callbacks need to:
 *   - parse the response and set auth cookies on the parent partition
 *   - `postMessage` the result to `window.opener`
 *   - run `window.close()` themselves
 *
 * Closing too early (the previous behavior, which slammed the popup
 * shut on the first parent-origin nav) cut all three steps short --
 * the parent never received the auth signal and stayed on /login,
 * which the user saw as "Google auth seemed to be working then when
 * it finished just disappeared and the login screen stayed."
 *
 * 5s is comfortably above what real OneReach + Google flows need
 * (typically <500ms) without leaving a stale popup on screen for so
 * long the user worries it broke.
 */
export const POPUP_PARENT_ORIGIN_GRACE_MS = 5000;

export function attachPopupLifecycle(
  parent: BrowserWindow,
  popup: BrowserWindow,
  options: {
    logger?: PopupLogger;
    source?: string;
    /**
     * Override the parent-origin grace window (for tests). Defaults
     * to {@link POPUP_PARENT_ORIGIN_GRACE_MS}.
     */
    parentOriginGraceMs?: number;
  } = {}
): () => void {
  const { logger, source } = options;
  const graceMs = options.parentOriginGraceMs ?? POPUP_PARENT_ORIGIN_GRACE_MS;
  let disposed = false;
  const cleanups: Array<() => void> = [];

  const parentOrigin = safeOriginOfWebContents(parent);

  /**
   * Pending grace timer set by Trigger 1. If Trigger 2 (parent
   * navigated) fires first -- the normal happy-path signal -- we
   * cancel the grace timer and close immediately. If the popup's own
   * `window.close()` fires first, the popup-closed listener clears
   * the timer too.
   */
  let pendingGraceTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelGraceTimer = (): void => {
    if (pendingGraceTimer !== null) {
      clearTimeout(pendingGraceTimer);
      pendingGraceTimer = null;
    }
  };

  const closePopup = (reason: string): void => {
    if (disposed) return;
    cancelGraceTimer();
    if (popup.isDestroyed()) return;
    logger?.('info', 'oauth-popup: auto-closing popup', {
      reason,
      ...(source !== undefined ? { source } : {}),
    });
    getLoggingApi().event(AUTH_EVENTS.OAUTH_POPUP_AUTO_CLOSED, {
      reason,
      ...(source !== undefined ? { source } : {}),
    });
    try {
      popup.close();
    } catch {
      // best-effort; popup may have already closed itself
    }
  };

  // Trigger 1: popup navigates back to parent's origin.
  //
  // Schedule a delayed close instead of closing synchronously. The
  // popup's renderer needs time to set cookies, `postMessage` the
  // opener, and run its own `window.close()`. If any of those
  // happen first (popup destroyed, parent navigates), we cancel
  // this timer; otherwise the timer fires as a safety net so we
  // don't leave a stale popup on screen forever.
  const onPopupNavigated = (_event: Electron.Event, url: string): void => {
    try {
      const popupOrigin = new URL(url).origin;
      if (parentOrigin === null || popupOrigin !== parentOrigin) return;
      if (pendingGraceTimer !== null) return; // already scheduled
      const reachedOrigin = safeOriginOf(url);
      logger?.('info', 'oauth-popup: parent-origin reached, scheduling grace close', {
        url: reachedOrigin,
        graceMs,
        ...(source !== undefined ? { source } : {}),
      });
      getLoggingApi().event(AUTH_EVENTS.OAUTH_POPUP_PARENT_ORIGIN_REACHED, {
        origin: reachedOrigin,
        graceMs,
        ...(source !== undefined ? { source } : {}),
      });
      pendingGraceTimer = setTimeout(() => {
        pendingGraceTimer = null;
        closePopup('popup-returned-to-parent-origin-grace-elapsed');
      }, graceMs);
    } catch {
      // ignore unparseable URLs
    }
  };

  // Trigger 2: parent navigates (post-auth landing page). This is
  // the canonical "auth completed" signal -- the parent's auth
  // window only navigates away from /login when the OneReach
  // session establishes. Closing the popup now is exactly right.
  const onParentNavigated = (): void => {
    closePopup('parent-navigated-post-auth');
  };

  // Trigger 3: popup hard-fails to load (rare, but we shouldn't
  // leave a blank popup on screen)
  const onPopupCrashed = (): void => {
    getLoggingApi().event(AUTH_EVENTS.OAUTH_POPUP_CRASHED, {
      ...(source !== undefined ? { source } : {}),
    });
    closePopup('popup-render-crashed');
  };

  try {
    popup.webContents.on('did-navigate', onPopupNavigated);
    cleanups.push(() => {
      try {
        popup.webContents.off('did-navigate', onPopupNavigated);
      } catch {
        /* best-effort */
      }
    });
  } catch {
    /* popup may already be destroyed */
  }

  try {
    parent.webContents.on('did-navigate', onParentNavigated);
    cleanups.push(() => {
      try {
        parent.webContents.off('did-navigate', onParentNavigated);
      } catch {
        /* best-effort */
      }
    });
  } catch {
    /* parent may already be destroyed */
  }

  try {
    popup.webContents.on('render-process-gone', onPopupCrashed);
    cleanups.push(() => {
      try {
        popup.webContents.off('render-process-gone', onPopupCrashed);
      } catch {
        /* best-effort */
      }
    });
  } catch {
    /* best-effort */
  }

  // Auto-dispose when the popup is closed by the user / OAuth
  // provider. The grace timer (if any) gets cancelled here so a
  // popup that closes itself before the grace window doesn't leave
  // a dangling close call that fires against a destroyed BrowserWindow.
  popup.once('closed', () => {
    disposed = true;
    cancelGraceTimer();
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        /* best-effort */
      }
    }
  });

  return (): void => {
    disposed = true;
    cancelGraceTimer();
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        /* best-effort */
      }
    }
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────

function safeOriginOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '<unparseable>';
  }
}

function safeOriginOfWebContents(win: BrowserWindow): string | null {
  if (win.isDestroyed()) return null;
  try {
    const url = win.webContents.getURL();
    if (typeof url !== 'string' || url.length === 0) return null;
    return new URL(url).origin;
  } catch {
    return null;
  }
}
