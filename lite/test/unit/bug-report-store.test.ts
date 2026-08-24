import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { BugReportStore } from '../../bug-report/store.js';
import { FakeKV, makeBugReportPayload } from '../harness/index.js';

// Local alias so existing test bodies that call `makePayload(...)` keep
// working; the harness factory accepts the same overrides.
const makePayload = makeBugReportPayload;

describe('BugReportStore.save', () => {
  let kv: FakeKV;
  let store: BugReportStore;

  beforeEach(() => {
    kv = new FakeKV();
    store = new BugReportStore({ kvApi: kv });
  });

  it('writes payload to KV under id=lite-bugs', async () => {
    const payload = makePayload({ description: 'happy path' });
    const result = await store.save(payload);

    expect(result.kvWritten).toBe(true);
    expect(result.kvError).toBeNull();
    expect(kv.sets).toHaveLength(1);
    expect(kv.sets[0]?.collection).toBe('lite-bugs');
    expect(kv.sets[0]?.key).toBe(payload.timestamp);
    expect(kv.sets[0]?.value).toEqual(payload);
  });

  it('throws when KV write fails (no fallback)', async () => {
    kv.failSet = true;
    const payload = makePayload();
    await expect(store.save(payload)).rejects.toThrow(/Bug report save failed/);
  });
});

describe('BugReportStore.list', () => {
  let kv: FakeKV;
  let store: BugReportStore;

  beforeEach(() => {
    kv = new FakeKV();
    store = new BugReportStore({ kvApi: kv });
  });

  it('returns sorted summaries (newest first)', async () => {
    const a = makePayload({ timestamp: '2026-05-04T00:00:00.000Z', description: 'older' });
    const b = makePayload({ timestamp: '2026-05-04T02:00:00.000Z', description: 'newer' });
    const c = makePayload({ timestamp: '2026-05-04T01:00:00.000Z', description: 'middle' });
    await store.save(a);
    await store.save(b);
    await store.save(c);

    const result = await store.list();
    expect(result.map((s) => s.descriptionPreview)).toEqual(['newer', 'middle', 'older']);
  });

  it('returns empty list when KV is empty', async () => {
    expect(await store.list()).toEqual([]);
  });

  it('returns empty list (no throw) when KV fails', async () => {
    kv.failList = true;
    const result = await store.list();
    expect(result).toEqual([]);
  });

  it('skips KV records that do not match BugReportPayload schema', async () => {
    await store.save(makePayload({ description: 'valid' }));
    // Inject a junk record directly
    kv.store.set('lite-bugs::junk-key', { not: 'a real payload' });
    kv.store.set('lite-bugs::null-key', null);

    const result = await store.list();
    expect(result.length).toBe(1);
    expect(result[0]?.descriptionPreview).toBe('valid');
  });

  it('summaries use synthetic kv:<key> filePath', async () => {
    const payload = makePayload({ timestamp: '2026-05-04T05:00:00.000Z' });
    await store.save(payload);
    const result = await store.list();
    expect(result[0]?.filePath).toBe(`kv:${payload.timestamp}`);
  });

  it('summary attachmentCount reflects payload.attachments length', async () => {
    const noneAttached = makePayload({ timestamp: '2026-05-04T03:00:00.000Z' });
    const withAttached = {
      ...makePayload({ timestamp: '2026-05-04T04:00:00.000Z' }),
      attachments: [
        {
          key: 'lite-bugs/attachments/x/a.png',
          name: 'a.png',
          contentType: 'image/png',
          size: 100,
          uploadedAt: '2026-05-04T04:00:00.000Z',
        },
        {
          key: 'lite-bugs/attachments/x/b.txt',
          name: 'b.txt',
          contentType: 'text/plain',
          size: 200,
          uploadedAt: '2026-05-04T04:00:00.000Z',
        },
      ],
    };
    await store.save(noneAttached);
    await store.save(withAttached);
    const result = await store.list();
    const byTs = new Map(result.map((s) => [s.timestamp, s]));
    expect(byTs.get(noneAttached.timestamp)?.attachmentCount).toBe(0);
    expect(byTs.get(withAttached.timestamp)?.attachmentCount).toBe(2);
  });
});

describe('BugReportStore.read', () => {
  let kv: FakeKV;
  let store: BugReportStore;

  beforeEach(() => {
    kv = new FakeKV();
    store = new BugReportStore({ kvApi: kv });
  });

  it('reads a record by bare timestamp', async () => {
    const payload = makePayload({ timestamp: '2026-05-04T06:00:00.000Z', description: 'from kv' });
    await store.save(payload);

    const result = await store.read(payload.timestamp);
    expect(result).toEqual(payload);
  });

  it('reads a record by synthetic kv:<timestamp> identifier', async () => {
    const payload = makePayload({ timestamp: '2026-05-04T07:00:00.000Z', description: 'kv-prefix' });
    await store.save(payload);

    const result = await store.read(`kv:${payload.timestamp}`);
    expect(result).toEqual(payload);
  });

  it('throws when the record is missing', async () => {
    await expect(store.read('2099-01-01T00:00:00.000Z')).rejects.toThrow(/not found/);
  });

  it('migrates legacy records on read', async () => {
    // Inject a legacy record (no status/notes/lastModified)
    kv.store.set('lite-bugs::2026-05-04T08:00:00.000Z', {
      schemaVersion: 1,
      timestamp: '2026-05-04T08:00:00.000Z',
      appTag: 'lite',
      source: 'user-bug-report',
      version: '5.0.0',
      os: { platform: 'darwin', release: '23.0', arch: 'arm64' },
      description: 'legacy',
      recentLogs: '',
      redactionTelemetry: { bucket: 'none', countsByKind: {} },
    });
    const result = await store.read('2026-05-04T08:00:00.000Z');
    expect(result.status).toBe('open');
    expect(result.notes).toBe('');
    expect(result.lastModified).toBe('2026-05-04T08:00:00.000Z');
  });
});

describe('BugReportStore.update', () => {
  let kv: FakeKV;
  let store: BugReportStore;

  beforeEach(() => {
    kv = new FakeKV();
    store = new BugReportStore({ kvApi: kv });
  });

  it('updates status', async () => {
    const payload = makePayload();
    await store.save(payload);
    kv.sets.splice(0); // reset the recorded sets without reassigning the readonly array

    const result = await store.update(payload.timestamp, { status: 'resolved' });
    expect(result.kvUpdated).toBe(true);
    expect(result.payload.status).toBe('resolved');
    expect(kv.sets.length).toBe(1);
    expect((kv.sets[0]!.value as { status: string }).status).toBe('resolved');
  });

  it('redacts secrets in notes before saving', async () => {
    const payload = makePayload();
    await store.save(payload);

    const result = await store.update(payload.timestamp, {
      notes: 'API key sk-abcdefghijklmnopqrstuvwx is exposed',
    });
    expect(result.payload.notes).toContain('[REDACTED:OPENAI_KEY]');
    expect(result.payload.notes).not.toContain('sk-abcdefghijklmnopqrstuvwx');
  });

  it('returns kvUpdated=false on KV write failure', async () => {
    const payload = makePayload();
    await store.save(payload);
    kv.failSet = true;

    const result = await store.update(payload.timestamp, { status: 'resolved' });
    expect(result.kvUpdated).toBe(false);
    expect(result.kvError).toMatch(/mock set failure/);
  });

  it('updates lastModified', async () => {
    const payload = makePayload();
    await store.save(payload);
    const original = payload.lastModified;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const result = await store.update(payload.timestamp, { status: 'resolved' });
    expect(new Date(result.payload.lastModified).getTime()).toBeGreaterThan(new Date(original).getTime());
  });

  it('preserves immutable fields', async () => {
    const payload = makePayload({ description: 'never change me', recentLogs: 'log line' });
    await store.save(payload);

    const result = await store.update(payload.timestamp, { status: 'resolved', notes: 'fixed' });
    expect(result.payload.description).toBe('never change me');
    expect(result.payload.recentLogs).toBe('log line');
    expect(result.payload.timestamp).toBe(payload.timestamp);
  });
});

describe('BugReportStore.delete', () => {
  let kv: FakeKV;
  let store: BugReportStore;

  beforeEach(() => {
    kv = new FakeKV();
    store = new BugReportStore({ kvApi: kv });
  });

  it('calls KV delete', async () => {
    const payload = makePayload();
    await store.save(payload);
    const result = await store.delete(payload.timestamp);
    expect(result.kvDeleted).toBe(true);
    expect(kv.deletes).toEqual([{ collection: 'lite-bugs', key: payload.timestamp }]);
  });

  it('returns kvDeleted=false on failure (does not throw)', async () => {
    kv.failDelete = true;
    const result = await store.delete('2099-01-01T00:00:00.000Z');
    expect(result.kvDeleted).toBe(false);
    expect(result.kvError).toMatch(/mock delete failure/);
  });
});

// ─── ADR-078: local spool ───────────────────────────────────────────────────

describe('BugReportStore spool (ADR-078)', () => {
  let kv: FakeKV;
  let store: BugReportStore;
  let spoolDir: string;
  /** Flip to simulate sign-in/out. */
  let account: string | null;
  let mirrored: string[];

  beforeEach(async () => {
    kv = new FakeKV();
    spoolDir = await fsp.mkdtemp(path.join(tmpdir(), 'lite-bugs-spool-test-'));
    account = null;
    mirrored = [];
    store = new BugReportStore({
      kvApi: kv,
      spoolDir,
      getActiveAccountId: () => account,
      mirrorToGraph: async (payload) => {
        mirrored.push(payload.timestamp);
        return { filed: true };
      },
    });
  });

  afterEach(async () => {
    await fsp.rm(spoolDir, { recursive: true, force: true });
  });

  async function spoolFiles(): Promise<string[]> {
    try {
      return (await fsp.readdir(spoolDir)).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
  }

  it('signed-out save succeeds into the spool, touching neither KV nor graph', async () => {
    const payload = makePayload({ description: 'filed while signed out' });
    const result = await store.save(payload);

    expect(result).toEqual({ kvWritten: false, kvError: null, spooled: true });
    expect(kv.sets).toHaveLength(0);
    expect(mirrored).toEqual([]);
    const files = await spoolFiles();
    expect(files).toHaveLength(1);
    const onDisk = JSON.parse(
      await fsp.readFile(path.join(spoolDir, files[0] as string), 'utf-8')
    ) as { description: string; timestamp: string };
    expect(onDisk.description).toBe('filed while signed out');
    expect(onDisk.timestamp).toBe(payload.timestamp);
  });

  it('signed-in save writes KV and leaves no spool residue', async () => {
    account = 'acct-1';
    const result = await store.save(makePayload());

    expect(result.kvWritten).toBe(true);
    expect(result.spooled).toBe(false);
    expect(kv.sets).toHaveLength(1);
    expect(await spoolFiles()).toHaveLength(0);
    expect(mirrored).toHaveLength(1);
  });

  it('signed-in save with KV down keeps the report in the spool (soft result, no throw)', async () => {
    account = 'acct-1';
    kv.failSet = true;
    const result = await store.save(makePayload());

    expect(result.kvWritten).toBe(false);
    expect(result.spooled).toBe(true);
    expect(result.kvError).toMatch(/mock set failure/);
    expect(await spoolFiles()).toHaveLength(1);
    expect(mirrored).toEqual([]);
  });

  it('drainSpool is a counted no-op while signed out', async () => {
    await store.save(makePayload());
    const result = await store.drainSpool();
    expect(result).toEqual({ drained: 0, remaining: 1 });
    expect(kv.sets).toHaveLength(0);
  });

  it('drainSpool pushes every spooled report to KV, mirrors, and clears the spool', async () => {
    const a = makePayload({ timestamp: '2026-08-24T01:00:00.000Z' });
    const b = makePayload({ timestamp: '2026-08-24T02:00:00.000Z' });
    await store.save(a);
    await store.save(b);
    account = 'acct-1';

    const result = await store.drainSpool();
    expect(result).toEqual({ drained: 2, remaining: 0 });
    expect(kv.sets.map((s) => s.key).sort()).toEqual([a.timestamp, b.timestamp]);
    expect(mirrored.sort()).toEqual([a.timestamp, b.timestamp]);
    expect(await spoolFiles()).toHaveLength(0);
  });

  it('drainSpool stops on KV failure and reports the remainder', async () => {
    await store.save(makePayload({ timestamp: '2026-08-24T03:00:00.000Z' }));
    await store.save(makePayload({ timestamp: '2026-08-24T04:00:00.000Z' }));
    account = 'acct-1';
    kv.failSet = true;

    const result = await store.drainSpool();
    expect(result).toEqual({ drained: 0, remaining: 2 });
    expect(await spoolFiles()).toHaveLength(2);
  });

  it('list surfaces spooled reports signed out, with spool:<ts> ids', async () => {
    const payload = makePayload({ description: 'visible offline' });
    await store.save(payload);

    const summaries = await store.list();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.filePath).toBe(`spool:${payload.timestamp}`);
    expect(summaries[0]?.descriptionPreview).toBe('visible offline');
  });

  it('read resolves spooled reports by spool: id and by bare timestamp while signed out', async () => {
    const payload = makePayload({ description: 'readable offline' });
    await store.save(payload);

    expect((await store.read(`spool:${payload.timestamp}`)).description).toBe('readable offline');
    expect((await store.read(payload.timestamp)).description).toBe('readable offline');
  });

  it('update mutates a spooled report in place, with notes redaction', async () => {
    const payload = makePayload();
    await store.save(payload);

    const result = await store.update(payload.timestamp, {
      status: 'resolved',
      notes: 'key sk-abcdefghijklmnopqrstuvwx seen here',
    });
    expect(result.spooled).toBe(true);
    expect(result.kvUpdated).toBe(false);
    expect(result.payload.status).toBe('resolved');
    expect(result.payload.notes).toContain('[REDACTED:OPENAI_KEY]');
    expect(kv.sets).toHaveLength(0);
    // The mutation persisted to the file, not just the returned object.
    const reread = await store.read(payload.timestamp);
    expect(reread.status).toBe('resolved');
  });

  it('delete removes a spooled report so a later drain cannot resurrect it', async () => {
    const payload = makePayload();
    await store.save(payload);

    const result = await store.delete(payload.timestamp);
    expect(result.spooled).toBe(true);
    expect(result.kvError).toBeNull();
    expect(await spoolFiles()).toHaveLength(0);

    account = 'acct-1';
    expect(await store.drainSpool()).toEqual({ drained: 0, remaining: 0 });
    expect(kv.sets).toHaveLength(0);
  });

  it('without a spoolDir, signed-out save still hard-fails (legacy contract)', async () => {
    const legacy = new BugReportStore({ kvApi: kv, getActiveAccountId: () => null });
    await expect(legacy.save(makePayload())).rejects.toThrow(/signed out/);
  });
});
