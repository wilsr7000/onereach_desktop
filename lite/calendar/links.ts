/**
 * Flow ↔ playbook ↔ journey-map links (ADR-090 addendum, 2026-09-05).
 *
 * GSX keeps no pointer from a flow to the playbook that produced it. The
 * flow-build watcher's KV queue does: every slot (live queue + archive)
 * names `{ playbookId, flowId }`. Those slots are the authoritative link
 * ("via: build"). A flow is IN a Space when an asset there points at it:
 * the GSX Designer mirror (ADR-091) writes one agent asset per live flow
 * with `gsxFlowId`; a hand-made item may carry `flowId` or the Studio URL.
 * Journey maps have no flow pointer at all, so they are
 * offered by neighbourhood: journey assets in the linked playbook's Space
 * ("via: playbook") or in a Space named like the flow's GSX space
 * ("via: space"). Every Space is sight-filtered (ADR-084), so a button is
 * offered only when the viewer may open what it points at.
 */
import { SPACE_VISIBLE_FOR } from '../spaces/sdk-client.js';

/** The watcher's queue collections, live first. */
export const BUILD_QUEUE_COLLECTIONS: readonly string[] = ['flow-build-queue', 'flow-build-queue-archive'];
/** WISER playbook records (title fallback when the graph has no node). */
export const PLAYBOOK_KV_COLLECTION = 'riff:sheets';

export interface BuildSlot {
  key: string;
  playbookId: string;
  flowId: string;
  botId: string | null;
  status: string;
  finishedAtMs: number | null;
}

export interface FlowLinkPlaybook {
  id: string;
  title: string;
  spaceId: string | null;
  spaceName: string | null;
  via: 'build';
  builtAtMs: number | null;
  status: string;
}

export interface FlowLinkJourney {
  id: string;
  title: string;
  spaceId: string;
  spaceName: string;
  /** asset = the flow itself is an item there; playbook = beside the playbook that built it; space = a Space named like the GSX space. */
  via: 'asset' | 'playbook' | 'space';
}

/** A Space the flow belongs to (asset: an item points at the flow) or sits beside. */
export interface FlowLinkSpace {
  id: string;
  name: string;
  via: 'asset' | 'playbook' | 'name';
  assetId: string | null;
  assetTitle: string | null;
}

export interface FlowLinksInput {
  flowId: string;
  /** The GSX space (bot) label, matched by name against Spaces for journey maps. */
  botLabel?: string;
  refresh?: boolean;
}

export interface FlowLinksResult {
  flowId: string;
  /** Spaces first: where the flow is an item (via asset), then the playbook's Space, then a name match. */
  spaces: FlowLinkSpace[];
  playbooks: FlowLinkPlaybook[];
  journeys: FlowLinkJourney[];
  /** true when a source (KV queue or NEON) could not be read; what is listed is still real. */
  unavailable: boolean;
  reason?: string;
  fetchedAtMs: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

const ms = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e11 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
};

/** One queue slot → a link, or null when it names no playbook/flow pair. Values may arrive JSON-encoded. */
export function slotFrom(key: string, value: unknown): BuildSlot | null {
  let v = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const playbookId = str(o['playbookId']);
  const flowId = str(o['flowId']);
  if (playbookId.length === 0 || flowId.length === 0) return null;
  const botId = str(o['botId']);
  return {
    key,
    playbookId,
    flowId,
    botId: botId.length > 0 ? botId : null,
    status: str(o['status']) || 'unknown',
    finishedAtMs: ms(o['finishedAt']) ?? ms(o['archivedAt']) ?? ms(o['requestedAt']),
  };
}

/** The builds that produced a flow, newest first, one per playbook. */
export function buildsForFlow(slots: readonly BuildSlot[], flowId: string): BuildSlot[] {
  const mine = slots.filter((s) => s.flowId === flowId).sort((a, b) => (b.finishedAtMs ?? -1) - (a.finishedAtMs ?? -1));
  const seen = new Set<string>();
  const out: BuildSlot[] = [];
  for (const s of mine) {
    if (seen.has(s.playbookId)) continue;
    seen.add(s.playbookId);
    out.push(s);
  }
  return out;
}

/**
 * Playbooks by id (with their Space when the viewer may see it) and the
 * journey maps in reach. `$playbookIds` may be empty: the Space-name leg
 * still runs. `$viewerId` / `$nowMs` are injected by the caller.
 */
export const FLOW_LINKS_CYPHER = `
    OPTIONAL MATCH (fa:Asset)-[:BELONGS_TO]->(fs:Space)
      WHERE fa.deletedAt IS NULL AND fs.deletedAt IS NULL
        AND (fa.gsxFlowId = $flowId OR fa.flowId = $flowId OR toString(coalesce(fa.url, '')) CONTAINS $flowId)
        AND ${SPACE_VISIBLE_FOR('fs')}
    WITH collect(DISTINCT CASE WHEN fa IS NULL THEN NULL ELSE { id: fs.id, name: fs.name, assetId: fa.id, assetTitle: coalesce(fa.name, fa.title, fa.id) } END) AS flowSpaces
    OPTIONAL MATCH (p:Playbook)
      WHERE p.id IN $playbookIds AND coalesce(p.isTrashed, false) = false
    OPTIONAL MATCH (p)-[:BELONGS_TO]->(ps:Space)
      WHERE ps.deletedAt IS NULL AND ${SPACE_VISIBLE_FOR('ps')}
    WITH flowSpaces,
         collect(DISTINCT CASE WHEN p IS NULL THEN NULL ELSE { id: p.id, title: coalesce(p.title, p.name, p.id), spaceId: ps.id, spaceName: ps.name } END) AS playbooks,
         collect(DISTINCT ps.id) AS playbookSpaceIds
    WITH flowSpaces, playbooks, playbookSpaceIds, [x IN flowSpaces | x.id] AS flowSpaceIds
    OPTIONAL MATCH (s:Space)
      WHERE s.deletedAt IS NULL
        AND (s.id IN flowSpaceIds OR s.id IN playbookSpaceIds OR ($botLabel <> '' AND toLower(trim(coalesce(s.name, ''))) = $botLabel))
        AND ${SPACE_VISIBLE_FOR('s')}
    OPTIONAL MATCH (j:Asset)-[:BELONGS_TO]->(s)
      WHERE coalesce(j.type, j.assetType) = 'journey' AND j.deletedAt IS NULL
    RETURN flowSpaces, playbooks,
           collect(DISTINCT CASE WHEN s IS NULL THEN NULL ELSE { id: s.id, name: s.name, via: CASE WHEN s.id IN flowSpaceIds THEN 'asset' WHEN s.id IN playbookSpaceIds THEN 'playbook' ELSE 'name' END } END) AS spaces,
           collect(DISTINCT CASE WHEN j IS NULL THEN NULL ELSE { id: j.id, title: coalesce(j.name, j.title, j.id), spaceId: s.id, spaceName: s.name, via: CASE WHEN s.id IN flowSpaceIds THEN 'asset' WHEN s.id IN playbookSpaceIds THEN 'playbook' ELSE 'space' END } END) AS journeys
`;

const asList = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : []);

/** Rows of FLOW_LINKS_CYPHER → typed links; build metadata comes from the slots. */
export function linksFromRows(rows: ReadonlyArray<Record<string, unknown>>, builds: readonly BuildSlot[]): { spaces: FlowLinkSpace[]; playbooks: FlowLinkPlaybook[]; journeys: FlowLinkJourney[] } {
  const playbooks = new Map<string, FlowLinkPlaybook>();
  const journeys = new Map<string, FlowLinkJourney>();
  const spaces = new Map<string, FlowLinkSpace>();
  const byPlaybook = new Map(builds.map((b) => [b.playbookId, b] as const));
  const rank = { asset: 0, playbook: 1, name: 2, space: 2 } as const;
  for (const row of rows) {
    const assetBySpace = new Map<string, { assetId: string; assetTitle: string }>();
    for (const f of asList(row['flowSpaces'])) {
      const id = str(f['id']);
      if (id.length > 0 && !assetBySpace.has(id)) assetBySpace.set(id, { assetId: str(f['assetId']), assetTitle: str(f['assetTitle']) });
    }
    for (const sp of asList(row['spaces'])) {
      const id = str(sp['id']);
      if (id.length === 0) continue;
      const via = sp['via'] === 'asset' ? 'asset' : sp['via'] === 'playbook' ? 'playbook' : 'name';
      const prev = spaces.get(id);
      if (prev !== undefined && rank[prev.via] <= rank[via]) continue;
      const asset = assetBySpace.get(id);
      spaces.set(id, { id, name: str(sp['name']) || id, via, assetId: asset?.assetId ?? null, assetTitle: asset?.assetTitle ?? null });
    }
    for (const p of asList(row['playbooks'])) {
      const id = str(p['id']);
      if (id.length === 0 || playbooks.has(id)) continue;
      const b = byPlaybook.get(id);
      const spaceId = str(p['spaceId']);
      playbooks.set(id, { id, title: str(p['title']) || id, spaceId: spaceId.length > 0 ? spaceId : null, spaceName: spaceId.length > 0 ? str(p['spaceName']) : null, via: 'build', builtAtMs: b?.finishedAtMs ?? null, status: b?.status ?? 'unknown' });
    }
    for (const j of asList(row['journeys'])) {
      const id = str(j['id']);
      const spaceId = str(j['spaceId']);
      if (id.length === 0 || spaceId.length === 0) continue;
      const via = j['via'] === 'asset' ? 'asset' : j['via'] === 'playbook' ? 'playbook' : 'space';
      const prev = journeys.get(id);
      if (prev !== undefined && rank[prev.via] <= rank[via]) continue;
      journeys.set(id, { id, title: str(j['title']) || id, spaceId, spaceName: str(j['spaceName']), via });
    }
  }
  const order = (a: FlowLinkPlaybook, b: FlowLinkPlaybook): number => (b.builtAtMs ?? -1) - (a.builtAtMs ?? -1) || a.title.localeCompare(b.title);
  return {
    spaces: [...spaces.values()].sort((a, b) => rank[a.via] - rank[b.via] || a.name.localeCompare(b.name)),
    playbooks: [...playbooks.values()].sort(order),
    journeys: [...journeys.values()].sort((a, b) => rank[a.via] - rank[b.via] || a.title.localeCompare(b.title)),
  };
}
