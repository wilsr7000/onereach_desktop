/**
 * The store's graph-mirror hook.
 *
 * One rule, asserted from every angle: mirroring to the graph is
 * ADDITIVE. A rejected mirror, a thrown mirror, a soft-failed mirror --
 * the KV write already succeeded, so `save()` must still report success
 * to the user. The alternative is an app that says "couldn't file your
 * bug" whenever the graph is unhealthy, which is when bugs get filed.
 */

import { describe, it, expect } from 'vitest';
import { BugReportStore } from '../../bug-report/store.js';
import type { KVApi } from '../../kv/api.js';
import type { BugReportPayload } from '../../bug-report/capture.js';

function fakeKV(over: Partial<KVApi> = {}): KVApi {
  return {
    set: async (): Promise<void> => {},
    get: async (): Promise<unknown> => null,
    list: async (): Promise<unknown[]> => [],
    delete: async (): Promise<void> => {},
    ...over,
  } as unknown as KVApi;
}

function payload(): BugReportPayload {
  return {
    schemaVersion: 1,
    timestamp: '2026-08-06T12:00:00.000Z',
    appTag: 'lite',
    source: 'user-bug-report',
    version: '0.0.31',
    os: { platform: 'darwin', release: '25.5.0', arch: 'arm64' },
    description: 'something broke',
    recentLogs: '',
    redactionTelemetry: { bucket: 'none', countsByKind: {} },
    status: 'open',
    notes: '',
    lastModified: '2026-08-06T12:00:00.000Z',
  } as BugReportPayload;
}

describe('save() graph mirror', () => {
  it('calls the mirror with the saved payload after a successful KV write', async () => {
    const seen: string[] = [];
    const store = new BugReportStore({
      kvApi: fakeKV({
        set: async (): Promise<void> => {
          seen.push('kv');
        },
      }),
      mirrorToGraph: async (p) => {
        seen.push(`mirror:${p.timestamp}`);
        return { filed: true };
      },
    });
    const result = await store.save(payload());
    expect(result.kvWritten).toBe(true);
    expect(seen, 'mirror must run AFTER the KV write').toEqual([
      'kv',
      'mirror:2026-08-06T12:00:00.000Z',
    ]);
  });

  it('still reports success when the mirror soft-fails', async () => {
    const store = new BugReportStore({
      kvApi: fakeKV(),
      mirrorToGraph: async () => ({ filed: false, error: 'graph down' }),
    });
    const result = await store.save(payload());
    expect(result.kvWritten).toBe(true);
    expect(result.kvError).toBeNull();
  });

  it('still reports success when the mirror THROWS', async () => {
    const store = new BugReportStore({
      kvApi: fakeKV(),
      mirrorToGraph: async () => {
        throw new Error('boom');
      },
    });
    const result = await store.save(payload());
    expect(result.kvWritten).toBe(true);
  });

  it('logs a warning when the mirror fails, so the gap is diagnosable', async () => {
    const lines: Array<{ level: string; message: string }> = [];
    const store = new BugReportStore({
      kvApi: fakeKV(),
      logger: (level, message) => lines.push({ level, message }),
      mirrorToGraph: async () => ({ filed: false, error: 'graph down' }),
    });
    await store.save(payload());
    expect(lines.some((l) => l.level === 'warn' && l.message.includes('graph mirror'))).toBe(true);
  });

  it('does not mirror when the KV write failed — nothing was saved', async () => {
    let mirrored = false;
    const store = new BugReportStore({
      kvApi: fakeKV({
        set: async (): Promise<void> => {
          throw new Error('kv down');
        },
      }),
      mirrorToGraph: async () => {
        mirrored = true;
        return { filed: true };
      },
    });
    await expect(store.save(payload())).rejects.toThrow();
    expect(mirrored).toBe(false);
  });

  it('works with no mirror configured (legacy callers)', async () => {
    const store = new BugReportStore({ kvApi: fakeKV() });
    const result = await store.save(payload());
    expect(result.kvWritten).toBe(true);
  });
});
