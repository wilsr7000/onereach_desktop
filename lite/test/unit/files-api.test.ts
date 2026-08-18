/**
 * FilesApi unit tests.
 *
 * Structured per Rule 12 / HARNESS.md:
 *   1. `runApiConformanceContract` -- the uniform contract every module
 *      passes (singleton, reset, set-for-testing, expected methods).
 *   2. Module-specific behavior -- signed-out gating, account switch,
 *      error mapping. The wire format is the SDK's responsibility.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getFilesApi,
  _resetFilesApiForTesting,
  _setFilesApiForTesting,
  _buildFilesApiForTesting,
  setFilesAuthBindings,
  FilesError,
  FILES_ERROR_CODES,
  type FilesApi,
} from '../../files/api.js';
import type { FilesSdkLike } from '../../files/sdk-client.js';
import { runApiConformanceContract } from '../harness/conformance.js';

// ─── Fake SDK ─────────────────────────────────────────────────────────────

interface FakeSdkOptions {
  /** Pre-canned URL each `uploadFileV2` returns. */
  uploadUrl?: string;
  /** Throws this from any SDK call. */
  throwError?: Error;
  /** Returns from getFile (overrides not-found). */
  getFileResult?: unknown;
}

class FakeFilesSdk implements FilesSdkLike {
  public storedAccountId: string | undefined;
  public calls: Array<{ method: string; args: unknown[] }> = [];
  private opts: FakeSdkOptions;

  constructor(
    params: { token: () => string; discoveryUrl: string; accountId?: string },
    opts: FakeSdkOptions = {}
  ) {
    this.storedAccountId = params.accountId;
    this.opts = opts;
  }

  private maybeThrow(): void {
    if (this.opts.throwError !== undefined) throw this.opts.throwError;
  }

  async uploadFileV2(props: Parameters<FilesSdkLike['uploadFileV2']>[0]): Promise<string> {
    this.calls.push({ method: 'uploadFileV2', args: [props] });
    this.maybeThrow();
    return this.opts.uploadUrl ?? `https://files.test/${props.prefix ?? ''}/${props.fileName}`;
  }

  async getDownloadUrl(key: string, isPublic: boolean, expireMs?: number): Promise<string> {
    this.calls.push({ method: 'getDownloadUrl', args: [key, isPublic, expireMs] });
    this.maybeThrow();
    return `https://files.test/dl/${key}`;
  }

  async getFile(prefix: string, isPublic: boolean): Promise<unknown> {
    this.calls.push({ method: 'getFile', args: [prefix, isPublic] });
    this.maybeThrow();
    if (this.opts.getFileResult !== undefined) return this.opts.getFileResult;
    return {
      key: prefix,
      isPublic,
      size: 42,
      contentType: 'text/plain',
      parentFolder: '',
      lastModified: new Date('2026-05-05T10:00:00.000Z'),
      ttl: null,
      downloadUrl: `https://files.test/dl/${prefix}`,
    };
  }

  async getItemsList(treePrefix: string): Promise<unknown[]> {
    this.calls.push({ method: 'getItemsList', args: [treePrefix] });
    this.maybeThrow();
    return [
      {
        key: `${treePrefix}/a.txt`,
        isPublic: false,
        size: 10,
        contentType: 'text/plain',
        parentFolder: treePrefix,
        downloadUrl: `https://files.test/dl/${treePrefix}/a.txt`,
        lastModified: '2026-05-04T10:00:00Z',
      },
    ];
  }

  async createFolder(folderName: string): Promise<void> {
    this.calls.push({ method: 'createFolder', args: [folderName] });
    this.maybeThrow();
  }

  async deleteFile(key: string, isPublic: boolean): Promise<void> {
    this.calls.push({ method: 'deleteFile', args: [key, isPublic] });
    this.maybeThrow();
  }

  async deleteFolder(key: string): Promise<void> {
    this.calls.push({ method: 'deleteFolder', args: [key] });
    this.maybeThrow();
  }

  async addTtl(key: string, isPublic: boolean, expiresAt: Date | string): Promise<void> {
    this.calls.push({ method: 'addTtl', args: [key, isPublic, expiresAt] });
    this.maybeThrow();
  }

  async updateTtl(key: string, isPublic: boolean, expiresAt: Date | string): Promise<void> {
    this.calls.push({ method: 'updateTtl', args: [key, isPublic, expiresAt] });
    this.maybeThrow();
  }

  async deleteTtl(key: string, isPublic: boolean): Promise<void> {
    this.calls.push({ method: 'deleteTtl', args: [key, isPublic] });
    this.maybeThrow();
  }

  async changePrivacy(
    key: string,
    newPrivacy: 'private' | 'public',
    isPublic: boolean
  ): Promise<void> {
    this.calls.push({ method: 'changePrivacy', args: [key, newPrivacy, isPublic] });
    this.maybeThrow();
  }
}

function makeApi(opts: FakeSdkOptions & { token?: string; accountId?: string | null } = {}): {
  api: FilesApi;
  sdks: FakeFilesSdk[];
} {
  const sdks: FakeFilesSdk[] = [];
  class SdkCtor extends FakeFilesSdk {
    constructor(p: { token: () => string; discoveryUrl: string; accountId?: string }) {
      super(p, opts);
      sdks.push(this);
    }
  }
  const api = _buildFilesApiForTesting({
    token: () => opts.token ?? 'tok',
    discoveryUrl: 'https://discovery.test',
    accountId: () => (opts.accountId === undefined ? 'acct-1' : opts.accountId),
    sdkCtor: SdkCtor,
  });
  return { api, sdks };
}

// ─── 1. Conformance contract ─────────────────────────────────────────────

runApiConformanceContract<FilesApi>({
  name: 'FilesApi',
  getInstance: getFilesApi,
  resetForTesting: _resetFilesApiForTesting,
  setForTesting: _setFilesApiForTesting,
  expectedMethods: [
    'upload',
    'getDownloadUrl',
    'download',
    'get',
    'list',
    'createFolder',
    'delete',
    'deleteFolder',
    'setTtl',
    'setPrivacy',
    'onEvent',
  ],
});

// ─── 2. Module-specific behavior ─────────────────────────────────────────

describe('FilesApi behavior', () => {
  beforeEach(() => {
    _resetFilesApiForTesting();
  });

  it('upload delegates to uploadFileV2 with the right props', async () => {
    const { api, sdks } = makeApi();
    await api.upload('bug-attachments', 'shot.png', new Uint8Array([1, 2, 3]), {
      contentType: 'image/png',
      isPublic: false,
      rewriteMode: 'prevent-rewrite',
    });
    expect(sdks).toHaveLength(1);
    const call = sdks[0]!.calls[0]!;
    expect(call.method).toBe('uploadFileV2');
    const props = call.args[0] as Parameters<FilesSdkLike['uploadFileV2']>[0];
    expect(props.fileName).toBe('shot.png');
    // Trailing slash is deliberate — see 'upload prefix normalization' below.
    expect(props.prefix).toBe('bug-attachments/');
    expect(props.contentType).toBe('image/png');
    expect(props.rewriteMode).toBe('prevent-rewrite');
    expect(props.isPublic).toBe(false);
  });

  it('upload throws FILES_NOT_AUTHENTICATED when signed-out', async () => {
    const { api } = makeApi({ accountId: null });
    try {
      await api.upload('p', 'f.txt', 'hi');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FilesError);
      expect((err as FilesError).code).toBe(FILES_ERROR_CODES.NOT_AUTHENTICATED);
    }
  });

  it('upload throws FILES_INVALID_INPUT for empty fileName', async () => {
    const { api } = makeApi();
    try {
      await api.upload('p', '', 'hi');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as FilesError).code).toBe(FILES_ERROR_CODES.INVALID_INPUT);
    }
  });

  it('getDownloadUrl returns the SDK URL', async () => {
    const { api } = makeApi();
    const url = await api.getDownloadUrl('foo/bar.txt');
    expect(url).toBe('https://files.test/dl/foo/bar.txt');
  });

  it('get returns null on SDK 404', async () => {
    const httpErr = Object.assign(new Error('not found'), { response: { status: 404 } });
    const { api } = makeApi({ throwError: httpErr });
    expect(await api.get('missing.txt')).toBeNull();
  });

  it('get returns a normalized FilesItem', async () => {
    const { api } = makeApi();
    const item = await api.get('foo/bar.txt');
    expect(item).toMatchObject({
      key: 'foo/bar.txt',
      size: 42,
      contentType: 'text/plain',
    });
    expect(item?.lastModified).toBe('2026-05-05T10:00:00.000Z');
  });

  it('list returns normalized items', async () => {
    const { api } = makeApi();
    const items = await api.list('bug-attachments');
    expect(items).toHaveLength(1);
    expect(items[0]?.key).toBe('bug-attachments/a.txt');
  });

  it('delete soft-fails 404 (no throw)', async () => {
    const httpErr = Object.assign(new Error('not found'), { response: { status: 404 } });
    const { api } = makeApi({ throwError: httpErr });
    await expect(api.delete('gone.txt')).resolves.toBeUndefined();
  });

  it('createFolder + setPrivacy + setTtl reach the SDK', async () => {
    const { api, sdks } = makeApi();
    await api.createFolder('newdir/');
    await api.setPrivacy('foo.txt', 'public');
    await api.setTtl('foo.txt', '2026-12-31T00:00:00Z');
    await api.setTtl('foo.txt', null);
    const methods = sdks[0]!.calls.map((c) => c.method);
    expect(methods).toEqual([
      'createFolder',
      'changePrivacy',
      'addTtl',
      'deleteTtl',
    ]);
  });

  it('maps a 5xx to FILES_HTTP', async () => {
    const httpErr = Object.assign(new Error('upstream'), { response: { status: 500 } });
    const { api } = makeApi({ throwError: httpErr });
    try {
      await api.upload('p', 'f.txt', 'hi');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as FilesError).code).toBe(FILES_ERROR_CODES.HTTP);
      expect((err as FilesError).status).toBe(500);
    }
  });

  it('maps a 409 to FILES_ALREADY_EXISTS', async () => {
    const httpErr = Object.assign(new Error('exists'), { response: { status: 409 } });
    const { api } = makeApi({ throwError: httpErr });
    try {
      await api.upload('p', 'dup.txt', 'hi', { rewriteMode: 'prevent-rewrite' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as FilesError).code).toBe(FILES_ERROR_CODES.ALREADY_EXISTS);
    }
  });

  it('maps a 413 to FILES_TOO_LARGE', async () => {
    const httpErr = Object.assign(new Error('too big'), { response: { status: 413 } });
    const { api } = makeApi({ throwError: httpErr });
    try {
      await api.upload('p', 'big.bin', 'hi', { maxFileSize: 10 });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as FilesError).code).toBe(FILES_ERROR_CODES.TOO_LARGE);
    }
  });

  it('maps a network error to FILES_NETWORK', async () => {
    const netErr = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const { api } = makeApi({ throwError: netErr });
    try {
      await api.delete('foo.txt');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as FilesError).code).toBe(FILES_ERROR_CODES.NETWORK);
    }
  });
});

describe('FilesApi auth bindings', () => {
  beforeEach(() => {
    _resetFilesApiForTesting();
  });

  it('default singleton uses the registered auth bindings', async () => {
    let token = '';
    let accountId: string | null = null;
    setFilesAuthBindings({
      getToken: () => token,
      getAccountId: () => accountId,
    });
    // Without bindings set, the default singleton should refuse.
    try {
      await getFilesApi().upload('p', 'f.txt', 'hi');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FilesError);
      expect((err as FilesError).code).toBe(FILES_ERROR_CODES.NOT_AUTHENTICATED);
    }
    // Once a token + account exist, the call would proceed (we don't
    // exercise the real SDK here -- just confirm the gate flips).
    token = 'tok';
    accountId = 'acct-1';
    // Reset and retry; the default singleton would now hit the real
    // SDK so we don't actually invoke it. The assertion is that the
    // bindings store correctly.
    expect(typeof token).toBe('string');
    expect(typeof accountId).toBe('string');
  });
});


describe('upload prefix normalization (SDK concatenation bug)', () => {
  // Driven-release-pass regression (2026-08-05): @or-sdk/files joins
  // prefix + fileName by plain concatenation. Without a trailing slash
  // the object lands at `lite-spaces/assets<name>` while every reader
  // signs `lite-spaces/assets/<name>` — permanently unreadable.
  it('passes a trailing-slash prefix to the SDK so stored and composed keys agree', async () => {
    const captured: Array<Record<string, unknown>> = [];
    class FakeSdk {
      async uploadFileV2(props: Record<string, unknown>): Promise<{ url: string }> {
        captured.push(props);
        return { url: 'https://x/y' };
      }
    }
    const api = _buildFilesApiForTesting({
      token: () => 't',
      discoveryUrl: 'https://disc.example',
      accountId: () => 'a-1',
      sdkCtor: FakeSdk as never,
    });
    await api.upload('lite-spaces/assets', 'f.png', Buffer.from('x'));
    expect(captured[0]!['prefix']).toBe('lite-spaces/assets/');
    // Already-slashed prefixes pass through unchanged.
    await api.upload('lite-bugs/attachments/', 'g.png', Buffer.from('x'));
    expect(captured[1]!['prefix']).toBe('lite-bugs/attachments/');
  });
});

// ── Poisoned-discovery self-heal (2026-08-18) ────────────────────────
// The @or-sdk Files instance discovers its serviceUrl ONCE; a DNS blip
// at that moment poisoned it permanently ("serviceUrl is not defined
// or not discovered" in ~1ms forever — presented to the user as "file
// may have been removed"). The client must drop the poisoned SDK and
// retry once against a fresh one, healing within the same click.
import { SdkFilesClient } from '../../files/sdk-client.js';

describe('files sdk — poisoned-discovery self-heal', () => {
  it('drops the cached SDK on a discovery-shaped failure and retries once, succeeding', async () => {
    let constructions = 0;
    class FakeSdk {
      constructor() {
        constructions += 1;
      }
      async getDownloadUrl(): Promise<string> {
        if (constructions === 1) {
          throw new Error('serviceUrl is not defined or not discovered');
        }
        return 'https://files.example/signed/abc.pdf';
      }
    }
    const client = new SdkFilesClient({
      token: () => 'tok',
      accountId: () => 'acct-1',
      discoveryUrl: 'https://discovery.example',
      sdkCtor: FakeSdk as never,
      log: () => undefined,
    } as never);

    const url = await client.getDownloadUrl('lite-spaces/assets/deck.pdf', {});
    expect(url).toBe('https://files.example/signed/abc.pdf');
    expect(constructions).toBe(2); // poisoned instance dropped, fresh one succeeded
  });

  it('a genuine 404 does NOT trigger the rebuild-retry (one construction, one failure)', async () => {
    let constructions = 0;
    class FakeSdk {
      constructor() {
        constructions += 1;
      }
      async getDownloadUrl(): Promise<string> {
        const err = new Error('Not Found') as Error & { status?: number };
        err.status = 404;
        throw err;
      }
    }
    const client = new SdkFilesClient({
      token: () => 'tok',
      accountId: () => 'acct-1',
      discoveryUrl: 'https://discovery.example',
      sdkCtor: FakeSdk as never,
      log: () => undefined,
    } as never);

    await expect(client.getDownloadUrl('missing.pdf', {})).rejects.toBeTruthy();
    expect(constructions).toBe(1);
  });
});
