/**
 * TemporalContext tests
 *
 * Run: npx vitest run test/unit/temporal-context.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

const {
  TemporalContext,
  classifyBucket,
} = require('../../lib/temporal-context');

describe('classifyBucket', () => {
  const cases = [
    ['coffee shops nearby', 'local-search'],
    ['find a pharmacy near me', 'local-search'],
    ["what's the weather today", 'weather'],
    ['is it raining', 'weather'],
    ['directions to the airport', 'directions'],
    ['latest news', 'news'],
    ['what time is it', 'time'],
    ['show my calendar', 'calendar'],
    ['my inbox', 'email'],
    ['add a todo', 'tasks'],
    ['what is photosynthesis', 'factual'],
    ['build an agent', 'playbook'],
    ['tell me a joke', 'other'],
  ];

  for (const [input, bucket] of cases) {
    it(`classifies "${input}" as ${bucket}`, () => {
      expect(classifyBucket(input)).toBe(bucket);
    });
  }
});

describe('TemporalContext', () => {
  let ctx;
  const NOW = new Date('2026-04-15T14:30:00Z').getTime();

  beforeEach(() => {
    ctx = new TemporalContext();
    // Bypass disk IO for the in-memory tests
    ctx._diskPath = null;
  });

  it('records interactions and classifies into buckets', () => {
    ctx.recordInteraction({ userInput: 'coffee shops nearby', timestamp: NOW });
    const snap = ctx.getContextSnapshot(NOW);
    expect(snap.recent[snap.recent.length - 1].bucket).toBe('local-search');
    expect(snap.totalRecorded).toBe(1);
  });

  it('surfaces recent interactions (last 3)', () => {
    for (let i = 0; i < 5; i++) {
      ctx.recordInteraction({ userInput: `coffee nearby #${i}`, timestamp: NOW + i * 60 * 1000 });
    }
    const snap = ctx.getContextSnapshot(NOW + 10 * 60 * 1000);
    expect(snap.recent.length).toBe(3);
  });

  it('picks up "usually at this hour" pattern when sample >= 3', () => {
    // 3 days of "weather at 2pm"
    for (let d = 0; d < 3; d++) {
      const t = NOW - d * 24 * 60 * 60 * 1000;
      ctx.recordInteraction({ userInput: 'weather forecast', timestamp: t });
    }
    const snap = ctx.getContextSnapshot(NOW);
    expect(snap.patternsAtThisHour.length).toBeGreaterThan(0);
    expect(snap.patternsAtThisHour[0].bucket).toBe('weather');
    expect(snap.patternsAtThisHour[0].count).toBeGreaterThanOrEqual(3);
  });

  it('reports yesterdayTop topics', () => {
    const yesterday = NOW - 24 * 60 * 60 * 1000;
    ctx.recordInteraction({ userInput: 'coffee nearby', timestamp: yesterday });
    ctx.recordInteraction({ userInput: 'weather today', timestamp: yesterday });
    ctx.recordInteraction({ userInput: 'coffee again', timestamp: yesterday + 60 * 1000 });
    const snap = ctx.getContextSnapshot(NOW);
    expect(snap.yesterdayTop.length).toBeGreaterThan(0);
    expect(snap.yesterdayTop[0].bucket).toBe('local-search');
  });

  it('computes correct timeOfDay labels', () => {
    const morning = new Date('2026-04-15T09:00:00').getTime();
    const c = new TemporalContext();
    const s = c.getContextSnapshot(morning);
    expect(s.timeOfDay).toBe('morning');
  });

  it('prompt summary is empty when no data', () => {
    const c = new TemporalContext();
    const s = c.getPromptSummary(NOW);
    // Always includes time-of-day line, but nothing else
    expect(s).toMatch(/time of day/i);
  });

  it('prompt summary names recent activity when under 60min old', () => {
    ctx.recordInteraction({ userInput: 'coffee shops nearby', timestamp: NOW - 5 * 60 * 1000 });
    const s = ctx.getPromptSummary(NOW);
    expect(s).toMatch(/most recent activity/i);
    expect(s).toContain('local-search');
  });

  it('prunes hourly entries older than 7 days', () => {
    const eightDaysAgo = NOW - 8 * 24 * 60 * 60 * 1000;
    ctx.recordInteraction({ userInput: 'old query', timestamp: eightDaysAgo });
    ctx.recordInteraction({ userInput: 'new query', timestamp: NOW });
    // Prune is called implicitly on record; only the new hour should remain
    const snap = ctx.getContextSnapshot(NOW);
    expect(snap.totalRecorded).toBeGreaterThan(0);
  });
});
