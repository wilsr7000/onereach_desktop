/**
 * Honest write refusals (2026-08-20, the "add assets broke" report).
 *
 * The 0.0.77 outage taught two lessons. The first (an invisible byte
 * broke the guard itself) is pinned in
 * spaces-writable-guard-runtime.test.ts. This file pins the second:
 * when a guarded write IS refused, the error must say why. Every
 * refusal used to read "Space not found" — for a read-only member or a
 * lapsed grant that is a lie, and it costs whoever debugs it a session
 * of hunting for a Space that is right there on screen.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SdkSpacesClient } from '../../spaces/sdk-client.js';

const sdkSource = (): string => {
  const found = ['spaces/sdk-client.ts', 'lite/spaces/sdk-client.ts']
    .map((p) => resolve(p))
    .find((p) => existsSync(p));
  if (found === undefined) throw new Error('sdk-client.ts not found');
  return readFileSync(found, 'utf8');
};

/**
 * A client whose graph is scripted per-query: the mutation always
 * matches nothing; the refusal probe answers as the case dictates.
 */
function clientWith(
  probeRows: Array<Record<string, unknown>>,
  viewerId: string | null = 'rich@onereach.com'
): SdkSpacesClient {
  return new SdkSpacesClient({
    query: (cypher: string): Promise<Array<Record<string, unknown>>> => {
      if (cypher.includes('AS canWrite')) return Promise.resolve(probeRows);
      return Promise.resolve([]); // every mutation matches nothing
    },
    viewerId: () => viewerId,
  });
}

const create = (c: SdkSpacesClient): Promise<unknown> =>
  c.createAsset({ spaceId: 'space-1', title: 'T', kind: 'text', content: 'x' } as never);
// kind 'text' rides the note-citizen path — the most common add, so the
// classifier is exercised where Rich actually hit it.

describe('the refusal classifier', () => {
  it('read-only member: names the role and the fix, never "not found"', async () => {
    const c = clientWith([{ canWrite: false, role: 'reader', grantExpired: false, name: 'Data Bricks' }]);
    await expect(create(c)).rejects.toMatchObject({
      code: 'SPACES_FORBIDDEN',
      message: expect.stringContaining('read-only member of "Data Bricks"'),
      remediation: expect.stringContaining('change your role'),
    });
  });

  it('not a member: says so and points at Add people', async () => {
    const c = clientWith([{ canWrite: false, role: 'writer', grantExpired: false, name: 'Payments Ops' }]);
    await expect(create(c)).rejects.toMatchObject({
      code: 'SPACES_FORBIDDEN',
      message: expect.stringContaining('not a writer in "Payments Ops"'),
      remediation: expect.stringContaining('Add people'),
    });
  });

  it('expired grant: says expired, not vanished', async () => {
    const c = clientWith([{ canWrite: false, role: 'writer', grantExpired: true, name: 'Ops' }]);
    await expect(create(c)).rejects.toMatchObject({
      code: 'SPACES_FORBIDDEN',
      message: expect.stringContaining('expired'),
    });
  });

  it('signed out: NOT_AUTHENTICATED before any probe', async () => {
    const c = clientWith([], '');
    await expect(create(c)).rejects.toMatchObject({
      code: 'SPACES_NOT_AUTHENTICATED',
      remediation: expect.stringContaining('Sign in'),
    });
  });

  it('invisible or missing Space: stays an honest "not found"', async () => {
    const c = clientWith([]); // probe sees nothing the viewer may know about
    await expect(create(c)).rejects.toMatchObject({
      code: 'SPACES_NOT_FOUND',
    });
  });

  it('guard passes on re-probe: reported as transient, not as no-access', async () => {
    const c = clientWith([{ canWrite: true, role: 'writer', grantExpired: false, name: 'S' }]);
    await expect(create(c)).rejects.toMatchObject({
      code: 'SPACES_CYPHER',
      remediation: expect.stringContaining('Try again'),
    });
  });
});

describe('the wiring', () => {
  it('the whole add lane classifies: create, addToSpace, moveToSpace', () => {
    const s = sdkSource();
    for (const op of ['items.create', 'items.addToSpace', 'items.moveToSpace']) {
      expect(s, `${op} does not classify its refusal`).toContain(
        `throwWriteRefusal(${op === 'items.create' ? 'targetSpaceId' : 'toSpaceId'}, '${op}')`
      );
    }
  });

  it('the probe itself is visibility-gated — no existence leak to outsiders', () => {
    const s = sdkSource();
    const i = s.indexOf('EXPLAIN_WRITE_REFUSAL: `');
    expect(i).toBeGreaterThan(-1);
    const block = s.slice(i, i + 900);
    expect(block).toContain('SPACE_VISIBLE');
    expect(block).toContain('AS canWrite');
  });
});
