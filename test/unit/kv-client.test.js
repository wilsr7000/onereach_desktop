/**
 * lib/kv-client — the full app's single KV chokepoint (ADR-070, KV half).
 * Pins the URL builders, the standard value unwrap, the missing-vs-failure
 * error contract, and the one-retry transport.
 */
import { describe, it, expect, vi } from 'vitest';
import kv from '../../lib/kv-client';

const SHARED = 'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/keyvalue2';

function res(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body === undefined ? '' : body),
    json: () => Promise.resolve(body === undefined ? null : JSON.parse(body)),
  };
}

describe('URL builders', () => {
  it('sharedKvUrl pins the shared account on /keyvalue2', () => {
    expect(kv.sharedKvUrl()).toBe(SHARED);
  });

  it('kvUrlForAccount builds any account store', () => {
    expect(kv.kvUrlForAccount('abc-123')).toBe(
      'https://em.edison.api.onereach.ai/http/abc-123/keyvalue2'
    );
  });

  it('kvUrlFromRefreshUrl derives the session account store', () => {
    expect(
      kv.kvUrlFromRefreshUrl('https://em.edison.api.onereach.ai/http/some-acct/refresh_token')
    ).toBe('https://em.edison.api.onereach.ai/http/some-acct/keyvalue2');
  });
});

describe('kvGet — unwrap and error contract', () => {
  it('unwraps {value} and JSON-parses it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200, JSON.stringify({ value: '{"a":1}' })));
    expect(await kv.kvGet('col', 'k', { fetchImpl })).toEqual({ a: 1 });
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${SHARED}?id=col&key=k`);
  });

  it('missing data is null: "No data found.", empty body, 404', async () => {
    for (const r of [res(200, '{"Status":"No data found."}'), res(200, ''), res(404, '')]) {
      const fetchImpl = vi.fn().mockResolvedValue(r);
      expect(await kv.kvGet('col', 'k', { fetchImpl })).toBeNull();
    }
  });

  it('server failure THROWS instead of masquerading as missing data', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(500, 'boom'));
    await expect(kv.kvGet('col', 'k', { fetchImpl })).rejects.toThrow('KV GET 500');
  });
});

describe('kvPut — wire shape', () => {
  it('PUTs the standard {id, key, itemValue} body to the item URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200, 'ok'));
    await kv.kvPut('col', 'k', { hello: 1 }, { fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${SHARED}?id=col&key=k`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ id: 'col', key: 'k', itemValue: '{"hello":1}' });
  });

  it('honors an explicit url override (per-account stores)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200, 'ok'));
    await kv.kvPut('col', 'k', 1, { fetchImpl, url: kv.kvUrlForAccount('other') });
    expect(fetchImpl.mock.calls[0][0]).toContain('/http/other/keyvalue2?');
  });
});

describe('kvFetch — one retry on transient failure', () => {
  it('retries once after a 5xx and returns the recovery response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(503, 'unavailable'))
      .mockResolvedValueOnce(res(200, 'fine'));
    const out = await kv.kvFetch('http://x/keyvalue2', {}, { fetchImpl });
    expect(out.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries once after a network error, then rethrows', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    await expect(kv.kvFetch('http://x/keyvalue2', {}, { fetchImpl })).rejects.toThrow('ECONNRESET');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry 4xx — client errors are final', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(400, 'bad'));
    const out = await kv.kvFetch('http://x/keyvalue2', {}, { fetchImpl });
    expect(out.status).toBe(400);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('kvList', () => {
  it('POSTs {id} and returns the records array from any known shape', async () => {
    const shapes = [
      JSON.stringify([{ key: 'a' }]),
      JSON.stringify({ records: [{ key: 'a' }] }),
      JSON.stringify({ getStorageData: { records: [{ key: 'a' }] } }),
    ];
    for (const body of shapes) {
      const fetchImpl = vi.fn().mockResolvedValue(res(200, body));
      expect(await kv.kvList('col', { fetchImpl })).toEqual([{ key: 'a' }]);
    }
  });
});
