/**
 * AI main-process orchestration.
 *
 * Owns:
 *   - IPC handlers for `lite:ai:status` + `lite:ai:space-assist`
 *   - Pointing the config loader at the userData dir (so it can read
 *     ai-config.json) via `setAiConfigDir`
 *
 * Per ADR-019 / Rule 11, this module is the boundary between Electron
 * IPC and the typed `AiApi`. Renderers never see `AiService` directly,
 * and the API key / flow token never cross the bridge -- the renderer
 * only ever sends a purpose string and receives `{ description,
 * objectives }` or a structured error envelope.
 *
 * Per ADR-030, every handler emits an instant `ai.ipc.<verb>` event on
 * entry so renderer-driven activity is observable in `/logs`.
 */

import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  getAiApi,
  AiError,
  AI_ERROR_CODES,
  setAiConfigDir,
  setAiAccountIdProvider,
  refreshAiKeychainKey,
  saveAiKey,
  hasAiKey,
  deleteAiKey,
  _resetAiApiForTesting,
  type AiStatus,
  type SpaceAssistResult,
  type AiChatInput,
  type AiChatResult,
  type AiChatMessage,
  type AiChatProfile,
} from './api.js';
import { enrichAsset, type EnrichResult } from './enrich.js';
import { AI_EVENTS } from './events.js';
import { WISER_AI_CHANNELS } from './wiser-bridge-channels.js';
import { getAuthApi } from '../auth/api.js';
import { getLoggingApi } from '../logging/api.js';

// All channels prefixed `lite:ai:` per Rule 3.
export const AI_IPC = {
  STATUS: 'lite:ai:status',
  SPACE_ASSIST: 'lite:ai:space-assist',
  ENRICH_ASSET: 'lite:ai:enrich-asset',
  KEY_SAVE: 'lite:ai:key-save',
  KEY_HAS: 'lite:ai:key-has',
  KEY_DELETE: 'lite:ai:key-delete',
  // Generic chat for the embedded WISER Playbooks `window.ai` bridge.
  CHAT: WISER_AI_CHANNELS.CHAT,
  CHAT_STREAM: WISER_AI_CHANNELS.CHAT_STREAM,
} as const;

/** Monotonic id for streaming chat requests (per main-process session). */
let chatStreamSeq = 0;

/**
 * Coerce a renderer-supplied chat payload into a typed {@link AiChatInput}.
 * Defensive: the WISER window is a hosted page, so every field is validated
 * / defaulted rather than trusted.
 */
function parseChatInput(payload: unknown): AiChatInput {
  const p = (payload ?? {}) as Record<string, unknown>;
  const rawMessages = Array.isArray(p['messages']) ? (p['messages'] as unknown[]) : [];
  const messages: AiChatMessage[] = rawMessages.map((m) => {
    const mm = (m ?? {}) as Record<string, unknown>;
    return {
      role: mm['role'] === 'assistant' ? 'assistant' : 'user',
      content: typeof mm['content'] === 'string' ? mm['content'] : '',
    };
  });
  const profile = typeof p['profile'] === 'string' ? (p['profile'] as AiChatProfile) : undefined;
  return {
    ...(profile !== undefined ? { profile } : {}),
    ...(typeof p['system'] === 'string' ? { system: p['system'] as string } : {}),
    messages,
    ...(typeof p['maxTokens'] === 'number' ? { maxTokens: p['maxTokens'] as number } : {}),
    ...(typeof p['temperature'] === 'number' ? { temperature: p['temperature'] as number } : {}),
    ...(typeof p['jsonMode'] === 'boolean' ? { jsonMode: p['jsonMode'] as boolean } : {}),
    ...(typeof p['feature'] === 'string' ? { feature: p['feature'] as string } : {}),
  };
}

interface AiIpcError {
  code: string;
  message: string;
  remediation?: string;
  context?: Record<string, unknown>;
}
type AiIpcResult<T> = { ok: true; value: T } | { ok: false; error: AiIpcError };

function serializeAiError(err: unknown): AiIpcError {
  if (err instanceof AiError) {
    const j = err.toJSON();
    return { code: j.code, message: j.message, remediation: j.remediation, context: j.context };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: 'AI_PROVIDER_ERROR',
    message,
    remediation: 'Try again, or fill in the details manually.',
  };
}

export interface InitAiOptions {
  logger?: {
    info: (message: string, data?: unknown) => void;
    warn: (message: string, data?: unknown) => void;
    error: (message: string, data?: unknown) => void;
  };
}

export interface AiHandle {
  /** Tear down IPC handlers. Idempotent. */
  teardown(): void;
}

let registered = false;

/**
 * Register the AI IPC handlers and point the config loader at the
 * userData dir. Safe to call multiple times -- subsequent calls are
 * no-ops.
 */
export function initAi(opts: InitAiOptions = {}): AiHandle {
  const log = opts.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  if (registered) {
    return { teardown: teardownInternal };
  }

  // Let the config loader read {userData}/ai-config.json. Guarded so the
  // module still loads in a non-electron test harness.
  try {
    setAiConfigDir(app.getPath('userData'));
  } catch {
    setAiConfigDir(null);
  }

  // The OneReach flow path mints its FLOW token from the logged-in
  // session -- resolve the accountId the same way the KV transport does.
  setAiAccountIdProvider(() => getAuthApi().getSession('edison')?.accountId ?? null);

  // Populate the synchronous keychain-key cache from the OS keychain.
  // Fire-and-forget: a Keychain failure just leaves the cache null and
  // the config loader falls back to env / ai-config.json.
  void refreshAiKeychainKey();

  const api = getAiApi();

  ipcMain.handle(AI_IPC.STATUS, async (): Promise<AiIpcResult<AiStatus>> => {
    getLoggingApi().event(AI_EVENTS.IPC_STATUS);
    try {
      return { ok: true, value: await api.getStatus() };
    } catch (err) {
      return { ok: false, error: serializeAiError(err) };
    }
  });

  ipcMain.handle(
    AI_IPC.SPACE_ASSIST,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { purpose?: unknown; name?: unknown }
    ): Promise<AiIpcResult<SpaceAssistResult>> => {
      getLoggingApi().event(AI_EVENTS.IPC_SPACE_ASSIST);
      try {
        const purpose = typeof payload?.purpose === 'string' ? payload.purpose : '';
        const name = typeof payload?.name === 'string' ? payload.name : undefined;
        const value = await api.spaceAssist(name !== undefined ? { purpose, name } : { purpose });
        log.info('space-assist ok', { objectives: value.objectives.length });
        return { ok: true, value };
      } catch (err) {
        const code = err instanceof AiError ? err.code : 'AI_PROVIDER_ERROR';
        log.warn('space-assist rejected', { code });
        return { ok: false, error: serializeAiError(err) };
      }
    }
  );

  // Enrich one asset: Claude extracts metadata + we persist it under
  // `ai_*` keys. The renderer fires this on the "Auto-fill metadata"
  // button and (for eligible kinds) automatically on asset create.
  ipcMain.handle(
    AI_IPC.ENRICH_ASSET,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { assetId?: unknown }
    ): Promise<AiIpcResult<EnrichResult>> => {
      getLoggingApi().event(AI_EVENTS.IPC_ENRICH_ASSET);
      try {
        const assetId = typeof payload?.assetId === 'string' ? payload.assetId : '';
        const value = await enrichAsset(assetId);
        log.info('enrich-asset ok', {
          modality: value.modality,
          tags: value.metadata.tags.length,
        });
        return { ok: true, value };
      } catch (err) {
        const code = err instanceof AiError ? err.code : 'AI_PROVIDER_ERROR';
        log.warn('enrich-asset rejected', { code });
        return { ok: false, error: serializeAiError(err) };
      }
    }
  );

  // ─── Anthropic key (OS keychain). Value is write-only across IPC. ──────
  ipcMain.handle(
    AI_IPC.KEY_SAVE,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { key?: unknown }
    ): Promise<AiIpcResult<{ ok: true }>> => {
      getLoggingApi().event(AI_EVENTS.IPC_KEY_SAVE);
      try {
        const key = typeof payload?.key === 'string' ? payload.key : '';
        if (key.trim().length === 0) {
          throw new AiError({
            code: AI_ERROR_CODES.INVALID_INPUT,
            message: 'An Anthropic API key is required.',
            context: { op: 'key-save' },
            remediation: 'Paste your key (starts with `sk-ant-`) and save.',
          });
        }
        await saveAiKey(key);
        log.info('ai key saved', {});
        return { ok: true, value: { ok: true } };
      } catch (err) {
        return { ok: false, error: serializeAiError(err) };
      }
    }
  );

  ipcMain.handle(AI_IPC.KEY_HAS, async (): Promise<AiIpcResult<{ hasKey: boolean }>> => {
    getLoggingApi().event(AI_EVENTS.IPC_KEY_HAS);
    try {
      return { ok: true, value: { hasKey: await hasAiKey() } };
    } catch (err) {
      return { ok: false, error: serializeAiError(err) };
    }
  });

  ipcMain.handle(AI_IPC.KEY_DELETE, async (): Promise<AiIpcResult<{ ok: true }>> => {
    getLoggingApi().event(AI_EVENTS.IPC_KEY_DELETE);
    try {
      await deleteAiKey();
      log.info('ai key deleted', {});
      return { ok: true, value: { ok: true } };
    } catch (err) {
      return { ok: false, error: serializeAiError(err) };
    }
  });

  // ─── Generic chat (embedded WISER Playbooks `window.ai` bridge) ───────
  //
  // The key never crosses to the renderer: the WISER window's preload
  // exposes only chat/chatStream, and the Claude call is made here in the
  // main process with the keychain key. See `ai/wiser-bridge-channels.ts`
  // and `preload-lite-wiser.ts`.
  ipcMain.handle(
    AI_IPC.CHAT,
    async (_event: IpcMainInvokeEvent, payload?: unknown): Promise<AiIpcResult<AiChatResult>> => {
      getLoggingApi().event(AI_EVENTS.IPC_CHAT);
      try {
        const value = await api.chat(parseChatInput(payload));
        log.info('chat ok', { model: value.model, outputTokens: value.usage.outputTokens });
        return { ok: true, value };
      } catch (err) {
        const code = err instanceof AiError ? err.code : 'AI_PROVIDER_ERROR';
        log.warn('chat rejected', { code });
        return { ok: false, error: serializeAiError(err) };
      }
    }
  );

  // Streaming chat: returns `{ requestId }` immediately, then pushes chunks
  // on CHAT_STREAM_CHUNK (each tagged with the requestId). The renderer
  // subscribes via `window.ai.onStreamChunk(requestId, ...)` right after
  // this resolves; the preload buffers any chunk that races ahead of the
  // subscription so none are lost.
  ipcMain.handle(
    AI_IPC.CHAT_STREAM,
    async (
      event: IpcMainInvokeEvent,
      payload?: unknown
    ): Promise<AiIpcResult<{ requestId: string }>> => {
      getLoggingApi().event(AI_EVENTS.IPC_CHAT_STREAM);
      let input: AiChatInput;
      try {
        input = parseChatInput(payload);
      } catch (err) {
        return { ok: false, error: serializeAiError(err) };
      }
      const requestId = `wiser-chat-${++chatStreamSeq}`;
      const sender = event.sender;
      const send = (chunk: Record<string, unknown>): void => {
        if (!sender.isDestroyed()) {
          sender.send(WISER_AI_CHANNELS.CHAT_STREAM_CHUNK, { requestId, ...chunk });
        }
      };
      void (async () => {
        try {
          const finalResult = await api.chatStream(input, (delta) => send({ delta, done: false }));
          send({ done: true, finalResult });
          log.info('chat-stream ok', {
            model: finalResult.model,
            outputTokens: finalResult.usage.outputTokens,
          });
        } catch (err) {
          const code = err instanceof AiError ? err.code : 'AI_PROVIDER_ERROR';
          log.warn('chat-stream rejected', { code });
          send({ done: true, error: serializeAiError(err) });
        }
      })();
      return { ok: true, value: { requestId } };
    }
  );

  registered = true;
  log.info('ai initialized', {});
  return { teardown: teardownInternal };
}

function teardownInternal(): void {
  if (!registered) return;
  try {
    for (const ch of Object.values(AI_IPC)) {
      ipcMain.removeHandler(ch);
    }
  } catch {
    // best-effort
  }
  registered = false;
}

/** @internal -- exposed for tests. */
export function _isAiRegisteredForTesting(): boolean {
  return registered;
}

/** @internal -- exposed for tests so they can re-init cleanly. */
export function _resetAiRegistrationForTesting(): void {
  teardownInternal();
  _resetAiApiForTesting();
}
