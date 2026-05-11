/**
 * Onereach Lite Auto-Updater -- install orchestration.
 *
 * The install path on macOS bypasses Squirrel.Mac/ShipIt entirely and uses a
 * detached bash helper that swaps the bundle in /Applications after our
 * Electron process exits. Our work:
 *   1. Pre-flight: assert we can write the .app bundle (and its parent).
 *   2. Persist the target version so verify.ts can detect failed installs.
 *   3. Stop periodic check timer.
 *   4. Run save-state hooks within budget.
 *   5. Spawn the detached install helper (waits for our PID, then swaps).
 *   6. app.quit() -- helper takes over once we're gone.
 *   7. 10s safety net: process.exit(0) if we're still alive.
 *
 * Borrowed pattern: main.js _spawnInstallHelper + performUpdateInstall
 * (lines 17232-17491). Identical strategy with lite-specific paths.
 *
 * WHY THIS BYPASSES SQUIRREL.MAC:
 *   Squirrel.Mac's bundle-swap step uses the deprecated `launchctl submit`
 *   API to register its ShipIt helper as a launchd job. On macOS 26.4
 *   (Tahoe) that API silently no-ops -- the entry shows up in `launchctl
 *   list` for legacy compat, but launchd never actually schedules the job
 *   (runs = 0 indefinitely; manual `launchctl kickstart` is required to
 *   trigger it). Net effect: quitAndInstall returns successfully, the new
 *   bundle is staged in the ShipIt cache (update.*), the app quits, but
 *   ShipIt never runs, the swap never happens, and users see "Update
 *   available" again on next launch -- infinite loop.
 *
 *   Workaround: write a small detached bash script to /tmp that waits for
 *   our PID to exit, finds the staged bundle (either in Squirrel's cache or
 *   electron-updater's pending dir), codesign-verifies it, swaps it into
 *   /Applications, and re-launches via `open`. spawn(..., { detached: true })
 *   makes the child its own session leader so it survives our process exit.
 *
 *   Confirmed on the full app on 2026-05-11 -- the same bypass made the full
 *   app's auto-update work where Squirrel.Mac had been failing for weeks.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
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
  /**
   * Quit the Electron app after the install helper has been spawned. The
   * detached helper waits on our PID, so the sooner we exit the sooner the
   * swap happens. Defaults to a no-op -- the safety-net `process.exit(0)`
   * at 10 s is the backstop if the caller forgets to wire this up.
   *
   * `lite/updater/index.ts` wires this to `app.quit()`. Tests pass a spy.
   */
  appQuit?: () => void;
  /**
   * Test seam for the spawn call. Defaults to `child_process.spawn`. Tests
   * inject a stub that captures `{ command, args, options }` and returns
   * a fake `ChildProcess`-shaped object with `.unref()` + `.pid`.
   */
  spawnImpl?: typeof spawn;
  /**
   * Test seam for fs reads. Defaults to the `node:fs` module. The
   * production install path only reads (`existsSync`) -- the helper
   * script body is now in source control at
   * `scripts/install-update.sh`, packaged into
   * `Contents/Resources/install-update.sh` via electron-builder, not
   * generated at runtime.
   */
  fsImpl?: { existsSync?: typeof fs.existsSync };
  /**
   * Test seam for the user homedir. Defaults to `os.homedir()`. Tests pin
   * a stable directory so the resolved ShipIt + updater cache paths in
   * the spawned env are deterministic.
   */
  homedir?: () => string;
  /**
   * Test seam for the install helper script's log file path. Defaults to
   * `/tmp/onereach-lite-installer-<ts>.log`. Tests pin a fixed value so
   * the spawned env is deterministic.
   */
  getHelperLogPath?: () => string;
  /**
   * Test seam for the install helper script's body location on disk.
   * Defaults to `/tmp/onereach-lite-installer-<ts>.sh`. Tests pin a fixed
   * value so the spawn invocation can be asserted.
   */
  getHelperScriptPath?: () => string;
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

  // Bypass Squirrel.Mac: spawn the detached install helper, then quit. See
  // file header. The helper waits for our PID to exit, then swaps the
  // bundle and relaunches via `open`. We deliberately do NOT call
  // autoUpdater.quitAndInstall() because Squirrel.Mac's ShipIt handoff is
  // broken on macOS 26.4 (Tahoe).
  let helperSpawned = false;
  try {
    log.info('updater: spawning detached install helper');
    spawnInstallHelper(deps, { targetVersion, execPath: deps.execPath ?? process.execPath, log });
    helperSpawned = true;
  } catch (err) {
    log.error('updater: spawnInstallHelper threw', { error: (err as Error).message });
  }

  // Quit cleanly. The detached helper waits for this process to exit, then
  // performs the bundle swap and relaunches the new version. `appQuit` is
  // wired by `lite/updater/index.ts` to `app.quit()`. Skipped when the
  // helper wasn't spawned (no point quitting if there's no helper to take
  // over) so the user keeps the running app on a failed launch.
  if (helperSpawned) {
    try {
      log.info('updater: appQuit() -- detached helper will swap + relaunch');
      deps.appQuit?.();
    } catch (err) {
      log.error('updater: appQuit threw', { error: (err as Error).message });
    }
  }

  // Safety net: if we're still alive after 10s, a before-quit handler
  // refused to release us. Force-exit so the helper's wait-for-PID loop
  // proceeds and the swap happens.
  const forceExit = deps.forceExit ?? ((): void => {
    process.exit(0);
  });
  setTimeout(() => {
    log.warn('updater: safety-net force-exit firing');
    forceExit();
  }, SAFETY_NET_MS).unref();

  return { attempted: true, ...(saveStateMs !== undefined ? { saveStateMs } : {}) };
}

// ---------------------------------------------------------------------------
// Install helper: detached bash script that swaps the bundle + relaunches.
// ---------------------------------------------------------------------------
// See file header for the why. The script is generated at install time
// because (a) we need to interpolate the parent PID and lite-specific paths
// at runtime, (b) writing to /tmp avoids any asar packaging concerns. Logs
// land at /tmp/onereach-lite-installer-<ts>.log so a failed swap is
// debuggable post-mortem.

interface SpawnHelperOpts {
  targetVersion: string | null;
  execPath: string;
  log: { info: (msg: string, data?: unknown) => void };
}

/**
 * Locate the packaged install-update.sh script.
 *
 * In a packaged build the script lives at
 * `Contents/Resources/install-update.sh` (placed there by
 * electron-builder's `extraResources` entry in
 * `lite/electron-builder.json`). In dev runs (`npm run lite:dev`) the
 * resources path doesn't exist, so we fall back to the source-tree
 * location at `<repo>/scripts/install-update.sh`. Returns null when
 * neither exists -- caller logs + aborts the install.
 */
function findInstallHelperScript(deps: InstallDeps): string | null {
  // Defer to the test seam when present; only fall back to real
  // `fs.existsSync` when no seam was provided. The previous OR-with-
  // real-fs path made tests that wanted to simulate a missing script
  // impossible -- the real file IS present in the repo, so the
  // fallback always returned true and the test couldn't drive the
  // missing-script branch.
  const fsImpl = deps.fsImpl;
  const exists = (p: string): boolean => {
    try {
      if (fsImpl !== undefined && typeof fsImpl.existsSync === 'function') {
        return fsImpl.existsSync(p);
      }
      return fs.existsSync(p);
    } catch {
      return false;
    }
  };
  // Packaged: <app>/Contents/Resources/install-update.sh. Electron sets
  // process.resourcesPath to that directory.
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    const packaged = path.join(resourcesPath, 'install-update.sh');
    if (exists(packaged)) return packaged;
  }
  // Dev fallback: the bundled main-lite.js lives at
  // `dist-lite/build/main-lite.js`, so the source tree is two
  // directories up.
  const dev = path.resolve(__dirname, '..', '..', 'scripts', 'install-update.sh');
  if (exists(dev)) return dev;
  return null;
}

function spawnInstallHelper(deps: InstallDeps, opts: SpawnHelperOpts): void {
  // Resolve test seams. In production these all fall through to the
  // real implementations (`spawn`, `os.homedir`). Tests inject stubs
  // so the spawn invocation can be asserted without actually starting
  // bash.
  const spawnFn = deps.spawnImpl ?? spawn;
  const homeDir = (deps.homedir ?? os.homedir)();
  const ts = Date.now();
  const helperLog = deps.getHelperLogPath?.() ?? `/tmp/onereach-lite-installer-${ts}.log`;
  // Hard-code the installed `.app` path, matching the full app's
  // `_spawnInstallHelper`. The previous approach derived it from
  // `process.execPath` so dev runs could test the self-install path,
  // but in practice the bypass only meaningfully runs against a real
  // packaged install in `/Applications/` -- a dev run won't have a
  // valid Squirrel cache or signed bundle to swap in. Hard-coding
  // keeps the script's `basename "$APP_PATH"` derivation stable
  // (always "Onereach.ai Lite.app") and matches the cache paths the
  // helper script grep through.
  const appPath = '/Applications/Onereach.ai Lite.app';
  const shipItCache = path.join(homeDir, 'Library/Caches/com.onereach.lite.ShipIt');
  const electronUpdaterCache = path.join(
    homeDir,
    'Library/Caches/onereach-lite-updater/pending'
  );
  const statusFile = path.join(deps.userDataPath, 'last-install-result.json');

  // Locate the packaged helper script. Same surface as the full app's
  // `_spawnInstallHelper` -- the script itself lives at
  // `scripts/install-update.sh` in the repo, packaged into
  // `Contents/Resources/install-update.sh` for production runs.
  const helperPath = deps.getHelperScriptPath?.() ?? findInstallHelperScript(deps);
  if (helperPath === null) {
    opts.log.info('updater: install helper script not found', {
      resourcesPath: (process as { resourcesPath?: string }).resourcesPath ?? null,
    });
    throw new Error('install-update.sh not found in packaged resources or dev fallback');
  }
  opts.log.info('updater: spawning install helper', {
    helperPath,
    helperLog,
    statusFile,
  });

  // Notes:
  //   - `set -euo pipefail` so any error aborts; the user falls back to the
  //     "Update available" prompt on next launch instead of a corrupt bundle.
  //   - PATH explicit because detached launchd children inherit a stripped PATH.
  //   - Squirrel's cache is tried first (already unpacked, fastest). Fallback
  // Detached + stdio:'ignore' so the child becomes its own session
  // leader and our parent process can exit cleanly without holding
  // file descriptors. All inputs pass through env vars (ONEREACH_*
  // prefix) so the script body itself is hermetic and we don't
  // string-template anything. Mirrors the full app's
  // `_spawnInstallHelper` at `main.js:17425-17477`.
  const child = spawnFn('/bin/bash', [helperPath], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ONEREACH_PARENT_PID: String(process.pid),
      ONEREACH_TARGET_VERSION: opts.targetVersion ?? 'unknown',
      ONEREACH_APP_PATH: appPath,
      ONEREACH_SHIPIT_CACHE: shipItCache,
      ONEREACH_UPDATER_CACHE: electronUpdaterCache,
      ONEREACH_LOG: helperLog,
      ONEREACH_STATUS_FILE: statusFile,
    },
  });
  child.unref?.();
  opts.log.info('updater: spawned detached install helper', { pid: child.pid });
}
