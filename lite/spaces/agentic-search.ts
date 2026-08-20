/**
 * Agentic asset search — the LLM tier of the ONE search.
 *
 * Substring search finds what a query LITERALLY matches; this walk finds
 * what a query MEANS: candidates are examined one by one and a model
 * decides whether each genuinely satisfies the query's intent. Ported
 * from the full app's lib/playbook-search.js agentic tier (same walk
 * discipline), generalized past playbooks to every asset kind, and run
 * on Lite's own AI + Spaces APIs so it inherits ADR-051 visibility:
 * every candidate is fetched through the viewer-gated read path, so the
 * walk can never read — or reveal — an item the viewer cannot see.
 *
 * Cost discipline (the caps ARE the contract, pinned by tests):
 *   - keyword hits are examined first (likely matches surface early)
 *   - `stopAfter` matches end the walk (default 5)
 *   - `maxEvaluations` hard-caps model calls (default 25)
 *   - one failed evaluation SKIPS that item, never sinks the walk
 */

import type { AiApi } from '../ai/api.js';
import type { SpacesApi } from './api.js';
import type { ItemSummary } from './types.js';

export interface AgenticSearchOpts {
  spaceId?: string;
  maxEvaluations?: number;
  stopAfter?: number;
  onProgress?: (p: AgenticSearchProgress) => void;
}

export interface AgenticSearchProgress {
  phase: 'evaluating' | 'match';
  index: number;
  total: number;
  id: string;
  title: string;
  confidence?: number;
  matchesSoFar: number;
}

export interface AgenticMatch {
  id: string;
  title: string;
  spaceId: string | null;
  kind: string;
  confidence: number;
  reason: string;
}

export interface AgenticSearchResult {
  query: string;
  matches: AgenticMatch[];
  evaluated: number;
  totalCandidates: number;
  stoppedEarly: boolean;
}

const EVAL_CONTENT_CHARS = 6000;
const DEFAULT_MAX_EVALUATIONS = 25;
const DEFAULT_STOP_AFTER = 5;

function evalPrompt(query: string, title: string, kind: string, content: string): string {
  return `You are resolving a search query against ONE asset to decide if it matches.

Query: "${query}"

Asset title: ${title}
Asset kind: ${kind}
Asset content (may be truncated):
---
${content.slice(0, EVAL_CONTENT_CHARS)}
---

Does this asset genuinely satisfy the INTENT of the query — is it what
someone typing that query is looking for, or directly useful to it?
Matching keywords alone are not enough; judge purpose and subject.

Respond with JSON only:
{"match": true or false, "confidence": 0.0 to 1.0, "reason": "one sentence"}`;
}

/** Tolerant JSON extraction — models fence and preface despite orders. */
export function parseVerdict(text: string): { match: boolean; confidence: number; reason: string } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const conf = Number(raw['confidence']);
    return {
      match: raw['match'] === true,
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
      reason: typeof raw['reason'] === 'string' ? raw['reason'] : '',
    };
  } catch {
    return null;
  }
}

/**
 * Gather candidates: keyword hits first (already relevance-ranked by
 * the graph), then the scope's recent items the keywords missed — the
 * whole point of the agentic tier is finding what substring search
 * cannot.
 */
async function gatherCandidates(
  api: SpacesApi,
  query: string,
  spaceId: string | undefined,
  cap: number
): Promise<ItemSummary[]> {
  const seen = new Set<string>();
  const out: ItemSummary[] = [];
  const push = (rows: ReadonlyArray<ItemSummary>): void => {
    for (const row of rows) {
      if (seen.has(row.id) || out.length >= cap) continue;
      seen.add(row.id);
      out.push(row);
    }
  };
  try {
    push(await api.items.search({ query, ...(spaceId !== undefined ? { spaceId } : {}), limit: cap }));
  } catch {
    /* keyword tier down — the walk can still read the recents */
  }
  if (out.length < cap) {
    try {
      if (spaceId !== undefined) {
        push(await api.items.list({ kind: 'space', spaceId }, { limit: cap }));
      } else {
        // All-spaces: no single recents API on this surface — widen with
        // per-word keyword passes so the walk sees beyond the exact
        // phrase. (The full recents feed lives on the Home cache, not
        // the api; not worth a new read path for candidate padding.)
        for (const word of query.split(/\s+/).filter((w) => w.length >= 3).slice(0, 3)) {
          push(await api.items.search({ query: word, limit: cap }));
          if (out.length >= cap) break;
        }
      }
    } catch {
      /* recents unavailable — walk what we have */
    }
  }
  return out;
}

export async function runAgenticSearch(
  query: string,
  opts: AgenticSearchOpts,
  deps: { spacesApi: SpacesApi; ai: AiApi }
): Promise<AgenticSearchResult> {
  const q = query.trim();
  if (q.length === 0) {
    return { query: q, matches: [], evaluated: 0, totalCandidates: 0, stoppedEarly: false };
  }
  const maxEvaluations = opts.maxEvaluations ?? DEFAULT_MAX_EVALUATIONS;
  const stopAfter = opts.stopAfter ?? DEFAULT_STOP_AFTER;

  const candidates = await gatherCandidates(deps.spacesApi, q, opts.spaceId, maxEvaluations);
  const matches: AgenticMatch[] = [];
  let evaluated = 0;
  let stoppedEarly = false;

  for (let i = 0; i < candidates.length; i++) {
    if (matches.length >= stopAfter) {
      stoppedEarly = true;
      break;
    }
    const c = candidates[i]!;
    opts.onProgress?.({
      phase: 'evaluating',
      index: i,
      total: candidates.length,
      id: c.id,
      title: c.title,
      matchesSoFar: matches.length,
    });
    let content = '';
    try {
      const full = await deps.spacesApi.items.get(c.id);
      if (full === null) continue; // vanished or not visible — never guess
      content = typeof full.content === 'string' ? full.content : '';
    } catch {
      continue; // unreadable — skip, never sink the walk
    }
    let verdict: ReturnType<typeof parseVerdict> = null;
    try {
      const res = await deps.ai.chat({
        profile: 'fast',
        maxTokens: 300,
        messages: [{ role: 'user', content: evalPrompt(q, c.title, c.kind, content) }],
      });
      verdict = parseVerdict(res.content);
    } catch {
      continue; // one dead eval must not end the search
    }
    evaluated += 1;
    if (verdict !== null && verdict.match) {
      matches.push({
        id: c.id,
        title: c.title,
        spaceId: (c as { spaceId?: string | null }).spaceId ?? null,
        kind: c.kind,
        confidence: verdict.confidence,
        reason: verdict.reason,
      });
      opts.onProgress?.({
        phase: 'match',
        index: i,
        total: candidates.length,
        id: c.id,
        title: c.title,
        confidence: verdict.confidence,
        matchesSoFar: matches.length,
      });
    }
  }

  matches.sort((a, b) => b.confidence - a.confidence);
  return { query: q, matches, evaluated, totalCandidates: candidates.length, stoppedEarly };
}
