/**
 * files.delete vs the service's async FileItem indexing (2026-08-07).
 *
 * The service writes the FileItem DB row AFTER the S3 upload. Reads
 * use signed URLs and never notice; DELETE consults the DB and fails
 * with 'Could not find any entity of type "FileItem"' when it races
 * the indexer — which made delete-by-key look permanently broken and
 * meant orphaned uploads were never reclaimed.
 */

import { describe, it, expect, vi } from 'vitest';
import { SdkFilesClient } from '../../files/sdk-client.js';

function buildClient(deleteImpl: (key: string, isPublic: boolean) => Promise<void>): {
  client: SdkFilesClient;
  calls: () => number;
} {
  let calls = 0;
  class FakeSdk {
    async deleteFile(key: string, isPublic: boolean): Promise<void> {
      calls++;
      return deleteImpl(key, isPublic);
    }
  }
  const client = new SdkFilesClient({
    token: () => 'test-token',
    discoveryUrl: 'https://discovery.test',
    accountId: () => 'acct-test',
    sdkCtor: FakeSdk as never,
  });
  return { client, calls: () => calls };
}

function fileItemLagError(): Error {
  const err = new Error(
    'Could not find any entity of type "FileItem" matching: {"key":"lite-spaces/assets/x.png"}'
  );
  (err as { response?: { status: number } }).response = { status: 400 };
  return err;
}

describe('files.delete — FileItem index lag', () => {
  it('retries through the indexing window and succeeds', async () => {
    vi.useFakeTimers();
    let failures = 2;
    const { client, calls } = buildClient(async () => {
      if (failures > 0) {
        failures--;
        throw fileItemLagError();
      }
    });
    const done = client.delete('lite-spaces/assets/x.png');
    await vi.runAllTimersAsync();
    await done;
    expect(calls()).toBe(3);
    vi.useRealTimers();
  });

  it('gives up with the original error when the row never appears', async () => {
    vi.useFakeTimers();
    const { client, calls } = buildClient(async () => {
      throw fileItemLagError();
    });
    const done = client.delete('lite-spaces/assets/x.png');
    const assertion = expect(done).rejects.toThrow(/FileItem/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(calls()).toBe(3);
    vi.useRealTimers();
  });

  it('does NOT retry a generic FileItem-mentioning error (matcher is specific)', async () => {
    const boom = new Error('FileItem validation failed: name too long');
    (boom as { response?: { status: number } }).response = { status: 422 };
    const { client, calls } = buildClient(async () => {
      throw boom;
    });
    await expect(client.delete('k')).rejects.toThrow(/validation/);
    expect(calls()).toBe(1);
  });

  it('does NOT retry non-FileItem errors; 404 still means already-gone', async () => {
    const boom = new Error('HTTP 500');
    (boom as { response?: { status: number } }).response = { status: 500 };
    const { client, calls } = buildClient(async () => {
      throw boom;
    });
    await expect(client.delete('k')).rejects.toThrow('HTTP 500');
    expect(calls()).toBe(1);

    const gone = new Error('not found');
    (gone as { response?: { status: number } }).response = { status: 404 };
    const { client: c2, calls: calls2 } = buildClient(async () => {
      throw gone;
    });
    await expect(c2.delete('k')).resolves.toBeUndefined();
    expect(calls2()).toBe(1);
  });
});

describe('wiring (source-level)', () => {
  const read = (rel: string): string => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const p = require('node:path') as typeof import('node:path');
    const candidates = [p.resolve(rel), p.resolve('lite', rel)];
    const found = candidates.find((f) => fs.existsSync(f));
    if (found === undefined) throw new Error(`${rel} not found`);
    return fs.readFileSync(found, 'utf8');
  };

  it('createBinary uploads wait for the FileItem row', () => {
    expect(read('spaces/create-binary.ts')).toContain('waitTillFileAddedInDb: true');
  });

  it('downloads attach to every session Electron ever creates', () => {
    const src = read('downloads/main.ts');
    expect(src).toContain("app.on('session-created', onSessionCreated)");
    expect(src).toContain('detachSessionCreated');
    // Teardown symmetry.
    expect(src).toMatch(/dispose\(\) \{\n\s*active\?\.detachSessionCreated\?\.\(\);/);
  });
});
