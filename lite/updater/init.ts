/**
 * Onereach Lite Auto-Updater -- electron-updater initialization.
 *
 * Loads electron-updater lazily (after app.whenReady, like full does)
 * because it pulls in native module bindings and shouldn't run during
 * import resolution.
 *
 * Borrowed pattern: main.js lines 360-370. Configuration matches full:
 *   - autoDownload = false (user is asked first)
 *   - autoInstallOnAppQuit = true (pending install applies on next quit)
 *   - allowDowngrade = false (safety -- full uses same)
 *
 * Logger is wired into lite's log queue (lib/log-event-queue.js) rather
 * than electron-log -- lite has its own log server on :47392.
 */

import * as path from 'node:path';
import { LITE_UPDATE_FEED, feedDescriptorYaml } from './feed.js';

/**
 * The subset of electron-updater's autoUpdater we use. Typed as an
 * interface so unit tests can mock it without importing the real module.
 */
export interface AutoUpdaterLike {
  logger: unknown;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  updateConfigPath?: string | null;
  /**
   * electron-updater's safety guard: in dev mode (!app.isPackaged) it
   * refuses to perform real checks unless this is true. We flip it on
   * automatically when devUpdateConfigPath is set, since the only reason
   * to set that path is to test against a local server.
   */
  forceDevUpdateConfig?: boolean;
  getFeedURL?: () => string | null | undefined;
  /** electron-updater: set the provider from code instead of app-update.yml. */
  setFeedURL?: (options: Record<string, unknown>) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeAllListeners?: (event?: string) => unknown;
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
}

export interface InitUpdaterOptions {
  /** Logger (info/warn/error). Defaults to console. */
  logger?: {
    info: (msg: string, data?: unknown) => void;
    warn: (msg: string, data?: unknown) => void;
    error: (msg: string, data?: unknown) => void;
    debug?: (msg: string, data?: unknown) => void;
  };
  /**
   * In dev (!app.isPackaged) point at this dev-app-update.yml so a local
   * update server can be tested. main.js does the same -- see lines
   * 16814-16822. If the file doesn't exist the updater uses its default.
   */
  devUpdateConfigPath?: string;
  /**
   * Override for tests -- inject a fake updater instead of loading
   * electron-updater from disk.
   */
  loadAutoUpdater?: () => AutoUpdaterLike;
  /**
   * ADR-101 — set when the app is packaged. The feed is set from code
   * (`LITE_UPDATE_FEED`) so the provider never depends on the bundle's
   * `app-update.yml`; when that file is missing (a `--dir` build copied
   * into /Applications) the descriptor is written under userData and
   * pointed at, so the download cache dir resolves too.
   */
  packaged?: {
    resourcesPath: string;
    userDataPath: string;
    /** Filesystem seam for tests. */
    fs?: PackagedFs;
  };
}

/** The three filesystem calls the packaged path needs. */
export interface PackagedFs {
  existsSync: (p: string) => boolean;
  mkdirSync: (p: string, opts: { recursive: boolean }) => unknown;
  writeFileSync: (p: string, data: string, encoding: 'utf8') => void;
}

/**
 * ADR-101 — make the packaged updater independent of the packager:
 * provider from code, descriptor from code when the bundle has none.
 * Returns what it did (for the log and for tests).
 */
export function applyPackagedFeed(
  autoUpdater: AutoUpdaterLike,
  packaged: NonNullable<InitUpdaterOptions['packaged']>,
  log: NonNullable<InitUpdaterOptions['logger']>
): { feedFromCode: boolean; descriptor: 'bundle' | 'written' | 'unwritable' } {
  const fs = packaged.fs ?? nodeFs();
  const bundled = path.join(packaged.resourcesPath, 'app-update.yml');
  let descriptor: 'bundle' | 'written' | 'unwritable' = 'bundle';
  if (!fs.existsSync(bundled)) {
    // electron-updater reads updaterCacheDirName from the descriptor at
    // download time (configOnDisk), so a provider alone is not enough.
    const fallback = path.join(packaged.userDataPath, 'app-update.yml');
    try {
      fs.mkdirSync(packaged.userDataPath, { recursive: true });
      fs.writeFileSync(fallback, feedDescriptorYaml(), 'utf8');
      autoUpdater.updateConfigPath = fallback;
      descriptor = 'written';
      log.warn('updater: bundle has no app-update.yml — descriptor written from code', {
        bundled,
        fallback,
        note: 'this bundle was not produced by the release pipeline (a --dir build?); updates still work',
      });
    } catch (err) {
      descriptor = 'unwritable';
      log.error('updater: bundle has no app-update.yml and the fallback could not be written', {
        bundled,
        fallback,
        error: (err as Error).message,
      });
    }
  }
  let feedFromCode = false;
  if (typeof autoUpdater.setFeedURL === 'function') {
    autoUpdater.setFeedURL({ ...LITE_UPDATE_FEED });
    feedFromCode = true;
  }
  return { feedFromCode, descriptor };
}

function nodeFs(): PackagedFs {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  return {
    existsSync: (p) => fs.existsSync(p),
    mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
    writeFileSync: (p, data, encoding) => fs.writeFileSync(p, data, encoding),
  };
}

/**
 * Lazy-load electron-updater and apply lite's configuration. Returns the
 * configured singleton, or null if the package isn't available (unsigned
 * dev runs, broken install, etc.) -- callers must handle null.
 */
export function initAutoUpdater(opts: InitUpdaterOptions = {}): AutoUpdaterLike | null {
  const log = opts.logger ?? consoleLogger();
  let autoUpdater: AutoUpdaterLike;
  try {
    if (opts.loadAutoUpdater !== undefined) {
      autoUpdater = opts.loadAutoUpdater();
    } else {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      const mod = require('electron-updater') as { autoUpdater: AutoUpdaterLike };
      autoUpdater = mod.autoUpdater;
    }
  } catch (err) {
    log.warn('updater: electron-updater not available', { error: (err as Error).message });
    return null;
  }

  // Lite's logger is the log queue + log server. The shape below matches
  // electron-updater's expected logger interface (info/warn/error/debug).
  autoUpdater.logger = {
    info: (msg: unknown) => log.info(String(msg)),
    warn: (msg: unknown) => log.warn(String(msg)),
    error: (msg: unknown) => log.error(String(msg)),
    debug: (msg: unknown) => (log.debug ?? log.info)(String(msg)),
  };
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  // Dev-mode update config (tests inject a local server URL here).
  // Setting forceDevUpdateConfig bypasses electron-updater's guard
  // ("Skip checkForUpdates because application is not packed and dev
  // update config is not forced") -- we WANT real checks against the
  // local server when the test harness has wired one up.
  if (opts.devUpdateConfigPath !== undefined && fileExists(opts.devUpdateConfigPath)) {
    autoUpdater.updateConfigPath = opts.devUpdateConfigPath;
    autoUpdater.forceDevUpdateConfig = true;
    log.info('updater: dev-app-update.yml in effect', {
      path: opts.devUpdateConfigPath,
      forceDevUpdateConfig: true,
    });
  }

  // ADR-101 — packaged builds take the feed from code, always.
  let packagedFeed: ReturnType<typeof applyPackagedFeed> | null = null;
  if (opts.packaged !== undefined) {
    packagedFeed = applyPackagedFeed(autoUpdater, opts.packaged, log);
  }
  let feedUrl = '<default-from-publish-config>';
  try {
    feedUrl = autoUpdater.getFeedURL?.() ?? feedUrl;
  } catch {
    /* getFeedURL throws if not configured -- benign */
  }
  log.info('updater: initialized', {
    feedUrl,
    ...(packagedFeed !== null
      ? { feedFromCode: packagedFeed.feedFromCode, descriptor: packagedFeed.descriptor, feed: `${LITE_UPDATE_FEED.provider}:${LITE_UPDATE_FEED.owner}/${LITE_UPDATE_FEED.repo}` }
      : {}),
    autoDownload: autoUpdater.autoDownload,
    autoInstallOnAppQuit: autoUpdater.autoInstallOnAppQuit,
    allowDowngrade: autoUpdater.allowDowngrade,
  });

  return autoUpdater;
}

/** Default path to the dev-app-update.yml inside the app dir. */
export function defaultDevUpdateConfigPath(appDir: string): string {
  return path.join(appDir, 'dev-app-update.yml');
}

function consoleLogger(): NonNullable<InitUpdaterOptions['logger']> {
  return {
    // eslint-disable-next-line no-console
    info: (msg: string, data?: unknown) => console.log(`[lite-updater] ${msg}`, data ?? ''),
    // eslint-disable-next-line no-console
    warn: (msg: string, data?: unknown) => console.warn(`[lite-updater] ${msg}`, data ?? ''),
    // eslint-disable-next-line no-console
    error: (msg: string, data?: unknown) => console.error(`[lite-updater] ${msg}`, data ?? ''),
    // eslint-disable-next-line no-console
    debug: (msg: string, data?: unknown) => console.debug(`[lite-updater] ${msg}`, data ?? ''),
  };
}

function fileExists(p: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
