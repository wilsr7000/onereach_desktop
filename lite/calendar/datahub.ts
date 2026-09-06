/**
 * The GSX datahub as the Calendar reads it (ADR-090) — plain fetch, no
 * SDK dependency. Mirrors what `@or-sdk/flows` / `@or-sdk/bots` do:
 *
 *   token      GET https://em.<env>.api.onereach.ai/http/<accountId>/refresh_token → { token: "FLOW …" }
 *   discovery  GET https://discovery.<env>.api.onereach.ai/api/v2?serviceName=data-hub-pg → { url }
 *   bots       GET <url>/bots?query={"isDeleted":false}
 *   flows      GET <url>/flows?query={"botId":…,"isDeleted":false}
 *   flow       GET <url>/flows/<id>
 *
 * every call with `Authorization: <token>`. The token is the account's
 * own refresh flow, the same source the full app and the podscan tools
 * use; it is cached and re-minted once on a 401/403.
 */
import { CalendarError } from './errors.js';
import type { ActiveDeployment } from './types.js';
import type { FlowHead } from './index.js';

export interface DatahubDeps {
  fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  now?: () => number;
  /** Per-request timeout (default 8 s): one slow space must not stall the account. */
  timeoutMs?: number;
}

/**
 * What a flow listing must carry for the Calendar: the label, the tree
 * names, and the main tree's steps. Full bodies carry every step
 * template's code (a space with 347 flows answers 500 for them); this
 * projection is ~40× smaller and lists that space fine.
 */
export const FLOW_LIST_PROJECTION = ['id', 'botId', 'version', 'dateModified', 'data.label', 'data.description', 'data.trees', 'data.trees.main.steps'] as const;
/** A warm scan lists only heads: the schedule index answers for versions it has seen. */
export const FLOW_HEAD_PROJECTION = ['id', 'botId', 'version', 'dateModified', 'data.label', 'data.description'] as const;

/** The head of a flow row (what the index is keyed on). */
export function flowHeadOf(raw: Record<string, unknown>, botId: string): FlowHead {
  const data = typeof raw['data'] === 'object' && raw['data'] !== null ? (raw['data'] as Record<string, unknown>) : {};
  const mod = raw['dateModified'];
  const modifiedMs = typeof mod === 'number' ? mod : Number.parseInt(String(mod ?? ''), 10) || 0;
  const id = String(raw['id'] ?? '');
  return { id, botId: String(raw['botId'] ?? botId), version: typeof raw['version'] === 'string' ? raw['version'] : '', modifiedMs, label: String(data['label'] ?? id), description: typeof data['description'] === 'string' ? data['description'] : '' };
}

export interface BotRecord {
  id: string;
  label: string;
}

const TOKEN_TTL_MS = 30 * 60 * 1000;

function requestIdOf(body: unknown): string {
  const id = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['requestId'] : undefined;
  if (typeof id !== 'string' || id.length === 0) throw new CalendarError('CALENDAR_DEPLOY_FAILED', 'The deployer answered without a request id.', 'Try again; if it persists, check the flow in Designer.');
  return id;
}

export class DatahubClient {
  private token: { value: string; mintedAt: number } | null = null;
  private minting: Promise<string> | null = null;
  private serviceUrl: string | null = null;
  private discovering: Promise<string> | null = null;
  private readonly serviceUrls = new Map<string, string>();
  private readonly now: () => number;

  constructor(
    private readonly env: string,
    private readonly accountId: string,
    private readonly deps: DatahubDeps
  ) {
    this.now = deps.now ?? (() => Date.now());
  }

  get account(): string {
    return this.accountId;
  }

  private getJson(url: string, auth: string | null): Promise<unknown> {
    return this.send('GET', url, auth);
  }

  private async send(method: 'GET' | 'POST' | 'DELETE', url: string, auth: string | null, body?: unknown, timeoutMs?: number): Promise<unknown> {
    let res: { ok: boolean; status: number; text(): Promise<string> };
    try {
      res = await this.deps.fetch(url, { method, headers: { 'Content-Type': 'application/json;charset=UTF-8', ...(auth !== null ? { Authorization: auth } : {}) }, signal: AbortSignal.timeout(timeoutMs ?? this.deps.timeoutMs ?? 8000), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch (err) {
      const timedOut = err instanceof Error && /abort|timeout/i.test(err.message);
      throw new CalendarError('CALENDAR_HTTP_FAILED', timedOut ? `${new URL(url).host} did not answer within ${Math.round((timeoutMs ?? this.deps.timeoutMs ?? 8000) / 1000)} s.` : `Could not reach ${new URL(url).host}: ${err instanceof Error ? err.message : String(err)}`, timedOut ? 'The platform is slow right now; try again in a moment.' : 'Check the network, then refresh.');
    }
    const text = await res.text();
    if (!res.ok) {
      const e = new CalendarError('CALENDAR_HTTP_FAILED', `${new URL(url).host} answered ${res.status}${text.length > 0 ? `: ${text.slice(0, 160)}` : ''}`, res.status === 401 || res.status === 403 ? 'Sign in to GSX again, then refresh.' : 'Try again in a moment.');
      e.status = res.status;
      throw e;
    }
    try {
      return text.length > 0 ? (JSON.parse(text) as unknown) : null;
    } catch {
      throw new CalendarError('CALENDAR_HTTP_FAILED', `${new URL(url).host} answered with something that is not JSON.`, 'Try again in a moment.');
    }
  }

  /** The account token (cached). */
  async mintToken(force = false): Promise<string> {
    if (!force && this.token !== null && this.now() - this.token.mintedAt < TOKEN_TTL_MS) return this.token.value;
    if (this.minting !== null) return this.minting;
    this.minting = this.mint().finally(() => {
      this.minting = null;
    });
    return this.minting;
  }

  private async mint(): Promise<string> {
    let body: unknown;
    try {
      body = await this.getJson(`https://em.${this.env}.api.onereach.ai/http/${encodeURIComponent(this.accountId)}/refresh_token`, null);
    } catch (err) {
      throw new CalendarError('CALENDAR_TOKEN_FAILED', `The account token could not be minted: ${err instanceof Error ? err.message : String(err)}`, 'Check that the account has its refresh_token flow active, then refresh.');
    }
    const token = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['token'] : undefined;
    if (typeof token !== 'string' || token.length === 0) throw new CalendarError('CALENDAR_TOKEN_FAILED', 'The account token endpoint answered without a token.', 'Check the refresh_token flow in GSX Designer.');
    this.token = { value: token.startsWith('FLOW ') ? token : `FLOW ${token}`, mintedAt: this.now() };
    return this.token.value;
  }

  async discover(): Promise<string> {
    if (this.serviceUrl !== null) return this.serviceUrl;
    if (this.discovering !== null) return this.discovering;
    this.discovering = this.discoverOnce().finally(() => {
      this.discovering = null;
    });
    return this.discovering;
  }

  private async discoverOnce(): Promise<string> {
    let body: unknown;
    try {
      body = await this.getJson(`https://discovery.${this.env}.api.onereach.ai/api/v2?serviceName=data-hub-pg`, null);
    } catch (err) {
      throw new CalendarError('CALENDAR_DISCOVERY_FAILED', `Service discovery failed: ${err instanceof Error ? err.message : String(err)}`, 'Check the network, then refresh.');
    }
    const url = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['url'] : undefined;
    if (typeof url !== 'string' || url.length === 0) throw new CalendarError('CALENDAR_DISCOVERY_FAILED', 'Service discovery answered without a URL for data-hub-pg.', 'Try again in a moment.');
    this.serviceUrl = url.replace(/\/$/, '');
    return this.serviceUrl;
  }

  private async authed(path: string): Promise<unknown> {
    const base = await this.discover();
    const url = `${base}${path}`;
    try {
      return await this.getJson(url, await this.mintToken());
    } catch (err) {
      if (err instanceof CalendarError && (err.status === 401 || err.status === 403)) {
        return this.getJson(url, await this.mintToken(true));
      }
      throw err;
    }
  }

  private static items(body: unknown): Array<Record<string, unknown>> {
    const list = Array.isArray(body) ? body : typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['items'] : [];
    return Array.isArray(list) ? list.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : [];
  }

  async listBots(): Promise<BotRecord[]> {
    const rows = DatahubClient.items(await this.authed(`/bots?query=${encodeURIComponent(JSON.stringify({ isDeleted: false }))}`));
    return rows
      .map((b) => ({ id: String(b['botId'] ?? b['id'] ?? ''), label: String((typeof b['data'] === 'object' && b['data'] !== null ? (b['data'] as Record<string, unknown>)['label'] : undefined) ?? b['name'] ?? '') }))
      .filter((b) => b.id.length > 0)
      .map((b) => ({ id: b.id, label: b.label.length > 0 ? b.label : b.id }));
  }

  /** A space's flows, projected to what the Calendar reads (see {@link FLOW_LIST_PROJECTION}). */
  async listFlows(botId: string): Promise<Array<Record<string, unknown>>> {
    return DatahubClient.items(await this.authed(`/flows?query=${encodeURIComponent(JSON.stringify({ botId, isDeleted: false }))}&projection=${encodeURIComponent(JSON.stringify(FLOW_LIST_PROJECTION))}`));
  }

  /**
   * Active deployments — what is actually running. A scheduled flow's
   * deployment carries a timer trigger (`timer/<flowId>/<stepId>/next`,
   * `hasSchedule: true`, `timeoutTime` = the next fire recorded at
   * activation): the Event Manager arms it from there.
   */
  async listActiveDeployments(): Promise<ActiveDeployment[]> {
    const rows = DatahubClient.items(await this.authed(`/deployments?query=${encodeURIComponent(JSON.stringify({ dateDeactivated: 0 }))}&limit=1000`));
    const out: ActiveDeployment[] = [];
    for (const d of rows) {
      const data = typeof d['data'] === 'object' && d['data'] !== null ? (d['data'] as Record<string, unknown>) : {};
      const triggers = Array.isArray(data['triggers']) ? (data['triggers'] as unknown[]) : [];
      const scheduleTriggers: ActiveDeployment['scheduleTriggers'] = [];
      for (const t of triggers) {
        if (typeof t !== 'object' || t === null) continue;
        const params = (t as Record<string, unknown>)['params'];
        if (typeof params !== 'object' || params === null) continue;
        const p = params as Record<string, unknown>;
        const name = String(p['name'] ?? '');
        if (p['hasSchedule'] === true || name.startsWith('timer/')) scheduleTriggers.push({ name, timeoutMs: typeof p['timeoutTime'] === 'number' ? p['timeoutTime'] : 0 });
      }
      const flowId = String(d['flowId'] ?? '');
      if (flowId.length === 0) continue;
      const created = d['dateCreated'];
      out.push({ id: String(d['id'] ?? ''), flowId, botId: String(d['botId'] ?? ''), activatedMs: typeof created === 'number' ? created : Number.parseInt(String(created ?? ''), 10) || 0, flowVersion: String(data['flowVersion'] ?? ''), scheduleTriggers });
    }
    return out;
  }

  /** Flow heads only (id, version, modified, label): a few KB per space. */
  async listFlowHeads(botId: string): Promise<FlowHead[]> {
    const rows = DatahubClient.items(await this.authed(`/flows?query=${encodeURIComponent(JSON.stringify({ botId, isDeleted: false }))}&projection=${encodeURIComponent(JSON.stringify(FLOW_HEAD_PROJECTION))}`));
    return rows.map((r) => flowHeadOf(r, botId)).filter((h) => h.id.length > 0);
  }

  /** Any platform service by discovery name (cached per name). */
  async discoverService(serviceName: string): Promise<string> {
    const cached = this.serviceUrls.get(serviceName);
    if (cached !== undefined) return cached;
    let body: unknown;
    try {
      body = await this.getJson(`https://discovery.${this.env}.api.onereach.ai/api/v2?serviceName=${encodeURIComponent(serviceName)}`, null);
    } catch (err) {
      throw new CalendarError('CALENDAR_DISCOVERY_FAILED', `Service discovery failed for ${serviceName}: ${err instanceof Error ? err.message : String(err)}`, 'Check the network, then try again.');
    }
    const url = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['url'] : undefined;
    if (typeof url !== 'string' || url.length === 0) throw new CalendarError('CALENDAR_DISCOVERY_FAILED', `Service discovery answered without a URL for ${serviceName}.`, 'Try again in a moment.');
    const clean = url.replace(/\/$/, '');
    this.serviceUrls.set(serviceName, clean);
    return clean;
  }

  /**
   * A flow's log events in [startMs, endMs] from the deployer, paged
   * with `next` tokens, capped at `maxEvents`. Returns raw events; the
   * summariser parses them.
   */
  async fetchFlowLogs(flowId: string, startMs: number, endMs: number, maxEvents = 2000): Promise<{ events: unknown[]; truncated: boolean }> {
    const base = await this.discoverService('deployer');
    const events: unknown[] = [];
    let next: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const url = `${base}/flows/${encodeURIComponent(flowId)}/logs?limit=500&skipOriginal=true&start=${Math.floor(startMs)}&end=${Math.floor(endMs)}${next !== null ? `&next=${encodeURIComponent(next)}` : ''}`;
      // Log scans over a day can take well over the listing budget: 30 s per page.
      const body = await this.serviceCall('deployer', 'GET', url.slice(base.length), undefined, 30_000);
      const o = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
      const page = Array.isArray(o['events']) ? (o['events'] as unknown[]) : [];
      events.push(...page);
      const token = o['nextToken'];
      if (typeof token !== 'string' || token.length === 0 || page.length === 0) return { events, truncated: false };
      if (events.length >= maxEvents) return { events: events.slice(0, maxEvents), truncated: true };
      next = token;
    }
    return { events, truncated: true };
  }

  /** Authenticated call to a discovered service, re-minting the token once on 401/403. */
  private async serviceCall(serviceName: string, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const base = await this.discoverService(serviceName);
    const url = `${base}${path}`;
    try {
      return await this.send(method, url, await this.mintToken(), body, timeoutMs);
    } catch (err) {
      if (err instanceof CalendarError && (err.status === 401 || err.status === 403)) return this.send(method, url, await this.mintToken(true), body, timeoutMs);
      throw err;
    }
  }

  /** The deployer's activate call as @or-sdk/deployer sends it: a fresh alias per deploy, the flow's IAM role. */
  async activateFlow(flowId: string, role: string): Promise<{ requestId: string }> {
    const body = await this.serviceCall('deployer', 'POST', '/flows/deploy', { flowId, flowAlias: `v-${this.deps.now?.() ?? Date.now()}`, interactiveDebug: false, role });
    return { requestId: requestIdOf(body) };
  }

  /** The deployer's deactivate call: the flow goes as `{ flow: { id } }`; a bare flowId is answered 400 "flow is required". */
  async deactivateFlow(flowId: string, role: string): Promise<{ requestId: string }> {
    const body = await this.serviceCall('deployer', 'DELETE', '/flows/deploy', { flow: { id: flowId }, role });
    return { requestId: requestIdOf(body) };
  }

  async checkDeploy(flowId: string, requestId: string): Promise<Record<string, unknown>> {
    const body = await this.serviceCall('deployer', 'GET', `/flows/check/${encodeURIComponent(flowId)}/${encodeURIComponent(requestId)}`);
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  }

  async getFlow(flowId: string): Promise<Record<string, unknown> | null> {
    const body = await this.authed(`/flows/${encodeURIComponent(flowId)}`);
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
  }
}
