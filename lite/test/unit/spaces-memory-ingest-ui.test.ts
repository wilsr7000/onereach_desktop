/**
 * Spaces renderer — agentic-memory surfaces (ADR-079).
 *
 * Pins the two user-visible halves of the ingestion feature inside the
 * Spaces window: the space context menu offers "Send to agentic
 * memory", and the metadata table renders the machine-written
 * `agenticMemory` flag as per-server ingested status ("flagged as
 * ingested or not" must be readable, not a JSON blob).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { buildSpaceContextEntries, formatIngestStatus } from '../../spaces/spaces.js';

function noopHandlers(): Parameters<typeof buildSpaceContextEntries>[1] {
  const h = (): void => undefined;
  return {
    share: h,
    unshare: h,
    addPeople: h,
    upload: h,
    rename: h,
    editObjective: h,
    convertShared: h,
    convertUser: h,
    setPlaybook: h,
    newJourney: h,
    sendToMemory: h,
    deleteSpace: h,
    togglePin: h,
  };
}

describe('space menu offers the ingestion action', () => {
  it('Send to agentic memory is present and wired', () => {
    let fired = 0;
    const handlers = { ...noopHandlers(), sendToMemory: () => void (fired += 1) };
    const entries = buildSpaceContextEntries(
      { id: 's1', name: 'X', visibility: 'open', kind: 'user' } as never,
      handlers
    );
    const entry = entries.find(
      (e) => e.type === 'action' && e.label === 'Send to agentic memory'
    );
    expect(entry, 'menu entry missing').toBeDefined();
    (entry as { run: () => void }).run();
    expect(fired).toBe(1);
  });
});

describe('formatIngestStatus', () => {
  const flag = (sha: string): string =>
    JSON.stringify({
      'srv-1': { sha, at: '2026-08-28T01:00:00.000Z', name: 'Team memory' },
    });

  it('renders per-server ingested lines with an up-to-date verdict when the hash matches', () => {
    const out = formatIngestStatus(flag('abc'), { contentSha256: 'abc' });
    expect(out).toContain('Team memory — ingested');
    expect(out).toContain('(up-to-date)');
  });

  it('flags a changed hash as stale', () => {
    const out = formatIngestStatus(flag('old'), { contentSha256: 'new' });
    expect(out).toContain('(stale — will re-send)');
  });

  it('gives no verdict when the item has no stamped hash to compare', () => {
    const out = formatIngestStatus(flag('abc'), {});
    expect(out).toContain('ingested');
    expect(out).not.toContain('up-to-date');
    expect(out).not.toContain('stale');
  });

  it('lists every server on its own line', () => {
    const raw = JSON.stringify({
      a: { sha: 'x', at: '2026-08-28T01:00:00.000Z', name: 'First' },
      b: { sha: 'x', at: '2026-08-28T01:00:00.000Z', name: 'Second' },
    });
    const out = formatIngestStatus(raw, {});
    expect(out?.split('\n')).toHaveLength(2);
  });

  it('falls back to null on malformed or empty values', () => {
    expect(formatIngestStatus('not json', {})).toBeNull();
    expect(formatIngestStatus('{}', {})).toBeNull();
    expect(formatIngestStatus('[1]', {})).toBeNull();
    expect(formatIngestStatus(42, {})).toBeNull();
  });
});
