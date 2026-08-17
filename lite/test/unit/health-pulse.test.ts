/**
 * Service pulse (2026-08-17): the calm-outage-banner signal. An outage
 * must become ONE amber banner + stale-served panes, not a wall of
 * red. These tests pin the state machine, the KV-breaker producer, and
 * the banner builder.
 */

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getPulse,
  reportServiceDown,
  reportServiceUp,
  onPulseChange,
  _resetPulseForTesting,
  _setPulseClockForTesting,
} from '../../health/pulse.js';
import { FlowHttpKVClient } from '../../kv/flow-http-client.js';
import { buildServicePulseBanner, _setServiceDegradedForTesting, isServiceDegraded } from '../../spaces/spaces.js';

beforeEach(() => _resetPulseForTesting());
afterEach(() => {
  _resetPulseForTesting();
  _setServiceDegradedForTesting(false);
  vi.useRealTimers();
});

describe('pulse state machine', () => {
  it('ok → degraded → ok, with listeners fired on each transition', () => {
    _setPulseClockForTesting(() => 1000);
    const seen: string[] = [];
    onPulseChange((p) => seen.push(p.status));

    expect(getPulse().status).toBe('ok');
    reportServiceDown('onereach', 'server errors');
    expect(getPulse()).toMatchObject({
      status: 'degraded',
      degradedSinceMs: 1000,
      services: [{ service: 'onereach', reason: 'server errors', downSinceMs: 1000 }],
    });
    reportServiceUp('onereach');
    expect(getPulse().status).toBe('ok');
    expect(getPulse().degradedSinceMs).toBeNull();
    expect(seen).toEqual(['degraded', 'ok']);
  });

  it('repeated identical down-reports keep the original downSince and do not re-notify', () => {
    let t = 1000;
    _setPulseClockForTesting(() => t);
    let fires = 0;
    onPulseChange(() => fires++);
    reportServiceDown('onereach', 'server errors');
    t = 9000;
    reportServiceDown('onereach', 'server errors');
    expect(fires).toBe(1);
    expect(getPulse().services[0]?.downSinceMs).toBe(1000);
  });

  it('up for a service never reported down is a silent no-op', () => {
    let fires = 0;
    onPulseChange(() => fires++);
    reportServiceUp('ghost');
    expect(fires).toBe(0);
  });

  it('multiple services: oldest outage leads; ok only when ALL recover', () => {
    let t = 100;
    _setPulseClockForTesting(() => t);
    reportServiceDown('a', 'x');
    t = 200;
    reportServiceDown('b', 'y');
    expect(getPulse().degradedSinceMs).toBe(100);
    reportServiceUp('a');
    expect(getPulse().status).toBe('degraded');
    expect(getPulse().degradedSinceMs).toBe(200);
    reportServiceUp('b');
    expect(getPulse().status).toBe('ok');
  });
});

describe('KV breaker → pulse producer', () => {
  const resp500 = (): Response => new Response('boom', { status: 500 });
  const respToken = (): Response =>
    new Response(JSON.stringify({ token: 'tok', expiresIn: 3600 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('circuit OPEN reports the service down; recovery reports it up', async () => {
    vi.useFakeTimers();
    let mode: 'fail' | 'ok' = 'fail';
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('refresh_token')) return respToken();
      if (mode === 'fail') return resp500();
      return new Response(JSON.stringify({ value: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new FlowHttpKVClient({
      refreshUrl: 'https://example.test/refresh_token',
      accountId: () => 'acct-1',
      fetchImpl,
      log: () => undefined,
    } as never);

    for (let i = 0; i < 5; i++) {
      await expect(client.get('c', 'k')).rejects.toBeTruthy();
    }
    expect(getPulse().status).toBe('degraded');
    expect(getPulse().services[0]?.service).toBe('onereach');

    vi.advanceTimersByTime(15_100);
    mode = 'ok';
    await expect(client.get('c', 'k')).resolves.toBeTruthy();
    expect(getPulse().status).toBe('ok');
  });
});

describe('buildServicePulseBanner', () => {
  it('renders calm copy, the outage age, and a Report action that fires', () => {
    let reported = 0;
    const el = buildServicePulseBanner(
      {
        status: 'degraded',
        services: [{ service: 'onereach', reason: 'server errors', downSinceMs: Date.now() - 120_000 }],
        degradedSinceMs: Date.now() - 120_000,
      },
      () => reported++
    );
    expect(el.getAttribute('role')).toBe('status');
    expect(el.querySelector('.spaces-pulse-text')?.textContent).toContain('showing recent data');
    expect(el.querySelector('.spaces-pulse-text')?.textContent).toContain('retrying automatically');
    const btn = el.querySelector<HTMLButtonElement>('.spaces-pulse-report');
    expect(btn?.textContent).toBe('Report issue');
    btn?.click();
    expect(reported).toBe(1);
  });

  it('the degraded flag gates error-hushing', () => {
    expect(isServiceDegraded()).toBe(false);
    _setServiceDegradedForTesting(true);
    expect(isServiceDegraded()).toBe(true);
  });
});
