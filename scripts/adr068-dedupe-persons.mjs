#!/usr/bin/env node
/**
 * ADR-068 Phase 4 — Person dedupe migration (dry-run by default).
 *
 * Merges a CONFIRMED list of duplicate :Person nodes for one human into
 * a single canonical node, preserving every relationship type + direction
 * and re-keying Space/asset createdBy + Commit.author. The merge list is
 * explicit (not auto-detected) so a one-time live migration can't sweep
 * in an unrelated identity. Reviewed with robb 2026-08-15:
 *   robb+admin/onereach@…          (639 CREATED) → robb@onereach.com
 *   robb+multitenant/…/gsx_expert@ (51 ENABLED/MEMBER, GSX-Desktop) → robb
 *   35254342… (accountId fallback) (VIEWED + presence) → robb  [MERGE, not delete]
 *   ca66c2d2… is a DIFFERENT identity (a Lite install) — untouched.
 *
 *   node scripts/adr068-dedupe-persons.mjs            # DRY RUN (no writes)
 *   node scripts/adr068-dedupe-persons.mjs --execute  # perform the merge
 */

const EXECUTE = process.argv.includes('--execute');
const EP =
  process.env.EDISON_NEON_EP ||
  'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/omnidata/neon2';
// Credentials come from the environment — no baked secret in this
// committed script (export guard would block it). Supply NEON_URI,
// NEON_USER, NEON_PASSWORD (+ optional EDISON_NEON_EP) when running.
const CREDS = {
  neonUri: process.env.NEON_URI,
  neonUser: process.env.NEON_USER,
  neonPassword: process.env.NEON_PASSWORD,
  database: process.env.NEON_DATABASE || 'neo4j',
};
if (!CREDS.neonUri || !CREDS.neonUser || !CREDS.neonPassword) {
  console.error('Set NEON_URI, NEON_USER, NEON_PASSWORD (and optionally EDISON_NEON_EP) before running.');
  process.exit(2);
}

// The confirmed merge: every dup id → the canonical id.
const CANONICAL = 'robb@onereach.com';
const DUPS = [
  'robb+admin/onereach@onereach.com',
  'robb+multitenant/edison/gsx_expert@onereach.com',
  '35254342-4a2e-475b-aec1-18547e517e29',
];
// Every relationship type present on the dups (verified). The migration
// ABORTS if a dup carries a type outside this set — never silently drop.
const HANDLED_TYPES = ['CREATED', 'ENABLED', 'OWNS', 'VIEWED', 'USES', 'LOGGED', 'MEMBER', 'PRESENCE_OF'];

async function q(cypher, parameters = {}) {
  const r = await fetch(EP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...CREDS, cypher, parameters }),
  });
  const j = await r.json();
  const res = j.result ?? {};
  if (res.status && res.status !== 'ok') throw new Error(`neon: ${JSON.stringify(res).slice(0, 200)}`);
  return res.records ?? [];
}

async function relTypes(id) {
  const rows = await q(
    `MATCH (p:Person {id:$id})-[r]-() RETURN collect(DISTINCT type(r)) AS types`,
    { id }
  );
  return rows[0]?.types ?? [];
}

async function main() {
  console.log(`ADR-068 Person dedupe — ${EXECUTE ? 'EXECUTE (writing)' : 'DRY RUN (no writes)'}`);
  console.log(`canonical: ${CANONICAL}\n`);

  // Pre-flight: verify the canonical exists and each dup's rel types are handled.
  const canonExists = await q('MATCH (p:Person {id:$id}) RETURN count(p) AS n', { id: CANONICAL });
  if ((canonExists[0]?.n ?? 0) === 0) throw new Error(`canonical ${CANONICAL} not found`);

  for (const from of DUPS) {
    const exists = await q('MATCH (p:Person {id:$id}) RETURN count(p) AS n', { id: from });
    if ((exists[0]?.n ?? 0) === 0) { console.log(`   (skip, absent) ${from}`); continue; }
    const types = await relTypes(from);
    const unhandled = types.filter((t) => !HANDLED_TYPES.includes(t));
    if (unhandled.length > 0) {
      throw new Error(`ABORT: ${from} has unhandled rel types ${JSON.stringify(unhandled)} — extend HANDLED_TYPES`);
    }
    const cb = await q('MATCH (s:Space) WHERE s.createdBy = $id RETURN count(s) AS n', { id: from });
    console.log(`   merge ← ${from}  (relTypes=${types.join(',')||'none'}, spaces.createdBy=${cb[0]?.n ?? 0})`);

    if (!EXECUTE) continue;

    // Re-point each handled type, preserving direction + properties.
    for (const t of HANDLED_TYPES) {
      await q(
        `MATCH (dup:Person {id:$from})-[r:${t}]->(x)
         MATCH (canon:Person {id:$to})
         MERGE (canon)-[nr:${t}]->(x) SET nr += properties(r)
         DELETE r`,
        { from, to: CANONICAL }
      );
      await q(
        `MATCH (x)-[r:${t}]->(dup:Person {id:$from})
         MATCH (canon:Person {id:$to})
         MERGE (x)-[nr:${t}]->(canon) SET nr += properties(r)
         DELETE r`,
        { from, to: CANONICAL }
      );
    }
    // Re-key authorship props that used the dup id.
    await q('MATCH (s:Space) WHERE s.createdBy = $from SET s.createdBy = $to', { from, to: CANONICAL });
    await q('MATCH (a) WHERE a.createdBy = $from SET a.createdBy = $to', { from, to: CANONICAL });
    await q('MATCH (c:Commit) WHERE c.author = $from SET c.author = $to', { from, to: CANONICAL });
    // The dup must now be edge-free (all handled types re-pointed).
    const left = await q('MATCH (p:Person {id:$id})-[r]-() RETURN count(r) AS n', { id: from });
    if ((left[0]?.n ?? 0) > 0) throw new Error(`ABORT: ${from} still has ${left[0].n} edges after re-point`);
    await q('MATCH (p:Person {id:$id}) DELETE p', { id: from });
    console.log(`   ✓ merged + deleted ${from}`);
  }

  if (!EXECUTE) { console.log('\nDRY RUN complete — no writes. Re-run with --execute.'); return; }

  const final = await q(
    `MATCH (p:Person {id:$id})
     RETURN size([(p)-[:CREATED]->()|1]) AS created,
            size([(p)-[:HAS_ACCESS]->()|1]) AS memberOf,
            size([(p)-[:ENABLED]->()|1]) AS enabled,
            size([(p)-[:OWNS]->()|1]) AS owns`,
    { id: CANONICAL }
  );
  console.log(`\nEXECUTE complete. Canonical ${CANONICAL}:`, JSON.stringify(final[0]));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
