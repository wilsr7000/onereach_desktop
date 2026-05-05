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

import { describe, it, expect, beforeEach } from 'vitest';
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
