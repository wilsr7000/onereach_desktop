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
 * Edison `/omnidata/neon` proxy Lite uses, shaped exactly the way
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
    'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/omnidata/neon',
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

module.exports = {
  pushMeetingToSharedGraph,
  buildMeetingContent,
  meetingTitle,
  ensureMeetingsSpace,
  runCypher,
  SHARED_GRAPH,
  MEETINGS_SPACE,
  MAX_TRANSCRIPT_CHARS,
  MIN_TRANSCRIPT_CHARS,
};
