/**
 * Meeting history — the data behind the "history of meetings on a timeline,
 * with a summary of each transcript" modal.
 *
 * Sources, merged into one recency-ordered list:
 *   1. MEETING OBJECTS — space items tagged `wiser-meeting` whose content is
 *      the meeting JSON (title, duration, participants, and — when the
 *      post-meeting analysis ran — `post.summary`, the transcript summary).
 *   2. TRANSCRIPT ITEMS — "# Meeting Transcript" items. A meeting that
 *      recorded its `post.transcriptItemId` CLAIMS its transcript (one row,
 *      not two); orphan transcripts (analysis never ran — a real failure
 *      mode we recovered from) become their own rows so no meeting is
 *      invisible just because its meeting object never completed.
 *
 * Summary fallback chain per row: analysis summary → first transcript lines
 * → none ("No transcript captured").
 *
 * Deps-injectable and pure (no singletons touched when deps are passed):
 * `buildMeetingHistory({ getEntries, loadContent })` — getEntries() returns
 * index rows ({id, spaceId, type, preview, timestamp, tags?}), loadContent(id)
 * returns the full content string for an item (called only for candidates).
 */

'use strict';

const TRANSCRIPT_HEADER = '# Meeting Transcript';

/** True when an index row looks like a meeting OBJECT (the JSON spec item). */
function isMeetingObjectRow(row) {
  if (!row) return false;
  const tags = Array.isArray(row.tags) ? row.tags : [];
  if (tags.some((t) => typeof t === 'string' && t.toLowerCase() === 'wiser-meeting')) return true;
  // Index rows don't always carry tags — the preview of a meeting object is
  // its JSON, which always opens with the meeting id field.
  const p = typeof row.preview === 'string' ? row.preview : '';
  return p.startsWith('{') && p.includes('"id"') && p.includes('meeting_');
}

/** True when an index row is a saved transcript item. */
function isTranscriptRow(row) {
  return !!row && typeof row.preview === 'string' && row.preview.startsWith(TRANSCRIPT_HEADER);
}

/**
 * Reduce a transcript's markdown to a short human summary: drop the header /
 * metadata block, take the first few dialogue lines.
 */
function transcriptPreviewSummary(text, maxChars = 240) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const lines = text.split('\n');
  const dialogue = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) continue; // headers
    if (t.startsWith('**Recorded:') || t.startsWith('**Duration:') || t.startsWith('**Lines:')) continue;
    if (t === '---') continue;
    dialogue.push(t.replace(/\*\*/g, ''));
    if (dialogue.join(' ').length > maxChars) break;
  }
  if (dialogue.length === 0) return null;
  const joined = dialogue.join(' ');
  return joined.length > maxChars ? joined.slice(0, maxChars - 1).trimEnd() + '…' : joined;
}

/** Parse a meeting object's content; null when it isn't valid meeting JSON. */
function parseMeeting(content) {
  try {
    const m = JSON.parse(content);
    return m && typeof m === 'object' && m.id ? m : null;
  } catch (_e) {
    return null;
  }
}

/**
 * Build the timeline rows.
 *
 * @param {Object} deps
 * @param {Function} deps.getEntries  - () => Array<indexRow>
 * @param {Function} deps.loadContent - (itemId) => string|null (sync or async)
 * @param {number}   [deps.limit=100] - max rows returned
 * @returns {Promise<Array<Object>>} rows sorted newest-first:
 *   { key, itemId, transcriptItemId, spaceId, title, startedAtMs,
 *     durationMin, participants, summary, summarySource, status }
 */
async function buildMeetingHistory(deps = {}) {
  const getEntries = deps.getEntries || (() => []);
  const loadContent = deps.loadContent || (() => null);
  const limit = typeof deps.limit === 'number' && deps.limit > 0 ? deps.limit : 100;

  const entries = (getEntries() || []).filter(Boolean);
  const meetingRows = entries.filter(isMeetingObjectRow);
  const transcriptRows = entries.filter(isTranscriptRow);
  const transcriptById = new Map(transcriptRows.map((r) => [r.id, r]));
  const claimedTranscripts = new Set();
  const rows = [];

  for (const row of meetingRows) {
    const content = await loadContent(row.id);
    const meeting = parseMeeting(content);
    if (!meeting) continue;

    const post = meeting.post || {};
    const transcriptItemId = post.transcriptItemId || null;
    if (transcriptItemId) claimedTranscripts.add(transcriptItemId);

    let summary = typeof post.summary === 'string' && post.summary.trim() ? post.summary.trim() : null;
    let summarySource = summary ? 'analysis' : 'none';
    if (!summary && transcriptItemId && transcriptById.has(transcriptItemId)) {
      summary = transcriptPreviewSummary(await loadContent(transcriptItemId));
      if (summary) summarySource = 'transcript';
    }

    rows.push({
      key: 'meeting:' + row.id,
      itemId: row.id,
      transcriptItemId,
      spaceId: row.spaceId || meeting.spaceId || null,
      spaceName: row.spaceName || null,
      title:
        (meeting.calendar && meeting.calendar.vevent && meeting.calendar.vevent.summary) ||
        'Meeting',
      startedAtMs: new Date(row.timestamp || meeting.createdAt || 0).getTime() || 0,
      durationMin:
        meeting.during && typeof meeting.during.actualDuration === 'number'
          ? meeting.during.actualDuration
          : null,
      participants: (meeting.contacts || [])
        .map((c) => c && (c.displayName || c.identity))
        .filter(Boolean),
      summary: summary || null,
      summarySource,
      status: meeting.status || null,
    });
  }

  // Orphan transcripts: meetings whose object never completed still show up.
  for (const row of transcriptRows) {
    if (claimedTranscripts.has(row.id)) continue;
    const content = await loadContent(row.id);
    const summary = transcriptPreviewSummary(content || row.preview);
    // Title from the transcript's own "Recorded:" stamp when present.
    const rec = /\*\*Recorded:\*\*\s*([^\n]+)/.exec(content || row.preview || '');
    rows.push({
      key: 'transcript:' + row.id,
      itemId: row.id,
      transcriptItemId: row.id,
      spaceId: row.spaceId || null,
      spaceName: row.spaceName || null,
      title: rec ? 'Meeting — ' + rec[1].trim() : 'Meeting transcript',
      startedAtMs: new Date(row.timestamp || 0).getTime() || 0,
      durationMin: null,
      participants: [],
      summary: summary || null,
      summarySource: summary ? 'transcript' : 'none',
      status: 'transcript-only',
    });
  }

  rows.sort((a, b) => b.startedAtMs - a.startedAtMs);
  return rows.slice(0, limit);
}

/**
 * Convenience adapter: build the history straight from a SpacesAPI instance
 * (sweeps every space's item index; loads content only for candidates).
 */
async function buildMeetingHistoryFromSpaces(api, { limit } = {}) {
  const spaces = (await api.list()) || [];
  const entries = [];
  for (const s of spaces) {
    try {
      const items = (await api.items.list(s.id, {})) || [];
      for (const it of items) entries.push({ ...it, spaceId: s.id, spaceName: s.name });
    } catch (_e) {
      /* unreadable space — skip, keep the rest of the timeline */
    }
  }
  const byId = new Map(entries.map((e) => [e.id, e]));
  const contentCache = new Map();
  return buildMeetingHistory({
    getEntries: () => entries,
    loadContent: async (id) => {
      if (contentCache.has(id)) return contentCache.get(id);
      let content = null;
      try {
        const row = byId.get(id);
        const full = row ? await api.items.get(row.spaceId, id) : null;
        content = full && typeof full.content === 'string' ? full.content : null;
      } catch (_e) {
        content = null;
      }
      contentCache.set(id, content);
      return content;
    },
    limit,
  });
}

module.exports = {
  buildMeetingHistory,
  buildMeetingHistoryFromSpaces,
  transcriptPreviewSummary,
  isMeetingObjectRow,
  isTranscriptRow,
};
