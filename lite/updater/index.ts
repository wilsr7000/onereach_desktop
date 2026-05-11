/**
 * Onereach Lite Auto-Updater -- orchestration entry point.
 *
 * Wires init -> backups -> check -> lifecycle -> install -> menu in the
 * correct order, exposes IPC handlers for the renderer (window.updater),
 * and returns a teardown function for tests.
 *
 * Called from lite/main-lite.ts inside app.whenReady AFTER:
 *   - The log server has started (so updater logs land in lite's stream)
 *   - initBugReport has registered its IPC + window factory
 *   - seedKernelMenu has registered top:help (so menu-wiring can attach)
 *   - initMenu has subscribed to registry changes (so the new entry renders)
 *
 * verifyUpdateOnStartup MUST be called separately (and earlier in boot)
 * by main-lite.ts before any window opens -- see lite/updater/verify.ts.
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { initAutoUpdater, type AutoUpdaterLike } from './init.js';
import { BackupManager } from './backups.js';
import { createCheckRunner, type CheckRunner } from './check.js';
import { attachLifecycle, type LifecycleHandle, type UpdaterUiSurface } from './lifecycle.js';
import { performUpdateInstall as installPerform } from './install.js';
import { registerUpdaterMenu, unregisterUpdaterMenu } from './menu-wiring.js';
import { readUpdateState } from './state.js';
import { verifyUpdateOnStartup as verifyImpl } from './verify.js';
import type { UpdaterStatusEvent } from './types.js';
import type { Span } from '../logging/events.js';
import { getLoggingApi } from '../logging/api.js';

// Per-module typed event surface (ADR-032). Re-exported here so
// consumers `import { onUpdaterEvent } from '../updater/index.js'`
// without reaching into events.ts directly.
export {
  UPDATER_EVENTS,
  isUpdaterEvent,
  onUpdaterEvent,
  type UpdaterEvent,
  type UpdaterEventName,
  type UpdaterCheckStartEvent,
  type UpdaterCheckFinishEvent,
  type UpdaterCheckFailEvent,
  type UpdaterInstallStartEvent,
  type UpdaterInstallFinishEvent,
  type UpdaterInstallFailEvent,
  type UpdaterIpcCheckEvent,
  type UpdaterIpcInstallEvent,
  type UpdaterIpcGetStateEvent,
} from './events.js';

export const RELEASES_URL = 'https://github.com/wilsr7000/Onereach_Lite_Desktop_App/releases';

export const IPC_CHECK = 'lite:updater:check';
export const IPC_INSTALL = 'lite:updater:install';
export const IPC_GET_STATE = 'lite:updater:get-state';
export const IPC_STATUS_EVENT = 'lite:updater:status';

export interface InitUpdaterModuleOptions {
  /** Logger -- typically the lite log queue's wrapper. */
  logger: {
    info: (msg: string, data?: unknown) => void;
    warn: (msg: string, data?: unknown) => void;
    error: (msg: string, data?: unknown) => void;
    debug?: (msg: string, data?: unknown) => void;
  };
  /**
   * Optional span emitter -- when provided, the long-running ops
   * (`check`, `install`) wrap their work in `updater.<op>.start` /
   * `.finish` / `.fail` spans. ADR-030. main-lite.ts wires this to
   * `getLoggingApi().start()`. Tests can pass a stub or omit.
   */
  spanEmitter?: (name: string, data?: unknown) => Span;
  /** Override electron-updater loader (for tests). */
  loadAutoUpdater?: () => AutoUpdaterLike;
  /** Optional: dev-app-update.yml path injection (for tests). */
  devUpdateConfigPath?: string;
}

export interface UpdaterHandle {
  autoUpdater: AutoUpdaterLike | null;
  backups: BackupManager;
  checkRunner: CheckRunner | null;
  lifecycle: LifecycleHandle | null;
  /** Tear down everything. Idempotent. */
  teardown(): void;
}

/**
 * Boot the updater. Safe to call only once after app.whenReady. Returns a
 * handle whose teardown removes IPC handlers, stops periodic checks, and
 * unregisters the menu entry.
 *
 * If electron-updater fails to load (uncommon -- broken install), this
 * still returns a handle so the kernel doesn't crash; the `Check for
 * Updates...` menu item shows a fallback dialog.
 */
export function initUpdater(opts: InitUpdaterModuleOptions): UpdaterHandle {
  const log = opts.logger;
  const userDataPath = app.getPath('userData');

  const backups = new BackupManager({
    userDataPath,
    logger: (level, message, data) => log[level](`[backups] ${message}`, data),
  });

  const initOpts: Parameters<typeof initAutoUpdater>[0] = { logger: log };
  if (opts.loadAutoUpdater !== undefined) initOpts.loadAutoUpdater = opts.loadAutoUpdater;
  if (opts.devUpdateConfigPath !== undefined) initOpts.devUpdateConfigPath = opts.devUpdateConfigPath;
  const autoUpdater = initAutoUpdater(initOpts);

  if (autoUpdater === null) {
    // Updater unavailable -- still register a menu item so users see a
    // useful fallback dialog instead of silence.
    registerUpdaterMenu({
      onCheckForUpdates: () => {
        void dialog
          .showMessageBox({
            type: 'info',
            title: 'Updates Not Available',
            message: 'Automatic updates are not available in this build',
            detail: 'You can download the latest version manually from our releases page.',
            buttons: ['Download Manually', 'Cancel'],
            defaultId: 0,
          })
          .then((res) => {
            if (res.response === 0) void shell.openExternal(RELEASES_URL);
          });
      },
    });
    return {
      autoUpdater: null,
      backups,
      checkRunner: null,
      lifecycle: null,
      teardown: (): void => {
        unregisterUpdaterMenu();
      },
    };
  }

  // Status emitter: forwards to all renderers via IPC.
  const emitStatus = (event: UpdaterStatusEvent): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send(IPC_STATUS_EVENT, event);
      } catch (err) {
        log.warn('updater: emitStatus send failed', { error: (err as Error).message });
      }
    }
  };

  const ui: UpdaterUiSurface = {
    showMessageBox: async (params) => {
      // Bring lite to the front BEFORE showing the dialog. On macOS,
      // a window-attached dialog becomes a sheet -- if the parent
      // window isn't focused (e.g., behind Cursor / a browser),
      // the sheet renders invisibly and the user thinks the click
      // did nothing. We:
      //   1. Force lite to grab focus from whatever's frontmost.
      //   2. Show + focus the main window if it has one.
      //   3. Pass NO parent to dialog.showMessageBox -- this makes
      //      the dialog application-modal (floating in front of
      //      every window) instead of a window-attached sheet.
      // The combination guarantees the user actually sees the
      // dialog when an update check completes, regardless of what
      // app was frontmost when the periodic / manual check fired.
      try {
        if (process.platform === 'darwin') {
          app.focus({ steal: true });
        } else {
          app.focus();
        }
      } catch {
        /* app.focus() can throw before whenReady; best-effort */
      }
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (win !== undefined && !win.isDestroyed()) {
        try {
          if (win.isMinimized()) win.restore();
          if (!win.isVisible()) win.show();
          win.focus();
        } catch {
          /* window manipulation is best-effort */
        }
      }
      // Pass NO parent so the dialog is free-floating, not a sheet.
      const result = await dialog.showMessageBox(params);
      return { response: result.response };
    },
    openReleasesPage: () => {
      void shell.openExternal(RELEASES_URL);
    },
    setDockBadge: (text) => {
      if (process.platform === 'darwin') {
        try {
          app.dock?.setBadge(text);
        } catch {
          /* dock unavailable in tests */
        }
      }
    },
  };

  const checkRunner = createCheckRunner({
    autoUpdater,
    emitStatus,
    logger: log,
    ...(opts.spanEmitter !== undefined ? { spanEmitter: opts.spanEmitter } : {}),
  });

  const lifecycle = attachLifecycle({
    autoUpdater,
    ui,
    backups,
    getCurrentVersion: () => app.getVersion(),
    performUpdateInstall: async (targetVersion) => {
      // Span the whole install flow (download verify + relaunch).
      // ADR-030.
      const span = opts.spanEmitter?.('updater.install', { targetVersion });
      try {
        await installPerform(
          {
            autoUpdater,
            ui,
            userDataPath,
            isPackaged: () => app.isPackaged,
            destroyAllWindows: () => {
              for (const win of BrowserWindow.getAllWindows()) {
                try {
                  if (!win.isDestroyed()) win.destroy();
                } catch {
                  /* best-effort */
                }
              }
            },
            cancelPeriodicCheck: () => lifecycle.cancelPeriodicCheck(),
            logger: log,
            setUpdatingFlag: (value) => {
              (global as { isUpdatingApp?: boolean }).isUpdatingApp = value;
            },
            // Bypass Squirrel.Mac on macOS 26.4 (see install.ts header).
            // The detached helper waits on our PID and then swaps the
            // bundle; we need to actually quit so it can proceed.
            appQuit: () => app.quit(),
          },
          targetVersion
        );
        span?.finish({ targetVersion });
      } catch (err) {
        span?.fail(err);
        throw err;
      }
    },
    emitStatus,
    getFailedAttemptsForVersion: (version) => {
      const state = readUpdateState(userDataPath);
      return state.lastAttemptVersion === version ? state.failedAttempts ?? 0 : 0;
    },
    isVersionBroken: (version) => {
      // Read on every call so the lifecycle picks up writes from
      // verify.ts on the same boot (e.g., user clicked "Try Again"
      // and the next attempt also failed -- mid-session updates
      // matter). The state file is tiny so the read cost is fine.
      const state = readUpdateState(userDataPath);
      return state.lastFailedVersions.includes(version);
    },
    isPackaged: () => app.isPackaged,
    checkRunner,
    logger: log,
  });

  // Menu entry.
  registerUpdaterMenu({
    onCheckForUpdates: () => {
      // electron-updater's internal `isUpdaterActive()` check returns
      // false when `!app.isPackaged && !forceDevUpdateConfig`. In that
      // state `checkForUpdates()` resolves to null without firing any
      // event, so check.ts's Promise.race resolves cleanly with no
      // dialog -- the click produces zero UI feedback. Surface it
      // explicitly so dev runs aren't silent. The test harness sets
      // forceDevUpdateConfig=true via LITE_DEV_UPDATE_CONFIG and skips
      // this branch.
      if (!app.isPackaged && autoUpdater.forceDevUpdateConfig !== true) {
        void ui
          .showMessageBox({
            type: 'info',
            title: 'Update Checks Disabled in Dev Build',
            message: 'Automatic update checks only run in packaged builds',
            detail:
              'You are running from source. electron-updater suppresses real checks in dev to avoid replacing the dev tree. Open the GitHub releases page to see the latest version, or run a packaged build to test the full flow.',
            buttons: ['Open Releases Page', 'OK'],
            defaultId: 0,
            cancelId: 1,
          })
          .then((res) => {
            if (res.response === 0) void ui.openReleasesPage();
          });
        return;
      }
      void checkRunner.check({ manual: true });
    },
  });

  // IPC handlers for the renderer (window.updater).
  // ADR-030: each emits an `updater.ipc.<verb>` instant event on entry.
  ipcMain.handle(IPC_CHECK, async (_event, params: { manual?: boolean } = {}) => {
    getLoggingApi().event('updater.ipc.check', { manual: params.manual ?? true });
    return checkRunner.check({ manual: params.manual ?? true });
  });

  // In-flight guard. Once installPerform starts, the process is
  // committed: it writes lastAttemptVersion, destroys windows, and
  // hands off to Squirrel.Mac which schedules process exit. A second
  // concurrent IPC_INSTALL (e.g., user double-clicks "Install and
  // Restart", or two windows fire it) would race two quitAndInstall()
  // calls -- behavior is undefined under Squirrel and the 10s safety
  // net would force-exit anyway. Cleaner to refuse the second call.
  let installInFlight = false;

  ipcMain.handle(IPC_INSTALL, async () => {
    if (installInFlight) {
      getLoggingApi().event('updater.ipc.install', { rejected: 'already-in-flight' });
      log.warn('updater: install already in flight -- ignoring duplicate IPC_INSTALL');
      return { attempted: false, targetVersion: null, reason: 'already-in-flight' };
    }
    installInFlight = true;
    getLoggingApi().event('updater.ipc.install');
    const last = lifecycle.getLastDownloadedUpdate();
    const targetVersion = last !== null ? last.version : null;
    try {
      await installPerform(
        {
          autoUpdater,
          ui,
          userDataPath,
          isPackaged: () => app.isPackaged,
          destroyAllWindows: () => {
            for (const win of BrowserWindow.getAllWindows()) {
              try {
                if (!win.isDestroyed()) win.destroy();
              } catch {
                /* best-effort */
              }
            }
          },
          cancelPeriodicCheck: () => lifecycle.cancelPeriodicCheck(),
          logger: log,
          setUpdatingFlag: (value) => {
            (global as { isUpdatingApp?: boolean }).isUpdatingApp = value;
          },
          // Bypass Squirrel.Mac on macOS 26.4 (see install.ts header).
          // The detached helper waits on our PID and then swaps the
          // bundle; we need to actually quit so it can proceed.
          appQuit: () => app.quit(),
        },
        targetVersion
      );
      return { attempted: true, targetVersion };
    } catch (err) {
      // installPerform threw before quitAndInstall could schedule exit
      // (e.g., bundle-writability pre-flight refused). Reset the flag
      // so a subsequent attempt isn't blocked by stale state.
      installInFlight = false;
      log.error('updater: installPerform threw', { error: (err as Error).message });
      throw err;
    }
  });

  ipcMain.handle(IPC_GET_STATE, async () => {
    getLoggingApi().event('updater.ipc.get-state');
    return readUpdateState(userDataPath);
  });

  log.info('updater: initialized');

  let tornDown = false;
  return {
    autoUpdater,
    backups,
    checkRunner,
    lifecycle,
    teardown: (): void => {
      if (tornDown) return;
      tornDown = true;
      try {
        lifecycle.teardown();
      } catch {
        /* best-effort */
      }
      unregisterUpdaterMenu();
      ipcMain.removeHandler(IPC_CHECK);
      ipcMain.removeHandler(IPC_INSTALL);
      ipcMain.removeHandler(IPC_GET_STATE);
    },
  };
}

/**
 * Boot-time verification step. Call BEFORE creating any windows.
 * Returns a promise that resolves once any failure dialog has been
 * dismissed (or immediately if there's no prior failed attempt).
 */
export async function verifyUpdateOnStartup(opts: {
  logger: { info: (msg: string, data?: unknown) => void; warn: (msg: string, data?: unknown) => void };
  /** Optional override for tests. */
  triggerCheckImpl?: () => void | Promise<void>;
}): Promise<ReturnType<typeof verifyImpl>> {
  return verifyImpl({
    userDataPath: app.getPath('userData'),
    currentVersion: app.getVersion(),
    openReleasesPage: () => {
      void shell.openExternal(RELEASES_URL);
    },
    triggerCheck: opts.triggerCheckImpl ?? ((): void => {
      /* updater not yet initialized -- user can re-trigger via menu */
    }),
    dialogs: {
      showFailureDialog: async (params) => {
        const result = await dialog.showMessageBox({
          type: 'warning',
          title: params.title,
          message: params.message,
          detail: params.detail,
          buttons: [...params.buttons],
          defaultId: params.defaultId,
        });
        const r = result.response;
        if (r === 0 || r === 1 || r === 2) return r;
        return 2;
      },
    },
    logger: opts.logger,
  });
}

export const UPDATER_IPC = {
  check: IPC_CHECK,
  install: IPC_INSTALL,
  getState: IPC_GET_STATE,
  statusEvent: IPC_STATUS_EVENT,
};
