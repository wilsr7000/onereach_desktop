/**
 * Spaces module -- Phase 0.5 discovery runner.
 *
 * Runs the 4 auto-runnable verification queries (Q1-Q4) defined in the
 * Spaces plan against the configured Neon endpoint via
 * `getNeonApi().query(...)`. Q5 (agent identity model) and Q6 (permission
 * composition semantics) are operational questions for the Edison team;
 * they appear in `DISCOVERY.md` as a template the human fills in.
 *
 * Outputs a structured `DiscoveryResults` envelope the renderer renders
 * as a Markdown-exportable panel. Every query either:
 *
 *   - succeeds (`ok: true`, `rows: NeonRecord[]`, `summary`),
 *   - fails recoverably (`ok: false`, `error: { code, message }`)
 *     -- the runner CONTINUES; one query's failure doesn't abort the
 *     suite, so the user sees partial results instead of empty state.
 *
 * Q1 has a graceful fallback: try `apoc.meta.stats()` first; if APOC
 * isn't installed, fall back to the explicit `UNION ALL` form. The
 * fallback is transparent to the renderer -- the result envelope
 * records which path was taken.
 *
 * @internal -- exposed to the renderer via the
 *   `lite:spaces:discovery:run` IPC handler.
 */

import { getNeonApi, NeonError } from '../neon/api.js';
import type { NeonRecord } from '../neon/api.js';

import type {
  DiscoveryGating,
  DiscoveryQueryId,
  DiscoveryQueryResult,
  DiscoveryResults,
} from './discovery-format.js';

// Re-export the shared types so consumers can import either from here
// (main-only callers) or from discovery-format.js (renderer-safe).
export type {
  DiscoveryGating,
  DiscoveryQueryId,
  DiscoveryQueryResult,
  DiscoveryResults,
} from './discovery-format.js';
export { discoveryResultsToMarkdown } from './discovery-format.js';

// ─── Local-only types ───────────────────────────────────────────────────

export interface DiscoveryQuerySpec {
  id: DiscoveryQueryId;
  title: string;
  cypher: string;
  /** Bound parameters for the query, if any. */
  parameters?: Record<string, unknown>;
  gating: DiscoveryGating;
  /** One-line summary the renderer shows above the result table. */
  rationale: string;
}

// ─── Query catalog ─────────────────────────────────────────────────────

const Q1_APOC: DiscoveryQuerySpec = {
  id: 'Q1',
  title: 'Q1 — Entity-type inventory (preferred: apoc.meta.stats())',
  cypher: 'CALL apoc.meta.stats() YIELD labels RETURN labels',
  gating: 'GATING',
  rationale:
    'Tells us which node labels exist in OmniGraph today. If only :Item exists, Phase 2 scope is confirmed by the data itself. If :Agent / :Workflow exist, the schema is forward-compatible.',
};

const Q1_FALLBACK: DiscoveryQuerySpec = {
  id: 'Q1',
  title: 'Q1 — Entity-type inventory (fallback: explicit UNION ALL)',
  cypher: [
    "MATCH (n:Item) RETURN 'Item' AS kind, count(n) AS count",
    'UNION ALL',
    "MATCH (n:Asset) RETURN 'Asset' AS kind, count(n) AS count",
    'UNION ALL',
    "MATCH (n:Agent) RETURN 'Agent' AS kind, count(n) AS count",
    'UNION ALL',
    "MATCH (n:Workflow) RETURN 'Workflow' AS kind, count(n) AS count",
    'UNION ALL',
    "MATCH (n:Person) RETURN 'Person' AS kind, count(n) AS count",
    'UNION ALL',
    "MATCH (n:Tool) RETURN 'Tool' AS kind, count(n) AS count",
  ].join('\n'),
  gating: 'GATING',
  rationale:
    'Fallback when APOC is not installed. Counts known labels explicitly. Missing labels return 0 rows for that branch -- safe.',
};

const Q2: DiscoveryQuerySpec = {
  id: 'Q2',
  title: 'Q2 — Provenance / authorship edges',
  cypher: [
    'MATCH ()-[r:PRODUCED_BY|AUTHORED_BY|WRITTEN_BY|CREATED_BY]->(p)',
    'RETURN type(r) AS edge, labels(p) AS principalType, count(*) AS count',
    'ORDER BY count DESC',
  ].join('\n'),
  gating: 'INFORMATIONAL',
  rationale:
    'Tells us whether agent-produced items already carry authorship in the graph. Non-empty rows = Phase 2d "Produced by" line is wireable immediately. Empty = defer provenance UI.',
};

const Q3: DiscoveryQuerySpec = {
  id: 'Q3',
  title: 'Q3 — Are agents first-class graph nodes',
  cypher: 'MATCH (a:Agent) RETURN count(a) AS agentCount',
  gating: 'INFORMATIONAL',
  rationale:
    'Confirms :Agent exists as a node label. Required for the provenance edge in Q2 to mean anything.',
};

const Q4: DiscoveryQuerySpec = {
  id: 'Q4',
  title: 'Q4 — User-level ACL filtering (single-account probe)',
  cypher: [
    '// WITH collapses to a single row before the second MATCH to avoid Cartesian product',
    'MATCH (s:Space) WITH count(s) AS spaceCount',
    'MATCH (i:Item) RETURN spaceCount, count(i) AS itemCount',
  ].join('\n'),
  gating: 'GATING',
  rationale:
    "Returns this account's visible Space + Item counts. The GATING outcome requires running again as a SECOND account with known-different memberships -- record the second account's results in DISCOVERY.md.",
};

// ─── Runner ─────────────────────────────────────────────────────────────

/**
 * Run the auto-runnable Phase 0.5 verification queries against the
 * configured Neon endpoint. Never throws -- per-query failures land in
 * the result envelope so the renderer can present partial results.
 */
export async function runDiscovery(): Promise<DiscoveryResults> {
  const startedAt = new Date().toISOString();
  const neon = getNeonApi();
  const results: DiscoveryQueryResult[] = [];

  // Q1: try APOC first, fall back on procedure-not-found.
  results.push(await runQ1(neon));

  // Q2-Q4: straightforward single-query runs.
  results.push(await runStandard(neon, Q2, summarizeQ2));
  results.push(await runStandard(neon, Q3, summarizeQ3));
  results.push(await runStandard(neon, Q4, summarizeQ4));

  const finishedAt = new Date().toISOString();
  const anyFailures = results.some((r) => !r.ok);
  const gatingFailures = results.some((r) => !r.ok && r.gating === 'GATING');
  return { startedAt, finishedAt, anyFailures, gatingFailures, results };
}

// ─── Per-query orchestration ───────────────────────────────────────────

async function runQ1(
  neon: ReturnType<typeof getNeonApi>
): Promise<DiscoveryQueryResult> {
  // Preferred path: apoc.meta.stats()
  const apocAttempt = await tryRunQuery(neon, Q1_APOC);
  if (apocAttempt.ok) {
    return {
      ...apocAttempt.result,
      summary: summarizeQ1Apoc(apocAttempt.result.rows),
      notes: [
        'APOC procedure available -- used apoc.meta.stats() as preferred path.',
      ],
    };
  }

  // If the APOC failure was a "procedure not found" (or anything that
  // looks like missing APOC), fall back to the explicit UNION ALL.
  const apocFailureLikelyMeansMissingApoc =
    apocAttempt.code === 'NEON_QUERY' &&
    /procedure|apoc\.meta\.stats|not.?found/i.test(apocAttempt.message);

  if (apocFailureLikelyMeansMissingApoc) {
    const fallback = await tryRunQuery(neon, Q1_FALLBACK);
    if (fallback.ok) {
      return {
        ...fallback.result,
        summary: summarizeQ1Fallback(fallback.result.rows),
        notes: [
          'APOC unavailable (apoc.meta.stats not found) -- fell back to explicit UNION ALL.',
          `APOC attempt error: ${apocAttempt.message}`,
        ],
      };
    }
    return {
      ...fallback.result,
      notes: [
        'APOC unavailable -- fallback also failed.',
        `APOC error: ${apocAttempt.message}`,
        `Fallback error: ${fallback.message}`,
      ],
    };
  }

  // APOC failed for some non-APOC reason (auth / network / permission).
  return {
    ...apocAttempt.result,
    notes: [
      'APOC attempt failed for non-APOC reason; fallback not attempted because the failure is unlikely to be procedure-related.',
    ],
  };
}

async function runStandard(
  neon: ReturnType<typeof getNeonApi>,
  spec: DiscoveryQuerySpec,
  summarize: (rows: NeonRecord[]) => string | undefined
): Promise<DiscoveryQueryResult> {
  const attempt = await tryRunQuery(neon, spec);
  if (attempt.ok) {
    const summary = summarize(attempt.result.rows);
    return summary !== undefined
      ? { ...attempt.result, summary }
      : attempt.result;
  }
  return attempt.result;
}

// ─── Wire helpers ──────────────────────────────────────────────────────

type AttemptResult =
  | { ok: true; result: DiscoveryQueryResult }
  | { ok: false; result: DiscoveryQueryResult; code: string; message: string };

async function tryRunQuery(
  neon: ReturnType<typeof getNeonApi>,
  spec: DiscoveryQuerySpec
): Promise<AttemptResult> {
  const started = performance.now();
  try {
    const rows = await neon.query(spec.cypher, spec.parameters);
    const durationMs = Math.round(performance.now() - started);
    return {
      ok: true,
      result: {
        id: spec.id,
        title: spec.title,
        gating: spec.gating,
        rationale: spec.rationale,
        ok: true,
        durationMs,
        cypher: spec.cypher,
        rows,
        notes: [],
      },
    };
  } catch (err) {
    const durationMs = Math.round(performance.now() - started);
    const code = err instanceof NeonError ? err.code : 'UNKNOWN';
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code,
      message,
      result: {
        id: spec.id,
        title: spec.title,
        gating: spec.gating,
        rationale: spec.rationale,
        ok: false,
        durationMs,
        cypher: spec.cypher,
        rows: [],
        error: { code, message },
        notes: [],
      },
    };
  }
}

// ─── Result summarizers (one-line UI hints) ────────────────────────────

function summarizeQ1Apoc(rows: NeonRecord[]): string {
  if (rows.length === 0) return 'APOC returned no rows.';
  const first = rows[0];
  const labels = first?.['labels'];
  if (labels === null || typeof labels !== 'object') {
    return 'APOC returned a non-object labels field.';
  }
  const entries = Object.entries(labels as Record<string, unknown>)
    .filter(([, count]) => typeof count === 'number' && (count as number) > 0)
    .sort(([, a], [, b]) => (b as number) - (a as number));
  if (entries.length === 0) return 'Graph is empty (no labels with rows).';
  const total = entries.reduce((sum, [, c]) => sum + (c as number), 0);
  const preview = entries
    .slice(0, 5)
    .map(([label, count]) => `${label}=${count}`)
    .join(', ');
  return `${entries.length} non-empty label(s), ${total} node(s) total. Top: ${preview}.`;
}

function summarizeQ1Fallback(rows: NeonRecord[]): string {
  const nonZero = rows.filter((r) => {
    const c = r['count'];
    return typeof c === 'number' && c > 0;
  });
  if (nonZero.length === 0) return 'All known labels returned 0 rows.';
  const preview = nonZero
    .map((r) => `${String(r['kind'])}=${String(r['count'])}`)
    .join(', ');
  return `${nonZero.length} non-empty label(s): ${preview}.`;
}

function summarizeQ2(rows: NeonRecord[]): string | undefined {
  if (rows.length === 0) {
    return 'No provenance edges found. Defer Phase 2d "Produced by" line.';
  }
  const total = rows.reduce(
    (sum, r) => sum + (typeof r['count'] === 'number' ? (r['count'] as number) : 0),
    0
  );
  return `${rows.length} edge type(s), ${total} edge(s) total. Phase 2d provenance line is wireable.`;
}

function summarizeQ3(rows: NeonRecord[]): string | undefined {
  if (rows.length === 0) return undefined;
  const count = rows[0]?.['agentCount'];
  if (typeof count !== 'number') return undefined;
  return count > 0
    ? `${count} :Agent node(s) exist. Agents are first-class.`
    : ':Agent label exists but is empty.';
}

function summarizeQ4(rows: NeonRecord[]): string | undefined {
  if (rows.length === 0) return undefined;
  const r = rows[0];
  if (r === undefined) return undefined;
  const spaceCount = r['spaceCount'];
  const itemCount = r['itemCount'];
  const fmt = (v: unknown): string =>
    typeof v === 'number' ? String(v) : '?';
  return `This account sees ${fmt(spaceCount)} Space(s) and ${fmt(itemCount)} Item(s). Re-run as a second account to confirm filtering.`;
}

