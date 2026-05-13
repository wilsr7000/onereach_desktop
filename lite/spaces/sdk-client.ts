/**
 * Spaces SDK client (internal).
 *
 * Wraps Cypher access through a narrow `queryFn` callback so the rest
 * of the Spaces module never talks to Neon directly and tests can
 * inject canned record streams without touching the wire format.
 *
 * Phase 1 lands:
 *   - `listSpaces()` — every `:Space` the active account can see
 *   - `getUncategorizedCount()` — `:Item` nodes without a `:MEMBER_OF`
 *     edge to any `:Space`
 *
 * Phase 2 lands:
 *   - `listItems()` for `kind: 'uncategorized'` and `kind: 'space'`,
 *     including the `otherSpaces` multi-Space chip projection
 *   - `getItem()` for the detail panel
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
 */
export const CYPHER = {
  LIST_SPACES: `
    MATCH (s:Space)
    OPTIONAL MATCH (i:Item)-[:MEMBER_OF]->(s)
    WITH s, count(i) AS itemCount
    RETURN s.id AS id,
           s.name AS name,
           s.description AS description,
           s.color AS color,
           s.iconKey AS iconKey,
           itemCount AS itemCount,
           s.createdAt AS createdAt,
           s.updatedAt AS updatedAt
    ORDER BY toLower(coalesce(s.name, '')) ASC
  `,
  UNCATEGORIZED_COUNT: `
    MATCH (i:Item)
    WHERE NOT (i)-[:MEMBER_OF]->(:Space)
    RETURN count(i) AS count
  `,
  LIST_ITEMS_UNCATEGORIZED: `
    MATCH (i:Item)
    WHERE NOT (i)-[:MEMBER_OF]->(:Space)
    OPTIONAL MATCH (i)-[:PRODUCED_BY|AUTHORED_BY]->(producer)
    WITH i, head(collect(producer)) AS producer
    RETURN i.id AS id,
           i.title AS title,
           i.kind AS kind,
           i.fileKey AS fileKey,
           i.sourceUrl AS sourceUrl,
           i.createdAt AS createdAt,
           i.updatedAt AS updatedAt,
           i.excerpt AS excerpt,
           [] AS otherSpaces,
           CASE WHEN producer IS NULL
                THEN null
                ELSE { kind: head(labels(producer)),
                       name: coalesce(producer.name, producer.title, ''),
                       id: producer.id }
           END AS producedBy
    ORDER BY coalesce(i.updatedAt, i.createdAt, '') DESC
    SKIP toInteger($offset)
    LIMIT toInteger($limit)
  `,
  LIST_ITEMS_IN_SPACE: `
    MATCH (i:Item)-[:MEMBER_OF]->(s:Space {id: $spaceId})
    OPTIONAL MATCH (i)-[:MEMBER_OF]->(other:Space)
      WHERE other.id <> s.id
    OPTIONAL MATCH (i)-[:PRODUCED_BY|AUTHORED_BY]->(producer)
    WITH i,
         collect(DISTINCT { id: other.id,
                            name: other.name,
                            color: other.color,
                            iconKey: other.iconKey }) AS otherSpacesRaw,
         head(collect(producer)) AS producer
    RETURN i.id AS id,
           i.title AS title,
           i.kind AS kind,
           i.fileKey AS fileKey,
           i.sourceUrl AS sourceUrl,
           i.createdAt AS createdAt,
           i.updatedAt AS updatedAt,
           i.excerpt AS excerpt,
           [x IN otherSpacesRaw WHERE x.id IS NOT NULL] AS otherSpaces,
           CASE WHEN producer IS NULL
                THEN null
                ELSE { kind: head(labels(producer)),
                       name: coalesce(producer.name, producer.title, ''),
                       id: producer.id }
           END AS producedBy
    ORDER BY coalesce(i.updatedAt, i.createdAt, '') DESC
    SKIP toInteger($offset)
    LIMIT toInteger($limit)
  `,
  GET_ITEM: `
    MATCH (i:Item {id: $id})
    OPTIONAL MATCH (i)-[:MEMBER_OF]->(s:Space)
    OPTIONAL MATCH (i)-[:PRODUCED_BY|AUTHORED_BY]->(producer)
    WITH i,
         collect(DISTINCT { id: s.id,
                            name: s.name,
                            color: s.color,
                            iconKey: s.iconKey }) AS spacesRaw,
         head(collect(producer)) AS producer
    RETURN i.id AS id,
           i.title AS title,
           i.kind AS kind,
           i.fileKey AS fileKey,
           i.sourceUrl AS sourceUrl,
           i.createdAt AS createdAt,
           i.updatedAt AS updatedAt,
           i.excerpt AS excerpt,
           i.content AS content,
           i.metadata AS metadata,
           [x IN spacesRaw WHERE x.id IS NOT NULL] AS otherSpaces,
           CASE WHEN producer IS NULL
                THEN null
                ELSE { kind: head(labels(producer)),
                       name: coalesce(producer.name, producer.title, ''),
                       id: producer.id }
           END AS producedBy
    LIMIT 1
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

function clampOffset(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}
