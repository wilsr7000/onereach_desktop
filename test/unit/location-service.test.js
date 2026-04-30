/**
 * LocationService tests
 *
 * Run: npx vitest run test/unit/location-service.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  }),
}));

const { LocationService } = require('../../lib/location-service');

describe('LocationService', () => {
  let svc;

  beforeEach(() => {
    svc = new LocationService();
    vi.restoreAllMocks();
  });

  describe('reportPrecise', () => {
    it('accepts valid coordinates and returns them as the snapshot', () => {
      const ok = svc.reportPrecise({
        latitude: 37.8716, longitude: -122.2727, accuracy: 20,
      });
      expect(ok).toBe(true);
      const snap = svc.getSnapshot();
      expect(snap.source).toBe('precise');
      expect(snap.latitude).toBe(37.8716);
      expect(snap.accuracy).toBe(20);
    });

    it('rejects missing coordinates', () => {
      expect(svc.reportPrecise({})).toBe(false);
      expect(svc.reportPrecise({ latitude: 'bad', longitude: 0 })).toBe(false);
    });

    it('backfills city/region/country/timezone from cached IP', () => {
      // Prime the IP cache by monkey-patching
      svc._ip = {
        city: 'Berkeley', region: 'CA', country: 'United States',
        timezone: 'America/Los_Angeles', latitude: 37.87, longitude: -122.27,
        fetchedAt: Date.now(), source: 'ip',
      };
      svc.reportPrecise({ latitude: 37.8716, longitude: -122.2727, accuracy: 15 });
      const snap = svc.getSnapshot();
      expect(snap.city).toBe('Berkeley');
      expect(snap.region).toBe('CA');
      expect(snap.timezone).toBe('America/Los_Angeles');
    });
  });

  describe('getLocation priority', () => {
    it('prefers precise over IP when both are fresh', async () => {
      svc._ip = {
        city: 'San Francisco', latitude: 37.77, longitude: -122.41,
        fetchedAt: Date.now(), source: 'ip',
      };
      svc.reportPrecise({
        latitude: 37.8716, longitude: -122.2727, accuracy: 15, city: 'Berkeley',
      });
      const loc = await svc.getLocation();
      expect(loc.source).toBe('precise');
      expect(loc.city).toBe('Berkeley');
    });

    it('falls back to IP when precise is stale', async () => {
      svc._ip = {
        city: 'Oakland', latitude: 37.80, longitude: -122.27,
        fetchedAt: Date.now(), source: 'ip',
      };
      // Precise, but set reportedAt to something older than the TTL.
      svc._precise = {
        latitude: 37.87, longitude: -122.27,
        reportedAt: Date.now() - (11 * 60 * 1000),
        source: 'precise',
      };
      const loc = await svc.getLocation();
      expect(loc.source).toBe('ip');
      expect(loc.city).toBe('Oakland');
    });

    it('falls back to stored when network is unavailable', async () => {
      svc._stored = {
        city: 'Paris', country: 'France', latitude: 48.85, longitude: 2.35,
        fetchedAt: Date.now() - 10 * 60 * 60 * 1000,
        source: 'stored',
      };
      // Force IP refresh to fail
      svc._refreshIp = async () => { throw new Error('offline'); };
      const loc = await svc.getLocation();
      expect(loc.source).toBe('stored');
      expect(loc.city).toBe('Paris');
    });

    it('returns unknown when nothing is available', async () => {
      svc._refreshIp = async () => { throw new Error('offline'); };
      const loc = await svc.getLocation();
      expect(loc.source).toBe('unknown');
    });
  });

  describe('getSnapshot (sync, no IO)', () => {
    it('returns the freshest available without touching network', () => {
      const spy = vi.spyOn(svc, '_refreshIp');
      svc.reportPrecise({ latitude: 1, longitude: 2 });
      const snap = svc.getSnapshot();
      expect(snap.source).toBe('precise');
      expect(spy).not.toHaveBeenCalled();
    });

    it('ageMs reflects how old the snapshot is', () => {
      svc.reportPrecise({ latitude: 1, longitude: 2 });
      const snap = svc.getSnapshot();
      expect(snap.ageMs).toBeGreaterThanOrEqual(0);
      expect(snap.ageMs).toBeLessThan(100);
    });
  });
});
