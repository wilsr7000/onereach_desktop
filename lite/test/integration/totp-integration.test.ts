/**
 * Integration test for lite/totp.
 *
 * Drives the full TotpApi pipeline (manager + store + scanner) against
 * a Map-backed FakeKeychain and a fake QR scanner that emits a
 * pre-baked otpauth URI. Verifies the end-to-end save-from-QR path
 * and the manual-entry path produce identical persisted state.
 *
 * The renderer-window flow (authenticator.html -> IPC -> main) is
 * deferred to E2E (`totp-authenticator-e2e` in PORTING.md).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock electron + native deps so the static `import { ... } from 'electron'`
// in window.ts / qr-scanner.ts resolves in the vitest Node runner.
// The TotpApi we build here injects custom keychain + scanner so these
// stubs never get reached in practice.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  shell: { openExternal: () => Promise.resolve() },
  clipboard: {
    readImage: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toBitmap: () => Buffer.alloc(0) }),
  },
  desktopCapturer: { getSources: async () => [] },
  screen: {
    getPrimaryDisplay: () => ({ workAreaSize: { width: 1, height: 1 }, scaleFactor: 1, id: 0 }),
    getDisplayNearestPoint: () => ({ workAreaSize: { width: 1, height: 1 }, scaleFactor: 1, id: 0 }),
  },
}));
vi.mock('keytar', () => ({
  setPassword: async () => undefined,
  getPassword: async () => null,
  deletePassword: async () => false,
}));
vi.mock('jsqr', () => ({ default: () => null }));

import { _buildTotpApiForTesting, type TotpApi } from '../../totp/api.js';
import type { KeychainBackend } from '../../totp/store.js';
import { QrScanner } from '../../totp/qr-scanner.js';

const SECRET = 'JBSWY3DPEHPK3PXP';
const ACCOUNT = 'alice@example.com';
const ISSUER = 'OneReach';
const URI = `otpauth://totp/${ISSUER}:${ACCOUNT}?secret=${SECRET}&issuer=${ISSUER}&algorithm=SHA1&digits=6&period=30`;

class MapKeychain implements KeychainBackend {
  readonly store = new Map<string, string>();
  async setPassword(s: string, a: string, p: string): Promise<void> {
    this.store.set(`${s}::${a}`, p);
  }
  async getPassword(s: string, a: string): Promise<string | null> {
    return this.store.get(`${s}::${a}`) ?? null;
  }
  async deletePassword(s: string, a: string): Promise<boolean> {
    return this.store.delete(`${s}::${a}`);
  }
}

/**
 * QrScanner subclass that lets the test emit canned scan results
 * without going through Electron's `desktopCapturer` / `clipboard`.
 */
class FakeScanner extends QrScanner {
  nextScreenResult: string | null = null;
  nextClipboardResult: string | null = null;
  override async scanFromScreen(): Promise<string | null> {
    return this.nextScreenResult;
  }
  override async scanFromClipboard(): Promise<string | null> {
    return this.nextClipboardResult;
  }
}

let api: TotpApi;
let keychain: MapKeychain;
let scanner: FakeScanner;

beforeEach(() => {
  keychain = new MapKeychain();
  scanner = new FakeScanner();
  api = _buildTotpApiForTesting({ keychain, scanner });
});

describe('totp integration -- end-to-end pipelines', () => {
  it('save-from-screen-QR persists the same state as manual entry', async () => {
    scanner.nextScreenResult = URI;
    const fromQr = await api.scanQrFromScreen();
    expect(fromQr.saved).toBe(true);
    expect(fromQr.issuer).toBe(ISSUER);
    expect(fromQr.account).toBe(ACCOUNT);

    const codeFromQr = await api.getCurrentCode();

    // Reset and try manual.
    await api.deleteSecret();
    expect(await api.hasSecret()).toBe(false);

    const manual = await api.saveSecret(SECRET, { issuer: ISSUER, account: ACCOUNT });
    expect(manual.saved).toBe(true);

    const codeFromManual = await api.getCurrentCode();
    expect(codeFromManual.code).toBe(codeFromQr.code);
  });

  it('clipboard-QR path produces the same persisted secret', async () => {
    scanner.nextClipboardResult = URI;
    const result = await api.scanQrFromClipboard();
    expect(result.saved).toBe(true);

    expect(await api.hasSecret()).toBe(true);
    const meta = await api.getMetadata();
    expect(meta?.issuer).toBe(ISSUER);
    expect(meta?.account).toBe(ACCOUNT);
  });

  it('scan-with-no-QR returns reason="no-qr-found", does NOT save', async () => {
    scanner.nextScreenResult = null;
    const result = await api.scanQrFromScreen();
    expect(result.saved).toBe(false);
    expect(result.reason).toBe('no-qr-found');
    expect(await api.hasSecret()).toBe(false);
  });

  it('scan with a non-otpauth QR returns reason="not-authenticator-qr"', async () => {
    scanner.nextScreenResult = 'https://example.com/some-link';
    const result = await api.scanQrFromScreen();
    expect(result.saved).toBe(false);
    expect(result.reason).toBe('not-authenticator-qr');
    expect(await api.hasSecret()).toBe(false);
  });

  it('persistence shape under the right keychain service names', async () => {
    await api.saveSecret(SECRET, { issuer: ISSUER, account: ACCOUNT });
    expect(keychain.store.has('OneReach.ai-TOTP::onereach-unified-login')).toBe(true);
    expect(keychain.store.has('OneReach.ai-TOTP-meta::onereach-unified-login')).toBe(true);
  });

  it('deleteSecret clears both the secret and metadata blobs', async () => {
    await api.saveSecret(SECRET);
    expect(keychain.store.size).toBe(2);
    await api.deleteSecret();
    expect(keychain.store.size).toBe(0);
    expect(await api.hasSecret()).toBe(false);
    expect(await api.getMetadata()).toBeNull();
  });
});
