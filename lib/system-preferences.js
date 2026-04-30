/**
 * System Preferences
 *
 * Single source of truth for user preferences that have sensible
 * defaults from the OS locale. Agents ask: "should I show 68°F or
 * 20°C? 14:00 or 2pm? Monday April 13 or 13/04?". Historically these
 * lived in `gsx-agent/main.md` -- a markdown file the user had to edit
 * manually. Result: nothing ever got set and every agent assumed US
 * defaults, even for users in France or Japan.
 *
 * This module:
 *   1. Derives intelligent defaults from `app.getLocale()` and Intl APIs.
 *   2. Lets the user explicitly override via settings.
 *   3. Exposes a synchronous snapshot so agents can inject preferences
 *      into prompts without async calls.
 *
 * Behaviour chart:
 *    Locale         Units      Time     Date       First day
 *    ---------      -----      -----    -----      ---------
 *    en-US          imperial   12h      MDY        Sunday
 *    en-GB          metric     12h      DMY        Monday
 *    en-CA          metric     12h      YMD        Sunday
 *    en-AU          metric     12h      DMY        Monday
 *    ja-JP          metric     24h      YMD        Sunday
 *    zh-CN          metric     24h      YMD        Monday
 *    de-DE / fr-FR  metric     24h      DMY        Monday
 *    anything else  metric     24h      DMY        Monday
 */

'use strict';

const { getLogQueue } = require('./log-event-queue');

// Regions that use imperial units for everyday measurements.
const IMPERIAL_REGIONS = new Set(['US', 'LR', 'MM']);

// Regions that use 12-hour time by default.
const TWELVE_HOUR_REGIONS = new Set([
  'US', 'CA', 'AU', 'NZ', 'IN', 'PH', 'EG', 'SA', 'MX', 'CO', 'PE',
  'NG', 'KE', 'BD', 'PK', 'MY', 'SG',
]);

// Regions using Month-Day-Year order.
const MDY_REGIONS = new Set(['US', 'BZ', 'MH', 'MM', 'PW']);
// Regions using Year-Month-Day order.
const YMD_REGIONS = new Set(['CN', 'JP', 'KR', 'TW', 'HU', 'IR', 'LT', 'MN']);

// Regions where the week starts on Sunday (everywhere else: Monday).
const SUNDAY_START_REGIONS = new Set([
  'US', 'CA', 'JP', 'BR', 'PH', 'MX', 'CO', 'PE', 'VE', 'IL', 'IN',
  'TH', 'TW', 'HK', 'ZA', 'EG', 'SA', 'NG',
]);

class SystemPreferences {
  constructor() {
    this._log = getLogQueue();
    this._locale = null;      // "en-US"
    this._language = null;    // "en"
    this._region = null;      // "US"
    this._timezone = null;    // "America/Los_Angeles"
    this._cache = null;
    this._overrides = {};     // user-supplied overrides from settings
  }

  init({ appGetLocale, appGetLocaleCountryCode } = {}) {
    try {
      // Prefer the Electron APIs when available; fall back to Intl.
      let locale = null;
      if (typeof appGetLocale === 'function') {
        try { locale = appGetLocale(); } catch (_) { /* ignore */ }
      }
      if (!locale) {
        try {
          locale = Intl.DateTimeFormat().resolvedOptions().locale;
        } catch (_) { /* ignore */ }
      }
      if (!locale) locale = 'en-US';

      this._locale = locale;
      const parts = locale.split(/[-_]/);
      this._language = parts[0] || 'en';
      let region = parts[1];
      if (!region && typeof appGetLocaleCountryCode === 'function') {
        try { region = appGetLocaleCountryCode(); } catch (_) { /* ignore */ }
      }
      this._region = (region || '').toUpperCase() || null;

      try {
        this._timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch (_) { /* ignore */ }

      this._log.info('app', '[SystemPreferences] Derived defaults', {
        locale: this._locale,
        region: this._region,
        timezone: this._timezone,
      });
    } catch (err) {
      this._log.warn('app', '[SystemPreferences] Init failed', { error: err.message });
    }
    this._cache = null;
    return this;
  }

  setOverride(key, value) {
    this._overrides[key] = value;
    this._cache = null;
  }

  setOverrides(overrides) {
    this._overrides = { ...this._overrides, ...(overrides || {}) };
    this._cache = null;
  }

  /**
   * Return the current snapshot of preferences. Pure and synchronous.
   */
  getAll() {
    if (this._cache) return this._cache;
    const region = this._region || '';
    const snap = {
      locale: this._locale,
      language: this._language,
      region,
      timezone: this._timezone,
      units: IMPERIAL_REGIONS.has(region) ? 'imperial' : 'metric',
      temperatureUnit: IMPERIAL_REGIONS.has(region) ? 'fahrenheit' : 'celsius',
      distanceUnit: IMPERIAL_REGIONS.has(region) ? 'miles' : 'kilometers',
      timeFormat: TWELVE_HOUR_REGIONS.has(region) ? '12h' : '24h',
      dateFormat: MDY_REGIONS.has(region)
        ? 'MDY'
        : YMD_REGIONS.has(region)
          ? 'YMD'
          : 'DMY',
      firstDayOfWeek: SUNDAY_START_REGIONS.has(region) ? 'sunday' : 'monday',
    };
    // Apply user overrides last so they take priority.
    Object.assign(snap, this._overrides);
    this._cache = Object.freeze(snap);
    return this._cache;
  }

  /** Testing hook */
  _resetForTests() {
    this._locale = null;
    this._region = null;
    this._timezone = null;
    this._overrides = {};
    this._cache = null;
  }
}

let _instance = null;
function getSystemPreferences() {
  if (!_instance) _instance = new SystemPreferences();
  return _instance;
}

module.exports = {
  SystemPreferences,
  getSystemPreferences,
  // Exported for tests
  IMPERIAL_REGIONS,
  TWELVE_HOUR_REGIONS,
  MDY_REGIONS,
  YMD_REGIONS,
};
