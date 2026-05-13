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
 * Scope note: Phase 2 renders only `:Item` entities (binary files, text,
 * URLs, web clips). Other entity types (`:Agent`, `:Workflow`, `:Person`,
 * `:Tool`) exist in the data model but are surfaced in later phases as
 * their respective Lite modules port over.
 */

/** Module version constant -- consumers can pin or feature-detect. */
export const SPACES_MODULE_VERSION = 1 as const;

// ─── Spaces ──────────────────────────────────────────────────────────────

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
  /** Cached count of `:Item` nodes with `[:MEMBER_OF]` to this Space. */
  itemCount?: number;
  /** ISO timestamp of node creation. */
  createdAt?: string;
  /** ISO timestamp of last update. */
  updatedAt?: string;
}

// ─── Items ───────────────────────────────────────────────────────────────

/** Discriminated kind values. Mirrors the `i.kind` property on `:Item` nodes. */
export type ItemKind =
  | 'document'
  | 'image'
  | 'url'
  | 'text'
  | 'audio'
  | 'video'
  | 'other';

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
 * Optional provenance row when the schema exposes `(:Item)-[:PRODUCED_BY|
 * AUTHORED_BY]->(...)` edges. `null` when absent.
 *
 * Whether this is populated is gated on Phase 0.5 Q2; the renderer
 * treats `null` as "do not render the line."
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
}

// ─── Query options ───────────────────────────────────────────────────────

/** Common list-options shape used by `items.list()` and future paged queries. */
export interface ListOpts {
  /** Default 100; cap is server-side. */
  limit?: number;
  /** For paging; 0-based. */
  offset?: number;
}
