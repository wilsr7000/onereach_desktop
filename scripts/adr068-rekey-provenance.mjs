#!/usr/bin/env node
/**
 * ADR-068 Phase 5 — provenance re-key (dry-run by default).
 *
 * Phase 4 merged robb's duplicate Person NODES (re-pointing 8 rel types
 * + createdBy/Commit.author). This pass re-keys the STRING-PROP
 * provenance the node merge could not touch, confirmed by the
 * 2026-08-16 live audit (generic sweep over every node/rel property):
 *
 *   created_by_user / updated_by_user   Agent x160, Playbook x24, Tool x14,
 *                                       Organization/Team/Library x1, Space x2
 *   CONTAINS.addedBy                    50 edges (onereach.com Library)
 *   App.user_id / ActivityLog.user_id   1 each (playbooks-riff-app)
 *
 * NOT handled here (deliberately):
 *   - Person {id: 35254342-…} + its Presence node + presence:logs KV key:
 *     the installed pre-fix Lite build re-mints them on every heartbeat;
 *     delete AFTER v0.0.69 is installed (use --cleanup-acct then).
 *   - KV namespaces keyed by old emails (tms:tickets:<raw>): separate
 *     copy, not a prop re-key.
 *
 *   node scripts/adr068-rekey-provenance.mjs                # DRY RUN
 *   node scripts/adr068-rekey-provenance.mjs --execute
 *   node scripts/adr068-rekey-provenance.mjs --execute --cleanup-acct
 */

const EXECUTE = process.argv.includes('--execute');
const CLEANUP_ACCT = process.argv.includes('--cleanup-acct');
const EP =
  process.env.EDISON_NEON_EP ||
  'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/omnidata/neon2';
const CREDS = {
  neonUri: process.env.NEON_URI,
  neonUser: process.env.NEON_USER,
  neonPassword: process.env.NEON_PASSWORD,
  database: process.env.NEON_DATABASE || 'neo4j',
};
if (!CREDS.neonUri || !CREDS.neonUser || !CREDS.neonPassword) {
  console.error('Set NEON_URI, NEON_USER, NEON_PASSWORD before running.');
  process.exit(2);
}

const CANONICAL = 'robb@onereach.com';
const OLD_EMAILS = [
  'robb+admin/onereach@onereach.com',
  'robb+multitenant/edison/gsx_expert@onereach.com',
];
const ACCT = '35254342-4a2e-475b-aec1-18547e517e29';

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

// Each step: [description, countCypher, rewriteCypher] — same params.
const STEPS = [
  [
    'created_by_user',
    `MATCH (n) WHERE n.created_by_user IN $old RETURN count(n) AS n`,
    `MATCH (n) WHERE n.created_by_user IN $old SET n.created_by_user = $to`,
  ],
  [
    'updated_by_user',
    `MATCH (n) WHERE n.updated_by_user IN $old RETURN count(n) AS n`,
    `MATCH (n) WHERE n.updated_by_user IN $old SET n.updated_by_user = $to`,
  ],
  [
    'CONTAINS.addedBy',
    `MATCH ()-[r:CONTAINS]->() WHERE r.addedBy IN $old RETURN count(r) AS n`,
    `MATCH ()-[r:CONTAINS]->() WHERE r.addedBy IN $old SET r.addedBy = $to`,
  ],
  [
    'App.user_id',
    `MATCH (n:App) WHERE n.user_id IN $old RETURN count(n) AS n`,
    `MATCH (n:App) WHERE n.user_id IN $old SET n.user_id = $to`,
  ],
  [
    'ActivityLog.user_id',
    `MATCH (n:ActivityLog) WHERE n.user_id IN $old RETURN count(n) AS n`,
    `MATCH (n:ActivityLog) WHERE n.user_id IN $old SET n.user_id = $to`,
  ],
];

async function main() {
  console.log(`ADR-068 Phase 5 provenance re-key — ${EXECUTE ? 'EXECUTE' : 'DRY RUN'}`);
  console.log(`canonical: ${CANONICAL}\n`);
  const params = { old: OLD_EMAILS, to: CANONICAL };

  for (const [name, countCy, rewriteCy] of STEPS) {
    const before = (await q(countCy, params))[0]?.n ?? 0;
    console.log(`  ${name}: ${before} to re-key`);
    if (!EXECUTE || before === 0) continue;
    await q(rewriteCy, params);
    const after = (await q(countCy, params))[0]?.n ?? 0;
    if (after !== 0) throw new Error(`ABORT: ${name} still has ${after} old refs after rewrite`);
    console.log(`    ✓ re-keyed, 0 remaining`);
  }

  // Re-minted accountId Person: only touch when explicitly asked, since
  // a running pre-fix Lite re-creates it on the next presence beat.
  const acctRows = await q(
    `MATCH (p:Person {id: $id}) OPTIONAL MATCH (p)-[r]-() RETURN count(r) AS rels`,
    { id: ACCT }
  );
  if (acctRows.length > 0) {
    console.log(`\n  Person {id: ${ACCT}} exists (rels: ${acctRows[0]?.rels ?? '?'})`);
    if (CLEANUP_ACCT && EXECUTE) {
      await q(`MATCH (pr:Presence {personId: $id}) DETACH DELETE pr`, { id: ACCT });
      await q(`MATCH (p:Person {id: $id}) DETACH DELETE p`, { id: ACCT });
      console.log('    ✓ deleted acct Person + its Presence (re-run audit after next Lite heartbeat window)');
    } else {
      console.log('    (left in place — pass --cleanup-acct AFTER the fixed Lite build is installed)');
    }
  }

  if (!EXECUTE) console.log('\nDRY RUN complete — no writes. Re-run with --execute.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
