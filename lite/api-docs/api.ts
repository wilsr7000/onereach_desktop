/**
 * API Docs module -- PUBLIC API.
 *
 * Per ADR-019 / Rule 11 in `lite/LITE-RULES.md`, cross-module imports
 * go through `<module>/api.ts` -- never reach into `main.ts`,
 * `window.ts`, or any other internal file.
 *
 * Per ADR-035, this module ships the in-app API Reference window: a
 * single-instance BrowserWindow that lists every documented lite
 * module. The doc data is harvested at build time from
 * `lite/<module>/api.ts`, `events.ts`, and `README.md` by
 * `lite/api-docs/manifest-builder.mjs`. The manifest is bundled into
 * the renderer so the window is fully populated without any IPC
 * round-trips for content (only `lite:api-docs:open` for window
 * control).
 *
 * Usage from another module / renderer:
 *
 *   import { getApiDocsApi } from '../api-docs/api.js';
 *   getApiDocsApi().open();
 *
 *   // or from a renderer with the preload bridge:
 *   await window.lite.apiDocs.open();
 *
 * Tests: `_setApiDocsApiForTesting(stub)` to inject a custom
 * implementation, `_resetApiDocsApiForTesting()` to clear the singleton.
 */

// Re-export the manifest types so consumers (tests, future Help-menu
// surface, etc.) can typecheck against the same shapes the renderer
// uses.
export type { Manifest, ModuleDoc, MethodDoc, EventDoc } from './types.js';

/**
 * The public surface of the API Docs module.
 *
 * **Error contract**: `open()` is fire-and-forget; opening failures
 * are logged via `getLoggingApi()` but never thrown back to the caller.
 * The window is a developer-facing surface; failure to open is not a
 * user-blocking event.
 */
export interface ApiDocsApi {
  /**
   * Open (or focus) the API Reference window. Idempotent: subsequent
   * calls focus the existing window instead of opening a second.
   *
   * @returns Nothing. Fire-and-forget.
   *
   * @example
   * ```typescript
   * import { getApiDocsApi } from '../api-docs/api.js';
   * getApiDocsApi().open();
   * ```
   */
  open(): void;
}

/**
 * Default backing implementation. Wired by `lite/api-docs/main.ts`
 * via `_setApiDocsApiForTesting()` once the BrowserWindow factory is
 * initialized at boot.
 *
 * Until `initApiDocs({...})` runs, calls to `getApiDocsApi().open()`
 * are no-ops (a warning is logged via `getLoggingApi()`).
 */
class UninitializedApiDocsApi implements ApiDocsApi {
  open(): void {
    // Lazy import to avoid pulling logging into modules that just
    // typecheck against `ApiDocsApi`.
    void import('../logging/api.js').then((m) => {
      m.getLoggingApi().warn('api-docs', 'open() called before initApiDocs()');
    });
  }
}

let _instance: ApiDocsApi = new UninitializedApiDocsApi();

/**
 * Get the singleton API Docs API. Lazily initialized -- `initApiDocs`
 * in `main.ts` swaps in the real implementation at boot.
 */
export function getApiDocsApi(): ApiDocsApi {
  return _instance;
}

/** Reset the singleton (for tests). */
export function _resetApiDocsApiForTesting(): void {
  _instance = new UninitializedApiDocsApi();
}

/**
 * Override the singleton with a custom implementation. Used by
 * `initApiDocs()` at boot to install the real BrowserWindow-backed
 * implementation, and by tests to inject stubs.
 */
export function _setApiDocsApiForTesting(api: ApiDocsApi): void {
  _instance = api;
}
