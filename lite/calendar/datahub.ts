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

export interface DatahubDeps {
  fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
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
export const FLOW_LIST_PROJECTION = ['id', 'botId', 'version', 'dateModified', 'data.label', 'data.trees', 'data.trees.main.steps'] as const;

export interface BotRecord {
  id: string;
  label: string;
}

const TOKEN_TTL_MS = 30 * 60 * 1000;

export class DatahubClient {
  private token: { value: string; mintedAt: number } | null = null;
  private minting: Promise<string> | null = null;
  private serviceUrl: string | null = null;
  private discovering: Promise<string> | null = null;
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

  private async getJson(url: string, auth: string | null): Promise<unknown> {
    let res: { ok: boolean; status: number; text(): Promise<string> };
    try {
      res = await this.deps.fetch(url, { method: 'GET', headers: { 'Content-Type': 'application/json;charset=UTF-8', ...(auth !== null ? { Authorization: auth } : {}) }, signal: AbortSignal.timeout(this.deps.timeoutMs ?? 8000) });
    } catch (err) {
      throw new CalendarError('CALENDAR_HTTP_FAILED', `Could not reach ${new URL(url).host}: ${err instanceof Error ? err.message : String(err)}`, 'Check the network, then refresh.');
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

  async getFlow(flowId: string): Promise<Record<string, unknown> | null> {
    const body = await this.authed(`/flows/${encodeURIComponent(flowId)}`);
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
  }
}
