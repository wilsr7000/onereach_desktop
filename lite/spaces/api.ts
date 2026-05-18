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
  CreateSpaceInput,
  DeleteSpaceOpts,
  ItemUpdatePatch,
  RecentCommitsOpts,
  SpaceKind,
  ListTicketsOpts,
  CreateTicketInput,
  UpdateTicketPatch,
  SetPlaybookResult,
  Person,
  PersonUpsertInput,
  SpaceMember,
  CreateAssetInput,
  DeleteAssetOpts,
  SearchItemsOpts,
  ItemMetadata,
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
  CreateSpaceInput,
  RenameSpaceInput,
  DeleteSpaceOpts,
  ItemUpdatePatch,
  RecentCommitsOpts,
  SpaceKind,
  TicketStatus,
  TicketDetails,
  ListTicketsOpts,
  CreateTicketInput,
  UpdateTicketPatch,
  SetPlaybookResult,
  Person,
  PersonUpsertInput,
  SpaceMember,
  CreateAssetInput,
  DeleteAssetOpts,
  SearchItemsOpts,
  ItemMetadata,
  MetadataValue,
  MetadataPrimitive,
} from './types.js';
export {
  SPACES_MODULE_VERSION,
  MAX_SPACE_NAME_LENGTH,
  MAX_SPACE_DESC_LENGTH,
  MAX_ITEM_TITLE_LENGTH,
  MAX_ITEM_DESCRIPTION_LENGTH,
  MAX_ITEM_TAG_LENGTH,
  TICKET_STATUSES,
} from './types.js';

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
  type SpacesCreateStartEvent,
  type SpacesCreateFinishEvent,
  type SpacesCreateFailEvent,
  type SpacesRenameStartEvent,
  type SpacesRenameFinishEvent,
  type SpacesRenameFailEvent,
  type SpacesDeleteStartEvent,
  type SpacesDeleteFinishEvent,
  type SpacesDeleteFailEvent,
  type SpacesUndeleteStartEvent,
  type SpacesUndeleteFinishEvent,
  type SpacesUndeleteFailEvent,
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

  /**
   * Update mutable fields on an Item (Phase 3b). Returns the freshly
   * re-fetched Item so callers can update their state with the new
   * `updatedAt`, `lastEditedBy`, etc. in one shape.
   *
   * @throws {SpacesError} `SPACES_INVALID_INPUT` for missing id / bad
   *   patch shapes (empty title, oversized description, unknown type).
   * @throws {SpacesError} `SPACES_NOT_FOUND` if the item disappeared
   *   between the update and the re-fetch.
   */
  update(id: string, patch: ItemUpdatePatch): Promise<Item>;

  /**
   * Append a tag to an Item (Phase 3b). Idempotent — duplicate calls
   * for the same tag are a no-op at the graph level. Returns the
   * updated tag list.
   *
   * @throws {SpacesError} `SPACES_INVALID_INPUT` for empty tags or
   *   tags longer than `MAX_ITEM_TAG_LENGTH`.
   */
  addTag(id: string, tag: string): Promise<string[]>;

  /**
   * Remove a tag from an Item. No-op when the tag is already absent.
   * Returns the updated tag list.
   */
  removeTag(id: string, tag: string): Promise<string[]>;

  /**
   * Per-asset activity log (Phase 3c). Returns the most recent commits
   * referencing the given Item, in reverse-chronological order. Row
   * shape matches `listRecentEvents()` so the detail-pane timeline can
   * reuse the same row renderer as the home-feed timeline.
   *
   * Defaults: 20 rows. Cap: 100.
   *
   * @throws {SpacesError} `SPACES_INVALID_INPUT` when `id` is empty.
   *   Unknown ids soft-fail to `[]` so a stale detail view doesn't
   *   crash on a freshly-deleted asset.
   */
  recentCommits(id: string, opts?: RecentCommitsOpts): Promise<Event[]>;

  /**
   * Create a new asset (Sprint 1). Either `content` (text body) or
   * `fileKey` (already uploaded via `getFilesApi().upload(...)`)
   * supplies the payload. Returns the freshly re-fetched Item.
   *
   * @throws {SpacesError} `SPACES_INVALID_INPUT` for empty title;
   *   `SPACES_NOT_FOUND` if the target space is missing/soft-deleted.
   */
  create(input: CreateAssetInput): Promise<Item>;

  /**
   * Delete an asset. Soft by default (sets `a.deletedAt`; reversible
   * via `restore`). Hard-delete with `{ soft: false }` — irreversible.
   *
   * Soft-deleted assets disappear from every list/get because the
   * underlying Cypher filters `WHERE a.deletedAt IS NULL`.
   *
   * @throws {SpacesError} `SPACES_NOT_FOUND` when the soft-delete
   *   path finds nothing to delete.
   */
  delete(id: string, opts?: DeleteAssetOpts): Promise<void>;

  /**
   * Restore a soft-deleted asset. Returns the freshly-fetched Item.
   *
   * @throws {SpacesError} `SPACES_NOT_FOUND` when the asset is missing
   *   OR wasn't soft-deleted.
   */
  restore(id: string): Promise<Item>;

  /**
   * Sprint 3 — move an asset to a different Space. Drops the
   * [:BELONGS_TO] edge to `fromSpaceId` (when provided) and MERGEs a
   * new one to `toSpaceId`. The asset retains any OTHER space
   * memberships.
   */
  moveToSpace(id: string, fromSpaceId: string | null, toSpaceId: string): Promise<Item>;

  /**
   * Sprint 3 — add an asset to ANOTHER space (multi-space membership).
   * Idempotent.
   */
  addToSpace(id: string, toSpaceId: string): Promise<Item>;

  /**
   * Sprint 3 — remove an asset from a specific space. Does NOT
   * soft-delete the asset; it just drops one [:BELONGS_TO] edge.
   */
  removeFromSpace(id: string, spaceId: string): Promise<Item>;

  /**
   * Sprint 3 — substring search across asset title / description /
   * excerpt. Optional `spaceId` restricts the search to one space.
   * Empty query returns `[]`.
   */
  search(opts: SearchItemsOpts): Promise<ItemSummary[]>;

  /**
   * Replace the metadata bag on an asset (Metadata sprint). Pass an
   * empty `{}` to clear.
   */
  setMetadata(id: string, metadata: ItemMetadata): Promise<Item>;

  /**
   * Merge a patch into the existing metadata bag. `null` values in
   * the patch remove the corresponding keys; primitives + arrays of
   * primitives set them.
   */
  patchMetadata(id: string, patch: ItemMetadata): Promise<Item>;

  /** Remove a single metadata key. No-op when already absent. */
  removeMetadataKey(id: string, key: string): Promise<Item>;
}

/**
 * Tickets sub-surface (Phase 4 — shared spaces). Tickets are
 * `:Asset {type: 'ticket'}` rows that decompose a playbook into
 * actionable work units. They live alongside other items in a Space
 * but get their own listing for the shared-space dashboard.
 */
export interface SpacesTicketsApi {
  /**
   * List tickets in a Space, optionally filtered by status. Returns
   * ticket-shaped Items (`Item.kind === 'ticket'` with `Item.ticket`
   * populated). Ordered by status priority (open → in_progress →
   * blocked → done) then most-recently-updated within each status.
   */
  list(spaceId: string, opts?: ListTicketsOpts): Promise<Item[]>;

  /**
   * Create a new ticket in a Space. Optionally links the ticket back
   * to a source playbook via `[:DECOMPOSED_FROM]` and to an initial
   * assignee via `[:ASSIGNED_TO]`.
   *
   * @throws {SpacesError} `SPACES_INVALID_INPUT` for empty title or
   *   unknown status. `SPACES_NOT_FOUND` if the Space is missing.
   */
  create(spaceId: string, input: CreateTicketInput): Promise<Item>;

  /**
   * Update a ticket. Mirrors `items.update()` but exposes ticket-
   * specific fields (status, priority, assignee). Pass
   * `{ assigneeId: null }` to clear the assignment.
   */
  update(id: string, patch: UpdateTicketPatch): Promise<Item>;
}

/**
 * Playbooks sub-surface (Phase 4 — shared spaces). A Space designates
 * one Asset as its "current playbook" — the plan agents are working
 * against. The playbook is just an Item with `kind === 'playbook'`.
 */
export interface SpacesPlaybooksApi {
  /**
   * Return the current playbook for a Space, or `null` when none is
   * set. `null` also covers the "space doesn't exist" case.
   */
  current(spaceId: string): Promise<Item | null>;

  /**
   * Promote an Asset to the Space's current playbook. The asset's
   * `kind` is rewritten to `'playbook'` so listings show the
   * playbook chrome. Any previous current playbook is demoted (the
   * `[:CURRENT_PLAYBOOK]` edge is dropped).
   */
  set(spaceId: string, playbookId: string): Promise<SetPlaybookResult>;
}

/**
 * Identity sub-surface (Phase 4 v2). Maps the active OneReach account
 * to a stable `:Person` row so attribution edges + assignee picks +
 * "who am I" lookups all resolve consistently.
 */
export interface SpacesIdentityApi {
  /**
   * Upsert a Person by id. Idempotent. Used by the renderer on boot
   * to ensure the current user has a graph row, and by the sharing
   * dialog when inviting a new collaborator who isn't in the graph
   * yet.
   */
  getOrCreatePerson(input: PersonUpsertInput): Promise<Person>;
}

/**
 * Members sub-surface (Phase 4 v2 — sharing). Manages the
 * `[:HAS_ACCESS]` edge set on a Space. Each member is either a
 * `:Person` (human collaborator) or `:Agent` (AI worker). Tickets are
 * assignable to anyone in this set.
 */
export interface SpacesMembersApi {
  /** List every Person + Agent with access to a Space. */
  list(spaceId: string): Promise<SpaceMember[]>;

  /**
   * Grant a Person or Agent access. Idempotent — adding the same
   * member twice is a no-op. Returns the canonical (kind, id, name)
   * tuple so the renderer can patch its cached list.
   *
   * @throws {SpacesError} `SPACES_NOT_FOUND` if either the Space or
   *   the principal is missing from the graph.
   */
  add(spaceId: string, memberId: string): Promise<SpaceMember>;

  /** Revoke access. No-op when the edge is already absent. */
  remove(spaceId: string, memberId: string): Promise<void>;
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

  /** Tickets sub-surface (Phase 4 — shared spaces). */
  readonly tickets: SpacesTicketsApi;

  /** Playbooks sub-surface (Phase 4 — shared spaces). */
  readonly playbooks: SpacesPlaybooksApi;

  /** Identity sub-surface (Phase 4 v2 — sharing). */
  readonly identity: SpacesIdentityApi;

  /** Space-membership sub-surface (Phase 4 v2 — sharing). */
  readonly members: SpacesMembersApi;

  /**
   * Toggle a Space between 'user' (default) and 'shared' (AI-managed).
   * Idempotent: setting the same kind again is a no-op aside from
   * refreshing `updatedAt`. Returns the new kind so the caller can
   * confirm the flip landed.
   *
   * @throws {SpacesError} `SPACES_INVALID_INPUT` for an unknown kind;
   *   `SPACES_NOT_FOUND` if the Space is missing or soft-deleted.
   */
  setSpaceKind(id: string, kind: SpaceKind): Promise<SpaceKind>;

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

  // ─── Mutations (Phase 3a) ─────────────────────────────────────────────
  //
  // All four methods throw `SpacesError`. Common codes:
  //   - SPACES_INVALID_INPUT   -- empty / too-long name; bad id
  //   - SPACES_DUPLICATE_NAME  -- name collision (create / rename)
  //   - SPACES_NOT_FOUND       -- target space missing or already hard-deleted
  //   - SPACES_DELETE_NON_EMPTY -- hard delete refused because items remain
  //   - SPACES_NOT_AUTHENTICATED / SPACES_NETWORK / SPACES_CYPHER (as for reads)
  //
  // Reversibility (ADR-048 Trust Principles):
  //   - create  <-> delete({ soft: true })
  //   - rename  <-> rename(id, previousName)
  //   - delete({ soft: true }) <-> undelete
  //   - delete({ soft: false }) -- one-way; not reversible
  // The trust-principles test harness registers the first three pairs.

  /**
   * Create a new Space. The name must be unique within the account
   * (case-insensitive). Returns the persisted `Space` with its
   * server-assigned id and timestamps. Trims whitespace and enforces
   * `MAX_SPACE_NAME_LENGTH` / `MAX_SPACE_DESC_LENGTH` client-side.
   */
  createSpace(input: CreateSpaceInput): Promise<Space>;

  /**
   * Rename an existing Space. Trims whitespace and enforces
   * `MAX_SPACE_NAME_LENGTH`. Returns the updated `Space`. Throws
   * `SPACES_NOT_FOUND` if the id doesn't exist (or is soft-deleted)
   * and `SPACES_DUPLICATE_NAME` if the new name collides.
   */
  renameSpace(id: string, name: string): Promise<Space>;

  /**
   * Delete a Space. Defaults to a soft delete (sets `deletedAt`); the
   * Space disappears from `listSpaces()` but its items keep their
   * `[:BELONGS_TO]` edges and can be restored via `undeleteSpace()`.
   *
   * Hard delete (`{ soft: false }`) removes the node entirely. Hard
   * delete refuses if items still belong to the Space (throws
   * `SPACES_DELETE_NON_EMPTY`); soft delete first, or move the items
   * out via `items.list()` and a future remove-from-space call.
   *
   * Soft-deleting an already-deleted Space is idempotent (no throw).
   */
  deleteSpace(id: string, opts?: DeleteSpaceOpts): Promise<void>;

  /**
   * Restore a soft-deleted Space. Throws `SPACES_NOT_FOUND` if the
   * Space has been hard-deleted or never existed. Restoring a Space
   * that wasn't soft-deleted is idempotent and returns the current row.
   */
  undeleteSpace(id: string): Promise<Space>;
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
    async update(_id: string, _patch: ItemUpdatePatch): Promise<Item> {
      throw notInitialized('items.update');
    },
    async addTag(_id: string, _tag: string): Promise<string[]> {
      throw notInitialized('items.addTag');
    },
    async removeTag(_id: string, _tag: string): Promise<string[]> {
      throw notInitialized('items.removeTag');
    },
    async recentCommits(
      _id: string,
      _opts?: RecentCommitsOpts
    ): Promise<Event[]> {
      throw notInitialized('items.recentCommits');
    },
    async create(_input: CreateAssetInput): Promise<Item> {
      throw notInitialized('items.create');
    },
    async delete(_id: string, _opts?: DeleteAssetOpts): Promise<void> {
      throw notInitialized('items.delete');
    },
    async restore(_id: string): Promise<Item> {
      throw notInitialized('items.restore');
    },
    async moveToSpace(
      _id: string,
      _fromSpaceId: string | null,
      _toSpaceId: string
    ): Promise<Item> {
      throw notInitialized('items.moveToSpace');
    },
    async addToSpace(_id: string, _toSpaceId: string): Promise<Item> {
      throw notInitialized('items.addToSpace');
    },
    async removeFromSpace(_id: string, _spaceId: string): Promise<Item> {
      throw notInitialized('items.removeFromSpace');
    },
    async search(_opts: SearchItemsOpts): Promise<ItemSummary[]> {
      throw notInitialized('items.search');
    },
    async setMetadata(_id: string, _metadata: ItemMetadata): Promise<Item> {
      throw notInitialized('items.setMetadata');
    },
    async patchMetadata(_id: string, _patch: ItemMetadata): Promise<Item> {
      throw notInitialized('items.patchMetadata');
    },
    async removeMetadataKey(_id: string, _key: string): Promise<Item> {
      throw notInitialized('items.removeMetadataKey');
    },
  };

  readonly tickets: SpacesTicketsApi = {
    async list(_spaceId: string, _opts?: ListTicketsOpts): Promise<Item[]> {
      throw notInitialized('tickets.list');
    },
    async create(_spaceId: string, _input: CreateTicketInput): Promise<Item> {
      throw notInitialized('tickets.create');
    },
    async update(_id: string, _patch: UpdateTicketPatch): Promise<Item> {
      throw notInitialized('tickets.update');
    },
  };

  readonly playbooks: SpacesPlaybooksApi = {
    async current(_spaceId: string): Promise<Item | null> {
      throw notInitialized('playbooks.current');
    },
    async set(_spaceId: string, _playbookId: string): Promise<SetPlaybookResult> {
      throw notInitialized('playbooks.set');
    },
  };

  readonly identity: SpacesIdentityApi = {
    async getOrCreatePerson(_input: PersonUpsertInput): Promise<Person> {
      throw notInitialized('identity.getOrCreatePerson');
    },
  };

  readonly members: SpacesMembersApi = {
    async list(_spaceId: string): Promise<SpaceMember[]> {
      throw notInitialized('members.list');
    },
    async add(_spaceId: string, _memberId: string): Promise<SpaceMember> {
      throw notInitialized('members.add');
    },
    async remove(_spaceId: string, _memberId: string): Promise<void> {
      throw notInitialized('members.remove');
    },
  };

  async setSpaceKind(_id: string, _kind: SpaceKind): Promise<SpaceKind> {
    throw notInitialized('setSpaceKind');
  }

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

  async createSpace(_input: CreateSpaceInput): Promise<Space> {
    throw notInitialized('createSpace');
  }

  async renameSpace(_id: string, _name: string): Promise<Space> {
    throw notInitialized('renameSpace');
  }

  async deleteSpace(_id: string, _opts?: DeleteSpaceOpts): Promise<void> {
    throw notInitialized('deleteSpace');
  }

  async undeleteSpace(_id: string): Promise<Space> {
    throw notInitialized('undeleteSpace');
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
