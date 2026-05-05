/**
 * Shared test fixtures for the bug-report module.
 *
 * Importing test files: only via the harness barrel
 * (`import { makeBugReportPayload } from '../harness'`).
 *
 * Adding new fixtures: keep them deterministic (no `Date.now()`, no
 * random ids). Tests should produce identical input shapes across runs.
 */

import type { BugReportPayload } from '../../../bug-report/capture.js';

export interface MakeBugReportPayloadOverrides {
  schemaVersion?: BugReportPayload['schemaVersion'];
  timestamp?: string;
  appTag?: BugReportPayload['appTag'];
  source?: BugReportPayload['source'];
  version?: string;
  os?: BugReportPayload['os'];
  description?: string;
  recentLogs?: string;
  redactionTelemetry?: BugReportPayload['redactionTelemetry'];
  status?: BugReportPayload['status'];
  notes?: string;
  lastModified?: string;
}

/**
 * Build a bug-report payload with sensible defaults. Overrides allow
 * tests to pin one or two fields (timestamp, description) without
 * having to construct the full object every time.
 *
 * Defaults are chosen to be schema-valid and deterministic.
 *
 * @example
 * ```typescript
 * const payload = makeBugReportPayload({
 *   description: 'modal froze on save',
 *   timestamp: '2026-05-04T12:00:00.000Z',
 * });
 * ```
 */
export function makeBugReportPayload(
  overrides: MakeBugReportPayloadOverrides = {}
): BugReportPayload {
  const ts = overrides.timestamp ?? '2026-05-04T01:02:03.456Z';
  return {
    schemaVersion: overrides.schemaVersion ?? 1,
    timestamp: ts,
    appTag: overrides.appTag ?? 'lite',
    source: overrides.source ?? 'user-bug-report',
    version: overrides.version ?? '5.0.0',
    os: overrides.os ?? { platform: 'darwin', release: '23.5.0', arch: 'arm64' },
    description: overrides.description ?? 'a test bug',
    recentLogs: overrides.recentLogs ?? '',
    redactionTelemetry:
      overrides.redactionTelemetry ?? { bucket: 'none', countsByKind: {} },
    status: overrides.status ?? 'open',
    notes: overrides.notes ?? '',
    lastModified: overrides.lastModified ?? ts,
  };
}
