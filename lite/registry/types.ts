/**
 * Agent Registry — types (ADR-086, 2026-09-02).
 *
 * The registry manager reads the account's `:Agent` catalog straight
 * from NEON and lets an admin manage what is available on the platform
 * and what each agent belongs to: IDWs (`APPLIES_TO_IDW`), knowledge
 * models (`USES_KNOWLEDGE`), skills — capabilities (`HAS_CAPABILITY`)
 * and MCP/API/Skill reachability endpoints (`REACHABLE_VIA`). Listing
 * goes through a submission checklist derived from the graph's own
 * registry contract (`(:Schema {entity:'Agent'})` + `_Manifest`).
 */

export type RegistryListing = 'unlisted' | 'submitted' | 'listed' | 'rejected';
export type RegistryReach = 'mcp' | 'api' | 'skill';

export type RegistryHosting = 'library' | 'hosted' | 'catalog';
export interface RegistrySpaceRef {
  id: string;
  name: string;
  /** asset = an asset in the Space represents the agent; usage = the full app recorded use there. */
  via: 'asset' | 'usage';
}

export interface RegistryAgentSummary {
  /** ADR-089 — where it lives. */
  hosting: RegistryHosting;
  /** The account (Library name for library agents, else the creator's domain). */
  account: string;
  /** A Skill: an agent with a UI (human in the loop). */
  isSkill: boolean;
  /** Spaces the VIEWER may see that hold this agent (ADR-084 sight). */
  spaces: RegistrySpaceRef[];
  id: string;
  name: string;
  description: string;
  /** `agentType` (Playbooks writer) or `type` (registry contract). */
  type: string;
  category: string;
  enabled: boolean;
  deleted: boolean;
  /** `created_by_app_name` — Playbooks, GSX-Desktop, … */
  source: string;
  owner: string;
  updatedMs: number;
  listing: RegistryListing;
  builtin: boolean;
  isSystem: boolean;
  reach: RegistryReach[];
  idwCount: number;
  knowledgeCount: number;
}

export interface RegistryEndpoint {
  id: string;
  kind: RegistryReach;
  url: string;
  channels: string[];
}

export interface RegistryRef {
  id: string;
  name: string;
  description: string;
  status: string;
  /** IDWs: chat / home URL, so Settings can install one into the IDW menu. */
  url?: string;
}

export interface RegistryAgentDetail extends RegistryAgentSummary {
  status: string;
  version: string;
  keywords: string[];
  capabilities: string[];
  executionType: string;
  gsxEndpoint: string;
  createdMs: number;
  endpoints: RegistryEndpoint[];
  idws: RegistryRef[];
  knowledgeModels: RegistryRef[];
  capabilityNodes: RegistryRef[];
  usedInSpaces: Array<{ id: string; name: string }>;
  representedBy: Array<{ assetId: string; spaceName: string }>;
  contributedPlaybooks: number;
  enabledBy: number;
  library: string;
  /** Manual submission checks the admin has ticked (`lite_listing_checks`). */
  manualChecks: Record<string, boolean>;
  listedAt: number | null;
}

export interface RegistrySearchInput {
  q?: string;
  source?: string;
  type?: string;
  category?: string;
  state?: '' | 'enabled' | 'disabled';
  listing?: '' | RegistryListing;
  reach?: '' | RegistryReach;
  idwId?: string;
  knowledgeId?: string;
  includeDeleted?: boolean;
  offset?: number;
  limit?: number;
  /** ADR-089 */
  spaceId?: string;
  hosting?: '' | RegistryHosting;
  kind?: '' | 'skill' | 'agent';
}

export interface RegistryFacet {
  value: string;
  count: number;
}

export interface RegistrySearchResult {
  items: RegistryAgentSummary[];
  total: number;
  offset: number;
  limit: number;
  facets: { sources: RegistryFacet[]; types: RegistryFacet[]; categories: RegistryFacet[]; hosting: RegistryFacet[]; kinds: RegistryFacet[] };
}

export interface RegistryViewer {
  viewerId: string | null;
  isAdmin: boolean;
  /** True when NO admin exists yet — the first-admin claim is offered. */
  noAdminYet: boolean;
  admins: string[];
}

export interface RegistryAgentPatch {
  name?: string;
  description?: string;
  type?: string;
  category?: string;
  status?: string;
  version?: string;
  keywords?: string[];
}

export interface ListingCheck {
  id: string;
  label: string;
  /** Auto checks are computed from the node; manual ones are ticked by an admin. */
  kind: 'auto' | 'manual';
  required: boolean;
  passed: boolean;
  detail: string;
}
