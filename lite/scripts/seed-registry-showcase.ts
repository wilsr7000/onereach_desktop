/**
 * Registry showcase seed (2026-09-05) — prepares live NEON + the shared
 * admission document for a Gartner walkthrough of the Agent Registry and
 * the IDW Store. Idempotent; dry-run by default; `--apply` writes.
 *
 *   npx tsx lite/scripts/seed-registry-showcase.ts            # plan only
 *   npx tsx lite/scripts/seed-registry-showcase.ts --apply    # write
 *
 * Every agent write goes through the REAL registry API (`RegistryApi`), so
 * it is gated exactly like the window (admin or creator) and stamped with
 * `_Manifest` provenance. Only facts are recorded:
 *
 *   - Record fields: `type` = the agent's own executionType, `status`
 *     active (they run today), `version` = the desktop app they ship in.
 *   - Endpoints: the full app's local agent gateway (a real route,
 *     POST /submit-task) as an `api` endpoint; Lite's Spaces MCP server
 *     (stdio transport) for the Spaces Assistant. No invented hosts.
 *   - IDW links: each showcase agent APPLIES_TO the "My AI" IDW — the
 *     desktop agents surfaced to the user's personal IDW. A modeling
 *     choice, stated here and in the report; change it in the window.
 *   - IDW nodes: the user's REAL IDWs from the Lite IDW list (GSX Expert,
 *     Accounting, IDW Staging) — name + URL only, no invented ratings.
 *   - Admission (Spaces Assistant): Analyze ticks what the graph proves;
 *     b4 / b5 / c1 are ticked with the evidence noted below; F2 (owner
 *     sign-off) is recorded for the platform owner. F1 is NOT ticked: it
 *     requires "the evidence pack exports from the registry in one
 *     action" and the registry has no export action yet. Listing needs
 *     F1 + F2, so the honest end state is SUBMITTED, not listed.
 */

import { EdisonNeonClient } from '../neon/client.js';
import { StaticCredentialsProvider, BAKED_IN_DEFAULT_GRAPH } from '../neon/credentials.js';
import { RegistryApi } from '../registry/api.js';
import type { AdmissionLineId } from '../registry/admission.js';

const APPLY = process.argv.includes('--apply');
const VIEWER = 'robb@onereach.com';
const APP_VERSION = '5.0.39'; // the desktop app these builtin agents ship in
const GATEWAY_API = 'http://127.0.0.1:3456/submit-task'; // lib/agent-gateway.js, real route
const SPACES_MCP = 'stdio://onereach-lite/spaces-mcp'; // lite/mcp/spaces-mcp.ts (stdio transport)
const MY_AI_IDW = 'idw_cust_success'; // :IDW "My AI"
const KV_URL = 'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/keyvalue2';

const SHOWCASE_AGENTS = [
  'spaces-agent',
  'weather-agent',
  'calendar-query-agent',
  'calendar-mutate-agent',
  'time-agent',
  'search-agent',
  'daily-brief-agent',
  'help-agent',
  'docs-agent',
  'meeting-notes-agent',
];

/** The user's real IDWs (from the Lite IDW list) that have no :IDW node yet. */
const NEW_IDWS = [
  { id: 'idw_gsx_expert', name: 'GSX Expert', url: 'https://idw.edison.onereach.ai/gsx-expert', category: 'Main', description: 'The GSX product expert IDW — guidance on building with GSX.' },
  { id: 'idw_accounting', name: 'Accounting', url: 'https://idw.edison.onereach.ai/sparky', category: 'Finance', description: 'The accounting IDW (Sparky).' },
  { id: 'idw_staging', name: 'IDW Staging', url: 'https://idw.edison.onereach.ai/staging', category: 'Staging', description: 'The staging IDW for pre-release checks.' },
];

/** Admission lines ticked by hand, each with the evidence it rests on. */
const ADMISSION_TICKS: Array<{ id: AdmissionLineId; evidence: string }> = [
  { id: 'b4', evidence: 'The desktop exchange exposes stop (POST /cancel-task) and steer (POST /respond-input) mid-flight; both are recorded in the structured event log with session + source.' },
  { id: 'b5', evidence: 'Every Lite write to the graph stamps who/when/which app (_Manifest provenance; ADR-026 commits carry the author).' },
  { id: 'c1', evidence: 'Every run logs to the structured event log with identity and session (ADR-030 spans; full-app situation logger).' },
  { id: 'f2', evidence: 'Owner sign-off recorded by the platform owner (robb@onereach.com) with identity and time.' },
];

const kv = {
  async get(collection: string, key: string): Promise<unknown | null> {
    const r = await fetch(`${KV_URL}?id=${encodeURIComponent(collection)}&key=${encodeURIComponent(key)}`);
    if (r.status === 404) return null;
    const t = await r.text();
    if (t === '' || t === 'null') return null;
    try {
      const p = JSON.parse(t) as { value?: unknown };
      return p.value ?? p;
    } catch {
      return t;
    }
  },
  async set(collection: string, key: string, value: unknown): Promise<void> {
    if (!APPLY) {
      console.log(`  [dry-run] KV set ${collection}/${key} (${JSON.stringify(value).length} bytes)`);
      return;
    }
    const enc = JSON.stringify(value);
    const r = await fetch(`${KV_URL}?id=${encodeURIComponent(collection)}&key=${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: collection, key, itemValue: enc, n: enc }),
    });
    if (!r.ok) throw new Error(`KV set failed: HTTP ${r.status}`);
  },
};

async function main(): Promise<void> {
  console.log(APPLY ? '=== APPLY mode: writing to live NEON + the shared admission document' : '=== DRY RUN: plan only (pass --apply to write)');
  const neon = new EdisonNeonClient({ credentials: new StaticCredentialsProvider(BAKED_IN_DEFAULT_GRAPH) });
  const query = (cy: string, p: Record<string, unknown>): Promise<Array<Record<string, unknown>>> =>
    neon.query(`/* caller:onereach-lite */ ${cy}`, p) as Promise<Array<Record<string, unknown>>>;
  const api = new RegistryApi({ query, viewerId: () => VIEWER, kv });

  // 1. Admin — the writes below are gated; claim only while no admin exists.
  let who = await api.whoAmI();
  console.log(`admin state: isAdmin=${who.isAdmin} noAdminYet=${who.noAdminYet} admins=${JSON.stringify(who.admins)}`);
  if (!who.isAdmin) {
    if (!who.noAdminYet) throw new Error('An admin already exists and it is not the viewer — refusing to seed as a non-admin.');
    console.log(`→ claim first admin as ${VIEWER}`);
    if (APPLY) {
      who = await api.claimFirstAdmin();
      console.log(`  now isAdmin=${who.isAdmin}`);
    }
  }

  // 2. IDW nodes for the user's real IDWs (no registry API for this — ADR-086 "not done").
  for (const idw of NEW_IDWS) {
    const exists = await query(`MATCH (i:IDW {id: $id}) RETURN i.id AS id`, { id: idw.id });
    if (exists.length > 0) {
      console.log(`idw ${idw.id}: exists, skip`);
      continue;
    }
    console.log(`→ create :IDW ${idw.id} (${idw.name}, ${idw.url})`);
    if (APPLY) {
      await query(
        `MERGE (i:IDW {id: $id})
         ON CREATE SET i.name = $name, i.url = $url, i.homePageURL = $url, i.description = $description,
           i.category = $category, i.developer = 'OneReach.ai', i.active = true, i.status = 'active',
           i.created_by_app_id = 'onereach-lite', i.created_by_app_name = 'Onereach.ai Lite',
           i.created_by_user = $viewer, i.created_at = $now, i.createdAt = $now,
           i.updated_by_app_id = 'onereach-lite', i.updated_by_app_name = 'Onereach.ai Lite',
           i.updated_by_user = $viewer, i.updated_at = toString($now), i.updatedAt = $now
         RETURN i.id AS id`,
        { ...idw, viewer: VIEWER, now: Date.now() }
      );
    }
  }

  // 3. Showcase agents: record fields, endpoints, IDW link — all via the registry API.
  for (const id of SHOWCASE_AGENTS) {
    const d = await api.get(id);
    if (d === null) {
      console.log(`agent ${id}: NOT FOUND, skip`);
      continue;
    }
    const row = (await query(`MATCH (a:Agent {id: $id}) RETURN a.executionType AS et, a.type AS type, a.status AS status, a.version AS version`, { id }))[0] ?? {};
    const type = typeof row['et'] === 'string' && (row['et'] as string).length > 0 ? (row['et'] as string) : 'action';
    const patch: { type?: string; status?: string; version?: string } = {};
    if (row['type'] !== type) patch.type = type;
    if (row['status'] !== 'active') patch.status = 'active';
    if (row['version'] !== APP_VERSION) patch.version = APP_VERSION;
    console.log(`agent ${id} (${d.name}): patch=${JSON.stringify(patch)} endpoints=${d.endpoints.length} idws=${d.idws.length}`);
    if (Object.keys(patch).length > 0 && APPLY) await api.update(id, patch);

    const urls = new Set(d.endpoints.map((e) => e.url));
    if (!urls.has(GATEWAY_API)) {
      console.log(`  → add api endpoint ${GATEWAY_API}`);
      if (APPLY) await api.addEndpoint(id, { kind: 'api', url: GATEWAY_API, channels: ['desktop'] });
    }
    if (id === 'spaces-agent' && !urls.has(SPACES_MCP)) {
      console.log(`  → add mcp endpoint ${SPACES_MCP}`);
      if (APPLY) await api.addEndpoint(id, { kind: 'mcp', url: SPACES_MCP, channels: ['claude-code', 'claude-desktop'] });
    }
    if (!d.idws.some((r) => r.id === MY_AI_IDW)) {
      console.log(`  → link APPLIES_TO_IDW ${MY_AI_IDW}`);
      if (APPLY) await api.link(id, 'idw', MY_AI_IDW, true);
    }
  }

  // 4. One agent through admission: Spaces Assistant.
  const showcase = 'spaces-agent';
  console.log(`admission for ${showcase}:`);
  if (APPLY) {
    const analyzed = await api.admissionAnalyze(showcase);
    console.log(`  analyze → rung=${analyzed.view.status.rung} grade=${analyzed.view.status.grade} met=${analyzed.view.status.progress.met}/${analyzed.view.status.progress.total}`);
  } else {
    console.log('  [dry-run] analyze (graph-proven ticks + recorded evidence)');
  }
  const before = await api.admissionGet(showcase);
  const items: Partial<Record<AdmissionLineId, boolean>> = {};
  for (const t of ADMISSION_TICKS) {
    if (before.entry?.items?.[t.id] === true) continue;
    items[t.id] = true;
    console.log(`  → tick ${t.id}: ${t.evidence}`);
  }
  if (APPLY && Object.keys(items).length > 0) {
    await api.admissionSave(showcase, { platform: 'gsx', ownerEmail: VIEWER, items });
  }
  const after = APPLY ? await api.admissionGet(showcase) : before;
  console.log(`  status: rung=${after.status.rung} grade=${after.status.grade} signed=${after.status.signed} admit=${after.status.admit}`);
  console.log(`  why: ${after.status.why}`);
  if (APPLY) {
    if (after.status.grade !== null && after.status.grade !== 'c') {
      const listed = await api.setListing(showcase, 'submitted');
      console.log(`  listing → ${listed.listing}`);
    } else {
      console.log('  listing unchanged (grade Critical or unstarted)');
    }
    console.log('  NOTE: "listed" needs F1 + F2; F1 (evidence pack export in one action) has no registry action yet — left unticked.');
  }
  console.log('=== done');
}

void main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
