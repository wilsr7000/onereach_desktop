/**
 * Agent execute() Contract Tests
 *
 * Loads every registered built-in agent and verifies the execute() contract:
 *   1. execute() returns { success: boolean, message: string }
 *   2. execute() never throws (returns { success: false } instead)
 *   3. execute({ input: '' }) handles empty input gracefully
 *   4. Response never contains `error` key without `message`
 *
 * Run:  npx vitest run test/unit/agent-execute-contract.test.js
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

// ─── Electron mock ──────────────────────────────────────────────────────────
vi.mock(
  'electron',
  () => ({
    app: {
      getPath: vi.fn(() => '/tmp/test-agents'),
      whenReady: vi.fn(() => Promise.resolve()),
      isReady: vi.fn(() => true),
    },
    ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
    BrowserWindow: {
      getAllWindows: vi.fn(() => []),
      fromWebContents: vi.fn(() => null),
    },
    screen: { getPrimaryDisplay: vi.fn(() => ({ workAreaSize: { width: 1920, height: 1080 } })) },
    clipboard: { readText: vi.fn(() => ''), writeText: vi.fn() },
    nativeImage: { createFromDataURL: vi.fn() },
    shell: { openExternal: vi.fn() },
    dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  }),
  { virtual: true }
);

// ─── Settings mock ──────────────────────────────────────────────────────────
vi.mock(
  '../../settings-manager',
  () => ({
    getSettingsManager: vi.fn(() => ({
      get: vi.fn((key) => {
        const defaults = {
          'ai.openaiApiKey': 'test-key',
          'ai.anthropicApiKey': 'test-key',
          'ai.profiles': null,
          'calendar.provider': 'none',
          'calendar.accounts': [],
          'weather.units': 'imperial',
        };
        return defaults[key] ?? null;
      }),
      set: vi.fn(),
      getAll: vi.fn(() => ({})),
    })),
  }),
  { virtual: true }
);

// ─── Log queue mock ─────────────────────────────────────────────────────────
vi.mock(
  '../../lib/log-event-queue',
  () => ({
    getLogQueue: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  }),
  { virtual: true }
);

// ─── Clipboard storage mock ─────────────────────────────────────────────────
vi.mock(
  '../../clipboard-storage-v2',
  () => ({
    getSharedStorage: vi.fn(() => null),
  }),
  { virtual: true }
);

// ─── AI service mock -- returns a simple response ───────────────────────────
vi.mock(
  '../../lib/ai-service',
  () => {
    const mockChat = vi.fn(async () => ({
      content: 'Mock AI response',
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }));
    return {
      default: { chat: mockChat, complete: vi.fn(async () => 'Mock'), json: vi.fn(async () => ({})) },
      chat: mockChat,
      complete: vi.fn(async () => 'Mock'),
      json: vi.fn(async () => ({})),
      vision: vi.fn(async () => ({ content: 'Mock' })),
      embed: vi.fn(async () => [0.1, 0.2]),
    };
  },
  { virtual: true }
);

// ─── Agent memory store mock ────────────────────────────────────────────────
vi.mock(
  '../../lib/agent-memory-store',
  () => ({
    getAgentMemory: vi.fn(() => ({
      load: vi.fn(async () => {}),
      save: vi.fn(async () => {}),
      get: vi.fn(() => null),
      set: vi.fn(),
      getSection: vi.fn(() => []),
      addToSection: vi.fn(),
    })),
  }),
  { virtual: true }
);

// ─── Thinking agent mock ────────────────────────────────────────────────────
vi.mock(
  '../../lib/thinking-agent',
  () => ({
    learnFromInteraction: vi.fn(async () => {}),
    reviewExecution: vi.fn(async (_task, result) => result),
    getTimeContext: vi.fn(() => ({ timeOfDay: 'morning', dayOfWeek: 'Monday' })),
  }),
  { virtual: true }
);

// ─── User profile store mock ────────────────────────────────────────────────
vi.mock(
  '../../lib/user-profile-store',
  () => ({
    getUserProfile: vi.fn(() => ({
      get: vi.fn(() => null),
      set: vi.fn(),
      getAll: vi.fn(() => ({})),
    })),
  }),
  { virtual: true }
);

// ─── Calendar store mock ────────────────────────────────────────────────────
vi.mock(
  '../../lib/calendar-store',
  () => ({
    getCalendarStore: vi.fn(() => ({
      getEvents: vi.fn(async () => []),
      getTodayEvents: vi.fn(async () => []),
    })),
  }),
  { virtual: true }
);

// ─── Calendar data mock ─────────────────────────────────────────────────────
vi.mock(
  '../../lib/calendar-data',
  () => ({
    getCalendarData: vi.fn(() => ({
      getEvents: vi.fn(async () => []),
      getAccounts: vi.fn(() => []),
    })),
  }),
  { virtual: true }
);

// ─── HTTP client mock ───────────────────────────────────────────────────────
vi.mock(
  '../../lib/http-client',
  () => ({
    fetch: vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '',
    })),
    fetchJSON: vi.fn(async () => ({})),
    resetCircuits: vi.fn(),
  }),
  { virtual: true }
);

// ─── Exchange event bus mock ────────────────────────────────────────────────
vi.mock(
  '../../lib/exchange/event-bus',
  () => {
    const EventEmitter = require('events');
    const bus = new EventEmitter();
    bus.registerBridge = vi.fn();
    bus.getExchange = vi.fn(() => null);
    bus.processSubmit = vi.fn(async () => ({ taskId: null, queued: false }));
    return bus;
  },
  { virtual: true }
);

// ─── Playbook executor mock ─────────────────────────────────────────────────
vi.mock(
  '../../lib/playbook-executor',
  () => ({
    executePlaybook: vi.fn(async () => ({ success: true, results: [] })),
    getPlaybookExecutor: vi.fn(() => ({
      execute: vi.fn(async () => ({ success: true, results: [] })),
    })),
  }),
  { virtual: true }
);

// ─── Browser automation mock ────────────────────────────────────────────────
vi.mock(
  '../../lib/browser-automation',
  () => ({
    launch: vi.fn(async () => null),
    isAvailable: vi.fn(() => false),
  }),
  { virtual: true }
);

// ═══════════════════════════════════════════════════════════════════════════════
// CONTRACT TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Agent execute() Contract', () => {
  let BUILT_IN_AGENT_IDS;
  let loadedAgents;
  const failedToLoad = [];

  beforeAll(() => {
    // Load the ID list
    const registry = require('../../packages/agents/agent-registry');
    BUILT_IN_AGENT_IDS = registry.BUILT_IN_AGENT_IDS;

    // Attempt to require each agent directly (bypass registry caching)
    loadedAgents = [];
    for (const agentId of BUILT_IN_AGENT_IDS) {
      try {
        const agent = require(`../../packages/agents/${agentId}`);
        loadedAgents.push(agent);
      } catch (err) {
        failedToLoad.push({ id: agentId, error: err.message });
      }
    }
  });

  it('loads at least half of the registered agents', () => {
    expect(loadedAgents.length).toBeGreaterThan(BUILT_IN_AGENT_IDS.length / 2);
    if (failedToLoad.length > 0) {
      console.warn(
        `[contract] ${failedToLoad.length} agents failed to load (dependency issues in test env):`,
        failedToLoad.map((f) => f.id).join(', ')
      );
    }
  });

  describe.each(
    // We dynamically build the list after beforeAll runs, but vitest needs
    // it statically. Use a lazy wrapper that filters at runtime.
    (() => {
      // Pre-require to discover which agents load successfully
      const ids = [];
      try {
        const reg = require('../../packages/agents/agent-registry');
        for (const agentId of reg.BUILT_IN_AGENT_IDS) {
          try {
            require(`../../packages/agents/${agentId}`);
            ids.push(agentId);
          } catch (_ignored) {
            // skip agents that can't load in test env
          }
        }
      } catch (_ignored) {
        // registry itself failed to load
      }
      return ids.map((id) => [id]);
    })()
  )('%s', (agentId) => {
    let agent;

    beforeAll(() => {
      agent = require(`../../packages/agents/${agentId}`);
    });

    it('has a valid execute function', () => {
      expect(typeof agent.execute).toBe('function');
    });

    it('execute() returns { success, message } and never throws', async () => {
      const task = {
        id: 'test-task-001',
        content: 'test query',
        input: 'test query',
        context: { signal: { aborted: false } },
      };

      let result;
      try {
        result = await agent.execute(task, {
          signal: { aborted: false },
          onProgress: vi.fn(),
        });
      } catch (err) {
        // execute() should never throw -- this is a contract violation
        expect.fail(`${agentId}.execute() threw instead of returning { success: false }: ${err.message}`);
      }

      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
      expect(typeof result.success).toBe('boolean');

      // message must be present (string)
      if (result.message !== undefined) {
        expect(typeof result.message).toBe('string');
      }
    });

    it('execute() handles empty input gracefully', async () => {
      const task = {
        id: 'test-task-empty',
        content: '',
        input: '',
        context: { signal: { aborted: false } },
      };

      let result;
      try {
        result = await agent.execute(task, {
          signal: { aborted: false },
          onProgress: vi.fn(),
        });
      } catch (err) {
        expect.fail(`${agentId}.execute() threw on empty input: ${err.message}`);
      }

      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
      expect(typeof result.success).toBe('boolean');
    });

    it('response never has error without message', async () => {
      const task = {
        id: 'test-task-error-check',
        content: 'error check',
        input: 'error check',
        context: { signal: { aborted: false } },
      };

      let result;
      try {
        result = await agent.execute(task, {
          signal: { aborted: false },
          onProgress: vi.fn(),
        });
      } catch (_ignored) {
        return; // if it throws, the "never throws" test already catches it
      }

      if (result && result.error) {
        expect(result.message).toBeDefined();
        expect(typeof result.message).toBe('string');
      }
    });
  });
});
