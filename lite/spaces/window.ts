/**
 * Spaces window factory.
 *
 * Per ADR-031 + the Settings precedent (`lite/settings/window.ts`),
 * single-instance BrowserWindow:
 *   - parent: mainWindow (glued to the placeholder, not modal)
 *   - Uses the kernel's single preload (`preload-lite.js`) so renderer
 *     code can call `window.lite.spaces.*`
 *   - Loads `spaces.html` from `dist-lite/build/`
 *
 * **Position + size persistence**: bounds are remembered via
 * `lite/kv/` under collection `lite-window-state`, key `spaces`. The
 * window persists its bounds on close, and re-applies them on next
 * open. Save fires on `'close'` and on a debounced `'resize' | 'move'`
 * tail so a crash still captures recent state. KV failures are
 * swallowed -- a missing or corrupt record falls back to the default
 * 1240x820 layout, never surfacing an error to the user.
 *
 * Defaults: 1240 x 820 -- big enough for the three-pane layout
 * (sidebar + main + detail) at MVP densities.
 *
 * @internal -- consumers go through `getSpacesApi()`.
 */

import { BrowserWindow, screen, shell, type Rectangle } from 'electron';
import { getKVApi } from '../kv/api.js';
import type { KVApi } from '../kv/api.js';

const KV_COLLECTION = 'lite-window-state';
const KV_KEY = 'spaces';
const DEFAULT_WIDTH = 1240;
const DEFAULT_HEIGHT = 820;
const MIN_WIDTH = 920;
const MIN_HEIGHT = 600;
/** Debounce window for resize/move tail-saves. Short enough to feel snappy, long enough not to thrash KV. */
const SAVE_DEBOUNCE_MS = 500;
/**
 * How long the window stays hidden waiting to be positioned before it
 * is shown centered anyway. Bounds come from a KV read; if that read is
 * slow or hung, an unshown window looks exactly like a broken one.
 */
const POSITION_TIMEOUT_MS = 1_200;

interface SpacesWindowConfig {
  parent: BrowserWindow | null;
  htmlPath: string;
  preloadPath: string;
  /** Override the KV implementation (tests). */
  kvApi?: KVApi;
  /** Override the saved-bounds loader (tests). */
  loadBounds?: () => Promise<Partial<Rectangle> | null>;
  /** Override the bounds saver (tests). */
  saveBounds?: (bounds: Rectangle) => Promise<void>;
  /**
   * Override the diagnostics sink (tests). Defaults to the central log.
   */
  onDiagnostic?: (level: 'warn' | 'error', message: string, data: Record<string, unknown>) => void;
}

/**
 * Wire renderer failures into the central log.
 *
 * Until this existed, a JS exception in the Spaces renderer produced a
 * blank or half-drawn window and left NO trace anywhere -- not in the
 * main-process log, not in a crash report, not in the event stream.
 * "The Spaces window crashes" was unactionable because the app recorded
 * nothing at all about it.
 *
 * These four handlers live in the MAIN process on purpose: they still
 * fire when the renderer's own JS is dead, which is precisely the case
 * a renderer-side handler cannot cover.
 */
function attachRendererDiagnostics(win: BrowserWindow, config: SpacesWindowConfig): void {
  const emit =
    config.onDiagnostic ??
    ((level, message, data): void => {
      void import('../logging/api.js')
        .then((m) => {
          m.getLoggingApi()[level]('spaces', message, data);
        })
        .catch(() => {
          /* logging must never itself break the window */
        });
    });

  // The renderer process died outright (OOM, native crash, kill).
  win.webContents.on('render-process-gone', (_e, details) => {
    emit('error', 'spaces renderer process gone', {
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });

  // The page is wedged -- an infinite loop or a blocking call.
  win.webContents.on('unresponsive', () => {
    emit('error', 'spaces renderer unresponsive', {});
  });

  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    emit('error', 'spaces window failed to load', { errorCode, errorDescription, validatedURL });
  });

  // Uncaught exceptions and unhandled rejections surface here as
  // console errors even with no renderer-side handler installed, which
  // makes this the catch-all for "it broke and we don't know why".
  win.webContents.on('console-message', (...args: unknown[]) => {
    // Electron changed this signature across majors: older builds pass
    // positional (event, level, message, line, sourceId); newer pass a
    // single details object. Read both so the diagnostic doesn't
    // silently stop working after an Electron bump.
    const first = args[0];
    const details =
      first !== null && typeof first === 'object' && 'message' in first
        ? (first as { level?: unknown; message?: unknown; lineNumber?: unknown; sourceId?: unknown })
        : {
            level: args[1],
            message: args[2],
            lineNumber: args[3],
            sourceId: args[4],
          };
    const level = details.level;
    // Numeric 3 (legacy) or 'error' (modern) both mean error.
    const isError = level === 3 || level === 'error';
    if (!isError) return;
    emit('error', 'spaces renderer console error', {
      text: String(details.message ?? '').slice(0, 2000),
      source: String(details.sourceId ?? ''),
      line: details.lineNumber ?? null,
    });
  });
}

let openWindow: BrowserWindow | null = null;

/**
 * Open (or focus) the Spaces window. Returns the BrowserWindow
 * reference. Idempotent: subsequent calls focus the existing window.
 *
 * On first open this kicks off an async KV read for saved bounds.
 * The window is created with defaults synchronously so we never block
 * the menu callback; saved bounds are applied with `setBounds()` when
 * the read resolves (typically before `ready-to-show`). If the read
 * loses the race with `ready-to-show`, the window snaps once after.
 */
export function createSpacesWindow(config: SpacesWindowConfig): BrowserWindow {
  if (openWindow !== null && !openWindow.isDestroyed()) {
    if (openWindow.isMinimized()) openWindow.restore();
    openWindow.focus();
    return openWindow;
  }

  const win = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    title: 'Spaces',
    backgroundColor: '#0F1115',
    show: false,
    autoHideMenuBar: true,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    ...(config.parent !== null ? { parent: config.parent } : {}),
    webPreferences: {
      preload: config.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  // Route target="_blank" / window.open to the OS browser.
  //
  // This window had NO handler, so Electron's default swallowed the
  // click: the detail pane's "Open PDF" button (an <a target="_blank">
  // pointing at the signed file URL) did nothing at all. Verified from
  // the event log that the upload and the signed-URL resolve both
  // succeeded -- the failure was purely this missing hop. Applies to
  // every external link in the Spaces window, not just PDFs.
  //
  // http(s) only: a signed file URL is https, and refusing everything
  // else keeps `file:` / `javascript:` out of shell.openExternal.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const scheme = new URL(url).protocol;
      if (scheme === 'https:' || scheme === 'http:') {
        void shell.openExternal(url);
      }
    } catch {
      /* unparseable URL -- drop it */
    }
    return { action: 'deny' };
  });

  attachRendererDiagnostics(win, config);

  void win.loadFile(config.htmlPath);

  // Kick off the async restore; whichever resolves first
  // (`ready-to-show` or the KV read) is the one that gets to position
  // the window. Both paths converge on `centerOrApplyBounds`.
  const loader = config.loadBounds ?? defaultLoadBounds(config.kvApi);
  const saver = config.saveBounds ?? defaultSaveBounds(config.kvApi);

  // POSITION BEFORE SHOWING.
  //
  // This used to show the window as soon as `ready-to-show` fired and
  // let the KV read snap it into place afterwards -- described in the
  // old comment as "a minor re-flow". It isn't minor when the saved
  // bounds are on ANOTHER DISPLAY: the window appears centered on the
  // screen you're looking at, then teleports to the other monitor. The
  // user-visible behaviour is "the Spaces window opens, then
  // disappears", which is indistinguishable from a crash and was
  // reported as one.
  //
  // Now the window stays hidden until it has been positioned. A slow
  // or hung KV read must never leave it invisible forever, so a
  // watchdog shows it centered after POSITION_TIMEOUT_MS regardless.
  let readyToShow = false;
  let positioned = false;
  let shown = false;

  const showIfReady = (): void => {
    if (shown || !readyToShow || !positioned || win.isDestroyed()) return;
    shown = true;
    win.show();
  };

  const markPositioned = (): void => {
    if (positioned) return;
    positioned = true;
    showIfReady();
  };

  const positionWatchdog = setTimeout(() => {
    if (win.isDestroyed() || positioned) return;
    centerOnParent(win, config.parent);
    markPositioned();
  }, POSITION_TIMEOUT_MS);

  loader()
    .then((saved) => {
      if (win.isDestroyed()) return;
      // The watchdog already centered + revealed the window — moving
      // it NOW (possibly to another display) is the teleport this
      // path exists to prevent. Late bounds lose.
      if (positioned) return;
      if (saved !== null) {
        // Strict `exactOptionalPropertyTypes` rejects `{ x: undefined }`,
        // so only spread x/y in when they're actually numbers.
        const safeBounds = clampToDisplay({
          width: saved.width ?? DEFAULT_WIDTH,
          height: saved.height ?? DEFAULT_HEIGHT,
          ...(typeof saved.x === 'number' ? { x: saved.x } : {}),
          ...(typeof saved.y === 'number' ? { y: saved.y } : {}),
        });
        try {
          win.setBounds(safeBounds);
        } catch {
          // best-effort -- bad bounds fall back to defaults
          centerOnParent(win, config.parent);
        }
      } else {
        centerOnParent(win, config.parent);
      }
    })
    .catch(() => {
      if (!win.isDestroyed()) centerOnParent(win, config.parent);
    })
    .finally(() => {
      clearTimeout(positionWatchdog);
      markPositioned();
    });

  win.once('ready-to-show', () => {
    readyToShow = true;
    showIfReady();
  });

  // Persist bounds on a debounced trailing edge for resize/move. Calls
  // settle to one write per ~500ms regardless of how many events fire.
  let saveTimer: NodeJS.Timeout | null = null;
  const persistBounds = (): void => {
    if (win.isDestroyed()) return;
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (win.isDestroyed()) return;
      try {
        const bounds = win.getBounds();
        void saver(bounds).catch(() => {
          // swallow KV failures -- next save will retry
        });
      } catch {
        // best-effort
      }
    }, SAVE_DEBOUNCE_MS);
  };
  win.on('resize', persistBounds);
  win.on('move', persistBounds);

  win.on('close', () => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    if (win.isDestroyed()) return;
    try {
      const bounds = win.getBounds();
      // Final save fires synchronously-ish; the underlying KV call is
      // async but Electron lets the event loop drain before the
      // process exits, so we don't need to await here.
      void saver(bounds).catch(() => {
        // swallow KV failures -- the user is closing the window, we're
        // not going to surface an error toast for a missed save.
      });
    } catch {
      // best-effort
    }
  });

  win.on('closed', () => {
    if (openWindow === win) openWindow = null;
  });

  openWindow = win;
  return win;
}

/**
 * Back-compat alias for callers that haven't been updated to the
 * `createSpacesWindow` name yet. The `open*Window` shape predates the
 * Spaces plan's naming pass; both point at the same factory.
 *
 * @deprecated Use `createSpacesWindow` directly.
 */
export const openSpacesWindow = createSpacesWindow;

/** Close the Spaces window if it is open. Idempotent. */
export function closeSpacesWindow(): void {
  if (openWindow !== null && !openWindow.isDestroyed()) {
    openWindow.close();
  }
  openWindow = null;
}

/** @internal -- testing helper */
export function _isSpacesWindowOpenForTesting(): boolean {
  return openWindow !== null && !openWindow.isDestroyed();
}

/** @internal -- testing helper to reset module state between tests. */
export function _resetSpacesWindowForTesting(): void {
  openWindow = null;
}

// ─── KV-backed default bounds loader / saver ────────────────────────────

function defaultLoadBounds(kvOverride?: KVApi): () => Promise<Partial<Rectangle> | null> {
  return async (): Promise<Partial<Rectangle> | null> => {
    const kv = kvOverride ?? getKVApi();
    try {
      const raw = await kv.get(KV_COLLECTION, KV_KEY);
      return parseBounds(raw);
    } catch {
      return null;
    }
  };
}

function defaultSaveBounds(kvOverride?: KVApi): (bounds: Rectangle) => Promise<void> {
  return async (bounds: Rectangle): Promise<void> => {
    const kv = kvOverride ?? getKVApi();
    await kv.set(KV_COLLECTION, KV_KEY, {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    });
  };
}

/**
 * Defensive parser for the saved-bounds blob. Anything that doesn't
 * match `{ x, y, width, height }` with finite-number values is
 * rejected and falls back to defaults.
 */
export function parseBounds(raw: unknown): Partial<Rectangle> | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (k: string): number | undefined => {
    const v = r[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  const out: Partial<Rectangle> = {};
  const w = num('width');
  const h = num('height');
  const x = num('x');
  const y = num('y');
  if (w !== undefined && w >= MIN_WIDTH) out.width = w;
  if (h !== undefined && h >= MIN_HEIGHT) out.height = h;
  if (x !== undefined) out.x = x;
  if (y !== undefined) out.y = y;
  // Width/height are required for a useful restore; x/y can be
  // omitted and the window will center on parent.
  if (out.width === undefined && out.height === undefined) return null;
  return out;
}

/**
 * Clamp a restored bounds rectangle so it always lands at least
 * partly inside an attached display. Saves us from "I unplugged my
 * monitor and now the window is off-screen" footguns.
 */
export function clampToDisplay(
  bounds: { width: number; height: number; x?: number; y?: number },
  displays?: Array<{ bounds: Rectangle }>
): Rectangle {
  const width = Math.max(bounds.width, MIN_WIDTH);
  const height = Math.max(bounds.height, MIN_HEIGHT);
  const all =
    displays ??
    (typeof screen !== 'undefined' && screen.getAllDisplays !== undefined
      ? screen.getAllDisplays()
      : []);
  if (bounds.x === undefined || bounds.y === undefined || all.length === 0) {
    return {
      x: bounds.x ?? 0,
      y: bounds.y ?? 0,
      width,
      height,
    };
  }
  // Check whether at least one corner sits inside any attached display.
  const onScreen = all.some(({ bounds: db }) =>
    bounds.x !== undefined &&
    bounds.y !== undefined &&
    bounds.x + width > db.x &&
    bounds.x < db.x + db.width &&
    bounds.y + height > db.y &&
    bounds.y < db.y + db.height
  );
  if (!onScreen) {
    // Fall back to the primary display's origin so the user can find
    // the window.
    const primary = all[0]?.bounds ?? { x: 0, y: 0, width, height };
    return {
      x: primary.x,
      y: primary.y,
      width,
      height,
    };
  }
  // Overlapping a display is not the same as being USABLE on it. A
  // window restored to a negative y (observed in the wild at y=-21)
  // has its title bar above the top of the screen, tucked behind the
  // macOS menu bar -- visible, but impossible to grab and move back.
  // Push the top edge down onto the host display; never push it up, so
  // a deliberately-placed window keeps its position.
  const host =
    all.find(
      ({ bounds: db }) =>
        bounds.x !== undefined &&
        bounds.y !== undefined &&
        bounds.x + width > db.x &&
        bounds.x < db.x + db.width &&
        bounds.y + height > db.y &&
        bounds.y < db.y + db.height
    )?.bounds ?? all[0]?.bounds;
  const y = host !== undefined ? Math.max(bounds.y, host.y) : bounds.y;
  return {
    x: bounds.x,
    y,
    width,
    height,
  };
}

function centerOnParent(win: BrowserWindow, parent: BrowserWindow | null): void {
  if (parent === null || parent.isDestroyed()) return;
  try {
    const p: Rectangle = parent.getBounds();
    const c: Rectangle = win.getBounds();
    const x = Math.round(p.x + (p.width - c.width) / 2);
    const y = Math.round(p.y + (p.height - c.height) / 2);
    win.setBounds({ x, y, width: c.width, height: c.height });
  } catch {
    // best-effort centering
  }
}
