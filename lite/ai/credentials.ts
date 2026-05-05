/**
 * Credentials provider for the Lite AI service.
 *
 * Mirrors the Neon module's `CredentialsProvider` pattern (ADR-033)
 * so the wire-format can change without touching call sites. v1
 * supports `{ kind: 'openai-bearer', apiKey }`; future providers
 * (Anthropic, Azure, gcp) layer in as new union variants + a new
 * `client.ts` switch case.
 *
 * The KV-backed provider stores the API key as plaintext in KV
 * today. **Hardening roadmap** (in `./README.md`): A1 = move the
 * API key into the OS keychain via `keytar` (same pattern as
 * `lite/totp/store.ts`); KV stores only the model / voice
 * preferences. The `CredentialsProvider` interface stays unchanged
 * across A0 -> A1 -- only the provider implementation swaps.
 *
 * @internal
 */

import { getKVApi } from '../kv/api.js';

/**
 * Discriminated union of credential bundles. v1 has one variant.
 */
export type AiCredentials = {
  kind: 'openai-bearer';
  apiKey: string;
};

/**
 * Persisted AI settings record. KV collection `lite-ai-config`,
 * key `default`. Same shape as `AiConfig` in `types.ts` but always
 * with concrete strings (defaults applied).
 */
export interface AiSettingsRecord {
  apiKey: string;
  defaultTtsVoice: string;
  defaultTtsModel: string;
  defaultChatModel: string;
}

const DEFAULT_RECORD: AiSettingsRecord = {
  apiKey: '',
  defaultTtsVoice: 'nova',
  defaultTtsModel: 'tts-1',
  defaultChatModel: 'gpt-4o-mini',
};

const KV_COLLECTION = 'lite-ai-config';
const KV_KEY = 'default';

/**
 * Provider abstraction. The client calls `get()` on every request.
 * `invalidate()` is a no-op for the KV provider (no caching);
 * future bearer providers will use it on 401 responses.
 */
export interface AiCredentialsProvider {
  /** Resolve credentials. Returns null when no API key is set. */
  get(): Promise<AiCredentials | null>;
  /** Read the persisted record (without API key). Used by `status()`. */
  readPublic(): Promise<{
    defaultTtsVoice: string;
    defaultTtsModel: string;
    defaultChatModel: string;
    hasApiKey: boolean;
  }>;
  /** Persist a partial settings update. */
  write(partial: Partial<AiSettingsRecord>): Promise<void>;
  /** Invalidate cached credentials. No-op for the KV provider. */
  invalidate?(): void;
}

interface KVCredentialsProviderOptions {
  kvApi?: ReturnType<typeof getKVApi>;
  collection?: string;
  key?: string;
  /**
   * Resolver for the active OneReach `accountId`. When `null`, the
   * provider treats the user as signed-out: reads return defaults
   * without hitting KV; writes throw a clear error.
   *
   * Wired in `lite/ai/api.ts` to
   * `getAuthApi().getSession('edison')?.accountId ?? null`.
   *
   * If omitted (legacy tests), the provider falls back to allowing
   * all operations.
   */
  getActiveAccountId?: () => string | null;
}

/**
 * Reads/writes AI settings from the lite KV module under
 * `lite-ai-config / default`. This is the production default.
 */
export class KVAiCredentialsProvider implements AiCredentialsProvider {
  private readonly kvApi: ReturnType<typeof getKVApi>;
  private readonly collection: string;
  private readonly key: string;
  private readonly getActiveAccountId: NonNullable<
    KVCredentialsProviderOptions['getActiveAccountId']
  > | null;

  constructor(options: KVCredentialsProviderOptions = {}) {
    this.kvApi = options.kvApi ?? getKVApi();
    this.collection = options.collection ?? KV_COLLECTION;
    this.key = options.key ?? KV_KEY;
    this.getActiveAccountId = options.getActiveAccountId ?? null;
  }

  /** True when callers should hit KV. Always true in legacy mode. */
  private isSignedIn(): boolean {
    if (this.getActiveAccountId === null) return true;
    const accountId = this.getActiveAccountId();
    return typeof accountId === 'string' && accountId.length > 0;
  }

  async get(): Promise<AiCredentials | null> {
    const record = await this.readRecord();
    if (record.apiKey.length === 0) return null;
    return { kind: 'openai-bearer', apiKey: record.apiKey };
  }

  async readPublic(): Promise<{
    defaultTtsVoice: string;
    defaultTtsModel: string;
    defaultChatModel: string;
    hasApiKey: boolean;
  }> {
    const record = await this.readRecord();
    return {
      defaultTtsVoice: record.defaultTtsVoice,
      defaultTtsModel: record.defaultTtsModel,
      defaultChatModel: record.defaultChatModel,
      hasApiKey: record.apiKey.length > 0,
    };
  }

  async write(partial: Partial<AiSettingsRecord>): Promise<void> {
    if (!this.isSignedIn()) {
      throw new Error(
        'Cannot save AI configuration while signed out. Open Settings -> Account to sign in.'
      );
    }
    const current = await this.readRecord();
    const next: AiSettingsRecord = {
      apiKey: partial.apiKey !== undefined ? partial.apiKey : current.apiKey,
      defaultTtsVoice:
        partial.defaultTtsVoice !== undefined && partial.defaultTtsVoice.length > 0
          ? partial.defaultTtsVoice
          : current.defaultTtsVoice,
      defaultTtsModel:
        partial.defaultTtsModel !== undefined && partial.defaultTtsModel.length > 0
          ? partial.defaultTtsModel
          : current.defaultTtsModel,
      defaultChatModel:
        partial.defaultChatModel !== undefined && partial.defaultChatModel.length > 0
          ? partial.defaultChatModel
          : current.defaultChatModel,
    };
    await this.kvApi.set(this.collection, this.key, next);
  }

  private async readRecord(): Promise<AiSettingsRecord> {
    if (!this.isSignedIn()) {
      // Signed-out: skip the KV round-trip and serve defaults so
      // status() / readPublic() render meaningfully.
      return { ...DEFAULT_RECORD };
    }
    try {
      const value = await this.kvApi.get(this.collection, this.key);
      if (value === null || value === undefined || typeof value !== 'object') {
        return { ...DEFAULT_RECORD };
      }
      const v = value as Partial<AiSettingsRecord>;
      return {
        apiKey: typeof v.apiKey === 'string' ? v.apiKey : '',
        defaultTtsVoice:
          typeof v.defaultTtsVoice === 'string' && v.defaultTtsVoice.length > 0
            ? v.defaultTtsVoice
            : 'nova',
        defaultTtsModel:
          typeof v.defaultTtsModel === 'string' && v.defaultTtsModel.length > 0
            ? v.defaultTtsModel
            : 'tts-1',
        defaultChatModel:
          typeof v.defaultChatModel === 'string' && v.defaultChatModel.length > 0
            ? v.defaultChatModel
            : 'gpt-4o-mini',
      };
    } catch {
      return { ...DEFAULT_RECORD };
    }
  }
}

/**
 * In-memory provider for tests. Constructor accepts initial state.
 */
export class StaticAiCredentialsProvider implements AiCredentialsProvider {
  private record: AiSettingsRecord;

  constructor(record: Partial<AiSettingsRecord> = {}) {
    this.record = { ...DEFAULT_RECORD, ...record };
  }

  async get(): Promise<AiCredentials | null> {
    if (this.record.apiKey.length === 0) return null;
    return { kind: 'openai-bearer', apiKey: this.record.apiKey };
  }

  async readPublic(): Promise<{
    defaultTtsVoice: string;
    defaultTtsModel: string;
    defaultChatModel: string;
    hasApiKey: boolean;
  }> {
    return {
      defaultTtsVoice: this.record.defaultTtsVoice,
      defaultTtsModel: this.record.defaultTtsModel,
      defaultChatModel: this.record.defaultChatModel,
      hasApiKey: this.record.apiKey.length > 0,
    };
  }

  async write(partial: Partial<AiSettingsRecord>): Promise<void> {
    this.record = {
      apiKey: partial.apiKey !== undefined ? partial.apiKey : this.record.apiKey,
      defaultTtsVoice:
        partial.defaultTtsVoice !== undefined && partial.defaultTtsVoice.length > 0
          ? partial.defaultTtsVoice
          : this.record.defaultTtsVoice,
      defaultTtsModel:
        partial.defaultTtsModel !== undefined && partial.defaultTtsModel.length > 0
          ? partial.defaultTtsModel
          : this.record.defaultTtsModel,
      defaultChatModel:
        partial.defaultChatModel !== undefined && partial.defaultChatModel.length > 0
          ? partial.defaultChatModel
          : this.record.defaultChatModel,
    };
  }
}
