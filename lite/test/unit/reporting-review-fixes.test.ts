/**
 * 2026-08-07 reporting review (feedback #5) + the 0.0.40 delta-review
 * fixes on the Home-URL feature.
 *
 * Covers: the updater's install-failure → pre-filled bug report chain,
 * the telemetry sent-marker (rollup visibility), the diagnostics
 * describeRollupState copy, resolveHomeUrl hardening, and the
 * no-URL-in-logs invariant as BEHAVIOR (the old test pinned a comment).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyUpdateOnStartup } from '../../updater/verify.js';
import { writeUpdateState } from '../../updater/state.js';
import {
  readSentMarker,
  recordRollupOutcome,
  EMPTY_SENT_MARKER,
} from '../../telemetry/sent-marker.js';
import { resolveHomeUrl } from '../../main-window/home-url-store.js';

describe('updater install failure → pre-filled bug report', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'updater-verify-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const logger = { info: (): void => {}, warn: (): void => {} };

  it('the Report a Bug button hands a structured trail to the dep and keeps state', async () => {
    writeUpdateState(dir, {
      failedAttempts: 1,
      lastAttemptVersion: '0.0.40',
      lastAttemptTime: '2026-08-07T10:00:00Z',
      lastFailedVersions: [],
    });
    let received: string | null = null;
    const result = await verifyUpdateOnStartup({
      userDataPath: dir,
      currentVersion: '0.0.39',
      openReleasesPage: () => {},
      triggerCheck: () => {},
      openBugReport: (prefill) => {
        received = prefill;
      },
      dialogs: { showFailureDialog: async () => 2 }, // "Report a Bug…"
      logger,
    });
    expect(result.outcome).toBe('install-failed');
    expect(received).not.toBeNull();
    const trail = received ?? '';
    expect(trail).toContain('Target version: 0.0.40');
    expect(trail).toContain('Still running: 0.0.39');
    expect(trail).toContain('Consecutive failures');
    // Reporting is not resolving: the state survives for the next boot.
    expect(result.after.lastAttemptVersion).toBe('0.0.40');
  });

  it('a missing openBugReport dep cannot crash the flow', async () => {
    writeUpdateState(dir, {
      failedAttempts: 0,
      lastAttemptVersion: '0.0.40',
      lastAttemptTime: null,
      lastFailedVersions: [],
    });
    const result = await verifyUpdateOnStartup({
      userDataPath: dir,
      currentVersion: '0.0.39',
      openReleasesPage: () => {},
      triggerCheck: () => {},
      dialogs: { showFailureDialog: async () => 2 },
      logger,
    });
    expect(result.outcome).toBe('install-failed');
  });

  it('a manually installed NEWER version clears the trail — no dialog, no recount', async () => {
    writeUpdateState(dir, {
      failedAttempts: 4,
      lastAttemptVersion: '0.0.46',
      lastAttemptTime: '2026-08-10T03:17:36.107Z',
      lastFailedVersions: ['0.0.46'],
    });
    let dialogShown = false;
    const result = await verifyUpdateOnStartup({
      userDataPath: dir,
      currentVersion: '0.0.47',
      openReleasesPage: () => {},
      triggerCheck: () => {},
      dialogs: {
        showFailureDialog: async () => {
          dialogShown = true;
          return 3;
        },
      },
      logger,
    });
    expect(result.outcome).toBe('install-succeeded');
    expect(result.after.failedAttempts).toBe(0);
    expect(result.after.lastAttemptVersion).toBeNull();
    expect(result.after.lastFailedVersions).toEqual([]);
    expect(dialogShown).toBe(false);
  });

  it('Skip moved to response 3 and still leaves state', async () => {
    writeUpdateState(dir, {
      failedAttempts: 0,
      lastAttemptVersion: '0.0.40',
      lastAttemptTime: null,
      lastFailedVersions: [],
    });
    const result = await verifyUpdateOnStartup({
      userDataPath: dir,
      currentVersion: '0.0.39',
      openReleasesPage: () => {},
      triggerCheck: () => {},
      dialogs: { showFailureDialog: async () => 3 },
      logger,
    });
    expect(result.after.lastAttemptVersion).toBe('0.0.40');
  });
});

describe('telemetry sent-marker (rollup visibility)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sent-marker-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips outcomes; only "sent" advances lastSentDay', () => {
    expect(readSentMarker(dir)).toEqual(EMPTY_SENT_MARKER);
    recordRollupOutcome(dir, 'failed', '2026-08-05', '2026-08-06T00:01:00Z');
    let marker = readSentMarker(dir);
    expect(marker.lastSentDay).toBeNull();
    expect(marker.lastOutcome).toBe('failed');
    recordRollupOutcome(dir, 'sent', '2026-08-06', '2026-08-07T00:01:00Z');
    marker = readSentMarker(dir);
    expect(marker.lastSentDay).toBe('2026-08-06');
    expect(marker.lastOutcome).toBe('sent');
    // A later failure keeps the last SUCCESS day.
    recordRollupOutcome(dir, 'failed', '2026-08-07', '2026-08-08T00:01:00Z');
    marker = readSentMarker(dir);
    expect(marker.lastSentDay).toBe('2026-08-06');
    expect(marker.lastOutcome).toBe('failed');
  });

  it('corrupt marker file degrades to empty, never throws', async () => {
    const fs = await import('node:fs');
    fs.writeFileSync(path.join(dir, 'telemetry-sent-marker.json'), '{nope');
    expect(readSentMarker(dir)).toEqual(EMPTY_SENT_MARKER);
  });
});

describe('resolveHomeUrl hardening (0.0.40 review LOW#7)', () => {
  it('replaces EVERY {accountId} occurrence, URL-encoded', () => {
    const got = resolveHomeUrl(
      'https://x.test/a?u={accountId}&again={accountId}',
      'id with spaces&x'
    );
    expect(got).toBe(
      'https://x.test/a?u=id%20with%20spaces%26x&again=id%20with%20spaces%26x'
    );
  });

  it('is immune to $-pattern expansion in the account id', () => {
    const got = resolveHomeUrl('https://x.test/?a={accountId}', 'id$&tail');
    expect(got).toContain(encodeURIComponent('id$&tail'));
    expect(got).not.toContain('{accountId}');
  });

  it('null account id substitutes empty on every occurrence', () => {
    expect(resolveHomeUrl('https://x.test/{accountId}/{accountId}', null)).toBe(
      'https://x.test//'
    );
  });
});

describe('remote-home mount invariants (source-level)', () => {
  const read = (rel: string): string => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const p = require('node:path') as typeof import('node:path');
    const candidates = [p.resolve(rel), p.resolve('lite', rel)];
    const found = candidates.find((f) => fs.existsSync(f));
    if (found === undefined) throw new Error(`${rel} not found`);
    return fs.readFileSync(found, 'utf8');
  };

  it('the loadURL rejection never logs err.message (it embeds the URL)', () => {
    const src = read('main-window/window.ts');
    const start = src.indexOf("'remote home initial load rejected'");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start - 400, start + 400);
    // Structured fields only — Electron's rejection message contains
    // the full URL including the room-key fragment (0.0.40 review HIGH).
    expect(block).not.toContain('(err as Error).message');
    expect(block).toContain('errno');
  });

  it('the permission handler installs unconditionally and denies by default', () => {
    const src = read('main-window/window.ts');
    const start = src.indexOf('let allowedOrigin: string | null = null;');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 1400);
    expect(block).toContain('setPermissionRequestHandler');
    expect(block).toContain('details.requestingUrl');
    expect(block).toMatch(/callback\(false\)/);
  });

  it('subframe failures do not blank Home; a later success re-shows it', () => {
    const src = read('main-window/window.ts');
    const start = src.indexOf("'remote home failed to load; revealing boot-chat home'");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start - 700, start + 100);
    expect(block).toContain('isMainFrame');
    expect(src).toContain("view.webContents.on('did-finish-load'");
  });

  it('the bug-modal prefill only fills an empty textarea', () => {
    const src = read('bug-report/modal.ts');
    expect(src).toContain('getPrefill()');
    expect(src).toContain("descriptionInput.value.trim().length === 0");
  });
});
