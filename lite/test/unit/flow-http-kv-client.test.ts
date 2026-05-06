/**
 * FlowHttpKVClient unit tests.
 *
 * Verifies the per-account flow KV transport:
 *   - Fetches a FLOW token from /refresh_token before each call (cached).
 *   - Prefixes "FLOW " on the Authorization header.
 *   - Hits the right URL shape (`/http/{accountId}/keyvalue`).
 *   - Maps server responses to the same KVApi semantics as the SDK client.
 *   - Reclassifies stale-token errors and fires onAuthRejected.
 *
 * Network is stubbed via a fetch impl that records requests + returns
 * canned responses. No real HTTP.
 */

import { describe, it, expect } from 'vitest';
import { FlowHttpKVClient, FLOW_TOKEN_TTL_MS } from '../../kv/flow-http-client.js';
import { KVError, KV_ERROR_CODES } from '../../kv/client.js';

// ─── fetch stub ────────────────────────────────────────────────────────────

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface FakeResponseSpec {
  status?: number;
  body?: unknown;
  bodyText?: string;
}

class FetchStub {
  public readonly requests: RecordedRequest[] = [];
  /** Per-call queue of responses, in order. Reset per test. */
  public responses: FakeResponseSpec[] = [];

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers instanceof Headers) {
      init.headers.forEach((v, k) => {
        headers[k] = v;
      });
    } else if (Array.isArray(init?.headers)) {
      for (const [k, v] of init.headers) headers[k] = v;
    } else if (init?.headers !== undefined) {
      Object.assign(headers, init.headers as Record<string, string>);
    }
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const recorded: RecordedRequest = { url, method, headers };
    if (body !== undefined) recorded.body = body;
    this.requests.push(recorded);

    const spec = this.responses.shift();
    if (spec === undefined) {
      throw new Error(`FetchStub: no canned response for ${method} ${url}`);
    }
    const status = spec.status ?? 200;
    const text =
      spec.bodyText !== undefined
        ? spec.bodyText
        : spec.body !== undefined
          ? JSON.stringify(spec.body)
          : '';
    return makeResponse(status, text);
  };
}

function makeResponse(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ACCOUNT_ID = '35254342-4a2e-475b-aec1-18547e517e29';

function makeClient(opts: {
  accountId?: string | null;
  baseUrl?: string;
  onAuthRejected?: (reason: string) => void;
  now?: () => number;
} = {}): { client: FlowHttpKVClient; stub: FetchStub } {
  const stub = new FetchStub();
  const config: ConstructorParameters<typeof FlowHttpKVClient>[0] = {
    accountId: () => (opts.accountId === undefined ? ACCOUNT_ID : opts.accountId),
    fetchImpl: stub.fetch,
    baseUrl: opts.baseUrl ?? 'https://em.edison.api.onereach.ai',
  };
  if (opts.onAuthRejected !== undefined) config.onAuthRejected = opts.onAuthRejected;
  if (opts.now !== undefined) config.now = opts.now;
  const client = new FlowHttpKVClient(config);
  return { client, stub };
}

// ─── Token acquisition + caching ───────────────────────────────────────────

describe('FlowHttpKVClient token acquisition', () => {
  it('fetches a FLOW token from /refresh_token before the first KV call', async () => {
    const { client, stub } = makeClient();
    stub.responses = [
      { body: { token: 'abc123' } }, // refresh_token
      { status: 404 }, // get -> 404 -> null
    ];
    await client.get('lite-tool-entries', 'default');
    expect(stub.requests).toHaveLength(2);
    expect(stub.requests[0]?.url).toBe(
      `https://em.edison.api.onereach.ai/http/${ACCOUNT_ID}/refresh_token`
    );
    expect(stub.requests[0]?.method).toBe('GET');
  });

  it('prefixes "FLOW " on the Authorization header', async () => {
    const { client, stub } = makeClient();
    stub.responses = [
      { body: { token: 'abc123' } },
      { status: 404 },
    ];
    await client.get('coll', 'k');
    expect(stub.requests[1]?.headers['Authorization']).toBe('FLOW abc123');
  });

  it('honors a token that already starts with "FLOW "', async () => {
    const { client, stub } = makeClient();
    stub.responses = [
      { body: { token: 'FLOW abc123' } },
      { status: 404 },
    ];
    await client.get('coll', 'k');
    expect(stub.requests[1]?.headers['Authorization']).toBe('FLOW abc123');
  });

  it('falls back to access_token when token field is absent', async () => {
    const { client, stub } = makeClient();
    stub.responses = [
      { body: { access_token: 'xyz789' } },
      { status: 404 },
    ];
    await client.get('coll', 'k');
    expect(stub.requests[1]?.headers['Authorization']).toBe('FLOW xyz789');
  });

  it('caches the token across calls (one /refresh_token for many KV ops)', async () => {
    const { client, stub } = makeClient();
    stub.responses = [
      { body: { token: 'abc' } }, // refresh_token (fired once)
      { status: 404 },             // get 1
      { status: 404 },             // get 2
      { status: 404 },             // get 3
    ];
    await client.get('c', 'k1');
    await client.get('c', 'k2');
    await client.get('c', 'k3');
    const refreshTokenCalls = stub.requests.filter((r) =>
      r.url.endsWith('/refresh_token')
    );
    expect(refreshTokenCalls).toHaveLength(1);
  });

  it('refreshes the token after TTL expires', async () => {
    let now = 1_000_000;
    const { client, stub } = makeClient({ now: () => now });
    stub.responses = [
      { body: { token: 'first' } },
      { status: 404 },
      { body: { token: 'second' } },
      { status: 404 },
    ];
    await client.get('c', 'k1');
    now += FLOW_TOKEN_TTL_MS + 1;
    await client.get('c', 'k2');
    const refreshes = stub.requests.filter((r) => r.url.endsWith('/refresh_token'));
    expect(refreshes).toHaveLength(2);
    // Second KV call should use the new token.
    const kvCalls = stub.requests.filter((r) => r.url.includes('/keyvalue'));
    expect(kvCalls[1]?.headers['Authorization']).toBe('FLOW second');
  });

  it('refreshes the token when the active accountId changes', async () => {
    let accountId: string | null = ACCOUNT_ID;
    const stub = new FetchStub();
    const client = new FlowHttpKVClient({
      accountId: () => accountId,
      fetchImpl: stub.fetch,
      baseUrl: 'https://em.edison.api.onereach.ai',
    });
    stub.responses = [
      { body: { token: 'first' } },
      { status: 404 },
      { body: { token: 'second' } },
      { status: 404 },
    ];
    await client.get('c', 'k1');
    accountId = '11111111-2222-3333-4444-555555555555';
    await client.get('c', 'k2');
    const refreshes = stub.requests.filter((r) => r.url.endsWith('/refresh_token'));
    expect(refreshes).toHaveLength(2);
    expect(refreshes[1]?.url).toContain('/11111111-2222-');
  });

  it('coalesces concurrent first-time refreshes into a single network call', async () => {
    const { client, stub } = makeClient();
    stub.responses = [
      { body: { token: 'abc' } }, // single refresh_token even with 5 parallel get()s
      { status: 404 },
      { status: 404 },
      { status: 404 },
      { status: 404 },
      { status: 404 },
    ];
    await Promise.all([
      client.get('c', 'k1'),
      client.get('c', 'k2'),
      client.get('c', 'k3'),
      client.get('c', 'k4'),
      client.get('c', 'k5'),
    ]);
    const refreshes = stub.requests.filter((r) => r.url.endsWith('/refresh_token'));
    expect(refreshes).toHaveLength(1);
  });

  it('throws KVError 401 when refresh_token returns non-200', async () => {
    const { client, stub } = makeClient();
    stub.responses = [{ status: 500, body: { error: 'flow not deployed' } }];
    await expect(client.get('c', 'k')).rejects.toMatchObject({
      code: KV_ERROR_CODES.HTTP,
      status: 500,
    });
  });

  it('throws KVError 401 when accountId is null (signed-out)', async () => {
    const { client } = makeClient({ accountId: null });
    await expect(client.get('c', 'k')).rejects.toMatchObject({
      code: KV_ERROR_CODES.HTTP,
      status: 401,
    });
  });
});

// ─── KV operation wire format ──────────────────────────────────────────────

describe('FlowHttpKVClient.set', () => {
  it('PUTs to /keyvalue?id=...&key=... with body { id, key, value }', async () => {
    const { client, stub } = makeClient();
    stub.responses = [
      { body: { token: 'abc' } },
      { status: 200, body: { ok: true } },
    ];
    await client.set('lite-tool-entries', 'default', { foo: 'bar' });
    const req = stub.requests[1];
    expect(req?.method).toBe('PUT');
    expect(req?.url).toBe(
      `https://em.edison.api.onereach.ai/http/${ACCOUNT_ID}/keyvalue?id=lite-tool-entries&key=default`
    );
    expect(JSON.parse(req?.body ?? '{}')).toEqual({
      id: 'lite-tool-entries',
      key: 'default',
      value: { foo: 'bar' },
    });
  });

  it('URL-encodes collection + key', async () => {
    const { client, stub } = makeClient();
    stub.responses = [
      { body: { token: 'abc' } },
      { status: 200, body: { ok: true } },
    ];
    await client.set('weird/coll', 'edison:abc-123', {});
    expect(stub.requests[1]?.url).toContain(
      'id=weird%2Fcoll&key=edison%3Aabc-123'
    );
  });
});

describe('FlowHttpKVClient.get', () => {
  it('returns null on HTTP 404', async () => {
    const { client, stub } = makeClient();
    stub.responses = [
      { body: { token: 'abc' } },
      { status: 404 },
    ];
    expect(await client.get('c', 'k')).toBeNull();
  });

  it('returns null on the "No data found." sentinel', async () => {
    const { client, stub } = makeClient();
    stub.responses = [
      { body: { token: 'abc' } },
      { status: 200, body: { Status: 'No data found.' } },
    ];
    expect(await client.get('c', 'k')).toBeNull();
  });

  it('parses { value: ... } shape', async () => {
    const { client, stub } = makeClient();
    stub.responses = [
      { body: { token: 'abc' } },
      { status: 200, body: { value: { foo: 'bar' } } },
    ];
    expect(await client.get('c', 'k')).toEqual({ foo: 'bar' });
  });

  it('parses { get: { value } } shape', async () => {
    const { client, stub } = makeClient();
    stub.responses = [
      { body: { token: 'abc' } },
      { status: 200, body: { get: { value: 'hello' } } },
    ];
    expect(await client.get('c', 'k')).toBe('hello');
  });

  it('parses double-encoded inner JSON strings', async () => {
    const { client, stub } = makeClient();
    stub.responses = [
      { body: { token: 'abc' } },
      { status: 200, body: { value: '{"nested":true}' } },
    ];
    expect(await client.get('c', 'k')).toEqual({ nested: true });
  });
});

describe('FlowHttpKVClient.listKeys', () => {
  it('POSTs to /keyvalue with body { id: collection } and parses records[]', async () => {
    const { client, stub } = makeClient();
    stub.responses = [
      { body: { token: 'abc' } },
      {
        status: 200,
        body: { records: [{ key: 'a' }, { key: 'b' }, 'c'] },
      },
    ];
    expect(await client.listKeys('c')).toEqual(['a', 'b', 'c']);
    const req = stub.requests[1];
    expect(req?.method).toBe('POST');
    expect(JSON.parse(req?.body ?? '{}')).toEqual({ id: 'c' });
  });
});

describe('FlowHttpKVClient.delete', () => {
  it('DELETEs /keyvalue?id=...&key=...', async () => {
    const { client, stub } = makeClient();
    stub.responses = [
      { body: { token: 'abc' } },
      { status: 200, body: { ok: true } },
    ];
    await client.delete('c', 'k');
    expect(stub.requests[1]?.method).toBe('DELETE');
  });

  it('treats 404 on delete as idempotent success', async () => {
    const { client, stub } = makeClient();
    stub.responses = [
      { body: { token: 'abc' } },
      { status: 404 },
    ];
    await expect(client.delete('c', 'k')).resolves.toBeUndefined();
  });
});

// ─── Auth-rejection signaling ──────────────────────────────────────────────

describe('FlowHttpKVClient onAuthRejected', () => {
  it('fires when KV returns HTTP 401', async () => {
    const rejected: string[] = [];
    const { client, stub } = makeClient({ onAuthRejected: (r) => rejected.push(r) });
    stub.responses = [
      { body: { token: 'abc' } },
      { status: 401, bodyText: 'Token was not accepted: wrong keyId' },
    ];
    await expect(client.set('c', 'k', {})).rejects.toMatchObject({
      code: KV_ERROR_CODES.HTTP,
      status: 401,
    });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain('wrong keyId');
  });

  it('fires when KV returns 200 but body contains "Token was not accepted" (legacy flow shape)', async () => {
    const rejected: string[] = [];
    const { client, stub } = makeClient({ onAuthRejected: (r) => rejected.push(r) });
    stub.responses = [
      { body: { token: 'abc' } },
      // The flow KV occasionally returns 4xx as 200+body. Detect by body content.
      { status: 400, bodyText: 'wrong keyId' },
    ];
    await expect(client.set('c', 'k', {})).rejects.toBeInstanceOf(KVError);
    expect(rejected).toHaveLength(1);
  });

  it('does not fire on 5xx server errors', async () => {
    const rejected: string[] = [];
    const { client, stub } = makeClient({ onAuthRejected: (r) => rejected.push(r) });
    stub.responses = [
      { body: { token: 'abc' } },
      { status: 503, bodyText: 'service unavailable' },
    ];
    await expect(client.set('c', 'k', {})).rejects.toMatchObject({
      code: KV_ERROR_CODES.HTTP,
      status: 503,
    });
    expect(rejected).toEqual([]);
  });

  it('drops the cached token on 401 so the next call refreshes', async () => {
    const { client, stub } = makeClient();
    stub.responses = [
      { body: { token: 'first' } },
      { status: 401, bodyText: 'Token was not accepted' },
      { body: { token: 'second' } },
      { status: 200, body: { ok: true } },
    ];
    await expect(client.set('c', 'k', {})).rejects.toBeInstanceOf(KVError);
    await client.set('c', 'k', {});
    const refreshes = stub.requests.filter((r) => r.url.endsWith('/refresh_token'));
    expect(refreshes).toHaveLength(2);
    const kvCalls = stub.requests.filter((r) => r.url.includes('/keyvalue'));
    expect(kvCalls[1]?.headers['Authorization']).toBe('FLOW second');
  });
});
