/**
 * Learned Arbitration Rules tests (Phase 3 self-learning arbitration)
 *
 * Run: npx vitest run test/unit/agent-learning/learned-arbitration-rules.test.js
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const {
  LearnedArbitrationRulesStore,
  applyRule,
  applyRules,
  isValidRule,
  normaliseRule,
  VALID_RULE_TYPES,
  MAX_RULES,
} = require('../../../lib/agent-learning/learned-arbitration-rules');

// ============================================================
// Fixtures
// ============================================================

function makeBids() {
  return [
    { agentId: 'time-agent', confidence: 0.85, score: 0.85, reasoning: 'I report current time' },
    { agentId: 'calendar-agent', confidence: 0.7, score: 0.7, reasoning: 'I handle calendar' },
    { agentId: 'weather-agent', confidence: 0.4, score: 0.4, reasoning: 'I do weather' },
  ];
}

function makeRule(overrides = {}) {
  return {
    id: 'rule-1',
    type: 'shrink',
    target: 'calendar-agent',
    magnitude: 0.5,
    conditions: { taskClass: 'time' },
    acceptedAt: 1700000000,
    acceptedBy: 'user',
    sourceFindingId: 'finding-1',
    ...overrides,
  };
}

// ============================================================
// isValidRule
// ============================================================

describe('isValidRule', () => {
  it('accepts a well-formed shrink rule', () => {
    expect(isValidRule(makeRule())).toBe(true);
  });

  it('rejects unknown rule types', () => {
    expect(isValidRule(makeRule({ type: 'shimmy' }))).toBe(false);
  });

  it('rejects out-of-range magnitudes', () => {
    expect(isValidRule(makeRule({ magnitude: 1.5 }))).toBe(false);
    expect(isValidRule(makeRule({ magnitude: -0.1 }))).toBe(false);
    expect(isValidRule(makeRule({ magnitude: 'half' }))).toBe(false);
  });

  it('requires array target with 2 entries for suppress-pair', () => {
    expect(isValidRule(makeRule({ type: 'suppress-pair', target: 'just-one' }))).toBe(false);
    expect(isValidRule(makeRule({ type: 'suppress-pair', target: ['only-one'] }))).toBe(false);
    expect(isValidRule(makeRule({ type: 'suppress-pair', target: ['a', 'b'] }))).toBe(true);
  });

  it('requires string target for shrink/boost/route-class', () => {
    expect(isValidRule(makeRule({ type: 'shrink', target: ['a', 'b'] }))).toBe(false);
    expect(isValidRule(makeRule({ type: 'route-class', target: 'time-agent' }))).toBe(true);
  });

  it('rejects when id is missing', () => {
    const r = makeRule(); delete r.id;
    expect(isValidRule(r)).toBe(false);
  });
});

describe('VALID_RULE_TYPES', () => {
  it('exports the four rule types', () => {
    expect(VALID_RULE_TYPES.has('shrink')).toBe(true);
    expect(VALID_RULE_TYPES.has('boost')).toBe(true);
    expect(VALID_RULE_TYPES.has('suppress-pair')).toBe(true);
    expect(VALID_RULE_TYPES.has('route-class')).toBe(true);
    expect(VALID_RULE_TYPES.size).toBe(4);
  });
});

// ============================================================
// applyRule
// ============================================================

describe('applyRule -- shrink', () => {
  it('multiplies the target bid confidence by (1 - magnitude)', () => {
    const { adjusted } = applyRule(makeBids(), makeRule({
      type: 'shrink',
      target: 'calendar-agent',
      magnitude: 0.5,
    }));
    expect(adjusted.find((b) => b.agentId === 'calendar-agent').confidence).toBeCloseTo(0.35, 5);
    expect(adjusted.find((b) => b.agentId === 'time-agent').confidence).toBe(0.85); // untouched
  });

  it('clamps shrunk confidence at 0 even with magnitude=1', () => {
    const { adjusted } = applyRule(makeBids(), makeRule({ magnitude: 1 }));
    expect(adjusted.find((b) => b.agentId === 'calendar-agent').confidence).toBe(0);
  });

  it('does not mutate the input array', () => {
    const bids = makeBids();
    const before = JSON.stringify(bids);
    applyRule(bids, makeRule());
    expect(JSON.stringify(bids)).toBe(before);
  });

  it('returns a new array (immutable)', () => {
    const bids = makeBids();
    const { adjusted } = applyRule(bids, makeRule());
    expect(adjusted).not.toBe(bids);
  });
});

describe('applyRule -- boost', () => {
  it('multiplies by (1 + magnitude), capped at 1', () => {
    const { adjusted } = applyRule(makeBids(), makeRule({
      type: 'boost',
      target: 'calendar-agent',
      magnitude: 0.5,
    }));
    expect(adjusted.find((b) => b.agentId === 'calendar-agent').confidence).toBeCloseTo(1.0, 5);
  });
});

describe('applyRule -- suppress-pair', () => {
  it('drops the lower-confidence agent of the specified pair', () => {
    const { adjusted, dropped } = applyRule(makeBids(), makeRule({
      type: 'suppress-pair',
      target: ['time-agent', 'calendar-agent'],
      magnitude: 0,
    }));
    expect(adjusted.find((b) => b.agentId === 'calendar-agent')).toBeUndefined();
    expect(adjusted.find((b) => b.agentId === 'time-agent')).toBeDefined();
    expect(dropped).toEqual(['calendar-agent']);
  });

  it('no-ops when one of the pair is missing from bids', () => {
    const { adjusted, dropped } = applyRule(makeBids(), makeRule({
      type: 'suppress-pair',
      target: ['time-agent', 'never-bid'],
      magnitude: 0,
    }));
    expect(adjusted).toHaveLength(3);
    expect(dropped).toEqual([]);
  });
});

describe('applyRule -- route-class', () => {
  it('keeps only the target agent and drops the rest', () => {
    const { adjusted, dropped } = applyRule(makeBids(), makeRule({
      type: 'route-class',
      target: 'time-agent',
      magnitude: 0,
    }));
    expect(adjusted).toHaveLength(1);
    expect(adjusted[0].agentId).toBe('time-agent');
    expect(dropped.sort()).toEqual(['calendar-agent', 'weather-agent']);
  });
});

describe('applyRule -- defensive', () => {
  it('returns the input unchanged for invalid rule', () => {
    const bids = makeBids();
    const { adjusted, dropped } = applyRule(bids, { junk: true });
    expect(adjusted).toBe(bids);
    expect(dropped).toEqual([]);
  });

  it('returns empty for empty bids', () => {
    const { adjusted, dropped } = applyRule([], makeRule());
    expect(adjusted).toEqual([]);
    expect(dropped).toEqual([]);
  });
});

// ============================================================
// applyRules (sequential fold)
// ============================================================

describe('applyRules', () => {
  it('applies rules in order and reports each that fired', () => {
    const bids = makeBids();
    const rules = [
      makeRule({ id: 'r1', type: 'shrink', target: 'calendar-agent', magnitude: 0.5 }),
      makeRule({ id: 'r2', type: 'route-class', target: 'time-agent', magnitude: 0 }),
    ];
    const { bids: out, applied } = applyRules(bids, rules);
    expect(out).toHaveLength(1);
    expect(out[0].agentId).toBe('time-agent');
    expect(applied).toHaveLength(2);
    expect(applied[0].ruleId).toBe('r1');
    expect(applied[1].ruleId).toBe('r2');
  });

  it('returns input unchanged when no rules match', () => {
    const bids = makeBids();
    const { bids: out, applied } = applyRules(bids, []);
    expect(out).toBe(bids);
    expect(applied).toEqual([]);
  });
});

// ============================================================
// LearnedArbitrationRulesStore -- in-memory
// ============================================================

describe('LearnedArbitrationRulesStore (in-memory)', () => {
  let store;

  beforeEach(() => {
    store = new LearnedArbitrationRulesStore();
  });

  it('starts empty', () => {
    expect(store.listRules()).toEqual([]);
  });

  it('addRule normalises and persists the rule', () => {
    const r = store.addRule(makeRule());
    expect(r).toBeDefined();
    expect(r.id).toBe('rule-1');
    expect(store.listRules()).toHaveLength(1);
  });

  it('addRule replaces an existing rule with the same id', () => {
    store.addRule(makeRule());
    store.addRule(makeRule({ magnitude: 0.9 }));
    expect(store.listRules()).toHaveLength(1);
    expect(store.listRules()[0].magnitude).toBe(0.9);
  });

  it('refuses an invalid rule', () => {
    const r = store.addRule({ id: 'x', type: 'unknown' });
    expect(r).toBeNull();
    expect(store.listRules()).toHaveLength(0);
  });

  it('removeRule removes by id', () => {
    store.addRule(makeRule());
    expect(store.removeRule('rule-1')).toBe(true);
    expect(store.listRules()).toEqual([]);
    expect(store.removeRule('rule-1')).toBe(false); // already gone
  });

  it('caps the rule list at MAX_RULES (drops oldest)', () => {
    for (let i = 0; i < MAX_RULES + 5; i += 1) {
      store.addRule(makeRule({ id: `rule-${i}` }));
    }
    expect(store.listRules()).toHaveLength(MAX_RULES);
    // First 5 should have been dropped.
    const ids = store.listRules().map((r) => r.id);
    expect(ids[0]).toBe('rule-5');
  });
});

// ============================================================
// LearnedArbitrationRulesStore -- conditions filtering
// ============================================================

describe('LearnedArbitrationRulesStore.getApplicableRules', () => {
  let store;
  beforeEach(() => { store = new LearnedArbitrationRulesStore(); });

  it('returns no rules when none match', () => {
    store.addRule(makeRule({ id: 'r1', conditions: { taskClass: 'time' } }));
    const result = store.getApplicableRules({ content: 'whatever' }, makeBids(), () => 'weather');
    expect(result).toEqual([]);
  });

  it('matches by taskClass classifier', () => {
    store.addRule(makeRule({ id: 'r1', conditions: { taskClass: 'time' } }));
    const result = store.getApplicableRules({ content: 'what time is it' }, makeBids(), () => 'time');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('r1');
  });

  it('matches by taskContentMatchesRegex', () => {
    store.addRule(makeRule({ id: 'r1', conditions: { taskContentMatchesRegex: '\\bweather\\b' } }));
    const result = store.getApplicableRules({ content: 'what is the weather like' }, makeBids());
    expect(result).toHaveLength(1);
  });

  it('skips rules whose target agent is not present in bids (shrink)', () => {
    store.addRule(makeRule({
      id: 'r1', type: 'shrink', target: 'never-bid',
      conditions: { taskClass: 'time' },
    }));
    const result = store.getApplicableRules({ content: 'q' }, makeBids(), () => 'time');
    expect(result).toEqual([]);
  });

  it('skips suppress-pair when only one of the pair is in bids', () => {
    store.addRule(makeRule({
      id: 'r1', type: 'suppress-pair', target: ['time-agent', 'never-bid'],
      conditions: { taskClass: 'time' },
    }));
    const result = store.getApplicableRules({ content: 'q' }, makeBids(), () => 'time');
    expect(result).toEqual([]);
  });

  it('handles bad-regex conditions gracefully (no crash, no match)', () => {
    store.addRule(makeRule({ id: 'r1', conditions: { taskContentMatchesRegex: '[unclosed' } }));
    const result = store.getApplicableRules({ content: 'anything' }, makeBids());
    expect(result).toEqual([]);
  });
});

// ============================================================
// LearnedArbitrationRulesStore -- disk persistence
// ============================================================

describe('LearnedArbitrationRulesStore disk persistence', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-test-'));
  });

  it('persists rules across init() calls', () => {
    const a = new LearnedArbitrationRulesStore().init(dir);
    a.addRule(makeRule());
    const b = new LearnedArbitrationRulesStore().init(dir);
    expect(b.listRules()).toHaveLength(1);
    expect(b.listRules()[0].id).toBe('rule-1');
  });

  it('uses atomic rename (no .tmp left behind on success)', () => {
    const s = new LearnedArbitrationRulesStore().init(dir);
    s.addRule(makeRule());
    const tmpExists = fs.existsSync(path.join(dir, 'agent-learning', 'learned-arbitration-rules.json.tmp'));
    expect(tmpExists).toBe(false);
  });

  it('drops invalid stored rules on init() (resilient to schema drift)', () => {
    const subdir = path.join(dir, 'agent-learning');
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(
      path.join(subdir, 'learned-arbitration-rules.json'),
      JSON.stringify({
        rules: [makeRule(), { id: 'bad', type: 'unknown', target: 'x', magnitude: 0.5 }],
        updatedAt: 1700000000,
      }),
    );
    const s = new LearnedArbitrationRulesStore().init(dir);
    expect(s.listRules()).toHaveLength(1);
    expect(s.listRules()[0].id).toBe('rule-1');
  });

  it('survives a corrupted file (returns empty store)', () => {
    const subdir = path.join(dir, 'agent-learning');
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(path.join(subdir, 'learned-arbitration-rules.json'), '{not json');
    const s = new LearnedArbitrationRulesStore().init(dir);
    expect(s.listRules()).toEqual([]);
  });
});

// ============================================================
// normaliseRule
// ============================================================

describe('normaliseRule', () => {
  it('clamps magnitude to [0, 1]', () => {
    const r = normaliseRule(makeRule({ magnitude: 0.5 }));
    expect(r.magnitude).toBe(0.5);
  });

  it('returns null for invalid rules', () => {
    expect(normaliseRule({ junk: true })).toBeNull();
  });

  it('defaults acceptedAt + acceptedBy when missing', () => {
    const r = normaliseRule(makeRule({ acceptedAt: undefined, acceptedBy: undefined }));
    expect(typeof r.acceptedAt).toBe('number');
    expect(r.acceptedBy).toBe('user');
  });

  it('clones suppress-pair target array', () => {
    const target = ['a', 'b'];
    const r = normaliseRule(makeRule({ type: 'suppress-pair', target }));
    expect(r.target).toEqual(['a', 'b']);
    expect(r.target).not.toBe(target);
  });
});
