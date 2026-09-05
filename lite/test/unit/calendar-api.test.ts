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
const plainFlow = (id: string, botId: string) => ({ id, botId, version: 'v', data: { label: 'plain', trees: { main: { steps: { s: { type: 'other', label: 'Wait for HTTP Request', data: {} } } } } } });

function fakeGsx(opts: { tokenOk?: boolean; rejectFirst?: boolean; failBot?: string; deploymentsFail?: boolean } = {}) {
  const calls: string[] = [];
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
    if (url.includes('/flows?')) {
      const q = JSON.parse(decodeURIComponent(url.split('query=')[1]?.split('&')[0] ?? '{}')) as { botId: string };
      if (q.botId === opts.failBot) return reply(500, 'bot exploded');
      if (q.botId === 'b1') return reply(200, { items: [scheduledFlow('f-armed', 'b1', 'Armed report'), scheduledFlow('f-active-noschedule', 'b1', 'Active no trigger'), plainFlow('f-plain', 'b1')] });
      return reply(200, { items: [scheduledFlow('f-authored', 'b2', 'Authored only', null)] });
    }
    return reply(404, 'nope');
  });
  return { fetch, calls, mintedCount: () => minted };
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
    expect(snap).toMatchObject({ env: 'edison', accountId: ACCOUNT, botCount: 2, flowCount: 4, activeDeployments: 2, errors: [] });
    expect(snap.scheduled.map((f) => [f.flowLabel, f.active, f.armed, f.deployed])).toEqual([
      ['Authored only', false, false, false],
      ['Active no trigger', true, false, true],
      ['Armed report', true, true, true],
    ]);
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
    // three scheduled flows × two runs (09:00, 09:30)
    expect(res.occurrences).toHaveLength(6);
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
