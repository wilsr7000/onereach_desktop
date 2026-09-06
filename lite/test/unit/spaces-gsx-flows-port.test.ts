/**
 * FetchGsxFlowsPort — the wire format was captured from @or-sdk/flows /
 * @or-sdk/bots 2.7.x against an echo server (ADR-091). These tests pin
 * that contract with a scripted fetch: token mint → discovery → paged
 * lists with the exact query/projection/from/size encoding.
 */
import { describe, it, expect } from 'vitest';
import { FetchGsxFlowsPort, GsxFlowsError } from '../../spaces/gsx-flows-port.js';

interface Call { url: string; auth?: string }

function scripted(routes: Record<string, (url: URL, n: number) => { status?: number; body?: unknown }>): {
  fetch: NonNullable<ConstructorParameters<typeof FetchGsxFlowsPort>[0]['fetch']>;
  calls: Call[];
} {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const fetch = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, ...(init?.headers?.['Authorization'] !== undefined ? { auth: init.headers['Authorization'] } : {}) });
    const u = new URL(url);
    const key = Object.keys(routes).find((k) => u.host + u.pathname === k || u.pathname === k || url.includes(k));
    if (key === undefined) return { ok: false, status: 404, text: async () => 'no route' };
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const r = routes[key]!(u, n);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => JSON.stringify(r.body ?? null) };
  };
  return { fetch, calls };
}

const ACCT = '35254342-4a2e-475b-aec1-18547e517e29';
const base = (calls: Call[]): FetchGsxFlowsPort['listBots'] extends never ? never : ReturnType<typeof scripted> => ({ fetch: async () => ({ ok: true, status: 200, text: async () => '' }), calls });

describe('FetchGsxFlowsPort — bots ("Designer spaces")', () => {
  it('mints FLOW token, discovers data-hub-pg, lists bots with the SDK wire format', async () => {
    const { fetch, calls } = scripted({
      '/refresh_token': () => ({ body: { token: 'abc' } }),
      'discovery.edison.api.onereach.ai/api/v2': () => ({ body: { url: 'https://hub.example/base/' } }),
      // Live shape: the data hub answers a BARE ARRAY per page.
      '/base/bots': () => ({ body: [
        { id: 'b1', data: { label: 'Tickets', description: 'd' }, dateModified: 1700000000000 },
        { id: 'b2', data: {} },
      ] }),
    });
    const port = new FetchGsxFlowsPort({ env: 'edison', accountId: ACCT, fetch });
    const bots = await port.listBots();
    expect(bots).toEqual([
      { id: 'b1', label: 'Tickets', description: 'd', dateModified: 1700000000000 },
      { id: 'b2', label: 'b2', description: '', dateModified: null },
    ]);
    // Token endpoint + discovery carry no auth; the list carries FLOW <token>.
    expect(calls[0]?.url).toBe(`https://em.edison.api.onereach.ai/http/${ACCT}/refresh_token`);
    expect(calls[0]?.auth).toBeUndefined();
    expect(calls[1]?.url).toBe('https://discovery.edison.api.onereach.ai/api/v2?serviceName=data-hub-pg');
    const list = new URL(calls[2]!.url);
    expect(list.origin + list.pathname).toBe('https://hub.example/base/bots');
    expect(list.searchParams.get('query')).toBe('{"isDeleted":false}');
    expect(list.searchParams.get('from')).toBe('0');
    expect(list.searchParams.get('size')).toBe('100');
    expect(list.searchParams.get('projection')).toBeNull();
    expect(calls[2]?.auth).toBe('FLOW abc');
  });

  it('pages until the first short page (and accepts the SDK-wrapped {total,items} shape too)', async () => {
    const { fetch, calls } = scripted({
      '/refresh_token': () => ({ body: { token: 'FLOW already' } }),
      'discovery.edison.api.onereach.ai/api/v2': () => ({ body: { url: 'https://hub.example' } }),
      '/bots': (_u, n) => ({ body: n === 1 ? [{ id: 'a' }, { id: 'b' }] : { total: 3, items: [{ id: 'c' }] } }),
    });
    const port = new FetchGsxFlowsPort({ env: 'edison', accountId: ACCT, fetch, pageSize: 2 });
    const bots = await port.listBots();
    expect(bots.map((b) => b.id)).toEqual(['a', 'b', 'c']);
    const pages = calls.filter((c) => c.url.includes('/bots'));
    expect(pages).toHaveLength(2);
    expect(new URL(pages[1]!.url).searchParams.get('from')).toBe('2');
    expect(calls[0]?.auth).toBeUndefined();
    expect(pages[0]?.auth).toBe('FLOW already'); // prefix not doubled
  });

  it('a hub that ignores `from` (repeats page 1) cannot loop: rows dedupe by id and paging stops', async () => {
    // Observed live 2026-09-05: /flows?from=100 answered the same rows as
    // from=0, and one bot answers 347 rows to a size=100 request. Before
    // this rule the sync counted 17,418 "flows" for 68 real ones.
    const big = Array.from({ length: 347 }, (_, i) => ({ id: `f${i}`, data: { label: `Flow ${i}` } }));
    const { fetch, calls } = scripted({
      '/refresh_token': () => ({ body: { token: 't' } }),
      'discovery.edison.api.onereach.ai/api/v2': () => ({ body: { url: 'https://hub.example' } }),
      '/flows': () => ({ body: big }), // every page identical, oversized
    });
    const port = new FetchGsxFlowsPort({ env: 'edison', accountId: ACCT, fetch, pageSize: 100 });
    const flows = await port.listFlows('b1');
    expect(flows).toHaveLength(347);
    expect(new Set(flows.map((f) => f.id)).size).toBe(347);
    expect(calls.filter((c) => c.url.includes('/flows'))).toHaveLength(2); // page 2 added nothing → stop
  });

  it('surfaces the account-without-flow case as a 404 GsxFlowsError', async () => {
    const { fetch } = scripted({ '/refresh_token': () => ({ status: 404, body: 'no handler' }) });
    const port = new FetchGsxFlowsPort({ env: 'edison', accountId: 'dd96413e-nope', fetch });
    await expect(port.listBots()).rejects.toMatchObject({ name: 'GsxFlowsError', status: 404 });
    await expect(port.listBots()).rejects.toBeInstanceOf(GsxFlowsError);
  });
});

describe('FetchGsxFlowsPort — flows', () => {
  it('lists a bot\'s live flows with the projection (a full record is ~2.7 MB)', async () => {
    const { fetch, calls } = scripted({
      '/refresh_token': () => ({ body: { token: 't' } }),
      'discovery.edison.api.onereach.ai/api/v2': () => ({ body: { url: 'https://hub.example' } }),
      '/flows': () => ({ body: [
        { id: 'f1', botId: 'b1', version: 'v9', dateModified: 1776111207428, isDeleted: false, data: { label: 'Create a Ticket', categories: ['ops', 7] } },
        { id: 'f2', botId: 'b1', isDeleted: true, data: {} },
      ] }),
    });
    const port = new FetchGsxFlowsPort({ env: 'edison', accountId: ACCT, fetch });
    const flows = await port.listFlows('b1');
    expect(flows).toEqual([
      { id: 'f1', botId: 'b1', label: 'Create a Ticket', description: '', categories: ['ops'], version: 'v9', dateModified: 1776111207428, isDeleted: false },
      { id: 'f2', botId: 'b1', label: 'f2', description: '', categories: [], version: '', dateModified: null, isDeleted: true },
    ]);
    const list = new URL(calls.find((c) => c.url.includes('/flows'))!.url);
    expect(list.searchParams.get('query')).toBe('{"botId":"b1","isDeleted":false}');
    expect(list.searchParams.get('projection')).toBe(
      '["id","botId","data.label","data.description","data.categories","dateModified","isDeleted","version"]'
    );
  });

  it('reuses the token and discovery across calls (one mint, one discovery)', async () => {
    const { fetch, calls } = scripted({
      '/refresh_token': () => ({ body: { token: 't' } }),
      'discovery.edison.api.onereach.ai/api/v2': () => ({ body: { url: 'https://hub.example' } }),
      '/bots': () => ({ body: [] }),
      '/flows': () => ({ body: [] }),
    });
    const port = new FetchGsxFlowsPort({ env: 'edison', accountId: ACCT, fetch });
    await port.listBots();
    await port.listFlows('b1');
    await port.listFlows('b2');
    expect(calls.filter((c) => c.url.includes('refresh_token'))).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes('discovery.'))).toHaveLength(1);
  });
});
void base;
