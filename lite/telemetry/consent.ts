/**
 * Consent gate — the only thing standing between a colleague's machine
 * and a central graph. Every send path routes through `maySend()`.
 *
 * Modelled on the platform convention the user asked for (Apple's
 * "Share analytics?" prompt): asked once, in plain language, with the
 * payload disclosed, defaulting to NO, and revocable afterwards
 * without penalty.
 *
 * The functions here are pure so the gate is exhaustively testable
 * without Electron, KV, or a graph.
 */

import type { TelemetryConsent, TelemetryConsentRecord } from './types.js';

/**
 * May this install send telemetry?
 *
 * Strict `=== 'granted'`, and strict about the record's shape: an
 * absent record, a malformed one, an unknown state string, or a
 * JSON-round-tripped value all resolve to NO. The failure mode worth
 * engineering against is sending data the user never agreed to;
 * refusing to send is always recoverable by asking again.
 */
export function maySend(record: unknown): boolean {
  if (record === null || typeof record !== 'object') return false;
  const state = (record as { state?: unknown }).state;
  return state === 'granted';
}

/**
 * Should we show the consent prompt?
 *
 * Only when we have never asked. A denial is permanent until the user
 * revisits Settings themselves — re-prompting a "no" is how consent
 * dialogs become something people click through to make them stop,
 * which destroys the value of the signal.
 */
export function shouldPrompt(record: unknown): boolean {
  if (record === null || typeof record !== 'object') return true;
  const state = (record as { state?: unknown }).state;
  if (state === 'granted' || state === 'denied') return false;
  // 'unset', missing, or anything unrecognised -> we still owe the ask.
  return true;
}

/** Build the record to persist for a decision. */
export function recordDecision(
  state: Extract<TelemetryConsent, 'granted' | 'denied'>,
  version: string,
  nowIso: string
): TelemetryConsentRecord {
  return { state, decidedAt: nowIso, decidedInVersion: version };
}

/**
 * The disclosure shown in the prompt.
 *
 * Exported and asserted in tests on purpose: this text is the promise
 * the code has to keep. If the payload ever grows beyond what this
 * says, the test that pins them together should fail and force the
 * disclosure to be updated rather than quietly drift.
 */
export const CONSENT_DISCLOSURE = {
  title: 'Help improve Onereach.ai Lite?',
  body:
    'Lite can send a short daily summary of how this copy of the app is ' +
    'running, so problems get found before you have to report them.',
  sends: [
    'App version, platform, and how long the app was open',
    'Counts of errors, grouped by area of the app',
    'Which parts of the app were opened, and how often',
    'Whether sign-in, the database, and updates are working',
  ],
  neverSends: [
    'Anything you type, upload, or open',
    'File names, asset titles, links, or message contents',
    'Passwords, tokens, or cookies',
  ],
  footer: 'You can change this any time in Settings → Diagnostics.',
} as const;

/**
 * Fields a rollup is permitted to carry. The disclosure above promises
 * this and nothing else; `assertRollupWithinDisclosure` enforces it at
 * runtime so a future field cannot ship without someone also updating
 * what the user was told.
 */
export const ALLOWED_ROLLUP_KEYS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'installId',
  'day',
  'version',
  'platform',
  'arch',
  'activeMinutes',
  'counters',
  'health',
]);

/**
 * Reject a payload carrying anything the user was not told about.
 *
 * This is a belt-and-braces check on the boundary, not a formality: it
 * is the difference between "we promise the payload is limited" and
 * "the payload cannot exceed the promise". Returns the offending keys
 * so the caller can log precisely what was blocked.
 */
export function disclosureViolations(payload: unknown): string[] {
  if (payload === null || typeof payload !== 'object') return ['<not an object>'];
  return Object.keys(payload as Record<string, unknown>)
    .filter((k) => !ALLOWED_ROLLUP_KEYS.has(k))
    .sort();
}
