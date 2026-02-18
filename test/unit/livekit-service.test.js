/**
 * LiveKit Service - CRUD Lifecycle Tests
 *
 * Lifecycle: Create room -> Read tokens -> Verify structure -> Save credentials -> Read credentials
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

const livekit = require('../../lib/livekit-service');

beforeEach(() => {
  mockSettings.clear();
  tokenCounter = 0;
});

// ═══════════════════════════════════════════════════════════════════
// ROOM LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

describe('LiveKit Service - Room CRUD Lifecycle', () => {
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
// TOKEN GENERATION
// ═══════════════════════════════════════════════════════════════════

describe('LiveKit Service - Token Generation', () => {
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
// CREDENTIALS CRUD
// ═══════════════════════════════════════════════════════════════════

describe('LiveKit Service - Credentials CRUD Lifecycle', () => {
  it('Step 1: Save credentials', () => {
    livekit.saveCredentials('wss://custom.livekit.cloud', 'myKey', 'mySecret');
    expect(mockSettings.get('livekitUrl')).toBe('wss://custom.livekit.cloud');
    expect(mockSettings.get('livekitApiKey')).toBe('myKey');
    expect(mockSettings.get('livekitApiSecret')).toBe('mySecret');
  });

  it('Step 2: Read credentials', () => {
    livekit.saveCredentials('wss://custom.livekit.cloud', 'myKey', 'mySecret');
    const creds = livekit.getCredentials();
    expect(creds.url).toBe('wss://custom.livekit.cloud');
    expect(creds.apiKey).toBe('myKey');
    expect(creds.apiSecret).toBe('mySecret');
  });

  it('Step 3: Update credentials', () => {
    livekit.saveCredentials('wss://v1.livekit.cloud', 'key1', 'secret1');
    livekit.saveCredentials('wss://v2.livekit.cloud', 'key2', 'secret2');
    const creds = livekit.getCredentials();
    expect(creds.url).toBe('wss://v2.livekit.cloud');
    expect(creds.apiKey).toBe('key2');
  });

  it('Step 4: Read defaults when no custom credentials', () => {
    mockSettings.clear();
    const creds = livekit.getCredentials();
    expect(creds.url).toBeTruthy();
    expect(creds.apiKey).toBeTruthy();
    expect(creds.apiSecret).toBeTruthy();
  });
});
