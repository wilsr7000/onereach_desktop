/**
 * Task Store -- Unit Tests
 *
 * Verifies the consolidated state store mirrors the operations done
 * today by the six Maps inside lib/hud-api.js. Key guarantees:
 *
 *   - CRUD on task routing (tool, space, timestamp).
 *   - HUD items bucket-per-tool with merge-update semantics.
 *   - Disambiguation and needs-input states have independent TTLs.
 *   - `sweep(now)` reproduces the legacy stale-entry cleanup behavior.
 */

import { describe, it, expect, beforeEach } from 'vitest';

const {
  TaskStore,
  getTaskStore,
  _resetTaskStoreForTests,
  STALE_TASK_TTL_MS,
  STALE_STATE_TTL_MS,
} = require('../../lib/exchange/task-store');

describe('TaskStore -- routing CRUD', () => {
  let store;
  beforeEach(() => { store = new TaskStore(); });

  it('createTask requires a taskId', () => {
    expect(() => store.createTask('')).toThrow();
  });

  it('createTask stores toolId and spaceId with createdAt default', () => {
    const entry = store.createTask('t1', { toolId: 'orb', spaceId: 'meeting-agents' });
    expect(entry.taskId).toBe('t1');
    expect(entry.toolId).toBe('orb');
    expect(entry.spaceId).toBe('meeting-agents');
    expect(typeof entry.createdAt).toBe('number');
  });

  it('getToolId / getSpaceId resolve from the store', () => {
    store.createTask('t1', { toolId: 'orb', spaceId: 'calendar-agents' });
    expect(store.getToolId('t1')).toBe('orb');
    expect(store.getSpaceId('t1')).toBe('calendar-agents');
  });

  it('getToolId returns null for unknown taskId', () => {
    expect(store.getToolId('missing')).toBe(null);
  });

  it('updateTask patches fields without clobbering the rest', () => {
    store.createTask('t1', { toolId: 'orb', spaceId: 'space-a', createdAt: 100 });
    store.updateTask('t1', { spaceId: 'space-b' });
    const entry = store.getTask('t1');
    expect(entry.toolId).toBe('orb');
    expect(entry.spaceId).toBe('space-b');
    expect(entry.createdAt).toBe(100);
  });

  it('updateTask on unknown id creates it', () => {
    store.updateTask('new-id', { toolId: 'recorder' });
    expect(store.getTask('new-id').toolId).toBe('recorder');
  });

  it('deleteTask is idempotent', () => {
    store.createTask('t1');
    expect(store.deleteTask('t1')).toBe(true);
    expect(store.deleteTask('t1')).toBe(false);
    expect(store.getTask('t1')).toBe(null);
  });

  it('listActiveTaskIds and activeTaskCount reflect state', () => {
    expect(store.activeTaskCount()).toBe(0);
    store.createTask('a');
    store.createTask('b');
    expect(store.activeTaskCount()).toBe(2);
    expect(store.listActiveTaskIds().sort()).toEqual(['a', 'b']);
  });
});

describe('TaskStore -- HUD items', () => {
  let store;
  beforeEach(() => { store = new TaskStore(); });

  it('addItem requires toolId and item.id', () => {
    expect(() => store.addItem('', { id: 'x' })).toThrow();
    expect(() => store.addItem('orb', {})).toThrow();
  });

  it('buckets items by tool', () => {
    store.addItem('orb', { id: 'i1', text: 'hi' });
    store.addItem('recorder', { id: 'i1', text: 'different tool' });
    expect(store.getItem('orb', 'i1').text).toBe('hi');
    expect(store.getItem('recorder', 'i1').text).toBe('different tool');
  });

  it('updateItem merges and returns the patched item', () => {
    store.addItem('orb', { id: 'i1', text: 'a', createdAt: 1 });
    const updated = store.updateItem('orb', 'i1', { text: 'b' });
    expect(updated.text).toBe('b');
    expect(updated.createdAt).toBe(1);
  });

  it('updateItem returns null when item missing', () => {
    expect(store.updateItem('orb', 'missing', { text: 'x' })).toBe(null);
  });

  it('removeItem is idempotent', () => {
    store.addItem('orb', { id: 'i1' });
    expect(store.removeItem('orb', 'i1')).toBe(true);
    expect(store.removeItem('orb', 'i1')).toBe(false);
  });

  it('listItems returns items sorted by createdAt desc', () => {
    store.addItem('orb', { id: 'i1', createdAt: 100 });
    store.addItem('orb', { id: 'i2', createdAt: 300 });
    store.addItem('orb', { id: 'i3', createdAt: 200 });
    const ids = store.listItems('orb').map((i) => i.id);
    expect(ids).toEqual(['i2', 'i3', 'i1']);
  });

  it('clearToolItems drops the whole bucket', () => {
    store.addItem('orb', { id: 'i1' });
    store.clearToolItems('orb');
    expect(store.listItems('orb')).toEqual([]);
  });
});

describe('TaskStore -- disambiguation', () => {
  let store;
  beforeEach(() => { store = new TaskStore(); });

  it('stores and retrieves a disambiguation state with stateId echoed', () => {
    store.createDisambiguation('s1', {
      taskId: 't1',
      toolId: 'orb',
      question: 'Which one?',
      options: ['a', 'b'],
    });
    const got = store.getDisambiguation('s1');
    expect(got.stateId).toBe('s1');
    expect(got.taskId).toBe('t1');
    expect(got.options).toEqual(['a', 'b']);
    expect(typeof got.createdAt).toBe('number');
  });

  it('deleteDisambiguation removes', () => {
    store.createDisambiguation('s1', { taskId: 't1', question: 'q' });
    expect(store.deleteDisambiguation('s1')).toBe(true);
    expect(store.getDisambiguation('s1')).toBe(null);
  });

  it('listDisambiguations returns all active states', () => {
    store.createDisambiguation('s1', { taskId: 't1', question: 'q' });
    store.createDisambiguation('s2', { taskId: 't2', question: 'r' });
    expect(store.listDisambiguations().map((s) => s.stateId).sort()).toEqual(['s1', 's2']);
  });
});

describe('TaskStore -- needs input', () => {
  let store;
  beforeEach(() => { store = new TaskStore(); });

  it('setNeedsInput stores full request with taskId and createdAt', () => {
    store.setNeedsInput('t1', { toolId: 'orb', prompt: 'which day?', agentId: 'calendar' });
    const got = store.getNeedsInput('t1');
    expect(got.taskId).toBe('t1');
    expect(got.prompt).toBe('which day?');
    expect(got.agentId).toBe('calendar');
    expect(typeof got.createdAt).toBe('number');
  });

  it('clearNeedsInput removes', () => {
    store.setNeedsInput('t1', { prompt: 'q' });
    expect(store.clearNeedsInput('t1')).toBe(true);
    expect(store.getNeedsInput('t1')).toBe(null);
  });
});

describe('TaskStore -- sweep (TTL cleanup)', () => {
  let store;
  beforeEach(() => { store = new TaskStore(); });

  it('removes tasks older than STALE_TASK_TTL_MS', () => {
    const now = 1_000_000_000;
    store.createTask('fresh', { createdAt: now - 1000 });
    store.createTask('stale', { createdAt: now - STALE_TASK_TTL_MS - 10 });
    const result = store.sweep(now);
    expect(result.tasksRemoved).toBe(1);
    expect(store.getTask('fresh')).not.toBe(null);
    expect(store.getTask('stale')).toBe(null);
  });

  it('removes disambiguations older than STALE_STATE_TTL_MS', () => {
    const now = 1_000_000_000;
    store.createDisambiguation('fresh', { taskId: 't1', question: 'q', createdAt: now - 1000 });
    store.createDisambiguation('stale', { taskId: 't2', question: 'q', createdAt: now - STALE_STATE_TTL_MS - 10 });
    const result = store.sweep(now);
    expect(result.disambiguationsRemoved).toBe(1);
    expect(store.getDisambiguation('fresh')).not.toBe(null);
    expect(store.getDisambiguation('stale')).toBe(null);
  });

  it('removes needs-inputs older than STALE_STATE_TTL_MS', () => {
    const now = 1_000_000_000;
    store.setNeedsInput('fresh', { prompt: 'q', createdAt: now - 1000 });
    store.setNeedsInput('stale', { prompt: 'q', createdAt: now - STALE_STATE_TTL_MS - 10 });
    const result = store.sweep(now);
    expect(result.needsInputsRemoved).toBe(1);
    expect(store.getNeedsInput('fresh')).not.toBe(null);
    expect(store.getNeedsInput('stale')).toBe(null);
  });

  it('leaves fresh entries untouched across sweeps', () => {
    store.createTask('t', { createdAt: Date.now() });
    store.sweep();
    store.sweep();
    expect(store.getTask('t')).not.toBe(null);
  });
});

describe('TaskStore -- stats', () => {
  it('returns zero counts on a fresh store', () => {
    const store = new TaskStore();
    expect(store.stats()).toEqual({
      activeTasks: 0,
      tools: 0,
      totalItems: 0,
      disambiguations: 0,
      needsInputs: 0,
    });
  });

  it('totalItems sums across tools', () => {
    const store = new TaskStore();
    store.addItem('orb', { id: 'a' });
    store.addItem('orb', { id: 'b' });
    store.addItem('recorder', { id: 'c' });
    expect(store.stats().totalItems).toBe(3);
    expect(store.stats().tools).toBe(2);
  });
});

describe('getTaskStore -- singleton', () => {
  it('returns the same instance across calls', () => {
    const a = getTaskStore();
    const b = getTaskStore();
    expect(a).toBe(b);
  });

  it('_resetTaskStoreForTests yields a fresh singleton', () => {
    const a = getTaskStore();
    a.createTask('leftover');
    _resetTaskStoreForTests();
    const b = getTaskStore();
    expect(a).not.toBe(b);
    expect(b.getTask('leftover')).toBe(null);
  });
});
