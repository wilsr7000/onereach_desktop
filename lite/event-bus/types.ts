/**
 * Event bus shared types -- the public domain-event surface.
 *
 * Per ADR-043, the event bus sits on top of the logging queue and
 * projects raw module events (`auth.signIn.finish`, `idw.changed`,
 * `main-window.open-tab.finish`, ...) into a smaller catalogue of
 * **domain events** that other systems care about (`user.signed-in`,
 * `agent.tab.opened`, ...).
 *
 * The discriminated `DomainEvent` union below IS the bus's public
 * contract. Adding / removing / changing entries is an ADR-worthy
 * change -- subscribers across modules and renderers depend on the
 * shape staying stable.
 *
 * Public types are re-exported from `api.ts`. Internal-only helpers
 * stay here.
 */

import type { Environment } from '../auth/types.js';

// ─── Domain event catalogue ───────────────────────────────────────────────
//
// Every entry carries:
//   - `name`  -- string-literal discriminator (used as the IPC key)
//   - `id`    -- unique id (UUID)
//   - `ts`    -- ISO 8601 timestamp
//   - `data`  -- typed payload
//
// New domain events go here AND in `translator.ts` (the rules table)
// AND in the `event-name-conformance` test (which enforces every name
// has at least one rule and every rule emits a known name).

interface DomainEventBase {
  id: string;
  ts: string;
}

export interface UserSignedInEvent extends DomainEventBase {
  name: 'user.signed-in';
  data: { env: Environment; accountId: string; email?: string };
}

export interface UserSignedOutEvent extends DomainEventBase {
  name: 'user.signed-out';
  data: { env: Environment };
}

export interface AgentTabOpenedEvent extends DomainEventBase {
  name: 'agent.tab.opened';
  data: { tabId: string; idwId?: string; url: string; label: string };
}

export interface AgentTabClosedEvent extends DomainEventBase {
  name: 'agent.tab.closed';
  data: { tabId: string };
}

export interface AgentTabActivatedEvent extends DomainEventBase {
  name: 'agent.tab.activated';
  data: { tabId: string };
}

export interface AgentTabFocusedEvent extends DomainEventBase {
  name: 'agent.tab.focused';
  /**
   * Fired when an `openTab` call hit the dedupe path -- an existing
   * tab matching `idwId` was focused rather than a new one created.
   * Distinct from `opened` so subscribers can tell them apart.
   */
  data: { tabId: string; idwId?: string };
}

export interface TokenInjectedEvent extends DomainEventBase {
  name: 'token.injected';
  /**
   * A captured `mult` cookie was successfully written to a per-tab
   * partition. Fires only when injection actually wrote cookies; the
   * `injected: false` cases (`no-token`, `expired`, ...) DON'T emit
   * a domain event since they're non-events from a consumer POV.
   */
  data: { env: Environment; partitionPrefix: string };
}

export interface UpdateAvailableEvent extends DomainEventBase {
  name: 'update.available';
  data: { version: string };
}

export interface UpdateDownloadedEvent extends DomainEventBase {
  name: 'update.downloaded';
  data: { version: string };
}

export interface IdwInstalledEvent extends DomainEventBase {
  name: 'idw.installed';
  data: { id: string; kind: string; catalogId: string };
}

export interface BugReportSubmittedEvent extends DomainEventBase {
  name: 'bug-report.submitted';
  data: { filePath: string; redactionBucket: string };
}

/**
 * Discriminated union -- every possible domain event the bus emits.
 * Branch on `ev.name` for type-narrowed access to `ev.data`.
 */
export type DomainEvent =
  | UserSignedInEvent
  | UserSignedOutEvent
  | AgentTabOpenedEvent
  | AgentTabClosedEvent
  | AgentTabActivatedEvent
  | AgentTabFocusedEvent
  | TokenInjectedEvent
  | UpdateAvailableEvent
  | UpdateDownloadedEvent
  | IdwInstalledEvent
  | BugReportSubmittedEvent;

/** All concrete domain event names. Stays in lockstep with the union. */
export type DomainEventName = DomainEvent['name'];

/** Source-of-truth for valid names. The conformance test asserts the union
 *  matches this list. Keep it sorted by category for readable diffs. */
export const DOMAIN_EVENT_NAMES: ReadonlyArray<DomainEventName> = [
  'user.signed-in',
  'user.signed-out',
  'agent.tab.opened',
  'agent.tab.closed',
  'agent.tab.activated',
  'agent.tab.focused',
  'token.injected',
  'update.available',
  'update.downloaded',
  'idw.installed',
  'bug-report.submitted',
];

// ─── Persistence shape ────────────────────────────────────────────────────

export interface EventBusBlob {
  schemaVersion: 1;
  /** Most-recent-last. Bounded by `RING_BUFFER_MAX`. */
  events: DomainEvent[];
}

/** KV collection + key for cross-restart replay. */
export const KV_COLLECTION = 'lite-event-bus';
export const KV_KEY = 'default';

/** Maximum events held in the in-memory ring buffer + persisted blob. */
export const RING_BUFFER_MAX = 200;

/** Throttle window for KV writes. We coalesce bursts so a 100-event
 *  storm produces at most one disk write per window instead of 100. */
export const PERSIST_DEBOUNCE_MS = 500;

/** Sentinel module version (avoids dep-cruiser orphan warning). */
export const EVENT_BUS_MODULE_VERSION = 1 as const;
