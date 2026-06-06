/**
 * Onboarding module event types -- per-module typed event surface
 * (ADR-032 + ADR-030).
 *
 * The onboarding module tracks first-run checklist progress in KV.
 * These events make every IPC entry + the corrupt-blob self-heal
 * observable in `/logs?category=onboarding`.
 *
 * Mirrors the catalog pattern in `lite/idw/events.ts`.
 */

import type { EventRecord } from '../logging/events.js';

/** Stable event-name catalog. Source of truth for what onboarding/ emits. */
export const ONBOARDING_EVENTS = {
  // Activity (instant).
  STEP_COMPLETED: 'onboarding.step.completed',
  DISMISSED: 'onboarding.dismissed',
  // Self-heal: corrupt KV blob detected on read + overwritten with a
  // fresh default. Surfaced so data-recovery isn't hidden in a warn line.
  SELF_HEAL: 'onboarding.self-heal',
  // IPC entry events (per ADR-030).
  IPC_LOAD: 'onboarding.ipc.load',
  IPC_MARK_COMPLETE: 'onboarding.ipc.mark-complete',
  IPC_DISMISS: 'onboarding.ipc.dismiss',
} as const;

export type OnboardingEventName =
  (typeof ONBOARDING_EVENTS)[keyof typeof ONBOARDING_EVENTS];

interface OnboardingEventBase {
  id: string;
  timestamp: string;
  category: 'onboarding';
}

export interface OnboardingStepCompletedEvent extends OnboardingEventBase {
  name: typeof ONBOARDING_EVENTS.STEP_COMPLETED;
  level: 'info';
  data: { stepId: string };
}
export interface OnboardingDismissedEvent extends OnboardingEventBase {
  name: typeof ONBOARDING_EVENTS.DISMISSED;
  level: 'info';
}
export interface OnboardingSelfHealEvent extends OnboardingEventBase {
  name: typeof ONBOARDING_EVENTS.SELF_HEAL;
  level: 'warn';
  data: { actualType: string };
}
export interface OnboardingIpcLoadEvent extends OnboardingEventBase {
  name: typeof ONBOARDING_EVENTS.IPC_LOAD;
  level: 'info';
}
export interface OnboardingIpcMarkCompleteEvent extends OnboardingEventBase {
  name: typeof ONBOARDING_EVENTS.IPC_MARK_COMPLETE;
  level: 'info';
}
export interface OnboardingIpcDismissEvent extends OnboardingEventBase {
  name: typeof ONBOARDING_EVENTS.IPC_DISMISS;
  level: 'info';
}

export type OnboardingEvent =
  | OnboardingStepCompletedEvent
  | OnboardingDismissedEvent
  | OnboardingSelfHealEvent
  | OnboardingIpcLoadEvent
  | OnboardingIpcMarkCompleteEvent
  | OnboardingIpcDismissEvent;

export function isOnboardingEvent(
  ev: EventRecord
): ev is EventRecord & OnboardingEvent {
  return Object.values(ONBOARDING_EVENTS).includes(
    ev.name as OnboardingEventName
  );
}
