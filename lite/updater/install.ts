/**
 * Onereach Lite Auto-Updater -- install orchestration.
 *
 * The actual install path on macOS delegates to Squirrel.Mac/ShipIt via
 * autoUpdater.quitAndInstall(). Our work:
 *   1. Pre-flight: assert we can write the .app bundle (and its parent).
 *   2. Persist the target version so verify.ts can detect failed installs.
 *   3. Stop periodic check timer.
 *   4. Run save-state hooks within budget.
 *   5. Call autoUpdater.quitAndInstall() -- Squirrel.Mac handles windows + quit.
 *   6. 10s safety net: process.exit(0) if we're still alive.
 *
 * Borrowed pattern: main.js _checkAppBundleWritable + performUpdateInstall
 * (lines 17120-17302).
 *
 * IMPORTANT: do NOT call destroyAllWindows() before quitAndInstall().
 * That triggers `window-all-closed` -> `app.quit()` which starts a normal
 * shutdown in parallel with Squirrel.Mac's relaunch handoff. The two race,
 * `app.quit()` wins, the process exits cleanly, ShipIt never gets the
 * relaunch signal, and the user is left with the old bundle in /Applications.
 * Squirrel.Mac's nativeUpdater.quitAndInstall() already closes all windows
 * and calls app.quit() in the correct order (see main.js#L17283-L17286).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AutoUpdaterLike } from './init.js';
import { writeUpdateState, readUpdateState } from './state.js';
import { saveStateBeforeUpdate } from './save-state.js';
import type { UpdaterUiSurface } from './lifecycle.js';

const SAFETY_NET_MS = 10_000;

export interface InstallDeps {
  autoUpdater: AutoUpdaterLike;
  ui: UpdaterUiSurface;
  /** Lite's userData path -- update-state.json lives here. */
  userDataPath: string;
  /** Process.execPath equivalent. Defaults to process.execPath. */
  execPath?: string;
  /** True iff the app is packaged. Skips writability check in dev. */
  isPackaged: () => boolean;
  /**
   * Force-close all BrowserWindows. NO LONGER CALLED -- preserved on the
   * interface for backwards compatibility with existing call sites, but the
   * production install flow skips it (Squirrel.Mac closes windows itself).
   * Tests may still observe it as unused.
   */
  destroyAllWindows: () => void;
  /** Optional: stop the periodic check interval. Tests pass a no-op. */
  cancelPeriodicCheck?: () => void;
  /** Logger -- defaults to silent. */
  logger?: {
    info: (msg: string, data?: unknown) => void;
    warn: (msg: string, data?: unknown) => void;
    error: (msg: string, data?: unknown) => void;
  };
  /**
   * Hook for the safety-net process exit. Tests pass a spy that does NOT
   * actually exit the test process. Defaults to process.exit(0).
   */
  forceExit?: () => void;
  /**
   * Cosmetic flag set on global so other modules can suppress before-quit
   * cleanup that would otherwise block ShipIt. Defaults to a no-op.
   */
  setUpdatingFlag?: (value: boolean) => void;
}

export interface InstallResult {
  /** True if install was attempted. False if pre-flight refused. */
  attempted: boolean;
  /** Why we bailed out, if attempted is false. */
  refusalReason?: 'bundle-not-writable' | 'autoupdater-missing';
  /** Time spent in the save-state phase. */
  saveStateMs?: number;
}

/**
 * macOS-only writability pre-flight. Returns true if the .app and its
 * parent are writable, false otherwise (a dialog is shown to the user
 * with a Download Manually button).
 */
export async function checkAppBundleWritable(deps: InstallDeps): Promise<boolean> {
  if (process.platform !== 'darwin' || !deps.isPackaged()) return true;
  const log = deps.logger ?? { info: () => {}, warn: () => {}, error: () => {} };
  try {
    const exec = deps.execPath ?? process.execPath;
    const appPath = path.dirname(path.dirname(exec)); // .../Onereach.ai Lite.app
    fs.accessSync(appPath, fs.constants.W_OK);
    fs.accessSync(path.dirname(appPath), fs.constants.W_OK);
    return true;
  } catch (err) {
    log.warn('updater: bundle not writable', { error: (err as Error).message });
    const res = await deps.ui.showMessageBox({
      type: 'error',
      title: 'Cannot Install Update',
      message: "The app can't write to its own location",
      detail:
        "The auto-updater needs to replace the app bundle in /Applications, but it's not writable by your user account.\n\nPlease download and install the update manually.",
      buttons: ['Download Manually', 'Cancel'],
      defaultId: 0,
    });
    if (res.response === 0) {
      await deps.ui.openReleasesPage();
    }
    return false;
  }
}

/**
 * Orchestrate the install. Resolves once quitAndInstall has been called
 * (or pre-flight has refused) -- the actual process exit happens on the
 * Electron event loop after this returns.
 */
export async function performUpdateInstall(
  deps: InstallDeps,
  targetVersion: string | null
): Promise<InstallResult> {
  const log = deps.logger ?? { info: () => {}, warn: () => {}, error: () => {} };
  log.info('updater: performUpdateInstall begin', { targetVersion });

  if (!(await checkAppBundleWritable(deps))) {
    return { attempted: false, refusalReason: 'bundle-not-writable' };
  }

  deps.setUpdatingFlag?.(true);

  if (targetVersion !== null) {
    const state = readUpdateState(deps.userDataPath);
    state.lastAttemptVersion = targetVersion;
    state.lastAttemptTime = new Date().toISOString();
    writeUpdateState(deps.userDataPath, state);
  }

  deps.cancelPeriodicCheck?.();

  let saveStateMs: number | undefined;
  try {
    const result = await saveStateBeforeUpdate({ logger: log });
    saveStateMs = result.elapsedMs;
  } catch (err) {
    log.warn('updater: save-state phase threw', { error: (err as Error).message });
  }

  // Do NOT call destroyAllWindows here -- see file header. Squirrel.Mac's
  // nativeUpdater.quitAndInstall() will close all windows and call app.quit()
  // in the correct order. Destroying windows ourselves races with that flow
  // and ends with the process exiting via window-all-closed before Squirrel
  // can register the relaunch.
  try {
    log.info('updater: calling autoUpdater.quitAndInstall()');
    deps.autoUpdater.quitAndInstall();
  } catch (err) {
    log.error('updater: quitAndInstall threw', { error: (err as Error).message });
  }

  // Safety net: if we're still alive after 10s, the graceful quit failed.
  const forceExit = deps.forceExit ?? ((): void => {
    process.exit(0);
  });
  setTimeout(() => {
    log.warn('updater: safety-net force-exit firing');
    forceExit();
  }, SAFETY_NET_MS).unref();

  return { attempted: true, ...(saveStateMs !== undefined ? { saveStateMs } : {}) };
}
