/**
 * IDW module -- PUBLIC API.
 *
 * The only file other lite modules should import from in this module.
 * Per ADR-019 / Rule 11 in `lite/LITE-RULES.md`, cross-module imports
 * go through `<module>/api.ts` -- never reach into `store.ts`,
 * `menu-builder.ts`, or any other internal file.
 *
 * The IDW module hosts the top-level "IDW" menu and the persistence
 * layer behind it. Six kinds of entries (IDWs, External Bots, Image
 * Creators, Video Creators, Audio Generators, UI Design Tools) live
 * in one unified data model. See `./types.ts` for the discriminated
 * `IdwEntry` shape and `./kind-metadata.ts` for the per-kind UI +
 * validation table.
 *
 * Tests: `_setIdwApiForTesting(stub)` to inject a custom
 * implementation, `_resetIdwApiForTesting()` to clear the singleton.
 */

import { IdwStore } from './store.js';
import type { AddResult } from './store.js';
import { IdwError, IDW_ERROR_CODES } from './errors.js';
import { getLoggingApi } from '../logging/api.js';
import { getAuthApi } from '../auth/api.js';

// Re-export the public types consumers need to typecheck calls.
export type {
  AgentKind,
  AudioSubCategory,
  BotType,
  IdwEntry,
  IdwStorageBlob,
} from './types.js';
export { AGENT_KINDS, AUDIO_SUB_CATEGORIES, BOT_TYPES, IDW_MODULE_VERSION } from './types.js';

// Re-export the per-kind metadata table -- used by the Settings
// section, the catalog renderer, and the menu builder.
export { KIND_META, AUDIO_SUB_LABELS } from './kind-metadata.js';
export type { KindMetadata } from './kind-metadata.js';

// Re-export the external-bot preset table -- used by the Settings
// section's Add/Edit form to pre-fill label + URL when the user picks
// a well-known third-party bot.
export { BOT_PRESETS, findBotPreset } from './bot-presets.js';
export type { BotPreset } from './bot-presets.js';

// Re-export the structured error class + code catalog.
export type { IdwErrorCode, IdwErrorOptions } from './errors.js';
export { IdwError, IDW_ERROR_CODES };

// Re-export the typed event surface (ADR-032).
export type {
  IdwEvent,
  IdwEventName,
  IdwAddStartEvent,
  IdwAddFinishEvent,
  IdwAddFailEvent,
  IdwUpdateStartEvent,
  IdwUpdateFinishEvent,
  IdwUpdateFailEvent,
  IdwRemoveStartEvent,
  IdwRemoveFinishEvent,
  IdwRemoveFailEvent,
  IdwChangedEvent,
  IdwOpenedEvent,
  IdwStoreOpenedEvent,
  IdwStoreInstalledEvent,
  IdwStoreUpdatedEvent,
  IdwBrowserLoadingEvent,
  IdwBrowserLoadedEvent,
  IdwIpcListEvent,
  IdwIpcListByKindEvent,
  IdwIpcGetEvent,
  IdwIpcAddEvent,
  IdwIpcUpdateEvent,
  IdwIpcRemoveEvent,
  IdwIpcOpenEvent,
  IdwIpcOpenStoreEvent,
} from './events.js';
export { IDW_EVENTS, isIdwEvent } from './events.js';

// Generic base class -- consumers can also catch via `instanceof
// LiteError` if they want to handle errors uniformly across all lite
// modules.
export { LiteError, isLiteError } from '../errors.js';

// Re-export AddResult so consumers can branch on `wasUpdate`.
export type { AddResult };

import type { AgentKind, IdwEntry } from './types.js';
import type { IdwEvent } from './events.js';

/**
 * The public surface of the IDW module.
 *
 * **Error contract**: `add` / `update` / `remove` throw `IdwError`
 * (extends `LiteError`) on failure. Inspect `.code` to branch on
 * `IDW_NOT_FOUND`, `IDW_INVALID_INPUT`, `IDW_INVALID_URL`,
 * `IDW_DUPLICATE`, `IDW_KIND_MISMATCH`, `IDW_PERSISTENCE_FAILED`.
 * `list` / `listByKind` / `get` do not throw; they return empty /
 * null on failure.
 *
 * **Renderer surface**: `list`, `listByKind`, `get`, `add`, `update`,
 * `remove`, `openStore`, `onChange`, `parseError` are bridged via
 * `window.lite.idw.*`. The main-process-only `onEvent` is not
 * bridged (use `window.logging.recent('idw.*')` from the renderer
 * if you need historical events).
 */
export interface IdwApi {
  /** All entries, in storage order. */
  list(): Promise<IdwEntry[]>;
  /** Entries of the given kind only, in storage order. */
  listByKind(kind: AgentKind): Promise<IdwEntry[]>;
  /** Single entry by id, or null if absent. */
  get(id: string): Promise<IdwEntry | null>;
  /**
   * Add a new entry, OR (for `source='store'` entries with a matching
   * `storeMetadata.catalogId`) update the existing one in place.
   * Returns `{ entry, wasUpdate }` so callers can show "Installed"
   * vs "Updated" toasts.
   *
   * @throws {IdwError} `IDW_DUPLICATE` if an explicit `id` collides.
   * @throws {IdwError} `IDW_INVALID_INPUT` for missing / wrong-type fields.
   * @throws {IdwError} `IDW_INVALID_URL` for non-http/https URLs.
   * @throws {IdwError} `IDW_KIND_MISMATCH` when a Store re-install changes kind.
   * @throws {IdwError} `IDW_PERSISTENCE_FAILED` if KV write rejects.
   */
  add(entry: Partial<IdwEntry> & Pick<IdwEntry, 'kind' | 'label' | 'url'>): Promise<AddResult>;
  /**
   * Update mutable fields on an existing entry. `kind` cannot change.
   *
   * @throws {IdwError} `IDW_NOT_FOUND` if no entry with `id`.
   * @throws {IdwError} `IDW_KIND_MISMATCH` if patch tries to change kind.
   * @throws {IdwError} `IDW_INVALID_URL` for invalid url/apiUrl.
   * @throws {IdwError} `IDW_INVALID_INPUT` for invalid label / audio sub.
   * @throws {IdwError} `IDW_PERSISTENCE_FAILED` if KV write rejects.
   */
  update(id: string, patch: Partial<IdwEntry>): Promise<IdwEntry>;
  /**
   * Remove an entry.
   *
   * @throws {IdwError} `IDW_NOT_FOUND` if no entry with `id`.
   * @throws {IdwError} `IDW_PERSISTENCE_FAILED` if KV write rejects.
   */
  remove(id: string): Promise<void>;
  /**
   * Subscribe to mutations. Handler receives the latest entries each
   * time `add` / `update` / `remove` runs successfully. Returns an
   * unsubscribe function.
   */
  onChange(handler: (entries: IdwEntry[]) => void): () => void;
  /**
   * Subscribe to typed IDW events (ADR-032). Returns an unsubscribe
   * function.
   */
  onEvent(handler: (event: IdwEvent) => void): () => void;
}

let _instance: IdwApi | null = null;

/**
 * Get the singleton IDW API. Lazily instantiates on first call with
 * the default `IdwStore` (KV-backed).
 */
export function getIdwApi(): IdwApi {
  if (_instance === null) {
    _instance = buildDefaultApi();
  }
  return _instance;
}

/** Reset the singleton (for tests). */
export function _resetIdwApiForTesting(): void {
  _instance = null;
}

/** Override the singleton with a custom implementation (for tests). */
export function _setIdwApiForTesting(api: IdwApi): void {
  _instance = api;
}

// ─── default implementation ──────────────────────────────────────────────

function buildDefaultApi(): IdwApi {
  const store = new IdwStore({
    logger: (level, message, data) => {
      const log = getLoggingApi();
      log[level]('idw', message, data);
    },
    spanEmitter: (name, data) => getLoggingApi().start(name, data),
    // Multi-user isolation: scope KV by the signed-in OneReach
    // accountId so two installs sharing the global anonymous KV
    // namespace don't see each other's IDWs. Returns null when
    // signed-out, which makes the store return an empty list and
    // refuse writes.
    getActiveAccountId: () => getAuthApi().getSession('edison')?.accountId ?? null,
  });
  return {
    list: () => store.list(),
    listByKind: (kind) => store.listByKind(kind),
    get: (id) => store.get(id),
    add: (input) => store.add(input),
    update: (id, patch) => store.update(id, patch),
    remove: (id) => store.remove(id),
    onChange: (handler) => store.onChange(handler),
    onEvent: (handler) => store.onEvent(handler),
  };
}
