/**
 * Meeting-graph bridge — pushes completed WISER meetings into the SHARED
 * account graph (the same Neo4j Aura instance Lite Spaces, WISER
 * Playbooks, and agents read), so meetings and transcripts show up in
 * Lite automatically.
 *
 * Why this exists: the recorder saves meetings to the LOCAL OR-Spaces
 * store, and the OmniGraph sync path is off unless `neo4jPassword` is
 * configured — so as of 2026-08-10 the shared graph contained ZERO
 * meeting artifacts. This bridge writes them directly through the same
 * Edison `/omnidata/neon2` proxy Lite uses, shaped exactly the way
 * Lite's ADR-058/059/060 read paths expect:
 *
 *   (:Asset:Meeting {type:'text'})      content = summary/actions/decisions
 *   (:Asset:Transcript {type:'transcript'})  content = full transcript
 *   (:Asset:Recording {type:'other'})   metadata stub (file stays on host)
 *   all BELONGS_TO + CONTAINS a shared "WISER Meetings" Space
 *   (m)-[:HAS_TRANSCRIPT|:HAS_RECORDING]->(artifact)
 *   one idempotent `item:added` Commit per artifact worth announcing
 *
 * Contract: BEST-EFFORT AND NEVER THROWS. A meeting must complete and
 * save locally even when the shared graph is unreachable — callers
 * fire-and-forget and log the returned {ok:false} instead of failing
 * the meeting. Every write is an id-keyed MERGE, so re-pushing (the
 * complete handler AND the analyze handler both push) only enriches.
 *
 * Timestamps land in BOTH conventions (camelCase + snake_case, epoch
 * ms) so Lite's ADR-060 cross-writer recency ordering ranks a fresh
 * meeting at the top of Recent.
 */

'use strict';

/**
 * Shared account graph credentials — the SAME baked dev-account record
 * as `lite/neon/credentials.ts` (BAKED_IN_DEFAULT_GRAPH), duplicated
 * here because the full app cannot import lite/ modules. Punch-listed
 * tech debt: rotate together with the lite copy when the graph creds
 * rotation lands (user deferred rotation; see PUNCH-LIST.md).
 */
const SHARED_GRAPH = Object.freeze({
  endpoint:
    'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/omnidata/neon2',
  uri: 'neo4j+s://40c812ef.databases.neo4j.io',
  user: 'neo4j',
  password: 'oCLF5bxkj66qivVDh1biePK7Byo9U1NUvFLJrHnQjzo',
  database: 'neo4j',
});

/** Landing-zone Space, auto-ensured on first push. */
const MEETINGS_SPACE = Object.freeze({
  id: 'space-wiser-meetings',
  name: 'WISER Meetings',
});

/** Writer identity stamped on every node the bridge touches. */
const WRITER = Object.freeze({
  appName: 'WISER Meeting',
  source: 'meeting-graph-bridge',
});

const DEFAULT_TIMEOUT_MS = 20_000;
/** Defensive cap so a marathon transcript cannot blow a node property. */
const MAX_TRANSCRIPT_CHARS = 180_000;
/** Transcripts shorter than this are noise (mirrors the analyze gate). */
const MIN_TRANSCRIPT_CHARS = 50;

/**
 * POST one Cypher statement to the Edison neon proxy. Accepts the
 * proxy's several response shapes; throws on HTTP/network failure
 * (callers inside pushMeetingToSharedGraph catch).
 */
async function runCypher(cypher, parameters, opts = {}) {
  // NEON access standard (2026-08-17): every query wears its caller tag
  // (visible in SHOW TRANSACTIONS / Aura query log). Callers sharing
  // this transport can override via opts.caller.
  if (!String(cypher).startsWith('/* caller:')) {
    cypher = `/* caller:${opts.caller || 'wiser-meeting-bridge'} */\n${cypher}`;
  }
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const res = await fetchImpl(SHARED_GRAPH.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cypher,
        parameters: parameters || {},
        neonUri: SHARED_GRAPH.uri,
        neonUser: SHARED_GRAPH.user,
        neonPassword: SHARED_GRAPH.password,
        database: SHARED_GRAPH.database,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`neon proxy HTTP ${res.status}`);
    }
    const body = await res.json().catch(() => null);
    if (Array.isArray(body)) return body;
    if (body && Array.isArray(body.records)) return body.records;
    if (body && body.result && Array.isArray(body.result.records)) return body.result.records;
    if (body && Array.isArray(body.result)) return body.result;
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Markdown body for the meeting item Lite renders as a text tile. */
function buildMeetingContent(meeting, title) {
  const post = (meeting && meeting.post) || {};
  const during = (meeting && meeting.during) || {};
  const contacts = Array.isArray(meeting && meeting.contacts) ? meeting.contacts : [];
  const lines = [`# ${title}`, ''];
  const durationMin = during.actualDuration;
  if (Number.isFinite(durationMin) && durationMin > 0) {
    lines.push(`**Duration:** ${Math.round(durationMin)} min`);
  }
  const names = contacts
    .map((c) => c && c.displayName)
    .filter((n) => typeof n === 'string' && n.length > 0);
  if (names.length > 0) lines.push(`**Participants:** ${names.join(', ')}`);
  if (typeof post.summary === 'string' && post.summary.length > 0) {
    lines.push('', '## Summary', post.summary);
  }
  const decisions = Array.isArray(post.decisions) ? post.decisions.filter(Boolean) : [];
  if (decisions.length > 0) {
    lines.push('', '## Decisions', ...decisions.map((d) => `- ${d}`));
  }
  const actions = Array.isArray(post.actionItems) ? post.actionItems : [];
  if (actions.length > 0) {
    lines.push(
      '',
      '## Action items',
      ...actions
        .filter((a) => a && typeof a.text === 'string')
        .map((a) => `- [ ] ${a.text}${a.assignee ? ` — ${a.assignee}` : ''}`)
    );
  }
  if (lines.length <= 2) lines.push('_Meeting completed — no analysis available yet._');
  return lines.join('\n');
}

/** Display title for the meeting node. */
function meetingTitle(meeting, nowMs) {
  const fromCalendar =
    meeting &&
    meeting.calendar &&
    meeting.calendar.vevent &&
    typeof meeting.calendar.vevent.summary === 'string'
      ? meeting.calendar.vevent.summary.trim()
      : '';
  if (fromCalendar.length > 0) return fromCalendar.slice(0, 120);
  return `Meeting ${new Date(nowMs).toISOString().slice(0, 10)}`;
}

/**
 * Ensure the shared landing Space exists and return its id. Reuses any
 * live Space already named "WISER Meetings" (case-insensitive) so a
 * user-created space wins over our deterministic one.
 */
async function ensureMeetingsSpace(opts) {
  const found = await runCypher(
    `MATCH (s:Space)
       WHERE s.deletedAt IS NULL AND toLower(coalesce(s.name,'')) = toLower($name)
     RETURN s.id AS id LIMIT 1`,
    { name: MEETINGS_SPACE.name },
    opts
  );
  const existing = found && found[0] && (found[0].id || (found[0].get && found[0].get('id')));
  if (typeof existing === 'string' && existing.length > 0) return existing;
  await runCypher(
    `MERGE (s:Space {id: $id})
     ON CREATE SET s.name = $name,
                   s.kind = 'user',
                   s.visibility = 'open',
                   s.createdAt = $nowMs,
                   s.created_at = $nowMs
     SET s.updatedAt = $nowMs,
         s.updated_at = $nowMs
     RETURN s.id AS id`,
    { id: MEETINGS_SPACE.id, name: MEETINGS_SPACE.name, nowMs: opts.nowMs },
    opts
  );
  return MEETINGS_SPACE.id;
}

/**
 * MERGE one artifact node (+membership edges, +optional commit,
 * +optional edge from the meeting node). Extra labels are interpolated
 * from a fixed allow-list — never from input.
 */
const ARTIFACT_LABELS = Object.freeze({
  Meeting: 'Meeting',
  Transcript: 'Transcript',
  Recording: 'Recording',
});

async function upsertArtifact(input, opts) {
  const label = ARTIFACT_LABELS[input.label];
  if (label === undefined) throw new Error(`unknown artifact label ${String(input.label)}`);
  const withCommit = input.announce === true;
  const fromMeeting =
    typeof input.meetingNodeId === 'string' && input.meetingNodeId.length > 0
      ? input.meetingNodeId
      : null;
  const edge =
    label === 'Transcript' ? 'HAS_TRANSCRIPT' : label === 'Recording' ? 'HAS_RECORDING' : null;
  const cypher = `
    MATCH (s:Space {id: $spaceId})
    MERGE (a:Asset {id: $id})
    SET a:${label},
        a.name = $title,
        a.title = $title,
        a.type = $kind,
        a.content = $content,
        a.description = $description,
        a.tags = ['wiser-meeting'],
        a.updatedAt = $nowMs,
        a.updated_at = $nowMs,
        a.updated_by_app_name = '${WRITER.appName}',
        a.updated_by_source = '${WRITER.source}'
    FOREACH (_ IN CASE WHEN a.createdAt IS NULL THEN [1] ELSE [] END |
      SET a.createdAt = $nowMs,
          a.created_at = $nowMs,
          a.created_by_app_name = '${WRITER.appName}')
    MERGE (a)-[:BELONGS_TO]->(s)
    MERGE (s)-[:CONTAINS]->(a)
    ${
      fromMeeting !== null && edge !== null
        ? `WITH a, s
    MATCH (m:Asset {id: $meetingNodeId})
    MERGE (m)-[:${edge}]->(a)`
        : ''
    }
    ${
      withCommit
        ? `MERGE (c:Commit {hash: $commitHash})
    ON CREATE SET c.author = '${WRITER.appName}',
                  c.message = 'item:added',
                  c.timestamp = $nowMs,
                  c.assetId = $id,
                  c.spaceId = $spaceId
    MERGE (c)-[:IN_SPACE]->(s)
    MERGE (c)-[:TOUCHED]->(a)`
        : ''
    }
    RETURN a.id AS id`;
  const params = {
    spaceId: input.spaceId,
    id: input.id,
    title: input.title,
    kind: input.kind,
    content: input.content,
    description: input.description || null,
    nowMs: opts.nowMs,
  };
  if (fromMeeting !== null) params.meetingNodeId = fromMeeting;
  if (withCommit) params.commitHash = `meeting-add-${input.id}`;
  await runCypher(cypher, params, opts);
}

/**
 * Push a completed meeting (+transcript, +recording stubs) into the
 * shared graph. Never throws.
 *
 * @param {object} args
 * @param {object} args.meeting        meeting-schema object (post-complete)
 * @param {string} [args.transcriptText]  full transcript markdown/text
 * @param {string[]} [args.recordingItemIds]
 * @param {object} [args.log]          logger with info/warn
 * @param {Function} [args.fetchImpl]  test seam
 * @param {number} [args.nowMs]        test seam
 * @returns {Promise<{ok: boolean, pushed?: object, error?: string}>}
 */
async function pushMeetingToSharedGraph(args) {
  const log = args.log || { info: () => {}, warn: () => {} };
  try {
    const meeting = args.meeting;
    if (!meeting || typeof meeting.id !== 'string' || meeting.id.length === 0) {
      return { ok: false, error: 'no meeting id' };
    }
    const nowMs = typeof args.nowMs === 'number' ? args.nowMs : Date.now();
    const opts = { fetchImpl: args.fetchImpl, nowMs };
    const spaceId = await ensureMeetingsSpace(opts);
    const title = meetingTitle(meeting, nowMs);
    const meetingNodeId = `meeting_${meeting.id}`;

    await upsertArtifact(
      {
        spaceId,
        id: meetingNodeId,
        label: 'Meeting',
        title,
        kind: 'text',
        content: buildMeetingContent(meeting, title),
        description:
          typeof meeting.post === 'object' && meeting.post !== null && meeting.post.summary
            ? String(meeting.post.summary).slice(0, 500)
            : null,
        announce: true,
      },
      opts
    );

    const pushed = { meeting: meetingNodeId, transcript: null, recordings: [] };

    const transcriptText =
      typeof args.transcriptText === 'string' ? args.transcriptText.trim() : '';
    if (transcriptText.length >= MIN_TRANSCRIPT_CHARS) {
      const transcriptId = `transcript_${meeting.id}`;
      await upsertArtifact(
        {
          spaceId,
          id: transcriptId,
          label: 'Transcript',
          title: `${title} — transcript`,
          kind: 'transcript',
          content: transcriptText.slice(0, MAX_TRANSCRIPT_CHARS),
          description: null,
          announce: true,
          meetingNodeId,
        },
        opts
      );
      pushed.transcript = transcriptId;
    }

    const recordingIds = Array.isArray(args.recordingItemIds) ? args.recordingItemIds : [];
    for (const rid of recordingIds) {
      if (typeof rid !== 'string' || rid.length === 0) continue;
      const recordingNodeId = `recording_${rid}`;
      await upsertArtifact(
        {
          spaceId,
          id: recordingNodeId,
          label: 'Recording',
          title: `${title} — recording`,
          kind: 'other',
          content: '',
          description: 'Recording file stored on the host device (not uploaded).',
          announce: false,
          meetingNodeId,
        },
        opts
      );
      pushed.recordings.push(recordingNodeId);
    }

    log.info('recorder', 'Meeting pushed to shared graph', { meetingId: meeting.id, ...pushed });
    return { ok: true, pushed };
  } catch (error) {
    log.warn('recorder', 'Shared-graph meeting push skipped', {
      error: error && error.message ? error.message : String(error),
    });
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

// ─── ADR-062 — the meeting ring ──────────────────────────────────────────
//
// A live meeting announces itself as an EPHEMERAL `(:MeetingLive)`
// signal node — deliberately NOT an `:Asset` and with NO space
// membership, so it never renders as an item anywhere (ADR-058's
// member label set excludes it). Lite's ring check reads these on its
// existing heartbeat; the ring self-expires by TTL on the read side,
// and each announce sweeps nodes a crashed host left behind. Ending
// the session deletes the signal eagerly.

/** Read-side ring TTL (Lite ignores older signals). */
const LIVE_RING_TTL_MS = 30 * 60 * 1000;
/** Write-side sweep: announces delete stale signals beyond this. */
const LIVE_SWEEP_MS = 2 * 60 * 60 * 1000;

/** "weekly-sync-a1b2c3" -> "Weekly Sync" (drops the spaceId salt). */
function prettyRoomTitle(roomName) {
  if (typeof roomName !== 'string' || roomName.length === 0) return 'Meeting';
  const stripped = roomName.replace(/-[a-z0-9]{4,10}$/i, '');
  const words = stripped.split(/[-_]+/).filter((w) => w.length > 0);
  if (words.length === 0) return 'Meeting';
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Announce a live meeting (never throws). Idempotent per room —
 * re-announcing refreshes `lastSeenAt` without resetting `startedAt`.
 */
async function announceMeetingLive(args) {
  const log = (args && args.log) || { info: () => {}, warn: () => {} };
  try {
    const roomName = args.roomName;
    if (typeof roomName !== 'string' || roomName.length === 0) {
      return { ok: false, error: 'no room name' };
    }
    const nowMs = typeof args.nowMs === 'number' ? args.nowMs : Date.now();
    const opts = { fetchImpl: args.fetchImpl, nowMs };
    // Space context (2026-08-12): when the recorder was opened with a
    // target space, resolve its NAME so ring surfaces (the Lite tab
    // label) can lead with it. Best-effort — a miss stores null.
    let spaceName = null;
    if (typeof args.spaceId === 'string' && args.spaceId.length > 0) {
      try {
        const rows = await runCypher(
          `MATCH (s:Space {id: $spaceId}) WHERE s.deletedAt IS NULL
           RETURN coalesce(s.name, '') AS name`,
          { spaceId: args.spaceId },
          opts
        );
        const n = rows && rows[0] && typeof rows[0].name === 'string' ? rows[0].name : '';
        spaceName = n.length > 0 ? n.slice(0, 80) : null;
      } catch {
        spaceName = null;
      }
    }
    await runCypher(
      `MERGE (m:MeetingLive {id: $id})
       SET m.roomName = $roomName,
           m.title = $title,
           m.joinUrl = $joinUrl,
           m.host = $host,
           m.hostId = $hostId,
           m.invitees = $invitees,
           m.spaceName = $spaceName,
           m.startedAt = coalesce(m.startedAt, $nowMs),
           m.lastSeenAt = $nowMs
       WITH m
       OPTIONAL MATCH (old:MeetingLive)
         WHERE old.id <> m.id
           AND coalesce(old.lastSeenAt, old.startedAt, 0) < $nowMs - $sweepMs
       DETACH DELETE old
       RETURN m.id AS id`,
      {
        id: `live_${roomName}`,
        roomName,
        title:
          typeof args.title === 'string' && args.title.length > 0
            ? args.title.slice(0, 120)
            : prettyRoomTitle(roomName),
        joinUrl: typeof args.joinUrl === 'string' && args.joinUrl.length > 0 ? args.joinUrl : null,
        host: typeof args.host === 'string' && args.host.length > 0 ? args.host : null,
        // Ring identity: m.host is a DISPLAY name; the audience predicate
        // compares emails, so the host's account email goes on hostId.
        hostId:
          typeof args.hostId === 'string' && args.hostId.includes('@')
            ? args.hostId.trim().toLowerCase()
            : null,
        // Per-meeting ring audience. Lite rings host + these people ONLY —
        // never the whole (sticky) WISER Meetings membership. Empty means
        // nobody but the host gets rung (explicit invites or silence).
        invitees: [
          ...new Set(
            (Array.isArray(args.invitees) ? args.invitees : [])
              .map((e) => (typeof e === 'string' ? e.trim().toLowerCase() : ''))
              .filter((e) => e.includes('@') && e.length <= 200)
          ),
        ],
        spaceName,
        nowMs,
        sweepMs: LIVE_SWEEP_MS,
      },
      opts
    );
    log.info('recorder', 'Meeting ring announced', { roomName });
    return { ok: true };
  } catch (error) {
    log.warn('recorder', 'Meeting ring announce skipped', {
      error: error && error.message ? error.message : String(error),
    });
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

/** Tear the ring signal down when the host ends the session (never throws). */
async function endMeetingLive(roomName, args = {}) {
  const log = args.log || { info: () => {}, warn: () => {} };
  try {
    if (typeof roomName !== 'string' || roomName.length === 0) {
      return { ok: false, error: 'no room name' };
    }
    await runCypher(
      `MATCH (m:MeetingLive {id: $id}) DETACH DELETE m`,
      { id: `live_${roomName}` },
      { fetchImpl: args.fetchImpl, nowMs: typeof args.nowMs === 'number' ? args.nowMs : Date.now() }
    );
    return { ok: true };
  } catch (error) {
    log.warn('recorder', 'Meeting ring teardown skipped', {
      error: error && error.message ? error.message : String(error),
    });
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

/**
 * Grant the meeting ring to specific people. ADR-065 gates Lite's
 * live-meeting doorbell to MEMBERS of the shared "WISER Meetings" Space —
 * so "inviting" someone IS granting them [:HAS_ACCESS] on that Space.
 * Until this existed, organizing participants (Meeting Starter) changed
 * only the local draft: nobody was ever made a member, so the ring rang
 * nobody. Same contract as the rest of this file: id-keyed MERGEs,
 * best-effort, never throws. No expiry is set (GRANT_LIVE passes on
 * `expiresUnixMs IS NULL`) — membership persists so regulars stay rung.
 *
 * @param {Array<string>} emails - invitee emails (non-emails are skipped)
 * @param {Object} [args] - { log, fetchImpl, nowMs, grantedBy } test seams
 * @returns {Promise<{ok: boolean, granted?: number, error?: string}>}
 */
async function grantMeetingRingAccess(emails, args = {}) {
  const log = (args && args.log) || { info: () => {}, warn: () => {} };
  try {
    const list = [
      ...new Set(
        (Array.isArray(emails) ? emails : [])
          .map((e) => (typeof e === 'string' ? e.trim().toLowerCase() : ''))
          .filter((e) => e.includes('@') && e.length <= 200)
      ),
    ];
    if (list.length === 0) return { ok: true, granted: 0 };

    const nowMs = typeof args.nowMs === 'number' ? args.nowMs : Date.now();
    const opts = { fetchImpl: args.fetchImpl, nowMs };
    await ensureMeetingsSpace(opts);
    await runCypher(
      `MATCH (s:Space {id: $spaceId})
       UNWIND $emails AS email
       MERGE (p:Person {id: email})
         ON CREATE SET p.name = email, p.email = email, p.createdAt = $nowMs
       MERGE (p)-[r:HAS_ACCESS]->(s)
         ON CREATE SET r.grantedAt = $nowMs,
                       r.grantedBy = $grantedBy,
                       r.source = 'meeting-invite'`,
      {
        spaceId: MEETINGS_SPACE.id,
        emails: list,
        nowMs,
        grantedBy: typeof args.grantedBy === 'string' ? args.grantedBy : 'meeting-graph-bridge',
      },
      opts
    );
    log.info('meeting-graph-bridge', 'Meeting ring access granted', { count: list.length });
    return { ok: true, granted: list.length };
  } catch (err) {
    log.warn('meeting-graph-bridge', 'Ring access grant failed (non-fatal)', { error: err.message });
    return { ok: false, error: err.message };
  }
}

/**
 * Append invitees to an already-live meeting (the in-meeting Invite picker).
 * Dedupes against the existing audience in Cypher. Never throws.
 */
async function addLiveInvitees(roomName, emails, args = {}) {
  const log = (args && args.log) || { info: () => {}, warn: () => {} };
  try {
    if (typeof roomName !== 'string' || roomName.length === 0) {
      return { ok: false, error: 'no room name' };
    }
    const list = [
      ...new Set(
        (Array.isArray(emails) ? emails : [])
          .map((e) => (typeof e === 'string' ? e.trim().toLowerCase() : ''))
          .filter((e) => e.includes('@') && e.length <= 200)
      ),
    ];
    if (list.length === 0) return { ok: true, added: 0 };
    const nowMs = typeof args.nowMs === 'number' ? args.nowMs : Date.now();
    await runCypher(
      `MATCH (m:MeetingLive {id: $id})
       SET m.invitees = [x IN coalesce(m.invitees, []) WHERE NOT x IN $emails] + $emails,
           m.lastSeenAt = $nowMs
       RETURN m.id AS id`,
      { id: `live_${roomName}`, emails: list, nowMs },
      { fetchImpl: args.fetchImpl, nowMs }
    );
    log.info('meeting-graph-bridge', 'Live invitees added', { roomName, count: list.length });
    return { ok: true, added: list.length };
  } catch (err) {
    log.warn('meeting-graph-bridge', 'addLiveInvitees failed (non-fatal)', { error: err.message });
    return { ok: false, error: err.message };
  }
}

/**
 * People the host can invite, for the in-meeting picker. Space-scoped when a
 * spaceId is given (members of THAT space), otherwise all known humans.
 * Uses this bridge's baked shared-graph transport (the omnigraph client is
 * unconfigured on most installs), and the same humans-only filter Meeting
 * Starter uses. Never throws — a graph outage returns an empty list.
 */
async function listInvitablePeople(args = {}) {
  const log = (args && args.log) || { info: () => {}, warn: () => {} };
  try {
    const { isHumanPerson } = require('../meetings/participants');
    const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 100) : 50;
    const spaceId = typeof args.spaceId === 'string' && args.spaceId.length > 0 ? args.spaceId : null;
    const nowMs = typeof args.nowMs === 'number' ? args.nowMs : Date.now();
    const opts = { fetchImpl: args.fetchImpl, nowMs };
    const rows = await runCypher(
      spaceId
        ? `MATCH (p:Person)-[:HAS_ACCESS]->(s:Space {id: $spaceId})
           WHERE p.id CONTAINS '@'
           RETURN p.id AS email, coalesce(p.name, p.id) AS name
           ORDER BY name LIMIT ${limit}`
        : `MATCH (p:Person)
           WHERE p.id CONTAINS '@'
           RETURN p.id AS email, coalesce(p.name, p.id) AS name
           ORDER BY name LIMIT ${limit}`,
      spaceId ? { spaceId } : {},
      opts
    );
    const exclude = new Set(
      (Array.isArray(args.excludeEmails) ? args.excludeEmails : [])
        .map((e) => (typeof e === 'string' ? e.trim().toLowerCase() : ''))
        .filter(Boolean)
    );
    const people = (rows || [])
      .map((r) => ({ id: r.email, name: r.name, email: r.email }))
      .filter((p) => isHumanPerson(p))
      // Live-test findings: the host saw THEMSELF and an anonymous@ service
      // identity in their own invite list. Neither is invitable.
      .filter((p) => !exclude.has(String(p.email).toLowerCase()))
      .filter((p) => !String(p.email).toLowerCase().startsWith('anonymous@'));
    return { ok: true, people };
  } catch (err) {
    log.warn('meeting-graph-bridge', 'listInvitablePeople failed', { error: err.message });
    return { ok: false, people: [], error: err.message };
  }
}

module.exports = {
  pushMeetingToSharedGraph,
  buildMeetingContent,
  meetingTitle,
  ensureMeetingsSpace,
  runCypher,
  announceMeetingLive,
  endMeetingLive,
  grantMeetingRingAccess,
  addLiveInvitees,
  listInvitablePeople,
  prettyRoomTitle,
  SHARED_GRAPH,
  MEETINGS_SPACE,
  MAX_TRANSCRIPT_CHARS,
  MIN_TRANSCRIPT_CHARS,
  LIVE_RING_TTL_MS,
};
