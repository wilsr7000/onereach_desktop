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
  RECOVERY_STABLE_MS,
} from '../../health/pulse.js';

/**
 * 2026-08-17 flap-suppression contract: reportServiceUp publishes only
 * after RECOVERY_STABLE_MS of stability. Tests that assert recovery
 * use this to settle the hold under fake timers.
 */
function settleRecovery(): void {
  vi.advanceTimersByTime(RECOVERY_STABLE_MS + 1_000);
}
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
    vi.useFakeTimers();
    try {
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
      // 2026-08-17: recovery publishes only after the stability hold —
      // a flapping network no longer spams alerts.
      reportServiceUp('onereach');
      expect(getPulse().status).toBe('degraded');
      settleRecovery();
      expect(getPulse().status).toBe('ok');
      expect(getPulse().degradedSinceMs).toBeNull();
      expect(seen).toEqual(['degraded', 'ok']);
    } finally {
      vi.useRealTimers();
    }
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
    vi.useFakeTimers();
    try {
      let t = 100;
      _setPulseClockForTesting(() => t);
      reportServiceDown('a', 'x');
      t = 200;
      reportServiceDown('b', 'y');
      expect(getPulse().degradedSinceMs).toBe(100);
      reportServiceUp('a');
      settleRecovery();
      expect(getPulse().status).toBe('degraded');
      expect(getPulse().degradedSinceMs).toBe(200);
      reportServiceUp('b');
      settleRecovery();
      expect(getPulse().status).toBe('ok');
    } finally {
      vi.useRealTimers();
    }
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
      token: () => 'mult-token-1',
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
    // 2026-08-17: recovery publishes after the flap-suppression hold.
    expect(getPulse().status).toBe('degraded');
    settleRecovery();
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

describe('flap suppression (2026-08-17)', () => {
  it('a down→up→down flap publishes ONE continuous episode', () => {
    vi.useFakeTimers();
    try {
      _resetPulseForTesting();
      const seen: string[] = [];
      const un = onPulseChange((p) => seen.push(p.status));
      reportServiceDown('onereach', 'server errors');
      expect(seen).toEqual(['degraded']);
      const originalSince = getPulse().degradedSinceMs;
      // Momentary recovery — the clear must HOLD, not publish.
      reportServiceUp('onereach');
      vi.advanceTimersByTime(10_000);
      expect(getPulse().status).toBe('degraded');
      expect(seen).toEqual(['degraded']);
      // Re-down inside the hold: same episode, same downSince, no re-notify.
      reportServiceDown('onereach', 'server errors');
      expect(seen).toEqual(['degraded']);
      expect(getPulse().degradedSinceMs).toBe(originalSince);
      un();
    } finally {
      vi.useRealTimers();
      _resetPulseForTesting();
    }
  });

  it('a stable recovery publishes ok exactly once after the hold', () => {
    vi.useFakeTimers();
    try {
      _resetPulseForTesting();
      const seen: string[] = [];
      const un = onPulseChange((p) => seen.push(p.status));
      reportServiceDown('onereach', 'server errors');
      reportServiceUp('onereach');
      vi.advanceTimersByTime(RECOVERY_STABLE_MS + 1_000);
      expect(getPulse().status).toBe('ok');
      expect(seen).toEqual(['degraded', 'ok']);
      un();
    } finally {
      vi.useRealTimers();
      _resetPulseForTesting();
    }
  });
});

