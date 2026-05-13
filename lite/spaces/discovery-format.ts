/**
 * Spaces module -- Phase 0.5 discovery formatter + shared types.
 *
 * Renderer-safe: no main-process imports. Both `lite/spaces/discovery.ts`
 * (main) and `lite/spaces/spaces.ts` (renderer) import from here. The
 * main-side runner uses these types as its return shape; the renderer
 * uses the same types to project incoming IPC payloads + the markdown
 * formatter to power "Copy as Markdown".
 */

import type { NeonRecord } from '../neon/types.js';

export type DiscoveryQueryId = 'Q1' | 'Q2' | 'Q3' | 'Q4';
export type DiscoveryGating = 'GATING' | 'INFORMATIONAL';

export interface DiscoveryQueryResult {
  id: DiscoveryQueryId;
  title: string;
  gating: DiscoveryGating;
  rationale: string;
  ok: boolean;
  durationMs: number;
  cypher: string;
  rows: NeonRecord[];
  summary?: string;
  error?: { code: string; message: string };
  notes: string[];
}

export interface DiscoveryResults {
  startedAt: string;
  finishedAt: string;
  anyFailures: boolean;
  gatingFailures: boolean;
  results: DiscoveryQueryResult[];
}

/**
 * Render a `DiscoveryResults` envelope as a human-paste-friendly
 * Markdown document. Used by the renderer's "Copy as Markdown" button
 * and by tests to snapshot the output format.
 */
export function discoveryResultsToMarkdown(results: DiscoveryResults): string {
  const lines: string[] = [];
  lines.push('# Spaces — Phase 0.5 Discovery Results');
  lines.push('');
  lines.push(`Started:  ${results.startedAt}`);
  lines.push(`Finished: ${results.finishedAt}`);
  lines.push(
    `Failures: ${results.anyFailures ? 'YES' : 'none'}` +
      (results.gatingFailures ? ' (GATING failures present)' : '')
  );
  lines.push('');

  for (const r of results.results) {
    lines.push(`## ${r.title}`);
    lines.push('');
    lines.push(`- **Gating**: ${r.gating}`);
    lines.push(`- **Status**: ${r.ok ? 'OK' : 'FAILED'}`);
    lines.push(`- **Duration**: ${r.durationMs}ms`);
    lines.push(`- **Rationale**: ${r.rationale}`);
    if (r.summary !== undefined) lines.push(`- **Summary**: ${r.summary}`);
    if (r.notes.length > 0) {
      lines.push('- **Notes**:');
      for (const note of r.notes) lines.push(`  - ${note}`);
    }
    lines.push('');
    lines.push('```cypher');
    lines.push(r.cypher);
    lines.push('```');
    lines.push('');

    if (r.ok) {
      lines.push('```json');
      lines.push(JSON.stringify(r.rows, null, 2));
      lines.push('```');
    } else if (r.error !== undefined) {
      lines.push('**Error**');
      lines.push('');
      lines.push('```');
      lines.push(`[${r.error.code}] ${r.error.message}`);
      lines.push('```');
    }
    lines.push('');
  }

  // Q5 / Q6 operational placeholders so the exported doc is self-contained.
  lines.push('## Q5 — Agent identity model (GATING, operational)');
  lines.push('');
  lines.push(
    '_Not runnable from the app. Resolve with the Edison team and paste answers below._'
  );
  lines.push('');
  lines.push('- How does an agent authenticate to `/omnidata/neon`? (TODO)');
  lines.push(
    "- Does an agent inherit the dispatching user's ACL, or have its own identity? (TODO)"
  );
  lines.push(
    '- Is there a schema model for agents as graph principals? (TODO)'
  );
  lines.push('');

  lines.push('## Q6 — Permission composition semantics (GATING, operational)');
  lines.push('');
  lines.push(
    '_Not runnable from the app. Resolve via authorization-layer code review or targeted multi-account test._'
  );
  lines.push('');
  lines.push(
    '- When entity-ACL and Space-ACL both apply, how do they compose? Intersection / union / override? (TODO)'
  );
  lines.push('');

  return lines.join('\n');
}
