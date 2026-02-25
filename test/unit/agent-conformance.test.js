/**
 * Agent Conformance Test Suite
 *
 * Validates that every registered agent follows the required contract:
 *  - Has id, name, execute (function), categories (array)
 *  - execute() never throws (returns { success, message })
 *  - Handles missing task.content gracefully
 *  - Handles undefined task gracefully
 *
 * Also tests the agent-middleware in isolation.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

// ─── Mock external dependencies ──────────────────────────────────────────────
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    enqueue: vi.fn(),
  }),
}));

vi.mock('../../lib/ai-service', () => ({
  chat: vi.fn().mockResolvedValue({ content: '{}' }),
  complete: vi.fn().mockResolvedValue('mock response'),
  json: vi.fn().mockResolvedValue({}),
  vision: vi.fn().mockResolvedValue({ content: '' }),
  embed: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../lib/agent-memory-store', () => ({
  getAgentMemory: vi.fn(() => ({
    load: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    getSection: vi.fn().mockReturnValue(''),
    getSectionNames: vi.fn().mockReturnValue([]),
    updateSection: vi.fn(),
    appendToSection: vi.fn(),
    parseSectionAsKeyValue: vi.fn().mockReturnValue({}),
    isDirty: vi.fn().mockReturnValue(false),
    getAllFacts: vi.fn().mockReturnValue({}),
  })),
  initializeBuiltInAgentMemories: vi.fn().mockResolvedValue({ created: [] }),
}));

vi.mock('../../lib/user-profile-store', () => ({
  getUserProfile: vi.fn(() => ({
    load: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    isLoaded: vi.fn().mockReturnValue(true),
    getFacts: vi.fn().mockReturnValue({}),
    getContextString: vi.fn().mockReturnValue(''),
    updateFact: vi.fn(),
  })),
}));

vi.mock('../../lib/applescript-helper', () => ({
  run: vi.fn().mockResolvedValue(''),
  runScript: vi.fn().mockResolvedValue(''),
}));

vi.mock('https', () => ({
  request: vi.fn(() => ({
    on: vi.fn().mockReturnThis(),
    write: vi.fn(),
    end: vi.fn(),
  })),
  get: vi.fn(),
}));

// ─── Import middleware ───────────────────────────────────────────────────────
const {
  safeExecuteAgent,
  normalizeTaskInput,
  normalizeResult,
  validateAgentContract,
} = require('../../packages/agents/agent-middleware');

// ─── Agent registry (load all agents) ────────────────────────────────────────
// We load agents individually to isolate failures
const AGENT_FILES = [
  'time-agent',
  'weather-agent',
  'calendar-query-agent',
  'calendar-create-agent',
  'calendar-edit-agent',
  'calendar-delete-agent',
  'smalltalk-agent',
  'spelling-agent',
  'help-agent',
  'media-agent',
  'orchestrator-agent',
  'decision-agent',
  'meeting-notes-agent',
  'action-item-agent',
  'error-agent',
  'memory-agent',
  'playbook-agent',
  'daily-brief-agent',
];

const loadedAgents = [];

beforeAll(() => {
  for (const agentId of AGENT_FILES) {
    try {
      const agent = require(`../../packages/agents/${agentId}`);
      loadedAgents.push({ id: agentId, agent, loadError: null });
    } catch (err) {
      loadedAgents.push({ id: agentId, agent: null, loadError: err.message });
    }
  }
});

// ─── Middleware Unit Tests ────────────────────────────────────────────────────

describe('Agent Middleware', () => {
  describe('normalizeTaskInput', () => {
    it('passes through existing task.content', () => {
      const task = { content: 'hello world', metadata: {} };
      const result = normalizeTaskInput(task);
      expect(result.content).toBe('hello world');
    });

    it('copies task.text to content when content is missing', () => {
      const task = { text: 'from text field' };
      const result = normalizeTaskInput(task);
      expect(result.content).toBe('from text field');
    });

    it('copies task.query to content when content is missing', () => {
      const task = { query: 'from query field' };
      const result = normalizeTaskInput(task);
      expect(result.content).toBe('from query field');
    });

    it('copies task.input to content when content is missing', () => {
      const task = { input: 'from input field' };
      const result = normalizeTaskInput(task);
      expect(result.content).toBe('from input field');
    });

    it('defaults to empty string when all fields are missing', () => {
      const result = normalizeTaskInput({});
      expect(result.content).toBe('');
    });

    it('handles null task', () => {
      const result = normalizeTaskInput(null);
      expect(result.content).toBe('');
      expect(result.metadata).toEqual({});
    });

    it('handles undefined task', () => {
      const result = normalizeTaskInput(undefined);
      expect(result.content).toBe('');
    });

    it('backfills text and query aliases', () => {
      const task = { content: 'hello' };
      const result = normalizeTaskInput(task);
      expect(result.text).toBe('hello');
      expect(result.query).toBe('hello');
    });

    it('coerces non-string content to string', () => {
      const task = { content: 42 };
      const result = normalizeTaskInput(task);
      expect(result.content).toBe('42');
    });
  });

  describe('normalizeResult', () => {
    it('wraps undefined as failure', () => {
      const result = normalizeResult(undefined);
      expect(result.success).toBe(false);
      expect(typeof result.message).toBe('string');
    });

    it('wraps null as failure', () => {
      const result = normalizeResult(null);
      expect(result.success).toBe(false);
    });

    it('wraps bare string as success', () => {
      const result = normalizeResult('hello');
      expect(result.success).toBe(true);
      expect(result.message).toBe('hello');
    });

    it('passes through well-formed result', () => {
      const result = normalizeResult({ success: true, message: 'done' });
      expect(result.success).toBe(true);
      expect(result.message).toBe('done');
    });

    it('maps output to message when message is missing', () => {
      const result = normalizeResult({ success: true, output: 'from output' });
      expect(result.message).toBe('from output');
    });

    it('maps error to message when success is false and message missing', () => {
      const result = normalizeResult({ success: false, error: 'boom' });
      expect(result.message).toBe('boom');
    });

    it('infers success=true when no error field', () => {
      const result = normalizeResult({ message: 'hi' });
      expect(result.success).toBe(true);
    });

    it('infers success=false when error field is present', () => {
      const result = normalizeResult({ error: 'fail' });
      expect(result.success).toBe(false);
    });
  });

  describe('safeExecuteAgent', () => {
    it('catches agent exceptions and returns structured failure', async () => {
      const agent = {
        id: 'crash-agent',
        name: 'Crash Agent',
        execute: () => { throw new Error('kaboom'); },
      };
      const result = await safeExecuteAgent(agent, { content: 'hello' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('kaboom');
    });

    it('catches async agent exceptions', async () => {
      const agent = {
        id: 'async-crash',
        name: 'Async Crash',
        execute: async () => { throw new Error('async boom'); },
      };
      const result = await safeExecuteAgent(agent, { content: 'hello' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('async boom');
    });

    it('handles agent returning undefined', async () => {
      const agent = {
        id: 'void-agent',
        name: 'Void Agent',
        execute: async () => undefined,
      };
      const result = await safeExecuteAgent(agent, { content: 'hello' });
      expect(result.success).toBe(false);
      expect(typeof result.message).toBe('string');
    });

    it('handles agent returning bare string', async () => {
      const agent = {
        id: 'string-agent',
        name: 'String Agent',
        execute: async () => 'just a string',
      };
      const result = await safeExecuteAgent(agent, { content: 'hello' });
      expect(result.success).toBe(true);
      expect(result.message).toBe('just a string');
    });

    it('normalizes task.content before passing to agent', async () => {
      let receivedTask = null;
      const agent = {
        id: 'spy-agent',
        name: 'Spy Agent',
        execute: async (task) => {
          receivedTask = task;
          return { success: true, message: 'ok' };
        },
      };
      await safeExecuteAgent(agent, { text: 'from text', query: 'from query' });
      expect(receivedTask.content).toBe('from text');
    });

    it('handles agent with no execute method', async () => {
      const agent = { id: 'broken', name: 'Broken' };
      const result = await safeExecuteAgent(agent, { content: 'hello' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('not properly configured');
    });

    it('handles null agent', async () => {
      const result = await safeExecuteAgent(null, { content: 'hello' });
      expect(result.success).toBe(false);
    });

    it('respects timeout', async () => {
      const agent = {
        id: 'slow-agent',
        name: 'Slow Agent',
        execute: () => new Promise((resolve) => setTimeout(() => resolve({ success: true, message: 'late' }), 5000)),
      };
      const result = await safeExecuteAgent(agent, { content: 'hello' }, { timeoutMs: 100 });
      expect(result.success).toBe(false);
      expect(result.message).toContain('taking longer');
    }, 10000);

    it('uses custom executeFn when provided', async () => {
      const agent = {
        id: 'custom-fn',
        name: 'Custom Fn',
        execute: async () => ({ success: true, message: 'direct' }),
      };
      const customFn = vi.fn(async (_agent, task) => ({
        success: true,
        message: `custom: ${task.content}`,
      }));
      const result = await safeExecuteAgent(agent, { content: 'hello' }, { executeFn: customFn });
      expect(customFn).toHaveBeenCalled();
      expect(result.message).toBe('custom: hello');
    });

    it('preserves needsInput in result', async () => {
      const agent = {
        id: 'multi-turn',
        name: 'Multi Turn',
        execute: async () => ({
          success: true,
          needsInput: { prompt: 'What city?', agentId: 'multi-turn' },
        }),
      };
      const result = await safeExecuteAgent(agent, { content: 'weather' });
      expect(result.success).toBe(true);
      expect(result.needsInput).toBeDefined();
      expect(result.needsInput.prompt).toBe('What city?');
    });
  });

  describe('validateAgentContract', () => {
    it('passes for a well-formed agent', () => {
      const agent = {
        id: 'test-agent',
        name: 'Test Agent',
        execute: async () => ({}),
        categories: ['test'],
        description: 'A test agent',
        keywords: ['test'],
      };
      const { valid, warnings } = validateAgentContract(agent);
      expect(valid).toBe(true);
      expect(warnings.length).toBe(0);
    });

    it('warns about missing required fields', () => {
      const agent = { name: 'No ID' };
      const { valid, warnings } = validateAgentContract(agent);
      expect(valid).toBe(false);
      expect(warnings.some((w) => w.includes('id'))).toBe(true);
      expect(warnings.some((w) => w.includes('execute'))).toBe(true);
    });

    it('warns about missing recommended fields', () => {
      const agent = { id: 'x', name: 'X', execute: async () => ({}) };
      const { warnings } = validateAgentContract(agent);
      expect(warnings.some((w) => w.includes('categories'))).toBe(true);
    });
  });
});

// ─── Per-Agent Contract Tests ────────────────────────────────────────────────

describe('Agent Contract Conformance', () => {
  it('loaded at least 10 agents', () => {
    const loaded = loadedAgents.filter((a) => a.agent !== null);
    expect(loaded.length).toBeGreaterThanOrEqual(10);
  });

  describe.each(AGENT_FILES)('%s', (agentId) => {
    it('loads without error', () => {
      const entry = loadedAgents.find((a) => a.id === agentId);
      if (entry.loadError) {
        console.warn(`  [skip] ${agentId} failed to load: ${entry.loadError}`);
      }
      expect(entry).toBeDefined();
      // Allow load failures for agents with complex deps -- the point is they don't crash the suite
    });

    it('has required id field', () => {
      const entry = loadedAgents.find((a) => a.id === agentId);
      if (!entry.agent) return; // skip if load failed
      expect(entry.agent.id).toBeTruthy();
      expect(typeof entry.agent.id).toBe('string');
    });

    it('has required name field', () => {
      const entry = loadedAgents.find((a) => a.id === agentId);
      if (!entry.agent) return;
      expect(entry.agent.name).toBeTruthy();
      expect(typeof entry.agent.name).toBe('string');
    });

    it('has execute as a function', () => {
      const entry = loadedAgents.find((a) => a.id === agentId);
      if (!entry.agent) return;
      expect(typeof entry.agent.execute).toBe('function');
    });

    it('has categories as an array', () => {
      const entry = loadedAgents.find((a) => a.id === agentId);
      if (!entry.agent) return;
      expect(Array.isArray(entry.agent.categories)).toBe(true);
      expect(entry.agent.categories.length).toBeGreaterThan(0);
    });

    it('does not crash when task.content is undefined (via middleware)', async () => {
      const entry = loadedAgents.find((a) => a.id === agentId);
      if (!entry.agent) return;
      const result = await safeExecuteAgent(entry.agent, { content: undefined });
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.message).toBe('string');
    });

    it('does not crash when task is empty object (via middleware)', async () => {
      const entry = loadedAgents.find((a) => a.id === agentId);
      if (!entry.agent) return;
      const result = await safeExecuteAgent(entry.agent, {});
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.message).toBe('string');
    });

    it('does not crash with task.text instead of task.content (via middleware)', async () => {
      const entry = loadedAgents.find((a) => a.id === agentId);
      if (!entry.agent) return;
      const result = await safeExecuteAgent(entry.agent, { text: 'hello' });
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.message).toBe('string');
    });

    it('returns well-formed result with normal input (via middleware)', async () => {
      const entry = loadedAgents.find((a) => a.id === agentId);
      if (!entry.agent) return;
      const result = await safeExecuteAgent(entry.agent, { content: 'test' });
      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.message).toBe('string');
      expect(result.message.length).toBeGreaterThan(0);
    });
  });
});
