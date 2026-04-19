/**
 * Council Adapter -- Unit Tests
 *
 * Verifies the translation from unified-bidder bids into the evaluation
 * shape expected by lib/evaluation/consolidator.js.
 */

import { describe, it, expect } from 'vitest';

const {
  bidToEvaluation,
  bidsToEvaluations,
  buildConsolidateContext,
  _deriveAgentType,
  _inferDocumentType,
} = require('../../lib/exchange/council-adapter');

describe('bidToEvaluation -- required shape', () => {
  it('throws on non-object input', () => {
    expect(() => bidToEvaluation(null)).toThrow(/must be an object/);
    expect(() => bidToEvaluation('hi')).toThrow(/must be an object/);
  });

  it('maps confidence to 0-100 overallScore', () => {
    expect(bidToEvaluation({ agentId: 'a', confidence: 0.85 }).overallScore).toBe(85);
    expect(bidToEvaluation({ agentId: 'a', confidence: 0.01 }).overallScore).toBe(1);
    expect(bidToEvaluation({ agentId: 'a', confidence: 1 }).overallScore).toBe(100);
  });

  it('clamps confidence to [0,1]', () => {
    expect(bidToEvaluation({ agentId: 'a', confidence: 1.5 }).overallScore).toBe(100);
    expect(bidToEvaluation({ agentId: 'a', confidence: -0.5 }).overallScore).toBe(0);
  });

  it('preserves agentId and derives agentType from it', () => {
    const evaluation = bidToEvaluation({ agentId: 'calendar-query-agent', confidence: 0.8 });
    expect(evaluation.agentId).toBe('calendar-query-agent');
    expect(evaluation.agentType).toBe('calendar-query');
  });

  it('respects explicit agentType override', () => {
    const evaluation = bidToEvaluation(
      { agentId: 'x-agent', confidence: 0.5 },
      { agentType: 'expert' }
    );
    expect(evaluation.agentType).toBe('expert');
  });

  it('defaults agentId to unknown when missing', () => {
    const evaluation = bidToEvaluation({ confidence: 0.5 });
    expect(evaluation.agentId).toBe('unknown');
  });
});

describe('bidToEvaluation -- criteria expansion', () => {
  it('expands task criteria into per-criterion scores using overallScore', () => {
    const evaluation = bidToEvaluation(
      { agentId: 'a', confidence: 0.72 },
      {
        criteria: [
          { id: 'clarity', label: 'Clarity', weight: 0.4 },
          { id: 'risk', label: 'Risk' },
        ],
      }
    );
    expect(evaluation.criteria).toHaveLength(2);
    expect(evaluation.criteria[0]).toMatchObject({ name: 'clarity', score: 72, weight: 0.4 });
    // default weight=1 when not provided
    expect(evaluation.criteria[1]).toMatchObject({ name: 'risk', score: 72, weight: 1 });
  });

  it('skips criteria entries without id', () => {
    const evaluation = bidToEvaluation(
      { agentId: 'a', confidence: 0.5 },
      { criteria: [{ id: 'clarity' }, { id: '' }, null, undefined] }
    );
    expect(evaluation.criteria).toHaveLength(1);
    expect(evaluation.criteria[0].name).toBe('clarity');
  });

  it('has empty criteria array when task defines none', () => {
    const evaluation = bidToEvaluation({ agentId: 'a', confidence: 0.8 });
    expect(evaluation.criteria).toEqual([]);
  });
});

describe('bidToEvaluation -- strengths/concerns heuristic', () => {
  it('high-confidence reasoning becomes a strength', () => {
    const evaluation = bidToEvaluation({
      agentId: 'a',
      confidence: 0.9,
      reasoning: 'Domain is a perfect match.',
    });
    expect(evaluation.strengths).toEqual(['Domain is a perfect match.']);
    expect(evaluation.concerns).toEqual([]);
  });

  it('low-confidence reasoning becomes a concern', () => {
    const evaluation = bidToEvaluation({
      agentId: 'a',
      confidence: 0.2,
      reasoning: 'Not the right agent for this.',
    });
    expect(evaluation.concerns).toEqual(['Not the right agent for this.']);
    expect(evaluation.strengths).toEqual([]);
  });

  it('mid-range reasoning goes in neither', () => {
    const evaluation = bidToEvaluation({
      agentId: 'a',
      confidence: 0.55,
      reasoning: 'Could handle it.',
    });
    expect(evaluation.strengths).toEqual([]);
    expect(evaluation.concerns).toEqual([]);
  });

  it('hallucinationRisk=high adds a concern', () => {
    const evaluation = bidToEvaluation({
      agentId: 'a',
      confidence: 0.85,
      reasoning: 'Clear match.',
      hallucinationRisk: 'high',
    });
    expect(evaluation.strengths).toContain('Clear match.');
    expect(evaluation.concerns.some((c) => /hallucination/i.test(c))).toBe(true);
  });
});

describe('bidToEvaluation -- suggestions', () => {
  it('emits a plan suggestion when the bid carries one', () => {
    const evaluation = bidToEvaluation({
      agentId: 'a',
      confidence: 0.8,
      plan: 'Fetch events for next 7 days.',
    });
    expect(evaluation.suggestions.some((s) => s.type === 'plan' && /7 days/.test(s.text))).toBe(true);
  });

  it('emits an execution-result suggestion when execute() ran', () => {
    const evaluation = bidToEvaluation(
      { agentId: 'a', confidence: 0.8 },
      { executionResult: { message: 'You have 3 meetings tomorrow.', data: { count: 3 } } }
    );
    const exec = evaluation.suggestions.find((s) => s.type === 'execution-result');
    expect(exec).toBeTruthy();
    expect(exec.text).toContain('3 meetings');
    expect(exec.data).toEqual({ count: 3 });
  });

  it('no suggestions when neither plan nor execution result', () => {
    const evaluation = bidToEvaluation({ agentId: 'a', confidence: 0.8 });
    expect(evaluation.suggestions).toEqual([]);
  });
});

describe('bidToEvaluation -- _bid passthrough', () => {
  it('preserves the original bid on the _bid field', () => {
    const evaluation = bidToEvaluation({
      agentId: 'a',
      confidence: 0.66,
      reasoning: 'maybe',
      plan: 'try X',
      hallucinationRisk: 'low',
    });
    expect(evaluation._bid).toMatchObject({
      confidence: 0.66,
      reasoning: 'maybe',
      plan: 'try X',
      hallucinationRisk: 'low',
    });
  });
});

describe('bidsToEvaluations -- filtering + mapping', () => {
  it('drops bids below confidenceFloor', () => {
    const bids = [
      { agentId: 'a', confidence: 0.9 },
      { agentId: 'b', confidence: 0.3 },
      { agentId: 'c', confidence: 0.5 },
    ];
    const result = bidsToEvaluations(bids, { confidenceFloor: 0.5 });
    expect(result.map((r) => r.agentId).sort()).toEqual(['a', 'c']);
  });

  it('defaults confidenceFloor to 0.5 when not provided', () => {
    const bids = [
      { agentId: 'a', confidence: 0.51 },
      { agentId: 'b', confidence: 0.49 },
    ];
    const result = bidsToEvaluations(bids);
    expect(result.map((r) => r.agentId)).toEqual(['a']);
  });

  it('passes executionResults through by agentId', () => {
    const bids = [{ agentId: 'a', confidence: 0.9 }];
    const exec = new Map([['a', { message: 'done', data: { ok: true } }]]);
    const result = bidsToEvaluations(bids, { executionResults: exec });
    expect(result[0].suggestions.some((s) => s.type === 'execution-result')).toBe(true);
  });

  it('accepts executionResults as a plain object', () => {
    const bids = [{ agentId: 'a', confidence: 0.9 }];
    const exec = { a: { message: 'done' } };
    const result = bidsToEvaluations(bids, { executionResults: exec });
    expect(result[0].suggestions.some((s) => s.type === 'execution-result')).toBe(true);
  });

  it('returns empty array for non-array input', () => {
    expect(bidsToEvaluations(null)).toEqual([]);
    expect(bidsToEvaluations(undefined)).toEqual([]);
    expect(bidsToEvaluations({})).toEqual([]);
  });
});

describe('buildConsolidateContext', () => {
  it('defaults weightingMode to uniform', () => {
    const ctx = buildConsolidateContext({ id: 't', content: 'hello' });
    expect(ctx.weightingMode).toBe('uniform');
    expect(ctx.taskId).toBe('t');
  });

  it('respects explicit weightingMode', () => {
    const ctx = buildConsolidateContext({ id: 't', content: 'x' }, { weightingMode: 'learned' });
    expect(ctx.weightingMode).toBe('learned');
  });

  it('carries spaceId onto context', () => {
    const ctx = buildConsolidateContext({ id: 't', content: 'x', spaceId: 'meeting' });
    expect(ctx.spaceId).toBe('meeting');
  });

  it('derives documentType from task.rubric when present', () => {
    const ctx = buildConsolidateContext({ id: 't', content: 'x', rubric: 'api' });
    expect(ctx.documentType).toBe('api');
  });
});

describe('_deriveAgentType', () => {
  it('drops the -agent suffix', () => {
    expect(_deriveAgentType('calendar-query-agent')).toBe('calendar-query');
    expect(_deriveAgentType('memory-agent')).toBe('memory');
  });

  it('handles agents without the suffix', () => {
    expect(_deriveAgentType('custom-type')).toBe('custom-type');
  });

  it('returns unknown for non-strings', () => {
    expect(_deriveAgentType(null)).toBe('unknown');
    expect(_deriveAgentType(42)).toBe('unknown');
  });

  it('lowercases the result', () => {
    expect(_deriveAgentType('Calendar-AGENT')).toBe('calendar');
  });
});

describe('_inferDocumentType heuristics', () => {
  it('recognizes recipe-flavored content', () => {
    expect(_inferDocumentType({ content: 'Give me a recipe for pasta' })).toBe('recipe');
  });

  it('recognizes api content', () => {
    expect(_inferDocumentType({ content: 'Design this REST endpoint' })).toBe('api');
  });

  it('recognizes test content', () => {
    expect(_inferDocumentType({ content: 'Write unit tests' })).toBe('test');
  });

  it('recognizes documentation', () => {
    expect(_inferDocumentType({ content: 'Update the README' })).toBe('documentation');
  });

  it('falls back to code for generic content', () => {
    expect(_inferDocumentType({ content: 'help me think through this' })).toBe('code');
  });

  it('prefers rubric when set', () => {
    expect(_inferDocumentType({ content: 'give me a recipe', rubric: 'creative' })).toBe('creative');
  });

  it('returns code for null task', () => {
    expect(_inferDocumentType(null)).toBe('code');
  });
});
