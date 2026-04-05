/**
 * Spaces Sync Manager
 *
 * Event-driven bidirectional sync between local Spaces and OmniGraph.
 *
 * Push: SpacesAPI write events -> debounced git commit + graph upsert
 * Pull: Periodic loop -> discover remote spaces + sync items
 *
 * Reconciliation model:
 * - Every change carries a timestamp and device ID
 * - Conflicts resolved by last-write-wins using timestamps
 * - Pending pushes survive graph unavailability (queued and retried)
 * - Sync state persisted to disk so restarts don't re-pull everything
 * - Items created by pull are flagged to avoid push-back loops
 *
 * @module spaces-sync-manager
 */

const { getLogQueue } = require('./log-event-queue');
const path = require('path');
const fs = require('fs');
const os = require('os');
const log = getLogQueue();

const PUSH_DEBOUNCE_MS = 2000;
const PULL_INTERVAL_MS = 60000;
const MAX_PULL_FAILURES = 5;
const PUSH_TIMEOUT_MS = 15000;
const SYNC_STATE_FILE = path.join(os.homedir(), 'Documents', 'OR-Spaces', '.sync-state.json');
const DEVICE_ID_FILE = path.join(os.homedir(), 'Documents', 'OR-Spaces', '.device-id');

class SpacesSyncManager {
  constructor() {
    this._pushTimers = new Map();
    this._pendingPushes = new Map();
    this._pullTimer = null;
    this._pullFailures = 0;
    this._syncState = new Map();
    this._started = false;
    this._suppressPushForIds = new Set();
    this._deviceId = this._loadOrCreateDeviceId();
    this._loadSyncState();
  }

  // ── Device Identity ────────────────────────────────────────────────────

  _loadOrCreateDeviceId() {
    try {
      if (fs.existsSync(DEVICE_ID_FILE)) {
        return fs.readFileSync(DEVICE_ID_FILE, 'utf8').trim();
      }
      const id = `device_${os.hostname()}_${Date.now().toString(36)}`;
      fs.mkdirSync(path.dirname(DEVICE_ID_FILE), { recursive: true });
      fs.writeFileSync(DEVICE_ID_FILE, id);
      return id;
    } catch {
      return `device_${os.hostname()}_fallback`;
    }
  }

  // ── Persistent Sync State ──────────────────────────────────────────────

  _loadSyncState() {
    try {
      if (fs.existsSync(SYNC_STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(SYNC_STATE_FILE, 'utf8'));
        if (data && typeof data === 'object') {
          for (const [k, v] of Object.entries(data)) {
            this._syncState.set(k, v);
          }
        }
      }
    } catch { /* fresh state */ }
  }

  _saveSyncState() {
    try {
      const data = {};
      this._syncState.forEach((v, k) => { data[k] = v; });
      fs.mkdirSync(path.dirname(SYNC_STATE_FILE), { recursive: true });
      fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(data, null, 2));
    } catch { /* non-fatal */ }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  start() {
    if (this._started) return;
    this._started = true;
    this._hookSpacesAPI();
    this._startPullLoop();
    log.info('sync-manager', 'Started', { deviceId: this._deviceId });
  }

  stop() {
    this._started = false;
    this._pushTimers.forEach(t => clearTimeout(t));
    this._pushTimers.clear();
    if (this._pullTimer) {
      clearTimeout(this._pullTimer);
      this._pullTimer = null;
    }
    this._saveSyncState();
    log.info('sync-manager', 'Stopped');
  }

  // ── Event Hooks ────────────────────────────────────────────────────────

  _hookSpacesAPI() {
    try {
      const { getSpacesAPI } = require('../spaces-api');
      const api = getSpacesAPI();

      const syncEvents = new Set([
        'space:created', 'space:updated', 'space:deleted',
        'item:added', 'item:updated', 'item:deleted',
        'item:moved', 'item:tags:updated',
      ]);

      // Patch _emit to intercept all events (bulletproof -- no singleton issues)
      const originalEmit = api._emit.bind(api);
      api._emit = (event, data) => {
        originalEmit(event, data);
        if (syncEvents.has(event)) {
          try {
            this._onWriteEvent(event, data);
          } catch (err) {
            log.error('sync-manager', 'Event handler error', { event, error: err.message });
          }
        }
      };

      log.info('sync-manager', 'Hooked events', { count: syncEvents.size, method: 'emit-patch' });
    } catch (e) {
      log.warn('sync-manager', 'Hook failed', { error: e.message });
    }
  }

  _onWriteEvent(event, data) {
    const spaceId = data?.spaceId || data?.space?.id || data?.fromSpaceId || data?.toSpaceId || data?.item?.spaceId;
    if (!spaceId) return;

    const itemId = data?.itemId || data?.item?.id;

    // Suppress push for items we just pulled (avoid sync loops)
    if (itemId && this._suppressPushForIds.has(itemId)) {
      this._suppressPushForIds.delete(itemId);
      return;
    }

    this._debouncedPush(spaceId, event, data);

    // For item:moved, also push the destination space
    if (event === 'item:moved' && data?.toSpaceId && data.toSpaceId !== spaceId) {
      this._debouncedPush(data.toSpaceId, event, data);
    }
  }

  // ── Push ───────────────────────────────────────────────────────────────

  _isGraphAvailable() {
    try {
      const { getOmniGraphClient } = require('../omnigraph-client');
      const graph = getOmniGraphClient();
      return !!(graph?.endpoint);
    } catch {
      return false;
    }
  }

  _debouncedPush(spaceId, event, data) {
    if (this._pushTimers.has(spaceId)) {
      clearTimeout(this._pushTimers.get(spaceId));
    }

    // Track pending push data (latest event wins within debounce window)
    this._pendingPushes.set(spaceId, { event, data, queuedAt: Date.now() });

    const timer = setTimeout(async () => {
      this._pushTimers.delete(spaceId);
      const pending = this._pendingPushes.get(spaceId);
      this._pendingPushes.delete(spaceId);
      if (!pending) return;

      try {
        const pushPromise = this._pushSpace(spaceId, pending.event, pending.data);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Push timed out')), PUSH_TIMEOUT_MS)
        );
        await Promise.race([pushPromise, timeoutPromise]);
      } catch (e) {
        log.warn('sync-manager', 'Push failed', { spaceId, error: e.message });
        // Re-queue for retry on next change or next pull cycle
        const state = this._syncState.get(spaceId) || {};
        state.pendingPush = true;
        state.lastPushError = e.message;
        state.lastPushErrorAt = Date.now();
        this._syncState.set(spaceId, state);
        this._saveSyncState();
      }
    }, PUSH_DEBOUNCE_MS);

    this._pushTimers.set(spaceId, timer);
  }

  async _pushSpace(spaceId, triggerEvent, triggerData) {
    // 1. Git commit (space-scoped)
    let commitResult = { sha: null, filesChanged: 0 };
    try {
      const { getSpacesGit } = require('./spaces-git');
      const git = getSpacesGit();
      if (git.isInitialized()) {
        const itemIds = triggerData?.itemId ? [triggerData.itemId] : [];
        commitResult = await git.commitSpace(spaceId, {
          message: `${triggerEvent}: ${triggerData?.itemId || spaceId}`,
          authorName: this._deviceId,
          itemIds,
        });
      }
    } catch (e) {
      log.warn('sync-manager', 'Git commit failed', { spaceId, error: e.message });
    }

    // 2. Push to graph
    if (!this._isGraphAvailable()) return;

    const { getOmniGraphClient, escapeCypher } = require('../omnigraph-client');
    const graph = getOmniGraphClient();
    const { getSpacesAPI } = require('../spaces-api');
    const api = getSpacesAPI();
    const esc = (s) => escapeCypher ? escapeCypher(s) : String(s || '').replace(/'/g, "\\'");
    const now = Date.now();

    if (triggerEvent === 'space:deleted') {
      // Soft-delete in graph
      try {
        await graph.softDeleteSpace(spaceId);
        log.info('sync-manager', 'Space soft-deleted in graph', { spaceId });
      } catch (e) {
        log.warn('sync-manager', 'Graph delete failed', { spaceId, error: e.message });
      }
    } else {
      // Upsert space
      try {
        const spaceData = await api.get(spaceId);
        if (spaceData) {
          await graph.upsertSpace({
            id: spaceId,
            name: spaceData.name || spaceId,
            description: spaceData.description || '',
            icon: spaceData.icon || '',
            color: spaceData.color || '#64c8ff',
          });
        }
      } catch (e) {
        log.warn('sync-manager', 'Space upsert failed', { spaceId, error: e.message });
        throw e;
      }

      // Upsert item as asset (if item event)
      if (triggerEvent === 'item:deleted' && triggerData?.itemId) {
        try {
          await graph.softDeleteAsset(triggerData.itemId);
        } catch (e) {
          log.warn('sync-manager', 'Asset delete failed', { itemId: triggerData.itemId, error: e.message });
        }
      } else if (triggerData?.itemId) {
        try {
          const item = triggerData.item || {};
          await graph.upsertAsset({
            id: item.id || triggerData.itemId,
            title: item.preview || item.title || triggerData.itemId,
            type: item.type || 'text',
            tags: (item.tags || []).join(','),
            visibility: 'private',
          }, spaceId, item.type || 'text');
        } catch (e) {
          log.warn('sync-manager', 'Asset upsert failed', { itemId: triggerData.itemId, error: e.message });
        }
      }

      // Create commit node
      if (commitResult.sha) {
        try {
          await graph.executeQuery(`
            MERGE (c:Commit {hash: '${esc(commitResult.sha)}'})
            ON CREATE SET c.message = '${esc(triggerEvent)}',
                          c.author = '${esc(this._deviceId)}',
                          c.timestamp = ${now},
                          c.spaceId = '${esc(spaceId)}'
            WITH c
            MATCH (s:Space {id: '${esc(spaceId)}'})
            MERGE (c)-[:IN_SPACE]->(s)
          `);
        } catch (e) {
          log.warn('sync-manager', 'Commit node failed', { error: e.message });
        }
      }
    }

    // Update sync state
    const state = this._syncState.get(spaceId) || {};
    state.lastPushAt = now;
    state.lastPushSha = commitResult.sha;
    state.lastPushDevice = this._deviceId;
    state.pendingPush = false;
    state.lastPushError = null;
    this._syncState.set(spaceId, state);
    this._saveSyncState();

    log.info('sync-manager', 'Pushed', { spaceId, sha: commitResult.sha?.slice(0, 8), trigger: triggerEvent });
  }

  // ── Pull ───────────────────────────────────────────────────────────────

  _startPullLoop() {
    const tick = async () => {
      if (!this._started) return;

      try {
        await this._pullAll();
        this._pullFailures = 0;
      } catch (e) {
        this._pullFailures++;
        log.warn('sync-manager', 'Pull failed', { error: e.message, failures: this._pullFailures });
      }

      // Recover from max failures after a longer backoff (don't stop permanently)
      const maxBackoff = 300000; // 5 minutes
      let interval = PULL_INTERVAL_MS;
      if (this._pullFailures > 0) {
        interval = Math.min(PULL_INTERVAL_MS * Math.pow(2, this._pullFailures), maxBackoff);
      }
      if (this._pullFailures >= MAX_PULL_FAILURES) {
        interval = maxBackoff; // Slow down but don't stop
      }

      this._pullTimer = setTimeout(tick, interval);
    };

    this._pullTimer = setTimeout(tick, 15000);
  }

  async _pullAll() {
    if (!this._isGraphAvailable()) return;

    const { getSpacesAPI } = require('../spaces-api');
    const api = getSpacesAPI();
    const { getOmniGraphClient } = require('../omnigraph-client');
    const graph = getOmniGraphClient();

    // Step 1: Discover and auto-import new remote spaces
    await this._discoverAndImport(api);

    // Step 2: Retry any pending pushes from failed attempts
    await this._retryPendingPushes(api);

    // Step 3: Sync items for all local spaces
    const spaces = api.list();
    if (!spaces?.length) return;

    for (const space of spaces) {
      if (space.isSystem) continue;
      try {
        await this._pullSpace(space.id, graph, api);
      } catch (e) {
        log.warn('sync-manager', 'Pull space failed', { spaceId: space.id, error: e.message });
      }
    }
  }

  async _retryPendingPushes(api) {
    for (const [spaceId, state] of this._syncState) {
      if (!state.pendingPush) continue;
      try {
        log.info('sync-manager', 'Retrying pending push', { spaceId });
        await this._pushSpace(spaceId, 'retry-push', {});
      } catch (e) {
        log.warn('sync-manager', 'Retry push failed', { spaceId, error: e.message });
      }
    }
  }

  async _discoverAndImport(api) {
    try {
      const result = await api.discovery.discoverRemoteSpaces();
      if (!result.spaces?.length) return;

      log.info('sync-manager', 'Discovered remote spaces', { count: result.spaces.length });

      for (const remote of result.spaces) {
        try {
          const importResult = await api.discovery.importRemoteSpace(remote);
          if (importResult.success) {
            log.info('sync-manager', 'Auto-imported space', { spaceId: remote.id, name: remote.name });
            // Suppress the push that the import will trigger
            this._suppressPushForIds.add(remote.id);
          }
        } catch (e) {
          log.warn('sync-manager', 'Import failed', { spaceId: remote.id, error: e.message });
        }
      }
    } catch (e) {
      // Discovery requires a valid user email -- silently skip if not configured
      if (!e.message?.includes('No valid user email')) {
        log.warn('sync-manager', 'Discovery failed', { error: e.message });
      }
    }
  }

  async _pullSpace(spaceId, graph, api) {
    const state = this._syncState.get(spaceId) || {};
    const lastPullAt = state.lastPullAt || 0;

    // Check remote for newer commits
    const remoteCommit = await graph.getLatestCommit(spaceId);
    if (!remoteCommit?.timestamp) return;

    // Skip if remote commit is from this device (we already have it)
    if (remoteCommit.author === this._deviceId && remoteCommit.timestamp <= (state.lastPushAt || 0)) {
      return;
    }

    if (remoteCommit.timestamp <= lastPullAt) return;

    // Fetch remote assets
    const remoteAssets = await graph.getSpaceAssetsWithHashes(spaceId);
    if (!remoteAssets?.length) {
      state.lastPullAt = Date.now();
      this._syncState.set(spaceId, state);
      this._saveSyncState();
      return;
    }

    // Get local items for comparison
    const localItems = await api.items.list(spaceId, { limit: 500 });
    const localById = new Map((localItems || []).map(i => [i.id, i]));

    let imported = 0;
    let updated = 0;
    let conflicts = 0;

    for (const remote of remoteAssets) {
      if (!remote.id) continue;
      const local = localById.get(remote.id);

      if (!local) {
        // Remote-only: create locally
        try {
          this._suppressPushForIds.add(remote.id);
          await api.items.add(spaceId, {
            id: remote.id,
            type: remote.type || 'text',
            content: remote.title || '',
            source: 'graph-sync',
            preview: remote.title || remote.id,
            tags: remote.tags ? remote.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
            metadata: {
              title: remote.title,
              source: 'graph-sync',
              contentHash: remote.contentHash,
              fileUrl: remote.fileUrl,
              syncedAt: new Date().toISOString(),
              syncDevice: this._deviceId,
            },
          });
          imported++;
        } catch (e) {
          this._suppressPushForIds.delete(remote.id);
          log.warn('sync-manager', 'Import item failed', { spaceId, assetId: remote.id, error: e.message });
        }
      } else if (remote.contentHash && local.contentHash !== remote.contentHash) {
        const remoteTime = remote.updatedAt || 0;
        const localTime = local.timestamp || 0;
        const timeDiff = Math.abs(remoteTime - localTime);

        if (timeDiff < 5000) {
          // Within 5 seconds -- potential conflict
          conflicts++;
          log.warn('sync-manager', 'Conflict detected', {
            spaceId,
            itemId: remote.id,
            remoteTime,
            localTime,
            timeDiff,
            remoteHash: remote.contentHash?.slice(0, 8),
            localHash: local.contentHash?.slice(0, 8),
          });
          // Flag the item for manual resolution
          try {
            await api.items.update(spaceId, local.id, {
              metadata: {
                syncConflict: true,
                syncConflictAt: new Date().toISOString(),
                remoteContentHash: remote.contentHash,
                remoteUpdatedAt: remoteTime,
              },
            });
            this._suppressPushForIds.add(local.id);
          } catch {}
        } else if (remoteTime > localTime) {
          // Remote is clearly newer -- update local
          try {
            this._suppressPushForIds.add(local.id);
            await api.items.update(spaceId, local.id, {
              metadata: {
                contentHash: remote.contentHash,
                fileUrl: remote.fileUrl,
                syncedAt: new Date().toISOString(),
                syncDevice: this._deviceId,
                syncConflict: false,
              },
            });
            updated++;
          } catch (e) {
            this._suppressPushForIds.delete(local.id);
            log.warn('sync-manager', 'Update from remote failed', { spaceId, itemId: local.id, error: e.message });
          }
        }
        // If localTime > remoteTime, local wins -- no action needed (push will update remote)
      }
    }

    // Check for items deleted remotely (exist locally but not in remote)
    const remoteIds = new Set(remoteAssets.map(a => a.id).filter(Boolean));
    for (const [localId, localItem] of localById) {
      if (localItem.source === 'graph-sync' && !remoteIds.has(localId)) {
        // Item was synced from graph before but no longer exists remotely
        // Don't auto-delete -- flag it
        try {
          await api.items.update(spaceId, localId, {
            metadata: { syncRemoteDeleted: true, syncRemoteDeletedAt: new Date().toISOString() },
          });
          this._suppressPushForIds.add(localId);
        } catch {}
      }
    }

    state.lastPullAt = Date.now();
    state.lastRemoteCommit = remoteCommit.hash;
    state.lastPullImported = imported;
    state.lastPullUpdated = updated;
    state.lastPullConflicts = conflicts;
    this._syncState.set(spaceId, state);
    this._saveSyncState();

    if (imported > 0 || updated > 0 || conflicts > 0) {
      log.info('sync-manager', 'Pulled', { spaceId, imported, updated, conflicts });
    }
  }

  // ── Status ─────────────────────────────────────────────────────────────

  getStatus(spaceId) {
    return this._syncState.get(spaceId) || { lastPushAt: null, lastPullAt: null };
  }

  getAllStatus() {
    const result = {};
    this._syncState.forEach((state, id) => { result[id] = state; });
    return result;
  }

  getDeviceId() {
    return this._deviceId;
  }

  isRunning() {
    return this._started;
  }

  /** Force an immediate sync cycle for a specific space. */
  async forcePush(spaceId) {
    await this._pushSpace(spaceId, 'force-push', {});
  }

  /** Force an immediate pull for all spaces. */
  async forcePull() {
    await this._pullAll();
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let _instance = null;

function getSyncManager() {
  if (!_instance) {
    _instance = new SpacesSyncManager();
  }
  return _instance;
}

module.exports = { SpacesSyncManager, getSyncManager };
