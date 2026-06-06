/**
 * FlowHttpKVClient <-> Edison flow KV contract -- real HTTP round-trip.
 *
 * The ACTIVE KV transport in lite is `FlowHttpKVClient` (the FLOW-token
 * direct-HTTP path), but it had no integration coverage against the
 * real wire format -- only `SdkKVClient` did. That gap let a write-side
 * regression ship: the client sent the value under `value`, but the
 * flow stores it under `itemValue`, so every blob silently round-tripped
 * to the literal string "undefined" and the IDW menu / tabs / tools list
 * were wiped on every relaunch.
 *
 * These tests drive the real client against the in-memory contract
 * server (which speaks the actual PUT `itemValue` / GET `{ value }`
 * protocol + the `/refresh_token` mint), so a field-name regression
 * fails here instead of in production.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  startInMemoryKVServer,
  type InMemoryKVServer,
} from '../harness/mocks/in-memory-kv-server.js';
import { FlowHttpKVClient } from '../../kv/flow-http-client.js';

let server: InMemoryKVServer;

function makeClient(): FlowHttpKVClient {
  return new FlowHttpKVClient({ accountId: () => 'acct-1', baseUrl: server.url });
}

beforeEach(async () => {
  server = await startInMemoryKVServer();
});

afterEach(async () => {
  await server.stop();
});

describe('FlowHttpKVClient real-HTTP round-trip', () => {
  it('set + get round-trips an object blob (regression: value persists)', async () => {
    const client = makeClient();
    const blob = { schemaVersion: 1, entries: [{ id: 'a', label: 'My AI' }] };
    await client.set('lite-idw-entries', 'default', blob);
    expect(await client.get('lite-idw-entries', 'default')).toEqual(blob);
  });

  it('writes the value under `itemValue` as a JSON string (not `value`)', async () => {
    const client = makeClient();
    await client.set('lite-idw-entries', 'default', { entries: [] });
    const put = server.getRequests().find((r) => r.method === 'PUT');
    expect(put).toBeDefined();
    const body = JSON.parse(put?.body ?? '{}') as Record<string, unknown>;
    expect(typeof body['itemValue']).toBe('string');
    expect(JSON.parse(body['itemValue'] as string)).toEqual({ entries: [] });
    // The legacy `value` field (silently dropped by the flow) is gone.
    expect(body['value']).toBeUndefined();
  });

  it('persists across a fresh client instance (simulates an app relaunch)', async () => {
    const blob = { schemaVersion: 1, entries: [{ id: 'x', label: 'Persisted' }] };
    // Write with one client (this "session"), read with a brand-new one
    // (the "next launch") against the same server store (the user's KV).
    await makeClient().set('lite-idw-entries', 'default', blob);
    const afterRelaunch = await makeClient().get('lite-idw-entries', 'default');
    expect(afterRelaunch).toEqual(blob);
  });

  it('round-trips the main-window tabs blob shape too', async () => {
    const client = makeClient();
    const tabs = { schemaVersion: 1, tabs: [{ id: 't1', url: 'https://x' }], activeId: 't1' };
    await client.set('lite-main-window-tabs', 'default', tabs);
    expect(await client.get('lite-main-window-tabs', 'default')).toEqual(tabs);
  });

  it('overwrite then read returns the latest value', async () => {
    const client = makeClient();
    await client.set('lite-idw-entries', 'default', { entries: [{ id: '1' }] });
    await client.set('lite-idw-entries', 'default', { entries: [{ id: '1' }, { id: '2' }] });
    expect(await client.get('lite-idw-entries', 'default')).toEqual({
      entries: [{ id: '1' }, { id: '2' }],
    });
  });

  it('returns null for a key that was never written', async () => {
    expect(await makeClient().get('lite-idw-entries', 'never-written')).toBeNull();
  });

  // Every KV-backed lite store (idw, tabs, tools, bug-report, event-bus,
  // neon-config, onboarding, auth-sessions, ai-run-times, window-state)
  // routes through this one client, so a round-trip here proves
  // persistence for ALL of them and guards against any future
  // per-collection special-casing in set()/get().
  const ALL_KV_COLLECTIONS = [
    'lite-idw-entries',
    'lite-main-window-tabs',
    'lite-tool-entries',
    'lite-bugs',
    'lite-event-bus',
    'lite-neon-config',
    'lite-onboarding',
    'lite-auth-sessions',
    'lite-ai-run-times',
    'lite-window-state',
  ];
  it.each(ALL_KV_COLLECTIONS)('round-trips + survives relaunch for collection "%s"', async (collection) => {
    const blob = { schemaVersion: 1, items: [{ id: `${collection}-1` }], flag: true, nested: { n: 2 } };
    await makeClient().set(collection, 'default', blob);
    // Fresh client = relaunch.
    expect(await makeClient().get(collection, 'default')).toEqual(blob);
  });
});
