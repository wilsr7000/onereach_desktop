/**
 * SlowSuccessTracker tests
 *
 * Run: npx vitest run test/unit/agent-learning/slow-success-tracker.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

const {
  SlowSuccessTracker,
  normalizeQueryClass,
} = require('../../../lib/agent-learning/slow-success-tracker');

describe('normalizeQueryClass (bucketing)', () => {
  it('groups local-search queries regardless of phrasing', () => {
    expect(normalizeQueryClass('coffee shops nearby')).toBe('bucket:local-search');
    expect(normalizeQueryClass('best pizza near me')).toBe('bucket:local-search');
    expect(normalizeQueryClass('closest pharmacy')).toBe('bucket:local-search');
    expect(normalizeQueryClass('find a good restaurant around here')).toBe('bucket:local-search');
    expect(normalizeQueryClass('coffee shops in Berkeley')).toBe('bucket:local-search');
  });

  it('groups weather queries together', () => {
    expect(normalizeQueryClass('weather today')).toBe('bucket:weather');
    expect(normalizeQueryClass('what\'s the forecast')).toBe('bucket:weather');
    expect(normalizeQueryClass('is it raining')).toBe('bucket:weather');
  });

  it('groups directions queries together', () => {
    expect(normalizeQueryClass('directions to the airport')).toBe('bucket:directions');
    expect(normalizeQueryClass('how far to Austin')).toBe('bucket:directions');
  });

  it('classifies news separately', () => {
    expect(normalizeQueryClass('latest news')).toBe('bucket:news');
    expect(normalizeQueryClass('today\'s headlines')).toBe('bucket:news');
  });

  it('classifies factual definitions separately', () => {
    expect(normalizeQueryClass('what is photosynthesis')).toBe('bucket:factual');
    expect(normalizeQueryClass('define entropy')).toBe('bucket:factual');
  });

  it('falls back to "other" for unmatched queries', () => {
    expect(normalizeQueryClass('asdf qwerty xyz')).toBe('bucket:other');
    expect(normalizeQueryClass('hello world')).toBe('bucket:other');
  });

  it('returns empty for empty input', () => {
    expect(normalizeQueryClass('')).toBe('');
    expect(normalizeQueryClass(null)).toBe('');
    expect(normalizeQueryClass(undefined)).toBe('');
  });
});

describe('SlowSuccessTracker', () => {
  let tracker;

  beforeEach(() => {
    tracker = new SlowSuccessTracker({
      threshold: 2,
      classCooldownMs: 60 * 60 * 1000,
      globalCooldownMs: 0, // disabled for most tests
    });
  });

  it('does not suggest on first occurrence (under threshold)', () => {
    const result = tracker.shouldSuggestBuild({
      userInput: 'coffee shops nearby',
      winningAgentId: 'search-agent',
      bustCount: 2,
    });
    expect(result).toBeNull();
  });

  it('suggests once threshold is reached (same bucket)', () => {
    tracker.shouldSuggestBuild({ userInput: 'coffee shops nearby', bustCount: 2 });
    const result = tracker.shouldSuggestBuild({ userInput: 'best pizza near me', bustCount: 1 });
    expect(result).not.toBeNull();
    expect(result.reason).toBe('slow-success-threshold');
    expect(result.queryClass).toBe('bucket:local-search');
    expect(result.suggestedPrompt).toContain('build');
  });

  it('picks a local-search agent idea for local-search bucket', () => {
    tracker.shouldSuggestBuild({ userInput: 'coffee shops nearby', bustCount: 2 });
    const r = tracker.shouldSuggestBuild({ userInput: 'find a cafe', bustCount: 2 });
    expect(r).not.toBeNull();
    expect(r.agentIdea).toMatch(/coffee|local/i);
  });

  it('picks a weather agent idea for weather bucket', () => {
    tracker.shouldSuggestBuild({ userInput: 'weather today', bustCount: 2 });
    const r = tracker.shouldSuggestBuild({ userInput: 'is it raining', bustCount: 2 });
    expect(r).not.toBeNull();
    expect(r.agentIdea).toMatch(/weather/i);
  });

  it('does not re-suggest same bucket within class cooldown', () => {
    tracker.shouldSuggestBuild({ userInput: 'coffee shops nearby', bustCount: 2 });
    const r1 = tracker.shouldSuggestBuild({ userInput: 'closest pharmacy', bustCount: 2 });
    expect(r1).not.toBeNull();
    const r2 = tracker.shouldSuggestBuild({ userInput: 'find a bar nearby', bustCount: 2 });
    expect(r2).toBeNull(); // same bucket, within cooldown
  });

  it('different buckets do not block each other (no global cooldown)', () => {
    // Two occurrences of local-search -> suggestion for local
    tracker.shouldSuggestBuild({ userInput: 'coffee nearby', bustCount: 2 });
    const r1 = tracker.shouldSuggestBuild({ userInput: 'find a pharmacy nearby', bustCount: 2 });
    expect(r1).not.toBeNull();
    expect(r1.queryClass).toBe('bucket:local-search');
    // Two occurrences of weather -> suggestion for weather (different bucket)
    tracker.shouldSuggestBuild({ userInput: 'weather today', bustCount: 2 });
    const r2 = tracker.shouldSuggestBuild({ userInput: 'is it raining', bustCount: 2 });
    expect(r2).not.toBeNull();
    expect(r2.queryClass).toBe('bucket:weather');
    expect(r1.queryClass).not.toBe(r2.queryClass);
  });

  it('respects global cooldown across different buckets', () => {
    const t = new SlowSuccessTracker({
      threshold: 2,
      classCooldownMs: 60 * 60 * 1000,
      globalCooldownMs: 60 * 60 * 1000,
    });
    t.shouldSuggestBuild({ userInput: 'coffee nearby', bustCount: 2 });
    const r1 = t.shouldSuggestBuild({ userInput: 'pharmacy nearby', bustCount: 2 });
    expect(r1).not.toBeNull();
    t.shouldSuggestBuild({ userInput: 'weather today', bustCount: 2 });
    const r2 = t.shouldSuggestBuild({ userInput: 'is it raining', bustCount: 2 });
    expect(r2).toBeNull(); // global cooldown suppresses
  });

  it('ignores events without userInput', () => {
    expect(tracker.shouldSuggestBuild({})).toBeNull();
    expect(tracker.shouldSuggestBuild({ userInput: '' })).toBeNull();
    expect(tracker.shouldSuggestBuild(null)).toBeNull();
  });
});
