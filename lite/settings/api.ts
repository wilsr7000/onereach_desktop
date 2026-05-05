/**
 * Settings module -- PUBLIC API.
 *
 * The only file other lite modules should import from in this module.
 * Per ADR-019 / Rule 11 in `lite/LITE-RULES.md`, cross-module imports
 * go through `<module>/api.ts` -- never reach into `main.ts`,
 * `window.ts`, or any other internal file.
 *
 * Per ADR-031, v1 ships one section (Two-Factor). The Settings window
 * is opened via the `Onereach.ai Lite -> Settings...` menu entry; the
 * `open()` method here is also exposed as `window.lite.settings.open()`
 * via the preload bridge so future placeholder UI (e.g. a Manage 2FA
 * button) can deep-link in.
 *
 * No error class in v1 -- failures inside the Two-Factor section bubble
 * through `TotpError` (see `lite/totp/api.ts`).
 *
 * Tests: `_setSettingsApiForTesting(stub)` to inject a custom
 * implementation, `_resetSettingsApiForTesting()` to clear the singleton.
 */

import type { SectionDescriptor } from './types.js';

// Re-export public types.
export type { SectionDescriptor } from './types.js';
export { SETTINGS_MODULE_VERSION } from './types.js';

/**
 * The public surface of the Settings module.
 *
 * **Error contract**: `open()` is fire-and-forget; opening failures are
 * logged but never thrown back to the caller. Section-level failures
 * surface inside the section's UI.
 */
export interface SettingsApi {
  /**
   * Open (or focus) the Settings window. Idempotent: subsequent calls
   * focus the existing window instead of opening a second.
   *
   * @param sectionId Optional section to deep-link to (e.g. 'idws',
   *   'oagi', 'two-factor'). When provided, the window opens with
   *   the matching section activated. When the window is already
   *   open, the existing window is focused and switched to the
   *   target section. Unknown ids are ignored (renderer falls back
   *   to the first section).
   */
  open(sectionId?: string): void;
}

/**
 * The default backing implementation. Wired by `lite/settings/main.ts`
 * via `_setSettingsApiForTesting()` once the BrowserWindow factory is
 * initialized at boot.
 *
 * Until `initSettings({...})` runs, calls to `getSettingsApi().open()`
 * are no-ops (a warning is logged via `getLoggingApi()`).
 */
class UninitializedSettingsApi implements SettingsApi {
  open(_sectionId?: string): void {
    // Lazy import to avoid pulling logging into modules that just
    // typecheck against `SettingsApi`.
    void import('../logging/api.js').then((m) => {
      m.getLoggingApi().warn('settings', 'open() called before initSettings()');
    });
  }
}

let _instance: SettingsApi = new UninitializedSettingsApi();

/**
 * Get the singleton Settings API. Lazily initialized -- `initSettings`
 * in `main.ts` swaps in the real implementation at boot. Until then,
 * `open()` is a no-op (safe for tests that only check the surface).
 */
export function getSettingsApi(): SettingsApi {
  return _instance;
}

/** Reset the singleton (for tests). */
export function _resetSettingsApiForTesting(): void {
  _instance = new UninitializedSettingsApi();
}

/**
 * Override the singleton with a custom implementation. Used by
 * `initSettings()` at boot to install the real BrowserWindow-backed
 * implementation, and by tests to inject stubs.
 */
export function _setSettingsApiForTesting(api: SettingsApi): void {
  _instance = api;
}

/**
 * Internal helper -- exposes the section-descriptor type so other
 * modules' code can typecheck against the shape if they want to
 * contribute sections in the future. Kept as an export from `api.ts`
 * so the discoverability lives next to the singleton.
 */
export type Section = SectionDescriptor;
