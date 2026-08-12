/**
 * LiveKit Service - credential modes and token minting
 *
 * Hosting resolves credentials in precedence order:
 *   - server-mint:   settings `livekitMintUrl` (GSX function holds the secret)
 *   - local:         settings `livekitUrl`/`livekitApiKey`/`livekitApiSecret`
 *   - legacy-shared: in-code fallback so hosting works with zero config
 *     (deliberately retained until the credential rotation lands — see
 *     docs/internal/WISER-MEETING-SECURITY.md §3; the leaked-credential
 *     scan keeps the pair contained to lib/livekit-service.js)
 *
 * Run:  npx vitest run test/unit/livekit-service.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock log-event-queue
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mutable auth token for the server-mint path, injected through the
// service's test seam (the real gsx-flow-context is Electron-wired).
const mintMocks = { authToken: 'gsx-auth-token' };

// Mock livekit-server-sdk
let tokenCounter = 0;
vi.mock(
  'livekit-server-sdk',
  () => {
    class MockAccessToken {
      constructor(apiKey, apiSecret, opts) {
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.identity = opts?.identity;
        this.ttl = opts?.ttl;
        this.grants = [];
      }
      addGrant(grant) {
        this.grants.push(grant);
      }
      async toJwt() {
        return `jwt-${this.identity}-${++tokenCounter}`;
      }
    }
    return { AccessToken: MockAccessToken };
  },
  { virtual: true }
);

// Mock global settingsManager
const mockSettings = new Map();
global.settingsManager = {
  get: (key) => mockSettings.get(key) || null,
  set: (key, value) => mockSettings.set(key, value),
};

const livekit = require('../../lib/meeting/livekit-service');
livekit._setAuthTokenProviderForTests(() => mintMocks.authToken);

function seedLocalCreds() {
  mockSettings.set('livekitUrl', 'wss://custom.livekit.cloud');
  mockSettings.set('livekitApiKey', 'myKey');
  mockSettings.set('livekitApiSecret', 'mySecret');
}

beforeEach(() => {
  mockSettings.clear();
  tokenCounter = 0;
  mintMocks.authToken = 'gsx-auth-token';
  vi.unstubAllGlobals();
});

// ═══════════════════════════════════════════════════════════════════
// ROOM LIFECYCLE (local credentials mode)
// ═══════════════════════════════════════════════════════════════════

describe('LiveKit Service - Room CRUD Lifecycle (local mode)', () => {
  beforeEach(seedLocalCreds);

  it('Step 1: Create a room', async () => {
    const result = await livekit.createRoom('test-meeting', 2);
    expect(result).toBeDefined();
    expect(result.roomName).toBe('test-meeting');
  });

  it('Step 2: Read host token', async () => {
    const result = await livekit.createRoom('test-meeting', 2);
    expect(result.hostToken).toBeTruthy();
    expect(typeof result.hostToken).toBe('string');
    expect(result.hostToken.length).toBeGreaterThan(0);
  });

  it('Step 3: Read guest tokens', async () => {
    const result = await livekit.createRoom('test-meeting', 3);
    expect(result.guestTokens).toHaveLength(3);
    result.guestTokens.forEach((token) => {
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    });
  });

  it('Step 4: Verify room structure', async () => {
    const result = await livekit.createRoom('my-room', 2);
    expect(result).toHaveProperty('roomName', 'my-room');
    expect(result).toHaveProperty('hostToken');
    expect(result).toHaveProperty('guestTokens');
    expect(result).toHaveProperty('livekitUrl');
    expect(result.livekitUrl).toContain('livekit');
  });
});

// ═══════════════════════════════════════════════════════════════════
// TOKEN GENERATION (local credentials mode)
// ═══════════════════════════════════════════════════════════════════

describe('LiveKit Service - Token Generation', () => {
  beforeEach(seedLocalCreds);

  it('should generate a host token', async () => {
    const token = await livekit.generateToken('room-1', 'host', { isHost: true });
    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');
  });

  it('should generate a guest token', async () => {
    const token = await livekit.generateToken('room-1', 'guest-0', { isHost: false });
    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');
  });

  it('host and guest tokens are different', async () => {
    const hostToken = await livekit.generateToken('room-1', 'host', { isHost: true });
    const guestToken = await livekit.generateToken('room-1', 'guest-0', { isHost: false });
    expect(hostToken).not.toBe(guestToken);
  });
});

// ═══════════════════════════════════════════════════════════════════
// LEGACY SHARED FALLBACK: zero-config hosting must keep working as-is
// until the credential rotation lands (then this block flips to the
// hard-fail expectations — see the runbook)
// ═══════════════════════════════════════════════════════════════════

describe('LiveKit Service - legacy shared fallback (zero config)', () => {
  it('getCredentials returns a complete credential set with nothing configured', () => {
    const creds = livekit.getCredentials();
    expect(creds).toBeTruthy();
    expect(creds.url).toMatch(/^wss:\/\//);
    expect(creds.apiKey).toBeTruthy();
    expect(creds.apiSecret).toBeTruthy();
  });

  it('getConfiguredMode reports legacy-shared when nothing is configured', () => {
    expect(livekit.getConfiguredMode()).toBe('legacy-shared');
  });

  it('createRoom works out of the box with zero configuration', async () => {
    const result = await livekit.createRoom('zero-config-room', 2);
    expect(result.roomName).toBe('zero-config-room');
    expect(result.hostToken).toBeTruthy();
    expect(result.guestTokens).toHaveLength(2);
    expect(result.livekitUrl).toMatch(/^wss:\/\//);
  });

  it('partial settings fall back wholesale (no mixing url/key/secret across sources)', () => {
    mockSettings.set('livekitUrl', 'wss://custom.livekit.cloud');
    mockSettings.set('livekitApiKey', 'myKey');
    // No secret — the half-configured set must not be mixed with fallback parts
    const creds = livekit.getCredentials();
    expect(creds.apiKey).not.toBe('myKey');
    expect(creds.url).not.toBe('wss://custom.livekit.cloud');
    expect(livekit.getConfiguredMode()).toBe('legacy-shared');
  });

  it('complete per-account settings win over the legacy fallback', () => {
    seedLocalCreds();
    expect(livekit.getCredentials()).toEqual({
      url: 'wss://custom.livekit.cloud',
      apiKey: 'myKey',
      apiSecret: 'mySecret',
    });
    expect(livekit.getConfiguredMode()).toBe('local');
  });
});

// ═══════════════════════════════════════════════════════════════════
// CREDENTIALS CRUD
// ═══════════════════════════════════════════════════════════════════

describe('LiveKit Service - credentials CRUD', () => {
  it('save -> read round-trip', () => {
    const saved = livekit.saveCredentials('wss://custom.livekit.cloud', 'myKey', 'mySecret');
    expect(saved).toBe(true);
    expect(livekit.getCredentials()).toEqual({
      url: 'wss://custom.livekit.cloud',
      apiKey: 'myKey',
      apiSecret: 'mySecret',
    });
  });

  it('update overwrites previous credentials', () => {
    livekit.saveCredentials('wss://v1.livekit.cloud', 'key1', 'secret1');
    livekit.saveCredentials('wss://v2.livekit.cloud', 'key2', 'secret2');
    const creds = livekit.getCredentials();
    expect(creds.url).toBe('wss://v2.livekit.cloud');
    expect(creds.apiKey).toBe('key2');
  });
});

// ═══════════════════════════════════════════════════════════════════
// SERVER-SIDE MINT MODE
// ═══════════════════════════════════════════════════════════════════

describe('LiveKit Service - server-side mint mode', () => {
  const MINT_URL = 'https://mint.example.test/livekit-mint';

  function stubFetch(impl) {
    const fn = vi.fn(impl);
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  beforeEach(() => {
    mockSettings.set('livekitMintUrl', MINT_URL);
  });

  it('getConfiguredMode prefers server-mint over local creds', () => {
    expect(livekit.getConfiguredMode()).toBe('server-mint');
    seedLocalCreds();
    expect(livekit.getConfiguredMode()).toBe('server-mint');
  });

  it('non-https mint URLs are ignored (falls back to legacy mode)', () => {
    mockSettings.set('livekitMintUrl', 'http://mint.example.test/livekit-mint');
    expect(livekit.getConfiguredMode()).toBe('legacy-shared');
  });

  it('createRoom POSTs to the mint endpoint with GSX auth and maps the response', async () => {
    const fetchMock = stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        hostToken: 'h-1',
        guestTokens: ['g-1', 'g-2'],
        livekitUrl: 'wss://minted.livekit.cloud',
      }),
    }));

    const result = await livekit.createRoom('team-sync', 2);
    expect(result).toEqual({
      roomName: 'team-sync',
      hostToken: 'h-1',
      guestTokens: ['g-1', 'g-2'],
      livekitUrl: 'wss://minted.livekit.cloud',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(MINT_URL);
    expect(opts.method).toBe('POST');
    expect(opts.headers.n).toBe('gsx-auth-token');
    expect(JSON.parse(opts.body)).toEqual({ roomName: 'team-sync', guestCount: 2 });
  });

  it('rejects when not signed in to GSX (no auth token)', async () => {
    mintMocks.authToken = null;
    stubFetch(async () => {
      throw new Error('should not be called');
    });
    await expect(livekit.createRoom('team-sync', 2)).rejects.toThrow(/sign in to gsx/i);
  });

  it('rejects on a non-2xx mint response', async () => {
    stubFetch(async () => ({ ok: false, status: 403, json: async () => ({}) }));
    await expect(livekit.createRoom('team-sync', 2)).rejects.toThrow(/403/);
  });

  it('rejects an invalid mint response shape', async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ hostToken: 'h-1', guestTokens: [], livekitUrl: 'wss://x' }),
    }));
    await expect(livekit.createRoom('team-sync', 2)).rejects.toThrow(/invalid response/i);
  });

  it('rejects a mint response whose livekitUrl is not wss://', async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ hostToken: 'h-1', guestTokens: ['g-1'], livekitUrl: 'https://attacker.example' }),
    }));
    await expect(livekit.createRoom('team-sync', 2)).rejects.toThrow(/invalid response/i);
  });
});
