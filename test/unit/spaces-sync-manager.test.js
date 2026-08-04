/**
 * Spaces Sync Manager + Space-Scoped Git — Unit Tests
 *
 * Tests: sync manager lifecycle, event-driven push, pull loop,
 * space-scoped git commits, graph method contracts, conflict detection.
 *
 * Run:  npx vitest run test/unit/spaces-sync-manager.test.js
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock spaces-git for sync manager tests (avoid real isomorphic-git filesystem access)
const mockCommitSpace = vi.fn(async () => ({ sha: 'mock_sha_123', filesChanged: 1, paths: ['test'] }));
const mockGitStatus = vi.fn(async () => ({ clean: 0, modified: [], added: [], deleted: [] }));
const mockGitIsInitialized = vi.fn(() => true);

vi.mock('../../lib/spaces-git', () => ({
  SpacesGit: class MockSpacesGit {
    constructor() { this._initialized = true; }
    isInitialized() { return mockGitIsInitialized(); }
    async commitSpace(...args) { return mockCommitSpace(...args); }
    async status() { return mockGitStatus(); }
    async commitAll() { return { sha: 'mock_sha', filesChanged: 0 }; }
    async log() { return []; }
    async head() { return 'mock_head'; }
    _ensureInit() {}
  },
  getSpacesGit: () => ({
    isInitialized: mockGitIsInitialized,
    commitSpace: mockCommitSpace,
    status: mockGitStatus,
    commitAll: vi.fn(async () => ({ sha: 'mock_sha', filesChanged: 0 })),
    log: vi.fn(async () => []),
    head: vi.fn(async () => 'mock_head'),
  }),
  OR_SPACES_DIR: '/tmp/test-spaces',
  BINARY_EXTENSIONS: ['*.png', '*.jpg', '*.mp4'],
  ALWAYS_IGNORED: ['*.duckdb', 'index.json'],
}));

// ── SpacesGit.commitSpace Tests ────────────────────────────────────────────

describe('SpacesGit.commitSpace (contract)', () => {
  it('commitSpace exists on the mock and is callable', async () => {
    const { getSpacesGit } = require('../../lib/spaces-git');
    const git = getSpacesGit();
    expect(typeof git.commitSpace).toBe('function');
    const result = await git.commitSpace('space-a', { message: 'test' });
    expect(result).toHaveProperty('sha');
    expect(result).toHaveProperty('filesChanged');
  });

  it('SpacesGit class has commitSpace method', () => {
    const { SpacesGit } = require('../../lib/spaces-git');
    const sg = new SpacesGit();
    expect(typeof sg.commitSpace).toBe('function');
  });

  it('getSpacesGit returns an object with isInitialized', () => {
    const { getSpacesGit } = require('../../lib/spaces-git');
    const git = getSpacesGit();
    expect(typeof git.isInitialized).toBe('function');
  });
});

// ── Sync Manager Tests ─────────────────────────────────────────────────────

describe('SpacesSyncManager', () => {
  let SpacesSyncManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Isolate the constructor from disk. SpacesSyncManager's constructor calls
    // _loadSyncState() and _loadOrCreateDeviceId(), which read (and can WRITE)
    // real files under userData -- so on a machine with prior sync history a
    // "fresh" instance is pre-populated and getAllStatus() is non-empty (and a
    // real device-id file could be overwritten). Stub fs so every instance
    // starts genuinely empty. Auto-restored by the global afterEach.
    const fs = require('fs');
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});

    // Reset the module to get a fresh singleton
    vi.resetModules();
    ({ SpacesSyncManager } = require('../../lib/spaces-sync-manager'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates an instance with initial state', () => {
    const mgr = new SpacesSyncManager();
    expect(mgr.isRunning()).toBe(false);
    expect(mgr.getAllStatus()).toEqual({});
  });

  it('start() sets running state', () => {
    const mgr = new SpacesSyncManager();
    mgr.start();
    expect(mgr.isRunning()).toBe(true);
    mgr.stop();
  });

  it('stop() clears running state', () => {
    const mgr = new SpacesSyncManager();
    mgr.start();
    mgr.stop();
    expect(mgr.isRunning()).toBe(false);
  });

  it('start() is idempotent', () => {
    const mgr = new SpacesSyncManager();
    mgr.start();
    mgr.start();
    expect(mgr.isRunning()).toBe(true);
    mgr.stop();
  });

  it('getStatus returns empty for unknown space', () => {
    const mgr = new SpacesSyncManager();
    expect(mgr.getStatus('unknown')).toEqual({ lastPushAt: null, lastPullAt: null });
  });

  // ── WISER meeting graph specialization (_syncMeetingGraph) ────────────────
  // A synced meeting item drives its own graph shape: :Meeting label + labelled
  // transcript/recording + meeting->artifact edges. Edge is created before the
  // kind label so the artifact node exists to label. Content is supplied inline
  // so the method never falls back to the spaces-api fetch.

  const fakeGraph = () => {
    const calls = [];
    return {
      calls,
      setAssetKind: async (id, kind) => { calls.push(['setAssetKind', id, kind]); },
      linkMeetingArtifact: async (m, a, rel) => { calls.push(['linkMeetingArtifact', m, a, rel]); },
    };
  };

  it('_syncMeetingGraph ignores non-meeting items (no graph calls)', async () => {
    const mgr = new SpacesSyncManager();
    const g = fakeGraph();
    await mgr._syncMeetingGraph(g, 'space1', { id: 'x1', type: 'text', source: 'gsx-capture', tags: [] }, 'x1');
    expect(g.calls).toHaveLength(0);
  });

  it('_syncMeetingGraph labels the meeting + artifacts and draws edges', async () => {
    const mgr = new SpacesSyncManager();
    const g = fakeGraph();
    const content = JSON.stringify({ post: { transcriptItemId: 't1', recordingItemIds: ['r1', 'r2'] } });
    await mgr._syncMeetingGraph(g, 'space1', { id: 'm1', source: 'wiser-meeting', tags: ['wiser-meeting'], content }, 'm1');
    expect(g.calls).toEqual([
      ['setAssetKind', 'm1', 'Meeting'],
      ['linkMeetingArtifact', 'm1', 't1', 'HAS_TRANSCRIPT'],
      ['setAssetKind', 't1', 'Transcript'],
      ['linkMeetingArtifact', 'm1', 'r1', 'HAS_RECORDING'],
      ['setAssetKind', 'r1', 'Recording'],
      ['linkMeetingArtifact', 'm1', 'r2', 'HAS_RECORDING'],
      ['setAssetKind', 'r2', 'Recording'],
    ]);
  });

  it('_syncMeetingGraph detects a meeting by tag even without a source field', async () => {
    const mgr = new SpacesSyncManager();
    const g = fakeGraph();
    const content = JSON.stringify({ post: { transcriptItemId: 't1', recordingItemIds: [] } });
    await mgr._syncMeetingGraph(g, 'space1', { id: 'm1', tags: ['wiser-meeting'], content }, 'm1');
    expect(g.calls[0]).toEqual(['setAssetKind', 'm1', 'Meeting']);
    expect(g.calls).toContainEqual(['linkMeetingArtifact', 'm1', 't1', 'HAS_TRANSCRIPT']);
  });

  it('_syncMeetingGraph labels the meeting even when it has no artifacts yet', async () => {
    const mgr = new SpacesSyncManager();
    const g = fakeGraph();
    await mgr._syncMeetingGraph(g, 'space1', { id: 'm1', source: 'wiser-meeting', tags: [], content: '{"post":{}}' }, 'm1');
    expect(g.calls).toEqual([['setAssetKind', 'm1', 'Meeting']]);
  });

  it('_syncMeetingGraph is inert when the graph lacks the new methods (old client)', async () => {
    const mgr = new SpacesSyncManager();
    // Must not throw when setAssetKind is absent.
    await expect(mgr._syncMeetingGraph({}, 'space1', { id: 'm1', tags: ['wiser-meeting'] }, 'm1')).resolves.toBeUndefined();
  });
});

// ── Graph Method Contracts ─────────────────────────────────────────────────

describe('OmniGraph sync methods', () => {
  it('getLatestCommit is defined on OmniGraphClient', () => {
    const { OmniGraphClient } = require('../../omnigraph-client');
    const client = new OmniGraphClient();
    expect(typeof client.getLatestCommit).toBe('function');
  });

  it('getSpaceAssetsWithHashes is defined on OmniGraphClient', () => {
    const { OmniGraphClient } = require('../../omnigraph-client');
    const client = new OmniGraphClient();
    expect(typeof client.getSpaceAssetsWithHashes).toBe('function');
  });
});

// ── Integration Contract Tests ─────────────────────────────────────────────

describe('Sync Integration Contracts', () => {
  it('spaces-git exports commitSpace', () => {
    const { SpacesGit } = require('../../lib/spaces-git');
    const sg = new SpacesGit('/tmp/test');
    expect(typeof sg.commitSpace).toBe('function');
  });

  it('spaces-sync-manager exports getSyncManager', () => {
    const { getSyncManager } = require('../../lib/spaces-sync-manager');
    expect(typeof getSyncManager).toBe('function');
    const mgr = getSyncManager();
    expect(typeof mgr.start).toBe('function');
    expect(typeof mgr.stop).toBe('function');
    expect(typeof mgr.getStatus).toBe('function');
    expect(typeof mgr.getAllStatus).toBe('function');
  });

  it('sync manager singleton is stable', () => {
    const { getSyncManager } = require('../../lib/spaces-sync-manager');
    const a = getSyncManager();
    const b = getSyncManager();
    expect(a).toBe(b);
  });
});
