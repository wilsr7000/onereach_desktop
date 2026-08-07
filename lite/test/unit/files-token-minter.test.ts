import { describe, it, expect } from 'vitest';
import {
  FilesTokenMinter,
  FILES_TOKEN_MINT_BASE_URL,
  FILES_TOKEN_TTL_MS,
} from '../../files/token-minter.js';
import { _buildFilesApiForTesting } from '../../files/api.js';

interface FetchCall {
  url: string;
}

function stubFetch(
  handler: (url: string) => { ok: boolean; status: number; body: string }
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push({ url });
    const r = handler(url);
    return {
      ok: r.ok,
      status: r.status,
      text: async () => r.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const okFetch = (token = 'minted-123'): ReturnType<typeof stubFetch> =>
  stubFetch(() => ({ ok: true, status: 200, body: JSON.stringify({ token }) }));

describe('FilesTokenMinter', () => {
  it('mints from /http/<accountId>/refresh_token and FLOW-prefixes the value', async () => {
    const { fetchImpl, calls } = okFetch();
    const m = new FilesTokenMinter({ getAccountId: () => 'acct-1', fetchImpl });
    const token = await m.ensure();
    expect(token).toBe('FLOW minted-123');
    expect(calls[0]!.url).toBe(`${FILES_TOKEN_MINT_BASE_URL}/http/acct-1/refresh_token`);
  });

  it('keeps an existing FLOW prefix intact', async () => {
    const { fetchImpl } = okFetch('FLOW already');
    const m = new FilesTokenMinter({ getAccountId: () => 'a', fetchImpl });
    expect(await m.ensure()).toBe('FLOW already');
  });

  it('accepts access_token as the field name', async () => {
    const { fetchImpl } = stubFetch(() => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ access_token: 'alt' }),
    }));
    const m = new FilesTokenMinter({ getAccountId: () => 'a', fetchImpl });
    expect(await m.ensure()).toBe('FLOW alt');
  });

  it('caches within the TTL (one fetch for many ensures)', async () => {
    const { fetchImpl, calls } = okFetch();
    let t = 1_000;
    const m = new FilesTokenMinter({
      getAccountId: () => 'a',
      fetchImpl,
      now: () => t,
    });
    await m.ensure();
    t += FILES_TOKEN_TTL_MS - 1;
    await m.ensure();
    expect(calls).toHaveLength(1);
  });

  it('re-mints after the TTL expires', async () => {
    const { fetchImpl, calls } = okFetch();
    let t = 1_000;
    const m = new FilesTokenMinter({
      getAccountId: () => 'a',
      fetchImpl,
      now: () => t,
    });
    await m.ensure();
    t += FILES_TOKEN_TTL_MS + 1;
    await m.ensure();
    expect(calls).toHaveLength(2);
  });

  it('re-mints when the account changes (no cross-account reuse)', async () => {
    const { fetchImpl, calls } = okFetch();
    let acct = 'a1';
    const m = new FilesTokenMinter({ getAccountId: () => acct, fetchImpl });
    await m.ensure();
    acct = 'a2';
    await m.ensure();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain('/http/a2/');
  });

  it('returns null when signed out (no fetch fired)', async () => {
    const { fetchImpl, calls } = okFetch();
    const m = new FilesTokenMinter({ getAccountId: () => null, fetchImpl });
    expect(await m.ensure()).toBeNull();
    expect(m.get()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('invalidate() forces the next ensure to re-mint', async () => {
    const { fetchImpl, calls } = okFetch();
    const m = new FilesTokenMinter({ getAccountId: () => 'a', fetchImpl });
    await m.ensure();
    m.invalidate();
    await m.ensure();
    expect(calls).toHaveLength(2);
  });

  it('concurrent ensures share one in-flight mint', async () => {
    const { fetchImpl, calls } = okFetch();
    const m = new FilesTokenMinter({ getAccountId: () => 'a', fetchImpl });
    const [t1, t2, t3] = await Promise.all([m.ensure(), m.ensure(), m.ensure()]);
    expect(t1).toBe('FLOW minted-123');
    expect(t2).toBe(t1);
    expect(t3).toBe(t1);
    expect(calls).toHaveLength(1);
  });

  it('maps a non-OK response to FILES_NETWORK', async () => {
    const { fetchImpl } = stubFetch(() => ({ ok: false, status: 502, body: 'bad gateway' }));
    const m = new FilesTokenMinter({ getAccountId: () => 'a', fetchImpl });
    await expect(m.ensure()).rejects.toMatchObject({ code: 'FILES_NETWORK' });
  });

  it('maps a non-JSON body to FILES_NETWORK', async () => {
    const { fetchImpl } = stubFetch(() => ({ ok: true, status: 200, body: 'not json' }));
    const m = new FilesTokenMinter({ getAccountId: () => 'a', fetchImpl });
    await expect(m.ensure()).rejects.toMatchObject({ code: 'FILES_NETWORK' });
  });

  it('maps an empty token to FILES_NETWORK', async () => {
    const { fetchImpl } = stubFetch(() => ({ ok: true, status: 200, body: '{}' }));
    const m = new FilesTokenMinter({ getAccountId: () => 'a', fetchImpl });
    await expect(m.ensure()).rejects.toMatchObject({ code: 'FILES_NETWORK' });
  });

  it('maps a thrown fetch (offline) to FILES_NETWORK', async () => {
    const fetchImpl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;
    const m = new FilesTokenMinter({ getAccountId: () => 'a', fetchImpl });
    await expect(m.ensure()).rejects.toMatchObject({ code: 'FILES_NETWORK' });
  });
});

describe('FilesTokenMinter — account switching', () => {
  it('an in-flight mint is not reused across an account switch', async () => {
    // Review finding (2026-08-06): `pending` was not keyed by account,
    // so a mint started for acct-A could be handed to the next op
    // after the user switched to acct-B (server 403s until the
    // invalidate self-heal).
    let account = 'acct-A';
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(String(url));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ token: `tok-for-${String(url).match(/http\/([^/]+)\//)?.[1] ?? '?'}` }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const minter = new FilesTokenMinter({
      getAccountId: () => account,
      fetchImpl,
    });

    const first = minter.ensure();
    account = 'acct-B';
    const second = minter.ensure();
    await Promise.all([first, second]);
    // Two DIFFERENT accounts must produce two mint requests — the
    // second must not piggy-back on the first account's in-flight one.
    expect(seen.length, `mint URLs seen: ${seen.join(', ')}`).toBe(2);
    expect(seen[0]).toContain('acct-A');
    expect(seen[1]).toContain('acct-B');
  });
});

describe('SdkFilesClient + minted bearer', () => {
  interface CapturedSdkParams {
    token: () => string;
    discoveryUrl: string;
    accountId?: string;
  }

  it('the SDK bearer prefers the minted token and falls back to the raw binding', async () => {
    const captured: CapturedSdkParams[] = [];
    class FakeSdk {
      constructor(params: CapturedSdkParams) {
        captured.push(params);
      }
      async uploadFileV2(): Promise<{ url: string }> {
        return { url: 'https://x/y' };
      }
    }
    let minted: string | null = 'FLOW minted-xyz';
    const api = _buildFilesApiForTesting({
      token: () => 'raw-mult',
      discoveryUrl: 'https://disc.example',
      accountId: () => 'acct-1',
      sdkCtor: FakeSdk as never,
      ensureToken: async () => minted,
    });
    await api.upload('p', 'f.png', Buffer.from('x'));
    expect(captured).toHaveLength(1);
    // Minted token wins while present…
    expect(captured[0]!.token()).toBe('FLOW minted-xyz');
    // …and the raw binding is the fallback when the mint is unavailable.
    minted = null;
    await api.upload('p', 'f2.png', Buffer.from('x'));
    expect(captured[0]!.token()).toBe('raw-mult');
  });

  it('a mint OUTAGE does not fail the op — reads ride the raw binding token', async () => {
    // Review finding (2026-08-06): minting is an ENHANCEMENT (only
    // account-scoped WRITES need it). Hard-failing on a mint error
    // took down every thumbnail / preview / download whenever the
    // mint host was unreachable, where the raw token worked fine.
    const captured: CapturedSdkParams[] = [];
    let downloaded = 0;
    class FakeSdk {
      constructor(params: CapturedSdkParams) {
        captured.push(params);
      }
      async getDownloadUrl(): Promise<string> {
        downloaded++;
        return 'https://signed.example/f';
      }
      async uploadFileV2(): Promise<{ url: string }> {
        return { url: 'https://x/y' };
      }
    }
    const api = _buildFilesApiForTesting({
      token: () => 'raw-mult',
      discoveryUrl: 'https://disc.example',
      accountId: () => 'acct-1',
      sdkCtor: FakeSdk as never,
      ensureToken: async () => {
        throw new Error('mint host unreachable');
      },
    });
    // The op must still run, on the raw binding token.
    await expect(api.getDownloadUrl('some/key.png')).resolves.toBeTruthy();
    expect(downloaded).toBe(1);
    expect(captured[0]!.token()).toBe('raw-mult');
  });
});
