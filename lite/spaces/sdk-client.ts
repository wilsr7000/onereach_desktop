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
  CreateSpaceInput,
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
} from './types.js';
import {
  MAX_SPACE_NAME_LENGTH,
  MAX_SPACE_DESC_LENGTH,
  MAX_ITEM_TITLE_LENGTH,
  MAX_ITEM_DESCRIPTION_LENGTH,
  MAX_ITEM_TAG_LENGTH,
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
      WHERE s.deletedAt IS NULL
    OPTIONAL MATCH (a:Asset)-[:BELONGS_TO]->(s)
    WITH s, count(a) AS itemCount
    RETURN s.id AS id,
           coalesce(s.name, s.id) AS name,
           coalesce(s.description, '') AS description,
           coalesce(s.color, '') AS color,
           coalesce(s.iconKey, s.icon, '') AS iconKey,
           coalesce(s.kind, 'user') AS kind,
           itemCount AS itemCount,
           coalesce(toString(s.createdAt), toString(s.created_at), '') AS createdAt,
           coalesce(toString(s.updatedAt), toString(s.updated_at), '') AS updatedAt
    ORDER BY toLower(coalesce(s.name, s.id, '')) ASC
  `,
  UNCATEGORIZED_COUNT: `
    MATCH (a:Asset)
    WHERE a.deletedAt IS NULL
      AND NOT (a)-[:BELONGS_TO]->(:Space)
    RETURN count(a) AS count
  `,
  LIST_ITEMS_UNCATEGORIZED: `
    MATCH (a:Asset)
    WHERE a.deletedAt IS NULL
      AND NOT (a)-[:BELONGS_TO]->(:Space)
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
      WHERE s.deletedAt IS NULL
        AND a.deletedAt IS NULL
    OPTIONAL MATCH (a)-[:BELONGS_TO]->(other:Space)
      WHERE other.id <> s.id
        AND other.deletedAt IS NULL
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
    OPTIONAL MATCH (a)-[:BELONGS_TO]->(s:Space)
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
           coalesce(a.excerpt, a.description, a.notes) AS excerpt,
           coalesce(a.content, '') AS content,
           coalesce(a.size, a.fileSize, a.byteCount) AS size,
           coalesce(a.mimeType, a.contentType) AS mimeType,
           coalesce(a.tags, edgeTags, []) AS tags,
           null AS metadata,
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
           END AS ticketAssignee
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
    MATCH (s:Space) WHERE s.deletedAt IS NULL RETURN 'Space' AS kind, count(s) AS n
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
      WHERE s.deletedAt IS NULL
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
      WHERE s.deletedAt IS NULL
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
  SPACE_ITEM_COUNT: `
    MATCH (s:Space {id: $id})
    OPTIONAL MATCH (a:Asset)-[:BELONGS_TO]->(s)
    RETURN count(a) AS count
  `,

  /**
   * SOFT_DELETE_SPACE -- sets `deletedAt` so the Space stops appearing
   * in listSpaces() but its items keep their `[:BELONGS_TO]` edges.
   * Reversible via UNDELETE_SPACE.
   */
  SOFT_DELETE_SPACE: `
    MATCH (s:Space {id: $id})
      WHERE s.deletedAt IS NULL
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
    OPTIONAL MATCH (a)-[:ASSIGNED_TO]->(assignee)
      WHERE assignee:Person OR assignee:Agent
    OPTIONAL MATCH (a)-[:DECOMPOSED_FROM]->(pb:Asset)
    WITH a,
         head(collect(assignee)) AS assigneeNode,
         head(collect(pb)) AS sourcePlaybook
    RETURN a.id AS id,
           coalesce(a.name, a.title, a.id) AS title,
           coalesce(a.excerpt, a.description, a.notes) AS excerpt,
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
    OPTIONAL MATCH (member)-[:HAS_ACCESS]->(s)
      WHERE member:Person OR member:Agent
    WITH member
    WHERE member IS NOT NULL
    RETURN head(labels(member)) AS kind,
           member.id AS id,
           coalesce(member.name, member.title, '') AS name
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
    MATCH (member {id: $memberId})
      WHERE member:Person OR member:Agent
    MERGE (member)-[:HAS_ACCESS]->(s)
    RETURN head(labels(member)) AS kind,
           member.id AS id,
           coalesce(member.name, member.title, '') AS name
  `,

  /**
   * Remove a member from a Space. No-op when the edge is already
   * absent. Returns 1 if removed, 0 otherwise (the renderer ignores
   * the count and just re-renders).
   */
  REMOVE_SPACE_MEMBER: `
    MATCH (member {id: $memberId})-[r:HAS_ACCESS]->(s:Space {id: $spaceId})
      WHERE member:Person OR member:Agent
    DELETE r
    RETURN $memberId AS id
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
      createdAt: $now,
      updatedAt: $now
    })
    MERGE (a)-[:BELONGS_TO]->(s)
    WITH a
    OPTIONAL MATCH (p:Person {id: $creatorId})
    FOREACH (x IN CASE WHEN p IS NULL THEN [] ELSE [p] END |
      MERGE (x)-[:CREATED]->(a))
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
      createdAt: $now,
      updatedAt: $now
    })
    WITH a
    OPTIONAL MATCH (p:Person {id: $creatorId})
    FOREACH (x IN CASE WHEN p IS NULL THEN [] ELSE [p] END |
      MERGE (x)-[:CREATED]->(a))
    RETURN a.id AS id
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
    OPTIONAL MATCH (a)-[:BELONGS_TO]->(s:Space)
      WHERE s.deletedAt IS NULL
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

  // ─── Mutations (Phase 3a) ──────────────────────────────────────────────

  /**
   * Create a new Space. Validates input client-side, generates an id,
   * stamps `createdAt`/`updatedAt`, executes the atomic create. A name
   * collision returns 0 rows; we surface that as
   * `SPACES_DUPLICATE_NAME`.
   */
  async createSpace(input: CreateSpaceInput): Promise<Space> {
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
  }

  /**
   * Rename an existing Space. 0 rows from RENAME_SPACE means either the
   * Space doesn't exist (or is soft-deleted) or the new name collides;
   * a follow-up SPACE_EXISTS_BY_ID probe disambiguates so callers see
   * the right error code.
   */
  async renameSpace(id: string, name: string): Promise<Space> {
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
  }

  /**
   * Delete a Space. Defaults to soft (sets `deletedAt`); pass
   * `{ soft: false }` to hard-remove. Hard delete refuses if the
   * Space still has items so data can't orphan accidentally.
   */
  async deleteSpace(id: string, opts: DeleteSpaceOpts = {}): Promise<void> {
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
          'Move the items out first (or use soft delete -- the default -- which keeps items reachable via Uncategorized).',
        context: { id: validId, itemCount },
      });
    }
    await this.run(CYPHER.HARD_DELETE_SPACE, { id: validId });
  }

  /**
   * Restore a soft-deleted Space. 0 rows means either the Space
   * doesn't exist or wasn't soft-deleted -- a follow-up probe
   * disambiguates so the caller sees the right error code.
   */
  async undeleteSpace(id: string): Promise<Space> {
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
      const refreshed = await this.run(CYPHER.LIST_SPACES);
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
    const created = await this.getItem(id);
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
      creatorId,
      now,
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
    const created = await this.getItem(id);
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
      out.push({
        kind: optString(r, 'kind') ?? 'Person',
        id,
        name: optString(r, 'name') ?? '',
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
  async addSpaceMember(spaceId: string, memberId: string): Promise<SpaceMember> {
    const validSpaceId = validateSpaceId(spaceId);
    if (typeof memberId !== 'string' || memberId.length === 0) {
      throw new SpacesError({
        code: 'SPACES_INVALID_INPUT',
        message: 'addSpaceMember requires a non-empty memberId',
        context: { memberId },
      });
    }
    const rows = await this.run(CYPHER.ADD_SPACE_MEMBER, {
      spaceId: validSpaceId,
      memberId,
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
    return {
      kind: optString(row, 'kind') ?? 'Person',
      id: requireString(row, 'id'),
      name: optString(row, 'name') ?? '',
    };
  }

  /**
   * Remove a member's access to a Space. No-op when the edge is
   * already absent; returns silently in either case so callers can
   * call without a try/catch around "edge was missing."
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
    await this.run(CYPHER.REMOVE_SPACE_MEMBER, {
      spaceId: validSpaceId,
      memberId,
    });
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
  const kind = optString(row, 'kind');
  if (kind === 'shared' || kind === 'user') space.kind = kind;
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
    createdAt: optString(row, 'createdAt') ?? '',
    updatedAt: optString(row, 'updatedAt') ?? '',
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
  'other',
]);

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
): { title: string | null; description: string | null; type: string | null; editorId: string | null } {
  const out = {
    title: null as string | null,
    description: null as string | null,
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
