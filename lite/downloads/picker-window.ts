/**
 * Space-picker BrowserWindow factory + lifecycle.
 *
 * Spawns a small dedicated window (`download-picker.html`) when a
 * download is destined for a Space. The picker:
 *   1. Loads with the `?dl=<id>` query parameter so the renderer can
 *      look up its bootstrap payload via IPC.
 *   2. Calls back through `lite:download-picker:bootstrap` to fetch
 *      the spaces list + captured-file metadata.
 *   3. Resolves through `lite:download-picker:resolve` with either the
 *      chosen spaceId/name or `null` for cancel.
 *
 * One picker at a time. Subsequent downloads queue at the orchestrator
 * level (see `handler.ts`); this module is single-instance for
 * simplicity.
 *
 * @internal -- consumers go through `lite/downloads/api.ts` and
 * `handler.ts`.
 */

import { BrowserWindow, type Rectangle } from 'electron';
import type { PickerBootstrap, PickerResult } from './types.js';
import { windowBackgroundColor } from '../theme/main.js';

interface OpenPickerOptions {
  parent: BrowserWindow | null;
  htmlPath: string;
  preloadPath: string;
  /** Per-download id; appears in `?dl=` so the renderer knows what to fetch. */
  downloadId: string;
}

/** Promise resolvers tracked per open picker. Settled by `resolvePicker`. */
const pending = new Map<
  string,
  {
    resolve: (result: PickerResult | null) => void;
    bootstrap: PickerBootstrap;
  }
>();

let activeWindow: BrowserWindow | null = null;

/**
 * Open the picker window for a captured download. Returns a Promise
 * that resolves with the user's choice (Space id + name) or `null` if
 * they cancelled (closed the window, hit Escape, clicked Cancel).
 *
 * Caller must arrange to feed the picker's bootstrap fetch via the
 * IPC handler in `ipc.ts` -- the bootstrap is stashed under the
 * download id at picker-creation time.
 */
export async function openSpacePicker(
  opts: OpenPickerOptions,
  bootstrap: PickerBootstrap
): Promise<PickerResult | null> {
  // Single-instance: if a picker is open, focus it and reject the new
  // capture (the orchestrator queues at its level).
  if (activeWindow !== null && !activeWindow.isDestroyed()) {
    try {
      activeWindow.focus();
    } catch {
      /* best-effort */
    }
    return null;
  }

  const win = new BrowserWindow({
    width: 420,
    height: 540,
    minWidth: 360,
    minHeight: 420,
    title: 'Save to Space',
    backgroundColor: windowBackgroundColor(),
    show: false,
    autoHideMenuBar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    ...(opts.parent !== null ? { parent: opts.parent } : {}),
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  void win.loadFile(opts.htmlPath, { query: { dl: opts.downloadId } });

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) {
      win.show();
      centerOnParent(win, opts.parent);
    }
  });

  activeWindow = win;

  return new Promise<PickerResult | null>((resolve) => {
    pending.set(opts.downloadId, { resolve, bootstrap });

    win.on('closed', () => {
      // If the picker closes before a resolution arrived, treat it as
      // a cancel so the caller's promise never hangs.
      const entry = pending.get(opts.downloadId);
      if (entry !== undefined) {
        pending.delete(opts.downloadId);
        entry.resolve(null);
      }
      if (activeWindow === win) activeWindow = null;
    });
  });
}

/**
 * Look up the bootstrap payload stashed for a download id. The IPC
 * handler calls this from the `bootstrap` channel to hand the picker
 * its initial render data.
 */
export function readBootstrap(downloadId: string): PickerBootstrap | null {
  const entry = pending.get(downloadId);
  return entry === undefined ? null : entry.bootstrap;
}

/**
 * Resolve a pending picker with the user's choice. Called from the IPC
 * handler when the renderer fires the `resolve` channel.
 */
export function resolvePicker(
  downloadId: string,
  result: PickerResult | null
): void {
  const entry = pending.get(downloadId);
  if (entry === undefined) return;
  pending.delete(downloadId);
  entry.resolve(result);
  // Close the window after a resolution so the renderer never has to
  // worry about leaking a window on a successful path.
  if (activeWindow !== null && !activeWindow.isDestroyed()) {
    try {
      activeWindow.close();
    } catch {
      /* best-effort */
    }
  }
  activeWindow = null;
}

/** @internal -- for tests. */
export function _hasActivePickerForTesting(): boolean {
  return activeWindow !== null && !activeWindow.isDestroyed();
}

/** @internal -- for tests. */
export function _resetPickerForTesting(): void {
  if (activeWindow !== null && !activeWindow.isDestroyed()) {
    try {
      activeWindow.destroy();
    } catch {
      /* ignore */
    }
  }
  activeWindow = null;
  pending.clear();
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
    /* best-effort centering */
  }
}
