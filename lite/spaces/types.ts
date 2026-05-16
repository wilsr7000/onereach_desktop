/**
 * Spaces module -- shared types.
 *
 * The Spaces module is a platform primitive (see plan "Spaces as Platform
 * Primitive" section): the SDK is designed as if it were `@or-sdk/spaces`
 * even though it physically lives in `lite/spaces/` today. Types defined
 * here are the platform contract.
 *
 * Public types live here so both `api.ts` and the internal sdk-client
 * reference one source of truth.
 *
 * Scope note: Phase 2 renders only `:Asset` entities (binary files,
 * text, URLs, web clips). Other entity types (`:Agent`, `:Person`,
 * `:Tool`, `:Playbook`, etc.) exist in the data model but are
 * surfaced in later phases as their respective Lite modules port over.
 *
 * Naming asymmetry: Lite's TypeScript surface uses `Item` /
 * `ItemSummary` / `ItemKind` for ergonomic reasons (it's the noun
 * the renderers want to read). The on-graph entity is `:Asset` per
 * the canonical schema (see `(:Schema {entity: 'Asset'})` and
 * `lite/spaces/sdk-client.ts CYPHER`). The translation happens in
 * the SDK client; renderers never see the storage label.
 */

/** Module version constant -- consumers can pin or feature-detect. */
export const SPACES_MODULE_VERSION = 1 as const;

// ─── Spaces ──────────────────────────────────────────────────────────────

/**
 * Discriminator on how a Space's contents are curated:
 *
 *   - `'user'` (default): humans add/remove items manually. The current
 *     behavior of every Lite Space pre-2026Q2.
 *   - `'shared'`: AI-managed workspace where agents do work driven by
 *     a user-authored **playbook** (a plan asset stored in the Space).
 *     The playbook decomposes into **tickets** (work units), and the
 *     Space accumulates the artifacts agents produce. The renderer
 *     swaps to a dashboard layout when `kind === 'shared'`.
 *
 * Optional in `Space` so existing rows default to `'user'` without a
 * schema migration; the SDK projects `coalesce(s.kind, 'user') AS kind`.
 */
export type SpaceKind = 'user' | 'shared';

/**
 * A canonical Space (graph community / operational context). Every
 * `:Space` node in Neo4j maps to this shape after the listSpaces query.
 *
 * Optional fields are soft-failed at the SDK layer (the underlying
 * Cypher returns `null` for missing properties; we map to `undefined`
 * so renderer code can use `??` defaults uniformly).
 */
export interface Space {
  /** Neo4j-side id (elementId or external uuid; whichever the graph uses). */
  id: string;
  /** Display name. */
  name: string;
  /** Optional human description. */
  description?: string;
  /** Optional hex color for sidebar dot. */
  color?: string;
  /** Optional lucide icon key (e.g. 'circle', 'shield', 'folder'). Default 'circle'. */
  iconKey?: string;
  /** Cached count of `:Asset` nodes with `[:BELONGS_TO]` to this Space. */
  itemCount?: number;
  /** ISO timestamp of node creation. */
  createdAt?: string;
  /** ISO timestamp of last update. */
  updatedAt?: string;
  /**
   * Curation model. Defaults to `'user'` for existing Spaces (the SDK
   * coalesces `s.kind` so rows written before this property existed
   * still parse). `'shared'` flips the renderer into the AI-managed
   * dashboard layout.
   */
  kind?: SpaceKind;
}

// ─── Items ───────────────────────────────────────────────────────────────

/**
 * Discriminated kind values. Mirrors the canonical `a.type` property
 * on `:Asset` nodes (with legacy fallback to `a.assetType` per the
 * SDK Cypher). Unknown values are normalized to `'other'` by
 * `toItemKind()` in `sdk-client.ts`.
 *
 * `'playbook'` and `'ticket'` are shared-space primitives:
 *   - **Playbook** — a user-authored plan asset. One Space designates
 *     a "current" playbook via the `[:CURRENT_PLAYBOOK]` edge; that's
 *     the plan the agents are working against.
 *   - **Ticket** — a single decomposed unit of work. Tickets carry a
 *     `status` and an optional assignee (Person or Agent), and chain
 *     back to the source playbook via `[:DECOMPOSED_FROM]`.
 *
 * Both surface through the standard Item interface — the discriminator
 * lives on `Item.kind`, and `Item.ticket` carries the ticket-specific
 * substructure when applicable.
 */
export type ItemKind =
  | 'document'
  | 'image'
  | 'url'
  | 'text'
  | 'audio'
  | 'video'
  | 'playbook'
  | 'ticket'
  | 'other';

/**
 * Ticket lifecycle. Open → in_progress → done, with `'blocked'` as an
 * orthogonal "waiting on something" state the user / agent flags
 * manually. v1 is a flat enum; v2 could add `'cancelled'` /
 * `'duplicate'` without breaking the renderer (UI just gets a new pill
 * color and the SDK projection passes the new value through).
 */
export type TicketStatus = 'open' | 'in_progress' | 'done' | 'blocked';

/** Ordered status list for stable iteration in renderer + tests. */
export const TICKET_STATUSES: ReadonlyArray<TicketStatus> = [
  'open',
  'in_progress',
  'done',
  'blocked',
] as const;

/**
 * Ticket-specific substructure projected onto an Item when
 * `Item.kind === 'ticket'`. Pulls from canonical Asset properties
 * (`a.status`, `a.assigneeId`, `a.playbookId`, `a.priority`) with
 * legacy fallbacks per the standard `coalesce(...)` pattern.
 */
export interface TicketDetails {
  /** Lifecycle status. Defaults to `'open'` when the graph row has no value. */
  status: TicketStatus;
  /** Free-form priority bucket. Optional. */
  priority?: 'low' | 'med' | 'high';
  /** Resolved assignee (Person or Agent). Null when unassigned. */
  assignee: ItemProvenance | null;
  /**
   * The playbook this ticket was decomposed from. Undefined when the
   * ticket was created directly without a playbook context.
   */
  playbookId?: string;
}

/**
 * Compact reference to another Space an item participates in. Used in the
 * `otherSpaces` projection so item cards can render multi-Space chips
 * without a second round-trip.
 */
export interface SpaceChipRef {
  id: string;
  name: string;
  color?: string;
  iconKey?: string;
}

/**
 * Optional provenance row when the schema exposes
 * `(:Person)-[:CREATED]->(:Asset)` edges (the canonical creator edge
 * per `_RelationshipTypes` Schema node). `null` when absent.
 *
 * The renderer treats `null` as "do not render the line."
 */
export interface ItemProvenance {
  /** Principal type label (e.g. 'Agent', 'Person'). */
  kind: string;
  /** Display name (e.g. 'Quarterly Audit Agent', 'Robb Wilson'). */
  name: string;
  /** Principal id. */
  id: string;
}

/**
 * Compact view of an Item -- enough to render a card without fetching
 * full content. Returned by `items.list()`.
 */
export interface ItemSummary {
  id: string;
  title: string;
  kind: ItemKind;
  /** Key recognized by `lite/files/` for binary content fetch. */
  fileKey?: string;
  /** External URL for web-clipped items. */
  sourceUrl?: string;
  /** ISO timestamp of node creation. */
  createdAt: string;
  /** ISO timestamp of last update. */
  updatedAt: string;
  /** Up to ~120 char preview; nullable. */
  excerpt?: string;
  /**
   * Spaces this item participates in OTHER than the currently-viewed
   * Space. Already permission-filtered server-side (Phase 0.5 Q4/Q6).
   * Empty array for items in the Uncategorized scope.
   */
  otherSpaces: SpaceChipRef[];
  /** Producer/author if the schema exposes provenance edges; null otherwise. */
  producedBy: ItemProvenance | null;
}

/**
 * Full Item -- the summary plus any content the caller asked for.
 * Returned by `items.get()`.
 */
export interface Item extends ItemSummary {
  /** Inline text content for text-kind items. */
  content?: string;
  /** Free-form metadata bag. */
  metadata?: Record<string, unknown>;
  /**
   * Size in bytes for binary assets (`fileKey` present). Read from
   * canonical `a.size`, legacy `a.fileSize`, or `a.byteCount`. Undefined
   * when the graph node has none of those.
   */
  size?: number;
  /**
   * MIME type ('image/png', 'application/pdf', etc.). From canonical
   * `a.mimeType`, legacy `a.contentType`. Used to refine the detail-pane
   * preview (e.g. show a video player for `video/*` even when
   * `a.type` collapsed to 'other').
   */
  mimeType?: string;
  /**
   * Plain-text tag list. Read from `a.tags` (canonical, array property)
   * or `[:TAGGED_AS]->(:Tag)` edge collection (canonical edge model).
   * Empty array when neither path is populated. Phase 3b will mutate
   * via `items.addTag` / `removeTag`.
   */
  tags?: string[];
  /**
   * Last-edited attribution. Distinct from `producedBy` (the original
   * author) — populated when a `[:LAST_EDITED]->(:Person)` edge exists.
   * Falls back to `null` when the schema has no such edge yet.
   */
  lastEditedBy?: ItemProvenance | null;
  /**
   * Ticket-specific fields. Populated when `kind === 'ticket'`; absent
   * for every other kind. The SDK does NOT synthesize a default — if
   * the renderer needs to draw a ticket UI it should defensively check
   * for presence (`item.ticket !== undefined`).
   */
  ticket?: TicketDetails;
}

// ─── Query options ───────────────────────────────────────────────────────

/** Common list-options shape used by `items.list()` and future paged queries. */
export interface ListOpts {
  /** Default 100; cap is server-side. */
  limit?: number;
  /** For paging; 0-based. */
  offset?: number;
}

/**
 * Patch shape for `items.update(id, patch)` (Phase 3b).
 * Every field is optional — the SDK only writes what's provided.
 * Empty strings are treated as "clear this field" so a user can
 * remove a description by setting it to "".
 */
export interface ItemUpdatePatch {
  /** New display name. Trimmed; rejected if longer than `MAX_ITEM_TITLE_LENGTH`. */
  title?: string;
  /** Free-form description. Trimmed; capped at `MAX_ITEM_DESCRIPTION_LENGTH`. */
  description?: string;
  /** New `ItemKind`. Used by the renderer's "Reclassify" affordance. */
  type?: ItemKind;
  /**
   * Optional editor id (a `:Person.id`). When provided, the SDK
   * MERGEs a `[:LAST_EDITED]->(:Person {id})` edge so the detail
   * pane can attribute the change. Null/missing skips the edge.
   */
  editorId?: string;
}

/** Max title length enforced client-side. */
export const MAX_ITEM_TITLE_LENGTH = 200 as const;
/** Max description length enforced client-side. */
export const MAX_ITEM_DESCRIPTION_LENGTH = 4000 as const;
/** Max tag name length (single tag). */
export const MAX_ITEM_TAG_LENGTH = 60 as const;

// ─── Mutation inputs (Phase 3a) ─────────────────────────────────────────
//
// Inputs for `spaces.create` / `.rename` / `.delete` / `.undelete`. All
// fields are validated client-side (length, trim) so error feedback is
// snappy and the Cypher only ever sees normalized values.

/** Input to `spaces.create({...})`. */
export interface CreateSpaceInput {
  /**
   * Display name. Trimmed; rejected if empty or longer than
   * `MAX_SPACE_NAME_LENGTH`. Uniqueness is enforced server-side; a
   * collision surfaces as `SPACES_DUPLICATE_NAME`.
   */
  name: string;
  /** Optional human description. Trimmed; capped at `MAX_SPACE_DESC_LENGTH`. */
  description?: string;
  /** Optional hex color for the sidebar dot (e.g. `'#4f8cff'`). */
  color?: string;
  /** Optional lucide icon key. */
  iconKey?: string;
}

/** Input to `spaces.rename(id, name)`. (Wrapped for symmetry; same constraints as `create.name`.) */
export interface RenameSpaceInput {
  name: string;
}

/** Options for `spaces.delete(id, opts?)`. */
export interface DeleteSpaceOpts {
  /**
   * When `true` (default), sets `s.deletedAt` instead of removing the
   * node. The Space stops appearing in `listSpaces()` but can be
   * restored via `undelete()`. When `false`, hard-removes the node;
   * refuses (throws `SPACES_DELETE_NON_EMPTY`) if any items still
   * have a `[:BELONGS_TO]` edge into the Space.
   */
  soft?: boolean;
}

/** Max display-name length enforced client-side and in the Cypher pattern. */
export const MAX_SPACE_NAME_LENGTH = 80 as const;
/** Max description length enforced client-side. */
export const MAX_SPACE_DESC_LENGTH = 400 as const;

// ─── Home view (chunk 3k + 3o) ──────────────────────────────────────────
//
// Types backing the Home news-feed cards. Documented in
// `lite/spaces/HOME-V1.md`. The 3k data layer ships these; 3o renders.

/**
 * Flat entity counts powering the "Your data room at a glance" card.
 *
 * Sources from `apoc.meta.stats()` when available, falls back to an
 * explicit UNION ALL when APOC isn't installed. Either path normalizes
 * to this shape; renderer never sees the wire-format difference.
 *
 * Counts of `0` are represented as the literal `0` (never undefined),
 * so the renderer can distinguish "loaded with no data" from "still
 * loading".
 */
export interface EntityCounts {
  spaces: number;
  assets: number;
  people: number;
  agents: number;
}

/**
 * One row in the "Recent activity" card. A contributor is anything
 * (Person OR Agent) that has authored `:Commit` events in the requested
 * time window.
 *
 * `displayName` is the best human-readable label the SDK could derive:
 * the underlying `:Commit.author` is a free-form string written by the
 * producer (e.g. `device_mac.lan_<id>`, `robb+admin/onereach@onereach.com`,
 * `Audit Agent`). The SDK doesn't try to resolve these to `:Person` /
 * `:Agent` nodes in v1; that's a 3n / 3m concern.
 */
export interface Contributor {
  /** The raw `:Commit.author` value (used as a stable id for the row). */
  author: string;
  /**
   * Best-effort human display label. v1 returns `author` verbatim;
   * v2 may resolve `:Person` / `:Agent` matches and pretty-print.
   */
  displayName: string;
  /** Number of commit events authored by this contributor in the window. */
  events: number;
  /** ISO timestamp of this contributor's most-recent event in the window. */
  lastEventAt: string;
}

/**
 * One event from the `:Commit` projection. Ordered by `timestamp` desc
 * by the underlying Cypher.
 *
 * The `kind` field carries the verbatim `:Commit.message` string
 * (e.g. `'item:added'`, `'item:updated'`). v1 surfaces it as-is; when
 * 3l (real bidirectional sync) lands in v2 the `kind` enum widens to
 * include sync-event variants without a data-shape change.
 */
export interface Event {
  /** The `:Commit.hash` (stable id; sortable but not chronological). */
  id: string;
  /** Raw `:Commit.author`. See `Contributor.author` for the same caveat. */
  author: string;
  /** Verbatim `:Commit.message`. Producer-defined; widens over time. */
  kind: string;
  /** ISO timestamp of the commit. */
  timestamp: string;
  /** The `:Space.id` this commit was written against, when present. */
  spaceId?: string;
  /** Best-effort Space display name; falls back to `spaceId`. */
  spaceName?: string;
}

/**
 * One row in the "Agents in your account" card. Powers Card 3 of Home;
 * v1 surfaces a sample (the first N alphabetically) plus a "+ X more"
 * link to a modal listing all agents.
 */
export interface AgentSummary {
  id: string;
  name: string;
  /** Empty string when the agent has no description property. */
  description: string;
}

/**
 * "Your view" card payload. Tells the user how many Spaces they can
 * see in this account. v1 only knows `visibleSpaceCount`; the
 * `totalSpaceCount` comparison is reserved for when Edison D6
 * (composition with item ACLs) returns a way to count Spaces the
 * user CAN'T see.
 */
export interface PermissionSummary {
  /** Spaces visible to the current account. Always set. */
  visibleSpaceCount: number;
  /**
   * Total Spaces in the account, including ones the user can't see.
   * Optional in v1 — depends on Edison D6 answers; omitted when
   * unknown so the renderer falls back to "you see X Spaces" copy
   * instead of "X of Y".
   */
  totalSpaceCount?: number;
}

/**
 * Window selectors for `topContributors()`. The SDK translates these
 * to a `sinceMs` epoch parameter on the Cypher.
 */
export type ContributorWindow = 'day' | 'week' | 'month';

/** Options shape for `topContributors()`. */
export interface TopContributorsOpts {
  /** Default 'week'. */
  window?: ContributorWindow;
  /** Default 4 (matches Home Card 2 row count). Capped at 50. */
  limit?: number;
}

/** Options shape for `listRecentEvents()`. */
export interface RecentEventsOpts {
  /** Default 50; cap is server-side at 200. */
  limit?: number;
  /** Optional epoch ms cutoff; events with `timestamp >= since` only. */
  since?: number;
  /**
   * Optional Space scope. When set, the SDK returns only commits
   * whose `:Commit.spaceId` matches. Powers the per-Space timeline
   * (the home-page timeline filtered to one Space).
   */
  spaceId?: string;
}

/** Options shape for `listRecentItems()`. */
export interface RecentItemsOpts {
  /** Default 3 (matches Home Card 5 row count). Capped at 50. */
  limit?: number;
}

/** Options shape for `listAgentsSample()`. */
export interface AgentsSampleOpts {
  /** Default 3 (matches Home Card 3 row count). Capped at 200. */
  limit?: number;
}

/**
 * Options shape for `items.recentCommits(id, opts?)` (Phase 3c).
 * Returns commits that reference the given Asset. Used by the detail
 * pane's per-asset activity log.
 *
 * Distinct from `RecentEventsOpts` (which is Space-scoped). No `spaceId`
 * field: asset-scoping is implicit from the `id` argument.
 */
export interface RecentCommitsOpts {
  /** Default 20; capped at 100. */
  limit?: number;
  /** Optional epoch ms cutoff; events with `timestamp >= since` only. */
  since?: number;
}

// ─── Shared spaces: playbooks + tickets (Phase 4) ────────────────────────

/**
 * Options shape for `tickets.list(spaceId, opts?)`. Filters at the SDK
 * layer (no need for separate Cypher per filter). Mirrors the
 * `ListOpts` shape used by `items.list` for paging.
 */
export interface ListTicketsOpts {
  /** Status filter; when omitted, returns tickets in every status. */
  status?: TicketStatus;
  /** Default 200; cap is server-side. */
  limit?: number;
  /** 0-based offset for paging. */
  offset?: number;
}

/**
 * Input shape for `tickets.create(spaceId, input)`. The SDK stamps id +
 * createdAt + updatedAt + the canonical `a.type = 'ticket'` and merges
 * a `[:BELONGS_TO]->(:Space)` edge.
 */
export interface CreateTicketInput {
  /** Ticket title. 1..MAX_ITEM_TITLE_LENGTH after trim. */
  title: string;
  /** Optional human description. Capped at MAX_ITEM_DESCRIPTION_LENGTH. */
  description?: string;
  /** Initial status. Defaults to `'open'` when omitted. */
  status?: TicketStatus;
  /** Priority bucket. Free-form for now. */
  priority?: 'low' | 'med' | 'high';
  /**
   * Optional source playbook id. When set, the SDK merges a
   * `[:DECOMPOSED_FROM]->(:Asset)` edge so the playbook view can
   * surface all derived tickets.
   */
  playbookId?: string;
  /** Optional initial assignee. Either a `:Person.id` or `:Agent.id`. */
  assigneeId?: string;
}

/**
 * Patch shape for `tickets.update(ticketId, patch)`. Every field is
 * optional — the SDK only writes what's provided. Distinct from the
 * generic `ItemUpdatePatch` because ticket-specific fields (status,
 * assignee, priority) demand validation that doesn't apply to other
 * kinds.
 */
export interface UpdateTicketPatch {
  /** New display title. */
  title?: string;
  /** New description. */
  description?: string;
  /** New status. Validated against the `TicketStatus` enum. */
  status?: TicketStatus;
  /** New priority bucket. */
  priority?: 'low' | 'med' | 'high';
  /**
   * New assignee id. Pass `null` to clear the assignment. Strings are
   * treated as a Person/Agent id; the SDK does NOT distinguish which —
   * it MERGEs an `[:ASSIGNED_TO]` edge against whichever node carries
   * the id.
   */
  assigneeId?: string | null;
}

/**
 * Result of `playbooks.set(spaceId, playbookId)`. Returns the freshly
 * promoted playbook + the count of derived tickets so the renderer can
 * decide whether to refetch the ticket list.
 */
export interface SetPlaybookResult {
  /** The playbook now flagged as current. */
  playbook: Item;
  /** Count of tickets already linked to this playbook. */
  ticketCount: number;
}

/**
 * Canonical Person row. Upserted on the boot path via
 * `identity.getOrCreatePerson({ id, name, email })` and resurfaced
 * everywhere a producer / editor / assignee is shown.
 */
export interface Person {
  id: string;
  name: string;
  email?: string;
}

/**
 * Input shape for `identity.getOrCreatePerson()`. The id is required
 * (it's used as the MERGE key); name + email are optional but
 * recommended (they populate `:Person.name` / `email` on first
 * insertion so attribution lights up immediately).
 */
export interface PersonUpsertInput {
  /** Stable id. Use lowercased email when available; falls back to accountId. */
  id: string;
  /** Display name. Optional; preserves any existing value when omitted. */
  name?: string;
  /** Optional email. Same preserve-existing rule applies. */
  email?: string;
}

/**
 * A :Person or :Agent who has access to a Space (via
 * `[:HAS_ACCESS]->(s:Space)`). Returned by
 * `spaces.listSpaceMembers(spaceId)` and rendered as a chip row on
 * shared spaces.
 */
export interface SpaceMember {
  /** 'Person' or 'Agent'. */
  kind: string;
  /** Stable id. */
  id: string;
  /** Display name. */
  name: string;
}
