/**
 * Credentials provider abstraction for the Neon client.
 *
 * The HTTP wrapper asks the provider for a credential bundle on every
 * request; the wrapper never holds long-lived secrets, and never
 * inspects what kind of credential it got. This is the
 * forward-security seam: when the `/omnidata/neon` endpoint hardens
 * (bearer / OAuth2 / mTLS), only one new provider variant + one new
 * `buildRequest` switch case lands -- call sites stay unchanged.
 *
 * **Today** (Phase N0): `KVCredentialsProvider` returns
 *   `{ kind: 'basic-in-body', uri, user, password, database }`
 * and the client embeds those fields in the request body per the
 * current `/omnidata/neon` contract.
 *
 * **Tomorrow** (Phase N3+): a `BearerCredentialsProvider` returns
 *   `{ kind: 'bearer', token, database }`
 * and the client adds an `Authorization: Bearer <token>` header. No
 * call site changes.
 *
 * Module-internal. Other lite modules MUST NOT import this file
 * directly -- consume `NeonApi` from `./api.ts` (Rule 11 in
 * `lite/LITE-RULES.md`).
 *
 * @internal
 */

import { getKVApi, KVError } from '../kv/api.js';

/**
 * Discriminated union of credential bundles. Each variant is a
 * different wire-format. The client `buildRequest()` switches on
 * `kind` to format the outgoing HTTP call.
 */
export type NeonCredentials =
  | {
      kind: 'basic-in-body';
      uri: string;
      user: string;
      password: string;
      database: string;
    }
  | {
      kind: 'bearer';
      token: string;
      database: string;
    };

/**
 * Settings record persisted under KV collection `lite-neon-config`,
 * key `default`. Same shape as `NeonConfig` in `types.ts` but always
 * with concrete strings (defaults applied).
 */
export interface NeonSettingsRecord {
  endpoint: string;
  uri: string;
  user: string;
  password: string;
  database: string;
}

/**
 * Provider abstraction. The client calls `get()` on every request.
 * Providers may cache internally and short-circuit; `invalidate()`
 * tells the provider that the cached credentials were rejected (e.g.
 * 401 from a bearer flow) and to re-resolve next time.
 */
export interface CredentialsProvider {
  /**
   * Resolve credentials for a single request. Returns `null` when the
   * provider has nothing configured -- the client surfaces this as
   * `NEON_NOT_CONFIGURED`.
   */
  get(): Promise<NeonCredentials | null>;
  /**
   * Resolve the endpoint URL separately from the credential bundle.
   * Endpoint lives next to credentials in the same settings record;
   * keeping it on the provider keeps "config" in one place even
   * though it's not technically a secret.
   */
  getEndpoint(): Promise<string | null>;
  /**
   * Optional: invalidate cached credentials. Called by the client on
   * a 401 response from a future bearer flow so the next request
   * re-resolves.
   */
  invalidate?(): void;
  /**
   * Read the persisted settings record (without password). Used by
   * `NeonApi.status()`. Returns `null` when nothing is persisted yet.
   */
  readPublic(): Promise<{
    endpoint: string;
    uri: string;
    user: string;
    database: string;
    hasPassword: boolean;
  } | null>;
  /**
   * Persist a partial settings update. Fields omitted from `partial`
   * are left unchanged. To clear the password explicitly, pass
   * `password: ''`.
   */
  write(partial: Partial<NeonSettingsRecord>): Promise<void>;
}

// ─── KV-backed provider (production default) ──────────────────────────────

const KV_COLLECTION = 'lite-neon-config';
const KV_KEY = 'default';

const DEFAULT_RECORD: NeonSettingsRecord = {
  endpoint: '',
  uri: '',
  user: 'neo4j',
  password: '',
  database: 'neo4j',
};

/**
 * TEMPORARY -- baked-in OneReach default graph for fresh installs.
 *
 * When the user has never configured a graph in Settings, the production
 * singleton (see `api.ts`) wires this record as the `fallbackRecord` so
 * `status()` reports `ready: true` and queries connect against the team's
 * shared Aura instance without any setup. The user can override any field
 * in Settings -> OAGI; once persisted, KV always wins over this fallback.
 *
 * This mirrors the values already present in
 * `scripts/neo4j-schema-migration.js` plus the well-known Edison
 * `/omnidata/neon` flow URL for account
 * `35254342-4a2e-475b-aec1-18547e517e29`.
 *
 * Remove (or replace with a build-time injected value) before public
 * launch -- shipping a shared password in source is a development
 * convenience, not a production posture. Tracked in
 * `lite/LITE-PUNCH-LIST.md`.
 */
export const BAKED_IN_DEFAULT_GRAPH: Readonly<NeonSettingsRecord> = Object.freeze({
  endpoint:
    'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/omnidata/neon',
  uri: 'neo4j+s://40c812ef.databases.neo4j.io',
  user: 'neo4j',
  password: 'oCLF5bxkj66qivVDh1biePK7Byo9U1NUvFLJrHnQjzo',
  database: 'neo4j',
});

interface KVCredentialsProviderOptions {
  /** Override the KV API. Defaults to `getKVApi()`. */
  kvApi?: ReturnType<typeof getKVApi>;
  /** Override the KV collection name. Defaults to `lite-neon-config`. */
  collection?: string;
  /** Override the KV key name. Defaults to `default`. */
  key?: string;
  /**
   * Optional fallback record returned when KV has no record at all.
   * When omitted (the test default), `get()` / `getEndpoint()` /
   * `readPublic()` return `null` for absent records. When supplied, the
   * provider behaves as if KV held this record until the user explicitly
   * writes anything via `write()` -- at which point the persisted KV
   * value wins. The production singleton uses this to bake in the
   * OneReach default graph so fresh installs are pre-configured.
   */
  fallbackRecord?: NeonSettingsRecord;
}

/**
 * Reads/writes Neon settings from the lite KV module under
 * `lite-neon-config / default`. This is the production default.
 *
 * Caching: reads are NOT cached. The KV `get()` itself is fast and
 * stays consistent with concurrent writes from the Settings UI.
 * `invalidate()` is a no-op for this provider.
 */
export class KVCredentialsProvider implements CredentialsProvider {
  private readonly kvApi: ReturnType<typeof getKVApi>;
  private readonly collection: string;
  private readonly key: string;
  private readonly fallbackRecord: NeonSettingsRecord | null;

  constructor(options: KVCredentialsProviderOptions = {}) {
    this.kvApi = options.kvApi ?? getKVApi();
    this.collection = options.collection ?? KV_COLLECTION;
    this.key = options.key ?? KV_KEY;
    this.fallbackRecord =
      options.fallbackRecord !== undefined ? { ...options.fallbackRecord } : null;
  }

  async get(): Promise<NeonCredentials | null> {
    const record = await this.readRecord();
    if (record === null) return null;
    if (record.uri.length === 0 || record.password.length === 0) return null;
    return {
      kind: 'basic-in-body',
      uri: record.uri,
      user: record.user,
      password: record.password,
      database: record.database,
    };
  }

  async getEndpoint(): Promise<string | null> {
    const record = await this.readRecord();
    if (record === null) return null;
    if (record.endpoint.length === 0) return null;
    return record.endpoint;
  }

  async readPublic(): Promise<{
    endpoint: string;
    uri: string;
    user: string;
    database: string;
    hasPassword: boolean;
  } | null> {
    const record = await this.readRecord();
    if (record === null) return null;
    return {
      endpoint: record.endpoint,
      uri: record.uri,
      user: record.user,
      database: record.database,
      hasPassword: record.password.length > 0,
    };
  }

  async write(partial: Partial<NeonSettingsRecord>): Promise<void> {
    const current = (await this.readRecord()) ?? { ...DEFAULT_RECORD };
    const next: NeonSettingsRecord = {
      endpoint: partial.endpoint !== undefined ? partial.endpoint : current.endpoint,
      uri: partial.uri !== undefined ? partial.uri : current.uri,
      user: partial.user !== undefined && partial.user.length > 0 ? partial.user : current.user,
      password: partial.password !== undefined ? partial.password : current.password,
      database:
        partial.database !== undefined && partial.database.length > 0
          ? partial.database
          : current.database,
    };
    await this.kvApi.set(this.collection, this.key, next);
  }

  /**
   * Read the raw record. Returns `null` when nothing is persisted and
   * no fallback record is configured. When a fallback record was passed
   * to the constructor, that record is returned for absent / malformed
   * KV values so callers see a fully-formed configuration.
   * KV failures bubble through as `KVError`; callers wrap as needed.
   */
  private async readRecord(): Promise<NeonSettingsRecord | null> {
    try {
      const value = await this.kvApi.get(this.collection, this.key);
      if (value === null || value === undefined) {
        return this.fallbackRecord !== null ? { ...this.fallbackRecord } : null;
      }
      if (typeof value !== 'object') {
        return this.fallbackRecord !== null ? { ...this.fallbackRecord } : null;
      }
      const v = value as Partial<NeonSettingsRecord>;
      return {
        endpoint: typeof v.endpoint === 'string' ? v.endpoint : '',
        uri: typeof v.uri === 'string' ? v.uri : '',
        user: typeof v.user === 'string' && v.user.length > 0 ? v.user : 'neo4j',
        password: typeof v.password === 'string' ? v.password : '',
        database:
          typeof v.database === 'string' && v.database.length > 0 ? v.database : 'neo4j',
      };
    } catch (err) {
      if (err instanceof KVError) {
        // Propagate; the calling layer surfaces this as a Neon-side
        // error if needed. Reads happen outside the query hot-path so
        // we don't need to wrap here.
        throw err;
      }
      throw err;
    }
  }
}

// ─── Static provider (tests) ──────────────────────────────────────────────

/**
 * In-memory provider for tests. Holds a single `NeonSettingsRecord`
 * and answers `get()` / `getEndpoint()` / `readPublic()` from it.
 */
export class StaticCredentialsProvider implements CredentialsProvider {
  private record: NeonSettingsRecord;

  constructor(initial: Partial<NeonSettingsRecord> = {}) {
    this.record = { ...DEFAULT_RECORD, ...initial };
  }

  async get(): Promise<NeonCredentials | null> {
    if (this.record.uri.length === 0 || this.record.password.length === 0) return null;
    return {
      kind: 'basic-in-body',
      uri: this.record.uri,
      user: this.record.user,
      password: this.record.password,
      database: this.record.database,
    };
  }

  async getEndpoint(): Promise<string | null> {
    if (this.record.endpoint.length === 0) return null;
    return this.record.endpoint;
  }

  async readPublic(): Promise<{
    endpoint: string;
    uri: string;
    user: string;
    database: string;
    hasPassword: boolean;
  }> {
    return {
      endpoint: this.record.endpoint,
      uri: this.record.uri,
      user: this.record.user,
      database: this.record.database,
      hasPassword: this.record.password.length > 0,
    };
  }

  async write(partial: Partial<NeonSettingsRecord>): Promise<void> {
    this.record = {
      endpoint: partial.endpoint !== undefined ? partial.endpoint : this.record.endpoint,
      uri: partial.uri !== undefined ? partial.uri : this.record.uri,
      user:
        partial.user !== undefined && partial.user.length > 0 ? partial.user : this.record.user,
      password: partial.password !== undefined ? partial.password : this.record.password,
      database:
        partial.database !== undefined && partial.database.length > 0
          ? partial.database
          : this.record.database,
    };
  }

  /** @internal -- direct snapshot for tests. */
  _snapshot(): NeonSettingsRecord {
    return { ...this.record };
  }
}
