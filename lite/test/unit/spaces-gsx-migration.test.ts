import { describe, it, expect } from 'vitest';
import {
  runGsxMigration,
  type GsxMigrationDeps,
} from '../../spaces/gsx-migration.js';
import type { InlineBinaryAssetRow } from '../../spaces/sdk-client.js';

const b64 = (s: string): string => Buffer.from(s).toString('base64');

function row(id: string, over: Partial<InlineBinaryAssetRow> = {}): InlineBinaryAssetRow {
  return {
    id,
    content: `data:image/png;base64,${b64(`bytes-of-${id}`)}`,
    title: `${id}.png`,
    mimeType: 'image/png',
    ...over,
  };
}

interface Rec {
  uploads: Array<{ prefix: string; fileName: string; bytes: string; contentType?: string }>;
  converts: Array<{ id: string; fileKey: string; size: number }>;
  events: Array<{ name: string; data: unknown }>;
  spans: Array<{ op: 'finish' | 'fail'; data?: unknown }>;
}

/**
 * Build injectable deps around a scripted sequence of list() pages.
 * Conversion removes rows from subsequent pages automatically unless
 * `convertFails` includes the id (mirrors the real predicate cursor).
 */
function makeDeps(initialRows: InlineBinaryAssetRow[], over: {
  uploadFailsFor?: Record<string, Error>;
  convertFalseFor?: string[];
  convertThrowsFor?: string[];
  listThrows?: Error;
  maxItems?: number;
} = {}): { deps: GsxMigrationDeps; rec: Rec } {
  const rec: Rec = { uploads: [], converts: [], events: [], spans: [] };
  const remaining = new Map(initialRows.map((r) => [r.id, r]));

  const deps: GsxMigrationDeps = {
    client: {
      listInlineBinaryAssets: async (limit = 25) => {
        if (over.listThrows !== undefined) throw over.listThrows;
        return [...remaining.values()].slice(0, limit);
      },
      convertInlineAssetToFile: async (id, fileKey, size) => {
        if (over.convertThrowsFor?.includes(id) === true) throw new Error('convert down');
        if (over.convertFalseFor?.includes(id) === true) return false;
        rec.converts.push({ id, fileKey, size });
        remaining.delete(id); // node no longer matches the predicate
        return true;
      },
    },
    files: {
      upload: async (prefix, fileName, bytes, options) => {
        // Fail-injection matches by the original asset id, which is
        // embedded in the generated unique file name via the title.
        for (const [id, err] of Object.entries(over.uploadFailsFor ?? {})) {
          if (fileName.includes(id)) throw err;
        }
        rec.uploads.push({
          prefix,
          fileName,
          bytes: bytes.toString(),
          ...(options?.contentType !== undefined ? { contentType: options.contentType } : {}),
        });
        return `https://signed.example/${prefix}/${fileName}`;
      },
    },
    log: {
      start: () => ({
        finish: (data?: unknown) => rec.spans.push({ op: 'finish', data }),
        fail: () => rec.spans.push({ op: 'fail' }),
      }),
      event: (name, data) => rec.events.push({ name, data }),
      info: () => undefined,
      warn: () => undefined,
    },
    ...(over.maxItems !== undefined ? { maxItems: over.maxItems } : {}),
  };
  return { deps, rec };
}

describe('runGsxMigration', () => {
  it('migrates every inline-stub asset: upload bytes, convert node, clear from cursor', async () => {
    const { deps, rec } = makeDeps([row('a1'), row('a2')]);
    const out = await runGsxMigration(deps);

    expect(out).toMatchObject({ scanned: 2, migrated: 2, failed: 0, aborted: false });
    expect(rec.uploads).toHaveLength(2);
    expect(rec.uploads[0]!.bytes).toBe('bytes-of-a1');
    expect(rec.uploads[0]!.contentType).toBe('image/png');
    expect(rec.converts).toHaveLength(2);
    // fileKey matches the uploaded prefix/name pair
    expect(rec.converts[0]!.fileKey).toBe(
      `${rec.uploads[0]!.prefix}/${rec.uploads[0]!.fileName}`
    );
    expect(rec.converts[0]!.size).toBe(Buffer.byteLength('bytes-of-a1'));
    // per-item events
    const outcomes = rec.events.map((e) => (e.data as { outcome: string }).outcome);
    expect(outcomes).toEqual(['migrated', 'migrated']);
    // span closed with counts
    expect(rec.spans).toEqual([
      { op: 'finish', data: { scanned: 2, migrated: 2, failed: 0 } },
    ]);
  });

  it('falls back to the data-URL media type when the node has none', async () => {
    const { deps, rec } = makeDeps([row('a1', { mimeType: '' })]);
    await runGsxMigration(deps);
    expect(rec.uploads[0]!.contentType).toBe('image/png');
  });

  it('skips undecodable content (counts failed, emits skipped, no upload)', async () => {
    const { deps, rec } = makeDeps([
      row('bad', { content: 'data:image/png;base64,@@@' }),
      row('good'),
    ]);
    const out = await runGsxMigration(deps);
    expect(out).toMatchObject({ scanned: 2, migrated: 1, failed: 1 });
    expect(rec.uploads).toHaveLength(1);
    const skipped = rec.events.find(
      (e) => (e.data as { outcome: string }).outcome === 'skipped'
    );
    expect((skipped?.data as { assetId: string }).assetId).toBe('bad');
  });

  it('a single upload failure never stops the sweep', async () => {
    const { deps, rec } = makeDeps([row('u1'), row('u2')], {
      uploadFailsFor: { u1: new Error('boom') },
    });
    const out = await runGsxMigration(deps);
    expect(out).toMatchObject({ migrated: 1, failed: 1, aborted: false });
    expect(rec.converts.map((c) => c.id)).toEqual(['u2']);
  });

  it('aborts quietly on FILES_NOT_AUTHENTICATED (retry next boot)', async () => {
    const { deps, rec } = makeDeps([row('u1'), row('u2')], {
      uploadFailsFor: {
        u1: Object.assign(new Error('no session'), { code: 'FILES_NOT_AUTHENTICATED' }),
      },
    });
    const out = await runGsxMigration(deps);
    expect(out.aborted).toBe(true);
    expect(out.migrated).toBe(0);
    expect(rec.converts).toHaveLength(0);
    // still closes the span cleanly
    expect(rec.spans[0]!.op).toBe('finish');
  });

  it('aborts quietly when the graph list throws (signed out / offline)', async () => {
    const { deps, rec } = makeDeps([], { listThrows: new Error('neon down') });
    const out = await runGsxMigration(deps);
    expect(out).toMatchObject({ scanned: 0, aborted: true });
    expect(rec.spans[0]!.op).toBe('finish');
  });

  it('a convert-false outcome counts as failed and does not loop forever', async () => {
    const { deps } = makeDeps([row('c1')], { convertFalseFor: ['c1'] });
    const out = await runGsxMigration(deps);
    expect(out).toMatchObject({ scanned: 1, migrated: 0, failed: 1 });
  });

  it('a convert-throw after upload counts as failed (warn path)', async () => {
    const { deps } = makeDeps([row('c1')], { convertThrowsFor: ['c1'] });
    const out = await runGsxMigration(deps);
    expect(out).toMatchObject({ scanned: 1, migrated: 0, failed: 1 });
  });

  it('terminates when the list keeps returning only already-failed rows', async () => {
    // convert always false -> row is never removed from the cursor; the
    // failedIds set must stop the loop rather than spin forever.
    const { deps } = makeDeps([row('stuck')], { convertFalseFor: ['stuck'] });
    const out = await runGsxMigration(deps);
    expect(out.scanned).toBe(1); // processed exactly once
  });

  it('honors the per-run item cap', async () => {
    const rows = Array.from({ length: 10 }, (_v, i) => row(`m${i}`));
    const { deps } = makeDeps(rows, { maxItems: 3 });
    const out = await runGsxMigration(deps);
    expect(out.scanned).toBe(3);
    expect(out.migrated).toBe(3);
  });

  it('empty graph -> clean zero-result finish', async () => {
    const { deps, rec } = makeDeps([]);
    const out = await runGsxMigration(deps);
    expect(out).toMatchObject({ scanned: 0, migrated: 0, failed: 0, aborted: false });
    expect(rec.spans).toEqual([
      { op: 'finish', data: { scanned: 0, migrated: 0, failed: 0 } },
    ]);
  });
});
