/**
 * Agent Transition Tracker - Unit Tests
 *
 * Run:  npx vitest run test/unit/agent-transition-tracker.test.js
 */

import { describe, it, expect, beforeEach } from 'vitest';

const {
  AgentTransitionTracker,
  DEFAULT_TTL_MS,
  getSharedTracker,
} = require('../../lib/naturalness/agent-transition-tracker');

describe('AgentTransitionTracker', () => {
  let nowMs;
  let tracker;

  beforeEach(() => {
    nowMs = 1_000_000;
    tracker = new AgentTransitionTracker({
      ttlMs: 60_000, // 1 minute for easier assertions
      now: () => nowMs,
    });
  });

  describe('basic record/get', () => {
    it('getLastAgent returns null when nothing recorded', () => {
      expect(tracker.getLastAgent('voice')).toBeNull();
    });

    it('recordAgent + getLastAgent roundtrips', () => {
      tracker.recordAgent('voice', 'dj-agent');
      expect(tracker.getLastAgent('voice')).toBe('dj-agent');
    });

    it('different context keys stay isolated', () => {
      tracker.recordAgent('voice', 'dj-agent');
      tracker.recordAgent('recorder', 'meeting-notes-agent');
      expect(tracker.getLastAgent('voice')).toBe('dj-agent');
      expect(tracker.getLastAgent('recorder')).toBe('meeting-notes-agent');
    });

    it('recordAgent overwrites the previous entry', () => {
      tracker.recordAgent('voice', 'dj-agent');
      nowMs += 1000;
      tracker.recordAgent('voice', 'time-agent');
      expect(tracker.getLastAgent('voice')).toBe('time-agent');
    });
  });

  describe('TTL', () => {
    it('getLastAgent returns null after TTL expires', () => {
      tracker.recordAgent('voice', 'dj-agent');
      nowMs += 120_000; // 2 minutes, past TTL
      expect(tracker.getLastAgent('voice')).toBeNull();
    });

    it('stale entries are removed on lookup', () => {
      tracker.recordAgent('voice', 'dj-agent');
      expect(tracker.size()).toBe(1);
      nowMs += 120_000;
      tracker.getLastAgent('voice');
      expect(tracker.size()).toBe(0);
    });

    it('recordAgent resets the clock window', () => {
      tracker.recordAgent('voice', 'dj-agent');
      nowMs += 50_000;
      tracker.recordAgent('voice', 'time-agent');
      nowMs += 50_000; // 100s since first record, 50s since second
      expect(tracker.getLastAgent('voice')).toBe('time-agent');
    });
  });

  describe('hasTransition', () => {
    it('false when no prior entry exists', () => {
      expect(tracker.hasTransition('voice', 'dj-agent')).toBe(false);
    });

    it('false when the same agent continues', () => {
      tracker.recordAgent('voice', 'dj-agent');
      expect(tracker.hasTransition('voice', 'dj-agent')).toBe(false);
    });

    it('true when a different agent is about to speak', () => {
      tracker.recordAgent('voice', 'dj-agent');
      expect(tracker.hasTransition('voice', 'time-agent')).toBe(true);
    });

    it('false after TTL expires even if agent differs', () => {
      tracker.recordAgent('voice', 'dj-agent');
      nowMs += 120_000;
      expect(tracker.hasTransition('voice', 'time-agent')).toBe(false);
    });

    it('false when nextAgentId is missing', () => {
      tracker.recordAgent('voice', 'dj-agent');
      expect(tracker.hasTransition('voice', null)).toBe(false);
      expect(tracker.hasTransition('voice', undefined)).toBe(false);
    });
  });

  describe('maintenance', () => {
    it('forget removes one key', () => {
      tracker.recordAgent('voice', 'dj-agent');
      tracker.recordAgent('recorder', 'meeting-notes-agent');
      tracker.forget('voice');
      expect(tracker.getLastAgent('voice')).toBeNull();
      expect(tracker.getLastAgent('recorder')).toBe('meeting-notes-agent');
    });

    it('clear drops everything', () => {
      tracker.recordAgent('a', 'x');
      tracker.recordAgent('b', 'y');
      tracker.clear();
      expect(tracker.size()).toBe(0);
      expect(tracker.getLastAgent('a')).toBeNull();
    });
  });

  describe('defensive inputs', () => {
    it('recordAgent is a no-op on empty strings', () => {
      tracker.recordAgent('', 'x');
      tracker.recordAgent('voice', '');
      expect(tracker.size()).toBe(0);
    });

    it('getLastAgent returns null on empty key', () => {
      expect(tracker.getLastAgent('')).toBeNull();
      expect(tracker.getLastAgent(null)).toBeNull();
    });

    it('invalid ttlMs falls back to DEFAULT_TTL_MS', () => {
      const t = new AgentTransitionTracker({ ttlMs: -1 });
      // Just smoke: that it constructs without throwing and can record
      t.recordAgent('k', 'a');
      expect(t.getLastAgent('k')).toBe('a');
    });
  });

  describe('getSharedTracker', () => {
    it('returns the same instance across calls', () => {
      const a = getSharedTracker();
      const b = getSharedTracker();
      expect(a).toBe(b);
      // Clean up so it does not leak into other test files.
      a.clear();
    });

    it('DEFAULT_TTL_MS is a positive number', () => {
      expect(DEFAULT_TTL_MS).toBeGreaterThan(0);
    });
  });
});
