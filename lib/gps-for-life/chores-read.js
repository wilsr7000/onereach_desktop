/**
 * GPS for Life graph reads for the daily brief -- the user's Child node and
 * its open Chores, plus open TaskItems from the graph TaskQueue.
 *
 * Read-only, through lib/neon-read-client (no local graph credential
 * needed). The user's Child is resolved from, in order:
 *   1. settings `gpsForLife.childPhone` (explicit),
 *   2. env GPSFL_CHILD_PHONE,
 *   3. a Child whose name matches the user's profile first name.
 * Every query is parameterised -- no user text is interpolated into Cypher.
 */

'use strict';

const { neonRead } = require('../neon-read-client');

const CHILD_BY_PHONE = `MATCH (c:Child {phone: $phone})
RETURN c.phone AS phone, c.name AS name
LIMIT 1`;

// Name match is only trusted when it is UNIQUE in the graph (the queue is a
// shared org graph; another family's child with the same first name must
// never be read). The explicit `gpsForLife.childPhone` setting bypasses this.
const CHILD_BY_NAME = `MATCH (c:Child)
WHERE toLower(coalesce(c.name, '')) = toLower($name)
WITH collect({phone: c.phone, name: c.name}) AS matches
WHERE size(matches) = 1
UNWIND matches AS m
RETURN m.phone AS phone, m.name AS name`;

const CHORES_FOR_CHILD = `MATCH (c:Child {phone: $phone})-[:HAS_CHORE]->(ch:Chore)
RETURN ch.id AS id, ch.title AS title, ch.status AS status,
       ch.scheduled_at AS scheduled_at, ch.due_by AS due_by, ch.priority AS priority,
       ch.recurrence_rule AS recurrence_rule, ch.energy_level AS energy_level,
       ch.source AS source, ch.completed_at AS completed_at, ch.updated_at AS updated_at
ORDER BY ch.scheduled_at
LIMIT 200`;

// TaskItems are read ONLY for the signed-in user: without an email there is
// no way to tell whose items they are, and the graph is shared.
const OPEN_TASK_ITEMS = `MATCH (t:TaskItem)
WHERE toLower(coalesce(t.status, 'pending')) IN ['pending', 'queued', 'active', 'due']
  AND t.created_by_user = $user
RETURN t.id AS id, t.name AS name, t.status AS status, t.priority AS priority,
       t.fire_at AS fire_at, t.notes AS notes, t.created_by_user AS created_by_user
ORDER BY t.fire_at
LIMIT 50`;

function settingsGet(key) {
  try {
    const sm = global.settingsManager;
    return sm && typeof sm.get === 'function' ? sm.get(key) : undefined;
  } catch (_) {
    return undefined;
  }
}

/**
 * Resolve the user's Child node.
 * @param {Object} opts - { profileName?, read? } (read = neonRead test seam)
 * @returns {Promise<{ phone, name }|null>}
 */
async function resolveChild(opts = {}) {
  const read = opts.read || neonRead;
  const explicit = settingsGet('gpsForLife.childPhone') || process.env.GPSFL_CHILD_PHONE || null;
  if (explicit) {
    const rows = await read(CHILD_BY_PHONE, { phone: String(explicit) }, opts.readOpts);
    if (rows[0] && rows[0].phone) return { phone: String(rows[0].phone), name: rows[0].name || null };
  }
  // The name fallback needs a signed-in user (an anonymous session reads
  // nobody's chores) and a unique match (enforced in the query).
  const name = typeof opts.profileName === 'string' ? opts.profileName.trim().split(/\s+/)[0] : '';
  if (name && opts.userEmail) {
    const rows = await read(CHILD_BY_NAME, { name }, opts.readOpts);
    if (rows.length === 1 && rows[0] && rows[0].phone) return { phone: String(rows[0].phone), name: rows[0].name || null };
  }
  return null;
}

/**
 * Read everything the Tasks section needs.
 * @param {Object} opts - { profileName?, userEmail?, read? }
 * @returns {Promise<{ child, chores, taskItems }>}
 */
async function readTasksForBrief(opts = {}) {
  const read = opts.read || neonRead;
  const child = await resolveChild(opts);
  const chores = child ? await read(CHORES_FOR_CHILD, { phone: child.phone }, opts.readOpts) : [];
  let taskItems = [];
  if (opts.userEmail) {
    try {
      taskItems = await read(OPEN_TASK_ITEMS, { user: opts.userEmail }, opts.readOpts);
    } catch (_) {
      taskItems = []; // the queue is optional; chores still brief
    }
  }
  return { child, chores, taskItems };
}

module.exports = { resolveChild, readTasksForBrief, CHORES_FOR_CHILD, OPEN_TASK_ITEMS, CHILD_BY_NAME, CHILD_BY_PHONE };
