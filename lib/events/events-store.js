/**
 * Events Store - :Event nodes in the OneReach graph.
 *
 * The manage-events feature (voice agent + modal app + eventually the watch)
 * shares ONE source of truth: :Event nodes in the Neo4j Aura graph, written
 * through the same OmniGraph client the rest of the desktop uses. The watch
 * side reads the same label (the graph already carries Event/WatchEvent
 * label tokens from earlier experiments).
 *
 * Event shape (node properties):
 *   id          evt_<random>            (stable)
 *   title       string
 *   startsAt    ISO datetime            (first / only occurrence)
 *   recurrence  none|daily|weekly|monthly
 *   byDay       CSV of weekday numbers  (weekly only, optional)
 *   notes       string (optional)
 *   active      boolean (soft delete)
 *   source      'or-desktop'
 *   createdAt / updatedAt ISO
 *
 * Deps seam: `_setTestDeps({ getClient, now })` -- vitest CJS mocks don't
 * reliably intercept requires here.
 */

'use strict';

const crypto = require('crypto');
const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();
const { RECURRENCES, upcoming, describeOccurrence } = require('./recurrence');

let _deps = null;

function _setTestDeps(deps) {
  _deps = deps || null;
}

function _client() {
  if (_deps && _deps.getClient) return _deps.getClient();
  const { getOmniGraphClient } = require('../../omnigraph-client');
  return getOmniGraphClient();
}

function _now() {
  return _deps && _deps.now ? _deps.now() : new Date();
}

function _normalizeRecurrence(recurrence) {
  const r = String(recurrence || 'none').toLowerCase();
  return RECURRENCES.includes(r) ? r : 'none';
}

/** Map a raw record (node properties or aliased map) to an event object. */
function _toEvent(props) {
  if (!props) return null;
  const byDay = typeof props.byDay === 'string' && props.byDay.length
    ? props.byDay.split(',').map((s) => parseInt(s, 10)).filter((n) => !isNaN(n))
    : [];
  return {
    id: props.id,
    title: props.title || '(untitled)',
    startsAt: props.startsAt,
    recurrence: _normalizeRecurrence(props.recurrence),
    byDay,
    notes: props.notes || '',
    active: props.active !== false,
  };
}

/**
 * Add an event. Validates title + startsAt; recurrence defaults to 'none'.
 * @returns {Promise<Object>} the stored event
 */
async function addEvent({ title, startsAt, recurrence, byDay, notes } = {}) {
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) throw new Error('Event needs a title');
  const start = new Date(startsAt);
  if (!startsAt || isNaN(start.getTime())) {
    throw new Error(`Event needs a valid start time (got "${startsAt}")`);
  }

  const nowIso = _now().toISOString();
  const event = {
    id: `evt_${crypto.randomBytes(6).toString('hex')}`,
    title: cleanTitle,
    startsAt: start.toISOString(),
    recurrence: _normalizeRecurrence(recurrence),
    byDay: Array.isArray(byDay) ? byDay.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).join(',') : '',
    notes: String(notes || ''),
    active: true,
    source: 'or-desktop',
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  await _client().executeQuery(
    `MERGE (e:Event {id: $id})
     SET e += $props
     RETURN e.id AS id`,
    { id: event.id, props: event }
  );

  log.info('events', 'Event added to graph', { id: event.id, title: event.title, recurrence: event.recurrence });
  return _toEvent(event);
}

/**
 * All active events (raw definitions, not expanded occurrences).
 * @returns {Promise<Object[]>}
 */
async function listEvents() {
  const records = await _client().executeQuery(
    `MATCH (e:Event)
     WHERE e.source = 'or-desktop' AND coalesce(e.active, true) = true
     RETURN e.id AS id, e.title AS title, e.startsAt AS startsAt,
            e.recurrence AS recurrence, e.byDay AS byDay, e.notes AS notes,
            coalesce(e.active, true) AS active
     ORDER BY e.startsAt`,
    {}
  );
  return (records || []).map(_toEvent).filter(Boolean);
}

/**
 * Soft-delete an event by id or exact-ish title.
 * @returns {Promise<{ deleted: number }>}
 */
async function deleteEvent({ id, title } = {}) {
  if (!id && !title) throw new Error('deleteEvent needs an id or title');
  const records = await _client().executeQuery(
    id
      ? `MATCH (e:Event {id: $id}) SET e.active = false, e.updatedAt = $now RETURN count(e) AS deleted`
      : `MATCH (e:Event) WHERE toLower(e.title) = toLower($title) AND coalesce(e.active, true) = true
         SET e.active = false, e.updatedAt = $now RETURN count(e) AS deleted`,
    { id: id || null, title: title || null, now: _now().toISOString() }
  );
  const deleted = (records && records[0] && Number(records[0].deleted)) || 0;
  log.info('events', 'Event soft-deleted', { id, title, deleted });
  return { deleted };
}

/**
 * Upcoming occurrences (recurrence-aware), soonest first.
 * @param {number} [limit=5]
 * @returns {Promise<Array<{ event, at: Date, when: string }>>}
 */
async function nextEvents(limit = 5) {
  const events = await listEvents();
  const from = _now();
  return upcoming(events, from, limit).map(({ event, at }) => ({
    event,
    at,
    when: describeOccurrence(at, from),
  }));
}

module.exports = {
  addEvent,
  listEvents,
  deleteEvent,
  nextEvents,
  _setTestDeps,
  _toEvent, // exported for tests
};
