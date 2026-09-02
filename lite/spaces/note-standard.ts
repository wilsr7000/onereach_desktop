/**
 * ADR-059 — the universal Note standard (registry entity `Note` v1.1.0).
 *
 * Notes are a SHARED entity: WISER Playbooks / OR-Mobile, agents, and
 * Lite all read and write the same `:Note` nodes in the same graph, and
 * the full note body lives in the shared Edison KV store — the graph
 * node is an index (title, type, scalar mirrors) plus relationships.
 * The contract Lite conforms to here is the `(:Schema {entity:'Note'})`
 * registry node, NOT anything Lite invented:
 *
 * - id `note_<UUID>`, upserted with MERGE on id
 * - labels `:Note` + a subtype label derived from `type`
 *   (Basic→BasicNote, Checklist→ChecklistNote, …)
 * - body in KV at `kv_collection` / `kv_ref`
 *   (`notes:<account>` / `note:<id>`)
 * - space membership as BOTH `(Note)-[:BELONGS_TO]->(Space)` and
 *   `(Space)-[:CONTAINS]->(Note)` kept in lockstep
 * - every write stamps `schema_version` +
 *   `updated_by_actor_type`/`updated_by_source` (plus app/user/at)
 * - conflict rule: newer-wins on `updated_at` (epoch ms) — a writer
 *   whose base is older than the node skips the property merge AND
 *   the KV body write
 *
 * Nothing in this module talks to the network: the KV store is
 * injected (`NoteKvStore`) so `sdk-client.ts` stays free of a
 * lite/kv dependency and tests can stub the store.
 */

import { randomUUID } from 'node:crypto';

/** Registry schema version Lite writes on every note write. */
export const NOTE_SCHEMA_VERSION = '1.1.0';

/**
 * Subtype label per the registry instructions. A note's `type`
 * property is the SUBTYPE ('Basic', 'Checklist', …) — its Lite
 * ItemKind is always derived from the `:Note` label instead
 * (ADR-058), so this map is only used to keep the subtype label in
 * lockstep with `type` on create.
 */
export const NOTE_SUBTYPE_LABELS: Readonly<Record<string, string>> = {
  Basic: 'BasicNote',
  Checklist: 'ChecklistNote',
  Ticket: 'TicketNote',
  Post: 'PostNote',
  'Calendar Event': 'CalendarEventNote',
  Space: 'SpaceNote',
  Transcript: 'TranscriptNote',
};

/** Writer identity Lite stamps on every note write. */
export const LITE_NOTE_WRITER = {
  appName: 'Onereach.ai Lite',
  appId: 'onereach-lite',
  actorType: 'human',
  source: 'lite-spaces',
} as const;

/** `note_<UUID>` per the registry id_pattern (uppercase like OR-Mobile). */
export function generateNoteId(): string {
  return `note_${randomUUID().toUpperCase()}`;
}

/** KV collection for an account's notes: `notes:<account>`. */
export function noteKvCollection(account: string): string {
  return `notes:${account}`;
}

/** KV key for one note body: `note:<noteId>`. */
export function noteKvRef(noteId: string): string {
  return `note:${noteId}`;
}

/**
 * Minimal KV surface the note paths need. Matches lite/kv's `KVApi`
 * `get`/`set` signatures so the main-process wiring is a plain
 * pass-through, but declared here so spaces never imports lite/kv.
 */
export interface NoteKvStore {
  get(collection: string, key: string): Promise<unknown | null>;
  set(collection: string, key: string, value: unknown): Promise<void>;
}

/** The fields Lite is allowed to change in a note's KV body. */
export interface NoteKvPatch {
  title?: string;
  content?: string;
  description?: string;
}

/**
 * Merge a Lite edit into an existing KV note body WITHOUT dropping
 * anything another app put there (`basicNoteData`, provenance,
 * space pointers, future fields — all preserved verbatim). Only the
 * explicitly patched fields plus `updatedAt` (ISO, the KV-side
 * convention) change. `description` is only introduced when patched —
 * Lite never adds fields other apps didn't ask for.
 */
export function mergeNoteKvBody(
  existing: unknown,
  patch: NoteKvPatch,
  nowIso: string
): Record<string, unknown> {
  const base: Record<string, unknown> =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  if (patch.title !== undefined) base['title'] = patch.title;
  if (patch.content !== undefined) base['content'] = patch.content;
  if (patch.description !== undefined) base['description'] = patch.description;
  base['updatedAt'] = nowIso;
  return base;
}

/** Fresh KV body for a note born in Lite. */
export function buildNoteKvBody(input: {
  id: string;
  title: string;
  content: string;
  description?: string;
  type?: string;
  createdBy: string;
  spaceId?: string | null;
  spaceName?: string | null;
  nowIso: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: input.id,
    localId: input.id.replace(/^note_/, ''),
    title: input.title,
    content: input.content,
    type: input.type ?? 'Basic',
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
    createdBy: input.createdBy,
    sourceApp: LITE_NOTE_WRITER.appName,
  };
  if (input.description !== undefined) body['description'] = input.description;
  if (input.spaceId) body['spaceId'] = input.spaceId;
  if (input.spaceName) body['spaceName'] = input.spaceName;
  return body;
}

/**
 * Guarded note write (Cypher). ONE query, two jobs:
 *
 * 1. Newer-wins gate — `coalesce(n.updated_at, 0) <= $baseUpdatedAt`
 *    makes the write a no-op (0 rows) when another app wrote after
 *    the state this edit was based on. The caller MUST treat 0 rows
 *    as a conflict and skip the KV write too (registry conflict rule).
 * 2. Stamps + (optionally) content — `$setContent` controls whether
 *    title/content/description are written here. Dual-label
 *    `:Asset:Note` items pass false and let the ADR-057 UPDATE_ITEM
 *    machinery write content (so the version snapshot captures the
 *    PRE-edit state); pure `:Note` items pass true.
 *
 * Timestamps land in BOTH conventions: snake_case `updated_at`
 * (epoch ms — the note standard's conflict key) and camelCase
 * `updatedAt` (Lite's native sort key).
 */
export const UPDATE_NOTE_GUARDED = `
    MATCH (n:Note {id: $id})
      WHERE coalesce(n.updated_at, 0) <= $baseUpdatedAt
    SET n.title = CASE WHEN $setContent AND $title IS NOT NULL THEN $title ELSE n.title END,
        n.content = CASE WHEN $setContent AND $content IS NOT NULL THEN $content ELSE n.content END,
        n.description = CASE WHEN $setContent AND $description IS NOT NULL THEN $description ELSE n.description END,
        n.schema_version = '${NOTE_SCHEMA_VERSION}',
        n.updated_at = $nowMs,
        n.updatedAt = $nowMs,
        n.updated_by_app_name = '${LITE_NOTE_WRITER.appName}',
        n.updated_by_app_id = '${LITE_NOTE_WRITER.appId}',
        n.updated_by_user = $viewerId,
        n.updated_by_actor_type = '${LITE_NOTE_WRITER.actorType}',
        n.updated_by_source = '${LITE_NOTE_WRITER.source}'
    RETURN n.id AS id
`;

/**
 * Create a Lite-born note as a DUAL-LABEL citizen:
 * `:Asset:Note:BasicNote`. The `:Note` (+ subtype) labels make it a
 * first-class universal note — WISER and agents see and edit it; the
 * `:Asset` label keeps every Lite capability working on it (ADR-057
 * versions, tags, metadata). Space membership is written in lockstep
 * (`BELONGS_TO` + `CONTAINS`) per the registry instructions.
 *
 * MERGE on id per the standard; `$subtypeLabel` is validated against
 * NOTE_SUBTYPE_LABELS by the caller before interpolation (labels
 * cannot be parameterized in Cypher).
 */
export function createNoteCypher(
  subtypeLabel: string,
  guards: {
    /**
     * The caller's SPACE_WRITABLE predicate (alias `s`). REQUIRED: before
     * 2026-09-01 this MATCH checked only `deletedAt IS NULL`, so ANY
     * viewer who knew a space id could plant a note into it — the node
     * was created and attached, and only the visibility-gated read-back
     * failed ("disappeared after creation"). Found by the live
     * stranger-write audit; the write-guard meta-test never saw this
     * builder because it enumerates the CYPHER map, not functions.
     */
    spaceWritable: string;
  }
): string {
  if (typeof guards?.spaceWritable !== 'string' || guards.spaceWritable.trim().length === 0) {
    throw new Error('createNoteCypher requires a non-empty spaceWritable guard');
  }
  return `
    MATCH (s:Space {id: $spaceId})
      WHERE s.deletedAt IS NULL
        AND ${guards.spaceWritable}
    MERGE (n:Note {id: $id})
    ON CREATE SET n.created_at = $nowMs,
                  n.createdAt = $nowMs,
                  n.createdAtISO = $nowIso,
                  n.created_by_user = $viewerId,
                  n.created_by_app_name = '${LITE_NOTE_WRITER.appName}',
                  n.created_by_app_id = '${LITE_NOTE_WRITER.appId}'
    SET n:Asset, n:${subtypeLabel},
        n.title = $title,
        n.name = $title,
        n.content = $content,
        n.description = $description,
        n.type = $subtype,
        n.metadata = $metadata,
        n.kv_collection = $kvCollection,
        n.kv_ref = $kvRef,
        n.schema_version = '${NOTE_SCHEMA_VERSION}',
        n.updated_at = $nowMs,
        n.updatedAt = $nowMs,
        n.updated_by_app_name = '${LITE_NOTE_WRITER.appName}',
        n.updated_by_app_id = '${LITE_NOTE_WRITER.appId}',
        n.updated_by_user = $viewerId,
        n.updated_by_actor_type = '${LITE_NOTE_WRITER.actorType}',
        n.updated_by_source = '${LITE_NOTE_WRITER.source}'
    MERGE (n)-[:BELONGS_TO]->(s)
    MERGE (s)-[:CONTAINS]->(n)
    WITH n, s
    OPTIONAL MATCH (p:Person {id: $creatorId})
    FOREACH (creator IN CASE WHEN p IS NOT NULL THEN [p] ELSE [] END |
      MERGE (creator)-[:CREATED]->(n)
    )
    FOREACH (x IN CASE WHEN $commitAuthor IS NULL THEN [] ELSE [1] END |
      MERGE (c:Commit {hash: $commitHash})
      ON CREATE SET c.author = $commitAuthor,
                    c.message = 'item:added',
                    c.timestamp = $commitTimestampMs,
                    c.assetId = n.id,
                    c.spaceId = s.id
      MERGE (c)-[:IN_SPACE]->(s)
      MERGE (c)-[:TOUCHED]->(n))
    RETURN n.id AS id, s.name AS spaceName
`;
}
