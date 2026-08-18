/**
 * ADR-070 — the NEON access standard's Lite half: every query leaves
 * EdisonNeonClient wearing its caller tag, exactly once, overridable by
 * config. The tag is what makes SHOW TRANSACTIONS / the Aura query log
 * self-attributing during the next "who is calling like crazy".
 */
import { describe, it, expect, vi } from 'vitest';
import { EdisonNeonClient } from '../../neon/client.js';
import { StaticCredentialsProvider, normalizeNeonEndpoint } from '../../neon/credentials.js';

const ENDPOINT = 'https://example.com/neon';

function provider(): StaticCredentialsProvider {
  return new StaticCredentialsProvider({
    endpoint: ENDPOINT,
    uri: 'neo4j+s://abc.databases.neo4j.io',
    user: 'neo4j',
    password: 'secret',
    database: 'neo4j',
  });
}

function harness(callerTag?: string): { client: EdisonNeonClient; sentCypher: () => string } {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify({ records: [{ ok: 1 }] })),
  } as unknown as Response);
  const client = new EdisonNeonClient({
    credentials: provider(),
    fetchImpl: fetchMock as unknown as typeof fetch,
    ...(callerTag !== undefined ? { callerTag } : {}),
  });
  return {
    client,
    sentCypher: (): string => {
      const [, init] = fetchMock.mock.calls[0]!;
      return (JSON.parse((init as { body: string }).body) as { cypher: string }).cypher;
    },
  };
}

describe('ADR-070 — caller tag on the wire', () => {
  it('prefixes every query with the default lite tag', async () => {
    const { client, sentCypher } = harness();
    await client.query('RETURN 1 AS ok');
    expect(sentCypher()).toBe('/* caller:onereach-lite */\nRETURN 1 AS ok');
  });

  it('honors a configured tag', async () => {
    const { client, sentCypher } = harness('lite-test-suite');
    await client.query('RETURN 1');
    expect(sentCypher()).toMatch(/^\/\* caller:lite-test-suite \*\//);
  });

  it('never double-tags an already-tagged query', async () => {
    const { client, sentCypher } = harness();
    await client.query('/* caller:upstream */\nRETURN 1');
    const cypher = sentCypher();
    expect(cypher.startsWith('/* caller:upstream */')).toBe(true);
    expect(cypher.match(/caller:/g)?.length).toBe(1);
  });
});

describe('normalizeNeonEndpoint — stale stored endpoints self-heal', () => {
  const BASE = 'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29';

  it('rewrites the dead pre-migration path', () => {
    expect(normalizeNeonEndpoint(`${BASE}/omnidata/neon`)).toBe(`${BASE}/omnidata/neon2`);
  });

  it('is idempotent on already-migrated endpoints', () => {
    expect(normalizeNeonEndpoint(`${BASE}/omnidata/neon2`)).toBe(`${BASE}/omnidata/neon2`);
  });

  it('leaves unrelated URLs and empty strings alone', () => {
    expect(normalizeNeonEndpoint('')).toBe('');
    expect(normalizeNeonEndpoint(`${BASE}/keyvalue2`)).toBe(`${BASE}/keyvalue2`);
    expect(normalizeNeonEndpoint(`${BASE}/omnidata/neonati`)).toBe(`${BASE}/omnidata/neonati`);
  });
});
