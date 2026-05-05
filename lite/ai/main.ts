/**
 * Lite AI service main-process orchestration.
 *
 * Owns:
 *   - IPC handlers for `lite:ai:tts / chat / status / configure`
 *   - Wiring the singleton `AiApi`
 *
 * Per ADR-019 / Rule 11, this module is the boundary between
 * Electron IPC and the typed `AiApi`. Per ADR-030, every handler
 * emits an instant `ai.ipc.<verb>` event on entry.
 *
 * Renderer-facing payloads use base64 for binary audio (IPC can't
 * cleanly transport `Uint8Array` across the boundary on all
 * Electron versions).
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  getAiApi,
  AiError,
  type AiStatus,
  type AiConfig,
  type ChatRequest,
  type ChatResponse,
  type TtsRequest,
} from './api.js';
import { AI_EVENTS } from './events.js';
import { getLoggingApi } from '../logging/api.js';

export const AI_IPC = {
  TTS: 'lite:ai:tts',
  CHAT: 'lite:ai:chat',
  STATUS: 'lite:ai:status',
  CONFIGURE: 'lite:ai:configure',
} as const;

export interface InitAiOptions {
  logger?: {
    info: (message: string, data?: unknown) => void;
    warn: (message: string, data?: unknown) => void;
    error: (message: string, data?: unknown) => void;
  };
}

export interface AiHandle {
  teardown(): void;
}

let registered = false;

export function initAi(opts: InitAiOptions = {}): AiHandle {
  const log = opts.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  if (registered) return { teardown: teardownInternal };

  ipcMain.handle(
    AI_IPC.TTS,
    async (
      _event: IpcMainInvokeEvent,
      payload: TtsRequest
    ): Promise<{ audioBase64: string; mimeType: string; voice: string; model: string; format: string }> => {
      getLoggingApi().event(AI_EVENTS.IPC_TTS);
      try {
        const result = await getAiApi().tts(payload);
        return {
          audioBase64: bytesToBase64(result.audio),
          mimeType: result.mimeType,
          voice: result.voice,
          model: result.model,
          format: result.format,
        };
      } catch (err) {
        if (err instanceof AiError) {
          log.warn('tts rejected', { code: err.code });
          throw new Error(JSON.stringify({ __aiError: err.toJSON() }));
        }
        throw err;
      }
    }
  );

  ipcMain.handle(
    AI_IPC.CHAT,
    async (_event: IpcMainInvokeEvent, payload: ChatRequest): Promise<ChatResponse> => {
      getLoggingApi().event(AI_EVENTS.IPC_CHAT);
      try {
        return await getAiApi().chat(payload);
      } catch (err) {
        if (err instanceof AiError) {
          log.warn('chat rejected', { code: err.code });
          throw new Error(JSON.stringify({ __aiError: err.toJSON() }));
        }
        throw err;
      }
    }
  );

  ipcMain.handle(AI_IPC.STATUS, async (): Promise<AiStatus> => {
    getLoggingApi().event(AI_EVENTS.IPC_STATUS);
    return getAiApi().status();
  });

  ipcMain.handle(
    AI_IPC.CONFIGURE,
    async (_event: IpcMainInvokeEvent, config: AiConfig): Promise<{ ok: true }> => {
      getLoggingApi().event(AI_EVENTS.IPC_CONFIGURE);
      try {
        await getAiApi().configure(config);
        return { ok: true };
      } catch (err) {
        if (err instanceof AiError) {
          log.warn('configure rejected', { code: err.code });
          throw new Error(JSON.stringify({ __aiError: err.toJSON() }));
        }
        throw err;
      }
    }
  );

  registered = true;
  log.info('ai initialized', {});
  return { teardown: teardownInternal };
}

function teardownInternal(): void {
  if (!registered) return;
  try {
    ipcMain.removeHandler(AI_IPC.TTS);
    ipcMain.removeHandler(AI_IPC.CHAT);
    ipcMain.removeHandler(AI_IPC.STATUS);
    ipcMain.removeHandler(AI_IPC.CONFIGURE);
  } catch {
    /* best-effort */
  }
  registered = false;
}

/** @internal -- exposed for tests. */
export function _isAiRegisteredForTesting(): boolean {
  return registered;
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
