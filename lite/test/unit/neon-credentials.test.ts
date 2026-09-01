/**
 * CredentialsProvider tests for the Neon module.
 *
 * Covers the two providers that ship in Phase N0:
 *   - StaticCredentialsProvider -- in-memory, used by tests.
 *   - KVCredentialsProvider -- production default, reads / writes
 *     KV collection `lite-neon-config`.
 *
 * The forward-secure abstraction (the discriminated `NeonCredentials`
 * union) is exercised by `neon-client.test.ts:buildRequest`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BAKED_IN_DEFAULT_GRAPH,
  KVCredentialsProvider,
  StaticCredentialsProvider,
} from '../../neon/credentials.js';
import { _resetKVApiForTesting, _setKVApiForTesting } from '../../kv/api.js';
import { FakeKV } from '../harness/index.js';

describe('StaticCredentialsProvider', () => {
  it('starts with the defaults when given no overrides', async () => {
    const p = new StaticCredentialsProvider();
    expect(await p.getEndpoint()).toBeNull();
    expect(await p.get()).toBeNull();
    const pub = await p.readPublic();
    expect(pub).toEqual({
      endpoint: '',
      uri: '',
      user: 'neo4j',
      database: 'neo4j',
      hasPassword: false,
      source: 'account',
    });
  });

  it('returns the basic-in-body credentials when uri+password are set', async () => {
    const p = new StaticCredentialsProvider({
      endpoint: 'https://example.com/neon',
      uri: 'neo4j+s://abc.databases.neo4j.io',
      user: 'neo4j',
      password: 'pw',
      database: 'neo4j',
    });
    expect(await p.getEndpoint()).toBe('https://example.com/neon');
    const creds = await p.get();
    expect(creds).toEqual({
      kind: 'basic-in-body',
      uri: 'neo4j+s://abc.databases.neo4j.io',
      user: 'neo4j',
      password: 'pw',
      database: 'neo4j',
    });
  });

  it('returns null from get() when uri OR password is empty', async () => {
    const p1 = new StaticCredentialsProvider({ password: 'p' });
    expect(await p1.get()).toBeNull();
    const p2 = new StaticCredentialsProvider({ uri: 'x' });
    expect(await p2.get()).toBeNull();
  });

  it('write() merges partial updates and leaves omitted fields unchanged', async () => {
    const p = new StaticCredentialsProvider({
      endpoint: 'e1',
      uri: 'u1',
      user: 'u',
      password: 'p1',
      database: 'd1',
    });
    await p.write({ endpoint: 'e2', password: 'p2' });
    const snap = p._snapshot();
    expect(snap.endpoint).toBe('e2');
    expect(snap.uri).toBe('u1');
    expect(snap.user).toBe('u');
    expect(snap.password).toBe('p2');
    expect(snap.database).toBe('d1');
  });

  it('write() preserves non-empty user/database overrides', async () => {
    const p = new StaticCredentialsProvider({ user: 'admin', database: 'graph' });
    await p.write({ user: '' });
    expect(p._snapshot().user).toBe('admin');
    await p.write({ database: '' });
    expect(p._snapshot().database).toBe('graph');
    await p.write({ user: 'neo' });
    expect(p._snapshot().user).toBe('neo');
  });

  it('write({ password: "" }) explicitly clears the password', async () => {
    const p = new StaticCredentialsProvider({ uri: 'u', password: 'p' });
    await p.write({ password: '' });
    const snap = p._snapshot();
    expect(snap.password).toBe('');
    expect(await p.get()).toBeNull();
  });

  it('readPublic() never includes the password', async () => {
    const p = new StaticCredentialsProvider({
      uri: 'u',
      password: 'super-secret-12345',
    });
    const pub = await p.readPublic();
    const json = JSON.stringify(pub);
    expect(json).not.toContain('super-secret-12345');
    expect(pub.hasPassword).toBe(true);
  });
});

describe('KVCredentialsProvider', () => {
  beforeEach(() => {
    _resetKVApiForTesting();
  });

  it('reads from the lite-neon-config / default KV record', async () => {
    const fake = new FakeKV();
    _setKVApiForTesting(fake);
    await fake.set('lite-neon-config', 'default', {
      endpoint: 'https://ex/neon',
      uri: 'neo4j+s://x',
      user: 'neo4j',
      password: 'pw',
      database: 'neo4j',
    });
    const p = new KVCredentialsProvider();
    expect(await p.getEndpoint()).toBe('https://ex/neon');
    expect(await p.get()).toEqual({
      kind: 'basic-in-body',
      uri: 'neo4j+s://x',
      user: 'neo4j',
      password: 'pw',
      database: 'neo4j',
    });
  });

  it('returns null when the KV record is absent', async () => {
    const fake = new FakeKV();
    _setKVApiForTesting(fake);
    const p = new KVCredentialsProvider();
    expect(await p.getEndpoint()).toBeNull();
    expect(await p.get()).toBeNull();
    expect(await p.readPublic()).toBeNull();
  });

  it('returns null from get() when password is missing in the record', async () => {
    const fake = new FakeKV();
    _setKVApiForTesting(fake);
    await fake.set('lite-neon-config', 'default', {
      endpoint: 'https://ex/neon',
      uri: 'neo4j+s://x',
      user: 'neo4j',
      password: '',
      database: 'neo4j',
    });
    const p = new KVCredentialsProvider();
    expect(await p.get()).toBeNull();
    // Endpoint is independent -- still resolves.
    expect(await p.getEndpoint()).toBe('https://ex/neon');
  });

  it('write() merges partial updates back into KV', async () => {
    const fake = new FakeKV();
    _setKVApiForTesting(fake);
    await fake.set('lite-neon-config', 'default', {
      endpoint: 'e1',
      uri: 'u1',
      user: 'admin',
      password: 'p1',
      database: 'graph',
    });

    const p = new KVCredentialsProvider();
    await p.write({ endpoint: 'e2', password: 'p2' });

    const stored = await fake.get('lite-neon-config', 'default');
    expect(stored).toEqual({
      endpoint: 'e2',
      uri: 'u1',
      user: 'admin',
      password: 'p2',
      database: 'graph',
    });
  });

  it('write() seeds defaults when the record was absent', async () => {
    const fake = new FakeKV();
    _setKVApiForTesting(fake);
    const p = new KVCredentialsProvider();
    await p.write({ endpoint: 'https://ex/neon', uri: 'u', password: 'p' });

    const stored = await fake.get('lite-neon-config', 'default');
    expect(stored).toEqual({
      endpoint: 'https://ex/neon',
      uri: 'u',
      user: 'neo4j',
      password: 'p',
      database: 'neo4j',
    });
  });

  it('write() heals a legacy /omnidata/neon endpoint to /neon2 (ADR-070)', async () => {
    const fake = new FakeKV();
    _setKVApiForTesting(fake);
    const p = new KVCredentialsProvider();
    await p.write({
      endpoint: 'https://em.edison.api.onereach.ai/http/acct/omnidata/neon',
      uri: 'u',
      password: 'p',
    });
    const stored = (await fake.get('lite-neon-config', 'default')) as { endpoint: string };
    expect(stored.endpoint).toBe(
      'https://em.edison.api.onereach.ai/http/acct/omnidata/neon2'
    );
  });

  it('write() heals a stored /neon even when saving an unrelated field', async () => {
    const fake = new FakeKV();
    _setKVApiForTesting(fake);
    // Simulate a pre-migration persisted record.
    await fake.set('lite-neon-config', 'default', {
      endpoint: 'https://em.edison.api.onereach.ai/http/acct/omnidata/neon',
      uri: 'u',
      user: 'neo4j',
      password: 'p',
      database: 'neo4j',
    });
    const p = new KVCredentialsProvider();
    await p.write({ password: 'rotated' });
    const stored = (await fake.get('lite-neon-config', 'default')) as { endpoint: string };
    expect(stored.endpoint).toBe(
      'https://em.edison.api.onereach.ai/http/acct/omnidata/neon2'
    );
  });

  it('readPublic() reports hasPassword without the value', async () => {
    const fake = new FakeKV();
    _setKVApiForTesting(fake);
    await fake.set('lite-neon-config', 'default', {
      endpoint: 'e',
      uri: 'u',
      user: 'neo4j',
      password: 'super-secret-12345',
      database: 'neo4j',
    });
    const p = new KVCredentialsProvider();
    const pub = await p.readPublic();
    expect(pub).toMatchObject({ hasPassword: true });
    expect(JSON.stringify(pub)).not.toContain('super-secret-12345');
  });

  it('falls back to defaults for malformed fields', async () => {
    const fake = new FakeKV();
    _setKVApiForTesting(fake);
    await fake.set('lite-neon-config', 'default', {
      endpoint: 42,
      uri: null,
      user: '',
      password: undefined,
      database: 0,
    });
    const p = new KVCredentialsProvider();
    const pub = await p.readPublic();
    expect(pub).toEqual({
      endpoint: '',
      uri: '',
      user: 'neo4j',
      database: 'neo4j',
      hasPassword: false,
      source: 'account',
    });
  });

  it('honors a custom collection / key', async () => {
    const fake = new FakeKV();
    _setKVApiForTesting(fake);
    await fake.set('alt-coll', 'alt-key', {
      endpoint: 'e',
      uri: 'u',
      user: 'neo4j',
      password: 'p',
      database: 'neo4j',
    });
    const p = new KVCredentialsProvider({ collection: 'alt-coll', key: 'alt-key' });
    expect(await p.getEndpoint()).toBe('e');
  });

  it('returns the fallback record when KV is empty and a fallback is configured', async () => {
    const fake = new FakeKV();
    _setKVApiForTesting(fake);
    const fallback = {
      endpoint: 'https://fallback.example/neon',
      uri: 'neo4j+s://fallback.databases.neo4j.io',
      user: 'neo4j',
      password: 'fallback-pw',
      database: 'neo4j',
    };
    const p = new KVCredentialsProvider({ fallbackRecord: fallback });

    expect(await p.getEndpoint()).toBe(fallback.endpoint);
    expect(await p.get()).toEqual({
      kind: 'basic-in-body',
      uri: fallback.uri,
      user: fallback.user,
      password: fallback.password,
      database: fallback.database,
    });
    expect(await p.readPublic()).toEqual({
      endpoint: fallback.endpoint,
      uri: fallback.uri,
      user: fallback.user,
      database: fallback.database,
      hasPassword: true,
      source: 'bundle-default',
    });
  });

  it('persisted KV record wins over the fallback once the user writes', async () => {
    const fake = new FakeKV();
    _setKVApiForTesting(fake);
    const p = new KVCredentialsProvider({
      fallbackRecord: { ...BAKED_IN_DEFAULT_GRAPH },
    });

    // Before the user touches anything: fallback is in effect.
    expect(await p.getEndpoint()).toBe(BAKED_IN_DEFAULT_GRAPH.endpoint);

    // User saves their own endpoint and password from Settings -> OAGI.
    await p.write({ endpoint: 'https://user.example/neon', password: 'user-pw' });

    // Persisted values now win, but unspecified fields fall back to
    // whatever was already in KV (here that's a merge against the
    // fallback record because nothing was in KV yet).
    expect(await p.getEndpoint()).toBe('https://user.example/neon');
    expect(await p.get()).toEqual({
      kind: 'basic-in-body',
      uri: BAKED_IN_DEFAULT_GRAPH.uri,
      user: BAKED_IN_DEFAULT_GRAPH.user,
      password: 'user-pw',
      database: BAKED_IN_DEFAULT_GRAPH.database,
    });
  });
});

describe('BAKED_IN_DEFAULT_GRAPH', () => {
  it('has every field populated so fresh installs are fully configured', () => {
    expect(BAKED_IN_DEFAULT_GRAPH.endpoint.length).toBeGreaterThan(0);
    expect(BAKED_IN_DEFAULT_GRAPH.uri.length).toBeGreaterThan(0);
    expect(BAKED_IN_DEFAULT_GRAPH.user.length).toBeGreaterThan(0);
    expect(BAKED_IN_DEFAULT_GRAPH.password.length).toBeGreaterThan(0);
    expect(BAKED_IN_DEFAULT_GRAPH.database.length).toBeGreaterThan(0);
  });

  it('is frozen so callers cannot mutate the shared default', () => {
    expect(Object.isFrozen(BAKED_IN_DEFAULT_GRAPH)).toBe(true);
  });
});

describe('config source resolution (2026-08-10 — retires the baked-default blocker)', () => {
  beforeEach(() => {
    _resetKVApiForTesting();
  });

  it("signed-in with an account KV record → source 'account'", async () => {
    const fake = new FakeKV();
    _setKVApiForTesting(fake);
    await fake.set('lite-neon-config', 'default', {
      endpoint: 'https://ex/neon',
      uri: 'neo4j+s://x',
      user: 'neo4j',
      password: 'pw',
      database: 'neo4j',
    });
    const p = new KVCredentialsProvider({
      fallbackRecord: { endpoint: 'baked', uri: 'neo4j+s://baked', user: 'neo4j', password: 'bakedpw', database: 'neo4j' },
      getActiveAccountId: () => 'acct-1',
    });
    const pub = await p.readPublic();
    expect(pub?.source).toBe('account');
    expect(pub?.endpoint).toBe('https://ex/neon');
  });

  it("signed-in but KV empty → falls back to bundle-default with source 'bundle-default'", async () => {
    const fake = new FakeKV();
    _setKVApiForTesting(fake);
    const p = new KVCredentialsProvider({
      fallbackRecord: { endpoint: 'baked', uri: 'neo4j+s://baked', user: 'neo4j', password: 'bakedpw', database: 'neo4j' },
      getActiveAccountId: () => 'acct-1',
    });
    const pub = await p.readPublic();
    expect(pub?.source).toBe('bundle-default');
    expect(pub?.endpoint).toBe('baked');
  });

  it("signed-out uses the bundle default (source 'bundle-default')", async () => {
    _setKVApiForTesting(new FakeKV());
    const p = new KVCredentialsProvider({
      fallbackRecord: { endpoint: 'baked', uri: 'neo4j+s://baked', user: 'neo4j', password: 'bakedpw', database: 'neo4j' },
      getActiveAccountId: () => null,
    });
    expect((await p.readPublic())?.source).toBe('bundle-default');
  });

  it('NO fallback (public-build posture) → readPublic null, source cannot be bundle-default', async () => {
    _setKVApiForTesting(new FakeKV());
    const p = new KVCredentialsProvider({ getActiveAccountId: () => 'acct-1' });
    // KV empty + no fallbackRecord → nothing resolves; the plaintext
    // baked creds are simply not in the path.
    expect(await p.readPublic()).toBeNull();
    expect(await p.get()).toBeNull();
  });
});

describe('KVCredentialsProvider — cold-start fallback (2026-08-17 incident)', () => {
  beforeEach(() => {
    _resetKVApiForTesting();
  });

  it('serves the bundle default when KV fails and nothing is cached yet', async () => {
    // THE BUG: before this, a KV blip in the first seconds after launch
    // threw — and the KV circuit breaker then failed every Neon call
    // instantly for 15s. The user saw "connection issues to NEON" while
    // Neon was perfectly healthy; the app had merely failed to look up
    // its ADDRESS. Log signature:
    //   KV circuit open — failing fast (get lite-neon-config)
    //   → 8× neon.query.fail in 0–2ms → spaces.listSpaces.fail
    const fake = new FakeKV();
    fake.failGet = true;
    _setKVApiForTesting(fake);

    const p = new KVCredentialsProvider({ fallbackRecord: BAKED_IN_DEFAULT_GRAPH });
    // No prior successful read → the cache is empty. Must NOT throw.
    const pub = await p.readPublic();
    expect(pub).not.toBeNull();
    expect(pub?.source).toBe('bundle-default');
    expect(await p.getEndpoint()).toBe(BAKED_IN_DEFAULT_GRAPH.endpoint);
  });

  it('still throws when there is genuinely nothing to fall back to', async () => {
    // Public builds (LITE_NO_BAKED_GRAPH=1) construct the provider with
    // fallbackRecord: null. This branch is what keeps such a build
    // failing LOUDLY instead of silently pretending it has config —
    // do not "helpfully" soften it into a silent null return.
    const fake = new FakeKV();
    fake.failGet = true;
    _setKVApiForTesting(fake);

    const p = new KVCredentialsProvider();
    await expect(p.readPublic()).rejects.toThrow();
  });

  it('a cached record still wins over the fallback during a blip', async () => {
    // Stale-while-error: once a real read has succeeded, a later blip
    // must serve the last-good ACCOUNT record — never silently
    // downgrade the user to the bundle default. Uses fake timers to
    // age past the 60s resolve TTL WITHOUT calling invalidate(), which
    // would drop the cache and defeat the point of the test.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T00:00:00Z'));
    const fake = new FakeKV();
    _setKVApiForTesting(fake);
    await fake.set('lite-neon-config', 'default', {
      endpoint: 'https://account/neon2',
      uri: 'neo4j+s://account',
      user: 'neo4j',
      password: 'pw',
      database: 'neo4j',
    });
    const p = new KVCredentialsProvider({ fallbackRecord: BAKED_IN_DEFAULT_GRAPH });
    expect(await p.getEndpoint()).toBe('https://account/neon2');

    // Age past the TTL so the next read re-resolves, then make KV fail.
    vi.setSystemTime(new Date('2026-08-17T00:01:01Z'));
    fake.failGet = true;
    expect(await p.getEndpoint()).toBe('https://account/neon2');
    vi.useRealTimers();
  });

  it('does not cache the fallback — real config is picked up on recovery', async () => {
    // Caching the fallback would mask real account config for the full
    // 60s resolve TTL after a one-off blip. NOTE: no invalidate() here
    // on purpose — calling it would clear the cache and make this test
    // pass even if the fallback WERE cached, i.e. it would stop
    // detecting the bug it exists to detect.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T00:00:00Z'));
    const fake = new FakeKV();
    fake.failGet = true;
    _setKVApiForTesting(fake);
    const p = new KVCredentialsProvider({ fallbackRecord: BAKED_IN_DEFAULT_GRAPH });
    expect((await p.readPublic())?.source).toBe('bundle-default');

    // KV recovers with real config. Step past the 10s failure cooldown
    // but stay INSIDE the 60s TTL: correct behavior has an empty cache
    // and re-reads KV; the buggy version would serve a cached fallback.
    fake.failGet = false;
    await fake.set('lite-neon-config', 'default', {
      endpoint: 'https://account/neon2',
      uri: 'neo4j+s://account',
      user: 'neo4j',
      password: 'pw',
      database: 'neo4j',
    });
    vi.setSystemTime(new Date('2026-08-17T00:00:11Z'));
    const after = await p.readPublic();
    expect(after?.source).toBe('account');
    expect(await p.getEndpoint()).toBe('https://account/neon2');
    vi.useRealTimers();
  });
});
