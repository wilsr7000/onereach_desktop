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

import { BrowserWindow, screen, type Rectangle } from 'electron';
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

  void win.loadFile(config.htmlPath);

  // Kick off the async restore; whichever resolves first
  // (`ready-to-show` or the KV read) is the one that gets to position
  // the window. Both paths converge on `centerOrApplyBounds`.
  const loader = config.loadBounds ?? defaultLoadBounds(config.kvApi);
  const saver = config.saveBounds ?? defaultSaveBounds(config.kvApi);

  let restored = false;
  loader()
    .then((saved) => {
      if (win.isDestroyed()) return;
      restored = true;
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
        }
      }
    })
    .catch(() => {
      restored = true;
    });

  win.once('ready-to-show', () => {
    // If the loader hasn't resolved yet we use the centered-on-parent
    // default. When the loader resolves shortly after, it snaps the
    // window into the restored position with a minor re-flow.
    if (!restored) centerOnParent(win, config.parent);
    win.show();
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
  return {
    x: bounds.x,
    y: bounds.y,
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
