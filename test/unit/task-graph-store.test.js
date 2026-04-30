/**
 * Unit tests for lib/task-graph-store.js
 *
 * Covers:
 *   - upsertQueue: emits MERGE on TaskQueue with id, sets name on CREATE only
 *   - addTaskItem: requires name, creates TaskItem with ENQUEUED_IN, sets
 *     fire_at only when provided, escapes quotes in names
 *   - listPendingTasks: tolerates an unready client (returns []), respects
 *     horizonMs filter
 *   - completeTask: sets status='completed' and completed_at
 *   - deleteTask: DETACH DELETE
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

const store = require('../../lib/task-graph-store');

function makeFakeClient(responses = {}) {
  const captured = [];
  const client = {
    currentUser: 'tester@example.com',
    isReady: () => responses.isReady !== false,
    executeQuery: vi.fn(async (cypher, params) => {
      captured.push({ cypher, params });
      if (typeof responses.executeQuery === 'function') {
        return responses.executeQuery(cypher, params);
      }
      return responses.rows || [];
    }),
  };
  client._captured = captured;
  return client;
}

describe('task-graph-store', () => {
  beforeEach(() => {
    store._setClientForTests(null);
  });

  describe('upsertQueue', () => {
    it('issues a MERGE keyed on the queue id', async () => {
      const fake = makeFakeClient({ rows: [{ id: 'user-tasks', name: 'User Tasks', status: 'active' }] });
      store._setClientForTests(fake);

      const result = await store.upsertQueue();

      expect(result).toEqual({ id: 'user-tasks', name: 'User Tasks', status: 'active' });
      expect(fake._captured).toHaveLength(1);
      const { cypher } = fake._captured[0];
      expect(cypher).toContain('MERGE (q:TaskQueue {id:');
      expect(cypher).toContain("'user-tasks'");
      expect(cypher).toContain('ON CREATE SET');
      expect(cypher).toContain('ON MATCH SET');
      expect(cypher).toContain("q.name = 'User Tasks'");
    });

    it('accepts an override id and name', async () => {
      const fake = makeFakeClient({ rows: [{ id: 'work', name: 'Work Items', status: 'active' }] });
      store._setClientForTests(fake);

      await store.upsertQueue({ id: 'work', name: 'Work Items' });

      const { cypher } = fake._captured[0];
      expect(cypher).toContain("'work'");
      expect(cypher).toContain("'Work Items'");
    });

    it('throws a clear error when the graph client is not ready', async () => {
      const fake = makeFakeClient({ isReady: false });
      store._setClientForTests(fake);
      await expect(store.upsertQueue()).rejects.toThrow(/not ready/i);
    });
  });

  describe('addTaskItem', () => {
    it('rejects an empty name', async () => {
      const fake = makeFakeClient();
      store._setClientForTests(fake);
      await expect(store.addTaskItem({ name: '' })).rejects.toThrow(/name is required/i);
      await expect(store.addTaskItem({ name: '   ' })).rejects.toThrow(/name is required/i);
      await expect(store.addTaskItem({})).rejects.toThrow(/name is required/i);
    });

    it('issues upsertQueue then CREATE TaskItem with ENQUEUED_IN', async () => {
      const fake = makeFakeClient({
        executeQuery: (cypher) => {
          if (cypher.includes('CREATE (t:TaskItem)')) {
            return [{
              id: 'task-123-abc',
              name: 'Call Jenny',
              status: 'queued',
              priority: 5,
              fire_at: null,
              notes: null,
              queued_at: 1700000000000,
              queue: 'user-tasks',
            }];
          }
          return [{ id: 'user-tasks', name: 'User Tasks', status: 'active' }];
        },
      });
      store._setClientForTests(fake);

      const row = await store.addTaskItem({ name: 'Call Jenny' });

      expect(row?.name).toBe('Call Jenny');
      expect(fake.executeQuery).toHaveBeenCalledTimes(2);
      const create = fake._captured[1].cypher;
      expect(create).toContain('MATCH (q:TaskQueue {id:');
      expect(create).toContain('CREATE (t:TaskItem)');
      expect(create).toContain('MERGE (t)-[:ENQUEUED_IN]->(q)');
      expect(create).toContain("t.name = 'Call Jenny'");
      expect(create).toContain("t.status = 'queued'");
      expect(create).toContain('t.priority = 5');
      // No fire_at set when not provided
      expect(create).not.toContain('t.fire_at =');
    });

    it('sets fire_at when fireAtMs is provided', async () => {
      const fake = makeFakeClient({
        executeQuery: (cypher) => {
          if (cypher.includes('CREATE (t:TaskItem)')) {
            return [{ id: 'task-1', name: 'Alarm', status: 'queued', priority: 10, fire_at: 1700000000000 }];
          }
          return [{ id: 'user-tasks' }];
        },
      });
      store._setClientForTests(fake);

      await store.addTaskItem({ name: 'Alarm', fireAtMs: 1700000000000, priority: 10 });

      const create = fake._captured[1].cypher;
      expect(create).toContain('t.fire_at = 1700000000000');
      expect(create).toContain('t.priority = 10');
    });

    it('escapes single quotes in the task name', async () => {
      const fake = makeFakeClient({
        executeQuery: (cypher) => {
          if (cypher.includes('CREATE (t:TaskItem)')) return [{ id: 'task-1', name: "O'Brien" }];
          return [{ id: 'user-tasks' }];
        },
      });
      store._setClientForTests(fake);

      await store.addTaskItem({ name: "Call O'Brien" });

      const create = fake._captured[1].cypher;
      // escapeCypher (omnigraph-client.js) backslash-escapes single quotes.
      expect(create).toContain("'Call O\\'Brien'");
    });

    it('omits notes clause when notes is empty/whitespace', async () => {
      const fake = makeFakeClient({
        executeQuery: (cypher) => (cypher.includes('CREATE') ? [{ id: 'task-1' }] : [{ id: 'user-tasks' }]),
      });
      store._setClientForTests(fake);

      await store.addTaskItem({ name: 'A', notes: '   ' });

      const create = fake._captured[1].cypher;
      expect(create).not.toContain('t.notes =');
    });

    it('includes notes when provided', async () => {
      const fake = makeFakeClient({
        executeQuery: (cypher) => (cypher.includes('CREATE') ? [{ id: 'task-1' }] : [{ id: 'user-tasks' }]),
      });
      store._setClientForTests(fake);

      await store.addTaskItem({ name: 'A', notes: 'bring the red folder' });

      const create = fake._captured[1].cypher;
      expect(create).toContain("t.notes = 'bring the red folder'");
    });
  });

  describe('listPendingTasks', () => {
    it('returns [] when the client is not ready (graceful)', async () => {
      const fake = makeFakeClient({ isReady: false });
      store._setClientForTests(fake);

      const rows = await store.listPendingTasks();

      expect(rows).toEqual([]);
      expect(fake.executeQuery).not.toHaveBeenCalled();
    });

    it('queries queued tasks ordered by fire_at, priority, queued_at', async () => {
      const fake = makeFakeClient({
        rows: [
          { id: 't1', name: 'Alarm', priority: 10, fire_at: 1700000000000 },
          { id: 't2', name: 'Thing', priority: 5, fire_at: null },
        ],
      });
      store._setClientForTests(fake);

      const rows = await store.listPendingTasks();

      expect(rows.length).toBe(2);
      const { cypher } = fake._captured[0];
      expect(cypher).toContain("MATCH (t:TaskItem {status: 'queued'})");
      expect(cypher).toContain('-[:ENQUEUED_IN]->(q:TaskQueue');
      expect(cypher).toContain('ORDER BY coalesce(t.fire_at');
      expect(cypher).toContain('t.priority DESC');
    });

    it('applies a horizonMs filter on fire_at', async () => {
      const fake = makeFakeClient({ rows: [] });
      store._setClientForTests(fake);

      await store.listPendingTasks({ horizonMs: 2 * 60 * 60 * 1000 });

      const { cypher } = fake._captured[0];
      expect(cypher).toContain('AND (t.fire_at IS NULL OR t.fire_at <=');
    });
  });

  describe('completeTask', () => {
    it('sets status=completed and completed_at', async () => {
      const fake = makeFakeClient({ rows: [{ id: 'task-1', status: 'completed', completed_at: 123 }] });
      store._setClientForTests(fake);

      const row = await store.completeTask('task-1');

      expect(row).toEqual({ id: 'task-1', status: 'completed', completed_at: 123 });
      const { cypher } = fake._captured[0];
      expect(cypher).toContain("MATCH (t:TaskItem {id: 'task-1'})");
      expect(cypher).toContain("SET t.status = 'completed'");
      expect(cypher).toContain('t.completed_at =');
    });

    it('throws when taskId is missing', async () => {
      const fake = makeFakeClient();
      store._setClientForTests(fake);
      await expect(store.completeTask()).rejects.toThrow(/taskId required/i);
    });
  });

  describe('deleteTask', () => {
    it('DETACH DELETEs the task', async () => {
      const fake = makeFakeClient({ rows: [{ deleted: 1 }] });
      store._setClientForTests(fake);

      const row = await store.deleteTask('task-1');

      expect(row).toEqual({ deleted: 1 });
      const { cypher } = fake._captured[0];
      expect(cypher).toContain('DETACH DELETE t');
    });
  });
});
