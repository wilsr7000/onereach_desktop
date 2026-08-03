/**
 * Unit tests for packages/agents/dynamic-agent.js wrapConfigAgent.
 *
 * wrapConfigAgent turns a config-only stored agent definition into an
 * executable agent using the app-LLM executor, so freshly built agents can
 * be live-tested and hot-connected immediately. The executor is injected via
 * the opts.executeLLM seam (vitest CJS module mocks don't reliably intercept
 * this module's requires).
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../lib/ai-service', () => ({
  chat: vi.fn(),
  json: vi.fn(),
  complete: vi.fn(),
}));

import { wrapConfigAgent, executeWithAppLLM } from '../../packages/agents/dynamic-agent';

const LLM_DEF = {
  id: 'w1',
  name: 'Weather Buddy',
  description: 'Tells the weather',
  prompt: 'You report weather conditions.',
  executionType: 'llm',
};

describe('wrapConfigAgent', () => {
  it('wraps an llm config into an executable agent that routes through the injected executor', async () => {
    const executeLLM = vi.fn(async () => ({ success: true, result: 'sunny' }));
    const wrapped = wrapConfigAgent(LLM_DEF, { executeLLM });

    expect(wrapped).not.toBeNull();
    expect(typeof wrapped.execute).toBe('function');
    // Definition fields carry over so bidding/registration metadata survives
    expect(wrapped.id).toBe('w1');
    expect(wrapped.name).toBe('Weather Buddy');

    const out = await wrapped.execute({ content: 'weather tomorrow?' });
    expect(out).toEqual({ success: true, result: 'sunny' });
    expect(executeLLM).toHaveBeenCalledTimes(1);
    const [prompt, systemPrompt, task] = executeLLM.mock.calls[0];
    expect(prompt).toBe('weather tomorrow?');
    expect(systemPrompt).toBe(LLM_DEF.prompt);
    expect(task.content).toBe('weather tomorrow?');
  });

  it('wraps chat configs and defaults a missing executionType to llm', async () => {
    const executeLLM = vi.fn(async () => ({ success: true, result: 'ok' }));
    expect(wrapConfigAgent({ ...LLM_DEF, executionType: 'chat' }, { executeLLM })).not.toBeNull();
    expect(wrapConfigAgent({ ...LLM_DEF, executionType: undefined }, { executeLLM })).not.toBeNull();
  });

  it('prefers systemPrompt over prompt, and falls back to a name/description prompt', async () => {
    const executeLLM = vi.fn(async () => ({ success: true }));

    const withSystem = wrapConfigAgent({ ...LLM_DEF, systemPrompt: 'SYSTEM WINS' }, { executeLLM });
    await withSystem.execute({ content: 'x' });
    expect(executeLLM.mock.calls[0][1]).toBe('SYSTEM WINS');

    const descOnly = wrapConfigAgent(
      { id: 'd1', name: 'Desc Agent', description: 'does things', executionType: 'llm' },
      { executeLLM }
    );
    await descOnly.execute({ content: 'x' });
    const sys = executeLLM.mock.calls[1][1];
    expect(sys).toContain('Desc Agent');
    expect(sys).toContain('does things');
  });

  it('refuses non-LLM execution types (applescript/shell/script/api)', () => {
    for (const executionType of ['applescript', 'shell', 'script', 'api']) {
      expect(wrapConfigAgent({ ...LLM_DEF, executionType })).toBeNull();
    }
  });

  it('refuses configs with nothing to serve from (no prompt/systemPrompt/description)', () => {
    expect(wrapConfigAgent({ id: 'x', name: 'X', executionType: 'llm' })).toBeNull();
    expect(wrapConfigAgent({ id: 'x', name: 'X', executionType: 'llm', prompt: '   ' })).toBeNull();
    expect(wrapConfigAgent(null)).toBeNull();
    expect(wrapConfigAgent('not an object')).toBeNull();
  });

  it('returns an already-executable agent unchanged', () => {
    const execute = async () => ({ success: true });
    const def = { ...LLM_DEF, execute };
    expect(wrapConfigAgent(def)).toBe(def);
  });

  it('handles a missing task argument without throwing', async () => {
    const executeLLM = vi.fn(async (prompt) => ({ success: true, result: prompt }));
    const wrapped = wrapConfigAgent(LLM_DEF, { executeLLM });
    const out = await wrapped.execute();
    expect(out.success).toBe(true);
    expect(executeLLM.mock.calls[0][0]).toBe('');
  });

  it('exports executeWithAppLLM at module scope as the default executor', () => {
    expect(typeof executeWithAppLLM).toBe('function');
  });
});
