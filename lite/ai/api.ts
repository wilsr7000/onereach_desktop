/**
 * AI module -- PUBLIC API.
 *
 * The only file other lite modules should import from in this module.
 * Per ADR-019 / Rule 11 in `lite/LITE-RULES.md`, cross-module imports go
 * through `<module>/api.ts` -- never reach into `service.ts`, `client.ts`,
 * or `config.ts`.
 *
 * This file is deliberately electron-free so the conformance unit test
 * can import it under Node without an electron mock. The userData config
 * directory is injected by the main-process wiring via
 * {@link setAiConfigDir} (called from `ai/main.ts` `initAi`).
 */

import { AiService } from './service.js';
import { loadAiConfigFromDisk } from './config.js';
import { getLoggingApi } from '../logging/api.js';
import { AiError, AI_ERROR_CODES } from './errors.js';
import { AnthropicKeyStore } from './key-store.js';
import type {
  AiStatus,
  SpaceAssistInput,
  SpaceAssistResult,
  AssetMetadataInput,
  AssetMetadataResult,
  OkfConversionInput,
  SuggestSpacesInput,
  SuggestSpacesResult,
  OkfConversionResult,
} from './types.js';
import type { AiChatInput, AiChatResult } from './chat.js';

// Re-export the public types + error surface consumers need.
export type {
  AiProvider,
  AiStatus,
  SpaceAssistInput,
  SpaceAssistResult,
  AssetMetadataInput,
  AssetMetadataResult,
  OkfConversionInput,
  OkfConversionResult,
  SuggestSpacesInput,
  SuggestSpacesResult,
  SpaceSuggestion,
} from './types.js';
export type { AiChatInput, AiChatResult, AiChatMessage, AiChatProfile } from './chat.js';
export { AI_MODULE_VERSION } from './types.js';
export type { AiErrorCode, AiErrorOptions } from './errors.js';
export { AiError, AI_ERROR_CODES };
export { LiteError, isLiteError } from '../errors.js';

/**
 * Public surface of the AI module. The IPC layer (`ai/main.ts`) wraps
 * these in the standard `{ ok, value | error }` envelope; the renderer
 * sees that envelope via `window.lite.ai`.
 */
export interface AiApi {
  /** Whether an AI provider is configured (and which one). Carries no secrets. */
  getStatus(): Promise<AiStatus>;
  /**
   * Draft a polished description + 3-5 high-level objectives from a
   * short, rough purpose. Throws `AiError` (`AI_NOT_CONFIGURED`,
   * `AI_INVALID_INPUT`, `AI_NETWORK`, `AI_AUTH_REJECTED`,
   * `AI_RATE_LIMITED`, `AI_PROVIDER_ERROR`, or `AI_BAD_RESPONSE`).
   */
  spaceAssist(input: SpaceAssistInput): Promise<SpaceAssistResult>;

  /**
   * Extract structured metadata (summary, tags, topics, entities, ...)
   * for a single asset via Claude 4.8. Multimodal: a text body, an image
   * (vision), or a PDF document. **Claude-only** — throws
   * `AI_NOT_CONFIGURED` when the active provider isn't Claude (the
   * OneReach flow contract only covers `spaceAssist`).
   *
   * Throws `AiError` (`AI_NOT_CONFIGURED`, `AI_INVALID_INPUT`,
   * `AI_NETWORK`, `AI_AUTH_REJECTED`, `AI_RATE_LIMITED`,
   * `AI_PROVIDER_ERROR`, `AI_BAD_RESPONSE`).
   */
  extractAssetMetadata(input: AssetMetadataInput): Promise<AssetMetadataResult>;

  /**
   * Convert an agent definition (pasted text, or the contents of a
   * pasted URL) into OKF (structured YAML/MD text) via Claude, and
   * classify its `agentType` + suggest a `name`. Powers "add an agent"
   * in Spaces. **Claude-only** — throws `AI_NOT_CONFIGURED` when the
   * active provider isn't Claude. When `isUrl`, the URL is fetched first
   * (https only + basic SSRF guard).
   *
   * Throws `AiError` (`AI_NOT_CONFIGURED`, `AI_INVALID_INPUT`,
   * `AI_NETWORK`, `AI_AUTH_REJECTED`, `AI_RATE_LIMITED`,
   * `AI_PROVIDER_ERROR`, `AI_BAD_RESPONSE`).
   */
  convertToOkf(input: OkfConversionInput): Promise<OkfConversionResult>;

  /**
   * Shortlist the Spaces an item belongs in, each with a one-line
   * reason, by reading the Space names + descriptions. Returns an
   * empty list when nothing fits — the caller still shows the full
   * Space picker, so this is an accelerant, never a gate.
   */
  suggestSpaces(input: SuggestSpacesInput): Promise<SuggestSpacesResult>;

  /**
   * Generic single-shot Claude chat. Powers the embedded WISER Playbooks
   * `window.ai.chat` bridge so the hosted app runs on the Onereach Claude
   * key without the key ever leaving the main process. **Claude-only** —
   * throws `AI_NOT_CONFIGURED` when the active provider isn't Claude.
   *
   * Throws `AiError` (`AI_NOT_CONFIGURED`, `AI_INVALID_INPUT`,
   * `AI_NETWORK`, `AI_AUTH_REJECTED`, `AI_RATE_LIMITED`,
   * `AI_PROVIDER_ERROR`).
   */
  chat(input: AiChatInput): Promise<AiChatResult>;

  /**
   * Streaming variant of {@link AiApi.chat}: invokes `onDelta` for each
   * text chunk as it arrives and resolves with the full result. The IPC
   * layer forwards each delta to the WISER renderer via the
   * `window.ai.onStreamChunk` callback. Same error surface as `chat`.
   */
  chatStream(input: AiChatInput, onDelta: (delta: string) => void): Promise<AiChatResult>;
}

let _instance: AiApi | null = null;
let _configDir: string | null = null;
let _accountIdProvider: (() => string | null) | null = null;
/**
 * Cached Anthropic key read from the OS keychain. The config loader is
 * synchronous but keytar is async, so the key is read once at boot
 * (`refreshAiKeychainKey`) + after each mutation and cached here. The
 * value never crosses the bridge or appears in a log.
 */
let _keychainKey: string | null = null;
let _keyStore: AnthropicKeyStore | null = null;

/**
 * Point the default config loader at the app's userData directory so it
 * can read `ai-config.json`. Called by `initAi` in the main process.
 * Kept separate from the electron import surface so unit tests don't
 * need an electron mock to exercise `getAiApi()`.
 */
export function setAiConfigDir(dir: string | null): void {
  _configDir = dir;
}

/**
 * Provide the logged-in OneReach accountId resolver so the OneReach flow
 * path can mint a FLOW token from the session. Injected by `initAi`
 * (which reads `getAuthApi()`), keeping this file electron- and
 * auth-free for the conformance test.
 */
export function setAiAccountIdProvider(fn: (() => string | null) | null): void {
  _accountIdProvider = fn;
}

export function getAiApi(): AiApi {
  if (_instance === null) {
    _instance = buildDefaultApi();
  }
  return _instance;
}

export function _resetAiApiForTesting(): void {
  _instance = null;
  _keychainKey = null;
  _keyStore = null;
}

export function _setAiApiForTesting(api: AiApi): void {
  _instance = api;
}

// ─── Anthropic key (OS keychain) ─────────────────────────────────────────
//
// Lazy keytar binding: the store is built only when a key op actually
// runs, so importing this file under Node (the conformance test) never
// requires `keytar`. Tests inject a fake via `_setAiKeyStoreForTesting`.

/** Lazily build (or return) the keychain-backed key store. */
function getKeyStore(): AnthropicKeyStore {
  if (_keyStore === null) {
    _keyStore = new AnthropicKeyStore();
  }
  return _keyStore;
}

/** @internal -- inject a fake key store (avoids real keytar in tests). */
export function _setAiKeyStoreForTesting(store: AnthropicKeyStore): void {
  _keyStore = store;
}

/**
 * Re-read the Anthropic key from the keychain into the synchronous
 * cache the config loader uses. Called by `initAi` at boot and after
 * every key mutation. Never throws (a Keychain failure just leaves the
 * cache null, falling back to env / ai-config.json).
 */
export async function refreshAiKeychainKey(): Promise<void> {
  try {
    _keychainKey = await getKeyStore().getKey();
  } catch {
    _keychainKey = null;
  }
}

/** Persist the Anthropic key to the keychain + refresh the cache. */
export async function saveAiKey(key: string): Promise<void> {
  await getKeyStore().saveKey(key);
  _keychainKey = key.trim();
}

/** Whether an Anthropic key is configured in the keychain. */
export async function hasAiKey(): Promise<boolean> {
  return getKeyStore().hasKey();
}

/** Remove the Anthropic key from the keychain + clear the cache. */
export async function deleteAiKey(): Promise<void> {
  await getKeyStore().deleteKey();
  _keychainKey = null;
}

function buildDefaultApi(): AiApi {
  return new AiService({
    loadConfig: () => loadAiConfigFromDisk(_configDir, _keychainKey),
    fetchImpl: globalThis.fetch.bind(globalThis),
    accountId: () => (_accountIdProvider !== null ? _accountIdProvider() : null),
    logger: (level, message, data) => {
      getLoggingApi()[level]('ai', message, data);
    },
  });
}
