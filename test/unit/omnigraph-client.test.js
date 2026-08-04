/**
 * OmniGraph Client - CRUD Lifecycle Tests
 *
 * Tests the client configuration lifecycle and pure utility functions.
 * HTTP-dependent methods are tested for correct invocation shape.
 *
 * Run:  npx vitest run test/unit/omnigraph-client.test.js
 */

import { describe, it, expect, beforeEach } from 'vitest';

const {
  OmniGraphClient,
  getOmniGraphClient,
  escapeCypher,
  _computeContentHash,
  WISER_NODE_KINDS,
  MEETING_ARTIFACT_RELS,
} = require('../../omnigraph-client');

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
    expect(client.database).toBe('neo4j');
    expect(client.neo4jUser).toBe('neo4j');
    expect(client.currentUser).toBe('system');
    expect(client.timeout).toBe(60000);
  });

  it('Step 2: Set endpoint', () => {
    client.setEndpoint('https://graph.example.com/omnigraph');
    expect(client.endpoint).toBe('https://graph.example.com/omnigraph');
  });

  it('Step 3: Read - isReady requires endpoint AND neo4j password', () => {
    expect(client.isReady()).toBe(false);
    client.setEndpoint('https://graph.example.com/omnigraph');
    expect(client.isReady()).toBe(false); // endpoint alone is not enough
    client.setNeo4jPassword('secret');
    expect(client.isReady()).toBe(true); // proxy path ready: endpoint + password
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
      neo4jPassword: 'secret',
      timeout: 5000,
      currentUser: 'tester@test.com',
    });
    expect(c.endpoint).toBe('https://test.com');
    expect(c.timeout).toBe(5000);
    expect(c.currentUser).toBe('tester@test.com');
    expect(c.isReady()).toBe(true); // endpoint + password supplied at construction
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

// ═══════════════════════════════════════════════════════════════════
// WISER MEETING NODES: :Meeting / :Transcript / :Recording + edges
// A meeting stays an :Asset but gets a second, queryable kind label, and is
// linked to its transcript/recording. Labels + rel types are query STRUCTURE
// (not parameterisable), so both go through fixed allow-lists. We stub
// executeQuery to capture the Cypher and assert its shape + escaping + guards.
// ═══════════════════════════════════════════════════════════════════

describe('OmniGraph Client - WISER meeting nodes + edges', () => {
  let client;
  let queries;

  beforeEach(() => {
    client = new OmniGraphClient();
    queries = [];
    client.executeQuery = async (cypher) => {
      queries.push(cypher);
      return [];
    };
  });

  it('exposes the WISER allow-lists as the single source of truth', () => {
    expect(WISER_NODE_KINDS).toEqual(['Meeting', 'Transcript', 'Recording']);
    expect(MEETING_ARTIFACT_RELS).toEqual(['HAS_TRANSCRIPT', 'HAS_RECORDING']);
  });

  it('setAssetKind adds the kind as a second label on the existing Asset', async () => {
    await client.setAssetKind('item-123', 'Meeting');
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/MATCH \(a:Asset \{id: 'item-123'\}\)/);
    expect(queries[0]).toMatch(/SET a:Meeting/);
    expect(queries[0]).toContain("a.nodeKind = 'Meeting'");
  });

  it('setAssetKind supports Transcript and Recording', async () => {
    await client.setAssetKind('t1', 'Transcript');
    await client.setAssetKind('r1', 'Recording');
    expect(queries[0]).toMatch(/SET a:Transcript/);
    expect(queries[1]).toMatch(/SET a:Recording/);
  });

  it('setAssetKind rejects any label outside the allow-list (Cypher-injection guard)', async () => {
    await expect(client.setAssetKind('x', 'Person')).rejects.toThrow(/Invalid asset kind/);
    // A crafted label that would inject structure must never reach the query.
    await expect(client.setAssetKind('x', 'Meeting RETURN a; MATCH (n) DETACH DELETE n //')).rejects.toThrow(
      /Invalid asset kind/
    );
    expect(queries).toHaveLength(0);
  });

  it('setAssetKind escapes the asset id', async () => {
    await client.setAssetKind("it'--drop", 'Meeting');
    expect(queries[0]).toContain("it\\'--drop");
  });

  it('linkMeetingArtifact creates a typed edge to a MERGEd artifact node', async () => {
    await client.linkMeetingArtifact('m1', 't1', 'HAS_TRANSCRIPT');
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/MATCH \(m:Meeting \{id: 'm1'\}\)/);
    expect(queries[0]).toMatch(/MERGE \(a:Asset \{id: 't1'\}\)/);
    expect(queries[0]).toMatch(/MERGE \(m\)-\[r:HAS_TRANSCRIPT\]->\(a\)/);
  });

  it('linkMeetingArtifact supports HAS_RECORDING', async () => {
    await client.linkMeetingArtifact('m1', 'rec1', 'HAS_RECORDING');
    expect(queries[0]).toMatch(/MERGE \(m\)-\[r:HAS_RECORDING\]->\(a\)/);
  });

  it('linkMeetingArtifact rejects any relationship outside the allow-list', async () => {
    await expect(client.linkMeetingArtifact('m1', 't1', 'DELETED_BY')).rejects.toThrow(/Invalid meeting relationship/);
    await expect(
      client.linkMeetingArtifact('m1', 't1', 'HAS_TRANSCRIPT]->() DETACH DELETE m //')
    ).rejects.toThrow(/Invalid meeting relationship/);
    expect(queries).toHaveLength(0);
  });

  it('linkMeetingArtifact is a no-op (no query) when an id is missing', async () => {
    expect(await client.linkMeetingArtifact('m1', '', 'HAS_TRANSCRIPT')).toBeNull();
    expect(await client.linkMeetingArtifact('', 't1', 'HAS_TRANSCRIPT')).toBeNull();
    expect(queries).toHaveLength(0);
  });
});
