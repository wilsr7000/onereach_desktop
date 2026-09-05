/**
 * Space events on the Calendar (ADR-090 addendum, 2026-09-05).
 *
 * A Space event is an activity commit: an item added, updated, edited
 * or restored in a Space, by whom and when. The query is the Home tab's
 * recent-events query narrowed to a time range and shaped for a day
 * grid; it carries the ADR-084 sight predicate verbatim (creator or
 * live HAS_ACCESS grant, nested opt-in per ADR-085, nothing inferred),
 * and an edgeless commit is visible only to its author or through a
 * Space the viewer can see. Grouping per local day and per Space is
 * pure and tested.
 */
import { SPACE_VISIBLE_FOR } from '../spaces/sdk-client.js';
import { zonedParts } from './cron.js';

export interface SpaceEvent {
  id: string;
  atMs: number;
  /** added | updated | edited | restored (from the commit message `item:<kind>`), else the raw message. */
  kind: string;
  author: string;
  spaceId: string;
  spaceName: string;
  itemId: string;
  itemTitle: string;
  itemKind: string;
}

export interface SpaceEventDay {
  /** YYYY-MM-DD in the grouping zone. */
  date: string;
  total: number;
  spaces: Array<{ spaceId: string; spaceName: string; count: number }>;
}

export interface SpaceEventsInput {
  fromMs: number;
  toMs: number;
  /** Zone the days are grouped in (the viewer's); explicit, never implied. */
  timeZone: string;
  refresh?: boolean;
}

export interface SpaceEventsResult {
  events: SpaceEvent[];
  days: SpaceEventDay[];
  total: number;
  truncated: boolean;
  fetchedAtMs: number;
  /** True when the graph is not configured or not reachable (the calendar still shows flows). */
  unavailable: boolean;
}

export const SPACE_EVENTS_LIMIT = 5000;

/** Commits in [$fromMs, $toMs), sight-filtered. `$viewerId` and `$nowMs` are injected by the caller. */
export const SPACE_EVENTS_CYPHER = `
    MATCH (c:Commit)
    WHERE c.timestamp >= $fromMs AND c.timestamp < $toMs
    OPTIONAL MATCH (c)-[:IN_SPACE]->(s:Space)
    WITH c, s
    WHERE (s IS NOT NULL AND s.deletedAt IS NULL AND ${SPACE_VISIBLE_FOR('s')})
       OR (s IS NULL AND (
            ($viewerId <> '' AND toLower(coalesce(c.author, '')) = $viewerId)
            OR EXISTS {
              MATCH (other:Space)
              WHERE other.deletedAt IS NULL
                AND ${SPACE_VISIBLE_FOR('other')}
                AND (
                  other.id = c.spaceId
                  OR EXISTS { MATCH (c)-[:TOUCHED]->()-[:BELONGS_TO]->(other) }
                )
            }
          ))
    WITH c, s
    ORDER BY c.timestamp ASC
    LIMIT toInteger($limit)
    OPTIONAL MATCH (other:Space)
      WHERE other.deletedAt IS NULL
        AND ${SPACE_VISIBLE_FOR('other')}
        AND (
          other.id = c.spaceId
          OR (c.spaceId IS NULL AND s IS NULL
              AND EXISTS { MATCH (c)-[:TOUCHED]->()-[:BELONGS_TO]->(other) })
        )
    WITH c, s, head(collect(DISTINCT other)) AS resolved
    RETURN c.hash AS id,
           toInteger(c.timestamp) AS atMs,
           coalesce(c.message, '') AS message,
           coalesce(c.author, '') AS author,
           coalesce(c.spaceId, resolved.id, '') AS spaceId,
           coalesce(s.name, resolved.name, c.spaceId, '') AS spaceName,
           head([(c)-[:TOUCHED]->(a:Asset) | {id: a.id, title: coalesce(a.title, a.name, ''), kind: coalesce(a.type, a.assetType, '')}]) AS item
    ORDER BY c.timestamp ASC
  `;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function kindOf(message: string): string {
  const m = /^item:([a-z]+)$/i.exec(message.trim());
  return m !== null ? (m[1] ?? message).toLowerCase() : message.trim();
}

/** One query row → event; null when it has no id or time. */
export function rowToSpaceEvent(row: Record<string, unknown>): SpaceEvent | null {
  const id = str(row['id']);
  const at = row['atMs'];
  const atMs = typeof at === 'number' ? at : Number.parseInt(str(at), 10);
  if (id.length === 0 || !Number.isFinite(atMs)) return null;
  const item = typeof row['item'] === 'object' && row['item'] !== null ? (row['item'] as Record<string, unknown>) : {};
  return {
    id,
    atMs,
    kind: kindOf(str(row['message'])),
    author: str(row['author']),
    spaceId: str(row['spaceId']),
    spaceName: str(row['spaceName']) || 'Uncategorized',
    itemId: str(item['id']),
    itemTitle: str(item['title']),
    itemKind: str(item['kind']),
  };
}

export function dayKeyIn(atMs: number, timeZone: string): string {
  const p = zonedParts(atMs, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Events bucketed per local day, each day's Spaces ordered by count then name. */
export function groupSpaceEventsByDay(events: readonly SpaceEvent[], timeZone: string): SpaceEventDay[] {
  const days = new Map<string, Map<string, { spaceId: string; spaceName: string; count: number }>>();
  for (const e of events) {
    const key = dayKeyIn(e.atMs, timeZone);
    let spaces = days.get(key);
    if (spaces === undefined) {
      spaces = new Map();
      days.set(key, spaces);
    }
    const sid = e.spaceId.length > 0 ? e.spaceId : `name:${e.spaceName}`;
    const entry = spaces.get(sid);
    if (entry === undefined) spaces.set(sid, { spaceId: e.spaceId, spaceName: e.spaceName, count: 1 });
    else entry.count += 1;
  }
  return [...days.entries()]
    .map(([date, spaces]) => {
      const list = [...spaces.values()].sort((a, b) => b.count - a.count || a.spaceName.localeCompare(b.spaceName));
      return { date, total: list.reduce((n, s) => n + s.count, 0), spaces: list };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
