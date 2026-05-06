/**
 * ToolsApi tests.
 *
 * Per Rule 12 / HARNESS.md, every public api.ts has a contract test
 * that runs `runApiConformanceContract` from the harness, plus the
 * uniform error-class contract. Module-specific behavior + transport
 * coverage lives in `tools-store.test.ts`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getToolsApi,
  _resetToolsApiForTesting,
  _setToolsApiForTesting,
  ToolsError,
  TOOLS_ERROR_CODES,
  TOOLS_EVENTS,
  isToolsEvent,
  type ToolsApi,
  type ToolsErrorCode,
} from '../../tools/api.js';
import { runApiConformanceContract } from '../harness/api-conformance.js';
import { runErrorConformanceContract } from '../harness/error-conformance.js';

// 1. Public-surface conformance contract.
runApiConformanceContract<ToolsApi>({
  name: 'ToolsApi',
  getInstance: getToolsApi,
  resetForTesting: _resetToolsApiForTesting,
  setForTesting: _setToolsApiForTesting,
  expectedMethods: ['list', 'get', 'add', 'update', 'remove', 'onChange', 'onEvent'],
});

// 2. Error class conformance contract.
runErrorConformanceContract<ToolsError>({
  name: 'ToolsError',
  ErrorClass: ToolsError,
  codeEnum: TOOLS_ERROR_CODES,
  modulePrefix: 'TOOLS_',
  constructErrorWithCode: (code) =>
    new ToolsError({
      code: code as ToolsErrorCode,
      message: 'sample',
      context: { op: 'sample' },
    }),
});

// 3. Module-specific behavior.

describe('ToolsApi event surface', () => {
  beforeEach(() => {
    _resetToolsApiForTesting();
  });

  it('isToolsEvent narrows arbitrary EventRecord by name', () => {
    for (const name of Object.values(TOOLS_EVENTS)) {
      expect(
        isToolsEvent({
          id: '1',
          timestamp: 't',
          name,
          level: 'info',
          category: 'tools',
        })
      ).toBe(true);
    }
    expect(
      isToolsEvent({
        id: '1',
        timestamp: 't',
        name: 'kv.set.start',
        level: 'info',
        category: 'kv',
      })
    ).toBe(false);
  });

  it('TOOLS_EVENTS contains start/finish/fail for every CRUD op', () => {
    const names = Object.values(TOOLS_EVENTS);
    for (const op of ['tools.add', 'tools.update', 'tools.remove']) {
      expect(names).toContain(`${op}.start`);
      expect(names).toContain(`${op}.finish`);
      expect(names).toContain(`${op}.fail`);
    }
  });

  it('TOOLS_EVENTS contains the expected activity events', () => {
    const names = Object.values(TOOLS_EVENTS);
    expect(names).toContain('tools.changed');
    expect(names).toContain('tools.opened');
    expect(names).toContain('tools.manage.opened');
  });

  it('TOOLS_EVENTS contains all expected IPC entry events', () => {
    const names = Object.values(TOOLS_EVENTS);
    expect(names).toContain('tools.ipc.list');
    expect(names).toContain('tools.ipc.get');
    expect(names).toContain('tools.ipc.add');
    expect(names).toContain('tools.ipc.update');
    expect(names).toContain('tools.ipc.remove');
    expect(names).toContain('tools.ipc.open');
    expect(names).toContain('tools.ipc.open-manager');
  });
});

describe('_setToolsApiForTesting overrides the singleton', () => {
  beforeEach(() => {
    _resetToolsApiForTesting();
  });

  it('returned instance is returned by subsequent getToolsApi calls', () => {
    const stub: ToolsApi = {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      add: vi.fn().mockResolvedValue({
        id: 'x',
        label: 'X',
        url: 'https://x.example',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
      update: vi.fn().mockResolvedValue({
        id: 'x',
        label: 'X',
        url: 'https://x.example',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
      remove: vi.fn().mockResolvedValue(undefined),
      onChange: vi.fn().mockReturnValue(() => undefined),
      onEvent: vi.fn().mockReturnValue(() => undefined),
    };
    _setToolsApiForTesting(stub);
    expect(getToolsApi()).toBe(stub);
  });
});
