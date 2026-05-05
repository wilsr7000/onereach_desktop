/**
 * BugReportApi tests.
 *
 * Structured per Rule 12 / HARNESS.md:
 *   1. `runApiConformanceContract` -- the uniform contract every module
 *      passes (singleton, reset, set-for-testing, expected methods).
 *   2. Module-specific behavior tests -- only what's not already
 *      covered by the conformance contract.
 */

import { describe, it, expect } from 'vitest';
import {
  getBugReportApi,
  _resetBugReportApiForTesting,
  _setBugReportApiForTesting,
  type BugReportApi,
} from '../../bug-report/api.js';
import type { BugReportPayload } from '../../bug-report/capture.js';
import { runApiConformanceContract } from '../harness/conformance.js';
import { makeBugReportPayload } from '../harness/index.js';

// 1. Conformance contract -- runs the uniform suite.
runApiConformanceContract<BugReportApi>({
  name: 'BugReportApi',
  getInstance: getBugReportApi,
  resetForTesting: _resetBugReportApiForTesting,
  setForTesting: _setBugReportApiForTesting,
  expectedMethods: ['save', 'list', 'read', 'update', 'delete', 'onEvent'],
});

// 2. Module-specific tests -- the parts the contract doesn't cover.

/**
 * In-memory stub implementation of BugReportApi for routing tests.
 * Records every call and persists to a Map so we can verify CRUD
 * semantics route through the public surface to the underlying store.
 */
function makeStubApi(): BugReportApi & {
  calls: Array<{ method: string; args: unknown[] }>;
  reports: Map<string, BugReportPayload>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const reports = new Map<string, BugReportPayload>();
  return {
    calls,
    reports,
    save: async (payload) => {
      calls.push({ method: 'save', args: [payload] });
      reports.set(payload.timestamp, payload);
      return { kvWritten: true, kvError: null };
    },
    list: async () => {
      calls.push({ method: 'list', args: [] });
      return Array.from(reports.values()).map((p) => ({
        filePath: `kv:${p.timestamp}`,
        filename: `${p.timestamp}.json`,
        timestamp: p.timestamp,
        version: p.version,
        descriptionPreview: p.description.slice(0, 100),
        redactionBucket: p.redactionTelemetry.bucket,
        redactionTotalCount: 0,
        bytes: JSON.stringify(p).length,
        status: p.status,
        hasNotes: p.notes.length > 0,
      }));
    },
    read: async (idOrPath) => {
      calls.push({ method: 'read', args: [idOrPath] });
      const key = idOrPath.startsWith('kv:') ? idOrPath.slice(3) : idOrPath;
      const payload = reports.get(key);
      if (payload === undefined) throw new Error(`not found: ${key}`);
      return payload;
    },
    update: async (timestamp, updates) => {
      calls.push({ method: 'update', args: [timestamp, updates] });
      const current = reports.get(timestamp);
      if (current === undefined) throw new Error(`not found: ${timestamp}`);
      const next: BugReportPayload = {
        ...current,
        ...(updates.status !== undefined ? { status: updates.status } : {}),
        ...(updates.notes !== undefined ? { notes: updates.notes } : {}),
        lastModified: new Date().toISOString(),
      };
      reports.set(timestamp, next);
      return { payload: next, kvUpdated: true, kvError: null };
    },
    delete: async (timestamp) => {
      calls.push({ method: 'delete', args: [timestamp] });
      reports.delete(timestamp);
      return { kvDeleted: true, kvError: null };
    },
    onEvent: () => {
      calls.push({ method: 'onEvent', args: [] });
      return (): void => {
        /* no-op */
      };
    },
  };
}

describe('BugReportApi (via stub) routes CRUD calls correctly', () => {
  it('save -> list -> read -> update -> delete round-trip', async () => {
    _resetBugReportApiForTesting();
    const stub = makeStubApi();
    _setBugReportApiForTesting(stub);
    const api = getBugReportApi();

    const payload = makeBugReportPayload({
      description: 'route-trip',
      timestamp: '2026-05-04T02:00:00.000Z',
    });
    const saveResult = await api.save(payload);
    expect(saveResult.kvWritten).toBe(true);

    const listResult = await api.list();
    expect(listResult).toHaveLength(1);
    expect(listResult[0]?.descriptionPreview).toBe('route-trip');

    const read = await api.read(`kv:${payload.timestamp}`);
    expect(read.description).toBe('route-trip');

    const updateResult = await api.update(payload.timestamp, { notes: 'triaged' });
    expect(updateResult.kvUpdated).toBe(true);
    expect(updateResult.payload.notes).toBe('triaged');

    const deleteResult = await api.delete(payload.timestamp);
    expect(deleteResult.kvDeleted).toBe(true);
    const afterDelete = await api.list();
    expect(afterDelete).toHaveLength(0);
  });

  it('records every method in stub.calls for audit', async () => {
    _resetBugReportApiForTesting();
    const stub = makeStubApi();
    _setBugReportApiForTesting(stub);
    const api = getBugReportApi();

    const payload = makeBugReportPayload({ timestamp: '2026-05-04T03:00:00.000Z' });
    await api.save(payload);
    await api.list();
    await api.read(payload.timestamp);
    await api.update(payload.timestamp, { status: 'resolved' });
    await api.delete(payload.timestamp);

    const methods = stub.calls.map((c) => c.method);
    expect(methods).toEqual(['save', 'list', 'read', 'update', 'delete']);
  });
});
