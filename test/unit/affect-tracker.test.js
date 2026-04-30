/**
 * Affect Tracker - Unit Tests
 *
 * Run:  npx vitest run test/unit/affect-tracker.test.js
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const {
  getSharedAffectTracker,
  configureAffectTracker,
  resetSharedAffectTracker,
  DEFAULT_TTL_MS,
  PRIORITY,
} = require('../../lib/naturalness/affect-tracker');

describe('affect-tracker', () => {
  let clockMs;
  beforeEach(() => {
    resetSharedAffectTracker();
    clockMs = 1_000_000;
    configureAffectTracker({ now: () => clockMs, ttlMs: 60_000 });
  });
  afterEach(() => {
    resetSharedAffectTracker();
  });

  describe('record + get', () => {
    it('stores a non-neutral affect', () => {
      const tracker = getSharedAffectTracker();
      tracker.record({ label: 'frustrated', confidence: 0.8, signals: [] });
      expect(tracker.get()).toMatchObject({
        label: 'frustrated',
        confidence: 0.8,
      });
    });

    it('ignores neutral', () => {
      const tracker = getSharedAffectTracker();
      tracker.record({ label: 'neutral', confidence: 1, signals: [] });
      expect(tracker.get()).toBeNull();
    });

    it('ignores unknown labels', () => {
      const tracker = getSharedAffectTracker();
      tracker.record({ label: 'sleepy', confidence: 1 });
      expect(tracker.get()).toBeNull();
    });

    it('ignores null / undefined input', () => {
      const tracker = getSharedAffectTracker();
      tracker.record(null);
      tracker.record(undefined);
      tracker.record({});
      expect(tracker.get()).toBeNull();
    });

    it('the returned value is a defensive copy (no recordedAt leak)', () => {
      const tracker = getSharedAffectTracker();
      tracker.record({ label: 'excited', confidence: 0.5 });
      const got = tracker.get();
      expect(got).not.toHaveProperty('recordedAt');
    });
  });

  describe('TTL decay', () => {
    it('returns null after TTL elapses', () => {
      const tracker = getSharedAffectTracker();
      tracker.record({ label: 'rushed' });
      clockMs += 30_000;
      expect(tracker.get()).toMatchObject({ label: 'rushed' });
      clockMs += 40_000; // now 70s total
      expect(tracker.get()).toBeNull();
    });

    it('a stale affect is replaced even by a lower-priority one', () => {
      const tracker = getSharedAffectTracker();
      tracker.record({ label: 'frustrated' });
      clockMs += 70_000; // expire
      tracker.record({ label: 'deliberate' });
      expect(tracker.get()).toMatchObject({ label: 'deliberate' });
    });
  });

  describe('priority', () => {
    it('in-TTL higher-priority affect replaces lower-priority', () => {
      const tracker = getSharedAffectTracker();
      tracker.record({ label: 'hesitant' });
      tracker.record({ label: 'frustrated' });
      expect(tracker.get()).toMatchObject({ label: 'frustrated' });
    });

    it('in-TTL lower-priority affect does NOT replace higher', () => {
      const tracker = getSharedAffectTracker();
      tracker.record({ label: 'frustrated' });
      tracker.record({ label: 'hesitant' });
      expect(tracker.get()).toMatchObject({ label: 'frustrated' });
    });

    it('equal priority replaces (newer wins)', () => {
      const tracker = getSharedAffectTracker();
      tracker.record({ label: 'excited', signals: ['a'] });
      clockMs += 1_000;
      tracker.record({ label: 'excited', signals: ['b'] });
      expect(tracker.get().signals).toEqual(['b']);
    });

    it('PRIORITY table is frozen-feeling (all known labels present)', () => {
      for (const l of ['frustrated', 'rushed', 'excited', 'hesitant', 'deliberate']) {
        expect(PRIORITY[l]).toBeGreaterThan(0);
      }
    });
  });

  describe('clear', () => {
    it('clear empties the store', () => {
      const tracker = getSharedAffectTracker();
      tracker.record({ label: 'excited' });
      tracker.clear();
      expect(tracker.get()).toBeNull();
    });
  });

  describe('configuration', () => {
    it('configureAffectTracker resets the instance', () => {
      const a = getSharedAffectTracker();
      configureAffectTracker({ now: () => 2_000_000, ttlMs: 1_000 });
      const b = getSharedAffectTracker();
      expect(a).not.toBe(b);
    });

    it('respects custom TTL', () => {
      configureAffectTracker({ now: () => clockMs, ttlMs: 2_000 });
      const tracker = getSharedAffectTracker();
      tracker.record({ label: 'rushed' });
      clockMs += 1_500;
      expect(tracker.get()).toMatchObject({ label: 'rushed' });
      clockMs += 1_000;
      expect(tracker.get()).toBeNull();
    });

    it('DEFAULT_TTL_MS is 60s', () => {
      expect(DEFAULT_TTL_MS).toBe(60_000);
    });
  });
});
