/**
 * TotpStore behavior tests.
 *
 * Drives the store directly with a Map-backed FakeKeychain:
 *   - saveSecret happy path
 *   - rejects invalid Base32 with TOTP_INVALID_SECRET
 *   - rejects keychain failures with TOTP_KEYCHAIN_FAILED
 *   - getCurrentCode rejects with TOTP_NO_SECRET when nothing stored
 *   - deleteSecret is idempotent
 *   - **TOKEN REDACTION** -- the secret value never appears in any log call
 */

import { describe, it, expect } from 'vitest';
import { TotpStore, type KeychainBackend } from '../../totp/store.js';
import { TotpError, TOTP_ERROR_CODES } from '../../totp/api.js';

const SAMPLE_SECRET = 'JBSWY3DPEHPK3PXP';
const SECOND_SECRET = 'KRSXG5CTMVRXEZLU';

class FakeKeychain implements KeychainBackend {
  readonly store = new Map<string, string>();
  failNext: 'set' | 'get' | 'delete' | null = null;

  async setPassword(service: string, account: string, password: string): Promise<void> {
    if (this.failNext === 'set') {
      this.failNext = null;
      throw new Error('fake keychain set failure');
    }
    this.store.set(`${service}::${account}`, password);
  }
  async getPassword(service: string, account: string): Promise<string | null> {
    if (this.failNext === 'get') {
      this.failNext = null;
      throw new Error('fake keychain get failure');
    }
    return this.store.get(`${service}::${account}`) ?? null;
  }
  async deletePassword(service: string, account: string): Promise<boolean> {
    if (this.failNext === 'delete') {
      this.failNext = null;
      throw new Error('fake keychain delete failure');
    }
    return this.store.delete(`${service}::${account}`);
  }
}

interface LoggedCall {
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: unknown;
}

function recordingLogger(): {
  calls: LoggedCall[];
  fn: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
} {
  const calls: LoggedCall[] = [];
  return {
    calls,
    fn: (level, message, data) => {
      calls.push({ level, message, data });
    },
  };
}

describe('TotpStore.saveSecret', () => {
  it('persists a valid secret + writes metadata', async () => {
    const keychain = new FakeKeychain();
    const store = new TotpStore({ keychain });
    const meta = await store.saveSecret(SAMPLE_SECRET, { issuer: 'OneReach', account: 'alice' });
    expect(meta.issuer).toBe('OneReach');
    expect(meta.account).toBe('alice');
    expect(meta.secretLength).toBe(SAMPLE_SECRET.length);

    expect(keychain.store.size).toBe(2); // secret + meta blob
    expect(keychain.store.get('OneReach.ai-TOTP::onereach-unified-login')).toBe(SAMPLE_SECRET);
    const metaBlob = keychain.store.get('OneReach.ai-TOTP-meta::onereach-unified-login');
    expect(metaBlob).toBeDefined();
    expect(JSON.parse(metaBlob ?? '{}')).toMatchObject({
      issuer: 'OneReach',
      account: 'alice',
    });
  });

  it('rejects invalid Base32 with TOTP_INVALID_SECRET', async () => {
    const store = new TotpStore({ keychain: new FakeKeychain() });
    await expect(store.saveSecret('!!!!!')).rejects.toBeInstanceOf(TotpError);
    await expect(store.saveSecret('!!!!!')).rejects.toMatchObject({
      code: TOTP_ERROR_CODES.INVALID_SECRET,
    });
  });

  it('rejects with TOTP_KEYCHAIN_FAILED when keychain throws', async () => {
    const keychain = new FakeKeychain();
    keychain.failNext = 'set';
    const store = new TotpStore({ keychain });
    await expect(store.saveSecret(SAMPLE_SECRET)).rejects.toMatchObject({
      code: TOTP_ERROR_CODES.KEYCHAIN_FAILED,
    });
  });

  it('overwrites a previously-stored secret', async () => {
    const keychain = new FakeKeychain();
    const store = new TotpStore({ keychain });
    await store.saveSecret(SAMPLE_SECRET);
    await store.saveSecret(SECOND_SECRET);
    expect(keychain.store.get('OneReach.ai-TOTP::onereach-unified-login')).toBe(SECOND_SECRET);
  });
});

describe('TotpStore.saveFromOtpAuthUri', () => {
  it('parses the URI and saves the secret with derived metadata', async () => {
    const keychain = new FakeKeychain();
    const store = new TotpStore({ keychain });
    const uri = `otpauth://totp/OneReach:alice@example.com?secret=${SAMPLE_SECRET}&issuer=OneReach`;
    const meta = await store.saveFromOtpAuthUri(uri);
    expect(meta.issuer).toBe('OneReach');
    expect(meta.account).toBe('alice@example.com');
    expect(keychain.store.get('OneReach.ai-TOTP::onereach-unified-login')).toBe(SAMPLE_SECRET);
  });
});

describe('TotpStore.hasSecret + getMetadata', () => {
  it('hasSecret returns false when nothing stored, true after save', async () => {
    const keychain = new FakeKeychain();
    const store = new TotpStore({ keychain });
    expect(await store.hasSecret()).toBe(false);
    await store.saveSecret(SAMPLE_SECRET);
    expect(await store.hasSecret()).toBe(true);
  });
  it('getMetadata returns null when nothing stored', async () => {
    const store = new TotpStore({ keychain: new FakeKeychain() });
    expect(await store.getMetadata()).toBeNull();
  });
  it('getMetadata returns the persisted blob', async () => {
    const store = new TotpStore({ keychain: new FakeKeychain() });
    await store.saveSecret(SAMPLE_SECRET, { issuer: 'OneReach', account: 'alice' });
    const meta = await store.getMetadata();
    expect(meta?.issuer).toBe('OneReach');
    expect(meta?.account).toBe('alice');
    expect(meta?.secretLength).toBe(SAMPLE_SECRET.length);
  });

  it('synthesizes metadata when the full app has a secret but lite metadata is absent', async () => {
    const keychain = new FakeKeychain();
    await keychain.setPassword('OneReach.ai-TOTP', 'onereach-unified-login', SAMPLE_SECRET);
    const store = new TotpStore({ keychain });

    expect(await store.hasSecret()).toBe(true);
    const meta = await store.getMetadata();
    expect(meta).toMatchObject({
      issuer: 'OneReach',
      account: 'configured in full app',
      secretLength: SAMPLE_SECRET.length,
    });
  });

  it('falls back to a legacy Lite-only secret if no full-app secret exists', async () => {
    const keychain = new FakeKeychain();
    await keychain.setPassword('OneReach.ai-Lite-TOTP', 'lite-totp-secret', SECOND_SECRET);
    const store = new TotpStore({ keychain });

    expect(await store.hasSecret()).toBe(true);
    const info = await store.getCurrentCode();
    expect(info.code).toMatch(/^\d{6}$/);
  });
});

describe('TotpStore.getCurrentCode', () => {
  it('returns code + countdown when secret is stored', async () => {
    const store = new TotpStore({ keychain: new FakeKeychain() });
    await store.saveSecret(SAMPLE_SECRET);
    const info = await store.getCurrentCode();
    expect(info.code).toMatch(/^\d{6}$/);
    expect(info.formattedCode).toMatch(/^\d{3} \d{3}$/);
    expect(info.timeRemaining).toBeGreaterThan(0);
    expect(info.timeRemaining).toBeLessThanOrEqual(30);
  });
  it('throws TOTP_NO_SECRET when nothing stored', async () => {
    const store = new TotpStore({ keychain: new FakeKeychain() });
    await expect(store.getCurrentCode()).rejects.toMatchObject({
      code: TOTP_ERROR_CODES.NO_SECRET,
    });
  });
  it('throws TOTP_KEYCHAIN_FAILED when keychain read fails', async () => {
    const keychain = new FakeKeychain();
    await keychain.setPassword('OneReach.ai-TOTP', 'onereach-unified-login', SAMPLE_SECRET);
    const store = new TotpStore({ keychain });
    keychain.failNext = 'get';
    await expect(store.getCurrentCode()).rejects.toMatchObject({
      code: TOTP_ERROR_CODES.KEYCHAIN_FAILED,
    });
  });
});

describe('TotpStore.deleteSecret', () => {
  it('removes the stored secret + metadata', async () => {
    const keychain = new FakeKeychain();
    const store = new TotpStore({ keychain });
    await store.saveSecret(SAMPLE_SECRET);
    expect(keychain.store.size).toBe(2);
    await store.deleteSecret();
    expect(keychain.store.size).toBe(0);
  });
  it('is idempotent (no-op when nothing stored)', async () => {
    const store = new TotpStore({ keychain: new FakeKeychain() });
    await expect(store.deleteSecret()).resolves.toBeUndefined();
  });
  it('throws TOTP_KEYCHAIN_FAILED when keychain throws', async () => {
    const keychain = new FakeKeychain();
    await keychain.setPassword('OneReach.ai-TOTP', 'onereach-unified-login', SAMPLE_SECRET);
    keychain.failNext = 'delete';
    const store = new TotpStore({ keychain });
    await expect(store.deleteSecret()).rejects.toMatchObject({
      code: TOTP_ERROR_CODES.KEYCHAIN_FAILED,
    });
  });
});

describe('TotpStore -- secret redaction (CRITICAL)', () => {
  it('never logs the secret value as a substring of any log call', async () => {
    const keychain = new FakeKeychain();
    const recorder = recordingLogger();
    const store = new TotpStore({ keychain, logger: recorder.fn });

    await store.saveSecret(SAMPLE_SECRET, { issuer: 'OneReach', account: 'alice' });
    await store.getMetadata();
    await store.getCurrentCode();
    await store.deleteSecret();

    const violations: LoggedCall[] = [];
    for (const call of recorder.calls) {
      if (call.message.includes(SAMPLE_SECRET)) {
        violations.push(call);
        continue;
      }
      const dataStr = call.data === undefined ? '' : JSON.stringify(call.data);
      if (dataStr.includes(SAMPLE_SECRET)) {
        violations.push(call);
      }
    }
    expect(
      violations,
      'TOTP secret leaked into log output: ' +
        violations.map((v) => `${v.level}: ${v.message}`).join(' | ')
    ).toEqual([]);
  });

  it('logs metadata (secretLength, issuer presence, account presence) without the secret', async () => {
    const keychain = new FakeKeychain();
    const recorder = recordingLogger();
    const store = new TotpStore({ keychain, logger: recorder.fn });

    await store.saveSecret(SAMPLE_SECRET, { issuer: 'OneReach', account: 'alice' });

    const saved = recorder.calls.filter((c) => c.message.includes('secret saved'));
    expect(saved.length).toBeGreaterThan(0);
    for (const c of saved) {
      const data = c.data as Record<string, unknown>;
      expect(typeof data['secretLength']).toBe('number');
      expect(data['hasIssuer']).toBe(true);
      expect(data['hasAccount']).toBe(true);
      expect((data as { secret?: unknown }).secret).toBeUndefined();
      expect((data as { value?: unknown }).value).toBeUndefined();
    }
  });
});
