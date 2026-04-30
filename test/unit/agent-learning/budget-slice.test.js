/**
 * Budget slice tests for lib/agent-learning/index.js (Phase 2 wiring)
 *
 * Run: npx vitest run test/unit/agent-learning/budget-slice.test.js
 *
 * Verifies that _checkLearningBudget('counterfactual') is gated by the
 * sliced share of dailyBudget rather than the full daily budget. Other
 * learning features (improvement, transcriptReview, reflection) remain
 * unaffected by counterfactual spend, and vice versa.
 *
 * The real budget-manager constructor depends on electron's app.getPath
 * at import time, which isn't available in vitest. Rather than fight
 * vi.mock CJS-vs-ESM interception, we use the _setBudgetManagerForTests
 * injection seam in lib/agent-learning/index.js.
 */

import { describe, it, expect, beforeEach } from 'vitest';

const { _checkLearningBudget, _setBudgetManagerForTests, BUDGET_SLICES, DEFAULT_CONFIG } =
  require('../../../lib/agent-learning');

let mockUsage;

function todayIso(offsetMin = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setMinutes(d.getMinutes() + offsetMin);
  return d.toISOString();
}

beforeEach(() => {
  mockUsage = [];
  _setBudgetManagerForTests({ data: { usage: mockUsage } });
});

describe('BUDGET_SLICES', () => {
  it('exports the four phase slices and they sum to <= 1', () => {
    expect(BUDGET_SLICES.improvement).toBeGreaterThan(0);
    expect(BUDGET_SLICES.counterfactual).toBeGreaterThan(0);
    expect(BUDGET_SLICES.transcriptReview).toBeGreaterThan(0);
    expect(BUDGET_SLICES.reflection).toBeGreaterThan(0);
    const sum =
      BUDGET_SLICES.improvement +
      BUDGET_SLICES.counterfactual +
      BUDGET_SLICES.transcriptReview +
      BUDGET_SLICES.reflection;
    expect(sum).toBeLessThanOrEqual(1.0001); // float tolerance
  });
});

describe('_checkLearningBudget(slice)', () => {
  it('counterfactual slice allows when sliced spend is below sliced limit', async () => {
    // 30% of $0.50 = $0.15. Spend $0.05; should still be allowed.
    mockUsage.push({
      timestamp: todayIso(60),
      feature: 'agent-learning-counterfactual',
      cost: 0.05,
    });
    const r = await _checkLearningBudget('counterfactual');
    expect(r.allowed).toBe(true);
    expect(r.slice).toBe('counterfactual');
    expect(r.spent).toBeCloseTo(0.05, 5);
    expect(r.remaining).toBeCloseTo(0.10, 5); // 0.15 - 0.05
  });

  it('counterfactual slice blocks when sliced spend hits the cap', async () => {
    // Spend $0.20 -- exceeds the 30% slice ($0.15)
    mockUsage.push({
      timestamp: todayIso(60),
      feature: 'agent-learning-counterfactual',
      cost: 0.20,
    });
    const r = await _checkLearningBudget('counterfactual');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('daily_budget_slice');
    expect(r.slice).toBe('counterfactual');
  });

  it('counterfactual slice ignores spend on other features', async () => {
    // Big improvement-engine spend doesn't gate the counterfactual slice.
    mockUsage.push({
      timestamp: todayIso(60),
      feature: 'agent-learning-improvement',
      cost: 0.50,
    });
    const r = await _checkLearningBudget('counterfactual');
    expect(r.allowed).toBe(true);
    expect(r.spent).toBe(0); // no counterfactual spend
  });

  it('counterfactual slice ignores yesterday spend', async () => {
    const yesterday = new Date();
    yesterday.setHours(0, 0, 0, 0);
    yesterday.setDate(yesterday.getDate() - 1);
    mockUsage.push({
      timestamp: yesterday.toISOString(),
      feature: 'agent-learning-counterfactual',
      cost: 1.0,
    });
    const r = await _checkLearningBudget('counterfactual');
    expect(r.allowed).toBe(true);
    expect(r.spent).toBe(0);
  });

  it('unsliced check (no slice arg) uses the legacy LEARNING_FEATURE_PREFIX rule', async () => {
    // The unsliced path counts EVERY feature starting with
    // 'agent-learning' against the full daily budget. Counterfactual
    // spend should count here.
    mockUsage.push({
      timestamp: todayIso(60),
      feature: 'agent-learning-counterfactual',
      cost: 0.10,
    });
    const r = await _checkLearningBudget();
    expect(r.allowed).toBe(true);
    expect(r.spent).toBeCloseTo(0.10, 5);
    expect(r.remaining).toBeCloseTo(DEFAULT_CONFIG.dailyBudget - 0.10, 5);
  });

  it('unknown slice key falls through to the unsliced check', async () => {
    mockUsage.push({
      timestamp: todayIso(60),
      feature: 'agent-learning-counterfactual',
      cost: 0.10,
    });
    const r = await _checkLearningBudget('not-a-real-slice');
    // Unsliced means the full $0.50 budget; spent 0.10, allowed.
    expect(r.allowed).toBe(true);
    expect(r.slice).toBeUndefined(); // legacy shape, no slice key
  });

  it('returns allowed when budget manager is unavailable (degraded path)', async () => {
    _setBudgetManagerForTests(null); // simulate getBudgetManager() returning null
    // The fallback at the start of _checkLearningBudget returns
    // allowed=true with spent=0, remaining=Infinity to fail-open.
    const r = await _checkLearningBudget('counterfactual');
    expect(r.allowed).toBe(true);
  });
});
