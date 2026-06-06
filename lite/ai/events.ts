/**
 * AI module event types -- per-module typed event surface (ADR-032 +
 * ADR-030).
 *
 * The AI module talks to Claude (and optionally a OneReach flow). These
 * events make every IPC entry + the asset-enrichment span observable in
 * `/logs?category=ai`.
 *
 * **SECURITY:** no event payload ever carries the API key, the asset
 * content, or the user's purpose text -- only ids, counts, and the
 * chosen modality.
 *
 * Mirrors the catalog pattern in `lite/idw/events.ts`.
 */

import type { EventRecord, SerializedEventError } from '../logging/events.js';

/** Stable event-name catalog. Source of truth for what ai/ emits. */
export const AI_EVENTS = {
  // Asset enrichment span (fetch asset -> Claude -> patch metadata).
  ENRICH_ASSET_START: 'ai.enrich-asset.start',
  ENRICH_ASSET_FINISH: 'ai.enrich-asset.finish',
  ENRICH_ASSET_FAIL: 'ai.enrich-asset.fail',
  // Which content modality the enrichment used.
  ENRICH_MODALITY: 'ai.enrich.modality',
  // IPC entry events (per ADR-030). Note: there is no `extract-metadata`
  // IPC channel — `extractAssetMetadata` is consumed internally by
  // `enrichAsset`, so it's observable through the `ai.enrich-asset` span
  // rather than a separate `ai.ipc.*` entry event.
  IPC_STATUS: 'ai.ipc.status',
  IPC_SPACE_ASSIST: 'ai.ipc.space-assist',
  IPC_ENRICH_ASSET: 'ai.ipc.enrich-asset',
  IPC_KEY_SAVE: 'ai.ipc.key-save',
  IPC_KEY_HAS: 'ai.ipc.key-has',
  IPC_KEY_DELETE: 'ai.ipc.key-delete',
} as const;

export type AiEventName = (typeof AI_EVENTS)[keyof typeof AI_EVENTS];

interface AiEventBase {
  id: string;
  timestamp: string;
  category: 'ai';
}
interface AiSpanBase extends AiEventBase {
  spanId: string;
}

export interface AiEnrichAssetStartEvent extends AiSpanBase {
  name: typeof AI_EVENTS.ENRICH_ASSET_START;
  level: 'info';
  data?: { assetId: string };
}
export interface AiEnrichAssetFinishEvent extends AiSpanBase {
  name: typeof AI_EVENTS.ENRICH_ASSET_FINISH;
  level: 'info';
  durationMs: number;
  data?: { assetId: string; modality: string; tags: number };
}
export interface AiEnrichAssetFailEvent extends AiSpanBase {
  name: typeof AI_EVENTS.ENRICH_ASSET_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}
export interface AiEnrichModalityEvent extends AiEventBase {
  name: typeof AI_EVENTS.ENRICH_MODALITY;
  level: 'info';
  data: { assetId: string; kind: string; modality: string };
}

interface AiIpcEventBase extends AiEventBase {
  level: 'info';
}
export interface AiIpcStatusEvent extends AiIpcEventBase {
  name: typeof AI_EVENTS.IPC_STATUS;
}
export interface AiIpcSpaceAssistEvent extends AiIpcEventBase {
  name: typeof AI_EVENTS.IPC_SPACE_ASSIST;
}
export interface AiIpcEnrichAssetEvent extends AiIpcEventBase {
  name: typeof AI_EVENTS.IPC_ENRICH_ASSET;
}
export interface AiIpcKeySaveEvent extends AiIpcEventBase {
  name: typeof AI_EVENTS.IPC_KEY_SAVE;
}
export interface AiIpcKeyHasEvent extends AiIpcEventBase {
  name: typeof AI_EVENTS.IPC_KEY_HAS;
}
export interface AiIpcKeyDeleteEvent extends AiIpcEventBase {
  name: typeof AI_EVENTS.IPC_KEY_DELETE;
}

export type AiEvent =
  | AiEnrichAssetStartEvent
  | AiEnrichAssetFinishEvent
  | AiEnrichAssetFailEvent
  | AiEnrichModalityEvent
  | AiIpcStatusEvent
  | AiIpcSpaceAssistEvent
  | AiIpcEnrichAssetEvent
  | AiIpcKeySaveEvent
  | AiIpcKeyHasEvent
  | AiIpcKeyDeleteEvent;

export function isAiEvent(ev: EventRecord): ev is EventRecord & AiEvent {
  return Object.values(AI_EVENTS).includes(ev.name as AiEventName);
}
