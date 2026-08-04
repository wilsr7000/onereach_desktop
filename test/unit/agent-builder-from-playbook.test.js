/**
 * Unit tests for the user-authored WISER playbook build path:
 *
 *   consent "playbook" -> WISER opens prefilled with the LOCAL AGENT
 *   TEMPLATE -> user refines/saves -> "build the agent from my playbook"
 *   -> builder finds it in Spaces and builds FROM it verbatim.
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
import {
  buildAgentWithClaudeCode,
  _setTestDeps,
} from '../../lib/claude-code-agent-builder.js';

const mockBuildAgent = vi.fn();
agentBuilder._setClaudeCodeBuilder(mockBuildAgent);
agentBuilder._setExchangeBus({ emit: vi.fn(), processSubmit: vi.fn(async () => ({})) });

const AUTHORED = `# Local Agent Playbook: Invoice Chaser

## Goal
Chase unpaid invoices politely.`;

function makeStorage(items) {
  return { index: { items } };
}

beforeEach(() => {
  mockBuildAgent.mockReset().mockResolvedValue({
    success: true,
    agent: { id: 'a1', name: 'Invoice Chaser' },
    elapsedMs: 2000,
    verified: { mode: 'live-tested', detail: 'ok' },
    playbook: { markdown: AUTHORED, title: 'Local Agent Playbook: Invoice Chaser', saved: true, authored: true },
  });
});

describe('"build the agent from my playbook" intent', () => {
  it('finds the newest playbook in Spaces and builds from its exact markdown', async () => {
    agentBuilder._setSpacesStorage(
      makeStorage([
        { type: 'text', content: '# Local Agent Playbook: Old One', metadata: { itemType: 'agent-playbook', title: 'Old One' }, timestamp: 100 },
        { type: 'text', content: AUTHORED, metadata: { itemType: 'agent-playbook', title: 'Invoice Chaser' }, timestamp: 200 },
        { type: 'text', content: 'random note', metadata: { title: 'note' }, timestamp: 300 },
      ])
    );

    const out = await agentBuilder.execute({ content: 'build the agent from my playbook' });

    expect(mockBuildAgent).toHaveBeenCalledTimes(1);
    const [request, opts] = mockBuildAgent.mock.calls[0];
    expect(request).toContain('Invoice Chaser');
    expect(opts.playbookMarkdown).toBe(AUTHORED); // verbatim spec
    expect(out.success).toBe(true);
    expect(out.message).toMatch(/Built from your playbook/);
    agentBuilder._setSpacesStorage(null);
  });

  it('honors a name filter', async () => {
    agentBuilder._setSpacesStorage(
      makeStorage([
        { type: 'text', content: '# Local Agent Playbook: Expense Bot', metadata: { itemType: 'agent-playbook', title: 'Expense Bot' }, timestamp: 300 },
        { type: 'text', content: AUTHORED, metadata: { itemType: 'agent-playbook', title: 'Invoice Chaser' }, timestamp: 100 },
      ])
    );

    await agentBuilder.execute({ content: 'build the agent from my playbook called "invoice chaser"' });
    const [, opts] = mockBuildAgent.mock.calls[0];
    expect(opts.playbookMarkdown).toBe(AUTHORED); // older but name-matched
    agentBuilder._setSpacesStorage(null);
  });

  it('says so honestly when no playbook exists', async () => {
    agentBuilder._setSpacesStorage(makeStorage([]));
    const out = await agentBuilder.execute({ content: 'build the agent from my playbook' });
    expect(mockBuildAgent).not.toHaveBeenCalled();
    expect(out.message).toMatch(/couldn't find a playbook/i);
    agentBuilder._setSpacesStorage(null);
  });
});

describe('consent "playbook" path opens WISER with the local-agent template', () => {
  it('_buildWithPlaybooks tells the user the comeback phrase', async () => {
    // No moduleManager in tests -> _openPlaybooks fails -> fallback message;
    // spy the prompt WISER would have received via _openPlaybooks.
    const openSpy = vi.spyOn(agentBuilder, '_openPlaybooks').mockResolvedValue(true);
    const out = await agentBuilder._buildWithPlaybooks({
      originalRequest: 'chase unpaid invoices',
      assessment: { effort: 'hard', reasoning: 'r', requiredIntegrations: [], missingAccess: [], estimatedCostPerUse: '$0.01' },
      buildMethod: 'playbook',
    });
    expect(openSpy).toHaveBeenCalledTimes(1);
    const prefill = openSpy.mock.calls[0][0];
    expect(prefill).toContain('# Local Agent Playbook');
    expect(prefill).toContain('chase unpaid invoices');
    expect(out.message).toMatch(/build the agent from my playbook/i);
    openSpy.mockRestore();
  });
});

describe('buildAgentWithClaudeCode with an authored playbook', () => {
  const runner = { planAgent: vi.fn() };
  const generator = { generateAgentFromDescription: vi.fn() };
  const store = { init: vi.fn(), createAgent: vi.fn(), updateAgent: vi.fn() };
  const playbookLib = {
    composeLocalAgentPlaybook: vi.fn(() => ({ markdown: '# composed', title: 't', agentName: 'a' })),
    saveAgentPlaybook: vi.fn(() => ({ saved: true, ref: null })),
  };
  const wrapper = { wrapConfigAgent: vi.fn(() => null) };

  beforeEach(() => {
    runner.planAgent.mockReset().mockResolvedValue({ success: false });
    generator.generateAgentFromDescription.mockReset().mockResolvedValue({ executionType: 'llm', prompt: 'p' });
    store.createAgent.mockReset().mockResolvedValue({
      id: 'n1',
      name: 'Invoice Chaser',
      execute: async () => ({ success: true, message: 'ok' }),
    });
    playbookLib.composeLocalAgentPlaybook.mockClear();
    _setTestDeps({
      runner: () => runner,
      generator: () => generator,
      store: () => store,
      wrapper: () => wrapper,
      playbook: () => playbookLib,
      budget: () => null,
    });
  });

  it('uses the authored markdown verbatim: no compose, no re-save, authored flag set', async () => {
    const result = await buildAgentWithClaudeCode('build from playbook', {
      playbookMarkdown: AUTHORED,
      skipPlanning: true,
    });

    expect(result.success).toBe(true);
    expect(result.playbook.authored).toBe(true);
    expect(result.playbook.title).toBe('Local Agent Playbook: Invoice Chaser');
    expect(playbookLib.composeLocalAgentPlaybook).not.toHaveBeenCalled();
    expect(playbookLib.saveAgentPlaybook).not.toHaveBeenCalled();

    // Generator builds FROM the authored spec; config carries it.
    const genSpec = generator.generateAgentFromDescription.mock.calls[0][0];
    expect(genSpec).toContain('Chase unpaid invoices politely.');
    const savedConfig = store.createAgent.mock.calls[0][0];
    expect(savedConfig.playbook.markdown).toBe(AUTHORED);
  });
});
