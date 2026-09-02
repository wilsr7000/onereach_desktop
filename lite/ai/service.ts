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
import { callClaudeSuggestSpaces } from './suggest-spaces.js';
import type { SuggestSpacesInput, SuggestSpacesResult } from './types.js';
import type { ClaudeConfig, ResolvedAiConfig } from './config.js';
import {
  callClaude,
  callOneReachFlow,
  makeClaudeMessageCreator,
  mintFlowAuthHeader,
  type ClaudeMessageCreator,
} from './client.js';
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
  /** Test seam: build the Claude chat client (chat/chatStream). Defaults to the SDK one. */
  makeClaudeChatClient?: (config: ClaudeConfig) => ClaudeChatClient;
}

export class AiService {
  private readonly loadConfig: AiServiceDeps['loadConfig'];
  private readonly fetchImpl: typeof fetch;
  private readonly accountId: () => string | null;
  private readonly makeCreator: (config: ClaudeConfig) => ClaudeMessageCreator;
  private readonly makeChatClient: ((config: ClaudeConfig) => ClaudeChatClient) | undefined;
  private readonly log: NonNullable<AiServiceDeps['logger']>;

  constructor(deps: AiServiceDeps) {
    this.loadConfig = deps.loadConfig;
    this.fetchImpl = deps.fetchImpl;
    this.accountId = deps.accountId;
    this.makeCreator = deps.makeClaudeMessageCreator ?? makeClaudeMessageCreator;
    this.makeChatClient = deps.makeClaudeChatClient;
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
          'Add your Claude API key in Settings → AI. It takes a minute — the walkthrough there shows where to get one.',
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
          'Add your Claude API key in Settings → AI. It takes a minute — the walkthrough there shows where to get one.',
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
   * Convert an agent definition (pasted text, or the contents of a
   * pasted URL) into OKF via Claude. Claude-only. When `isUrl`, the URL
   * contents are fetched first (https only + basic SSRF guard).
   */
  async suggestSpaces(input: SuggestSpacesInput): Promise<SuggestSpacesResult> {
    const candidates = Array.isArray(input?.spaces) ? input.spaces : [];
    const title = typeof input?.item?.title === 'string' ? input.item.title.trim() : '';
    // No candidates (already in every Space) or nothing to reason about
    // -> an empty shortlist is the correct answer, not an error. The
    // picker still lists every Space.
    if (candidates.length === 0 || title.length === 0) return { suggestions: [] };
    const cfg = this.requireClaudeConfig('suggest-spaces');
    this.log('info', 'suggest-spaces start', {
      provider: 'claude',
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
    const cfg = this.requireClaudeConfig('convert-okf');
    const isUrl = input.isUrl === true;
    const text = isUrl ? await this.fetchUrlForOkf(source) : source;
    this.log('info', 'convert-okf start', {
      provider: 'claude',
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
        provider: 'claude',
        agentType: result.agentType,
        okfLen: result.okf.length,
      });
      return result;
    } catch (err) {
      if (err instanceof AiError) {
        this.log('warn', 'convert-okf rejected', { provider: 'claude', code: err.code });
        throw err;
      }
      this.log('error', 'convert-okf unexpected', {
        provider: 'claude',
        error: (err as Error).message,
      });
      throw new AiError({
        code: AI_ERROR_CODES.PROVIDER_ERROR,
        message: `AI provider error: ${(err as Error).message}`,
        context: { provider: 'claude', op: 'convert-okf' },
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
    const cfg = this.requireClaudeConfig('chat');
    this.log('info', 'chat start', {
      provider: 'claude',
      model: profileToModel(input.profile, cfg.model),
      messages: Array.isArray(input.messages) ? input.messages.length : 0,
      feature: typeof input.feature === 'string' ? input.feature : undefined,
    });
    try {
      const result = await runClaudeChat(input, {
        config: cfg,
        ...(this.makeChatClient !== undefined ? { client: this.makeChatClient(cfg) } : {}),
      });
      this.log('info', 'chat ok', {
        provider: 'claude',
        model: result.model,
        outputTokens: result.usage.outputTokens,
      });
      return result;
    } catch (err) {
      throw this.normalizeChatError(err, 'chat');
    }
  }

  async chatStream(
    input: AiChatInput,
    onDelta: (delta: string) => void
  ): Promise<AiChatResult> {
    assertValidChatInput(input);
    const cfg = this.requireClaudeConfig('chat-stream');
    this.log('info', 'chat-stream start', {
      provider: 'claude',
      model: profileToModel(input.profile, cfg.model),
      messages: Array.isArray(input.messages) ? input.messages.length : 0,
      feature: typeof input.feature === 'string' ? input.feature : undefined,
    });
    try {
      const result = await runClaudeChatStream(input, {
        config: cfg,
        onDelta,
        ...(this.makeChatClient !== undefined ? { client: this.makeChatClient(cfg) } : {}),
      });
      this.log('info', 'chat-stream ok', {
        provider: 'claude',
        model: result.model,
        outputTokens: result.usage.outputTokens,
      });
      return result;
    } catch (err) {
      throw this.normalizeChatError(err, 'chat-stream');
    }
  }

  /**
   * Chat is Claude-only (the OneReach flow contract covers `spaceAssist`
   * only). Require an active Claude config or throw `AI_NOT_CONFIGURED`.
   */
  private requireClaudeConfig(op: string): ClaudeConfig {
    const cfg = this.loadConfig();
    if (cfg === null || cfg.provider !== 'claude') {
      throw new AiError({
        code: AI_ERROR_CODES.NOT_CONFIGURED,
        message: 'Claude is not configured.',
        context: { op, provider: cfg?.provider ?? null },
        remediation: 'Open Settings -> AI and paste your Anthropic API key (or set ANTHROPIC_API_KEY).',
      });
    }
    return cfg;
  }

  /** Pass AiErrors through; wrap anything else as a provider error. */
  private normalizeChatError(err: unknown, op: string): AiError {
    if (err instanceof AiError) {
      this.log('warn', `${op} rejected`, { provider: 'claude', code: err.code });
      return err;
    }
    this.log('error', `${op} unexpected`, { provider: 'claude', error: (err as Error).message });
    return new AiError({
      code: AI_ERROR_CODES.PROVIDER_ERROR,
      message: `AI provider error: ${(err as Error).message}`,
      context: { provider: 'claude', op },
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
