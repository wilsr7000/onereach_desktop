/**
 * Spaces platform-contract proof.
 *
 * This test is the **non-negotiable Phase 2 gate** from the Spaces
 * plan (see Success Criteria → Phase 2 → "Platform-contract proof"):
 *
 *   > A stub consumer outside `lite/spaces/` imports `getSpacesApi()`,
 *   > calls `listSpaces()` and `items.list()`, and asserts the
 *   > returned shapes match the public types. This is the
 *   > non-negotiable test of the platform claim -- if the SDK can't
 *   > be consumed from outside the module without reaching into
 *   > internals, the platform discipline failed and the Phase 2 ship
 *   > is blocked until it succeeds.
 *
 * The discipline this file enforces:
 *   - Only `lite/spaces/api.ts` is imported. Never `sdk-client.ts`,
 *     never `types.ts` directly, never `errors.ts` directly. Every
 *     consumer-visible symbol must come through the api barrel.
 *   - The exported `SpacesApi` is fully consumable end-to-end via
 *     `_setSpacesApiForTesting()`, the same hook external consumers
 *     would use to inject a stub or a fake.
 *   - Returned shapes match the documented types (`Space`, `Item`,
 *     `ItemSummary`, `SpaceChipRef`, `ItemProvenance`).
 *   - Documented errors (`SpacesError` + `SPACES_ERROR_CODES`) are
 *     catchable through the public surface.
 *   - The event taxonomy (`SPACES_EVENTS`, `isSpacesEvent`) is part
 *     of the public surface.
 *   - The module-version constant (`SPACES_MODULE_VERSION`) is
 *     exported and pinnable.
 *   - The synthetic Uncategorized sentinel (`UNCATEGORIZED_SPACE_ID`)
 *     and the `resolveSpaceScope()` helper are part of the public
 *     surface so consumers can call the typed methods without
 *     hand-rolling the scope union.
 *
 * If this test fails after a refactor, do NOT relax the imports.
 * Restore the missing public re-export and re-run.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// ────────────────────────────────────────────────────────────────────────
// IMPORT DISCIPLINE: every symbol below comes through the api barrel.
// Any reach-into-internals here is a test-suite-level violation.
// ────────────────────────────────────────────────────────────────────────
import {
  // Singleton + lifecycle
  getSpacesApi,
  _setSpacesApiForTesting,
  _resetSpacesApiForTesting,
  // Surface types
  type SpacesApi,
  type Space,
  type ItemSummary,
  type Item,
  type SpaceChipRef,
  type ItemProvenance,
  type ItemKind,
  type ListOpts,
  // Scope helper
  type SpaceScope,
  UNCATEGORIZED_SPACE_ID,
  resolveSpaceScope,
  isUncategorized,
  // Errors
  SpacesError,
  SPACES_ERROR_CODES,
  type SpacesErrorCode,
  // Events
  SPACES_EVENTS,
  isSpacesEvent,
  type SpacesEventName,
  // Version
  SPACES_MODULE_VERSION,
  // Generic base from the platform error hierarchy
  LiteError,
  isLiteError,
} from '../../../spaces/api.js';

// ────────────────────────────────────────────────────────────────────────
// Stub consumer: implements `SpacesApi` end-to-end. A real second
// consumer (GSX agent runtime, Cowork) would build something more
// elaborate; this stub captures the minimum surface area an external
// caller has to satisfy to use the module.
// ────────────────────────────────────────────────────────────────────────

interface StubCalls {
  open: number;
  listSpaces: number;
  getUncategorizedCount: number;
  itemsList: Array<{ scope: SpaceScope; opts: ListOpts | undefined }>;
  itemsGet: string[];
  itemsResolveFileUrl: string[];
}

function buildStubConsumer(): {
  api: SpacesApi;
  calls: StubCalls;
  setSpaces(spaces: Space[]): void;
  setItems(items: ItemSummary[]): void;
  setItem(id: string, item: Item | null): void;
  setFileUrl(key: string, url: string | null): void;
  setNextError(err: SpacesError): void;
} {
  const calls: StubCalls = {
    open: 0,
    listSpaces: 0,
    getUncategorizedCount: 0,
    itemsList: [],
    itemsGet: [],
    itemsResolveFileUrl: [],
  };
  let spaces: Space[] = [];
  let items: ItemSummary[] = [];
  const itemMap = new Map<string, Item | null>();
  const fileUrlMap = new Map<string, string | null>();
  let nextError: SpacesError | null = null;

  function maybeFail<T>(fallback: T): T {
    if (nextError !== null) {
      const e = nextError;
      nextError = null;
      throw e;
    }
    return fallback;
  }

  const api: SpacesApi = {
    open: () => {
      calls.open++;
    },
    listSpaces: async () => {
      calls.listSpaces++;
      return maybeFail(spaces);
    },
    getUncategorizedCount: async () => {
      calls.getUncategorizedCount++;
      return maybeFail(0);
    },
    items: {
      list: async (scope, opts) => {
        calls.itemsList.push({ scope, opts });
        return maybeFail(items);
      },
      get: async (id) => {
        calls.itemsGet.push(id);
        return maybeFail(itemMap.get(id) ?? null);
      },
      resolveFileUrl: async (key) => {
        calls.itemsResolveFileUrl.push(key);
        return maybeFail(fileUrlMap.get(key) ?? null);
      },
      // Phase 3b — item mutations. Default stubs return the
      // canonical empty shapes; specific Phase 3b unit tests
      // exercise the real behavior. The platform contract just
      // asserts the surface is consumable.
      update: async (_id, _patch) => maybeFail({} as unknown as Item),
      addTag: async (_id, _tag) => maybeFail([] as string[]),
      removeTag: async (_id, _tag) => maybeFail([] as string[]),
      // Phase 3c — per-asset activity log. Stub returns an empty event
      // list; specific behavior is exercised by spaces-sdk-client tests.
      recentCommits: async (_id, _opts) => maybeFail([]),
    },
    // Home view (chunk 3k + 3o). Stub returns are not exercised by
    // the platform-contract tests below; they're here so the stub
    // shape satisfies the SpacesApi interface.
    getEntityCounts: async () =>
      maybeFail({ spaces: 0, assets: 0, people: 0, agents: 0 }),
    listRecentItems: async () => maybeFail([] as ItemSummary[]),
    topContributors: async () => maybeFail([]),
    listRecentEvents: async () => maybeFail([]),
    listAgentsSample: async () => maybeFail([]),
    getPermissionSummary: async () => maybeFail({ visibleSpaceCount: 0 }),
    // Mutations (Phase 3a). Same rationale -- stubs to satisfy the
    // interface; specific mutation tests live in
    // trust-principles.test.ts and the sdk-client unit tests.
    createSpace: async (input) =>
      maybeFail<Space>({
        id: `space-stub-${Date.now()}`,
        name: input.name,
      }),
    renameSpace: async (id, name) => maybeFail<Space>({ id, name }),
    deleteSpace: async () => {
      maybeFail(undefined);
    },
    undeleteSpace: async (id) => maybeFail<Space>({ id, name: '' }),
  };

  return {
    api,
    calls,
    setSpaces: (s) => {
      spaces = s;
    },
    setItems: (xs) => {
      items = xs;
    },
    setItem: (id, item) => {
      itemMap.set(id, item);
    },
    setFileUrl: (key, url) => {
      fileUrlMap.set(key, url);
    },
    setNextError: (err) => {
      nextError = err;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetSpacesApiForTesting();
});

afterEach(() => {
  _resetSpacesApiForTesting();
});

describe('Spaces SDK — platform-contract proof', () => {
  it('every consumer-facing symbol is re-exported from api.ts', () => {
    // If this test compiles + runs, the import block at the top of
    // this file proved that every symbol survives the api.ts barrel.
    // Runtime assertion: the symbols are actual values, not undefined.
    expect(typeof getSpacesApi).toBe('function');
    expect(typeof _setSpacesApiForTesting).toBe('function');
    expect(typeof _resetSpacesApiForTesting).toBe('function');
    expect(typeof resolveSpaceScope).toBe('function');
    expect(typeof isUncategorized).toBe('function');
    expect(typeof isSpacesEvent).toBe('function');
    expect(typeof isLiteError).toBe('function');
    expect(typeof UNCATEGORIZED_SPACE_ID).toBe('string');
    expect(typeof SPACES_MODULE_VERSION).toBe('number');
    expect(typeof SPACES_ERROR_CODES).toBe('object');
    expect(typeof SPACES_EVENTS).toBe('object');
    expect(SpacesError.prototype).toBeInstanceOf(Error);
    expect(LiteError.prototype).toBeInstanceOf(Error);
  });

  it('SPACES_MODULE_VERSION is a positive integer (versioning contract)', () => {
    expect(Number.isInteger(SPACES_MODULE_VERSION)).toBe(true);
    expect(SPACES_MODULE_VERSION).toBeGreaterThan(0);
  });

  it('SPACES_ERROR_CODES is the documented stable catalog', () => {
    // Adding codes is fine; removing them silently breaks downstream
    // consumers. This guards the catalog as a published contract.
    const codes = new Set(Object.values(SPACES_ERROR_CODES));
    expect(codes).toContain('SPACES_NOT_AUTHENTICATED');
    expect(codes).toContain('SPACES_NOT_FOUND');
    expect(codes).toContain('SPACES_FORBIDDEN');
    expect(codes).toContain('SPACES_CYPHER');
    expect(codes).toContain('SPACES_NETWORK');
    expect(codes).toContain('SPACES_INVALID_INPUT');
    expect(codes).toContain('SPACES_NOT_INITIALIZED');
  });

  it('SPACES_EVENTS catalog contains start/finish/fail triples for every public op', () => {
    const names = new Set<string>(Object.values(SPACES_EVENTS));
    const expectTriple = (base: string): void => {
      expect(names).toContain(`${base}.start`);
      expect(names).toContain(`${base}.finish`);
      expect(names).toContain(`${base}.fail`);
    };
    expectTriple('spaces.listSpaces');
    expectTriple('spaces.items.list');
    expectTriple('spaces.items.get');
    expectTriple('spaces.uncategorizedCount');
  });

  it('UNCATEGORIZED_SPACE_ID resolves through the public scope helper', () => {
    const scope = resolveSpaceScope(UNCATEGORIZED_SPACE_ID);
    expect(scope.kind).toBe('uncategorized');
    expect(isUncategorized(scope)).toBe(true);
  });

  it('a plain space id resolves to the space-scope variant', () => {
    const scope = resolveSpaceScope('sp-123');
    expect(scope.kind).toBe('space');
    if (scope.kind === 'space') {
      expect(scope.spaceId).toBe('sp-123');
    }
    expect(isUncategorized(scope)).toBe(false);
  });

  it('isSpacesEvent narrows a generic event payload by name prefix', () => {
    // `isSpacesEvent` takes a generic `EventRecord` -- the central
    // logging shape -- and narrows to `SpacesEvent` based on the
    // `name` field. Build a minimal record that satisfies the input
    // contract from the public surface alone (no internal types).
    const base = {
      id: 'e-1',
      timestamp: '2026-01-01T00:00:00Z',
      level: 'info' as const,
    };
    expect(
      isSpacesEvent({
        ...base,
        category: 'spaces',
        name: 'spaces.listSpaces.finish',
      })
    ).toBe(true);
    expect(
      isSpacesEvent({
        ...base,
        category: 'auth',
        name: 'auth.sign-in.finish',
      })
    ).toBe(false);
  });

  it('SpacesError is a subclass of LiteError and is catchable through either', () => {
    const err = new SpacesError({
      code: 'SPACES_CYPHER',
      message: 'fake',
    });
    expect(err).toBeInstanceOf(SpacesError);
    expect(err).toBeInstanceOf(LiteError);
    expect(err).toBeInstanceOf(Error);
    expect(isLiteError(err)).toBe(true);
    const code: SpacesErrorCode = err.code as SpacesErrorCode;
    expect(code).toBe('SPACES_CYPHER');
  });
});

describe('Spaces SDK — consuming the surface end-to-end', () => {
  it('a stub consumer can install via _setSpacesApiForTesting and be observed via getSpacesApi', () => {
    const stub = buildStubConsumer();
    _setSpacesApiForTesting(stub.api);
    const observed = getSpacesApi();
    // Reference equality: the singleton resolves to the installed stub.
    expect(observed).toBe(stub.api);
  });

  it('listSpaces returns the documented Space shape', async () => {
    const stub = buildStubConsumer();
    const fixture: Space = {
      id: 'sp-1',
      name: 'Engineering',
      description: 'Eng work',
      color: '#4f8cff',
      iconKey: 'cog',
      itemCount: 12,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-05T00:00:00Z',
    };
    stub.setSpaces([fixture]);
    _setSpacesApiForTesting(stub.api);
    const spaces = await getSpacesApi().listSpaces();
    expect(stub.calls.listSpaces).toBe(1);
    expect(spaces).toEqual([fixture]);
    // Type narrowing: pick out a couple of fields without `any`.
    const first: Space | undefined = spaces[0];
    if (first !== undefined) {
      const _name: string = first.name;
      const _count: number | undefined = first.itemCount;
      void _name;
      void _count;
    }
  });

  it('items.list with kind=uncategorized passes the typed scope through', async () => {
    const stub = buildStubConsumer();
    const summary: ItemSummary = {
      id: 'i-1',
      title: 'Inbox item',
      kind: 'document' satisfies ItemKind,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      otherSpaces: [] satisfies SpaceChipRef[],
      producedBy: null as ItemProvenance | null,
    };
    stub.setItems([summary]);
    _setSpacesApiForTesting(stub.api);
    const scope = resolveSpaceScope(UNCATEGORIZED_SPACE_ID);
    const items = await getSpacesApi().items.list(scope, { limit: 25 });
    expect(stub.calls.itemsList[0]?.scope).toEqual({ kind: 'uncategorized' });
    expect(stub.calls.itemsList[0]?.opts).toEqual({ limit: 25 });
    expect(items).toEqual([summary]);
  });

  it('items.list with kind=space carries the spaceId through the typed scope', async () => {
    const stub = buildStubConsumer();
    stub.setItems([]);
    _setSpacesApiForTesting(stub.api);
    const scope: SpaceScope = { kind: 'space', spaceId: 'sp-77' };
    await getSpacesApi().items.list(scope);
    expect(stub.calls.itemsList[0]?.scope).toEqual({
      kind: 'space',
      spaceId: 'sp-77',
    });
  });

  it('items.get returns the documented Item shape (content + metadata + chips)', async () => {
    const stub = buildStubConsumer();
    const chip: SpaceChipRef = {
      id: 'sp-2',
      name: 'Sales',
      color: '#ff9c4a',
      iconKey: 'briefcase',
    };
    const provenance: ItemProvenance = {
      kind: 'Agent',
      name: 'Quarterly Audit Agent',
      id: 'ag-1',
    };
    const item: Item = {
      id: 'i-100',
      title: 'Spec doc',
      kind: 'text',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      excerpt: 'first 120 chars…',
      content: 'full body',
      metadata: { source: 'web-clip' },
      otherSpaces: [chip],
      producedBy: provenance,
    };
    stub.setItem('i-100', item);
    _setSpacesApiForTesting(stub.api);
    const got = await getSpacesApi().items.get('i-100');
    expect(stub.calls.itemsGet).toEqual(['i-100']);
    expect(got).toEqual(item);
    if (got !== null) {
      // Compile-time + runtime: the public types let consumers
      // navigate the full Item without casts.
      const chipName: string | undefined = got.otherSpaces[0]?.name;
      const prov: ItemProvenance | null = got.producedBy;
      expect(chipName).toBe('Sales');
      expect(prov?.kind).toBe('Agent');
    }
  });

  it('items.get returns null when the stub has no entry for the id', async () => {
    const stub = buildStubConsumer();
    _setSpacesApiForTesting(stub.api);
    const got = await getSpacesApi().items.get('missing');
    expect(got).toBeNull();
  });

  it('items.resolveFileUrl passes the key through and returns the signed URL', async () => {
    const stub = buildStubConsumer();
    stub.setFileUrl('images/foo.png', 'https://signed.example.com/foo.png');
    _setSpacesApiForTesting(stub.api);
    const url = await getSpacesApi().items.resolveFileUrl('images/foo.png');
    expect(stub.calls.itemsResolveFileUrl).toEqual(['images/foo.png']);
    expect(url).toBe('https://signed.example.com/foo.png');
  });

  it('items.resolveFileUrl returns null for unknown keys (soft contract)', async () => {
    const stub = buildStubConsumer();
    _setSpacesApiForTesting(stub.api);
    const url = await getSpacesApi().items.resolveFileUrl('missing/key');
    expect(url).toBeNull();
  });

  it('getUncategorizedCount returns a number through the public surface', async () => {
    const stub = buildStubConsumer();
    _setSpacesApiForTesting(stub.api);
    const count = await getSpacesApi().getUncategorizedCount();
    expect(typeof count).toBe('number');
    expect(stub.calls.getUncategorizedCount).toBe(1);
  });

  it('open() is fire-and-forget (returns void, never throws)', () => {
    const stub = buildStubConsumer();
    _setSpacesApiForTesting(stub.api);
    expect(() => getSpacesApi().open()).not.toThrow();
    expect(stub.calls.open).toBe(1);
  });

  it('thrown SpacesError can be caught + branched on .code via the public surface', async () => {
    const stub = buildStubConsumer();
    stub.setNextError(
      new SpacesError({
        code: 'SPACES_NOT_AUTHENTICATED',
        message: 'no mult token',
        remediation: 'Sign in.',
      })
    );
    _setSpacesApiForTesting(stub.api);
    try {
      await getSpacesApi().listSpaces();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SpacesError);
      if (err instanceof SpacesError) {
        expect(err.code).toBe(SPACES_ERROR_CODES.NOT_AUTHENTICATED);
        expect(err.message).toContain('no mult token');
      }
    }
  });

  it('reset returns the uninitialized stub (throws SPACES_NOT_INITIALIZED on data methods)', async () => {
    _resetSpacesApiForTesting();
    await expect(getSpacesApi().listSpaces()).rejects.toMatchObject({
      code: 'SPACES_NOT_INITIALIZED',
    });
  });
});

describe('Spaces SDK — name conventions match the platform contract', () => {
  it('every event name uses the spaces.<op>.start | finish | fail taxonomy', () => {
    const ALLOWED_SUFFIXES = ['.start', '.finish', '.fail'];
    for (const name of Object.values(SPACES_EVENTS)) {
      expect(name.startsWith('spaces.')).toBe(true);
      expect(ALLOWED_SUFFIXES.some((s) => name.endsWith(s))).toBe(true);
    }
  });

  it('every event-name string in SPACES_EVENTS is registered in the SpacesEventName union', () => {
    // Compile-time check: SpacesEventName is the union; this loop
    // forces each catalog entry through the union type at runtime
    // and would fail to compile if a name fell out of sync.
    for (const name of Object.values(SPACES_EVENTS)) {
      const typed: SpacesEventName = name;
      void typed;
    }
    expect(true).toBe(true);
  });
});
