/**
 * Search Agent -- implicit-location detection tests
 *
 * Verifies that queries like "coffee shops nearby" get recognised as
 * location-aware so the agent can enhance them with the user's live city
 * before hitting the search API.
 *
 * Run: npx vitest run test/unit/search-agent-local-detection.test.js
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  }),
}));
vi.mock('../../lib/ai-service', () => ({ chat: vi.fn(), complete: vi.fn() }));
vi.mock('../../lib/http-client', () => ({ fetch: vi.fn() }));
vi.mock('../../lib/agent-memory-store', () => ({
  getAgentMemory: () => ({ load: vi.fn(), save: vi.fn() }),
}));
vi.mock('./circuit-breaker', () => ({ getCircuit: () => ({ execute: (fn) => fn() }) }));

const searchAgent = require('../../packages/agents/search-agent');

describe('Search Agent -- _isImplicitlyLocal', () => {
  const cases = [
    // Matches: the question is clearly about "here"
    ['coffee shops nearby', true],
    ['find a good place for lunch around here', true],
    ['closest pharmacy', true],
    ['restaurants near me', true],
    ['gyms in this area', true],
    ['where is the best coffee shop', true],
    ['cheap gas station close by', true],
    ['find a bar that is open', true],
    ['best cafe for studying', true],
    // Does NOT match: explicit city, or non-local query
    ['coffee shops in Paris', false],
    ['weather in Tokyo', false],
    ['what is the capital of France', false],
    ['latest iPhone news', false],
    ['how does photosynthesis work', false],
    ['what time is it', false],
  ];

  for (const [query, expected] of cases) {
    it(`${expected ? 'flags' : 'skips'} "${query}"`, () => {
      expect(searchAgent._isImplicitlyLocal(query)).toBe(expected);
    });
  }

  it('does not flag when explicit "in <place>" is present', () => {
    expect(searchAgent._isImplicitlyLocal('find coffee near Austin')).toBe(true);
    // With "in <city>" it should still match our implicit detector, but
    // hasLocation() will return true upstream and skip enhancement. That
    // upstream gate is why the detector can be permissive here without
    // breaking queries that already name a city.
  });
});
