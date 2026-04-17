/**
 * Unit tests for lib/claude-code-agent-builder.js
 *
 * Verifies the plan -> generate -> save orchestration with mocked
 * claude-code-runner, ai-agent-generator, and agent-store.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  buildAgentWithClaudeCode,
  BUILD_COST_ESTIMATE_USD,
  _setTestDeps,
  _describeAgentFromPlan,
  _preflightBudgetCheck,
} from '../../lib/claude-code-agent-builder.js';

// Fresh mock suite, injected via _setTestDeps each test.
const runner = {
  planAgent: vi.fn(),
};
const generator = {
  generateAgentFromDescription: vi.fn(),
};
const store = {
  init: vi.fn().mockResolvedValue(undefined),
  createAgent: vi.fn(),
};
const budget = {
  checkBudget: vi.fn().mockReturnValue({ blocked: false, warnings: [] }),
};

_setTestDeps({
  runner: () => runner,
  generator: () => generator,
  store: () => store,
  budget: () => ({ getBudgetManager: () => budget }),
});

const SAMPLE_PLAN = {
  understanding: 'User wants an agent that fetches stock prices',
  executionType: 'llm',
  features: ['fetch-price', 'format-quote'],
  approach: 'Use a free stock API with a single tool call',
  suggestedName: 'Stock Quote Agent',
  confidence: 0.9,
};

const SAMPLE_AGENT = {
  id: 'agent-stock-quote',
  name: 'Stock Quote Agent',
  description: 'Fetches stock prices',
};

describe('buildAgentWithClaudeCode', () => {
  beforeEach(() => {
    runner.planAgent.mockReset();
    generator.generateAgentFromDescription.mockReset();
    store.init.mockReset().mockResolvedValue(undefined);
    store.createAgent.mockReset();
    budget.checkBudget.mockReset().mockReturnValue({ blocked: false, warnings: [] });
  });

  it('rejects empty requests without calling any downstream service', async () => {
    const r1 = await buildAgentWithClaudeCode('');
    expect(r1.success).toBe(false);
    expect(r1.stage).toBe('validate');
    expect(runner.planAgent).not.toHaveBeenCalled();
    expect(generator.generateAgentFromDescription).not.toHaveBeenCalled();
  });

  it('runs plan -> generate -> save on the happy path', async () => {
    runner.planAgent.mockResolvedValue({ success: true, plan: SAMPLE_PLAN });
    generator.generateAgentFromDescription.mockResolvedValue({
      id: 'agent-stock-quote',
      name: 'Stock Quote Agent',
    });
    store.createAgent.mockResolvedValue(SAMPLE_AGENT);

    const result = await buildAgentWithClaudeCode('I want stock prices');

    expect(result.success).toBe(true);
    expect(result.stage).toBe('done');
    expect(result.agent).toEqual(SAMPLE_AGENT);
    expect(result.plan).toEqual(SAMPLE_PLAN);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);

    expect(runner.planAgent).toHaveBeenCalledTimes(1);
    expect(runner.planAgent.mock.calls[0][0]).toBe('I want stock prices');

    // Generator should receive a description that incorporates plan details
    expect(generator.generateAgentFromDescription).toHaveBeenCalledTimes(1);
    const genDescription = generator.generateAgentFromDescription.mock.calls[0][0];
    expect(genDescription).toContain('I want stock prices');
    expect(genDescription).toContain('Stock Quote Agent');
    expect(genDescription).toContain('fetch-price');

    expect(store.init).toHaveBeenCalled();
    expect(store.createAgent).toHaveBeenCalledTimes(1);
  });

  it('continues to generate when planAgent throws (degraded mode)', async () => {
    runner.planAgent.mockRejectedValue(new Error('claude code not available'));
    generator.generateAgentFromDescription.mockResolvedValue({ id: 'x', name: 'X' });
    store.createAgent.mockResolvedValue(SAMPLE_AGENT);

    const result = await buildAgentWithClaudeCode('do something');

    expect(result.success).toBe(true);
    expect(result.plan).toBeNull();
    expect(generator.generateAgentFromDescription).toHaveBeenCalled();
  });

  it('continues when planAgent returns success: false', async () => {
    runner.planAgent.mockResolvedValue({ success: false, error: 'CLI error' });
    generator.generateAgentFromDescription.mockResolvedValue({ id: 'x', name: 'X' });
    store.createAgent.mockResolvedValue(SAMPLE_AGENT);

    const result = await buildAgentWithClaudeCode('do something');
    expect(result.success).toBe(true);
    expect(result.plan).toBeNull();
  });

  it('skips planning when skipPlanning: true', async () => {
    generator.generateAgentFromDescription.mockResolvedValue({ id: 'x', name: 'X' });
    store.createAgent.mockResolvedValue(SAMPLE_AGENT);

    const result = await buildAgentWithClaudeCode('do something', { skipPlanning: true });
    expect(result.success).toBe(true);
    expect(runner.planAgent).not.toHaveBeenCalled();
  });

  it('fails cleanly when generator throws', async () => {
    runner.planAgent.mockResolvedValue({ success: true, plan: SAMPLE_PLAN });
    generator.generateAgentFromDescription.mockRejectedValue(new Error('gen failed'));

    const result = await buildAgentWithClaudeCode('do something');
    expect(result.success).toBe(false);
    expect(result.stage).toBe('generate');
    expect(result.error).toMatch(/gen failed/);
    expect(store.createAgent).not.toHaveBeenCalled();
  });

  it('fails cleanly when generator returns empty config', async () => {
    runner.planAgent.mockResolvedValue({ success: true, plan: SAMPLE_PLAN });
    generator.generateAgentFromDescription.mockResolvedValue(null);

    const result = await buildAgentWithClaudeCode('do something');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/empty config/i);
  });

  it('fails cleanly when store.createAgent throws', async () => {
    runner.planAgent.mockResolvedValue({ success: true, plan: SAMPLE_PLAN });
    generator.generateAgentFromDescription.mockResolvedValue({ id: 'x', name: 'X' });
    store.createAgent.mockRejectedValue(new Error('disk full'));

    const result = await buildAgentWithClaudeCode('do something');
    expect(result.success).toBe(false);
    expect(result.stage).toBe('save');
    expect(result.error).toMatch(/disk full/);
  });

  it('emits progress events at each stage on the happy path', async () => {
    runner.planAgent.mockResolvedValue({ success: true, plan: SAMPLE_PLAN });
    generator.generateAgentFromDescription.mockResolvedValue({ id: 'x', name: 'X' });
    store.createAgent.mockResolvedValue(SAMPLE_AGENT);

    const events = [];
    const onProgress = (e) => events.push(e);

    const result = await buildAgentWithClaudeCode('build me a stock bot', { onProgress });

    expect(result.success).toBe(true);
    const stages = events.map((e) => e.stage);
    expect(stages).toContain('start');
    expect(stages).toContain('plan');
    expect(stages).toContain('generate');
    expect(stages).toContain('save');
    expect(stages).toContain('done');
    // Each event carries a message
    for (const e of events) {
      expect(typeof e.message).toBe('string');
      expect(e.message.length).toBeGreaterThan(0);
    }
  });

  it('emits a failed progress event when generation fails', async () => {
    runner.planAgent.mockResolvedValue({ success: true, plan: SAMPLE_PLAN });
    generator.generateAgentFromDescription.mockRejectedValue(new Error('gen boom'));

    const events = [];
    const result = await buildAgentWithClaudeCode('do X', { onProgress: (e) => events.push(e) });

    expect(result.success).toBe(false);
    expect(events.some((e) => e.stage === 'failed')).toBe(true);
  });

  it('blocks the build when budget precheck signals blocked', async () => {
    budget.checkBudget.mockReturnValue({
      blocked: true,
      warnings: [{ reason: 'Daily cap reached' }],
    });

    const events = [];
    const result = await buildAgentWithClaudeCode('do X', { onProgress: (e) => events.push(e) });

    expect(result.success).toBe(false);
    expect(result.budgetBlocked).toBe(true);
    expect(result.stage).toBe('budget');
    expect(runner.planAgent).not.toHaveBeenCalled();
    expect(generator.generateAgentFromDescription).not.toHaveBeenCalled();
    expect(events.some((e) => e.stage === 'failed')).toBe(true);
  });

  it('skips budget precheck when skipBudgetCheck: true', async () => {
    budget.checkBudget.mockReturnValue({
      blocked: true,
      warnings: [{ reason: 'Daily cap reached' }],
    });
    runner.planAgent.mockResolvedValue({ success: true, plan: SAMPLE_PLAN });
    generator.generateAgentFromDescription.mockResolvedValue({ id: 'x', name: 'X' });
    store.createAgent.mockResolvedValue(SAMPLE_AGENT);

    const result = await buildAgentWithClaudeCode('do X', { skipBudgetCheck: true });
    expect(result.success).toBe(true);
  });

  it('never crashes if a progress callback throws', async () => {
    runner.planAgent.mockResolvedValue({ success: true, plan: SAMPLE_PLAN });
    generator.generateAgentFromDescription.mockResolvedValue({ id: 'x', name: 'X' });
    store.createAgent.mockResolvedValue(SAMPLE_AGENT);

    const onProgress = () => {
      throw new Error('bad consumer');
    };

    const result = await buildAgentWithClaudeCode('do X', { onProgress });
    expect(result.success).toBe(true);
  });

  it('exports a sane BUILD_COST_ESTIMATE_USD', () => {
    expect(typeof BUILD_COST_ESTIMATE_USD).toBe('number');
    expect(BUILD_COST_ESTIMATE_USD).toBeGreaterThan(0);
    expect(BUILD_COST_ESTIMATE_USD).toBeLessThan(1); // sanity: < $1 per build
  });

  it('supports a getAgentStore() style dependency (module-level factory)', async () => {
    const factoryStore = {
      init: vi.fn().mockResolvedValue(undefined),
      createAgent: vi.fn().mockResolvedValue(SAMPLE_AGENT),
    };
    const factory = {
      getAgentStore: () => factoryStore,
    };
    _setTestDeps({
      runner: () => runner,
      generator: () => generator,
      store: () => factory,
    });

    runner.planAgent.mockResolvedValue({ success: true, plan: SAMPLE_PLAN });
    generator.generateAgentFromDescription.mockResolvedValue({ id: 'x', name: 'X' });

    const result = await buildAgentWithClaudeCode('do something');
    expect(result.success).toBe(true);
    expect(factoryStore.createAgent).toHaveBeenCalled();

    // Restore direct-store dep for subsequent tests
    _setTestDeps({
      runner: () => runner,
      generator: () => generator,
      store: () => store,
    });
  });
});

describe('_preflightBudgetCheck', () => {
  beforeEach(() => {
    budget.checkBudget.mockReset().mockReturnValue({ blocked: false, warnings: [] });
  });

  it('returns { blocked: false } when budget-manager is missing', () => {
    _setTestDeps({
      runner: () => runner,
      generator: () => generator,
      store: () => store,
      budget: () => null,
    });
    const r = _preflightBudgetCheck();
    expect(r.blocked).toBe(false);
    // Restore
    _setTestDeps({
      runner: () => runner,
      generator: () => generator,
      store: () => store,
      budget: () => ({ getBudgetManager: () => budget }),
    });
  });

  it('returns { blocked: true, reason } when manager says blocked', () => {
    budget.checkBudget.mockReturnValue({
      blocked: true,
      warnings: [{ message: 'daily limit hit' }],
    });
    const r = _preflightBudgetCheck();
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe('daily limit hit');
  });

  it('never throws; returns blocked:false on unexpected errors', () => {
    budget.checkBudget.mockImplementation(() => {
      throw new Error('internal');
    });
    const r = _preflightBudgetCheck();
    expect(r.blocked).toBe(false);
  });
});

describe('_describeAgentFromPlan', () => {
  it('returns original request when plan is null/undefined', () => {
    expect(_describeAgentFromPlan('do X', null)).toBe('do X');
    expect(_describeAgentFromPlan('do X', undefined)).toBe('do X');
  });

  it('incorporates plan understanding, features, approach, name', () => {
    const description = _describeAgentFromPlan('do X', SAMPLE_PLAN);
    expect(description).toContain('do X');
    expect(description).toContain('User wants an agent that fetches stock prices');
    expect(description).toContain('fetch-price');
    expect(description).toContain('format-quote');
    expect(description).toContain('Use a free stock API');
    expect(description).toContain('Stock Quote Agent');
  });

  it('handles missing plan fields gracefully', () => {
    const description = _describeAgentFromPlan('do X', { understanding: 'just X' });
    expect(description).toContain('do X');
    expect(description).toContain('just X');
  });
});
