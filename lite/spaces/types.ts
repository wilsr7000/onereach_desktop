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
/**
 * ADR-051 — per-space visibility. 'open' (default): every account
 * member sees the Space (pre-ADR behavior, and what every existing
 * Space keeps). 'restricted': only members with `[:HAS_ACCESS]` see
 * it (list, items, search, home feed, direct get).
 */
export type SpaceVisibility = 'open' | 'restricted';

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
  /** ADR-051 — 'open' (default) or 'restricted' (members-only). */
  visibility?: SpaceVisibility;
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
/**
 * The kinds, as a runtime value. `ItemKind` is derived from this, so the
 * two can never drift: anything that needs to enumerate the kinds at
 * runtime (notably the asset-matrix coverage contract, which asserts
 * every kind has a render test) reads THIS rather than hand-copying the
 * union. A hand-copied mirror passes vacuously when a kind is added —
 * which is how `'transcript'` shipped with no matrix row.
 */
export const ITEM_KINDS = [
  'document',
  'image',
  'url',
  'text',
  'audio',
  'video',
  'playbook',
  'ticket',
  'agent',
  'transcript',
  'knowledge',
  'journey',
  'other',
] as const;

export type ItemKind = (typeof ITEM_KINDS)[number];

/**
 * Agent kinds. An agent asset (`Item.kind === 'agent'`) carries an
 * `agentType` discriminator that drives the per-type child node in the
 * graph (`(:Agent)-[:HAS_TYPE]->(:AgentType:<TypeLabel>)`) and the
 * renderer's type label. Open-ended on purpose — the AI classifier may
 * return a value outside this starter set, so treat unknown values as
 * `'other'` for display but persist the raw string. Confirm the real
 * OneReach taxonomy before locking this down.
 */
export type AgentType =
  | 'conversational'
  | 'workflow'
  | 'autonomous'
  | 'tool'
  | 'orchestrator'
  | 'other';

/** Ordered list for stable iteration in renderer + tests. */
export const AGENT_TYPES: ReadonlyArray<AgentType> = [
  'conversational',
  'workflow',
  'autonomous',
  'tool',
  'orchestrator',
  'other',
] as const;

/**
 * How an agent is reachable. An agent can expose one or more of these —
 * pasting a URL registers how the system reaches the agent and on which
 * channels (making it available as a web app). Distinct from the
 * behavioral {@link AgentType}: an agent has a type AND its endpoints.
 */
export type AgentEndpointKind = 'mcp' | 'api' | 'skill';

/** Ordered list for stable iteration in renderer + tests. */
export const AGENT_ENDPOINT_KINDS: ReadonlyArray<AgentEndpointKind> = [
  'mcp',
  'api',
  'skill',
] as const;

/**
 * A single reachability endpoint on an agent. Stored in the graph as a
 * per-kind child node `(:Agent)-[:REACHABLE_VIA]->(:AgentEndpoint:<Kind>)`.
 */
export interface AgentEndpoint {
  /** Reachability method. */
  kind: AgentEndpointKind;
  /** The endpoint URL (MCP server, API base, or OneReach skill URL). */
  url: string;
  /** Channels this endpoint serves (e.g. 'web', 'sms', 'voice', 'slack'). */
  channels: string[];
}

/**
 * Ticket lifecycle. Open → in_progress → done, with `'blocked'` as an
 * orthogonal "waiting on something" state the user / agent flags
 * manually. v1 is a flat enum; v2 could add `'cancelled'` /
 * `'duplicate'` without breaking the renderer (UI just gets a new pill
 * color and the SDK projection passes the new value through).
 */
/** One row of the add-member picker (graph `:Person` / `:Agent`). */
export interface MemberLibraryEntry {
  kind: 'Person' | 'Agent';
  id: string;
  name: string;
  email: string;
}

/** One row of the account's agent library (graph `:Agent` nodes). */
export interface AgentLibraryEntry {
  id: string;
  name: string;
  description: string;
  agentType: string;
}

/**
 * Input for adding a LIBRARY agent to a Space: references the existing
 * graph `:Agent` (no new agent node) via `[:REPRESENTS]`, copying its
 * name/description onto the Space-facing asset. Endpoints registered
 * here attach to the existing agent.
 */
export interface CreateAgentFromLibraryInput {
  spaceId: string;
  agentId: string;
  endpoints?: AgentEndpoint[];
  creatorId?: string;
  /** Display name for activity attribution (falls back to creatorId). */
  creatorName?: string;
}

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
   * User-authored description, when non-blank. Distinct from `excerpt`
   * (which may be derived from description OR content): tiles that
   * need both — the playbook tile shows description + plan steps —
   * read this field directly.
   */
  description?: string;
  /**
   * First ~280 chars of `content` for playbook / transcript /
   * knowledge / journey rows (other kinds return null to keep list
   * payloads lean). Lets special tiles parse structure even when
   * `excerpt` was taken from the description.
   */
  contentHead?: string;
  /** Agent rows only: the behavioral type driving the tile chip. */
  agentType?: string;
  /** Agent rows only: reachability endpoints for the tile chips. */
  agentEndpoints?: AgentEndpoint[];
  /**
   * Metadata bag on summary rows — powers tile hover text (objective,
   * ai_summary) without a getItem round-trip. Same JSON property the
   * full Item carries.
   */
  metadata?: ItemMetadata;
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
 * Free-form metadata value. The renderer + SDK round-trip these
 * through a JSON-string property on `:Asset` (`a.metadata`); Neo4j
 * doesn't natively support nested map properties so JSON is the
 * least-painful storage form.
 *
 * Nested objects are NOT allowed in v1 — flatten with dot-separated
 * keys (e.g. `image.width: 1024`) if you need hierarchy. This keeps
 * the editor UI simple and avoids the recursion-depth surprise.
 */
export type MetadataPrimitive = string | number | boolean | null;
export type MetadataValue = MetadataPrimitive | MetadataPrimitive[];

/** Canonical metadata bag for an :Asset. Persisted as JSON. */
export type ItemMetadata = Record<string, MetadataValue>;

/**
 * Full Item -- the summary plus any content the caller asked for.
 * Returned by `items.get()`.
 */
export interface Item extends ItemSummary {
  /** Inline text content for text-kind items. */
  content?: string;
  /**
   * Free-form description / abstract / caption / notes. Distinct from
   * `excerpt` (which is a derived preview snippet of `content`):
   * `description` is user-authored prose about the asset. Edited via
   * `items.update({ description })`; rendered in the detail rail
   * between the meta strip and any preview.
   */
  description?: string;
  /** Free-form metadata bag (round-tripped as JSON in `a.metadata`). */
  metadata?: ItemMetadata;
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
  /**
   * Agent type discriminator. Populated when `kind === 'agent'` (read
   * from the linked `(:Agent)-[:HAS_TYPE]->(:AgentType)` subgraph, or
   * `a.agentType` on the asset). Raw string — may fall outside
   * {@link AGENT_TYPES} if the AI classifier returns a novel value; the
   * renderer maps unknowns to an "other" visual. Absent for non-agents.
   */
  agentType?: string;
  /**
   * Reachability endpoints (only for `kind === 'agent'`): how the system
   * reaches the agent + on which channels. Collected from the
   * `(:Agent)-[:REACHABLE_VIA]->(:AgentEndpoint)` subgraph. Empty/absent
   * when the agent has no registered endpoints.
   */
  agentEndpoints?: AgentEndpoint[];
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
   * Inline content body -- the Markdown / text payload rendered by
   * the detail pane's content block. Empty string clears the content.
   * Trimmed only for length validation (the body is stored verbatim
   * so trailing newlines / formatting survive). Capped at
   * `MAX_ITEM_CONTENT_LENGTH`.
   */
  content?: string;
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
/** Max content body length enforced client-side. ~50 pages of Markdown. */
export const MAX_ITEM_CONTENT_LENGTH = 200_000 as const;
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

/**
 * Input to `spaces.updateSpace(id, patch)` — partial update of the
 * non-identity fields on a Space. Each field is optional; only those
 * present in the patch are written. Pass an empty string for
 * `description` to clear it. Name changes go through `renameSpace`
 * (uniqueness check is name-specific), not this method.
 *
 * Validation mirrors `CreateSpaceInput`:
 *   - description: trimmed; capped at `MAX_SPACE_DESC_LENGTH`
 *   - color: any string (typically a hex like `#4f8cff`); not validated
 *     beyond type (renderer is the source of truth on visual semantics)
 *   - iconKey: any string (lucide-style key); not validated beyond type
 */
export interface UpdateSpaceInput {
  description?: string;
  color?: string;
  iconKey?: string;
  /**
   * ADR-051 — flip the Space between 'open' (account-wide) and
   * 'restricted' (members-only). Restricting auto-grants the caller
   * `[:HAS_ACCESS]` so a Space can never be orphaned from its owner.
   */
  visibility?: SpaceVisibility;
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
  /**
   * ADR-052 — when this member's access ends (ISO-8601). Absent means
   * permanent, which is what every grant written before expiry existed
   * resolves to.
   */
  accessExpiresAt?: string;
}

/** Options for `members.add(spaceId, memberId, opts)`. */
export interface AddSpaceMemberOptions {
  /**
   * When the grant should lapse (ISO-8601).
   *
   * Three distinct intents, deliberately not collapsed:
   *   - **omitted** — leave an existing grant's expiry untouched, so
   *     re-adding a member never silently extends or revokes access;
   *   - **`null`** — permanent access;
   *   - **ISO string** — access ends at that instant.
   *
   * Validated, not trusted: a malformed or past value is rejected. A
   * grant an admin believes expires on Friday but which was quietly
   * stored as permanent is a security hole wearing the costume of a
   * working feature.
   */
  expiresAt?: string | null;
}

// ─── Asset CRUD (Sprint 1) ───────────────────────────────────────────────

/**
 * Input shape for `items.create(input)`. Either `content` (text body)
 * or `fileKey` (already uploaded to the Files bucket) supplies the
 * asset's payload; both can be set when the asset is e.g. an image
 * with an accompanying caption.
 *
 * The SDK stamps `id`, `createdAt`, `updatedAt`, and (when an editorId
 * is supplied) the `[:CREATED]->(:Person)` edge.
 */
export interface CreateAssetInput {
  /** Target Space id. Required — assets always live in a Space. */
  spaceId: string;
  /** Display title. 1..MAX_ITEM_TITLE_LENGTH after trim. */
  title: string;
  /**
   * Asset kind. Defaults to `'text'` when only `content` is provided,
   * or `'other'` when only `fileKey` is provided. Callers should set
   * an explicit kind (`'image'`, `'video'`, etc.) when known.
   */
  kind?: ItemKind;
  /** Inline text body. */
  content?: string;
  /** File-bucket key (from `files.upload`) for binary assets. */
  fileKey?: string;
  /** Optional MIME type (refines preview rendering). */
  mimeType?: string;
  /** Optional byte size (for binary assets). */
  size?: number;
  /** Free-form description. */
  description?: string;
  /** Optional external URL — sets `a.sourceUrl` for web-clip kinds. */
  sourceUrl?: string;
  /** Optional :Person.id of the creator — MERGEs [:CREATED] edge. */
  creatorId?: string;
  /** Display name for activity attribution (falls back to creatorId). */
  creatorName?: string;
  /**
   * Free-form metadata to persist on creation. Round-trips through
   * `a.metadata` (JSON). Populated automatically by the renderer's
   * auto-extract pass when files are uploaded.
   */
  metadata?: ItemMetadata;
}

/**
 * Input for `items.createBinary(...)` — GSX-first asset creation
 * (ADR-050). The caller hands over raw bytes; the API uploads them to
 * the account's GSX file bucket and creates the `:Asset` with the
 * resulting `fileKey` — inline base64 never touches the graph. This is
 * what makes binary assets shareable across apps: any client of the
 * same GSX account (full app, Lite, agents) resolves the same key.
 */
export interface CreateBinaryAssetInput {
  /** Target Space id. Required — assets always live in a Space. */
  spaceId: string;
  /** Display title. 1..MAX_ITEM_TITLE_LENGTH after trim. */
  title: string;
  /** Asset kind (`'image'`, `'video'`, `'document'`, ...). Defaults to `'other'`. */
  kind?: ItemKind;
  /** Original file name — sanitized into the GSX key for readability. */
  fileName: string;
  /** MIME type. Advertised to GSX and stored on the node. */
  mimeType?: string;
  /** The file's raw bytes. Size is derived from this. */
  bytes: ArrayBuffer | Uint8Array;
  /** Free-form description. */
  description?: string;
  /** Optional :Person.id of the creator — MERGEs [:CREATED] edge. */
  creatorId?: string;
  /** Display name for activity attribution (falls back to creatorId). */
  creatorName?: string;
  /** Free-form metadata to persist on creation (renderer auto-extract). */
  metadata?: ItemMetadata;
  /**
   * Write the bytes to the PUBLIC bucket instead of the private one.
   *
   * Defaults to `false` — private. Must be an explicit `true` to take
   * effect; anything else is treated as private, because the failure
   * mode of guessing wrong is exposing a user's file to the world.
   *
   * The bucket is part of the file's identity: a key written to the
   * public bucket cannot later be read or deleted as private. The
   * choice is therefore recorded on the asset (`metadata.fileIsPublic`)
   * so every later resolve/download/delete targets the same bucket.
   * To flip an existing file, use `files.setPrivacy()`.
   */
  isPublic?: boolean;
  /**
   * Optional ISO-8601 expiry. The bucket deletes the object at this
   * time (GSX TTL). Omit for no expiry, which is the default.
   *
   * Validated, not trusted: a malformed or past timestamp is rejected
   * rather than dropped, because a TTL the caller believes is set but
   * that never applied is worse than an error. Mirrored onto the asset
   * as `metadata.fileExpiresAt` for display; the bucket stays the
   * authority on actual deletion. To change it later, use
   * `files.setTtl()`.
   */
  expiresAt?: string;
}

/**
 * Input for `agents.create(...)` — adds an agent to a Space. The OKF
 * text (already converted by the AI; see `window.lite.ai.convertToOkf`)
 * is stored as the asset's inline `content`. The SDK writes the
 * Space-facing `:Asset {type:'agent'}` AND the parent `:Agent` node +
 * typed child (`:AgentType:<TypeLabel>`) subgraph in one transaction,
 * stamping `id` / `createdAt` / `updatedAt` and the `[:CREATED]` edge.
 */
export interface CreateAgentInput {
  /** Target Space id. Required. */
  spaceId: string;
  /** Display name/title for the agent. 1..MAX_ITEM_TITLE_LENGTH after trim. */
  name: string;
  /** The OKF definition text (structured YAML/MD). Stored as `a.content`. */
  okf: string;
  /**
   * Agent type discriminator — drives the typed child node's label.
   * Raw string (AI-classified); may fall outside {@link AGENT_TYPES}.
   */
  agentType: string;
  /** Optional source URL the OKF was derived from (sets `a.sourceUrl`). */
  sourceUrl?: string;
  /** Optional free-form description. */
  description?: string;
  /** Optional :Person.id of the creator — MERGEs [:CREATED] edge. */
  creatorId?: string;
  /** Display name for activity attribution (falls back to creatorId). */
  creatorName?: string;
  /**
   * Reachability endpoints (MCP / API / Skill) the agent exposes — one
   * or more. Each becomes a `(:Agent)-[:REACHABLE_VIA]->(:AgentEndpoint)`
   * child node. Optional: an agent can be defined by OKF alone.
   */
  endpoints?: AgentEndpoint[];
}

/** Options for `items.delete(id, opts?)`. */
export interface DeleteAssetOpts {
  /**
   * Default true (soft delete via `a.deletedAt`). When false, hard
   * deletes the node and its [:BELONGS_TO] / [:TAGGED_AS] / [:CREATED]
   * edges — irreversible.
   */
  soft?: boolean;
}

/** Options for `items.search(opts)`. */
export interface SearchItemsOpts {
  /** Substring (case-insensitive). Required. */
  query: string;
  /** Restrict to one space; null/missing searches across every space. */
  spaceId?: string;
  /** Default 50; cap is server-side. */
  limit?: number;
}
