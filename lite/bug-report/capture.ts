/**
 * Bug-report capture -- assembles the structured payload from app state
 * + log server, applies mandatory redaction, returns the result.
 *
 * Per ADR-008, redaction is default-on and cannot be opted out of.
 * Per ADR-011, the kernel does NOT capture screenshots (deferred until
 * first content-tab port has something visual to capture).
 * Per ADR-011, the kernel does NOT include AI prompt content (no AI
 * calls happen in kernel, so there are no prompts to redact).
 */

import { redact, bucketFor, type RedactionBucket } from '../bug-report-redaction-patterns.js';
import type { AppHealthSnapshot } from '../health/api.js';

export type BugReportStatus = 'open' | 'resolved';

export interface BugReportPayload {
  /** Schema version of the payload itself */
  schemaVersion: 1;
  /** ISO timestamp at capture time -- also the unique record key */
  timestamp: string;
  /** Tagged at capture per ADR-008/011 -- distinguishes from full-app reports */
  appTag: 'lite';
  /** Marker so the regression-test pipeline can distinguish real bugs from synthetic fixtures */
  source: 'user-bug-report';
  /** App version from package.json */
  version: string;
  /** OS info */
  os: {
    platform: NodeJS.Platform;
    release: string;
    arch: string;
  };
  /** User-supplied free-text description -- IMMUTABLE after creation (evidence) */
  description: string;
  /** Last N redacted log lines from lite's log server -- IMMUTABLE after creation */
  recentLogs: string;
  /**
   * Optional current-state snapshot at capture time (ADR-036). Holds
   * presence booleans / metadata only -- never tokens, secrets, or
   * passwords (see `lite/health/types.ts`). Optional so the bug-report
   * schema does not break when the health module is unavailable; the
   * field simply isn't present in older payloads.
   */
  healthSnapshot?: AppHealthSnapshot;
  /** Cohort-aggregated redaction telemetry (per ADR-008, never per-user-attributable) */
  redactionTelemetry: {
    bucket: RedactionBucket;
    /** Counts by pattern kind, for trend audit at Phase 3 security review */
    countsByKind: Record<string, number>;
  };
  /**
   * Mutable: triage state. Defaults to 'open' on capture; user can toggle
   * to 'resolved' from the previous-reports view. NOT redacted -- this is
   * a status the user assigns, not user-typed content.
   */
  status: BugReportStatus;
  /**
   * Mutable: free-text notes the user (or future triager) adds AFTER the
   * bug is filed. Goes through the same redaction pass on save as the
   * original description.
   */
  notes: string;
  /**
   * ISO timestamp of the last mutation (status or notes). Equals timestamp
   * for never-modified reports.
   */
  lastModified: string;
}

export interface CaptureContext {
  /** App version (from package.json or app.getVersion()) */
  version: string;
  /** OS platform info */
  platform: NodeJS.Platform;
  release: string;
  arch: string;
  /** Recent log lines fetched from lite's log server (may be empty) */
  recentLogLines: string[];
  /** User-supplied description (already typed in the modal) */
  userDescription: string;
  /**
   * Optional current-state health snapshot to include in the payload.
   * Already secret-free by construction (see `lite/health/types.ts`).
   * The caller is responsible for fetching it via
   * `getHealthApi().snapshot()`; capture is best-effort and does not
   * read it itself so this module stays free of cross-module imports
   * that aren't strictly required.
   */
  healthSnapshot?: AppHealthSnapshot;
}

/**
 * Build a redacted bug-report payload. Mandatory redaction is applied
 * to BOTH the user description and the log lines before assembly.
 */
export function capture(ctx: CaptureContext): BugReportPayload {
  // Redact user description and log lines separately, then sum counts.
  const descRedaction = redact(ctx.userDescription);
  const logsJoined = ctx.recentLogLines.join('\n');
  const logsRedaction = redact(logsJoined);

  const totalCount = descRedaction.totalCount + logsRedaction.totalCount;
  const countsByKind: Record<string, number> = {};
  for (const [kind, count] of Object.entries(descRedaction.counts)) {
    countsByKind[kind] = (countsByKind[kind] ?? 0) + count;
  }
  for (const [kind, count] of Object.entries(logsRedaction.counts)) {
    countsByKind[kind] = (countsByKind[kind] ?? 0) + count;
  }

  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    timestamp: now,
    appTag: 'lite',
    source: 'user-bug-report',
    version: ctx.version,
    os: {
      platform: ctx.platform,
      release: ctx.release,
      arch: ctx.arch,
    },
    description: descRedaction.text,
    recentLogs: logsRedaction.text,
    ...(ctx.healthSnapshot !== undefined ? { healthSnapshot: ctx.healthSnapshot } : {}),
    redactionTelemetry: {
      bucket: bucketFor(totalCount),
      countsByKind,
    },
    status: 'open',
    notes: '',
    lastModified: now,
  };
}

/**
 * Migrate a payload read from disk/KV that may predate the status/notes
 * fields. Defaults missing fields to safe values. Used by readers so old
 * reports list cleanly without manual migration.
 */
export function migrateLegacyPayload(payload: Partial<BugReportPayload> & Record<string, unknown>): BugReportPayload {
  return {
    schemaVersion: 1,
    timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : new Date().toISOString(),
    appTag: 'lite',
    source: 'user-bug-report',
    version: typeof payload.version === 'string' ? payload.version : '0.0.0',
    os: payload.os ?? { platform: 'darwin', release: '', arch: '' },
    description: typeof payload.description === 'string' ? payload.description : '',
    recentLogs: typeof payload.recentLogs === 'string' ? payload.recentLogs : '',
    // Pre-ADR-036 reports lack healthSnapshot. Pass-through if present;
    // omit otherwise (the field is optional on BugReportPayload).
    ...(payload.healthSnapshot !== undefined
      ? { healthSnapshot: payload.healthSnapshot }
      : {}),
    redactionTelemetry: payload.redactionTelemetry ?? { bucket: 'none', countsByKind: {} },
    status: payload.status === 'resolved' ? 'resolved' : 'open',
    notes: typeof payload.notes === 'string' ? payload.notes : '',
    lastModified:
      typeof payload.lastModified === 'string'
        ? payload.lastModified
        : typeof payload.timestamp === 'string'
          ? payload.timestamp
          : new Date().toISOString(),
  };
}
