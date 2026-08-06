/**
 * Per-asset bucket privacy and TTL on `items.createBinary`.
 *
 * The default is the whole point: an asset is PRIVATE unless the caller
 * explicitly says otherwise. The failure mode of getting this wrong is
 * publishing a user's file to the world, so `isPublic` is tested
 * against every sloppy-truthy value that could cross an IPC boundary,
 * not just `undefined`.
 *
 * The second theme is that the bucket is part of the file's IDENTITY. A
 * key written to the public bucket cannot be read or deleted as
 * private, so the choice must be (a) recorded on the asset and (b) used
 * by the orphan-cleanup path.
 */

import { describe, it, expect } from 'vitest';
import { createBinaryAsset, normalizeExpiresAt } from '../../spaces/create-binary.js';
import type { CreateBinaryDeps } from '../../spaces/create-binary.js';
import type { CreateAssetInput, Item } from '../../spaces/types.js';

interface Recorded {
  uploadOptions?: Record<string, unknown>;
  createInput?: CreateAssetInput;
  deleteCalls: Array<{ key: string; options?: { isPublic?: boolean } }>;
  warnings: string[];
}

function deps(over: { failCreate?: boolean } = {}): { deps: CreateBinaryDeps; rec: Recorded } {
  const rec: Recorded = { deleteCalls: [], warnings: [] };
  return {
    rec,
    deps: {
      files: {
        upload: async (_prefix, _name, _content, options): Promise<string> => {
          rec.uploadOptions = options as Record<string, unknown>;
          return 'key';
        },
        delete: async (key, options): Promise<void> => {
          rec.deleteCalls.push({ key, ...(options !== undefined ? { options } : {}) });
        },
      },
      createAsset: async (input): Promise<Item> => {
        rec.createInput = input;
        if (over.failCreate === true) throw new Error('graph write rejected');
        return { id: 'i1', title: input.title } as unknown as Item;
      },
      warn: (message) => rec.warnings.push(message),
      uniqueNameFor: (n) => n,
    },
  };
}

const BASE = {
  spaceId: 's1',
  title: 'Doc',
  fileName: 'doc.pdf',
  bytes: new Uint8Array([1, 2, 3]),
};

describe('createBinary — private by default', () => {
  it('uploads to the PRIVATE bucket when isPublic is not given', async () => {
    const { deps: d, rec } = deps();
    await createBinaryAsset(d, { ...BASE });
    expect(rec.uploadOptions?.['isPublic']).toBe(false);
  });

  it('does not stamp fileIsPublic on a private asset', async () => {
    const { deps: d, rec } = deps();
    await createBinaryAsset(d, { ...BASE });
    expect(rec.createInput?.metadata?.['fileIsPublic']).toBeUndefined();
  });

  // Anything that isn't a literal `true` must stay private. These are
  // the shapes that realistically arrive from a checkbox, a form value,
  // or a JSON round-trip across IPC.
  const SLOPPY: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['string "true"', 'true'],
    ['string "false"', 'false'],
    ['number 1', 1],
    ['empty string', ''],
    ['object', {}],
  ];
  for (const [label, value] of SLOPPY) {
    it(`stays PRIVATE when isPublic is ${label}`, async () => {
      const { deps: d, rec } = deps();
      // Cast the whole input: these values are exactly the ones the
      // type system is meant to prevent, and the point of the test is
      // that the RUNTIME check holds when they arrive anyway (e.g. via
      // an IPC JSON round-trip, which erases types entirely).
      await createBinaryAsset(d, { ...BASE, isPublic: value } as Parameters<
        typeof createBinaryAsset
      >[1]);
      expect(rec.uploadOptions?.['isPublic'], `${label} must not publish`).toBe(false);
    });
  }

  it('publishes only on an explicit true, and records it on the asset', async () => {
    const { deps: d, rec } = deps();
    await createBinaryAsset(d, { ...BASE, isPublic: true });
    expect(rec.uploadOptions?.['isPublic']).toBe(true);
    // Without this the file is unreadable later -- resolve/delete would
    // look in the private bucket.
    expect(rec.createInput?.metadata?.['fileIsPublic']).toBe(true);
  });

  it('cleans up an orphan from the SAME bucket it uploaded to', async () => {
    const { deps: d, rec } = deps({ failCreate: true });
    await expect(createBinaryAsset(d, { ...BASE, isPublic: true })).rejects.toThrow();
    expect(rec.deleteCalls).toHaveLength(1);
    expect(
      rec.deleteCalls[0]?.options?.isPublic,
      'deleting from the wrong bucket leaves a public orphan nobody knows about'
    ).toBe(true);
  });

  it('preserves caller metadata alongside the privacy stamp', async () => {
    const { deps: d, rec } = deps();
    await createBinaryAsset(d, { ...BASE, isPublic: true, metadata: { pages: 12 } });
    expect(rec.createInput?.metadata?.['pages']).toBe(12);
    expect(rec.createInput?.metadata?.['fileIsPublic']).toBe(true);
  });
});

describe('createBinary — TTL', () => {
  it('sets no expiry by default', async () => {
    const { deps: d, rec } = deps();
    await createBinaryAsset(d, { ...BASE });
    expect(rec.uploadOptions?.['expiresAt']).toBeUndefined();
    expect(rec.createInput?.metadata?.['fileExpiresAt']).toBeUndefined();
  });

  it('passes a valid expiry to the bucket and mirrors it for display', async () => {
    const { deps: d, rec } = deps();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await createBinaryAsset(d, { ...BASE, expiresAt: future });
    expect(rec.uploadOptions?.['expiresAt']).toBe(future);
    expect(rec.createInput?.metadata?.['fileExpiresAt']).toBe(future);
  });

  it('combines TTL with public', async () => {
    const { deps: d, rec } = deps();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await createBinaryAsset(d, { ...BASE, isPublic: true, expiresAt: future });
    expect(rec.uploadOptions?.['isPublic']).toBe(true);
    expect(rec.uploadOptions?.['expiresAt']).toBe(future);
  });

  it('REJECTS a malformed expiry rather than dropping it', async () => {
    const { deps: d, rec } = deps();
    await expect(createBinaryAsset(d, { ...BASE, expiresAt: 'next tuesday' })).rejects.toThrow(
      /not a valid date/
    );
    // Nothing was uploaded -- the failure happens before any side effect.
    expect(rec.uploadOptions).toBeUndefined();
  });

  it('REJECTS a past expiry — an upload that means "delete now" is a mistake', async () => {
    const { deps: d } = deps();
    const past = new Date(Date.now() - 1000).toISOString();
    await expect(createBinaryAsset(d, { ...BASE, expiresAt: past })).rejects.toThrow(/in the past/);
  });

  it('REJECTS an empty expiry rather than treating it as "no expiry"', async () => {
    const { deps: d } = deps();
    await expect(createBinaryAsset(d, { ...BASE, expiresAt: '   ' })).rejects.toThrow(
      /non-empty ISO-8601/
    );
  });
});

describe('normalizeExpiresAt', () => {
  const NOW = Date.parse('2026-08-06T12:00:00.000Z');

  it('passes undefined through — no expiry is the default', () => {
    expect(normalizeExpiresAt(undefined, NOW)).toBeUndefined();
  });

  it('canonicalizes a valid future date to ISO', () => {
    expect(normalizeExpiresAt('2026-08-07T00:00:00Z', NOW)).toBe('2026-08-07T00:00:00.000Z');
  });

  it('rejects exactly-now as past — a zero-length TTL is not a TTL', () => {
    expect(() => normalizeExpiresAt(new Date(NOW).toISOString(), NOW)).toThrow(/in the past/);
  });
});
