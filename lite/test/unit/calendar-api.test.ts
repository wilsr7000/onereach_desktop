/**
 * Calendar API (ADR-090) — the Rule-12 conformance contract, and the
 * service over a fake GSX: token minting, discovery, bots, flows,
 * deployments → scheduled flows with activation state; caching; errors.
 */
import { describe, it, expect, vi } from 'vitest';
import { runApiConformanceContract } from '../harness/conformance.js';
import { CALENDAR_API_METHODS, CalendarService, _resetCalendarApiForTesting, _setCalendarApiForTesting, getCalendarApi, type CalendarApi } from '../../calendar/api.js';
import { SCHEDULE_STEP_TEMPLATE_ID } from '../../calendar/types.js';

runApiConformanceContract<CalendarApi>({
  name: 'CalendarApi',
  getInstance: () => getCalendarApi(),
  resetForTesting: () => _resetCalendarApiForTesting(),
  setForTesting: (instance) => _setCalendarApiForTesting(instance),
  expectedMethods: CALENDAR_API_METHODS,
});

describe('not-initialized stub', () => {
  it('refuses with CALENDAR_NOT_INITIALIZED until configured; status says so without throwing', async () => {
    _resetCalendarApiForTesting();
    await expect(getCalendarApi().snapshot()).rejects.toMatchObject({ code: 'CALENDAR_NOT_INITIALIZED' });
    expect(getCalendarApi().status().signedIn).toBe(false);
  });
});

// ── a fake GSX ─────────────────────────────────────────────────────────
const ACCOUNT = '35254342-4a2e-475b-aec1-18547e517e29';
const CRON = '0,30 9 ? * MON-FRI *';
const EVENT = { scheduleEventData: { id: 'ev-1', eventName: 'Morning', color: '#FFC107', timeZone: { value: 'UTC' }, expressions: [CRON], isReccuring: true } };
const scheduledFlow = (id: string, botId: string, label: string, version: string | null = 'v1') => ({
  id, botId, version, dateModified: 1, data: { label, trees: { main: { steps: { s1: { type: SCHEDULE_STEP_TEMPLATE_ID, label: 'Schedule execution', data: { scheduleEvents: [EVENT] } } } } } },
});
const plainFlow = (id: string, botId: string) => ({ id, botId, version: 'v', dateModified: 1, data: { label: 'plain', trees: { main: { steps: { s: { type: 'other', label: 'Wait for HTTP Request', data: {} } } } } } });

function fakeGsx(opts: { tokenOk?: boolean; rejectFirst?: boolean; failBot?: string; deploymentsFail?: boolean } = {}) {
  const calls: string[] = [];
  // The account's flows, mutable so tests can save a new version or delete one.
  const flowsByBot: Record<string, Array<Record<string, unknown>>> = {
    b1: [scheduledFlow('f-armed', 'b1', 'Armed report'), scheduledFlow('f-active-noschedule', 'b1', 'Active no trigger'), plainFlow('f-plain', 'b1')],
    b2: [scheduledFlow('f-authored', 'b2', 'Authored only', null), { id: 'f-legs', botId: 'b2', version: 'v', dateModified: 1, data: { label: 'Two legs', trees: { main: { steps: {} }, leg: { steps: { s9: { type: SCHEDULE_STEP_TEMPLATE_ID, label: 'Schedule execution', data: { scheduleEvents: [EVENT] } } } } } } }],
  };
  const headOf = (f: Record<string, unknown>) => ({ id: f['id'], botId: f['botId'], version: f['version'], dateModified: f['dateModified'], data: { label: (f['data'] as { label: string }).label } });
  const bulkOf = (f: Record<string, unknown>) => { const d = f['data'] as { label: string; trees: Record<string, unknown> }; return { id: f['id'], botId: f['botId'], version: f['version'], dateModified: f['dateModified'], data: { label: d.label, trees: Object.fromEntries(Object.entries(d.trees).map(([k, v]) => [k, k === 'main' ? v : {}])) } }; };
  let minted = 0;
  let rejected = false;
  const deployments = [
    { id: 'dep-1', flowId: 'f-armed', botId: 'b1', dateCreated: 1700000000000, data: { flowVersion: 'v1', triggers: [{ name: 'trigger/processed', params: { name: 'timer/f-armed/s1/next', type: 'on', hasSchedule: true, timeoutTime: 4102444800000 } }] } },
    { id: 'dep-2', flowId: 'f-active-noschedule', botId: 'b1', dateCreated: 1700000000000, data: { flowVersion: 'v1', triggers: [{ name: 'trigger/processed', params: { name: 'http/post/x', type: 'on', params: { path: 'x', method: 'post' }, timeoutTime: 0 } }] } },
  ];
  const fetch = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push(url);
    const auth = init?.headers?.['Authorization'] ?? '';
    const reply = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
    if (url.includes('/refresh_token')) {
      minted += 1;
      return opts.tokenOk === false ? reply(500, 'boom') : reply(200, { token: `FLOW tok-${minted}` });
    }
    if (url.includes('discovery.')) return reply(200, { url: 'https://datahub.edison.api.onereach.ai/' });
    if (!auth.startsWith('FLOW ')) return reply(401, 'no auth');
    if (opts.rejectFirst === true && auth === 'FLOW tok-1' && !rejected) {
      rejected = true;
      return reply(401, 'auth fail: wrong keyId');
    }
    if (url.includes('/bots?')) return reply(200, { items: [{ id: 'b1', data: { label: 'Reporting' } }, { botId: 'b2', data: { label: 'Ops' } }] });
    if (url.includes('/deployments?')) return opts.deploymentsFail === true ? reply(500, 'nope') : reply(200, deployments);
    if (/\/flows\/[A-Za-z0-9_-]+$/.test(url)) {
      const id = url.split('/').pop() ?? '';
      const f = Object.values(flowsByBot).flat().find((x) => x['id'] === id);
      return f === undefined ? reply(404, 'no flow') : reply(200, f);
    }
    if (url.includes('/flows?')) {
      const q = JSON.parse(decodeURIComponent(url.split('query=')[1]?.split('&')[0] ?? '{}')) as { botId: string };
      const projection = decodeURIComponent(url.split('projection=')[1] ?? '');
      if (q.botId === opts.failBot) return reply(500, 'bot exploded');
      const list = flowsByBot[q.botId] ?? [];
      // Heads projection (no steps) vs the bulk projection (main-tree steps).
      return reply(200, { items: list.map((f) => (projection.includes('steps') ? bulkOf(f) : headOf(f))) });
    }
    return reply(404, 'nope');
  });
  return { fetch, calls, mintedCount: () => minted, flowsByBot };
}

/** An in-memory schedule-index store. */
function memoryStore(initial: unknown = null) {
  let value: unknown = initial;
  let saves = 0;
  return { load: vi.fn(async () => value), save: vi.fn(async (_a: string, index: unknown) => { value = JSON.parse(JSON.stringify(index)); saves += 1; }), saves: () => saves, value: () => value };
}

function service(gsx: ReturnType<typeof fakeGsx>, over: Partial<ConstructorParameters<typeof CalendarService>[0]> = {}) {
  const openGsxWindow = vi.fn(async () => ({}));
  const openCalendarWindow = vi.fn();
  let now = 1_800_000_000_000;
  const svc = new CalendarService({ getSession: () => ({ env: 'edison', accountId: ACCOUNT }), fetch: gsx.fetch as never, openGsxWindow, openCalendarWindow, now: () => now, ...over });
  return { svc, openGsxWindow, openCalendarWindow, tick: (ms: number) => { now += ms; } };
}

describe('CalendarService — snapshot over the datahub', () => {
  it('mints the token, discovers data-hub-pg, lists bots, flows and deployments, and marks activation state', async () => {
    const gsx = fakeGsx();
    const { svc } = service(gsx);
    const snap = await svc.snapshot();
    expect(snap).toMatchObject({ env: 'edison', accountId: ACCOUNT, botCount: 2, flowCount: 5, activeDeployments: 2, errors: [] });
    expect(snap.scheduled.map((f) => [f.flowLabel, f.active, f.armed, f.deployed])).toEqual([
      ['Authored only', false, false, false],
      ['Two legs', false, false, true],
      ['Active no trigger', true, false, true],
      ['Armed report', true, true, true],
    ]);
    // Cold start: bulk projected listings; the legs flow was fetched whole to find its schedule.
    expect(gsx.calls.filter((u) => u.includes('/flows?')).every((u) => u.includes('projection=') && u.includes('steps'))).toBe(true);
    expect(gsx.calls.filter((u) => /\/flows\/f-legs$/.test(u))).toHaveLength(1);
    expect(snap.scan).toEqual({ indexed: 5, reused: 0, fetched: 0, bulk: 5, dropped: 0 });
    const armed = snap.scheduled.find((f) => f.flowId === 'f-armed')!;
    expect(armed.nextFireMs).toBe(4102444800000);
    expect(armed.activatedMs).toBe(1700000000000);
    expect(gsx.calls.filter((u) => u.includes('/refresh_token'))).toHaveLength(1);
    expect(gsx.calls.some((u) => u.includes('serviceName=data-hub-pg'))).toBe(true);
    expect(gsx.calls.some((u) => u.includes('/flows?query=') && decodeURIComponent(u).includes('"botId":"b1","isDeleted":false'))).toBe(true);
    expect(svc.status()).toMatchObject({ signedIn: true, env: 'edison', accountId: ACCOUNT, snapshotAgeMs: 0, lastError: null });
  });
  it('caches for the TTL, refreshes on demand, and re-mints the token once on a 401', async () => {
    const gsx = fakeGsx({ rejectFirst: true });
    const { svc, tick } = service(gsx);
    await svc.snapshot();
    expect(gsx.mintedCount()).toBe(2); // first token rejected once, re-minted
    const before = gsx.calls.length;
    await svc.snapshot();
    expect(gsx.calls.length).toBe(before); // cached
    tick(6 * 60 * 1000);
    await svc.snapshot();
    expect(gsx.calls.length).toBeGreaterThan(before); // TTL expired
    const again = gsx.calls.length;
    await svc.snapshot({ refresh: true });
    expect(gsx.calls.length).toBeGreaterThan(again);
  });
  it('one bot failing is reported, not fatal; deployments failing leaves activation unknown', async () => {
    const gsx = fakeGsx({ failBot: 'b2', deploymentsFail: true });
    const { svc } = service(gsx);
    const snap = await svc.snapshot();
    expect(snap.errors).toEqual([{ botId: 'b2', botLabel: 'Ops', message: expect.stringContaining('500') }]);
    expect(snap.scheduled.map((f) => f.flowLabel)).toEqual(['Active no trigger', 'Armed report']);
    expect(snap.flowCount).toBe(3);
    expect(snap.scheduled.every((f) => !f.active && !f.armed)).toBe(true);
    expect(snap.activeDeployments).toBe(0);
  });
  it('signed out, a bad token and a bad window are typed errors with remediation', async () => {
    const gsx = fakeGsx();
    const { svc } = service(gsx, { getSession: () => null });
    await expect(svc.snapshot()).rejects.toMatchObject({ code: 'CALENDAR_SIGNED_OUT', remediation: expect.stringContaining('GSX') });
    expect(svc.status().signedIn).toBe(false);
    const { svc: bad } = service(fakeGsx({ tokenOk: false }));
    await expect(bad.snapshot()).rejects.toMatchObject({ code: 'CALENDAR_TOKEN_FAILED' });
    expect(bad.status().lastError).toContain('token');
    const { svc: ok } = service(fakeGsx());
    await expect(ok.occurrences({ fromMs: 10, toMs: 5 })).rejects.toMatchObject({ code: 'CALENDAR_INVALID_INPUT' });
    await expect(ok.occurrences({ fromMs: 0, toMs: 500 * 24 * 3600 * 1000 })).rejects.toMatchObject({ code: 'CALENDAR_INVALID_INPUT' });
  });
  it('occurrences expand every scheduled flow within the window, ascending', async () => {
    const { svc } = service(fakeGsx());
    const fromMs = Date.UTC(2026, 8, 7); // Monday
    const toMs = Date.UTC(2026, 8, 8) - 1;
    const res = await svc.occurrences({ fromMs, toMs });
    expect(res.truncated).toBe(false);
    // four scheduled flows × two runs (09:00, 09:30)
    expect(res.occurrences).toHaveLength(8);
    expect(res.occurrences.map((o) => o.atMs)).toEqual([...res.occurrences.map((o) => o.atMs)].sort((a, b) => a - b));
    expect(res.occurrences[0]).toMatchObject({ atMs: Date.UTC(2026, 8, 7, 9, 0), eventName: 'Morning', timeZone: 'UTC' });
  });
  it('openFlow opens the flow in the GSX window; openWindow opens the Calendar', async () => {
    const { svc, openGsxWindow, openCalendarWindow } = service(fakeGsx());
    await svc.snapshot();
    await svc.openFlow({ flowId: 'f-armed', botId: 'b1' });
    expect(openGsxWindow).toHaveBeenCalledWith({ env: 'edison', url: 'https://studio.edison.onereach.ai/flows/b1/f-armed', title: 'Armed report — GSX Designer' });
    await expect(svc.openFlow({ flowId: '../x', botId: 'b1' })).rejects.toMatchObject({ code: 'CALENDAR_INVALID_INPUT' });
    await svc.openWindow();
    expect(openCalendarWindow).toHaveBeenCalledTimes(1);
  });
});

describe('CalendarService — the schedule index', () => {
  it('a warm scan lists heads only and reads no bodies when nothing changed; a saved version is read once; a deleted flow drops', async () => {
    const gsx = fakeGsx();
    const store = memoryStore();
    const { svc, tick } = service(gsx, { indexStore: store });
    const cold = await svc.snapshot();
    expect(cold.scan).toMatchObject({ bulk: 5, fetched: 0, reused: 0, indexed: 5 });
    expect(store.saves()).toBe(1);
    // Warm: same versions.
    tick(6 * 60 * 1000);
    const before = gsx.calls.length;
    const warm = await svc.snapshot();
    const since = gsx.calls.slice(before);
    expect(warm.scan).toEqual({ indexed: 5, reused: 5, fetched: 0, bulk: 0, dropped: 0 });
    expect(since.filter((u) => u.includes('/flows?')).every((u) => !u.includes('steps'))).toBe(true); // heads only
    expect(since.some((u) => /\/flows\/[A-Za-z0-9_-]+$/.test(u))).toBe(false); // no bodies
    expect(warm.scheduled.map((f) => f.flowLabel)).toEqual(cold.scheduled.map((f) => f.flowLabel));
    expect(warm.scheduled.find((f) => f.flowId === 'f-armed')?.armed).toBe(true); // activation still applied
    expect(store.saves()).toBe(1); // unchanged index is not rewritten
    // The author saves a new version of one flow, and deletes another.
    const armed = gsx.flowsByBot['b1']!.find((f) => f['id'] === 'f-armed')!;
    armed['version'] = 'v2';
    armed['dateModified'] = 2;
    gsx.flowsByBot['b1'] = gsx.flowsByBot['b1']!.filter((f) => f['id'] !== 'f-plain');
    tick(6 * 60 * 1000);
    const mark = gsx.calls.length;
    const changed = await svc.snapshot();
    expect(changed.scan).toEqual({ indexed: 4, reused: 3, fetched: 1, bulk: 0, dropped: 1 });
    expect(gsx.calls.slice(mark).filter((u) => /\/flows\/f-armed$/.test(u))).toHaveLength(1);
    expect(store.saves()).toBe(2);
    expect(Object.keys((store.value() as { flows: Record<string, unknown> }).flows).sort()).toEqual(['f-active-noschedule', 'f-armed', 'f-authored', 'f-legs']);
  });
  it('a space that fails to list keeps its index entries; a stored index for another account is ignored', async () => {
    const gsx = fakeGsx();
    const store = memoryStore();
    const { svc, tick } = service(gsx, { indexStore: store });
    await svc.snapshot();
    const failing = fakeGsx({ failBot: 'b2' });
    const { svc: svc2, tick: tick2 } = service(failing, { indexStore: store });
    tick(1); tick2(1);
    const snap = await svc2.snapshot();
    expect(snap.errors.map((e) => e.botId)).toEqual(['b2']);
    expect(snap.scan).toMatchObject({ dropped: 0, reused: 3 });
    expect(Object.keys((store.value() as { flows: Record<string, unknown> }).flows)).toHaveLength(5); // b2 entries kept
    const foreign = memoryStore({ v: 1, accountId: 'someone-else', updatedAt: 1, flows: { x: { version: 'v', schedule: null } } });
    const { svc: svc3 } = service(fakeGsx(), { indexStore: foreign });
    const s3 = await svc3.snapshot();
    expect(s3.scan.bulk).toBe(5); // started cold
  });
});
