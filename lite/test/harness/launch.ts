/**
 * Onereach Lite Test Harness -- App lifecycle.
 *
 * Boots the BUILT lite app from dist-lite/, optionally with an isolated
 * userData directory + custom env. Returns the Playwright ElectronApplication
 * handle plus the main window and the resolved log-server port.
 *
 * Borrowed pattern: launchApp/closeApp from full's
 * test/e2e/helpers/electron-app.js (NOT imported -- studied only). Stripped
 * of full-app concerns (no Spaces/Agent Exchange/AI cost monitoring; lite
 * doesn't have those services in the kernel).
 */

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';

export const LITE_LOG_PORT = 47392;
export const LITE_LOG_SERVER = `http://127.0.0.1:${LITE_LOG_PORT}`;
const LAUNCH_TIMEOUT_MS = 30_000;
const READY_POLL_INTERVAL_MS = 250;
const READY_POLL_MAX_ATTEMPTS = 80; // 20 s total

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DIST_LITE = path.join(REPO_ROOT, 'dist-lite');

export interface LaunchOptions {
  /**
   * Path to the built lite executable. Defaults to the standard packaged
   * location for the current platform (dist-lite/mac-arm64/... on macOS,
   * dist-lite/win-unpacked/Onereach.ai Lite.exe on Windows).
   */
  executablePath?: string;
  /**
   * Override the userData directory. Useful for hermetic tests so they
   * don't see/touch each other's update-state.json or lite-bugs/.
   */
  userDataDir?: string;
  /**
   * Extra environment variables. Merged onto process.env (with
   * ELECTRON_RUN_AS_NODE stripped -- Cursor's terminal sets it because
   * Cursor itself is an Electron app).
   */
  env?: Record<string, string>;
  /** Extra CLI args to pass to the lite executable. */
  additionalArgs?: string[];
  /** Override the default 30s launch timeout. */
  timeoutMs?: number;
  /**
   * Skip the log-server readiness wait. Useful for tests that exercise
   * boot crashes or tests that want to assert the log server NEVER comes
   * up. Defaults to false (do wait).
   */
  skipReadyWait?: boolean;
}

export interface LiteHandle {
  app: ElectronApplication;
  mainWindow: Page;
  /** Resolved userData path used by this app instance. */
  userDataPath: string;
  /** Lite's log-server port (always 47392 in kernel; future ports may vary). */
  logPort: number;
  /** The executable path used for launch. */
  executablePath: string;
  /** True if userData was a temporary dir created by launchLite (cleaned on close). */
  ownsUserData: boolean;
}

/**
 * Default executable path for the built lite app on the current platform.
 * Throws if the platform is unsupported or the file doesn't exist.
 */
export function defaultExecutablePath(): string {
  if (process.platform === 'darwin') {
    return path.join(
      DIST_LITE,
      'mac-arm64',
      'Onereach.ai Lite.app',
      'Contents',
      'MacOS',
      'Onereach.ai Lite'
    );
  }
  if (process.platform === 'win32') {
    return path.join(DIST_LITE, 'win-unpacked', 'Onereach.ai Lite.exe');
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

/**
 * Launch the built lite app and wait for the log server to come up.
 *
 * Cleanup: ALWAYS pair with closeLite(handle) in test teardown. The handle
 * carries an `ownsUserData` flag so closeLite knows whether to rm -rf the
 * tempdir it created.
 */
export async function launchLite(opts: LaunchOptions = {}): Promise<LiteHandle> {
  const executablePath = opts.executablePath ?? defaultExecutablePath();
  await assertExecutable(executablePath);

  let userDataPath = opts.userDataDir;
  let ownsUserData = false;
  if (userDataPath === undefined) {
    userDataPath = await fs.mkdtemp(path.join(tmpdir(), 'onereach-lite-test-'));
    ownsUserData = true;
  } else {
    await fs.mkdir(userDataPath, { recursive: true });
  }

  // Strip ELECTRON_RUN_AS_NODE -- Cursor's terminal sets it because Cursor
  // is itself Electron, and it would make our launch start as plain Node.
  const env: Record<string, string> = { ...process.env, ...(opts.env ?? {}) } as Record<
    string,
    string
  >;
  delete env.ELECTRON_RUN_AS_NODE;
  env.NODE_ENV = env.NODE_ENV ?? 'test';
  env.LITE_TEST_MODE = 'true';

  const args: string[] = [
    `--user-data-dir=${userDataPath}`,
    ...(opts.additionalArgs ?? []),
  ];

  const app = await electron.launch({
    executablePath,
    args,
    env,
    timeout: opts.timeoutMs ?? LAUNCH_TIMEOUT_MS,
  });

  const mainWindow = await app.firstWindow();
  await mainWindow.waitForLoadState('domcontentloaded');

  if (opts.skipReadyWait !== true) {
    await waitForLogServer(LITE_LOG_PORT);
  }

  return {
    app,
    mainWindow,
    userDataPath,
    logPort: LITE_LOG_PORT,
    executablePath,
    ownsUserData,
  };
}

/**
 * Gracefully close the lite app, with a force-kill fallback. Cleans up
 * the temporary userData dir if launchLite created it.
 *
 * The lite kernel quits within ~1s on `app.quit()` (see lite/main-lite.ts
 * before-quit handler). We keep a 10s outer timeout as a safety net.
 */
export async function closeLite(handle: LiteHandle | null | undefined): Promise<void> {
  if (handle === null || handle === undefined) return;
  const { app, userDataPath, ownsUserData } = handle;
  try {
    try {
      await app.evaluate(({ app: a }) => {
        a.quit();
      });
    } catch {
      /* app may already be exiting */
    }
    await Promise.race([
      app.close(),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('close timeout')), 10_000)),
    ]);
  } catch {
    try {
      await app.evaluate(({ app: a }) => a.exit(0));
    } catch {
      /* no-op */
    }
    try {
      await Promise.race([
        app.close(),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('force close timeout')), 2_000)),
      ]);
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[lite-harness] App did not exit cleanly -- process will be force-killed');
    }
  }

  if (ownsUserData) {
    try {
      await fs.rm(userDataPath, { recursive: true, force: true });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[lite-harness] failed to clean tempdir', userDataPath, err);
    }
  }
}

/**
 * Poll the log server's /health endpoint until it responds. Throws if it
 * never comes up within the budget.
 */
export async function waitForLogServer(port: number = LITE_LOG_PORT): Promise<void> {
  const url = `http://127.0.0.1:${port}/health`;
  for (let i = 0; i < READY_POLL_MAX_ATTEMPTS; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch {
      /* not ready yet */
    }
    await sleep(READY_POLL_INTERVAL_MS);
  }
  throw new Error(
    `lite log server on :${port} did not respond within ${
      (READY_POLL_INTERVAL_MS * READY_POLL_MAX_ATTEMPTS) / 1000
    }s`
  );
}

async function assertExecutable(executablePath: string): Promise<void> {
  try {
    await fs.access(executablePath);
  } catch {
    throw new Error(
      `lite executable not found at ${executablePath} -- run \`npm run lite:package:mac\` (or :win) first`
    );
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
