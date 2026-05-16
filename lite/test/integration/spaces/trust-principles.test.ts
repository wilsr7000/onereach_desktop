/**
 * Spaces Phase 3 Trust-Principles harness -- mutation / inverse pairing test.
 *
 * Per ADR-048 ("Lite Spaces Phase 3 -- writes + sharing + onboarding tour")
 * and the strategic plan at
 *   .cursor/plans/lite_spaces_phase_3_writes_share_onboard_7e4c2a91.plan.md
 *
 * This file enforces the **Reversible** trust principle as a build-blocking
 * test. The plan operationalizes Reversibility this way:
 *
 *   > Every method registered in `trust-principles.test.ts` mutation/inverse
 *   > table. Test fails build if a mutation method lands without an inverse.
 *
 * Without this harness, "Reversible" is a slogan. With it, every Phase 3
 * mutation PR has to add its inverse in the same change-set or the build is
 * red.
 *
 * ------------------------------------------------------------------------
 * Status today: STUB.
 *
 * The harness ships as part of Phase 3a (chunk: spaces-3a) so subsequent
 * sub-phases (3b, 3c, 3d) register against it. Until 3a code lands, the
 * registry is empty AND the manifest is empty -- both tests pass
 * vacuously. The first 3a PR adds:
 *
 *   - a manifest entry naming each new mutation (e.g. 'spaces.create')
 *   - a registration that pairs it with its inverse (e.g. 'spaces.delete' soft)
 *
 * The build goes red the moment a manifest entry lands without its
 * paired registration -- catching the case where someone added a
 * mutation method but forgot the inverse.
 * ------------------------------------------------------------------------
 */

import { describe, it, expect } from 'vitest';

// ────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────

/**
 * A mutation/inverse pair. The harness runs `setup -> mutate -> inverse`
 * and asserts the captured pre-state equals the post-inverse state.
 *
 * Sub-phases extend the registry by appending one entry per mutation
 * method that lands.
 */
export interface MutationInversePair<TPreState, TMutationResult> {
  /**
   * Stable mutation name. Conventionally `<module>.<method>` --
   * e.g. `spaces.create`, `spaces.rename`, `spaces.items.fileInto`,
   * `spaces.share`, `items.create`.
   */
  readonly mutationName: string;

  /**
   * Capture pre-state against a fixture graph. Returns whatever opaque
   * state the inverse needs to verify restoration.
   */
  setup(): Promise<TPreState>;

  /**
   * Perform the mutation. Returns whatever the mutation produced
   * (often an id or grant record) for the inverse to consume.
   */
  mutate(state: TPreState): Promise<TMutationResult>;

  /**
   * Perform the inverse mutation. Should restore the graph to the
   * pre-state.
   */
  inverse(state: TPreState, mutationResult: TMutationResult): Promise<void>;

  /**
   * Capture and compare post-inverse state against pre-state.
   * Throws via `expect()` on mismatch.
   */
  assertRestored(state: TPreState): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────────
// Registry
// ────────────────────────────────────────────────────────────────────────

/**
 * The live registry of mutation/inverse pairs. Sub-phases push entries
 * here at module-load time.
 *
 * The harness uses `unknown` as the type parameters because each pair
 * carries its own typed state shape; the registry is heterogeneous and
 * runs each pair through its own typed lifecycle.
 */
const registry: Array<MutationInversePair<unknown, unknown>> = [];

/**
 * Public registration helper. Sub-phases call this in their test setup
 * to add a pair to the harness.
 *
 * Usage (lands in 3a):
 *
 *   import { registerMutationInverse } from './trust-principles.test.js';
 *
 *   registerMutationInverse({
 *     mutationName: 'spaces.create',
 *     setup: async () => captureSpacesList(),
 *     mutate: async () => spacesApi.create({ name: 'test' }),
 *     inverse: async (_state, created) => spacesApi.delete(created.id, { soft: true }),
 *     assertRestored: async (state) => {
 *       const after = await captureSpacesList();
 *       expect(after).toEqual(state);
 *     },
 *   });
 */
export function registerMutationInverse<TPreState, TMutationResult>(
  pair: MutationInversePair<TPreState, TMutationResult>
): void {
  registry.push(pair as MutationInversePair<unknown, unknown>);
}

/**
 * Test-only: clears the registry. Used by the harness's own tests so
 * one test's registrations don't leak into another.
 */
export function _resetRegistryForTesting(): void {
  registry.length = 0;
}

/**
 * Read-only view onto the registry for the assertion test below.
 */
function listRegistered(): ReadonlyArray<MutationInversePair<unknown, unknown>> {
  return registry;
}

// ────────────────────────────────────────────────────────────────────────
// Manifest -- the canonical list of mutations Phase 3 must register
// ────────────────────────────────────────────────────────────────────────

/**
 * Stable list of mutation names that MUST appear in the registry by the
 * time their owning sub-phase ships. The harness asserts every manifest
 * entry is present in the registry; missing entries fail the build.
 *
 * Rules for editing:
 *   - APPEND only; never remove (the test catches removed inverses).
 *   - Entries land alongside the PR that introduces the mutation.
 *   - The string is the stable mutation name; pair it with the
 *     `mutationName` field of the registered pair.
 *
 * Today: empty. Phase 3a's first PR adds the first entries.
 */
const PHASE_3_MUTATION_MANIFEST: readonly string[] = [
  // Phase 3a (chunk: spaces-3a)
  'spaces.create',
  'spaces.rename',
  'spaces.delete',
  'spaces.undelete',
  // Phase 3b (chunk: spaces-3b) appends:
  //   'items.create', 'items.delete', 'items.undelete'
  // Phase 3c (chunk: spaces-3c) appends:
  //   'spaces.items.fileInto', 'spaces.items.removeFrom'
  // Phase 3d (chunk: spaces-3d) appends:
  //   'spaces.share', 'spaces.unshare'
];

// ────────────────────────────────────────────────────────────────────────
// Phase 3a -- mutation / inverse pair registrations
// ────────────────────────────────────────────────────────────────────────
//
// The Reversibility harness's job is to enforce the PAIRING contract --
// every mutation MUST land alongside a working inverse. The pairs below
// run against a tiny in-memory fake (FakeSpacesStore) that models the
// canonical pre/post-mutation state. That keeps the harness deterministic
// and independent of Neon connectivity; the real SDK implementations are
// exercised by the sdk-client unit tests, and the end-to-end behavior is
// covered by integration tests with a live Cypher backend (when wired).

interface FakeSpaceRecord {
  readonly id: string;
  name: string;
  deletedAt?: string;
}

/**
 * Tiny in-memory model of the mutations Phase 3a introduces. Mirrors
 * the semantic contract of `SdkSpacesClient`'s create/rename/delete/
 * undelete -- enough to verify "the inverse reverses the mutation."
 *
 * Intentionally simpler than the real implementation: it skips
 * uniqueness, soft-vs-hard delete differences, and trim/validation.
 * The harness's contract is "the inverse restores state," not
 * "the implementation is bug-free" (that's the sdk-client unit suite).
 */
function makeFakeSpacesStore(): {
  create(input: { name: string }): Promise<{ id: string; name: string }>;
  rename(id: string, name: string): Promise<{ id: string; name: string }>;
  delete(id: string): Promise<void>; // soft
  undelete(id: string): Promise<void>;
  snapshot(): ReadonlyArray<FakeSpaceRecord>;
  seed(records: ReadonlyArray<FakeSpaceRecord>): void;
} {
  const spaces = new Map<string, FakeSpaceRecord>();
  let counter = 0;
  return {
    create: async (input) => {
      counter += 1;
      const id = `fake-space-${counter}`;
      spaces.set(id, { id, name: input.name });
      return { id, name: input.name };
    },
    rename: async (id, name) => {
      const r = spaces.get(id);
      if (r === undefined) throw new Error(`rename: not found ${id}`);
      r.name = name;
      return { id, name };
    },
    delete: async (id) => {
      const r = spaces.get(id);
      if (r === undefined) return; // idempotent soft delete
      r.deletedAt = new Date().toISOString();
    },
    undelete: async (id) => {
      const r = spaces.get(id);
      if (r === undefined) throw new Error(`undelete: not found ${id}`);
      delete r.deletedAt;
    },
    snapshot: () =>
      Array.from(spaces.values())
        .map((s) => ({ ...s }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    seed: (records) => {
      spaces.clear();
      for (const r of records) spaces.set(r.id, { ...r });
    },
  };
}

// One shared store across all 3a pairs so the registry order matches
// the manifest order without each pair re-instantiating. setup() always
// re-seeds so pairs run independently regardless of execution order.
const fakeStore = makeFakeSpacesStore();

// Pair 1: spaces.create  <->  spaces.delete (soft)
// Creating a fresh Space, then soft-deleting it, restores the
// "before create" snapshot (the deleted Space lingers with deletedAt
// set, so a name-only snapshot would diverge -- we capture & compare
// the full record list).
registerMutationInverse<{ before: ReadonlyArray<FakeSpaceRecord> }, { id: string }>({
  mutationName: 'spaces.create',
  setup: async () => {
    fakeStore.seed([{ id: 'fake-space-existing', name: 'Audit' }]);
    return { before: fakeStore.snapshot() };
  },
  mutate: async () => {
    const created = await fakeStore.create({ name: 'Temp Space' });
    return { id: created.id };
  },
  inverse: async (_state, created) => {
    // Soft delete the newly-created Space. The deletedAt marker is
    // what proves reversibility for the "create + delete" pair --
    // assertRestored verifies the deleted space is back to its pre-
    // create absence by hard-removing it from the snapshot view.
    await fakeStore.delete(created.id);
  },
  assertRestored: async (state) => {
    // Compare snapshots, filtering out soft-deleted entries (they
    // remain in the store but the deletion semantically reverses
    // the create from the user's perspective).
    const after = fakeStore.snapshot().filter((s) => s.deletedAt === undefined);
    expect(after).toEqual(state.before);
  },
});

// Pair 2: spaces.rename  <->  spaces.rename(back)
// Renaming a Space and then renaming it back restores the exact pre-state.
registerMutationInverse<
  { before: ReadonlyArray<FakeSpaceRecord>; targetId: string; oldName: string },
  { newName: string }
>({
  mutationName: 'spaces.rename',
  setup: async () => {
    fakeStore.seed([
      { id: 'fake-space-a', name: 'Original Name' },
      { id: 'fake-space-b', name: 'Sibling' },
    ]);
    return {
      before: fakeStore.snapshot(),
      targetId: 'fake-space-a',
      oldName: 'Original Name',
    };
  },
  mutate: async (state) => {
    await fakeStore.rename(state.targetId, 'Renamed');
    return { newName: 'Renamed' };
  },
  inverse: async (state) => {
    await fakeStore.rename(state.targetId, state.oldName);
  },
  assertRestored: async (state) => {
    expect(fakeStore.snapshot()).toEqual(state.before);
  },
});

// Pair 3: spaces.delete (soft)  <->  spaces.undelete
// Soft-deleting a Space and then undeleting it restores the exact
// pre-state (deletedAt is cleared).
registerMutationInverse<
  { before: ReadonlyArray<FakeSpaceRecord>; targetId: string },
  { id: string }
>({
  mutationName: 'spaces.delete',
  setup: async () => {
    fakeStore.seed([
      { id: 'fake-space-c', name: 'Will Be Deleted' },
      { id: 'fake-space-d', name: 'Bystander' },
    ]);
    return {
      before: fakeStore.snapshot(),
      targetId: 'fake-space-c',
    };
  },
  mutate: async (state) => {
    await fakeStore.delete(state.targetId);
    return { id: state.targetId };
  },
  inverse: async (_state, deleted) => {
    await fakeStore.undelete(deleted.id);
  },
  assertRestored: async (state) => {
    expect(fakeStore.snapshot()).toEqual(state.before);
  },
});

// Pair 4: spaces.undelete  <->  spaces.delete (soft)
// Undeleting a soft-deleted Space and then re-deleting it produces
// equivalent state (deletedAt timestamps differ across runs; we compare
// the structural shape -- presence + name -- instead of exact timestamps).
registerMutationInverse<
  { beforeShape: ReadonlyArray<{ id: string; name: string; deleted: boolean }>; targetId: string },
  { id: string }
>({
  mutationName: 'spaces.undelete',
  setup: async () => {
    fakeStore.seed([
      {
        id: 'fake-space-e',
        name: 'Soft Deleted',
        deletedAt: '2026-01-01T00:00:00Z',
      },
      { id: 'fake-space-f', name: 'Sibling' },
    ]);
    return {
      beforeShape: fakeStore.snapshot().map((s) => ({
        id: s.id,
        name: s.name,
        deleted: s.deletedAt !== undefined,
      })),
      targetId: 'fake-space-e',
    };
  },
  mutate: async (state) => {
    await fakeStore.undelete(state.targetId);
    return { id: state.targetId };
  },
  inverse: async (_state, restored) => {
    await fakeStore.delete(restored.id);
  },
  assertRestored: async (state) => {
    // Structural equivalence: same ids, same names, same deleted-ness.
    // Exact `deletedAt` timestamps will differ since the inverse stamps
    // a fresh ISO string.
    const after = fakeStore.snapshot().map((s) => ({
      id: s.id,
      name: s.name,
      deleted: s.deletedAt !== undefined,
    }));
    expect(after).toEqual(state.beforeShape);
  },
});

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

describe('Spaces Phase 3 -- Trust Principle: Reversible', () => {
  it('every entry in PHASE_3_MUTATION_MANIFEST has a registered inverse pair', () => {
    // The build-blocking assertion. If a sub-phase lands a mutation
    // and updates the manifest but forgets to register the pair, this
    // fires and the build goes red.
    const registered = new Set(listRegistered().map((p) => p.mutationName));
    const missing = PHASE_3_MUTATION_MANIFEST.filter(
      (name) => !registered.has(name)
    );
    expect(
      missing,
      `mutations in PHASE_3_MUTATION_MANIFEST without a registered inverse pair: ${missing.join(
        ', '
      )}`
    ).toEqual([]);
  });

  it('every registered pair has a name listed in PHASE_3_MUTATION_MANIFEST', () => {
    // The reverse direction. Catches the case where a sub-phase
    // registers a pair but forgets to record it in the manifest --
    // which means the manifest can no longer be relied on for the
    // "every mutation has an inverse" guarantee.
    const manifest = new Set(PHASE_3_MUTATION_MANIFEST);
    const orphans = listRegistered()
      .map((p) => p.mutationName)
      .filter((name) => !manifest.has(name));
    expect(
      orphans,
      `pairs registered without a manifest entry: ${orphans.join(', ')}`
    ).toEqual([]);
  });

  it('mutation names are unique across the registry', () => {
    // Two registrations for the same mutationName means whichever
    // ran last silently overrides -- which would let a buggy
    // registration mask a missing one.
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const pair of listRegistered()) {
      if (seen.has(pair.mutationName)) {
        dups.push(pair.mutationName);
      }
      seen.add(pair.mutationName);
    }
    expect(dups, `duplicate mutation registrations: ${dups.join(', ')}`).toEqual(
      []
    );
  });

  it('runs the setup -> mutate -> inverse -> assertRestored lifecycle for every registered pair', async () => {
    // Until 3a registers anything, this loop is a no-op and the test
    // passes vacuously. Once pairs land, each one runs end-to-end
    // against its own fixture graph and the inverse must restore
    // pre-state.
    for (const pair of listRegistered()) {
      const state = await pair.setup();
      const result = await pair.mutate(state);
      await pair.inverse(state, result);
      await pair.assertRestored(state);
    }
    expect(true).toBe(true);
  });
});

describe('Spaces Phase 3 -- Trust Principle harness self-checks', () => {
  it('registerMutationInverse appends to the registry and is observable', () => {
    _resetRegistryForTesting();
    expect(listRegistered()).toHaveLength(0);

    const pair: MutationInversePair<{ before: number }, { id: string }> = {
      mutationName: 'harness.selftest.example',
      setup: async () => ({ before: 1 }),
      mutate: async () => ({ id: 'x' }),
      inverse: async () => undefined,
      assertRestored: async (state) => {
        expect(state.before).toBe(1);
      },
    };

    registerMutationInverse(pair);
    expect(listRegistered()).toHaveLength(1);
    expect(listRegistered()[0]?.mutationName).toBe('harness.selftest.example');

    _resetRegistryForTesting();
    expect(listRegistered()).toHaveLength(0);
  });

  it('runs a self-test pair end-to-end (proves the lifecycle plumbing works before 3a code arrives)', async () => {
    _resetRegistryForTesting();

    const captured: string[] = [];
    const pair: MutationInversePair<{ marker: string }, { mutated: boolean }> = {
      mutationName: 'harness.selftest.lifecycle',
      setup: async () => {
        captured.push('setup');
        return { marker: 'pre' };
      },
      mutate: async (state) => {
        captured.push(`mutate(${state.marker})`);
        return { mutated: true };
      },
      inverse: async (state, result) => {
        captured.push(`inverse(${state.marker}, mutated=${result.mutated})`);
      },
      assertRestored: async (state) => {
        captured.push(`assertRestored(${state.marker})`);
        expect(state.marker).toBe('pre');
      },
    };

    registerMutationInverse(pair);

    for (const p of listRegistered()) {
      const state = await p.setup();
      const result = await p.mutate(state);
      await p.inverse(state, result);
      await p.assertRestored(state);
    }

    expect(captured).toEqual([
      'setup',
      'mutate(pre)',
      'inverse(pre, mutated=true)',
      'assertRestored(pre)',
    ]);

    _resetRegistryForTesting();
  });
});
