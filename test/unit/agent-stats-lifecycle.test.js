/**
 * Agent Stats -- Task Lifecycle Extensions (Phase 0)
 *
 * Verifies `recordTaskLifecycle`, `getTaskTimeline`, `getRecentLifecycle`,
 * `pruneTaskTimeline` added for the agent-system upgrade.
 *
 * Strategy: agent-stats.js falls back to `$HOME/.gsx-power-user` when
 * `electron.app.getPath('userData')` is undefined (the non-Electron case).
 * We exploit that: override `$HOME` to a fresh tmp directory per test so
 * each tracker writes to isolated storage with no mocking gymnastics.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AgentStatsTracker } = require('../../src/voice-task-sdk/agent-stats');

// Per-test HOME directory -- agent-stats will write under
// <HOME>/.gsx-power-user/agents/
let _home;
let _originalHome;

async function _freshTracker() {
  const tracker = new AgentStatsTracker();
  await tracker.init();
  return tracker;
}

function _statsDir() {
  return path.join(_home, '.gsx-power-user', 'agents');
}

beforeEach(() => {
  _originalHome = process.env.HOME;
  _home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-stats-'));
  process.env.HOME = _home;
});

afterEach(() => {
  process.env.HOME = _originalHome;
  try {
    fs.rmSync(_home, { recursive: true, force: true });
  } catch (_err) { /* best-effort cleanup */ }
});

describe('recordTaskLifecycle', () => {
  it('validates required fields', async () => {
    const stats = await _freshTracker();
    expect(stats.recordTaskLifecycle(null)).toBe(null);
    expect(stats.recordTaskLifecycle({})).toBe(null);
    expect(stats.recordTaskLifecycle({ taskId: 't1' })).toBe(null);
    expect(stats.recordTaskLifecycle({ type: 'queued' })).toBe(null);
  });

  it('records a single event with default at timestamp', async () => {
    const stats = await _freshTracker();
    const event = stats.recordTaskLifecycle({ taskId: 't1', type: 'queued' });
    expect(event.taskId).toBe('t1');
    expect(event.type).toBe('queued');
    expect(typeof event.at).toBe('number');
  });

  it('preserves provided at and data fields', async () => {
    const stats = await _freshTracker();
    stats.recordTaskLifecycle({
      taskId: 't1',
      type: 'bids-collected',
      at: 123456,
      data: { count: 3 },
    });
    const timeline = stats.getTaskTimeline('t1');
    expect(timeline).toHaveLength(1);
    expect(timeline[0].at).toBe(123456);
    expect(timeline[0].data).toEqual({ count: 3 });
  });

  it('persists events to disk', async () => {
    const stats = await _freshTracker();
    stats.recordTaskLifecycle({ taskId: 't1', type: 'queued' });
    const file = path.join(_statsDir(), 'task-timeline.json');
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].taskId).toBe('t1');
  });

  it('restores events from disk on a fresh tracker init', async () => {
    const first = await _freshTracker();
    first.recordTaskLifecycle({ taskId: 't1', type: 'queued' });
    first.recordTaskLifecycle({ taskId: 't1', type: 'completed' });

    const second = await _freshTracker();
    const timeline = second.getTaskTimeline('t1');
    expect(timeline).toHaveLength(2);
    expect(timeline.map((e) => e.type)).toEqual(['queued', 'completed']);
  });
});

describe('getTaskTimeline', () => {
  it('returns events in insertion order for a taskId', async () => {
    const stats = await _freshTracker();
    stats.recordTaskLifecycle({ taskId: 't1', type: 'queued', at: 100 });
    stats.recordTaskLifecycle({ taskId: 't2', type: 'queued', at: 110 });
    stats.recordTaskLifecycle({ taskId: 't1', type: 'assigned', at: 120 });
    stats.recordTaskLifecycle({ taskId: 't1', type: 'completed', at: 130 });
    const timeline = stats.getTaskTimeline('t1');
    expect(timeline.map((e) => e.type)).toEqual(['queued', 'assigned', 'completed']);
  });

  it('returns empty array for unknown taskId', async () => {
    const stats = await _freshTracker();
    expect(stats.getTaskTimeline('nope')).toEqual([]);
    expect(stats.getTaskTimeline('')).toEqual([]);
  });
});

describe('getRecentLifecycle', () => {
  it('returns last N events across tasks', async () => {
    const stats = await _freshTracker();
    for (let i = 0; i < 10; i++) {
      stats.recordTaskLifecycle({ taskId: `t${i}`, type: 'queued', at: 1000 + i });
    }
    const recent = stats.getRecentLifecycle(3);
    expect(recent).toHaveLength(3);
    expect(recent.map((e) => e.taskId)).toEqual(['t7', 't8', 't9']);
  });

  it('returns all events when limit >= size', async () => {
    const stats = await _freshTracker();
    stats.recordTaskLifecycle({ taskId: 't1', type: 'queued' });
    stats.recordTaskLifecycle({ taskId: 't2', type: 'queued' });
    expect(stats.getRecentLifecycle(1000)).toHaveLength(2);
  });
});

describe('maxTimelineSize enforcement', () => {
  it('trims oldest when exceeding maxTimelineSize', async () => {
    const stats = await _freshTracker();
    stats.maxTimelineSize = 5;
    for (let i = 0; i < 10; i++) {
      stats.recordTaskLifecycle({ taskId: `t${i}`, type: 'queued', at: i });
    }
    expect(stats.taskTimeline).toHaveLength(5);
    expect(stats.taskTimeline.map((e) => e.taskId)).toEqual(['t5', 't6', 't7', 't8', 't9']);
  });
});

describe('pruneTaskTimeline', () => {
  it('removes events older than olderThanMs cutoff', async () => {
    const stats = await _freshTracker();
    const now = Date.now();
    stats.taskTimeline = [
      { taskId: 'old', type: 'queued', at: now - 20000 },
      { taskId: 'new', type: 'queued', at: now - 5000 },
    ];
    const removed = stats.pruneTaskTimeline(10000);
    expect(removed).toBe(1);
    expect(stats.taskTimeline.map((e) => e.taskId)).toEqual(['new']);
  });

  it('returns 0 and does not save when nothing to remove', async () => {
    const stats = await _freshTracker();
    stats.taskTimeline = [{ taskId: 'fresh', type: 'queued', at: Date.now() }];
    expect(stats.pruneTaskTimeline(60_000)).toBe(0);
  });
});

describe('clearAllStats also clears timeline', () => {
  it('resets taskTimeline to empty', async () => {
    const stats = await _freshTracker();
    stats.recordTaskLifecycle({ taskId: 't1', type: 'queued' });
    stats.clearAllStats();
    expect(stats.taskTimeline).toEqual([]);
    expect(stats.getTaskTimeline('t1')).toEqual([]);
  });
});
