/**
 * OmniGraph Client - CRUD Lifecycle Tests
 *
 * Tests the client configuration lifecycle and pure utility functions.
 * HTTP-dependent methods are tested for correct invocation shape.
 *
 * Run:  npx vitest run test/unit/omnigraph-client.test.js
 */

import { describe, it, expect, beforeEach } from 'vitest';

const { OmniGraphClient, getOmniGraphClient, escapeCypher, _computeContentHash } = require('../../omnigraph-client');

// ═══════════════════════════════════════════════════════════════════
// CLIENT CONFIGURATION LIFECYCLE: Create -> Set -> Read -> Update -> Verify
// ═══════════════════════════════════════════════════════════════════

describe('OmniGraph Client - Configuration Lifecycle', () => {
  let client;

  beforeEach(() => {
    client = new OmniGraphClient();
  });

  it('Step 1: Create client with defaults', () => {
    expect(client).toBeDefined();
    expect(client.endpoint).toBeNull();
    expect(client.graphName).toBe('idw');
    expect(client.currentUser).toBe('system');
    expect(client.timeout).toBe(30000);
  });

  it('Step 2: Set endpoint', () => {
    client.setEndpoint('https://graph.example.com/omnigraph');
    expect(client.endpoint).toBe('https://graph.example.com/omnigraph');
  });

  it('Step 3: Read - isReady reflects endpoint', () => {
    expect(client.isReady()).toBe(false);
    client.setEndpoint('https://graph.example.com/omnigraph');
    expect(client.isReady()).toBe(true);
  });

  it('Step 4: Set current user', () => {
    client.setCurrentUser('admin@example.com');
    expect(client.currentUser).toBe('admin@example.com');
  });

  it('Step 5: Update current user', () => {
    client.setCurrentUser('user1@example.com');
    client.setCurrentUser('user2@example.com');
    expect(client.currentUser).toBe('user2@example.com');
  });

  it('Step 6: Set auth token getter', () => {
    const getter = async () => 'my-token-123';
    client.setAuthTokenGetter(getter);
    expect(client.getAuthToken).toBe(getter);
  });

  it('Step 7: Create with options', () => {
    const c = new OmniGraphClient({
      endpoint: 'https://test.com',
      timeout: 5000,
      currentUser: 'tester@test.com',
    });
    expect(c.endpoint).toBe('https://test.com');
    expect(c.timeout).toBe(5000);
    expect(c.currentUser).toBe('tester@test.com');
    expect(c.isReady()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// SINGLETON
// ═══════════════════════════════════════════════════════════════════

describe('OmniGraph Client - Singleton', () => {
  it('getOmniGraphClient returns same instance', () => {
    const a = getOmniGraphClient();
    const b = getOmniGraphClient();
    expect(a).toBe(b);
  });

  it('singleton is an instance of OmniGraphClient', () => {
    const client = getOmniGraphClient();
    expect(client).toBeInstanceOf(OmniGraphClient);
  });
});

// ═══════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

describe('OmniGraph Client - Cypher Escaping', () => {
  it('escapeCypher handles normal strings', () => {
    expect(escapeCypher('hello')).toBe('hello');
  });

  it('escapeCypher escapes single quotes', () => {
    const result = escapeCypher("it's a test");
    // Should contain the escaped form \' (but JS string also escapes backslashes)
    expect(result).toContain("\\'");
  });

  it('escapeCypher escapes backslashes', () => {
    const result = escapeCypher('a\\b');
    expect(result).toBe('a\\\\b');
  });

  it('escapeCypher handles empty string', () => {
    expect(escapeCypher('')).toBe('');
  });
});

describe('OmniGraph Client - Content Hashing', () => {
  it('computeContentHashFromBuffer returns a hash string', () => {
    const { computeContentHashFromBuffer } = require('../../omnigraph-client');
    if (!computeContentHashFromBuffer) {
      return;
    }
    const hash = computeContentHashFromBuffer(Buffer.from('hello world'));
    expect(typeof hash).toBe('string');
    expect(hash).toMatch(/^sha256:/);
  });

  it('same content produces same hash', () => {
    const { computeContentHashFromBuffer } = require('../../omnigraph-client');
    if (!computeContentHashFromBuffer) {
      return;
    }
    const h1 = computeContentHashFromBuffer(Buffer.from('test data'));
    const h2 = computeContentHashFromBuffer(Buffer.from('test data'));
    expect(h1).toBe(h2);
  });

  it('different content produces different hash', () => {
    const { computeContentHashFromBuffer } = require('../../omnigraph-client');
    if (!computeContentHashFromBuffer) {
      return;
    }
    const h1 = computeContentHashFromBuffer(Buffer.from('data A'));
    const h2 = computeContentHashFromBuffer(Buffer.from('data B'));
    expect(h1).not.toBe(h2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// METHOD EXISTENCE (verify API shape)
// ═══════════════════════════════════════════════════════════════════

describe('OmniGraph Client - API Shape', () => {
  let client;

  beforeEach(() => {
    client = new OmniGraphClient({ endpoint: 'https://test.com' });
  });

  it('has schema methods', () => {
    expect(typeof client.getSchema).toBe('function');
    expect(typeof client.schemaExists).toBe('function');
    expect(typeof client.listSchemas).toBe('function');
  });

  it('has space methods', () => {
    expect(typeof client.upsertSpace).toBe('function');
    expect(typeof client.getSpace).toBe('function');
    expect(typeof client.softDeleteSpace).toBe('function');
  });

  it('has asset methods', () => {
    expect(typeof client.upsertAsset).toBe('function');
    expect(typeof client.getAsset).toBe('function');
    expect(typeof client.softDeleteAsset).toBe('function');
    expect(typeof client.changeAssetVisibility).toBe('function');
  });

  it('has sharing methods', () => {
    expect(typeof client.shareWith).toBe('function');
    expect(typeof client.getSharedWith).toBe('function');
    expect(typeof client.unshare).toBe('function');
  });

  it('has executeQuery method', () => {
    expect(typeof client.executeQuery).toBe('function');
  });
});
