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
  /** EventEmitter's emit; the download guard raises its refusal as the 'error' event the lifecycle's dialog listens to. */
  emit?: (event: string, ...args: unknown[]) => unknown;
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

/** The filesystem calls the packaged path needs. */
export interface PackagedFs {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, encoding: 'utf8') => string;
  mkdirSync: (p: string, opts: { recursive: boolean }) => unknown;
  writeFileSync: (p: string, data: string, encoding: 'utf8') => void;
}

export type PackagedDescriptorState =
  /** The bundle's own app-update.yml matches the feed; nothing written. */
  | 'bundle'
  /** Missing or drifted in the bundle; written under userData and pointed at. */
  | 'written'
  /** Missing/drifted and the userData copy could not be written — checks work, downloads cannot. */
  | 'unwritable'
  /** The packaged path threw; the updater runs with whatever the bundle has. */
  | 'error';

export interface PackagedFeedState {
  feedFromCode: boolean;
  descriptor: PackagedDescriptorState;
  /** Why the userData descriptor was written, when it was. */
  reason?: 'missing' | 'drift';
  /** The userData descriptor path, when one is in use. */
  fallbackPath?: string;
}

/** Parse the four-key descriptor (`key: value` lines); tolerant of extra keys and comments. */
export function parseDescriptor(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

/** Does a descriptor name exactly our feed (provider, owner, repo, cache dir)? */
export function descriptorMatchesFeed(text: string): boolean {
  const d = parseDescriptor(text);
  return (
    d['provider'] === LITE_UPDATE_FEED.provider &&
    d['owner'] === LITE_UPDATE_FEED.owner &&
    d['repo'] === LITE_UPDATE_FEED.repo &&
    d['updaterCacheDirName'] === LITE_UPDATE_FEED.updaterCacheDirName
  );
}

let _packagedFeedState: PackagedFeedState | null = null;

/** What the packaged path did at init (null in dev / before init). */
export function packagedFeedState(): PackagedFeedState | null {
  return _packagedFeedState;
}

/** Shown when a check is refused because this install can never download an update. */
export const FEED_UNUSABLE_MESSAGE =
  'This copy of the app cannot download updates: the app bundle has no usable update descriptor and one could not be written to your user data folder. Reinstall the current release from the GitHub releases page; updates work normally from there.';

/**
 * Why no update check should run, or null. The check runner's preflight
 * (index.ts) asks this for every caller — menu, renderer IPC, periodic.
 * Only a packaged app whose descriptor is 'unwritable' or 'error'
 * refuses; 'bundle', 'written', dev runs and pre-init all allow.
 */
export function feedRefusalMessage(state: PackagedFeedState | null, isPackaged: boolean): string | null {
  if (!isPackaged || state === null) return null;
  return state.descriptor === 'unwritable' || state.descriptor === 'error' ? FEED_UNUSABLE_MESSAGE : null;
}

/**
 * ADR-101 — make the packaged updater independent of the packager:
 * provider from code; descriptor from code when the bundle's is missing
 * or names another feed (the `gsx-power-user-updater` drift class);
 * the userData descriptor rewritten right before every download, since
 * it is user-writable and electron-updater reads `updaterCacheDirName`
 * from it at download time. Never throws: a failure degrades to
 * `feedFromCode: false` and is reported, because a throw here would
 * take the IPC handlers and the fallback menu down with it.
 */
export function applyPackagedFeed(
  autoUpdater: AutoUpdaterLike,
  packaged: NonNullable<InitUpdaterOptions['packaged']>,
  log: NonNullable<InitUpdaterOptions['logger']>
): PackagedFeedState {
  const state: PackagedFeedState = { feedFromCode: false, descriptor: 'bundle' };
  // Rewrites the userData descriptor; set once the packaged path has one to own.
  let refresh: (() => void) | null = null;
  // Downloads read the descriptor again (updaterCacheDirName decides where
  // the zip is staged, and install.ts looks there). Refuse when no
  // trustworthy descriptor exists; rewrite ours first when it does. The
  // guard is installed before anything below can fail, so the 'error'
  // state refuses as well, and a refusal is raised as the updater's
  // 'error' event — the lifecycle's dialog lives there.
  const refuse = (message: string): never => {
    const err = new Error(message);
    try {
      autoUpdater.emit?.('error', err);
    } catch {
      // no 'error' listener attached (tests, early boot) — the rejection below still carries it
    }
    throw err;
  };
  try {
    const originalDownload = autoUpdater.downloadUpdate.bind(autoUpdater);
    autoUpdater.downloadUpdate = async (): Promise<unknown> => {
      if (state.descriptor === 'unwritable' || state.descriptor === 'error') {
        return refuse(
          'Updates cannot be downloaded on this install: the app bundle has no usable update descriptor and one could not be written. Reinstall from the releases page.'
        );
      }
      if (state.descriptor === 'written' && refresh !== null) {
        try {
          refresh();
        } catch (err) {
          return refuse(`Updates cannot be downloaded: the update descriptor could not be refreshed (${(err as Error).message}).`);
        }
      }
      return originalDownload();
    };
  } catch (err) {
    // An updater without a callable downloadUpdate: nothing to guard, nothing to feed. Never throw (see above).
    state.descriptor = 'error';
    log.error('updater: packaged feed setup failed — the updater has no downloadUpdate to guard', { error: (err as Error).message });
    return state;
  }
  try {
    const fs = packaged.fs ?? nodeFs();
    const bundled = path.join(packaged.resourcesPath, 'app-update.yml');
    const fallback = path.join(packaged.userDataPath, 'app-update.yml');
    let reason: 'missing' | 'drift' | null = null;
    if (!fs.existsSync(bundled)) {
      reason = 'missing';
    } else if (!descriptorMatchesFeed(fs.readFileSync(bundled, 'utf8'))) {
      reason = 'drift';
    }
    const writeFallback = (): boolean => {
      fs.mkdirSync(packaged.userDataPath, { recursive: true });
      fs.writeFileSync(fallback, feedDescriptorYaml(), 'utf8');
      return true;
    };
    if (reason !== null) {
      state.reason = reason;
      try {
        writeFallback();
        refresh = writeFallback;
        autoUpdater.updateConfigPath = fallback;
        state.descriptor = 'written';
        state.fallbackPath = fallback;
        log.warn(
          reason === 'missing'
            ? 'updater: bundle has no app-update.yml — descriptor written from code'
            : 'updater: bundle app-update.yml names another feed — descriptor written from code',
          {
            bundled,
            fallback,
            note:
              reason === 'missing'
                ? 'this bundle was not produced by the release pipeline (a --dir build?); updates still work'
                : 'the bundle descriptor is ignored; updates use the feed in lite/updater/feed.ts',
          }
        );
      } catch (err) {
        state.descriptor = 'unwritable';
        log.error('updater: bundle app-update.yml is missing or wrong and the fallback could not be written — checks work, downloads cannot', {
          bundled,
          fallback,
          reason,
          error: (err as Error).message,
        });
      }
    }
    if (typeof autoUpdater.setFeedURL === 'function') {
      autoUpdater.setFeedURL({ ...LITE_UPDATE_FEED });
      state.feedFromCode = true;
    }
  } catch (err) {
    state.descriptor = 'error';
    log.error('updater: packaged feed setup failed — running with the bundle descriptor only', {
      error: (err as Error).message,
    });
  }
  return state;
}

function nodeFs(): PackagedFs {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  return {
    existsSync: (p) => fs.existsSync(p),
    readFileSync: (p, encoding) => fs.readFileSync(p, encoding),
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

  // ADR-101 — packaged builds take the feed from code — unless a dev
  // update config is in effect (LITE_DEV_UPDATE_CONFIG: the packaged e2e
  // tier points the real bundle at a local server; the production feed
  // must not override it).
  let packagedFeed: PackagedFeedState | null = null;
  _packagedFeedState = null;
  if (opts.packaged !== undefined) {
    if (autoUpdater.forceDevUpdateConfig === true) {
      log.info('updater: dev update config in effect — feed from code not applied');
    } else {
      packagedFeed = applyPackagedFeed(autoUpdater, opts.packaged, log);
      _packagedFeedState = packagedFeed;
    }
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
