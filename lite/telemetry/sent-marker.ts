/**
 * Telemetry sent-marker — remembers the last rollup outcome across
 * restarts so Settings can show whether consent is actually producing
 * data ("last rollup sent: <day>") instead of silent soft-fails hiding
 * a week of misses (2026-08-07 reporting review, row 4).
 *
 * Deliberately additive to the telemetry module: one tiny JSON file,
 * atomic write, corrupt-tolerant read — same conventions as the
 * updater's update-state.json.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const SENT_MARKER_FILENAME = 'telemetry-sent-marker.json';

export type RollupOutcome = 'sent' | 'skipped-consent' | 'failed';

export interface SentMarker {
  /** UTC day of the last SUCCESSFUL send, or null if never. */
  lastSentDay: string | null;
  /** Outcome of the most recent seal attempt (whatever it was). */
  lastOutcome: RollupOutcome | null;
  /** ISO timestamp of that attempt. */
  lastAttemptAt: string | null;
}

export const EMPTY_SENT_MARKER: SentMarker = {
  lastSentDay: null,
  lastOutcome: null,
  lastAttemptAt: null,
};

function markerFile(userDataPath: string): string {
  return path.join(userDataPath, SENT_MARKER_FILENAME);
}

/** Never throws; corrupt or missing → empty marker. */
export function readSentMarker(userDataPath: string): SentMarker {
  try {
    const raw = fs.readFileSync(markerFile(userDataPath), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SentMarker>;
    const outcome =
      parsed.lastOutcome === 'sent' ||
      parsed.lastOutcome === 'skipped-consent' ||
      parsed.lastOutcome === 'failed'
        ? parsed.lastOutcome
        : null;
    return {
      lastSentDay: typeof parsed.lastSentDay === 'string' ? parsed.lastSentDay : null,
      lastOutcome: outcome,
      lastAttemptAt: typeof parsed.lastAttemptAt === 'string' ? parsed.lastAttemptAt : null,
    };
  } catch {
    return { ...EMPTY_SENT_MARKER };
  }
}

/** Atomic tmp+rename; never throws (bookkeeping must not crash the app). */
export function recordRollupOutcome(
  userDataPath: string,
  outcome: RollupOutcome,
  day: string,
  nowIso: string
): SentMarker {
  const previous = readSentMarker(userDataPath);
  const next: SentMarker = {
    lastSentDay: outcome === 'sent' ? day : previous.lastSentDay,
    lastOutcome: outcome,
    lastAttemptAt: nowIso,
  };
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    const target = markerFile(userDataPath);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, target);
  } catch {
    /* best-effort */
  }
  return next;
}
