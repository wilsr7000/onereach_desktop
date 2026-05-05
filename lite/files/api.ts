/**
 * Files module -- PUBLIC API.
 *
 * The only file other lite modules should import from in this module.
 * Per ADR-019 / Rule 11 in `lite/LITE-RULES.md`, cross-module imports
 * go through `<module>/api.ts` -- never reach into `sdk-client.ts` or
 * any other internal file.
 *
 * Wraps `@or-sdk/files` so other modules can upload, download, list,
 * and delete files in OneReach storage without importing the SDK.
 * Per-user isolation is enforced server-side: every request carries
 * the user's `mult` token and the active `accountId`.
 *
 * Usage from another module (main process only):
 *
 *   import { getFilesApi } from '../files/api.js';
 *   const url = await getFilesApi().upload('bug-attachments', 'screenshot.png', bytes, {
 *     contentType: 'image/png',
 *   });
 *
 * Tests: `_setFilesApiForTesting(stub)` to inject a custom
 * implementation, `_resetFilesApiForTesting()` to clear the singleton.
 */

import { SdkFilesClient } from './sdk-client.js';
import type { SdkFilesClientConfig } from './sdk-client.js';
import { getLoggingApi } from '../logging/api.js';
import { ENVIRONMENT_CONFIGS } from '../auth/types.js';
import type { FilesEvent } from './events.js';

// Re-export the public types consumers need.
export type {
  FilesItem,
  FilesContent,
  FilesUploadOptions,
  FilesDownloadOptions,
  FilesListOptions,
  FilesDeleteOptions,
  FilesRewriteMode,
} from './types.js';

// Re-export the structured error class + code catalog.
export type { FilesErrorCode, FilesErrorOptions } from './errors.js';
export { FilesError, FILES_ERROR_CODES } from './errors.js';

// Per-module typed event surface (ADR-032).
export {
  FILES_EVENTS,
  isFilesEvent,
  type FilesEvent,
  type FilesEventName,
  type FilesUploadStartEvent,
  type FilesUploadFinishEvent,
  type FilesUploadFailEvent,
  type FilesDownloadStartEvent,
  type FilesDownloadFinishEvent,
  type FilesDownloadFailEvent,
  type FilesGetStartEvent,
  type FilesGetFinishEvent,
  type FilesGetFailEvent,
  type FilesListStartEvent,
  type FilesListFinishEvent,
  type FilesListFailEvent,
  type FilesDeleteStartEvent,
  type FilesDeleteFinishEvent,
  type FilesDeleteFailEvent,
  type FilesCreateFolderStartEvent,
  type FilesCreateFolderFinishEvent,
  type FilesCreateFolderFailEvent,
  type FilesTtlSetStartEvent,
  type FilesTtlSetFinishEvent,
  type FilesTtlSetFailEvent,
  type FilesPrivacyChangeStartEvent,
  type FilesPrivacyChangeFinishEvent,
  type FilesPrivacyChangeFailEvent,
} from './events.js';

// Generic base class -- consumers can also catch via `instanceof LiteError`.
export { LiteError, isLiteError } from '../errors.js';

import type {
  FilesItem,
  FilesContent,
  FilesUploadOptions,
  FilesDownloadOptions,
  FilesListOptions,
  FilesDeleteOptions,
} from './types.js';

/**
 * The public surface of the files module.
 *
 * **Error contract**: every method throws `FilesError` (extends
 * `LiteError`) on failure. Inspect `.code`:
 * `FILES_NOT_AUTHENTICATED`, `FILES_NOT_FOUND`, `FILES_HTTP`,
 * `FILES_NETWORK`, `FILES_ALREADY_EXISTS`, `FILES_TOO_LARGE`,
 * `FILES_INVALID_INPUT`. `get()` and `delete()` soft-fail
 * not-found (return null / no-op).
 *
 * **Auth**: every method requires a signed-in OneReach account.
 * Signed-out callers see `FILES_NOT_AUTHENTICATED`.
 */
export interface FilesApi {
  /**
   * Upload bytes to a key inside the account's bucket. Returns the
   * full download URL (good for ~15 min for private files).
   */
  upload(
    prefix: string,
    fileName: string,
    content: FilesContent,
    options?: FilesUploadOptions
  ): Promise<string>;

  /**
   * Get a fresh signed download URL for an existing key. Use when
   * you need to hand the URL to a renderer or external system.
   */
  getDownloadUrl(key: string, options?: FilesDownloadOptions): Promise<string>;

  /**
   * Convenience: download the file's bytes via a signed URL. Returns
   * the raw `ArrayBuffer`. Throws `FILES_NOT_FOUND` on 404.
   */
  download(key: string, options?: FilesDownloadOptions): Promise<ArrayBuffer>;

  /**
   * Read a single file's metadata. Returns null if the key doesn't
   * exist (mirrors `kv.get`'s missing-key contract).
   */
  get(key: string, options?: FilesDownloadOptions): Promise<FilesItem | null>;

  /** List items under a prefix. Empty prefix lists from bucket root. */
  list(prefix: string, options?: FilesListOptions): Promise<FilesItem[]>;

  /** Create a folder. Idempotent at the SDK level. */
  createFolder(folderName: string): Promise<void>;

  /**
   * Delete a single file. Soft-fails 404 (no-op when the key is
   * already gone).
   */
  delete(key: string, options?: FilesDeleteOptions): Promise<void>;

  /** Delete a folder and everything underneath it. */
  deleteFolder(folderKey: string): Promise<void>;

  /** Set / clear a TTL. Pass `null` to clear. */
  setTtl(key: string, expiresAt: string | null, options?: FilesDeleteOptions): Promise<void>;

  /** Flip a file's privacy in place. */
  setPrivacy(
    key: string,
    newPrivacy: 'private' | 'public',
    options?: FilesDeleteOptions
  ): Promise<void>;

  /**
   * Subscribe to typed files events (ADR-032). Branch on `ev.name`
   * for type-narrowed access.
   */
  onEvent(handler: (event: FilesEvent) => void): () => void;
}

let _instance: FilesApi | null = null;

/**
 * Get the singleton files API. Lazily instantiates on first call.
 *
 * Default backing implementation is `SdkFilesClient` wired to:
 *   - the auth bindings registered via `setFilesAuthBindings` from
 *     main-lite.ts (after initAuth)
 *   - the env-specific `discoveryUrl` from `ENVIRONMENT_CONFIGS`
 */
export function getFilesApi(): FilesApi {
  if (_instance === null) {
    _instance = new SdkFilesClient(defaultConfig());
  }
  return _instance;
}

/** Reset the singleton (for tests). */
export function _resetFilesApiForTesting(): void {
  _instance = null;
  _authBindings = null;
}

/**
 * Override the singleton with a custom implementation (for tests).
 */
export function _setFilesApiForTesting(api: FilesApi): void {
  _instance = api;
}

/**
 * @internal -- exposed so tests can pass a custom SDK ctor without
 * going through the singleton.
 */
export function _buildFilesApiForTesting(config: SdkFilesClientConfig): FilesApi {
  return new SdkFilesClient(config);
}

// ─── auth wiring ─────────────────────────────────────────────────────────
//
// Same pattern as `setKVAuthBindings` (ADR-044). The Files module
// must NOT import `lite/auth/` at module-load time because
// `auth/store.ts` imports `kv/api.ts`, and we want to keep
// `lite/files/` isolated from auth's import graph too. main-lite.ts
// (which sits above both) calls setFilesAuthBindings() after
// initAuth completes.

/** Late-bound auth resolvers for the default `SdkFilesClient` config. */
export interface FilesAuthBindings {
  /** Returns the bearer token, or empty string when signed-out. */
  getToken: () => string;
  /** Returns the active accountId, or null when signed-out. */
  getAccountId: () => string | null;
}

let _authBindings: FilesAuthBindings | null = null;

/**
 * Wire the files module's default config to a live auth source. Should
 * be called exactly once at app boot, after `initAuth()`.
 */
export function setFilesAuthBindings(bindings: FilesAuthBindings): void {
  _authBindings = bindings;
}

function defaultConfig(): SdkFilesClientConfig {
  const edisonConfig = ENVIRONMENT_CONFIGS['edison'];
  if (edisonConfig === undefined) {
    throw new Error('lite/files: no EnvironmentConfig found for edison');
  }
  return {
    token: () => _authBindings?.getToken() ?? '',
    discoveryUrl: edisonConfig.discoveryUrl,
    accountId: () => _authBindings?.getAccountId() ?? null,
    logger: (level, message, data) => {
      const log = getLoggingApi();
      log[level]('files', message, data);
    },
    spanEmitter: (name, data) => getLoggingApi().start(name, data),
  };
}
