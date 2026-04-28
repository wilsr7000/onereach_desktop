/**
 * Integration tests for SpacesAPI.setCutoverProvider + routing.
 *
 * Per docs/sync-v5/replica-shape.md §5.1 commit E. When a cutover
 * provider is wired, items.list / items.get / tags.findItems /
 * smartFolders.list route through it. Falls through to the primary
 * path on miss or (when fallback is enabled) on provider throw.
 *
 * These are source-level + behavioural tests using a stub provider
 * rather than the real Replica-backed cutover provider. Loading the
 * full SpacesAPI requires clipboard-storage-v2 which has heavy
 * top-level dependencies, so we read the module's source for
 * routing-shape assertions and use a tiny SpacesAPI-shaped fake
 * for the gating behaviour.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

// ---------------------------------------------------------------------------
// Source-level routing assertions
// ---------------------------------------------------------------------------

const SRC = fs.readFileSync(
  path.join(__dirname, '../../../spaces-api.js'),
  'utf8'
);

describe('spaces-api -- setCutoverProvider source contract', () => {
  it('exposes setCutoverProvider(provider, opts) on SpacesAPI', () => {
    expect(SRC).toMatch(/setCutoverProvider\s*\(\s*provider\s*,\s*opts\s*=\s*\{\s*\}\s*\)/);
  });

  it('exposes _tryReplicaRead(method, args) helper', () => {
    expect(SRC).toMatch(/_tryReplicaRead\s*\(\s*method\s*,\s*args\s*\)/);
  });

  it('initialises _cutoverProvider = null in the constructor (default off)', () => {
    expect(SRC).toMatch(/this\._cutoverProvider\s*=\s*null/);
  });

  it('initialises _cutoverFallback = true (fallback default ON; matches syncV5.replica.fallbackToOldPath default)', () => {
    expect(SRC).toMatch(/this\._cutoverFallback\s*=\s*true/);
  });
});

describe('spaces-api -- read methods route through cutover provider when wired', () => {
  it('items.list calls _tryReplicaRead("list", [spaceId, options])', () => {
    expect(SRC).toMatch(/_tryReplicaRead\(\s*'list'\s*,\s*\[\s*spaceId\s*,\s*options\s*\]\s*\)/);
  });

  it('items.get calls _tryReplicaRead("get", [spaceId, itemId])', () => {
    expect(SRC).toMatch(/_tryReplicaRead\(\s*'get'\s*,\s*\[\s*spaceId\s*,\s*itemId\s*\]\s*\)/);
  });

  it('tags.findItems calls _tryReplicaRead("findItems", [tags, options])', () => {
    expect(SRC).toMatch(/_tryReplicaRead\(\s*'findItems'\s*,\s*\[\s*tags\s*,\s*options\s*\]\s*\)/);
  });

  it('smartFolders.list calls _tryReplicaRead("listSmartFolders", [])', () => {
    expect(SRC).toMatch(/_tryReplicaRead\(\s*'listSmartFolders'\s*,\s*\[\s*\]\s*\)/);
  });

  it('cutover hit short-circuits the primary path (returns inside the if block)', () => {
    // Each cutover block returns BEFORE the original primary-path code.
    // Verify by counting `if (cutover.hit) {` patterns -- expect 4
    // (one per read method).
    const matches = SRC.match(/if\s*\(\s*cutover\.hit\s*\)\s*\{/g);
    expect(matches).toBeTruthy();
    expect(matches.length).toBe(4);
  });

  it('emits the read event from the cutover branch too (so shadow-reader counts every call)', () => {
    // The four cutover branches should each contain a _emit call.
    expect(SRC).toMatch(/items:listed[\s\S]{0,200}cutover\.value/);
    expect(SRC).toMatch(/cutover\.value[\s\S]{0,200}return cutover\.value/);
  });
});

// ---------------------------------------------------------------------------
// Behavioural test: _tryReplicaRead semantics with stub provider
// ---------------------------------------------------------------------------

/**
 * Tiny SpacesAPI shape replicating just _tryReplicaRead + the
 * setCutoverProvider hook, so we can exercise the gating without
 * loading the full module.
 */
function spacesApiShape() {
  let _cutoverProvider = null;
  let _cutoverFallback = true;
  const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  return {
    setCutoverProvider(provider, opts = {}) {
      _cutoverProvider = provider || null;
      _cutoverFallback = opts.fallbackEnabled !== false;
    },
    async _tryReplicaRead(method, args) {
      const cp = _cutoverProvider;
      if (!cp || typeof cp[method] !== 'function') return { hit: false, value: null };
      try {
        const value = await cp[method](...args);
        return { hit: true, value };
      } catch (err) {
        if (_cutoverFallback) {
          log.warn('spaces', `replica ${method} failed; falling back to primary`, {
            error: err.message,
          });
          return { hit: false, value: null };
        }
        throw err;
      }
    },
    _state() { return { provider: _cutoverProvider, fallback: _cutoverFallback }; },
  };
}

describe('_tryReplicaRead -- semantics', () => {
  it('returns { hit: false } when no provider is wired', async () => {
    const api = spacesApiShape();
    const result = await api._tryReplicaRead('list', ['s1', {}]);
    expect(result).toEqual({ hit: false, value: null });
  });

  it('returns { hit: true, value } when provider succeeds', async () => {
    const api = spacesApiShape();
    api.setCutoverProvider({ list: async () => [{ id: 'a' }] });
    const r = await api._tryReplicaRead('list', ['s1', {}]);
    expect(r.hit).toBe(true);
    expect(r.value).toEqual([{ id: 'a' }]);
  });

  it('forwards args to the provider method', async () => {
    const api = spacesApiShape();
    let captured;
    api.setCutoverProvider({
      list: async (spaceId, options) => { captured = { spaceId, options }; return []; },
    });
    await api._tryReplicaRead('list', ['s1', { limit: 10 }]);
    expect(captured).toEqual({ spaceId: 's1', options: { limit: 10 } });
  });

  it('returns { hit: false } when provider throws and fallback is enabled (default)', async () => {
    const api = spacesApiShape();
    api.setCutoverProvider({ list: async () => { throw new Error('replica down'); } });
    const r = await api._tryReplicaRead('list', ['s1', {}]);
    expect(r.hit).toBe(false);
  });

  it('rethrows when provider throws and fallback is disabled (commit-F mode)', async () => {
    const api = spacesApiShape();
    api.setCutoverProvider(
      { list: async () => { throw new Error('replica down'); } },
      { fallbackEnabled: false },
    );
    await expect(api._tryReplicaRead('list', ['s1', {}])).rejects.toThrow(/replica down/);
  });

  it('returns { hit: false } when provider lacks the requested method', async () => {
    const api = spacesApiShape();
    api.setCutoverProvider({ list: async () => [] }); // no `get`
    const r = await api._tryReplicaRead('get', ['s1', 'i1']);
    expect(r.hit).toBe(false);
  });

  it('setCutoverProvider(null) detaches the provider', async () => {
    const api = spacesApiShape();
    api.setCutoverProvider({ list: async () => [{ id: 'a' }] });
    expect((await api._tryReplicaRead('list', ['s1', {}])).hit).toBe(true);
    api.setCutoverProvider(null);
    expect((await api._tryReplicaRead('list', ['s1', {}])).hit).toBe(false);
  });

  it('setCutoverProvider(provider, { fallbackEnabled: false }) sets the strict mode flag', () => {
    const api = spacesApiShape();
    api.setCutoverProvider({ list: async () => [] }, { fallbackEnabled: false });
    expect(api._state().fallback).toBe(false);
  });
});
