/**
 * EdisonNeonClient tests.
 *
 * Covers the HTTP wrapper directly: request body shape, response
 * normalization, every error code path, span emission, and provider
 * invalidation on 401.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EdisonNeonClient, buildRequest, extractRecords } from '../../neon/client.js';
import { NeonError, NEON_ERROR_CODES } from '../../neon/errors.js';
import { StaticCredentialsProvider, type CredentialsProvider } from '../../neon/credentials.js';

const ENDPOINT = 'https://example.com/neon';

function configuredProvider(overrides: Partial<{
  endpoint: string;
  uri: string;
  user: string;
  password: string;
  database: string;
}> = {}): StaticCredentialsProvider {
  return new StaticCredentialsProvider({
    endpoint: ENDPOINT,
    uri: 'neo4j+s://abc.databases.neo4j.io',
    user: 'neo4j',
    password: 'secret',
    database: 'neo4j',
    ...overrides,
  });
}

interface MockResponseInit {
  ok: boolean;
  status: number;
  text: string;
}

function makeResponse(init: MockResponseInit): Response {
  return {
    ok: init.ok,
    status: init.status,
    text: () => Promise.resolve(init.text),
  } as unknown as Response;
}

describe('EdisonNeonClient.query happy path', () => {
  it('POSTs to the endpoint with the basic-in-body shape', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        makeResponse({ ok: true, status: 200, text: JSON.stringify({ records: [{ ok: 1 }] }) })
      );
    const client = new EdisonNeonClient({
      credentials: configuredProvider(),
      fetchImpl: fetchMock,
    });

    const records = await client.query('RETURN 1 AS ok');

    expect(records).toEqual([{ ok: 1 }]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(ENDPOINT);
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string);
    expect(body.cypher).toBe('RETURN 1 AS ok');
    expect(body.parameters).toEqual({});
    expect(body.neonUri).toBe('neo4j+s://abc.databases.neo4j.io');
    expect(body.neonUser).toBe('neo4j');
    expect(body.neonPassword).toBe('secret');
    expect(body.database).toBe('neo4j');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('passes parameters through verbatim', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResponse({ ok: true, status: 200, text: '{"records":[]}' }));
    const client = new EdisonNeonClient({
      credentials: configuredProvider(),
      fetchImpl: fetchMock,
    });
    await client.query('MATCH (p:Person {email: $email}) RETURN p', { email: 'a@b.c' });
    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(body.parameters).toEqual({ email: 'a@b.c' });
  });

  it('accepts the inline records[] response shape', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResponse({ ok: true, status: 200, text: '[{"a":1},{"a":2}]' }));
    const client = new EdisonNeonClient({
      credentials: configuredProvider(),
      fetchImpl: fetchMock,
    });
    const records = await client.query('MATCH (n) RETURN n.a AS a');
    expect(records).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('accepts the wrapped result.records response shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        ok: true,
        status: 200,
        text: JSON.stringify({ result: { records: [{ x: 'y' }] } }),
      })
    );
    const client = new EdisonNeonClient({
      credentials: configuredProvider(),
      fetchImpl: fetchMock,
    });
    const records = await client.query('RETURN "y" AS x');
    expect(records).toEqual([{ x: 'y' }]);
  });
});

describe('EdisonNeonClient.query error paths', () => {
  it('NEON_BAD_INPUT for empty cypher', async () => {
    const client = new EdisonNeonClient({ credentials: configuredProvider(), fetchImpl: vi.fn() });
    await expect(client.query('')).rejects.toMatchObject({
      code: NEON_ERROR_CODES.BAD_INPUT,
    });
    await expect(client.query('  ')).rejects.toMatchObject({
      code: NEON_ERROR_CODES.BAD_INPUT,
    });
  });

  it('NEON_NOT_CONFIGURED when endpoint is missing', async () => {
    const client = new EdisonNeonClient({
      credentials: new StaticCredentialsProvider({ uri: 'x', password: 'y' }),
      fetchImpl: vi.fn(),
    });
    await expect(client.query('RETURN 1')).rejects.toMatchObject({
      code: NEON_ERROR_CODES.NOT_CONFIGURED,
    });
  });

  it('NEON_NOT_CONFIGURED when password is missing', async () => {
    const client = new EdisonNeonClient({
      credentials: new StaticCredentialsProvider({ endpoint: ENDPOINT, uri: 'x' }),
      fetchImpl: vi.fn(),
    });
    await expect(client.query('RETURN 1')).rejects.toMatchObject({
      code: NEON_ERROR_CODES.NOT_CONFIGURED,
    });
  });

  it('NEON_HTTP for non-OK status', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResponse({ ok: false, status: 500, text: 'oops' }));
    const client = new EdisonNeonClient({
      credentials: configuredProvider(),
      fetchImpl: fetchMock,
    });
    await expect(client.query('RETURN 1')).rejects.toMatchObject({
      code: NEON_ERROR_CODES.HTTP,
      status: 500,
    });
  });

  it('NEON_HTTP carries 4xx status with the right remediation', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResponse({ ok: false, status: 401, text: 'auth' }));
    const client = new EdisonNeonClient({
      credentials: configuredProvider(),
      fetchImpl: fetchMock,
    });
    try {
      await client.query('RETURN 1');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NeonError);
      const ne = err as NeonError;
      expect(ne.code).toBe(NEON_ERROR_CODES.HTTP);
      expect(ne.status).toBe(401);
      expect(ne.remediation).toMatch(/credentials/i);
    }
  });

  it('NEON_NETWORK for fetch-level rejection', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    const client = new EdisonNeonClient({
      credentials: configuredProvider(),
      fetchImpl: fetchMock,
    });
    await expect(client.query('RETURN 1')).rejects.toMatchObject({
      code: NEON_ERROR_CODES.NETWORK,
    });
  });

  it('NEON_TIMEOUT when the fetch aborts', async () => {
    const fetchMock = vi.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        (init as { signal: AbortSignal }).signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const client = new EdisonNeonClient({
      credentials: configuredProvider(),
      fetchImpl: fetchMock,
      timeoutMs: 10,
    });
    await expect(client.query('RETURN 1')).rejects.toMatchObject({
      code: NEON_ERROR_CODES.TIMEOUT,
    });
  });

  it('NEON_QUERY when server returns 200 with an error field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        ok: true,
        status: 200,
        text: JSON.stringify({ error: 'Cypher syntax error: unexpected token' }),
      })
    );
    const client = new EdisonNeonClient({
      credentials: configuredProvider(),
      fetchImpl: fetchMock,
    });
    await expect(client.query('MATCH bogus')).rejects.toMatchObject({
      code: NEON_ERROR_CODES.QUERY,
    });
  });

  it('NEON_HTTP when response body is not JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ ok: true, status: 200, text: 'not json {' })
    );
    const client = new EdisonNeonClient({
      credentials: configuredProvider(),
      fetchImpl: fetchMock,
    });
    await expect(client.query('RETURN 1')).rejects.toMatchObject({
      code: NEON_ERROR_CODES.HTTP,
    });
  });

  it('calls credentials.invalidate on 401 when defined', async () => {
    const invalidate = vi.fn();
    const provider: CredentialsProvider = {
      get: () =>
        Promise.resolve({
          kind: 'basic-in-body',
          uri: 'x',
          user: 'neo4j',
          password: 'p',
          database: 'neo4j',
        }),
      getEndpoint: () => Promise.resolve(ENDPOINT),
      readPublic: () =>
        Promise.resolve({
          endpoint: ENDPOINT,
          uri: 'x',
          user: 'neo4j',
          database: 'neo4j',
          hasPassword: true,
        }),
      write: () => Promise.resolve(),
      invalidate,
    };
    const client = new EdisonNeonClient({
      credentials: provider,
      fetchImpl: vi.fn().mockResolvedValue(makeResponse({ ok: false, status: 401, text: '' })),
    });
    await expect(client.query('RETURN 1')).rejects.toMatchObject({ status: 401 });
    expect(invalidate).toHaveBeenCalledOnce();
  });
});

describe('EdisonNeonClient.ping', () => {
  it('returns true for {records:[{ok:1}]}', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResponse({ ok: true, status: 200, text: '{"records":[{"ok":1}]}' }));
    const client = new EdisonNeonClient({
      credentials: configuredProvider(),
      fetchImpl: fetchMock,
    });
    expect(await client.ping()).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(body.cypher).toBe('RETURN 1 AS ok');
  });

  it('returns false when ok is missing or wrong', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResponse({ ok: true, status: 200, text: '{"records":[]}' }));
    const client = new EdisonNeonClient({
      credentials: configuredProvider(),
      fetchImpl: fetchMock,
    });
    expect(await client.ping()).toBe(false);
  });
});

describe('EdisonNeonClient.status', () => {
  it('returns ready=false when nothing is configured', async () => {
    const client = new EdisonNeonClient({
      credentials: new StaticCredentialsProvider(),
      fetchImpl: vi.fn(),
    });
    const status = await client.status();
    expect(status.ready).toBe(false);
    expect(status.endpoint).toBeNull();
    expect(status.hasPassword).toBe(false);
  });

  it('returns ready=true when endpoint+uri+password set', async () => {
    const client = new EdisonNeonClient({
      credentials: configuredProvider(),
      fetchImpl: vi.fn(),
    });
    const status = await client.status();
    expect(status.ready).toBe(true);
    expect(status.endpoint).toBe(ENDPOINT);
    expect(status.uri).toBe('neo4j+s://abc.databases.neo4j.io');
    expect(status.hasPassword).toBe(true);
  });

  it('never includes the password in any field', async () => {
    const client = new EdisonNeonClient({
      credentials: configuredProvider({ password: 'super-secret-12345' }),
      fetchImpl: vi.fn(),
    });
    const status = await client.status();
    const json = JSON.stringify(status);
    expect(json).not.toContain('super-secret-12345');
  });
});

describe('buildRequest -- forward-secure switch', () => {
  it('embeds basic-in-body credentials in the request body', () => {
    const { url, init } = buildRequest(
      ENDPOINT,
      {
        kind: 'basic-in-body',
        uri: 'neo4j+s://x',
        user: 'u',
        password: 'p',
        database: 'd',
      },
      'RETURN 1',
      { foo: 'bar' },
      new AbortController().signal
    );
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      cypher: 'RETURN 1',
      parameters: { foo: 'bar' },
      neonUri: 'neo4j+s://x',
      neonUser: 'u',
      neonPassword: 'p',
      database: 'd',
    });
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    // Bearer header MUST NOT be present.
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('emits Authorization: Bearer for the bearer credentials variant', () => {
    const { init } = buildRequest(
      ENDPOINT,
      { kind: 'bearer', token: 'tok-abc', database: 'neo4j' },
      'RETURN 1',
      {},
      new AbortController().signal
    );
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok-abc');
    const body = JSON.parse(init.body as string);
    // Bearer body OMITs neon* fields.
    expect(body.neonUri).toBeUndefined();
    expect(body.neonUser).toBeUndefined();
    expect(body.neonPassword).toBeUndefined();
    expect(body.database).toBe('neo4j');
  });
});

describe('extractRecords -- response shape normalization', () => {
  it('handles records[] field', () => {
    expect(extractRecords({ records: [{ a: 1 }] })).toEqual([{ a: 1 }]);
  });
  it('handles result: records[] nesting', () => {
    expect(extractRecords({ result: { records: [{ a: 1 }] } })).toEqual([{ a: 1 }]);
  });
  it('handles result as a bare array', () => {
    expect(extractRecords({ result: [{ a: 1 }] })).toEqual([{ a: 1 }]);
  });
  it('handles a bare top-level array', () => {
    expect(extractRecords([{ a: 1 }, { b: 2 }])).toEqual([{ a: 1 }, { b: 2 }]);
  });
  it('returns [] for null / non-object / unknown shapes', () => {
    expect(extractRecords(null)).toEqual([]);
    expect(extractRecords('string')).toEqual([]);
    expect(extractRecords({ unknown: 'shape' })).toEqual([]);
  });
});

describe('EdisonNeonClient span emission', () => {
  beforeEach(() => {
    /* nothing -- each test wires its own client */
  });

  it('calls spanEmitter for query with cypher preview + paramCount', async () => {
    const finish = vi.fn();
    const fail = vi.fn();
    const spanEmitter = vi.fn().mockReturnValue({
      name: 'neon.query',
      id: 's-1',
      finish,
      fail,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResponse({ ok: true, status: 200, text: '{"records":[]}' }));
    const client = new EdisonNeonClient({
      credentials: configuredProvider(),
      fetchImpl: fetchMock,
      spanEmitter: spanEmitter as never,
    });

    await client.query('MATCH (n) RETURN n', { a: 1, b: 2 });

    expect(spanEmitter).toHaveBeenCalledWith('neon.query', {
      cypher: 'MATCH (n) RETURN n',
      paramCount: 2,
    });
    expect(finish).toHaveBeenCalledWith({ recordCount: 0 });
    expect(fail).not.toHaveBeenCalled();
  });

  it('calls span.fail when the request fails', async () => {
    const finish = vi.fn();
    const fail = vi.fn();
    const spanEmitter = vi.fn().mockReturnValue({
      name: 'neon.query',
      id: 's-1',
      finish,
      fail,
    });
    const client = new EdisonNeonClient({
      credentials: configuredProvider(),
      fetchImpl: vi.fn().mockRejectedValue(new Error('boom')),
      spanEmitter: spanEmitter as never,
    });
    await expect(client.query('RETURN 1')).rejects.toThrow();
    expect(fail).toHaveBeenCalledOnce();
    expect(finish).not.toHaveBeenCalled();
  });
});
