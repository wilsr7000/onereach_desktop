/**
 * TOTP module event types -- per-module typed event surface (ADR-032).
 *
 * **Redaction guarantee (ADR-027):** TOTP secrets and live codes are
 * NEVER carried in any event payload. Span + instant events here carry
 * only metadata (issuer, account, secret LENGTH, success/failure
 * reason). The `auth-store.test.ts` / `totp` redaction tests enforce
 * that no secret bytes ever reach the log queue.
 *
 * Mirrors the catalog pattern in `lite/idw/events.ts`:
 *   1. A const-typed catalog (`TOTP_EVENTS`) of every emitted name.
 *   2. A discriminated union (`TotpEvent`) for consumer ergonomics.
 *   3. `isTotpEvent(record)` type guard.
 *
 * Adding an event requires updating BOTH the emit site and this file --
 * the `event-name-conformance` meta-test enforces correspondence.
 */

import type { EventRecord, SerializedEventError } from '../logging/events.js';

/** Stable event-name catalog. Source of truth for what totp/ emits. */
export const TOTP_EVENTS = {
  // Operation spans (base name -> .start/.finish/.fail). No secrets in
  // any payload; save-secret carries only the secret LENGTH + issuer.
  SAVE_SECRET_START: 'totp.save-secret.start',
  SAVE_SECRET_FINISH: 'totp.save-secret.finish',
  SAVE_SECRET_FAIL: 'totp.save-secret.fail',
  GET_CODE_START: 'totp.get-code.start',
  GET_CODE_FINISH: 'totp.get-code.finish',
  GET_CODE_FAIL: 'totp.get-code.fail',
  SCAN_QR_SCREEN_START: 'totp.scan-qr-screen.start',
  SCAN_QR_SCREEN_FINISH: 'totp.scan-qr-screen.finish',
  SCAN_QR_SCREEN_FAIL: 'totp.scan-qr-screen.fail',
  SCAN_QR_CLIPBOARD_START: 'totp.scan-qr-clipboard.start',
  SCAN_QR_CLIPBOARD_FINISH: 'totp.scan-qr-clipboard.finish',
  SCAN_QR_CLIPBOARD_FAIL: 'totp.scan-qr-clipboard.fail',
  // IPC entry events (per ADR-030).
  IPC_HAS_SECRET: 'totp.ipc.has-secret',
  IPC_GET_METADATA: 'totp.ipc.get-metadata',
  IPC_SAVE_SECRET: 'totp.ipc.save-secret',
  IPC_SCAN_QR_SCREEN: 'totp.ipc.scan-qr-screen',
  IPC_SCAN_QR_CLIPBOARD: 'totp.ipc.scan-qr-clipboard',
  IPC_GET_CURRENT_CODE: 'totp.ipc.get-current-code',
  IPC_DELETE_SECRET: 'totp.ipc.delete-secret',
} as const;

export type TotpEventName = (typeof TOTP_EVENTS)[keyof typeof TOTP_EVENTS];

interface TotpEventBase {
  id: string;
  timestamp: string;
  category: 'totp';
}

interface TotpSpanBase extends TotpEventBase {
  spanId: string;
}

// ─── spans ──────────────────────────────────────────────────────────────

export interface TotpSaveSecretStartEvent extends TotpSpanBase {
  name: typeof TOTP_EVENTS.SAVE_SECRET_START;
  level: 'info';
  /** Secret LENGTH only -- never the secret bytes. */
  data?: { secretLength?: number; issuer?: string };
}
export interface TotpSaveSecretFinishEvent extends TotpSpanBase {
  name: typeof TOTP_EVENTS.SAVE_SECRET_FINISH;
  level: 'info';
  durationMs: number;
}
export interface TotpSaveSecretFailEvent extends TotpSpanBase {
  name: typeof TOTP_EVENTS.SAVE_SECRET_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}
export interface TotpGetCodeStartEvent extends TotpSpanBase {
  name: typeof TOTP_EVENTS.GET_CODE_START;
  level: 'info';
}
export interface TotpGetCodeFinishEvent extends TotpSpanBase {
  name: typeof TOTP_EVENTS.GET_CODE_FINISH;
  level: 'info';
  durationMs: number;
}
export interface TotpGetCodeFailEvent extends TotpSpanBase {
  name: typeof TOTP_EVENTS.GET_CODE_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}
export interface TotpScanQrScreenStartEvent extends TotpSpanBase {
  name: typeof TOTP_EVENTS.SCAN_QR_SCREEN_START;
  level: 'info';
}
export interface TotpScanQrScreenFinishEvent extends TotpSpanBase {
  name: typeof TOTP_EVENTS.SCAN_QR_SCREEN_FINISH;
  level: 'info';
  durationMs: number;
}
export interface TotpScanQrScreenFailEvent extends TotpSpanBase {
  name: typeof TOTP_EVENTS.SCAN_QR_SCREEN_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}
export interface TotpScanQrClipboardStartEvent extends TotpSpanBase {
  name: typeof TOTP_EVENTS.SCAN_QR_CLIPBOARD_START;
  level: 'info';
}
export interface TotpScanQrClipboardFinishEvent extends TotpSpanBase {
  name: typeof TOTP_EVENTS.SCAN_QR_CLIPBOARD_FINISH;
  level: 'info';
  durationMs: number;
}
export interface TotpScanQrClipboardFailEvent extends TotpSpanBase {
  name: typeof TOTP_EVENTS.SCAN_QR_CLIPBOARD_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── ipc (instant) ────────────────────────────────────────────────────────

interface TotpIpcEventBase extends TotpEventBase {
  level: 'info';
}
export interface TotpIpcHasSecretEvent extends TotpIpcEventBase {
  name: typeof TOTP_EVENTS.IPC_HAS_SECRET;
}
export interface TotpIpcGetMetadataEvent extends TotpIpcEventBase {
  name: typeof TOTP_EVENTS.IPC_GET_METADATA;
}
export interface TotpIpcSaveSecretEvent extends TotpIpcEventBase {
  name: typeof TOTP_EVENTS.IPC_SAVE_SECRET;
}
export interface TotpIpcScanQrScreenEvent extends TotpIpcEventBase {
  name: typeof TOTP_EVENTS.IPC_SCAN_QR_SCREEN;
}
export interface TotpIpcScanQrClipboardEvent extends TotpIpcEventBase {
  name: typeof TOTP_EVENTS.IPC_SCAN_QR_CLIPBOARD;
}
export interface TotpIpcGetCurrentCodeEvent extends TotpIpcEventBase {
  name: typeof TOTP_EVENTS.IPC_GET_CURRENT_CODE;
}
export interface TotpIpcDeleteSecretEvent extends TotpIpcEventBase {
  name: typeof TOTP_EVENTS.IPC_DELETE_SECRET;
}

export type TotpEvent =
  | TotpSaveSecretStartEvent
  | TotpSaveSecretFinishEvent
  | TotpSaveSecretFailEvent
  | TotpGetCodeStartEvent
  | TotpGetCodeFinishEvent
  | TotpGetCodeFailEvent
  | TotpScanQrScreenStartEvent
  | TotpScanQrScreenFinishEvent
  | TotpScanQrScreenFailEvent
  | TotpScanQrClipboardStartEvent
  | TotpScanQrClipboardFinishEvent
  | TotpScanQrClipboardFailEvent
  | TotpIpcHasSecretEvent
  | TotpIpcGetMetadataEvent
  | TotpIpcSaveSecretEvent
  | TotpIpcScanQrScreenEvent
  | TotpIpcScanQrClipboardEvent
  | TotpIpcGetCurrentCodeEvent
  | TotpIpcDeleteSecretEvent;

export function isTotpEvent(ev: EventRecord): ev is EventRecord & TotpEvent {
  return Object.values(TOTP_EVENTS).includes(ev.name as TotpEventName);
}
