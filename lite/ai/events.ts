/**
 * Lite AI module event types -- per-module typed event surface (ADR-032).
 */

import type { EventRecord } from '../logging/events.js';

export const AI_EVENTS = {
  // Spans (start / finish / fail)
  TTS_START: 'ai.tts.start',
  TTS_FINISH: 'ai.tts.finish',
  TTS_FAIL: 'ai.tts.fail',
  CHAT_START: 'ai.chat.start',
  CHAT_FINISH: 'ai.chat.finish',
  CHAT_FAIL: 'ai.chat.fail',
  CONFIGURE_START: 'ai.configure.start',
  CONFIGURE_FINISH: 'ai.configure.finish',
  CONFIGURE_FAIL: 'ai.configure.fail',
  // IPC entry events (per ADR-030)
  IPC_TTS: 'ai.ipc.tts',
  IPC_CHAT: 'ai.ipc.chat',
  IPC_STATUS: 'ai.ipc.status',
  IPC_CONFIGURE: 'ai.ipc.configure',
} as const;

export type AiEventName = (typeof AI_EVENTS)[keyof typeof AI_EVENTS];

interface AiEventBase {
  id: string;
  timestamp: string;
  category: 'ai';
}

export interface AiTtsStartEvent extends AiEventBase {
  name: typeof AI_EVENTS.TTS_START;
  level: 'info';
  data: { textLength: number; voice: string; model: string };
}
export interface AiTtsFinishEvent extends AiEventBase {
  name: typeof AI_EVENTS.TTS_FINISH;
  level: 'info';
  data: { textLength: number; bytes: number; durationMs: number };
}
export interface AiTtsFailEvent extends AiEventBase {
  name: typeof AI_EVENTS.TTS_FAIL;
  level: 'error';
  data: { code: string; status?: number };
}

export interface AiChatStartEvent extends AiEventBase {
  name: typeof AI_EVENTS.CHAT_START;
  level: 'info';
  data: { messageCount: number; model: string };
}
export interface AiChatFinishEvent extends AiEventBase {
  name: typeof AI_EVENTS.CHAT_FINISH;
  level: 'info';
  data: { totalTokens: number; durationMs: number };
}
export interface AiChatFailEvent extends AiEventBase {
  name: typeof AI_EVENTS.CHAT_FAIL;
  level: 'error';
  data: { code: string; status?: number };
}

export interface AiConfigureStartEvent extends AiEventBase {
  name: typeof AI_EVENTS.CONFIGURE_START;
  level: 'info';
  data: { fields: string[] };
}
export interface AiConfigureFinishEvent extends AiEventBase {
  name: typeof AI_EVENTS.CONFIGURE_FINISH;
  level: 'info';
}
export interface AiConfigureFailEvent extends AiEventBase {
  name: typeof AI_EVENTS.CONFIGURE_FAIL;
  level: 'error';
  data: { code: string };
}

export interface AiIpcTtsEvent extends AiEventBase {
  name: typeof AI_EVENTS.IPC_TTS;
  level: 'info';
}
export interface AiIpcChatEvent extends AiEventBase {
  name: typeof AI_EVENTS.IPC_CHAT;
  level: 'info';
}
export interface AiIpcStatusEvent extends AiEventBase {
  name: typeof AI_EVENTS.IPC_STATUS;
  level: 'info';
}
export interface AiIpcConfigureEvent extends AiEventBase {
  name: typeof AI_EVENTS.IPC_CONFIGURE;
  level: 'info';
}

/** Discriminated union -- branch on `ev.name` to narrow. */
export type AiEvent =
  | AiTtsStartEvent
  | AiTtsFinishEvent
  | AiTtsFailEvent
  | AiChatStartEvent
  | AiChatFinishEvent
  | AiChatFailEvent
  | AiConfigureStartEvent
  | AiConfigureFinishEvent
  | AiConfigureFailEvent
  | AiIpcTtsEvent
  | AiIpcChatEvent
  | AiIpcStatusEvent
  | AiIpcConfigureEvent;

export function isAiEvent(ev: EventRecord): ev is EventRecord & AiEvent {
  return Object.values(AI_EVENTS).includes(ev.name as AiEventName);
}
