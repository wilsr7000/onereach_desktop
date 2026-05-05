/**
 * Translator -- pure projection from raw `EventRecord` to `DomainEvent`.
 *
 * The rules table here IS the public contract for what raw events
 * become domain events. Each rule is a (predicate, projection) pair:
 *   - `match(ev)` -- is this raw event one we care about?
 *   - `project(ev)` -- shape it into a typed `DomainEvent` (or null
 *     when the event matched the predicate but the payload was
 *     malformed; null = skip).
 *
 * Pure: no I/O, no mutable state, no logger. Easy to unit-test.
 *
 * Per ADR-043:
 *   - Each domain event name MUST have at least one rule (no orphan names)
 *   - Each rule MUST emit a known domain event name (no orphan rules)
 *   - The conformance test enforces both invariants
 *
 * Design note: rules are checked in order; first match wins. We
 * deliberately project on the `.finish` (success) variant of spans
 * rather than on `.start` -- domain events represent OUTCOMES, not
 * intentions.
 */

import type { EventRecord } from '../logging/events.js';
import type { DomainEvent } from './types.js';
import type { Environment } from '../auth/types.js';

interface TranslatorRule {
  /** Stable id for the rule -- shows up in `event-bus.translated` events. */
  id: string;
  /** Predicate. Pure -- depends only on the raw record. */
  match: (ev: EventRecord) => boolean;
  /** Projection. Returns the new domain event (without `id` / `ts` --
   *  the store fills those in) or null to skip (e.g. data shape is wrong). */
  project: (ev: EventRecord) => Omit<DomainEvent, 'id' | 'ts'> | null;
}

// ─── Helpers (kept tight; avoid complex parsers) ──────────────────────────

function readData(ev: EventRecord): Record<string, unknown> | null {
  if (ev.data === null || ev.data === undefined) return null;
  if (typeof ev.data !== 'object' || Array.isArray(ev.data)) return null;
  return ev.data as Record<string, unknown>;
}

function readString(d: Record<string, unknown> | null, key: string): string | null {
  if (d === null) return null;
  const v = d[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function readBool(d: Record<string, unknown> | null, key: string): boolean | null {
  if (d === null) return null;
  const v = d[key];
  return typeof v === 'boolean' ? v : null;
}

// ─── Rules table ──────────────────────────────────────────────────────────

export const TRANSLATOR_RULES: ReadonlyArray<TranslatorRule> = [
  // user.signed-in -- auth.signIn.finish carries env + accountId.
  {
    id: 'auth.signIn.finish->user.signed-in',
    match: (ev) => ev.name === 'auth.signIn.finish',
    project: (ev) => {
      const d = readData(ev);
      const env = readString(d, 'env');
      const accountId = readString(d, 'accountId');
      if (env === null || accountId === null) return null;
      const email = readString(d, 'email');
      return {
        name: 'user.signed-in',
        data: {
          env: env as Environment,
          accountId,
          ...(email !== null ? { email } : {}),
        },
      };
    },
  },
  // user.signed-out -- auth.signOut.finish always succeeds (no fail variant).
  {
    id: 'auth.signOut.finish->user.signed-out',
    match: (ev) => ev.name === 'auth.signOut.finish',
    project: (ev) => {
      const d = readData(ev);
      const env = readString(d, 'env');
      if (env === null) return null;
      return { name: 'user.signed-out', data: { env: env as Environment } };
    },
  },
  // agent.tab.opened -- new tab created (NOT dedupe path).
  // The main-window's open-tab span emits wasFocus=true on the dedupe
  // path and wasFocus=false on a new tab. We split this into two rules
  // so each one has a single target name -- the test invariant
  // "every rule emits exactly one known name" stays simple.
  {
    id: 'main-window.open-tab.finish->agent.tab.opened',
    match: (ev) =>
      ev.name === 'main-window.open-tab.finish' &&
      readBool(readData(ev), 'wasFocus') !== true,
    project: (ev) => {
      const d = readData(ev);
      const tabId = readString(d, 'id');
      if (tabId === null) return null;
      // For v1 we don't have idwId/url/label in the span data
      // (open-tab only logs `id` + `wasFocus`). Subscribers can call
      // window.lite.mainWindow.get(tabId) for richer detail.
      return {
        name: 'agent.tab.opened',
        data: { tabId, url: '', label: '' },
      };
    },
  },
  // agent.tab.focused -- existing tab focused via dedupe.
  {
    id: 'main-window.open-tab.finish->agent.tab.focused',
    match: (ev) =>
      ev.name === 'main-window.open-tab.finish' &&
      readBool(readData(ev), 'wasFocus') === true,
    project: (ev) => {
      const d = readData(ev);
      const tabId = readString(d, 'id');
      if (tabId === null) return null;
      return { name: 'agent.tab.focused', data: { tabId } };
    },
  },
  // agent.tab.closed
  {
    id: 'main-window.close-tab.finish->agent.tab.closed',
    match: (ev) => ev.name === 'main-window.close-tab.finish',
    project: (ev) => {
      const d = readData(ev);
      const tabId = readString(d, 'id');
      if (tabId === null) return null;
      return { name: 'agent.tab.closed', data: { tabId } };
    },
  },
  // agent.tab.activated
  {
    id: 'main-window.activate-tab.finish->agent.tab.activated',
    match: (ev) => ev.name === 'main-window.activate-tab.finish',
    project: (ev) => {
      const d = readData(ev);
      const tabId = readString(d, 'id');
      if (tabId === null) return null;
      return { name: 'agent.tab.activated', data: { tabId } };
    },
  },
  // token.injected -- only emit when injection actually wrote cookies.
  {
    id: 'auth.inject-token.finish->token.injected',
    match: (ev) => ev.name === 'auth.inject-token.finish',
    project: (ev) => {
      const d = readData(ev);
      const injected = readBool(d, 'injected');
      if (injected !== true) return null;
      // env + partitionPrefix come from the START event's data; the
      // FINISH event in our auth store doesn't echo them. To keep this
      // rule self-contained (no span correlation), require the auth
      // store to add them to the finish payload. v1 emits with what's
      // available; v1.1 enriches if we need more.
      const env = readString(d, 'env');
      if (env === null) return null;
      return {
        name: 'token.injected',
        data: {
          env: env as Environment,
          partitionPrefix: readString(d, 'partitionPrefix') ?? '',
        },
      };
    },
  },
  // update.available
  {
    id: 'updater.update-available->update.available',
    match: (ev) =>
      ev.name === 'updater.update-available' || ev.name === 'updater.available',
    project: (ev) => {
      const d = readData(ev);
      const version = readString(d, 'version');
      if (version === null) return null;
      return { name: 'update.available', data: { version } };
    },
  },
  // update.downloaded
  {
    id: 'updater.update-downloaded->update.downloaded',
    match: (ev) =>
      ev.name === 'updater.update-downloaded' || ev.name === 'updater.downloaded',
    project: (ev) => {
      const d = readData(ev);
      const version = readString(d, 'version');
      if (version === null) return null;
      return { name: 'update.downloaded', data: { version } };
    },
  },
  // idw.installed -- a Store catalog install completed.
  {
    id: 'idw.store.installed->idw.installed',
    match: (ev) => ev.name === 'idw.store.installed',
    project: (ev) => {
      const d = readData(ev);
      const id = readString(d, 'id');
      const kind = readString(d, 'kind');
      const catalogId = readString(d, 'catalogId');
      if (id === null || kind === null || catalogId === null) return null;
      return { name: 'idw.installed', data: { id, kind, catalogId } };
    },
  },
  // bug-report.submitted -- the bug-report module fires bug-report.save
  // events; we project the success path.
  {
    id: 'bug-report.save.finish->bug-report.submitted',
    match: (ev) => ev.name === 'bug-report.save.finish',
    project: (ev) => {
      const d = readData(ev);
      const filePath = readString(d, 'filePath');
      const redactionBucket = readString(d, 'redactionBucket') ?? 'none';
      if (filePath === null) return null;
      return {
        name: 'bug-report.submitted',
        data: { filePath, redactionBucket },
      };
    },
  },
];

/**
 * Translate one raw record. Returns the matched rule's projection, or
 * null when no rule matches (or the matching rule rejected the
 * payload as malformed).
 */
export function translate(
  ev: EventRecord
): { rule: TranslatorRule; event: Omit<DomainEvent, 'id' | 'ts'> } | null {
  for (const rule of TRANSLATOR_RULES) {
    if (!rule.match(ev)) continue;
    const projected = rule.project(ev);
    if (projected !== null) return { rule, event: projected };
    // Matched but malformed -- return null so the caller logs and skips.
    return null;
  }
  return null;
}
