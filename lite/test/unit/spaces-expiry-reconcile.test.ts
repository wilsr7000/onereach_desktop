/**
 * Reconciling our TTL stamp against the bucket's real schedule.
 *
 * `metadata.fileExpiresAt` records only what Lite ASKED for at upload.
 * The bucket is what actually deletes, and it reports its schedule on
 * every read — a field this app parsed and then discarded on every
 * request until now.
 *
 * The two disagreeing is not an edge case to smooth over, it is the
 * signal:
 *   - a bucket expiry we never stamped means something OUTSIDE Lite
 *     scheduled the file for deletion — the exact shape of "the bytes
 *     vanished but the graph node survived";
 *   - a stamp with no bucket expiry means the UI promised an
 *     auto-delete that will never happen.
 *
 * Both are reported rather than papered over.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { reconcileExpiry } from '../../spaces/spaces.js';

describe('reconcileExpiry', () => {
  it('says nothing when neither side has an expiry', () => {
    expect(reconcileExpiry(null, null)).toEqual({ effective: null, note: null });
  });

  it('is silent when the two agree', () => {
    const iso = '2026-09-01T00:00:00.000Z';
    expect(reconcileExpiry(iso, iso)).toEqual({ effective: iso, note: null });
  });

  // Clock skew and rounding between our stamp and the bucket's record
  // shouldn't read as a discrepancy.
  it('tolerates sub-minute drift between the two', () => {
    const a = '2026-09-01T00:00:00.000Z';
    const b = '2026-09-01T00:00:30.000Z';
    expect(reconcileExpiry(a, b).note).toBeNull();
    expect(reconcileExpiry(a, b).effective).toBe(b);
  });

  // THE diagnostic case.
  it('flags a bucket expiry that Lite never set', () => {
    const r = reconcileExpiry(null, '2026-09-01T00:00:00.000Z');
    expect(r.effective).toBe('2026-09-01T00:00:00.000Z');
    expect(r.note).toContain('outside Onereach.ai Lite');
  });

  it('flags a stamp the bucket does not honour — the file will NOT auto-delete', () => {
    const r = reconcileExpiry('2026-09-01T00:00:00.000Z', null);
    expect(r.effective, 'the bucket is the authority; show no expiry').toBeNull();
    expect(r.note).toContain('will not auto-delete');
  });

  it('flags a real mismatch and trusts the bucket', () => {
    const r = reconcileExpiry('2026-09-01T00:00:00.000Z', '2026-12-25T00:00:00.000Z');
    expect(r.effective, 'the bucket deletes, so the bucket wins').toBe(
      '2026-12-25T00:00:00.000Z'
    );
    expect(r.note).toContain('differs from what was requested');
  });

  it('never invents an expiry the bucket does not have', () => {
    for (const stamped of [null, '2026-09-01T00:00:00.000Z']) {
      expect(reconcileExpiry(stamped, null).effective).toBeNull();
    }
  });
});
