/**
 * AiService -- the default implementation of `AiApi`.
 *
 * Picks the configured provider per call (so the user can drop in a
 * key/flow without restarting), validates input, dispatches to the
 * matching client, and normalizes every failure to an `AiError`.
 *
 *   - Claude        -> the Anthropic SDK (via an injectable message-creator
 *                      factory; default = `makeClaudeMessageCreator`).
 *   - OneReach flow -> a FLOW token minted from the logged-in session
 *                      (`accountId` provider) unless an explicit token
 *                      override is configured.
 *
 * Structurally conforms to `AiApi` (enforced where `api.ts`'s
 * `buildDefaultApi(): AiApi` returns a new instance). Not declared with
 * `implements AiApi` to avoid an api<->service import cycle.
 *
 * SECURITY: logs carry only provider/model/lengths -- never the key,
 * token, or the user's purpose text.
 */

import { AiError, AI_ERROR_CODES } from './errors.js';
import type { ClaudeConfig, ResolvedAiConfig } from './config.js';
import {
  callClaude,
  callOneReachFlow,
  makeClaudeMessageCreator,
  mintFlowAuthHeader,
  type ClaudeMessageCreator,
} from './client.js';
import { callClaudeMetadata } from './metadata.js';
import type {
  AiStatus,
  SpaceAssistInput,
  SpaceAssistResult,
  AssetMetadataInput,
  AssetMetadataResult,
} from './types.js';

export interface AiServiceDeps {
  /** Resolve the active provider config (or null when unconfigured). */
  loadConfig: () => ResolvedAiConfig | null;
  /** Fetch implementation (injectable for tests) -- used by the flow path. */
  fetchImpl: typeof fetch;
  /** Resolve the logged-in OneReach accountId (or null when signed out). */
  accountId: () => string | null;
  /** Optional logger. Defaults to silent. */
  logger?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /** Test seam: build the Claude message-creator. Defaults to the SDK one. */
  makeClaudeMessageCreator?: (config: ClaudeConfig) => ClaudeMessageCreator;
}

export class AiService {
  private readonly loadConfig: AiServiceDeps['loadConfig'];
  private readonly fetchImpl: typeof fetch;
  private readonly accountId: () => string | null;
  private readonly makeCreator: (config: ClaudeConfig) => ClaudeMessageCreator;
  private readonly log: NonNullable<AiServiceDeps['logger']>;

  constructor(deps: AiServiceDeps) {
    this.loadConfig = deps.loadConfig;
    this.fetchImpl = deps.fetchImpl;
    this.accountId = deps.accountId;
    this.makeCreator = deps.makeClaudeMessageCreator ?? makeClaudeMessageCreator;
    this.log =
      deps.logger ??
      ((): void => {
        /* default: silent */
      });
  }

  async getStatus(): Promise<AiStatus> {
    const cfg = this.loadConfig();
    return cfg === null
      ? { configured: false, provider: null }
      : { configured: true, provider: cfg.provider };
  }

  async spaceAssist(input: SpaceAssistInput): Promise<SpaceAssistResult> {
    const purpose = typeof input?.purpose === 'string' ? input.purpose.trim() : '';
    if (purpose.length === 0) {
      throw new AiError({
        code: AI_ERROR_CODES.INVALID_INPUT,
        message: 'A purpose is required to draft a Space.',
        context: { op: 'space-assist' },
        remediation: 'Type a sentence about what the Space is for, then try again.',
      });
    }

    const cfg = this.loadConfig();
    if (cfg === null) {
      throw new AiError({
        code: AI_ERROR_CODES.NOT_CONFIGURED,
        message: 'No AI provider is configured.',
        context: { op: 'space-assist' },
        remediation:
          'Add a Claude API key (ANTHROPIC_API_KEY) or a OneReach flow URL to ai-config.json in the app data folder. See lite/ai/README.md.',
      });
    }

    const normalized: SpaceAssistInput =
      typeof input.name === 'string' && input.name.trim().length > 0
        ? { purpose, name: input.name.trim() }
        : { purpose };

    this.log('info', 'space-assist start', {
      provider: cfg.provider,
      model: cfg.provider === 'claude' ? cfg.model : undefined,
      purposeLen: purpose.length,
      hasName: normalized.name !== undefined,
    });

    try {
      const result =
        cfg.provider === 'claude'
          ? await callClaude(normalized, {
              model: cfg.model,
              createMessage: this.makeCreator(cfg),
            })
          : await callOneReachFlow(normalized, {
              url: cfg.url,
              authHeader: await this.resolveFlowAuthHeader(cfg.token, cfg.tokenBaseUrl),
              fetchImpl: this.fetchImpl,
            });
      this.log('info', 'space-assist ok', {
        provider: cfg.provider,
        objectives: result.objectives.length,
      });
      return result;
    } catch (err) {
      if (err instanceof AiError) {
        this.log('warn', 'space-assist rejected', { provider: cfg.provider, code: err.code });
        throw err;
      }
      this.log('error', 'space-assist unexpected', {
        provider: cfg.provider,
        error: (err as Error).message,
      });
      throw new AiError({
        code: AI_ERROR_CODES.PROVIDER_ERROR,
        message: `AI provider error: ${(err as Error).message}`,
        context: { provider: cfg.provider, op: 'space-assist' },
        remediation: 'Try again, or fill in the details manually.',
        cause: err,
      });
    }
  }

  async extractAssetMetadata(input: AssetMetadataInput): Promise<AssetMetadataResult> {
    if (input === null || typeof input !== 'object' || typeof input.kind !== 'string') {
      throw new AiError({
        code: AI_ERROR_CODES.INVALID_INPUT,
        message: 'An asset (with a kind) is required to extract metadata.',
        context: { op: 'extract-metadata' },
        remediation: 'Pass an AssetMetadataInput with at least a `kind`.',
      });
    }

    const cfg = this.loadConfig();
    // Metadata extraction is Claude-only -- the OneReach flow contract
    // covers space-assist only. Require a Claude config explicitly.
    if (cfg === null || cfg.provider !== 'claude') {
      throw new AiError({
        code: AI_ERROR_CODES.NOT_CONFIGURED,
        message: 'Claude is not configured for metadata extraction.',
        context: { op: 'extract-metadata', provider: cfg?.provider ?? null },
        remediation:
          'Open Settings -> AI and paste your Anthropic API key (or set ANTHROPIC_API_KEY).',
      });
    }

    const modality = input.imageBase64
      ? 'image'
      : input.pdfBase64
        ? 'pdf'
        : input.text
          ? 'text'
          : 'hints';
    this.log('info', 'extract-metadata start', {
      provider: 'claude',
      model: cfg.model,
      kind: input.kind,
      modality,
      textLen: typeof input.text === 'string' ? input.text.length : 0,
    });

    try {
      const result = await callClaudeMetadata(input, {
        model: cfg.model,
        createMessage: this.makeCreator(cfg),
      });
      this.log('info', 'extract-metadata ok', {
        provider: 'claude',
        tags: result.tags.length,
        topics: result.topics.length,
      });
      return result;
    } catch (err) {
      if (err instanceof AiError) {
        this.log('warn', 'extract-metadata rejected', { provider: 'claude', code: err.code });
        throw err;
      }
      this.log('error', 'extract-metadata unexpected', {
        provider: 'claude',
        error: (err as Error).message,
      });
      throw new AiError({
        code: AI_ERROR_CODES.PROVIDER_ERROR,
        message: `AI provider error: ${(err as Error).message}`,
        context: { provider: 'claude', op: 'extract-metadata' },
        remediation: 'Try again, or add metadata manually.',
        cause: err,
      });
    }
  }

  /**
   * Resolve the OneReach `Authorization` header: an explicit token
   * override when configured, otherwise a FLOW token minted from the
   * logged-in session. Throws `AI_NOT_CONFIGURED` when signed out.
   */
  private async resolveFlowAuthHeader(
    overrideToken: string | undefined,
    tokenBaseUrl: string | undefined
  ): Promise<string> {
    if (overrideToken !== undefined && overrideToken.length > 0) {
      return overrideToken;
    }
    const accountId = this.accountId();
    if (accountId === null || accountId.length === 0) {
      throw new AiError({
        code: AI_ERROR_CODES.NOT_CONFIGURED,
        message: 'Not signed in to OneReach.',
        context: { provider: 'onereach-flow', op: 'space-assist' },
        remediation: 'Sign in to OneReach, then try again.',
      });
    }
    return mintFlowAuthHeader(accountId, this.fetchImpl, tokenBaseUrl);
  }
}
