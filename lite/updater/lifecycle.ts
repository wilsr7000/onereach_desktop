/**
 * Onereach Lite Auto-Updater -- electron-updater event handlers + dialogs.
 *
 * Attaches the standard electron-updater event handlers (checking-for-update,
 * update-available, update-not-available, error, download-progress,
 * update-downloaded) and translates each into:
 *   1. A status IPC event for the renderer (window.updater.onStatus)
 *   2. A user-facing modal dialog (showMessageBox) where appropriate
 *   3. A backup creation step on update-downloaded (per ADR-020)
 *
 * Also runs the periodic background check (every 6 hours when packaged).
 *
 * Borrowed pattern: main.js setupAutoUpdater (lines 16806-16988). Dialog
 * copy and button order preserved verbatim so users see the same UX.
 *
 * The Electron-side imports (dialog / shell / app) are abstracted via a
 * UI surface so unit tests can mock them.
 */

import type { AutoUpdaterLike } from './init.js';
import type { BackupManager } from './backups.js';
import type { CheckRunner } from './check.js';
import type { UpdaterInfo, UpdaterStatusEvent } from './types.js';

/**
 * Once a day. The previous 6-hour cadence ran four times per workday;
 * users who keep Lite open across multiple days don't need that
 * frequency, and a 24h cadence cuts background traffic to the
 * publish feed by 4x without changing the "user always sees the new
 * version within a day of release" guarantee.
 */
export const PERIODIC_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Delay before the deferred boot-time check fires. Matches the full
 * app pattern at `main.js:1850`. Long enough that the user's first
 * meaningful interaction isn't blocked by network I/O on a slow
 * connection, short enough that an update is offered while they're
 * still focused on the app.
 *
 * Without this hook, Lite never checked at boot -- the periodic
 * interval was the only trigger, so a user who launched and quit
 * within 24h would never see an update prompt.
 */
export const STARTUP_CHECK_DELAY_MS = 5_000;

export interface DialogResult {
  response: number;
}

/**
 * Surface for the user-facing parts of the lifecycle. Lets tests inject
 * mocks for dialog.showMessageBox + shell.openExternal + dock badge.
 */
export interface UpdaterUiSurface {
  showMessageBox: (opts: {
    type: 'info' | 'warning' | 'error';
    title: string;
    message: string;
    detail?: string;
    buttons: string[];
    defaultId?: number;
    cancelId?: number;
  }) => Promise<DialogResult>;
  openReleasesPage: () => void | Promise<void>;
  /** dock badge ('25%') -- macOS only; no-op on other platforms. */
  setDockBadge?: (text: string) => void;
}

export interface DownloadInfo {
  /** version of the downloaded update */
  version: string;
  /** True if a backup was created before install attempt. */
  backupCreated: boolean;
  /** Currently running version when the download landed. */
  currentVersion: string;
}

export interface LifecycleDeps {
  autoUpdater: AutoUpdaterLike;
  ui: UpdaterUiSurface;
  backups: BackupManager;
  /** Read by lifecycle to compose dialog text. Typically app.getVersion(). */
  getCurrentVersion: () => string;
  /** Triggered by user clicking "Install and Restart". */
  performUpdateInstall: (targetVersion: string | null) => void | Promise<void>;
  /** Status emitter -- propagates to renderer. */
  emitStatus: (event: UpdaterStatusEvent) => void;
  /**
   * Read prior failed-attempt count for this version so the
   * update-downloaded dialog can adjust its copy.
   */
  getFailedAttemptsForVersion: (version: string) => number;
  /**
   * Whether this version has hit the broken-version threshold and
   * should be suppressed from auto-install. Read from the
   * `lastFailedVersions` field of `update-state.json`. When true the
   * lifecycle skips the auto-prompt and steers the user to the
   * manual-download path. ADR-030 / verify.ts.
   */
  isVersionBroken: (version: string) => boolean;
  /** Periodic check -- only fires when packaged. */
  isPackaged: () => boolean;
  /** Trigger a check (used by error-with-Retry path). */
  checkRunner: CheckRunner;
  logger?: {
    info: (msg: string, data?: unknown) => void;
    warn: (msg: string, data?: unknown) => void;
    error: (msg: string, data?: unknown) => void;
  };
}

export interface LifecycleHandle {
  /** Stop periodic checks + remove all event listeners. For teardown. */
  teardown(): void;
  /**
   * Stop ONLY the periodic background-check interval, without
   * removing any autoUpdater listeners. The install flow calls this
   * pre-`quitAndInstall` so the timer doesn't fire mid-handoff; the
   * full `teardown()` would also strip every listener off the
   * autoUpdater EventEmitter, which can confuse electron-updater's
   * Squirrel.Mac driver while the install is in progress.
   */
  cancelPeriodicCheck(): void;
  /** The current download tracking, if any. */
  getLastDownloadedUpdate(): { version: string; info: UpdaterInfo } | null;
}

/**
 * Attach all event handlers. Returns a handle for teardown.
 */
export function attachLifecycle(deps: LifecycleDeps): LifecycleHandle {
  const log = deps.logger ?? { info: () => {}, warn: () => {}, error: () => {} };
  let lastDownloaded: { version: string; info: UpdaterInfo } | null = null;
  let intervalHandle: ReturnType<typeof setInterval> | null = null;

  // Auto-recovery: one automatic re-download per version on checksum
  // failure. Most checksum mismatches are transient (CDN flake, partial
  // download) and resolve on retry. Tracked per-version so a different
  // failing version doesn't inherit the spent attempt.
  const checksumRetryAttempted = new Set<string>();

  // ------------------------------------------------------------------
  // checking-for-update
  // ------------------------------------------------------------------
  deps.autoUpdater.on('checking-for-update', () => {
    log.info('updater: checking-for-update');
    deps.emitStatus({ status: 'checking' });
  });

  // ------------------------------------------------------------------
  // update-available
  // ------------------------------------------------------------------
  deps.autoUpdater.on('update-available', (info: unknown) => {
    const updateInfo = info as UpdaterInfo;
    log.info('updater: update-available', { version: updateInfo.version });
    deps.emitStatus({ status: 'available', info: updateInfo });

    // Auto-recovery: if this version has been marked broken (3+
    // consecutive failed install attempts -- see verify.ts), skip the
    // auto-prompt entirely. Steer the user to the manual download.
    // The next DIFFERENT version released will retry auto-update
    // automatically because broken-versions only suppresses the
    // version that failed.
    if (deps.isVersionBroken(updateInfo.version)) {
      log.warn('updater: update-available for broken version -- suppressing auto-prompt', {
        version: updateInfo.version,
      });
      void deps.ui
        .showMessageBox({
          type: 'warning',
          title: 'Update Available (Manual Install Required)',
          message: `Version ${updateInfo.version} is available, but auto-install previously failed on this Mac.`,
          detail:
            `Lite has stopped trying to install v${updateInfo.version} automatically. ` +
            `You can download it manually from the releases page. The next different version ` +
            `released will retry auto-update automatically.`,
          buttons: ['Download Manually', 'Later'],
          defaultId: 0,
        })
        .then((res) => {
          if (res.response === 0) {
            void deps.ui.openReleasesPage();
          }
        });
      return;
    }

    void deps.ui
      .showMessageBox({
        type: 'info',
        title: 'Update Available',
        message: `A new version (${updateInfo.version}) is available`,
        detail: `Current version: ${deps.getCurrentVersion()}\nNew version: ${updateInfo.version}\n\nWould you like to download it now?`,
        buttons: ['Download', 'Later'],
        defaultId: 0,
      })
      .then((res) => {
        if (res.response === 0) {
          deps.emitStatus({ status: 'downloading' });
          deps.autoUpdater.downloadUpdate().catch((err: unknown) => {
            log.error('updater: downloadUpdate failed', { error: (err as Error).message });
            deps.emitStatus({ status: 'error', info: { error: (err as Error).message } });
          });
        }
      });
  });

  // ------------------------------------------------------------------
  // update-not-available
  // ------------------------------------------------------------------
  deps.autoUpdater.on('update-not-available', (info: unknown) => {
    log.info('updater: update-not-available');
    deps.emitStatus({ status: 'not-available', info });
    if (deps.checkRunner.wasLastManual()) {
      void deps.ui.showMessageBox({
        type: 'info',
        title: 'No Updates Available',
        message: 'You are running the latest version',
        detail: `Current version: ${deps.getCurrentVersion()}`,
        buttons: ['OK'],
      });
    }
  });

  // ------------------------------------------------------------------
  // error
  // ------------------------------------------------------------------
  deps.autoUpdater.on('error', (err: unknown) => {
    const raw = (err as Error).message ?? 'Unknown error';
    let errorMessage = raw;
    if (raw.includes('ERR_CONNECTION_REFUSED') || raw.includes('ENOTFOUND')) {
      errorMessage = 'Cannot connect to update server. Please check your internet connection.';
    } else if (raw.includes('net::ERR_INTERNET_DISCONNECTED')) {
      errorMessage = 'No internet connection available.';
    } else if (raw.includes('404') || raw.includes('Not Found')) {
      errorMessage = 'Update information not found on server.';
    } else if (raw.includes('sha512 checksum mismatch')) {
      errorMessage = 'Downloaded update failed integrity check. Please try again.';
    }

    // Auto-recovery: checksum mismatch is most often a transient CDN
    // hiccup or a partial-download artifact. Try the download once
    // more before surfacing the error to the user. Tracked per-version
    // via `checksumRetryAttempted`; a second failure on the same
    // version falls through to the user-facing dialog.
    if (raw.includes('sha512 checksum mismatch')) {
      const target = lastDownloaded?.version ?? 'unknown';
      if (!checksumRetryAttempted.has(target)) {
        checksumRetryAttempted.add(target);
        log.warn('updater: checksum mismatch -- retrying download once', { version: target });
        deps.emitStatus({ status: 'downloading' });
        deps.autoUpdater.downloadUpdate().catch((retryErr: unknown) => {
          log.error('updater: re-download after checksum mismatch failed', {
            error: (retryErr as Error).message,
          });
          deps.emitStatus({ status: 'error', info: { error: (retryErr as Error).message } });
        });
        return;
      }
      log.error('updater: checksum mismatch persists after retry', { version: target });
    }

    log.error('updater: error', { error: errorMessage, raw });
    deps.emitStatus({ status: 'error', info: { error: errorMessage } });

    if (deps.checkRunner.wasLastManual()) {
      void deps.ui
        .showMessageBox({
          type: 'warning',
          title: 'Update Check Failed',
          message: 'Could not check for updates',
          detail: errorMessage,
          buttons: ['Download Manually', 'Try Again Later'],
          defaultId: 1,
        })
        .then((res) => {
          if (res.response === 0) {
            void deps.ui.openReleasesPage();
          }
        });
    }
  });

  // ------------------------------------------------------------------
  // download-progress
  // ------------------------------------------------------------------
  deps.autoUpdater.on('download-progress', (progress: unknown) => {
    const p = progress as { percent?: number };
    const pct = Math.round(p.percent ?? 0);
    deps.emitStatus({ status: 'progress', info: progress });
    if (process.platform === 'darwin' && deps.ui.setDockBadge !== undefined) {
      deps.ui.setDockBadge(`${pct}%`);
    }
  });

  // ------------------------------------------------------------------
  // update-downloaded
  // ------------------------------------------------------------------
  deps.autoUpdater.on('update-downloaded', (info: unknown) => {
    const updateInfo = info as UpdaterInfo;
    log.info('updater: update-downloaded', { version: updateInfo.version });
    lastDownloaded = { version: updateInfo.version, info: updateInfo };

    if (process.platform === 'darwin' && deps.ui.setDockBadge !== undefined) {
      deps.ui.setDockBadge('');
    }

    void (async () => {
      const currentVersion = deps.getCurrentVersion();
      let backupCreated = false;
      try {
        backupCreated = await deps.backups.createBackup(currentVersion);
      } catch (err) {
        log.error('updater: backup failed', { error: (err as Error).message });
      }
      deps.emitStatus({
        status: 'downloaded',
        info: { ...updateInfo, backupCreated, currentVersion } satisfies DownloadInfo & UpdaterInfo,
      });

      const prevFailures = deps.getFailedAttemptsForVersion(updateInfo.version);
      const detailText =
        prevFailures > 0
          ? `A previous automatic install of v${updateInfo.version} did not succeed.\nYou can try again or download manually if the issue persists.`
          : 'The application will restart to apply the update. Your settings and data will be preserved.';
      const buttons =
        prevFailures > 0
          ? ['Install and Restart', 'Download Manually', 'Later']
          : ['Install and Restart', 'Install Later'];

      const res = await deps.ui.showMessageBox({
        type: 'info',
        title: 'Update Ready to Install',
        message: `Version ${updateInfo.version} has been downloaded`,
        detail: detailText,
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
      });

      if (res.response === 0) {
        await deps.performUpdateInstall(updateInfo.version);
      } else if (prevFailures > 0 && res.response === 1) {
        await deps.ui.openReleasesPage();
      }
    })();
  });

  // Deferred boot-time silent check. Without this, Lite has no
  // trigger to check for updates until the periodic interval (now
  // 24h, see PERIODIC_CHECK_INTERVAL_MS) -- so a user who launches
  // and quits within a day would never be offered an update. Matches
  // the full app's pattern (`main.js:1850`). Gated on isPackaged so
  // dev runs aren't spammed; `manual:false` keeps it silent (no
  // "no updates available" dialog when the user is up to date).
  //
  // We hold the timer handle on a separate variable from
  // `intervalHandle` (which tracks the periodic check) so the
  // narrow `cancelPeriodicCheck()` can clear both without removing
  // event listeners.
  const startupTimer = setTimeout(() => {
    if (deps.isPackaged() && !deps.checkRunner.isCheckInFlight()) {
      log.info('updater: startup check');
      void deps.checkRunner.check({ manual: false });
    }
  }, STARTUP_CHECK_DELAY_MS);
  // `unref` so the timer doesn't keep the event loop alive if the
  // process is otherwise idle on a unit-test path.
  startupTimer.unref?.();

  // Periodic background check (only when packaged). Fires once every
  // 24 hours after the startup check.
  intervalHandle = setInterval(() => {
    if (deps.isPackaged() && !deps.checkRunner.isCheckInFlight()) {
      log.info('updater: periodic check');
      void deps.checkRunner.check({ manual: false });
    }
  }, PERIODIC_CHECK_INTERVAL_MS);

  return {
    teardown(): void {
      if (intervalHandle !== null) clearInterval(intervalHandle);
      intervalHandle = null;
      clearTimeout(startupTimer);
      try {
        deps.autoUpdater.removeAllListeners?.();
      } catch {
        /* may not be implemented on the mock */
      }
    },
    cancelPeriodicCheck(): void {
      if (intervalHandle !== null) clearInterval(intervalHandle);
      intervalHandle = null;
      // Also stop the boot-time check timer if it hasn't fired yet.
      // The install flow calls this pre-`quitAndInstall` and a
      // boot-check firing mid-handoff would race the install.
      clearTimeout(startupTimer);
    },
    getLastDownloadedUpdate(): { version: string; info: UpdaterInfo } | null {
      return lastDownloaded;
    },
  };
}
