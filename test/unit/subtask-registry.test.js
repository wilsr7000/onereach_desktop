/**
 * Subtask Registry - CRUD Lifecycle Tests
 *
 * Lifecycle: Submit subtask -> Check isSubtask -> Get context -> Get routing -> Cleanup -> Verify
 * Also covers: input schema processing.
 *
 * Run:  npx vitest run test/unit/subtask-registry.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock log-event-queue
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const subtaskReg = require('../../lib/exchange/subtask-registry');

// ═══════════════════════════════════════════════════════════════════
// SUBTASK HELPERS (no exchange needed)
// ═══════════════════════════════════════════════════════════════════

describe('Subtask Registry - isSubtask / getContext / getRouting', () => {
  it('isSubtask returns truthy for subtask metadata', () => {
    const task = { metadata: { source: 'subtask', parentTaskId: 'parent-1' } };
    expect(subtaskReg.isSubtask(task)).toBeTruthy();
  });

  it('isSubtask returns false for normal tasks', () => {
    expect(subtaskReg.isSubtask({ metadata: {} })).toBe(false);
    expect(subtaskReg.isSubtask({})).toBe(false);
    expect(subtaskReg.isSubtask(null)).toBe(false);
  });

  it('getSubtaskContext returns context from metadata', () => {
    const task = {
      metadata: {
        source: 'subtask',
        parentTaskId: 'p-1',
        subtaskContext: { key: 'value' },
      },
    };
    const ctx = subtaskReg.getSubtaskContext(task);
    expect(ctx).toEqual({ key: 'value' });
  });

  it('getSubtaskContext returns empty object for non-subtask', () => {
    expect(subtaskReg.getSubtaskContext({})).toEqual({});
    expect(subtaskReg.getSubtaskContext(null)).toEqual({});
  });

  it('getSubtaskRouting returns locked info for locked subtask', () => {
    const task = {
      metadata: {
        source: 'subtask',
        parentTaskId: 'p-1',
        routingMode: 'locked',
        lockedAgentId: 'weather-agent',
      },
    };
    const routing = subtaskReg.getSubtaskRouting(task);
    expect(routing.locked).toBe(true);
    expect(routing.agentId).toBe('weather-agent');
  });

  it('getSubtaskRouting returns unlocked for open subtask', () => {
    const task = {
      metadata: {
        source: 'subtask',
        parentTaskId: 'p-1',
        routingMode: 'open',
      },
    };
    const routing = subtaskReg.getSubtaskRouting(task);
    expect(routing.locked).toBe(false);
    expect(routing.agentId).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// SUBMIT -> READ -> CLEANUP LIFECYCLE (with mock exchange)
// ═══════════════════════════════════════════════════════════════════

describe('Subtask Registry - Submit Lifecycle', () => {
  let mockExchange;

  beforeEach(() => {
    mockExchange = {
      submit: vi.fn(async ({ content, priority, metadata }) => ({
        taskId: 'subtask-' + Math.random().toString(36).slice(2, 8),
        task: { id: 'subtask-mock', content, priority, metadata },
      })),
      on: vi.fn(),
      off: vi.fn(),
    };
    subtaskReg.setExchangeInstance(mockExchange);
    subtaskReg.setBroadcast(vi.fn());
  });

  it('Step 1: Submit a subtask', async () => {
    const result = await subtaskReg.submitSubtask({
      parentTaskId: 'parent-1',
      content: 'What time is it in Tokyo?',
      routingMode: 'open',
    });
    expect(result.queued).toBe(true);
    expect(result.subtaskId).toBeTruthy();
  });

  it('Step 2: Read subtasks for parent', async () => {
    await subtaskReg.submitSubtask({
      parentTaskId: 'parent-2',
      content: 'Subtask A',
    });
    await subtaskReg.submitSubtask({
      parentTaskId: 'parent-2',
      content: 'Subtask B',
    });
    const children = subtaskReg.getSubtasksForParent('parent-2');
    expect(children.length).toBe(2);
  });

  it('Step 3: Cleanup subtasks', async () => {
    await subtaskReg.submitSubtask({
      parentTaskId: 'parent-3',
      content: 'temp subtask',
    });
    expect(subtaskReg.getSubtasksForParent('parent-3').length).toBe(1);

    subtaskReg.cleanupSubtasks('parent-3');
    expect(subtaskReg.getSubtasksForParent('parent-3').length).toBe(0);
  });

  it('Step 4: Verify gone after cleanup', async () => {
    await subtaskReg.submitSubtask({
      parentTaskId: 'parent-4',
      content: 'to be cleaned',
    });
    subtaskReg.cleanupSubtasks('parent-4');
    const children = subtaskReg.getSubtasksForParent('parent-4');
    expect(children).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════

describe('Subtask Registry - Validation', () => {
  beforeEach(() => {
    subtaskReg.setExchangeInstance(null);
  });

  it('should fail when exchange is not initialized', async () => {
    const result = await subtaskReg.submitSubtask({
      parentTaskId: 'p',
      content: 'test',
    });
    expect(result.queued).toBe(false);
    expect(result.error).toContain('Exchange not initialized');
  });

  it('should fail when parentTaskId is missing', async () => {
    subtaskReg.setExchangeInstance({ submit: vi.fn() });
    const result = await subtaskReg.submitSubtask({
      content: 'test',
    });
    expect(result.queued).toBe(false);
    expect(result.error).toContain('Missing');
  });

  it('should fail when locked routing has no agentId', async () => {
    subtaskReg.setExchangeInstance({ submit: vi.fn() });
    const result = await subtaskReg.submitSubtask({
      parentTaskId: 'p',
      content: 'test',
      routingMode: 'locked',
    });
    expect(result.queued).toBe(false);
    expect(result.error).toContain('lockedAgentId');
  });
});

// ═══════════════════════════════════════════════════════════════════
// INPUT SCHEMA
// ═══════════════════════════════════════════════════════════════════

describe('Subtask Registry - Input Schema', () => {
  it('hasInputSchema returns falsy for agent without inputs', () => {
    expect(subtaskReg.hasInputSchema({})).toBeFalsy();
    expect(subtaskReg.hasInputSchema({ inputs: {} })).toBeFalsy();
  });

  it('hasInputSchema returns true for agent with inputs', () => {
    const agent = { inputs: { city: { required: true, prompt: 'Which city?' } } };
    expect(subtaskReg.hasInputSchema(agent)).toBe(true);
  });

  it('getNextMissingInput returns first missing required field', () => {
    const agent = {
      inputs: {
        city: { required: true, prompt: 'Which city?' },
        units: { required: true, prompt: 'Units?' },
      },
    };
    const missing = subtaskReg.getNextMissingInput(agent, {});
    expect(missing.field).toBe('city');
  });

  it('getNextMissingInput skips already gathered fields', () => {
    const agent = {
      inputs: {
        city: { required: true, prompt: 'Which city?' },
        units: { required: true, prompt: 'Units?' },
      },
    };
    const missing = subtaskReg.getNextMissingInput(agent, { city: 'Tokyo' });
    expect(missing.field).toBe('units');
  });

  it('getNextMissingInput returns null when all gathered', () => {
    const agent = {
      inputs: {
        city: { required: true, prompt: 'Which city?' },
      },
    };
    const missing = subtaskReg.getNextMissingInput(agent, { city: 'Tokyo' });
    expect(missing).toBeNull();
  });

  it('processInputResponse matches options', () => {
    const result = subtaskReg.processInputResponse('celsius', 'units', { options: ['Fahrenheit', 'Celsius'] }, {});
    expect(result.units).toBe('Celsius');
  });

  it('buildInputRequest includes required structure', () => {
    const req = subtaskReg.buildInputRequest(
      'weather-agent',
      'city',
      { prompt: 'Which city?', options: ['NYC', 'LA'] },
      {},
      {}
    );
    expect(req.success).toBe(true);
    expect(req.needsInput).toBeDefined();
    expect(req.needsInput.field).toBe('city');
    expect(req.needsInput.prompt).toBe('Which city?');
    expect(req.needsInput.agentId).toBe('weather-agent');
  });
});
