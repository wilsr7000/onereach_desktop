import { describe, it, expect } from 'vitest';
import { createBinaryAsset, type CreateBinaryDeps } from '../../spaces/create-binary.js';
import { SpacesError } from '../../spaces/errors.js';
import {
  SPACES_ASSETS_PREFIX,
  MAX_BINARY_ASSET_BYTES,
} from '../../spaces/binary-asset.js';
import type { Item } from '../../spaces/types.js';

const ITEM = { id: 'a-1', title: 'T' } as unknown as Item;
const BYTES = new TextEncoder().encode('FILEBYTES').buffer as ArrayBuffer;

interface Recorded {
  uploads: Array<{ prefix: string; fileName: string; bytes: Buffer; options?: unknown }>;
  deletes: string[];
  creates: unknown[];
  warns: string[];
}

function makeDeps(over: {
  createFails?: boolean;
  deleteFails?: boolean;
  uploadFails?: Error;
} = {}): { deps: CreateBinaryDeps; rec: Recorded } {
  const rec: Recorded = { uploads: [], deletes: [], creates: [], warns: [] };
  const deps: CreateBinaryDeps = {
    files: {
      upload: async (prefix, fileName, bytes, options) => {
        if (over.uploadFails !== undefined) throw over.uploadFails;
        rec.uploads.push({ prefix, fileName, bytes, options });
        return `https://signed.example/${prefix}/${fileName}`;
      },
      delete: async (key) => {
        if (over.deleteFails === true) throw new Error('bucket busy');
        rec.deletes.push(key);
      },
    },
    createAsset: async (input) => {
      rec.creates.push(input);
      if (over.createFails === true) throw new Error('graph down');
      return ITEM;
    },
    warn: (message) => {
      rec.warns.push(message);
    },
    uniqueNameFor: (name) => `uuid-${name}`,
  };
  return { deps, rec };
}

const INPUT = {
  spaceId: 's-1',
  title: 'Chart',
  kind: 'image' as const,
  fileName: 'chart.png',
  mimeType: 'image/png',
  bytes: BYTES,
};

describe('createBinaryAsset', () => {
  it('uploads to GSX first, then creates the node with the fileKey (no inline content)', async () => {
    const { deps, rec } = makeDeps();
    const out = await createBinaryAsset(deps, INPUT);

    expect(out).toBe(ITEM);
    expect(rec.uploads).toHaveLength(1);
    const up = rec.uploads[0]!;
    expect(up.prefix).toBe(SPACES_ASSETS_PREFIX);
    expect(up.fileName).toBe('uuid-chart.png');
    expect(up.bytes.toString()).toBe('FILEBYTES');
    expect(up.options).toMatchObject({
      contentType: 'image/png',
      rewriteMode: 'prevent-rewrite',
    });

    expect(rec.creates).toHaveLength(1);
    expect(rec.creates[0]).toMatchObject({
      spaceId: 's-1',
      title: 'Chart',
      kind: 'image',
      fileKey: `${SPACES_ASSETS_PREFIX}/uuid-chart.png`,
      mimeType: 'image/png',
      size: 9,
    });
    // Inline content must never be part of the graph payload.
    expect(rec.creates[0]).not.toHaveProperty('content');
    expect(rec.deletes).toHaveLength(0);
  });

  it('defaults kind to "other" and contentType to octet-stream', async () => {
    const { deps, rec } = makeDeps();
    await createBinaryAsset(deps, {
      spaceId: 's-1',
      title: 'Blob',
      fileName: 'x.bin',
      bytes: BYTES,
    });
    expect(rec.creates[0]).toMatchObject({
      kind: 'other',
      mimeType: 'application/octet-stream',
    });
  });

  it('rejects an empty fileName before touching GSX', async () => {
    const { deps, rec } = makeDeps();
    await expect(
      createBinaryAsset(deps, { ...INPUT, fileName: '  ' })
    ).rejects.toMatchObject({ code: 'SPACES_INVALID_INPUT' });
    expect(rec.uploads).toHaveLength(0);
    expect(rec.creates).toHaveLength(0);
  });

  it('rejects empty bytes before touching GSX', async () => {
    const { deps, rec } = makeDeps();
    await expect(
      createBinaryAsset(deps, { ...INPUT, bytes: new ArrayBuffer(0) })
    ).rejects.toMatchObject({ code: 'SPACES_INVALID_INPUT' });
    expect(rec.uploads).toHaveLength(0);
  });

  it('rejects an over-cap payload before touching GSX', async () => {
    const { deps, rec } = makeDeps();
    // One real (zero-filled) allocation just over the cap. Buffer is a
    // Uint8Array, so it flows through toBuffer without copying.
    const overCap = Buffer.alloc(MAX_BINARY_ASSET_BYTES + 1);
    const err = await createBinaryAsset(deps, {
      ...INPUT,
      bytes: overCap,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpacesError);
    expect((err as SpacesError).code).toBe('SPACES_INVALID_INPUT');
    expect((err as SpacesError).message).toMatch(/100 MB/);
    expect(rec.uploads).toHaveLength(0);
  });

  it('cleans up the uploaded file when the graph create fails, then rethrows', async () => {
    const { deps, rec } = makeDeps({ createFails: true });
    await expect(createBinaryAsset(deps, INPUT)).rejects.toThrow('graph down');
    expect(rec.uploads).toHaveLength(1);
    expect(rec.deletes).toEqual([`${SPACES_ASSETS_PREFIX}/uuid-chart.png`]);
  });

  it('swallows a cleanup failure (warn) and still rethrows the create error', async () => {
    const { deps, rec } = makeDeps({ createFails: true, deleteFails: true });
    await expect(createBinaryAsset(deps, INPUT)).rejects.toThrow('graph down');
    expect(rec.warns.some((w) => w.includes('orphan cleanup failed'))).toBe(true);
  });

  it('propagates an upload failure without touching the graph', async () => {
    const { deps, rec } = makeDeps({
      uploadFails: Object.assign(new Error('no session'), {
        code: 'FILES_NOT_AUTHENTICATED',
      }),
    });
    await expect(createBinaryAsset(deps, INPUT)).rejects.toThrow('no session');
    expect(rec.creates).toHaveLength(0);
    expect(rec.deletes).toHaveLength(0);
  });

  it('passes description / creator / metadata through to the graph create', async () => {
    const { deps, rec } = makeDeps();
    await createBinaryAsset(deps, {
      ...INPUT,
      description: 'desc',
      creatorId: 'p-9',
      metadata: { width: 820 },
    });
    expect(rec.creates[0]).toMatchObject({
      description: 'desc',
      creatorId: 'p-9',
      metadata: { width: 820 },
    });
  });

  it('generates a real uuid name when no override is provided', async () => {
    const { deps, rec } = makeDeps();
    delete (deps as { uniqueNameFor?: unknown }).uniqueNameFor;
    await createBinaryAsset(deps, INPUT);
    expect(rec.uploads[0]!.fileName).toMatch(/^[0-9a-f-]{36}-chart\.png$/);
  });
});
