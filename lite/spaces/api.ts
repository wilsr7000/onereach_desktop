/**
 * Spaces module -- PUBLIC API.
 *
 * The only file other lite modules should import from in this module.
 * Per ADR-019 / Rule 11 in `lite/LITE-RULES.md`, cross-module imports
 * go through `<module>/api.ts` -- never reach into `sdk-client.ts`,
 * `window.ts`, `main.ts`, or any other internal file.
 *
 * Per the Spaces plan ("Spaces as Platform Primitive" section), the
 * methods declared here ARE the platform contract -- the same surface
 * GSX agents, Cowork integrations, and the renderer all consume. The
 * Lite UI is just the first consumer.
 *
 * Phase 0 ships:
 *   - The singleton swap pattern (`getSpacesApi` + `_setSpacesApiForTesting`)
 *   - Method signatures (every method throws `SPACES_NOT_INITIALIZED`
 *     in the default implementation)
 *   - `open()` to launch the Spaces window
 *
 * Phase 1 wires the BrowserWindow-backed implementation via
 * `initSpaces()` and lands the real `listSpaces` + `items.list` queries.
 *
 * Tests: `_setSpacesApiForTesting(stub)` to inject a custom
 * implementation, `_resetSpacesApiForTesting()` to clear the singleton.
 */

import { SpacesError } from './errors.js';
import type {
  Space,
  Item,
  ItemSummary,
  ListOpts,
  EntityCounts,
  Contributor,
  Event,
  AgentSummary,
  PermissionSummary,
  TopContributorsOpts,
  RecentEventsOpts,
  RecentItemsOpts,
  AgentsSampleOpts,
} from './types.js';
import type { SpaceScope } from './scope.js';

// ── Re-export public types consumers need ───────────────────────────────

export type {
  Space,
  Item,
  ItemSummary,
  ItemKind,
  ItemProvenance,
  SpaceChipRef,
  ListOpts,
  EntityCounts,
  Contributor,
  Event,
  AgentSummary,
  PermissionSummary,
  ContributorWindow,
  TopContributorsOpts,
  RecentEventsOpts,
  RecentItemsOpts,
  AgentsSampleOpts,
} from './types.js';
export { SPACES_MODULE_VERSION } from './types.js';

export type { SpaceScope } from './scope.js';
export {
  UNCATEGORIZED_SPACE_ID,
  resolveSpaceScope,
  isUncategorized,
} from './scope.js';

// ── Structured error class + code catalog ──────────────────────────────

export type { SpacesErrorCode, SpacesErrorOptions } from './errors.js';
export { SpacesError, SPACES_ERROR_CODES } from './errors.js';
export { LiteError, isLiteError } from '../errors.js';

// ── Per-module typed event surface (ADR-032) ───────────────────────────

export {
  SPACES_EVENTS,
  isSpacesEvent,
  type SpacesEvent,
  type SpacesEventName,
  type SpacesListSpacesStartEvent,
  type SpacesListSpacesFinishEvent,
  type SpacesListSpacesFailEvent,
  type SpacesItemsListStartEvent,
  type SpacesItemsListFinishEvent,
  type SpacesItemsListFailEvent,
  type SpacesItemsGetStartEvent,
  type SpacesItemsGetFinishEvent,
  type SpacesItemsGetFailEvent,
  type SpacesUncategorizedCountStartEvent,
  type SpacesUncategorizedCountFinishEvent,
  type SpacesUncategorizedCountFailEvent,
} from './events.js';

// ─── Public surface ─────────────────────────────────────────────────────

/**
 * Items sub-surface, scoped to a Space. Mirrored on the renderer side
 * as `window.lite.spaces.items.*`.
 *
 * **Error contract**: every method throws `SpacesError` on failure.
 * Inspect `.code`: `SPACES_NOT_AUTHENTICATED`, `SPACES_NOT_FOUND`,
 * `SPACES_FORBIDDEN`, `SPACES_CYPHER`, `SPACES_NETWORK`,
 * `SPACES_INVALID_INPUT`, `SPACES_NOT_INITIALIZED`. `get()` soft-fails
 * not-found (returns `null`).
 */
export interface SpacesItemsApi {
  /**
   * List items in the given scope. When `scope.kind === 'uncategorized'`,
   * returns items NOT participating in any `:Space` (the intake +
   * exception zone). Permission-filtered server-side.
   */
  list(scope: SpaceScope, opts?: ListOpts): Promise<ItemSummary[]>;

  /**
   * Fetch a single item by id. Returns `null` when the item doesn't
   * exist or is filtered out by ACL. Throws on auth / network / Cypher
   * failure.
   */
  get(id: string): Promise<Item | null>;

  /**
   * Resolve a binary `fileKey` (taken off `Item.fileKey`) into a
   * short-TTL signed download URL via the Files module. Used by the
   * detail panel to render image previews and offer download links
   * for non-image binary kinds.
   *
   * Returns `null` on any failure (missing key, no auth, network
   * error). Consumers treat `null` as "no preview available" rather
   * than surface an error toast -- the detail pane already shows the
   * item; the missing preview is a soft degrade.
   */
  resolveFileUrl(key: string): Promise<string | null>;
}

/**
 * The public surface of the spaces module.
 *
 * **Error contract**: every async method throws `SpacesError` on
 * failure (see `SpacesItemsApi` for codes). `open()` is fire-and-forget
 * and never throws; opening failures are logged.
 *
 * **Auth**: every data method requires a signed-in OneReach account.
 * Signed-out callers see `SPACES_NOT_AUTHENTICATED`.
 */
export interface SpacesApi {
  /**
   * Open (or focus) the Spaces window. Idempotent: subsequent calls
   * focus the existing window instead of opening a second.
   *
   * No-op until `initSpaces()` runs at boot (logs a warning).
   */
  open(): void;

  /**
   * List every Space the current account has read access to. Sorted
   * server-side by name; pinning is layered on top by the renderer
   * via local preferences (KV).
   */
  listSpaces(): Promise<Space[]>;

  /**
   * Count of items in the Uncategorized scope. Surfaced in the sidebar
   * row so users see intake pressure at a glance.
   */
  getUncategorizedCount(): Promise<number>;

  /** Items sub-surface. */
  readonly items: SpacesItemsApi;

  // ─── Home view (chunk 3k + 3o) ────────────────────────────────────────
  //
  // Read-only methods powering the Home news-feed cards. Detail in
  // `lite/spaces/HOME-V1.md`. All return canonical shapes from
  // `./types.ts`; SDK normalises wire-format variations.

  /**
   * Flat entity counts for the "Your data room at a glance" card.
   * Counts default to 0 (never undefined) so the renderer can tell
   * "loaded with no data" apart from "still loading".
   *
   * Tries APOC's `apoc.meta.stats()` first and falls back to an
   * explicit per-label `UNION ALL` if APOC isn't installed. The
   * fallback is transparent.
   */
  getEntityCounts(): Promise<EntityCounts>;

  /**
   * Most-recent assets across the entire account, ordered by
   * `updatedAt` (or `createdAt`) descending. Powers Card 5
   * ("Just added"). Returns the same `ItemSummary` shape as
   * `items.list()` so renderers reuse the existing card builder.
   */
  listRecentItems(opts?: RecentItemsOpts): Promise<ItemSummary[]>;

  /**
   * Top contributors over a rolling time window. Powers Card 2
   * ("Recent activity"). Window defaults to 'week'; limit defaults
   * to 4 (matches the card's row count).
   */
  topContributors(opts?: TopContributorsOpts): Promise<Contributor[]>;

  /**
   * Recent commit events across the account, optionally filtered to
   * those after a `since` epoch ms cutoff. Powers Card 2's "See
   * timeline" drill-down (modal in v1).
   */
  listRecentEvents(opts?: RecentEventsOpts): Promise<Event[]>;

  /**
   * Sample of `:Agent` nodes visible to the current account. Powers
   * Card 3 ("Agents in your account"). Limit defaults to 3 (matches
   * the card's row count); cap is 200 (matches modal pagination size).
   */
  listAgentsSample(opts?: AgentsSampleOpts): Promise<AgentSummary[]>;

  /**
   * "Your view" payload for Card 4: how many Spaces the current
   * account can see. `totalSpaceCount` is omitted in v1 because the
   * canonical schema doesn't expose a way to count Spaces the user
   * CAN'T see; renderer falls back to "you see X Spaces" copy.
   */
  getPermissionSummary(): Promise<PermissionSummary>;
}

// ─── Default uninitialized implementation ──────────────────────────────

/**
 * The default backing implementation. Wired by `lite/spaces/main.ts`
 * via `_setSpacesApiForTesting()` once the BrowserWindow factory + neon
 * client are initialized at boot.
 *
 * Until `initSpaces({...})` runs:
 *   - `open()` logs a warning and no-ops
 *   - every async data method rejects with `SPACES_NOT_INITIALIZED`
 */
class UninitializedSpacesApi implements SpacesApi {
  readonly items: SpacesItemsApi = {
    async list(_scope: SpaceScope, _opts?: ListOpts): Promise<ItemSummary[]> {
      throw notInitialized('items.list');
    },
    async get(_id: string): Promise<Item | null> {
      throw notInitialized('items.get');
    },
    async resolveFileUrl(_key: string): Promise<string | null> {
      // Soft contract: the resolver never throws even in the uninit
      // state -- it just returns null so the detail pane degrades to
      // "no preview" instead of an error banner.
      return null;
    },
  };

  open(): void {
    void import('../logging/api.js').then((m) => {
      m.getLoggingApi().warn('spaces', 'open() called before initSpaces()');
    });
  }

  async listSpaces(): Promise<Space[]> {
    throw notInitialized('listSpaces');
  }

  async getUncategorizedCount(): Promise<number> {
    throw notInitialized('getUncategorizedCount');
  }

  async getEntityCounts(): Promise<EntityCounts> {
    throw notInitialized('getEntityCounts');
  }

  async listRecentItems(_opts?: RecentItemsOpts): Promise<ItemSummary[]> {
    throw notInitialized('listRecentItems');
  }

  async topContributors(_opts?: TopContributorsOpts): Promise<Contributor[]> {
    throw notInitialized('topContributors');
  }

  async listRecentEvents(_opts?: RecentEventsOpts): Promise<Event[]> {
    throw notInitialized('listRecentEvents');
  }

  async listAgentsSample(_opts?: AgentsSampleOpts): Promise<AgentSummary[]> {
    throw notInitialized('listAgentsSample');
  }

  async getPermissionSummary(): Promise<PermissionSummary> {
    throw notInitialized('getPermissionSummary');
  }
}

function notInitialized(method: string): SpacesError {
  return new SpacesError({
    code: 'SPACES_NOT_INITIALIZED',
    message: `spaces.${method}() called before initSpaces()`,
    remediation:
      'Call initSpaces({...}) from main-lite.ts at boot. In tests, use _setSpacesApiForTesting() to inject a stub.',
    context: { method },
  });
}

let _instance: SpacesApi = new UninitializedSpacesApi();

/**
 * Get the singleton Spaces API. Lazily initialized -- `initSpaces` in
 * `main.ts` swaps in the real implementation at boot. Until then, the
 * stub no-ops `open()` and rejects data methods with
 * `SPACES_NOT_INITIALIZED`.
 */
export function getSpacesApi(): SpacesApi {
  return _instance;
}

/** Reset the singleton (for tests). */
export function _resetSpacesApiForTesting(): void {
  _instance = new UninitializedSpacesApi();
}

/**
 * Override the singleton with a custom implementation. Used by
 * `initSpaces()` at boot to install the real BrowserWindow + neon-
 * backed implementation, and by tests to inject stubs.
 */
export function _setSpacesApiForTesting(api: SpacesApi): void {
  _instance = api;
}
