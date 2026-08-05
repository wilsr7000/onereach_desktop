/**
 * Main window factory + tab orchestration.
 *
 * Single `BrowserWindow` whose main webContents loads `chrome.html`
 * (the tab bar UI + home view). Below the 36px tab bar, each open
 * tab is a `WebContentsView` added as a child of the window's
 * `contentView`. The active tab's view fills the content area; all
 * others are hidden via `setVisible(false)` (warm render state, no
 * reload on switch).
 *
 * Per ADR-038:
 *  - IDW tabs get a STABLE `persist:idw-<idwId>` partition (keyed by
 *    the IDW so the saved login persists across close/reopen); ad-hoc
 *    non-IDW tabs get an ephemeral `persist:tab-<short-uuid>` partition.
 *    Both keep IDWs isolated from each other (ADR-038).
 *  - Tab views have NO preload -- third-party agents cannot reach
 *    `window.lite.*`. The chrome (separate webContents) DOES use the
 *    standard kernel preload.
 *  - `setWindowOpenHandler` denies child Electron windows; external
 *    links route to the OS default browser via `shell.openExternal`.
 *
 * @internal -- consumers go through `getMainWindowApi()` for state
 *  ops; the factory itself is invoked by `lite/main-window/main.ts`
 *  during boot.
 */

import {
  BrowserWindow,
  WebContentsView,
  session as electronSession,
  Notification,
} from 'electron';
import type { Rectangle } from 'electron';
import { getLoggingApi } from '../logging/api.js';
import { getMainWindowApi } from './api.js';
import { getAuthApi, getEnvironmentForUrl } from '../auth/api.js';
import { isOneReachSsoSkipUrl, tryAutoSkipSso } from '../auth/sso-skip.js';
import { startTotpAutofillForWebContents } from '../auth/totp-autofill.js';
import { buildPopupHandler } from '../auth/oauth-popup.js';
import {
  startLoginVerifier,
  makeWebContentsProbe,
  isOneReachAuthOrLoginUrl,
} from '../auth/login-verifier.js';
import { getReSignInPrompter } from '../auth/re-signin-prompt.js';

/**
 * Renderer channel the chrome listens on to show a "couldn't finish
 * signing in" banner. Literal (not a MAIN_WINDOW_IPC import) to keep
 * window.ts free of a main.ts↔window.ts cycle; the preload references
 * the same string. Lives in the auth namespace alongside
 * `lite:auth:2fa-needs-setup`.
 */
const IDW_LOGIN_STUCK_CHANNEL = 'lite:auth:idw-login-stuck';
import type { Tab } from './types.js';
import { CHROME_HEIGHT_PX } from './types.js';
import { MAIN_WINDOW_EVENTS } from './events.js';

interface CreateMainWindowConfig {
  /** Path to the chrome HTML file (built bundle). */
  chromeHtmlPath: string;
  /** Path to the kernel preload (the chrome uses this; tab views do NOT). */
  preloadPath: string;
}

interface AttachedTab {
  id: string;
  view: WebContentsView;
  /** Tracks the tab object we mounted; used to detect navigation churn. */
  lastUrl: string;
  /**
   * Electron partition string the view's session is bound to. Stashed
   * here so the session-change listener can re-inject cookies into the
   * right partition without rummaging through the store. Set at attach
   * time from the Tab record.
   */
  partition: string;
  /** Set on first navigation after creation -- guards against the load-time race. */
  initialLoadStarted: boolean;
  /** Detaches the main-process 2FA detector from this tab's webContents. */
  stopTotpAutofill: () => void;
  /** Stops the per-tab login-outcome verifier (no-op for non-OneReach tabs). */
  stopLoginVerifier: () => void;
}

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const MIN_WIDTH = 720;
const MIN_HEIGHT = 480;
const BACKGROUND = '#0e0e10';

/**
 * The IDW Feed shown as the Home-tab CONTENT (deployed to Edison). The
 * chrome shell — the 36px tab bar with the Spaces button, the Home pill,
 * and open IDW tab pills — is ALWAYS present. The feed is mounted as a
 * WebContentsView that fills the content area BELOW the tab bar and is
 * visible only while the Home pill is active. Opening an IDW tab hides
 * the feed (the tab covers the same region); closing all tabs returns to
 * the feed. If the feed URL fails to load, the view is hidden and the
 * bundled boot-chat home view shows through underneath, so the window is
 * never blank.
 *
 * Set env `LITE_HOME=chrome` to disable the feed entirely and use the
 * original boot-chat home view as the Home-tab content.
 */
const IDW_HOME_URL: string | null =
  process.env.LITE_HOME === 'chrome'
    ? null
    : 'https://files.edison.api.onereach.ai/public/35254342-4a2e-475b-aec1-18547e517e29/idw-feed/index.html';

/** Partition for the home feed — shares the IDW browser's signed-in session. */
const HOME_FEED_PARTITION = 'persist:lite-idw-browser';

let mainWindow: BrowserWindow | null = null;
let unsubscribeStore: (() => void) | null = null;
/**
 * Unsubscribe handle for the auth session-change listener. We attach
 * one listener for the whole window so that whenever the user signs
 * into an env (via the home-view boot-chat OR the chrome "Sign in to
 * OneReach" button OR the IDW-tab auto-trigger), every already-open
 * tab that's stuck on a OneReach login interstitial gets refreshed
 * cookies and a reload. Closes the loop: sign in once → all your
 * IDW tabs auto-login on the next paint.
 */
let unsubscribeAuth: (() => void) | null = null;
const attachedTabs = new Map<string, AttachedTab>();
let activeAttachedTabId: string | null = null;

/**
 * The IDW home feed view (default Home-tab content). Mounted once per
 * window at ready-to-show when IDW_HOME_URL is set; null in
 * `LITE_HOME=chrome` mode and before the window is shown. Owned by the
 * BrowserWindow — destroyed when the window closes.
 */
let homeFeedView: WebContentsView | null = null;

/**
 * Create (or focus) the main window. Idempotent: subsequent calls
 * focus the existing window. The window subscribes to the tab store
 * and reconciles its WebContentsViews with store state on every change.
 *
 * The store is read once on creation to rehydrate previously-open
 * tabs (per-tab partition strings make the agents log back in
 * automatically). After that, subscriptions drive the view set.
 */
export function createMainWindow(config: CreateMainWindowConfig): BrowserWindow {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return mainWindow;
  }

  const win = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: 'Onereach.ai Lite',
    backgroundColor: BACKGROUND,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: config.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  // The chrome (tab bar + home view) lives in the BrowserWindow's main
  // webContents — ALWAYS loaded, so the Spaces button and tab bar are
  // always present. The boot-chat home surface lives inside chrome.html;
  // tab views (and, by default, the IDW home feed) are added on TOP via
  // contentView.addChildView and cover the home-view region BELOW the
  // 36px tab bar — never the tab bar itself.
  void win.loadFile(config.chromeHtmlPath);

  win.once('ready-to-show', () => {
    if (mainWindow === null || mainWindow.isDestroyed()) return;
    win.show();
    // Mount the IDW home feed (default) as the Home-tab content, then
    // reconcile + rehydrate any persisted tabs. The feed sits below the
    // tab bar and reconcileViews shows it only while Home is active.
    if (IDW_HOME_URL !== null) {
      attachHomeFeed(win);
    }
    void rehydrateFromStore(win);
  });

  win.on('resize', () => {
    if (win.isDestroyed()) return;
    repositionActiveTab(win);
  });

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
    teardownStoreSubscription();
    stopAllAttachedTabWatchers();
    // WebContentsViews are owned by the BrowserWindow; closing the
    // window destroys them. Clear our refs.
    attachedTabs.clear();
    activeAttachedTabId = null;
    homeFeedView = null;
  });

  // Subscribe to store changes -- mounts/unmounts tab views in
  // response to openTab/closeTab/activateTab.
  const api = getMainWindowApi();
  unsubscribeStore = api.onTabsChanged((tabs, activeId) => {
    if (mainWindow === null || mainWindow.isDestroyed()) return;
    reconcileViews(mainWindow, tabs, activeId);
  });

  // Subscribe to auth session changes. When a session becomes non-null
  // for an env (sign-in just completed), refresh cookies in every
  // attached tab whose URL belongs to that env AND whose live
  // webContents URL looks like it landed on a OneReach login page.
  // Tabs that are happily loaded against the agent are left alone.
  unsubscribeAuth = getAuthApi().onSessionChanged((env, session) => {
    if (session === null) return; // Sign-out path doesn't auto-reload.
    if (mainWindow === null || mainWindow.isDestroyed()) return;
    void refreshAttachedTabsForEnv(env);
  });

  mainWindow = win;
  return win;
}

/**
 * Iterate `attachedTabs` and reload any tab that (a) belongs to the
 * given env (per its stored URL) and (b) is currently sitting on a
 * OneReach login interstitial in its live webContents. Cookies are
 * re-injected before the reload so the IDW handshake sees a fresh
 * `mult` and skips the login form.
 */
async function refreshAttachedTabsForEnv(env: ReturnType<typeof getEnvironmentForUrl>): Promise<void> {
  if (env === null) return;
  const auth = getAuthApi();
  for (const attached of Array.from(attachedTabs.values())) {
    try {
      const tabEnv = getEnvironmentForUrl(getTabUrl(attached));
      if (tabEnv !== env) continue;
      const liveUrl = safeWebContentsUrl(attached.view.webContents);
      if (!looksLikeOneReachLoginUrl(liveUrl, env)) continue;
      // Inject fresh cookies into the tab partition first, then reload
      // so the next request carries the new `mult`.
      const result = await auth.injectTokenIntoPartition(env, getTabPartition(attached));
      if (!result.injected) {
        getLoggingApi().info('main-window', 'session-changed reload skipped (injection failed)', {
          id: attached.id,
          env,
          reason: result.reason,
        });
        getLoggingApi().event(MAIN_WINDOW_EVENTS.SESSION_RELOAD_SKIPPED, {
          id: attached.id,
          env,
          reason: result.reason,
        });
        continue;
      }
      getLoggingApi().info('main-window', 'session-changed reload firing', {
        id: attached.id,
        env,
        liveUrl: liveUrl.slice(0, 80),
      });
      getLoggingApi().event(MAIN_WINDOW_EVENTS.SESSION_RELOAD_FIRING, {
        id: attached.id,
        env,
      });
      attached.view.webContents.reload();
    } catch (err) {
      getLoggingApi().warn('main-window', 'session-changed reload threw', {
        id: attached.id,
        error: (err as Error).message,
      });
    }
  }
}

/**
 * Best-effort detector for the "this tab is stuck on a OneReach login
 * page" condition. Looks for the SSO interstitial host (`auth.<env>.…`)
 * or paths that include `/login` on a OneReach host. False negatives
 * (we miss a stuck tab) are fine — the user can refresh manually. False
 * positives (we reload a tab that's actually fine) are also tolerable
 * given this only fires on a session change.
 */
function looksLikeOneReachLoginUrl(url: string, env: ReturnType<typeof getEnvironmentForUrl>): boolean {
  if (url.length === 0 || env === null) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (host.startsWith(`auth.${env}.`)) return true;
  // Some IDW flows land on `studio.<env>.onereach.ai/login`.
  if (host === `studio.${env}.onereach.ai` && parsed.pathname.includes('/login')) {
    return true;
  }
  return false;
}

/** Best-effort accessor for the tab's stored URL. */
function getTabUrl(attached: AttachedTab): string {
  // `lastUrl` tracks what we mounted; tabs may have navigated since.
  // We use the stored value because we care about the agent the user
  // INTENDED to open, not whichever auth page they were bounced to.
  return attached.lastUrl;
}

/** Best-effort accessor for the tab's partition string. */
function getTabPartition(attached: AttachedTab): string {
  // The partition is set on attach; pulling it off webContents.session
  // would require knowing the session's partition string, which
  // Electron doesn't expose directly. We stash it on the attached
  // record at mount time; readback here is a synchronous lookup.
  // For tabs that pre-date this field, fall back to an empty string —
  // injection will reject with `unsupported-env` and we skip.
  return attached.partition ?? '';
}

/** @internal -- exposed for tests. */
export function _getMainWindowForTesting(): BrowserWindow | null {
  return mainWindow;
}

/** @internal -- exposed for tests. */
export function _resetMainWindowForTesting(): void {
  teardownStoreSubscription();
  stopAllAttachedTabWatchers();
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
  mainWindow = null;
  attachedTabs.clear();
  activeAttachedTabId = null;
  homeFeedView = null;
}

/** Close the main window if open. Idempotent. */
export function closeMainWindow(): void {
  teardownStoreSubscription();
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
  stopAllAttachedTabWatchers();
  mainWindow = null;
  activeAttachedTabId = null;
  homeFeedView = null;
}

/** Get the current main window (or null if not open). */
export function getMainWindow(): BrowserWindow | null {
  if (mainWindow === null || mainWindow.isDestroyed()) return null;
  return mainWindow;
}

/** Open DevTools for the currently-visible tab WebContentsView, if any. */
export function openActiveTabDevTools(): boolean {
  const active = getActiveAttachedTab();
  if (active === null) {
    getLoggingApi().warn('main-window', 'no active tab available for DevTools');
    return false;
  }

  try {
    active.view.webContents.openDevTools({ mode: 'detach' });
    getLoggingApi().event('main-window.devtools.open-active-tab', { id: active.id });
    return true;
  } catch (err) {
    getLoggingApi().warn('main-window', 'failed to open active tab DevTools', {
      id: active.id,
      error: (err as Error).message,
    });
    return false;
  }
}

/**
 * Reload the currently-visible content: the active tab's
 * `WebContentsView`, or — when Home is active (no tab foregrounded) —
 * the IDW home feed. Returns `false` when there is nothing to reload.
 *
 * Wired to the tab-bar ↻ button (`chrome.ts`) and the `CmdOrCtrl+R`
 * menu accelerator. A plain `reload()` (not `reloadIgnoringCache()`)
 * matches the full app's tab-refresh behavior. Pure view op — does not
 * touch the tab store, so no persistence side effects.
 */
export function reloadActive(): boolean {
  const active = getActiveAttachedTab();
  if (active !== null) {
    try {
      active.view.webContents.reload();
      getLoggingApi().event(MAIN_WINDOW_EVENTS.RELOAD_ACTIVE, { target: 'tab', id: active.id });
      return true;
    } catch (err) {
      getLoggingApi().warn('main-window', 'failed to reload active tab', {
        id: active.id,
        error: (err as Error).message,
      });
      return false;
    }
  }
  // Home is active (activeAttachedTabId === null): reload the IDW home feed.
  if (homeFeedView !== null && !homeFeedView.webContents.isDestroyed()) {
    try {
      homeFeedView.webContents.reload();
      getLoggingApi().event(MAIN_WINDOW_EVENTS.RELOAD_ACTIVE, { target: 'home' });
      return true;
    } catch (err) {
      getLoggingApi().warn('main-window', 'failed to reload home feed', {
        error: (err as Error).message,
      });
      return false;
    }
  }
  getLoggingApi().warn('main-window', 'no active tab or home feed to reload');
  return false;
}

function getActiveAttachedTab(): AttachedTab | null {
  if (activeAttachedTabId === null) return null;
  return attachedTabs.get(activeAttachedTabId) ?? null;
}

function stopAllAttachedTabWatchers(): void {
  for (const attached of attachedTabs.values()) {
    try {
      attached.stopTotpAutofill();
    } catch {
      /* best-effort */
    }
    try {
      attached.stopLoginVerifier();
    } catch {
      /* best-effort */
    }
  }
}

// ─── store -> view reconciliation ─────────────────────────────────────────

async function rehydrateFromStore(win: BrowserWindow): Promise<void> {
  try {
    // `listTabs()` awaits auth hydration internally (see
    // `lite/main-window/api.ts`) — the TabStore reads the signed-in
    // accountId synchronously, so without that await a freshly-launched
    // window would see "no session yet" and drop the user's persisted
    // tabs.
    const api = getMainWindowApi();
    const tabs = await api.listTabs();
    // Boot ALWAYS lands on Home (the IDW feed), never a restored tab: a
    // persisted active tab can be stale (e.g. it targets a different
    // OneReach account) and would auto-foreground over the feed, leaving
    // the user stuck on a login / account-picker page ("the app is hung").
    // We still restore the tabs so they sit in the bar; the user
    // foregrounds one by clicking it.
    //
    // Commit Home FIRST — before attaching any tab view. Attaching a tab
    // starts its load, whose page-title-updated / did-navigate events call
    // setLabel / setUrl; those read-modify-write the blob preserving its
    // current activeId. If Home isn't committed yet, that races and
    // re-persists the tab as active (re-foregrounding the stuck tab ~17ms
    // later — the symptom we just saw). goHome() first means those later
    // writes read activeId=null and keep it null.
    await api.goHome();
    reconcileViews(win, tabs, null);
  } catch (err) {
    getLoggingApi().warn('main-window', 'rehydrate failed', {
      error: (err as Error).message,
    });
  }
}

/**
 * Reconcile the set of attached WebContentsViews against the store's
 * tab list. Adds views for new tabs, removes views for tabs no longer
 * in the store, swaps which view is foregrounded based on activeId.
 */
function reconcileViews(win: BrowserWindow, tabs: Tab[], activeId: string | null): void {
  const tabIds = new Set(tabs.map((t) => t.id));

  // Remove views for tabs that no longer exist in the store.
  for (const [id, attached] of Array.from(attachedTabs.entries())) {
    if (!tabIds.has(id)) {
      try {
        attached.stopTotpAutofill();
      } catch {
        /* best-effort */
      }
      try {
        attached.stopLoginVerifier();
      } catch {
        /* best-effort */
      }
      try {
        win.contentView.removeChildView(attached.view);
      } catch {
        /* best-effort */
      }
      // WebContentsView destruction: close webContents to release the
      // partition's renderer process. (Electron 30+ preferred path.)
      try {
        attached.view.webContents.close();
      } catch {
        /* best-effort -- some Electron versions throw if already destroyed */
      }
      // Drop the partition's persisted state (cookies, IndexedDB,
      // localStorage, service workers, cache) so closing a tab
      // doesn't leak `<userData>/Partitions/tab-<8hex>/` directories
      // and ambient identities forever. Without this, long-running
      // installs accumulate megabytes per closed tab and a future
      // partition-string collision could resurrect stale credentials.
      // Fire-and-forget — failures are logged, never thrown.
      clearTabPartitionStorage(attached.partition, attached.id);
      attachedTabs.delete(id);
    }
  }

  // Add views for new tabs.
  for (const tab of tabs) {
    if (!attachedTabs.has(tab.id)) {
      attachTab(win, tab);
    }
  }

  // Foreground only the active tab; hide the rest.
  activeAttachedTabId = activeId;
  for (const [id, attached] of attachedTabs.entries()) {
    const isActive = id === activeId;
    attached.view.setVisible(isActive);
  }

  // Position the active tab to fill the content area below the tab bar.
  if (activeId !== null) {
    const active = attachedTabs.get(activeId);
    if (active !== undefined) {
      active.view.setBounds(computeContentBounds(win));
    }
  }

  // The IDW home feed is the Home-tab content: visible only while Home
  // is active (no tab foregrounded), covering the same content region as
  // a tab — never the tab bar. When an IDW tab is active it hides so the
  // tab shows through; closing all tabs returns to the feed.
  if (homeFeedView !== null) {
    const showFeed = activeId === null;
    homeFeedView.setVisible(showFeed);
    if (showFeed) {
      homeFeedView.setBounds(computeContentBounds(win));
    }
  }
}

function attachTab(win: BrowserWindow, tab: Tab): void {
  const view = new WebContentsView({
    webPreferences: {
      // NO preload -- third-party agent pages must not see
      // window.lite.*. ADR-038.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      partition: tab.partition,
    },
  });
  // Capture accountId from the IDW URL so the watcher can auto-select
  // it on the OneReach account-picker page (`/multi-user/list-users`).
  // OneReach drops the `?accountId=...` query when redirecting through
  // login + 2FA, so we keep the original IDW value as the authoritative
  // target. Picker auto-select is best-effort -- if the user reaches a
  // page without a captured target, they pick manually.
  const initialAccountId = extractAccountIdFromUrl(tab.url);
  const stopTotpAutofill = startTotpAutofillForWebContents(view.webContents, {
    source: `main-window-tab:${tab.id}`,
    logger: (level, message, data) => getLoggingApi()[level]('auth', message, data),
    onTwoFactorDetected: (payload) => {
      // Auto-fill is the primary path: lite/auth/totp-autofill.ts
      // generates the code from the keychain and submits it inside
      // the tab's webContents. We log the detection for diagnostics
      // but do NOT auto-open Settings -> Two-Factor anymore (that was
      // a fallback before auto-fill was reliable). Users can still
      // open Settings manually if they need to copy the code.
      getLoggingApi().event('main-window.tab.two-factor-detected', {
        id: tab.id,
        frameUrl: payload.frameUrl,
        source: payload.source,
        ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
      });
    },
    getTargetAccountId: () => {
      // Prefer the live URL's accountId in case the user navigates to
      // a fresh IDW link, fall back to the IDW URL we opened with.
      const live = extractAccountIdFromUrl(safeWebContentsUrl(view.webContents));
      return live ?? initialAccountId;
    },
    onAccountPickerDetected: (payload) => {
      getLoggingApi().event('main-window.tab.account-picker-detected', {
        id: tab.id,
        frameUrl: payload.frameUrl,
        source: payload.source,
      });
    },
  });

  // Login-outcome verifier -- the "did auto-login actually work?" check.
  // The inject → SSO-skip → 2FA → account-picker steps are fire-and-
  // forget; this watches whether THIS tab reaches a logged-in state or
  // spins on a login page, emits auth.idw-login.* to the central log,
  // and hands the user actionable instruction when it's stuck. Only
  // meaningful for OneReach env tabs (where our auto-login applies);
  // other tabs get a no-op disposer.
  const verifierEnv = getEnvironmentForUrl(tab.url);
  let verifierActive = false;
  /**
   * True once we've told the user this tab needs their attention.
   * Suppresses repeat notifications: a login page churns through
   * in-page navigations (reCAPTCHA, form posts, redirects), and each
   * one re-arms the verifier -- without this the user would get a
   * fresh "couldn't sign in" notification every ~20s WHILE they are
   * actively signing in. Cleared when the tab recovers or navigates
   * off the login flow.
   */
  let loginStuckNotified = false;
  /**
   * True while the tab's most recent MAIN-FRAME load failed (net
   * error / DNS / offline). Feeds the login verifier's
   * `pageLooksBroken` seam: an error page has a normal-looking URL and
   * no login markers, so without this bit the verifier would declare a
   * false logged-in SUCCESS on a dead tab. Cleared when a load
   * finishes.
   */
  let lastMainFrameLoadFailed = false;
  let stopCurrentVerifier: () => void = (): void => {};
  // (Re)start the login verifier for this tab -- on attach, and again if
  // a settled tab bounces back to a OneReach login page (session dropped
  // mid-use). Guarded so a throw here can never break tab attach.
  const startVerifier = (): void => {
    if (verifierEnv === null) return;
    try {
      stopCurrentVerifier();
      verifierActive = true;
      stopCurrentVerifier = startLoginVerifier(
        { tabId: tab.id, env: verifierEnv, label: tab.label },
        {
          ...makeWebContentsProbe(view.webContents),
          pageLooksBroken: () => lastMainFrameLoadFailed,
          emit: (name, data, level) => getLoggingApi().event(name, data, level),
          now: () => Date.now(),
          schedule: (fn, ms) => {
            const timer = setTimeout(fn, ms);
            return () => clearTimeout(timer);
          },
          // Self-heal: re-inject fresh cookies + reload once. The reload
          // re-runs the did-finish-load SSO-skip too, so a missed Skip
          // click gets a second shot. Only worth it if we actually have a
          // session to inject (or the SSO-skip case, where cookies are
          // already present and the reload is the fix).
          attemptRecovery: async (cause) => {
            try {
              if (view.webContents.isDestroyed()) return false;
              const inj = await getAuthApi().injectTokenIntoPartition(verifierEnv, tab.partition);
              getLoggingApi().event(MAIN_WINDOW_EVENTS.LOGIN_RECOVERY, {
                id: tab.id,
                env: verifierEnv,
                cause,
                injected: inj.injected,
                ...(inj.reason !== undefined ? { reason: inj.reason } : {}),
              });
              if (view.webContents.isDestroyed()) return false;
              if (inj.injected || cause === 'sso-skip-missed') {
                view.webContents.reload();
                return true;
              }
              // Injection failed for want of a LIVE session (the token
              // expired mid-use, or there are no cookies at all). Route
              // to the shared re-sign-in prompter — the same coalesced,
              // cool-down'd "session expired, sign in again?" dialog the
              // KV 401 path uses. On accept, signIn() completes and the
              // session-changed reload re-injects + reloads every stuck
              // tab; returning true here opens a fresh probe window so
              // the verifier observes that recovery (or times out into
              // the notification if the user ignores the dialog).
              if (inj.reason === 'expired' || inj.reason === 'no-mult' || inj.reason === 'no-cookies') {
                const prompter = getReSignInPrompter();
                if (prompter !== null && !prompter.isSuspended() && !prompter.isInCooldown()) {
                  prompter.promptReSignIn(
                    `IDW tab "${tab.label}" lost its OneReach session (${inj.reason})`
                  );
                  return true;
                }
              }
              return false;
            } catch (err) {
              getLoggingApi().warn('main-window', 'login recovery threw', {
                id: tab.id,
                error: (err as Error).message,
              });
              return false;
            }
          },
          onOutcome: (outcome) => {
            verifierActive = false;
            // Recovered -- allow a future problem to notify again.
            if (outcome.verdict === 'logged-in') loginStuckNotified = false;
          },
          onNeedsUserAction: (info) => {
            if (loginStuckNotified) return; // already told them; don't nag
            loginStuckNotified = true;
            notifyLoginStuck(win, tab, verifierEnv, info);
          },
        }
      );
    } catch (err) {
      verifierActive = false;
      getLoggingApi().warn('main-window', 'failed to start login verifier', {
        id: tab.id,
        error: (err as Error).message,
      });
    }
  };
  startVerifier();
  const stopLoginVerifier = (): void => {
    stopCurrentVerifier();
  };

  const attached: AttachedTab = {
    id: tab.id,
    view,
    lastUrl: tab.url,
    partition: tab.partition,
    initialLoadStarted: false,
    stopTotpAutofill,
    stopLoginVerifier,
  };
  attachedTabs.set(tab.id, attached);

  // Initial bounds are zero; reconcileViews positions the active tab
  // immediately after attach.
  view.setBounds({ x: 0, y: CHROME_HEIGHT_PX, width: 0, height: 0 });
  view.setVisible(false);

  // Window-open handler: allow OAuth IdP popups (Google / Microsoft /
  // Apple / Auth0 / Okta / etc.) in the SAME `persist:tab-<uuid>`
  // partition so cookies land in this tab's jar. Anything else still
  // routes to the OS default browser.
  //
  // Prior behavior denied every popup, which silently broke
  // "Sign in with Google" inside ChatGPT / Claude / Gemini / etc.
  // tabs because the popup completed in Safari and the resulting
  // session never reached this tab's partition.
  view.webContents.setWindowOpenHandler(
    buildPopupHandler({
      partition: tab.partition,
      source: `main-window-tab:${tab.id}`,
      logger: (level, message, data) => getLoggingApi()[level]('auth', message, data),
      // Keep a third-party chatbot's OWN same-site links/buttons in-app
      // (Grok / ChatGPT / etc. open these as new windows). Cross-site
      // targets still route to the OS browser. Read live so it tracks
      // the tab's current page, not just its initial URL.
      sameSiteOpenerUrl: () => safeWebContentsUrl(view.webContents),
    })
  );

  // Persist navigation -- save the latest URL to the store so we can
  // restore the user's place across app restarts.
  view.webContents.on('did-navigate', (_e, url) => {
    void getMainWindowApi().setTabUrl(tab.id, url);
    // Auto-skip SSO interstitial -- runs on every main-frame nav so
    // mid-flight redirects through auth.<env>.onereach.ai are caught
    // even when the page has already finished an earlier load.
    const ssoMatch = isOneReachSsoSkipUrl(url);
    if (ssoMatch.match && ssoMatch.env !== null) {
      void tryAutoSkipSso(view.webContents, ssoMatch.env, url);
    }
    // Re-verify if a SETTLED tab bounces back to a OneReach login page
    // (session dropped mid-use). Guarded by `verifierActive` so the
    // normal login redirects during the FIRST attempt don't restart it.
    if (verifierEnv !== null && isOneReachAuthOrLoginUrl(url)) {
      if (!verifierActive) startVerifier();
    } else if (loginStuckNotified) {
      // Left the login flow -- treat the episode as over so a LATER
      // bounce is allowed to notify again.
      loginStuckNotified = false;
    }
  });
  view.webContents.on('did-navigate-in-page', (_e, url) => {
    void getMainWindowApi().setTabUrl(tab.id, url);
    const ssoMatch = isOneReachSsoSkipUrl(url);
    if (ssoMatch.match && ssoMatch.env !== null) {
      void tryAutoSkipSso(view.webContents, ssoMatch.env, url);
    }
    // Re-verify here TOO. The IDW is a SPA: when it decides its session
    // is no good it routes to /login IN-PAGE, which fires only this
    // event -- not `did-navigate`. Watching just `did-navigate` meant a
    // tab that loaded fine and bounced to login seconds later went
    // completely unnoticed (no retry, no badge, no notification), which
    // is exactly how "auto-login stopped working" looked silent in the
    // event log.
    if (verifierEnv !== null && isOneReachAuthOrLoginUrl(url)) {
      if (!verifierActive) startVerifier();
    } else if (loginStuckNotified) {
      loginStuckNotified = false;
    }
  });

  // Update the tab label when the page title resolves -- gives users
  // a more informative tab pill than the static IDW label alone.
  view.webContents.on('page-title-updated', (_e, title) => {
    if (typeof title === 'string' && title.length > 0 && title.length <= 80) {
      void getMainWindowApi().setTabLabel(tab.id, title);
    }
  });

  // Load failure surface -- log it but don't bring down the tab.
  view.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (errorCode === -3) return; // ABORTED -- user navigated away
    if (isMainFrame) lastMainFrameLoadFailed = true;
    getLoggingApi().event(MAIN_WINDOW_EVENTS.TAB_LOAD_FAIL, {
      id: tab.id,
      errorCode,
      errorDescription,
    });
    getLoggingApi().warn('main-window', 'tab load failed', {
      id: tab.id,
      errorCode,
      errorDescription,
      validatedURL,
    });
  });

  view.webContents.on('did-start-loading', () => {
    if (!attached.initialLoadStarted) attached.initialLoadStarted = true;
    getLoggingApi().event(MAIN_WINDOW_EVENTS.TAB_LOAD_START, { id: tab.id });
  });

  let loadStart = Date.now();
  view.webContents.on('did-start-navigation', (_e, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) loadStart = Date.now();
  });
  view.webContents.on('did-finish-load', () => {
    lastMainFrameLoadFailed = false;
    getLoggingApi().event(MAIN_WINDOW_EVENTS.TAB_LOAD_FINISH, {
      id: tab.id,
      durationMs: Date.now() - loadStart,
    });
    // Per the "ultimate convenience" goal: when the IDW redirects
    // through OneReach's SSO interstitial (auth.<env>.onereach.ai/?
    // sso=true&showSkip=true), auto-click the Skip / Continue button
    // so the user never sees that page. The cookies we injected on
    // attach already carry the user's session; the Skip button just
    // confirms it.
    const currentUrl = safeWebContentsUrl(view.webContents);
    const ssoMatch = isOneReachSsoSkipUrl(currentUrl);
    if (ssoMatch.match && ssoMatch.env !== null) {
      void tryAutoSkipSso(view.webContents, ssoMatch.env, currentUrl);
    }
  });

  win.contentView.addChildView(view);

  // Kick off the initial navigation. URL was validated on store-side
  // openTab; we trust it here.
  //
  // Per ADR-042, if the tab points at a OneReach environment (Edison,
  // staging, etc.), inject the captured `mult` cookie into this tab's
  // partition BEFORE navigation. This is what makes the IDW agent
  // recognize the user immediately on first open -- skipping the
  // OneReach account picker. Soft-fails: when no token is available
  // (third-party agents, or user not yet signed in) we just navigate
  // and let the agent's own sign-in flow handle it.
  void prepareTabAndLoad(tab, view);
}

async function prepareTabAndLoad(tab: Tab, view: WebContentsView): Promise<void> {
  try {
    const env = getEnvironmentForUrl(tab.url);
    if (env !== null) {
      const result = await ensureTokenInPartitionForTab(env, tab);
      if (!result.injected && result.reason !== undefined) {
        // Reason is informational; agent will fall back to its own
        // picker when no token. Logged at debug-equivalent level.
        getLoggingApi().info('main-window', 'token injection skipped', {
          id: tab.id,
          env,
          reason: result.reason,
        });
      }
    }
  } catch (err) {
    getLoggingApi().warn('main-window', 'token injection threw (continuing to load)', {
      id: tab.id,
      error: (err as Error).message,
    });
  }
  try {
    await view.webContents.loadURL(tab.url);
  } catch (err) {
    getLoggingApi().warn('main-window', 'initial loadURL rejected', {
      id: tab.id,
      url: tab.url,
      error: (err as Error).message,
    });
  }
}

/**
 * Multi-env auto-sign-in (ADR-042 amendment): when an IDW tab loads a
 * OneReach URL whose env doesn't have a captured session, automatically
 * trigger `signIn(env)` to open the studio sign-in window, then
 * re-attempt injection so the tab lands with cookies already in place.
 *
 * Falls through (returns the original failure) when:
 *   - The env isn't in `SUPPORTED_ENVIRONMENTS` (`unsupported-env`)
 *   - The user cancels the sign-in window
 *   - The sign-in succeeds but cookies still won't clone (very rare,
 *     usually a transient timing issue) — surfaced for diagnostics
 *
 * Coalesces naturally: `signIn(env)` returns the same in-flight Promise
 * to every caller, so opening three tabs at once for the same env
 * triggers ONE auth window, and all three injections re-run once the
 * Promise resolves.
 */
async function ensureTokenInPartitionForTab(
  env: ReturnType<typeof getEnvironmentForUrl>,
  tab: Tab
): Promise<{ injected: boolean; reason?: string }> {
  if (env === null) return { injected: false, reason: 'unsupported-env' };
  const auth = getAuthApi();
  const first = await auth.injectTokenIntoPartition(env, tab.partition);
  if (first.injected) return first;
  // Reasons that warrant an auto sign-in attempt — anything that says
  // "no usable cookie for this env." `unsupported-env` and
  // `cookie-write-failed` are NOT in this list: the former isn't fixable
  // by signing in; the latter retried would just refail.
  const NEEDS_SIGN_IN: ReadonlySet<string> = new Set([
    'no-cookies',
    'no-mult',
    'expired',
  ]);
  if (first.reason === undefined || !NEEDS_SIGN_IN.has(first.reason)) {
    return first;
  }
  // Defer to the auth store. signIn coalesces in-flight calls for the
  // same env, so concurrent tabs for the same env open one auth window.
  getLoggingApi().info('main-window', 'auto-signin triggered by tab open', {
    id: tab.id,
    env,
    reason: first.reason,
  });
  getLoggingApi().event(MAIN_WINDOW_EVENTS.AUTO_SIGNIN_TRIGGERED, {
    id: tab.id,
    env,
    reason: first.reason,
  });
  try {
    await auth.signIn(env);
  } catch (err) {
    // The user cancelled or sign-in failed. Don't navigate-and-pray —
    // surface the reason so the caller logs it; the agent's own
    // sign-in screen will appear when loadURL runs.
    getLoggingApi().warn('main-window', 'auto-signin rejected', {
      id: tab.id,
      env,
      error: (err as Error).message,
    });
    getLoggingApi().event(MAIN_WINDOW_EVENTS.AUTO_SIGNIN_REJECTED, {
      id: tab.id,
      env,
    });
    return { injected: false, reason: 'sign-in-cancelled' };
  }
  // Re-try injection now that cookies should be in the auth partition.
  const second = await auth.injectTokenIntoPartition(env, tab.partition);
  if (second.injected) {
    getLoggingApi().info('main-window', 'auto-signin succeeded; cookies injected', {
      id: tab.id,
      env,
    });
    getLoggingApi().event(MAIN_WINDOW_EVENTS.AUTO_SIGNIN_SUCCEEDED, {
      id: tab.id,
      env,
    });
  }
  return second;
}

function extractAccountIdFromUrl(url: string): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  try {
    const parsed = new URL(url);
    const value = parsed.searchParams.get('accountId');
    return value !== null && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function safeWebContentsUrl(webContents: Electron.WebContents): string {
  try {
    if (webContents.isDestroyed()) return '';
    return webContents.getURL();
  } catch {
    return '';
  }
}

/**
 * Tell the chrome to show a "couldn't finish signing in to <label>"
 * banner with actionable instruction. Best-effort: if the window is
 * gone we just drop it -- the `auth.idw-login.*` events already recorded
 * the outcome in the central log for troubleshooting.
 */
function notifyLoginStuck(
  win: BrowserWindow,
  tab: Tab,
  env: ReturnType<typeof getEnvironmentForUrl>,
  info: { likelyCause: string; instruction: string }
): void {
  const label = tab.label.length > 0 ? tab.label : 'your agent';
  // 1. A system notification is the reliable, layering-proof surface:
  // the chrome shell renders BEHIND the tab's WebContentsView, so an
  // in-chrome banner would be hidden by the very page that's stuck.
  try {
    if (Notification.isSupported()) {
      const note = new Notification({
        title: `Couldn’t finish signing in to ${label}`,
        body: info.instruction,
      });
      note.on('click', () => {
        try {
          if (!win.isDestroyed()) {
            win.show();
            win.focus();
          }
        } catch {
          /* best-effort */
        }
      });
      note.show();
    }
  } catch (err) {
    getLoggingApi().warn('main-window', 'failed to show login-stuck notification', {
      id: tab.id,
      error: (err as Error).message,
    });
  }
  // 2. Also broadcast to the chrome so a future in-app indicator (e.g.
  // a ⚠ badge on the stuck tab's pill) can consume it. Harmless no-op
  // until a listener exists.
  try {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(IDW_LOGIN_STUCK_CHANNEL, {
        tabId: tab.id,
        label: tab.label,
        ...(env !== null ? { env } : {}),
        likelyCause: info.likelyCause,
        instruction: info.instruction,
      });
    }
  } catch {
    /* best-effort; the notification already delivered the instruction */
  }
}

/**
 * Wipe a tab partition's persisted storage on close. Tab partitions
 * are `persist:tab-<8hex>` and every closed tab leaves a directory in
 * `<userData>/Partitions/` behind unless we clear it. The clear is
 * fire-and-forget (we don't await it from the reconcile loop) and any
 * failure becomes a warn log — Electron may refuse the call mid-quit
 * or on certain platform locks, neither of which should block the
 * tab-close path.
 */
function clearTabPartitionStorage(partition: string, tabId: string): void {
  // Refuse to touch any non-tab partition (auth, idw, university,
  // shared singletons) so a misconfiguration can't wipe a partition
  // we depend on for authentication. The `persist:tab-` prefix is
  // assigned exclusively by `lite/main-window/store.ts:generateId`.
  if (typeof partition !== 'string' || !partition.startsWith('persist:tab-')) {
    return;
  }
  try {
    const ses = electronSession.fromPartition(partition);
    // Synchronously promise-chain so a thrown error is observable in
    // the catch below rather than as an unhandled rejection.
    void ses
      .clearStorageData()
      .then(() => {
        getLoggingApi().info('main-window', 'cleared tab partition storage', {
          id: tabId,
          partition,
        });
        getLoggingApi().event(MAIN_WINDOW_EVENTS.PARTITION_CLEARED, { id: tabId });
      })
      .catch((err: unknown) => {
        getLoggingApi().warn('main-window', 'clearStorageData failed for tab partition', {
          id: tabId,
          partition,
          error: (err as Error).message,
        });
        getLoggingApi().event(MAIN_WINDOW_EVENTS.PARTITION_CLEAR_FAILED, { id: tabId });
      });
  } catch (err) {
    getLoggingApi().warn('main-window', 'sessionFromPartition threw on tab close', {
      id: tabId,
      partition,
      error: (err as Error).message,
    });
  }
}

/**
 * Mount the IDW home feed as the Home-tab content. A `WebContentsView`
 * with NO preload (remote content must not see `window.lite.*`, per
 * ADR-038) in the shared IDW partition, positioned to fill the content
 * area below the 36px tab bar. Shown immediately; `reconcileViews`
 * toggles its visibility as tabs come and go.
 *
 * The feed IS the home surface, so navigations stay inside this view.
 * External links (`target=_blank` / `window.open`) route per
 * `buildPopupHandler`. If the URL fails to load, the view hides so the
 * bundled boot-chat home view shows through underneath — the Home tab is
 * never blank.
 */
function attachHomeFeed(win: BrowserWindow): void {
  if (IDW_HOME_URL === null || homeFeedView !== null) return;

  const view = new WebContentsView({
    webPreferences: {
      // NO preload -- remote content must not reach window.lite.*. ADR-038.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      partition: HOME_FEED_PARTITION,
    },
  });

  // External links open per the shared popup policy (OAuth IdP popups in
  // this partition; everything else to the OS browser).
  view.webContents.setWindowOpenHandler(
    buildPopupHandler({
      partition: HOME_FEED_PARTITION,
      source: 'main-window-home-feed',
      logger: (level, message, data) => getLoggingApi()[level]('auth', message, data),
    })
  );

  // Auto-skip the OneReach SSO interstitial if the feed ever redirects
  // through it (cheap no-op for any other URL).
  const maybeSkipSso = (url: string): void => {
    const ssoMatch = isOneReachSsoSkipUrl(url);
    if (ssoMatch.match && ssoMatch.env !== null) {
      void tryAutoSkipSso(view.webContents, ssoMatch.env, url);
    }
  };
  view.webContents.on('did-navigate', (_e, url) => maybeSkipSso(url));
  view.webContents.on('did-navigate-in-page', (_e, url) => maybeSkipSso(url));
  view.webContents.on('did-finish-load', () => {
    maybeSkipSso(safeWebContentsUrl(view.webContents));
  });

  // On load failure, hide the feed so the boot-chat home view shows
  // through. Never leave a blank Home tab.
  view.webContents.on('did-fail-load', (_e, errorCode, errorDescription) => {
    if (errorCode === -3) return; // ABORTED -- navigated away.
    getLoggingApi().warn('main-window', 'home feed failed to load; revealing boot-chat home', {
      errorCode,
      errorDescription,
    });
    try {
      view.setVisible(false);
    } catch {
      /* best-effort */
    }
  });

  homeFeedView = view;
  win.contentView.addChildView(view);
  // Default visible + positioned; reconcileViews adjusts as tabs change.
  view.setBounds(computeContentBounds(win));
  view.setVisible(true);

  // Cache-bust each launch so the window picks up the latest Edison deploy.
  const sep = IDW_HOME_URL.includes('?') ? '&' : '?';
  void view.webContents.loadURL(`${IDW_HOME_URL}${sep}t=${Date.now()}`).catch((err: unknown) => {
    getLoggingApi().warn('main-window', 'home feed initial load rejected', {
      error: (err as Error).message,
    });
  });
}

function repositionActiveTab(win: BrowserWindow): void {
  // On every resize, the active tab's bounds need to track the window.
  // Inactive tabs are hidden anyway; their bounds don't matter until
  // they're activated, at which point reconcileViews will reposition
  // them.
  for (const attached of attachedTabs.values()) {
    if (attached.view.getVisible()) {
      attached.view.setBounds(computeContentBounds(win));
    }
  }
  // Keep the home feed (when visible) tracking the content area too.
  if (homeFeedView !== null && homeFeedView.getVisible()) {
    homeFeedView.setBounds(computeContentBounds(win));
  }
}

function computeContentBounds(win: BrowserWindow): Rectangle {
  const bounds = win.getContentBounds();
  return {
    x: 0,
    y: CHROME_HEIGHT_PX,
    width: bounds.width,
    height: Math.max(0, bounds.height - CHROME_HEIGHT_PX),
  };
}

function teardownStoreSubscription(): void {
  if (unsubscribeStore !== null) {
    try {
      unsubscribeStore();
    } catch {
      /* best-effort */
    }
    unsubscribeStore = null;
  }
  if (unsubscribeAuth !== null) {
    try {
      unsubscribeAuth();
    } catch {
      /* best-effort */
    }
    unsubscribeAuth = null;
  }
}
