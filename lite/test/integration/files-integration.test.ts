/**
 * Files integration tests -- end-to-end SdkFilesClient + a stand-in
 * for `@or-sdk/files`.
 *
 * Mirrors `lite/test/integration/kv-integration.test.ts`'s shape:
 * the SDK's own wire format is covered by the SDK team's tests; here
 * we validate Lite's contract (`FilesApi` round-trip, per-account
 * isolation server-side, signed-out gating, error mapping).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SdkFilesClient } from '../../files/sdk-client.js';
import type { FilesSdkLike } from '../../files/sdk-client.js';
import { FilesError, FILES_ERROR_CODES } from '../../files/errors.js';

// ─── Fake server -- tracks state per accountId ───────────────────────────

interface StoredFile {
  bytes: Uint8Array;
  contentType: string;
  isPublic: boolean;
  ttl: string | null;
  lastModified: string;
}

class FakeFilesService {
  /** Bucket: `${accountId}::${isPublic}::${key}` -> StoredFile. */
  public readonly store = new Map<string, StoredFile>();
  public readonly constructorParams: Array<{ accountId: string | undefined }> = [];
  public errorOnNextCall: Error | null = null;

  reset(): void {
    this.store.clear();
    this.constructorParams.length = 0;
    this.errorOnNextCall = null;
  }
}

let service: FakeFilesService;

class FakeFilesSdk implements FilesSdkLike {
  constructor(
    private readonly params: { token: () => string; discoveryUrl: string; accountId?: string }
  ) {
    service.constructorParams.push({ accountId: params.accountId });
  }

  private throwIfArmed(): void {
    if (service.errorOnNextCall !== null) {
      const err = service.errorOnNextCall;
      service.errorOnNextCall = null;
      throw err;
    }
  }

  private storeKey(key: string, isPublic: boolean): string {
    return `${this.params.accountId ?? 'unset'}::${isPublic}::${key}`;
  }

  async uploadFileV2(props: Parameters<FilesSdkLike['uploadFileV2']>[0]): Promise<string> {
    this.throwIfArmed();
    const key =
      props.prefix !== undefined && props.prefix !== ''
        ? `${props.prefix}/${props.fileName}`
        : props.fileName;
    const existing = service.store.get(this.storeKey(key, props.isPublic ?? false));
    if (existing !== undefined && props.rewriteMode === 'prevent-rewrite') {
      throw Object.assign(new Error('exists'), { response: { status: 409 } });
    }
    const bytes = toBytes(props.fileContent);
    if (props.maxFileSize !== undefined && bytes.length > props.maxFileSize) {
      throw Object.assign(new Error('too big'), { response: { status: 413 } });
    }
    service.store.set(this.storeKey(key, props.isPublic ?? false), {
      bytes,
      contentType: props.contentType ?? 'application/octet-stream',
      isPublic: props.isPublic ?? false,
      ttl:
        props.expiresAt instanceof Date
          ? props.expiresAt.toISOString()
          : typeof props.expiresAt === 'string'
            ? props.expiresAt
            : null,
      lastModified: new Date().toISOString(),
    });
    return `https://files.test/${this.params.accountId}/${key}`;
  }

  async getDownloadUrl(key: string, isPublic: boolean): Promise<string> {
    this.throwIfArmed();
    const file = service.store.get(this.storeKey(key, isPublic));
    if (file === undefined) {
      throw Object.assign(new Error('not found'), { response: { status: 404 } });
    }
    return `https://files.test/${this.params.accountId}/${key}?signed=1`;
  }

  async getFile(prefix: string, isPublic: boolean): Promise<unknown> {
    this.throwIfArmed();
    const file = service.store.get(this.storeKey(prefix, isPublic));
    if (file === undefined) {
      throw Object.assign(new Error('not found'), { response: { status: 404 } });
    }
    return {
      key: prefix,
      isPublic: file.isPublic,
      size: file.bytes.length,
      contentType: file.contentType,
      parentFolder: prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : '',
      lastModified: file.lastModified,
      ttl: file.ttl,
      downloadUrl: `https://files.test/${this.params.accountId}/${prefix}`,
    };
  }

  async getItemsList(treePrefix: string, isPublic = false): Promise<unknown[]> {
    this.throwIfArmed();
    const prefix = `${this.params.accountId ?? 'unset'}::${isPublic}::${treePrefix}`;
    const out: unknown[] = [];
    for (const [k, v] of service.store.entries()) {
      if (!k.startsWith(prefix)) continue;
      const key = k.slice(`${this.params.accountId ?? 'unset'}::${isPublic}::`.length);
      out.push({
        key,
        isPublic: v.isPublic,
        size: v.bytes.length,
        contentType: v.contentType,
        parentFolder: treePrefix,
        lastModified: v.lastModified,
        ttl: v.ttl,
        downloadUrl: `https://files.test/${this.params.accountId}/${key}`,
      });
    }
    return out;
  }

  async createFolder(_folderName: string): Promise<void> {
    this.throwIfArmed();
    // No-op in the fake -- folders are implicit by key prefix.
  }

  async deleteFile(key: string, isPublic: boolean): Promise<void> {
    this.throwIfArmed();
    const k = this.storeKey(key, isPublic);
    if (!service.store.has(k)) {
      throw Object.assign(new Error('not found'), { response: { status: 404 } });
    }
    service.store.delete(k);
  }

  async deleteFolder(folderKey: string): Promise<void> {
    this.throwIfArmed();
    for (const k of service.store.keys()) {
      const expectedPrefix = `${this.params.accountId ?? 'unset'}::false::${folderKey}`;
      if (k.startsWith(expectedPrefix)) service.store.delete(k);
    }
  }

  async addTtl(key: string, isPublic: boolean, expiresAt: Date | string): Promise<void> {
    this.throwIfArmed();
    const file = service.store.get(this.storeKey(key, isPublic));
    if (file === undefined) {
      throw Object.assign(new Error('not found'), { response: { status: 404 } });
    }
    if (file.ttl !== null) {
      throw Object.assign(new Error('ttl exists'), { response: { status: 409 } });
    }
    file.ttl = expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt;
  }

  async updateTtl(key: string, isPublic: boolean, expiresAt: Date | string): Promise<void> {
    this.throwIfArmed();
    const file = service.store.get(this.storeKey(key, isPublic));
    if (file === undefined) {
      throw Object.assign(new Error('not found'), { response: { status: 404 } });
    }
    file.ttl = expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt;
  }

  async deleteTtl(key: string, isPublic: boolean): Promise<void> {
    this.throwIfArmed();
    const file = service.store.get(this.storeKey(key, isPublic));
    if (file !== undefined) file.ttl = null;
  }

  async changePrivacy(
    key: string,
    newPrivacy: 'private' | 'public',
    isPublic: boolean
  ): Promise<void> {
    this.throwIfArmed();
    const file = service.store.get(this.storeKey(key, isPublic));
    if (file === undefined) {
      throw Object.assign(new Error('not found'), { response: { status: 404 } });
    }
    file.isPublic = newPrivacy === 'public';
  }
}

function toBytes(content: unknown): Uint8Array {
  if (typeof content === 'string') return new TextEncoder().encode(content);
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return new Uint8Array(0);
}

function makeClient(opts: { token?: string; accountId?: string | null } = {}): SdkFilesClient {
  return new SdkFilesClient({
    token: () => opts.token ?? 'tok',
    discoveryUrl: 'https://discovery.test',
    accountId: () => (opts.accountId === undefined ? 'acct-1' : opts.accountId),
    sdkCtor: FakeFilesSdk,
  });
}

beforeEach(() => {
  service = new FakeFilesService();
});

describe('Files integration: upload + download round-trip', () => {
  it('upload + getDownloadUrl returns a signed URL', async () => {
    const client = makeClient();
    await client.upload('bug-attachments', 'shot.png', new Uint8Array([1, 2, 3]), {
      contentType: 'image/png',
    });
    const url = await client.getDownloadUrl('bug-attachments/shot.png');
    expect(url).toContain('https://files.test/acct-1/bug-attachments/shot.png');
    expect(url).toContain('signed=1');
  });

  it('upload + get returns metadata; missing key returns null', async () => {
    const client = makeClient();
    await client.upload('p', 'a.txt', 'hello', { contentType: 'text/plain' });
    const item = await client.get('p/a.txt');
    expect(item?.size).toBe(5);
    expect(item?.contentType).toBe('text/plain');

    const missing = await client.get('p/b.txt');
    expect(missing).toBeNull();
  });

  it('list returns all items under a prefix', async () => {
    const client = makeClient();
    await client.upload('p', 'a.txt', 'a');
    await client.upload('p', 'b.txt', 'b');
    await client.upload('other', 'c.txt', 'c');
    const items = await client.list('p');
    expect(items.map((i) => i.key).sort()).toEqual(['p/a.txt', 'p/b.txt']);
  });

  it('delete removes the file; subsequent get returns null', async () => {
    const client = makeClient();
    await client.upload('p', 'a.txt', 'hi');
    await client.delete('p/a.txt');
    expect(await client.get('p/a.txt')).toBeNull();
  });

  it('delete soft-fails 404', async () => {
    const client = makeClient();
    await expect(client.delete('p/missing.txt')).resolves.toBeUndefined();
  });
});

describe('Files integration: per-account isolation', () => {
  it('different accountIds see different buckets even with the same key', async () => {
    const alice = makeClient({ accountId: 'alice' });
    const bob = makeClient({ accountId: 'bob' });

    await alice.upload('p', 'shared.txt', 'alice');
    await bob.upload('p', 'shared.txt', 'bob');

    const aItem = await alice.get('p/shared.txt');
    const bItem = await bob.get('p/shared.txt');
    expect(aItem?.size).toBe(5);
    expect(bItem?.size).toBe(3);
  });
});

describe('Files integration: signed-out gating', () => {
  it('upload throws FILES_NOT_AUTHENTICATED when no accountId', async () => {
    const client = makeClient({ accountId: null });
    await expect(client.upload('p', 'f.txt', 'hi')).rejects.toBeInstanceOf(FilesError);
    try {
      await client.upload('p', 'f.txt', 'hi');
    } catch (err) {
      expect((err as FilesError).code).toBe(FILES_ERROR_CODES.NOT_AUTHENTICATED);
    }
    expect(service.constructorParams).toHaveLength(0);
  });
});

describe('Files integration: rewrite mode', () => {
  it('prevent-rewrite throws FILES_ALREADY_EXISTS on collision', async () => {
    const client = makeClient();
    await client.upload('p', 'a.txt', 'first');
    try {
      await client.upload('p', 'a.txt', 'second', { rewriteMode: 'prevent-rewrite' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as FilesError).code).toBe(FILES_ERROR_CODES.ALREADY_EXISTS);
    }
    // First content preserved.
    expect((await client.get('p/a.txt'))?.size).toBe(5);
  });

  it('rewrite (default) overwrites existing content', async () => {
    const client = makeClient();
    await client.upload('p', 'a.txt', 'first');
    await client.upload('p', 'a.txt', 'longer-second-write');
    expect((await client.get('p/a.txt'))?.size).toBe('longer-second-write'.length);
  });
});

describe('Files integration: TTL + privacy', () => {
  it('setTtl adds when absent and updates when present', async () => {
    const client = makeClient();
    await client.upload('p', 'a.txt', 'hi');
    await client.setTtl('p/a.txt', '2026-12-31T00:00:00Z');
    expect((await client.get('p/a.txt'))?.ttl).toBe('2026-12-31T00:00:00.000Z');
    await client.setTtl('p/a.txt', '2027-01-01T00:00:00Z');
    expect((await client.get('p/a.txt'))?.ttl).toBe('2027-01-01T00:00:00.000Z');
  });

  it('setTtl with null clears the TTL', async () => {
    const client = makeClient();
    await client.upload('p', 'a.txt', 'hi', { expiresAt: '2026-12-31T00:00:00Z' });
    await client.setTtl('p/a.txt', null);
    expect((await client.get('p/a.txt'))?.ttl).toBeNull();
  });

  it('setPrivacy flips the bucket flag', async () => {
    const client = makeClient();
    await client.upload('p', 'a.txt', 'hi');
    await client.setPrivacy('p/a.txt', 'public');
    expect((await client.get('p/a.txt'))?.isPublic).toBe(true);
  });
});
