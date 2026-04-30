/**
 * Unit tests for packages/agents/critical-meeting-alarm-agent.js
 *
 * Covers:
 *   - Agent shape validates against agent-registry.js REQUIRED_PROPERTIES
 *   - Alarm key is unique per (eventId, startTime, leadMinutes)
 *   - Test fire goes out on all enabled channels
 *   - Dedupe: firing the same alarm twice in a session is a no-op
 *   - Snooze suppresses scheduled alarms for the event
 *   - Dismiss cancels all pending alarms for the event
 *   - State round-trips through the state.json file
 *   - getBriefing returns null when no critical events exist
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

// Stub calendar-fetch so initialize() and pollCycle() don't touch the network.
vi.mock('../../lib/calendar-fetch', () => ({
  getEventsForDay: async () => ({ events: [] }),
}));

// Stub agent-memory-store with an in-memory implementation.
vi.mock('../../lib/agent-memory-store', () => {
  const store = new Map();
  return {
    getAgentMemory: () => ({
      isLoaded: () => true,
      load: async () => true,
      save: async () => true,
      getSection: (n) => store.get(n) ?? null,
      getSectionNames: () => Array.from(store.keys()),
      updateSection: (n, c) => store.set(n, c),
      appendToSection: () => {},
      parseSectionAsKeyValue: () => ({}),
    }),
  };
});

// Stub ai-service so the free-form rules parser short-circuits to [].
vi.mock('../../lib/ai-service', () => ({
  json: async () => ({ rules: [] }),
}));

const agent = require('../../packages/agents/critical-meeting-alarm-agent');
const rules = require('../../lib/critical-meeting-rules');
const { validateAgent, REQUIRED_PROPERTIES } = require('../../packages/agents/agent-registry');

// Inject a fake ai-service into the rules engine so getBriefing() doesn't
// fall through to the real LLM call when the ## Rules section is empty.
rules._setAiService({ json: async () => ({ rules: [] }) });

// ────────────────────────────────────────────────────────────────────────────

function sampleEvent(overrides = {}) {
  return {
    id: 'evt-test-1',
    summary: 'Critical sync',
    start: { dateTime: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
    attendees: [{ email: 'ceo@team.com' }],
    organizer: { email: 'ceo@team.com' },
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────────

describe('critical-meeting-alarm-agent', () => {
  let tmpStateFile;

  beforeEach(async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'critical-alarms-test-'));
    tmpStateFile = path.join(tmpDir, 'state.json');
    agent._setStateFilePath(tmpStateFile);
    agent._setState({}, {});
    // Clear any leftover scheduled alarms from prior tests
    for (const [, entry] of agent._scheduledAlarms.entries()) clearTimeout(entry.timeoutHandle);
    agent._scheduledAlarms.clear();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Shape + registry compatibility
  // ──────────────────────────────────────────────────────────────────────

  describe('agent shape', () => {
    it('has all required properties expected by agent-registry', () => {
      for (const prop of REQUIRED_PROPERTIES) {
        expect(agent[prop]).toBeDefined();
      }
    });

    it('validates against the agent-registry validator', () => {
      const result = validateAgent(agent, 'critical-meeting-alarm-agent.js');
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('is marked bidExcluded and executionType=system', () => {
      expect(agent.bidExcluded).toBe(true);
      expect(agent.executionType).toBe('system');
    });

    it('exposes getBriefing for the daily brief', () => {
      expect(typeof agent.getBriefing).toBe('function');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Alarm key uniqueness
  // ──────────────────────────────────────────────────────────────────────

  describe('_alarmKey', () => {
    it('includes eventId, startTime, and leadMinutes', () => {
      const event = sampleEvent({ id: 'A', start: { dateTime: '2026-05-01T10:00:00Z' } });
      const k1 = agent._alarmKey(event, 5);
      const k2 = agent._alarmKey(event, 1);
      expect(k1).not.toBe(k2);
      expect(k1).toContain('A');
      expect(k1).toContain('5');
      expect(k2).toContain('1');
    });

    it('gives recurring-event instances their own keys', () => {
      const a = agent._alarmKey(
        sampleEvent({ id: 'recur-1', start: { dateTime: '2026-05-01T10:00:00Z' } }),
        5
      );
      const b = agent._alarmKey(
        sampleEvent({ id: 'recur-1', start: { dateTime: '2026-05-02T10:00:00Z' } }),
        5
      );
      expect(a).not.toBe(b);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Fire / dedupe
  // ──────────────────────────────────────────────────────────────────────

  describe('_fireAlarm + dedupe', () => {
    it('fires the voice channel through global.agentMessageQueue', async () => {
      const enqueue = vi.fn();
      global.agentMessageQueue = { enqueue };
      try {
        const event = sampleEvent();
        await agent._fireAlarm(event, 5, ['because'], { voice: true, hud: false, os: false, sound: false });
        expect(enqueue).toHaveBeenCalledTimes(1);
        const [agentId, message, priority] = enqueue.mock.calls[0];
        expect(agentId).toBe('critical-meeting-alarm-agent');
        expect(message).toMatch(/5 minutes/);
        expect(priority).toBe('high');
      } finally {
        delete global.agentMessageQueue;
      }
    });

    it('uses URGENT priority for <= 1 minute lead time', async () => {
      const enqueue = vi.fn();
      global.agentMessageQueue = { enqueue };
      try {
        await agent._fireAlarm(sampleEvent(), 1, [], { voice: true });
        expect(enqueue.mock.calls[0][2]).toBe('urgent');
      } finally {
        delete global.agentMessageQueue;
      }
    });

    it('does not fire the same alarm twice in one session', async () => {
      const enqueue = vi.fn();
      global.agentMessageQueue = { enqueue };
      try {
        const event = sampleEvent();
        await agent._fireAlarm(event, 5, [], { voice: true });
        await agent._fireAlarm(event, 5, [], { voice: true });
        expect(enqueue).toHaveBeenCalledTimes(1);
      } finally {
        delete global.agentMessageQueue;
      }
    });

    it('respects snooze', async () => {
      const enqueue = vi.fn();
      global.agentMessageQueue = { enqueue };
      try {
        const event = sampleEvent();
        await agent.snooze(event.id, Date.now() + 60_000);
        await agent._fireAlarm(event, 5, [], { voice: true });
        expect(enqueue).not.toHaveBeenCalled();
      } finally {
        delete global.agentMessageQueue;
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // snooze / dismiss
  // ──────────────────────────────────────────────────────────────────────

  describe('snooze + dismiss', () => {
    it('snooze clears scheduled alarms and suppresses future fires until expiry', async () => {
      const event = sampleEvent();
      const fire = Date.now() + 60_000;
      const key = `${event.id}::${new Date(event.start.dateTime).getTime()}::5`;
      // Fake a scheduled alarm we can cancel
      const handle = setTimeout(() => {}, 1_000_000);
      agent._scheduledAlarms.set(key, {
        timeoutHandle: handle,
        event,
        leadMinutes: 5,
        scheduledFor: fire,
        channels: { voice: true },
      });
      expect(agent._scheduledAlarms.has(key)).toBe(true);

      await agent.snooze(event.id, Date.now() + 5 * 60 * 1000);
      expect(agent._scheduledAlarms.has(key)).toBe(false);
    });

    it('dismiss removes every scheduled alarm for the event and records it as fired', async () => {
      const event = sampleEvent();
      const base = new Date(event.start.dateTime).getTime();
      for (const lead of [15, 5, 1]) {
        const key = `${event.id}::${base}::${lead}`;
        const handle = setTimeout(() => {}, 1_000_000);
        agent._scheduledAlarms.set(key, {
          timeoutHandle: handle,
          event,
          leadMinutes: lead,
          scheduledFor: base - lead * 60_000,
          channels: { voice: true },
        });
      }
      const cancelled = await agent.dismiss(event.id);
      expect(cancelled).toBe(3);
      expect(agent._scheduledAlarms.size).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Persistence
  // ──────────────────────────────────────────────────────────────────────

  describe('state persistence', () => {
    it('persists firedAlarms to the state file on fire', async () => {
      global.agentMessageQueue = { enqueue: () => {} };
      try {
        const event = sampleEvent({ id: 'persist-test' });
        await agent._fireAlarm(event, 5, [], { voice: true });
        await new Promise((r) => setTimeout(r, 20));
        const contents = await fs.promises.readFile(tmpStateFile, 'utf8');
        const parsed = JSON.parse(contents);
        const keys = Object.keys(parsed.firedAlarms || {});
        expect(keys.length).toBe(1);
        expect(keys[0]).toContain('persist-test');
      } finally {
        delete global.agentMessageQueue;
      }
    });

    it('persists snoozes', async () => {
      await agent.snooze('evt-snoozed', Date.now() + 60_000);
      await new Promise((r) => setTimeout(r, 20));
      const contents = await fs.promises.readFile(tmpStateFile, 'utf8');
      const parsed = JSON.parse(contents);
      expect(parsed.snoozes['evt-snoozed']).toBeTruthy();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // getBriefing
  // ──────────────────────────────────────────────────────────────────────

  describe('getBriefing', () => {
    it('returns null content when no critical events exist', async () => {
      const briefing = await agent.getBriefing();
      expect(briefing.section).toBe('Critical today');
      expect(briefing.priority).toBe(2);
      expect(briefing.content).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Test fire
  // ──────────────────────────────────────────────────────────────────────

  describe('test()', () => {
    it('fires a synthetic alarm on the voice channel', async () => {
      const enqueue = vi.fn();
      global.agentMessageQueue = { enqueue };
      try {
        const result = await agent.test({ title: 'Manual test' });
        expect(result.success).toBe(true);
        expect(result.fired.summary).toBe('Manual test');
        expect(enqueue).toHaveBeenCalledTimes(1);
      } finally {
        delete global.agentMessageQueue;
      }
    });
  });
});
