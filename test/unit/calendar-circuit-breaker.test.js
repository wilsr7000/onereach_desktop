/**
 * Phase 5 (calendar agent overhaul) -- circuit-breaker state machine.
 *
 * The promise from the plan: trips after `failuresToTrip` consecutive
 * failures, exponentially backs off (5min/10/20/30/30/30...), admits one
 * half-open probe per cooldown, and any successful traffic resets
 * `consecutiveTrips` to 0. Quiet-day zero-event responses count as success.
 *
 * Tests use process.env.CALENDAR_CIRCUIT_COOLDOWN_MS to keep latencies
 * negligible -- the production default is 5 minutes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const breakerModule = require('../../lib/calendar-circuit-breaker');
const { CalendarCircuitBreaker, CircuitOpenError, STATE } = breakerModule;

describe('Phase 5: calendar circuit breaker', () => {
  let breaker;
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env.CALENDAR_CIRCUIT_COOLDOWN_MS;
    process.env.CALENDAR_CIRCUIT_COOLDOWN_MS = '50'; // 50ms baseline so tests are fast
    breaker = new CalendarCircuitBreaker();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CALENDAR_CIRCUIT_COOLDOWN_MS;
    else process.env.CALENDAR_CIRCUIT_COOLDOWN_MS = originalEnv;
  });

  describe('happy path', () => {
    it('starts CLOSED', () => {
      expect(breaker.getState().state).toBe(STATE.CLOSED);
    });

    it('passes successful calls through', async () => {
      const result = await breaker.execute(async () => 'ok');
      expect(result).toBe('ok');
      expect(breaker.getState().state).toBe(STATE.CLOSED);
    });

    it('one failure does not trip', async () => {
      await expect(breaker.execute(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
      expect(breaker.getState().state).toBe(STATE.CLOSED);
      expect(breaker.getState().consecutiveFailures).toBe(1);
    });
  });

  describe('trip + cooldown + half-open probe', () => {
    it('trips OPEN after failuresToTrip consecutive failures', async () => {
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
      }
      expect(breaker.getState().state).toBe(STATE.OPEN);
      expect(breaker.getState().consecutiveTrips).toBe(1);
    });

    it('OPEN throws CircuitOpenError without invoking fn', async () => {
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(async () => { throw new Error('boom'); })).rejects.toThrow();
      }
      let invoked = false;
      const fn = async () => { invoked = true; return 'ok'; };
      await expect(breaker.execute(fn)).rejects.toBeInstanceOf(CircuitOpenError);
      expect(invoked).toBe(false);
    });

    it('after cooldown, admits one half-open probe', async () => {
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(async () => { throw new Error('boom'); })).rejects.toThrow();
      }
      // Wait past the 50ms cooldown.
      await new Promise((r) => { setTimeout(r, 70); });

      const result = await breaker.execute(async () => 'ok');
      expect(result).toBe('ok');
      expect(breaker.getState().state).toBe(STATE.CLOSED);
      expect(breaker.getState().consecutiveTrips).toBe(0);
    });

    it('failed half-open probe re-opens with NEXT backoff step', async () => {
      // First trip
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(async () => { throw new Error('x'); })).rejects.toThrow();
      }
      expect(breaker.getState().consecutiveTrips).toBe(1);
      const firstReopenAt = breaker.getState().reopenAt;
      const firstCooldown = firstReopenAt - Date.now();

      // Wait past cooldown, fail the probe
      await new Promise((r) => { setTimeout(r, 70); });
      await expect(breaker.execute(async () => { throw new Error('still bad'); })).rejects.toThrow('still bad');

      expect(breaker.getState().state).toBe(STATE.OPEN);
      expect(breaker.getState().consecutiveTrips).toBe(2);
      const secondCooldown = breaker.getState().reopenAt - Date.now();
      // Second cooldown should be ~2x the first (backoffFactor default 2).
      expect(secondCooldown).toBeGreaterThanOrEqual(firstCooldown * 1.5);
    });

    it('successful traffic resets consecutiveTrips so future trips backoff fresh', async () => {
      // Trip
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(async () => { throw new Error('x'); })).rejects.toThrow();
      }
      // Cooldown + successful probe
      await new Promise((r) => { setTimeout(r, 70); });
      await breaker.execute(async () => 'ok');
      expect(breaker.getState().consecutiveTrips).toBe(0);

      // Trip again -- should backoff with the v1 delay, not v2.
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(async () => { throw new Error('x'); })).rejects.toThrow();
      }
      expect(breaker.getState().consecutiveTrips).toBe(1);
    });
  });

  describe('exponential backoff', () => {
    it('cooldown grows: trip1 ~50ms, trip2 ~100ms, trip3 ~200ms (factor 2)', async () => {
      const cooldowns = [];
      for (let trip = 0; trip < 3; trip++) {
        for (let i = 0; i < 3; i++) {
          await expect(breaker.execute(async () => { throw new Error('x'); })).rejects.toThrow();
        }
        cooldowns.push(breaker.getState().msUntilReopen);
        // Wait + fail probe to advance to next trip
        await new Promise((r) => { setTimeout(r, breaker.getState().msUntilReopen + 20); });
        if (trip < 2) {
          await expect(breaker.execute(async () => { throw new Error('x'); })).rejects.toThrow();
        }
      }
      expect(cooldowns[1]).toBeGreaterThan(cooldowns[0] * 1.5);
      expect(cooldowns[2]).toBeGreaterThan(cooldowns[1] * 1.5);
    });
  });

  describe('reset()', () => {
    it('force-closes the breaker', async () => {
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(async () => { throw new Error('x'); })).rejects.toThrow();
      }
      expect(breaker.getState().state).toBe(STATE.OPEN);
      breaker.reset();
      expect(breaker.getState().state).toBe(STATE.CLOSED);
      expect(breaker.getState().consecutiveTrips).toBe(0);
    });
  });

  describe('singleton via getCircuitBreaker', () => {
    it('returns the same instance across calls', () => {
      breakerModule._resetForTests();
      const a = breakerModule.getCircuitBreaker();
      const b = breakerModule.getCircuitBreaker();
      expect(a).toBe(b);
    });
  });

  describe('no double-probe', () => {
    it('a second concurrent call while half-open probe is in flight throws CircuitOpenError', async () => {
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(async () => { throw new Error('x'); })).rejects.toThrow();
      }
      await new Promise((r) => { setTimeout(r, 70); });

      // Start a slow probe
      let resolveProbe;
      const probePromise = breaker.execute(
        () => new Promise((res) => { resolveProbe = res; })
      );
      // While the probe is in flight, another call should be rejected.
      await expect(breaker.execute(async () => 'ok-2')).rejects.toBeInstanceOf(CircuitOpenError);

      // Now let the probe succeed.
      resolveProbe('probe-result');
      await probePromise;
      expect(breaker.getState().state).toBe(STATE.CLOSED);
    });
  });
});
