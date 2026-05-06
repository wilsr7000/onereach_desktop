/**
 * Calendar Circuit Breaker (Phase 5 -- calendar agent overhaul)
 *
 * Wraps the Omnical fetch path with a closed/open/half-open state machine and
 * exponential backoff so a real Omnical incident doesn't produce constant
 * trip noise. Per the Phase 0 contract:
 *
 *   - Trips after `failuresToTrip` consecutive failures (default 3).
 *   - Stays open for `cooldownMs = min(maxCooldownMs, baseCooldownMs *
 *     backoffFactor ^ consecutiveTrips)`. Default: 5 min base, 30 min cap,
 *     factor 2 -> 5 / 10 / 20 / 30 / 30 / 30 ...
 *   - After cooldown, admits one half-open probe at `halfOpenProbeAfterMs`.
 *     If the probe succeeds, breaker closes and `consecutiveTrips` resets.
 *     If it fails, breaker re-opens with the next backoff step.
 *   - Successful traffic past the breaker (any 200 with a parseable body)
 *     resets `consecutiveTrips` to 0 so transient hiccups don't slow long-term
 *     recovery. Quiet-day zero-event responses count as success.
 *
 * Test override: `process.env.CALENDAR_CIRCUIT_COOLDOWN_MS` overrides the
 * baseline cooldown so unit tests don't have to wait 5 minutes.
 *
 * Usage:
 *   const breaker = getCircuitBreaker();
 *   const result = await breaker.execute(async () => omnicalFetch(...));
 *   // result is whatever omnicalFetch returns; if the breaker is open, throws
 *   // CircuitOpenError.
 *
 *   const state = breaker.getState();
 *   // { state: 'closed' | 'open' | 'half-open', consecutiveTrips, ... }
 */

'use strict';

const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

const STATE = Object.freeze({
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half-open',
});

class CircuitOpenError extends Error {
  constructor(message, { reopenAt, consecutiveTrips }) {
    super(message);
    this.name = 'CircuitOpenError';
    this.reopenAt = reopenAt;
    this.consecutiveTrips = consecutiveTrips;
  }
}

function _readSetting(key, fallback) {
  try {
    const v = global.settingsManager?.get(key);
    if (Number.isFinite(v)) return v;
  } catch {
    /* fall through */
  }
  return fallback;
}

class CalendarCircuitBreaker {
  constructor() {
    this._state = STATE.CLOSED;
    this._consecutiveTrips = 0;
    this._consecutiveFailures = 0;
    this._reopenAt = 0;
    this._halfOpenInFlight = false;
  }

  // ── Configuration knobs (read each call so settings flips take effect) ──

  _getConfig() {
    const envOverride = Number(process.env.CALENDAR_CIRCUIT_COOLDOWN_MS);
    const baseCooldownMs = Number.isFinite(envOverride) && envOverride > 0
      ? envOverride
      : _readSetting('calendar.omnicalCircuitBreaker.baseCooldownMs', 5 * 60 * 1000);
    return {
      failuresToTrip: _readSetting('calendar.omnicalCircuitBreaker.failuresToTrip', 3),
      baseCooldownMs,
      maxCooldownMs: _readSetting('calendar.omnicalCircuitBreaker.maxCooldownMs', 30 * 60 * 1000),
      backoffFactor: _readSetting('calendar.omnicalCircuitBreaker.backoffFactor', 2),
      halfOpenProbeAfterMs: _readSetting('calendar.omnicalCircuitBreaker.halfOpenProbeAfterMs', 30 * 1000),
    };
  }

  _computeCooldown(cfg) {
    // First trip = base cooldown (factor=2^0=1). Each subsequent trip
    // doubles up to maxCooldownMs. Plan: "5 min -> 10 -> 20 -> 30 -> 30 -> 30".
    const exponent = Math.max(0, this._consecutiveTrips - 1);
    const factor = Math.pow(cfg.backoffFactor, exponent);
    return Math.min(cfg.maxCooldownMs, cfg.baseCooldownMs * factor);
  }

  // ── State introspection ────────────────────────────────────────────────

  getState() {
    const now = Date.now();
    return {
      state: this._state,
      consecutiveTrips: this._consecutiveTrips,
      consecutiveFailures: this._consecutiveFailures,
      reopenAt: this._reopenAt,
      msUntilReopen: this._state === STATE.OPEN ? Math.max(0, this._reopenAt - now) : 0,
    };
  }

  /**
   * Force-reset the breaker. Used by tests and by the user-facing "retry now"
   * button if we add one to the HUD.
   */
  reset() {
    this._state = STATE.CLOSED;
    this._consecutiveTrips = 0;
    this._consecutiveFailures = 0;
    this._reopenAt = 0;
    this._halfOpenInFlight = false;
  }

  // ── execute() -- the public entry point ─────────────────────────────────

  /**
   * Run `fn` (an async producer of the result) through the breaker. Throws
   * `CircuitOpenError` when the breaker is open, otherwise calls fn() and
   * updates state based on the outcome.
   */
  async execute(fn) {
    const cfg = this._getConfig();
    const now = Date.now();

    // If a half-open probe is already in flight, reject all other callers
    // until the probe resolves so we don't accidentally fire concurrent
    // probes against a known-bad backend.
    if (this._state === STATE.HALF_OPEN && this._halfOpenInFlight) {
      throw new CircuitOpenError('Calendar circuit half-open probe already in flight', {
        reopenAt: this._reopenAt,
        consecutiveTrips: this._consecutiveTrips,
      });
    }

    if (this._state === STATE.OPEN) {
      if (now >= this._reopenAt) {
        // Cooldown elapsed -- transition to half-open and admit this call as
        // the probe.
        this._state = STATE.HALF_OPEN;
        this._halfOpenInFlight = true;
        log.info('calendar-circuit', 'Circuit transitioning open -> half-open (probe)');
      } else {
        throw new CircuitOpenError(
          `Calendar circuit open (cooldown ${Math.round((this._reopenAt - now) / 1000)}s remaining)`,
          { reopenAt: this._reopenAt, consecutiveTrips: this._consecutiveTrips }
        );
      }
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure(cfg);
      throw err;
    }
  }

  _onSuccess() {
    this._halfOpenInFlight = false;
    if (this._state === STATE.HALF_OPEN) {
      log.info('calendar-circuit', 'Half-open probe succeeded -- circuit closed', {
        priorTrips: this._consecutiveTrips,
      });
    }
    // Successful traffic past the breaker resets the trip counter so a
    // morning-long Omnical hiccup doesn't slow recovery later in the day.
    this._state = STATE.CLOSED;
    this._consecutiveTrips = 0;
    this._consecutiveFailures = 0;
  }

  _onFailure(cfg) {
    this._halfOpenInFlight = false;
    this._consecutiveFailures += 1;

    if (this._state === STATE.HALF_OPEN) {
      // Probe failed -- re-open with the next backoff step.
      this._consecutiveTrips += 1;
      this._state = STATE.OPEN;
      this._reopenAt = Date.now() + this._computeCooldown(cfg);
      log.warn('calendar-circuit', 'Half-open probe failed -- circuit re-opened', {
        consecutiveTrips: this._consecutiveTrips,
        cooldownMs: this._reopenAt - Date.now(),
      });
      return;
    }

    if (this._consecutiveFailures >= cfg.failuresToTrip) {
      this._consecutiveTrips += 1;
      this._state = STATE.OPEN;
      this._reopenAt = Date.now() + this._computeCooldown(cfg);
      log.warn('calendar-circuit', 'Circuit tripped open', {
        consecutiveFailures: this._consecutiveFailures,
        consecutiveTrips: this._consecutiveTrips,
        cooldownMs: this._reopenAt - Date.now(),
      });
    }
  }
}

let _instance = null;

function getCircuitBreaker() {
  if (!_instance) _instance = new CalendarCircuitBreaker();
  return _instance;
}

function _resetForTests() {
  _instance = null;
}

module.exports = {
  CalendarCircuitBreaker,
  CircuitOpenError,
  STATE,
  getCircuitBreaker,
  _resetForTests,
};
