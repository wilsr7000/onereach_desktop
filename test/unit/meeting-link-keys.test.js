/**
 * lib/meeting-link-keys.js -- persistent meeting-payload signing keypair
 *
 * The KV meeting-token store accepts unauthenticated writes, so the
 * host signs every payload and guests verify against the public key in
 * the join link (#k=...). These tests cover generation, persistence,
 * sign/verify interop with the exact WebCrypto calls the guest page
 * makes, corruption recovery, and rotation.
 *
 * Run:  npx vitest run test/unit/meeting-link-keys.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const SETTINGS_KEY = 'meetingLinkSigningKeyV1';

const mockSettings = new Map();
global.settingsManager = {
  get: (key) => mockSettings.get(key) || null,
  set: (key, value) => mockSettings.set(key, value),
};

// The module caches the keypair in module scope; resetKeyPair() is the
// public way to drop both the cache and the persisted record, so tests
// use it for isolation instead of relying on module-registry resets.
const keys = require('../../lib/meeting-link-keys');

const fromB64u = (s) => Uint8Array.from(Buffer.from(s, 'base64url'));

async function verifyLikeGuestPage(publicKeyB64u, payload, sigB64u) {
  const key = await webcrypto.subtle.importKey(
    'raw',
    fromB64u(publicKeyB64u),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  return webcrypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    fromB64u(sigB64u),
    new TextEncoder().encode(payload)
  );
}

beforeEach(() => {
  keys.resetKeyPair(); // drop the in-memory cache from the previous test
  mockSettings.clear();
});

describe('meeting-link-keys', () => {
  it('generates and persists a keypair on first use', async () => {
    const pub = await keys.getPublicKeyB64u();
    expect(pub).toBeTruthy();
    const stored = JSON.parse(mockSettings.get(SETTINGS_KEY));
    expect(stored.publicKeyRaw).toBe(pub);
    expect(stored.privateKeyJwk).toBeTruthy();
    // Raw uncompressed P-256 point is 65 bytes
    expect(fromB64u(pub)).toHaveLength(65);
  });

  it('reloads the same keypair from the persisted record (app relaunch)', async () => {
    const pub1 = await keys.getPublicKeyB64u();
    const record = mockSettings.get(SETTINGS_KEY);
    keys.resetKeyPair(); // drop cache AND stored record
    mockSettings.set(SETTINGS_KEY, record); // relaunch: record is back, cache is cold
    const pub2 = await keys.getPublicKeyB64u();
    expect(pub2).toBe(pub1);
  });

  it('signs payloads that verify with the guest page WebCrypto path', async () => {
    const payload = JSON.stringify({ v: 2, roomName: 'team-sync', tokens: ['t'], livekitUrl: 'wss://x' });
    const sig = await keys.signPayload(payload);
    const pub = await keys.getPublicKeyB64u();
    expect(await verifyLikeGuestPage(pub, payload, sig)).toBe(true);
    expect(await verifyLikeGuestPage(pub, payload + 'tampered', sig)).toBe(false);
  });

  it('signatures from a reloaded keypair still verify (same key material)', async () => {
    const pub = await keys.getPublicKeyB64u();
    const record = mockSettings.get(SETTINGS_KEY);
    keys.resetKeyPair();
    mockSettings.set(SETTINGS_KEY, record);
    const payload = 'payload-after-relaunch';
    const sig = await keys.signPayload(payload); // signed by the RELOADED private key
    expect(await verifyLikeGuestPage(pub, payload, sig)).toBe(true);
  });

  it('regenerates when the stored record is corrupted', async () => {
    const pub1 = await keys.getPublicKeyB64u();
    keys.resetKeyPair();
    mockSettings.set(SETTINGS_KEY, '{not json');
    const pub2 = await keys.getPublicKeyB64u();
    expect(pub2).toBeTruthy();
    expect(pub2).not.toBe(pub1);
    // And the regenerated key is persisted + usable
    const sig = await keys.signPayload('x');
    expect(await verifyLikeGuestPage(pub2, 'x', sig)).toBe(true);
  });

  it('resetKeyPair rotates to a fresh keypair', async () => {
    const pub1 = await keys.getPublicKeyB64u();
    keys.resetKeyPair();
    const pub2 = await keys.getPublicKeyB64u();
    expect(pub2).not.toBe(pub1);
  });

  it('rejects when no settings manager is available', async () => {
    const saved = global.settingsManager;
    try {
      global.settingsManager = null;
      await expect(keys.getPublicKeyB64u()).rejects.toThrow(/settings/i);
    } finally {
      global.settingsManager = saved;
    }
  });
});
