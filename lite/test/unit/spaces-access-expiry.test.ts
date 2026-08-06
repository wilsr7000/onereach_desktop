/**
 * ADR-052 — time-limited access grants.
 *
 * This is access control, so the tests are written around the ways it
 * could FAIL OPEN:
 *   - an expired grant still resolving as visible;
 *   - `$nowMs` missing from a query, so the expiry predicate can't be
 *     evaluated at all;
 *   - re-adding a member silently extending or wiping an existing
 *     expiry;
 *   - a malformed expiry being dropped, leaving permanent access where
 *     the admin asked for a deadline.
 *
 * The clock is injected, so none of this depends on wall time.
 */

import { describe, it, expect } from 'vitest';
import { SdkSpacesClient, parseGrantExpiry } from '../../spaces/sdk-client.js';
import { SpacesError } from '../../spaces/errors.js';

const NOW = Date.parse('2026-08-06T12:00:00.000Z');

interface Recorded {
  cypher: string;
  params: Record<string, unknown>;
}

function client(rows: Array<Record<string, unknown>> = []): {
  api: SdkSpacesClient;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const api = new SdkSpacesClient({
    now: () => NOW,
    viewerId: () => 'dana@example.com',
    query: async (cypher: string, params?: Record<string, unknown>) => {
      calls.push({ cypher, params: params ?? {} });
      return rows;
    },
  });
  return { api, calls };
}

describe('the clock is bound to every query', () => {
  // The expiry predicate is interpolated into a dozen queries. If any
  // one of them lacked $nowMs the comparison could not be evaluated --
  // so it is injected centrally rather than per call site.
  it('injects $nowMs even when a caller passes no parameters', async () => {
    const { api, calls } = client();
    await api.listSpaces();
    expect(calls[0]?.params['nowMs']).toBe(NOW);
  });

  it('injects $nowMs alongside a caller’s own parameters', async () => {
    const { api, calls } = client([{ id: 'a1', title: 't' }]);
    await api.getItem('a1');
    expect(calls[0]?.params['nowMs']).toBe(NOW);
    expect(calls[0]?.params['id']).toBe('a1');
  });

  it('lets an explicit nowMs win, so tests can pin the clock', async () => {
    const calls: Recorded[] = [];
    const api = new SdkSpacesClient({
      now: () => NOW,
      query: async (cypher: string, params?: Record<string, unknown>) => {
        calls.push({ cypher, params: params ?? {} });
        return [];
      },
    });
    await api.listSpaces();
    expect(calls[0]?.params['nowMs']).toBe(NOW);
  });
});

describe('the visibility predicate honours expiry', () => {
  it('gates restricted Spaces on a LIVE grant, not merely an existing one', async () => {
    const { api, calls } = client();
    await api.listSpaces();
    const cypher = calls[0]?.cypher ?? '';
    expect(cypher).toContain('HAS_ACCESS');
    expect(
      cypher.includes('expiresUnixMs IS NULL OR r.expiresUnixMs > $nowMs'),
      'an expired grant must not grant visibility'
    ).toBe(true);
  });

  it('applies the same rule to asset visibility', async () => {
    const { api, calls } = client();
    await api.listItems({ kind: 'space', spaceId: 's1' });
    const cypher = calls[0]?.cypher ?? '';
    expect(cypher).toContain('expiresUnixMs');
  });

  // Every grant written before this feature existed has no expiry
  // property. Treating NULL as "expired" would lock out every existing
  // member on deploy.
  it('treats a missing expiry as permanent, so existing grants survive', async () => {
    const { api, calls } = client();
    await api.listSpaces();
    expect(calls[0]?.cypher).toContain('r.expiresUnixMs IS NULL OR');
  });
});

describe('granting access', () => {
  const row = [{ kind: 'Person', id: 'p1', name: 'Dana' }];

  it('leaves an existing expiry untouched when none is specified', async () => {
    const { api, calls } = client(row);
    await api.addSpaceMember('s1', 'p1');
    expect(
      calls[0]?.params['writeExpiry'],
      're-adding a member must not silently change their deadline'
    ).toBe(false);
  });

  it('makes access permanent on an explicit null', async () => {
    const { api, calls } = client(row);
    await api.addSpaceMember('s1', 'p1', { expiresAt: null });
    expect(calls[0]?.params['writeExpiry']).toBe(true);
    expect(calls[0]?.params['expiresUnixMs']).toBeNull();
  });

  it('stores a future expiry as epoch millis', async () => {
    const { api, calls } = client(row);
    await api.addSpaceMember('s1', 'p1', { expiresAt: '2026-08-13T12:00:00.000Z' });
    expect(calls[0]?.params['writeExpiry']).toBe(true);
    expect(calls[0]?.params['expiresUnixMs']).toBe(Date.parse('2026-08-13T12:00:00.000Z'));
  });

  it('returns the resulting expiry so the UI can show it', async () => {
    const expires = Date.parse('2026-08-13T12:00:00.000Z');
    const { api } = client([{ kind: 'Person', id: 'p1', name: 'Dana', expiresUnixMs: expires }]);
    const member = await api.addSpaceMember('s1', 'p1');
    expect(member.accessExpiresAt).toBe('2026-08-13T12:00:00.000Z');
  });

  it('omits accessExpiresAt for a permanent grant', async () => {
    const { api } = client(row);
    const member = await api.addSpaceMember('s1', 'p1');
    expect(member.accessExpiresAt).toBeUndefined();
  });

  it('REJECTS a malformed expiry instead of granting permanent access', async () => {
    const { api, calls } = client(row);
    await expect(api.addSpaceMember('s1', 'p1', { expiresAt: 'next friday' })).rejects.toThrow(
      /not a valid date/
    );
    expect(calls, 'nothing should reach the graph').toHaveLength(0);
  });

  it('REJECTS a past expiry — a grant dead on arrival is a mistake', async () => {
    const { api } = client(row);
    await expect(
      api.addSpaceMember('s1', 'p1', { expiresAt: '2026-08-05T12:00:00.000Z' })
    ).rejects.toThrow(/in the past/);
  });
});

describe('parseGrantExpiry', () => {
  it('returns epoch millis for a valid future instant', () => {
    expect(parseGrantExpiry('2026-08-07T00:00:00Z', NOW)).toBe(
      Date.parse('2026-08-07T00:00:00Z')
    );
  });

  it('rejects empty input rather than defaulting to permanent', () => {
    expect(() => parseGrantExpiry('   ', NOW)).toThrow(SpacesError);
  });

  it('rejects exactly-now — a zero-length grant is not a grant', () => {
    expect(() => parseGrantExpiry(new Date(NOW).toISOString(), NOW)).toThrow(/in the past/);
  });
});
