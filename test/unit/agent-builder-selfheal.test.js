/**
 * Unit tests for agent-builder-agent's self-heal (rebuild) and feature-add
 * (modify) flows.
 *
 * Verifies behaviorally (via the injected builder/store/bus seams):
 *  1. "yes" on a rebuild consent updates the EXISTING agent in place
 *     (updateAgentId) and reports the verified outcome honestly.
 *  2. "add X to my <agent>" resolves the stored agent and proposes a
 *     modify-consent carrying its current definition.
 *  3. Rebuild/modify never auto-resubmit their maintenance instruction to
 *     the exchange (no builder->builder loop).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../lib/ai-service', () => ({
  json: vi.fn(),
  complete: vi.fn(),
  chat: vi.fn(),
}));

import agentBuilder from '../../packages/agents/agent-builder-agent';
import { buildRebuildPendingBuild } from '../../lib/exchange/self-heal.js';

const mockBuildAgent = vi.fn();
agentBuilder._setClaudeCodeBuilder(mockBuildAgent);

const submitCalls = [];
const mockExchangeBus = {
  emit: vi.fn(),
  processSubmit: vi.fn((text, options) => {
    submitCalls.push({ text, options });
    return Promise.resolve({ taskId: 'retry-1', queued: true });
  }),
};
agentBuilder._setExchangeBus(mockExchangeBus);

const WEATHER_DEF = {
  id: 'w1',
  name: 'Weather Buddy',
  description: 'Tells the weather',
  prompt: 'You report weather conditions.',
  keywords: ['weather', 'forecast'],
  executionType: 'llm',
  enabled: true,
};

const ALARM_DEF = {
  id: 'agent-123',
  name: 'Alarm Manager',
  description: 'Sets alarms',
  prompt: 'You manage alarms.',
  keywords: ['alarm'],
  executionType: 'llm',
  enabled: true,
};

const mockStore = {
  getLocalAgents: vi.fn(() => [WEATHER_DEF, ALARM_DEF]),
  getAgent: vi.fn((id) => [WEATHER_DEF, ALARM_DEF].find((a) => a.id === id) || null),
};
agentBuilder._setAgentStore(mockStore);

beforeEach(() => {
  mockBuildAgent.mockReset();
  mockExchangeBus.emit.mockClear();
  mockExchangeBus.processSubmit.mockClear();
  submitCalls.length = 0;
  mockStore.getLocalAgents.mockClear();
});

// ─── Rebuild consent (self-heal loop step 2) ────────────────────────────────

describe('rebuild consent -> update-in-place build', () => {
  function rebuildTask(content = 'yes') {
    return {
      content,
      context: { pendingBuild: buildRebuildPendingBuild(ALARM_DEF, 'agent:contract-violation') },
    };
  }

  it('passes updateAgentId so the broken agent is rebuilt in place, not duplicated', async () => {
    mockBuildAgent.mockResolvedValue({
      success: true,
      agent: { id: 'agent-123', name: 'Alarm Manager' },
      elapsedMs: 3000,
      verified: { mode: 'live-tested', detail: 'ok' },
    });

    const result = await agentBuilder.execute(rebuildTask());

    expect(result.success).toBe(true);
    expect(mockBuildAgent).toHaveBeenCalledTimes(1);
    const [request, opts] = mockBuildAgent.mock.calls[0];
    expect(request).toContain('Alarm Manager');
    expect(request).toContain(ALARM_DEF.prompt);
    expect(opts.updateAgentId).toBe('agent-123');
  });

  it('reports a live-tested rebuild as rebuilt-and-tested', async () => {
    mockBuildAgent.mockResolvedValue({
      success: true,
      agent: { id: 'agent-123', name: 'Alarm Manager' },
      elapsedMs: 3000,
      verified: { mode: 'live-tested', detail: 'ok' },
    });

    const result = await agentBuilder.execute(rebuildTask());
    expect(result.message).toMatch(/rebuilt/i);
    expect(result.message).toMatch(/tested/i);
    // No pending follow-up question -- the loop is closed.
    expect(result.needsInput).toBeUndefined();
  });

  it('reports config-pending-restart honestly (comes online after restart)', async () => {
    mockBuildAgent.mockResolvedValue({
      success: true,
      agent: { id: 'agent-123', name: 'Alarm Manager' },
      elapsedMs: 2000,
      verified: { mode: 'config-pending-restart', detail: 'executionType=llm' },
    });

    const result = await agentBuilder.execute(rebuildTask());
    expect(result.message).toMatch(/rebuilt/i);
    expect(result.message).toMatch(/restart/i);
  });

  it('never auto-resubmits the rebuild instruction to the exchange', async () => {
    mockBuildAgent.mockResolvedValue({
      success: true,
      agent: { id: 'agent-123', name: 'Alarm Manager' },
      elapsedMs: 3000,
      verified: { mode: 'live-tested', detail: 'ok' },
    });

    await agentBuilder.execute(rebuildTask());
    expect(mockExchangeBus.processSubmit).not.toHaveBeenCalled();
  });

  it('falls back to the Playbooks offer when the rebuild fails', async () => {
    mockBuildAgent.mockResolvedValue({
      success: false,
      agent: null,
      error: 'generation exploded',
      stage: 'generate',
      elapsedMs: 500,
    });

    const result = await agentBuilder.execute(rebuildTask());
    expect(result.needsInput).toBeDefined();
    expect(result.needsInput.context.pendingBuild.buildMethod).toBe('playbook');
  });

  it('declines politely on "no"', async () => {
    const result = await agentBuilder.execute(rebuildTask('no thanks'));
    expect(result.success).toBe(true);
    expect(mockBuildAgent).not.toHaveBeenCalled();
  });
});

// ─── Feature-add flow (step 3) ───────────────────────────────────────────────

describe('_findModifyTarget', () => {
  it('resolves a stored agent named with a change verb', () => {
    const target = agentBuilder._findModifyTarget('add sunrise times to my Weather Buddy agent');
    expect(target).not.toBeNull();
    expect(target.def.id).toBe('w1');
    expect(target.isRepair).toBe(false);
  });

  it('flags repair verbs as a rebuild', () => {
    const target = agentBuilder._findModifyTarget('fix my alarm manager, it stopped working');
    expect(target).not.toBeNull();
    expect(target.def.id).toBe('agent-123');
    expect(target.isRepair).toBe(true);
  });

  it('returns null without a change verb (asking the agent to do its job)', () => {
    expect(agentBuilder._findModifyTarget('what does weather buddy say about tomorrow')).toBeNull();
  });

  it('returns null when no stored agent is named', () => {
    expect(agentBuilder._findModifyTarget('add a countdown timer feature')).toBeNull();
  });

  it('prefers the longest matching agent name', () => {
    mockStore.getLocalAgents.mockReturnValue([
      { ...WEATHER_DEF, id: 'short', name: 'Weather' },
      { ...WEATHER_DEF, id: 'long', name: 'Weather Buddy' },
    ]);
    const target = agentBuilder._findModifyTarget('improve my weather buddy responses');
    expect(target.def.id).toBe('long');
    mockStore.getLocalAgents.mockReturnValue([WEATHER_DEF, ALARM_DEF]);
  });

  it('survives a missing agent store', () => {
    agentBuilder._setAgentStore({ getLocalAgents: null });
    expect(agentBuilder._findModifyTarget('add jokes to my weather buddy')).toBeNull();
    agentBuilder._setAgentStore(mockStore);
  });
});

describe('feature-add proposal and confirmation', () => {
  it('execute() routes an add-feature utterance to a modify consent with the stored config', async () => {
    const result = await agentBuilder.execute({
      content: 'add sunrise times to my Weather Buddy agent',
    });

    expect(result.success).toBe(true);
    expect(result.needsInput).toBeDefined();
    const pb = result.needsInput.context.pendingBuild;
    expect(pb.buildMethod).toBe('claude-code');
    expect(pb.modify).toEqual({ agentId: 'w1', agentName: 'Weather Buddy', isRepair: false });
    // The build spec carries the CURRENT definition so behavior is preserved
    expect(pb.originalRequest).toContain(WEATHER_DEF.prompt);
    expect(pb.originalRequest).toContain('add sunrise times');
    // No build happens before consent
    expect(mockBuildAgent).not.toHaveBeenCalled();
  });

  it('confirmation of a modify consent updates the existing agent in place', async () => {
    const proposal = await agentBuilder.execute({
      content: 'add sunrise times to my Weather Buddy agent',
    });
    mockBuildAgent.mockResolvedValue({
      success: true,
      agent: { id: 'w1', name: 'Weather Buddy' },
      elapsedMs: 4000,
      verified: { mode: 'live-tested', detail: 'ok' },
    });

    const result = await agentBuilder.execute({
      content: 'yes do it',
      context: proposal.needsInput.context,
    });

    expect(result.success).toBe(true);
    const [, opts] = mockBuildAgent.mock.calls[0];
    expect(opts.updateAgentId).toBe('w1');
    expect(result.message).toMatch(/updated/i);
    expect(mockExchangeBus.processSubmit).not.toHaveBeenCalled();
  });

  it('fresh builds (no rebuild/modify tag) still auto-retry the original request', async () => {
    mockBuildAgent.mockResolvedValue({
      success: true,
      agent: { id: 'n1', name: 'Joke Agent' },
      elapsedMs: 3000,
      verified: { mode: 'live-tested', detail: 'ok' },
    });

    const result = await agentBuilder.execute({
      content: 'yes',
      context: {
        pendingBuild: {
          originalRequest: 'tell me a dad joke every morning',
          assessment: { effort: 'easy' },
          buildMethod: 'claude-code',
        },
      },
    });

    expect(result.success).toBe(true);
    const [, opts] = mockBuildAgent.mock.calls[0];
    expect(opts.updateAgentId).toBeUndefined();
    expect(mockExchangeBus.processSubmit).toHaveBeenCalledTimes(1);
    expect(submitCalls[0].text).toBe('tell me a dad joke every morning');
  });
});

// ─── Bid surface: the builder must be discoverable for these intents ────────

describe('bid surface for self-heal and feature-add', () => {
  it('keywords cover feature-add and repair intents', () => {
    const kw = agentBuilder.keywords;
    expect(kw).toContain('add a feature');
    expect(kw).toContain('update my agent');
    expect(kw).toContain('fix my agent');
    expect(kw).toContain('rebuild agent');
  });

  it('the bidding prompt names agent modification as a HIGH-confidence case', () => {
    expect(agentBuilder.prompt).toMatch(/add a feature|CHANGE one of their custom agents/i);
    expect(agentBuilder.prompt).toMatch(/fix or rebuild/i);
  });
});
