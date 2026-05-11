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
   * Test seam for fs writes. Defaults to the `node:fs` module. Tests pass
   * an in-memory implementation that captures `writeFileSync` calls so
   * the helper-script body can be asserted.
   */
  fsImpl?: { writeFileSync: typeof fs.writeFileSync };
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
  try {
    log.info('updater: spawning detached install helper');
    spawnInstallHelper({ targetVersion, execPath: deps.execPath ?? process.execPath, log });
  } catch (err) {
    log.error('updater: spawnInstallHelper threw', { error: (err as Error).message });
  }

  // Quit cleanly. The detached helper waits for this process to exit, then
  // performs the bundle swap and relaunches the new version.
  try {
    log.info('updater: app.quit() -- detached helper will swap + relaunch');
    // Lazy-require electron so this module remains importable in unit tests
    // (which run outside Electron). The runtime never hits the catch below.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    app.quit();
  } catch (err) {
    log.error('updater: app.quit() threw', { error: (err as Error).message });
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

function spawnInstallHelper(opts: SpawnHelperOpts): void {
  const ts = Date.now();
  const helperPath = `/tmp/onereach-lite-installer-${ts}.sh`;
  const helperLog = `/tmp/onereach-lite-installer-${ts}.log`;
  // Derive .app path from execPath rather than hard-coding /Applications/...,
  // so a dev running from a non-/Applications location can still test the
  // self-install path. execPath is .../Onereach.ai Lite.app/Contents/MacOS/Onereach.ai Lite
  const appPath = path.dirname(path.dirname(opts.execPath));
  const shipItCache = path.join(os.homedir(), 'Library/Caches/com.onereach.lite.ShipIt');
  const electronUpdaterCache = path.join(
    os.homedir(),
    'Library/Caches/onereach-lite-updater/pending'
  );
  const parentPid = process.pid;
  const productName = path.basename(appPath); // "Onereach.ai Lite.app"

  // Notes:
  //   - `set -euo pipefail` so any error aborts; the user falls back to the
  //     "Update available" prompt on next launch instead of a corrupt bundle.
  //   - PATH explicit because detached launchd children inherit a stripped PATH.
  //   - Squirrel's cache is tried first (already unpacked, fastest). Fallback
  //     is electron-updater's pending ZIP, extracted via `ditto -x -k`.
  //   - `ditto` is used (not cp -R) because cp -R mishandles framework
  //     symlinks in macOS Mach-O bundles.
  //   - The old bundle is moved to .old.<ts> (not deleted) so a failed
  //     install rolls back rather than leaving an empty /Applications slot.
  //   - `open` (no -n) re-launches the new bundle exactly like a Finder
  //     double-click; Launch Services picks it up post-swap and the user
  //     ends up on the new version with the same UI state.
  const helperScript = `#!/bin/bash
set -euo pipefail
exec >> "${helperLog}" 2>&1
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
echo "[$(date '+%H:%M:%S')] onereach-lite-installer starting"
echo "  parent PID: ${parentPid}"
echo "  target version: ${opts.targetVersion ?? 'unknown'}"
echo "  app path: ${appPath}"
echo "  ShipIt cache: ${shipItCache}"
echo "  updater cache: ${electronUpdaterCache}"

# 1. Wait for parent (Electron) to fully exit. Up to 30s.
echo "[$(date '+%H:%M:%S')] waiting for parent PID ${parentPid} to exit..."
for i in $(seq 1 30); do
  if ! kill -0 ${parentPid} 2>/dev/null; then
    echo "[$(date '+%H:%M:%S')] parent exited after \${i}s"
    break
  fi
  sleep 1
done
if kill -0 ${parentPid} 2>/dev/null; then
  echo "[$(date '+%H:%M:%S')] WARNING: parent still alive after 30s, force-killing"
  kill -9 ${parentPid} 2>/dev/null || true
  sleep 1
fi

# 2. Locate the new .app bundle. Try Squirrel's cache first.
NEW_APP=""
for d in "${shipItCache}"/update.*; do
  if [ -d "$d/${productName}" ]; then
    NEW_APP="$d/${productName}"
    break
  fi
done

if [ -z "$NEW_APP" ]; then
  echo "[$(date '+%H:%M:%S')] no Squirrel cache, extracting from electron-updater ZIP"
  ZIP=$(ls "${electronUpdaterCache}"/*.zip 2>/dev/null | head -1)
  if [ -z "$ZIP" ]; then
    echo "[$(date '+%H:%M:%S')] FATAL: no update bundle found in either cache"
    exit 1
  fi
  EXTRACT_DIR=$(mktemp -d)
  echo "[$(date '+%H:%M:%S')] extracting $ZIP -> $EXTRACT_DIR"
  ditto -x -k "$ZIP" "$EXTRACT_DIR"
  NEW_APP="$EXTRACT_DIR/${productName}"
fi

if [ ! -d "$NEW_APP" ]; then
  echo "[$(date '+%H:%M:%S')] FATAL: NEW_APP path doesn't exist: $NEW_APP"
  exit 1
fi
echo "[$(date '+%H:%M:%S')] new bundle: $NEW_APP"

# 3. Verify the new bundle's signature before swapping. If this fails,
# refuse to install -- bad bundle is worse than a stale bundle.
if ! codesign --verify "$NEW_APP" 2>/dev/null; then
  echo "[$(date '+%H:%M:%S')] FATAL: codesign --verify failed on new bundle"
  exit 1
fi
echo "[$(date '+%H:%M:%S')] codesign verify ok"

# 4. Swap. Old bundle is moved aside (so a failed ditto can roll back).
BACKUP="${appPath}.old.\$(date +%s)"
echo "[$(date '+%H:%M:%S')] backing up old: ${appPath} -> $BACKUP"
mv "${appPath}" "$BACKUP"
echo "[$(date '+%H:%M:%S')] ditto new bundle into ${appPath}"
if ! ditto "$NEW_APP" "${appPath}"; then
  echo "[$(date '+%H:%M:%S')] FATAL: ditto failed, rolling back"
  rm -rf "${appPath}" 2>/dev/null || true
  mv "$BACKUP" "${appPath}"
  exit 1
fi

# 5. Strip quarantine in case the staged bundle inherited it from a downloaded zip.
xattr -d com.apple.quarantine "${appPath}" 2>/dev/null || true

echo "[$(date '+%H:%M:%S')] swap complete, launching new version"
open "${appPath}"

echo "[$(date '+%H:%M:%S')] backup left at $BACKUP (cleanup deferred -- user can delete manually)"
echo "[$(date '+%H:%M:%S')] DONE"
exit 0
`;

  fs.writeFileSync(helperPath, helperScript, { mode: 0o755 });
  opts.log.info('updater: wrote install helper', { helperPath, helperLog });

  // Detached + stdio:'ignore' so the child becomes its own session leader
  // and our parent process can exit cleanly without holding file descriptors.
  const child = spawn('/bin/bash', [helperPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  opts.log.info('updater: spawned detached install helper', { pid: child.pid });
}
