/**
 * ADR-063 — Chrome-parity behaviors for third-party tabs.
 *
 * Third-party sites (ChatGPT, Claude, any web app a user opens as a
 * tab) were built for a real browser. Every gap between a Lite tab
 * and Chrome is a reason for the user to leave the app, and the
 * pre-ADR tab views had five: `window.open` popups were unmanaged
 * (OAuth sign-in flows dead-ended), the user agent advertised
 * Electron (Google's sign-in refuses "insecure" embedded browsers),
 * right-click showed nothing, downloads had no handler, and PDFs
 * had no viewer.
 *
 * This module closes those gaps WITHOUT weakening the tab sandbox:
 * popups inherit the same hardened webPreferences (contextIsolation,
 * sandbox, no nodeIntegration, no preload — ADR-038), stay in the
 * tab's partition so `window.opener`/postMessage/cookie flows
 * complete, and unknown custom protocol schemes stay blocked (we
 * shell out only a small allowlist like mailto:).
 *
 * Everything decision-shaped is a pure exported function with
 * injectable seams so the behavior table is unit-testable without an
 * Electron runtime.
 */

import { Menu, clipboard, shell } from 'electron';
import type {
  BrowserWindowConstructorOptions,
  ContextMenuParams,
  HandlerDetails,
  Session,
  WebContents,
} from 'electron';
import { isOAuthPopupUrl } from '../auth/oauth-popup.js';
import { hidePasskeysFromGooglePopup, popupContents } from '../auth/passkey-popup.js';
import { PRODUCT_UA_TOKEN } from '../product.js';
import { getDownloadsApi } from '../downloads/api.js';
import { getLoggingApi } from '../logging/api.js';
import { getMainWindowApi } from './api.js';

// ─── User agent ──────────────────────────────────────────────────────────

/**
 * Chrome-shaped user agent for the current platform. Sites gate on
 * the UA: Google sign-in hard-refuses agents carrying an Electron /
 * app token ("This browser or app may not be secure"), which is the
 * single biggest "works in Chrome, broken here" driver. Same approach
 * the auth window has used since ADR-041; Chromium's real version is
 * preserved so feature sniffing stays honest.
 */
/** Re-exported for callers that only know this module (the token lives in product.ts). */
export { PRODUCT_UA_TOKEN };

/** A OneReach host: the token is meant for these pages and their servers only. */
export function isOneReachHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'onereach.ai' || host.endsWith('.onereach.ai');
  } catch {
    return false;
  }
}

/**
 * Request headers as they go on the wire: the product token stays on
 * requests to *.onereach.ai and is stripped for every other host, so a
 * third-party site (Google's own sign-in loaded as a tab, ChatGPT,
 * Gemini) sees exactly plain Chrome server-side. `navigator.userAgent`
 * in the tab is unchanged; the OneReach login page reads that.
 */
export function stripProductTokenForHost(url: string, headers: Record<string, string>): Record<string, string> {
  if (isOneReachHost(url)) return headers;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'user-agent');
  if (key === undefined) return headers;
  const ua = headers[key] ?? '';
  if (!ua.includes(PRODUCT_UA_TOKEN)) return headers;
  return { ...headers, [key]: ua.replace(new RegExp(`\\s*${PRODUCT_UA_TOKEN}(/\\S+)?`), '') };
}

export function chromeParityUserAgent(opts: { marker?: boolean } = {}): string {
  const chromeVersion = process.versions.chrome ?? '124.0.0.0';
  const marker = opts.marker === false ? '' : ` ${PRODUCT_UA_TOKEN}`;
  if (process.platform === 'darwin') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36${marker}`;
  }
  if (process.platform === 'win32') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36${marker}`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36${marker}`;
}

// ─── window.open routing ─────────────────────────────────────────────────

export type WindowOpenRoute = 'popup' | 'tab' | 'external' | 'deny';

/**
 * Protocols we hand to the OS. Chrome prompts for arbitrary custom
 * schemes; from third-party content we only forward this vetted set —
 * launching arbitrary protocol handlers (`slack:`, `zoommtg:`, …) on a
 * page's say-so is an app-launch primitive we don't give it.
 */
export const EXTERNAL_SCHEME_ALLOWLIST: ReadonlyArray<string> = Object.freeze([
  'mailto:',
  'tel:',
  'sms:',
  'facetime:',
  'webcal:',
]);

/**
 * The behavior table, mirroring what Chrome ACTUALLY does:
 *   - `window.open(url, name, 'width=…')` — a features string — is the
 *     popup signal. Chrome opens a real popup window for it, and OAuth
 *     popups are exactly this shape. The popup stays in the same
 *     partition so `window.opener`/postMessage/cookie flows complete.
 *   - Featureless opens (target=_blank anchors, cmd+click, plain
 *     `window.open(url)`) become TABS in Chrome — so they become app
 *     tabs here. Disposition is deliberately not trusted: measured in
 *     a WebContentsView, an anchor click can surface as a scripted
 *     open, which mis-routed tabs into popups (live-drive 2026-08-12).
 *   - allowlisted external schemes → the OS.
 *   - everything else → blocked (and logged by the wiring).
 */
export function classifyWindowOpen(
  url: string,
  _disposition: string,
  features: string = ''
): WindowOpenRoute {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'deny';
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return features.trim().length > 0 ? 'popup' : 'tab';
  }
  if (EXTERNAL_SCHEME_ALLOWLIST.includes(parsed.protocol)) return 'external';
  return 'deny';
}

/**
 * Honor the size the page asked for (Chrome does), clamped to sane
 * bounds so a page can't open a 1-pixel or wall-covering window.
 */
export function parsePopupSize(features: string): { width: number; height: number } {
  const pick = (key: string, fallback: number): number => {
    const m = new RegExp(`(?:^|[,\\s])${key}\\s*=\\s*(\\d{2,5})`, 'i').exec(features);
    const n = m !== null ? Number(m[1]) : NaN;
    if (!Number.isFinite(n)) return fallback;
    return Math.min(1600, Math.max(320, n));
  };
  return { width: pick('width', 980), height: pick('height', 760) };
}

/**
 * Popup windows inherit the tab's partition (cookies/opener flows)
 * and the full ADR-038 hardening — a popup is still third-party
 * content. `plugins` on for PDF parity inside popups too.
 */
export function popupWindowOptions(
  partition: string,
  size: { width: number; height: number } = { width: 980, height: 760 }
): BrowserWindowConstructorOptions {
  return {
    width: size.width,
    height: size.height,
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      plugins: true,
    },
  };
}

export interface TabWindowOpenSeams {
  partition: string;
  /** Test seam — defaults to opening a real app tab. */
  openInNewTab?: (url: string) => void;
  /** Test seam — defaults to `shell.openExternal`. */
  openExternal?: (url: string) => void;
  /** Test seam — defaults to the lite logging API. */
  logWarn?: (message: string, data: Record<string, unknown>) => void;
}

/** The origin (or the scheme, for non-URL targets) — logs never carry a query string. */
function originOf(url: string): string {
  try {
    const u = new URL(url);
    return u.origin === 'null' ? `${u.protocol}//` : u.origin;
  } catch {
    return '(unparseable)';
  }
}

/** The `setWindowOpenHandler` for a tab (and, recursively, its popups). */
export function buildTabWindowOpenHandler(
  seams: TabWindowOpenSeams
): (details: HandlerDetails) => { action: 'allow' | 'deny'; overrideBrowserWindowOptions?: BrowserWindowConstructorOptions } {
  const openInNewTab = seams.openInNewTab ?? defaultOpenInNewTab;
  const openExternal = seams.openExternal ?? ((url: string): void => void shell.openExternal(url));
  const logWarn =
    seams.logWarn ??
    ((message: string, data: Record<string, unknown>): void =>
      getLoggingApi().warn('main-window', message, data));
  return (details) => {
    const features = typeof details.features === 'string' ? details.features : '';
    let route = classifyWindowOpen(details.url, details.disposition, features);
    // OAuth exception: identity-provider popups (Google / Microsoft /
    // Apple / Okta / …) are often opened featureless, but the flow
    // dies without `window.opener`/postMessage back into THIS
    // partition — a tab can't provide that here. Keep the proven
    // popup routing for the allowlist regardless of features.
    if (route === 'tab' && isOAuthPopupUrl(details.url)) route = 'popup';
    // Route log (info, user-initiated volume): the one line that
    // explains "why did that open there" in support logs — and the
    // live-drive tool that caught disposition lying in the first place.
    getLoggingApi().info('main-window', 'window.open routed', {
      route,
      disposition: details.disposition,
      features: features.slice(0, 80),
      origin: originOf(details.url),
    });
    switch (route) {
      case 'popup':
        return {
          action: 'allow',
          overrideBrowserWindowOptions: popupWindowOptions(
            seams.partition,
            parsePopupSize(features)
          ),
        };
      case 'tab':
        openInNewTab(details.url);
        return { action: 'deny' };
      case 'external':
        openExternal(details.url);
        return { action: 'deny' };
      default:
        logWarn('blocked window.open to unsupported scheme', {
          origin: originOf(details.url),
          disposition: details.disposition,
        });
        return { action: 'deny' };
    }
  };
}

function defaultOpenInNewTab(url: string): void {
  let label = 'Tab';
  try {
    label = new URL(url).hostname.replace(/^www\./, '') || 'Tab';
  } catch {
    /* keep fallback */
  }
  void getMainWindowApi()
    .openTab({ url, label })
    .catch((err: unknown) => {
      getLoggingApi().warn('main-window', 'open-in-new-tab failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

// ─── Context menu ────────────────────────────────────────────────────────

/**
 * Declarative context-menu entry — pure data so the table is
 * unit-testable; the wiring maps ids to Electron actions.
 */
export interface ContextMenuEntry {
  id: string;
  label?: string;
  enabled?: boolean;
  separator?: boolean;
}

/**
 * The Chrome-shaped right-click menu. Sections appear only when
 * relevant (link under cursor, image under cursor, editable field,
 * text selection), with navigation always at the top.
 */
export function buildContextMenuTemplate(
  params: Pick<
    ContextMenuParams,
    'linkURL' | 'mediaType' | 'isEditable' | 'selectionText' | 'srcURL'
  >,
  nav: { canGoBack: boolean; canGoForward: boolean }
): ContextMenuEntry[] {
  const entries: ContextMenuEntry[] = [
    { id: 'back', label: 'Back', enabled: nav.canGoBack },
    { id: 'forward', label: 'Forward', enabled: nav.canGoForward },
    { id: 'reload', label: 'Reload' },
  ];
  if (params.linkURL.length > 0) {
    entries.push({ id: 'sep-link', separator: true });
    entries.push({ id: 'open-link-new-tab', label: 'Open Link in New Tab' });
    entries.push({ id: 'copy-link', label: 'Copy Link Address' });
  }
  if (params.mediaType === 'image' && params.srcURL.length > 0) {
    entries.push({ id: 'sep-image', separator: true });
    entries.push({ id: 'copy-image', label: 'Copy Image' });
    entries.push({ id: 'copy-image-address', label: 'Copy Image Address' });
  }
  if (params.isEditable) {
    entries.push({ id: 'sep-edit', separator: true });
    entries.push({ id: 'undo', label: 'Undo' });
    entries.push({ id: 'redo', label: 'Redo' });
    entries.push({ id: 'cut', label: 'Cut' });
    entries.push({ id: 'copy', label: 'Copy' });
    entries.push({ id: 'paste', label: 'Paste' });
    entries.push({ id: 'select-all', label: 'Select All' });
  } else if (params.selectionText.trim().length > 0) {
    entries.push({ id: 'sep-selection', separator: true });
    entries.push({ id: 'copy', label: 'Copy' });
    entries.push({ id: 'select-all', label: 'Select All' });
  }
  return entries;
}

function popupContextMenu(contents: WebContents, params: ContextMenuParams): void {
  const template = buildContextMenuTemplate(params, {
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
  });
  const menu = Menu.buildFromTemplate(
    template.map((entry) => {
      if (entry.separator === true) return { type: 'separator' as const };
      return {
        label: entry.label ?? entry.id,
        enabled: entry.enabled !== false,
        click: (): void => runContextMenuAction(contents, entry.id, params),
      };
    })
  );
  menu.popup();
}

function runContextMenuAction(
  contents: WebContents,
  id: string,
  params: ContextMenuParams
): void {
  switch (id) {
    case 'back':
      contents.navigationHistory.goBack();
      return;
    case 'forward':
      contents.navigationHistory.goForward();
      return;
    case 'reload':
      contents.reload();
      return;
    case 'open-link-new-tab':
      defaultOpenInNewTab(params.linkURL);
      return;
    case 'copy-link':
      clipboard.writeText(params.linkURL);
      return;
    case 'copy-image':
      contents.copyImageAt(params.x, params.y);
      return;
    case 'copy-image-address':
      clipboard.writeText(params.srcURL);
      return;
    case 'undo':
      contents.undo();
      return;
    case 'redo':
      contents.redo();
      return;
    case 'cut':
      contents.cut();
      return;
    case 'copy':
      contents.copy();
      return;
    case 'paste':
      contents.paste();
      return;
    case 'select-all':
      contents.selectAll();
      return;
    default:
      return;
  }
}

// ─── Wiring ──────────────────────────────────────────────────────────────

/** Sessions already carrying UA + download parity (idempotence guard). */
const paritySessions = new WeakSet<Session>();

/**
 * Session-scope parity: Chrome UA for every request in the partition
 * (including service workers and popups) + the downloads handler the
 * downloads module exposes for exactly this purpose. Best-effort — a
 * not-yet-initialized downloads module must not break tab attach.
 */
export function ensureSessionParity(ses: Session): void {
  if (paritySessions.has(ses)) return;
  paritySessions.add(ses);
  // The session default is plain Chrome (anything without a UA of its own:
  // popups, workers); a tab's own contents carry the token (attachChromeParity).
  ses.setUserAgent(chromeParityUserAgent({ marker: false }));
  // On the wire the token reaches *.onereach.ai only (ADR-096 review, 2026-09-06).
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: stripProductTokenForHost(details.url, { ...details.requestHeaders }) });
  });
  try {
    getDownloadsApi().attachToSession(ses);
  } catch (err) {
    getLoggingApi().warn('main-window', 'downloads attach skipped for tab session', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Full Chrome parity for one tab's webContents — and, via
 * `did-create-window`, recursively for every popup it opens.
 */
export function attachChromeParity(contents: WebContents, opts: { partition: string; popup?: boolean; hidePasskeys?: boolean }): void {
  // A tab carries the product token; a popup (Google's own pages) says plain Chrome.
  contents.setUserAgent(chromeParityUserAgent({ marker: opts.popup !== true }));
  // A sign-in popup (opened from a OneReach page) hides passkeys from accounts.google.com: the ceremony cannot finish in Electron (ADR-096).
  if (opts.popup === true && opts.hidePasskeys === true) void hidePasskeysFromGooglePopup(popupContents(contents), (level, message, data) => getLoggingApi()[level]('main-window', message, data));
  ensureSessionParity(contents.session);
  contents.setWindowOpenHandler(buildTabWindowOpenHandler({ partition: opts.partition }));
  contents.on('did-create-window', (child) => {
    // ADR-096 — what a popup starts with (its first document is already
    // loading here; the app-wide UA fallback in main-lite is what makes
    // it Chrome). One line per popup: support evidence, not volume.
    try {
      getLoggingApi().info('main-window', 'popup created', {
        sameSession: child.webContents.session === contents.session,
        sessionUserAgent: child.webContents.session.getUserAgent().slice(0, 120),
        contentsUserAgent: child.webContents.getUserAgent().slice(0, 120),
        openerUserAgent: contents.getUserAgent().slice(0, 120),
      });
    } catch {
      /* diagnostics only */
    }
    // Only a popup opened FROM a OneReach page is a sign-in popup; any other popup keeps WebAuthn.
    let openerIsOneReach = false;
    try {
      openerIsOneReach = isOneReachHost(contents.getURL());
    } catch {
      /* a destroyed opener: no hiding */
    }
    attachChromeParity(child.webContents, { partition: opts.partition, popup: true, hidePasskeys: openerIsOneReach });
  });
  contents.on('context-menu', (_event, params) => {
    try {
      popupContextMenu(contents, params);
    } catch (err) {
      getLoggingApi().warn('main-window', 'context menu failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
