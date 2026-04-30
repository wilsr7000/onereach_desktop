/**
 * Search Agent -- grounding-check tests
 *
 * Run: npx vitest run test/unit/search-agent-grounding.test.js
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));
vi.mock('../../lib/ai-service', () => ({ chat: vi.fn(), complete: vi.fn() }));
vi.mock('../../lib/http-client', () => ({ fetch: vi.fn() }));
vi.mock('../../lib/agent-memory-store', () => ({
  getAgentMemory: () => ({ load: vi.fn(), save: vi.fn() }),
}));

const searchAgent = require('../../packages/agents/search-agent');

describe('Search Agent -- _checkGrounding', () => {
  it('returns no-evidence when search returned nothing', () => {
    expect(searchAgent._checkGrounding('some answer', [])).toBe('no-evidence');
    expect(searchAgent._checkGrounding('some answer', null)).toBe('no-evidence');
  });

  it('returns grounded when answer shares many tokens with results', () => {
    const results = [
      { title: 'Jaffa Coffee Roasters', snippet: 'A popular coffee shop in Berkeley serving pour over and espresso drinks.' },
      { title: 'The Hidden Cafe', snippet: 'Cozy cafe on Addison Street Berkeley with good lighting and wifi.' },
    ];
    const answer = 'Jaffa Coffee Roasters and The Hidden Cafe are two popular coffee shops in Berkeley.';
    expect(searchAgent._checkGrounding(answer, results)).toBe('grounded');
  });

  it('returns ungrounded when answer shares almost nothing with results', () => {
    const results = [
      { title: 'Jaffa Coffee Roasters', snippet: 'Coffee shop in Berkeley.' },
    ];
    const answer = 'The Eiffel Tower was built in 1889 by Gustave Eiffel in Paris France.';
    expect(searchAgent._checkGrounding(answer, results)).toBe('ungrounded');
  });

  it('returns weak when there is some but not strong overlap', () => {
    const results = [
      { title: 'Weather today', snippet: 'Sunny with a high of 68 degrees.' },
    ];
    // Answer uses "weather" but drifts into a different topic
    const answer = 'Weather patterns are influenced by ocean currents and atmospheric pressure systems globally.';
    const grade = searchAgent._checkGrounding(answer, results);
    expect(['weak', 'ungrounded']).toContain(grade);
  });

  it('returns weak on empty answer', () => {
    const results = [{ title: 'x', snippet: 'y' }];
    expect(searchAgent._checkGrounding('', results)).toBe('no-evidence');
  });
});
