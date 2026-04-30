/**
 * Task Graph Store
 *
 * Thin convenience layer over omnigraph-client for CRUD on the
 * TaskQueue + TaskItem schema defined in scripts/omnigraph-schemas-export.json.
 *
 * Schema (already registered in the graph):
 *   (:TaskQueue { id, name, status, created_at, updated_at })
 *   (:TaskItem  { id, name, status, priority, fire_at?, notes?, queued_at,
 *                 completed_at?, created_by_user, created_at, updated_at })
 *   (:TaskItem)-[:ENQUEUED_IN]->(:TaskQueue)
 *
 * Design notes:
 *   - The OmniGraph client is a singleton. This module does not own it.
 *   - `isReady()` must be true before calls; this module throws a clear error
 *     when it isn't, so callers can surface a user-friendly message.
 *   - All IDs and user-provided strings are passed through `escapeCypher` to
 *     avoid injection via Cypher literals. Numeric values (priority, fire_at)
 *     are coerced to Number before interpolation.
 *   - Provenance fields follow the Temporal Graph Honor System (see
 *     omnigraph-client.js: buildCreateProvenance / buildUpdateProvenance).
 */

'use strict';

const {
  getOmniGraphClient,
  escapeCypher,
  buildCreateProvenance,
  buildUpdateProvenance,
} = require('../omnigraph-client');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

const DEFAULT_QUEUE_ID = 'user-tasks';
const DEFAULT_QUEUE_NAME = 'User Tasks';

// Allow tests to inject a fake OmniGraph client without monkey-patching the
// singleton getter.
let _clientOverride = null;

function _setClientForTests(client) {
  _clientOverride = client;
}

function _client() {
  return _clientOverride || getOmniGraphClient();
}

function _requireReady() {
  const client = _client();
  if (!client.isReady || !client.isReady()) {
    throw new Error(
      'OmniGraph client is not ready. Set up your account in Settings so the graph can be reached.'
    );
  }
  return client;
}

function _currentUser(client, override) {
  return override || client.currentUser || 'system';
}

function _intOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Ensure a TaskQueue node exists. Safe to call repeatedly.
 *
 * @param {Object} opts
 * @param {string} [opts.id]       Queue id (slug). Defaults to DEFAULT_QUEUE_ID.
 * @param {string} [opts.name]     Human-readable name. Only set on create.
 * @param {string} [opts.status]   active | paused | draining. Default: active.
 * @param {string} [opts.user]     User email for provenance. Default: client.currentUser.
 * @returns {Promise<{id:string,name:string,status:string}|null>}
 */
async function upsertQueue({
  id = DEFAULT_QUEUE_ID,
  name = DEFAULT_QUEUE_NAME,
  status = 'active',
  user,
} = {}) {
  const client = _requireReady();
  const prov = buildCreateProvenance(_currentUser(client, user));
  const updProv = buildUpdateProvenance(_currentUser(client, user));
  const cypher = `
    MERGE (q:TaskQueue {id: '${escapeCypher(id)}'})
    ON CREATE SET q.name = '${escapeCypher(name)}',
                  q.status = '${escapeCypher(status)}',
                  q.created_by_user = '${escapeCypher(prov.created_by_user)}',
                  q.created_by_app_name = '${escapeCypher(prov.created_by_app_name)}',
                  q.created_at = ${prov.created_at},
                  q.updated_at = ${prov.updated_at}
    ON MATCH SET  q.updated_by_user = '${escapeCypher(updProv.updated_by_user)}',
                  q.updated_at = ${updProv.updated_at}
    RETURN q.id AS id, q.name AS name, q.status AS status
  `;
  const result = await client.executeQuery(cypher);
  return Array.isArray(result) && result.length ? result[0] : null;
}

/**
 * Add a new TaskItem to a queue. Creates the queue if missing.
 *
 * @param {Object} opts
 * @param {string} [opts.queueId]  Queue id. Defaults to DEFAULT_QUEUE_ID.
 * @param {string}  opts.name      Task title (required).
 * @param {number} [opts.priority] Higher = more urgent. Default: 5.
 * @param {number} [opts.fireAtMs] Epoch ms. Present when this is an alarm.
 * @param {string} [opts.notes]    Free-form notes.
 * @param {string} [opts.status]   Default: 'queued'.
 * @param {string} [opts.user]     User email for provenance.
 * @returns {Promise<Object|null>}
 */
async function addTaskItem({
  queueId = DEFAULT_QUEUE_ID,
  name,
  priority = 5,
  fireAtMs,
  notes,
  status = 'queued',
  user,
} = {}) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('Task name is required');
  }

  const client = _requireReady();

  // Ensure the queue exists. `upsertQueue` is idempotent and cheap.
  await upsertQueue({ id: queueId, user });

  const now = Date.now();
  const taskId = `task-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const prov = buildCreateProvenance(_currentUser(client, user));

  const fireAt = _intOrNull(fireAtMs);
  const prio = _intOrNull(priority) ?? 5;

  // Build SET clauses piecewise so null/undefined fields are simply omitted
  // rather than stored as "null" strings.
  const setClauses = [
    `t.id = '${escapeCypher(taskId)}'`,
    `t.name = '${escapeCypher(name.trim())}'`,
    `t.status = '${escapeCypher(status)}'`,
    `t.priority = ${prio}`,
    `t.queued_at = ${now}`,
    `t.created_by_user = '${escapeCypher(prov.created_by_user)}'`,
    `t.created_by_app_name = '${escapeCypher(prov.created_by_app_name)}'`,
    `t.created_at = ${prov.created_at}`,
    `t.updated_at = ${prov.updated_at}`,
  ];
  if (fireAt !== null) setClauses.push(`t.fire_at = ${fireAt}`);
  if (notes && typeof notes === 'string' && notes.trim()) {
    setClauses.push(`t.notes = '${escapeCypher(notes.trim())}'`);
  }

  const cypher = `
    MATCH (q:TaskQueue {id: '${escapeCypher(queueId)}'})
    CREATE (t:TaskItem)
    SET ${setClauses.join(',\n        ')}
    MERGE (t)-[:ENQUEUED_IN]->(q)
    RETURN t.id AS id, t.name AS name, t.status AS status, t.priority AS priority,
           t.fire_at AS fire_at, t.notes AS notes, t.queued_at AS queued_at,
           q.id AS queue
  `;
  const result = await client.executeQuery(cypher);
  const row = Array.isArray(result) && result.length ? result[0] : null;
  log.info('task-graph-store', 'Task added', {
    id: row?.id,
    name: row?.name,
    priority: row?.priority,
    fireAt: row?.fire_at,
    queue: row?.queue,
  });
  return row;
}

/**
 * List queued tasks, optionally constrained by a time horizon on fire_at.
 *
 * @param {Object} opts
 * @param {string} [opts.queueId]   Default: DEFAULT_QUEUE_ID.
 * @param {number} [opts.horizonMs] If set, only returns items whose fire_at is
 *                                  null or <= now + horizonMs.
 * @param {number} [opts.limit]     Default 50.
 * @returns {Promise<Array>}
 */
async function listPendingTasks({
  queueId = DEFAULT_QUEUE_ID,
  horizonMs,
  limit = 50,
} = {}) {
  const client = _client();
  if (!client.isReady || !client.isReady()) return [];
  const now = Date.now();
  const upper = _intOrNull(horizonMs);
  const fireClause = upper !== null ? `AND (t.fire_at IS NULL OR t.fire_at <= ${now + upper})` : '';
  const safeLimit = Math.max(1, Math.min(500, _intOrNull(limit) ?? 50));
  const cypher = `
    MATCH (t:TaskItem {status: 'queued'})-[:ENQUEUED_IN]->(q:TaskQueue {id: '${escapeCypher(queueId)}'})
    WHERE 1=1 ${fireClause}
    RETURN t.id AS id, t.name AS name, t.priority AS priority, t.fire_at AS fire_at,
           t.notes AS notes, t.queued_at AS queued_at
    ORDER BY coalesce(t.fire_at, 9999999999999), t.priority DESC, t.queued_at ASC
    LIMIT ${safeLimit}
  `;
  try {
    const rows = await client.executeQuery(cypher);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    log.warn('task-graph-store', 'listPendingTasks failed', { error: err.message });
    return [];
  }
}

/**
 * Mark a TaskItem as completed.
 */
async function completeTask(taskId, { user } = {}) {
  if (!taskId) throw new Error('taskId required');
  const client = _requireReady();
  const prov = buildUpdateProvenance(_currentUser(client, user));
  const cypher = `
    MATCH (t:TaskItem {id: '${escapeCypher(taskId)}'})
    SET t.status = 'completed',
        t.completed_at = ${Date.now()},
        t.updated_by_user = '${escapeCypher(prov.updated_by_user)}',
        t.updated_at = ${prov.updated_at}
    RETURN t.id AS id, t.status AS status, t.completed_at AS completed_at
  `;
  const result = await client.executeQuery(cypher);
  return Array.isArray(result) && result.length ? result[0] : null;
}

/**
 * Delete a TaskItem entirely.
 */
async function deleteTask(taskId) {
  if (!taskId) throw new Error('taskId required');
  const client = _requireReady();
  const cypher = `
    MATCH (t:TaskItem {id: '${escapeCypher(taskId)}'})
    DETACH DELETE t
    RETURN count(*) AS deleted
  `;
  const result = await client.executeQuery(cypher);
  return Array.isArray(result) && result.length ? result[0] : { deleted: 0 };
}

module.exports = {
  DEFAULT_QUEUE_ID,
  DEFAULT_QUEUE_NAME,
  upsertQueue,
  addTaskItem,
  listPendingTasks,
  completeTask,
  deleteTask,
  _setClientForTests,
};
