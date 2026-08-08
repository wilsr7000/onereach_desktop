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
import type { LearnSignals } from './learn-content.js';
import type { Span } from '../logging/events.js';
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
  CreateSpaceInput,
  DeleteSpaceOpts,
  UpdateSpaceInput,
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
  AddSpaceMemberOptions,
  Checklist,
  ChecklistItemSpec,
  TicketChecklist,
  CreateChecklistInput,
  AttachChecklistInput,
  SetChecklistItemInput,
  CreateAssetInput,
  CreateAgentInput,
  CreateAgentFromLibraryInput,
  AgentLibraryEntry,
  MemberLibraryEntry,
  AgentEndpoint,
  AgentEndpointKind,
  DeleteAssetOpts,
  SearchItemsOpts,
  ItemMetadata,
  MetadataValue,
  MetadataPrimitive,
} from './types.js';
import {
  MAX_SPACE_NAME_LENGTH,
  MAX_SPACE_DESC_LENGTH,
  MAX_ITEM_TITLE_LENGTH,
  MAX_ITEM_DESCRIPTION_LENGTH,
  MAX_ITEM_CONTENT_LENGTH,
  MAX_ITEM_TAG_LENGTH,
} from './types.js';
import type { SpaceScope } from './scope.js';
import { CHECKLIST_MODES, CHECKLIST_OBLIGATIONS, MAX_CHECKLIST_ITEMS } from './types.js';
import type { UpdateChecklistInput } from './types.js';

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
  /**
   * Span emitter (ADR-030). When provided, every instrumented
   * operation wraps in a `spaces.<op>.start` / `.finish` / `.fail`
   * span so Neon-backed reads/writes are traceable in
   * `/logs?category=spaces` -- including the boot prewarm + background
   * refresh paths that never cross IPC. Wired to
   * `getLoggingApi().start(name, data)` by `main.ts`; omitted in tests
   * (silent fallback). Mirrors `SdkFilesClientConfig.spanEmitter`.
   */
  spanEmitter?: (name: string, data?: unknown) => Span;
  /**
   * ADR-051 — resolver for the viewing `:Person.id` (the signed-in
   * user's lowercased email, falling back to accountId; same
   * convention as the renderer's boot-time whoAmI probe). '' / null
   * means "unknown viewer" and every restricted Space is gated out.
   */
  viewerId?: () => string | null;
  /**
   * ADR-052 — clock seam. Injected into every query as `$nowMs` so
   * expiring access grants can be evaluated in Cypher. Tests pin it to
   * assert grant expiry deterministically; production uses `Date.now`.
   */
  now?: () => number;
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
/**
 * ADR-051 — per-space visibility gating. A Space is visible when it is
 * 'open' (the default; every pre-existing Space) or when the viewer
 * holds a `[:HAS_ACCESS]` edge to it. `$viewerId` is always bound ('':
 * signed-out / unknown viewer sees only open content). Alias contract:
 * the space being tested must be bound as `s`.
 */
/**
 * ADR-052 — a grant is live when it has no expiry, or its expiry is
 * still in the future. `$nowMs` is injected by `run()` for every query,
 * so no call site can forget to bind it.
 *
 * `r.expiresUnixMs IS NULL` means permanent. Every grant written before
 * expiry existed has no such property, so all of them stay valid — the
 * feature is additive and cannot retroactively lock anyone out.
 *
 * Epoch millis rather than an ISO string on purpose: numeric comparison
 * has no timezone or zero-padding hazard, and a lexicographic compare
 * of mixed-format timestamps fails silently in exactly the direction
 * that grants access.
 */
const GRANT_LIVE = `(r.expiresUnixMs IS NULL OR r.expiresUnixMs > $nowMs)`;

/**
 * SPACE_VISIBLE for a space bound as `other` (the GET_ITEM chips join).
 * Without it, an item visible through one open Space showed chips
 * NAMING every restricted Space it also belongs to — and names are
 * often the sensitive part.
 */
const OTHER_SPACE_VISIBLE = `(
        coalesce(other.visibility, 'open') <> 'restricted'
        OR ($viewerId <> '' AND EXISTS {
          MATCH (:Person {id: $viewerId})-[r2:HAS_ACCESS]->(other)
          WHERE (r2.expiresUnixMs IS NULL OR r2.expiresUnixMs > $nowMs)
        })
      )`;

const SPACE_VISIBLE = `(
        coalesce(s.visibility, 'open') <> 'restricted'
        OR ($viewerId <> '' AND EXISTS {
          MATCH (:Person {id: $viewerId})-[r:HAS_ACCESS]->(s)
          WHERE ${GRANT_LIVE}
        })
      )`;

/**
 * ADR-051 — item-level visibility. An asset (bound as `a`) is visible
 * when it is uncategorized (no space at all) or belongs to at least one
 * space the viewer can see. An item in both a restricted space and an
 * open one is visible — it genuinely lives in the open space.
 */
const ASSET_VISIBLE = `(
        NOT EXISTS {
          MATCH (a)-[:BELONGS_TO]->(anyLive:Space)
          WHERE anyLive.deletedAt IS NULL
        }
        OR EXISTS {
          MATCH (a)-[:BELONGS_TO]->(vs:Space)
          WHERE vs.deletedAt IS NULL
            AND (coalesce(vs.visibility, 'open') <> 'restricted'
                 OR ($viewerId <> '' AND EXISTS {
                   MATCH (:Person {id: $viewerId})-[r:HAS_ACCESS]->(vs)
                   WHERE ${GRANT_LIVE}
                 }))
        }
      )`;

export const CYPHER = {
  LIST_SPACES: `
    MATCH (s:Space)
      WHERE s.deletedAt IS NULL
        AND ${SPACE_VISIBLE}
    OPTIONAL MATCH (a:Asset)-[:BELONGS_TO]->(s)
    WITH s, count(a) AS itemCount
    RETURN s.id AS id,
           coalesce(s.name, s.id) AS name,
           coalesce(s.description, '') AS description,
           coalesce(s.color, '') AS color,
           coalesce(s.iconKey, s.icon, '') AS iconKey,
           coalesce(s.kind, 'user') AS kind,
           coalesce(s.visibility, 'open') AS visibility,
           itemCount AS itemCount,
           coalesce(toString(s.createdAt), toString(s.created_at), '') AS createdAt,
           coalesce(toString(s.updatedAt), toString(s.updated_at), '') AS updatedAt
    ORDER BY toLower(coalesce(s.name, s.id, '')) ASC
  `,
  UNCATEGORIZED_COUNT: `
    MATCH (a:Asset)
    WHERE a.deletedAt IS NULL
      AND NOT EXISTS {
        MATCH (a)-[:BELONGS_TO]->(live:Space)
        WHERE live.deletedAt IS NULL
      }
    RETURN count(a) AS count
  `,
  LIST_ITEMS_UNCATEGORIZED: `
    MATCH (a:Asset)
    WHERE a.deletedAt IS NULL
      AND NOT EXISTS {
        MATCH (a)-[:BELONGS_TO]->(live:Space)
        WHERE live.deletedAt IS NULL
      }
    OPTIONAL MATCH (creator:Person)-[:CREATED]->(a)
    WITH a, head(collect(creator)) AS producer
    RETURN a.id AS id,
           coalesce(a.name, a.title, a.id) AS title,
           coalesce(a.type, a.assetType, 'other') AS kind,
           coalesce(a.url, a.fileUrl) AS fileKey,
           coalesce(a.sourceUrl, a.source) AS sourceUrl,
           coalesce(toString(a.createdAt), toString(a.created_at), '') AS createdAt,
           coalesce(toString(a.updatedAt), toString(a.updated_at), '') AS updatedAt,
           coalesce(
             CASE WHEN trim(coalesce(a.excerpt, '')) = '' THEN NULL ELSE a.excerpt END,
             CASE WHEN trim(coalesce(a.description, '')) = '' THEN NULL ELSE a.description END,
             CASE WHEN trim(coalesce(a.notes, '')) = '' THEN NULL ELSE a.notes END,
             CASE WHEN a.content IS NULL OR a.content STARTS WITH 'data:'
                       OR trim(a.content) = '' THEN NULL
                  ELSE left(a.content, 280) END
           ) AS excerpt,
           CASE WHEN trim(coalesce(a.description, '')) = '' THEN NULL
                ELSE a.description END AS description,
           CASE WHEN coalesce(a.type, a.assetType) IN ['playbook', 'transcript', 'knowledge', 'journey']
                     AND a.content IS NOT NULL
                     AND NOT a.content STARTS WITH 'data:'
                THEN left(a.content, 280) ELSE NULL END AS contentHead,
           CASE WHEN coalesce(a.type, a.assetType) = 'agent'
                THEN coalesce(a.agentType, 'other') ELSE NULL END AS tileAgentType,
           CASE WHEN coalesce(a.type, a.assetType) = 'agent'
                THEN a.agentEndpoints ELSE NULL END AS tileAgentEndpoints,
           a.metadata AS tileMetadata,
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
      WHERE s.deletedAt IS NULL
        AND a.deletedAt IS NULL
        AND ${SPACE_VISIBLE}
    OPTIONAL MATCH (a)-[:BELONGS_TO]->(other:Space)
      WHERE other.id <> s.id
        AND other.deletedAt IS NULL
        AND ${OTHER_SPACE_VISIBLE}
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
           coalesce(
             CASE WHEN trim(coalesce(a.excerpt, '')) = '' THEN NULL ELSE a.excerpt END,
             CASE WHEN trim(coalesce(a.description, '')) = '' THEN NULL ELSE a.description END,
             CASE WHEN trim(coalesce(a.notes, '')) = '' THEN NULL ELSE a.notes END,
             CASE WHEN a.content IS NULL OR a.content STARTS WITH 'data:'
                       OR trim(a.content) = '' THEN NULL
                  ELSE left(a.content, 280) END
           ) AS excerpt,
           CASE WHEN trim(coalesce(a.description, '')) = '' THEN NULL
                ELSE a.description END AS description,
           CASE WHEN coalesce(a.type, a.assetType) IN ['playbook', 'transcript', 'knowledge', 'journey']
                     AND a.content IS NOT NULL
                     AND NOT a.content STARTS WITH 'data:'
                THEN left(a.content, 280) ELSE NULL END AS contentHead,
           CASE WHEN coalesce(a.type, a.assetType) = 'agent'
                THEN coalesce(a.agentType, 'other') ELSE NULL END AS tileAgentType,
           CASE WHEN coalesce(a.type, a.assetType) = 'agent'
                THEN a.agentEndpoints ELSE NULL END AS tileAgentEndpoints,
           a.metadata AS tileMetadata,
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
  /**
   * Update mutable fields on an :Asset node (Phase 3b). All inputs
   * are optional; the SET clause uses the canonical field name and
   * sets `a.updatedAt` to the current ISO timestamp via $now. The
   * caller-side helper coerces missing fields out of $patch so we
   * only mutate what the user actually changed.
   *
   * `[:LAST_EDITED]` edge is created/updated from a `:Person {id:
   * $editorId}` when present so the detail pane's attribution can
   * reflect the change. When `$editorId` is empty/null the edge
   * update is skipped (anonymous edit path).
   */
  UPDATE_ITEM: `
    MATCH (a:Asset {id: $id})
    SET a.name = coalesce($title, a.name),
        a.title = coalesce($title, a.title),
        a.description = coalesce($description, a.description),
        a.content = coalesce($content, a.content),
        a.type = coalesce($type, a.type),
        a.updatedAt = $now
    WITH a
    OPTIONAL MATCH (a)<-[r:LAST_EDITED]-(:Person)
    DELETE r
    WITH a
    OPTIONAL MATCH (p:Person {id: $editorId})
    FOREACH (x IN CASE WHEN p IS NULL THEN [] ELSE [p] END |
      MERGE (x)-[:LAST_EDITED]->(a))
    RETURN a.id AS id
  `,

  /**
   * Add a tag to an :Asset by edge model.
   * MERGE the :Tag node by name, then MERGE the edge. Idempotent —
   * duplicate `addTag('q3')` calls are no-ops.
   */
  ADD_TAG: `
    MATCH (a:Asset {id: $id})
    MERGE (t:Tag {name: $tag})
    MERGE (a)-[:TAGGED_AS]->(t)
    RETURN a.id AS id, t.name AS tag
  `,

  /**
   * Remove a tag from an :Asset. Cleans up the edge; leaves the
   * :Tag node in place (it may still be referenced by other assets).
   */
  REMOVE_TAG: `
    MATCH (a:Asset {id: $id})-[r:TAGGED_AS]->(t:Tag {name: $tag})
    DELETE r
    RETURN a.id AS id, t.name AS tag
  `,

  /**
   * Per-asset activity log (Phase 3c). Returns the most recent
   * `:Commit` rows that reference the given Asset. The match is
   * intentionally schema-tolerant — different producers attach the
   * Asset to a commit via:
   *   - `:Commit.assetId`  (canonical singular)
   *   - `:Commit.targetId` (legacy alias)
   *   - `:Commit.assetIds` (canonical array, for multi-asset commits)
   *   - `[:TOUCHED]->(:Asset)` edge (canonical edge model)
   *
   * The `$since` cutoff and `$limit` mirror the home-feed
   * `HOME_RECENT_EVENTS` query so the projection / row shape stays
   * identical — renderer code that knows how to draw a `RendererEvent`
   * draws an asset-scoped row without any new ceremony.
   */
  ITEM_RECENT_COMMITS: `
    MATCH (a:Asset {id: $id})
      WHERE a.deletedAt IS NULL
        AND ${ASSET_VISIBLE}
    OPTIONAL MATCH (c:Commit)
      WHERE c.assetId = $id
         OR c.targetId = $id
         OR $id IN coalesce(c.assetIds, [])
         OR (c)-[:TOUCHED]->(a)
    WITH a, c
    WHERE c IS NOT NULL
      AND ($since IS NULL OR c.timestamp >= $since)
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

  GET_ITEM: `
    MATCH (a:Asset {id: $id})
      WHERE a.deletedAt IS NULL
        AND ${ASSET_VISIBLE}
    OPTIONAL MATCH (a)-[:BELONGS_TO]->(s:Space)
      WHERE s.deletedAt IS NULL
        AND ${SPACE_VISIBLE}
    OPTIONAL MATCH (creator:Person)-[:CREATED]->(a)
    OPTIONAL MATCH (editor:Person)-[:LAST_EDITED]->(a)
    OPTIONAL MATCH (a)-[:TAGGED_AS]->(t:Tag)
    OPTIONAL MATCH (a)-[:ASSIGNED_TO]->(assignee)
      WHERE assignee:Person OR assignee:Agent
    OPTIONAL MATCH (a)-[:DECOMPOSED_FROM]->(pb:Asset)
    WITH a,
         collect(DISTINCT { id: s.id,
                            name: coalesce(s.name, s.id),
                            color: s.color,
                            iconKey: coalesce(s.iconKey, s.icon) }) AS spacesRaw,
         head(collect(creator)) AS producer,
         head(collect(editor)) AS lastEditor,
         collect(DISTINCT coalesce(t.name, t.id)) AS edgeTags,
         head(collect(assignee)) AS assigneeNode,
         head(collect(pb)) AS sourcePlaybook
    RETURN a.id AS id,
           coalesce(a.name, a.title, a.id) AS title,
           coalesce(a.type, a.assetType, 'other') AS kind,
           coalesce(a.url, a.fileUrl) AS fileKey,
           coalesce(a.sourceUrl, a.source) AS sourceUrl,
           coalesce(toString(a.createdAt), toString(a.created_at), '') AS createdAt,
           coalesce(toString(a.updatedAt), toString(a.updated_at), '') AS updatedAt,
           coalesce(
             CASE WHEN trim(coalesce(a.excerpt, '')) = '' THEN NULL ELSE a.excerpt END,
             CASE WHEN trim(coalesce(a.description, '')) = '' THEN NULL ELSE a.description END,
             CASE WHEN trim(coalesce(a.notes, '')) = '' THEN NULL ELSE a.notes END,
             CASE WHEN a.content IS NULL OR a.content STARTS WITH 'data:'
                       OR trim(a.content) = '' THEN NULL
                  ELSE left(a.content, 280) END
           ) AS excerpt,
           CASE WHEN coalesce(a.type, a.assetType) IN ['playbook', 'transcript', 'knowledge', 'journey']
                     AND a.content IS NOT NULL
                     AND NOT a.content STARTS WITH 'data:'
                THEN left(a.content, 280) ELSE NULL END AS contentHead,
           CASE WHEN coalesce(a.type, a.assetType) = 'agent'
                THEN coalesce(a.agentType, 'other') ELSE NULL END AS tileAgentType,
           CASE WHEN coalesce(a.type, a.assetType) = 'agent'
                THEN a.agentEndpoints ELSE NULL END AS tileAgentEndpoints,
           a.metadata AS tileMetadata,
           coalesce(a.description, '') AS description,
           coalesce(a.content, '') AS content,
           coalesce(a.size, a.fileSize, a.byteCount) AS size,
           coalesce(a.mimeType, a.contentType) AS mimeType,
           coalesce(a.tags, edgeTags, []) AS tags,
           a.metadata AS metadata,
           [x IN spacesRaw WHERE x.id IS NOT NULL] AS otherSpaces,
           CASE WHEN producer IS NULL
                THEN null
                ELSE { kind: head(labels(producer)),
                       name: coalesce(producer.name, producer.title, ''),
                       id: producer.id }
           END AS producedBy,
           CASE WHEN lastEditor IS NULL
                THEN null
                ELSE { kind: head(labels(lastEditor)),
                       name: coalesce(lastEditor.name, lastEditor.title, ''),
                       id: lastEditor.id }
           END AS lastEditedBy,
           coalesce(a.status, 'open') AS ticketStatus,
           a.priority AS ticketPriority,
           coalesce(sourcePlaybook.id, a.playbookId) AS ticketPlaybookId,
           CASE WHEN assigneeNode IS NULL
                THEN null
                ELSE { kind: head(labels(assigneeNode)),
                       name: coalesce(assigneeNode.name, assigneeNode.title, ''),
                       id: assigneeNode.id }
           END AS ticketAssignee,
           a.agentType AS agentType,
           a.agentEndpoints AS agentEndpoints
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
    MATCH (s:Space) WHERE s.deletedAt IS NULL AND ${SPACE_VISIBLE} RETURN 'Space' AS kind, count(s) AS n
    UNION ALL
    MATCH (a:Asset) WHERE a.deletedAt IS NULL AND ${ASSET_VISIBLE} RETURN 'Asset' AS kind, count(a) AS n
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
      WHERE ${ASSET_VISIBLE}
    OPTIONAL MATCH (a)-[:BELONGS_TO]->(s:Space)
      WHERE s.deletedAt IS NULL
    WITH a, head(collect(s)) AS firstSpace
    RETURN a.id AS id,
           coalesce(a.name, a.title, a.id) AS title,
           coalesce(a.type, a.assetType, 'other') AS kind,
           coalesce(a.url, a.fileUrl) AS fileKey,
           coalesce(a.sourceUrl, a.source) AS sourceUrl,
           coalesce(toString(a.createdAt), toString(a.created_at), '') AS createdAt,
           coalesce(toString(a.updatedAt), toString(a.updated_at), '') AS updatedAt,
           coalesce(
             CASE WHEN trim(coalesce(a.excerpt, '')) = '' THEN NULL ELSE a.excerpt END,
             CASE WHEN trim(coalesce(a.description, '')) = '' THEN NULL ELSE a.description END,
             CASE WHEN trim(coalesce(a.notes, '')) = '' THEN NULL ELSE a.notes END,
             CASE WHEN a.content IS NULL OR a.content STARTS WITH 'data:'
                       OR trim(a.content) = '' THEN NULL
                  ELSE left(a.content, 280) END
           ) AS excerpt,
           CASE WHEN trim(coalesce(a.description, '')) = '' THEN NULL
                ELSE a.description END AS description,
           CASE WHEN coalesce(a.type, a.assetType) IN ['playbook', 'transcript', 'knowledge', 'journey']
                     AND a.content IS NOT NULL
                     AND NOT a.content STARTS WITH 'data:'
                THEN left(a.content, 280) ELSE NULL END AS contentHead,
           CASE WHEN coalesce(a.type, a.assetType) = 'agent'
                THEN coalesce(a.agentType, 'other') ELSE NULL END AS tileAgentType,
           CASE WHEN coalesce(a.type, a.assetType) = 'agent'
                THEN a.agentEndpoints ELSE NULL END AS tileAgentEndpoints,
           a.metadata AS tileMetadata,
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
    OPTIONAL MATCH (c)-[:IN_SPACE]->(s:Space)
    WITH c, s
    WHERE s IS NULL OR (s.deletedAt IS NULL AND ${SPACE_VISIBLE})
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
    WITH c, s
    WHERE s IS NULL OR (s.deletedAt IS NULL AND ${SPACE_VISIBLE})
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
   * Agent library search — the account's `:Agent` nodes, filterable by
   * name/description substring. Powers the "From library" picker in the
   * Add-agent tab. Empty query returns the alphabetical head.
   */
  AGENT_LIBRARY_SEARCH: `
    MATCH (g:Agent)
    WHERE $q = ''
       OR toLower(coalesce(g.name, g.title, '')) CONTAINS toLower($q)
       OR toLower(coalesce(g.description, g.summary, '')) CONTAINS toLower($q)
    RETURN g.id AS id,
           coalesce(g.name, g.title, g.id) AS name,
           coalesce(g.description, g.summary, '') AS description,
           coalesce(g.agentType, 'other') AS agentType
    ORDER BY toLower(coalesce(g.name, g.id, '')) ASC
    LIMIT toInteger($limit)
  `,

  /**
   * Ambiguous-failure guard for createBinary: does ANY live asset
   * point at this fileKey? Checked before orphan cleanup deletes the
   * uploaded bytes — a create that "failed" at the HTTP layer may
   * still have landed (Edison read-after-write/timeout ambiguity,
   * observed live 2026-08-06), and deleting then destroys a live
   * asset's bytes.
   */
  FIND_ASSET_BY_FILE_KEY: `
    MATCH (a:Asset)
      WHERE coalesce(a.url, a.fileUrl) = $fileKey
        AND a.deletedAt IS NULL
    RETURN a.id AS id
    LIMIT 1
  `,

  /**
   * Idempotency guard for library adds: an asset already representing
   * this agent in this Space (repeat picks return it instead of
   * creating a twin tile).
   */
  FIND_AGENT_ASSET_IN_SPACE: `
    MATCH (a:Asset {agentRefId: $agentId})-[:BELONGS_TO]->(s:Space {id: $spaceId})
      WHERE a.deletedAt IS NULL
    RETURN a.id AS id
    LIMIT 1
  `,

  /**
   * Existing reachability endpoints on an `:Agent` — merged into the
   * asset's tile-endpoint property so library-added tiles report the
   * agent's FULL reachability, not just what the adder typed.
   */
  GET_AGENT_ENDPOINTS: `
    MATCH (g:Agent {id: $agentId})-[:REACHABLE_VIA]->(e:AgentEndpoint)
    RETURN e.kind AS kind, e.url AS url, coalesce(e.channels, '') AS channels
  `,

  /**
   * Add a LIBRARY agent to a Space: a Space-facing `:Asset` that
   * `[:REPRESENTS]` the EXISTING graph `:Agent` (no new agent node —
   * that's `CREATE_AGENT`'s job for pasted OKF). Name/description are
   * copied from the agent so tiles render without a join.
   */
  CREATE_AGENT_FROM_LIBRARY: `
    MATCH (s:Space {id: $spaceId})
      WHERE s.deletedAt IS NULL
    MATCH (g:Agent {id: $agentId})
    // OKF lives on the ASSET for Lite-created agents (the :Agent node
    // never carries okf/definition) — fall back to any existing
    // source asset that REPRESENTS this agent so library copies keep
    // their definition.
    OPTIONAL MATCH (src:Asset)-[:REPRESENTS]->(g)
      WHERE src.deletedAt IS NULL AND trim(coalesce(src.content, '')) <> ''
    WITH s, g, head(collect(src)) AS srcAsset
    CREATE (a:Asset {
      id: $id,
      type: 'agent',
      name: CASE WHEN trim(coalesce(g.name, g.title, '')) = ''
                 THEN g.id ELSE coalesce(g.name, g.title) END,
      title: CASE WHEN trim(coalesce(g.name, g.title, '')) = ''
                  THEN g.id ELSE coalesce(g.name, g.title) END,
      content: coalesce(g.okf, g.definition, srcAsset.content, ''),
      description: coalesce(g.description, g.summary, ''),
      agentType: coalesce(g.agentType, 'other'),
      agentRefId: g.id,
      agentEndpoints: $agentEndpointsJson,
      metadata: $metadata,
      createdAt: $now,
      updatedAt: $now
    })
    MERGE (a)-[:BELONGS_TO]->(s)
    MERGE (a)-[:REPRESENTS]->(g)
    WITH a, g
    OPTIONAL MATCH (p:Person {id: $creatorId})
    FOREACH (x IN CASE WHEN p IS NULL THEN [] ELSE [p] END |
      MERGE (x)-[:CREATED]->(a))
    RETURN a.id AS id, g.id AS agentId
  `,

  /**
   * Permission summary for Card 4. v1 only knows `visibleSpaceCount`;
   * `totalSpaceCount` (Spaces in account the user can't see) is left
   * unset until Edison D6 returns a way to count them.
   */
  HOME_PERMISSION_SUMMARY: `
    MATCH (s:Space)
      WHERE s.deletedAt IS NULL
        AND ${SPACE_VISIBLE}
    WITH count(s) AS visible
    RETURN visible AS visibleSpaceCount
  `,

  // ─── Mutations (Phase 3a) ────────────────────────────────────────────
  //
  // Server-side uniqueness on `:Space.name` is enforced via the
  // pre-CREATE existence check so we surface `SPACES_DUPLICATE_NAME`
  // rather than relying on a (currently absent) `CREATE CONSTRAINT`.
  // Soft-delete sets `s.deletedAt`. Every read path that touches
  // `:Space` filters with `WHERE s.deletedAt IS NULL` so the soft-
  // deleted Space disappears from listings, item-in-Space queries,
  // entity counts, and the multi-Space chip projection. To surface
  // deleted Spaces (e.g. for an "Undo" toast or a future "Trash"
  // view) callers will need a parallel `LIST_SPACES_INCLUDING_DELETED`
  // query that omits the WHERE -- not added in v1 since the toast's
  // Undo flow only needs the id, not a re-list.

  /**
   * CREATE_SPACE -- atomic create. Fails if a non-deleted Space with
   * the same name already exists in the account. The Cypher `WHERE NOT
   * EXISTS` predicate is server-evaluated so the check + create are
   * one round-trip; no race window between the two.
   *
   * Returns the new Space row projected the same way LIST_SPACES does.
   * Empty result set means the name collided -- callers map to
   * `SPACES_DUPLICATE_NAME`.
   */
  CREATE_SPACE: `
    OPTIONAL MATCH (existing:Space)
      WHERE toLower(coalesce(existing.name, '')) = toLower($name)
        AND existing.deletedAt IS NULL
    WITH existing
    WHERE existing IS NULL
    CREATE (s:Space {
      id: $id,
      name: $name,
      description: $description,
      color: $color,
      iconKey: $iconKey,
      createdAt: $now,
      updatedAt: $now
    })
    RETURN s.id AS id,
           coalesce(s.name, s.id) AS name,
           coalesce(s.description, '') AS description,
           coalesce(s.color, '') AS color,
           coalesce(s.iconKey, '') AS iconKey,
           0 AS itemCount,
           toString(s.createdAt) AS createdAt,
           toString(s.updatedAt) AS updatedAt
  `,

  /**
   * RENAME_SPACE -- updates `s.name` and `s.updatedAt`. Two predicates
   * combine to avoid race conditions:
   *   - The target Space must exist and be non-deleted.
   *   - No OTHER non-deleted Space already has the new name.
   * Empty result set means either the target is missing (caller maps
   * to `SPACES_NOT_FOUND`) or the name collides (mapped to
   * `SPACES_DUPLICATE_NAME`). The two are distinguished by a follow-up
   * existence probe via SPACE_EXISTS_BY_ID.
   */
  RENAME_SPACE: `
    MATCH (s:Space {id: $id})
      WHERE s.deletedAt IS NULL
        AND ${SPACE_VISIBLE}
    OPTIONAL MATCH (other:Space)
      WHERE other.id <> $id
        AND toLower(coalesce(other.name, '')) = toLower($name)
        AND other.deletedAt IS NULL
    WITH s, other
    WHERE other IS NULL
    SET s.name = $name,
        s.updatedAt = $now
    RETURN s.id AS id,
           coalesce(s.name, s.id) AS name,
           coalesce(s.description, '') AS description,
           coalesce(s.color, '') AS color,
           coalesce(s.iconKey, '') AS iconKey,
           toString(s.createdAt) AS createdAt,
           toString(s.updatedAt) AS updatedAt
  `,

  /**
   * UPDATE_SPACE -- patch the non-identity fields of a Space
   * (description / color / iconKey). Each clause is gated on a
   * boolean flag so the caller can pass only the fields it wants
   * to write; absent fields are left untouched. Name is intentionally
   * not in this Cypher -- renames need the uniqueness probe handled
   * by RENAME_SPACE.
   *
   * Empty result set means the Space doesn't exist (or was
   * soft-deleted) -- caller maps to `SPACES_NOT_FOUND`.
   */
  UPDATE_SPACE: `
    MATCH (s:Space {id: $id})
      WHERE s.deletedAt IS NULL
        AND ${SPACE_VISIBLE}
    SET s.updatedAt = $now
    FOREACH (_ IN CASE WHEN $writeDescription THEN [1] ELSE [] END |
      SET s.description = $description
    )
    FOREACH (_ IN CASE WHEN $writeColor THEN [1] ELSE [] END |
      SET s.color = $color
    )
    FOREACH (_ IN CASE WHEN $writeIconKey THEN [1] ELSE [] END |
      SET s.iconKey = $iconKey
    )
    FOREACH (_ IN CASE WHEN $writeVisibility THEN [1] ELSE [] END |
      SET s.visibility = $visibility
    )
    FOREACH (_ IN CASE WHEN $writeVisibility AND $visibility = 'restricted' AND $viewerId <> '' THEN [1] ELSE [] END |
      MERGE (viewer:Person {id: $viewerId})
      MERGE (viewer)-[:HAS_ACCESS]->(s)
    )
    RETURN s.id AS id,
           coalesce(s.name, s.id) AS name,
           coalesce(s.description, '') AS description,
           coalesce(s.color, '') AS color,
           coalesce(s.iconKey, '') AS iconKey,
           coalesce(s.visibility, 'open') AS visibility,
           toString(s.createdAt) AS createdAt,
           toString(s.updatedAt) AS updatedAt
  `,

  /**
   * SPACE_EXISTS_BY_ID -- 1-row existence probe used after RENAME or
   * DELETE returns 0 rows, to distinguish NOT_FOUND from
   * DUPLICATE_NAME / DELETE_NON_EMPTY in the SDK layer. Cheap and
   * deterministic.
   */
  SPACE_EXISTS_BY_ID: `
    MATCH (s:Space {id: $id})
    RETURN count(s) AS count
  `,

  /**
   * SPACE_ITEM_COUNT -- pre-flight for hard delete. Counts items
   * connected via `:BELONGS_TO`. Returns 0 for empty Spaces and for
   * non-existent ids (caller handles non-existence separately).
   */
  /**
   * Learning Center signals (2026-08-07): the counts that auto-detect
   * hands-on missions. Same visibility rules as every other read —
   * detection must never reveal more than the viewer can see.
   */
  LEARN_KIND_COUNTS: `
    MATCH (a:Asset)
    WHERE a.deletedAt IS NULL
      AND ${ASSET_VISIBLE}
    RETURN coalesce(a.type, 'other') AS learnKind, count(a) AS learnCount
  `,

  LEARN_SPACE_COUNT: `
    MATCH (s:Space)
    WHERE s.deletedAt IS NULL
      AND ${SPACE_VISIBLE}
    RETURN count(s) AS learnSpaces
  `,

  LEARN_OTHER_MEMBERS: `
    MATCH (member)-[r:HAS_ACCESS]->(s:Space)
    WHERE s.deletedAt IS NULL
      AND member.id <> $viewerId
      AND (r.expiresUnixMs IS NULL OR r.expiresUnixMs > $nowMs)
    RETURN count(DISTINCT member) AS learnOtherMembers
  `,

  SPACE_ITEM_COUNT: `
    MATCH (s:Space {id: $id})
    OPTIONAL MATCH (a:Asset)-[:BELONGS_TO]->(s)
    RETURN count(a) AS count
  `,

  /**
   * SOFT_DELETE_SPACE -- sets `deletedAt` so the Space stops appearing
   * in listSpaces(). Items keep their `[:BELONGS_TO]` edges and their
   * GSX bytes; nothing is destroyed. Because "uncategorized" means
   * "in no LIVE Space", an item whose every Space is deleted surfaces
   * under Uncategorized rather than becoming unreachable (it used to
   * vanish from listings, search AND direct get — verified 2026-08-06).
   * Fully reversible via UNDELETE_SPACE, which pulls the items back
   * into the restored Space automatically.
   */
  SOFT_DELETE_SPACE: `
    MATCH (s:Space {id: $id})
      WHERE s.deletedAt IS NULL
        AND ${SPACE_VISIBLE}
    SET s.deletedAt = $now,
        s.updatedAt = $now
    RETURN s.id AS id
  `,

  /**
   * HARD_DELETE_SPACE -- removes the node entirely. Caller MUST have
   * verified item count == 0 first; otherwise data orphans (items
   * pointing at a now-missing Space). The Cypher itself uses DELETE
   * (no DETACH) so a stale [:BELONGS_TO] edge will surface as a Neo4j
   * constraint error -- belt-and-suspenders.
   */
  HARD_DELETE_SPACE: `
    MATCH (s:Space {id: $id})
      WHERE ${SPACE_VISIBLE}
    DELETE s
  `,

  /**
   * UNDELETE_SPACE -- clears `deletedAt` so the Space reappears in
   * listSpaces(). Returns the restored row in the LIST_SPACES shape.
   * Empty result set means the Space wasn't soft-deleted (or doesn't
   * exist) -- caller maps to `SPACES_NOT_FOUND`.
   */
  UNDELETE_SPACE: `
    MATCH (s:Space {id: $id})
      WHERE s.deletedAt IS NOT NULL
        AND ${SPACE_VISIBLE}
    OPTIONAL MATCH (a:Asset)-[:BELONGS_TO]->(s)
    WITH s, count(a) AS itemCount
    SET s.deletedAt = null,
        s.updatedAt = $now
    RETURN s.id AS id,
           coalesce(s.name, s.id) AS name,
           coalesce(s.description, '') AS description,
           coalesce(s.color, '') AS color,
           coalesce(s.iconKey, '') AS iconKey,
           coalesce(s.kind, 'user') AS kind,
           itemCount AS itemCount,
           toString(s.createdAt) AS createdAt,
           toString(s.updatedAt) AS updatedAt
  `,

  // ─── Shared spaces: playbooks + tickets (Phase 4) ──────────────────────

  /**
   * Flip a Space's `kind` between 'user' (default) and 'shared'. The
   * field defaults to 'user' on every existing row via the
   * `coalesce(s.kind, 'user')` projection above, so this mutation is
   * additive — no migration needed for spaces created before the
   * shared-space concept existed.
   */
  SET_SPACE_KIND: `
    MATCH (s:Space {id: $id})
      WHERE s.deletedAt IS NULL
    SET s.kind = $kind,
        s.updatedAt = $now
    RETURN s.id AS id, coalesce(s.kind, 'user') AS kind
  `,

  /**
   * Fetch the current playbook for a shared space. Resolves via the
   * canonical `[:CURRENT_PLAYBOOK]` edge with a legacy fallback to
   * `s.currentPlaybookId` for spaces that haven't migrated yet.
   *
   * Returns 0 rows when the Space has no playbook (the renderer treats
   * that as "shared space exists but is empty — show the seed CTA").
   */
  GET_CURRENT_PLAYBOOK: `
    MATCH (s:Space {id: $spaceId})
      WHERE s.deletedAt IS NULL
        AND ${SPACE_VISIBLE}
    OPTIONAL MATCH (s)-[:CURRENT_PLAYBOOK]->(canonical:Asset)
    OPTIONAL MATCH (legacy:Asset {id: s.currentPlaybookId})
    WITH coalesce(canonical, legacy) AS pb
    WHERE pb IS NOT NULL
    RETURN pb.id AS playbookId
    LIMIT 1
  `,

  /**
   * Promote an :Asset to the Space's current playbook. Drops any
   * existing `[:CURRENT_PLAYBOOK]` edge first (a Space has at most one
   * current playbook), then MERGEs the new one and stamps
   * `a.type = 'playbook'` so listings render it with the playbook chrome.
   *
   * Returns the count of tickets already attached to the new playbook
   * so the renderer can decide whether to fetch the ticket list.
   */
  SET_CURRENT_PLAYBOOK: `
    MATCH (s:Space {id: $spaceId})
      WHERE s.deletedAt IS NULL
    MATCH (pb:Asset {id: $playbookId})
    OPTIONAL MATCH (s)-[old:CURRENT_PLAYBOOK]->(:Asset)
    DELETE old
    WITH s, pb
    MERGE (s)-[:CURRENT_PLAYBOOK]->(pb)
    SET pb.type = 'playbook',
        pb.updatedAt = $now
    WITH pb
    OPTIONAL MATCH (t:Asset)-[:DECOMPOSED_FROM]->(pb)
    RETURN pb.id AS playbookId, count(t) AS ticketCount
  `,

  /**
   * List tickets in a Space. Tickets are `:Asset {type: 'ticket'}` with
   * a `[:BELONGS_TO]` edge to the Space. Optional `$status` filter
   * passes through as a parameterised WHERE — null disables filtering.
   *
   * Order: open tickets first (so users see actionable work), then
   * status alphabetical, then most-recently-updated first within each
   * status. Pagination via SKIP/LIMIT matches LIST_ITEMS_*.
   */
  LIST_TICKETS_IN_SPACE: `
    MATCH (a:Asset)-[:BELONGS_TO]->(s:Space {id: $spaceId})
      WHERE s.deletedAt IS NULL
        AND a.deletedAt IS NULL
        AND coalesce(a.type, a.assetType) = 'ticket'
        AND ($status IS NULL OR coalesce(a.status, 'open') = $status)
        AND ${SPACE_VISIBLE}
    OPTIONAL MATCH (a)-[:ASSIGNED_TO]->(assignee)
      WHERE assignee:Person OR assignee:Agent
    OPTIONAL MATCH (a)-[:DECOMPOSED_FROM]->(pb:Asset)
    WITH a,
         head(collect(assignee)) AS assigneeNode,
         head(collect(pb)) AS sourcePlaybook
    RETURN a.id AS id,
           coalesce(a.name, a.title, a.id) AS title,
           coalesce(
             CASE WHEN trim(coalesce(a.excerpt, '')) = '' THEN NULL ELSE a.excerpt END,
             CASE WHEN trim(coalesce(a.description, '')) = '' THEN NULL ELSE a.description END,
             CASE WHEN trim(coalesce(a.notes, '')) = '' THEN NULL ELSE a.notes END,
             CASE WHEN a.content IS NULL OR a.content STARTS WITH 'data:'
                       OR trim(a.content) = '' THEN NULL
                  ELSE left(a.content, 280) END
           ) AS excerpt,
           CASE WHEN trim(coalesce(a.description, '')) = '' THEN NULL
                ELSE a.description END AS description,
           CASE WHEN coalesce(a.type, a.assetType) IN ['playbook', 'transcript', 'knowledge', 'journey']
                     AND a.content IS NOT NULL
                     AND NOT a.content STARTS WITH 'data:'
                THEN left(a.content, 280) ELSE NULL END AS contentHead,
           CASE WHEN coalesce(a.type, a.assetType) = 'agent'
                THEN coalesce(a.agentType, 'other') ELSE NULL END AS tileAgentType,
           CASE WHEN coalesce(a.type, a.assetType) = 'agent'
                THEN a.agentEndpoints ELSE NULL END AS tileAgentEndpoints,
           a.metadata AS tileMetadata,
           coalesce(toString(a.createdAt), toString(a.created_at), '') AS createdAt,
           coalesce(toString(a.updatedAt), toString(a.updated_at), '') AS updatedAt,
           coalesce(a.status, 'open') AS status,
           a.priority AS priority,
           coalesce(sourcePlaybook.id, a.playbookId) AS playbookId,
           CASE WHEN assigneeNode IS NULL
                THEN null
                ELSE { kind: head(labels(assigneeNode)),
                       name: coalesce(assigneeNode.name, assigneeNode.title, ''),
                       id: assigneeNode.id }
           END AS assignee
    ORDER BY CASE coalesce(a.status, 'open')
                  WHEN 'open' THEN 0
                  WHEN 'in_progress' THEN 1
                  WHEN 'blocked' THEN 2
                  WHEN 'done' THEN 3
                  ELSE 4 END,
             coalesce(toString(a.updatedAt), toString(a.updated_at), '') DESC
    SKIP toInteger($offset)
    LIMIT toInteger($limit)
  `,

  /**
   * Create a new ticket asset and attach it to a Space. Optionally
   * MERGEs a `[:DECOMPOSED_FROM]` edge to a source playbook and an
   * `[:ASSIGNED_TO]` edge to a Person/Agent.
   *
   * Uniqueness: ids are generated client-side from a random suffix +
   * timestamp; collisions are vanishingly rare and the MERGE on
   * `[:BELONGS_TO]` is idempotent so a retried call doesn't double-link.
   */
  CREATE_TICKET: `
    MATCH (s:Space {id: $spaceId})
      WHERE s.deletedAt IS NULL
    CREATE (a:Asset {
      id: $id,
      type: 'ticket',
      name: $title,
      title: $title,
      description: $description,
      status: $status,
      priority: $priority,
      playbookId: $playbookId,
      createdAt: $now,
      updatedAt: $now
    })
    MERGE (a)-[:BELONGS_TO]->(s)
    WITH a
    OPTIONAL MATCH (pb:Asset {id: $playbookId})
    FOREACH (x IN CASE WHEN pb IS NULL THEN [] ELSE [pb] END |
      MERGE (a)-[:DECOMPOSED_FROM]->(x))
    WITH a
    OPTIONAL MATCH (assignee {id: $assigneeId})
      WHERE assignee:Person OR assignee:Agent
    FOREACH (x IN CASE WHEN assignee IS NULL THEN [] ELSE [assignee] END |
      MERGE (a)-[:ASSIGNED_TO]->(x))
    RETURN a.id AS id
  `,

  /**
   * Update a ticket. Mirrors UPDATE_ITEM but adds status/priority/
   * assignee handling. Status is validated client-side against the
   * TicketStatus enum so a typo never lands in the graph.
   *
   * Assignee re-assignment: drops any existing `[:ASSIGNED_TO]` edge
   * first so we never accumulate stale assignments. When
   * `$assigneeId` is null/empty, the ticket ends up unassigned.
   */
  UPDATE_TICKET: `
    MATCH (a:Asset {id: $id})
      WHERE coalesce(a.type, a.assetType) = 'ticket'
        AND ${ASSET_VISIBLE}
    SET a.name = coalesce($title, a.name),
        a.title = coalesce($title, a.title),
        a.description = coalesce($description, a.description),
        a.status = coalesce($status, a.status),
        a.priority = coalesce($priority, a.priority),
        a.updatedAt = $now
    WITH a
    OPTIONAL MATCH (a)-[r:ASSIGNED_TO]->()
    DELETE r
    WITH a
    OPTIONAL MATCH (assignee {id: $assigneeId})
      WHERE assignee:Person OR assignee:Agent
    FOREACH (x IN CASE WHEN assignee IS NULL THEN [] ELSE [assignee] END |
      MERGE (a)-[:ASSIGNED_TO]->(x))
    RETURN a.id AS id
  `,

  // ─── Identity + sharing (Phase 4 v2) ────────────────────────────────────

  /**
   * Upsert a :Person by id. Idempotent: a re-call with the same id is
   * a no-op (just refreshes the name/email defensively). Powers the
   * boot-time "who am I" probe in the renderer — the current account
   * is mapped to a stable :Person row by email (lowercased).
   */
  MERGE_PERSON: `
    MERGE (p:Person {id: $id})
      ON CREATE SET p.name = $name,
                    p.email = $email,
                    p.createdAt = $now,
                    p.updatedAt = $now
      ON MATCH SET p.name = coalesce(p.name, $name),
                   p.email = coalesce(p.email, $email),
                   p.updatedAt = $now
    RETURN p.id AS id,
           coalesce(p.name, '') AS name,
           coalesce(p.email, '') AS email
  `,

  /**
   * List the members of a Space — every :Person and :Agent reachable
   * via `[:HAS_ACCESS]->(s)`. The producer side of HAS_ACCESS is
   * either canonical edges or, when a Space pre-dates the sharing
   * concept, an empty set.
   */
  LIST_SPACE_MEMBERS: `
    MATCH (s:Space {id: $spaceId})
      WHERE s.deletedAt IS NULL
        AND ${SPACE_VISIBLE}
    OPTIONAL MATCH (member)-[r:HAS_ACCESS]->(s)
      WHERE member:Person OR member:Agent
    WITH member, r
    WHERE member IS NOT NULL
    // ADR-052 — deliberately NOT filtered on expiry. A lapsed member
    // stays listed so the owner can see WHY someone lost sight of the
    // Space and renew them. Silently dropping the row turns an expired
    // grant into an unexplained disappearance.
    RETURN head(labels(member)) AS kind,
           member.id AS id,
           coalesce(member.name, member.title, '') AS name,
           r.expiresUnixMs AS expiresUnixMs
    ORDER BY kind ASC, toLower(coalesce(member.name, member.id, '')) ASC
  `,

  /**
   * Add a :Person or :Agent as a member of a Space. MERGE makes the
   * call idempotent — adding the same member twice is a no-op.
   * Returns the (kind, id, name) tuple so the renderer can patch its
   * cached list without a refetch.
   */
  ADD_SPACE_MEMBER: `
    MATCH (s:Space {id: $spaceId})
      WHERE s.deletedAt IS NULL
        AND ${SPACE_VISIBLE}
    MATCH (member {id: $memberId})
      WHERE member:Person OR member:Agent
    MERGE (member)-[r:HAS_ACCESS]->(s)
    // ADR-052 — time-limited access. $writeExpiry distinguishes "no
    // expiry was requested" (leave whatever is there) from "make this
    // permanent" ($expiresUnixMs null), so re-adding a member without
    // specifying an expiry never silently extends or revokes an
    // existing grant.
    FOREACH (_ IN CASE WHEN $writeExpiry THEN [1] ELSE [] END |
      SET r.expiresUnixMs = $expiresUnixMs
    )
    SET r.grantedUnixMs = coalesce(r.grantedUnixMs, $nowMs)
    RETURN head(labels(member)) AS kind,
           member.id AS id,
           coalesce(member.name, member.title, '') AS name,
           r.expiresUnixMs AS expiresUnixMs
  `,

  /**
   * Member library — the account's `:Person` and `:Agent` nodes,
   * searchable by name/email/id substring. Powers the add-member
   * picker (people sort first). Empty query returns the head.
   */
  MEMBER_LIBRARY_SEARCH: `
    MATCH (member)
    WHERE (member:Person OR member:Agent)
      AND ($q = ''
           OR toLower(coalesce(member.name, member.title, '')) CONTAINS toLower($q)
           OR toLower(coalesce(member.email, '')) CONTAINS toLower($q)
           OR toLower(member.id) CONTAINS toLower($q))
    RETURN head(labels(member)) AS kind,
           member.id AS id,
           coalesce(member.name, member.title, member.id) AS name,
           coalesce(member.email, '') AS email
    ORDER BY CASE WHEN member:Person THEN 0 ELSE 1 END,
             toLower(coalesce(member.name, member.id, '')) ASC
    LIMIT toInteger($limit)
  `,

  /**
   * Remove a member from a Space. Returns the count of HAS_ACCESS
   * edges actually deleted (2026-08-08 release review): this is an
   * access REVOKE, so the result must be verifiable — the old
   * `RETURN $memberId` echoed the parameter whether or not anything
   * was deleted. The aggregation yields exactly one row even when the
   * MATCH found nothing (deleted = 0), so an EMPTY result can only
   * mean the query itself failed (the Edison endpoint surfaces Cypher
   * errors as empty 200s). The TS wrapper throws on both.
   */
  REMOVE_SPACE_MEMBER: `
    MATCH (s:Space {id: $spaceId})
      WHERE ${SPACE_VISIBLE}
    MATCH (member {id: $memberId})-[r:HAS_ACCESS]->(s)
      WHERE member:Person OR member:Agent
    DELETE r
    RETURN count(r) AS deleted
  `,

  /**
   * GSX migration sweep (ADR-050): page through assets still carrying
   * the v1 inline-base64 stub (`a.content` is a `data:` URL). The
   * sweep uploads each payload to GSX and then converts the node via
   * CONVERT_INLINE_ASSET_TO_FILE, so a migrated asset stops matching
   * this predicate — the query is its own progress cursor.
   */
  LIST_INLINE_BINARY_ASSETS: `
    MATCH (a:Asset)
    WHERE a.deletedAt IS NULL
      AND a.content STARTS WITH 'data:'
    RETURN a.id AS id,
           a.content AS content,
           coalesce(a.name, a.title, '') AS title,
           coalesce(a.mimeType, a.contentType, '') AS mimeType
    ORDER BY a.id
    LIMIT $limit
  `,

  /**
   * Flip one inline-stub asset to its GSX-backed form: set the file
   * key + true byte size, clear the inline blob (SET x = null removes
   * the property in Cypher). Idempotent per asset — after this runs
   * the node no longer matches LIST_INLINE_BINARY_ASSETS.
   */
  CONVERT_INLINE_ASSET_TO_FILE: `
    MATCH (a:Asset {id: $id})
    WHERE a.deletedAt IS NULL
    SET a.url = $fileKey,
        a.size = $size,
        a.content = null,
        a.updatedAt = $now
    RETURN a.id AS id
  `,

  // ─── Asset CRUD (Sprint 1) ───────────────────────────────────────────────

  /**
   * Create a new :Asset and link it to the target Space via
   * `[:BELONGS_TO]`. Optional `[:CREATED]<-(:Person)` edge when an
   * editor id is supplied so attribution lights up immediately.
   *
   * The `spaceId` is required and validated client-side; passing an
   * empty/sentinel value would orphan the asset, which is allowed at
   * the graph level (Uncategorized) but the caller should explicitly
   * use the dedicated CREATE_ASSET_UNCATEGORIZED path for that.
   */
  CREATE_ASSET: `
    MATCH (s:Space {id: $spaceId})
      WHERE s.deletedAt IS NULL
    CREATE (a:Asset {
      id: $id,
      type: $kind,
      name: $title,
      title: $title,
      content: $content,
      description: $description,
      url: $fileKey,
      sourceUrl: $sourceUrl,
      mimeType: $mimeType,
      size: $size,
      metadata: $metadata,
      createdAt: $now,
      updatedAt: $now
    })
    MERGE (a)-[:BELONGS_TO]->(s)
    WITH a, s
    OPTIONAL MATCH (p:Person {id: $creatorId})
    FOREACH (x IN CASE WHEN p IS NULL THEN [] ELSE [p] END |
      MERGE (x)-[:CREATED]->(a))
    // Activity: one Commit per create, so the asset's ACTIVITY panel
    // and the Home timeline attribute the add to a real person instead
    // of "Someone" (2026-08-07). Written only when the author is known.
    FOREACH (x IN CASE WHEN $commitAuthor IS NULL THEN [] ELSE [1] END |
      MERGE (c:Commit {hash: $commitHash})
      ON CREATE SET c.author = $commitAuthor,
                    c.message = 'item:added',
                    c.timestamp = $commitTimestampMs,
                    c.assetId = a.id,
                    c.spaceId = s.id
      MERGE (c)-[:IN_SPACE]->(s)
      MERGE (c)-[:TOUCHED]->(a))
    RETURN a.id AS id
  `,

  /**
   * Same as CREATE_ASSET but for the Uncategorized intake zone:
   * creates the asset without a `[:BELONGS_TO]` edge. Used when the
   * user adds an asset from outside any space.
   */
  CREATE_ASSET_UNCATEGORIZED: `
    CREATE (a:Asset {
      id: $id,
      type: $kind,
      name: $title,
      title: $title,
      content: $content,
      description: $description,
      url: $fileKey,
      sourceUrl: $sourceUrl,
      mimeType: $mimeType,
      size: $size,
      metadata: $metadata,
      createdAt: $now,
      updatedAt: $now
    })
    WITH a
    OPTIONAL MATCH (p:Person {id: $creatorId})
    FOREACH (x IN CASE WHEN p IS NULL THEN [] ELSE [p] END |
      MERGE (x)-[:CREATED]->(a))
    FOREACH (x IN CASE WHEN $commitAuthor IS NULL THEN [] ELSE [1] END |
      MERGE (c:Commit {hash: $commitHash})
      ON CREATE SET c.author = $commitAuthor,
                    c.message = 'item:added',
                    c.timestamp = $commitTimestampMs,
                    c.assetId = a.id
      MERGE (c)-[:TOUCHED]->(a))
    RETURN a.id AS id
  `,

  /**
   * Create an agent in a Space. Writes THREE nodes in one transaction:
   *   1. a Space-facing `:Asset {type:'agent'}` (so it lists/renders/
   *      soft-deletes like any asset; OKF text lives in `a.content`),
   *   2. a parent `:Agent` node (queryable as an agent),
   *   3. a typed child `:AgentType:<TypeLabel>` node,
   * linked `(:Asset)-[:REPRESENTS]->(:Agent)-[:HAS_TYPE]->(:AgentType)`.
   *
   * `__TYPE_LABEL__` is a placeholder the caller (`createAgent`) replaces
   * with a STRICTLY-SANITIZED PascalCase label (see
   * `sanitizeAgentTypeLabel`) — Cypher can't parameterize labels, and we
   * deliberately don't depend on APOC (its availability isn't
   * guaranteed; see the discovery fallback). The raw `agentType` is also
   * stored as a property on all three nodes for property-based queries.
   */
  CREATE_AGENT: `
    MATCH (s:Space {id: $spaceId})
      WHERE s.deletedAt IS NULL
    CREATE (a:Asset {
      id: $id,
      type: 'agent',
      name: $name,
      title: $name,
      content: $okf,
      description: $description,
      sourceUrl: $sourceUrl,
      agentType: $agentType,
      agentEndpoints: $agentEndpointsJson,
      metadata: $metadata,
      createdAt: $now,
      updatedAt: $now
    })
    MERGE (a)-[:BELONGS_TO]->(s)
    CREATE (ag:Agent {
      id: $agentId,
      name: $name,
      description: $description,
      agentType: $agentType,
      createdAt: $now,
      updatedAt: $now
    })
    CREATE (a)-[:REPRESENTS]->(ag)
    CREATE (t:AgentType:__TYPE_LABEL__ {
      id: $typeId,
      agentType: $agentType,
      createdAt: $now
    })
    CREATE (ag)-[:HAS_TYPE]->(t)
    WITH a
    OPTIONAL MATCH (p:Person {id: $creatorId})
    FOREACH (x IN CASE WHEN p IS NULL THEN [] ELSE [p] END |
      MERGE (x)-[:CREATED]->(a))
    RETURN a.id AS id
  `,

  /**
   * Attach one reachability endpoint (MCP / API / Skill) to an agent as
   * a child node `(:Agent)-[:REACHABLE_VIA]->(:AgentEndpoint:<Kind>)`.
   * Run once per endpoint (variable count + dynamic per-kind label, which
   * Cypher can't parameterize). `__KIND_LABEL__` is a strictly-sanitized
   * PascalCase label (`Mcp`/`Api`/`Skill`); `kind`/`url`/`channels` are
   * parameters. `channels` is a comma-joined string.
   */
  CREATE_AGENT_ENDPOINT_MERGED: `
    MATCH (ag:Agent {id: $agentId})
    MERGE (ag)-[:REACHABLE_VIA]->(e:AgentEndpoint:__KIND_LABEL__ {url: $url})
    ON CREATE SET e.id = $endpointId,
                  e.kind = $kind,
                  e.channels = $channels,
                  e.createdAt = $now
    RETURN e.id AS id
  `,

  CREATE_AGENT_ENDPOINT: `
    MATCH (ag:Agent {id: $agentId})
    CREATE (ag)-[:REACHABLE_VIA]->(e:AgentEndpoint:__KIND_LABEL__ {
      id: $endpointId,
      kind: $kind,
      url: $url,
      channels: $channels,
      createdAt: $now
    })
    RETURN e.id AS id
  `,

  /**
   * Soft delete: mark the asset with `deletedAt` so every read path's
   * `WHERE a.deletedAt IS NULL` filter hides it. Reversible via
   * RESTORE_ASSET. Mirrors the Space soft-delete pattern.
   */
  SOFT_DELETE_ASSET: `
    MATCH (a:Asset {id: $id})
      WHERE a.deletedAt IS NULL
    SET a.deletedAt = $now,
        a.updatedAt = $now
    RETURN a.id AS id
  `,

  /**
   * Restore a soft-deleted asset. 0 rows means the asset wasn't
   * soft-deleted (or doesn't exist) — caller maps to SPACES_NOT_FOUND.
   */
  RESTORE_ASSET: `
    MATCH (a:Asset {id: $id})
      WHERE a.deletedAt IS NOT NULL
    SET a.deletedAt = null,
        a.updatedAt = $now
    RETURN a.id AS id
  `,

  /**
   * Hard delete: drop the node + all incident edges. Use sparingly —
   * irreversible. Tags / Persons / Spaces survive (just the
   * relationships and the asset row itself are removed).
   */
  HARD_DELETE_ASSET: `
    MATCH (a:Asset {id: $id})
    DETACH DELETE a
  `,

  // ─── Sprint 3: move + copy + search ──────────────────────────────────

  /**
   * Move an asset to a different Space. Drops the [:BELONGS_TO] edge
   * to the source space (if present) and MERGEs a new one to the
   * target. When `$fromSpaceId` is null/empty, the asset was
   * uncategorized and only the new edge is created.
   *
   * Asset stays in any OTHER spaces it was already in — this is a
   * primary-space move, not a "remove from everywhere".
   */
  MOVE_ASSET_TO_SPACE: `
    MATCH (a:Asset {id: $id})
      WHERE a.deletedAt IS NULL
    MATCH (target:Space {id: $toSpaceId})
      WHERE target.deletedAt IS NULL
    OPTIONAL MATCH (a)-[old:BELONGS_TO]->(source:Space {id: $fromSpaceId})
      WHERE source.deletedAt IS NULL
    DELETE old
    WITH a, target
    MERGE (a)-[:BELONGS_TO]->(target)
    SET a.updatedAt = $now
    RETURN a.id AS id
  `,

  /**
   * Add an asset to ANOTHER space (multi-space membership). MERGE
   * makes it idempotent — adding to a space the asset already lives
   * in is a no-op.
   */
  ADD_ASSET_TO_SPACE: `
    MATCH (a:Asset {id: $id})
      WHERE a.deletedAt IS NULL
    MATCH (target:Space {id: $toSpaceId})
      WHERE target.deletedAt IS NULL
    MERGE (a)-[:BELONGS_TO]->(target)
    SET a.updatedAt = $now
    RETURN a.id AS id
  `,

  /**
   * Remove an asset from a specific space (drop one [:BELONGS_TO]
   * edge). Does NOT soft-delete the asset — the asset may still live
   * in other spaces. Use `SOFT_DELETE_ASSET` to remove from
   * everywhere.
   */
  REMOVE_ASSET_FROM_SPACE: `
    MATCH (a:Asset {id: $id})-[r:BELONGS_TO]->(s:Space {id: $spaceId})
      WHERE a.deletedAt IS NULL
    DELETE r
    SET a.updatedAt = $now
    RETURN a.id AS id
  `,

  /**
   * Replace the entire metadata JSON on an :Asset. Pass `$metadata`
   * as a JSON-stringified value (or empty string to clear).
   */
  SET_METADATA: `
    MATCH (a:Asset {id: $id})
      WHERE a.deletedAt IS NULL
    SET a.metadata = $metadata,
        a.updatedAt = $now
    RETURN a.id AS id
  `,

  /**
   * Search assets in a Space by title / description / content match.
   * Case-insensitive substring search via `CONTAINS toLower(...)`.
   * Scope null/empty searches across every non-soft-deleted asset
   * the user can see; non-empty `spaceId` restricts to one space.
   *
   * Row shape matches LIST_ITEMS_IN_SPACE so the renderer can reuse
   * the existing item-row builder.
   */
  SEARCH_ITEMS: `
    MATCH (a:Asset)
      WHERE a.deletedAt IS NULL
        AND (
          toLower(coalesce(a.name, a.title, '')) CONTAINS toLower($query)
          OR toLower(coalesce(a.description, '')) CONTAINS toLower($query)
          OR toLower(coalesce(a.excerpt, '')) CONTAINS toLower($query)
        )
        AND ($spaceId IS NULL
             OR EXISTS { MATCH (a)-[:BELONGS_TO]->(:Space {id: $spaceId}) })
        AND ${ASSET_VISIBLE}
    OPTIONAL MATCH (a)-[:BELONGS_TO]->(s:Space)
      WHERE s.deletedAt IS NULL
        AND ${SPACE_VISIBLE}
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
           coalesce(
             CASE WHEN trim(coalesce(a.excerpt, '')) = '' THEN NULL ELSE a.excerpt END,
             CASE WHEN trim(coalesce(a.description, '')) = '' THEN NULL ELSE a.description END,
             CASE WHEN trim(coalesce(a.notes, '')) = '' THEN NULL ELSE a.notes END,
             CASE WHEN a.content IS NULL OR a.content STARTS WITH 'data:'
                       OR trim(a.content) = '' THEN NULL
                  ELSE left(a.content, 280) END
           ) AS excerpt,
           CASE WHEN trim(coalesce(a.description, '')) = '' THEN NULL
                ELSE a.description END AS description,
           CASE WHEN coalesce(a.type, a.assetType) IN ['playbook', 'transcript', 'knowledge', 'journey']
                     AND a.content IS NOT NULL
                     AND NOT a.content STARTS WITH 'data:'
                THEN left(a.content, 280) ELSE NULL END AS contentHead,
           CASE WHEN coalesce(a.type, a.assetType) = 'agent'
                THEN coalesce(a.agentType, 'other') ELSE NULL END AS tileAgentType,
           CASE WHEN coalesce(a.type, a.assetType) = 'agent'
                THEN a.agentEndpoints ELSE NULL END AS tileAgentEndpoints,
           a.metadata AS tileMetadata,
           [x IN spacesRaw WHERE x.id IS NOT NULL] AS otherSpaces,
           CASE WHEN producer IS NULL
                THEN null
                ELSE { kind: head(labels(producer)),
                       name: coalesce(producer.name, producer.title, ''),
                       id: producer.id }
           END AS producedBy
    ORDER BY coalesce(toString(a.updatedAt), toString(a.updated_at), '') DESC
    LIMIT toInteger($limit)
  `,
  // ─── Checklists (ADR-055) ──────────────────────────────────────────────

  CREATE_CHECKLIST: `
    MATCH (s:Space {id: $spaceId})
      WHERE s.deletedAt IS NULL
        AND ${SPACE_VISIBLE}
    CREATE (c:Checklist {
      id: $id,
      name: $name,
      mode: $mode,
      pausePoint: $pausePoint,
      items: $itemsJson,
      itemCount: $itemCount,
      requiredIdx: $requiredIdx,
      version: 1,
      createdAt: $now,
      updatedAt: $now
    })
    MERGE (c)-[:BELONGS_TO]->(s)
    RETURN c.id AS id
  `,

  LIST_CHECKLISTS_IN_SPACE: `
    MATCH (c:Checklist)-[:BELONGS_TO]->(s:Space {id: $spaceId})
      WHERE s.deletedAt IS NULL
        AND ${SPACE_VISIBLE}
    RETURN c.id AS id,
           c.name AS name,
           c.mode AS mode,
           c.pausePoint AS pausePoint,
           c.items AS itemsJson,
           coalesce(c.version, 1) AS version,
           toString(c.revisedAt) AS revisedAt,
           toString(c.createdAt) AS createdAt,
           toString(c.updatedAt) AS updatedAt,
           size([(t)-[:PREFLIGHT_CHECKLIST]->(c) | t]) +
             size([(t2)-[:POSTFLIGHT_CHECKLIST]->(c) | t2]) AS usedByCount
    ORDER BY toLower(c.name) ASC
  `,

  /**
   * Revise a checklist (ADR-055 addendum, 2026-08-08): a checklist is
   * a living document — version bumps, revisedAt stamps — and a
   * REVISED checklist must be RE-RUN: every attached ticket's run
   * state resets in the same statement, because a check made against
   * item list v1 says nothing about item list v2 (checkedIdx is
   * positional). Doctrine over convenience.
   */
  UPDATE_CHECKLIST: `
    MATCH (c:Checklist {id: $id})-[:BELONGS_TO]->(s:Space)
      WHERE s.deletedAt IS NULL
        AND ${SPACE_VISIBLE}
    SET c.name = $name,
        c.mode = $mode,
        c.pausePoint = $pausePoint,
        c.items = $itemsJson,
        c.itemCount = $itemCount,
        c.requiredIdx = $requiredIdx,
        c.version = coalesce(c.version, 1) + 1,
        c.revisedAt = $now,
        c.updatedAt = $now
    WITH c
    OPTIONAL MATCH (tpre)-[pre:PREFLIGHT_CHECKLIST]->(c)
    SET pre.checkedIdx = [],
        pre.lastCheckedBy = null,
        pre.lastCheckedAt = null,
        pre.completedAt = null
    WITH c
    OPTIONAL MATCH (tpost)-[post:POSTFLIGHT_CHECKLIST]->(c)
    SET post.checkedIdx = [],
        post.lastCheckedBy = null,
        post.lastCheckedAt = null,
        post.completedAt = null
    RETURN DISTINCT c.id AS id, coalesce(c.version, 1) AS version
  `,

  /**
   * How many tickets hold this checklist (delete guard). Visibility-
   * gated like every read: an invisible checklist's attachment count
   * must not leak through the guard's error message.
   */
  COUNT_CHECKLIST_ATTACHMENTS: `
    MATCH (c:Checklist {id: $id})-[:BELONGS_TO]->(s:Space)
      WHERE s.deletedAt IS NULL
        AND ${SPACE_VISIBLE}
    RETURN size([(t)-[:PREFLIGHT_CHECKLIST]->(c) | t]) +
             size([(t2)-[:POSTFLIGHT_CHECKLIST]->(c) | t2]) AS attachedCount
  `,

  /**
   * Delete only when detached everywhere — silently unhooking a
   * REQUIRED gate from live tickets would un-gate them without anyone
   * choosing that.
   */
  DELETE_CHECKLIST: `
    MATCH (c:Checklist {id: $id})-[:BELONGS_TO]->(s:Space)
      WHERE s.deletedAt IS NULL
        AND ${SPACE_VISIBLE}
    DETACH DELETE c
  `,

  // Attach = MERGE so re-attaching is idempotent (obligation updates in
  // place; run state is preserved). Phase selects the edge type — two
  // distinct relationship types per the schema, not a property flag, so
  // graph queries can traverse "what gates done?" without filtering.
  ATTACH_CHECKLIST_PREFLIGHT: `
    MATCH (a:Asset {id: $ticketId})
      WHERE coalesce(a.type, a.assetType) = 'ticket'
        AND a.deletedAt IS NULL
        AND ${ASSET_VISIBLE}
    MATCH (c:Checklist {id: $checklistId})-[:BELONGS_TO]->(cs:Space)
      WHERE (coalesce(cs.visibility, 'open') <> 'restricted'
             OR ($viewerId <> '' AND EXISTS {
               MATCH (:Person {id: $viewerId})-[rv:HAS_ACCESS]->(cs)
               WHERE (rv.expiresUnixMs IS NULL OR rv.expiresUnixMs > $nowMs)
             }))
    MERGE (a)-[r:PREFLIGHT_CHECKLIST]->(c)
    SET r.obligation = $obligation
    FOREACH (_ IN CASE WHEN r.checkedIdx IS NULL THEN [1] ELSE [] END |
      SET r.checkedIdx = []
    )
    RETURN c.id AS id
  `,

  ATTACH_CHECKLIST_POSTFLIGHT: `
    MATCH (a:Asset {id: $ticketId})
      WHERE coalesce(a.type, a.assetType) = 'ticket'
        AND a.deletedAt IS NULL
        AND ${ASSET_VISIBLE}
    MATCH (c:Checklist {id: $checklistId})-[:BELONGS_TO]->(cs:Space)
      WHERE (coalesce(cs.visibility, 'open') <> 'restricted'
             OR ($viewerId <> '' AND EXISTS {
               MATCH (:Person {id: $viewerId})-[rv:HAS_ACCESS]->(cs)
               WHERE (rv.expiresUnixMs IS NULL OR rv.expiresUnixMs > $nowMs)
             }))
    MERGE (a)-[r:POSTFLIGHT_CHECKLIST]->(c)
    SET r.obligation = $obligation
    FOREACH (_ IN CASE WHEN r.checkedIdx IS NULL THEN [1] ELSE [] END |
      SET r.checkedIdx = []
    )
    RETURN c.id AS id
  `,

  GET_TICKET_CHECKLISTS: `
    MATCH (a:Asset {id: $ticketId})
      WHERE a.deletedAt IS NULL
        AND ${ASSET_VISIBLE}
    OPTIONAL MATCH (a)-[pre:PREFLIGHT_CHECKLIST]->(cpre:Checklist)
    OPTIONAL MATCH (a)-[post:POSTFLIGHT_CHECKLIST]->(cpost:Checklist)
    WITH
      collect(DISTINCT CASE WHEN cpre IS NULL THEN NULL ELSE {
        phase: 'preflight',
        obligation: coalesce(pre.obligation, 'recommended'),
        checkedIdx: coalesce(pre.checkedIdx, []),
        completedAt: toString(pre.completedAt),
        lastCheckedBy: pre.lastCheckedBy,
        lastCheckedAt: toString(pre.lastCheckedAt),
        id: cpre.id, name: cpre.name, mode: cpre.mode,
        pausePoint: cpre.pausePoint, itemsJson: cpre.items,
        itemCount: coalesce(cpre.itemCount, 0),
        requiredIdx: cpre.requiredIdx,
        version: coalesce(cpre.version, 1)
      } END) AS pres,
      collect(DISTINCT CASE WHEN cpost IS NULL THEN NULL ELSE {
        phase: 'postflight',
        obligation: coalesce(post.obligation, 'recommended'),
        checkedIdx: coalesce(post.checkedIdx, []),
        completedAt: toString(post.completedAt),
        lastCheckedBy: post.lastCheckedBy,
        lastCheckedAt: toString(post.lastCheckedAt),
        id: cpost.id, name: cpost.name, mode: cpost.mode,
        pausePoint: cpost.pausePoint, itemsJson: cpost.items,
        itemCount: coalesce(cpost.itemCount, 0),
        requiredIdx: cpost.requiredIdx,
        version: coalesce(cpost.version, 1)
      } END) AS posts
    RETURN [x IN pres WHERE x IS NOT NULL] + [x IN posts WHERE x IS NOT NULL] AS links
  `,

  // One atomic toggle: remove-then-conditionally-add the index as a
  // native list op, and derive completion from the checklist's own
  // itemCount in the same statement. Two agents checking DIFFERENT
  // items concurrently both land; a JSON-blob read-modify-write would
  // lose one of them.
  SET_CHECKLIST_ITEM_PREFLIGHT: `
    MATCH (a:Asset {id: $ticketId})
      WHERE a.deletedAt IS NULL
        AND ${ASSET_VISIBLE}
    MATCH (a)-[r:PREFLIGHT_CHECKLIST]->(c:Checklist {id: $checklistId})
    SET r.checkedIdx =
      CASE WHEN $checked
           THEN [x IN coalesce(r.checkedIdx, []) WHERE x <> $itemIndex] + $itemIndex
           ELSE [x IN coalesce(r.checkedIdx, []) WHERE x <> $itemIndex]
      END,
        r.lastCheckedBy = $actorId,
        r.lastCheckedAt = $now
    WITH r, c,
         CASE WHEN c.requiredIdx IS NULL
              THEN size(r.checkedIdx) = coalesce(c.itemCount, -1)
              ELSE all(req IN c.requiredIdx WHERE req IN r.checkedIdx)
         END AS nowComplete
    SET r.completedAt = CASE WHEN nowComplete AND r.completedAt IS NULL THEN $now
                             WHEN NOT nowComplete THEN NULL
                             ELSE r.completedAt END
    RETURN r.checkedIdx AS checkedIdx, nowComplete AS complete
  `,

  SET_CHECKLIST_ITEM_POSTFLIGHT: `
    MATCH (a:Asset {id: $ticketId})
      WHERE a.deletedAt IS NULL
        AND ${ASSET_VISIBLE}
    MATCH (a)-[r:POSTFLIGHT_CHECKLIST]->(c:Checklist {id: $checklistId})
    SET r.checkedIdx =
      CASE WHEN $checked
           THEN [x IN coalesce(r.checkedIdx, []) WHERE x <> $itemIndex] + $itemIndex
           ELSE [x IN coalesce(r.checkedIdx, []) WHERE x <> $itemIndex]
      END,
        r.lastCheckedBy = $actorId,
        r.lastCheckedAt = $now
    WITH r, c,
         CASE WHEN c.requiredIdx IS NULL
              THEN size(r.checkedIdx) = coalesce(c.itemCount, -1)
              ELSE all(req IN c.requiredIdx WHERE req IN r.checkedIdx)
         END AS nowComplete
    SET r.completedAt = CASE WHEN nowComplete AND r.completedAt IS NULL THEN $now
                             WHEN NOT nowComplete THEN NULL
                             ELSE r.completedAt END
    RETURN r.checkedIdx AS checkedIdx, nowComplete AS complete
  `,

  // The gate's read: current status + every REQUIRED link's run state.
  TICKET_GATE_STATE: `
    MATCH (a:Asset {id: $ticketId})
      WHERE a.deletedAt IS NULL
        AND ${ASSET_VISIBLE}
    OPTIONAL MATCH (a)-[pre:PREFLIGHT_CHECKLIST {obligation: 'required'}]->(cpre:Checklist)
    OPTIONAL MATCH (a)-[post:POSTFLIGHT_CHECKLIST {obligation: 'required'}]->(cpost:Checklist)
    RETURN coalesce(a.status, 'open') AS currentStatus,
           [x IN collect(DISTINCT CASE WHEN cpre IS NULL THEN NULL ELSE {
              name: cpre.name,
              complete: CASE WHEN cpre.requiredIdx IS NULL
                             THEN size(coalesce(pre.checkedIdx, [])) = coalesce(cpre.itemCount, -1)
                             ELSE all(req IN cpre.requiredIdx WHERE req IN coalesce(pre.checkedIdx, []))
                        END
           } END) WHERE x IS NOT NULL] AS requiredPre,
           [x IN collect(DISTINCT CASE WHEN cpost IS NULL THEN NULL ELSE {
              name: cpost.name,
              complete: CASE WHEN cpost.requiredIdx IS NULL
                             THEN size(coalesce(post.checkedIdx, [])) = coalesce(cpost.itemCount, -1)
                             ELSE all(req IN cpost.requiredIdx WHERE req IN coalesce(post.checkedIdx, []))
                        END
           } END) WHERE x IS NOT NULL] AS requiredPost
  `,

  DETACH_CHECKLIST_PREFLIGHT: `
    MATCH (a:Asset {id: $ticketId})
      WHERE a.deletedAt IS NULL
        AND ${ASSET_VISIBLE}
    MATCH (a)-[r:PREFLIGHT_CHECKLIST]->(:Checklist {id: $checklistId})
    DELETE r
    RETURN $checklistId AS id
  `,

  DETACH_CHECKLIST_POSTFLIGHT: `
    MATCH (a:Asset {id: $ticketId})
      WHERE a.deletedAt IS NULL
        AND ${ASSET_VISIBLE}
    MATCH (a)-[r:POSTFLIGHT_CHECKLIST]->(:Checklist {id: $checklistId})
    DELETE r
    RETURN $checklistId AS id
  `,

  // ADR-055 — self-registration into the graph's schema registry.
  // Idempotent MERGEs keyed on `entity`; SET is additive so whatever
  // else lives on `_RelationshipTypes` is never clobbered.
  ENSURE_CHECKLIST_SCHEMA: `
    MERGE (cs:Schema {entity: 'Checklist'})
    SET cs.description = $checklistDoc,
        cs.properties = $checklistProps,
        cs.updatedAt = $now
    MERGE (rt:Schema {entity: '_RelationshipTypes'})
    SET rt.preflightChecklist = $preflightDoc,
        rt.postflightChecklist = $postflightDoc,
        rt.updatedAt = $now
    RETURN cs.entity AS entity
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
  protected readonly spanEmitter: NonNullable<SdkSpacesClientConfig['spanEmitter']> | null;
  protected readonly getViewerId: (() => string | null) | null;
  /** ADR-052 — clock for `$nowMs`; overridable so tests can pin it. */
  protected readonly now: () => number;

  constructor(config: SdkSpacesClientConfig = {}) {
    this.getAuthEnv = config.getAuthEnv ?? ((): string | null => null);
    this.spanEmitter = config.spanEmitter ?? null;
    this.getViewerId = config.viewerId ?? null;
    this.now = config.now ?? ((): number => Date.now());
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

  /**
   * Wrap an operation in a span (ADR-030). The base `name` auto-emits
   * `<name>.start` immediately and `<name>.finish` / `<name>.fail` on
   * settle. No-op when no `spanEmitter` is wired (tests). The function
   * runs unchanged whether instrumented or not.
   */
  protected async withSpan<T>(
    name: string,
    fn: () => Promise<T>,
    data?: unknown
  ): Promise<T> {
    const span = this.spanEmitter?.(name, data);
    try {
      const result = await fn();
      span?.finish();
      return result;
    } catch (err) {
      span?.fail(err);
      throw err;
    }
  }

  async listSpaces(): Promise<Space[]> {
    return this.withSpan('spaces.listSpaces', async () => {
      const rows = await this.run(CYPHER.LIST_SPACES, { viewerId: this.viewerParam() });
      return rows.map(toSpace);
    });
  }

  /**
   * GSX migration sweep (ADR-050) — list assets still carrying the v1
   * inline-base64 stub. Unspanned like the other asset-level ops; the
   * sweep in `gsx-migration.ts` wraps the whole pass in its own
   * `spaces.gsxMigrate` span.
   */
  async listInlineBinaryAssets(limit = 25): Promise<InlineBinaryAssetRow[]> {
    const rows = await this.run(CYPHER.LIST_INLINE_BINARY_ASSETS, {
      limit: Math.max(1, Math.min(100, Math.floor(limit))),
    });
    return rows.map((r) => ({
      id: optString(r, 'id') ?? '',
      content: optString(r, 'content') ?? '',
      title: optString(r, 'title') ?? '',
      mimeType: optString(r, 'mimeType') ?? '',
    }));
  }

  /**
   * GSX migration sweep (ADR-050) — convert one inline-stub asset to
   * its GSX-backed form. Returns true when the node was found+updated.
   */
  async convertInlineAssetToFile(id: string, fileKey: string, size: number): Promise<boolean> {
    const rows = await this.run(CYPHER.CONVERT_INLINE_ASSET_TO_FILE, {
      id,
      fileKey,
      size: Math.max(0, Math.floor(size)),
      now: new Date().toISOString(),
    });
    return rows.length > 0;
  }

  async learnSignals(): Promise<LearnSignals> {
    return this.withSpan('spaces.learn.signals', async () => {
      const viewerId = this.viewerParam();
      const [kindRows, spaceRows, memberRows] = await Promise.all([
        this.run(CYPHER.LEARN_KIND_COUNTS, { viewerId }),
        this.run(CYPHER.LEARN_SPACE_COUNT, { viewerId }),
        this.run(CYPHER.LEARN_OTHER_MEMBERS, { viewerId }),
      ]);
      const kinds: Record<string, number> = {};
      for (const row of kindRows) {
        const kind = typeof row.learnKind === 'string' ? row.learnKind : 'other';
        const n = Number(row.learnCount);
        if (Number.isFinite(n) && n > 0) kinds[kind] = (kinds[kind] ?? 0) + n;
      }
      const spaces = Number(spaceRows[0]?.learnSpaces);
      const otherMembers = Number(memberRows[0]?.learnOtherMembers);
      return {
        spaces: Number.isFinite(spaces) ? spaces : 0,
        otherMembers: Number.isFinite(otherMembers) ? otherMembers : 0,
        kinds,
      };
    });
  }

  async getUncategorizedCount(): Promise<number> {
    return this.withSpan('spaces.uncategorizedCount', async () => {
      const rows = await this.run(CYPHER.UNCATEGORIZED_COUNT);
      return toCount(rows[0]);
    });
  }

  async listItems(scope: SpaceScope, opts: ListOpts = {}): Promise<ItemSummary[]> {
    return this.withSpan('spaces.items.list', async () => {
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
      const rows = await this.run(CYPHER.LIST_ITEMS_IN_SPACE, {
        spaceId,
        offset,
        limit,
        viewerId: this.viewerParam(),
      });
      return rows.map((r) => toItemSummary(r, { stripOtherSpaces: false }));
    });
  }

  /**
   * Read-back for freshly-created nodes. The Edison Neon endpoint has
   * shown read-after-write inconsistency under load — a CREATE returns
   * rows, yet an immediate re-read misses the node (observed live
   * 2026-08-06: mp4 createBinary triggered spurious orphan cleanup;
   * transcript create surfaced "disappeared after creation" while the
   * node existed). Retry the read briefly before declaring the asset
   * gone — the alternative is telling the user a successful create
   * failed (and, on the binary path, deleting bytes a live node points
   * at).
   */
  private async getItemAfterCreate(id: string): Promise<Item | null> {
    const delays = [0, 350, 700, 1400];
    for (let i = 0; i < delays.length; i++) {
      const delay = delays[i] ?? 0;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      const item = await this.getItem(id);
      if (item !== null) return item;
    }
    return null;
  }

  async getItem(id: string): Promise<Item | null> {
    return this.withSpan('spaces.items.get', async () => {
      if (typeof id !== 'string' || id.length === 0) {
        throw new SpacesError({
          code: 'SPACES_INVALID_INPUT',
          message: 'getItem requires a non-empty id',
          remediation: 'Pass the canonical item id from a prior list result.',
          context: { id },
        });
      }
      const rows = await this.run(CYPHER.GET_ITEM, { id, viewerId: this.viewerParam() });
      if (rows.length === 0) return null;
      return toItem(rows[0] as Record<string, unknown>);
    });
  }

  /**
   * Update mutable fields on an Item (Phase 3b). Returns the
   * freshly-projected Item via a follow-up `getItem` so the caller
   * gets the updated `updatedAt`, lastEditedBy, etc. in one shape.
   *
   * Input is validated client-side:
   *   - title: trimmed; 1..MAX_ITEM_TITLE_LENGTH chars
   *   - description: trimmed; 0..MAX_ITEM_DESCRIPTION_LENGTH (empty = clear)
   *   - type: must be a valid ItemKind
   *   - editorId: optional `:Person.id`; empty = anonymous edit
   *
   * Throws `SPACES_INVALID_INPUT` for missing id or bad shapes.
   */
  async updateItem(id: string, patch: ItemUpdatePatch): Promise<Item> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'items.update requires a non-empty id',
        remediation: 'Pass the canonical item id from a prior list result.',
        context: { id },
      });
    }
    const params = validateUpdatePatch(patch);
    await this.run(CYPHER.UPDATE_ITEM, { id, ...params, now: new Date().toISOString() });
    const updated = await this.getItem(id);
    if (updated === null) {
      throw new SpacesError({
        code: 'SPACES_NOT_FOUND',
        message: 'Item disappeared between update and re-fetch',
        remediation:
          'Refresh the list; the asset may have been deleted by another producer mid-edit.',
        context: { id },
      });
    }
    return updated;
  }

  /**
   * Add a tag to an Item. Returns the updated tag list (post-merge,
   * de-duplicated) read from the canonical edge projection. Empty /
   * whitespace-only tags are rejected with `SPACES_INVALID_INPUT`.
   */
  async addTag(id: string, tag: string): Promise<string[]> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'addTag requires a non-empty id',
        context: { id },
      });
    }
    const normalized = normalizeTag(tag);
    if (normalized === null) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: `Tag must be 1..${MAX_ITEM_TAG_LENGTH} chars after trim`,
        context: { tag },
      });
    }
    await this.run(CYPHER.ADD_TAG, { id, tag: normalized });
    const updated = await this.getItem(id);
    return updated?.tags ?? [];
  }

  /**
   * Remove a tag from an Item. No-op if the edge is already absent
   * (the underlying MATCH won't find anything to DELETE — Cypher
   * just returns empty rows). Returns the updated tag list.
   */
  async removeTag(id: string, tag: string): Promise<string[]> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'removeTag requires a non-empty id',
        context: { id },
      });
    }
    const normalized = normalizeTag(tag);
    if (normalized === null) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: `Tag must be 1..${MAX_ITEM_TAG_LENGTH} chars after trim`,
        context: { tag },
      });
    }
    await this.run(CYPHER.REMOVE_TAG, { id, tag: normalized });
    const updated = await this.getItem(id);
    return updated?.tags ?? [];
  }

  /**
   * Per-asset activity log (Phase 3c). Returns the most recent commits
   * touching the given Asset. Row shape mirrors `listRecentEvents()` so
   * the renderer reuses the same event-row layout.
   *
   * Defaults: limit 20 (one screen of activity), no `since` cutoff.
   * Caps: limit 100 (prevents large server-side scans).
   *
   * Soft-fails: an unknown asset returns `[]` rather than throwing,
   * because the OPTIONAL MATCH on the Cypher side already absorbs the
   * not-found case. Callers that need a hard 404 should call `getItem`
   * first.
   */
  async itemRecentCommits(
    id: string,
    opts: RecentCommitsOpts = {}
  ): Promise<Event[]> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'recentCommits requires a non-empty id',
        context: { id },
      });
    }
    const limit = clampSmallLimit(opts.limit, 20, 100);
    const since =
      typeof opts.since === 'number' && Number.isFinite(opts.since) && opts.since >= 0
        ? Math.floor(opts.since)
        : null;
    const rows = await this.run(CYPHER.ITEM_RECENT_COMMITS, { id, limit, since });
    return rows.map(toEvent).filter((e): e is Event => e !== null);
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
    const rows = await this.run(CYPHER.HOME_RECENT_ITEMS, {
      limit,
      viewerId: this.viewerParam(),
    });
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

  // ─── Mutations (Phase 3a) ──────────────────────────────────────────────

  /**
   * Create a new Space. Validates input client-side, generates an id,
   * stamps `createdAt`/`updatedAt`, executes the atomic create. A name
   * collision returns 0 rows; we surface that as
   * `SPACES_DUPLICATE_NAME`.
   */
  async createSpace(input: CreateSpaceInput): Promise<Space> {
    return this.withSpan('spaces.create', async () => {
      const name = validateSpaceName(input.name);
      const description = validateOptionalDescription(input.description);
      const color = typeof input.color === 'string' ? input.color : '';
      const iconKey = typeof input.iconKey === 'string' ? input.iconKey : '';
      const id = generateSpaceId();
      const now = nowIso();
      const rows = await this.run(CYPHER.CREATE_SPACE, {
        id,
        name,
        description,
        color,
        iconKey,
        now,
      });
      if (rows.length === 0) {
        throw new SpacesError({
          code: 'SPACES_DUPLICATE_NAME',
          message: `A space named "${name}" already exists`,
          remediation: 'Pick a different name. Names are unique within an account.',
          context: { name },
        });
      }
      return toSpace(rows[0] as Record<string, unknown>);
    });
  }

  /**
   * Rename an existing Space. 0 rows from RENAME_SPACE means either the
   * Space doesn't exist (or is soft-deleted) or the new name collides;
   * a follow-up SPACE_EXISTS_BY_ID probe disambiguates so callers see
   * the right error code.
   */
  async renameSpace(id: string, name: string): Promise<Space> {
    return this.withSpan('spaces.rename', async () => {
      const validId = validateSpaceId(id);
      const validName = validateSpaceName(name);
      const now = nowIso();
      const rows = await this.run(CYPHER.RENAME_SPACE, {
        id: validId,
        name: validName,
        now,
      });
      if (rows.length === 0) {
        const exists = await this.spaceExists(validId);
        if (!exists) {
          throw new SpacesError({
            code: 'SPACES_NOT_FOUND',
            message: `Space ${validId} not found (it may have been deleted)`,
            remediation: 'Refresh the list and try again.',
            context: { id: validId },
          });
        }
        throw new SpacesError({
          code: 'SPACES_DUPLICATE_NAME',
          message: `A space named "${validName}" already exists`,
          remediation: 'Pick a different name. Names are unique within an account.',
          context: { id: validId, name: validName },
        });
      }
      return toSpace(rows[0] as Record<string, unknown>);
    });
  }

  /**
   * Patch a Space's non-identity fields (description / color /
   * iconKey). Empty patches are a no-op that still bumps
   * `s.updatedAt` (so the cache invalidation surface stays uniform).
   *
   * 0 rows from UPDATE_SPACE means the Space doesn't exist or is
   * soft-deleted. Renames go through `renameSpace` so the uniqueness
   * probe stays scoped to the name-change path.
   */
  async updateSpace(id: string, patch: UpdateSpaceInput): Promise<Space> {
    return this.withSpan('spaces.update', async () => {
      const validId = validateSpaceId(id);
      const writeDescription = patch.description !== undefined;
      const writeColor = patch.color !== undefined;
      const writeIconKey = patch.iconKey !== undefined;
      const writeVisibility = patch.visibility !== undefined;
      if (writeVisibility && patch.visibility !== 'open' && patch.visibility !== 'restricted') {
        throw new SpacesError({
          code: 'SPACES_INVALID_INPUT',
          message: `visibility must be 'open' or 'restricted' (got ${String(patch.visibility)})`,
          remediation: "Pass visibility: 'open' | 'restricted'.",
          context: { id: validId },
        });
      }

      // Normalize + validate description when present.
      const description = writeDescription
        ? validateOptionalDescription(patch.description)
        : '';
      const color = writeColor ? String(patch.color ?? '') : '';
      const iconKey = writeIconKey ? String(patch.iconKey ?? '') : '';

      const now = nowIso();
      const rows = await this.run(CYPHER.UPDATE_SPACE, {
        id: validId,
        now,
        writeDescription,
        description,
        writeColor,
        color,
        writeIconKey,
        iconKey,
        writeVisibility,
        visibility: writeVisibility ? patch.visibility : '',
        // Auto-grant: whoever flips a Space to members-only gets a
        // HAS_ACCESS edge in the same transaction, so you can never
        // lock yourself out of your own Space.
        viewerId: this.viewerParam(),
      });
      if (rows.length === 0) {
        throw new SpacesError({
          code: 'SPACES_NOT_FOUND',
          message: `Space ${validId} not found (it may have been deleted)`,
          remediation: 'Refresh the list and try again.',
          context: { id: validId },
        });
      }
      return toSpace(rows[0] as Record<string, unknown>);
    });
  }

  /**
   * Delete a Space. Defaults to soft (sets `deletedAt`); pass
   * `{ soft: false }` to hard-remove. Hard delete refuses if the
   * Space still has items so data can't orphan accidentally.
   */
  async deleteSpace(id: string, opts: DeleteSpaceOpts = {}): Promise<void> {
    return this.withSpan('spaces.delete', async () => {
      const validId = validateSpaceId(id);
      const soft = opts.soft !== false; // default true

      if (soft) {
        const now = nowIso();
        const rows = await this.run(CYPHER.SOFT_DELETE_SPACE, { id: validId, now });
        if (rows.length === 0) {
          const exists = await this.spaceExists(validId);
          if (!exists) {
            throw new SpacesError({
              code: 'SPACES_NOT_FOUND',
              message: `Space ${validId} not found`,
              remediation: 'Refresh the list and try again.',
              context: { id: validId },
            });
          }
          // Space exists but the WHERE filtered it out -- already soft-deleted.
          // Idempotent: treat as success.
        }
        return;
      }

      // Hard delete: pre-flight the item count.
      const countRows = await this.run(CYPHER.SPACE_ITEM_COUNT, { id: validId });
      const itemCount = toCount(countRows[0]);
      if (countRows.length === 0) {
        // The MATCH didn't bind -- Space doesn't exist.
        throw new SpacesError({
          code: 'SPACES_NOT_FOUND',
          message: `Space ${validId} not found`,
          remediation: 'Refresh the list and try again.',
          context: { id: validId },
        });
      }
      if (itemCount > 0) {
        throw new SpacesError({
          code: 'SPACES_DELETE_NON_EMPTY',
          message: `Cannot hard-delete a Space that still contains ${itemCount} item(s)`,
          remediation:
            'Move the items out first, or use soft delete (the default): it hides the Space and its items surface under Uncategorized until you restore it.',
          context: { id: validId, itemCount },
        });
      }
      await this.run(CYPHER.HARD_DELETE_SPACE, { id: validId });
    });
  }

  /**
   * Restore a soft-deleted Space. 0 rows means either the Space
   * doesn't exist or wasn't soft-deleted -- a follow-up probe
   * disambiguates so the caller sees the right error code.
   */
  async undeleteSpace(id: string): Promise<Space> {
    return this.withSpan('spaces.undelete', async () => {
      const validId = validateSpaceId(id);
      const now = nowIso();
      const rows = await this.run(CYPHER.UNDELETE_SPACE, { id: validId, now });
      if (rows.length === 0) {
        const exists = await this.spaceExists(validId);
        if (!exists) {
          throw new SpacesError({
            code: 'SPACES_NOT_FOUND',
            message: `Space ${validId} not found`,
            remediation: 'Verify the id; the Space may have been hard-deleted.',
            context: { id: validId },
          });
        }
        // Exists but wasn't soft-deleted -- nothing to restore. Idempotent:
        // re-fetch and return the current row.
        const refreshed = await this.run(CYPHER.LIST_SPACES, {
          viewerId: this.viewerParam(),
        });
        const match = refreshed
          .map(toSpace)
          .find((s) => s.id === validId);
        if (match !== undefined) return match;
        throw new SpacesError({
          code: 'SPACES_NOT_FOUND',
          message: `Space ${validId} not found after undelete`,
          remediation: 'Refresh the list and try again.',
          context: { id: validId },
        });
      }
      return toSpace(rows[0] as Record<string, unknown>);
    });
  }

  // ─── Phase 4: shared spaces (playbooks + tickets) ────────────────────

  /**
   * Flip a Space's `kind` between 'user' and 'shared'. Idempotent:
   * setting the same kind again is a no-op at the renderer level
   * (just refreshes `updatedAt`).
   *
   * @throws {SpacesError} SPACES_NOT_FOUND if the Space is missing or
   *   soft-deleted; SPACES_INVALID_INPUT if `kind` is anything other
   *   than 'user' / 'shared'.
   */
  async setSpaceKind(id: string, kind: SpaceKind): Promise<SpaceKind> {
    const validId = validateSpaceId(id);
    if (kind !== 'user' && kind !== 'shared') {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: `kind must be 'user' or 'shared' (got ${String(kind)})`,
        context: { kind },
      });
    }
    const now = nowIso();
    const rows = await this.run(CYPHER.SET_SPACE_KIND, { id: validId, kind, now });
    if (rows.length === 0) {
      throw new SpacesError({
        code: 'SPACES_NOT_FOUND',
        message: `Space ${validId} not found`,
        remediation: 'It may have been deleted. Refresh and try again.',
        context: { id: validId },
      });
    }
    const next = optString(rows[0] as Record<string, unknown>, 'kind');
    return next === 'shared' ? 'shared' : 'user';
  }

  /**
   * Return the current playbook for a shared space, or `null` when
   * none is set. Wraps the GET_CURRENT_PLAYBOOK probe with a follow-up
   * `getItem(playbookId)` so the caller receives the full Item rather
   * than just an id.
   *
   * Returns `null` for both "space has no playbook" AND "space doesn't
   * exist" — distinguishing them costs a second round-trip and the
   * caller's renderer treats them identically (the "set a playbook"
   * CTA in both cases).
   */
  async getCurrentPlaybook(spaceId: string): Promise<Item | null> {
    const validId = validateSpaceId(spaceId);
    const rows = await this.run(CYPHER.GET_CURRENT_PLAYBOOK, { spaceId: validId });
    if (rows.length === 0) return null;
    const pbId = optString(rows[0] as Record<string, unknown>, 'playbookId');
    if (pbId === undefined || pbId.length === 0) return null;
    return this.getItem(pbId);
  }

  /**
   * Promote an :Asset to be the Space's current playbook. The asset's
   * type is rewritten to `'playbook'` so listings draw it with the
   * playbook chrome regardless of what kind it was before.
   *
   * @throws {SpacesError} SPACES_NOT_FOUND if either the Space or the
   *   asset is missing.
   */
  async setCurrentPlaybook(spaceId: string, playbookId: string): Promise<SetPlaybookResult> {
    const validSpaceId = validateSpaceId(spaceId);
    if (typeof playbookId !== 'string' || playbookId.length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'setCurrentPlaybook requires a non-empty playbookId',
        context: { playbookId },
      });
    }
    const now = nowIso();
    const rows = await this.run(CYPHER.SET_CURRENT_PLAYBOOK, {
      spaceId: validSpaceId,
      playbookId,
      now,
    });
    if (rows.length === 0) {
      throw new SpacesError({
        code: 'SPACES_NOT_FOUND',
        message: 'Space or asset not found',
        remediation: 'Verify both ids; the Space may have been deleted.',
        context: { spaceId: validSpaceId, playbookId },
      });
    }
    const playbook = await this.getItem(playbookId);
    if (playbook === null) {
      throw new SpacesError({
        code: 'SPACES_NOT_FOUND',
        message: `Playbook ${playbookId} disappeared after promotion`,
        context: { playbookId },
      });
    }
    const ticketCount = optNumber(rows[0] as Record<string, unknown>, 'ticketCount') ?? 0;
    return { playbook, ticketCount };
  }

  /**
   * List tickets in a Space. Returns ticket-shaped Items (i.e.
   * `Item.kind === 'ticket'` with `Item.ticket` populated). When the
   * Space isn't shared the result is still well-defined: just the
   * tickets that happen to live there, if any.
   */
  async listTickets(spaceId: string, opts: ListTicketsOpts = {}): Promise<Item[]> {
    const validSpaceId = validateSpaceId(spaceId);
    const status = opts.status ?? null;
    if (status !== null && !(TICKET_STATUS_SET as Set<string>).has(status)) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: `Unknown ticket status ${String(status)}`,
        context: { status },
      });
    }
    const limit = clampSmallLimit(opts.limit, 200, 500);
    const offset = typeof opts.offset === 'number' && opts.offset >= 0
      ? Math.floor(opts.offset)
      : 0;
    const rows = await this.run(CYPHER.LIST_TICKETS_IN_SPACE, {
      spaceId: validSpaceId,
      status,
      limit,
      offset,
    });
    return rows.map((r) => toTicketItem(r as Record<string, unknown>));
  }

  /**
   * Create a new ticket in a Space. Returns the freshly-projected
   * ticket Item via a follow-up getItem so the caller never sees a
   * half-populated row.
   *
   * @throws {SpacesError} SPACES_INVALID_INPUT for empty title /
   *   oversize fields / unknown status; SPACES_NOT_FOUND if the
   *   Space doesn't exist.
   */
  async createTicket(spaceId: string, input: CreateTicketInput): Promise<Item> {
    const validSpaceId = validateSpaceId(spaceId);
    const title = validateTitle(input.title);
    const description = validateOptionalDescription(input.description ?? '');
    const status = input.status ?? 'open';
    if (!(TICKET_STATUS_SET as Set<string>).has(status)) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: `Unknown ticket status ${String(status)}`,
        context: { status },
      });
    }
    const priority = input.priority ?? null;
    const playbookId = typeof input.playbookId === 'string' && input.playbookId.length > 0
      ? input.playbookId
      : null;
    const assigneeId = typeof input.assigneeId === 'string' && input.assigneeId.length > 0
      ? input.assigneeId
      : null;
    const id = generateTicketId();
    const now = nowIso();
    const rows = await this.run(CYPHER.CREATE_TICKET, {
      spaceId: validSpaceId,
      id,
      title,
      description,
      status,
      priority,
      playbookId,
      assigneeId,
      now,
    });
    if (rows.length === 0) {
      throw new SpacesError({
        code: 'SPACES_NOT_FOUND',
        message: `Space ${validSpaceId} not found`,
        remediation: 'Refresh the list and try again.',
        context: { spaceId: validSpaceId },
      });
    }
    const created = await this.getItemAfterCreate(id);
    if (created === null) {
      throw new SpacesError({
        code: 'SPACES_NOT_FOUND',
        message: `Ticket ${id} disappeared after creation`,
        context: { id },
      });
    }
    return created;
  }

  /**
   * Update a ticket. Mirrors `updateItem` but exposes ticket-specific
   * fields (status, priority, assignee) via a typed patch. Returns the
   * freshly re-fetched ticket Item.
   */
  async updateTicket(id: string, patch: UpdateTicketPatch): Promise<Item> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'updateTicket requires a non-empty id',
        context: { id },
      });
    }
    const params: Record<string, unknown> = {
      id,
      title: null,
      description: null,
      status: null,
      priority: null,
      assigneeId: null,
    };
    if (typeof patch.title === 'string') {
      params['title'] = validateTitle(patch.title);
    }
    if (typeof patch.description === 'string') {
      params['description'] = validateOptionalDescription(patch.description);
    }
    if (patch.status !== undefined) {
      if (!(TICKET_STATUS_SET as Set<string>).has(patch.status)) {
        throw new SpacesError({
          code: 'SPACES_INVALID_INPUT',
          message: `Unknown ticket status ${String(patch.status)}`,
          context: { status: patch.status },
        });
      }
      // ADR-055 — required checklists gate transitions BEFORE the write.
      await this.assertTicketStatusAllowed(id, patch.status);
      params['status'] = patch.status;
    }
    if (patch.priority !== undefined) {
      if (!(TICKET_PRIORITIES as Set<string>).has(patch.priority)) {
        throw new SpacesError({
          code: 'SPACES_INVALID_INPUT',
          message: `Unknown priority ${String(patch.priority)}`,
          context: { priority: patch.priority },
        });
      }
      params['priority'] = patch.priority;
    }
    if (patch.assigneeId !== undefined) {
      // null clears the assignment; a non-empty string sets / re-MERGES it.
      params['assigneeId'] =
        typeof patch.assigneeId === 'string' && patch.assigneeId.length > 0
          ? patch.assigneeId
          : null;
    }
    params['now'] = nowIso();
    const rows = await this.run(CYPHER.UPDATE_TICKET, params);
    if (rows.length === 0) {
      throw new SpacesError({
        code: 'SPACES_NOT_FOUND',
        message: `Ticket ${id} not found`,
        remediation: 'It may have been deleted. Refresh and try again.',
        context: { id },
      });
    }
    const updated = await this.getItem(id);
    if (updated === null) {
      throw new SpacesError({
        code: 'SPACES_NOT_FOUND',
        message: `Ticket ${id} disappeared after update`,
        context: { id },
      });
    }
    return updated;
  }

  // ─── Asset CRUD (Sprint 1) ───────────────────────────────────────────

  /**
   * Create a new asset. When `input.spaceId` is non-empty, the asset
   * is linked to that Space; passing an empty string takes the
   * Uncategorized intake path.
   *
   * Returns the freshly-fetched Item via a follow-up `getItem` so
   * callers never see a half-populated row.
   *
   * @throws {SpacesError} `SPACES_INVALID_INPUT` for empty title or
   *   unknown kind; `SPACES_NOT_FOUND` if the target Space is missing.
   */
  async createAsset(input: CreateAssetInput): Promise<Item> {
    const title = validateTitle(input.title);
    const description = validateOptionalDescription(input.description ?? '');
    const content = typeof input.content === 'string' ? input.content : '';
    const fileKey =
      typeof input.fileKey === 'string' && input.fileKey.length > 0
        ? input.fileKey
        : null;
    const mimeType =
      typeof input.mimeType === 'string' && input.mimeType.length > 0
        ? input.mimeType
        : null;
    const sourceUrl =
      typeof input.sourceUrl === 'string' && input.sourceUrl.length > 0
        ? input.sourceUrl
        : null;
    const size =
      typeof input.size === 'number' && Number.isFinite(input.size) && input.size >= 0
        ? Math.floor(input.size)
        : null;
    // Kind inference: if explicit, use it; else infer from payload.
    let kind: ItemKind;
    if (input.kind !== undefined && (ITEM_KINDS as Set<string>).has(input.kind)) {
      kind = input.kind;
    } else if (fileKey !== null) {
      kind = 'other';
    } else if (sourceUrl !== null) {
      kind = 'url';
    } else if (content.length > 0) {
      kind = 'text';
    } else {
      kind = 'other';
    }
    const creatorId =
      typeof input.creatorId === 'string' && input.creatorId.length > 0
        ? input.creatorId
        : null;
    const id = generateAssetId();
    const now = nowIso();
    const metadata = stringifyMetadata(input.metadata);
    const params = {
      id,
      kind,
      title,
      content,
      description,
      fileKey,
      sourceUrl,
      mimeType,
      size,
      metadata,
      creatorId,
      now,
      commitAuthor:
        typeof input.creatorName === 'string' && input.creatorName.trim().length > 0
          ? input.creatorName.trim().slice(0, 120)
          : creatorId,
      commitHash: generateCommitHash(),
      commitTimestampMs: Date.now(),
    };
    const targetSpaceId =
      typeof input.spaceId === 'string' && input.spaceId.length > 0
        ? input.spaceId
        : null;
    if (targetSpaceId === null) {
      // Uncategorized intake path — no [:BELONGS_TO] edge.
      await this.run(CYPHER.CREATE_ASSET_UNCATEGORIZED, params);
    } else {
      const rows = await this.run(CYPHER.CREATE_ASSET, {
        ...params,
        spaceId: targetSpaceId,
      });
      if (rows.length === 0) {
        throw new SpacesError({
          code: 'SPACES_NOT_FOUND',
          message: `Space ${targetSpaceId} not found`,
          remediation: 'Refresh the list and try again.',
          context: { spaceId: targetSpaceId },
        });
      }
    }
    const created = await this.getItemAfterCreate(id);
    if (created === null) {
      throw new SpacesError({
        code: 'SPACES_NOT_FOUND',
        message: `Asset ${id} disappeared after creation`,
        context: { id },
      });
    }
    return created;
  }

  /**
   * Create an agent in a Space (see CYPHER.CREATE_AGENT). The OKF text
   * is stored as the asset's inline `content`. Writes the Space-facing
   * `:Asset {type:'agent'}` + parent `:Agent` + typed child node in one
   * transaction, then returns the freshly-fetched Item (kind 'agent').
   *
   * @throws {SpacesError} `SPACES_INVALID_INPUT` for empty name/okf or
   *   missing spaceId; `SPACES_NOT_FOUND` if the target Space is missing.
   */
  async createAgent(input: CreateAgentInput): Promise<Item> {
    const name = validateTitle(input.name);
    const okf = typeof input.okf === 'string' ? input.okf : '';
    if (okf.trim().length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'An agent requires OKF definition text.',
        remediation: 'Paste a URL or text so Lite can convert it to OKF.',
        context: { op: 'createAgent' },
      });
    }
    const spaceId = typeof input.spaceId === 'string' ? input.spaceId.trim() : '';
    if (spaceId.length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'An agent must be added to a Space.',
        remediation: 'Open a Space first, then add the agent.',
        context: { op: 'createAgent' },
      });
    }
    const description = validateOptionalDescription(input.description ?? '');
    const agentType =
      typeof input.agentType === 'string' && input.agentType.trim().length > 0
        ? input.agentType.trim()
        : 'other';
    const sourceUrl =
      typeof input.sourceUrl === 'string' && input.sourceUrl.length > 0
        ? input.sourceUrl
        : null;
    const creatorId =
      typeof input.creatorId === 'string' && input.creatorId.length > 0
        ? input.creatorId
        : null;
    // Reachability endpoints (MCP / API / Skill). Stored as a JSON
    // property on the asset (cheap read) AND as per-kind child nodes.
    const endpoints = normalizeAgentEndpoints(input.endpoints);
    const agentEndpointsJson = endpoints.length > 0 ? JSON.stringify(endpoints) : '';
    const id = generateAssetId();
    const agentId = generateAssetId();
    const typeId = generateAssetId();
    const now = nowIso();
    // Dynamic per-type label, strictly sanitized (Cypher can't
    // parameterize labels; see sanitizeAgentTypeLabel).
    const cypher = CYPHER.CREATE_AGENT.replace(
      '__TYPE_LABEL__',
      sanitizeAgentTypeLabel(agentType)
    );
    const rows = await this.run(cypher, {
      id,
      agentId,
      typeId,
      spaceId,
      name,
      okf,
      description,
      sourceUrl,
      agentType,
      agentEndpointsJson,
      metadata: stringifyMetadata(undefined),
      creatorId,
      now,
    });
    if (rows.length === 0) {
      throw new SpacesError({
        code: 'SPACES_NOT_FOUND',
        message: `Space ${spaceId} not found`,
        remediation: 'Refresh the list and try again.',
        context: { spaceId },
      });
    }
    // Write each reachability endpoint as a per-kind child node
    // (separate writes: variable count + dynamic per-kind label).
    for (const ep of endpoints) {
      const epCypher = CYPHER.CREATE_AGENT_ENDPOINT.replace(
        '__KIND_LABEL__',
        sanitizeAgentTypeLabel(ep.kind)
      );
      await this.run(epCypher, {
        agentId,
        endpointId: generateAssetId(),
        kind: ep.kind,
        url: ep.url,
        channels: ep.channels.join(','),
        now,
      });
    }
    const created = await this.getItemAfterCreate(id);
    if (created === null) {
      throw new SpacesError({
        code: 'SPACES_NOT_FOUND',
        message: `Agent ${id} disappeared after creation`,
        context: { id },
      });
    }
    return created;
  }

  /**
   * Search the account's agent library (graph `:Agent` nodes) by
   * name/description substring. Empty query = alphabetical head.
   */
  async searchAgentLibrary(q: string, limit = 25): Promise<AgentLibraryEntry[]> {
    const query = typeof q === 'string' ? q.trim() : '';
    const cappedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = await this.run(CYPHER.AGENT_LIBRARY_SEARCH, {
      q: query,
      limit: cappedLimit,
    });
    // Skip malformed (id-less) rows — one junk node must not break
    // the whole directory (LIST_SPACE_MEMBERS behaves the same way).
    const out: AgentLibraryEntry[] = [];
    for (const r of rows) {
      const id = optString(r, 'id');
      if (id === undefined || id.length === 0) continue;
      out.push({
        id,
        name: optString(r, 'name') ?? '',
        description: optString(r, 'description') ?? '',
        agentType: optString(r, 'agentType') ?? 'other',
      });
    }
    return out;
  }

  /** True when a live asset points at the given GSX fileKey. */
  async assetExistsForFileKey(fileKey: string): Promise<boolean> {
    const rows = await this.run(CYPHER.FIND_ASSET_BY_FILE_KEY, { fileKey });
    return rows.length > 0;
  }

  /**
   * Search the account's people + agents for the add-member picker.
   * People sort first; empty query returns the alphabetical head.
   */
  async searchMemberLibrary(q: string, limit = 25): Promise<MemberLibraryEntry[]> {
    const query = typeof q === 'string' ? q.trim() : '';
    const cappedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = await this.run(CYPHER.MEMBER_LIBRARY_SEARCH, {
      q: query,
      limit: cappedLimit,
    });
    // Skip malformed (id-less) rows — same contract as the agent
    // library and LIST_SPACE_MEMBERS.
    const out: MemberLibraryEntry[] = [];
    for (const r of rows) {
      const id = optString(r, 'id');
      if (id === undefined || id.length === 0) continue;
      out.push({
        kind: optString(r, 'kind') === 'Agent' ? ('Agent' as const) : ('Person' as const),
        id,
        name: optString(r, 'name') ?? '',
        email: optString(r, 'email') ?? '',
      });
    }
    return out;
  }

  /**
   * Add a LIBRARY agent to a Space — references the existing `:Agent`
   * via `[:REPRESENTS]` (no new agent node), copies name/description
   * onto the asset, and registers any reachability endpoints on the
   * EXISTING agent.
   */
  async createAgentFromLibrary(input: CreateAgentFromLibraryInput): Promise<Item> {
    const spaceId = typeof input.spaceId === 'string' ? input.spaceId.trim() : '';
    const agentId = typeof input.agentId === 'string' ? input.agentId.trim() : '';
    if (spaceId.length === 0 || agentId.length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'Adding a library agent requires a Space and an agent.',
        remediation: 'Open a Space, then pick an agent from the library.',
        context: { op: 'createAgentFromLibrary' },
      });
    }
    const creatorId =
      typeof input.creatorId === 'string' && input.creatorId.length > 0
        ? input.creatorId
        : null;
    const requested = normalizeAgentEndpoints(input.endpoints);

    // Idempotent: picking the same agent for the same Space again
    // returns the existing tile instead of creating a twin.
    const existing = await this.run(CYPHER.FIND_AGENT_ASSET_IN_SPACE, {
      spaceId,
      agentId,
    });
    const existingId = existing.length > 0 ? optString(existing[0] ?? {}, 'id') : undefined;
    if (existingId !== undefined) {
      const found = await this.getItem(existingId);
      if (found !== null) return found;
    }

    // Merge the agent's EXISTING reachability with what the adder
    // typed, so the tile reports full reachability (requested wins on
    // kind+url collisions; both get deduped).
    const currentRows = await this.run(CYPHER.GET_AGENT_ENDPOINTS, { agentId });
    const current: AgentEndpoint[] = [];
    for (const r of currentRows) {
      const kind = optString(r, 'kind');
      const url = optString(r, 'url');
      if ((kind !== 'mcp' && kind !== 'api' && kind !== 'skill') || url === undefined || url.length === 0) continue;
      const channelsRaw = optString(r, 'channels') ?? '';
      current.push({
        kind,
        url,
        channels: channelsRaw.length > 0 ? channelsRaw.split(',') : [],
      });
    }
    const merged: AgentEndpoint[] = [...requested];
    for (const ep of current) {
      if (!merged.some((m) => m.kind === ep.kind && m.url === ep.url)) merged.push(ep);
    }
    const agentEndpointsJson = merged.length > 0 ? JSON.stringify(merged) : '';

    const id = generateAssetId();
    const now = nowIso();
    const rows = await this.run(CYPHER.CREATE_AGENT_FROM_LIBRARY, {
      id,
      spaceId,
      agentId,
      agentEndpointsJson,
      metadata: stringifyMetadata(undefined),
      creatorId,
      now,
    });
    if (rows.length === 0) {
      throw new SpacesError({
        code: 'SPACES_NOT_FOUND',
        message: `Space ${spaceId} or agent ${agentId} not found`,
        remediation: 'Refresh the library and try again.',
        context: { spaceId, agentId },
      });
    }
    // Register only the ADDER's endpoints on the shared agent —
    // MERGEd by (kind, url) so repeat registrations never duplicate
    // the agent's REACHABLE_VIA children.
    for (const ep of requested) {
      const epCypher = CYPHER.CREATE_AGENT_ENDPOINT_MERGED.replace(
        '__KIND_LABEL__',
        sanitizeAgentTypeLabel(ep.kind)
      );
      await this.run(epCypher, {
        agentId,
        endpointId: generateAssetId(),
        kind: ep.kind,
        url: ep.url,
        channels: ep.channels.join(','),
        now,
      });
    }
    const created = await this.getItemAfterCreate(id);
    if (created === null) {
      throw new SpacesError({
        code: 'SPACES_NOT_FOUND',
        message: `Asset ${id} disappeared after creation`,
        context: { id },
      });
    }
    return created;
  }

  /**
   * Soft delete an asset (default) or hard delete (when
   * `opts.soft === false`). Soft is the boring default — reversible
   * via `restoreAsset`, and the asset disappears from every listing
   * because the read queries filter `WHERE a.deletedAt IS NULL`.
   *
   * @throws {SpacesError} `SPACES_INVALID_INPUT` for empty id;
   *   `SPACES_NOT_FOUND` if the soft-delete path finds nothing to
   *   delete (id missing OR already soft-deleted).
   */
  async deleteAsset(id: string, opts: DeleteAssetOpts = {}): Promise<void> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'deleteAsset requires a non-empty id',
        context: { id },
      });
    }
    const soft = opts.soft !== false;
    if (soft) {
      const now = nowIso();
      const rows = await this.run(CYPHER.SOFT_DELETE_ASSET, { id, now });
      if (rows.length === 0) {
        throw new SpacesError({
          code: 'SPACES_NOT_FOUND',
          message: `Asset ${id} not found (it may already be deleted)`,
          context: { id },
        });
      }
      return;
    }
    await this.run(CYPHER.HARD_DELETE_ASSET, { id });
  }

  /**
   * Restore a soft-deleted asset. Idempotent at the renderer layer
   * (the SDK throws if there's nothing to restore so callers see
   * exactly what happened).
   */
  async restoreAsset(id: string): Promise<Item> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'restoreAsset requires a non-empty id',
        context: { id },
      });
    }
    const now = nowIso();
    const rows = await this.run(CYPHER.RESTORE_ASSET, { id, now });
    if (rows.length === 0) {
      throw new SpacesError({
        code: 'SPACES_NOT_FOUND',
        message: `Asset ${id} not found or wasn't soft-deleted`,
        context: { id },
      });
    }
    const restored = await this.getItem(id);
    if (restored === null) {
      throw new SpacesError({
        code: 'SPACES_NOT_FOUND',
        message: `Asset ${id} disappeared after restore`,
        context: { id },
      });
    }
    return restored;
  }

  // ─── Metadata mutations ──────────────────────────────────────────────

  /**
   * Replace the whole metadata bag on an asset. Pass an empty
   * `{}` to clear. Idempotent.
   */
  async setMetadata(id: string, metadata: ItemMetadata): Promise<Item> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'setMetadata requires a non-empty id',
        context: { id },
      });
    }
    const serialized = stringifyMetadata(metadata);
    const now = nowIso();
    const rows = await this.run(CYPHER.SET_METADATA, {
      id,
      metadata: serialized,
      now,
    });
    if (rows.length === 0) {
      throw new SpacesError({
        code: 'SPACES_NOT_FOUND',
        message: `Asset ${id} not found`,
        context: { id },
      });
    }
    const updated = await this.getItem(id);
    if (updated === null) {
      throw new SpacesError({
        code: 'SPACES_NOT_FOUND',
        message: `Asset ${id} disappeared after metadata write`,
        context: { id },
      });
    }
    return updated;
  }

  /**
   * Merge a patch into the existing metadata bag. Reads the current
   * metadata, applies the patch (shallow merge — new keys add, same
   * keys overwrite, `null` value removes), writes the result.
   *
   * Not atomic across racing writers — last-writer-wins by design.
   */
  async patchMetadata(id: string, patch: ItemMetadata): Promise<Item> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'patchMetadata requires a non-empty id',
        context: { id },
      });
    }
    const current = await this.getItem(id);
    if (current === null) {
      throw new SpacesError({
        code: 'SPACES_NOT_FOUND',
        message: `Asset ${id} not found`,
        context: { id },
      });
    }
    const merged: ItemMetadata = { ...(current.metadata ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      // null in the patch means "remove this key"; primitives + arrays
      // set the value.
      if (value === null) {
        delete merged[key];
      } else {
        const normalized = normalizeMetadataValue(value);
        if (normalized !== undefined) merged[key] = normalized;
      }
    }
    return this.setMetadata(id, merged);
  }

  /** Remove a single metadata key. No-op if the key was already absent. */
  async removeMetadataKey(id: string, key: string): Promise<Item> {
    if (typeof key !== 'string' || key.length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'removeMetadataKey requires a non-empty key',
        context: { key },
      });
    }
    // Implement as a patch with `null` — the patch path already
    // handles delete semantics.
    return this.patchMetadata(id, { [key]: null });
  }

  // ─── Sprint 3: move / copy / search ──────────────────────────────────

  /**
   * Move an asset to a different Space. If `fromSpaceId` is empty, the
   * asset was uncategorized and only the new [:BELONGS_TO] edge is
   * created. Asset stays in any other spaces it was in.
   *
   * @throws {SpacesError} `SPACES_INVALID_INPUT` for empty id/toSpaceId;
   *   `SPACES_NOT_FOUND` if asset OR target is missing.
   */
  async moveAssetToSpace(
    id: string,
    fromSpaceId: string | null,
    toSpaceId: string
  ): Promise<Item> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'moveAssetToSpace requires a non-empty id',
        context: { id },
      });
    }
    if (typeof toSpaceId !== 'string' || toSpaceId.length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'moveAssetToSpace requires a non-empty toSpaceId',
        context: { toSpaceId },
      });
    }
    const now = nowIso();
    const params = {
      id,
      fromSpaceId:
        typeof fromSpaceId === 'string' && fromSpaceId.length > 0
          ? fromSpaceId
          : null,
      toSpaceId,
      now,
    };
    const rows = await this.run(CYPHER.MOVE_ASSET_TO_SPACE, params);
    if (rows.length === 0) {
      throw new SpacesError({
        code: 'SPACES_NOT_FOUND',
        message: 'Asset or target space not found',
        context: { id, toSpaceId },
      });
    }
    const moved = await this.getItem(id);
    if (moved === null) {
      throw new SpacesError({
        code: 'SPACES_NOT_FOUND',
        message: `Asset ${id} disappeared after move`,
        context: { id },
      });
    }
    return moved;
  }

  /**
   * Add an asset to ANOTHER space (multi-space membership). Idempotent.
   * Returns the re-fetched Item so callers see the updated otherSpaces
   * projection.
   */
  async addAssetToSpace(id: string, toSpaceId: string): Promise<Item> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'addAssetToSpace requires a non-empty id',
        context: { id },
      });
    }
    if (typeof toSpaceId !== 'string' || toSpaceId.length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'addAssetToSpace requires a non-empty toSpaceId',
        context: { toSpaceId },
      });
    }
    const now = nowIso();
    const rows = await this.run(CYPHER.ADD_ASSET_TO_SPACE, {
      id,
      toSpaceId,
      now,
    });
    if (rows.length === 0) {
      throw new SpacesError({
        code: 'SPACES_NOT_FOUND',
        message: 'Asset or target space not found',
        context: { id, toSpaceId },
      });
    }
    const updated = await this.getItem(id);
    if (updated === null) {
      throw new SpacesError({
        code: 'SPACES_NOT_FOUND',
        message: `Asset ${id} disappeared after add`,
        context: { id },
      });
    }
    return updated;
  }

  /**
   * Remove an asset from a specific space. Does NOT soft-delete the
   * asset — it just drops one [:BELONGS_TO] edge. If the asset is in
   * no other spaces, it lands in Uncategorized.
   */
  async removeAssetFromSpace(id: string, spaceId: string): Promise<Item> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'removeAssetFromSpace requires a non-empty id',
        context: { id },
      });
    }
    if (typeof spaceId !== 'string' || spaceId.length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'removeAssetFromSpace requires a non-empty spaceId',
        context: { spaceId },
      });
    }
    const now = nowIso();
    await this.run(CYPHER.REMOVE_ASSET_FROM_SPACE, { id, spaceId, now });
    const updated = await this.getItem(id);
    if (updated === null) {
      throw new SpacesError({
        code: 'SPACES_NOT_FOUND',
        message: `Asset ${id} disappeared after remove-from-space`,
        context: { id },
      });
    }
    return updated;
  }

  /**
   * Search assets by title/description/excerpt substring. Returns an
   * `ItemSummary[]` matching the LIST_ITEMS_* row shape so callers
   * can render results in the existing item-card chrome.
   */
  async searchItems(opts: SearchItemsOpts): Promise<ItemSummary[]> {
    const query = typeof opts.query === 'string' ? opts.query.trim() : '';
    if (query.length === 0) return [];
    const spaceId =
      typeof opts.spaceId === 'string' && opts.spaceId.length > 0
        ? opts.spaceId
        : null;
    const limit = clampSmallLimit(opts.limit, 50, 200);
    const rows = await this.run(CYPHER.SEARCH_ITEMS, {
      viewerId: this.viewerParam(),
      query,
      spaceId,
      limit,
    });
    return rows.map((row) =>
      toItemSummary(row as Record<string, unknown>, { stripOtherSpaces: false })
    );
  }

  // ─── Identity + sharing (Phase 4 v2) ─────────────────────────────────

  /**
   * Upsert a Person by id. Idempotent — calling with the same id is a
   * no-op aside from a touched `updatedAt`. The renderer calls this on
   * boot to map the active OneReach account to a :Person row that
   * `[:CREATED]` / `[:LAST_EDITED]` / `[:ASSIGNED_TO]` edges can MERGE
   * against.
   *
   * @throws {SpacesError} `SPACES_INVALID_INPUT` if `id` is empty.
   */
  async getOrCreatePerson(input: PersonUpsertInput): Promise<Person> {
    if (typeof input.id !== 'string' || input.id.length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'getOrCreatePerson requires a non-empty id',
        context: { id: input.id },
      });
    }
    const id = input.id.trim();
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const email = typeof input.email === 'string' ? input.email.trim() : '';
    const now = nowIso();
    const rows = await this.run(CYPHER.MERGE_PERSON, { id, name, email, now });
    const row = rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) {
      // MERGE should always return one row, but if the Neo4j adapter
      // for some reason swallows it, return what the user supplied so
      // the renderer never crashes.
      return { id, name };
    }
    const person: Person = {
      id: requireString(row, 'id'),
      name: optString(row, 'name') ?? '',
    };
    const e = optString(row, 'email');
    if (e !== undefined && e.length > 0) person.email = e;
    return person;
  }

  /**
   * List the members (Persons + Agents with `[:HAS_ACCESS]`) of a
   * Space. Used by the shared-space dashboard to show the team chip
   * row + by the assignee picker to enumerate who can take a ticket.
   */
  async listSpaceMembers(spaceId: string): Promise<SpaceMember[]> {
    const validId = validateSpaceId(spaceId);
    const rows = await this.run(CYPHER.LIST_SPACE_MEMBERS, { spaceId: validId });
    const out: SpaceMember[] = [];
    for (const raw of rows) {
      const r = raw as Record<string, unknown>;
      const id = optString(r, 'id');
      if (id === undefined || id.length === 0) continue;
      const expiry = r['expiresUnixMs'];
      out.push({
        kind: optString(r, 'kind') ?? 'Person',
        id,
        name: optString(r, 'name') ?? '',
        ...(typeof expiry === 'number'
          ? { accessExpiresAt: new Date(expiry).toISOString() }
          : {}),
      });
    }
    return out;
  }

  /**
   * Add a Person or Agent as a member of a Space. Idempotent — calling
   * with the same memberId twice is a no-op (the MERGE deduplicates).
   *
   * @throws {SpacesError} `SPACES_NOT_FOUND` if either the Space or
   *   the principal is missing.
   */
  async addSpaceMember(
    spaceId: string,
    memberId: string,
    opts: AddSpaceMemberOptions = {}
  ): Promise<SpaceMember> {
    const validSpaceId = validateSpaceId(spaceId);
    if (typeof memberId !== 'string' || memberId.length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'addSpaceMember requires a non-empty memberId',
        context: { memberId },
      });
    }
    // Three distinct intents, and conflating them loses access control:
    //   - `expiresAt` absent      -> leave any existing grant alone
    //   - `expiresAt: null`       -> make it permanent
    //   - `expiresAt: <iso>`      -> expire at that instant
    const writeExpiry = 'expiresAt' in opts;
    const expiresUnixMs =
      opts.expiresAt === undefined || opts.expiresAt === null
        ? null
        : parseGrantExpiry(opts.expiresAt, this.now());
    const rows = await this.run(CYPHER.ADD_SPACE_MEMBER, {
      spaceId: validSpaceId,
      memberId,
      writeExpiry,
      expiresUnixMs,
    });
    const row = rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) {
      throw new SpacesError({
        code: 'SPACES_NOT_FOUND',
        message: 'Space or member not found',
        remediation: 'Verify both ids exist.',
        context: { spaceId: validSpaceId, memberId },
      });
    }
    const expiry = row['expiresUnixMs'];
    return {
      kind: optString(row, 'kind') ?? 'Person',
      id: requireString(row, 'id'),
      name: optString(row, 'name') ?? '',
      ...(typeof expiry === 'number'
        ? { accessExpiresAt: new Date(expiry).toISOString() }
        : {}),
    };
  }

  /**
   * Remove a member's access to a Space.
   *
   * SECURITY (2026-08-08 release review): this is an access REVOKE, so
   * the result is verified rather than assumed. The Cypher returns the
   * deleted-edge count; zero means nothing was removed (the member was
   * already absent, or the Space is not visible to this viewer), and an
   * empty result means the query itself failed (Edison surfaces Cypher
   * errors as empty 200s). Both throw — a revoke that did not happen
   * must never look done.
   */
  async removeSpaceMember(spaceId: string, memberId: string): Promise<void> {
    const validSpaceId = validateSpaceId(spaceId);
    if (typeof memberId !== 'string' || memberId.length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'removeSpaceMember requires a non-empty memberId',
        context: { memberId },
      });
    }
    const rows = await this.run(CYPHER.REMOVE_SPACE_MEMBER, {
      spaceId: validSpaceId,
      memberId,
    });
    const row = rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) {
      throw new SpacesError({
        code: 'SPACES_CYPHER',
        message: 'Member removal returned no result — access may NOT have been revoked.',
        remediation: 'Retry, then re-open the member list to verify the grant is gone.',
        context: { op: 'members.remove', spaceId: validSpaceId, memberId },
      });
    }
    const deleted = typeof row['deleted'] === 'number' ? row['deleted'] : 0;
    if (deleted === 0) {
      throw new SpacesError({
        code: 'SPACES_NOT_FOUND',
        message:
          'No access grant was removed — the member may already be gone, or the Space is not visible to you.',
        remediation: 'Refresh the member list to confirm the current state.',
        context: { op: 'members.remove', spaceId: validSpaceId, memberId },
      });
    }
  }

  /** @internal -- helper for disambiguating empty mutation results. */
  private async spaceExists(id: string): Promise<boolean> {
    const rows = await this.run(CYPHER.SPACE_EXISTS_BY_ID, { id });
    return toCount(rows[0]) > 0;
  }

  /**
   * Wraps the injected query function and translates underlying
   * errors into `SpacesError` so callers always see one stable
   * exception type. Errors that are already `SpacesError` pass
   * through unchanged.
   */
  /** ADR-051 — the `$viewerId` bound into every gated query. */
  private viewerParam(): string {
    const raw = this.getViewerId !== null ? this.getViewerId() : null;
    return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  }


  // ─── Checklists (ADR-055) ────────────────────────────────────────────

  /**
   * Create a checklist in a Space. Validation enforces the doctrine the
   * schema encodes: a real mode, a stated pause point, and a list short
   * enough to actually run — reject, don't truncate.
   */
  async createChecklist(input: CreateChecklistInput): Promise<Checklist> {
    return this.withSpan('spaces.checklists.create', async () => {
      const spaceId = validateSpaceId(input.spaceId);
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (name.length === 0 || name.length > 120) {
        throw new SpacesError({
          code: 'SPACES_INVALID_INPUT',
          message: 'Checklist name must be 1–120 characters',
          context: { op: 'checklists.create' },
        });
      }
      if (!(CHECKLIST_MODES as readonly string[]).includes(input.mode)) {
        throw new SpacesError({
          code: 'SPACES_INVALID_INPUT',
          message: `Checklist mode must be DO-CONFIRM or READ-DO (got ${String(input.mode)})`,
          remediation:
            'DO-CONFIRM: work from memory, then pause and confirm. READ-DO: read each item and do it.',
          context: { op: 'checklists.create' },
        });
      }
      const pausePoint = typeof input.pausePoint === 'string' ? input.pausePoint.trim() : '';
      if (pausePoint.length === 0) {
        throw new SpacesError({
          code: 'SPACES_INVALID_INPUT',
          message: 'A checklist needs a pause point — WHEN it runs ("before merge").',
          remediation: 'Checklists run at defined pause points; without one it is just a list.',
          context: { op: 'checklists.create' },
        });
      }
      const items = sanitizeChecklistItems(input.items);
      const id = generateChecklistId();
      await this.run(CYPHER.CREATE_CHECKLIST, {
        spaceId,
        id,
        name,
        mode: input.mode,
        pausePoint,
        itemsJson: JSON.stringify(items),
        itemCount: items.length,
        requiredIdx: requiredIndexes(items),
        now: this.now(),
        viewerId: this.viewerParam(),
      });
      return { id, name, mode: input.mode, pausePoint, items, version: 1 };
    });
  }

  async updateChecklist(input: UpdateChecklistInput): Promise<{ id: string; version: number }> {
    return this.withSpan('spaces.checklists.update', async () => {
      const id = typeof input.id === 'string' ? input.id.trim() : '';
      if (id.length === 0) {
        throw new SpacesError({
          code: 'SPACES_INVALID_INPUT',
          message: 'Checklist id is required',
          context: { op: 'checklists.update' },
        });
      }
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (name.length === 0 || name.length > 120) {
        throw new SpacesError({
          code: 'SPACES_INVALID_INPUT',
          message: 'Checklist name must be 1–120 characters',
          context: { op: 'checklists.update' },
        });
      }
      if (!(CHECKLIST_MODES as readonly string[]).includes(input.mode)) {
        throw new SpacesError({
          code: 'SPACES_INVALID_INPUT',
          message: `Checklist mode must be DO-CONFIRM or READ-DO (got ${String(input.mode)})`,
          context: { op: 'checklists.update' },
        });
      }
      const pausePoint = typeof input.pausePoint === 'string' ? input.pausePoint.trim() : '';
      if (pausePoint.length === 0) {
        throw new SpacesError({
          code: 'SPACES_INVALID_INPUT',
          message: 'A checklist needs a pause point — WHEN it runs ("before merge").',
          context: { op: 'checklists.update' },
        });
      }
      const items = sanitizeChecklistItems(input.items);
      const rows = await this.run(CYPHER.UPDATE_CHECKLIST, {
        id,
        name,
        mode: input.mode,
        pausePoint,
        itemsJson: JSON.stringify(items),
        itemCount: items.length,
        requiredIdx: requiredIndexes(items),
        now: this.now(),
        viewerId: this.viewerParam(),
      });
      const row = rows[0];
      if (row === undefined) {
        throw new SpacesError({
          code: 'SPACES_NOT_FOUND',
          message: `Checklist not found: ${id}`,
          remediation: 'It may have been deleted, or you may not have access to its Space.',
          context: { op: 'checklists.update', id },
        });
      }
      // Revision resets every attached ticket's run state by design —
      // a check against v1's items says nothing about v2's.
      return { id, version: Number(row.version) };
    });
  }

  async deleteChecklist(id: string): Promise<void> {
    return this.withSpan('spaces.checklists.delete', async () => {
      const validId = typeof id === 'string' ? id.trim() : '';
      if (validId.length === 0) {
        throw new SpacesError({
          code: 'SPACES_INVALID_INPUT',
          message: 'Checklist id is required',
          context: { op: 'checklists.delete' },
        });
      }
      const counts = await this.run(CYPHER.COUNT_CHECKLIST_ATTACHMENTS, {
        id: validId,
        viewerId: this.viewerParam(),
      });
      if (counts.length === 0) {
        throw new SpacesError({
          code: 'SPACES_NOT_FOUND',
          message: `Checklist not found: ${validId}`,
          remediation: 'It may have been deleted, or you may not have access to its Space.',
          context: { op: 'checklists.delete', id: validId },
        });
      }
      const attached = Number(counts[0]?.attachedCount ?? 0);
      if (attached > 0) {
        throw new SpacesError({
          code: 'SPACES_CHECKLIST_ATTACHED',
          message: `Checklist is attached to ${attached} ticket${attached === 1 ? '' : 's'}`,
          remediation:
            'Detach it from every ticket first. Deleting a checklist out from under a REQUIRED gate would silently un-gate those tickets.',
          context: { op: 'checklists.delete', id: validId, attached },
        });
      }
      await this.run(CYPHER.DELETE_CHECKLIST, {
        id: validId,
        viewerId: this.viewerParam(),
      });
    });
  }

  async listChecklists(spaceId: string): Promise<Checklist[]> {
    return this.withSpan('spaces.checklists.list', async () => {
      const validId = validateSpaceId(spaceId);
      const rows = await this.run(CYPHER.LIST_CHECKLISTS_IN_SPACE, {
        spaceId: validId,
        viewerId: this.viewerParam(),
      });
      return rows
        .map((raw) => rowToChecklist(raw as Record<string, unknown>))
        .filter((c): c is Checklist => c !== null);
    });
  }

  async attachChecklist(input: AttachChecklistInput): Promise<void> {
    return this.withSpan('spaces.checklists.attach', async () => {
      if (!(CHECKLIST_OBLIGATIONS as readonly string[]).includes(input.obligation)) {
        throw new SpacesError({
          code: 'SPACES_INVALID_INPUT',
          message: `Obligation must be required | recommended | optional (got ${String(input.obligation)})`,
          context: { op: 'checklists.attach' },
        });
      }
      const cypher =
        input.phase === 'preflight'
          ? CYPHER.ATTACH_CHECKLIST_PREFLIGHT
          : CYPHER.ATTACH_CHECKLIST_POSTFLIGHT;
      const rows = await this.run(cypher, {
        ticketId: input.ticketId,
        checklistId: input.checklistId,
        obligation: input.obligation,
        viewerId: this.viewerParam(),
      });
      if (rows.length === 0) {
        throw new SpacesError({
          code: 'SPACES_NOT_FOUND',
          message: 'Ticket or checklist not found (or not visible to you).',
          context: { op: 'checklists.attach', ticketId: input.ticketId },
        });
      }
    });
  }

  async getTicketChecklists(ticketId: string): Promise<TicketChecklist[]> {
    const rows = await this.run(CYPHER.GET_TICKET_CHECKLISTS, {
      ticketId,
      viewerId: this.viewerParam(),
    });
    const row = rows[0] as Record<string, unknown> | undefined;
    const links = Array.isArray(row?.['links']) ? (row['links'] as unknown[]) : [];
    const out: TicketChecklist[] = [];
    for (const raw of links) {
      const link = rowToTicketChecklist(raw as Record<string, unknown>);
      if (link !== null) out.push(link);
    }
    return out;
  }

  async setChecklistItem(input: SetChecklistItemInput): Promise<{ checkedIndexes: number[]; complete: boolean }> {
    return this.withSpan('spaces.checklists.check', async () => {
      if (!Number.isInteger(input.itemIndex) || input.itemIndex < 0) {
        throw new SpacesError({
          code: 'SPACES_INVALID_INPUT',
          message: 'itemIndex must be a non-negative integer',
          context: { op: 'checklists.check' },
        });
      }
      const cypher =
        input.phase === 'preflight'
          ? CYPHER.SET_CHECKLIST_ITEM_PREFLIGHT
          : CYPHER.SET_CHECKLIST_ITEM_POSTFLIGHT;
      const rows = await this.run(cypher, {
        ticketId: input.ticketId,
        checklistId: input.checklistId,
        itemIndex: input.itemIndex,
        checked: input.checked === true,
        actorId: typeof input.actorId === 'string' ? input.actorId : this.viewerParam(),
        now: this.now(),
        viewerId: this.viewerParam(),
      });
      const row = rows[0] as Record<string, unknown> | undefined;
      if (row === undefined) {
        throw new SpacesError({
          code: 'SPACES_NOT_FOUND',
          message: 'Ticket, checklist, or attachment not found.',
          context: { op: 'checklists.check', ticketId: input.ticketId },
        });
      }
      const idx = Array.isArray(row['checkedIdx'])
        ? (row['checkedIdx'] as unknown[]).filter((n): n is number => typeof n === 'number')
        : [];
      return { checkedIndexes: idx, complete: row['complete'] === true };
    });
  }

  async detachChecklist(
    ticketId: string,
    checklistId: string,
    phase: 'preflight' | 'postflight'
  ): Promise<void> {
    return this.withSpan('spaces.checklists.detach', async () => {
      const cypher =
        phase === 'preflight'
          ? CYPHER.DETACH_CHECKLIST_PREFLIGHT
          : CYPHER.DETACH_CHECKLIST_POSTFLIGHT;
      await this.run(cypher, { ticketId, checklistId, viewerId: this.viewerParam() });
    });
  }

  /**
   * ADR-055 — the status gate. A ticket with an incomplete REQUIRED
   * preflight cannot leave `open`; one with an incomplete REQUIRED
   * postflight cannot enter `done`. `recommended` never blocks — the
   * renderer warns instead, because a gate people can't distinguish
   * from bureaucracy gets worked around, which is worse than no gate.
   */
  async assertTicketStatusAllowed(ticketId: string, targetStatus: string): Promise<void> {
    const leavingOpen = targetStatus === 'in_progress' || targetStatus === 'done';
    const enteringDone = targetStatus === 'done';
    if (!leavingOpen && !enteringDone) return;
    const rows = await this.run(CYPHER.TICKET_GATE_STATE, {
      ticketId,
      viewerId: this.viewerParam(),
    });
    const row = rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return; // not found -> the update itself will fail
    const current = typeof row['currentStatus'] === 'string' ? row['currentStatus'] : 'open';
    const pre = readGateLinks(row['requiredPre']);
    const post = readGateLinks(row['requiredPost']);
    const blockers: string[] = [];
    // Preflight gates STARTING work: entering in_progress/done from any
    // not-yet-started status. Gating only `current === 'open'` left a
    // bypass — park the ticket (`blocked` is deliberately ungated) and
    // move on from there, and the required preflight never ran
    // (2026-08-08 review). A ticket already past open (in_progress)
    // stays un-re-gated on its way to done; that is postflight's job.
    const notYetStarted = current === 'open' || current === 'blocked';
    if (leavingOpen && notYetStarted) {
      for (const g of pre) if (!g.complete) blockers.push(`preflight “${g.name}”`);
    }
    if (enteringDone) {
      for (const g of post) if (!g.complete) blockers.push(`postflight “${g.name}”`);
    }
    if (blockers.length > 0) {
      throw new SpacesError({
        code: 'SPACES_CHECKLIST_REQUIRED',
        message: `Required checklist${blockers.length > 1 ? 's' : ''} incomplete: ${blockers.join(', ')}`,
        remediation:
          'Run the checklist from the ticket pane, or downgrade its obligation if it no longer applies.',
        context: { op: 'tickets.update', ticketId, targetStatus },
      });
    }
  }

  /**
   * ADR-055 — write the Checklist entity + both relationship types into
   * the graph's `(:Schema)` registry. Idempotent; runs at init.
   */
  async ensureChecklistSchema(): Promise<void> {
    try {
      await this.run(CYPHER.ENSURE_CHECKLIST_SCHEMA, {
        now: this.now(),
        checklistDoc:
          'A runnable checklist (The Checklist Manifesto): mode DO-CONFIRM|READ-DO, a stated pause point, 1–12 items (killer items flagged), versioned as a living document. Belongs to a Space via BELONGS_TO.',
        checklistProps: JSON.stringify({
          id: 'string (checklist-<ts36>-<rand>)',
          name: 'string 1..120',
          mode: "enum 'DO-CONFIRM' | 'READ-DO'",
          pausePoint: 'string — when the checklist runs',
          items: 'JSON [{text, killer?}] max 12',
          itemCount: 'int — denormalized for atomic completion checks',
          version: 'int, starts 1',
          revisedAt: 'datetime?',
        }),
        preflightDoc: JSON.stringify({
          type: 'PREFLIGHT_CHECKLIST',
          from: 'Asset(kind=ticket)',
          to: 'Checklist',
          properties: {
            obligation: "enum 'required' | 'recommended' | 'optional'",
            checkedIdx: 'int[] — indexes checked for this ticket',
            completedAt: 'datetime?',
            lastCheckedBy: 'string?',
            lastCheckedAt: 'datetime?',
          },
          gate: "obligation=required blocks the ticket leaving 'open'",
        }),
        postflightDoc: JSON.stringify({
          type: 'POSTFLIGHT_CHECKLIST',
          from: 'Asset(kind=ticket)',
          to: 'Checklist',
          properties: {
            obligation: "enum 'required' | 'recommended' | 'optional'",
            checkedIdx: 'int[]',
            completedAt: 'datetime?',
            lastCheckedBy: 'string?',
            lastCheckedAt: 'datetime?',
          },
          gate: "obligation=required blocks the ticket entering 'done'",
        }),
      });
    } catch {
      // Registry write is best-effort; the feature works without it and
      // the next boot retries.
    }
  }

  private async run(
    cypher: string,
    parameters?: Record<string, unknown>
  ): Promise<Array<Record<string, unknown>>> {
    try {
      // `$nowMs` and `$viewerId` are injected for EVERY query rather
      // than bound per call site. Access grants can expire (ADR-052)
      // and visibility is viewer-relative (ADR-051), so the predicates
      // need both -- and they are interpolated into a dozen different
      // queries. Binding them at each one would mean a single forgotten
      // parameter silently breaking access control. That is not
      // hypothetical: LIST_TICKETS_IN_SPACE gained the visibility
      // predicate without its call site gaining `viewerId`, Neo4j
      // rejected the query for the missing parameter, the Edison flow
      // mapped the rejection to an empty result set, and every shared
      // dashboard showed "No tickets yet" against real data. Central
      // injection makes the omission impossible. Explicit values in
      // `parameters` still win, so tests can pin the clock or viewer.
      const withInjected =
        parameters === undefined
          ? { nowMs: this.now(), viewerId: this.viewerParam() }
          : { nowMs: this.now(), viewerId: this.viewerParam(), ...parameters };
      return await this.queryFn(cypher, withInjected);
    } catch (err) {
      throw normalizeError(err);
    }
  }
}

/**
 * ADR-052 — validate an access-grant expiry into epoch millis.
 *
 * Rejects rather than ignores, for the same reason `create-binary.ts`
 * rejects a bad file TTL: a grant the admin believes expires on Friday
 * but which was silently stored as permanent is a security hole that
 * looks like a working feature. A past instant is refused too — if the
 * intent is "no access", remove the member instead of adding one that
 * is dead on arrival.
 */
export function parseGrantExpiry(value: string, now: number): number {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SpacesError({
      code: 'SPACES_INVALID_INPUT',
      message: 'Access expiry must be a non-empty ISO-8601 timestamp',
      remediation: 'Pass an ISO string, null for permanent access, or omit to leave it unchanged.',
      context: { op: 'members.add', expiresAt: String(value) },
    });
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new SpacesError({
      code: 'SPACES_INVALID_INPUT',
      message: `Access expiry is not a valid date: ${value}`,
      remediation: 'Pass an ISO-8601 timestamp, or null for permanent access.',
      context: { op: 'members.add', expiresAt: value },
    });
  }
  if (parsed <= now) {
    throw new SpacesError({
      code: 'SPACES_INVALID_INPUT',
      message: 'Access expiry is in the past — the grant would be dead on arrival',
      remediation: 'Pick a future time, or remove the member instead of granting expired access.',
      context: { op: 'members.add', expiresAt: value },
    });
  }
  return parsed;
}

// ─── Mutation helpers (Phase 3a) ─────────────────────────────────────────

/**
 * Validate + normalize a Space name. Throws `SPACES_INVALID_INPUT` on
 * empty / too-long values. Trims whitespace.
 */
function validateSpaceName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new SpacesError({
      code: 'SPACES_INVALID_INPUT',
      message: 'Space name must be a string',
      remediation: 'Pass a non-empty string for the name field.',
      context: { received: typeof raw },
    });
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new SpacesError({
      code: 'SPACES_INVALID_INPUT',
      message: 'Space name cannot be empty',
      remediation: 'Enter a name -- it can be edited later.',
    });
  }
  if (trimmed.length > MAX_SPACE_NAME_LENGTH) {
    throw new SpacesError({
      code: 'SPACES_INVALID_INPUT',
      message: `Space name is too long (${trimmed.length} chars; max ${MAX_SPACE_NAME_LENGTH})`,
      remediation: `Shorten the name to ${MAX_SPACE_NAME_LENGTH} characters or fewer.`,
      context: { length: trimmed.length, max: MAX_SPACE_NAME_LENGTH },
    });
  }
  return trimmed;
}

/** Validate optional description; returns empty string when absent. */
function validateOptionalDescription(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') {
    throw new SpacesError({
      code: 'SPACES_INVALID_INPUT',
      message: 'Space description must be a string',
      remediation: 'Pass a string (or omit the field).',
      context: { received: typeof raw },
    });
  }
  const trimmed = raw.trim();
  if (trimmed.length > MAX_SPACE_DESC_LENGTH) {
    throw new SpacesError({
      code: 'SPACES_INVALID_INPUT',
      message: `Description is too long (${trimmed.length} chars; max ${MAX_SPACE_DESC_LENGTH})`,
      remediation: `Shorten the description to ${MAX_SPACE_DESC_LENGTH} characters or fewer.`,
      context: { length: trimmed.length, max: MAX_SPACE_DESC_LENGTH },
    });
  }
  return trimmed;
}

/** Validate a Space id (used by rename / delete / undelete). */
function validateSpaceId(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new SpacesError({
      code: 'SPACES_INVALID_INPUT',
      message: 'Space id must be a non-empty string',
      remediation: 'Pass an id taken from a prior listSpaces() result.',
      context: { received: typeof raw },
    });
  }
  return raw;
}

/**
 * Generate a stable, URL-safe Space id. Uses crypto.randomUUID() when
 * available (modern Node, Electron) and falls back to a timestamped
 * pseudo-random string for environments that don't have it.
 */
function generateSpaceId(): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c !== undefined && typeof c.randomUUID === 'function') {
      return `space-${c.randomUUID()}`;
    }
  } catch {
    /* fall through */
  }
  const rand = Math.random().toString(36).slice(2, 10);
  return `space-${Date.now().toString(36)}-${rand}`;
}

/**
 * Generate a ticket id. Same id strategy as Space (UUID with prefix)
 * so renderers can identify a ticket from its id alone when debugging.
 */
function generateTicketId(): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c !== undefined && typeof c.randomUUID === 'function') {
      return `ticket-${c.randomUUID()}`;
    }
  } catch {
    /* fall through */
  }
  const rand = Math.random().toString(36).slice(2, 10);
  return `ticket-${Date.now().toString(36)}-${rand}`;
}

/** Generate an :Asset id. Same UUID-with-prefix scheme as Space + Ticket. */
/** Git-shaped 40-hex commit hash (matches the existing Commit rows). */
function generateCommitHash(): string {
  const hex = '0123456789abcdef';
  let out = '';
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c !== undefined && typeof c.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(20));
    for (const b of bytes) out += hex[b >> 4]! + hex[b & 15]!;
    return out;
  }
  for (let i = 0; i < 40; i++) out += hex[Math.floor(Math.random() * 16)]!;
  return out;
}

function generateAssetId(): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c !== undefined && typeof c.randomUUID === 'function') {
      return `asset-${c.randomUUID()}`;
    }
  } catch {
    /* fall through */
  }
  const rand = Math.random().toString(36).slice(2, 10);
  return `asset-${Date.now().toString(36)}-${rand}`;
}

/**
 * Validate + normalize a ticket / item title. Throws
 * `SPACES_INVALID_INPUT` for empty or oversize values.
 */
function validateTitle(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new SpacesError({
      code: 'SPACES_INVALID_INPUT',
      message: 'title must be a string',
      context: { raw: typeof raw },
    });
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new SpacesError({
      code: 'SPACES_INVALID_INPUT',
      message: 'title must be non-empty after trim',
    });
  }
  if (trimmed.length > MAX_ITEM_TITLE_LENGTH) {
    throw new SpacesError({
      code: 'SPACES_INVALID_INPUT',
      message: `title must be ${MAX_ITEM_TITLE_LENGTH} chars or fewer`,
      context: { length: trimmed.length },
    });
  }
  return trimmed;
}

/** Single source of truth for the timestamp written to created/updated/deletedAt. */
function nowIso(): string {
  return new Date().toISOString();
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

/**
 * Normalize a timestamp coming off the graph into an ISO 8601 string.
 *
 * The graph is written by MORE THAN ONE app and they don't agree on the
 * format: Lite writes ISO strings (`2026-05-19T03:06:17.123Z`) while
 * GSX / WISER Playbooks writes **epoch milliseconds**
 * (`1785976501151`). The Cypher already coalesces the camelCase and
 * snake_case NAMES, but the VALUE still arrives in whichever shape its
 * writer used.
 *
 * Left unnormalized, the renderer's `Date.parse` returns NaN for the
 * epoch form, which meant GSX-written Spaces displayed a raw number
 * where a date belongs and always sank to the bottom of the
 * "Recently updated" sort. Converting at this boundary means every
 * consumer downstream gets one shape.
 *
 * Accepts: ISO strings (passed through), epoch millis, and epoch
 * seconds (10-digit values are widened) as either number or numeric
 * string. Returns undefined for anything it can't place, so callers
 * keep their existing "missing timestamp" behavior.
 */
export function normalizeGraphTimestamp(raw: unknown): string | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return epochToIso(raw);
  }
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  // All-digits => epoch. Anything else is treated as a date string.
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? epochToIso(n) : undefined;
  }
  // Already a date string: hand it back VERBATIM. Re-serializing would
  // rewrite '2026-01-01T00:00:00Z' as '...00.000Z' -- same instant, but
  // needless churn on data that was already correct, and anything
  // comparing these strings would see a spurious change.
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  return trimmed;
}

/** Epoch seconds (10 digits) or millis -> ISO. */
function epochToIso(n: number): string | undefined {
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // Values below ~1e12 are seconds (1e12 ms == 2001-09-09).
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  const t = d.getTime();
  if (!Number.isFinite(t)) return undefined;
  return d.toISOString();
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
  const createdAt = normalizeGraphTimestamp(optString(row, 'createdAt'));
  if (createdAt !== undefined) space.createdAt = createdAt;
  const updatedAt = normalizeGraphTimestamp(optString(row, 'updatedAt'));
  if (updatedAt !== undefined) space.updatedAt = updatedAt;
  const kind = optString(row, 'kind');
  if (kind === 'shared' || kind === 'user') space.kind = kind;
  const visibility = optString(row, 'visibility');
  if (visibility === 'open' || visibility === 'restricted') space.visibility = visibility;
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
    createdAt: normalizeGraphTimestamp(optString(row, 'createdAt')) ?? '',
    updatedAt: normalizeGraphTimestamp(optString(row, 'updatedAt')) ?? '',
    otherSpaces: opts.stripOtherSpaces ? [] : toChipList(row['otherSpaces']),
    producedBy: toProducedBy(row['producedBy']),
  };
  const fileKey = optString(row, 'fileKey');
  if (fileKey !== undefined) summary.fileKey = fileKey;
  const sourceUrl = optString(row, 'sourceUrl');
  if (sourceUrl !== undefined) summary.sourceUrl = sourceUrl;
  const excerpt = optString(row, 'excerpt');
  if (excerpt !== undefined) summary.excerpt = excerpt;
  const description = optString(row, 'description');
  if (description !== undefined) summary.description = description;
  const contentHead = optString(row, 'contentHead');
  if (contentHead !== undefined) summary.contentHead = contentHead;
  const tileAgentType = optString(row, 'tileAgentType');
  if (tileAgentType !== undefined) summary.agentType = tileAgentType;
  const tileEndpoints = parseAgentEndpointsJson(row['tileAgentEndpoints']);
  if (tileEndpoints !== null) summary.agentEndpoints = tileEndpoints;
  const tileMeta = parseMetadataField(row['tileMetadata']);
  if (tileMeta !== null) summary.metadata = tileMeta;
  return summary;
}

/** Parse the `a.agentEndpoints` JSON property; null on junk/absence. */
function parseAgentEndpointsJson(v: unknown): AgentEndpoint[] | null {
  if (typeof v !== 'string' || v.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(v) as unknown;
    if (!Array.isArray(parsed)) return null;
    const out: AgentEndpoint[] = [];
    for (const e of parsed) {
      const kind = (e as { kind?: unknown })?.kind;
      const url = (e as { url?: unknown })?.url;
      if (kind !== 'mcp' && kind !== 'api' && kind !== 'skill') continue;
      if (typeof url !== 'string' || url.length === 0) continue;
      const rawChannels = (e as { channels?: unknown })?.channels;
      const channels = Array.isArray(rawChannels)
        ? rawChannels.filter((c): c is string => typeof c === 'string')
        : [];
      out.push({ kind, url, channels });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function toItem(row: Record<string, unknown>): Item {
  const base = toItemSummary(row, { stripOtherSpaces: false });
  const item: Item = { ...base };
  const description = optString(row, 'description');
  if (description !== undefined) item.description = description;
  const content = optString(row, 'content');
  if (content !== undefined) item.content = content;
  const parsedMeta = parseMetadataField(row['metadata']);
  if (parsedMeta !== null) item.metadata = parsedMeta;
  // Phase A2 detail-pane projections. Each falls through to undefined
  // when the underlying field is missing so the renderer can branch
  // on presence rather than special-case sentinel values.
  const size = optNumber(row, 'size');
  if (size !== undefined && size >= 0) item.size = Math.floor(size);
  const mime = optString(row, 'mimeType');
  if (mime !== undefined) item.mimeType = mime;
  item.tags = toTagList(row['tags']);
  item.lastEditedBy = toProducedBy(row['lastEditedBy']);
  // Phase 4 (shared-space) ticket projection. Only populated when the
  // item is itself a ticket; for every other kind the GET_ITEM Cypher
  // returns sentinel values that toTicketStatus/toTicketPriority reject,
  // so item.ticket stays undefined.
  if (item.kind === 'ticket') {
    const status = toTicketStatus(row['ticketStatus']) ?? 'open';
    const ticket: TicketDetails = {
      status,
      assignee: toProducedBy(row['ticketAssignee']),
    };
    const priority = toTicketPriority(row['ticketPriority']);
    if (priority !== null) ticket.priority = priority;
    const playbookId = optString(row, 'ticketPlaybookId');
    if (playbookId !== undefined && playbookId.length > 0) {
      ticket.playbookId = playbookId;
    }
    item.ticket = ticket;
  }
  // Agent projection: surface the type discriminator + reachability
  // endpoints for the renderer.
  if (item.kind === 'agent') {
    const agentType = optString(row, 'agentType');
    if (agentType !== undefined && agentType.length > 0) {
      item.agentType = agentType;
    }
    const endpoints = parseAgentEndpoints(row['agentEndpoints']);
    if (endpoints.length > 0) {
      item.agentEndpoints = endpoints;
    }
  }
  return item;
}

/**
 * Map one row of LIST_TICKETS_IN_SPACE into an Item-shaped object with
 * the ticket substructure populated. Renderer code that knows how to
 * draw an Item draws a ticket without any new mapper.
 */
function toTicketItem(row: Record<string, unknown>): Item {
  const item: Item = {
    id: requireString(row, 'id'),
    title: optString(row, 'title') ?? '',
    kind: 'ticket',
    createdAt: normalizeGraphTimestamp(optString(row, 'createdAt')) ?? '',
    updatedAt: normalizeGraphTimestamp(optString(row, 'updatedAt')) ?? '',
    otherSpaces: [],
    producedBy: null,
  };
  const excerpt = optString(row, 'excerpt');
  if (excerpt !== undefined) item.excerpt = excerpt;
  const status = toTicketStatus(row['status']) ?? 'open';
  const ticket: TicketDetails = {
    status,
    assignee: toProducedBy(row['assignee']),
  };
  const priority = toTicketPriority(row['priority']);
  if (priority !== null) ticket.priority = priority;
  const playbookId = optString(row, 'playbookId');
  if (playbookId !== undefined && playbookId.length > 0) {
    ticket.playbookId = playbookId;
  }
  item.ticket = ticket;
  return item;
}

/**
 * Parse the `a.metadata` projection. The graph stores it as a JSON
 * string (Neo4j doesn't support nested map properties natively), so
 * we JSON.parse and defensively validate the shape.
 *
 * Returns `null` for missing/invalid metadata so the caller can skip
 * assigning the field entirely (preserves "undefined means not set").
 */
function parseMetadataField(v: unknown): ItemMetadata | null {
  if (v === null || v === undefined) return null;
  // Tolerate both legacy (object) and canonical (JSON string) forms.
  let parsed: unknown;
  if (typeof v === 'string') {
    if (v.length === 0) return null;
    try {
      parsed = JSON.parse(v);
    } catch {
      return null;
    }
  } else if (typeof v === 'object' && !Array.isArray(v)) {
    parsed = v;
  } else {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  // Validate each entry; drop unknown shapes (functions, nested maps).
  const out: ItemMetadata = {};
  for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.length === 0) continue;
    const value = normalizeMetadataValue(raw);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function normalizeMetadataValue(v: unknown): MetadataValue | undefined {
  if (v === null) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) {
    const arr: MetadataPrimitive[] = [];
    for (const item of v) {
      if (
        item === null ||
        typeof item === 'string' ||
        typeof item === 'number' ||
        typeof item === 'boolean'
      ) {
        arr.push(item as MetadataPrimitive);
      }
      // nested objects / functions inside arrays are dropped silently
    }
    return arr;
  }
  return undefined;
}

/**
 * Serialize an ItemMetadata bag for storage. Returns an empty string
 * for an empty bag so the graph property is still queryable but
 * doesn't pretend to have data.
 */
function stringifyMetadata(meta: ItemMetadata | undefined): string {
  if (meta === undefined) return '';
  const keys = Object.keys(meta);
  if (keys.length === 0) return '';
  // Round-trip through normalizeMetadataValue to drop invalid entries.
  const clean: ItemMetadata = {};
  for (const k of keys) {
    const v = normalizeMetadataValue(meta[k]);
    if (v !== undefined) clean[k] = v;
  }
  if (Object.keys(clean).length === 0) return '';
  return JSON.stringify(clean);
}

/**
 * Normalize the `tags` projection into a string[] regardless of whether
 * the graph stored them as an array property or projected from
 * `[:TAGGED_AS]->(:Tag)` edges. Drops empty/non-string entries.
 */
function toTagList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
  }
  return out;
}

const ITEM_KINDS: ReadonlySet<ItemKind> = new Set([
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
]);

/**
 * Turn a raw `agentType` string into a safe Cypher label
 * (PascalCase, ASCII alphanumerics only, leading letter guaranteed).
 * This is interpolated into CREATE_AGENT's `__TYPE_LABEL__` slot, so it
 * MUST NOT allow anything that could break out of the label position —
 * we strip everything except [A-Za-z0-9] and fall back to `Other`.
 */
function sanitizeAgentTypeLabel(agentType: unknown): string {
  const raw = typeof agentType === 'string' ? agentType : '';
  const pascal = raw
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  // Must start with a letter to be a valid label; default to 'Other'.
  const safe = /^[A-Za-z]/.test(pascal) ? pascal : '';
  return safe.length > 0 ? safe : 'Other';
}

const AGENT_ENDPOINT_KIND_SET: ReadonlySet<AgentEndpointKind> = new Set<AgentEndpointKind>([
  'mcp',
  'api',
  'skill',
]);

/** Defensive bound on channels kept per endpoint. */
const MAX_ENDPOINT_CHANNELS = 24;

/**
 * Normalize/validate the reachability endpoints from a CreateAgentInput:
 * drop entries with an unknown kind or empty url; trim + dedupe channels.
 */
function normalizeAgentEndpoints(raw: unknown): AgentEndpoint[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentEndpoint[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    const kind =
      typeof e['kind'] === 'string' ? (e['kind'] as string).trim().toLowerCase() : '';
    const url = typeof e['url'] === 'string' ? (e['url'] as string).trim() : '';
    if (!AGENT_ENDPOINT_KIND_SET.has(kind as AgentEndpointKind) || url.length === 0) continue;
    const channels: string[] = [];
    const seen = new Set<string>();
    const rawCh = Array.isArray(e['channels']) ? (e['channels'] as unknown[]) : [];
    for (const c of rawCh) {
      const s = typeof c === 'string' ? c.trim() : '';
      if (s.length === 0) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      channels.push(s);
      if (channels.length >= MAX_ENDPOINT_CHANNELS) break;
    }
    out.push({ kind: kind as AgentEndpointKind, url, channels });
  }
  return out;
}

/** Parse the asset's `agentEndpoints` JSON property back into objects. */
function parseAgentEndpoints(raw: unknown): AgentEndpoint[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  try {
    return normalizeAgentEndpoints(JSON.parse(raw));
  } catch {
    return [];
  }
}

function toItemKind(v: unknown): ItemKind {
  return typeof v === 'string' && (ITEM_KINDS as Set<string>).has(v) ? (v as ItemKind) : 'other';
}

const TICKET_STATUS_SET: ReadonlySet<TicketStatus> = new Set<TicketStatus>([
  'open',
  'in_progress',
  'done',
  'blocked',
]);

/** Validate + normalize a ticket status, returning null when unrecognized. */
function toTicketStatus(v: unknown): TicketStatus | null {
  return typeof v === 'string' && (TICKET_STATUS_SET as Set<string>).has(v)
    ? (v as TicketStatus)
    : null;
}

const TICKET_PRIORITIES: ReadonlySet<'low' | 'med' | 'high'> = new Set([
  'low',
  'med',
  'high',
] as const);

function toTicketPriority(v: unknown): 'low' | 'med' | 'high' | null {
  return typeof v === 'string' && (TICKET_PRIORITIES as Set<string>).has(v)
    ? (v as 'low' | 'med' | 'high')
    : null;
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

/**
 * Validate + normalize an `ItemUpdatePatch` into the Cypher params
 * shape ({ title, description, type, editorId } — all nullable).
 * Throws `SPACES_INVALID_INPUT` on length / type violations.
 *
 * Untouched fields collapse to `null` so the Cypher's
 * `coalesce($title, a.name)` keeps the existing value. Empty
 * description ("") is distinct from missing — it clears the field.
 */
function validateUpdatePatch(
  patch: ItemUpdatePatch
): {
  title: string | null;
  description: string | null;
  content: string | null;
  type: string | null;
  editorId: string | null;
} {
  const out = {
    title: null as string | null,
    description: null as string | null,
    content: null as string | null,
    type: null as string | null,
    editorId: null as string | null,
  };
  if (patch === null || typeof patch !== 'object') {
    return out;
  }
  if (patch.title !== undefined) {
    if (typeof patch.title !== 'string') {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'title must be a string',
        context: { title: typeof patch.title },
      });
    }
    const trimmed = patch.title.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_ITEM_TITLE_LENGTH) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: `title must be 1..${MAX_ITEM_TITLE_LENGTH} chars after trim`,
        context: { length: trimmed.length, max: MAX_ITEM_TITLE_LENGTH },
      });
    }
    out.title = trimmed;
  }
  if (patch.description !== undefined) {
    if (typeof patch.description !== 'string') {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'description must be a string',
        context: { description: typeof patch.description },
      });
    }
    const trimmed = patch.description.trim();
    if (trimmed.length > MAX_ITEM_DESCRIPTION_LENGTH) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: `description longer than ${MAX_ITEM_DESCRIPTION_LENGTH} chars`,
        context: { length: trimmed.length, max: MAX_ITEM_DESCRIPTION_LENGTH },
      });
    }
    out.description = trimmed;
  }
  if (patch.content !== undefined) {
    if (typeof patch.content !== 'string') {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'content must be a string',
        context: { content: typeof patch.content },
      });
    }
    // Content is stored verbatim -- we cap LENGTH but don't trim, so
    // intentional trailing newlines / leading whitespace survive.
    if (patch.content.length > MAX_ITEM_CONTENT_LENGTH) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: `content longer than ${MAX_ITEM_CONTENT_LENGTH} chars`,
        context: { length: patch.content.length, max: MAX_ITEM_CONTENT_LENGTH },
      });
    }
    out.content = patch.content;
  }
  if (patch.type !== undefined) {
    if (typeof patch.type !== 'string' || !(ITEM_KINDS as Set<string>).has(patch.type)) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'type must be a valid ItemKind',
        context: { type: patch.type },
      });
    }
    out.type = patch.type;
  }
  if (patch.editorId !== undefined) {
    if (typeof patch.editorId !== 'string') {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'editorId must be a string',
        context: { editorId: typeof patch.editorId },
      });
    }
    const trimmed = patch.editorId.trim();
    if (trimmed.length > 0) out.editorId = trimmed;
  }
  return out;
}

/**
 * Normalize a tag string. Returns `null` when it's empty after
 * trim or exceeds `MAX_ITEM_TAG_LENGTH`. Pure; exported for tests
 * (re-exported from api.ts indirectly via the SDK error path).
 */
function normalizeTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ITEM_TAG_LENGTH) return null;
  return trimmed;
}

/** Row shape returned by `listInlineBinaryAssets` (GSX migration sweep). */
export interface InlineBinaryAssetRow {
  id: string;
  content: string;
  title: string;
  mimeType: string;
}

// ─── Checklist helpers (ADR-055) ─────────────────────────────────────────

function generateChecklistId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `checklist-${Date.now().toString(36)}-${rand}`;
}

/**
 * Sanitize checklist items with the doctrine caps: non-empty text, one
 * line each, at most MAX_CHECKLIST_ITEMS. Rejects rather than truncates
 * — silently dropping someone's killer item defeats the whole point.
 */
export function sanitizeChecklistItems(raw: ReadonlyArray<ChecklistItemSpec>): ChecklistItemSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SpacesError({
      code: 'SPACES_INVALID_INPUT',
      message: 'A checklist needs at least one item',
      context: { op: 'checklists.create' },
    });
  }
  if (raw.length > MAX_CHECKLIST_ITEMS) {
    throw new SpacesError({
      code: 'SPACES_INVALID_INPUT',
      message: `Checklist has ${raw.length} items — the cap is ${MAX_CHECKLIST_ITEMS}`,
      remediation:
        'Checklists are for the killer items, not the whole procedure (aviation practice: 5–9 items, 60–90 seconds to run). Split it, or cut to what is most dangerous to skip.',
      context: { op: 'checklists.create' },
    });
  }
  return raw.map((item, i) => {
    const text = typeof item?.text === 'string' ? item.text.trim().replace(/\s+/g, ' ') : '';
    if (text.length === 0 || text.length > 200) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: `Checklist item ${i + 1} must be 1–200 characters of one-line text`,
        context: { op: 'checklists.create' },
      });
    }
    const more =
      typeof item?.more === 'string' && item.more.trim().length > 0
        ? item.more.trim().slice(0, 500)
        : undefined;
    const killer = item?.killer === true;
    // Killer implies required — a "most dangerous to skip" item that
    // doesn't count toward completion is a contradiction.
    const optional = !killer && item?.optional === true;
    return {
      text,
      ...(killer ? { killer: true } : {}),
      ...(optional ? { optional: true } : {}),
      ...(more !== undefined ? { more } : {}),
    };
  });
}

/** Indexes that count toward completion (non-optional items). */
export function requiredIndexes(items: ReadonlyArray<ChecklistItemSpec>): number[] {
  const out: number[] = [];
  items.forEach((item, i) => {
    if (item.optional !== true) out.push(i);
  });
  return out;
}

function rowToChecklist(r: Record<string, unknown>): Checklist | null {
  const id = typeof r['id'] === 'string' ? r['id'] : '';
  if (id.length === 0) return null;
  return {
    id,
    name: typeof r['name'] === 'string' ? r['name'] : '(unnamed)',
    mode: r['mode'] === 'READ-DO' ? 'READ-DO' : 'DO-CONFIRM',
    pausePoint: typeof r['pausePoint'] === 'string' ? r['pausePoint'] : '',
    items: parseChecklistItems(r['itemsJson']),
    version: typeof r['version'] === 'number' ? r['version'] : 1,
    ...(typeof r['revisedAt'] === 'string' && r['revisedAt'].length > 0
      ? { revisedAt: r['revisedAt'] }
      : {}),
    ...(typeof r['createdAt'] === 'string' && r['createdAt'].length > 0
      ? { createdAt: r['createdAt'] }
      : {}),
    ...(typeof r['updatedAt'] === 'string' && r['updatedAt'].length > 0
      ? { updatedAt: r['updatedAt'] }
      : {}),
    ...(typeof r['usedByCount'] === 'number' ? { usedByCount: r['usedByCount'] } : {}),
  };
}

function parseChecklistItems(raw: unknown): ChecklistItemSpec[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: ChecklistItemSpec[] = [];
    for (const x of parsed) {
      if (x === null || typeof x !== 'object') continue;
      const text = (x as { text?: unknown }).text;
      if (typeof text !== 'string' || text.length === 0) continue;
      const item: ChecklistItemSpec = { text };
      if ((x as { killer?: unknown }).killer === true) item.killer = true;
      // v2 fields (bfa91ef). Dropping these on read silently converted
      // every optional item back to required on the next revise (the
      // editor seeds from the parsed items) and killed the optional
      // badges + "more ▸" accordions — the write path stored them, the
      // read path erased them. Preserve exactly what sanitize wrote.
      if ((x as { optional?: unknown }).optional === true) item.optional = true;
      const more = (x as { more?: unknown }).more;
      if (typeof more === 'string' && more.length > 0) item.more = more;
      out.push(item);
    }
    return out;
  } catch {
    return [];
  }
}

function rowToTicketChecklist(link: Record<string, unknown>): TicketChecklist | null {
  const base = rowToChecklist(link);
  if (base === null) return null;
  const checkedIndexes = Array.isArray(link['checkedIdx'])
    ? (link['checkedIdx'] as unknown[]).filter((n): n is number => typeof n === 'number')
    : [];
  const itemCount = typeof link['itemCount'] === 'number' ? link['itemCount'] : base.items.length;
  // Required-aware completion (2026-08-08 release review): mirror the
  // rule SET_CHECKLIST_ITEM_* and TICKET_GATE_STATE apply in Cypher —
  // a null requiredIdx (legacy v1 node) means every item counts; a
  // list means only the REQUIRED items gate. The run card and the gate
  // must agree, or a checklist with optional items reads "incomplete"
  // on the card even while the gate passes it.
  const requiredIdx = Array.isArray(link['requiredIdx'])
    ? (link['requiredIdx'] as unknown[]).filter((n): n is number => typeof n === 'number')
    : null;
  const checkedSet = new Set(checkedIndexes);
  const complete =
    requiredIdx === null
      ? itemCount > 0 && checkedIndexes.length === itemCount
      : requiredIdx.every((req) => checkedSet.has(req));
  return {
    checklist: base,
    phase: link['phase'] === 'postflight' ? 'postflight' : 'preflight',
    obligation:
      link['obligation'] === 'required' || link['obligation'] === 'optional'
        ? link['obligation']
        : 'recommended',
    checkedIndexes,
    complete,
    ...(typeof link['completedAt'] === 'string' && link['completedAt'].length > 0
      ? { completedAt: link['completedAt'] }
      : {}),
    ...(typeof link['lastCheckedBy'] === 'string' && link['lastCheckedBy'].length > 0
      ? { lastCheckedBy: link['lastCheckedBy'] }
      : {}),
    ...(typeof link['lastCheckedAt'] === 'string' && link['lastCheckedAt'].length > 0
      ? { lastCheckedAt: link['lastCheckedAt'] }
      : {}),
  };
}

function readGateLinks(raw: unknown): Array<{ name: string; complete: boolean }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ name: string; complete: boolean }> = [];
  for (const x of raw) {
    if (x !== null && typeof x === 'object') {
      const name = (x as { name?: unknown }).name;
      out.push({
        name: typeof name === 'string' ? name : '(unnamed)',
        complete: (x as { complete?: unknown }).complete === true,
      });
    }
  }
  return out;
}

