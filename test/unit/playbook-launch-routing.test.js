/**
 * Playbook launch routing (2026-08-05 live: "Can you launch WISER Playbooks?"
 * listed playbooks instead of launching one).
 *
 * Two independent defects, both pinned here:
 *  A. playbook-agent crashed with "spaces.find is not a function" — the
 *     /api/spaces envelope { spaces: [...] } was treated as a bare array, so
 *     the winner busted and a generic backup answered instead.
 *  B. the Master Orchestrator rejected the correct specialist with
 *     "confidence score of 0.49 is too low compared to tied leaders at 0.70"
 *     — 0.49 was its REPUTATION-WEIGHTED score, 0.70 the leaders' RAW
 *     confidence. Same-confidence bids must not read as weaker because past
 *     rejections dragged reputation down (a rejection death-spiral).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..', '..');

describe('A. /api/spaces envelope handling', () => {
  const SRC = readFileSync(resolve(REPO, 'packages/agents/playbook-agent.js'), 'utf8');

  it('defines _unwrapSpaces and uses it at every /api/spaces call site', () => {
    expect(SRC).toMatch(/function _unwrapSpaces\(res\)/);
    const rawCalls = SRC.match(/await _fetchJSON\(`\$\{SPACES_API\}\/api\/spaces`\)/g) || [];
    const wrapped = SRC.match(/_unwrapSpaces\(await _fetchJSON\(`\$\{SPACES_API\}\/api\/spaces`\)\)/g) || [];
    expect(rawCalls.length).toBeGreaterThan(0);
    expect(wrapped.length).toBe(rawCalls.length); // every call site unwrapped
  });

  it('_unwrapSpaces accepts both shapes and never yields a non-array', () => {
    // Re-implement the shipped logic against the source to keep this
    // behavioral without booting the agent's module graph.
    const body = SRC.slice(SRC.indexOf('function _unwrapSpaces'), SRC.indexOf('function _unwrapSpaces') + 300);
    // eslint-disable-next-line no-new-func
    const fn = new Function(`${body.slice(0, body.lastIndexOf('}') + 1)}; return _unwrapSpaces;`)();
    expect(fn({ spaces: [{ id: '1' }] })).toEqual([{ id: '1' }]);
    expect(fn([{ id: '2' }])).toEqual([{ id: '2' }]);
    expect(fn(null)).toEqual([]);
    expect(fn({})).toEqual([]);
    expect(Array.isArray(fn(undefined))).toBe(true);
    // The crash was calling .find on the envelope — now impossible.
    expect(typeof fn({ spaces: [] }).find).toBe('function');
  });
});

describe('B. Master Orchestrator scoring vocabulary', () => {
  const SRC = readFileSync(resolve(REPO, 'packages/agents/master-orchestrator.js'), 'utf8');

  it('labels the weighted score distinctly from raw confidence', () => {
    expect(SRC).toMatch(/Reputation-weighted score:/);
    expect(SRC).not.toMatch(/\n   Score: \$\{bid\.score/); // old ambiguous label gone
  });

  it('shows the reputation multiplier inline so the two numbers are comparable', () => {
    expect(SRC).toMatch(/past-reputation/);
  });

  it('instructs the evaluator that the weighted score is not a fitness measure', () => {
    expect(SRC).toMatch(/SCORING NOTE:/);
    expect(SRC).toMatch(/NOT a measure of\s*\n?fit/);
    expect(SRC).toMatch(/Never call a bid\s*\n?"low confidence" by quoting its weighted score/);
  });
});
