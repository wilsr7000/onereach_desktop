/**
 * Every Files operation targets the PRIVATE bucket unless told otherwise.
 *
 * This is not a stylistic preference — it is a deliberate inversion of
 * the platform's own default. The OneReach Files documentation states:
 *
 *     "If no preference is specified by default, the file is set to
 *      public."
 *
 * So a call that merely FORGETS to pass `isPublic` would upload to the
 * world-readable bucket. `lite/files/sdk-client.ts` defends against that
 * by resolving `options.isPublic ?? false` at every single call site,
 * which makes the omission safe instead of dangerous.
 *
 * That defence is invisible: nothing about `await files.upload(...)`
 * hints that a default is being overridden underneath. This file pins
 * it, per operation, so that removing an `?? false` — or adding a new
 * method that forgets one — fails loudly rather than silently
 * publishing user files.
 */

import { describe, it, expect } from 'vitest';
import { _buildFilesApiForTesting, type FilesApi } from '../../files/api.js';
import type { FilesSdkLike } from '../../files/sdk-client.js';

interface Call {
  method: string;
  args: unknown[];
}

class RecordingSdk implements FilesSdkLike {
  static last: RecordingSdk | null = null;
  calls: Call[] = [];

  constructor() {
    RecordingSdk.last = this;
  }

  private rec(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
  }

  async uploadFileV2(props: Parameters<FilesSdkLike['uploadFileV2']>[0]): Promise<string> {
    this.rec('uploadFileV2', [props]);
    return 'https://files.test/x';
  }
  async getDownloadUrl(key: string, isPublic: boolean, expireMs?: number): Promise<string> {
    this.rec('getDownloadUrl', [key, isPublic, expireMs]);
    return 'https://files.test/dl';
  }
  async getFile(prefix: string, isPublic: boolean): Promise<unknown> {
    this.rec('getFile', [prefix, isPublic]);
    return null;
  }
  async getItemsList(treePrefix: string, isPublic?: boolean): Promise<unknown[]> {
    this.rec('getItemsList', [treePrefix, isPublic]);
    return [];
  }
  async deleteFile(key: string, isPublic: boolean): Promise<void> {
    this.rec('deleteFile', [key, isPublic]);
  }
  async addTtl(key: string, isPublic: boolean, expiresAt: Date | string): Promise<void> {
    this.rec('addTtl', [key, isPublic, expiresAt]);
  }
  async updateTtl(key: string, isPublic: boolean, newExpiresAt: Date | string): Promise<void> {
    this.rec('updateTtl', [key, isPublic, newExpiresAt]);
  }
  async deleteTtl(key: string, isPublic: boolean): Promise<void> {
    this.rec('deleteTtl', [key, isPublic]);
  }
  async changePrivacy(key: string, newPrivacy: string, isPublic: boolean): Promise<void> {
    this.rec('changePrivacy', [key, newPrivacy, isPublic]);
  }
  async createFolder(): Promise<void> {
    this.rec('createFolder', []);
  }
  async deleteFolder(): Promise<void> {
    this.rec('deleteFolder', []);
  }
}

function api(): FilesApi {
  RecordingSdk.last = null;
  return _buildFilesApiForTesting({
    token: () => 'tok',
    discoveryUrl: 'https://discovery.test',
    accountId: () => 'acct-1',
    sdkCtor: RecordingSdk as never,
  });
}

function lastCall(method: string): Call {
  const found = RecordingSdk.last?.calls.find((c) => c.method === method);
  expect(found, `SDK method ${method} was never called`).toBeDefined();
  return found as Call;
}

describe('Files: private by default at every call site', () => {
  it('upload sends isPublic:false when the caller omits it', async () => {
    const files = api();
    await files.upload('prefix', 'f.txt', 'body');
    const props = lastCall('uploadFileV2').args[0] as { isPublic?: unknown };
    expect(
      props.isPublic,
      'the platform defaults to PUBLIC — omitting this would publish the file'
    ).toBe(false);
  });

  it('getDownloadUrl reads from the private bucket by default', async () => {
    const files = api();
    await files.getDownloadUrl('k');
    expect(lastCall('getDownloadUrl').args[1]).toBe(false);
  });

  it('get reads from the private bucket by default', async () => {
    const files = api();
    await files.get('k');
    expect(lastCall('getFile').args[1]).toBe(false);
  });

  it('list reads from the private bucket by default', async () => {
    const files = api();
    await files.list('p');
    expect(lastCall('getItemsList').args[1]).toBe(false);
  });

  it('delete targets the private bucket by default', async () => {
    const files = api();
    await files.delete('k');
    expect(lastCall('deleteFile').args[1]).toBe(false);
  });

  it('setTtl targets the private bucket by default', async () => {
    const files = api();
    await files.setTtl('k', '2099-01-01T00:00:00.000Z');
    const call =
      RecordingSdk.last?.calls.find((c) => c.method === 'addTtl' || c.method === 'updateTtl') ??
      null;
    expect(call, 'expected addTtl or updateTtl').not.toBeNull();
    expect((call as Call).args[1]).toBe(false);
  });

  it('clearing a TTL targets the private bucket by default', async () => {
    const files = api();
    await files.setTtl('k', null);
    expect(lastCall('deleteTtl').args[1]).toBe(false);
  });

  // The third argument is the file's CURRENT bucket, not the target
  // privacy — an easy one to get backwards. Flipping a PUBLIC file to
  // private requires passing { isPublic: true }.
  it('setPrivacy passes the CURRENT bucket, defaulting to private', async () => {
    const files = api();
    await files.setPrivacy('k', 'public');
    const call = lastCall('changePrivacy');
    expect(call.args[1], 'second arg is the TARGET privacy').toBe('public');
    expect(call.args[2], 'third arg is the CURRENT bucket').toBe(false);
  });

  it('honours an explicit isPublic:true rather than forcing private', async () => {
    const files = api();
    await files.upload('prefix', 'f.txt', 'body', { isPublic: true });
    const props = lastCall('uploadFileV2').args[0] as { isPublic?: unknown };
    expect(props.isPublic).toBe(true);
  });

  it('treats a truthy non-boolean as PRIVATE, not public', async () => {
    const files = api();
    // Values that erase to a string across an IPC/JSON boundary.
    await files.upload('prefix', 'f.txt', 'body', {
      isPublic: 'true',
    } as unknown as { isPublic?: boolean });
    const props = lastCall('uploadFileV2').args[0] as { isPublic?: unknown };
    expect(props.isPublic, 'a stringified flag must never publish a file').toBe(false);
  });
});
