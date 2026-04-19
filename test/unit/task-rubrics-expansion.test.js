/**
 * Task Rubric -> Criteria Expansion (agent-system v2)
 *
 * Verifies:
 *   - `rubricToCriteria` produces the Task.criteria[] shape.
 *   - `getRubric` returns the expected built-in rubrics.
 *   - `buildTask` auto-expands a rubric string into criteria when
 *     the caller didn't supply their own.
 *   - Explicit `criteria` from the caller wins over the rubric.
 *   - Unknown rubric ids don't break buildTask -- they just don't
 *     populate criteria.
 */

import { describe, it, expect } from 'vitest';

const {
  getRubric,
  rubricToCriteria,
  TASK_SUCCESS_RUBRICS,
} = require('../../lib/task-rubrics');
const { buildTask } = require('../../lib/task');

describe('getRubric', () => {
  it('returns null for unknown ids', () => {
    expect(getRubric('nope')).toBe(null);
    expect(getRubric('')).toBe(null);
    expect(getRubric(null)).toBe(null);
    expect(getRubric(123)).toBe(null);
  });

  it('returns built-in rubrics by id', () => {
    expect(getRubric('plan_review')).toBeTruthy();
    expect(getRubric('plan_proposal')).toBeTruthy();
    expect(getRubric('decision_record')).toBeTruthy();
    expect(getRubric('meeting_outcome')).toBeTruthy();
    expect(getRubric('code_generation')).toBeTruthy();
    expect(getRubric('documentation')).toBeTruthy();
    expect(getRubric('default')).toBeTruthy();
  });

  it('TASK_SUCCESS_RUBRICS includes planning rubrics', () => {
    expect(Object.keys(TASK_SUCCESS_RUBRICS)).toEqual(
      expect.arrayContaining(['plan_review', 'plan_proposal', 'decision_record', 'meeting_outcome'])
    );
  });
});

describe('rubricToCriteria -- shape conversion', () => {
  it('converts a rubric object into the flat criteria array', () => {
    const out = rubricToCriteria('plan_review');
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
    // Every entry has id + label, and description/weight where defined
    for (const c of out) {
      expect(typeof c.id).toBe('string');
      expect(c.id.length).toBeGreaterThan(0);
      expect(typeof c.label).toBe('string');
    }
  });

  it('humanizes snake_case ids into pretty labels', () => {
    const out = rubricToCriteria('decision_record');
    const byId = Object.fromEntries(out.map((c) => [c.id, c]));
    expect(byId.rationale.label).toBe('Rationale');
    // _ based ids become spaces + title case
    const pm = rubricToCriteria('plan_proposal');
    const pmById = Object.fromEntries(pm.map((c) => [c.id, c]));
    expect(pmById.problem_clarity.label).toBe('Problem Clarity');
    expect(pmById.risk_awareness.label).toBe('Risk Awareness');
  });

  it('preserves weight and description when provided', () => {
    const out = rubricToCriteria('plan_review');
    const clarity = out.find((c) => c.id === 'clarity');
    expect(clarity.weight).toBe(0.25);
    expect(clarity.description).toMatch(/clearly stated/);
  });

  it('accepts a rubric object directly (not just an id)', () => {
    const rubric = {
      criteria: {
        custom: { weight: 1.0, check: 'llm', description: 'Custom' },
      },
    };
    const out = rubricToCriteria(rubric);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('custom');
  });

  it('returns null for unknown id / malformed input', () => {
    expect(rubricToCriteria('nope')).toBe(null);
    expect(rubricToCriteria(null)).toBe(null);
    expect(rubricToCriteria({})).toBe(null);
    expect(rubricToCriteria({ criteria: 'not an object' })).toBe(null);
  });
});

describe('buildTask -- rubric auto-expansion', () => {
  it('auto-expands task.rubric into criteria when caller did not supply them', () => {
    const t = buildTask({ content: 'evaluate this plan', rubric: 'plan_review' });
    expect(t.rubric).toBe('plan_review');
    expect(Array.isArray(t.criteria)).toBe(true);
    expect(t.criteria.length).toBeGreaterThan(0);
    expect(t.criteria.find((c) => c.id === 'clarity')).toBeTruthy();
    expect(t.criteria.find((c) => c.id === 'feasibility')).toBeTruthy();
  });

  it('explicit criteria from the caller wins over the rubric', () => {
    const t = buildTask({
      content: 'evaluate',
      rubric: 'plan_review',
      criteria: [{ id: 'only-this-one', label: 'Custom' }],
    });
    expect(t.criteria).toHaveLength(1);
    expect(t.criteria[0].id).toBe('only-this-one');
  });

  it('unknown rubric id leaves criteria unset without throwing', () => {
    const t = buildTask({ content: 'x', rubric: 'does-not-exist' });
    expect(t.rubric).toBe('does-not-exist');
    expect(t.criteria).toBeUndefined();
  });

  it('works for every built-in planning rubric', () => {
    for (const id of ['plan_review', 'plan_proposal', 'decision_record', 'meeting_outcome']) {
      const t = buildTask({ content: 'x', rubric: id });
      expect(t.criteria, `rubric ${id} should expand`).toBeTruthy();
      expect(t.criteria.length, `rubric ${id} should have >=3 criteria`).toBeGreaterThanOrEqual(3);
    }
  });
});
