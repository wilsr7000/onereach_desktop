/**
 * DiscoveryApi tests.
 *
 * Structured per Rule 12 / HARNESS.md:
 *   1. `runApiConformanceContract` -- the uniform contract every module
 *      passes (singleton, reset, set-for-testing, expected methods).
 *   2. Module-specific behavior tests -- caching, signed-out gating,
 *      error mapping that the contract doesn't cover.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getDiscoveryApi,
  _resetDiscoveryApiForTesting,
  _setDiscoveryApiForTesting,
  _buildDiscoveryApiForTesting,
  DISCOVERY_ERROR_CODES,
  DiscoveryError,
  type DiscoveryApi,
} from '../../discovery/api.js';
import { runApiConformanceContract } from '../harness/conformance.js';

// ─── Fake SDK ─────────────────────────────────────────────────────────────

interface FakeSdkOptions {
  /** Pre-canned URL each `getServiceUrl` returns. Defaults to a per-key URL. */
  urlForKey?: (key: string) => string;
  /** When set, throws this error from getServiceUrl. */
  throwOnGetServiceUrl?: Error;
}

class FakeDiscoverySdk {
  public getServiceUrlCalls: string[] = [];
  public listServicesCalls: number = 0;
  private opts: FakeSdkOptions;

  constructor(_params: { token: () => string; discoveryUrl: string }, opts: FakeSdkOptions = {}) {
    this.opts = opts;
  }

  async getServiceUrl(key: string): Promise<string> {
    this.getServiceUrlCalls.push(key);
    if (this.opts.throwOnGetServiceUrl !== undefined) throw this.opts.throwOnGetServiceUrl;
    if (this.opts.urlForKey !== undefined) return this.opts.urlForKey(key);
    return `https://example.test/${key}`;
  }

  async listServices(): Promise<{ items: Array<{ serviceKey: string; type: string; version: string; url?: string }> }> {
    this.listServicesCalls += 1;
    return {
      items: [
        { serviceKey: 'key-value-storage', type: 'sdk', version: '1.0.0', url: 'https://example.test/kv' },
        { serviceKey: 'flows', type: 'sdk', version: '1.0.0' },
      ],
    };
  }
}

function makeSdkCtor(
  opts: FakeSdkOptions = {}
): new (params: { token: () => string; discoveryUrl: string }) => FakeDiscoverySdk {
  // Tiny adapter so we can pass options to the FakeDiscoverySdk constructor.
  return class extends FakeDiscoverySdk {
    constructor(params: { token: () => string; discoveryUrl: string }) {
      super(params, opts);
    }
  };
}

// ─── 1. Conformance contract ─────────────────────────────────────────────

runApiConformanceContract<DiscoveryApi>({
  name: 'DiscoveryApi',
  getInstance: getDiscoveryApi,
  resetForTesting: _resetDiscoveryApiForTesting,
  setForTesting: _setDiscoveryApiForTesting,
  expectedMethods: ['resolve', 'list', 'invalidateCache', 'onEvent'],
});

// ─── 2. Module-specific behavior ─────────────────────────────────────────

describe('DiscoveryApi behavior', () => {
  beforeEach(() => {
    _resetDiscoveryApiForTesting();
  });

  it('resolve() returns the SDK URL', async () => {
    const api = _buildDiscoveryApiForTesting({
      token: () => 'tok-1',
      discoveryUrl: 'https://discovery.test',
      sdkCtor: makeSdkCtor(),
    });
    const url = await api.resolve('key-value-storage');
    expect(url).toBe('https://example.test/key-value-storage');
  });

  it('resolve() throws DISCOVERY_NOT_AUTHENTICATED when token is empty', async () => {
    const api = _buildDiscoveryApiForTesting({
      token: () => '',
      discoveryUrl: 'https://discovery.test',
      sdkCtor: makeSdkCtor(),
    });
    await expect(api.resolve('key-value-storage')).rejects.toBeInstanceOf(DiscoveryError);
    try {
      await api.resolve('key-value-storage');
    } catch (err) {
      expect((err as DiscoveryError).code).toBe(DISCOVERY_ERROR_CODES.NOT_AUTHENTICATED);
    }
  });

  it('resolve() caches results across repeated calls for the same key', async () => {
    let recordedSdk: FakeDiscoverySdk | null = null;
    class Spy extends FakeDiscoverySdk {
      constructor(p: { token: () => string; discoveryUrl: string }) {
        super(p);
        recordedSdk = this;
      }
    }
    const api = _buildDiscoveryApiForTesting({
      token: () => 'tok',
      discoveryUrl: 'https://discovery.test',
      sdkCtor: Spy,
    });
    await api.resolve('foo');
    await api.resolve('foo');
    await api.resolve('foo');
    expect(recordedSdk!.getServiceUrlCalls).toEqual(['foo']);
  });

  it('invalidateCache() forces re-resolve', async () => {
    let recorded: FakeDiscoverySdk | null = null;
    class Spy extends FakeDiscoverySdk {
      constructor(p: { token: () => string; discoveryUrl: string }) {
        super(p);
        recorded = this;
      }
    }
    const api = _buildDiscoveryApiForTesting({
      token: () => 'tok',
      discoveryUrl: 'https://discovery.test',
      sdkCtor: Spy,
    });
    await api.resolve('foo');
    expect(recorded!.getServiceUrlCalls).toEqual(['foo']);
    api.invalidateCache();
    await api.resolve('foo');
    expect(recorded!.getServiceUrlCalls).toEqual(['foo', 'foo']);
  });

  it('resolve() maps a 401 axios error to DISCOVERY_HTTP', async () => {
    const httpErr = Object.assign(new Error('unauthorized'), {
      response: { status: 401 },
    });
    const api = _buildDiscoveryApiForTesting({
      token: () => 'tok',
      discoveryUrl: 'https://discovery.test',
      sdkCtor: makeSdkCtor({ throwOnGetServiceUrl: httpErr }),
    });
    try {
      await api.resolve('foo');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DiscoveryError);
      expect((err as DiscoveryError).code).toBe(DISCOVERY_ERROR_CODES.HTTP);
      expect((err as DiscoveryError).status).toBe(401);
    }
  });

  it('resolve() maps a 404 axios error to DISCOVERY_NOT_FOUND', async () => {
    const httpErr = Object.assign(new Error('not found'), {
      response: { status: 404 },
    });
    const api = _buildDiscoveryApiForTesting({
      token: () => 'tok',
      discoveryUrl: 'https://discovery.test',
      sdkCtor: makeSdkCtor({ throwOnGetServiceUrl: httpErr }),
    });
    try {
      await api.resolve('unknown-key');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DiscoveryError);
      expect((err as DiscoveryError).code).toBe(DISCOVERY_ERROR_CODES.NOT_FOUND);
    }
  });

  it('resolve() maps a network error to DISCOVERY_NETWORK', async () => {
    const netErr = new Error('ECONNREFUSED');
    const api = _buildDiscoveryApiForTesting({
      token: () => 'tok',
      discoveryUrl: 'https://discovery.test',
      sdkCtor: makeSdkCtor({ throwOnGetServiceUrl: netErr }),
    });
    try {
      await api.resolve('foo');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DiscoveryError);
      expect((err as DiscoveryError).code).toBe(DISCOVERY_ERROR_CODES.NETWORK);
    }
  });

  it('list() returns the SDK service items', async () => {
    const api = _buildDiscoveryApiForTesting({
      token: () => 'tok',
      discoveryUrl: 'https://discovery.test',
      sdkCtor: makeSdkCtor(),
    });
    const services = await api.list();
    expect(services.map((s) => s.serviceKey).sort()).toEqual(['flows', 'key-value-storage']);
  });
});
