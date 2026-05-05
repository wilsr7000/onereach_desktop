/**
 * IdwApi tests.
 *
 * Structured per Rule 12 / HARNESS.md:
 *   1. `runApiConformanceContract` -- the uniform contract every module
 *      passes (singleton, reset, set-for-testing, expected methods).
 *   2. `runErrorConformanceContract` -- the IdwError class threads
 *      code/message/context/remediation/cause through `LiteError`
 *      correctly and codes are namespaced `IDW_`.
 *   3. Module-specific behavior tests using injected stubs.
 *
 * Detailed transport behavior lives in `idw-store.test.ts` and
 * `idw-menu-builder.test.ts`. This file focuses on the shape of the
 * public surface so a regression in api.ts shows up here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getIdwApi,
  _resetIdwApiForTesting,
  _setIdwApiForTesting,
  IdwError,
  IDW_ERROR_CODES,
  IDW_EVENTS,
  isIdwEvent,
  type IdwApi,
  type IdwErrorCode,
} from '../../idw/api.js';
import { runApiConformanceContract } from '../harness/api-conformance.js';
import { runErrorConformanceContract } from '../harness/error-conformance.js';

// 1. Public-surface conformance contract.
runApiConformanceContract<IdwApi>({
  name: 'IdwApi',
  getInstance: getIdwApi,
  resetForTesting: _resetIdwApiForTesting,
  setForTesting: _setIdwApiForTesting,
  expectedMethods: ['list', 'listByKind', 'get', 'add', 'update', 'remove', 'onChange', 'onEvent'],
});

// 2. Error class conformance contract.
runErrorConformanceContract<IdwError>({
  name: 'IdwError',
  ErrorClass: IdwError,
  codeEnum: IDW_ERROR_CODES,
  modulePrefix: 'IDW_',
  constructErrorWithCode: (code) =>
    new IdwError({
      code: code as IdwErrorCode,
      message: 'sample',
      context: { op: 'sample' },
    }),
});

// 3. Module-specific behavior tests.

describe('IdwApi (with stub)', () => {
  beforeEach(() => {
    _resetIdwApiForTesting();
  });

  it('isIdwEvent narrows arbitrary EventRecord by name', () => {
    const goodNames = Object.values(IDW_EVENTS);
    for (const name of goodNames) {
      expect(
        isIdwEvent({
          id: '1',
          timestamp: 't',
          name,
          level: 'info',
          category: 'idw',
        })
      ).toBe(true);
    }
    expect(
      isIdwEvent({
        id: '1',
        timestamp: 't',
        name: 'kv.set.start',
        level: 'info',
        category: 'kv',
      })
    ).toBe(false);
  });

  it('IDW_EVENTS contains start/finish/fail for every CRUD op', () => {
    const names = Object.values(IDW_EVENTS);
    for (const op of ['idw.add', 'idw.update', 'idw.remove']) {
      expect(names).toContain(`${op}.start`);
      expect(names).toContain(`${op}.finish`);
      expect(names).toContain(`${op}.fail`);
    }
  });

  it('IDW_EVENTS contains the expected activity events', () => {
    const names = Object.values(IDW_EVENTS);
    expect(names).toContain('idw.changed');
    expect(names).toContain('idw.opened');
    expect(names).toContain('idw.store.opened');
    expect(names).toContain('idw.store.installed');
    expect(names).toContain('idw.store.updated');
    expect(names).toContain('idw.browser.loading');
    expect(names).toContain('idw.browser.loaded');
  });

  it('IDW_EVENTS contains all expected IPC entry events', () => {
    const names = Object.values(IDW_EVENTS);
    expect(names).toContain('idw.ipc.list');
    expect(names).toContain('idw.ipc.list-by-kind');
    expect(names).toContain('idw.ipc.get');
    expect(names).toContain('idw.ipc.add');
    expect(names).toContain('idw.ipc.update');
    expect(names).toContain('idw.ipc.remove');
    expect(names).toContain('idw.ipc.open');
    expect(names).toContain('idw.ipc.open-store');
  });
});

describe('_setIdwApiForTesting overrides the singleton', () => {
  beforeEach(() => {
    _resetIdwApiForTesting();
  });

  it('returned instance is returned by subsequent getIdwApi calls', () => {
    const stub: IdwApi = {
      list: vi.fn().mockResolvedValue([]),
      listByKind: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      add: vi.fn().mockResolvedValue({
        entry: {
          id: 'x',
          kind: 'idw',
          label: 'x',
          url: 'https://x',
          source: 'manual',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        wasUpdate: false,
      }),
      update: vi.fn().mockResolvedValue({
        id: 'x',
        kind: 'idw',
        label: 'x',
        url: 'https://x',
        source: 'manual',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
      remove: vi.fn().mockResolvedValue(undefined),
      onChange: vi.fn().mockReturnValue(() => undefined),
      onEvent: vi.fn().mockReturnValue(() => undefined),
    };
    _setIdwApiForTesting(stub);
    expect(getIdwApi()).toBe(stub);
  });
});
