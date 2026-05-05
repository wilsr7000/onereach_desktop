/**
 * Lite AI service module -- PUBLIC API.
 *
 * The only file other lite modules should import from in this
 * module. Per ADR-019 / Rule 11, cross-module imports go through
 * `<module>/api.ts` -- never reach into `client.ts`,
 * `credentials.ts`, or any other internal file.
 *
 * v1 surface: TTS + chat completion via OpenAI. The provider is
 * abstracted via `CredentialsProvider` (mirrors ADR-033's Neon
 * pattern) so a future provider (Anthropic, gemini, local) plugs
 * in behind the same `AiApi` surface without consumer changes.
 *
 * Tests: `_setAiApiForTesting(stub)` to inject a custom
 * implementation, `_resetAiApiForTesting()` to clear the singleton.
 */

import { OpenAiClient } from './client.js';
import {
  KVAiCredentialsProvider,
  type AiCredentialsProvider,
} from './credentials.js';
import type {
  AiConfig,
  AiStatus,
  ChatRequest,
  ChatResponse,
  TtsRequest,
  TtsResponse,
  OpenAiTtsModel,
  OpenAiTtsVoice,
} from './types.js';
import { AiError, AI_ERROR_CODES, type AiErrorCode } from './errors.js';
import { getLoggingApi } from '../logging/api.js';
import type { EventRecord } from '../logging/events.js';
import { isAiEvent, AI_EVENTS, type AiEvent } from './events.js';

// ── Re-export public types ────────────────────────────────────────────────

export type {
  AiConfig,
  AiStatus,
  AiProvider,
  AiChatMessage,
  ChatRequest,
  ChatResponse,
  TtsRequest,
  TtsResponse,
  OpenAiTtsVoice,
  OpenAiTtsModel,
  OpenAiTtsFormat,
} from './types.js';
export { OPENAI_TTS_VOICES, AI_MODULE_VERSION } from './types.js';

export type { AiErrorCode, AiErrorOptions } from './errors.js';
export { AiError, AI_ERROR_CODES };

export type {
  AiEvent,
  AiEventName,
  AiTtsStartEvent,
  AiTtsFinishEvent,
  AiTtsFailEvent,
  AiChatStartEvent,
  AiChatFinishEvent,
  AiChatFailEvent,
  AiConfigureStartEvent,
  AiConfigureFinishEvent,
  AiConfigureFailEvent,
  AiIpcTtsEvent,
  AiIpcChatEvent,
  AiIpcStatusEvent,
  AiIpcConfigureEvent,
} from './events.js';
export { AI_EVENTS, isAiEvent } from './events.js';

export { LiteError, isLiteError } from '../errors.js';

// ── Public API ────────────────────────────────────────────────────────────

/**
 * The public surface of the Lite AI module.
 *
 * **Error contract**: every method throws `AiError` (extends
 * `LiteError`) on failure. Inspect `.code` to branch on
 * `AI_NOT_CONFIGURED`, `AI_RATE_LIMITED`, `AI_HTTP`, `AI_NETWORK`,
 * `AI_TIMEOUT`, `AI_BAD_INPUT`. `status()` does not throw -- it
 * returns the public configuration snapshot.
 */
export interface AiApi {
  /** Generate speech from text. Returns raw audio bytes + MIME. */
  tts(req: TtsRequest): Promise<TtsResponse>;
  /** Single-shot chat completion. */
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** Public status snapshot. NEVER includes the API key. */
  status(): Promise<AiStatus>;
  /**
   * Persist a partial config update. Pass `apiKey: ''` to clear it.
   * MAIN-PROCESS ONLY (renderer must use the Settings -> AI bridge).
   */
  configure(config: AiConfig): Promise<void>;
  /** Subscribe to typed AI events (ADR-032). Returns an unsubscribe. */
  onEvent(handler: (event: AiEvent) => void): () => void;
}

let _instance: AiApi | null = null;

export function getAiApi(): AiApi {
  if (_instance === null) {
    _instance = buildDefaultApi();
  }
  return _instance;
}

/** Reset the singleton (for tests). */
export function _resetAiApiForTesting(): void {
  _instance = null;
}

/** Override the singleton with a custom implementation (for tests). */
export function _setAiApiForTesting(api: AiApi): void {
  _instance = api;
}

/**
 * Build an `AiApi` from a custom `CredentialsProvider`. Used by the
 * test harness to inject `StaticAiCredentialsProvider`.
 */
export function buildAiApi(provider: AiCredentialsProvider): AiApi {
  const client = new OpenAiClient({ credentials: provider });
  return makeApi(provider, client);
}

// ── default implementation ────────────────────────────────────────────────

function buildDefaultApi(): AiApi {
  const provider = new KVAiCredentialsProvider();
  const client = new OpenAiClient({ credentials: provider });
  return makeApi(provider, client);
}

function makeApi(provider: AiCredentialsProvider, client: OpenAiClient): AiApi {
  return {
    tts: async (req) => {
      const span = getLoggingApi().start('ai.tts', {
        textLength: req.text?.length ?? 0,
        voice: req.voice ?? 'nova',
        model: req.model ?? 'tts-1',
      });
      try {
        const result = await client.tts(req);
        span.finish({ data: { textLength: req.text.length, bytes: result.audio.byteLength } });
        return result;
      } catch (err) {
        span.fail(err as Error);
        throw err;
      }
    },
    chat: async (req) => {
      const span = getLoggingApi().start('ai.chat', {
        messageCount: req.messages.length,
        model: req.model ?? 'gpt-4o-mini',
      });
      try {
        const result = await client.chat(req);
        span.finish({ data: { totalTokens: result.usage.totalTokens } });
        return result;
      } catch (err) {
        span.fail(err as Error);
        throw err;
      }
    },
    status: async () => {
      const pub = await provider.readPublic();
      return {
        provider: 'openai',
        hasApiKey: pub.hasApiKey,
        defaultTtsVoice: pub.defaultTtsVoice as OpenAiTtsVoice,
        defaultTtsModel: pub.defaultTtsModel as OpenAiTtsModel,
        defaultChatModel: pub.defaultChatModel,
      };
    },
    configure: async (config) => {
      const span = getLoggingApi().start('ai.configure', {
        fields: configFieldNames(config),
      });
      try {
        await provider.write({
          ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
          ...(config.defaultTtsVoice !== undefined
            ? { defaultTtsVoice: config.defaultTtsVoice }
            : {}),
          ...(config.defaultTtsModel !== undefined
            ? { defaultTtsModel: config.defaultTtsModel }
            : {}),
          ...(config.defaultChatModel !== undefined
            ? { defaultChatModel: config.defaultChatModel }
            : {}),
        });
        span.finish();
      } catch (err) {
        span.fail(err as Error);
        throw err;
      }
    },
    onEvent: (handler) =>
      getLoggingApi().onEvent('ai.*', (ev: EventRecord) => {
        if (isAiEvent(ev)) {
          handler(ev as unknown as AiEvent);
        }
      }),
  };
}

function configFieldNames(c: AiConfig): string[] {
  const out: string[] = [];
  if (c.apiKey !== undefined) out.push('apiKey');
  if (c.defaultTtsVoice !== undefined) out.push('defaultTtsVoice');
  if (c.defaultTtsModel !== undefined) out.push('defaultTtsModel');
  if (c.defaultChatModel !== undefined) out.push('defaultChatModel');
  return out;
}

// Touch unused imports so dep-cruiser doesn't flag them.
void AI_EVENTS;
void AI_ERROR_CODES;
type _AiErrorCodeUnused = AiErrorCode;
void (null as unknown as _AiErrorCodeUnused);
