/**
 * The schedule index (ADR-090): which flows, by version, do and do not
 * carry a schedule — so a scan re-reads only what changed.
 *
 * A flow's `version` (and `dateModified`) move when it is saved. The
 * index remembers, per flow id, the version it last examined and what it
 * found: no schedule (skip it next time) or the parsed schedule events
 * (reuse them without fetching the body). A warm scan therefore lists
 * only flow heads — id, version, modified time, label — and fetches the
 * body of a flow only when its version is new. Deleted flows drop out
 * when they disappear from their space's listing.
 *
 * Pure: planning and merging here; storage and fetching in the service.
 */
import type { ScheduleEvent, ScheduledFlow } from './types.js';

export const SCHEDULE_INDEX_VERSION = 1;

export interface FlowHead {
  id: string;
  botId: string;
  version: string;
  modifiedMs: number;
  label: string;
}

export interface IndexEntry {
  version: string;
  modifiedMs: number;
  botId: string;
  label: string;
  /** When this version was examined (ms). */
  checkedAt: number;
  /** null = no schedule on this version; else the parsed events. */
  schedule: { stepLabel: string; events: ScheduleEvent[] } | null;
}

export interface ScheduleIndex {
  v: number;
  accountId: string;
  updatedAt: number;
  flows: Record<string, IndexEntry>;
}

export function emptyIndex(accountId: string, now: number): ScheduleIndex {
  return { v: SCHEDULE_INDEX_VERSION, accountId, updatedAt: now, flows: {} };
}

/** Parse a stored index; anything malformed or for another account is discarded. */
export function parseIndex(raw: unknown, accountId: string): ScheduleIndex | null {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o['v'] !== SCHEDULE_INDEX_VERSION || o['accountId'] !== accountId || typeof o['flows'] !== 'object' || o['flows'] === null) return null;
  const flows: Record<string, IndexEntry> = {};
  for (const [id, e] of Object.entries(o['flows'] as Record<string, unknown>)) {
    if (typeof e !== 'object' || e === null) continue;
    const x = e as Record<string, unknown>;
    if (typeof x['version'] !== 'string') continue;
    const sched = x['schedule'];
    flows[id] = {
      version: x['version'],
      modifiedMs: typeof x['modifiedMs'] === 'number' ? x['modifiedMs'] : 0,
      botId: typeof x['botId'] === 'string' ? x['botId'] : '',
      label: typeof x['label'] === 'string' ? x['label'] : id,
      checkedAt: typeof x['checkedAt'] === 'number' ? x['checkedAt'] : 0,
      schedule:
        typeof sched === 'object' && sched !== null && Array.isArray((sched as Record<string, unknown>)['events'])
          ? { stepLabel: String((sched as Record<string, unknown>)['stepLabel'] ?? 'Schedule execution'), events: (sched as { events: ScheduleEvent[] }).events }
          : null,
    };
  }
  return { v: SCHEDULE_INDEX_VERSION, accountId, updatedAt: typeof o['updatedAt'] === 'number' ? o['updatedAt'] : 0, flows };
}

export interface ScanPlan {
  /** Heads whose version the index already examined: answer from the index. */
  reuse: FlowHead[];
  /** Heads whose version is new or changed: fetch the body. */
  fetch: FlowHead[];
  /** Index entries for flows no longer listed in a space that listed fine: drop. */
  drop: string[];
}

/**
 * Compare listed heads against the index. `listedBots` are the spaces
 * that listed successfully; entries for flows in a space that failed to
 * list are kept (absence there means nothing).
 */
export function planScan(index: ScheduleIndex, heads: FlowHead[], listedBots: ReadonlySet<string>): ScanPlan {
  const reuse: FlowHead[] = [];
  const fetch: FlowHead[] = [];
  const seen = new Set<string>();
  for (const h of heads) {
    seen.add(h.id);
    const e = index.flows[h.id];
    if (e !== undefined && e.version === h.version && e.modifiedMs === h.modifiedMs) reuse.push(h);
    else fetch.push(h);
  }
  const drop: string[] = [];
  for (const [id, e] of Object.entries(index.flows)) {
    if (!seen.has(id) && listedBots.has(e.botId)) drop.push(id);
  }
  return { reuse, fetch, drop };
}

/** A ScheduledFlow from an index entry (activation fields default; the service fills them from deployments). */
export function scheduledFromIndex(id: string, e: IndexEntry, botLabel: string): ScheduledFlow | null {
  if (e.schedule === null) return null;
  return {
    flowId: id,
    botId: e.botId,
    botLabel,
    flowLabel: e.label,
    deployed: e.version.length > 0,
    stepLabel: e.schedule.stepLabel,
    events: e.schedule.events,
    modifiedMs: e.modifiedMs,
    active: false,
    armed: false,
    activatedMs: 0,
    nextFireMs: null,
  };
}

/** Record what a fetched (or bulk-listed) flow showed. Returns true when the index changed. */
export function recordFlow(index: ScheduleIndex, head: FlowHead, scheduled: ScheduledFlow | null, now: number): boolean {
  const next: IndexEntry = {
    version: head.version,
    modifiedMs: head.modifiedMs,
    botId: head.botId,
    label: head.label,
    checkedAt: now,
    schedule: scheduled === null ? null : { stepLabel: scheduled.stepLabel, events: scheduled.events },
  };
  const prev = index.flows[head.id];
  const same = prev !== undefined && prev.version === next.version && prev.modifiedMs === next.modifiedMs && prev.botId === next.botId && prev.label === next.label && JSON.stringify(prev.schedule) === JSON.stringify(next.schedule);
  index.flows[head.id] = same ? { ...prev, checkedAt: now } : next;
  if (!same) index.updatedAt = now;
  return !same;
}

export function dropFlows(index: ScheduleIndex, ids: string[], now: number): boolean {
  let changed = false;
  for (const id of ids) {
    if (index.flows[id] !== undefined) {
      delete index.flows[id];
      changed = true;
    }
  }
  if (changed) index.updatedAt = now;
  return changed;
}

export interface IndexStats {
  flows: number;
  withSchedule: number;
}
export function indexStats(index: ScheduleIndex): IndexStats {
  const entries = Object.values(index.flows);
  return { flows: entries.length, withSchedule: entries.filter((e) => e.schedule !== null).length };
}
