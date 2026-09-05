/**
 * Agent Registry — the API over the NEON transport (ADR-086).
 * Every call binds `$viewerId` and `$nowMs`; writes refuse with
 * REGISTRY_FORBIDDEN when the Cypher gate (admin or creator) matches
 * nothing. Registry-contract vocabularies are enforced here in TS so a
 * typo can never widen a status or a listing.
 */

import { randomBytes } from 'node:crypto';
import { evaluateListingChecklist, listingReady, checklistProgress } from './checklist.js';
import {
  ADMISSION_KV,
  ADMISSION_LINES,
  ADMISSION_LINE_IDS,
  ADMISSION_PAGE_URL,
  ADMISSION_PLATFORMS,
  autoChecks,
  computeAdmission,
  findAdmissionEntry,
  type AdmissionAiLine,
  type AdmissionAnalysis,
  type AdmissionDoc,
  type AdmissionEntry,
  type AdmissionLineId,
  type AdmissionPlatform,
  type AdmissionStatus,
} from './admission.js';
import { REGISTRY_CYPHER } from './queries.js';
import type {
  ListingCheck,
  RegistryAgentDetail,
  RegistryAgentPatch,
  RegistryAgentSummary,
  RegistryEndpoint,
  RegistryFacet,
  RegistryListing,
  RegistryReach,
  RegistryRef,
  RegistrySearchInput,
  RegistrySearchResult,
  RegistryViewer,
} from './types.js';

export type RegistryErrorCode =
  | 'REGISTRY_NOT_AUTHENTICATED'
  | 'REGISTRY_FORBIDDEN'
  | 'REGISTRY_NOT_FOUND'
  | 'REGISTRY_INVALID_INPUT'
  | 'REGISTRY_NOT_READY'
  | 'REGISTRY_NOT_INITIALIZED';

export class RegistryError extends Error {
  readonly code: RegistryErrorCode;
  readonly remediation: string;
  constructor(code: RegistryErrorCode, message: string, remediation = '') {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
    this.remediation = remediation;
  }
}

export interface RegistryApiOptions {
  query: (cypher: string, parameters: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  viewerId: () => string | null;
  now?: () => number;
  /** ADR-088 — the shared admission-checklist document lives in KV. */
  kv?: { get(collection: string, key: string): Promise<unknown | null>; set(collection: string, key: string, value: unknown): Promise<void> };
  /** ADR-088 — "the system analyzes the agent": a chat completion for the grading pass. */
  ai?: { chat(input: { system?: string; messages: Array<{ role: 'user' | 'assistant'; content: string }>; maxTokens?: number }): Promise<{ content: string; model?: string }> };
}

/** ADR-088 — one agent's admission checklist as the window shows it. */
export interface AdmissionView {
  key: string;
  entry: AdmissionEntry | null;
  status: AdmissionStatus;
  pageUrl: string;
  canWrite: boolean;
}
export interface AdmissionPatch {
  platform?: AdmissionPlatform;
  ownerEmail?: string;
  items?: Partial<Record<AdmissionLineId, boolean>>;
}

/**
 * The Agent Registry surface (ADR-086): the account's `:Agent` catalog
 * from NEON — search with facets, one agent's full record, and the
 * admin management of what is available on the platform and what each
 * agent belongs to (IDWs, knowledge models, skills), plus the
 * submission checklist. Every write needs a registry admin (a Person
 * whose role is admin/owner) or the agent's own creator and stamps
 * `_Manifest` provenance.
 */
export interface RegistryManagerApi {
  /** Who the viewer is to the registry: signed-in id, admin flag, whether any admin exists yet, and the admin list. */
  whoAmI(): Promise<RegistryViewer>;
  /** Become the first admin — only while the graph holds NO admin at all. */
  claimFirstAdmin(): Promise<RegistryViewer>;
  /** Grant or revoke another person's admin role (admin only; never yourself). */
  setAdmin(personId: string, isAdmin: boolean): Promise<RegistryViewer>;
  /** Search the catalog: text over name/description/keywords/category/id, facets, paging (limit ≤ 200), newest first. */
  search(input?: RegistrySearchInput): Promise<RegistrySearchResult>;
  /** One agent's full registry record, or null. */
  get(id: string): Promise<RegistryAgentDetail | null>;
  /** Patch record fields (name, description, type, category, status, version, keywords) — vocabularies enforced. */
  update(id: string, patch: RegistryAgentPatch): Promise<RegistryAgentDetail>;
  /** Availability on the platform: mirrors `enabled` and `active`. */
  setEnabled(id: string, enabled: boolean): Promise<RegistryAgentDetail>;
  /** The graph's IDWs. */
  listIdws(): Promise<RegistryRef[]>;
  /** The graph's knowledge models. */
  listKnowledgeModels(): Promise<RegistryRef[]>;
  /** The graph's capabilities (skills). */
  listCapabilities(): Promise<RegistryRef[]>;
  /** Link or unlink the agent to an IDW (APPLIES_TO_IDW), knowledge model (USES_KNOWLEDGE) or capability (HAS_CAPABILITY). */
  link(id: string, kind: 'idw' | 'knowledge' | 'capability', targetId: string, on: boolean): Promise<RegistryAgentDetail>;
  /** Mint a knowledge model record (admin only; MERGE on a generated id). */
  createKnowledgeModel(input: { name: string; description?: string; type?: string; status?: string }): Promise<RegistryRef>;
  /** Mint a capability (skill) record (admin only). */
  createCapability(input: { name: string; description?: string }): Promise<RegistryRef>;
  /** Add an MCP / RESTful API / Skill reachability endpoint. */
  addEndpoint(id: string, input: { kind: RegistryReach; url: string; channels?: string[] }): Promise<RegistryAgentDetail>;
  /** Remove a reachability endpoint. */
  removeEndpoint(id: string, endpointId: string): Promise<RegistryAgentDetail>;
  /** The submission checklist for an agent: auto checks from the registry contract plus the admin's manual reviews. */
  checklist(id: string): Promise<{ agent: RegistryAgentDetail; checks: ListingCheck[]; ready: boolean; progress: { passed: number; total: number } }>;
  /** Tick or clear a manual review (stored as `lite_listing_checks`). */
  setManualCheck(id: string, checkId: string, value: boolean): Promise<RegistryAgentDetail>;
  /** Move the listing state (unlisted | submitted | listed | rejected); submit/list refuse until every required check passes; listing is admin-only. */
  setListing(id: string, listing: RegistryListing): Promise<RegistryAgentDetail>;
  /** Idempotent registry annotations (lite_* keys) for other writers. */
  ensureAnnotations(): Promise<void>;
  /** ADR-088 — the agent's admission checklist (shared KV document, same words and grading as the hosted page). */
  admissionGet(id: string): Promise<AdmissionView>;
  /** Tick lines, set the platform or owner e-mail (admin or the agent's creator); merged into the shared document. */
  admissionSave(id: string, patch: AdmissionPatch): Promise<AdmissionView>;
  /** "The system analyzes the agent": graph-provable lines are ticked with evidence; the AI grades the rest and explains. */
  admissionAnalyze(id: string): Promise<{ view: AdmissionView; analysis: AdmissionAnalysis }>;
}

const LISTINGS: ReadonlyArray<RegistryListing> = ['unlisted', 'submitted', 'listed', 'rejected'];
const STATUSES = ['active', 'inactive', 'deprecated'] as const;
const REACH: ReadonlyArray<RegistryReach> = ['mcp', 'api', 'skill'];
const KIND_LABEL: Record<RegistryReach, string> = { mcp: 'Mcp', api: 'Api', skill: 'Skill' };
const MAX_LIMIT = 200;

const str = (r: Record<string, unknown>, k: string): string => (typeof r[k] === 'string' ? (r[k] as string) : '');
const num = (r: Record<string, unknown>, k: string): number => (typeof r[k] === 'number' && Number.isFinite(r[k] as number) ? (r[k] as number) : 0);
const bool = (r: Record<string, unknown>, k: string): boolean => r[k] === true;
const jsonArray = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v !== 'string' || v.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  }
};
const listingOf = (v: unknown): RegistryListing => (LISTINGS.includes(v as RegistryListing) ? (v as RegistryListing) : 'unlisted');
const reachOf = (v: unknown): RegistryReach[] =>
  Array.isArray(v) ? v.filter((x): x is RegistryReach => REACH.includes(x as RegistryReach)) : [];
const refs = (v: unknown): RegistryRef[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
        .map((x) => {
          const ref: RegistryRef = { id: str(x, 'id'), name: str(x, 'name'), description: str(x, 'description'), status: str(x, 'status') };
          const url = str(x, 'url');
          if (url.length > 0) ref.url = url;
          return ref;
        })
        .filter((x) => x.id.length > 0)
    : [];

export function rowToSummary(r: Record<string, unknown>): RegistryAgentSummary | null {
  const id = str(r, 'id');
  if (id.length === 0) return null;
  return {
    id,
    name: str(r, 'name') || id,
    description: str(r, 'description'),
    type: str(r, 'type'),
    category: str(r, 'category'),
    enabled: r['enabled'] !== false,
    deleted: bool(r, 'deleted'),
    source: str(r, 'source'),
    owner: str(r, 'owner'),
    updatedMs: num(r, 'updatedMs'),
    listing: listingOf(r['listing']),
    builtin: bool(r, 'builtin'),
    isSystem: bool(r, 'isSystem'),
    reach: [...new Set(reachOf(r['reach']))],
    idwCount: num(r, 'idwCount'),
    knowledgeCount: num(r, 'knowledgeCount'),
  };
}

export function rowToDetail(r: Record<string, unknown>): RegistryAgentDetail | null {
  const base = rowToSummary(r);
  if (base === null) return null;
  let manualChecks: Record<string, boolean> = {};
  try {
    const parsed: unknown = JSON.parse(str(r, 'manualChecks') || '{}');
    if (typeof parsed === 'object' && parsed !== null) {
      manualChecks = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, v === true]));
    }
  } catch {
    manualChecks = {};
  }
  const endpoints: RegistryEndpoint[] = Array.isArray(r['endpoints'])
    ? (r['endpoints'] as unknown[])
        .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
        .map((x) => ({ id: str(x, 'id'), kind: str(x, 'kind') as RegistryReach, url: str(x, 'url'), channels: jsonArray(x['channels']) }))
        .filter((x) => REACH.includes(x.kind))
    : [];
  return {
    ...base,
    status: str(r, 'status'),
    version: str(r, 'version'),
    keywords: jsonArray(r['keywords']),
    capabilities: jsonArray(r['capabilities']),
    executionType: str(r, 'executionType'),
    gsxEndpoint: str(r, 'gsxEndpoint'),
    createdMs: num(r, 'createdMs'),
    endpoints,
    idws: refs(r['idws']),
    knowledgeModels: refs(r['knowledgeModels']),
    capabilityNodes: refs(r['capabilityNodes']),
    usedInSpaces: Array.isArray(r['usedInSpaces'])
      ? (r['usedInSpaces'] as unknown[])
          .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
          .map((x) => ({ id: str(x, 'id'), name: str(x, 'name') }))
          .filter((x) => x.id.length > 0)
      : [],
    representedBy: Array.isArray(r['representedBy'])
      ? (r['representedBy'] as unknown[])
          .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
          .map((x) => ({ assetId: str(x, 'assetId'), spaceName: str(x, 'spaceName') }))
      : [],
    contributedPlaybooks: num(r, 'contributedPlaybooks'),
    enabledBy: num(r, 'enabledBy'),
    library: str(r, 'library'),
    manualChecks,
    listedAt: typeof r['listedAt'] === 'number' ? (r['listedAt'] as number) : null,
  };
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item';
const rand = (): string => randomBytes(4).toString('hex');

export class RegistryApi implements RegistryManagerApi {
  private readonly opts: RegistryApiOptions;
  constructor(opts: RegistryApiOptions) {
    this.opts = opts;
  }

  private viewer(): string {
    const v = this.opts.viewerId();
    return typeof v === 'string' ? v.trim().toLowerCase() : '';
  }
  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }
  private run(cypher: string, params: Record<string, unknown> = {}): Promise<Array<Record<string, unknown>>> {
    return this.opts.query(cypher, { viewerId: this.viewer(), nowMs: this.now(), ...params });
  }
  private requireViewer(): string {
    const v = this.viewer();
    if (v.length === 0) {
      throw new RegistryError('REGISTRY_NOT_AUTHENTICATED', 'Sign in to use the Agent Registry.', 'Sign in with your OneReach account first.');
    }
    return v;
  }
  private async write(cypher: string, params: Record<string, unknown>, what: string): Promise<Record<string, unknown>> {
    this.requireViewer();
    const rows = await this.run(cypher, params);
    const row = rows[0];
    if (row === undefined) {
      throw new RegistryError(
        'REGISTRY_FORBIDDEN',
        `Could not ${what}: it needs a registry admin (or the agent's creator), and the target must exist.`,
        'Ask a registry admin, or claim the first admin role if none exists yet.'
      );
    }
    return row;
  }

  async whoAmI(): Promise<RegistryViewer> {
    const viewerId = this.viewer();
    const rows = await this.run(REGISTRY_CYPHER.WHO_AM_I);
    const row = rows[0] ?? {};
    const admins = jsonArray(row['admins']).filter((a) => a.length > 0);
    return {
      viewerId: viewerId.length > 0 ? viewerId : null,
      isAdmin: row['isAdmin'] === true,
      noAdminYet: admins.length === 0,
      admins,
    };
  }

  async claimFirstAdmin(): Promise<RegistryViewer> {
    await this.write(REGISTRY_CYPHER.CLAIM_FIRST_ADMIN, {}, 'claim the first admin role (someone already holds it, or you are not in the graph yet)');
    return this.whoAmI();
  }

  async setAdmin(personId: string, isAdmin: boolean): Promise<RegistryViewer> {
    const id = personId.trim().toLowerCase();
    if (id.length === 0) throw new RegistryError('REGISTRY_INVALID_INPUT', 'A person id is required.');
    await this.write(REGISTRY_CYPHER.SET_ADMIN, { personId: id, isAdmin: isAdmin === true }, `${isAdmin ? 'grant' : 'revoke'} admin`);
    return this.whoAmI();
  }

  async search(input: RegistrySearchInput = {}): Promise<RegistrySearchResult> {
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(input.limit ?? 50)));
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const params = {
      q: (input.q ?? '').trim().toLowerCase(),
      source: input.source ?? '',
      type: input.type ?? '',
      category: input.category ?? '',
      state: input.state ?? '',
      listing: input.listing ?? '',
      reach: input.reach ?? '',
      idwId: input.idwId ?? '',
      knowledgeId: input.knowledgeId ?? '',
      includeDeleted: input.includeDeleted === true,
      offset,
      limit,
    };
    const [rows, countRows, facetRows] = await Promise.all([
      this.run(REGISTRY_CYPHER.SEARCH, params),
      this.run(REGISTRY_CYPHER.SEARCH_COUNT, params),
      this.run(REGISTRY_CYPHER.FACETS, { q: params.q, includeDeleted: params.includeDeleted }),
    ]);
    const facets = { sources: [] as RegistryFacet[], types: [] as RegistryFacet[], categories: [] as RegistryFacet[] };
    for (const f of facetRows) {
      const entry = { value: str(f, 'value'), count: num(f, 'n') };
      const facet = str(f, 'facet');
      if (facet === 'source') facets.sources.push(entry);
      else if (facet === 'type') facets.types.push(entry);
      else if (facet === 'category') facets.categories.push(entry);
    }
    for (const list of [facets.sources, facets.types, facets.categories]) list.sort((a, b) => b.count - a.count);
    return {
      items: rows.map(rowToSummary).filter((x): x is RegistryAgentSummary => x !== null),
      total: num(countRows[0] ?? {}, 'total'),
      offset,
      limit,
      facets,
    };
  }

  async get(id: string): Promise<RegistryAgentDetail | null> {
    const rows = await this.run(REGISTRY_CYPHER.GET, { id: id.trim() });
    const row = rows[0];
    return row === undefined ? null : rowToDetail(row);
  }

  async update(id: string, patch: RegistryAgentPatch): Promise<RegistryAgentDetail> {
    const clean: Record<string, unknown> = {};
    if (typeof patch.name === 'string' && patch.name.trim().length > 0) clean['name'] = patch.name.trim().slice(0, 200);
    if (typeof patch.description === 'string') clean['description'] = patch.description.trim().slice(0, 4000);
    if (typeof patch.type === 'string' && patch.type.trim().length > 0) {
      clean['agentType'] = patch.type.trim().slice(0, 60);
      clean['type'] = clean['agentType'];
    }
    if (typeof patch.category === 'string') clean['category'] = patch.category.trim().slice(0, 60);
    if (typeof patch.status === 'string') {
      if (!(STATUSES as ReadonlyArray<string>).includes(patch.status)) {
        throw new RegistryError('REGISTRY_INVALID_INPUT', 'status must be active, inactive or deprecated.');
      }
      clean['status'] = patch.status;
    }
    if (typeof patch.version === 'string') clean['version'] = patch.version.trim().slice(0, 40);
    if (Array.isArray(patch.keywords)) {
      clean['keywords'] = JSON.stringify(patch.keywords.map((k) => String(k).trim()).filter((k) => k.length > 0).slice(0, 60));
    }
    if (Object.keys(clean).length === 0) throw new RegistryError('REGISTRY_INVALID_INPUT', 'Nothing to update.');
    await this.write(REGISTRY_CYPHER.UPDATE_AGENT, { id: id.trim(), patch: clean }, 'update the agent');
    return this.mustGet(id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<RegistryAgentDetail> {
    await this.write(REGISTRY_CYPHER.SET_ENABLED, { id: id.trim(), enabled: enabled === true }, enabled ? 'enable the agent' : 'disable the agent');
    return this.mustGet(id);
  }

  listIdws(): Promise<RegistryRef[]> {
    return this.run(REGISTRY_CYPHER.LIST_IDWS).then(refs);
  }
  listKnowledgeModels(): Promise<RegistryRef[]> {
    return this.run(REGISTRY_CYPHER.LIST_KNOWLEDGE_MODELS).then(refs);
  }
  listCapabilities(): Promise<RegistryRef[]> {
    return this.run(REGISTRY_CYPHER.LIST_CAPABILITIES).then(refs);
  }

  async link(id: string, kind: 'idw' | 'knowledge' | 'capability', targetId: string, on: boolean): Promise<RegistryAgentDetail> {
    const q =
      kind === 'idw'
        ? on ? REGISTRY_CYPHER.LINK_IDW : REGISTRY_CYPHER.UNLINK_IDW
        : kind === 'knowledge'
          ? on ? REGISTRY_CYPHER.LINK_KNOWLEDGE : REGISTRY_CYPHER.UNLINK_KNOWLEDGE
          : on ? REGISTRY_CYPHER.LINK_CAPABILITY : REGISTRY_CYPHER.UNLINK_CAPABILITY;
    if (targetId.trim().length === 0) throw new RegistryError('REGISTRY_INVALID_INPUT', 'A target id is required.');
    await this.write(q, { id: id.trim(), targetId: targetId.trim() }, `${on ? 'link' : 'unlink'} the ${kind}`);
    return this.mustGet(id);
  }

  async createKnowledgeModel(input: { name: string; description?: string; type?: string; status?: string }): Promise<RegistryRef> {
    const name = input.name.trim();
    if (name.length < 2) throw new RegistryError('REGISTRY_INVALID_INPUT', 'A knowledge model needs a name.');
    const targetId = `km-${slug(name)}-${rand()}`;
    await this.write(
      REGISTRY_CYPHER.CREATE_KNOWLEDGE_MODEL,
      { targetId, name, description: (input.description ?? '').trim(), type: input.type ?? null, status: input.status ?? null },
      'create the knowledge model (admin only)'
    );
    return { id: targetId, name, description: (input.description ?? '').trim(), status: input.status ?? 'available' };
  }

  async createCapability(input: { name: string; description?: string }): Promise<RegistryRef> {
    const name = input.name.trim();
    if (name.length < 2) throw new RegistryError('REGISTRY_INVALID_INPUT', 'A capability (skill) needs a name.');
    const targetId = `cap-${slug(name)}-${rand()}`;
    await this.write(REGISTRY_CYPHER.CREATE_CAPABILITY, { targetId, name, description: (input.description ?? '').trim() }, 'create the capability (admin only)');
    return { id: targetId, name, description: (input.description ?? '').trim(), status: 'active' };
  }

  async addEndpoint(id: string, input: { kind: RegistryReach; url: string; channels?: string[] }): Promise<RegistryAgentDetail> {
    if (!REACH.includes(input.kind)) throw new RegistryError('REGISTRY_INVALID_INPUT', 'Endpoint kind must be mcp, api or skill.');
    const url = input.url.trim();
    if (url.length === 0 || url.length > 2048) throw new RegistryError('REGISTRY_INVALID_INPUT', 'An endpoint URL is required.');
    const cypher = REGISTRY_CYPHER.ADD_ENDPOINT.replace('__KIND_LABEL__', KIND_LABEL[input.kind]);
    await this.write(
      cypher,
      { id: id.trim(), endpointId: `ep-${rand()}`, kind: input.kind, url, channels: JSON.stringify((input.channels ?? []).map((c) => c.trim()).filter((c) => c.length > 0)) },
      'add the endpoint'
    );
    return this.mustGet(id);
  }

  async removeEndpoint(id: string, endpointId: string): Promise<RegistryAgentDetail> {
    await this.write(REGISTRY_CYPHER.REMOVE_ENDPOINT, { id: id.trim(), endpointId: endpointId.trim() }, 'remove the endpoint');
    return this.mustGet(id);
  }

  async checklist(id: string): Promise<{ agent: RegistryAgentDetail; checks: ListingCheck[]; ready: boolean; progress: { passed: number; total: number } }> {
    const agent = await this.mustGet(id);
    const checks = evaluateListingChecklist(agent);
    return { agent, checks, ready: listingReady(checks), progress: checklistProgress(checks) };
  }

  async setManualCheck(id: string, checkId: string, value: boolean): Promise<RegistryAgentDetail> {
    const key = checkId.trim();
    if (!/^[a-z][a-z0-9_-]{0,30}$/.test(key)) throw new RegistryError('REGISTRY_INVALID_INPUT', 'Unknown check.');
    const current = await this.mustGet(id);
    const next = { ...current.manualChecks, [key]: value === true };
    await this.write(REGISTRY_CYPHER.SET_MANUAL_CHECKS, { id: id.trim(), checks: JSON.stringify(next) }, 'record the review');
    return this.mustGet(id);
  }

  async setListing(id: string, listing: RegistryListing): Promise<RegistryAgentDetail> {
    if (!LISTINGS.includes(listing)) throw new RegistryError('REGISTRY_INVALID_INPUT', 'listing must be unlisted, submitted, listed or rejected.');
    if (listing === 'listed' || listing === 'submitted') {
      // ADR-088: the admission checklist decides. A Critical grade is not
      // admitted to act; listing on the platform needs the sign-offs.
      const { status } = await this.admissionGet(id);
      if (status.grade === null || status.grade === 'c' || (listing === 'listed' && !status.signed)) {
        throw new RegistryError(
          'REGISTRY_NOT_READY',
          status.grade === null
            ? 'The admission checklist has not been started for this agent.'
            : status.grade === 'c'
              ? `Not admitted to act: ${status.why}`
              : `Listing needs the owner and tier-approver sign-offs (F1, F2). ${status.why}`,
          'Open the admission checklist, tick the lines the agent meets (or run Analyze), and complete F1 and F2.'
        );
      }
    }
    await this.write(REGISTRY_CYPHER.SET_LISTING, { id: id.trim(), listing }, listing === 'listed' ? 'list the agent (admin only)' : `mark the agent ${listing}`);
    return this.mustGet(id);
  }

  async ensureAnnotations(): Promise<void> {
    try {
      await this.run(REGISTRY_CYPHER.ENSURE_ANNOTATIONS);
    } catch {
      /* registry docs are best-effort; never block a boot */
    }
  }

  // ── ADR-088: admission checklist ───────────────────────────────────
  private async readAdmissionDoc(): Promise<AdmissionDoc | null> {
    if (this.opts.kv === undefined) return null;
    let raw = await this.opts.kv.get(ADMISSION_KV.collection, ADMISSION_KV.key);
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    }
    if (typeof raw !== 'object' || raw === null) return null;
    const agents = (raw as { agents?: unknown }).agents;
    if (typeof agents !== 'object' || agents === null) return { v: 1, agents: {} };
    return { v: 1, agents: agents as Record<string, AdmissionEntry> };
  }

  private async canWriteAgent(detail: RegistryAgentDetail): Promise<boolean> {
    const viewer = this.viewer();
    if (viewer.length === 0) return false;
    if (detail.owner.trim().toLowerCase() === viewer) return true;
    const who = await this.whoAmI();
    return who.isAdmin;
  }

  async admissionGet(id: string): Promise<AdmissionView> {
    const detail = await this.mustGet(id);
    const doc = await this.readAdmissionDoc();
    const { key, entry } = findAdmissionEntry(doc, detail.id, detail.name);
    return { key, entry, status: computeAdmission(entry), pageUrl: ADMISSION_PAGE_URL, canWrite: await this.canWriteAgent(detail) };
  }

  async admissionSave(id: string, patch: AdmissionPatch): Promise<AdmissionView> {
    this.requireViewer();
    const detail = await this.mustGet(id);
    if (!(await this.canWriteAgent(detail))) {
      throw new RegistryError('REGISTRY_FORBIDDEN', "Only a registry admin or the agent's creator can edit its admission checklist.");
    }
    if (this.opts.kv === undefined) throw new RegistryError('REGISTRY_INVALID_INPUT', 'The shared checklist store is not configured.', 'Sign in so KV is reachable, then try again.');
    const fresh = (await this.readAdmissionDoc()) ?? { v: 1, agents: {} };
    const { key, entry } = findAdmissionEntry(fresh, detail.id, detail.name);
    const items: Partial<Record<AdmissionLineId, boolean>> = { ...(entry?.items ?? {}) };
    for (const [k, v] of Object.entries(patch.items ?? {})) {
      if ((ADMISSION_LINE_IDS as ReadonlyArray<string>).includes(k)) items[k as AdmissionLineId] = v === true;
    }
    const platform: AdmissionPlatform = patch.platform !== undefined && patch.platform in ADMISSION_PLATFORMS ? patch.platform : entry?.platform ?? 'gsx';
    const ownerEmail = typeof patch.ownerEmail === 'string' ? patch.ownerEmail.trim().slice(0, 200) : entry?.ownerEmail ?? detail.owner;
    const next: AdmissionEntry = {
      name: entry?.name ?? detail.name,
      items,
      platform,
      ownerEmail,
      updatedAt: new Date(this.now()).toISOString(),
      by: this.viewer(),
      agentId: detail.id,
      ...(entry?.lite !== undefined ? { lite: entry.lite } : {}),
    };
    fresh.agents[key.length > 0 ? key : detail.id] = next;
    await this.opts.kv.set(ADMISSION_KV.collection, ADMISSION_KV.key, fresh);
    return this.admissionGet(id);
  }

  async admissionAnalyze(id: string): Promise<{ view: AdmissionView; analysis: AdmissionAnalysis }> {
    this.requireViewer();
    const detail = await this.mustGet(id);
    if (!(await this.canWriteAgent(detail))) {
      throw new RegistryError('REGISTRY_FORBIDDEN', "Only a registry admin or the agent's creator can analyze the agent.");
    }
    const auto = autoChecks({
      name: detail.name,
      description: detail.description,
      owner: detail.owner,
      keywords: detail.keywords,
      capabilities: detail.capabilities,
      version: detail.version,
      endpoints: detail.endpoints.map((e) => ({ kind: e.kind, url: e.url })),
      gsxEndpoint: detail.gsxEndpoint,
      executionType: detail.executionType,
    });
    const before = await this.admissionGet(id);
    let ai: AdmissionAnalysis['ai'] = null;
    let aiError: string | undefined;
    if (this.opts.ai !== undefined) {
      try {
        const result = await this.opts.ai.chat({
          system:
            'You are the admission reviewer for an enterprise AI agent registry. You are given an agent record and an admission checklist. ' +
            'For every line, decide whether the record shows the line is met ("met"), shows it is not met ("unmet"), or gives no evidence ("unknown"). ' +
            'Be conservative: "met" only with direct evidence in the record. Reply with JSON only, no prose: ' +
            '{"summary": string, "lines": [{"id": "a1", "verdict": "met" | "unmet" | "unknown", "note": string}]}',
          messages: [
            {
              role: 'user',
              content:
                `AGENT RECORD\n${JSON.stringify({ id: detail.id, name: detail.name, description: detail.description, type: detail.type, category: detail.category, source: detail.source, owner: detail.owner, status: detail.status, version: detail.version, executionType: detail.executionType, gsxEndpoint: detail.gsxEndpoint, endpoints: detail.endpoints, keywords: detail.keywords, capabilities: detail.capabilities, idws: detail.idws.map((i) => i.name), knowledgeModels: detail.knowledgeModels.map((k) => k.name), usedInSpaces: detail.usedInSpaces.length, library: detail.library, enabled: detail.enabled }, null, 1)}\n\n` +
                `PLATFORM: ${before.status.platformName}\nLINES ALREADY TICKED: ${before.status.lines.filter((l) => l.met).map((l) => l.id.toUpperCase()).join(', ') || 'none'}\n\n` +
                'CHECKLIST\n' +
                ADMISSION_LINES.filter((l) => l.section !== 'f').map((l) => `${l.id.toUpperCase()} ${l.title}\n  owner completes: ${l.owner}\n  we test: ${l.test}`).join('\n'),
            },
          ],
          maxTokens: 2500,
        });
        const match = /\{[\s\S]*\}/.exec(result.content);
        const parsed = match !== null ? (JSON.parse(match[0]) as { summary?: unknown; lines?: unknown }) : null;
        const lines: AdmissionAiLine[] = Array.isArray(parsed?.lines)
          ? (parsed.lines as unknown[])
              .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
              .map((x) => ({ id: String(x['id'] ?? '').toLowerCase() as AdmissionLineId, verdict: (['met', 'unmet', 'unknown'] as const).includes(x['verdict'] as 'met') ? (x['verdict'] as AdmissionAiLine['verdict']) : 'unknown', note: String(x['note'] ?? '').slice(0, 400) }))
              .filter((x) => (ADMISSION_LINE_IDS as ReadonlyArray<string>).includes(x.id))
          : [];
        ai = { summary: String(parsed?.summary ?? '').slice(0, 1200), lines };
      } catch (err) {
        aiError = err instanceof Error ? err.message : String(err);
      }
    } else {
      aiError = 'AI grading is not configured (add a Claude key in Settings → AI).';
    }
    const analysis: AdmissionAnalysis = { at: new Date(this.now()).toISOString(), by: this.viewer(), auto, ai, ...(aiError !== undefined ? { aiError } : {}) };
    // Persist: tick only what the graph PROVES; record the analysis on the entry.
    const items: Partial<Record<AdmissionLineId, boolean>> = {};
    for (const c of auto) if (c.passed) items[c.line] = true;
    if (this.opts.kv !== undefined) {
      const fresh = (await this.readAdmissionDoc()) ?? { v: 1, agents: {} };
      const { key, entry } = findAdmissionEntry(fresh, detail.id, detail.name);
      const merged: AdmissionEntry = {
        name: entry?.name ?? detail.name,
        items: { ...(entry?.items ?? {}), ...items },
        platform: entry?.platform ?? 'gsx',
        ownerEmail: entry?.ownerEmail ?? detail.owner,
        updatedAt: analysis.at,
        by: this.viewer(),
        agentId: detail.id,
        lite: { ...(entry?.lite ?? {}), analysis },
      };
      fresh.agents[key.length > 0 ? key : detail.id] = merged;
      await this.opts.kv.set(ADMISSION_KV.collection, ADMISSION_KV.key, fresh);
    }
    return { view: await this.admissionGet(id), analysis };
  }

  private async mustGet(id: string): Promise<RegistryAgentDetail> {
    const agent = await this.get(id);
    if (agent === null) throw new RegistryError('REGISTRY_NOT_FOUND', `Agent ${id} was not found.`);
    return agent;
  }
}

// ── Singleton accessors (Rule 12 module contract) ─────────────────────
const METHODS: ReadonlyArray<keyof RegistryManagerApi> = [
  'whoAmI', 'claimFirstAdmin', 'setAdmin', 'search', 'get', 'update', 'setEnabled', 'listIdws', 'listKnowledgeModels',
  'listCapabilities', 'link', 'createKnowledgeModel', 'createCapability', 'addEndpoint', 'removeEndpoint', 'checklist',
  'setManualCheck', 'setListing', 'ensureAnnotations', 'admissionGet', 'admissionSave', 'admissionAnalyze',
];

/** Every method refuses until `configureRegistryApi()` has run (boot order bug, not a user error). */
function notInitializedApi(): RegistryManagerApi {
  const refuse = (name: string) => (): Promise<never> =>
    Promise.reject(new RegistryError('REGISTRY_NOT_INITIALIZED', `Registry API not initialized (${name}).`, 'initRegistry() must run before the registry is used.'));
  const stub: Record<string, unknown> = {};
  for (const m of METHODS) stub[m] = refuse(m);
  return stub as unknown as RegistryManagerApi;
}

let registryInstance: RegistryManagerApi | null = null;
let registryFactory: (() => RegistryManagerApi) | null = null;

/** Install the factory (called once by initRegistry); the instance is built lazily. */
export function configureRegistryApi(factory: () => RegistryManagerApi): void {
  registryFactory = factory;
  registryInstance = null;
}

export function getRegistryApi(): RegistryManagerApi {
  if (registryInstance === null) registryInstance = registryFactory !== null ? registryFactory() : notInitializedApi();
  return registryInstance;
}

export function _resetRegistryApiForTesting(): void {
  registryInstance = null;
}

export function _setRegistryApiForTesting(api: RegistryManagerApi): void {
  registryInstance = api;
}

export const REGISTRY_API_METHODS = METHODS;
