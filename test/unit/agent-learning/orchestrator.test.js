/**
 * Orchestrator (index.js) Integration Tests
 *
 * Tests the full improvement pipeline with all dependencies mocked.
 *
 * Run:  npx vitest run test/unit/agent-learning/orchestrator.test.js
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
}), { virtual: true });

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  }),
}));

vi.mock('../../../lib/ai-service', () => ({
  complete: vi.fn().mockResolvedValue('improved prompt'),
  json: vi.fn().mockResolvedValue({
    improvements: [{ type: 'prompt', priority: 8, reasoning: 'test', specificIssue: 'fails on X' }],
    overallHealthScore: 40,
  }),
}));

vi.mock('../../../lib/exchange/event-bus', () => {
  const EventEmitter = require('events');
  const bus = new EventEmitter();
  bus.on = bus.on.bind(bus);
  bus.emit = bus.emit.bind(bus);
  bus.removeListener = bus.removeListener.bind(bus);
  return bus;
});

const mockStore = {
  getAgent: vi.fn(),
  updateAgent: vi.fn().mockResolvedValue(true),
};
vi.mock('../../../src/voice-task-sdk/agent-store', () => ({
  getAgentStore: () => mockStore,
}));

vi.mock('../../../packages/agents/agent-registry', () => ({
  isRegistered: vi.fn((id) => id.startsWith('builtin-')),
  getAllAgents: vi.fn(() => []),
}));

// The orchestrator's _isModifiable uses a try/catch require, so we also
// need the module resolvable from the orchestrator's perspective
vi.mock('../../packages/agents/agent-registry', () => ({
  isRegistered: vi.fn((id) => id.startsWith('builtin-')),
  getAllAgents: vi.fn(() => []),
}));

vi.mock('../../../budget-manager', () => ({
  getBudgetManager: () => ({
    data: { usage: [] },
  }),
}));

vi.mock('../../../spaces-api', () => ({
  getSpacesAPI: () => ({
    storage: {
      index: { spaces: [] },
      createSpace: vi.fn(),
      addItem: vi.fn().mockReturnValue({ id: 'item-1' }),
    },
  }),
}));

vi.mock('../../../lib/hud-api', () => ({
  emitResult: vi.fn(),
}));

describe('Agent Learning Orchestrator', () => {
  let orchestrator;

  beforeEach(() => {
    vi.resetModules();
    mockStore.getAgent.mockReset();
    mockStore.updateAgent.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    if (orchestrator) {
      orchestrator.shutdownAgentLearning();
    }
  });

  it('exports initAgentLearning and shutdownAgentLearning', () => {
    orchestrator = require('../../../lib/agent-learning');
    expect(typeof orchestrator.initAgentLearning).toBe('function');
    expect(typeof orchestrator.shutdownAgentLearning).toBe('function');
  });

  it('_isModifiable returns false for built-in agents', () => {
    orchestrator = require('../../../lib/agent-learning');
    const mockRegistry = { isRegistered: (id) => id.startsWith('builtin-') };
    orchestrator._setTestDeps({ registry: mockRegistry });
    expect(orchestrator._isModifiable({ id: 'builtin-weather', type: 'local' })).toBe(false);
  });

  it('_isModifiable returns true for user-defined local agents', () => {
    orchestrator = require('../../../lib/agent-learning');
    const mockRegistry = { isRegistered: () => false };
    orchestrator._setTestDeps({ registry: mockRegistry });
    expect(orchestrator._isModifiable({ id: 'my-custom-agent', type: 'local' })).toBe(true);
  });

  it('_isModifiable returns false for GSX agents', () => {
    orchestrator = require('../../../lib/agent-learning');
    expect(orchestrator._isModifiable({ id: 'gsx-agent', type: 'gsx' })).toBe(false);
  });

  it('_checkLearningBudget returns allowed when no usage', async () => {
    orchestrator = require('../../../lib/agent-learning');
    const result = await orchestrator._checkLearningBudget();
    expect(result.allowed).toBe(true);
  });

  it('has correct default config', () => {
    orchestrator = require('../../../lib/agent-learning');
    expect(orchestrator.DEFAULT_CONFIG.enabled).toBe(true);
    expect(orchestrator.DEFAULT_CONFIG.maxImprovementsPerDay).toBe(10);
    expect(orchestrator.DEFAULT_CONFIG.maxCreationsPerDay).toBe(3);
    expect(orchestrator.DEFAULT_CONFIG.dailyBudget).toBe(0.50);
  });

  it('feature prefix is agent-learning', () => {
    orchestrator = require('../../../lib/agent-learning');
    expect(orchestrator.LEARNING_FEATURE_PREFIX).toBe('agent-learning');
  });
});
