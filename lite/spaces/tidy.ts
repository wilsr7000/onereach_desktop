/**
 * ADR-099 — the groomer's core, pure: what the model is shown, how its
 * answer is checked, and how an accepted move maps onto the existing
 * Spaces API. No I/O here; `tidy-engine.ts` owns the store, the model
 * call and the schedule.
 *
 * The rules, stated once (the prompt repeats them to the model and the
 * validator enforces them whatever the model says):
 *   - a move never changes who can see what: merges LIST the members the
 *     target lacks and stop there — a grant is a person's act;
 *   - only Spaces the viewer can write are moved;
 *   - every id must exist in the evidence; nests may not cycle;
 *   - at most MAX_TIDY_MOVES moves, each with a reason and its evidence;
 *   - a move a person rejected is not proposed again.
 */
import type { TidySpaceEvidence } from './types.js';

export type TidyMoveKind = 'nest' | 'unnest' | 'merge' | 'archive' | 'rename' | 'create-parent';
export type TidyDecision = 'accepted' | 'rejected' | 'undecided';

export interface TidyMove {
  /** Deterministic: the same proposal always has the same key (decision memory rides on it). */
  key: string;
  kind: TidyMoveKind;
  /** nest / unnest / archive / rename / merge (the source). */
  spaceId?: string;
  spaceName?: string;
  /** nest / unnest. */
  parentId?: string;
  parentName?: string;
  /** merge. */
  targetId?: string;
  targetName?: string;
  /** rename (the new name) / create-parent (the parent's name). */
  name?: string;
  /** create-parent. */
  childIds?: string[];
  childNames?: string[];
  reason: string;
  evidence: string[];
  confidence: number;
  /** merge: members of the source the target lacks — surfaced, never granted. */
  membersNotInTarget?: string[];
  decision: TidyDecision;
  applied?: boolean;
  error?: string;
}

export interface TidyPlan {
  createdAt: string;
  model: string;
  provider: string;
  summary: string;
  topLevelCount: number;
  spaceCount: number;
  moves: TidyMove[];
}

export interface TidySettings {
  /** A plan is prepared in the background every N days. */
  cadenceDays: number;
  /** …or sooner, once the top level passes this many rows. */
  topLevelThreshold: number;
  /** The chat profile the plan runs on (`powerful` = the provider's strongest tier). */
  profile: 'powerful' | 'standard';
}

export interface TidyState {
  settings: TidySettings;
  lastRunAt: string | null;
  running: boolean;
  plan: TidyPlan | null;
  /** Moves still waiting on a decision. */
  pending: number;
  error?: string;
}

export const DEFAULT_TIDY_SETTINGS: TidySettings = {
  cadenceDays: 7,
  topLevelThreshold: 20,
  profile: 'powerful',
};

export const MAX_TIDY_MOVES = 25;
export const TIDY_FEATURE = 'spaces-tidy';
const MAX_REASON = 240;
const MAX_NAME = 80;
const MAX_EVIDENCE = 6;
const MAX_OVERLAPS = 40;

export function normalizeTidySettings(raw: unknown, base: TidySettings = DEFAULT_TIDY_SETTINGS): TidySettings {
  const r = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const int = (v: unknown, fallback: number, min: number, max: number): number => {
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
    return Math.min(max, Math.max(min, n));
  };
  return {
    cadenceDays: int(r['cadenceDays'], base.cadenceDays, 1, 90),
    topLevelThreshold: int(r['topLevelThreshold'], base.topLevelThreshold, 5, 500),
    profile: r['profile'] === 'standard' ? 'standard' : r['profile'] === 'powerful' ? 'powerful' : base.profile,
  };
}

/** Top-level rows as the sidebar counts them: live, not archived, no visible parent. */
export function topLevelCount(
  spaces: ReadonlyArray<{ id: string; parentIds?: string[]; archived?: boolean; archivedAt?: string }>
): number {
  const live = spaces.filter((s) => s.archived !== true && (s.archivedAt === undefined || s.archivedAt === ''));
  const ids = new Set(live.map((s) => s.id));
  return live.filter((s) => !(s.parentIds ?? []).some((p) => ids.has(p))).length;
}

/** Lower-cased word tokens, minus filler, for name overlap. */
function tokens(name: string): Set<string> {
  const stop = new Set(['the', 'a', 'an', 'of', 'and', 'for', 'to', 'in', 'on', 'space', 'spaces', 'test', 'my']);
  return new Set(
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((t) => t.length > 1 && !stop.has(t))
  );
}

/**
 * Pairs of Spaces whose names overlap enough to ask about — a hint for
 * the model, not a verdict. Jaccard over word tokens, or one name inside
 * the other.
 */
export function nameOverlaps(
  evidence: ReadonlyArray<Pick<TidySpaceEvidence, 'id' | 'name'>>
): Array<{ a: string; b: string; score: number }> {
  const out: Array<{ a: string; b: string; score: number }> = [];
  const toks = evidence.map((e) => ({ id: e.id, name: e.name.toLowerCase().trim(), set: tokens(e.name) }));
  for (let i = 0; i < toks.length; i += 1) {
    for (let j = i + 1; j < toks.length; j += 1) {
      const x = toks[i];
      const y = toks[j];
      if (x === undefined || y === undefined) continue;
      let score = 0;
      if (x.name.length > 0 && y.name.length > 0 && (x.name.includes(y.name) || y.name.includes(x.name))) {
        score = 0.9;
      } else if (x.set.size > 0 && y.set.size > 0) {
        let inter = 0;
        for (const t of x.set) if (y.set.has(t)) inter += 1;
        const union = x.set.size + y.set.size - inter;
        score = union === 0 ? 0 : inter / union;
      }
      if (score >= 0.5) out.push({ a: x.id, b: y.id, score: Math.round(score * 100) / 100 });
    }
  }
  return out.sort((p, q) => q.score - p.score).slice(0, MAX_OVERLAPS);
}

/** The stable identity of a proposal: kind + the Spaces it touches (+ the name it proposes). */
export function moveKey(move: {
  kind: TidyMoveKind;
  spaceId?: string;
  parentId?: string;
  targetId?: string;
  childIds?: string[];
  name?: string;
}): string {
  switch (move.kind) {
    case 'nest':
    case 'unnest':
      return `${move.kind}:${move.spaceId ?? ''}>${move.parentId ?? ''}`;
    case 'merge':
      return `merge:${move.spaceId ?? ''}>${move.targetId ?? ''}`;
    case 'archive':
      return `archive:${move.spaceId ?? ''}`;
    case 'rename':
      return `rename:${move.spaceId ?? ''}:${(move.name ?? '').trim().toLowerCase()}`;
    case 'create-parent':
      return `create-parent:${[...(move.childIds ?? [])].sort().join(',')}`;
  }
}

/** One line a person (or the model) can read a move back from. */
export function describeMove(move: TidyMove): string {
  const n = (id: string | undefined, name: string | undefined): string => (name !== undefined && name.length > 0 ? `"${name}"` : `${id ?? '?'}`);
  switch (move.kind) {
    case 'nest':
      return `Put ${n(move.spaceId, move.spaceName)} inside ${n(move.parentId, move.parentName)}`;
    case 'unnest':
      return `Take ${n(move.spaceId, move.spaceName)} out of ${n(move.parentId, move.parentName)}`;
    case 'merge':
      return `Merge ${n(move.spaceId, move.spaceName)} into ${n(move.targetId, move.targetName)}`;
    case 'archive':
      return `Archive ${n(move.spaceId, move.spaceName)}`;
    case 'rename':
      return `Rename ${n(move.spaceId, move.spaceName)} to "${move.name ?? ''}"`;
    case 'create-parent':
      return `Create "${move.name ?? ''}" and put ${(move.childNames ?? move.childIds ?? []).map((c) => `"${c}"`).join(', ')} inside`;
  }
}

export interface TidyPromptInput {
  evidence: ReadonlyArray<TidySpaceEvidence>;
  /** Moves a person rejected before, as readable lines: the model is told not to raise them again. */
  rejected: ReadonlyArray<string>;
  viewerId: string;
  now: Date;
}

const SYSTEM_PROMPT = `You are the groomer for a person's Spaces in Onereach Desktop. Spaces are folders of work: files, notes, playbooks, agents, tickets, links. They multiply fast — a sync mints one per Designer bot, another writer mints one per project, people make them by hand — and nobody tidies them. Your job is to read the evidence the way a careful colleague would and propose a short plan that reduces clutter at the top level without losing anything.

You may propose these moves and nothing else:
- nest: put a Space inside another (organization only; permissions do not change).
- unnest: take a Space out of a parent it no longer belongs in.
- merge: move everything from one Space into another and archive the empty one. Only for true duplicates or a Space that is plainly a fragment of another.
- archive: take an idle or finished Space out of the working set (it stays searchable and comes back with one click).
- rename: when the name misleads (it says something the objective and contents do not) or nobody named it ("Space a7671f80").
- create-parent: make a new parent Space and put several related Spaces inside it, when the person has three or more Spaces on one theme and no parent yet.

Rules you must follow:
1. Never propose anything that changes who can see or edit a Space. No sharing, no member changes. When a merge would bring members together, say so in the reason and let the person decide.
2. Move only Spaces marked writable. Never touch a Space marked archived except to unnest it.
3. Use only ids from the evidence. Do not invent Spaces except through create-parent.
4. Prefer few, high-confidence moves over many. At most ${MAX_TIDY_MOVES}. Do not propose a move that appears in the "previously rejected" list, or anything equivalent to it.
5. Respect what is already there: a Space with a parent is organized; a group Space (source "lite-group") is a frame the app keeps; a Designer mirror (source "gsx-designer") belongs under the GSX Designer group unless the person moved it.
6. Every move carries a reason of one or two sentences that names the evidence (item titles, dates, overlapping names, member lists) and a confidence between 0 and 1.
7. Write in plain English, no headings, no emoji. Names are the person's; quote them exactly. People appear as person-1, person-2 … (the same label means the same person across Spaces; "viewer" is the person you are advising); never guess who they are.

Answer with JSON only, in this shape:
{"summary": "one or two sentences on the shape of the problem and the plan", "moves": [
 {"kind": "nest", "spaceId": "…", "parentId": "…", "reason": "…", "evidence": ["…"], "confidence": 0.8},
 {"kind": "unnest", "spaceId": "…", "parentId": "…", "reason": "…", "evidence": ["…"], "confidence": 0.6},
 {"kind": "merge", "spaceId": "…", "targetId": "…", "reason": "…", "evidence": ["…"], "confidence": 0.7},
 {"kind": "archive", "spaceId": "…", "reason": "…", "evidence": ["…"], "confidence": 0.9},
 {"kind": "rename", "spaceId": "…", "name": "…", "reason": "…", "evidence": ["…"], "confidence": 0.5},
 {"kind": "create-parent", "name": "…", "childIds": ["…", "…", "…"], "reason": "…", "evidence": ["…"], "confidence": 0.7}
]}`;

export function buildTidyPrompt(input: TidyPromptInput): { system: string; user: string } {
  // People never cross to the model provider by name: each Person id
  // becomes person-N for this prompt, the same label everywhere it
  // appears, so overlap still reads while identities stay in the app.
  const people = new Map<string, string>();
  const alias = (id: string): string => {
    if (id.length === 0) return '';
    const seen = people.get(id);
    if (seen !== undefined) return seen;
    const label = id === input.viewerId ? 'viewer' : `person-${people.size + 1}`;
    people.set(id, label);
    return label;
  };
  alias(input.viewerId);
  const spaces = input.evidence.map((e) => {
    const row: Record<string, unknown> = {
      id: e.id,
      name: e.name,
      objective: e.description.slice(0, 280),
      kind: e.kind,
      source: e.source.length > 0 ? e.source : undefined,
      createdBy: alias(e.createdBy),
      createdAt: e.createdAt.slice(0, 10),
      lastActivity: e.lastActivity.slice(0, 10),
      items: e.itemCount,
      sample: e.items.slice(0, 12).map((it) => (it.tags.length > 0 ? `${it.title} [${it.kind}; ${it.tags.slice(0, 4).join(', ')}]` : `${it.title} [${it.kind}]`)),
      members: e.members.map(alias),
      memberCount: e.memberCount,
      parents: e.parentIds,
      writable: e.writable,
      archived: e.archived ? true : undefined,
    };
    for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
    return row;
  });
  const user = JSON.stringify(
    {
      today: input.now.toISOString().slice(0, 10),
      viewer: 'viewer',
      topLevelRows: topLevelCount(input.evidence),
      spaces,
      nameOverlaps: nameOverlaps(input.evidence),
      previouslyRejected: input.rejected,
      limits: { maxMoves: MAX_TIDY_MOVES },
    },
    null,
    0
  );
  return { system: SYSTEM_PROMPT, user };
}

/** Pull the JSON object out of a model answer that may wrap it in prose or a code fence. */
export function extractJsonObject(raw: string): unknown {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced !== null && fenced[1] !== undefined ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

export interface ParsedTidyPlan {
  summary: string;
  moves: TidyMove[];
  /** Why a proposal was dropped (for the log; never shown as a move). */
  dropped: string[];
}

function ancestorsOf(id: string, byId: Map<string, TidySpaceEvidence>): Set<string> {
  const seen = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined) continue;
    const e = byId.get(cur);
    if (e === undefined) continue;
    for (const p of e.parentIds) {
      if (seen.has(p)) continue;
      seen.add(p);
      queue.push(p);
      if (seen.size > 64) return seen;
    }
  }
  return seen;
}

/**
 * Check the model's answer against the evidence and the rules. Anything
 * that fails is dropped with a reason, never repaired into something the
 * model did not say.
 */
export function parseTidyPlan(
  raw: string,
  ctx: { evidence: ReadonlyArray<TidySpaceEvidence>; rejectedKeys: ReadonlySet<string> }
): ParsedTidyPlan {
  const obj = extractJsonObject(raw);
  const dropped: string[] = [];
  if (obj === null || typeof obj !== 'object') return { summary: '', moves: [], dropped: ['answer was not a JSON object'] };
  const o = obj as Record<string, unknown>;
  const summary = typeof o['summary'] === 'string' ? o['summary'].trim().slice(0, 600) : '';
  const rawMoves = Array.isArray(o['moves']) ? (o['moves'] as unknown[]) : [];
  const byId = new Map(ctx.evidence.map((e) => [e.id, e] as const));
  const moves: TidyMove[] = [];
  const seen = new Set<string>();
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);
  const strs = (v: unknown, max: number): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim().slice(0, 200)).slice(0, max) : [];
  const writableSpace = (id: string, what: string, allowArchived = false): TidySpaceEvidence | null => {
    const e = byId.get(id);
    if (e === undefined) {
      dropped.push(`${what}: unknown Space ${id}`);
      return null;
    }
    if (!e.writable) {
      dropped.push(`${what}: ${e.name} is not writable by the viewer`);
      return null;
    }
    // Rule 2: an archived Space is touched only to take it out of a parent.
    if (e.archived && !allowArchived) {
      dropped.push(`${what}: ${e.name} is archived`);
      return null;
    }
    return e;
  };

  for (const rm of rawMoves) {
    if (moves.length >= MAX_TIDY_MOVES) break;
    if (rm === null || typeof rm !== 'object') continue;
    const m = rm as Record<string, unknown>;
    const kind = str(m['kind']) as TidyMoveKind;
    const reason = str(m['reason']).slice(0, MAX_REASON);
    const evidence = strs(m['evidence'], MAX_EVIDENCE);
    const confidence = num(m['confidence']);
    if (reason.length === 0) {
      dropped.push(`${kind || 'move'}: no reason given`);
      continue;
    }
    let move: TidyMove | null = null;
    switch (kind) {
      case 'nest': {
        const child = writableSpace(str(m['spaceId']), 'nest');
        const parent = byId.get(str(m['parentId']));
        if (child === null) break;
        if (parent === undefined) {
          dropped.push(`nest: unknown parent ${str(m['parentId'])}`);
          break;
        }
        if (!parent.writable) {
          dropped.push(`nest: parent ${parent.name} is not writable by the viewer`);
          break;
        }
        if (child.id === parent.id) {
          dropped.push(`nest: ${child.name} cannot sit inside itself`);
          break;
        }
        if (parent.archived) {
          dropped.push(`nest: ${parent.name} is archived`);
          break;
        }
        if (child.parentIds.includes(parent.id)) {
          dropped.push(`nest: ${child.name} is already inside ${parent.name}`);
          break;
        }
        if (ancestorsOf(parent.id, byId).has(child.id)) {
          dropped.push(`nest: ${parent.name} already sits below ${child.name} (cycle)`);
          break;
        }
        move = { key: '', kind, spaceId: child.id, spaceName: child.name, parentId: parent.id, parentName: parent.name, reason, evidence, confidence, decision: 'undecided' };
        break;
      }
      case 'unnest': {
        const child = writableSpace(str(m['spaceId']), 'unnest', true);
        const parent = byId.get(str(m['parentId']));
        if (child === null) break;
        if (parent === undefined || !child.parentIds.includes(parent.id)) {
          dropped.push(`unnest: ${child.name} is not inside ${str(m['parentId'])}`);
          break;
        }
        move = { key: '', kind, spaceId: child.id, spaceName: child.name, parentId: parent.id, parentName: parent.name, reason, evidence, confidence, decision: 'undecided' };
        break;
      }
      case 'merge': {
        const source = writableSpace(str(m['spaceId']), 'merge');
        const target = writableSpace(str(m['targetId']), 'merge target');
        if (source === null || target === null) break;
        if (source.id === target.id) {
          dropped.push(`merge: ${source.name} into itself`);
          break;
        }
        if (target.archived) {
          dropped.push(`merge: target ${target.name} is archived`);
          break;
        }
        const targetMembers = new Set(target.members);
        const membersNotInTarget = source.members.filter((p) => !targetMembers.has(p) && p !== target.createdBy);
        move = {
          key: '',
          kind,
          spaceId: source.id,
          spaceName: source.name,
          targetId: target.id,
          targetName: target.name,
          reason,
          evidence,
          confidence,
          decision: 'undecided',
          ...(membersNotInTarget.length > 0 ? { membersNotInTarget } : {}),
        };
        break;
      }
      case 'archive': {
        const target = writableSpace(str(m['spaceId']), 'archive');
        if (target === null) break;
        if (target.source === 'lite-group') {
          dropped.push(`archive: ${target.name} is a group the app keeps`);
          break;
        }
        move = { key: '', kind, spaceId: target.id, spaceName: target.name, reason, evidence, confidence, decision: 'undecided' };
        break;
      }
      case 'rename': {
        const target = writableSpace(str(m['spaceId']), 'rename');
        const name = str(m['name']).slice(0, MAX_NAME);
        if (target === null) break;
        if (name.length === 0 || name.toLowerCase() === target.name.trim().toLowerCase()) {
          dropped.push(`rename: no new name for ${target.name}`);
          break;
        }
        move = { key: '', kind, spaceId: target.id, spaceName: target.name, name, reason, evidence, confidence, decision: 'undecided' };
        break;
      }
      case 'create-parent': {
        const name = str(m['name']).slice(0, MAX_NAME);
        const childIds = Array.from(new Set(strs(m['childIds'], 40)));
        if (name.length === 0) {
          dropped.push('create-parent: no name');
          break;
        }
        const children: TidySpaceEvidence[] = [];
        let bad = false;
        for (const id of childIds) {
          const c = writableSpace(id, 'create-parent child');
          if (c === null) {
            bad = true;
            break;
          }
          children.push(c);
        }
        if (bad) break;
        if (children.length < 2) {
          dropped.push(`create-parent "${name}": fewer than two children`);
          break;
        }
        if (ctx.evidence.some((e) => !e.archived && e.name.trim().toLowerCase() === name.toLowerCase())) {
          dropped.push(`create-parent "${name}": a Space with that name exists (propose nest instead)`);
          break;
        }
        move = {
          key: '',
          kind,
          name,
          childIds: children.map((c) => c.id),
          childNames: children.map((c) => c.name),
          reason,
          evidence,
          confidence,
          decision: 'undecided',
        };
        break;
      }
      default:
        dropped.push(`unknown move kind "${String(m['kind'])}"`);
    }
    if (move === null) continue;
    move.key = moveKey(move);
    if (seen.has(move.key)) {
      dropped.push(`duplicate: ${describeMove(move)}`);
      continue;
    }
    if (ctx.rejectedKeys.has(move.key)) {
      dropped.push(`previously rejected: ${describeMove(move)}`);
      continue;
    }
    seen.add(move.key);
    moves.push(move);
  }
  return { summary, moves, dropped };
}

/** Structural moves first, then names, then containment, then merges, then archives. */
export function applyOrder(moves: ReadonlyArray<TidyMove>): TidyMove[] {
  const rank: Record<TidyMoveKind, number> = { 'create-parent': 0, rename: 1, unnest: 2, nest: 3, merge: 4, archive: 5 };
  return [...moves].sort((a, b) => rank[a.kind] - rank[b.kind]);
}

/** The slice of the Spaces API an accepted move needs. Every port already carries its own guard. */
export interface TidyApplyPorts {
  nest(childId: string, parentId: string): Promise<void>;
  unnest(childId: string, parentId: string): Promise<void>;
  archive(id: string, reason: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  createSpace(name: string, description: string): Promise<string>;
  listItemIds(spaceId: string): Promise<string[]>;
  moveItem(itemId: string, fromSpaceId: string, toSpaceId: string): Promise<void>;
}

export async function applyTidyMove(move: TidyMove, ports: TidyApplyPorts): Promise<void> {
  switch (move.kind) {
    case 'nest':
      await ports.nest(move.spaceId ?? '', move.parentId ?? '');
      return;
    case 'unnest':
      await ports.unnest(move.spaceId ?? '', move.parentId ?? '');
      return;
    case 'archive':
      await ports.archive(move.spaceId ?? '', 'tidy');
      return;
    case 'rename':
      await ports.rename(move.spaceId ?? '', move.name ?? '');
      return;
    case 'merge': {
      const source = move.spaceId ?? '';
      const target = move.targetId ?? '';
      for (const itemId of await ports.listItemIds(source)) {
        await ports.moveItem(itemId, source, target);
      }
      await ports.archive(source, `merged-into:${target}`);
      return;
    }
    case 'create-parent': {
      const parentId = await ports.createSpace(
        move.name ?? '',
        `Groups ${(move.childNames ?? []).map((n) => `"${n}"`).join(', ')}. Made by Tidy up on ${new Date().toISOString().slice(0, 10)}.`
      );
      for (const childId of move.childIds ?? []) {
        await ports.nest(childId, parentId);
      }
      return;
    }
  }
}

/** When the background pass should prepare a plan. */
export function shouldRunScheduled(input: {
  settings: TidySettings;
  lastRunAt: string | null;
  now: Date;
  topLevel: number;
  spaceCount: number;
}): boolean {
  if (input.spaceCount < 4) return false;
  const sinceMs = input.lastRunAt === null ? Number.POSITIVE_INFINITY : input.now.getTime() - new Date(input.lastRunAt).getTime();
  const day = 24 * 60 * 60 * 1000;
  if (sinceMs >= input.settings.cadenceDays * day) return true;
  return input.topLevel > input.settings.topLevelThreshold && sinceMs >= day;
}
