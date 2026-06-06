/**
 * Downloads module — PUBLIC API.
 *
 * Per ADR-019 / Rule 11 (`lite/LITE-RULES.md`), cross-module imports go
 * through this file — never reach into `handler.ts`, `picker-window.ts`,
 * or any other internal file from outside the module.
 *
 * Today the public surface is tiny: most of the module's work is
 * triggered implicitly by Electron's `will-download` event, not by
 * other modules calling in. The one entry point is
 * `attachToSession(s)` — used when a new per-tab session is created
 * after boot (the chrome session is wired by default in
 * `initDownloads`).
 *
 * Re-exports the public types + the typed `DownloadsError` codes for
 * consumers that need them (currently none; placeholder for parity
 * with sibling modules' api.ts shape).
 */

import type { Session } from 'electron';

// Re-export the public types consumers need. (The bulk of the
// module's types -- CapturedDownload, PickerBootstrap, PickerResult --
// stay internal.)
export type { DerivedItemKind } from './mime.js';

/**
 * The public surface of the downloads module.
 *
 * **Lifecycle**: returned from `initDownloads(...)` and also exposed
 * as a singleton via `getDownloadsApi()` so peer modules can call in
 * without holding the boot-time handle.
 *
 * **Behavior**: callers normally never invoke any of these methods.
 * The `will-download` listener installed at init handles every
 * download surface (main window, secure windows, IDW tabs, ...) on
 * its own. The method below exists for the rare case where a new
 * `Session` is created at runtime (e.g. a freshly-created tab with
 * a custom partition) and needs the handler attached.
 */
export interface DownloadsApi {
  /**
   * Attach the `will-download` handler to an additional session.
   * Returns an unhook function. Idempotent — calling for a session
   * that's already attached returns a no-op unhook.
   */
  attachToSession(s: Session): () => void;
}

let _instance: DownloadsApi = buildUninitializedApi();

/**
 * Get the singleton downloads API. Until `initDownloads()` runs the
 * singleton throws `DOWNLOADS_NOT_INITIALIZED`-shaped errors on use
 * (the orchestrator publishes a live api as soon as it's wired).
 */
export function getDownloadsApi(): DownloadsApi {
  return _instance;
}

/** Reset to the uninitialized stub. Test seam. */
export function _resetDownloadsApiForTesting(): void {
  _instance = buildUninitializedApi();
}

/**
 * Override the singleton with a custom implementation. `main.ts`
 * calls this once at boot with the live api; tests can stub it.
 */
export function _setDownloadsApiForTesting(api: DownloadsApi): void {
  _instance = api;
}

function buildUninitializedApi(): DownloadsApi {
  return {
    attachToSession: () => {
      throw new Error(
        'downloads.attachToSession() called before initDownloads()'
      );
    },
  };
}
