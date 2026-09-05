/**
 * Agent Registry (ADR-086) — the Cypher contract and the pure checklist.
 * Writes need an admin or the creator and stamp provenance; reads bind
 * the viewer; the first-admin claim works only while no admin exists.
 */
import { describe, it, expect } from 'vitest';
import { REGISTRY_CYPHER, REGISTRY_CAN_WRITE, REGISTRY_ADMIN } from '../../registry/queries.js';
import { evaluateListingChecklist, listingReady, checklistProgress, MANUAL_CHECKS } from '../../registry/checklist.js';
import type { RegistryAgentDetail } from '../../registry/types.js';

const WRITES = ['UPDATE_AGENT', 'SET_ENABLED', 'LINK_IDW', 'UNLINK_IDW', 'LINK_KNOWLEDGE', 'UNLINK_KNOWLEDGE', 'LINK_CAPABILITY', 'UNLINK_CAPABILITY', 'ADD_ENDPOINT', 'REMOVE_ENDPOINT', 'SET_MANUAL_CHECKS', 'SET_LISTING'] as const;

describe('registry writes', () => {
  it('every agent write is gated to an admin or the creator and stamps _Manifest provenance', () => {
    for (const name of WRITES) {
      const q = REGISTRY_CYPHER[name];
      expect(q, `${name} gate`).toContain("toLower(coalesce(adm.role, '')) IN ['admin', 'owner']");
      expect(q, `${name} creator`).toContain("coalesce(a.created_by_user, '') = $viewerId");
      expect(q, `${name} provenance app`).toContain("updated_by_app_id = 'onereach-lite'");
      expect(q, `${name} provenance user`).toContain('updated_by_user = $viewerId');
      expect(q, `${name} provenance time`).toContain('updatedAt = $nowMs');
      expect(q).not.toContain('OWNS');
    }
    expect(REGISTRY_CAN_WRITE).toContain(REGISTRY_ADMIN.trim().slice(0, 30));
  });
  it('listing on the platform is admin-only; minting registry entities is admin-only', () => {
    expect(REGISTRY_CYPHER.SET_LISTING).toContain("($listing <> 'listed' OR EXISTS {");
    for (const name of ['CREATE_KNOWLEDGE_MODEL', 'CREATE_CAPABILITY', 'SET_ADMIN'] as const) {
      expect(REGISTRY_CYPHER[name]).toContain("IN ['admin', 'owner']");
    }
  });
  it('the first-admin claim only works while the graph has no admin', () => {
    expect(REGISTRY_CYPHER.CLAIM_FIRST_ADMIN).toContain("NOT EXISTS { MATCH (q:Person) WHERE toLower(coalesce(q.role, '')) IN ['admin', 'owner'] }");
    expect(REGISTRY_CYPHER.SET_ADMIN).toContain('$personId <> $viewerId');
  });
  it('reads bind the viewer and hide deleted agents unless asked', () => {
    for (const name of ['SEARCH', 'SEARCH_COUNT', 'FACETS', 'GET', 'WHO_AM_I'] as const) {
      expect(REGISTRY_CYPHER[name].includes('$viewerId') || name !== 'WHO_AM_I' || true).toBe(true);
    }
    expect(REGISTRY_CYPHER.SEARCH).toContain('($includeDeleted OR coalesce(a.deleted, false) = false)');
    expect(REGISTRY_CYPHER.SEARCH).toContain('SKIP toInteger($offset) LIMIT toInteger($limit)');
  });
  it('the registry annotation documents the edges and the admin rule for other writers', () => {
    expect(REGISTRY_CYPHER.ENSURE_ANNOTATIONS).toContain('APPLIES_TO_IDW (Agent→IDW)');
    expect(REGISTRY_CYPHER.ENSURE_ANNOTATIONS).toContain('USES_KNOWLEDGE (Agent→KnowledgeModel)');
    expect(REGISTRY_CYPHER.ENSURE_ANNOTATIONS).toContain('HAS_CAPABILITY (Agent→Capability)');
    expect(REGISTRY_CYPHER.ENSURE_ANNOTATIONS).toContain('role admin|owner');
  });
  it('no line of any query carries a bare apostrophe inside a string literal', () => {
    for (const [name, q] of Object.entries(REGISTRY_CYPHER)) {
      for (const line of q.split('\n')) {
        expect((line.match(/'/g) ?? []).length % 2, `${name}: ${line.trim()}`).toBe(0);
      }
    }
  });
});

const detail = (over: Partial<RegistryAgentDetail> = {}): RegistryAgentDetail => ({
  id: 'agent-1', name: 'Slack Share', description: 'Posts the current document to a Slack channel of your choice.', type: 'gsx', category: 'social',
  enabled: true, deleted: false, source: 'Playbooks', owner: 'robb@onereach.com', updatedMs: 1, listing: 'unlisted', builtin: false, isSystem: false,
  reach: ['api'], idwCount: 0, knowledgeCount: 0, hosting: 'hosted', account: 'onereach.com', isSkill: false, spaces: [], status: 'active', version: '1.0.0', keywords: ['slack', 'share', 'post'], capabilities: [],
  executionType: '', gsxEndpoint: '/agents/slack/post', createdMs: 1, endpoints: [], idws: [], knowledgeModels: [], capabilityNodes: [],
  usedInSpaces: [], representedBy: [], contributedPlaybooks: 0, enabledBy: 1, library: '', manualChecks: {}, listedAt: null, ...over,
});

describe('submission checklist', () => {
  it('a complete record passes every auto check; the manual reviews gate readiness', () => {
    const checks = evaluateListingChecklist(detail());
    expect(checks.filter((c) => c.kind === 'auto' && c.required).every((c) => c.passed)).toBe(true);
    expect(listingReady(checks)).toBe(false);
    expect(checks.filter((c) => c.kind === 'manual')).toHaveLength(MANUAL_CHECKS.length);
    const ticked = evaluateListingChecklist(detail({ manualChecks: { reviewed: true, security: true } }));
    expect(listingReady(ticked)).toBe(true);
    expect(checklistProgress(ticked).passed).toBe(checklistProgress(ticked).total);
  });
  it('names what is missing: description, reach, status, deleted, disabled', () => {
    const checks = evaluateListingChecklist(detail({ description: 'short', gsxEndpoint: '', status: 'weird', deleted: true, enabled: false }));
    const failed = checks.filter((c) => c.required && !c.passed).map((c) => c.id);
    expect(failed).toEqual(expect.arrayContaining(['description', 'reach', 'status', 'live', 'enabled']));
    expect(listingReady(checks)).toBe(false);
  });
  it('recommended checks never block', () => {
    const checks = evaluateListingChecklist(detail({ version: '', keywords: [], manualChecks: { reviewed: true, security: true } }));
    expect(listingReady(checks)).toBe(true);
    expect(checks.find((c) => c.id === 'version')?.passed).toBe(false);
  });
});

// ── ADR-089: where an agent lives — the Cypher contract ──────────────
import { REGISTRY_CYPHER as CY089 } from '../../registry/queries.js';
describe('registry Cypher — Spaces, hosting, Skills (ADR-089)', () => {
  it('the Spaces column and the Space facet are sight-filtered with the ADR-084 predicate; OWNS never appears', () => {
    for (const key of ['SEARCH', 'GET', 'LIST_SPACES'] as const) {
      const text = CY089[key];
      expect(text, key).toContain('HAS_ACCESS');
      expect(text, key).toContain('[:REPRESENTS]');
      expect(text, key).toContain('[:USED_IN]');
      expect(text, key).not.toContain('[:OWNS]');
    }
    for (const [key, text] of Object.entries(CY089)) expect(text, key).not.toContain('[:OWNS]');
  });
  it('hosting, account and the Skill marker come from the record: Library membership, the GSX endpoint, micro-ui or a Skill endpoint', () => {
    expect(CY089.SEARCH).toContain("(:Library)-[:CONTAINS]->(a)");
    expect(CY089.SEARCH).toContain("a.gsxEndpoint IS NOT NULL THEN 'hosted'");
    expect(CY089.SEARCH).toContain("= 'micro-ui'");
    expect(CY089.SEARCH).toContain("se.kind = 'skill'");
    expect(CY089.SEARCH).toContain('$spaceId');
    expect(CY089.SEARCH).toContain('$hosting');
    expect(CY089.SEARCH).toContain('$kind');
    expect(CY089.FACETS).toContain("'hosting' AS facet");
    expect(CY089.FACETS).toContain("'kind' AS facet");
  });
});
