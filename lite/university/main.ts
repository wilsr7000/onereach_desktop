/**
 * Agentic University main-process orchestration.
 *
 * Owns:
 *   - IPC handlers for `lite:university:list / list-by-kind / get /
 *     open / open-tutorials`
 *   - Wiring `menu-builder.ts` (registers `top:university` + items)
 *   - Wiring the shared Learning Browser singleton + the tutorials
 *     catalog window factory
 *
 * Per ADR-019 / Rule 11, this module is the boundary between
 * Electron IPC and the typed `UniversityApi`. Per ADR-030, every
 * handler emits an instant `university.ipc.<verb>` event on entry.
 */

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  getUniversityApi,
  resolveEntryStrict,
  UniversityError,
  _resetUniversityApiForTesting,
  type LearningEntry,
  type LearningKind,
} from './api.js';
import { LEARNING_KINDS } from './types.js';
import { UNIVERSITY_EVENTS } from './events.js';
import { initMenuBuilder, teardownMenuBuilder } from './menu-builder.js';
import { openLearningInBrowser, closeLearningBrowser } from './browser-window.js';
import { openTutorialsWindow, closeTutorialsWindow } from './tutorials-window.js';
import { getLoggingApi } from '../logging/api.js';

// ---------------------------------------------------------------------------
// IPC channel names. All prefixed `lite:university:` per Rule 3.
// ---------------------------------------------------------------------------

export const UNIVERSITY_IPC = {
  LIST: 'lite:university:list',
  LIST_BY_KIND: 'lite:university:list-by-kind',
  GET: 'lite:university:get',
  OPEN: 'lite:university:open',
  OPEN_TUTORIALS: 'lite:university:open-tutorials',
} as const;

// ---------------------------------------------------------------------------
// Init / teardown
// ---------------------------------------------------------------------------

export interface InitUniversityOptions {
  /** Path to the bundled preload-lite.js (used by the tutorials window). */
  preloadPath: string;
  /** Path to the bundled university-tutorials.html (catalog window). */
  tutorialsHtmlPath: string;
  /** Resolver for the parent window. Called on each open. */
  getParentWindow: () => BrowserWindow | null;
  /** Optional logger -- routed through lite logging by default. */
  logger?: {
    info: (message: string, data?: unknown) => void;
    warn: (message: string, data?: unknown) => void;
    error: (message: string, data?: unknown) => void;
  };
  /**
   * Optional per-entry routing override. Called BEFORE the default
   * Learning Browser path. Return `true` to indicate the entry was
   * handled; return `false` to fall through to the default
   * `openLearningInBrowser(entry)`. Used by `main-lite.ts` to route
   * `ai-run-times` to its dedicated reader window without making
   * `lite/university/` depend on `lite/ai-run-times/`.
   */
  onOpenEntryOverride?: (entry: LearningEntry) => boolean;
}

export interface UniversityHandle {
  /** Tear down IPC handlers, menu subscriptions, and any open windows. Idempotent. */
  teardown(): void;
}

let registered = false;
let initOptions: InitUniversityOptions | null = null;

/**
 * Register IPC handlers, register the top:university menu, and
 * wire window factories. Safe to call multiple times -- subsequent
 * calls are no-ops.
 */
export function initUniversity(opts: InitUniversityOptions): UniversityHandle {
  const log = opts.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  if (registered) {
    return { teardown: teardownInternal };
  }
  initOptions = opts;

  const api = getUniversityApi();

  // ── IPC handlers ───────────────────────────────────────────────────────

  ipcMain.handle(UNIVERSITY_IPC.LIST, async (): Promise<LearningEntry[]> => {
    getLoggingApi().event(UNIVERSITY_EVENTS.IPC_LIST);
    return api.list();
  });

  ipcMain.handle(
    UNIVERSITY_IPC.LIST_BY_KIND,
    async (_event: IpcMainInvokeEvent, payload: { kind?: unknown }): Promise<LearningEntry[]> => {
      getLoggingApi().event(UNIVERSITY_EVENTS.IPC_LIST);
      const kind = validateKind(payload?.kind);
      return api.listByKind(kind);
    }
  );

  ipcMain.handle(
    UNIVERSITY_IPC.GET,
    async (_event: IpcMainInvokeEvent, payload: { id?: unknown }): Promise<LearningEntry | null> => {
      getLoggingApi().event(UNIVERSITY_EVENTS.IPC_GET);
      const id = validateNonEmptyString(payload?.id, 'id');
      return api.get(id);
    }
  );

  ipcMain.handle(
    UNIVERSITY_IPC.OPEN,
    async (_event: IpcMainInvokeEvent, payload: { id?: unknown }): Promise<{ ok: true }> => {
      getLoggingApi().event(UNIVERSITY_EVENTS.IPC_OPEN);
      const id = validateNonEmptyString(payload?.id, 'id');
      try {
        const entry = resolveEntryStrict(id);
        getLoggingApi().event(UNIVERSITY_EVENTS.OPENED, { id: entry.id, kind: entry.kind });
        if (initOptions?.onOpenEntryOverride !== undefined) {
          const handled = initOptions.onOpenEntryOverride(entry);
          if (handled) return { ok: true };
        }
        openLearningInBrowser(entry);
        return { ok: true };
      } catch (err) {
        if (err instanceof UniversityError) {
          log.warn('open rejected', { code: err.code, id });
          throw new Error(JSON.stringify({ __universityError: err.toJSON() }));
        }
        log.error('open unexpected error', { id, error: (err as Error).message });
        throw err;
      }
    }
  );

  ipcMain.handle(UNIVERSITY_IPC.OPEN_TUTORIALS, async (): Promise<{ ok: true }> => {
    getLoggingApi().event(UNIVERSITY_EVENTS.IPC_OPEN_TUTORIALS);
    if (initOptions === null) {
      throw new Error('initUniversity must be called before opening the tutorials window');
    }
    openTutorialsWindow({
      parent: initOptions.getParentWindow(),
      htmlPath: initOptions.tutorialsHtmlPath,
      preloadPath: initOptions.preloadPath,
    });
    getLoggingApi().event(UNIVERSITY_EVENTS.TUTORIALS_OPENED);
    return { ok: true };
  });

  // ── Menu builder ───────────────────────────────────────────────────────

  initMenuBuilder({
    onOpenEntry: (entry) => {
      if (initOptions?.onOpenEntryOverride !== undefined) {
        const handled = initOptions.onOpenEntryOverride(entry);
        if (handled) return;
      }
      openLearningInBrowser(entry);
    },
    onOpenTutorials: () => {
      if (initOptions === null) return;
      openTutorialsWindow({
        parent: initOptions.getParentWindow(),
        htmlPath: initOptions.tutorialsHtmlPath,
        preloadPath: initOptions.preloadPath,
      });
    },
  });

  registered = true;
  log.info('university initialized', {});
  return { teardown: teardownInternal };
}

function teardownInternal(): void {
  if (!registered) return;
  try {
    ipcMain.removeHandler(UNIVERSITY_IPC.LIST);
    ipcMain.removeHandler(UNIVERSITY_IPC.LIST_BY_KIND);
    ipcMain.removeHandler(UNIVERSITY_IPC.GET);
    ipcMain.removeHandler(UNIVERSITY_IPC.OPEN);
    ipcMain.removeHandler(UNIVERSITY_IPC.OPEN_TUTORIALS);
  } catch {
    // best-effort
  }
  try {
    teardownMenuBuilder();
  } catch {
    // best-effort
  }
  try {
    closeLearningBrowser();
  } catch {
    // best-effort
  }
  try {
    closeTutorialsWindow();
  } catch {
    // best-effort
  }
  registered = false;
  initOptions = null;
}

/** @internal -- exposed for tests. */
export function _isUniversityRegisteredForTesting(): boolean {
  return registered;
}

/** @internal -- exposed for tests so they can re-init cleanly. */
export function _resetUniversityRegistrationForTesting(): void {
  teardownInternal();
  _resetUniversityApiForTesting();
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

function validateKind(value: unknown): LearningKind {
  if (typeof value !== 'string' || !(LEARNING_KINDS as readonly string[]).includes(value)) {
    throw new Error(`Invalid kind: ${String(value)}`);
  }
  return value as LearningKind;
}

function validateNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}
