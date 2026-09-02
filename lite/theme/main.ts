/**
 * Appearance — main-process side.
 *
 * ONE mechanism themes every window: the stored preference becomes
 * `nativeTheme.themeSource`, and Chromium then answers
 * `prefers-color-scheme` accordingly in every renderer, live. Each
 * stylesheet defines its light tokens on `:root` and its dark tokens
 * under `@media (prefers-color-scheme: dark)` (see lite/signature.css),
 * so no window needs an IPC round-trip or a `data-theme` attribute —
 * a change in Settings repaints everything at once, and native
 * surfaces (dialogs, menus, the traffic-light chrome) follow too.
 *
 * The one thing CSS cannot cover is the BrowserWindow `backgroundColor`
 * painted before first render and during resizes; `windowBackgroundColor()`
 * gives every window factory the right one, and an `updated` listener
 * re-paints the live windows so a theme switch never shows a flash of
 * the other palette on the next resize.
 */

import { BrowserWindow, ipcMain, nativeTheme, type IpcMainInvokeEvent } from 'electron';
import { getLoggingApi } from '../logging/api.js';
import { wrapIpcHandler } from '../errors.js';
import { readTheme, writeTheme, type ThemePreference, type ThemeState } from './store.js';

export const THEME_IPC = {
  GET: 'lite:theme:get',
  SET: 'lite:theme:set',
} as const;

const IPC_ERROR_MARKER = '__themeError';

/**
 * Window chrome backgrounds. The dark value is the canvas every lite
 * window has always used; the light value matches `--or-bg-canvas` in
 * signature.css's light block. Keep these in sync with the stylesheet.
 */
export const DARK_WINDOW_BACKGROUND = '#0e0e10';
export const LIGHT_WINDOW_BACKGROUND = '#f4f5f7';

/**
 * The `backgroundColor` a BrowserWindow should be created with right
 * now. Fails to light (the default theme) when `nativeTheme` is
 * unavailable — unit tests mock `electron` without it, and a factory
 * must never throw over a paint hint.
 */
export function windowBackgroundColor(): string {
  try {
    return nativeTheme.shouldUseDarkColors ? DARK_WINDOW_BACKGROUND : LIGHT_WINDOW_BACKGROUND;
  } catch {
    return LIGHT_WINDOW_BACKGROUND;
  }
}

export interface ThemeHandle {
  /** The preference as last read/written (not the effective OS answer). */
  getState(): ThemeState;
  /** Persist + apply; rejects unknown values. */
  set(preference: ThemePreference | null): Promise<ThemeState>;
  teardown(): void;
}

function applyPreference(preference: ThemePreference): void {
  nativeTheme.themeSource = preference;
}

function repaintLiveWindows(): void {
  try {
    const color = windowBackgroundColor();
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.setBackgroundColor(color);
    }
  } catch {
    /* paint hint only */
  }
}

let registered = false;

/**
 * Read the stored preference and apply it. Call BEFORE the first window
 * is created so first paint, every dialog and every menu already use it.
 */
export async function initTheme(): Promise<ThemeHandle> {
  let state = await readTheme();
  applyPreference(state.preference);
  getLoggingApi().info('theme', 'appearance applied', {
    preference: state.preference,
    isDefault: state.isDefault,
    effective: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
  });

  const set = async (preference: ThemePreference | null): Promise<ThemeState> => {
    state = await writeTheme(preference);
    applyPreference(state.preference);
    repaintLiveWindows();
    getLoggingApi().info('theme', 'appearance changed', {
      preference: state.preference,
      effective: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    });
    return state;
  };

  const onUpdated = (): void => repaintLiveWindows();

  if (!registered) {
    registered = true;
    ipcMain.handle(
      THEME_IPC.GET,
      wrapIpcHandler(IPC_ERROR_MARKER, async (): Promise<ThemeState> => state)
    );
    ipcMain.handle(
      THEME_IPC.SET,
      wrapIpcHandler(IPC_ERROR_MARKER, async (_event: IpcMainInvokeEvent, payload: unknown) => {
        const raw = (payload as { preference?: unknown })?.preference;
        // null resets to the default; anything else must validate.
        return set(raw === null ? null : (raw as ThemePreference));
      })
    );
    nativeTheme.on('updated', onUpdated);
  }

  return {
    getState: () => state,
    set,
    teardown: () => {
      if (!registered) return;
      registered = false;
      ipcMain.removeHandler(THEME_IPC.GET);
      ipcMain.removeHandler(THEME_IPC.SET);
      try {
        nativeTheme.removeListener('updated', onUpdated);
      } catch {
        /* mock without an emitter */
      }
    },
  };
}
