/**
 * NEON Graph Explorer launcher (2026-09-04).
 *
 * Opens the graph UI from the Graphtester project (`~/Graphtester/
 * ioa-explorer`, the deployed "GSX Digital Twin" build) in a dedicated
 * Lite window, under Planning next to WISER Playbooks and the Journey
 * Map Builder. The explorer talks to NEON on its own (Edison
 * `omnidata/neon2`, the same graph Spaces live in); Lite only hosts
 * the page.
 *
 * Same window contract as `journey-map-window.ts`, minus the bridge:
 * single instance, sized to the display's work area, NO preload at all
 * (the hosted app needs nothing from `window.lite.*`, so it gets
 * nothing), sandboxed, its own cookie jar, and external links go to
 * the OS browser rather than navigating this window somewhere else.
 *
 * @internal — invoked from the Planning menu via `main-lite.ts`.
 */

import { BrowserWindow, nativeTheme, screen, shell } from 'electron';
import { getLoggingApi } from './logging/api.js';
import { windowBackgroundColor } from './theme/main.js';

export type ExplorerTheme = 'light' | 'dark';

/**
 * The explorer has a light theme (Lite's paper palette) and its original
 * dark one, and takes the choice from the URL (`?theme=`) — it does not
 * consult `prefers-color-scheme` (2026-09-04: its light default must hold
 * on a dark desktop too). So Lite passes its own Appearance along, and
 * the window matches the rest of the app in either mode.
 */
export function neonExplorerUrl(theme: ExplorerTheme): string {
  return `${NEON_EXPLORER_URL}?theme=${theme}`;
}

/** Lite's resolved appearance right now (its Appearance setting via nativeTheme). */
export function currentExplorerTheme(): ExplorerTheme {
  try {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/**
 * The deployed explorer. Graphtester's `deploy/deploy.js` uploads its
 * Vite build to the `ioa-explorer` public folder of the OneReach
 * account; verified live 2026-09-04 (HTTP 200, "GSX Digital Twin").
 * Change this one constant to repoint the launcher.
 */
export const NEON_EXPLORER_URL =
  'https://files.edison.api.onereach.ai/public/' +
  '35254342-4a2e-475b-aec1-18547e517e29/ioa-explorer/index.html';

/**
 * Prefix the will-navigate guard trusts: the explorer's own deployment
 * directory. Anything outside it opens in the OS browser instead of
 * turning this window into an accidental browser.
 */
export const NEON_EXPLORER_ORIGIN = NEON_EXPLORER_URL.slice(0, NEON_EXPLORER_URL.lastIndexOf('/') + 1);

/**
 * Its own cookie jar — never the auth partition, never a tab's. The
 * explorer keeps its settings (saved functions, a graph-password
 * override, the custom logo) in localStorage, so `persist:` carries
 * them across opens and app restarts.
 */
const PARTITION = 'persist:lite-neon-explorer';

const TARGET_WIDTH = 1600;
const TARGET_HEIGHT = 1000;

/** The window's name in the menu; the page's own title never replaces it. */
export const NEON_EXPLORER_TITLE = 'NEON Graph Explorer';

let win: BrowserWindow | null = null;

/** Open (or focus) the NEON Graph Explorer. */
export function openNeonExplorerWindow(): void {
  if (win !== null && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
    getLoggingApi().event('neon-explorer.focus', { url: NEON_EXPLORER_URL });
    return;
  }

  const work = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(TARGET_WIDTH, Math.max(800, work.width - 80));
  const height = Math.min(TARGET_HEIGHT, Math.max(600, work.height - 80));

  win = new BrowserWindow({
    width,
    height,
    title: NEON_EXPLORER_TITLE,
    backgroundColor: windowBackgroundColor(),
    // Shown at once, never hidden-until-ready: the explorer lays its
    // graph out with animation frames, which Chromium freezes for a
    // hidden window, and that boot-while-hidden phase is where its
    // canvas came up empty (3 of 6 scripted opens, 2026-09-04). The
    // themed background colour covers the moment before first paint.
    show: true,
    webPreferences: {
      // No preload of any kind: the hosted app reaches NEON directly
      // and needs nothing from Lite — not the bridge, not a narrow one.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      partition: PARTITION,
    },
  });

  // Links out of the app open in the OS browser; this window stays on
  // the explorer rather than becoming an accidental browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const scheme = new URL(url).protocol;
      if (scheme === 'https:' || scheme === 'http:') void shell.openExternal(url);
    } catch {
      /* malformed URL — drop */
    }
    return { action: 'deny' };
  });

  // In-window navigation stays on the explorer's own deployment; a
  // foreign http(s) destination opens in the OS browser instead. Same
  // policy as the Journey Map Builder window, kept even without a
  // bridge so the window never quietly turns into something else.
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(NEON_EXPLORER_ORIGIN)) return;
    event.preventDefault();
    try {
      const scheme = new URL(url).protocol;
      if (scheme === 'https:' || scheme === 'http:') void shell.openExternal(url);
    } catch {
      /* malformed URL — drop */
    }
    getLoggingApi().event('neon-explorer.navigation-blocked', { url: url.slice(0, 120) });
  });

  // The page calls itself "GSX Digital Twin"; the window keeps the
  // name the Planning menu opened it under.
  win.on('page-title-updated', (event) => {
    event.preventDefault();
  });

  // Follow the app's Appearance while open. The explorer reads its theme
  // from the URL once per load, so a flip means a reload — rare and
  // deliberate, and the window must not stay the odd one out.
  let loadedTheme = currentExplorerTheme();
  const created = win;
  const onThemeUpdated = (): void => {
    const next = currentExplorerTheme();
    if (next === loadedTheme || created.isDestroyed()) return;
    loadedTheme = next;
    getLoggingApi().event('neon-explorer.theme', { theme: next });
    void created.loadURL(neonExplorerUrl(next)).catch(() => {
      /* the load failure path below already reports */
    });
  };
  nativeTheme.on('updated', onThemeUpdated);

  win.on('closed', () => {
    nativeTheme.removeListener('updated', onThemeUpdated);
    win = null;
  });
  win.once('ready-to-show', () => {
    win?.show();
  });

  const url = neonExplorerUrl(loadedTheme);
  void win.loadURL(url).catch((err: unknown) => {
    getLoggingApi().warn('neon-explorer', 'explorer failed to load', {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  getLoggingApi().event('neon-explorer.open', { url, theme: loadedTheme });
}

/** @internal — test seam / teardown. */
export function closeNeonExplorerWindow(): void {
  if (win !== null && !win.isDestroyed()) win.close();
  win = null;
}
