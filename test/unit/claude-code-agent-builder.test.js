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
  updateAgent: vi.fn(),
};
const budget = {
  checkBudget: vi.fn().mockReturnValue({ blocked: false, warnings: [] }),
};
// Fake dynamic-agent wrapper mirroring the real wrapConfigAgent contract:
// llm/chat configs with a prompt get an executable wrap; everything else null.
// The wrap's execute() behavior is overridable per test via wrapExecute.
let wrapExecute = async () => ({ success: true, message: 'wrapped ok' });
const wrapper = {
  wrapConfigAgent: vi.fn((cfg) => {
    const et = String(cfg.executionType || 'llm').toLowerCase();
    if (!['llm', 'chat'].includes(et)) return null;
    if (!(cfg.prompt || cfg.systemPrompt || cfg.description)) return null;
    return { ...cfg, execute: (task) => wrapExecute(task) };
  }),
};

_setTestDeps({
  runner: () => runner,
  generator: () => generator,
  store: () => store,
  budget: () => ({ getBudgetManager: () => budget }),
  wrapper: () => wrapper,
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
    store.updateAgent.mockReset();
    budget.checkBudget.mockReset().mockReturnValue({ blocked: false, warnings: [] });
    wrapExecute = async () => ({ success: true, message: 'wrapped ok' });
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
      executionType: 'llm',
      prompt: 'You fetch stock prices.',
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
    generator.generateAgentFromDescription.mockResolvedValue({ executionType: 'llm', prompt: 'test prompt', id: 'x', name: 'X' });
    store.createAgent.mockResolvedValue(SAMPLE_AGENT);

    const result = await buildAgentWithClaudeCode('do something');

    expect(result.success).toBe(true);
    expect(result.plan).toBeNull();
    expect(generator.generateAgentFromDescription).toHaveBeenCalled();
  });

  it('continues when planAgent returns success: false', async () => {
    runner.planAgent.mockResolvedValue({ success: false, error: 'CLI error' });
    generator.generateAgentFromDescription.mockResolvedValue({ executionType: 'llm', prompt: 'test prompt', id: 'x', name: 'X' });
    store.createAgent.mockResolvedValue(SAMPLE_AGENT);

    const result = await buildAgentWithClaudeCode('do something');
    expect(result.success).toBe(true);
    expect(result.plan).toBeNull();
  });

  it('skips planning when skipPlanning: true', async () => {
    generator.generateAgentFromDescription.mockResolvedValue({ executionType: 'llm', prompt: 'test prompt', id: 'x', name: 'X' });
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
    generator.generateAgentFromDescription.mockResolvedValue({ executionType: 'llm', prompt: 'test prompt', id: 'x', name: 'X' });
    store.createAgent.mockRejectedValue(new Error('disk full'));

    const result = await buildAgentWithClaudeCode('do something');
    expect(result.success).toBe(false);
    expect(result.stage).toBe('save');
    expect(result.error).toMatch(/disk full/);
  });

  it('emits progress events at each stage on the happy path', async () => {
    runner.planAgent.mockResolvedValue({ success: true, plan: SAMPLE_PLAN });
    generator.generateAgentFromDescription.mockResolvedValue({ executionType: 'llm', prompt: 'test prompt', id: 'x', name: 'X' });
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
    generator.generateAgentFromDescription.mockResolvedValue({ executionType: 'llm', prompt: 'test prompt', id: 'x', name: 'X' });
    store.createAgent.mockResolvedValue(SAMPLE_AGENT);

    const result = await buildAgentWithClaudeCode('do X', { skipBudgetCheck: true });
    expect(result.success).toBe(true);
  });

  it('never crashes if a progress callback throws', async () => {
    runner.planAgent.mockResolvedValue({ success: true, plan: SAMPLE_PLAN });
    generator.generateAgentFromDescription.mockResolvedValue({ executionType: 'llm', prompt: 'test prompt', id: 'x', name: 'X' });
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
      wrapper: () => wrapper,
    });

    runner.planAgent.mockResolvedValue({ success: true, plan: SAMPLE_PLAN });
    generator.generateAgentFromDescription.mockResolvedValue({ executionType: 'llm', prompt: 'test prompt', id: 'x', name: 'X' });

    const result = await buildAgentWithClaudeCode('do something');
    expect(result.success).toBe(true);
    expect(factoryStore.createAgent).toHaveBeenCalled();

    // Restore direct-store dep for subsequent tests
    _setTestDeps({
      runner: () => runner,
      generator: () => generator,
      store: () => store,
      wrapper: () => wrapper,
    });
  });

  it('updates the existing agent in place when updateAgentId is set (rebuild/feature-add)', async () => {
    runner.planAgent.mockResolvedValue({ success: true, plan: SAMPLE_PLAN });
    const config = { executionType: 'llm', prompt: 'You set alarms.', name: 'Alarm Manager' };
    generator.generateAgentFromDescription.mockResolvedValue(config);
    store.updateAgent.mockResolvedValue({ id: 'agent-123', name: 'Alarm Manager', version: 2 });

    const result = await buildAgentWithClaudeCode('Rebuild the existing agent "Alarm Manager"', {
      updateAgentId: 'agent-123',
    });

    expect(result.success).toBe(true);
    expect(store.updateAgent).toHaveBeenCalledTimes(1);
    expect(store.createAgent).not.toHaveBeenCalled();
    const [idArg, configArg] = store.updateAgent.mock.calls[0];
    expect(idArg).toBe('agent-123');
    expect(configArg).toEqual(config);
    expect(result.agent.id).toBe('agent-123');
  });

  it('fails cleanly when updateAgentId is set but the store cannot update', async () => {
    runner.planAgent.mockResolvedValue({ success: true, plan: SAMPLE_PLAN });
    generator.generateAgentFromDescription.mockResolvedValue({ executionType: 'llm', prompt: 'p' });
    const noUpdateStore = { init: vi.fn(), createAgent: vi.fn() };
    _setTestDeps({
      runner: () => runner,
      generator: () => generator,
      store: () => noUpdateStore,
      wrapper: () => wrapper,
    });

    const result = await buildAgentWithClaudeCode('rebuild it', { updateAgentId: 'agent-123' });
    expect(result.success).toBe(false);
    expect(result.stage).toBe('save');
    expect(noUpdateStore.createAgent).not.toHaveBeenCalled();

    _setTestDeps({
      runner: () => runner,
      generator: () => generator,
      store: () => store,
      budget: () => ({ getBudgetManager: () => budget }),
      wrapper: () => wrapper,
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
      wrapper: () => wrapper,
    });
    const r = _preflightBudgetCheck();
    expect(r.blocked).toBe(false);
    // Restore
    _setTestDeps({
      runner: () => runner,
      generator: () => generator,
      store: () => store,
      budget: () => ({ getBudgetManager: () => budget }),
      wrapper: () => wrapper,
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

// ─── Post-build verification (stage 4: test before announcing) ─────────────
// Regression for the 2026-08 live E2E: the builder said "Done. I built Alarm
// Manager" while the artifact failed contract validation at creation. A build
// is only a success if it was live-tested or is a valid config that the
// dynamic runtime can serve after restart.
describe('buildAgentWithClaudeCode -- post-build verification', () => {
  beforeEach(() => {
    runner.planAgent.mockResolvedValue({ success: true, plan: SAMPLE_PLAN });
    wrapper.wrapConfigAgent.mockClear();
    wrapExecute = async () => ({ success: true, message: 'wrapped ok' });
  });

  it('live-tests an agent that has execute() and reports live-tested', async () => {
    generator.generateAgentFromDescription.mockResolvedValue({ executionType: 'llm', prompt: 'p' });
    store.createAgent.mockResolvedValue({
      id: 'a1', name: 'A1',
      execute: async () => ({ success: true, message: 'alarm set' }),
    });
    const result = await buildAgentWithClaudeCode('set an alarm');
    expect(result.success).toBe(true);
    expect(result.verified.mode).toBe('live-tested');
  });

  it('marks a valid config without an executor as config-pending-restart (still success, honest message upstream)', async () => {
    generator.generateAgentFromDescription.mockResolvedValue({ executionType: 'applescript', code: 'display notification' });
    store.createAgent.mockResolvedValue({ id: 'a2', name: 'A2' });
    const result = await buildAgentWithClaudeCode('set an alarm');
    expect(result.success).toBe(true);
    expect(result.verified.mode).toBe('config-pending-restart');
  });

  it('FAILS the build when the artifact can neither execute nor be served (the broken Alarm Manager case)', async () => {
    generator.generateAgentFromDescription.mockResolvedValue({ name: 'no exec, no config' });
    store.createAgent.mockResolvedValue({ id: 'a3', name: 'A3' });
    const result = await buildAgentWithClaudeCode('set an alarm');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/failed verification/i);
  });

  it('FAILS the build when the live self-test fails', async () => {
    generator.generateAgentFromDescription.mockResolvedValue({ executionType: 'llm', prompt: 'p' });
    store.createAgent.mockResolvedValue({
      id: 'a4', name: 'A4',
      execute: async () => ({ success: false, error: 'cannot actually set alarms' }),
    });
    const result = await buildAgentWithClaudeCode('set an alarm');
    expect(result.success).toBe(false);
    expect(result.verified.mode).toBe('failed');
  });

  // ── Hot-wrap: a config-only LLM artifact is live-tested NOW instead of
  //    settling for config-pending-restart (self-heal loop step 4) ─────────
  it('hot-wraps a config-only LLM artifact and reports live-tested when the wrapped test passes', async () => {
    generator.generateAgentFromDescription.mockResolvedValue({ executionType: 'llm', prompt: 'You joke.' });
    store.createAgent.mockResolvedValue({ id: 'a5', name: 'A5' }); // no execute()
    const result = await buildAgentWithClaudeCode('tell me a joke');
    expect(result.success).toBe(true);
    expect(result.verified.mode).toBe('live-tested');
    expect(wrapper.wrapConfigAgent).toHaveBeenCalled();
    // The wrap receives the persisted identity, not just the raw config
    const wrappedCfg = wrapper.wrapConfigAgent.mock.calls.at(-1)[0];
    expect(wrappedCfg.id).toBe('a5');
  });

  it('FAILS the build when the hot-wrapped self-test returns failure', async () => {
    generator.generateAgentFromDescription.mockResolvedValue({ executionType: 'llm', prompt: 'You joke.' });
    store.createAgent.mockResolvedValue({ id: 'a6', name: 'A6' });
    wrapExecute = async () => ({ success: false, error: 'LLM refused' });
    const result = await buildAgentWithClaudeCode('tell me a joke');
    expect(result.success).toBe(false);
    expect(result.verified.mode).toBe('failed');
  });

  it('falls back to config-pending-restart when the hot-wrapped self-test THROWS (transient, config still servable)', async () => {
    generator.generateAgentFromDescription.mockResolvedValue({ executionType: 'llm', prompt: 'You joke.' });
    store.createAgent.mockResolvedValue({ id: 'a7', name: 'A7' });
    wrapExecute = async () => {
      throw new Error('network blip');
    };
    const result = await buildAgentWithClaudeCode('tell me a joke');
    expect(result.success).toBe(true);
    expect(result.verified.mode).toBe('config-pending-restart');
  });
});
