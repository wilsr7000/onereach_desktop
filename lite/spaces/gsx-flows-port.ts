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

/**
 * A GSX View (Action Desk → Views). A view built from a flow carries
 * that flow's id — Action Desk's own list asks the hub for `flowId` /
 * `botId`; the SDK's typings call the same link `linkId` + `linkType`.
 * Either spelling is accepted.
 */
export interface GsxView {
  id: string;
  label: string;
  flowId: string | null;
  botId: string | null;
  dateModified: number | null;
}

export interface GsxFlowsPort {
  listBots(): Promise<GsxBot[]>;
  listFlows(botId: string): Promise<GsxFlow[]>;
  /**
   * The account's live views (2026-09-05). Needs the signed-in USER
   * token — the hub refuses the FLOW token on this route ("wrong
   * keyId") — so a port without one answers an empty list.
   */
  listViews?(): Promise<GsxView[]>;
  /**
   * ADR-092 — create a Designer bot (what GSX calls a space). Needs the
   * signed-in USER token like the views route; without one it throws a
   * GsxFlowsError with status 401 so the caller can say "sign in".
   */
  createBot?(input: { label: string; description: string }): Promise<{ id: string }>;
  /** Soft-delete a bot (Designer's own "temporarily"); it can be recovered in Designer. */
  deleteBot?(id: string): Promise<void>;
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
  fetch: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
  ) => Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
  now?: () => number;
  /** Page size for list calls (test seam). */
  pageSize?: number;
  /**
   * The signed-in user's token (Lite's auth session), sent raw as
   * `Authorization` the way Studio and Action Desk send it. Only the
   * views route needs it; null (signed out) makes `listViews` answer [].
   */
  userToken?: () => string | null;
}

const TOKEN_TTL_MS = 50 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
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

/** What Action Desk's own list asks for, trimmed to what Lite links to. */
const VIEW_PROJECTION = ['id', 'data.data.label', 'dateModified', 'flowId', 'botId', 'linkId', 'linkType'];

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

  async listViews(): Promise<GsxView[]> {
    const user = this.deps.userToken?.() ?? null;
    if (user === null || user.length === 0) return [];
    const rows = await this.listAll('views', { isDeleted: false }, VIEW_PROJECTION, user);
    return rows
      .map((r) => {
        const data = (r['data'] ?? {}) as Record<string, unknown>;
        const inner = (data['data'] ?? {}) as Record<string, unknown>;
        const linkType = str(r['linkType']);
        const linkId = str(r['linkId']);
        const flowId = str(r['flowId']) || (linkType === 'flow' ? linkId : '');
        const botId = str(r['botId']) || (linkType === 'bot' ? linkId : '');
        return {
          id: str(r['id']),
          label: str(inner['label']) || str(r['id']),
          flowId: flowId.length > 0 ? flowId : null,
          botId: botId.length > 0 ? botId : null,
          dateModified: num(r['dateModified']),
        };
      })
      .filter((v) => v.id.length > 0);
  }

  async createBot(input: { label: string; description: string }): Promise<{ id: string }> {
    const user = this.userTokenOrThrow('Creating a GSX space');
    const base = await this.discover();
    // Studio's own `saveBot` for a new bot: POST /bots/new with the bot
    // under `bot`, id 'new', and the empty fields Studio's getNewBot()
    // starts from. The hub answers the created record's id.
    const body = {
      bot: {
        id: 'new',
        data: {
          label: input.label,
          description: input.description,
          longDescription: '',
          iconUrl: '',
          deploy: {},
        },
      },
    };
    const res = await this.sendJson('POST', `${base}/bots/new`, user, body);
    const rec = typeof res === 'object' && res !== null ? (res as Record<string, unknown>) : {};
    const nested = typeof rec['bot'] === 'object' && rec['bot'] !== null ? (rec['bot'] as Record<string, unknown>) : {};
    const id = str(rec['id']) || str(nested['id']);
    if (id.length === 0) throw new GsxFlowsError('The data hub created the bot but answered without its id.');
    return { id };
  }

  async deleteBot(id: string): Promise<void> {
    const user = this.userTokenOrThrow('Deleting a GSX space');
    const base = await this.discover();
    await this.sendJson('DELETE', `${base}/bots/${encodeURIComponent(id)}`, user, { temporarily: true });
  }

  // ── internals ────────────────────────────────────────────────────────

  private userTokenOrThrow(what: string): string {
    const user = this.deps.userToken?.() ?? null;
    if (user === null || user.length === 0) {
      throw new GsxFlowsError(`${what} needs the signed-in user token; nobody is signed in.`, 401);
    }
    return user;
  }

  private async listAll(
    route: 'bots' | 'flows' | 'views',
    query: Record<string, unknown>,
    projection: string[] | null,
    userToken: string | null = null
  ): Promise<Array<Record<string, unknown>>> {
    // Token first: an account without the refresh flow fails fast on its
    // 404 (the caller aborts quietly) before discovery is even asked.
    // Views are the exception: they ride the user's own token.
    const token = userToken ?? (await this.mintToken());
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

  private getJson(url: string, auth: string | null): Promise<unknown> {
    return this.sendJson('GET', url, auth);
  }

  private async sendJson(method: 'GET' | 'POST' | 'DELETE', url: string, auth: string | null, body?: unknown): Promise<unknown> {
    let res: { ok: boolean; status: number; text(): Promise<string> };
    try {
      res = await this.deps.fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          ...(auth !== null ? { Authorization: auth } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        // A hub that hangs must not hang a Space creation or a sync.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
