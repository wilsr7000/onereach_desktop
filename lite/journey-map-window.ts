/**
 * Journey Map Builder launcher (ADR-072 phase 2, 2026-08-18).
 *
 * The Builder is a real app that lives OUTSIDE this repo
 * (`~/Capablity Projects/journey Map Builder`) and is already deployed
 * to edison public files. ADR-072 shipped an in-app composer because a
 * search of THIS repo found only the WISER template and the main app's
 * dead in-memory handlers — the wrong conclusion from an incomplete
 * search. Planning now opens the real app, the way "WISER Playbooks"
 * opens the riff build; the composer survives as quick capture that
 * files a journey straight into a Space.
 *
 * Same window contract as `wiser-playbooks-window.ts`: single instance,
 * sized to the display's work area, NO preload (the hosted app must not
 * reach `window.lite.*`), sandboxed, and external links go to the OS
 * browser rather than navigating this window somewhere unexpected.
 *
 * @internal — invoked from the Planning menu via `main-lite.ts`.
 */

import { BrowserWindow, ipcMain, screen, shell } from 'electron';
import { join } from 'node:path';
import { getLoggingApi } from './logging/api.js';
import { windowBackgroundColor } from './theme/main.js';

/**
 * The deployed Builder. Recorded in the project's own
 * DEPLOYMENT_COMPLETE.md and verified live (HTTP 200, "Journey Map
 * Builder"). Change this one constant to repoint the launcher.
 */
export const JOURNEY_MAP_BUILDER_URL =
  'https://files.edison.api.onereach.ai/public/' +
  '35254342-4a2e-475b-aec1-18547e517e29/journey-map-builder/index.html';

/**
 * Prefix the will-navigate guard trusts: the Builder's own deployment
 * directory. Anything outside it opens in the OS browser instead of
 * navigating a window that carries the `journeySpaces` preload bridge.
 */
export const JOURNEY_MAP_BUILDER_ORIGIN = JOURNEY_MAP_BUILDER_URL.slice(
  0,
  JOURNEY_MAP_BUILDER_URL.lastIndexOf('/') + 1
);

/** Its own cookie jar — never the auth partition, never a tab's. */
const PARTITION = 'persist:lite-journey-map';

const TARGET_WIDTH = 1600;
const TARGET_HEIGHT = 1000;

let win: BrowserWindow | null = null;

/**
 * The journey asset the Builder should load on open, set by the "Open
 * in Journey Map Builder" button on a journey asset. The deployed build
 * reads only `ai`/`nocache`/`scenario` from the query string, so a URL
 * parameter would silently do nothing — the id is handed over through
 * the preload bridge instead (`journeySpaces.openTarget()`), which the
 * Builder can feature-detect. Cleared once read so a later plain open
 * doesn't resurrect a stale target.
 */
let pendingTargetId: string | null = null;

/** @internal — read by `preload-journey-map` via IPC. */
export function takeJourneyTarget(): string | null {
  const id = pendingTargetId;
  pendingTargetId = null;
  return id;
}

/**
 * Open (or focus) the Journey Map Builder.
 *
 * NOTE on identity: the deployed build reads only `ai`, `nocache` and
 * `scenario` from the query string — it has no user parameter, so
 * unlike the riff app there is no signed-in hand-off to pass. Adding
 * one would need a change on the Builder side first; inventing a
 * parameter here would silently do nothing.
 */
export function openJourneyMapWindow(opts?: { itemId?: string }): void {
  pendingTargetId = opts?.itemId ?? null;
  if (win !== null && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
    // Already open: tell the live page a new target arrived, so
    // "Open in Journey Map Builder" on a second journey still lands.
    if (pendingTargetId !== null) {
      win.webContents.send('lite:journey-map:target', { itemId: pendingTargetId });
    }
    getLoggingApi().event('journey-map.focus', { url: JOURNEY_MAP_BUILDER_URL });
    return;
  }

  const work = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(TARGET_WIDTH, Math.max(800, work.width - 80));
  const height = Math.min(TARGET_HEIGHT, Math.max(600, work.height - 80));

  win = new BrowserWindow({
    width,
    height,
    title: 'Journey Map Builder',
    backgroundColor: windowBackgroundColor(),
    show: false,
    webPreferences: {
      // A NARROW preload — `window.journeySpaces` only (list / load /
      // save journeys as Space assets, so journeys live in NEON like
      // every other asset). Never `window.lite.*`: the hosted app
      // cannot reach auth, files, settings or arbitrary graph queries.
      preload: join(__dirname, 'preload-journey-map.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      partition: PARTITION,
    },
  });

  // Links out of the app open in the OS browser; this window stays on
  // the Builder rather than becoming an accidental browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const scheme = new URL(url).protocol;
      if (scheme === 'https:' || scheme === 'http:') void shell.openExternal(url);
    } catch {
      /* malformed URL — drop */
    }
    return { action: 'deny' };
  });

  // The preload bridge (`window.journeySpaces`) rides EVERY page this
  // window navigates to — so in-window navigation must stay on the
  // Builder's own deployment. Without this guard a single in-window
  // link would hand read/write on the signed-in user's Spaces to an
  // arbitrary site (2026-08-31 visibility audit). Same policy as
  // popups: foreign http(s) destinations open in the OS browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(JOURNEY_MAP_BUILDER_ORIGIN)) return;
    event.preventDefault();
    try {
      const scheme = new URL(url).protocol;
      if (scheme === 'https:' || scheme === 'http:') void shell.openExternal(url);
    } catch {
      /* malformed URL — drop */
    }
    getLoggingApi().event('journey-map.navigation-blocked', { url: url.slice(0, 120) });
  });

  win.on('closed', () => {
    win = null;
  });
  win.once('ready-to-show', () => {
    win?.show();
  });

  void win.loadURL(JOURNEY_MAP_BUILDER_URL).catch((err: unknown) => {
    getLoggingApi().warn('journey-map', 'Builder failed to load', {
      url: JOURNEY_MAP_BUILDER_URL,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  getLoggingApi().event('journey-map.open', { url: JOURNEY_MAP_BUILDER_URL });
}

/**
 * Registers the one main-side channel the Builder bridge needs beyond
 * the Spaces surface: "which journey did the user click?". Idempotent,
 * so a second boot (or a test re-import) doesn't double-register.
 */
let targetChannelReady = false;
export function registerJourneyMapTargetChannel(): void {
  if (targetChannelReady) return;
  targetChannelReady = true;
  ipcMain.handle('lite:journey-map:takeTarget', () => takeJourneyTarget());
}

/** @internal — test seam / teardown. */
export function closeJourneyMapWindow(): void {
  if (win !== null && !win.isDestroyed()) win.close();
  win = null;
}
