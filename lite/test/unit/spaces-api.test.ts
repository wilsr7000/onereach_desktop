/**
 * SpacesApi tests.
 *
 * Per Rule 12 / HARNESS.md, every module's `api.ts` runs through
 * `runApiConformanceContract`. Spaces exposes:
 *   - `open()`             -- launches the Spaces window
 *   - `listSpaces()`       -- Phase 1: real Cypher; Phase 0: throws
 *   - `getUncategorizedCount()` -- Phase 1 too
 *   - `items`              -- sub-surface with `list()` and `get()`
 *
 * The default `getSpacesApi()` returns an `UninitializedSpacesApi`
 * that no-ops `open()` and rejects every data method with
 * `SPACES_NOT_INITIALIZED`. The contract verifies surface presence;
 * the module-specific tests verify the uninitialized behaviour.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock electron so the static `import { ... } from 'electron'` in
// spaces/window.ts, ipc.ts, and main.ts resolves under vitest's Node
// runner. We never construct a BrowserWindow or register IPC in the
// surface-only conformance contract.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
}));

// Import directly from the conformance file to keep the test runtime
// surface minimal (matches the settings-api.test.ts pattern).
import { runApiConformanceContract } from '../harness/api-conformance.js';
import {
  getSpacesApi,
  _resetSpacesApiForTesting,
  _setSpacesApiForTesting,
  SPACES_ERROR_CODES,
  type SpacesApi,
} from '../../spaces/api.js';
import { UNCATEGORIZED_SPACE_ID } from '../../spaces/scope.js';

// 1. Conformance contract.
//
// Note: the `items` sub-surface is a namespace object, not a method, so
// it is exercised in the module-specific tests below rather than via
// `expectedMethods` (which asserts each entry is a function).
runApiConformanceContract<SpacesApi>({
  name: 'SpacesApi',
  getInstance: getSpacesApi,
  resetForTesting: _resetSpacesApiForTesting,
  setForTesting: _setSpacesApiForTesting,
  expectedMethods: [
    'open',
    'listSpaces',
    'getUncategorizedCount',
    // Home view (chunk 3k + 3o)
    'getEntityCounts',
    'listRecentItems',
    'topContributors',
    'listRecentEvents',
    'listAgentsSample',
    'getPermissionSummary',
    // Mutations (Phase 3a)
    'createSpace',
    'renameSpace',
    'deleteSpace',
    'undeleteSpace',
  ],
});

// 2. Module-specific shape tests.
describe('SpacesApi (default singleton)', () => {
  it('open() is a no-op before initSpaces() runs', () => {
    _resetSpacesApiForTesting();
    const api = getSpacesApi();
    expect(() => api.open()).not.toThrow();
  });

  it('listSpaces() rejects with SPACES_NOT_INITIALIZED before init', async () => {
    _resetSpacesApiForTesting();
    const api = getSpacesApi();
    await expect(api.listSpaces()).rejects.toMatchObject({
      code: SPACES_ERROR_CODES.NOT_INITIALIZED,
    });
  });

  it('getUncategorizedCount() rejects with SPACES_NOT_INITIALIZED before init', async () => {
    _resetSpacesApiForTesting();
    const api = getSpacesApi();
    await expect(api.getUncategorizedCount()).rejects.toMatchObject({
      code: SPACES_ERROR_CODES.NOT_INITIALIZED,
    });
  });

  it('items.list() rejects with SPACES_NOT_INITIALIZED before init', async () => {
    _resetSpacesApiForTesting();
    const api = getSpacesApi();
    await expect(api.items.list({ kind: 'uncategorized' })).rejects.toMatchObject({
      code: SPACES_ERROR_CODES.NOT_INITIALIZED,
    });
  });

  it('items.get() rejects with SPACES_NOT_INITIALIZED before init', async () => {
    _resetSpacesApiForTesting();
    const api = getSpacesApi();
    await expect(api.items.get('any-id')).rejects.toMatchObject({
      code: SPACES_ERROR_CODES.NOT_INITIALIZED,
    });
  });

  // Mutations (Phase 3a) -- each rejects with NOT_INITIALIZED before
  // initSpaces() runs, matching the rest of the surface.
  it('createSpace() rejects with SPACES_NOT_INITIALIZED before init', async () => {
    _resetSpacesApiForTesting();
    const api = getSpacesApi();
    await expect(api.createSpace({ name: 'whatever' })).rejects.toMatchObject({
      code: SPACES_ERROR_CODES.NOT_INITIALIZED,
    });
  });

  it('renameSpace() rejects with SPACES_NOT_INITIALIZED before init', async () => {
    _resetSpacesApiForTesting();
    const api = getSpacesApi();
    await expect(api.renameSpace('space-x', 'new name')).rejects.toMatchObject({
      code: SPACES_ERROR_CODES.NOT_INITIALIZED,
    });
  });

  it('deleteSpace() rejects with SPACES_NOT_INITIALIZED before init', async () => {
    _resetSpacesApiForTesting();
    const api = getSpacesApi();
    await expect(api.deleteSpace('space-x')).rejects.toMatchObject({
      code: SPACES_ERROR_CODES.NOT_INITIALIZED,
    });
  });

  it('undeleteSpace() rejects with SPACES_NOT_INITIALIZED before init', async () => {
    _resetSpacesApiForTesting();
    const api = getSpacesApi();
    await expect(api.undeleteSpace('space-x')).rejects.toMatchObject({
      code: SPACES_ERROR_CODES.NOT_INITIALIZED,
    });
  });
});

describe('SpacesApi.items sub-surface', () => {
  it('exposes list() and get() as functions', () => {
    _resetSpacesApiForTesting();
    const api = getSpacesApi();
    expect(typeof api.items).toBe('object');
    expect(typeof api.items.list).toBe('function');
    expect(typeof api.items.get).toBe('function');
  });
});

describe('Scope sentinel', () => {
  it('UNCATEGORIZED_SPACE_ID is the documented synthetic id', () => {
    expect(UNCATEGORIZED_SPACE_ID).toBe('__uncategorized__');
  });
});
