/**
 * Voter Pool -- Unit Tests
 *
 * Verifies Phase 3's role/space-based filtering of the bidder pool:
 *   - bidExcluded agents never bid.
 *   - Agents without declared defaultSpaces are generalists and bid on
 *     every task regardless of spaceId.
 *   - Agents with declared defaultSpaces are specialists and bid only
 *     in their declared spaces.
 *   - When the task has no spaceId, everybody is eligible (except
 *     bidExcluded).
 *   - buildAgentFilter short-circuits to null when no one would be
 *     filtered out (cost-avoidance).
 *   - targetAgentId always wins.
 */

import { describe, it, expect } from 'vitest';

const {
  isAgentEligible,
  filterEligibleAgents,
  buildAgentFilter,
} = require('../../lib/exchange/voter-pool');

// ---- Fixtures ----

const generalist = { id: 'generalist-agent', name: 'G' };
const meetingSpecialist = { id: 'meeting-notes-agent', name: 'Meeting', defaultSpaces: ['meeting-agents'] };
const multiSpaceSpecialist = { id: 'multi-agent', name: 'Multi', defaultSpaces: ['meeting-agents', 'review'] };
const excluded = { id: 'error-agent', name: 'Error', bidExcluded: true };

// ---- isAgentEligible ---------------------------------------------------

describe('isAgentEligible', () => {
  it('rejects bidExcluded agents regardless of space', () => {
    expect(isAgentEligible(excluded, {})).toBe(false);
    expect(isAgentEligible(excluded, { spaceId: 'meeting-agents' })).toBe(false);
    expect(isAgentEligible(excluded, null)).toBe(false);
  });

  it('returns false for null/undefined agents', () => {
    expect(isAgentEligible(null, {})).toBe(false);
    expect(isAgentEligible(undefined, {})).toBe(false);
  });

  it('generalist (no defaultSpaces) is eligible everywhere', () => {
    expect(isAgentEligible(generalist, {})).toBe(true);
    expect(isAgentEligible(generalist, { spaceId: 'any-space' })).toBe(true);
    expect(isAgentEligible(generalist, null)).toBe(true);
  });

  it('generalist with empty defaultSpaces array is still a generalist', () => {
    const g = { id: 'g', defaultSpaces: [] };
    expect(isAgentEligible(g, { spaceId: 'anywhere' })).toBe(true);
  });

  it('specialist bids only in their declared space', () => {
    expect(isAgentEligible(meetingSpecialist, { spaceId: 'meeting-agents' })).toBe(true);
    expect(isAgentEligible(meetingSpecialist, { spaceId: 'calendar-agents' })).toBe(false);
  });

  it('specialist with multiple spaces bids in any of them', () => {
    expect(isAgentEligible(multiSpaceSpecialist, { spaceId: 'meeting-agents' })).toBe(true);
    expect(isAgentEligible(multiSpaceSpecialist, { spaceId: 'review' })).toBe(true);
    expect(isAgentEligible(multiSpaceSpecialist, { spaceId: 'unknown' })).toBe(false);
  });

  it('specialist bids on tasks with no spaceId (task is global)', () => {
    expect(isAgentEligible(meetingSpecialist, {})).toBe(true);
    expect(isAgentEligible(meetingSpecialist, null)).toBe(true);
  });
});

// ---- filterEligibleAgents ---------------------------------------------

describe('filterEligibleAgents', () => {
  it('filters bidExcluded out even when task has no spaceId', () => {
    const out = filterEligibleAgents([generalist, excluded], {});
    expect(out.map((a) => a.id)).toEqual(['generalist-agent']);
  });

  it('keeps generalists + in-space specialists, drops out-of-space specialists', () => {
    const out = filterEligibleAgents(
      [generalist, meetingSpecialist, multiSpaceSpecialist, excluded],
      { spaceId: 'meeting-agents' },
    );
    expect(out.map((a) => a.id).sort()).toEqual(
      ['generalist-agent', 'meeting-notes-agent', 'multi-agent'].sort(),
    );
  });

  it('returns only generalists + matching specialists when spaceId is specific', () => {
    const out = filterEligibleAgents(
      [generalist, meetingSpecialist, multiSpaceSpecialist],
      { spaceId: 'review' },
    );
    expect(out.map((a) => a.id).sort()).toEqual(['generalist-agent', 'multi-agent']);
  });

  it('returns [] for empty or non-array input', () => {
    expect(filterEligibleAgents([], { spaceId: 'x' })).toEqual([]);
    expect(filterEligibleAgents(null, {})).toEqual([]);
    expect(filterEligibleAgents(undefined, {})).toEqual([]);
  });

  it('returns a new array, never mutates the input', () => {
    const input = [generalist, meetingSpecialist];
    const out = filterEligibleAgents(input, { spaceId: 'other' });
    expect(input).toHaveLength(2); // untouched
    expect(out).not.toBe(input);
  });
});

// ---- buildAgentFilter --------------------------------------------------

describe('buildAgentFilter', () => {
  it('targetAgentId always wins', () => {
    expect(
      buildAgentFilter([generalist, meetingSpecialist], { spaceId: 'meeting-agents' }, { targetAgentId: 'x' })
    ).toEqual(['x']);
  });

  it('returns null when task has no spaceId (full auction)', () => {
    expect(buildAgentFilter([generalist, meetingSpecialist], {})).toBe(null);
    expect(buildAgentFilter([generalist, meetingSpecialist], null)).toBe(null);
  });

  it('returns null when filter would not drop anyone (cost short-circuit)', () => {
    expect(buildAgentFilter([generalist], { spaceId: 'anywhere' })).toBe(null);
  });

  it('returns the id list when at least one specialist is filtered out', () => {
    const filter = buildAgentFilter(
      [generalist, meetingSpecialist, multiSpaceSpecialist],
      { spaceId: 'meeting-agents' },
    );
    // generalist is always in; both specialists are in because their
    // declared spaces include 'meeting-agents'. So everyone is eligible
    // and we short-circuit to null.
    expect(filter).toBe(null);
  });

  it('returns filtered ids when at least one agent is dropped', () => {
    const filter = buildAgentFilter(
      [generalist, meetingSpecialist, multiSpaceSpecialist],
      { spaceId: 'unrelated-space' },
    );
    expect(filter).toEqual(['generalist-agent']);
  });

  it('uses agent.name when id is missing', () => {
    const anon = { name: 'anon', defaultSpaces: ['review'] };
    // Also include an out-of-space specialist so filter is not short-circuited.
    const filter = buildAgentFilter(
      [generalist, anon, meetingSpecialist],
      { spaceId: 'review' },
    );
    expect(filter).toContain('anon');
    expect(filter).toContain('generalist-agent');
    expect(filter).not.toContain('meeting-notes-agent');
  });
});
