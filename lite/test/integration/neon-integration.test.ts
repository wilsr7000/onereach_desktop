/**
 * Neon integration tests -- real EdisonNeonClient against an
 * in-memory HTTP server. Exercises the actual wire format
 * (POST /omnidata/neon with `neonUri`/`neonUser`/`neonPassword`
 * in the body) so the harness catches wire-format regressions
 * that pure mocks miss.
 *
 * Also covers the KVCredentialsProvider end-to-end against the
 * real in-memory KV server: configure() -> KV write -> next query
 * picks up the new credentials without any in-memory caching trick.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { EdisonNeonClient } from '../../neon/client.js';
import { NEON_ERROR_CODES } from '../../neon/errors.js';
import {
  KVCredentialsProvider,
  StaticCredentialsProvider,
} from '../../neon/credentials.js';
import {
  startInMemoryKVServer,
  type InMemoryKVServer,
} from '../harness/index.js';
import { _resetKVApiForTesting, _setKVApiForTesting, getKVApi } from '../../kv/api.js';
import { EdisonKVClient } from '../../kv/client.js';

// ---------------------------------------------------------------------------
// In-memory Neon endpoint -- a tiny http server that records the most
// recent request and returns whatever shape the test wires up.
// ---------------------------------------------------------------------------

interface FakeNeonRequest {
  method: string;
  url: string;
  body: string;
  parsedBody: Record<string, unknown> | null;
}

interface FakeNeonServer {
  url: string;
  lastRequest: FakeNeonRequest | null;
  /** Set the next response sent to the client. */
  setNext(response: { status: number; body: string }): void;
  stop(): Promise<void>;
}

async function startFakeNeonServer(): Promise<FakeNeonServer> {
  let next: { status: number; body: string } = { status: 200, body: '{"records":[]}' };
  let lastRequest: FakeNeonRequest | null = null;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      lastRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        body,
        parsedBody: parsed,
      };
      res.writeHead(next.status, { 'Content-Type': 'application/json' });
      res.end(next.body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('failed to bind');
  const url = `http://127.0.0.1:${addr.port}/omnidata/neon`;

  return {
    url,
    get lastRequest() {
      return lastRequest;
    },
    setNext(response) {
      next = response;
    },
    stop() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err !== undefined && err !== null ? reject(err) : resolve()));
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Tests: client + static provider
// ---------------------------------------------------------------------------

describe('EdisonNeonClient + StaticCredentialsProvider against fake endpoint', () => {
  let neon: FakeNeonServer;

  beforeEach(async () => {
    neon = await startFakeNeonServer();
  });

  afterEach(async () => {
    await neon.stop();
  });

  it('sends the exact /omnidata/neon body shape on query()', async () => {
    const provider = new StaticCredentialsProvider({
      endpoint: neon.url,
      uri: 'neo4j+s://abc.databases.neo4j.io',
      user: 'neo4j',
      password: 'secret-pw',
      database: 'neo4j',
    });
    const client = new EdisonNeonClient({ credentials: provider, timeoutMs: 2000 });

    neon.setNext({ status: 200, body: '{"records":[{"ok":1}]}' });
    const records = await client.query('RETURN 1 AS ok');
    expect(records).toEqual([{ ok: 1 }]);

    expect(neon.lastRequest?.method).toBe('POST');
    const body = neon.lastRequest?.parsedBody;
    expect(body).toMatchObject({
      cypher: 'RETURN 1 AS ok',
      parameters: {},
      neonUri: 'neo4j+s://abc.databases.neo4j.io',
      neonUser: 'neo4j',
      neonPassword: 'secret-pw',
      database: 'neo4j',
    });
  });

  it('passes bound parameters through to the proxy', async () => {
    const provider = new StaticCredentialsProvider({
      endpoint: neon.url,
      uri: 'neo4j+s://x.databases.neo4j.io',
      password: 'p',
    });
    const client = new EdisonNeonClient({ credentials: provider, timeoutMs: 2000 });

    neon.setNext({ status: 200, body: '{"records":[]}' });
    await client.query('MATCH (p:Person {email: $email}) RETURN p', {
      email: 'rich@example.com',
    });

    const body = neon.lastRequest?.parsedBody;
    expect(body?.['parameters']).toEqual({ email: 'rich@example.com' });
  });

  it('raises NEON_HTTP with status when the endpoint returns 500', async () => {
    const provider = new StaticCredentialsProvider({
      endpoint: neon.url,
      uri: 'neo4j+s://x.databases.neo4j.io',
      password: 'p',
    });
    const client = new EdisonNeonClient({ credentials: provider, timeoutMs: 2000 });

    neon.setNext({ status: 500, body: 'Server boom' });
    await expect(client.query('RETURN 1')).rejects.toMatchObject({
      code: NEON_ERROR_CODES.HTTP,
      status: 500,
    });
  });

  it('raises NEON_QUERY when proxy returns 200 with an error field', async () => {
    const provider = new StaticCredentialsProvider({
      endpoint: neon.url,
      uri: 'neo4j+s://x.databases.neo4j.io',
      password: 'p',
    });
    const client = new EdisonNeonClient({ credentials: provider, timeoutMs: 2000 });

    neon.setNext({
      status: 200,
      body: JSON.stringify({ error: 'Cypher syntax error' }),
    });
    await expect(client.query('MATCH bogus')).rejects.toMatchObject({
      code: NEON_ERROR_CODES.QUERY,
    });
  });

  it('ping() round-trips against the fake endpoint', async () => {
    const provider = new StaticCredentialsProvider({
      endpoint: neon.url,
      uri: 'neo4j+s://x.databases.neo4j.io',
      password: 'p',
    });
    const client = new EdisonNeonClient({ credentials: provider, timeoutMs: 2000 });

    neon.setNext({ status: 200, body: '{"records":[{"ok":1}]}' });
    expect(await client.ping()).toBe(true);
    expect(neon.lastRequest?.parsedBody?.['cypher']).toBe('RETURN 1 AS ok');
  });
});

// ---------------------------------------------------------------------------
// Tests: client + KVCredentialsProvider against the real KV server
// ---------------------------------------------------------------------------

describe('KVCredentialsProvider end-to-end with real KV server', () => {
  let kvServer: InMemoryKVServer;
  let neonServer: FakeNeonServer;

  beforeEach(async () => {
    _resetKVApiForTesting();
    kvServer = await startInMemoryKVServer();
    neonServer = await startFakeNeonServer();
    _setKVApiForTesting(
      new EdisonKVClient({
        url: `${kvServer.url}/keyvalue`,
        timeoutMs: 1000,
      })
    );
  });

  afterEach(async () => {
    await neonServer.stop();
    await kvServer.stop();
    _resetKVApiForTesting();
  });

  it('write() persists; subsequent get()/getEndpoint() reflect the new value', async () => {
    const provider = new KVCredentialsProvider({ kvApi: getKVApi() });

    expect(await provider.getEndpoint()).toBeNull();
    expect(await provider.get()).toBeNull();

    await provider.write({
      endpoint: neonServer.url,
      uri: 'neo4j+s://x.databases.neo4j.io',
      password: 'pw-1',
    });

    expect(await provider.getEndpoint()).toBe(neonServer.url);
    expect(await provider.get()).toEqual({
      kind: 'basic-in-body',
      uri: 'neo4j+s://x.databases.neo4j.io',
      user: 'neo4j',
      password: 'pw-1',
      database: 'neo4j',
    });
  });

  it('client+KVProvider full path: configure -> query against fake endpoint', async () => {
    const provider = new KVCredentialsProvider({ kvApi: getKVApi() });
    const client = new EdisonNeonClient({ credentials: provider, timeoutMs: 2000 });

    await provider.write({
      endpoint: neonServer.url,
      uri: 'neo4j+s://x.databases.neo4j.io',
      password: 'pw',
    });

    neonServer.setNext({ status: 200, body: '{"records":[{"hello":"world"}]}' });
    const records = await client.query('RETURN "world" AS hello');
    expect(records).toEqual([{ hello: 'world' }]);
    expect(neonServer.lastRequest?.parsedBody?.['neonPassword']).toBe('pw');
  });

  it('write() with password change is reflected in the next query', async () => {
    const provider = new KVCredentialsProvider({ kvApi: getKVApi() });
    const client = new EdisonNeonClient({ credentials: provider, timeoutMs: 2000 });

    await provider.write({
      endpoint: neonServer.url,
      uri: 'neo4j+s://x.databases.neo4j.io',
      password: 'old-pw',
    });

    neonServer.setNext({ status: 200, body: '{"records":[]}' });
    await client.query('RETURN 1');
    expect(neonServer.lastRequest?.parsedBody?.['neonPassword']).toBe('old-pw');

    await provider.write({ password: 'new-pw' });

    neonServer.setNext({ status: 200, body: '{"records":[]}' });
    await client.query('RETURN 1');
    expect(neonServer.lastRequest?.parsedBody?.['neonPassword']).toBe('new-pw');
  });

  it('readPublic() reflects KV state without leaking the password', async () => {
    const provider = new KVCredentialsProvider({ kvApi: getKVApi() });
    await provider.write({
      endpoint: neonServer.url,
      uri: 'neo4j+s://x.databases.neo4j.io',
      password: 'top-secret-12345',
    });
    const pub = await provider.readPublic();
    expect(pub).toMatchObject({
      endpoint: neonServer.url,
      uri: 'neo4j+s://x.databases.neo4j.io',
      hasPassword: true,
    });
    expect(JSON.stringify(pub)).not.toContain('top-secret-12345');
  });
});
