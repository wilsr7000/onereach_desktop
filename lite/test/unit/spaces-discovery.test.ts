/**
 * Spaces — Phase 0.5 discovery runner tests.
 *
 * Covers:
 *   - Markdown formatter snapshot shape (renderer-safe module).
 *   - Runner happy path: stubbed Neon returns rows for Q1-Q4.
 *   - Runner failure isolation: one query failure does NOT abort the suite.
 *   - APOC -> fallback transition: APOC throws procedure-not-found,
 *     fallback succeeds.
 *   - Gating bookkeeping: `gatingFailures` is true iff a GATING query
 *     failed, regardless of INFORMATIONAL outcomes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock electron so transitively-imported main modules resolve under
// vitest's Node runner. The discovery runner only needs `getNeonApi()`,
// and we override it via `_setNeonApiForTesting()`.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
}));

import {
  discoveryResultsToMarkdown,
  type DiscoveryResults,
} from '../../spaces/discovery-format.js';
import { runDiscovery } from '../../spaces/discovery.js';
import {
  _resetNeonApiForTesting,
  _setNeonApiForTesting,
  NeonError,
  NEON_ERROR_CODES,
  type NeonApi,
  type NeonRecord,
} from '../../neon/api.js';

// ─── Markdown formatter ─────────────────────────────────────────────────

describe('discoveryResultsToMarkdown', () => {
  it('produces a self-contained Markdown document with Q5/Q6 placeholders', () => {
    const results: DiscoveryResults = {
      startedAt: '2026-05-12T14:00:00Z',
      finishedAt: '2026-05-12T14:00:02Z',
      anyFailures: false,
      gatingFailures: false,
      results: [
        {
          id: 'Q1',
          title: 'Q1 — Entity-type inventory (preferred)',
          gating: 'GATING',
          rationale: 'rationale text',
          ok: true,
          durationMs: 42,
          cypher: 'CALL apoc.meta.stats() YIELD labels RETURN labels',
          rows: [{ labels: { Item: 1234, Space: 7 } }],
          summary: '2 non-empty label(s).',
          notes: ['APOC available'],
        },
      ],
    };
    const md = discoveryResultsToMarkdown(results);
    expect(md).toContain('# Spaces — Phase 0.5 Discovery Results');
    expect(md).toContain('Q1 — Entity-type inventory (preferred)');
    expect(md).toContain('**Gating**: GATING');
    expect(md).toContain('**Status**: OK');
    expect(md).toContain('CALL apoc.meta.stats()');
    expect(md).toContain('Q5 — Agent identity model');
    expect(md).toContain('Q6 — Permission composition semantics');
  });

  it('renders errors when ok === false', () => {
    const results: DiscoveryResults = {
      startedAt: '2026-05-12T14:00:00Z',
      finishedAt: '2026-05-12T14:00:02Z',
      anyFailures: true,
      gatingFailures: true,
      results: [
        {
          id: 'Q4',
          title: 'Q4 — User-level ACL filtering (single-account probe)',
          gating: 'GATING',
          rationale: 'r',
          ok: false,
          durationMs: 1,
          cypher: 'MATCH ...',
          rows: [],
          error: { code: 'NEON_NETWORK', message: 'connect ECONNREFUSED' },
          notes: [],
        },
      ],
    };
    const md = discoveryResultsToMarkdown(results);
    expect(md).toContain('FAILED');
    expect(md).toContain('[NEON_NETWORK] connect ECONNREFUSED');
    expect(md).toContain('Failures: YES (GATING failures present)');
  });
});

// ─── Runner ──────────────────────────────────────────────────────────────

interface StubCall {
  cypher: string;
  parameters: Record<string, unknown> | undefined;
}

function buildStubNeonApi(
  responder: (call: StubCall) => Promise<NeonRecord[]> | NeonRecord[]
): { api: NeonApi; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const api: NeonApi = {
    async query(
      cypher: string,
      parameters?: Record<string, unknown>
    ): Promise<NeonRecord[]> {
      calls.push({ cypher, parameters });
      const result = await responder({ cypher, parameters });
      return result;
    },
    async ping(): Promise<boolean> {
      return true;
    },
    async status() {
      return {
        endpoint: null,
        uri: null,
        user: '',
        database: '',
        hasPassword: false,
        ready: true,
      };
    },
    async configure() {
      // no-op in stub
    },
    onEvent() {
      return () => undefined;
    },
  };
  return { api, calls };
}

describe('runDiscovery — happy path', () => {
  beforeEach(() => {
    _resetNeonApiForTesting();
  });

  it('runs Q1 (APOC) + Q2 + Q3 + Q4 and reports no failures', async () => {
    const { api, calls } = buildStubNeonApi(({ cypher }) => {
      if (cypher.includes('apoc.meta.stats')) {
        return [{ labels: { Item: 100, Space: 5, Agent: 2 } }];
      }
      if (cypher.includes('PRODUCED_BY')) {
        return [{ edge: 'PRODUCED_BY', principalType: ['Agent'], count: 12 }];
      }
      if (cypher.includes('count(a) AS agentCount')) {
        return [{ agentCount: 2 }];
      }
      if (cypher.includes('count(i) AS itemCount')) {
        return [{ spaceCount: 5, itemCount: 100 }];
      }
      return [];
    });
    _setNeonApiForTesting(api);

    const results = await runDiscovery();

    expect(results.results.length).toBe(4);
    expect(results.anyFailures).toBe(false);
    expect(results.gatingFailures).toBe(false);
    // 4 queries total: 1x APOC Q1 + Q2 + Q3 + Q4.
    expect(calls.length).toBe(4);
    expect(results.results.map((r) => r.id)).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
    expect(results.results.every((r) => r.ok)).toBe(true);
  });

  it('falls back from APOC to UNION ALL on procedure-not-found', async () => {
    let apocCalled = 0;
    let fallbackCalled = 0;
    const { api, calls } = buildStubNeonApi(({ cypher }) => {
      if (cypher.includes('apoc.meta.stats')) {
        apocCalled++;
        throw new NeonError({
          code: NEON_ERROR_CODES.QUERY,
          message: "There is no procedure with the name 'apoc.meta.stats'",
        });
      }
      if (cypher.startsWith("MATCH (n:Item) RETURN 'Item'")) {
        fallbackCalled++;
        return [
          { kind: 'Item', count: 42 },
          { kind: 'Space', count: 0 },
          { kind: 'Agent', count: 0 },
        ];
      }
      if (cypher.includes('PRODUCED_BY')) return [];
      if (cypher.includes('agentCount')) return [{ agentCount: 0 }];
      if (cypher.includes('itemCount')) return [{ spaceCount: 0, itemCount: 42 }];
      return [];
    });
    _setNeonApiForTesting(api);

    const results = await runDiscovery();

    expect(apocCalled).toBe(1);
    expect(fallbackCalled).toBe(1);
    expect(calls.length).toBe(5); // 1 APOC + 1 fallback + Q2 + Q3 + Q4

    const q1 = results.results.find((r) => r.id === 'Q1');
    expect(q1?.ok).toBe(true);
    expect(q1?.notes.some((n) => n.includes('APOC unavailable'))).toBe(true);
    expect(q1?.cypher).toContain('UNION ALL');
  });
});

describe('runDiscovery — failure isolation + gating', () => {
  beforeEach(() => {
    _resetNeonApiForTesting();
  });

  it('continues the suite when one query fails (returns partial results)', async () => {
    const { api } = buildStubNeonApi(({ cypher }) => {
      if (cypher.includes('PRODUCED_BY')) {
        throw new NeonError({
          code: NEON_ERROR_CODES.NETWORK,
          message: 'fetch failed',
        });
      }
      if (cypher.includes('apoc.meta.stats')) {
        return [{ labels: { Item: 1 } }];
      }
      if (cypher.includes('agentCount')) return [{ agentCount: 0 }];
      if (cypher.includes('itemCount')) return [{ spaceCount: 0, itemCount: 1 }];
      return [];
    });
    _setNeonApiForTesting(api);

    const results = await runDiscovery();

    expect(results.results.length).toBe(4);
    expect(results.anyFailures).toBe(true);
    // Q2 is INFORMATIONAL, so gatingFailures should be false.
    expect(results.gatingFailures).toBe(false);
    const q2 = results.results.find((r) => r.id === 'Q2');
    expect(q2?.ok).toBe(false);
    expect(q2?.error?.code).toBe(NEON_ERROR_CODES.NETWORK);
  });

  it('marks gatingFailures=true when a GATING query fails', async () => {
    const { api } = buildStubNeonApi(({ cypher }) => {
      // Q4 (GATING) fails.
      if (cypher.includes('count(i) AS itemCount')) {
        throw new NeonError({
          code: NEON_ERROR_CODES.NOT_CONFIGURED,
          message: 'neon not configured',
        });
      }
      if (cypher.includes('apoc.meta.stats')) {
        return [{ labels: { Item: 1 } }];
      }
      if (cypher.includes('PRODUCED_BY')) return [];
      if (cypher.includes('agentCount')) return [{ agentCount: 0 }];
      return [];
    });
    _setNeonApiForTesting(api);

    const results = await runDiscovery();

    expect(results.gatingFailures).toBe(true);
    expect(results.anyFailures).toBe(true);
    const q4 = results.results.find((r) => r.id === 'Q4');
    expect(q4?.ok).toBe(false);
    expect(q4?.gating).toBe('GATING');
  });
});
