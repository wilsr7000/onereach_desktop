/**
 * Spaces module -- SpaceScope helper.
 *
 * The synthetic Uncategorized id is wrapped in a discriminated union so it
 * doesn't leak as a string sentinel across the codebase. Every call site
 * that takes a Space-targeting argument (`listItems`, eventual `addToSpace`
 * / `removeFromSpace`, permission checks, analytics span tags) accepts a
 * `SpaceScope` and branches on `kind`.
 *
 * Doing this in Phase 2b is cheap; deferring to Phase 4 means refactoring
 * three or four call sites. See `spaces-manager-phases` plan, Phase 2b.
 */

/**
 * Synthetic id reserved for the Uncategorized "intake + exception" zone.
 * Not a real `:Space` node id; resolves to the
 * `MATCH (i:Item) WHERE NOT (i)-[:MEMBER_OF]->(:Space)` query.
 */
export const UNCATEGORIZED_SPACE_ID = '__uncategorized__';

/**
 * Discriminated union of where a Space-targeting operation should resolve.
 *
 * - `{ kind: 'space', spaceId }` -- a normal `:Space` node.
 * - `{ kind: 'uncategorized' }` -- the synthetic uncategorized zone.
 */
export type SpaceScope =
  | { kind: 'uncategorized' }
  | { kind: 'space'; spaceId: string };

/**
 * Resolve a string id (typically from UI selection state or an IPC
 * payload) into a typed `SpaceScope`. The string-to-union conversion
 * happens exactly once, at the IPC boundary.
 */
export function resolveSpaceScope(id: string): SpaceScope {
  return id === UNCATEGORIZED_SPACE_ID
    ? { kind: 'uncategorized' }
    : { kind: 'space', spaceId: id };
}

/**
 * Type guard for the uncategorized variant. Convenience for renderer code
 * that needs to check "is this Space scope the special intake zone?"
 * without restating the discriminant.
 */
export function isUncategorized(scope: SpaceScope): scope is { kind: 'uncategorized' } {
  return scope.kind === 'uncategorized';
}
