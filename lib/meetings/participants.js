/**
 * Meeting participants - suggestion + normalization for the Meeting Starter.
 *
 * Suggestions come from :Person nodes in the OneReach graph (the same
 * instance Spaces/agents live in). The graph mixes real people with system
 * actors (pipeline identities, account ids, "Playbooks System"); the filter
 * here keeps humans only.
 *
 * Deps seam: `_setTestDeps({ getClient })` (same pattern as events-store).
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

let _deps = null;

function _setTestDeps(deps) {
  _deps = deps || null;
}

function _client() {
  if (_deps && _deps.getClient) return _deps.getClient();
  const { getOmniGraphClient } = require('../../omnigraph-client');
  return getOmniGraphClient();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pure filter: is this Person node a real human (vs a system actor)?
 * @param {Object} p - { name, email, role }
 */
function isHumanPerson(p = {}) {
  const name = String(p.name || '').trim();
  const email = String(p.email || '').trim();
  if (!name) return false;
  if (UUID_RE.test(name)) return false;
  // Bare hex blobs (dashless UUIDs, content hashes) are machine ids too.
  if (/^[0-9a-f]{24,}$/i.test(name)) return false;
  if (/\b(system|pipeline|playbooks system|bot|actor)\b/i.test(name)) return false;
  if (email.toLowerCase() === 'system') return false;
  // Multitenant service identities like robb+multitenant/edison/... are
  // machine roles, not invitees.
  if (/\+.*\//.test(email)) return false;
  return true;
}

/**
 * Suggest meeting participants from the graph, humans only, deduped by
 * email/name, alphabetical.
 *
 * @param {number} [limit=8]
 * @returns {Promise<Array<{ name: string, email: string|null }>>}
 */
async function suggestParticipants(limit = 8) {
  let records = [];
  try {
    records = await _client().executeQuery(
      `MATCH (p:Person)
       RETURN p.name AS name, p.email AS email, p.role AS role
       ORDER BY p.name`,
      {}
    );
  } catch (err) {
    log.warn('meetings', 'Participant suggestion query failed', { error: err.message });
    return [];
  }

  const seen = new Set();
  const humans = [];
  for (const rec of records || []) {
    if (!isHumanPerson(rec)) continue;
    const key = String(rec.email || rec.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    humans.push({ name: rec.name, email: rec.email || null });
  }
  return humans.slice(0, limit);
}

module.exports = { suggestParticipants, isHumanPerson, _setTestDeps };
