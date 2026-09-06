/**
 * AiService -- the default implementation of `AiApi`.
 *
 * Picks the configured provider per call (so the user can drop in a
 * key/flow without restarting), validates input, dispatches to the
 * matching client, and normalizes every failure to an `AiError`.
 *
 *   - Claude        -> the Anthropic SDK (via an injectable message-creator
 *                      factory; default = `makeClaudeMessageCreator`).
 *   - OpenAI        -> the Chat Completions API over plain fetch, behind
 *                      the SAME creator / chat-client seams (`ai/openai.ts`),
 *                      so every capability below serves both providers.
 *   - OneReach flow -> a FLOW token minted from the logged-in session
 *                      (`accountId` provider) unless an explicit token
 *                      override is configured. `spaceAssist` only.
 *
 * Structurally conforms to `AiApi` (enforced where `api.ts`'s
 * `buildDefaultApi(): AiApi` returns a new instance). Not declared with
 * `implements AiApi` to avoid an api<->service import cycle.
 *
 * SECURITY: logs carry only provider/model/lengths -- never the key,
 * token, or the user's purpose text.
 */

import { AiError, AI_ERROR_CODES } from './errors.js';
import { callClaudeSuggestSpaces } from './suggest-spaces.js';
import type { SuggestSpacesInput, SuggestSpacesResult } from './types.js';
import type { ClaudeConfig, KeyedModelConfig, ResolvedAiConfig } from './config.js';
import {
  callClaude,
  callOneReachFlow,
  makeClaudeMessageCreator,
  mintFlowAuthHeader,
  type ClaudeMessageCreator,
} from './client.js';
import { makeOpenAiMessageCreator } from './openai.js';
import { callClaudeMetadata } from './metadata.js';
import { callClaudeOkf } from './okf.js';
import {
  runClaudeChat,
  runClaudeChatStream,
  assertValidChatInput,
  profileToModel,
  type AiChatInput,
  type AiChatResult,
  type ClaudeChatClient,
} from './chat.js';
import type {
  AiStatus,
  SpaceAssistInput,
  SpaceAssistResult,
  AssetMetadataInput,
  AssetMetadataResult,
  OkfConversionInput,
  OkfConversionResult,
} from './types.js';

/** The user-facing fix for "nothing is configured" — every key path offers it. */
export const NOT_CONFIGURED_REMEDIATION =
  'Add a Claude API key in Settings → AI. It takes a minute — the walkthrough there shows where to get one.';

export interface AiServiceDeps {
  /** Resolve the active provider config (or null when unconfigured). */
  loadConfig: () => ResolvedAiConfig | null;
  /** Fetch implementation (injectable for tests) -- used by the flow + OpenAI paths. */
  fetchImpl: typeof fetch;
  /** Resolve the logged-in OneReach accountId (or null when signed out). */
  accountId: () => string | null;
  /** Optional logger. Defaults to silent. */
  logger?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /** Test seam: build the Claude message-creator. Defaults to the SDK one. */
  makeClaudeMessageCreator?: (config: ClaudeConfig) => ClaudeMessageCreator;
  /** Test seam: build the Claude chat client (chat/chatStream). Defaults to the SDK one. */
  makeClaudeChatClient?: (config: ClaudeConfig) => ClaudeChatClient;
  /** Test seam: build the OpenAI message-creator. Defaults to the fetch adapter. */
  makeOpenAiMessageCreator?: (config: KeyedModelConfig) => ClaudeMessageCreator;
  /** Test seam: build the OpenAI chat client. Defaults to the fetch/SSE adapter. */
  makeOpenAiChatClient?: (config: KeyedModelConfig) => ClaudeChatClient;
}

export class AiService {
  private readonly loadConfig: AiServiceDeps['loadConfig'];
  private readonly fetchImpl: typeof fetch;
  private readonly accountId: () => string | null;
  private readonly makeClaudeCreator: (config: ClaudeConfig) => ClaudeMessageCreator;
  private readonly makeOpenAiCreator: ((config: KeyedModelConfig) => ClaudeMessageCreator) | undefined;
  private readonly makeClaudeChat: ((config: ClaudeConfig) => ClaudeChatClient) | undefined;
  private readonly makeOpenAiChat: ((config: KeyedModelConfig) => ClaudeChatClient) | undefined;
  private readonly log: NonNullable<AiServiceDeps['logger']>;

  constructor(deps: AiServiceDeps) {
    this.loadConfig = deps.loadConfig;
    this.fetchImpl = deps.fetchImpl;
    this.accountId = deps.accountId;
    this.makeClaudeCreator = deps.makeClaudeMessageCreator ?? makeClaudeMessageCreator;
    this.makeOpenAiCreator = deps.makeOpenAiMessageCreator;
    this.makeClaudeChat = deps.makeClaudeChatClient;
    this.makeOpenAiChat = deps.makeOpenAiChatClient;
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

  /** The message-creator for whichever key-based provider is active. */
  private makeCreator(cfg: KeyedModelConfig): ClaudeMessageCreator {
    if (cfg.provider === 'openai') {
      return this.makeOpenAiCreator !== undefined
        ? this.makeOpenAiCreator(cfg)
        : makeOpenAiMessageCreator(cfg, { fetchImpl: this.fetchImpl });
    }
    return this.makeClaudeCreator(cfg);
  }

  /** The chat client for whichever key-based provider is active (undefined = runner default). */
  private makeChatClient(cfg: KeyedModelConfig): ClaudeChatClient | undefined {
    if (cfg.provider === 'openai') {
      return this.makeOpenAiChat !== undefined ? this.makeOpenAiChat(cfg) : undefined;
    }
    return this.makeClaudeChat !== undefined ? this.makeClaudeChat(cfg) : undefined;
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
        remediation: NOT_CONFIGURED_REMEDIATION,
      });
    }

    const normalized: SpaceAssistInput =
      typeof input.name === 'string' && input.name.trim().length > 0
        ? { purpose, name: input.name.trim() }
        : { purpose };

    this.log('info', 'space-assist start', {
      provider: cfg.provider,
      model: cfg.provider === 'onereach-flow' ? undefined : cfg.model,
      purposeLen: purpose.length,
      hasName: normalized.name !== undefined,
    });

    try {
      const result =
        cfg.provider === 'onereach-flow'
          ? await callOneReachFlow(normalized, {
              url: cfg.url,
              authHeader: await this.resolveFlowAuthHeader(cfg.token, cfg.tokenBaseUrl),
              fetchImpl: this.fetchImpl,
            })
          : await callClaude(normalized, {
              model: cfg.model,
              createMessage: this.makeCreator(cfg),
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

    // Metadata extraction needs a model provider -- the OneReach flow
    // contract covers space-assist only.
    const cfg = this.requireModelConfig('extract-metadata');

    const modality = input.imageBase64
      ? 'image'
      : input.pdfBase64
        ? 'pdf'
        : input.text
          ? 'text'
          : 'hints';
    this.log('info', 'extract-metadata start', {
      provider: cfg.provider,
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
        provider: cfg.provider,
        tags: result.tags.length,
        topics: result.topics.length,
      });
      return result;
    } catch (err) {
      if (err instanceof AiError) {
        this.log('warn', 'extract-metadata rejected', { provider: cfg.provider, code: err.code });
        throw err;
      }
      this.log('error', 'extract-metadata unexpected', {
        provider: cfg.provider,
        error: (err as Error).message,
      });
      throw new AiError({
        code: AI_ERROR_CODES.PROVIDER_ERROR,
        message: `AI provider error: ${(err as Error).message}`,
        context: { provider: cfg.provider, op: 'extract-metadata' },
        remediation: 'Try again, or add metadata manually.',
        cause: err,
      });
    }
  }

  /**
   * Shortlist the Spaces an item belongs in. Needs a model provider.
   */
  async suggestSpaces(input: SuggestSpacesInput): Promise<SuggestSpacesResult> {
    const candidates = Array.isArray(input?.spaces) ? input.spaces : [];
    const title = typeof input?.item?.title === 'string' ? input.item.title.trim() : '';
    // No candidates (already in every Space) or nothing to reason about
    // -> an empty shortlist is the correct answer, not an error. The
    // picker still lists every Space.
    if (candidates.length === 0 || title.length === 0) return { suggestions: [] };
    const cfg = this.requireModelConfig('suggest-spaces');
    this.log('info', 'suggest-spaces start', {
      provider: cfg.provider,
      model: cfg.model,
      candidates: candidates.length,
    });
    try {
      const result = await callClaudeSuggestSpaces(input.item, candidates, {
        model: cfg.model,
        createMessage: this.makeCreator(cfg),
      });
      this.log('info', 'suggest-spaces ok', { count: result.suggestions.length });
      return result;
    } catch (err) {
      this.log('warn', 'suggest-spaces failed', { error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Convert an agent definition (pasted text, or the contents of a
   * pasted URL) into OKF. Needs a model provider. When `isUrl`, the URL
   * contents are fetched first (https only + basic SSRF guard).
   */
  async convertToOkf(input: OkfConversionInput): Promise<OkfConversionResult> {
    const source = typeof input?.source === 'string' ? input.source.trim() : '';
    if (source.length === 0) {
      throw new AiError({
        code: AI_ERROR_CODES.INVALID_INPUT,
        message: 'A URL or agent definition text is required to convert to OKF.',
        context: { op: 'convert-okf' },
        remediation: 'Paste a URL or the agent definition text, then try again.',
      });
    }
    const cfg = this.requireModelConfig('convert-okf');
    const isUrl = input.isUrl === true;
    const text = isUrl ? await this.fetchUrlForOkf(source) : source;
    this.log('info', 'convert-okf start', {
      provider: cfg.provider,
      model: cfg.model,
      isUrl,
      sourceLen: text.length,
    });
    try {
      const result = await callClaudeOkf(text, {
        model: cfg.model,
        createMessage: this.makeCreator(cfg),
      });
      this.log('info', 'convert-okf ok', {
        provider: cfg.provider,
        agentType: result.agentType,
        okfLen: result.okf.length,
      });
      return result;
    } catch (err) {
      if (err instanceof AiError) {
        this.log('warn', 'convert-okf rejected', { provider: cfg.provider, code: err.code });
        throw err;
      }
      this.log('error', 'convert-okf unexpected', {
        provider: cfg.provider,
        error: (err as Error).message,
      });
      throw new AiError({
        code: AI_ERROR_CODES.PROVIDER_ERROR,
        message: `AI provider error: ${(err as Error).message}`,
        context: { provider: cfg.provider, op: 'convert-okf' },
        remediation: 'Try again, or paste the OKF definition manually.',
        cause: err,
      });
    }
  }

  /**
   * Fetch a URL's contents for OKF conversion. https only + a basic
   * SSRF guard (block localhost / private / link-local hosts). NOTE:
   * this is a host-string check, not a DNS-resolution check, so it does
   * not defend against DNS rebinding — adequate for a user pasting their
   * own agent URL, not for untrusted input.
   */
  private async fetchUrlForOkf(rawUrl: string): Promise<string> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new AiError({
        code: AI_ERROR_CODES.INVALID_INPUT,
        message: 'That does not look like a valid URL.',
        context: { op: 'convert-okf' },
        remediation: 'Paste a full https:// URL, or paste the definition text instead.',
      });
    }
    if (parsed.protocol !== 'https:') {
      throw new AiError({
        code: AI_ERROR_CODES.INVALID_INPUT,
        message: 'Only https URLs are supported for agent sources.',
        context: { op: 'convert-okf' },
        remediation: 'Use an https:// URL, or paste the definition text.',
      });
    }
    if (isBlockedOkfHost(parsed.hostname)) {
      throw new AiError({
        code: AI_ERROR_CODES.INVALID_INPUT,
        message: 'That URL host is not allowed.',
        context: { op: 'convert-okf' },
        remediation: 'Paste a public https URL, or paste the definition text.',
      });
    }
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await this.fetchImpl(parsed.toString(), { redirect: 'follow' });
    } catch (err) {
      throw new AiError({
        code: AI_ERROR_CODES.NETWORK,
        message: `Could not fetch the URL: ${(err as Error).message}`,
        context: { op: 'convert-okf' },
        remediation: 'Check the URL / your network, or paste the definition text.',
        cause: err,
      });
    }
    if (!res.ok) {
      throw new AiError({
        code: AI_ERROR_CODES.PROVIDER_ERROR,
        message: `The URL returned HTTP ${res.status}.`,
        context: { op: 'convert-okf' },
        remediation: 'Check the URL, or paste the definition text.',
      });
    }
    return res.text();
  }

  async chat(input: AiChatInput): Promise<AiChatResult> {
    assertValidChatInput(input);
    const cfg = this.requireModelConfig('chat');
    this.log('info', 'chat start', {
      provider: cfg.provider,
      model: profileToModel(input.profile, cfg.model),
      messages: Array.isArray(input.messages) ? input.messages.length : 0,
      feature: typeof input.feature === 'string' ? input.feature : undefined,
    });
    try {
      const client = this.makeChatClient(cfg);
      const result = await runClaudeChat(input, {
        config: cfg,
        fetchImpl: this.fetchImpl,
        ...(client !== undefined ? { client } : {}),
      });
      this.log('info', 'chat ok', {
        provider: cfg.provider,
        model: result.model,
        outputTokens: result.usage.outputTokens,
      });
      return result;
    } catch (err) {
      throw this.normalizeChatError(err, 'chat', cfg.provider);
    }
  }

  async chatStream(
    input: AiChatInput,
    onDelta: (delta: string) => void
  ): Promise<AiChatResult> {
    assertValidChatInput(input);
    const cfg = this.requireModelConfig('chat-stream');
    this.log('info', 'chat-stream start', {
      provider: cfg.provider,
      model: profileToModel(input.profile, cfg.model),
      messages: Array.isArray(input.messages) ? input.messages.length : 0,
      feature: typeof input.feature === 'string' ? input.feature : undefined,
    });
    try {
      const client = this.makeChatClient(cfg);
      const result = await runClaudeChatStream(input, {
        config: cfg,
        onDelta,
        fetchImpl: this.fetchImpl,
        ...(client !== undefined ? { client } : {}),
      });
      this.log('info', 'chat-stream ok', {
        provider: cfg.provider,
        model: result.model,
        outputTokens: result.usage.outputTokens,
      });
      return result;
    } catch (err) {
      throw this.normalizeChatError(err, 'chat-stream', cfg.provider);
    }
  }

  /**
   * Everything except `spaceAssist` needs a MODEL provider (Claude or
   * OpenAI) — the OneReach flow contract covers `spaceAssist` only.
   * Throws `AI_NOT_CONFIGURED` otherwise.
   */
  private requireModelConfig(op: string): KeyedModelConfig {
    const cfg = this.loadConfig();
    if (cfg === null || cfg.provider === 'onereach-flow') {
      throw new AiError({
        code: AI_ERROR_CODES.NOT_CONFIGURED,
        message: 'No AI model provider is configured.',
        context: { op, provider: cfg?.provider ?? null },
        remediation: NOT_CONFIGURED_REMEDIATION,
      });
    }
    return cfg;
  }

  /** Pass AiErrors through; wrap anything else as a provider error. */
  private normalizeChatError(err: unknown, op: string, provider: string): AiError {
    if (err instanceof AiError) {
      this.log('warn', `${op} rejected`, { provider, code: err.code });
      return err;
    }
    this.log('error', `${op} unexpected`, { provider, error: (err as Error).message });
    return new AiError({
      code: AI_ERROR_CODES.PROVIDER_ERROR,
      message: `AI provider error: ${(err as Error).message}`,
      context: { provider, op },
      remediation: 'Try again in a moment.',
      cause: err,
    });
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

/**
 * Basic SSRF guard for the OKF URL fetch: block localhost, loopback,
 * private, and link-local hosts (incl. the 169.254.169.254 cloud
 * metadata endpoint). Host-string check only — not DNS-resolution
 * aware.
 */
function isBlockedOkfHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h.length === 0) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '0.0.0.0' || h === '127.0.0.1' || h === '::1' || h.startsWith('127.')) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // link-local + cloud metadata
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:')) return true; // IPv6 ULA/link-local
  return false;
}
