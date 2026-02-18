/**
 * Transcript Service Unit Tests
 *
 * Tests for lib/transcript-service.js covering:
 * - Rolling buffer (push, overflow, getRecent, getSince, getBySpeaker)
 * - Pending input state (setPending, hasPending, pickPending, clearPending)
 * - Session management (newSession clears state)
 * - EventEmitter behavior (entry events)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub log-event-queue before importing the service
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { TranscriptService } = require('../../lib/transcript-service');

describe('TranscriptService', () => {
  let ts;

  beforeEach(() => {
    ts = new TranscriptService(10); // small buffer for testing overflow
  });

  // ---- Rolling buffer ----

  describe('push() and getRecent()', () => {
    it('stores entries and returns them in order', () => {
      ts.push({ text: 'hello', speaker: 'user' });
      ts.push({ text: 'hi there', speaker: 'agent', agentId: 'weather' });

      const entries = ts.getRecent(10);
      expect(entries).toHaveLength(2);
      expect(entries[0].text).toBe('hello');
      expect(entries[0].speaker).toBe('user');
      expect(entries[1].text).toBe('hi there');
      expect(entries[1].speaker).toBe('agent');
      expect(entries[1].agentId).toBe('weather');
    });

    it('assigns id, timestamp, and sessionId to each entry', () => {
      ts.push({ text: 'test', speaker: 'user' });
      const [entry] = ts.getRecent(1);

      expect(entry.id).toMatch(/^t-\d+-[a-z0-9]+$/);
      expect(entry.timestamp).toBeTruthy();
      expect(entry.sessionId).toBe(ts.sessionId);
    });

    it('defaults isFinal to true', () => {
      ts.push({ text: 'test', speaker: 'user' });
      expect(ts.getRecent(1)[0].isFinal).toBe(true);
    });

    it('respects explicit isFinal: false', () => {
      ts.push({ text: 'par', speaker: 'user', isFinal: false });
      expect(ts.getRecent(1)[0].isFinal).toBe(false);
    });

    it('ignores push with no text', () => {
      const result = ts.push({ speaker: 'user' });
      expect(result).toBeNull();
      expect(ts.getRecent(10)).toHaveLength(0);
    });

    it('ignores push with empty text', () => {
      const result = ts.push({ text: '', speaker: 'user' });
      expect(result).toBeNull();
      expect(ts.getRecent(10)).toHaveLength(0);
    });

    it('returns only the last N entries', () => {
      for (let i = 0; i < 5; i++) {
        ts.push({ text: `msg-${i}`, speaker: 'user' });
      }
      const entries = ts.getRecent(2);
      expect(entries).toHaveLength(2);
      expect(entries[0].text).toBe('msg-3');
      expect(entries[1].text).toBe('msg-4');
    });
  });

  describe('buffer overflow', () => {
    it('evicts oldest entries when buffer is full', () => {
      // Buffer size is 10
      for (let i = 0; i < 15; i++) {
        ts.push({ text: `msg-${i}`, speaker: 'user' });
      }

      const entries = ts.getRecent(20);
      expect(entries).toHaveLength(10);
      expect(entries[0].text).toBe('msg-5'); // oldest surviving
      expect(entries[9].text).toBe('msg-14'); // newest
    });
  });

  describe('getSince()', () => {
    it('filters entries by timestamp', async () => {
      ts.push({ text: 'old', speaker: 'user' });

      // Small delay so timestamps differ
      await new Promise((r) => {
        setTimeout(r, 20);
      });
      const cutoff = new Date().toISOString();
      await new Promise((r) => {
        setTimeout(r, 20);
      });

      ts.push({ text: 'new', speaker: 'user' });

      const entries = ts.getSince(cutoff);
      expect(entries).toHaveLength(1);
      expect(entries[0].text).toBe('new');
    });
  });

  describe('getBySpeaker()', () => {
    it('filters by speaker', () => {
      ts.push({ text: 'user msg', speaker: 'user' });
      ts.push({ text: 'agent msg', speaker: 'agent' });
      ts.push({ text: 'user msg 2', speaker: 'user' });

      const userEntries = ts.getBySpeaker('user', 10);
      expect(userEntries).toHaveLength(2);
      expect(userEntries[0].text).toBe('user msg');

      const agentEntries = ts.getBySpeaker('agent', 10);
      expect(agentEntries).toHaveLength(1);
      expect(agentEntries[0].text).toBe('agent msg');
    });
  });

  // ---- Pending input state ----

  describe('pending input state', () => {
    it('starts with no pending agents', () => {
      expect(ts.hasPending()).toBe(false);
      expect(ts.getPendingAgentIds()).toEqual([]);
    });

    it('setPending() registers an agent', () => {
      ts.setPending('weather', { taskId: 't1', field: 'city' });
      expect(ts.hasPending()).toBe(true);
      expect(ts.getPendingAgentIds()).toEqual(['weather']);
    });

    it('getPending() retrieves the stored context', () => {
      const ctx = { taskId: 't1', field: 'city', options: ['NYC', 'LA'] };
      ts.setPending('weather', ctx);
      expect(ts.getPending('weather')).toEqual(ctx);
    });

    it('clearPending() removes a specific agent', () => {
      ts.setPending('weather', { taskId: 't1' });
      ts.setPending('calendar', { taskId: 't2' });
      ts.clearPending('weather');

      expect(ts.hasPending()).toBe(true);
      expect(ts.getPendingAgentIds()).toEqual(['calendar']);
      expect(ts.getPending('weather')).toBeUndefined();
    });

    it('pickPending() returns and removes the targeted agent', () => {
      ts.setPending('weather', { taskId: 't1' });
      ts.setPending('calendar', { taskId: 't2' });

      const pick = ts.pickPending('calendar');
      expect(pick.agentId).toBe('calendar');
      expect(pick.context.taskId).toBe('t2');
      expect(ts.getPendingAgentIds()).toEqual(['weather']);
    });

    it('pickPending() returns first agent when no target specified', () => {
      ts.setPending('weather', { taskId: 't1' });
      ts.setPending('calendar', { taskId: 't2' });

      const pick = ts.pickPending(null);
      expect(pick.agentId).toBe('weather');
      expect(ts.getPendingAgentIds()).toEqual(['calendar']);
    });

    it('pickPending() returns null when no pending', () => {
      expect(ts.pickPending('weather')).toBeNull();
    });

    it('pickPending() falls back to first when target not found', () => {
      ts.setPending('weather', { taskId: 't1' });
      const pick = ts.pickPending('nonexistent');
      expect(pick.agentId).toBe('weather');
    });

    it('getPendingSnapshot() returns serializable state', () => {
      ts.setPending('weather', { taskId: 't1', field: 'city', context: { x: 1 }, options: [] });
      const snapshot = ts.getPendingSnapshot();
      expect(snapshot).toEqual({
        weather: { taskId: 't1', field: 'city' },
      });
    });
  });

  // ---- Session management ----

  describe('newSession()', () => {
    it('clears entries and pending state', async () => {
      ts.push({ text: 'hello', speaker: 'user' });
      ts.setPending('weather', { taskId: 't1' });

      const oldSessionId = ts.sessionId;
      // Small delay so Date.now() produces a different timestamp
      await new Promise((r) => {
        setTimeout(r, 5);
      });
      const newSessionId = ts.newSession();

      expect(newSessionId).not.toBe(oldSessionId);
      expect(ts.getRecent(10)).toHaveLength(0);
      expect(ts.hasPending()).toBe(false);
    });
  });

  // ---- EventEmitter ----

  describe('entry event', () => {
    it('emits an entry event on push', () => {
      const handler = vi.fn();
      ts.on('entry', handler);

      ts.push({ text: 'hello', speaker: 'user' });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello', speaker: 'user' }));
    });

    it('does not emit for invalid pushes', () => {
      const handler = vi.fn();
      ts.on('entry', handler);

      ts.push({ speaker: 'user' }); // no text
      ts.push(null);

      expect(handler).not.toHaveBeenCalled();
    });
  });
});
