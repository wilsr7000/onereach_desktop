/**
 * Unified Task Queue Unit Tests
 * Part of the Governed Self-Improving Agent Runtime
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Import the queue module
const UnifiedTaskQueue = require('../../lib/unified-task-queue');
const { TASK_STATUS } = require('../../lib/event-schema');

describe('UnifiedTaskQueue', () => {
  let queue;

  beforeEach(() => {
    queue = new UnifiedTaskQueue({
      defaultTimeout: 5000,
      cleanupInterval: 60000
    });
  });

  afterEach(() => {
    queue.destroy();
  });

  describe('Task Addition', () => {
    it('should add a task to the queue', () => {
      const task = queue.add({
        description: 'Test task',
        type: 'code_generation'
      });

      expect(task).toBeDefined();
      expect(task.id).toBeDefined();
      expect(task.status).toBe(TASK_STATUS.QUEUED);
      expect(queue.getStats().queued).toBe(1);
    });

    it('should insert tasks in priority order', () => {
      queue.add({ description: 'Low priority', priority: 8 });
      queue.add({ description: 'High priority', priority: 2 });
      queue.add({ description: 'Medium priority', priority: 5 });

      const next = queue.getNext();
      expect(next.description).toBe('High priority');
    });

    it('should emit task:added event', () => {
      const listener = vi.fn();
      queue.on('task:added', listener);

      queue.add({ description: 'Test task' });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].description).toBe('Test task');
    });
  });

  describe('Task Retrieval', () => {
    it('should get next available task', () => {
      queue.add({ description: 'Task 1' });
      queue.add({ description: 'Task 2' });

      const next = queue.getNext();
      expect(next.description).toBe('Task 1');
    });

    it('should filter tasks by agent', () => {
      queue.add({ description: 'Task 1', agent: 'aider' });
      queue.add({ description: 'Task 2', agent: 'evaluator' });

      const next = queue.getNext({ agent: 'evaluator' });
      expect(next.description).toBe('Task 2');
    });

    it('should not return locked tasks', () => {
      const task = queue.add({ description: 'Task 1' });
      queue.lock(task.id, 'consumer-1');

      const next = queue.getNext();
      expect(next).toBeNull();
    });

    it('should get task by ID', () => {
      const task = queue.add({ description: 'Test task' });
      const retrieved = queue.get(task.id);

      expect(retrieved).toBeDefined();
      expect(retrieved.id).toBe(task.id);
    });
  });

  describe('Task Locking', () => {
    it('should lock a task', () => {
      const task = queue.add({ description: 'Test task' });
      const locked = queue.lock(task.id, 'consumer-1');

      expect(locked).toBe(true);
      expect(queue.get(task.id).status).toBe(TASK_STATUS.IN_PROGRESS);
    });

    it('should prevent double locking', () => {
      const task = queue.add({ description: 'Test task' });
      queue.lock(task.id, 'consumer-1');
      const secondLock = queue.lock(task.id, 'consumer-2');

      expect(secondLock).toBe(false);
    });

    it('should unlock a task', () => {
      const task = queue.add({ description: 'Test task' });
      queue.lock(task.id, 'consumer-1');
      const unlocked = queue.unlock(task.id, 'consumer-1');

      expect(unlocked).toBe(true);
      expect(queue.get(task.id).status).toBe(TASK_STATUS.QUEUED);
    });

    it('should only allow owner to unlock', () => {
      const task = queue.add({ description: 'Test task' });
      queue.lock(task.id, 'consumer-1');
      const unlocked = queue.unlock(task.id, 'consumer-2');

      expect(unlocked).toBe(false);
    });
  });

  describe('Task Completion', () => {
    it('should complete a task', () => {
      const task = queue.add({ description: 'Test task' });
      queue.lock(task.id, 'consumer-1');
      queue.complete(task.id, { result: 'success' });

      expect(queue.get(task.id).status).toBe(TASK_STATUS.COMPLETED);
      expect(queue.getStats().completed).toBe(1);
    });

    it('should add to undo queue when undoable', () => {
      const task = queue.add({ description: 'Test task', undoable: true });
      queue.lock(task.id, 'consumer-1');
      queue.complete(task.id);

      expect(queue.getUndoable().length).toBe(1);
    });

    it('should emit task:completed event', () => {
      const listener = vi.fn();
      queue.on('task:completed', listener);

      const task = queue.add({ description: 'Test task' });
      queue.complete(task.id);

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('Task Failure', () => {
    it('should retry on failure', () => {
      const task = queue.add({ description: 'Test task' });
      queue.lock(task.id, 'consumer-1');
      queue.fail(task.id, 'Error occurred');

      const updated = queue.get(task.id);
      expect(updated.queueMetadata.attempts).toBe(1);
      expect(updated.status).toBe(TASK_STATUS.QUEUED);
    });

    it('should mark as failed after max attempts', () => {
      const task = queue.add({ description: 'Test task', maxAttempts: 1 });
      queue.lock(task.id, 'consumer-1');
      queue.fail(task.id, 'Error occurred');

      expect(queue.get(task.id).status).toBe(TASK_STATUS.FAILED);
    });
  });

  describe('Query', () => {
    beforeEach(() => {
      queue.add({ description: 'Task 1', agent: 'aider' });
      queue.add({ description: 'Task 2', agent: 'evaluator' });
      queue.add({ description: 'Task 3', agent: 'aider' });
    });

    it('should query by agent', () => {
      const results = queue.query({ agent: 'aider' });
      expect(results.length).toBe(2);
    });

    it('should apply limit', () => {
      const results = queue.query({ limit: 1 });
      expect(results.length).toBe(1);
    });

    it('should sort by time', () => {
      const results = queue.query();
      // Most recent first
      expect(results[0].description).toBe('Task 3');
    });
  });

  describe('Undo', () => {
    it('should request undo for a task', () => {
      const task = queue.add({
        description: 'Test task',
        undoable: true,
        filesAffected: [{ path: 'test.js', before: 'old', after: 'new' }]
      });
      queue.complete(task.id);

      const undoTask = queue.requestUndo(task.id);

      expect(undoTask.type).toBe('undo');
      expect(undoTask.parentId).toBe(task.id);
    });

    it('should throw for non-undoable tasks', () => {
      const task = queue.add({ description: 'Test task', undoable: false });
      queue.complete(task.id);

      expect(() => queue.requestUndo(task.id)).toThrow();
    });
  });

  describe('Statistics', () => {
    it('should return accurate stats', () => {
      queue.add({ description: 'Task 1' });
      queue.add({ description: 'Task 2' });
      const task = queue.add({ description: 'Task 3' });
      queue.complete(task.id);

      const stats = queue.getStats();

      expect(stats.total).toBe(3);
      expect(stats.queued).toBe(2);
      expect(stats.completed).toBe(1);
    });
  });
});


