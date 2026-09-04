/**
 * The listing (submission) checklist — pure (ADR-086).
 *
 * Derived from the graph's own registry contract: `(:Schema
 * {entity:'Agent'}).properties_def` requires `id` and `name`, documents
 * `description`, `type`, `status` (active | inactive | deprecated) and
 * `version`; `_Manifest` requires provenance on every write and says an
 * agent connects to capabilities and knowledge per its relationships
 * field. Lite adds what makes an entry USABLE from the platform: a way
 * to reach it, an owner, and (recommended) a home — an IDW or a
 * knowledge model — plus three manual reviews an admin ticks.
 */

import type { ListingCheck, RegistryAgentDetail } from './types.js';

export const MANUAL_CHECKS: ReadonlyArray<{ id: string; label: string; required: boolean }> = [
  { id: 'reviewed', label: 'Description and behaviour reviewed by an admin', required: true },
  { id: 'security', label: 'Endpoints and credentials reviewed (no secrets in payload)', required: true },
  { id: 'docs', label: 'Usage notes or docs linked', required: false },
];

export function evaluateListingChecklist(agent: RegistryAgentDetail): ListingCheck[] {
  const checks: ListingCheck[] = [];
  const auto = (id: string, label: string, required: boolean, passed: boolean, detail: string): void => {
    checks.push({ id, label, kind: 'auto', required, passed, detail });
  };
  auto('id', 'Has a stable id', true, agent.id.trim().length > 0, agent.id);
  auto('name', 'Has a display name', true, agent.name.trim().length >= 3, agent.name);
  auto(
    'description',
    'Describes what it does (20+ characters)',
    true,
    agent.description.trim().length >= 20,
    `${agent.description.trim().length} characters`
  );
  auto('type', 'Has a type', true, agent.type.trim().length > 0, agent.type || 'none');
  auto('category', 'Has a category', true, agent.category.trim().length > 0, agent.category || 'none');
  const reachable =
    agent.endpoints.length > 0 || agent.gsxEndpoint.trim().length > 0 || agent.executionType === 'system';
  auto(
    'reach',
    'Reachable: an MCP, API or Skill endpoint (or a GSX endpoint / system agent)',
    true,
    reachable,
    agent.endpoints.length > 0
      ? agent.endpoints.map((e) => e.kind.toUpperCase()).join(', ')
      : agent.gsxEndpoint.length > 0
        ? `GSX ${agent.gsxEndpoint}`
        : agent.executionType === 'system'
          ? 'system agent'
          : 'no endpoint'
  );
  auto('owner', 'Has an owner', true, agent.owner.trim().length > 0, agent.owner || 'unknown');
  auto('live', 'Not deleted', true, !agent.deleted, agent.deleted ? 'deleted' : 'live');
  auto('enabled', 'Enabled', true, agent.enabled, agent.enabled ? 'enabled' : 'disabled');
  auto(
    'status',
    'Status set (active | inactive | deprecated)',
    true,
    ['active', 'inactive', 'deprecated'].includes(agent.status),
    agent.status || 'none'
  );
  auto('version', 'Has a version', false, agent.version.trim().length > 0, agent.version || 'none');
  auto('keywords', 'Three or more keywords', false, agent.keywords.length >= 3, `${agent.keywords.length} keywords`);
  auto(
    'home',
    'Belongs somewhere: an IDW or a knowledge model',
    false,
    agent.idws.length > 0 || agent.knowledgeModels.length > 0,
    `${agent.idws.length} IDW · ${agent.knowledgeModels.length} knowledge`
  );
  for (const m of MANUAL_CHECKS) {
    checks.push({
      id: m.id,
      label: m.label,
      kind: 'manual',
      required: m.required,
      passed: agent.manualChecks[m.id] === true,
      detail: agent.manualChecks[m.id] === true ? 'ticked' : 'not yet',
    });
  }
  return checks;
}

/** Every REQUIRED check passes — the entry may be listed. */
export function listingReady(checks: ReadonlyArray<ListingCheck>): boolean {
  return checks.every((c) => !c.required || c.passed);
}

export function checklistProgress(checks: ReadonlyArray<ListingCheck>): { passed: number; total: number } {
  const required = checks.filter((c) => c.required);
  return { passed: required.filter((c) => c.passed).length, total: required.length };
}
