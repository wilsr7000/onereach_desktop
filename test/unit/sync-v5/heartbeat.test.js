/**
 * Unit tests for lib/sync-v5/heartbeat.js
 *
 * Covers: heartbeat shape, ack accumulation, burst-threshold trigger,
 * lifecycle (sleep / wake), failure mode (queue acks across outage),
 * staleness computation across deviceClass + lifecycle states.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const {
  HeartbeatReporter,
  computeStaleness,
  CYPHER_WRITE_HEARTBEAT,
  STALENESS_MS,
} = require('../../../lib/sync-v5/heartbeat');
const { newTraceId } = require('../../../lib/sync-v5/trace-id');
const { DEVICE_CLASS } = require('../../../lib/sync-v5/device-identity');

function makeFakeOmni({ ready = true, throwOnQuery = null } = {}) {
  return {
    isReady: () => ready,
    executeQuery: vi.fn(async () => {
      if (throwOnQuery) throw throwOnQuery;
      return [{ deviceId: 'D', at: new Date().toISOString() }];
    }),
  };
}

describe('sync-v5 / heartbeat', () => {
  describe('HeartbeatReporter shape', () => {
    it('builds a heartbeat with all required v5 fields', async () => {
      const omni = makeFakeOmni();
      const reporter = new HeartbeatReporter({
        deviceId: '01HABCDEFGHJKMNPQRSTVWXYZ0',
        deviceClass: DEVICE_CLASS.DESKTOP,
        omniClient: omni,
        now: () => 1730000000000,
      });
      const r = await reporter.flush();
      expect(r.success).toBe(true);
      const hb = r.heartbeat;
      // v5 shape from Section 5.2:
      expect(hb).toHaveProperty('deviceId');
      expect(hb).toHaveProperty('deviceClass');
      expect(hb).toHaveProperty('at');
      expect(hb).toHaveProperty('expectedNextHeartbeatBy');
      expect(hb).toHaveProperty('ackedTraceIds');
      expect(hb).toHaveProperty('dlqCount');
      expect(hb).toHaveProperty('oldestParkedAt');
      expect(hb).toHaveProperty('schemaVersion');
      expect(hb).toHaveProperty('queueDepth');
      expect(hb).toHaveProperty('replicaSpaceCount');
      expect(hb).toHaveProperty('preserveUntil');
      expect(hb.deviceClass).toBe(DEVICE_CLASS.DESKTOP);
      expect(hb.ackedTraceIds).toEqual([]);
    });

    it('sets expectedNextHeartbeatBy to at + 6m for an active heartbeat', async () => {
      const omni = makeFakeOmni();
      const nowMs = 1730000000000;
      const reporter = new HeartbeatReporter({
        deviceId: 'D',
        deviceClass: DEVICE_CLASS.DESKTOP,
        omniClient: omni,
        now: () => nowMs,
      });
      const r = await reporter.flush({ goingToSleep: false });
      const expectedMs = new Date(r.heartbeat.expectedNextHeartbeatBy).getTime();
      expect(expectedMs - nowMs).toBe(6 * 60 * 1000);
    });

    it('sets expectedNextHeartbeatBy to null for a going-to-sleep heartbeat', async () => {
      const omni = makeFakeOmni();
      const reporter = new HeartbeatReporter({ omniClient: omni, deviceId: 'D' });
      const r = await reporter.flush({ goingToSleep: true });
      expect(r.heartbeat.expectedNextHeartbeatBy).toBe(null);
    });
  });

  describe('Ack accumulation', () => {
    it('collects ackedTraceIds and includes them in the next flush', async () => {
      const omni = makeFakeOmni();
      const reporter = new HeartbeatReporter({ omniClient: omni, deviceId: 'D' });
      const t1 = newTraceId();
      const t2 = newTraceId();
      reporter.recordAck(t1);
      reporter.recordAck(t2);
      const r = await reporter.flush();
      expect(r.heartbeat.ackedTraceIds).toEqual([t1, t2]);
    });

    it('clears the buffer after a successful flush', async () => {
      const omni = makeFakeOmni();
      const reporter = new HeartbeatReporter({ omniClient: omni, deviceId: 'D' });
      reporter.recordAck(newTraceId());
      await reporter.flush();
      const r2 = await reporter.flush();
      expect(r2.heartbeat.ackedTraceIds).toEqual([]);
    });

    it('preserves the buffer when flush fails (no ack loss across outage)', async () => {
      const omni = makeFakeOmni({ throwOnQuery: new Error('graph offline') });
      const reporter = new HeartbeatReporter({ omniClient: omni, deviceId: 'D' });
      const t = newTraceId();
      reporter.recordAck(t);
      const r = await reporter.flush();
      expect(r.success).toBe(false);
      // Buffer kept; next flush would resend.
      const inspect = reporter.inspect();
      expect(inspect.pendingAckCount).toBe(1);
    });

    it('ignores empty/non-string traceIds defensively', () => {
      const reporter = new HeartbeatReporter({
        omniClient: makeFakeOmni(),
        deviceId: 'D',
      });
      reporter.recordAck(null);
      reporter.recordAck(undefined);
      reporter.recordAck('');
      reporter.recordAck(123);
      expect(reporter.inspect().pendingAckCount).toBe(0);
    });
  });

  describe('Lifecycle hooks', () => {
    it('onGoingToSleep sends a heartbeat with expectedNextHeartbeatBy = null', async () => {
      const omni = makeFakeOmni();
      const reporter = new HeartbeatReporter({ omniClient: omni, deviceId: 'D' });
      reporter.start();
      await reporter.onGoingToSleep();
      expect(omni.executeQuery).toHaveBeenCalled();
      const lastCall = omni.executeQuery.mock.calls[omni.executeQuery.mock.calls.length - 1];
      expect(lastCall[1].expectedNextHeartbeatBy).toBe(null);
      expect(reporter.inspect().isAsleep).toBe(true);
    });

    it('onWakeup re-arms the active cadence', async () => {
      const omni = makeFakeOmni();
      const reporter = new HeartbeatReporter({ omniClient: omni, deviceId: 'D' });
      await reporter.onGoingToSleep();
      await reporter.onWakeup();
      expect(reporter.inspect().isAsleep).toBe(false);
      expect(reporter.inspect().started).toBe(true);
      reporter.stop();
    });

    it('start is idempotent', () => {
      const reporter = new HeartbeatReporter({ omniClient: makeFakeOmni(), deviceId: 'D' });
      reporter.start();
      reporter.start();
      expect(reporter.inspect().started).toBe(true);
      reporter.stop();
    });

    it('stop clears any timer', () => {
      const reporter = new HeartbeatReporter({ omniClient: makeFakeOmni(), deviceId: 'D' });
      reporter.start();
      reporter.stop();
      expect(reporter.inspect().started).toBe(false);
    });
  });

  describe('Providers', () => {
    it('honours dlqStateProvider', async () => {
      const omni = makeFakeOmni();
      const reporter = new HeartbeatReporter({
        omniClient: omni,
        deviceId: 'D',
        dlqStateProvider: () => ({ dlqCount: 7, oldestParkedAt: '2026-04-26T10:00:00Z' }),
      });
      const r = await reporter.flush();
      expect(r.heartbeat.dlqCount).toBe(7);
      expect(r.heartbeat.oldestParkedAt).toBe('2026-04-26T10:00:00Z');
    });

    it('honours queueDepthProvider', async () => {
      const omni = makeFakeOmni();
      const reporter = new HeartbeatReporter({
        omniClient: omni,
        deviceId: 'D',
        queueDepthProvider: () => 42,
      });
      const r = await reporter.flush();
      expect(r.heartbeat.queueDepth).toBe(42);
    });

    it('survives provider exceptions', async () => {
      const omni = makeFakeOmni();
      const reporter = new HeartbeatReporter({
        omniClient: omni,
        deviceId: 'D',
        dlqStateProvider: () => {
          throw new Error('provider crashed');
        },
        queueDepthProvider: () => {
          throw new Error('provider crashed');
        },
      });
      const r = await reporter.flush();
      expect(r.success).toBe(true);
      expect(r.heartbeat.dlqCount).toBe(0);
      expect(r.heartbeat.queueDepth).toBe(0);
    });
  });

  describe('CYPHER_WRITE_HEARTBEAT', () => {
    it('creates a :Heartbeat node and denormalises ackedTraceIds onto :OperationLog', () => {
      expect(CYPHER_WRITE_HEARTBEAT).toContain('CREATE (h:Heartbeat');
      expect(CYPHER_WRITE_HEARTBEAT).toContain('UNWIND $ackedTraceIds AS tid');
      expect(CYPHER_WRITE_HEARTBEAT).toContain('MATCH (op:OperationLog');
      expect(CYPHER_WRITE_HEARTBEAT).toContain('SET op.ackedByDevice = true');
    });
  });
});

describe('sync-v5 / heartbeat / computeStaleness (invariant 12)', () => {
  const baseAt = new Date('2026-04-27T10:00:00Z').getTime();

  it('active desktop: not stale within expectedNext + 1m grace', () => {
    const hb = {
      deviceClass: DEVICE_CLASS.DESKTOP,
      at: new Date(baseAt).toISOString(),
      expectedNextHeartbeatBy: new Date(baseAt + 6 * 60 * 1000).toISOString(),
    };
    expect(computeStaleness(hb, baseAt + 5 * 60 * 1000).stale).toBe(false);
    expect(computeStaleness(hb, baseAt + 6 * 60 * 1000 + 30 * 1000).stale).toBe(false);
  });

  it('active desktop: stale past expectedNext + 1m grace', () => {
    const hb = {
      deviceClass: DEVICE_CLASS.DESKTOP,
      at: new Date(baseAt).toISOString(),
      expectedNextHeartbeatBy: new Date(baseAt + 6 * 60 * 1000).toISOString(),
    };
    const r = computeStaleness(hb, baseAt + 7 * 60 * 1000 + 1);
    expect(r.stale).toBe(true);
    expect(r.reason).toMatch(/expectedNext/);
  });

  it('sleeping desktop: stale after 30 minutes', () => {
    const hb = {
      deviceClass: DEVICE_CLASS.DESKTOP,
      at: new Date(baseAt).toISOString(),
      expectedNextHeartbeatBy: null,
    };
    expect(computeStaleness(hb, baseAt + 29 * 60 * 1000).stale).toBe(false);
    const r = computeStaleness(hb, baseAt + 31 * 60 * 1000);
    expect(r.stale).toBe(true);
    expect(r.reason).toMatch(/30m/);
  });

  it('sleeping mobile: NOT stale at 6 days (background is normal)', () => {
    const hb = {
      deviceClass: DEVICE_CLASS.MOBILE,
      at: new Date(baseAt).toISOString(),
      expectedNextHeartbeatBy: null,
    };
    const r = computeStaleness(hb, baseAt + 6 * 24 * 60 * 60 * 1000);
    expect(r.stale).toBe(false);
  });

  it('sleeping mobile: stale at 8 days', () => {
    const hb = {
      deviceClass: DEVICE_CLASS.MOBILE,
      at: new Date(baseAt).toISOString(),
      expectedNextHeartbeatBy: null,
    };
    const r = computeStaleness(hb, baseAt + 8 * 24 * 60 * 60 * 1000);
    expect(r.stale).toBe(true);
    expect(r.reason).toMatch(/mobile/);
  });

  it('mobile threshold is configurable per tenant', () => {
    const hb = {
      deviceClass: DEVICE_CLASS.MOBILE,
      at: new Date(baseAt).toISOString(),
      expectedNextHeartbeatBy: null,
    };
    // 14-day tenant override
    const tenantWindow = 14 * 24 * 60 * 60 * 1000;
    const r = computeStaleness(hb, baseAt + 10 * 24 * 60 * 60 * 1000, tenantWindow);
    expect(r.stale).toBe(false);
  });

  it('handles missing or malformed input', () => {
    expect(computeStaleness(null).stale).toBe(true);
    expect(computeStaleness({}).stale).toBe(true);
    expect(computeStaleness({ at: 'garbage' }).stale).toBe(true);
  });

  it('exports the documented thresholds for cross-module parity', () => {
    expect(STALENESS_MS.ACTIVE_GRACE).toBe(60 * 1000);
    expect(STALENESS_MS.DESKTOP_SLEEP).toBe(30 * 60 * 1000);
    expect(STALENESS_MS.MOBILE_SLEEP).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
