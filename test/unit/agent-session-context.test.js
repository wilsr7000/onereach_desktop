/**
 * Phase 2c (calendar agent overhaul) -- regression guard for the ephemeral
 * session-context store.
 *
 * Hard contract: nothing in lib/agent-session-context.js may ever touch the
 * filesystem. The lint rule (or convention) is that anything under
 * `sessionContext.*` is in-process scratch -- if a value needs to survive
 * restart it must go through `lib/calendar-memory.js`.
 *
 * This test file enforces:
 *   - Basic get/set/clear semantics, isolated by agentId.
 *   - TTL auto-clears values past their expiry.
 *   - Overwriting a TTL value cancels the prior timer.
 *   - clearAll() drops everything for the next test.
 *   - The module never opens a file handle (proxy spy on fs).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

const sessionContext = require('../../lib/agent-session-context');

describe('Phase 2c: agent-session-context', () => {
  beforeEach(() => {
    sessionContext.clearAll();
  });

  describe('basic get/set/clear', () => {
    it('round-trips a value', () => {
      sessionContext.setSession('agent-a', 'k', 'v');
      expect(sessionContext.getSessionValue('agent-a', 'k')).toBe('v');
    });

    it('overwrites previous value', () => {
      sessionContext.setSession('agent-a', 'k', 'v1');
      sessionContext.setSession('agent-a', 'k', 'v2');
      expect(sessionContext.getSessionValue('agent-a', 'k')).toBe('v2');
    });

    it('isolates state by agentId', () => {
      sessionContext.setSession('agent-a', 'k', 'a-value');
      sessionContext.setSession('agent-b', 'k', 'b-value');
      expect(sessionContext.getSessionValue('agent-a', 'k')).toBe('a-value');
      expect(sessionContext.getSessionValue('agent-b', 'k')).toBe('b-value');
    });

    it('getSession returns a snapshot object', () => {
      sessionContext.setSession('agent-a', 'k1', 'v1');
      sessionContext.setSession('agent-a', 'k2', { nested: true });
      const snap = sessionContext.getSession('agent-a');
      expect(snap).toEqual({ k1: 'v1', k2: { nested: true } });
    });

    it('getSessionValue returns undefined for missing key', () => {
      expect(sessionContext.getSessionValue('agent-a', 'never-set')).toBeUndefined();
    });

    it('getSession returns {} for unknown agent', () => {
      expect(sessionContext.getSession('unknown-agent')).toEqual({});
    });

    it('clearSessionValue removes a single key', () => {
      sessionContext.setSession('agent-a', 'k1', 'v1');
      sessionContext.setSession('agent-a', 'k2', 'v2');
      sessionContext.clearSessionValue('agent-a', 'k1');
      expect(sessionContext.getSessionValue('agent-a', 'k1')).toBeUndefined();
      expect(sessionContext.getSessionValue('agent-a', 'k2')).toBe('v2');
    });

    it('clearSession removes everything for one agent', () => {
      sessionContext.setSession('agent-a', 'k', 'v');
      sessionContext.setSession('agent-b', 'k', 'b-value');
      sessionContext.clearSession('agent-a');
      expect(sessionContext.getSession('agent-a')).toEqual({});
      expect(sessionContext.getSessionValue('agent-b', 'k')).toBe('b-value');
    });

    it('clearAll drops every agent', () => {
      sessionContext.setSession('a', 'k', 1);
      sessionContext.setSession('b', 'k', 2);
      sessionContext.setSession('c', 'k', 3);
      sessionContext.clearAll();
      expect(sessionContext._debugSize()).toBe(0);
    });
  });

  describe('TTL', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('auto-clears a value after ttlMs', () => {
      sessionContext.setSession('agent-a', 'k', 'v', { ttlMs: 1000 });
      expect(sessionContext.getSessionValue('agent-a', 'k')).toBe('v');
      vi.advanceTimersByTime(1500);
      expect(sessionContext.getSessionValue('agent-a', 'k')).toBeUndefined();
    });

    it('overwrite cancels prior TTL timer', () => {
      sessionContext.setSession('agent-a', 'k', 'old', { ttlMs: 500 });
      sessionContext.setSession('agent-a', 'k', 'new'); // no TTL
      vi.advanceTimersByTime(1000);
      // The 500ms timer for 'old' should have been cancelled. 'new' has no TTL.
      expect(sessionContext.getSessionValue('agent-a', 'k')).toBe('new');
    });

    it('expired value is filtered from getSession snapshot', () => {
      sessionContext.setSession('agent-a', 'k1', 'fresh', { ttlMs: 1000 });
      sessionContext.setSession('agent-a', 'k2', 'persistent');
      vi.advanceTimersByTime(2000);
      const snap = sessionContext.getSession('agent-a');
      expect(snap).toEqual({ k2: 'persistent' });
    });

    it('zero or negative ttlMs is treated as no TTL', () => {
      sessionContext.setSession('agent-a', 'k', 'v', { ttlMs: 0 });
      vi.advanceTimersByTime(10_000);
      expect(sessionContext.getSessionValue('agent-a', 'k')).toBe('v');
    });
  });

  describe('input safety', () => {
    it('setSession with empty agentId is a no-op', () => {
      sessionContext.setSession('', 'k', 'v');
      sessionContext.setSession(null, 'k', 'v');
      expect(sessionContext._debugSize()).toBe(0);
    });

    it('setSession with empty key is a no-op', () => {
      sessionContext.setSession('agent-a', '', 'v');
      expect(sessionContext._debugSize()).toBe(0);
    });

    it('getSessionValue is forgiving with missing args', () => {
      expect(sessionContext.getSessionValue()).toBeUndefined();
      expect(sessionContext.getSessionValue('agent-a')).toBeUndefined();
    });
  });

  describe('persistence contract: NEVER touches the filesystem', () => {
    it('does not call any fs write API during normal use', () => {
      const writeFile = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
      const appendFile = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {});
      const writeFileAsync = vi.spyOn(fs, 'writeFile').mockImplementation(() => {});

      try {
        sessionContext.setSession('agent-a', 'k1', { large: 'object' });
        sessionContext.setSession('agent-b', 'k2', 'string');
        sessionContext.getSession('agent-a');
        sessionContext.getSessionValue('agent-b', 'k2');
        sessionContext.clearSession('agent-a');
        sessionContext.clearAll();

        expect(writeFile).not.toHaveBeenCalled();
        expect(appendFile).not.toHaveBeenCalled();
        expect(writeFileAsync).not.toHaveBeenCalled();
      } finally {
        writeFile.mockRestore();
        appendFile.mockRestore();
        writeFileAsync.mockRestore();
      }
    });
  });
});
