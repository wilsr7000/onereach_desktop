/**
 * Spaces SDK client (internal).
 *
 * Wraps Cypher access through a narrow `queryFn` callback so the rest
 * of the Spaces module never talks to Neon directly and tests can
 * inject canned record streams without touching the wire format.
 *
 * Phase 1 lands:
 *   - `listSpaces()` — every `:Space` the active account can see
 *   - `getUncategorizedCount()` — `:Asset` nodes without a `:BELONGS_TO`
 *     edge to any `:Space`
 *
 * Phase 2 lands:
 *   - `listItems()` for `kind: 'uncategorized'` and `kind: 'space'`,
 *     including the `otherSpaces` multi-Space chip projection
 *   - `getItem()` for the detail panel
 *
 * Naming: the on-graph entity is `:Asset` per the canonical schema
 * (see `(:Schema {entity: 'Asset' | 'Space' | '_RelationshipTypes'})`
 * Schema nodes). Lite's TypeScript surface keeps the friendlier
 * "Item" naming (`Item`, `ItemSummary`, `ItemKind`) so renderers
 * read naturally; the SDK translates between the two.
 *
 * Server-side ACL filtering is assumed (Phase 0.5 Q4); this client
 * never layers an additional per-user predicate on top of the Cypher.
 *
 * @internal -- consumers go through `getSpacesApi()`.
 */

import { SpacesError } from './errors.js';
import type {
  Space,
  Item,
  ItemSummary,
  ItemKind,
  ItemProvenance,
  ListOpts,
  SpaceChipRef,
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
import type { SpaceScope } from './scope.js';

/**
 * Narrow callback shape matching `getNeonApi().query` so the SDK
 * client can be unit-tested with a hand-rolled stub instead of the
 * full Neon module.
 */
export type SpacesQueryFn = (
  cypher: string,
  parameters?: Record<string, unknown>
) => Promise<Array<Record<string, unknown>>>;

export interface SdkSpacesClientConfig {
  /** Resolver for the active OneReach auth env. Reserved for Phase 3+. */
  getAuthEnv?: () => string | null;
  /**
   * Cypher executor. Defaults to a stub that throws
   * `SPACES_NOT_INITIALIZED` so tests/contracts that don't supply one
   * surface a clear error instead of a runtime crash.
   */
  query?: SpacesQueryFn;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Cypher source strings live as module constants so tests can assert
 * the exact query the client emits and so the strings are diffable in
 * code review without inline-string noise.
 *
 * Schema alignment: the queries target the canonical OneReach graph
 * schema documented in `(:Schema {entity: 'Asset' | 'Space'})` nodes.
 * The Asset entity uses node label `:Asset` and connects to its
 * container via `[:BELONGS_TO]` (outgoing); see also `_RelationshipTypes`
 * Schema node. Lite's TypeScript surface still names these "Items"
 * for ergonomic reasons (every Lite renderer talks about `ItemSummary`
 * etc.) but the wire format is `:Asset` end-to-end.
 *
 * Every projected field uses `coalesce(canonical, legacy, default)`
 * so existing data written by the legacy `omnigraph-client.js` push
 * path (which writes `title`/`assetType`/`fileUrl`/`created_at`)
 * still renders correctly while new producers can move to canonical
 * field names (`name`/`type`/`url`/`createdAt`) at their own pace.
 */
export const CYPHER = {
  LIST_SPACES: `
    MATCH (s:Space)
    OPTIONAL MATCH (a:Asset)-[:BELONGS_TO]->(s)
    WITH s, count(a) AS itemCount
    RETURN s.id AS id,
           coalesce(s.name, s.id) AS name,
           coalesce(s.description, '') AS description,
           coalesce(s.color, '') AS color,
           coalesce(s.iconKey, s.icon, '') AS iconKey,
           itemCount AS itemCount,
           coalesce(toString(s.createdAt), toString(s.created_at), '') AS createdAt,
           coalesce(toString(s.updatedAt), toString(s.updated_at), '') AS updatedAt
    ORDER BY toLower(coalesce(s.name, s.id, '')) ASC
  `,
  UNCATEGORIZED_COUNT: `
    MATCH (a:Asset)
    WHERE NOT (a)-[:BELONGS_TO]->(:Space)
    RETURN count(a) AS count
  `,
  LIST_ITEMS_UNCATEGORIZED: `
    MATCH (a:Asset)
    WHERE NOT (a)-[:BELONGS_TO]->(:Space)
    OPTIONAL MATCH (creator:Person)-[:CREATED]->(a)
    WITH a, head(collect(creator)) AS producer
    RETURN a.id AS id,
           coalesce(a.name, a.title, a.id) AS title,
           coalesce(a.type, a.assetType, 'other') AS kind,
           coalesce(a.url, a.fileUrl) AS fileKey,
           coalesce(a.sourceUrl, a.source) AS sourceUrl,
           coalesce(toString(a.createdAt), toString(a.created_at), '') AS createdAt,
           coalesce(toString(a.updatedAt), toString(a.updated_at), '') AS updatedAt,
           coalesce(a.excerpt, a.description, a.notes) AS excerpt,
           [] AS otherSpaces,
           CASE WHEN producer IS NULL
                THEN null
                ELSE { kind: head(labels(producer)),
                       name: coalesce(producer.name, producer.title, ''),
                       id: producer.id }
           END AS producedBy
    ORDER BY coalesce(toString(a.updatedAt), toString(a.updated_at), toString(a.createdAt), toString(a.created_at), '') DESC
    SKIP toInteger($offset)
    LIMIT toInteger($limit)
  `,
  LIST_ITEMS_IN_SPACE: `
    MATCH (a:Asset)-[:BELONGS_TO]->(s:Space {id: $spaceId})
    OPTIONAL MATCH (a)-[:BELONGS_TO]->(other:Space)
      WHERE other.id <> s.id
    OPTIONAL MATCH (creator:Person)-[:CREATED]->(a)
    WITH a,
         collect(DISTINCT { id: other.id,
                            name: coalesce(other.name, other.id),
                            color: other.color,
                            iconKey: coalesce(other.iconKey, other.icon) }) AS otherSpacesRaw,
         head(collect(creator)) AS producer
    RETURN a.id AS id,
           coalesce(a.name, a.title, a.id) AS title,
           coalesce(a.type, a.assetType, 'other') AS kind,
           coalesce(a.url, a.fileUrl) AS fileKey,
           coalesce(a.sourceUrl, a.source) AS sourceUrl,
           coalesce(toString(a.createdAt), toString(a.created_at), '') AS createdAt,
           coalesce(toString(a.updatedAt), toString(a.updated_at), '') AS updatedAt,
           coalesce(a.excerpt, a.description, a.notes) AS excerpt,
           [x IN otherSpacesRaw WHERE x.id IS NOT NULL] AS otherSpaces,
           CASE WHEN producer IS NULL
                THEN null
                ELSE { kind: head(labels(producer)),
                       name: coalesce(producer.name, producer.title, ''),
                       id: producer.id }
           END AS producedBy
    ORDER BY coalesce(toString(a.updatedAt), toString(a.updated_at), toString(a.createdAt), toString(a.created_at), '') DESC
    SKIP toInteger($offset)
    LIMIT toInteger($limit)
  `,
  GET_ITEM: `
    MATCH (a:Asset {id: $id})
    OPTIONAL MATCH (a)-[:BELONGS_TO]->(s:Space)
    OPTIONAL MATCH (creator:Person)-[:CREATED]->(a)
    WITH a,
         collect(DISTINCT { id: s.id,
                            name: coalesce(s.name, s.id),
                            color: s.color,
                            iconKey: coalesce(s.iconKey, s.icon) }) AS spacesRaw,
         head(collect(creator)) AS producer
    RETURN a.id AS id,
           coalesce(a.name, a.title, a.id) AS title,
           coalesce(a.type, a.assetType, 'other') AS kind,
           coalesce(a.url, a.fileUrl) AS fileKey,
           coalesce(a.sourceUrl, a.source) AS sourceUrl,
           coalesce(toString(a.createdAt), toString(a.created_at), '') AS createdAt,
           coalesce(toString(a.updatedAt), toString(a.updated_at), '') AS updatedAt,
           coalesce(a.excerpt, a.description, a.notes) AS excerpt,
           coalesce(a.content, '') AS content,
           null AS metadata,
           [x IN spacesRaw WHERE x.id IS NOT NULL] AS otherSpaces,
           CASE WHEN producer IS NULL
                THEN null
                ELSE { kind: head(labels(producer)),
                       name: coalesce(producer.name, producer.title, ''),
                       id: producer.id }
           END AS producedBy
    LIMIT 1
  `,

  // ─── Home view (chunk 3k + 3o) ───────────────────────────────────────
  //
  // Six read-only queries powering the Home news-feed cards. Detail in
  // `lite/spaces/HOME-V1.md`. All follow the canonical schema (`:Asset`,
  // `:BELONGS_TO`, `:Person`, `:Agent`) and reuse the `coalesce(canonical,
  // legacy, default)` projection pattern from the LIST_ITEMS_* queries
  // so legacy producer-side data still renders.

  /**
   * Entity counts via APOC. Falls back to `HOME_ENTITY_COUNTS_FALLBACK`
   * in the SDK when APOC is unavailable. Same recovery pattern as
   * `discovery.ts` Q1.
   */
  HOME_ENTITY_COUNTS: `
    CALL apoc.meta.stats() YIELD labels
    RETURN labels
  `,
  HOME_ENTITY_COUNTS_FALLBACK: `
    MATCH (s:Space) RETURN 'Space' AS kind, count(s) AS n
    UNION ALL
    MATCH (a:Asset) RETURN 'Asset' AS kind, count(a) AS n
    UNION ALL
    MATCH (p:Person) RETURN 'Person' AS kind, count(p) AS n
    UNION ALL
    MATCH (g:Agent) RETURN 'Agent' AS kind, count(g) AS n
  `,

  /**
   * Most-recently-added/updated assets across the entire account.
   * Returns rows shaped to the `ItemSummary` projection so the
   * renderer reuses the existing item-card builder (Card 5).
   */
  HOME_RECENT_ITEMS: `
    MATCH (a:Asset)
    OPTIONAL MATCH (a)-[:BELONGS_TO]->(s:Space)
    WITH a, head(collect(s)) AS firstSpace
    RETURN a.id AS id,
           coalesce(a.name, a.title, a.id) AS title,
           coalesce(a.type, a.assetType, 'other') AS kind,
           coalesce(a.url, a.fileUrl) AS fileKey,
           coalesce(a.sourceUrl, a.source) AS sourceUrl,
           coalesce(toString(a.createdAt), toString(a.created_at), '') AS createdAt,
           coalesce(toString(a.updatedAt), toString(a.updated_at), '') AS updatedAt,
           coalesce(a.excerpt, a.description, a.notes) AS excerpt,
           CASE WHEN firstSpace IS NULL
                THEN []
                ELSE [{ id: firstSpace.id,
                        name: coalesce(firstSpace.name, firstSpace.id),
                        color: firstSpace.color,
                        iconKey: coalesce(firstSpace.iconKey, firstSpace.icon) }]
           END AS otherSpaces,
           null AS producedBy
    ORDER BY coalesce(toString(a.updatedAt), toString(a.updated_at),
                      toString(a.createdAt), toString(a.created_at), '') DESC
    LIMIT toInteger($limit)
  `,

  /**
   * Top contributors over a rolling time window. Each row is one
   * `:Commit.author` with the count of commits in the window and the
   * timestamp of their most recent commit.
   *
   * `$sinceMs` is computed in JS from the requested window (day/week/
   * month). v1 doesn't try to resolve `:Commit.author` to `:Person` /
   * `:Agent` — that's a v2 concern.
   */
  HOME_TOP_CONTRIBUTORS: `
    MATCH (c:Commit)
    WHERE c.timestamp >= $sinceMs
    RETURN c.author AS author,
           count(c) AS events,
           toString(max(c.timestamp)) AS lastEventAt
    ORDER BY events DESC
    LIMIT toInteger($limit)
  `,

  /**
   * Recent commit events, optionally filtered to those after a cutoff.
   * Powers Card 2's "See timeline" drill-down (currently a modal).
   *
   * The `kind` projection deliberately surfaces `:Commit.message`
   * verbatim (e.g. `'item:added'`, `'item:updated'`). When v2's 3l
   * sync events arrive they reuse this projection — `kind` widens
   * but the row shape doesn't change.
   */
  HOME_RECENT_EVENTS: `
    MATCH (c:Commit)
    WHERE ($since IS NULL OR c.timestamp >= $since)
      AND ($spaceId IS NULL OR c.spaceId = $spaceId)
    OPTIONAL MATCH (c)-[:IN_SPACE]->(s:Space)
    RETURN c.hash AS id,
           c.author AS author,
           c.message AS kind,
           toString(c.timestamp) AS timestamp,
           c.spaceId AS spaceId,
           coalesce(s.name, c.spaceId) AS spaceName
    ORDER BY c.timestamp DESC
    LIMIT toInteger($limit)
  `,

  /**
   * Sample of `:Agent` nodes for Card 3. v1 returns alphabetical first
   * N; the modal-listing UX paginates through with repeated calls.
   */
  HOME_AGENTS_SAMPLE: `
    MATCH (a:Agent)
    RETURN a.id AS id,
           coalesce(a.name, a.title, a.id) AS name,
           coalesce(a.description, a.summary, '') AS description
    ORDER BY toLower(coalesce(a.name, a.id, '')) ASC
    LIMIT toInteger($limit)
  `,

  /**
   * Permission summary for Card 4. v1 only knows `visibleSpaceCount`;
   * `totalSpaceCount` (Spaces in account the user can't see) is left
   * unset until Edison D6 returns a way to count them.
   */
  HOME_PERMISSION_SUMMARY: `
    MATCH (s:Space)
    WITH count(s) AS visible
    RETURN visible AS visibleSpaceCount
  `,
} as const;

/**
 * Real Phase 1+ SDK client. Construct with a `query` function that
 * runs Cypher (e.g. `getNeonApi().query` in production, a stub in
 * tests).
 */
export class SdkSpacesClient {
  protected readonly getAuthEnv: () => string | null;
  protected readonly queryFn: SpacesQueryFn;

  constructor(config: SdkSpacesClientConfig = {}) {
    this.getAuthEnv = config.getAuthEnv ?? ((): string | null => null);
    this.queryFn =
      config.query ??
      (async (): Promise<Array<Record<string, unknown>>> => {
        throw new SpacesError({
          code: 'SPACES_NOT_INITIALIZED',
          message: 'SdkSpacesClient is missing a query function',
          remediation:
            'Construct with `new SdkSpacesClient({ query: getNeonApi().query })` from main.ts at boot, or pass a stub in tests.',
        });
      });
  }

  async listSpaces(): Promise<Space[]> {
    const rows = await this.run(CYPHER.LIST_SPACES);
    return rows.map(toSpace);
  }

  async getUncategorizedCount(): Promise<number> {
    const rows = await this.run(CYPHER.UNCATEGORIZED_COUNT);
    return toCount(rows[0]);
  }

  async listItems(scope: SpaceScope, opts: ListOpts = {}): Promise<ItemSummary[]> {
    const limit = clampLimit(opts.limit);
    const offset = clampOffset(opts.offset);
    if (scope.kind === 'uncategorized') {
      const rows = await this.run(CYPHER.LIST_ITEMS_UNCATEGORIZED, { offset, limit });
      return rows.map((r) => toItemSummary(r, { stripOtherSpaces: true }));
    }
    const spaceId = scope.spaceId;
    if (typeof spaceId !== 'string' || spaceId.length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'listItems(scope=space) requires a non-empty spaceId',
        remediation: 'Pass a SpaceScope with a real space.id from a prior listSpaces() result.',
        context: { spaceId },
      });
    }
    const rows = await this.run(CYPHER.LIST_ITEMS_IN_SPACE, { spaceId, offset, limit });
    return rows.map((r) => toItemSummary(r, { stripOtherSpaces: false }));
  }

  async getItem(id: string): Promise<Item | null> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'getItem requires a non-empty id',
        remediation: 'Pass the canonical item id from a prior list result.',
        context: { id },
      });
    }
    const rows = await this.run(CYPHER.GET_ITEM, { id });
    if (rows.length === 0) return null;
    return toItem(rows[0] as Record<string, unknown>);
  }

  // ─── Home view methods (chunk 3k) ──────────────────────────────────────

  /**
   * Flat entity counts powering the "Your data room at a glance" card.
   *
   * Tries APOC first; falls back to explicit `UNION ALL` per the
   * `discovery.ts` Q1 pattern. The fallback runs only when APOC
   * raises a NEON_QUERY error that looks like "procedure not found".
   *
   * Counts default to 0 (never undefined) so the renderer can tell
   * "loaded with no data" apart from "still loading".
   */
  async getEntityCounts(): Promise<EntityCounts> {
    try {
      const rows = await this.run(CYPHER.HOME_ENTITY_COUNTS);
      return toEntityCountsFromApoc(rows);
    } catch (err) {
      if (looksLikeMissingApoc(err)) {
        const rows = await this.run(CYPHER.HOME_ENTITY_COUNTS_FALLBACK);
        return toEntityCountsFromFallback(rows);
      }
      throw err;
    }
  }

  /**
   * Most-recent assets across the entire account. Powers Card 5
   * ("Just added"). Returns `ItemSummary` so the renderer can reuse
   * the existing item-card builder.
   */
  async listRecentItems(opts: RecentItemsOpts = {}): Promise<ItemSummary[]> {
    const limit = clampSmallLimit(opts.limit, 3, 50);
    const rows = await this.run(CYPHER.HOME_RECENT_ITEMS, { limit });
    // Same row shape as LIST_ITEMS_*; reuse the existing helper. The
    // `otherSpaces` projection on this query is always 0 or 1 chip, but
    // the helper handles both cases uniformly.
    return rows.map((r) => toItemSummary(r, { stripOtherSpaces: false }));
  }

  /**
   * Top contributors over a rolling time window. Powers Card 2
   * ("Recent activity"). Window defaults to 'week'.
   */
  async topContributors(opts: TopContributorsOpts = {}): Promise<Contributor[]> {
    const window: ContributorWindow = opts.window ?? 'week';
    const sinceMs = computeSinceMs(window);
    const limit = clampSmallLimit(opts.limit, 4, 50);
    const rows = await this.run(CYPHER.HOME_TOP_CONTRIBUTORS, { sinceMs, limit });
    return rows.map(toContributor).filter((c): c is Contributor => c !== null);
  }

  /**
   * Recent commit events. Powers the Card 2 "See timeline" modal
   * drill-down. Limit defaults to 50; cap is 200.
   */
  async listRecentEvents(opts: RecentEventsOpts = {}): Promise<Event[]> {
    const limit = clampSmallLimit(opts.limit, 50, 200);
    const since =
      typeof opts.since === 'number' && Number.isFinite(opts.since) && opts.since >= 0
        ? Math.floor(opts.since)
        : null;
    // Empty / non-string spaceId collapses to null so the Cypher's
    // optional-equality branch fires (no filter applied). The
    // canonical scope helper lives in `scope.ts`; this guard is the
    // SDK-layer twin of the renderer's "is this a real spaceId" check.
    const spaceId =
      typeof opts.spaceId === 'string' && opts.spaceId.length > 0 ? opts.spaceId : null;
    const rows = await this.run(CYPHER.HOME_RECENT_EVENTS, { limit, since, spaceId });
    return rows.map(toEvent).filter((e): e is Event => e !== null);
  }

  /**
   * Sample of `:Agent` nodes for Card 3. Limit defaults to 3 (matches
   * card row count); cap is 200 (matches the modal pagination size).
   */
  async listAgentsSample(opts: AgentsSampleOpts = {}): Promise<AgentSummary[]> {
    const limit = clampSmallLimit(opts.limit, 3, 200);
    const rows = await this.run(CYPHER.HOME_AGENTS_SAMPLE, { limit });
    return rows.map(toAgentSummary).filter((a): a is AgentSummary => a !== null);
  }

  /**
   * Permission summary for Card 4. v1 only populates `visibleSpaceCount`;
   * `totalSpaceCount` is omitted until Edison D6 returns a way to count
   * Spaces the user can't see.
   */
  async getPermissionSummary(): Promise<PermissionSummary> {
    const rows = await this.run(CYPHER.HOME_PERMISSION_SUMMARY);
    return toPermissionSummary(rows[0]);
  }

  /**
   * Wraps the injected query function and translates underlying
   * errors into `SpacesError` so callers always see one stable
   * exception type. Errors that are already `SpacesError` pass
   * through unchanged.
   */
  private async run(
    cypher: string,
    parameters?: Record<string, unknown>
  ): Promise<Array<Record<string, unknown>>> {
    try {
      return await this.queryFn(cypher, parameters);
    } catch (err) {
      throw normalizeError(err);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function normalizeError(err: unknown): SpacesError {
  if (err instanceof SpacesError) return err;
  const code = extractNeonErrorCode(err);
  if (code === 'NEON_NOT_CONFIGURED') {
    return new SpacesError({
      code: 'SPACES_NOT_AUTHENTICATED',
      message: 'Spaces requires a configured Neon endpoint and signed-in account',
      remediation:
        'Sign in to OneReach and verify Settings → OAGI shows a valid Neon endpoint.',
      cause: err instanceof Error ? err : undefined,
    });
  }
  if (code === 'NEON_NETWORK' || code === 'NEON_TIMEOUT') {
    return new SpacesError({
      code: 'SPACES_NETWORK',
      message: `Neon ${code === 'NEON_TIMEOUT' ? 'request timed out' : 'network call failed'}`,
      remediation: 'Retry after verifying connectivity to the configured Edison endpoint.',
      cause: err instanceof Error ? err : undefined,
    });
  }
  if (code === 'NEON_QUERY' || code === 'NEON_HTTP' || code === 'NEON_BAD_INPUT') {
    return new SpacesError({
      code: 'SPACES_CYPHER',
      message:
        err instanceof Error
          ? err.message
          : 'Cypher execution failed',
      remediation:
        'Inspect the Neon module logs (events `neon.query.fail`) for the underlying server response.',
      cause: err instanceof Error ? err : undefined,
    });
  }
  return new SpacesError({
    code: 'SPACES_CYPHER',
    message: err instanceof Error ? err.message : String(err),
    remediation: 'Inspect logging events to identify the failing Cypher and parameters.',
    cause: err instanceof Error ? err : undefined,
  });
}

function extractNeonErrorCode(err: unknown): string | null {
  if (err === null || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function toSpace(row: Record<string, unknown>): Space {
  const space: Space = {
    id: requireString(row, 'id'),
    name: optString(row, 'name') ?? '',
  };
  const description = optString(row, 'description');
  if (description !== undefined) space.description = description;
  const color = optString(row, 'color');
  if (color !== undefined) space.color = color;
  const iconKey = optString(row, 'iconKey');
  if (iconKey !== undefined) space.iconKey = iconKey;
  const itemCount = optNumber(row, 'itemCount');
  if (itemCount !== undefined) space.itemCount = itemCount;
  const createdAt = optString(row, 'createdAt');
  if (createdAt !== undefined) space.createdAt = createdAt;
  const updatedAt = optString(row, 'updatedAt');
  if (updatedAt !== undefined) space.updatedAt = updatedAt;
  return space;
}

function toCount(row: Record<string, unknown> | undefined): number {
  if (row === undefined) return 0;
  const raw = row['count'];
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.floor(raw));
  return 0;
}

interface SummaryOpts {
  /** If true, drop the otherSpaces projection (always [] for uncategorized). */
  stripOtherSpaces: boolean;
}

function toItemSummary(row: Record<string, unknown>, opts: SummaryOpts): ItemSummary {
  const summary: ItemSummary = {
    id: requireString(row, 'id'),
    title: optString(row, 'title') ?? '',
    kind: toItemKind(row['kind']),
    createdAt: optString(row, 'createdAt') ?? '',
    updatedAt: optString(row, 'updatedAt') ?? '',
    otherSpaces: opts.stripOtherSpaces ? [] : toChipList(row['otherSpaces']),
    producedBy: toProducedBy(row['producedBy']),
  };
  const fileKey = optString(row, 'fileKey');
  if (fileKey !== undefined) summary.fileKey = fileKey;
  const sourceUrl = optString(row, 'sourceUrl');
  if (sourceUrl !== undefined) summary.sourceUrl = sourceUrl;
  const excerpt = optString(row, 'excerpt');
  if (excerpt !== undefined) summary.excerpt = excerpt;
  return summary;
}

function toItem(row: Record<string, unknown>): Item {
  const base = toItemSummary(row, { stripOtherSpaces: false });
  const item: Item = { ...base };
  const content = optString(row, 'content');
  if (content !== undefined) item.content = content;
  const metaRaw = row['metadata'];
  if (metaRaw !== null && typeof metaRaw === 'object' && !Array.isArray(metaRaw)) {
    item.metadata = metaRaw as Record<string, unknown>;
  }
  return item;
}

const ITEM_KINDS: ReadonlySet<ItemKind> = new Set([
  'document',
  'image',
  'url',
  'text',
  'audio',
  'video',
  'other',
]);

function toItemKind(v: unknown): ItemKind {
  return typeof v === 'string' && (ITEM_KINDS as Set<string>).has(v) ? (v as ItemKind) : 'other';
}

function toChipList(v: unknown): SpaceChipRef[] {
  if (!Array.isArray(v)) return [];
  const out: SpaceChipRef[] = [];
  for (const raw of v) {
    if (raw === null || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r['id'] === 'string' ? (r['id'] as string) : null;
    if (id === null || id.length === 0) continue;
    const chip: SpaceChipRef = {
      id,
      name: typeof r['name'] === 'string' ? (r['name'] as string) : '',
    };
    if (typeof r['color'] === 'string') chip.color = r['color'] as string;
    if (typeof r['iconKey'] === 'string') chip.iconKey = r['iconKey'] as string;
    out.push(chip);
  }
  return out;
}

function toProducedBy(v: unknown): ItemProvenance | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const id = typeof r['id'] === 'string' ? (r['id'] as string) : null;
  if (id === null || id.length === 0) return null;
  return {
    kind: typeof r['kind'] === 'string' ? (r['kind'] as string) : '',
    name: typeof r['name'] === 'string' ? (r['name'] as string) : '',
    id,
  };
}

function requireString(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new SpacesError({
      code: 'SPACES_CYPHER',
      message: `Required field '${key}' missing or non-string in Cypher result`,
      remediation: 'Verify the graph schema matches the Spaces SDK expectations.',
      context: { key, received: typeof v },
    });
  }
  return v;
}

function optString(row: Record<string, unknown>, key: string): string | undefined {
  const v = row[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function optNumber(row: Record<string, unknown>, key: string): number | undefined {
  const v = row[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function clampLimit(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(v), MAX_LIMIT);
}

// ─── Home-view helpers (chunk 3k) ────────────────────────────────────────

/** Per-method clamper used by the Home methods (defaults differ per card). */
function clampSmallLimit(
  v: number | undefined,
  defaultValue: number,
  cap: number
): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return defaultValue;
  return Math.min(Math.floor(v), cap);
}

/**
 * Returns true when an error from the APOC `getEntityCounts` attempt
 * looks like APOC isn't installed. Mirrors the heuristic from
 * `discovery.ts runQ1`. Anything else (auth, network, permissions)
 * propagates so callers see a real failure instead of a silent
 * fallback that hides the underlying cause.
 */
function looksLikeMissingApoc(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : null;
  const message = typeof e.message === 'string' ? e.message : '';
  return (
    code === 'SPACES_CYPHER' &&
    /procedure|apoc\.meta\.stats|not.?found/i.test(message)
  );
}

/**
 * Normalise the APOC `apoc.meta.stats() YIELD labels` result shape
 * into a flat `EntityCounts`. The `labels` field is an object whose
 * keys are label names and values are counts.
 */
function toEntityCountsFromApoc(rows: Array<Record<string, unknown>>): EntityCounts {
  const counts = emptyEntityCounts();
  if (rows.length === 0) return counts;
  const labels = rows[0]?.['labels'];
  if (labels === null || typeof labels !== 'object') return counts;
  const entries = labels as Record<string, unknown>;
  counts.spaces = readLabelCount(entries, 'Space');
  counts.assets = readLabelCount(entries, 'Asset');
  counts.people = readLabelCount(entries, 'Person');
  counts.agents = readLabelCount(entries, 'Agent');
  return counts;
}

/**
 * Normalise the UNION-ALL fallback result shape into `EntityCounts`.
 * Each row is `{ kind: <Label>, n: <count> }`. Missing rows mean 0.
 */
function toEntityCountsFromFallback(
  rows: Array<Record<string, unknown>>
): EntityCounts {
  const counts = emptyEntityCounts();
  for (const row of rows) {
    const kind = row['kind'];
    const n = row['n'];
    if (typeof kind !== 'string' || typeof n !== 'number' || !Number.isFinite(n)) continue;
    const value = Math.max(0, Math.floor(n));
    if (kind === 'Space') counts.spaces = value;
    else if (kind === 'Asset') counts.assets = value;
    else if (kind === 'Person') counts.people = value;
    else if (kind === 'Agent') counts.agents = value;
  }
  return counts;
}

function emptyEntityCounts(): EntityCounts {
  return { spaces: 0, assets: 0, people: 0, agents: 0 };
}

function readLabelCount(entries: Record<string, unknown>, label: string): number {
  const v = entries[label];
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.floor(v));
}

/**
 * Compute the `sinceMs` epoch parameter for `topContributors()` from
 * a window selector. Uses 24h / 7d / 30d windows.
 */
function computeSinceMs(window: ContributorWindow): number {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  if (window === 'day') return now - day;
  if (window === 'month') return now - 30 * day;
  return now - 7 * day; // 'week' (default)
}

/**
 * Map one row of `HOME_TOP_CONTRIBUTORS` into a `Contributor`.
 * Returns `null` for malformed rows (missing author or non-numeric
 * count) so the caller can `.filter` them out.
 */
function toContributor(row: Record<string, unknown>): Contributor | null {
  const author = optString(row, 'author');
  if (author === undefined) return null;
  const events = optNumber(row, 'events') ?? 0;
  const lastEventAt = optString(row, 'lastEventAt') ?? '';
  return {
    author,
    displayName: author, // v1: verbatim. v2 may resolve via :Person/:Agent.
    events: Math.max(0, Math.floor(events)),
    lastEventAt,
  };
}

/**
 * Map one row of `HOME_RECENT_EVENTS` into an `Event`. Returns `null`
 * for malformed rows so callers can `.filter` them out.
 */
function toEvent(row: Record<string, unknown>): Event | null {
  const id = optString(row, 'id');
  const author = optString(row, 'author') ?? '';
  const kind = optString(row, 'kind') ?? '';
  const timestamp = optString(row, 'timestamp') ?? '';
  if (id === undefined) return null;
  const event: Event = { id, author, kind, timestamp };
  const spaceId = optString(row, 'spaceId');
  if (spaceId !== undefined) event.spaceId = spaceId;
  const spaceName = optString(row, 'spaceName');
  if (spaceName !== undefined) event.spaceName = spaceName;
  return event;
}

/**
 * Map one row of `HOME_AGENTS_SAMPLE` into an `AgentSummary`. Returns
 * `null` for malformed rows.
 */
function toAgentSummary(row: Record<string, unknown>): AgentSummary | null {
  const id = optString(row, 'id');
  if (id === undefined) return null;
  const name = optString(row, 'name') ?? id;
  const description = typeof row['description'] === 'string' ? (row['description'] as string) : '';
  return { id, name, description };
}

/**
 * Map one row of `HOME_PERMISSION_SUMMARY` into a `PermissionSummary`.
 * Missing or malformed `visibleSpaceCount` defaults to 0.
 */
function toPermissionSummary(
  row: Record<string, unknown> | undefined
): PermissionSummary {
  if (row === undefined) return { visibleSpaceCount: 0 };
  const visible = row['visibleSpaceCount'];
  const visibleSpaceCount =
    typeof visible === 'number' && Number.isFinite(visible)
      ? Math.max(0, Math.floor(visible))
      : 0;
  const summary: PermissionSummary = { visibleSpaceCount };
  const total = row['totalSpaceCount'];
  if (typeof total === 'number' && Number.isFinite(total)) {
    summary.totalSpaceCount = Math.max(0, Math.floor(total));
  }
  return summary;
}

function clampOffset(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}
