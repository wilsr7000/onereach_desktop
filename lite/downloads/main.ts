/**
 * Downloads module — main-process orchestrator.
 *
 * Public entry point is `initDownloads(opts)`, called from
 * `main-lite.ts` after the main window is created (so the picker can
 * anchor on it). One call installs:
 *
 *   1. The `will-download` listener on the default Electron session
 *      and any session passed via `attachToSession`.
 *   2. The `lite:download-picker:*` IPC handlers (bootstrap + resolve).
 *   3. The picker singleton lifecycle owned by `picker-window.ts`.
 *
 * Per ADR-019 / Rule 11, cross-module consumers go through
 * `lite/downloads/api.ts`. This file is the implementation boundary.
 */

import { session as defaultSessions, type BrowserWindow, type Session } from 'electron';
import {
  attachWillDownloadHandler,
  type DownloadsHandlerOptions,
  type DownloadsLogger,
} from './handler.js';
import { registerDownloadsIpc, unregisterDownloadsIpc } from './ipc.js';
import {
  _setDownloadsApiForTesting,
  type DownloadsApi,
} from './api.js';
import { _resetPickerForTesting } from './picker-window.js';

export interface InitDownloadsOptions {
  /** Absolute path to the picker HTML (copied into `dist-lite/build/`). */
  pickerHtmlPath: string;
  /** Absolute path to `preload-lite.js`. */
  preloadPath: string;
  /** Resolver for the parent window (centers picker on it when present). */
  getParentWindow?: () => BrowserWindow | null;
  /** Optional structured logger -- main-lite injects the central one. */
  logger?: DownloadsLogger;
  /**
   * Human label for the originating webContents. Optional; same shape
   * as `DownloadsHandlerOptions.describeSource`.
   */
  describeSource?: DownloadsHandlerOptions['describeSource'];
  /**
   * Sessions to attach the `will-download` handler to. Defaults to
   * `[session.defaultSession]`. Per-tab partitions can be attached via
   * `handle.attachToSession(s)` after init.
   */
  sessions?: Session[];
}

export interface DownloadsHandle {
  /**
   * Attach the `will-download` handler to an additional session
   * (e.g. a per-tab partition). Returns an unhook function. Sessions
   * passed to `initDownloads({ sessions })` at boot are already
   * attached -- only call this for sessions created after init.
   */
  attachToSession(s: Session): () => void;
  /** Tear everything down. Used in tests + future hot-reload paths. */
  dispose(): void;
}

let active: {
  unhooks: Array<() => void>;
  attachedSessions: WeakSet<Session>;
  opts: InitDownloadsOptions;
} | null = null;

/**
 * Initialise the downloads module. Throws if called twice without a
 * `dispose()` in between -- single-instance keeps the IPC and session
 * hooks in a known state.
 */
export function initDownloads(opts: InitDownloadsOptions): DownloadsHandle {
  if (active !== null) {
    throw new Error(
      'initDownloads called twice. Call dispose() on the previous handle first.'
    );
  }

  if (opts.logger !== undefined) {
    registerDownloadsIpc({
      logger: {
        warn: opts.logger.warn,
        error: opts.logger.error,
      },
    });
  } else {
    registerDownloadsIpc({});
  }

  const handlerOpts: DownloadsHandlerOptions = {
    pickerHtmlPath: opts.pickerHtmlPath,
    preloadPath: opts.preloadPath,
  };
  if (opts.getParentWindow !== undefined) {
    handlerOpts.getParentWindow = opts.getParentWindow;
  }
  if (opts.logger !== undefined) {
    handlerOpts.logger = opts.logger;
  }
  if (opts.describeSource !== undefined) {
    handlerOpts.describeSource = opts.describeSource;
  }

  const unhooks: Array<() => void> = [];
  const attachedSessions = new WeakSet<Session>();
  const targets =
    opts.sessions !== undefined && opts.sessions.length > 0
      ? opts.sessions
      : [defaultSessions.defaultSession];
  for (const s of targets) {
    const unhook = attachWillDownloadHandler(s, handlerOpts);
    unhooks.push(unhook);
    attachedSessions.add(s);
  }

  active = { unhooks, attachedSessions, opts };

  const handle: DownloadsHandle = {
    attachToSession(s: Session) {
      if (active === null) {
        throw new Error('initDownloads handle used after dispose()');
      }
      if (active.attachedSessions.has(s)) {
        // Idempotent: returning a no-op unhook is friendlier than
        // throwing for callers that don't track which sessions they've
        // already wired (e.g. a tab-creation hook).
        return () => undefined;
      }
      const unhook = attachWillDownloadHandler(s, handlerOpts);
      active.unhooks.push(unhook);
      active.attachedSessions.add(s);
      return unhook;
    },
    dispose() {
      if (active === null) return;
      for (const fn of active.unhooks) {
        try {
          fn();
        } catch {
          /* best-effort */
        }
      }
      unregisterDownloadsIpc();
      _resetPickerForTesting();
      active = null;
      // Reset the public api so a fresh init() rebuilds it from scratch.
      _setDownloadsApiForTesting(buildPlaceholderApi());
    },
  };

  // Publish the live api so other modules can call into it through
  // `lite/downloads/api.ts`. Today this is a no-op surface (the
  // orchestrator owns all behavior internally), but the api singleton
  // is the future home for any "trigger a save dialog programmatically"
  // entry point.
  _setDownloadsApiForTesting(buildLiveApi(handle));

  return handle;
}

function buildLiveApi(handle: DownloadsHandle): DownloadsApi {
  return {
    attachToSession: (s) => handle.attachToSession(s),
  };
}

function buildPlaceholderApi(): DownloadsApi {
  return {
    attachToSession: () => {
      throw new Error(
        'downloads api used before initDownloads(). Call initDownloads({...}) at boot.'
      );
    },
  };
}

/** @internal — testing seam. */
export function _hasActiveDownloadsForTesting(): boolean {
  return active !== null;
}
