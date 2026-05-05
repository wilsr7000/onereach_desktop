/**
 * NeonApi tests.
 *
 * Structured per Rule 12 / HARNESS.md:
 *   1. `runApiConformanceContract` -- the uniform contract every module
 *      passes (singleton, reset, set-for-testing, expected methods).
 *   2. `runErrorConformanceContract` -- every module-specific error
 *      class threads code/message/context/remediation/cause through
 *      `LiteError` correctly and codes are namespaced with the module
 *      prefix.
 *   3. Module-specific behavior tests using injected stubs.
 *
 * Detailed transport behavior lives in `neon-client.test.ts` and
 * `neon-credentials.test.ts`. This file focuses on the shape of the
 * public surface so a regression in api.ts shows up here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getNeonApi,
  _resetNeonApiForTesting,
  _setNeonApiForTesting,
  _setNeonCredentialsProviderForTesting,
  NeonError,
  NEON_ERROR_CODES,
  NEON_EVENTS,
  isNeonEvent,
  type NeonApi,
  type NeonErrorCode,
} from '../../neon/api.js';
import { StaticCredentialsProvider } from '../../neon/credentials.js';
import { runApiConformanceContract } from '../harness/api-conformance.js';
import { runErrorConformanceContract } from '../harness/error-conformance.js';

// 1. Public-surface conformance contract.
runApiConformanceContract<NeonApi>({
  name: 'NeonApi',
  getInstance: getNeonApi,
  resetForTesting: _resetNeonApiForTesting,
  setForTesting: _setNeonApiForTesting,
  expectedMethods: ['query', 'ping', 'status', 'configure', 'onEvent'],
});

// 2. Error class conformance contract.
runErrorConformanceContract<NeonError>({
  name: 'NeonError',
  ErrorClass: NeonError,
  codeEnum: NEON_ERROR_CODES,
  modulePrefix: 'NEON_',
  constructErrorWithCode: (code) =>
    new NeonError({
      code: code as NeonErrorCode,
      message: 'sample',
      context: { op: 'sample' },
    }),
});

// 3. Module-specific behavior tests.

describe('NeonApi (with StaticCredentialsProvider) end-to-end', () => {
  beforeEach(() => {
    _resetNeonApiForTesting();
  });

  it('status() reflects the provider when nothing is configured', async () => {
    _setNeonCredentialsProviderForTesting(new StaticCredentialsProvider());
    // We need to swap fetch so configure -> status doesn't reach out.
    // The default api never touches fetch on status() (it only reads
    // provider state) so we don't need to stub it here.
    const api = getNeonApi();
    const status = await api.status();
    expect(status.endpoint).toBeNull();
    expect(status.uri).toBeNull();
    expect(status.user).toBe('neo4j');
    expect(status.database).toBe('neo4j');
    expect(status.hasPassword).toBe(false);
    expect(status.ready).toBe(false);
  });

  it('status() reports ready when endpoint+uri+password are set', async () => {
    _setNeonCredentialsProviderForTesting(
      new StaticCredentialsProvider({
        endpoint: 'https://example.com/neon',
        uri: 'neo4j+s://abc.databases.neo4j.io',
        user: 'neo4j',
        password: 'secret',
        database: 'neo4j',
      })
    );
    const api = getNeonApi();
    const status = await api.status();
    expect(status.ready).toBe(true);
    expect(status.hasPassword).toBe(true);
    expect(status.endpoint).toBe('https://example.com/neon');
    expect(status.uri).toBe('neo4j+s://abc.databases.neo4j.io');
  });

  it('configure() persists fields and re-reads via status()', async () => {
    const provider = new StaticCredentialsProvider();
    _setNeonCredentialsProviderForTesting(provider);

    await getNeonApi().configure({
      endpoint: 'https://example.com/neon',
      uri: 'neo4j+s://abc.databases.neo4j.io',
      password: 'pw',
    });

    const status = await getNeonApi().status();
    expect(status.endpoint).toBe('https://example.com/neon');
    expect(status.uri).toBe('neo4j+s://abc.databases.neo4j.io');
    expect(status.hasPassword).toBe(true);
    expect(status.ready).toBe(true);
  });

  it('configure() leaves omitted fields unchanged', async () => {
    const provider = new StaticCredentialsProvider({
      endpoint: 'https://e1.example/neon',
      uri: 'neo4j+s://a.databases.neo4j.io',
      user: 'neo4j',
      password: 'p1',
      database: 'neo4j',
    });
    _setNeonCredentialsProviderForTesting(provider);

    await getNeonApi().configure({ uri: 'neo4j+s://b.databases.neo4j.io' });

    const snapshot = provider._snapshot();
    expect(snapshot.endpoint).toBe('https://e1.example/neon');
    expect(snapshot.uri).toBe('neo4j+s://b.databases.neo4j.io');
    expect(snapshot.password).toBe('p1');
  });

  it('query() rejects with NEON_NOT_CONFIGURED when nothing is set', async () => {
    _setNeonCredentialsProviderForTesting(new StaticCredentialsProvider());
    await expect(getNeonApi().query('RETURN 1')).rejects.toMatchObject({
      code: NEON_ERROR_CODES.NOT_CONFIGURED,
    });
  });

  it('query() rejects with NEON_BAD_INPUT for empty cypher', async () => {
    _setNeonCredentialsProviderForTesting(
      new StaticCredentialsProvider({
        endpoint: 'https://example.com/neon',
        uri: 'neo4j+s://abc.databases.neo4j.io',
        password: 'pw',
      })
    );
    await expect(getNeonApi().query('')).rejects.toMatchObject({
      code: NEON_ERROR_CODES.BAD_INPUT,
    });
    await expect(getNeonApi().query('   ')).rejects.toMatchObject({
      code: NEON_ERROR_CODES.BAD_INPUT,
    });
  });

  it('isNeonEvent() narrows arbitrary EventRecord by name', () => {
    const goodNames = Object.values(NEON_EVENTS);
    for (const name of goodNames) {
      expect(
        isNeonEvent({
          id: '1',
          timestamp: 't',
          name,
          level: 'info',
          category: 'neon',
        })
      ).toBe(true);
    }
    expect(
      isNeonEvent({
        id: '1',
        timestamp: 't',
        name: 'kv.set.start',
        level: 'info',
        category: 'kv',
      })
    ).toBe(false);
  });

  it('NEON_EVENTS contains start/finish/fail for every span op', () => {
    const names = Object.values(NEON_EVENTS);
    for (const op of ['neon.query', 'neon.ping', 'neon.configure']) {
      expect(names).toContain(`${op}.start`);
      expect(names).toContain(`${op}.finish`);
      expect(names).toContain(`${op}.fail`);
    }
  });
});

describe('_setNeonApiForTesting overrides the singleton', () => {
  beforeEach(() => {
    _resetNeonApiForTesting();
  });

  it('returned instance is returned by subsequent getNeonApi calls', () => {
    const stub: NeonApi = {
      query: vi.fn().mockResolvedValue([]),
      ping: vi.fn().mockResolvedValue(true),
      status: vi.fn().mockResolvedValue({
        endpoint: null,
        uri: null,
        user: 'neo4j',
        database: 'neo4j',
        hasPassword: false,
        ready: false,
      }),
      configure: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn().mockReturnValue(() => undefined),
    };
    _setNeonApiForTesting(stub);
    expect(getNeonApi()).toBe(stub);
  });
});
