/**
 * Bug-report integration tests -- BugReportStore against a real
 * EdisonKVClient against the in-memory KV server.
 *
 * Validates the full stack from the public BugReportApi down through
 * the KV HTTP contract, end-to-end with no mocks. Catches:
 *   - Schema/serialization drift between BugReportPayload and KV
 *   - Migration logic against real "wrapped value" responses
 *   - Update + delete round-trips through the network layer
 *   - Redaction integration (notes go through `redact()` before save)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BugReportStore, BugReportError, BUG_REPORT_ERROR_CODES } from '../../bug-report/store.js';
import { EdisonKVClient } from '../../kv/client.js';
import type { KVApi } from '../../kv/api.js';
import { startInMemoryKVServer, type InMemoryKVServer, makeBugReportPayload } from '../harness/index.js';

let server: InMemoryKVServer;
let kv: KVApi;
let store: BugReportStore;

beforeEach(async () => {
  server = await startInMemoryKVServer();
  // Wrap the real client as KVApi (it already conforms).
  kv = new EdisonKVClient({
    url: `${server.url}/keyvalue`,
    timeoutMs: 1000,
    listTimeoutMs: 1000,
  });
  store = new BugReportStore({ kvApi: kv });
});

afterEach(async () => {
  await server.stop();
});

describe('BugReportStore integration: round-trip', () => {
  it('save + read returns the same payload (round-trips through KV serialization)', async () => {
    const payload = makeBugReportPayload({
      description: 'integration round-trip',
      timestamp: '2026-05-04T10:00:00.000Z',
    });
    const saveResult = await store.save(payload);
    expect(saveResult.kvWritten).toBe(true);

    const read = await store.read(payload.timestamp);
    expect(read.description).toBe('integration round-trip');
    expect(read.timestamp).toBe(payload.timestamp);
    expect(read.os).toEqual(payload.os);
  });

  it('list returns summaries newest-first', async () => {
    await store.save(makeBugReportPayload({ timestamp: '2026-05-04T10:00:00.000Z', description: 'older' }));
    await store.save(makeBugReportPayload({ timestamp: '2026-05-04T12:00:00.000Z', description: 'newer' }));
    await store.save(makeBugReportPayload({ timestamp: '2026-05-04T11:00:00.000Z', description: 'middle' }));

    const list = await store.list();
    expect(list).toHaveLength(3);
    expect(list[0]?.descriptionPreview).toBe('newer');
    expect(list[1]?.descriptionPreview).toBe('middle');
    expect(list[2]?.descriptionPreview).toBe('older');
  });

  it('read accepts both bare timestamp and kv:<timestamp> identifier', async () => {
    const payload = makeBugReportPayload({ timestamp: '2026-05-04T13:00:00.000Z' });
    await store.save(payload);

    const byBare = await store.read(payload.timestamp);
    const byPrefixed = await store.read(`kv:${payload.timestamp}`);
    expect(byBare.timestamp).toBe(payload.timestamp);
    expect(byPrefixed.timestamp).toBe(payload.timestamp);
  });

  it('update mutates status and notes (and redacts notes through the layer)', async () => {
    const payload = makeBugReportPayload({ timestamp: '2026-05-04T14:00:00.000Z' });
    await store.save(payload);

    const sensitiveJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.xyz123abc456';
    const result = await store.update(payload.timestamp, {
      status: 'resolved',
      notes: `Reviewed by ricky -- token: ${sensitiveJwt}`,
    });
    expect(result.kvUpdated).toBe(true);
    expect(result.payload.status).toBe('resolved');
    // The JWT should be redacted before save.
    expect(result.payload.notes).not.toContain(sensitiveJwt);
    expect(result.payload.notes).toContain('REDACTED');

    // Round-trip through KV again to confirm the persisted value is
    // the redacted form, not the raw input.
    const fresh = await store.read(payload.timestamp);
    expect(fresh.notes).not.toContain(sensitiveJwt);
  });

  it('delete removes the report (subsequent read throws BR_NOT_FOUND)', async () => {
    const payload = makeBugReportPayload({ timestamp: '2026-05-04T15:00:00.000Z' });
    await store.save(payload);
    expect((await store.list()).length).toBe(1);

    const deleteResult = await store.delete(payload.timestamp);
    expect(deleteResult.kvDeleted).toBe(true);
    expect((await store.list()).length).toBe(0);

    try {
      await store.read(payload.timestamp);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BugReportError);
      expect((err as BugReportError).code).toBe(BUG_REPORT_ERROR_CODES.NOT_FOUND);
    }
  });
});

describe('BugReportStore integration: error paths', () => {
  it('save throws BR_SAVE_FAILED with KV cause when the server returns 500', async () => {
    server.failNextRequest({ status: 500, body: 'down' });
    const payload = makeBugReportPayload({ timestamp: '2026-05-04T16:00:00.000Z' });
    try {
      await store.save(payload);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BugReportError);
      expect((err as BugReportError).code).toBe(BUG_REPORT_ERROR_CODES.SAVE_FAILED);
      // The cause should be the underlying KVError.
      const cause = (err as BugReportError).cause as { code?: string; status?: number } | undefined;
      expect(cause?.code).toBe('KV_HTTP');
      expect(cause?.status).toBe(500);
    }
  });

  it('list returns [] when the server is unreachable (soft-fail)', async () => {
    server.failNextRequest({ status: 500, body: 'down' });
    const list = await store.list();
    expect(list).toEqual([]);
  });

  it('read throws BR_NOT_FOUND when the key does not exist (200 + No-data-found sentinel)', async () => {
    try {
      await store.read('2099-01-01T00:00:00.000Z');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BugReportError);
      expect((err as BugReportError).code).toBe(BUG_REPORT_ERROR_CODES.NOT_FOUND);
    }
  });

  it('delete soft-fails when the server returns 500 (does not throw)', async () => {
    const payload = makeBugReportPayload({ timestamp: '2026-05-04T17:00:00.000Z' });
    await store.save(payload);

    server.failNextRequest({ status: 500, body: 'down' });
    const result = await store.delete(payload.timestamp);
    expect(result.kvDeleted).toBe(false);
    expect(result.kvError).toMatch(/KV delete failed/);
  });
});

describe('BugReportStore integration: KV wire-format', () => {
  it('writes a JSON-stringified itemValue per the OneReach contract', async () => {
    const payload = makeBugReportPayload({ timestamp: '2026-05-04T18:00:00.000Z' });
    await store.save(payload);

    const requests = server.getRequests();
    const put = requests.find((r) => r.method === 'PUT');
    expect(put).toBeDefined();
    const body = JSON.parse(put!.body);
    expect(body.id).toBe('lite-bugs');
    expect(body.key).toBe(payload.timestamp);
    expect(typeof body.itemValue).toBe('string');
    const inner = JSON.parse(body.itemValue);
    expect(inner.timestamp).toBe(payload.timestamp);
  });
});
