/**
 * Device identity (v5 Section 4.2)
 *
 * Each device has a stable ULID `deviceId` that:
 *   - keys its vector-clock slot
 *   - identifies the writer in :OperationLog and :Heartbeat
 *   - participates in device-rebind ops (Path A: live handoff with signed payload;
 *     Path B: user-attested via auth)
 *
 * Phase 1 ships:
 *   - deviceId generation on first launch, persisted via the existing settings
 *     manager (NOT yet OS keychain -- that's a separate auth-effort prerequisite)
 *   - deviceClass detection: 'desktop' for now. Mobile clients send their own
 *     class; this module is desktop-only for Phase 1.
 *
 * Phase 1 does NOT ship:
 *   - keychain persistence (waits on Phase 0 auth)
 *   - rebind ops Path A or Path B (Phase 3, gated by auth for Path B)
 *   - iOS lifecycle bridging (waits on iOS app effort)
 */

'use strict';

const { newTraceId } = require('./trace-id');
const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

const SETTINGS_KEY_DEVICE_ID = 'syncV5.deviceId';
const SETTINGS_KEY_DEVICE_CREATED_AT = 'syncV5.deviceCreatedAt';

const DEVICE_CLASS = Object.freeze({
  DESKTOP: 'desktop',
  MOBILE: 'mobile',
});

let _cachedDeviceId = null;

/**
 * Get this device's stable identifier. Generates and persists on first call.
 *
 * Idempotent across calls. NOT idempotent across keychain resets / OS
 * reinstalls / disk failures -- those are the cases handled by Path B device
 * rebind in Phase 3 (which requires authenticated identity from Phase 0).
 *
 * @param {object} [opts]
 * @param {object} [opts.settingsManager]
 * @returns {string} a 26-char ULID
 */
function getDeviceId(opts = {}) {
  if (_cachedDeviceId) return _cachedDeviceId;
  const settings = _resolveSettingsManager(opts.settingsManager);
  if (!settings) {
    // Fallback: ephemeral ID for this process. NOT persistent. Used in tests
    // and during very early boot before settings manager is ready.
    const eph = newTraceId();
    log.warn('sync-v5', 'Device ID requested before settings manager ready; using ephemeral ID', {
      ephemeralId: eph,
    });
    return eph;
  }
  let id = settings.get(SETTINGS_KEY_DEVICE_ID);
  if (!id) {
    id = newTraceId();
    settings.set(SETTINGS_KEY_DEVICE_ID, id);
    settings.set(SETTINGS_KEY_DEVICE_CREATED_AT, new Date().toISOString());
    log.info('sync-v5', 'Generated new deviceId', { deviceId: id });
  }
  _cachedDeviceId = id;
  return id;
}

/**
 * Detect this device's class. Phase 1 is desktop-only -- iOS clients will set
 * their own class via the heartbeat shape on the iOS side.
 *
 * Implementation note: process.platform is 'darwin' / 'win32' / 'linux' for
 * desktop. Electron's main process never returns iOS values. So this defaults
 * to DESKTOP and is overridable per call (so the iOS bridge in Phase 1+ can
 * inject MOBILE without touching this code).
 *
 * @param {string} [override]
 * @returns {'desktop'|'mobile'}
 */
function getDeviceClass(override) {
  if (override === DEVICE_CLASS.DESKTOP || override === DEVICE_CLASS.MOBILE) {
    return override;
  }
  // process.platform never indicates iOS in Electron-main. If we ever ship
  // iOS, the iOS app will inject DEVICE_CLASS.MOBILE explicitly via this
  // module's setOverrideDeviceClass() (or its own HeartbeatReporter
  // construction).
  return DEVICE_CLASS.DESKTOP;
}

/**
 * Get the wall-clock time when the deviceId was first generated. Used by
 * diagnostics to display "device active since".
 *
 * @param {object} [opts]
 * @returns {string|null} ISO 8601 timestamp or null if unknown
 */
function getDeviceCreatedAt(opts = {}) {
  const settings = _resolveSettingsManager(opts.settingsManager);
  if (!settings) return null;
  return settings.get(SETTINGS_KEY_DEVICE_CREATED_AT) || null;
}

/**
 * Reset cached deviceId. Test-only; not used in production.
 */
function _resetCache() {
  _cachedDeviceId = null;
}

// ────────────────────────────────────────────────────────────────────────────
// Internal
// ────────────────────────────────────────────────────────────────────────────

function _resolveSettingsManager(injected) {
  if (injected) return injected;
  try {
    const { getSettingsManager } = require('../../settings-manager');
    return getSettingsManager();
  } catch (_) {
    return null;
  }
}

module.exports = {
  DEVICE_CLASS,
  SETTINGS_KEY_DEVICE_ID,
  SETTINGS_KEY_DEVICE_CREATED_AT,
  getDeviceId,
  getDeviceClass,
  getDeviceCreatedAt,
  _resetCache,
};
