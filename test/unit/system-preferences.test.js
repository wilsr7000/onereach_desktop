/**
 * SystemPreferences tests
 *
 * Run: npx vitest run test/unit/system-preferences.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

const { SystemPreferences } = require('../../lib/system-preferences');

function makePrefs(locale, overrides = {}) {
  const p = new SystemPreferences();
  p.init({
    appGetLocale: () => locale,
    appGetLocaleCountryCode: () => (locale.split('-')[1] || '').toUpperCase(),
  });
  if (Object.keys(overrides).length) p.setOverrides(overrides);
  return p;
}

describe('SystemPreferences', () => {
  describe('US defaults', () => {
    it('derives imperial, 12h, MDY, Sunday start', () => {
      const snap = makePrefs('en-US').getAll();
      expect(snap.units).toBe('imperial');
      expect(snap.temperatureUnit).toBe('fahrenheit');
      expect(snap.distanceUnit).toBe('miles');
      expect(snap.timeFormat).toBe('12h');
      expect(snap.dateFormat).toBe('MDY');
      expect(snap.firstDayOfWeek).toBe('sunday');
    });
  });

  describe('UK defaults', () => {
    it('metric, 24h, DMY, Monday start', () => {
      const snap = makePrefs('en-GB').getAll();
      expect(snap.units).toBe('metric');
      expect(snap.temperatureUnit).toBe('celsius');
      expect(snap.distanceUnit).toBe('kilometers');
      expect(snap.timeFormat).toBe('24h');
      expect(snap.dateFormat).toBe('DMY');
      expect(snap.firstDayOfWeek).toBe('monday');
    });
  });

  describe('Japan defaults', () => {
    it('metric, 24h, YMD, Sunday start', () => {
      const snap = makePrefs('ja-JP').getAll();
      expect(snap.units).toBe('metric');
      expect(snap.timeFormat).toBe('24h');
      expect(snap.dateFormat).toBe('YMD');
      expect(snap.firstDayOfWeek).toBe('sunday');
    });
  });

  describe('Germany defaults', () => {
    it('metric, 24h, DMY, Monday start', () => {
      const snap = makePrefs('de-DE').getAll();
      expect(snap.units).toBe('metric');
      expect(snap.timeFormat).toBe('24h');
      expect(snap.dateFormat).toBe('DMY');
      expect(snap.firstDayOfWeek).toBe('monday');
    });
  });

  describe('user overrides', () => {
    it('override beats locale default', () => {
      const p = makePrefs('en-US', { temperatureUnit: 'celsius' });
      expect(p.getAll().temperatureUnit).toBe('celsius');
      expect(p.getAll().distanceUnit).toBe('miles'); // non-overridden stays
    });

    it('setOverride invalidates the cached snapshot', () => {
      const p = makePrefs('en-US');
      const a = p.getAll();
      p.setOverride('units', 'metric');
      const b = p.getAll();
      expect(a.units).toBe('imperial');
      expect(b.units).toBe('metric');
    });
  });

  describe('unknown locale', () => {
    it('defaults to metric 24h DMY for unspecified regions', () => {
      const snap = makePrefs('xx-ZZ').getAll();
      expect(snap.units).toBe('metric');
      expect(snap.timeFormat).toBe('24h');
      expect(snap.dateFormat).toBe('DMY');
    });
  });

  describe('timezone', () => {
    it('derives a timezone from Intl', () => {
      const snap = makePrefs('en-US').getAll();
      expect(snap.timezone).toMatch(/\w+\/\w+|UTC/);
    });
  });
});
