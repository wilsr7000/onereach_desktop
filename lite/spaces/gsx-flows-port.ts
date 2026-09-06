/**
 * GSX Designer flows — read port (ADR-091).
 *
 * What GSX Designer calls a "space" is a **bot**; flows live under a
 * bot. This port lists both from the account's data hub, exactly the
 * way `@or-sdk/flows` / `@or-sdk/bots` (2.7.x) do — the wire format
 * below was captured from the SDK against an echo server, so the
 * kernel does not have to bundle the SDK (ADR-047: only declared deps;
 * the asar excludes `@or-sdk/**`). Same auth + discovery as the
 * Calendar (ADR-090):
 *
 *   token      GET https://em.<env>.api.onereach.ai/http/<accountId>/refresh_token → { token }
 *   discovery  GET https://discovery.<env>.api.onereach.ai/api/v2?serviceName=data-hub-pg → { url }
 *   bots       GET <url>/bots?query={"isDeleted":false}&from=0&size=100
 *   flows      GET <url>/flows?query={"botId":"…","isDeleted":false}
 *                &projection=["id","botId","data.label","data.description","data.categories","dateModified","isDeleted","version"]
 *                &from=0&size=100
 *   every call carries `Authorization: FLOW <token>`; a list page is a bare
 *   JSON array (the SDK's `makeList` wraps it as `{ total, items }`).
 *   Observed live (2026-09-05): the hub IGNORES `from` for this route
 *   (page 2 repeats page 1), so paging is id-driven — rows are deduped
 *   by id and the loop stops as soon as a page adds nothing new.
 *
 * The projection matters: a full flow record is ~2.7 MB (its step
 * trees); projected rows are a few hundred bytes.
 *
 * Fully dependency-injected (fetch, clock) so tests run without the
 * network.
 */

export interface GsxBot {
  id: string;
  label: string;
  description: string;
  dateModified: number | null;
}

export interface GsxFlow {
  id: string;
  botId: string;
  label: string;
  description: string;
  categories: string[];
  version: string;
  dateModified: number | null;
  isDeleted: boolean;
}

export interface GsxFlowsPort {
  listBots(): Promise<GsxBot[]>;
  listFlows(botId: string): Promise<GsxFlow[]>;
}

export class GsxFlowsError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GsxFlowsError';
    this.status = status;
  }
}

export interface GsxFlowsPortDeps {
  env: string;
  accountId: string;
  fetch: (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
  now?: () => number;
  /** Page size for list calls (test seam). */
  pageSize?: number;
}

const TOKEN_TTL_MS = 50 * 60 * 1000;
const FLOW_PROJECTION = [
  'id',
  'botId',
  'data.label',
  'data.description',
  'data.categories',
  'dateModified',
  'isDeleted',
  'version',
];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export class FetchGsxFlowsPort implements GsxFlowsPort {
  private token: { value: string; mintedAt: number } | null = null;
  private serviceUrl: string | null = null;
  private readonly now: () => number;
  private readonly pageSize: number;

  constructor(private readonly deps: GsxFlowsPortDeps) {
    this.now = deps.now ?? ((): number => Date.now());
    this.pageSize = deps.pageSize ?? 100;
  }

  async listBots(): Promise<GsxBot[]> {
    const rows = await this.listAll('bots', { isDeleted: false }, null);
    return rows
      .map((r) => {
        const data = (r['data'] ?? {}) as Record<string, unknown>;
        return {
          id: str(r['id']),
          label: str(data['label']) || str(r['id']),
          description: str(data['description']),
          dateModified: num(r['dateModified']),
        };
      })
      .filter((b) => b.id.length > 0);
  }

  async listFlows(botId: string): Promise<GsxFlow[]> {
    const rows = await this.listAll('flows', { botId, isDeleted: false }, FLOW_PROJECTION);
    return rows
      .map((r) => {
        const data = (r['data'] ?? {}) as Record<string, unknown>;
        const cats = data['categories'];
        return {
          id: str(r['id']),
          botId: str(r['botId']) || botId,
          label: str(data['label']) || str(r['id']),
          description: str(data['description']),
          categories: Array.isArray(cats) ? cats.filter((c): c is string => typeof c === 'string') : [],
          version: str(r['version']),
          dateModified: num(r['dateModified']),
          isDeleted: r['isDeleted'] === true,
        };
      })
      .filter((f) => f.id.length > 0);
  }

  // ── internals ────────────────────────────────────────────────────────

  private async listAll(
    route: 'bots' | 'flows',
    query: Record<string, unknown>,
    projection: string[] | null
  ): Promise<Array<Record<string, unknown>>> {
    // Token first: an account without the refresh flow fails fast on its
    // 404 (the caller aborts quietly) before discovery is even asked.
    const token = await this.mintToken();
    const base = await this.discover();
    const out: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    let from = 0;
    // Hard stop so a misbehaving hub can never loop forever.
    for (let page = 0; page < 50; page += 1) {
      const qs = new URLSearchParams();
      qs.set('query', JSON.stringify(query));
      if (projection !== null) qs.set('projection', JSON.stringify(projection));
      qs.set('from', String(from));
      qs.set('size', String(this.pageSize));
      const body = await this.getJson(`${base}/${route}?${qs.toString()}`, token);
      // Live shape: a bare array per page. Also accept the SDK's wrapped
      // `{ total, items }` so a proxy that normalizes keeps working.
      const items: Array<Record<string, unknown>> = Array.isArray(body)
        ? (body as Array<Record<string, unknown>>)
        : Array.isArray((body as { items?: unknown } | null)?.items)
          ? ((body as { items: Array<Record<string, unknown>> }).items)
          : [];
      // Id-driven paging: the hub repeats page 1 for any `from`, and may
      // hand back more rows than `size`. Keep only unseen ids; stop when
      // a page adds nothing new or comes back short.
      let added = 0;
      for (const row of items) {
        const id = str(row['id']);
        if (id.length === 0 || seen.has(id)) continue;
        seen.add(id);
        out.push(row);
        added += 1;
      }
      from += items.length;
      if (added === 0 || items.length < this.pageSize) break;
    }
    return out;
  }

  private async mintToken(): Promise<string> {
    if (this.token !== null && this.now() - this.token.mintedAt < TOKEN_TTL_MS) return this.token.value;
    const url = `https://em.${this.deps.env}.api.onereach.ai/http/${encodeURIComponent(this.deps.accountId)}/refresh_token`;
    const body = await this.getJson(url, null);
    const token = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['token'] : undefined;
    if (typeof token !== 'string' || token.length === 0) {
      throw new GsxFlowsError('The account token endpoint answered without a token.');
    }
    this.token = { value: token.startsWith('FLOW ') ? token : `FLOW ${token}`, mintedAt: this.now() };
    return this.token.value;
  }

  private async discover(): Promise<string> {
    if (this.serviceUrl !== null) return this.serviceUrl;
    const body = await this.getJson(
      `https://discovery.${this.deps.env}.api.onereach.ai/api/v2?serviceName=data-hub-pg`,
      null
    );
    const url = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['url'] : undefined;
    if (typeof url !== 'string' || url.length === 0) {
      throw new GsxFlowsError('Service discovery answered without a data-hub URL.');
    }
    this.serviceUrl = url.replace(/\/+$/, '');
    return this.serviceUrl;
  }

  private async getJson(url: string, auth: string | null): Promise<unknown> {
    let res: { ok: boolean; status: number; text(): Promise<string> };
    try {
      res = await this.deps.fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          ...(auth !== null ? { Authorization: auth } : {}),
        },
      });
    } catch (err) {
      throw new GsxFlowsError(`${new URL(url).host} did not answer: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new GsxFlowsError(`${new URL(url).host} answered ${res.status}${text.length > 0 ? `: ${text.slice(0, 160)}` : ''}`, res.status);
    }
    if (text.length === 0) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GsxFlowsError(`${new URL(url).host} answered with something that is not JSON.`);
    }
  }
}
