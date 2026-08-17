/**
 * Presence beacon — "who is doing what, right now" in the shared graph.
 *
 * ADR-064. Every OneReach app (the full desktop app, Lite, and — via
 * the same proxy — WISER Playbooks or any agent) can announce a
 * per-user, per-app `(:Presence)` node carrying live FACETS: which
 * tool is focused, which Space / playbook / IDW is open, whether a
 * meeting is active, and the last meaningful action ("edited
 * “Roadmap”"). A Live Activity page reads them for the account.
 *
 * Design rules (the MeetingLive doctrine generalized):
 *   - EPHEMERAL SIGNAL, NOT AN ARTIFACT: no `:Asset` label, no Space
 *     membership — nothing else ever renders it. History is NOT this
 *     node's job: the durable "what they did" log is the existing
 *     `:Commit` stream, which the activity page merges in.
 *   - TTL ON THE READ SIDE: a beacon is 'active' within 3 minutes of
 *     its last heartbeat, 'idle' within 30, invisible after — a stuck
 *     client can never show as present forever.
 *   - SWEEP ON THE WRITE SIDE: every beat deletes beacons silent for
 *     >24h, so the graph self-cleans without a janitor.
 *   - IDENTITY IS NEVER MANUFACTURED: beats require a real person id
 *     (the account email convention). No id -> no beacon, silently.
 *   - HEARTBEATS MUST NOT PONG RECENCY: presence writes touch ONLY the
 *     `:Presence` node. The `PRESENCE_OF` edge MERGE never SETs
 *     anything on `:Person`, so ADR-060's cross-writer recency never
 *     sees a heartbeat.
 *   - NEVER THROWS: presence is garnish. An unreachable graph must
 *     never break the app doing the announcing.
 *
 * Facet semantics: `beat({facets})` merges the given keys onto the
 * node via Cypher `+=`; a facet explicitly set to null is REMOVED
 * (that's `+=`'s contract) — so "left the meeting" is
 * `beat({facets: {meetingRoom: null}})`. A bare `beat()` is a pure
 * heartbeat. When `facets.lastAction` is present the writer stamps
 * `lastActionAt` alongside it.
 */

'use strict';

const { runCypher } = require('./meeting/meeting-graph-bridge');

/**
 * Temporal trail storage — the user's design call: presence is
 * TEMPORAL, so the graph holds only the now-snapshot and a POINTER;
 * the timeline itself lives in the shared Edison KV store (the same
 * store that holds Note bodies and meeting sheets). Each meaningful
 * beat (facet change / action — never bare heartbeats) appends
 * `{at, ...patch}` to a rolling per-user-per-app log, capped by count
 * and age so it self-prunes.
 */
const KV_ENDPOINT =
  'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/keyvalue2';
const PRESENCE_LOG_COLLECTION = 'presence:logs';
const PRESENCE_LOG_MAX_ENTRIES = 200;
const PRESENCE_LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function presenceLogRef(personId, appId) {
  return `log:${personId}_${appId}`;
}

async function kvRequest(method, key, value, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const url = `${KV_ENDPOINT}?id=${encodeURIComponent(PRESENCE_LOG_COLLECTION)}&key=${encodeURIComponent(key)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const init =
      method === 'PUT'
        ? {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: PRESENCE_LOG_COLLECTION,
              key,
              itemValue: JSON.stringify(value),
            }),
            signal: controller.signal,
          }
        : { method, headers: { Accept: 'application/json' }, signal: controller.signal };
    const res = await fetchImpl(url, init);
    if (!res.ok) throw new Error(`presence log HTTP ${res.status}`);
    if (method !== 'GET') return null;
    const text = await res.text();
    if (text.trim() === '') return null;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (parsed && typeof parsed === 'object' && 'value' in parsed) {
      try {
        return JSON.parse(parsed.value);
      } catch {
        return null;
      }
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

/** Append one temporal entry to the rolling KV log (read-prune-write). */
async function appendPresenceLog(personId, appId, entry, opts = {}) {
  const key = presenceLogRef(personId, appId);
  const existing = await kvRequest('GET', key, null, opts);
  const entries = Array.isArray(existing?.entries) ? existing.entries : [];
  entries.push(entry);
  const cutoff = entry.at - PRESENCE_LOG_MAX_AGE_MS;
  const pruned = entries
    .filter((e) => e && typeof e.at === 'number' && e.at >= cutoff)
    .slice(-PRESENCE_LOG_MAX_ENTRIES);
  await kvRequest('PUT', key, { personId, appId, entries: pruned }, opts);
}

/** Read a beacon's temporal trail, newest first. Never throws. */
async function readPresenceLog(personId, appId, opts = {}) {
  try {
    const blob = await kvRequest('GET', presenceLogRef(personId, appId), null, opts);
    const entries = Array.isArray(blob?.entries) ? blob.entries : [];
    return entries.slice().reverse();
  } catch {
    return [];
  }
}

/** Read-side TTLs. */
const PRESENCE_ACTIVE_MS = 3 * 60 * 1000;
const PRESENCE_IDLE_MS = 30 * 60 * 1000;
/** Write-side sweep: beacons silent longer than this are deleted. */
const PRESENCE_SWEEP_MS = 24 * 60 * 60 * 1000;
/** Default heartbeat cadence for `startHeartbeat`. */
const HEARTBEAT_MS = 60 * 1000;

/** Facet keys a beat may set (allow-list — everything else is dropped). */
const FACET_KEYS = Object.freeze([
  'tool',
  'spaceId',
  'spaceName',
  'playbookId',
  'playbookTitle',
  'meetingRoom',
  'idwName',
  'lastAction',
]);

function presenceId(personId, appId) {
  return `presence_${personId}_${appId}`;
}

/** 'active' | 'idle' | 'gone' from a beacon's last heartbeat. */
function presenceStatus(lastSeenAtMs, nowMs) {
  const at = typeof lastSeenAtMs === 'number' && Number.isFinite(lastSeenAtMs) ? lastSeenAtMs : 0;
  const age = nowMs - at;
  if (age <= PRESENCE_ACTIVE_MS) return 'active';
  if (age <= PRESENCE_IDLE_MS) return 'idle';
  return 'gone';
}

/**
 * Announce (or refresh) this user+app's presence. Never throws.
 *
 * @param {object} args
 * @param {string} args.personId  account email (the Person id convention)
 * @param {string} args.appId     stable app slug ('onereach-desktop', 'onereach-lite', …)
 * @param {string} args.appName   display name ('Onereach.ai', 'Onereach.ai Lite', …)
 * @param {object} [args.facets]  facet patch; null values clear facets
 * @param {object} [args.log]     logger with info/warn
 * @param {Function} [args.fetchImpl]  test seam
 * @param {number} [args.nowMs]        test seam
 */
async function beat(args) {
  const log = (args && args.log) || { info: () => {}, warn: () => {} };
  try {
    const personId = typeof args.personId === 'string' ? args.personId.trim() : '';
    const appId = typeof args.appId === 'string' ? args.appId.trim() : '';
    if (personId.length === 0 || appId.length === 0) {
      return { ok: false, error: 'no identity' };
    }
    const nowMs = typeof args.nowMs === 'number' ? args.nowMs : Date.now();
    const raw = args.facets && typeof args.facets === 'object' ? args.facets : {};
    const facets = {};
    for (const key of FACET_KEYS) {
      if (key in raw) {
        const value = raw[key];
        facets[key] =
          value === null ? null : typeof value === 'string' ? value.slice(0, 200) : String(value);
      }
    }
    if (typeof facets['lastAction'] === 'string') facets['lastActionAt'] = nowMs;
    const meaningful = Object.keys(facets).length > 0;
    await runCypher(
      `MERGE (pr:Presence {id: $id})
       ON CREATE SET pr.startedAt = $nowMs
       SET pr.personId = $personId,
           pr.appId = $appId,
           pr.appName = $appName,
           pr.kv_collection = $kvCollection,
           pr.kv_ref = $kvRef,
           pr.lastSeenAt = $nowMs
       SET pr += $facets
       WITH pr
       MERGE (p:Person {id: $personId})
       MERGE (pr)-[:PRESENCE_OF]->(p)
       WITH pr
       OPTIONAL MATCH (stale:Presence)
         WHERE stale.id <> pr.id
           AND coalesce(stale.lastSeenAt, 0) < $nowMs - $sweepMs
       DETACH DELETE stale
       RETURN pr.id AS id`,
      {
        id: presenceId(personId, appId),
        personId,
        appId,
        appName: typeof args.appName === 'string' ? args.appName : appId,
        kvCollection: PRESENCE_LOG_COLLECTION,
        kvRef: presenceLogRef(personId, appId),
        facets,
        nowMs,
        sweepMs: PRESENCE_SWEEP_MS,
      },
      { fetchImpl: args.fetchImpl, nowMs }
    );
    // Temporal trail: the graph points at it; only MEANINGFUL beats
    // (facet changes / actions) append — heartbeats stay graph-only.
    if (meaningful) {
      try {
        await appendPresenceLog(personId, appId, { at: nowMs, ...facets }, {
          fetchImpl: args.fetchImpl,
        });
      } catch (logError) {
        log.warn('presence', 'presence log append skipped', {
          error: logError && logError.message ? logError.message : String(logError),
        });
      }
    }
    return { ok: true };
  } catch (error) {
    log.warn('presence', 'presence beat skipped', {
      error: error && error.message ? error.message : String(error),
    });
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

/** Delete this user+app's beacon eagerly (app quit). Never throws. */
async function clear(args) {
  try {
    const personId = typeof args.personId === 'string' ? args.personId.trim() : '';
    const appId = typeof args.appId === 'string' ? args.appId.trim() : '';
    if (personId.length === 0 || appId.length === 0) return { ok: false };
    await runCypher(
      `MATCH (pr:Presence {id: $id}) DETACH DELETE pr`,
      { id: presenceId(personId, appId) },
      { fetchImpl: args.fetchImpl, nowMs: typeof args.nowMs === 'number' ? args.nowMs : Date.now() }
    );
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * The Live Activity read: every beacon inside the visibility window
 * (idle cutoff), newest first, with the person's display name resolved.
 */
async function listPresence(args = {}) {
  const nowMs = typeof args.nowMs === 'number' ? args.nowMs : Date.now();
  const rows = await runCypher(
    `MATCH (pr:Presence)
       WHERE coalesce(pr.lastSeenAt, 0) > $nowMs - $windowMs
     OPTIONAL MATCH (pr)-[:PRESENCE_OF]->(p:Person)
     RETURN pr.id AS id,
            pr.personId AS personId,
            coalesce(p.name, p.displayName, pr.personId) AS personName,
            pr.appId AS appId,
            pr.appName AS appName,
            pr.lastSeenAt AS lastSeenAt,
            pr.startedAt AS startedAt,
            pr.tool AS tool,
            pr.spaceId AS spaceId,
            pr.spaceName AS spaceName,
            pr.playbookId AS playbookId,
            pr.playbookTitle AS playbookTitle,
            pr.meetingRoom AS meetingRoom,
            pr.idwName AS idwName,
            pr.lastAction AS lastAction,
            pr.lastActionAt AS lastActionAt
     ORDER BY pr.lastSeenAt DESC
     LIMIT 100`,
    { nowMs, windowMs: PRESENCE_IDLE_MS },
    { fetchImpl: args.fetchImpl, nowMs }
  );
  return rows.map((row) => ({
    ...row,
    status: presenceStatus(Number(row.lastSeenAt), nowMs),
  }));
}

/**
 * The durable "what happened" rail: recent `:Commit`s with space names,
 * newest first. Presence says NOW; this says WHAT and WHEN.
 */
async function listRecentActivity(args = {}) {
  const nowMs = typeof args.nowMs === 'number' ? args.nowMs : Date.now();
  const windowMs =
    typeof args.windowMs === 'number' && args.windowMs > 0 ? args.windowMs : 24 * 60 * 60 * 1000;
  return runCypher(
    `MATCH (c:Commit)
       WHERE coalesce(c.timestamp, 0) > $nowMs - $windowMs
     OPTIONAL MATCH (c)-[:IN_SPACE]->(s:Space)
     OPTIONAL MATCH (c)-[:TOUCHED]->(a)
     RETURN c.author AS author,
            c.message AS message,
            c.timestamp AS timestamp,
            coalesce(s.name, c.spaceId) AS spaceName,
            coalesce(a.name, a.title) AS itemTitle
     ORDER BY c.timestamp DESC
     LIMIT 60`,
    { nowMs, windowMs },
    { fetchImpl: args.fetchImpl, nowMs }
  );
}

/**
 * Register the Presence entity in the graph's `(:Schema)` registry so
 * the standard is discoverable + governed (same pattern as Checklist /
 * AssetVersion). Idempotent, best-effort.
 */
async function ensurePresenceSchema(args = {}) {
  try {
    const nowMs = typeof args.nowMs === 'number' ? args.nowMs : Date.now();
    await runCypher(
      `MERGE (e:Schema {entity: 'Presence'})
       ON CREATE SET e.createdAt = $nowMs
       SET e.version = '1.0.0',
           e.description = 'Ephemeral per-user-per-app presence beacon: which tool/space/playbook/meeting is active right now. TTL-read (active<3m, idle<30m), sweep-on-write (>24h deleted). NOT an Asset; never a Space member; history lives in :Commit.',
           e.id_pattern = 'presence_<personId>_<appId>',
           e.storage_pattern = 'node (now-snapshot) + KV temporal log at kv_collection/kv_ref (presence:logs / log:<personId>_<appId>, {entries:[{at,...facets}]}, capped 200/24h)',
           e.instructions = 'MERGE on id. Heartbeat updates lastSeenAt only; facet patches merge via SET += (null clears a facet). PRESENCE_OF -> Person; NEVER set properties on the Person from a presence write. Readers must TTL-gate on lastSeenAt; writers sweep stale beacons. lastAction/lastActionAt describe the most recent meaningful act; the durable log is the Commit stream.',
           e.updated_at = $nowMs,
           e.updated_by_app_name = 'presence-beacon'
       RETURN e.entity AS entity`,
      { nowMs },
      { fetchImpl: args.fetchImpl, nowMs }
    );
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * Convenience for host apps: heartbeat on an unref'd interval. Facets
 * come from `getFacets()` each beat so the host reports live state
 * without extra bookkeeping. Returns a stop function.
 */
function startHeartbeat(options) {
  const { getIdentity, getFacets, log, intervalMs } = options;
  const tick = () => {
    try {
      const identity = getIdentity();
      if (identity === null || typeof identity !== 'object') return;
      void beat({
        ...identity,
        facets: typeof getFacets === 'function' ? getFacets() : {},
        log,
      });
    } catch {
      /* never throws */
    }
  };
  tick();
  const timer = setInterval(tick, typeof intervalMs === 'number' ? intervalMs : HEARTBEAT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  beat,
  clear,
  readPresenceLog,
  presenceLogRef,
  PRESENCE_LOG_COLLECTION,
  listPresence,
  listRecentActivity,
  ensurePresenceSchema,
  startHeartbeat,
  presenceStatus,
  presenceId,
  FACET_KEYS,
  PRESENCE_ACTIVE_MS,
  PRESENCE_IDLE_MS,
  PRESENCE_SWEEP_MS,
};
