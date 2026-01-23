/**
 * Priority Queue - Manages task queue with priority levels
 */
import type { Task, TaskPriority } from '../types/index.js';
import { TaskPriority as Priority } from '../types/index.js';

export class PriorityQueue {
  private queues: Map<TaskPriority, Task[]> = new Map([
    [Priority.URGENT, []],
    [Priority.NORMAL, []],
    [Priority.LOW, []],
  ]);

  /**
   * Add a task to the queue
   */
  enqueue(task: Task): void {
    const priority = task.priority ?? Priority.NORMAL;
    const queue = this.queues.get(priority) ?? this.queues.get(Priority.NORMAL)!;
    queue.push(task);
  }

  /**
   * Get the next task (highest priority first)
   */
  dequeue(): Task | null {
    for (const priority of [Priority.URGENT, Priority.NORMAL, Priority.LOW]) {
      const queue = this.queues.get(priority)!;
      if (queue.length > 0) {
        return queue.shift()!;
      }
    }
    return null;
  }

  /**
   * Peek at the next task without removing it
   */
  peek(): Task | null {
    for (const priority of [Priority.URGENT, Priority.NORMAL, Priority.LOW]) {
      const queue = this.queues.get(priority)!;
      if (queue.length > 0) {
        return queue[0];
      }
    }
    return null;
  }

  /**
   * Escalate a task to urgent priority
   */
  escalate(taskId: string): boolean {
    for (const [priority, queue] of this.queues) {
      const index = queue.findIndex(t => t.id === taskId);
      if (index !== -1 && priority !== Priority.URGENT) {
        const [task] = queue.splice(index, 1);
        task.priority = Priority.URGENT;
        // Add to front of urgent queue
        this.queues.get(Priority.URGENT)!.unshift(task);
        return true;
      }
    }
    return false;
  }

  /**
   * Remove a task from the queue
   */
  remove(taskId: string): Task | null {
    for (const queue of this.queues.values()) {
      const index = queue.findIndex(t => t.id === taskId);
      if (index !== -1) {
        const [task] = queue.splice(index, 1);
        return task;
      }
    }
    return null;
  }

  /**
   * Get queue depth by priority
   */
  getDepth(): { urgent: number; normal: number; low: number; total: number } {
    const urgent = this.queues.get(Priority.URGENT)!.length;
    const normal = this.queues.get(Priority.NORMAL)!.length;
    const low = this.queues.get(Priority.LOW)!.length;
    return {
      urgent,
      normal,
      low,
      total: urgent + normal + low,
    };
  }

  /**
   * Check if queue is empty
   */
  isEmpty(): boolean {
    return this.getDepth().total === 0;
  }

  /**
   * Get all tasks (for inspection)
   */
  getAllTasks(): Task[] {
    const all: Task[] = [];
    for (const queue of this.queues.values()) {
      all.push(...queue);
    }
    return all;
  }

  /**
   * Clear all queues
   */
  clear(): void {
    for (const queue of this.queues.values()) {
      queue.length = 0;
    }
  }
}
