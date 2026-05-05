import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EdisonKVClient, KVError } from '../../kv/client.js';

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

describe('EdisonKVClient.set', () => {
  it('PUTs to ?id=collection&key=key with JSON-stringified itemValue', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ ok: true, status: 200, text: '' }));
    const client = new EdisonKVClient({ url: 'https://kv.test/keyvalue', fetchImpl: fetchMock });

    await client.set('lite-bugs', 'rec-1', { foo: 'bar' });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://kv.test/keyvalue?id=lite-bugs&key=rec-1');
    expect(init?.method).toBe('PUT');
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      id: 'lite-bugs',
      key: 'rec-1',
      itemValue: JSON.stringify({ foo: 'bar' }),
    });
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('url-encodes collection and key in query string', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ ok: true, status: 200, text: '' }));
    const client = new EdisonKVClient({ url: 'https://kv.test/keyvalue', fetchImpl: fetchMock });

    await client.set('my collection', '2026-05-04T00:00:00.000Z', {});

    const [url] = fetchMock.mock.calls[0]!;
    // URLSearchParams encodes ' ' as '+', and ':' / '.' need encoding too
    expect(url).toContain('id=my+collection');
    expect(url).toContain('key=2026-05-04T00%3A00%3A00.000Z');
  });

  it('throws KVError on non-OK status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ ok: false, status: 500, text: 'oops' }));
    const client = new EdisonKVClient({ url: 'https://kv.test/keyvalue', fetchImpl: fetchMock });
    await expect(client.set('lite-bugs', 'x', {})).rejects.toThrow(KVError);
  });

  it('throws KVError on network failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    const client = new EdisonKVClient({ url: 'https://kv.test/keyvalue', fetchImpl: fetchMock });
    await expect(client.set('lite-bugs', 'x', {})).rejects.toThrow(KVError);
  });

  it('throws KVError with timeout message when request aborts', async () => {
    const fetchMock = vi.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        (init as { signal: AbortSignal }).signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const client = new EdisonKVClient({
      url: 'https://kv.test/keyvalue',
      fetchImpl: fetchMock,
      timeoutMs: 10,
    });
    await expect(client.set('lite-bugs', 'x', {})).rejects.toThrow(/timed out/);
  });
});

describe('EdisonKVClient.get', () => {
  it('GETs ?id=collection&key=key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ ok: true, status: 200, text: JSON.stringify({ value: JSON.stringify({ hello: 'world' }) }) })
    );
    const client = new EdisonKVClient({ url: 'https://kv.test/keyvalue', fetchImpl: fetchMock });

    const result = await client.get('lite-bugs', 'rec-1');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://kv.test/keyvalue?id=lite-bugs&key=rec-1');
    expect(init?.method).toBe('GET');
    expect(result).toEqual({ hello: 'world' });
  });

  it('parses the wrapped value (result.value is JSON-stringified)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        ok: true,
        status: 200,
        text: JSON.stringify({ value: JSON.stringify({ name: 'John', age: 30 }) }),
      })
    );
    const client = new EdisonKVClient({ url: 'https://kv.test/keyvalue', fetchImpl: fetchMock });
    const result = await client.get('users', 'user_123');
    expect(result).toEqual({ name: 'John', age: 30 });
  });

  it('returns null on the "No data found" sentinel', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ ok: true, status: 200, text: '{"Status":"No data found."}' })
    );
    const client = new EdisonKVClient({ url: 'https://kv.test/keyvalue', fetchImpl: fetchMock });
    const result = await client.get('lite-bugs', 'missing');
    expect(result).toBeNull();
  });

  it('returns null on empty body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ ok: true, status: 200, text: '' }));
    const client = new EdisonKVClient({ url: 'https://kv.test/keyvalue', fetchImpl: fetchMock });
    expect(await client.get('lite-bugs', 'missing')).toBeNull();
  });

  it('returns wrapped value as-is when it is not JSON-parseable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ ok: true, status: 200, text: JSON.stringify({ value: 'plain string' }) })
    );
    const client = new EdisonKVClient({ url: 'https://kv.test/keyvalue', fetchImpl: fetchMock });
    expect(await client.get('lite-bugs', 'plain')).toBe('plain string');
  });
});

describe('EdisonKVClient.delete', () => {
  it('DELETEs ?id=collection&key=key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ ok: true, status: 200, text: '' }));
    const client = new EdisonKVClient({ url: 'https://kv.test/keyvalue', fetchImpl: fetchMock });

    await client.delete('lite-bugs', 'rec-1');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://kv.test/keyvalue?id=lite-bugs&key=rec-1');
    expect(init?.method).toBe('DELETE');
  });

  it('throws KVError on non-OK status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ ok: false, status: 500, text: '' }));
    const client = new EdisonKVClient({ url: 'https://kv.test/keyvalue', fetchImpl: fetchMock });
    await expect(client.delete('lite-bugs', 'x')).rejects.toThrow(KVError);
  });
});

describe('EdisonKVClient.listKeys', () => {
  it('POSTs base URL with body { id: collection }', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        ok: true,
        status: 200,
        text: JSON.stringify([{ key: 'a' }, { key: 'b' }, { key: 'c' }]),
      })
    );
    const client = new EdisonKVClient({ url: 'https://kv.test/keyvalue', fetchImpl: fetchMock });

    const keys = await client.listKeys('lite-bugs');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://kv.test/keyvalue');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ id: 'lite-bugs' });
    expect(keys).toEqual(['a', 'b', 'c']);
  });

  it('handles array-of-strings response shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ ok: true, status: 200, text: JSON.stringify(['key1', 'key2']) })
    );
    const client = new EdisonKVClient({ url: 'https://kv.test/keyvalue', fetchImpl: fetchMock });
    expect(await client.listKeys('lite-bugs')).toEqual(['key1', 'key2']);
  });

  it('returns empty on "No data found" sentinel', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ ok: true, status: 200, text: '{"Status":"No data found."}' })
    );
    const client = new EdisonKVClient({ url: 'https://kv.test/keyvalue', fetchImpl: fetchMock });
    expect(await client.listKeys('lite-bugs')).toEqual([]);
  });

  it('returns empty on empty body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ ok: true, status: 200, text: '' }));
    const client = new EdisonKVClient({ url: 'https://kv.test/keyvalue', fetchImpl: fetchMock });
    expect(await client.listKeys('lite-bugs')).toEqual([]);
  });

  it('uses the shorter list timeout', async () => {
    const fetchMock = vi.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        (init as { signal: AbortSignal }).signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const client = new EdisonKVClient({
      url: 'https://kv.test/keyvalue',
      fetchImpl: fetchMock,
      listTimeoutMs: 10,
      timeoutMs: 100000, // distinguishably different
    });
    const start = Date.now();
    await expect(client.listKeys('lite-bugs')).rejects.toThrow(/timed out after 10/);
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe('EdisonKVClient.list (listKeys + parallel get)', () => {
  it('combines list with per-key gets to return full records', async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      callCount++;
      if (init.method === 'POST') {
        // listKeys
        return Promise.resolve(
          makeResponse({ ok: true, status: 200, text: JSON.stringify([{ key: 'a' }, { key: 'b' }]) })
        );
      }
      // GET per key
      const u = new URL(url);
      const key = u.searchParams.get('key');
      const value = key === 'a' ? { x: 1 } : { x: 2 };
      return Promise.resolve(
        makeResponse({ ok: true, status: 200, text: JSON.stringify({ value: JSON.stringify(value) }) })
      );
    });
    const client = new EdisonKVClient({ url: 'https://kv.test/keyvalue', fetchImpl: fetchMock });

    const records = await client.list('lite-bugs');
    expect(records).toEqual([
      { key: 'a', value: { x: 1 } },
      { key: 'b', value: { x: 2 } },
    ]);
    // 1 listKeys POST + 2 per-key GETs = 3
    expect(callCount).toBe(3);
  });

  it('skips per-key get failures (partial result)', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      if (init.method === 'POST') {
        return Promise.resolve(
          makeResponse({ ok: true, status: 200, text: JSON.stringify([{ key: 'good' }, { key: 'broken' }]) })
        );
      }
      const u = new URL(url);
      if (u.searchParams.get('key') === 'broken') {
        return Promise.resolve(makeResponse({ ok: false, status: 500, text: 'oops' }));
      }
      return Promise.resolve(
        makeResponse({ ok: true, status: 200, text: JSON.stringify({ value: JSON.stringify({ ok: true }) }) })
      );
    });
    const client = new EdisonKVClient({ url: 'https://kv.test/keyvalue', fetchImpl: fetchMock });
    const records = await client.list('lite-bugs');
    expect(records).toEqual([{ key: 'good', value: { ok: true } }]);
  });
});

describe('EdisonKVClient logger', () => {
  it('emits structured info on success', async () => {
    const events: Array<{ level: string; message: string }> = [];
    const logger = (level: 'info' | 'warn' | 'error', message: string): void => {
      events.push({ level, message });
    };
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ ok: true, status: 200, text: '' }));
    const client = new EdisonKVClient({ url: 'https://kv.test/keyvalue', fetchImpl: fetchMock, logger });
    await client.set('lite-bugs', 'k', {});
    expect(events.some((e) => e.level === 'info' && /set ok/.test(e.message))).toBe(true);
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});
