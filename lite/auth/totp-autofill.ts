/**
 * Auth-window TOTP auto-fill.
 *
 * Per ADR-034, Lite owns only the 2FA-code step inside the auth popup:
 * the user still types email/password and selects their account, but
 * when OneReach shows the TOTP page, Lite generates the current code
 * from `lite/totp/` and fills/submits it.
 *
 * Borrowed patterns:
 *   - `lib/auth-scripts.js` -- reused directly (allowed shared `lib/`)
 *     for React-compatible TOTP input fill, submit-button click, and the
 *     MutationObserver-based form wait used to handle SPA timing.
 *   - `lib/gsx-autologin.js:589-598` -- studied for the
 *     `waitForAuthForm` (MutationObserver) shape; not imported.
 *   - `lib/gsx-autologin.js:716-1052` -- studied for fresh-code timing
 *     and retry behavior; not imported.
 *
 * Detection model:
 *   - For every OneReach frame that loads in the auth window OR in any
 *     popup the auth window opens (e.g. `auth.edison.onereach.ai`
 *     opened via `window.open`), inject the full app's
 *     `buildWaitForAuthFormScript` -- a Promise-returning script that
 *     installs a MutationObserver and resolves only when the email,
 *     password, or TOTP input actually appears in the DOM. This
 *     replaces a single one-shot `document.querySelector` that ran
 *     before the OneReach SPA had rendered the form.
 *
 * Security:
 *   - NEVER log the six-digit code.
 *   - NEVER log the TOTP secret (this module never sees it; TotpApi
 *     returns only the generated code).
 *   - No preload is injected into the auth window or any popup.
 *
 * @internal -- started/stopped by `AuthStore` during signIn().
 */

import type { BrowserWindow, WebContents, WebFrameMain } from 'electron';
import * as path from 'node:path';
import { getTotpApi } from '../totp/api.js';
import { TOTP_ERROR_CODES, TotpError } from '../totp/errors.js';
import type { AuthWindowHandle } from './window.js';

/** Hard cap on fill+submit attempts across the entire sign-in. */
const MAX_ATTEMPTS = 3;
/** Below this many seconds remaining, wait for the next 30s window. */
const FRESH_CODE_THRESHOLD_SECONDS = 8;
/**
 * Per-frame MutationObserver wait budget.
 *
 * OneReach login is an SPA: the user can sit on email/password for a
 * while, then the same frame swaps into the 2FA prompt without a full
 * navigation. Keep the watcher armed for the sign-in window instead of
 * timing out after the initial login form render.
 */
const FORM_WAIT_TIMEOUT_MS = 5 * 60_000;

interface AuthScriptsLike {
  /**
   * Promise-returning script: resolves when the email, password, or
   * TOTP input appears (via MutationObserver) or after the timeout.
   * Result shape: `{ is2FAPage?: boolean; isLoginPage?: boolean; reason?: string; inputCount?: number }`.
   */
  buildWaitForAuthFormScript(timeoutMs?: number): string;
  /**
   * Optional Promise-returning script that waits specifically for the
   * TOTP/2FA form. If absent, this module falls back to its local
   * TOTP-only wait script so login-form detection never ends the watch
   * before the OneReach SPA swaps to 2FA.
   */
  buildWaitFor2FAFormScript?(timeoutMs?: number): string;
  buildFillTOTPScript(code: string, opts?: { autoSubmit?: boolean; submitDelay?: number }): string;
  buildSubmitButtonScript(fallbackTexts?: string[]): string;
  /**
   * Optional account-picker auto-selector. When present, the watcher
   * uses this on `/multi-user/list-users` (and similar pages) to skip
   * the picker by clicking the row matching the IDW URL's accountId.
   */
  buildSelectAccountScript?(targetAccountId: string): string;
}

interface StartOptions {
  logger?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /** Human-readable watcher source for diagnostics. */
  source?: string;
  /** Test seam: override full-app shared script builders. */
  authScripts?: AuthScriptsLike;
  /** Test seam: override TOTP code provider. */
  getCurrentCode?: () => Promise<{ code: string; timeRemaining: number }>;
  /**
   * Called once per detected 2FA frame before fill/submit. Used by the
   * main-window tab watcher to open Settings -> Two-Factor as the
   * visible fallback while keeping the tab itself preload-free.
   */
  onTwoFactorDetected?: (payload: TwoFactorDetectedPayload) => void;
  /**
   * Optional resolver for the account id to auto-select on the
   * OneReach account-picker page. Typically derived from the IDW URL
   * (`?accountId=<uuid>`) by the caller. Returning `null` disables
   * auto-select for that scan -- the user picks manually.
   */
  getTargetAccountId?: () => string | null;
  /**
   * Called once per detected account-picker frame, BEFORE the
   * auto-select script runs. Used for diagnostics. The watcher still
   * executes the auto-select either way.
   */
  onAccountPickerDetected?: (payload: AccountPickerDetectedPayload) => void;
}

interface RuntimeState {
  disposed: boolean;
  attempts: number;
  /** Frame keys (`processId:routingId`) currently waiting/filling. */
  inFlight: Set<string>;
  /** Frame keys that already emitted `onTwoFactorDetected`. */
  detectedFrames: Set<string>;
  /** Frame keys that already attempted account-picker auto-select. */
  accountPickerHandled: Set<string>;
  /** Per-window event-listener disposers (auth window + every popup). */
  cleanups: Array<() => void>;
}

export interface TwoFactorDetectedPayload {
  source: string;
  frameUrl: string;
  reason?: string;
  inputCount?: number;
}

export interface AccountPickerDetectedPayload {
  source: string;
  frameUrl: string;
  targetAccountId: string;
}

interface WatchTarget {
  source: string;
  webContents: WebContents;
  isDestroyed: () => boolean;
  currentUrl: () => string;
}

interface AuthFormProbe {
  is2FAPage?: boolean;
  isLoginPage?: boolean;
  reason?: string;
  inputCount?: number;
}

/**
 * Start watching the auth window (and any popup it opens) for the
 * OneReach 2FA page. Returns a disposer that detaches every listener
 * the watcher installed.
 */
export function startTotpAutofill(handle: AuthWindowHandle, opts: StartOptions = {}): () => void {
  const win = handle._window;
  if (win === undefined || win.isDestroyed()) {
    opts.logger?.('info', 'auth-totp-autofill: no BrowserWindow handle; disabled');
    return () => undefined;
  }

  const state = createRuntimeState();
  const source = opts.source ?? 'auth-window';
  const authScripts = opts.authScripts ?? loadAuthScripts();
  const getCurrentCode =
    opts.getCurrentCode ?? (async () => getTotpApi().getCurrentCode());

  opts.logger?.('info', 'auth-totp-autofill: started watching auth window', {
    source,
    partition: handle.partition,
    initialUrl: safeWindowUrl(win),
  });

  attachToTarget(
    targetFromWindow(win, source),
    state,
    authScripts,
    getCurrentCode,
    opts.logger,
    opts.onTwoFactorDetected,
    opts.getTargetAccountId,
    opts.onAccountPickerDetected
  );

  return () => disposeRuntimeState(state);
}

/**
 * Start watching arbitrary Electron webContents for OneReach 2FA forms.
 * Used by main-window WebContentsView tabs, which intentionally have no
 * preload bridge. The caller owns the webContents lifecycle and must
 * call the returned disposer when the tab is removed.
 */
export function startTotpAutofillForWebContents(
  webContents: WebContents,
  opts: StartOptions = {}
): () => void {
  const state = createRuntimeState();
  const source = opts.source ?? 'webcontents';
  const authScripts = opts.authScripts ?? loadAuthScripts();
  const getCurrentCode = opts.getCurrentCode ?? (async () => getTotpApi().getCurrentCode());

  opts.logger?.('info', 'auth-totp-autofill: started watching webContents', {
    source,
    initialUrl: safeWebContentsUrl(webContents),
  });

  attachToTarget(
    {
      source,
      webContents,
      isDestroyed: () => isWebContentsDestroyed(webContents),
      currentUrl: () => safeWebContentsUrl(webContents),
    },
    state,
    authScripts,
    getCurrentCode,
    opts.logger,
    opts.onTwoFactorDetected,
    opts.getTargetAccountId,
    opts.onAccountPickerDetected
  );

  return () => disposeRuntimeState(state);
}

/**
 * Wire scan triggers + popup tracking on a single BrowserWindow. Called
 * once for the auth window and again for each popup it opens.
 */
function createRuntimeState(): RuntimeState {
  return {
    disposed: false,
    attempts: 0,
    inFlight: new Set(),
    detectedFrames: new Set(),
    accountPickerHandled: new Set(),
    cleanups: [],
  };
}

function disposeRuntimeState(state: RuntimeState): void {
  if (state.disposed) return;
  state.disposed = true;
  for (const cleanup of state.cleanups) {
    try {
      cleanup();
    } catch {
      // best-effort cleanup during window teardown
    }
  }
  state.cleanups.length = 0;
}

function attachToTarget(
  target: WatchTarget,
  state: RuntimeState,
  authScripts: AuthScriptsLike,
  getCurrentCode: () => Promise<{ code: string; timeRemaining: number }>,
  logger: StartOptions['logger'],
  onTwoFactorDetected: StartOptions['onTwoFactorDetected'],
  getTargetAccountId: StartOptions['getTargetAccountId'],
  onAccountPickerDetected: StartOptions['onAccountPickerDetected']
): void {
  if (target.isDestroyed()) return;

  const scan = (source: string): void => {
    if (state.disposed || target.isDestroyed()) return;
    // Note: MAX_ATTEMPTS gates 2FA fills, NOT account-picker scans.
    // We still want to try auto-selecting the account even after the
    // 2FA attempts are exhausted (e.g. user reached the picker by
    // some other path, or 2FA already succeeded).

    const wc = target.webContents;
    let frames: WebFrameMain[];
    try {
      frames = [wc.mainFrame, ...wc.mainFrame.framesInSubtree];
    } catch (err) {
      logger?.('info', 'auth-totp-autofill: frame walk failed', {
        source,
        error: (err as Error).message,
      });
      return;
    }

    logger?.('info', 'auth-totp-autofill: scan', {
      source,
      target: target.source,
      mainFrameUrl: target.currentUrl(),
      frameCount: frames.length,
    });

    let candidateCount = 0;
    for (const frame of frames) {
      const frameUrl = safeFrameUrl(frame);
      if (!isOneReachFrame(frameUrl)) {
        logger?.('info', 'auth-totp-autofill: skip non-onereach frame', { frameUrl });
        continue;
      }
      candidateCount += 1;
      if (state.attempts < MAX_ATTEMPTS) {
        void awaitFormThenFill(
          frame,
          target,
          authScripts,
          getCurrentCode,
          state,
          logger,
          onTwoFactorDetected
        );
      }
      if (isAccountPickerUrl(frameUrl) && getTargetAccountId !== undefined) {
        void awaitAccountPickerThenSelect(
          frame,
          target,
          authScripts,
          getTargetAccountId,
          state,
          logger,
          onAccountPickerDetected
        );
      }
    }
    if (candidateCount === 0) {
      logger?.('info', 'auth-totp-autofill: no onereach frame in tree', { source });
    }
  };

  const onDidNavigate = (): void => scan('did-navigate');
  const onDidNavigateInPage = (): void => scan('did-navigate-in-page');
  const onDidFinishLoad = (): void => scan('did-finish-load');
  const onDidFrameFinishLoad = (): void => scan('did-frame-finish-load');

  const onDidCreateWindow = (newWin: BrowserWindow): void => {
    if (state.disposed) return;
    logger?.('info', 'auth-totp-autofill: tracking popup window', {
      source: target.source,
      url: safeWindowUrl(newWin),
    });
    attachToTarget(
      targetFromWindow(newWin, `${target.source}:popup`),
      state,
      authScripts,
      getCurrentCode,
      logger,
      onTwoFactorDetected,
      getTargetAccountId,
      onAccountPickerDetected
    );
  };

  target.webContents.on('did-navigate', onDidNavigate);
  target.webContents.on('did-navigate-in-page', onDidNavigateInPage);
  target.webContents.on('did-finish-load', onDidFinishLoad);
  target.webContents.on('did-frame-finish-load', onDidFrameFinishLoad);
  target.webContents.on('did-create-window', onDidCreateWindow);

  state.cleanups.push((): void => {
    if (target.isDestroyed()) return;
    try {
      target.webContents.off('did-navigate', onDidNavigate);
    } catch {
      /* best-effort */
    }
    try {
      target.webContents.off('did-navigate-in-page', onDidNavigateInPage);
    } catch {
      /* best-effort */
    }
    try {
      target.webContents.off('did-finish-load', onDidFinishLoad);
    } catch {
      /* best-effort */
    }
    try {
      target.webContents.off('did-frame-finish-load', onDidFrameFinishLoad);
    } catch {
      /* best-effort */
    }
    try {
      target.webContents.off('did-create-window', onDidCreateWindow);
    } catch {
      /* best-effort */
    }
  });

  // Initial kick in case the page is already on a 2FA URL by the time
  // we attach (the auth window starts loading before this function runs).
  scan('start');
}

/**
 * For one OneReach frame: wait (MutationObserver) until the form
 * renders, and if it's the 2FA page, fill + submit the current TOTP
 * code. De-duped per (processId, routingId) so multiple Electron
 * navigation events don't start parallel waits on the same frame.
 */
async function awaitFormThenFill(
  frame: WebFrameMain,
  target: WatchTarget,
  authScripts: AuthScriptsLike,
  getCurrentCode: () => Promise<{ code: string; timeRemaining: number }>,
  state: RuntimeState,
  logger: StartOptions['logger'],
  onTwoFactorDetected: StartOptions['onTwoFactorDetected']
): Promise<void> {
  if (state.disposed || state.attempts >= MAX_ATTEMPTS) return;
  if (target.isDestroyed() || frame.detached) return;

  const key = frameKey(frame);
  if (state.inFlight.has(key)) return;
  state.inFlight.add(key);

  try {
    const frameUrl = safeFrameUrl(frame);

    let probe: AuthFormProbe;
    try {
      logger?.('info', 'auth-totp-autofill: waiting for auth form', { frameUrl });
      probe = (await frame.executeJavaScript(
        buildWaitFor2FAOnlyScript(authScripts, FORM_WAIT_TIMEOUT_MS)
      )) as AuthFormProbe;
    } catch (err) {
      // Frames can navigate or be torn down mid-wait. That's fine --
      // the next Electron event will trigger a fresh scan.
      logger?.('info', 'auth-totp-autofill: form wait threw', {
        frameUrl,
        error: (err as Error).message,
      });
      return;
    }

    if (state.disposed || target.isDestroyed() || frame.detached) return;

    logger?.('info', 'auth-totp-autofill: form wait resolved', {
      source: target.source,
      frameUrl,
      is2FAPage: probe.is2FAPage === true,
      isLoginPage: probe.isLoginPage === true,
      ...(probe.reason !== undefined ? { reason: probe.reason } : {}),
      ...(probe.inputCount !== undefined ? { inputCount: probe.inputCount } : {}),
    });

    if (probe.is2FAPage !== true) return;
    notifyTwoFactorDetected(target.source, frameUrl, probe, key, state, logger, onTwoFactorDetected);
    if (state.attempts >= MAX_ATTEMPTS) return;

    state.attempts += 1;

    let codeInfo: { code: string; timeRemaining: number };
    try {
      codeInfo = await getCurrentCode();
    } catch (err) {
      if (err instanceof TotpError && err.code === TOTP_ERROR_CODES.NO_SECRET) {
        logger?.(
          'info',
          'auth-totp-autofill: skipped because no TOTP secret is configured',
          { frameUrl }
        );
        return;
      }
      logger?.('warn', 'auth-totp-autofill: getCurrentCode failed', {
        frameUrl,
        error: (err as Error).message,
      });
      return;
    }

    if (codeInfo.timeRemaining < FRESH_CODE_THRESHOLD_SECONDS) {
      const waitMs = (codeInfo.timeRemaining + 1) * 1000;
      logger?.('info', 'auth-totp-autofill: waiting for fresh code window', {
        source: target.source,
        frameUrl,
        timeRemaining: codeInfo.timeRemaining,
        waitMs,
      });
      await sleep(waitMs);
      if (state.disposed || target.isDestroyed() || frame.detached) return;
      try {
        codeInfo = await getCurrentCode();
      } catch (err) {
        logger?.('warn', 'auth-totp-autofill: getCurrentCode failed after fresh-code wait', {
          frameUrl,
          error: (err as Error).message,
        });
        return;
      }
    }

    let fillResult: { success?: boolean; verified?: boolean; reason?: string };
    try {
      fillResult = (await frame.executeJavaScript(
        authScripts.buildFillTOTPScript(codeInfo.code, { autoSubmit: false })
      )) as { success?: boolean; verified?: boolean; reason?: string };
    } catch (err) {
      logger?.('warn', 'auth-totp-autofill: fill threw', {
        frameUrl,
        attempt: state.attempts,
        error: (err as Error).message,
      });
      return;
    }

    if (fillResult.success !== true) {
      logger?.('warn', 'auth-totp-autofill: fill failed', {
        frameUrl,
        attempt: state.attempts,
        reason: fillResult.reason,
      });
      return;
    }

    let submitResult: { clicked?: boolean; reason?: string; method?: string };
    try {
      submitResult = (await frame.executeJavaScript(
        authScripts.buildSubmitButtonScript(['verify', 'submit', 'continue', 'confirm'])
      )) as { clicked?: boolean; reason?: string; method?: string };
    } catch (err) {
      logger?.('warn', 'auth-totp-autofill: submit threw', {
        frameUrl,
        attempt: state.attempts,
        error: (err as Error).message,
      });
      return;
    }

    logger?.('info', 'auth-totp-autofill: filled and submitted 2FA code', {
      source: target.source,
      frameUrl,
      attempt: state.attempts,
      verified: fillResult.verified === true,
      submitClicked: submitResult.clicked === true,
      ...(submitResult.method !== undefined ? { submitMethod: submitResult.method } : {}),
      ...(submitResult.reason !== undefined ? { submitReason: submitResult.reason } : {}),
      // code intentionally omitted
    });
  } finally {
    state.inFlight.delete(key);
  }
}

/**
 * For one OneReach frame on the account-picker page: wait for account
 * rows to render, then click the row matching `getTargetAccountId()`.
 * Per-frame de-duped via `state.accountPickerHandled` so navigations
 * inside the picker don't retrigger the script.
 */
async function awaitAccountPickerThenSelect(
  frame: WebFrameMain,
  target: WatchTarget,
  authScripts: AuthScriptsLike,
  getTargetAccountId: () => string | null,
  state: RuntimeState,
  logger: StartOptions['logger'],
  onAccountPickerDetected: StartOptions['onAccountPickerDetected']
): Promise<void> {
  if (state.disposed) return;
  if (target.isDestroyed() || frame.detached) return;

  const key = frameKey(frame);
  if (state.accountPickerHandled.has(key)) return;

  let targetAccountId: string | null;
  try {
    targetAccountId = getTargetAccountId();
  } catch (err) {
    logger?.('warn', 'auth-totp-autofill: getTargetAccountId threw', {
      source: target.source,
      error: (err as Error).message,
    });
    return;
  }
  if (typeof targetAccountId !== 'string' || targetAccountId.length === 0) {
    logger?.('info', 'auth-totp-autofill: account picker reached but no targetAccountId; skipping auto-select', {
      source: target.source,
      frameUrl: safeFrameUrl(frame),
    });
    return;
  }

  // Mark handled BEFORE running the script so we don't double-click on
  // a fast navigation. If the auto-select fails the user can still
  // click manually.
  state.accountPickerHandled.add(key);
  const frameUrl = safeFrameUrl(frame);

  logger?.('info', 'auth-totp-autofill: account picker detected', {
    source: target.source,
    frameUrl,
  });
  if (onAccountPickerDetected !== undefined) {
    try {
      onAccountPickerDetected({ source: target.source, frameUrl, targetAccountId });
    } catch (err) {
      logger?.('warn', 'auth-totp-autofill: onAccountPickerDetected callback threw', {
        source: target.source,
        frameUrl,
        error: (err as Error).message,
      });
    }
  }

  // 1. Wait for the matching row to render (MutationObserver-backed,
  //    short timeout because the picker page renders fast).
  try {
    const wait = (await frame.executeJavaScript(
      buildWaitForAccountPickerScript(targetAccountId, 8_000)
    )) as { found?: boolean; reason?: string; type?: string };
    if (wait.found !== true) {
      logger?.('warn', 'auth-totp-autofill: account picker wait did not find target', {
        source: target.source,
        frameUrl,
        reason: wait.reason,
      });
      return;
    }
  } catch (err) {
    logger?.('info', 'auth-totp-autofill: account picker wait threw', {
      source: target.source,
      frameUrl,
      error: (err as Error).message,
    });
    return;
  }

  if (state.disposed || target.isDestroyed() || frame.detached) return;

  // 2. Click the matching row.
  const buildSelect = authScripts.buildSelectAccountScript;
  if (typeof buildSelect !== 'function') {
    logger?.('warn', 'auth-totp-autofill: no buildSelectAccountScript available; cannot auto-select', {
      source: target.source,
      frameUrl,
    });
    return;
  }
  try {
    const result = (await frame.executeJavaScript(buildSelect(targetAccountId))) as {
      success?: boolean;
      method?: string;
      reason?: string;
    };
    if (result.success === true) {
      logger?.('info', 'auth-totp-autofill: account auto-selected', {
        source: target.source,
        frameUrl,
        ...(result.method !== undefined ? { method: result.method } : {}),
      });
    } else {
      logger?.('warn', 'auth-totp-autofill: account auto-select failed', {
        source: target.source,
        frameUrl,
        reason: result.reason,
      });
    }
  } catch (err) {
    logger?.('warn', 'auth-totp-autofill: account auto-select threw', {
      source: target.source,
      frameUrl,
      error: (err as Error).message,
    });
  }
}

function notifyTwoFactorDetected(
  source: string,
  frameUrl: string,
  probe: AuthFormProbe,
  frameIdentity: string,
  state: RuntimeState,
  logger: StartOptions['logger'],
  onTwoFactorDetected: StartOptions['onTwoFactorDetected']
): void {
  const key = `${source}:${frameIdentity}`;
  if (state.detectedFrames.has(key)) return;
  state.detectedFrames.add(key);

  logger?.('info', 'auth-totp-autofill: 2FA form detected', {
    source,
    frameUrl,
    ...(probe.reason !== undefined ? { reason: probe.reason } : {}),
    ...(probe.inputCount !== undefined ? { inputCount: probe.inputCount } : {}),
  });

  if (onTwoFactorDetected === undefined) return;
  try {
    onTwoFactorDetected({
      source,
      frameUrl,
      ...(probe.reason !== undefined ? { reason: probe.reason } : {}),
      ...(probe.inputCount !== undefined ? { inputCount: probe.inputCount } : {}),
    });
  } catch (err) {
    logger?.('warn', 'auth-totp-autofill: onTwoFactorDetected callback threw', {
      source,
      frameUrl,
      error: (err as Error).message,
    });
  }
}

function frameKey(frame: WebFrameMain): string {
  try {
    return `${frame.processId}:${frame.routingId}`;
  } catch {
    return safeFrameUrl(frame);
  }
}

function safeFrameUrl(frame: WebFrameMain): string {
  try {
    return frame.url;
  } catch {
    return '';
  }
}

function safeWindowUrl(win: BrowserWindow): string {
  try {
    if (win.isDestroyed()) return '';
    return win.webContents.getURL();
  } catch {
    return '';
  }
}

function safeWebContentsUrl(webContents: WebContents): string {
  try {
    if (isWebContentsDestroyed(webContents)) return '';
    return webContents.getURL();
  } catch {
    return '';
  }
}

function isWebContentsDestroyed(webContents: WebContents): boolean {
  try {
    return webContents.isDestroyed();
  } catch {
    return true;
  }
}

function targetFromWindow(win: BrowserWindow, source: string): WatchTarget {
  return {
    source,
    webContents: win.webContents,
    isDestroyed: () => win.isDestroyed(),
    currentUrl: () => safeWindowUrl(win),
  };
}

function isOneReachFrame(url: string): boolean {
  if (url.length === 0 || url === 'about:blank') return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'onereach.ai' || host.endsWith('.onereach.ai');
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isAccountPickerUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!isOneReachFrame(u.toString())) return false;
  const path = u.pathname.toLowerCase();
  return (
    path.startsWith('/multi-user/list-users') ||
    path.startsWith('/multi-user/select') ||
    path.startsWith('/account-select') ||
    path.startsWith('/select-account') ||
    path.startsWith('/accounts')
  );
}

function buildWaitForAccountPickerScript(targetAccountId: string, timeoutMs: number): string {
  const targetJson = JSON.stringify(targetAccountId);
  return `
    new Promise(function(resolve) {
      var TARGET = ${targetJson};
      function check() {
        if (!TARGET) return null;
        var anchors = document.querySelectorAll('a[href*="accountId"], a[href*="' + TARGET + '"]');
        for (var i = 0; i < anchors.length; i++) {
          var href = anchors[i].href || '';
          if (href.indexOf(TARGET) >= 0) return { found: true, type: 'link' };
        }
        var dataEls = document.querySelectorAll('[data-account-id], [data-id], [data-account]');
        for (var j = 0; j < dataEls.length; j++) {
          var d = dataEls[j].dataset || {};
          if ((d.accountId || d.id || d.account) === TARGET) return { found: true, type: 'data' };
        }
        var bodyHtml = (document.body && document.body.innerHTML) || '';
        if (bodyHtml.indexOf(TARGET) >= 0) return { found: true, type: 'body' };
        return null;
      }
      var existing = check();
      if (existing) return resolve(existing);
      var observer = new MutationObserver(function() {
        var result = check();
        if (result) { observer.disconnect(); clearTimeout(timer); resolve(result); }
      });
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['href', 'data-account-id', 'data-id', 'data-account', 'class', 'hidden']
      });
      var timer = setTimeout(function() {
        observer.disconnect();
        resolve({ found: false, reason: 'observer_timeout' });
      }, ${timeoutMs});
    })`;
}

function buildWaitFor2FAOnlyScript(authScripts: AuthScriptsLike, timeoutMs: number): string {
  if (typeof authScripts.buildWaitFor2FAFormScript === 'function') {
    return authScripts.buildWaitFor2FAFormScript(timeoutMs);
  }
  return `
    new Promise(function(resolve) {
      var TOTP_SEL = 'input[name="totp"], input[name="code"], input[name="otp"], input[name="verificationCode"], input[name="twoFactorCode"], input[autocomplete="one-time-code"], input[inputmode="numeric"][maxlength="6"], input[maxlength="6"]:not([type="password"]):not([name*="email"]):not([name*="user"]), input[placeholder*="code" i], input[placeholder*="2fa" i], input[placeholder*="authenticator" i], input[type="text"][maxlength="6"], input[type="number"][maxlength="6"]';
      var TWO_FA_HINTS = ['two-factor', '2fa', 'verification code', 'authenticator', 'enter the code', '6-digit', 'security code', 'authentication code'];
      function check() {
        var totpInput = document.querySelector(TOTP_SEL);
        if (totpInput) return { is2FAPage: true, reason: 'totp_input_found' };
        var pageText = document.body ? document.body.innerText.toLowerCase() : '';
        var has2FAText = TWO_FA_HINTS.some(function(h) { return pageText.indexOf(h) >= 0; });
        var passwordField = document.querySelector('input[type="password"]');
        if (has2FAText && !passwordField) return { is2FAPage: true, reason: '2fa_text_found' };
        if (has2FAText) {
          var allInputs = document.querySelectorAll('input:not([type="hidden"]):not([type="password"])');
          var shortInputs = Array.from(allInputs).filter(function(inp) {
            var rect = inp.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && inp.maxLength > 0 && inp.maxLength <= 8;
          });
          if (shortInputs.length === 1) return { is2FAPage: true, reason: 'heuristic_single_short_input', inputCount: allInputs.length };
        }
        return null;
      }
      var existing = check();
      if (existing) return resolve(existing);
      var observer = new MutationObserver(function() {
        var result = check();
        if (result) { observer.disconnect(); clearTimeout(timer); resolve(result); }
      });
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden']
      });
      var timer = setTimeout(function() {
        observer.disconnect();
        var allInputs = document.querySelectorAll('input:not([type="hidden"])');
        resolve({ isLoginPage: false, is2FAPage: false, reason: 'observer_timeout', inputCount: allInputs.length });
      }, ${timeoutMs});
    })`;
}

function loadAuthScripts(): AuthScriptsLike {
  // Runtime location is dist-lite/build/main-lite.js; repo-root lib/
  // sits two levels up. Dynamic require keeps esbuild from bundling the
  // CommonJS helper file and respects the allowed lite -> lib boundary.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { join, resolve } = require('node:path') as typeof path;
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  return require(join(resolve(__dirname, '..', '..', 'lib'), 'auth-scripts')) as AuthScriptsLike;
}
