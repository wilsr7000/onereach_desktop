/**
 * Meta-task handlers — the meta-agents behind classify-intent /
 * evaluate-buildability / evaluate-response (ADR-EX-007). Tested with injected
 * fakes, no exchange-bridge, no LLM.
 *
 * Run: npx vitest run test/unit/meta-handlers.test.js
 */

import { describe, it, expect, vi } from 'vitest';

const {
  makeClassifyIntentHandler,
  makeEvaluateBuildabilityHandler,
  makeEvaluateResponseHandler,
} = require('../../lib/exchange/meta-handlers');

describe('classify-intent handler', () => {
  it('returns the model classification + gap summary', async () => {
    const ai = { json: vi.fn(async () => ({ classification: 'rephrase', gapSummary: 'ambiguous time' })) };
    const h = makeClassifyIntentHandler({ ai });
    const out = await h({ content: 'do the thing', agentDescriptions: [{ name: 'time-agent', description: 'clock' }] });
    expect(out).toEqual({ classification: 'rephrase', gapSummary: 'ambiguous time' });
  });

  it('defaults to capability_gap + the raw content when the model omits fields', async () => {
    const ai = { json: vi.fn(async () => ({})) };
    const h = makeClassifyIntentHandler({ ai });
    const out = await h({ content: 'control my toaster' });
    expect(out).toEqual({ classification: 'capability_gap', gapSummary: 'control my toaster' });
  });

  it('includes near-miss bids in the prompt when present', async () => {
    const ai = { json: vi.fn(async () => ({ classification: 'rephrase', gapSummary: 'x' })) };
    const h = makeClassifyIntentHandler({ ai });
    await h({ content: 'x', nearMisses: [{ agentId: 'calendar-query-agent', confidence: 0.42 }] });
    const prompt = ai.json.mock.calls[0][0];
    expect(prompt).toMatch(/calendar-query-agent \(0\.42\)/);
  });
});

describe('evaluate-buildability handler', () => {
  it('runs the builder agent with capability-gap context', async () => {
    const execute = vi.fn(async () => ({ success: true, message: 'I can build that', needsInput: { agentId: 'agent-builder-agent', prompt: 'Build it?' } }));
    const h = makeEvaluateBuildabilityHandler({ getBuilderAgent: () => ({ execute }) });
    const out = await h({ content: 'daily standup reminder', gapSummary: 'no standup agent' });
    expect(out.message).toBe('I can build that');
    expect(execute).toHaveBeenCalledWith({
      content: 'daily standup reminder',
      metadata: { capabilityGap: 'no standup agent', originalRequest: 'daily standup reminder', source: 'exchange-halt' },
    });
  });

  it('calls initialize() when the builder exposes it', async () => {
    const initialize = vi.fn(async () => {});
    const h = makeEvaluateBuildabilityHandler({ getBuilderAgent: () => ({ initialize, execute: async () => ({ success: true }) }) });
    await h({ content: 'x', gapSummary: 'y' });
    expect(initialize).toHaveBeenCalled();
  });

  it('throws when the builder is unavailable (bridge falls back to inline)', async () => {
    const h = makeEvaluateBuildabilityHandler({ getBuilderAgent: () => null });
    await expect(h({ content: 'x', gapSummary: 'y' })).rejects.toThrow(/unavailable/);
  });

  it('rejects on builder timeout', async () => {
    const h = makeEvaluateBuildabilityHandler({
      getBuilderAgent: () => ({ execute: () => new Promise(() => {}) }), // never resolves
      timeoutMs: 5,
    });
    await expect(h({ content: 'x', gapSummary: 'y' })).rejects.toThrow(/timeout/);
  });
});

describe('evaluate-response handler', () => {
  it('surfaces a sanity issue', async () => {
    const h = makeEvaluateResponseHandler({ checkResponseSanity: () => 'wrong day-of-week' });
    expect(await h({ message: 'Today is Blursday' })).toEqual({ issue: 'wrong day-of-week' });
  });

  it('returns null issue for a clean response', async () => {
    const h = makeEvaluateResponseHandler({ checkResponseSanity: () => null });
    expect(await h({ message: 'It is 3 PM' })).toEqual({ issue: null });
  });
});
