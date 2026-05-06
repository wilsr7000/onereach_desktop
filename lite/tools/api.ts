/**
 * Tools module -- PUBLIC API.
 *
 * The only file other lite modules should import from in this module.
 * Per ADR-019 / Rule 11 in `lite/LITE-RULES.md`, cross-module imports
 * go through `<module>/api.ts`.
 *
 * The Tools module hosts the top-level "Tools" menu and the persistence
 * layer behind it. Each entry is a simple `{ label, url }` shortcut --
 * clicking it opens the URL in the user's default browser.
 *
 * Tests: `_setToolsApiForTesting(stub)` to inject a custom
 * implementation, `_resetToolsApiForTesting()` to clear the singleton.
 */

import { ToolsStore } from './store.js';
import { ToolsError, TOOLS_ERROR_CODES } from './errors.js';
import { getLoggingApi } from '../logging/api.js';
import { getAuthApi } from '../auth/api.js';

// Re-export public types.
export type { ToolEntry, ToolStorageBlob } from './types.js';
export { TOOLS_MODULE_VERSION } from './types.js';

// Re-export error class + code catalog.
export type { ToolsErrorCode, ToolsErrorOptions } from './errors.js';
export { ToolsError, TOOLS_ERROR_CODES };

// Re-export typed event surface.
export type {
  ToolsEvent,
  ToolsEventName,
  ToolsAddStartEvent,
  ToolsAddFinishEvent,
  ToolsAddFailEvent,
  ToolsUpdateStartEvent,
  ToolsUpdateFinishEvent,
  ToolsUpdateFailEvent,
  ToolsRemoveStartEvent,
  ToolsRemoveFinishEvent,
  ToolsRemoveFailEvent,
  ToolsChangedEvent,
  ToolsOpenedEvent,
  ToolsManageOpenedEvent,
  ToolsIpcListEvent,
  ToolsIpcGetEvent,
  ToolsIpcAddEvent,
  ToolsIpcUpdateEvent,
  ToolsIpcRemoveEvent,
  ToolsIpcOpenEvent,
  ToolsIpcOpenManagerEvent,
} from './events.js';
export { TOOLS_EVENTS, isToolsEvent } from './events.js';

// Generic base.
export { LiteError, isLiteError } from '../errors.js';

import type { ToolEntry } from './types.js';
import type { ToolsEvent } from './events.js';

/**
 * The public surface of the Tools module.
 *
 * **Error contract**: `add` / `update` / `remove` throw `ToolsError`
 * (extends `LiteError`) on failure. Inspect `.code` to branch on
 * `TOOLS_NOT_FOUND`, `TOOLS_INVALID_INPUT`, `TOOLS_INVALID_URL`,
 * `TOOLS_DUPLICATE`, `TOOLS_PERSISTENCE_FAILED`. `list` / `get` do not
 * throw; they return empty / null on failure.
 */
export interface ToolsApi {
  /** All entries, in storage order. */
  list(): Promise<ToolEntry[]>;
  /** Single entry by id, or null if absent. */
  get(id: string): Promise<ToolEntry | null>;
  /**
   * Add a new entry.
   *
   * @throws {ToolsError} `TOOLS_DUPLICATE` if an explicit `id` collides.
   * @throws {ToolsError} `TOOLS_INVALID_INPUT` for missing label.
   * @throws {ToolsError} `TOOLS_INVALID_URL` for non-http/https URLs.
   * @throws {ToolsError} `TOOLS_PERSISTENCE_FAILED` if KV write rejects.
   */
  add(entry: Partial<ToolEntry> & Pick<ToolEntry, 'label' | 'url'>): Promise<ToolEntry>;
  /**
   * Update mutable fields on an existing entry.
   *
   * @throws {ToolsError} `TOOLS_NOT_FOUND` if no entry with `id`.
   * @throws {ToolsError} `TOOLS_INVALID_URL` for an invalid url.
   * @throws {ToolsError} `TOOLS_INVALID_INPUT` for an empty label.
   * @throws {ToolsError} `TOOLS_PERSISTENCE_FAILED` if KV write rejects.
   */
  update(id: string, patch: Partial<ToolEntry>): Promise<ToolEntry>;
  /**
   * Remove an entry.
   *
   * @throws {ToolsError} `TOOLS_NOT_FOUND` if no entry with `id`.
   * @throws {ToolsError} `TOOLS_PERSISTENCE_FAILED` if KV write rejects.
   */
  remove(id: string): Promise<void>;
  /**
   * Subscribe to mutations. Handler receives the latest entries each
   * time `add` / `update` / `remove` runs successfully. Returns an
   * unsubscribe function.
   */
  onChange(handler: (entries: ToolEntry[]) => void): () => void;
  /**
   * Subscribe to typed Tools events (ADR-032). Returns an unsubscribe
   * function.
   */
  onEvent(handler: (event: ToolsEvent) => void): () => void;
}

let _instance: ToolsApi | null = null;

/** Get the singleton Tools API. Lazy on first call. */
export function getToolsApi(): ToolsApi {
  if (_instance === null) {
    _instance = buildDefaultApi();
  }
  return _instance;
}

/** Reset the singleton (for tests). */
export function _resetToolsApiForTesting(): void {
  _instance = null;
}

/** Override the singleton with a custom implementation (for tests). */
export function _setToolsApiForTesting(api: ToolsApi): void {
  _instance = api;
}

// ─── default implementation ──────────────────────────────────────────────

function buildDefaultApi(): ToolsApi {
  const store = new ToolsStore({
    logger: (level, message, data) => {
      const log = getLoggingApi();
      log[level]('tools', message, data);
    },
    spanEmitter: (name, data) => getLoggingApi().start(name, data),
    getActiveAccountId: () => getAuthApi().getSession('edison')?.accountId ?? null,
  });

  // Refresh entries on sign-in / sign-out so the Tools menu picks up
  // saved tools the moment KV becomes available. Same pattern as IDW
  // (see comment in `lite/idw/api.ts`). Without this, the menu only
  // ran `list()` once at boot when the user was still signed-out and
  // never re-fetched.
  try {
    getAuthApi().onSessionChanged((env) => {
      if (env !== 'edison') return;
      void store.refreshAfterAccountChange();
    });
  } catch (err) {
    getLoggingApi().warn('tools', 'failed to subscribe to onSessionChanged', {
      error: (err as Error).message,
    });
  }

  return {
    list: () => store.list(),
    get: (id) => store.get(id),
    add: (input) => store.add(input),
    update: (id, patch) => store.update(id, patch),
    remove: (id) => store.remove(id),
    onChange: (handler) => store.onChange(handler),
    onEvent: (handler) => store.onEvent(handler),
  };
}
