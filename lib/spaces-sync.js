/**
 * Spaces Sync Layer
 *
 * Coordinates three existing systems to give Spaces a git-like remote backend:
 * - isomorphic-git (lib/spaces-git.js)  -- local commits, diffs, history
 * - GSX File Sync  (gsx-file-sync.js)   -- remote file storage (blobs)
 * - OmniGraph      (omnigraph-client.js) -- remote metadata, entities, relationships
 *
 * Push: commit locally -> upload changed files to GSX Files -> upsert metadata to OmniGraph
 * Pull: fetch remote metadata from OmniGraph -> download files from GSX Files -> apply locally
 */

const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

// ---------------------------------------------------------------------------
// Push: local -> remote
// ---------------------------------------------------------------------------

/**
 * Push local changes to GSX Files + OmniGraph.
 *
 * @param {string} spaceId  - Space to push
 * @param {Object} [opts]
 * @param {string}   [opts.message]       - Commit message (auto-committed if working tree is dirty)
 * @param {string}   [opts.author]        - Commit author name
 * @param {Array}    [opts.assets]        - Asset metadata to upsert in the graph [{id, title, type, tags}]
 * @param {Array}    [opts.ticketUpdates] - Ticket status updates [{id, status, output}]
 * @returns {Promise<{ committed: boolean, sha?: string, filesPushed: number, graphUpdated: boolean }>}
 */
async function push(spaceId, opts = {}) {
  const { message = 'Sync push', author = 'spaces-sync', assets = [], ticketUpdates = [] } = opts;

  const result = {
    committed: false,
    sha: null,
    filesPushed: 0,
    graphUpdated: false,
  };

  // ---- 1. Local git commit (if there are changes) ----
  try {
    const { getSpacesGit } = require('./spaces-git');
    const git = getSpacesGit();

    const status = await git.status();
    const hasChanges = status.modified.length > 0 || status.added.length > 0 || status.deleted.length > 0;

    if (hasChanges) {
      const commitResult = await git.commitAll({
        message,
        authorName: author,
        authorEmail: `${author}@gsx.local`,
      });
      result.committed = true;
      result.sha = commitResult.sha;
      log.info('sync', 'Committed locally', { sha: commitResult.sha, files: commitResult.filesChanged });
    } else {
      // Get HEAD sha for graph reference
      try {
        const logEntries = await git.log({ depth: 1 });
        result.sha = logEntries[0]?.sha || null;
      } catch (err) {
        console.warn('[spaces-sync] Get HEAD sha for graph reference:', err.message);
      }
    }
  } catch (err) {
    log.warn('sync', 'Git commit failed (non-fatal)', { error: err.message });
  }

  // ---- 2. Push files to GSX Files ----
  try {
    const { getGSXFileSync } = require('../gsx-file-sync');
    const fileSync = getGSXFileSync();

    if (fileSync && typeof fileSync.pushFiles === 'function') {
      const pushResult = await fileSync.pushFiles(spaceId);
      result.filesPushed = pushResult?.pushed || 0;
      log.info('sync', 'Files pushed to GSX', { count: result.filesPushed });
    } else if (fileSync && typeof fileSync.syncSpace === 'function') {
      await fileSync.syncSpace(spaceId);
      log.info('sync', 'Space synced to GSX Files');
    }
  } catch (err) {
    log.warn('sync', 'GSX file push failed (non-fatal)', { error: err.message });
  }

  // ---- 3. Push metadata to OmniGraph ----
  try {
    const { getOmniGraphClient } = require('../omnigraph-client');
    const graph = getOmniGraphClient();

    if (!graph || !graph.endpoint) {
      log.info('sync', 'OmniGraph not configured, skipping graph push');
    } else {
      // Upsert space node
      await graph.upsertSpace({ id: spaceId, name: spaceId });

      // Upsert assets
      for (const asset of assets) {
        try {
          await graph.upsertAsset(
            {
              id: asset.id,
              title: asset.title || asset.id,
              type: asset.type || 'file',
              tags: asset.tags || [],
              visibility: 'private',
            },
            spaceId,
            asset.type || 'file'
          );
        } catch (assetErr) {
          log.warn('sync', 'Asset upsert failed', { id: asset.id, error: assetErr.message });
        }
      }

      // Create commit node and link to space
      if (result.sha) {
        try {
          const escapeCypher = (s) =>
            String(s || '')
              .replace(/'/g, "\\'")
              .replace(/\\/g, '\\\\');
          const commitCypher = `
            MERGE (c:Commit {hash: '${escapeCypher(result.sha)}'})
            ON CREATE SET c.message = '${escapeCypher(message)}',
                          c.author = '${escapeCypher(author)}',
                          c.timestamp = ${Date.now()},
                          c.spaceId = '${escapeCypher(spaceId)}'
            WITH c
            MATCH (s:Space {id: '${escapeCypher(spaceId)}'})
            MERGE (c)-[:IN_SPACE]->(s)
            RETURN c
          `;
          await graph.executeQuery(commitCypher);

          // Link commit to assets
          for (const asset of assets) {
            try {
              const linkCypher = `
                MATCH (c:Commit {hash: '${escapeCypher(result.sha)}'})
                MATCH (a:Asset {id: '${escapeCypher(asset.id)}'})
                MERGE (c)-[:PRODUCED]->(a)
                RETURN c, a
              `;
              await graph.executeQuery(linkCypher);
            } catch (err) {
              console.warn('[spaces-sync] Link commit to asset failed:', err.message);
            }
          }
        } catch (commitErr) {
          log.warn('sync', 'Commit node creation failed', { error: commitErr.message });
        }
      }

      // Update ticket statuses
      for (const ticket of ticketUpdates) {
        try {
          const escapeCypher = (s) =>
            String(s || '')
              .replace(/'/g, "\\'")
              .replace(/\\/g, '\\\\');
          const ticketCypher = `
            MERGE (t:Ticket {id: '${escapeCypher(ticket.id)}'})
            ON MATCH SET t.status = '${escapeCypher(ticket.status)}',
                         t.lastOutput = '${escapeCypher((ticket.output || '').substring(0, 500))}',
                         t.updatedAt = ${Date.now()}
            ${
              result.sha
                ? `
            WITH t
            MATCH (c:Commit {hash: '${escapeCypher(result.sha)}'})
            MERGE (c)-[:PROCESSED]->(t)
            `
                : ''
            }
            RETURN t
          `;
          await graph.executeQuery(ticketCypher);
        } catch (ticketErr) {
          log.warn('sync', 'Ticket update failed', { id: ticket.id, error: ticketErr.message });
        }
      }

      result.graphUpdated = true;
      log.info('sync', 'Graph updated', { assets: assets.length, tickets: ticketUpdates.length });
    }
  } catch (err) {
    log.warn('sync', 'OmniGraph push failed (non-fatal)', { error: err.message });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Pull: remote -> local
// ---------------------------------------------------------------------------

/**
 * Pull remote changes and apply locally.
 * Currently a placeholder -- full bidirectional sync is a future enhancement.
 *
 * @param {string} spaceId
 * @returns {Promise<{ pulled: boolean, message: string }>}
 */
async function pull(spaceId) {
  // For now, pull just fetches remote metadata from the graph
  // Full file pull from GSX Files is a future enhancement
  try {
    const { getOmniGraphClient } = require('../omnigraph-client');
    const graph = getOmniGraphClient();

    if (!graph || !graph.endpoint) {
      return { pulled: false, message: 'OmniGraph not configured' };
    }

    // Fetch latest space state from graph
    const space = await graph.getSpace(spaceId);
    if (!space) {
      return { pulled: false, message: 'Space not found in graph' };
    }

    // Fetch latest commit
    const escapeCypher = (s) =>
      String(s || '')
        .replace(/'/g, "\\'")
        .replace(/\\/g, '\\\\');
    const commitQuery = `
      MATCH (c:Commit)-[:IN_SPACE]->(s:Space {id: '${escapeCypher(spaceId)}'})
      RETURN c
      ORDER BY c.timestamp DESC
      LIMIT 1
    `;
    const commits = await graph.executeQuery(commitQuery);
    const latestRemoteCommit = commits?.[0]?.c;

    return {
      pulled: true,
      message: 'Fetched remote state',
      remoteCommit: latestRemoteCommit?.hash || null,
      remoteTimestamp: latestRemoteCommit?.timestamp || null,
    };
  } catch (err) {
    log.warn('sync', 'Pull failed', { error: err.message });
    return { pulled: false, message: err.message };
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Get sync status for a space.
 *
 * @param {string} spaceId
 * @returns {Promise<{ localHead?: string, remoteHead?: string, ahead: number, behind: number, lastSynced?: string }>}
 */
async function status(spaceId) {
  const result = {
    localHead: null,
    remoteHead: null,
    ahead: 0,
    behind: 0,
    lastSynced: null,
    dirty: false,
  };

  // Local HEAD
  try {
    const { getSpacesGit } = require('./spaces-git');
    const git = getSpacesGit();
    const logEntries = await git.log({ depth: 1 });
    result.localHead = logEntries[0]?.sha || null;

    const gitStatus = await git.status();
    result.dirty = gitStatus.modified.length > 0 || gitStatus.added.length > 0 || gitStatus.deleted.length > 0;
  } catch (_ignored) {
    /* git status may fail if not a git repo */
  }

  // Remote HEAD from graph
  try {
    const { getOmniGraphClient } = require('../omnigraph-client');
    const graph = getOmniGraphClient();

    if (graph && graph.endpoint) {
      const escapeCypher = (s) =>
        String(s || '')
          .replace(/'/g, "\\'")
          .replace(/\\/g, '\\\\');
      const commitQuery = `
        MATCH (c:Commit)-[:IN_SPACE]->(s:Space {id: '${escapeCypher(spaceId)}'})
        RETURN c.hash, c.timestamp
        ORDER BY c.timestamp DESC
        LIMIT 1
      `;
      const commits = await graph.executeQuery(commitQuery);
      if (commits?.[0]) {
        result.remoteHead = commits[0]['c.hash'] || null;
        result.lastSynced = commits[0]['c.timestamp'] ? new Date(commits[0]['c.timestamp']).toISOString() : null;
      }
    }
  } catch (err) {
    console.warn('[spaces-sync] Get remote HEAD failed:', err.message);
  }

  // Simple ahead/behind: if local differs from remote, we're ahead
  if (result.localHead && result.remoteHead && result.localHead !== result.remoteHead) {
    result.ahead = 1; // Simplified: we know there's at least 1 unsynced commit
  }

  return result;
}

// ---------------------------------------------------------------------------
// Discovery Polling: check graph for new remote spaces
// ---------------------------------------------------------------------------

let discoveryTimer = null;
let discoveryFailures = 0;
const MAX_BACKOFF_FAILURES = 5;
const MIN_POLL_INTERVAL = 30000; // 30 seconds minimum

/**
 * Run a single discovery check and broadcast results if new spaces found.
 *
 * @param {Function} [broadcastFn] - Optional (win) => win.webContents.send(...)
 * @returns {Promise<Object>} Discovery result { spaces, email, lastChecked }
 */
async function discoverRemote(broadcastFn) {
  try {
    const { getSpacesAPI } = require('../spaces-api');
    const api = getSpacesAPI();
    const result = await api.discovery.discoverRemoteSpaces();

    discoveryFailures = 0; // reset backoff on success

    if (result.spaces && result.spaces.length > 0) {
      log.info('sync', 'Discovered new remote spaces', { count: result.spaces.length });

      if (typeof broadcastFn === 'function') {
        broadcastFn({
          type: 'spaces:remote-discovered',
          spaces: result.spaces,
          email: result.email,
          lastChecked: result.lastChecked,
        });
      }
    }

    return result;
  } catch (err) {
    discoveryFailures++;
    log.warn('sync', 'Discovery check failed', { error: err.message, failures: discoveryFailures });
    return { spaces: [], error: err.message };
  }
}

/**
 * Start automatic discovery polling.
 *
 * @param {Object} opts
 * @param {number}   [opts.intervalMs=60000]  - Poll interval in milliseconds (min 30s)
 * @param {Function} [opts.broadcastFn]       - Callback to broadcast to windows
 * @returns {{ stop: Function }} Handle with stop() to clear polling
 */
function startDiscoveryPolling(opts = {}) {
  const { broadcastFn } = opts;
  let intervalMs = Math.max(opts.intervalMs || 60000, MIN_POLL_INTERVAL);

  stopDiscoveryPolling();
  discoveryFailures = 0;

  log.info('sync', 'Starting discovery polling', { intervalMs });

  const tick = async () => {
    await discoverRemote(broadcastFn);

    // Exponential backoff on repeated failures
    if (discoveryFailures > 0 && discoveryFailures <= MAX_BACKOFF_FAILURES) {
      const backoff = intervalMs * Math.pow(2, discoveryFailures);
      discoveryTimer = setTimeout(tick, Math.min(backoff, 5 * 60 * 1000)); // max 5 min
    } else if (discoveryFailures > MAX_BACKOFF_FAILURES) {
      log.warn('sync', 'Discovery polling paused after repeated failures', { failures: discoveryFailures });
      // Stop polling; user can restart manually
      return;
    } else {
      discoveryTimer = setTimeout(tick, intervalMs);
    }
  };

  // First check after a short delay to let the app settle
  discoveryTimer = setTimeout(tick, 5000);

  return { stop: stopDiscoveryPolling };
}

/**
 * Stop discovery polling if running.
 */
function stopDiscoveryPolling() {
  if (discoveryTimer) {
    clearTimeout(discoveryTimer);
    discoveryTimer = null;
    log.info('sync', 'Discovery polling stopped');
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  push,
  pull,
  status,
  discoverRemote,
  startDiscoveryPolling,
  stopDiscoveryPolling,
};
