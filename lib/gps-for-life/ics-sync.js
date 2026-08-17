// lib/gps-for-life/ics-sync.js — desktop-side external-calendar sync
// for GPS for Life (the ChoreQuest queue web app).
//
// Why the DESKTOP does this: Google Calendar "secret address" ICS
// endpoints send no CORS headers, so the web app cannot fetch them.
// This module reads the feed registry the web app manages, fetches +
// expands every enabled feed (lib/gps-for-life/ics.js), and publishes
// normalized occurrences back to the same Edison KV — after which every
// surface (web dashboard, phone Queue Companion) sees the merged
// calendars. Contract (shared with webapp src/utils/externalCal.js):
//
//   collection 'gpsfl:calendars'
//     key 'feeds'  — [{id, name, url, color, enabled, addedAt}]  (read)
//     key 'events' — {syncedAt, rangeStartMs, rangeEndMs,
//                     occurrences[], errors[]}                    (write)
//
// ⚠️ Privacy posture: feed URLs and event titles transit the same
// unauthenticated KV the rest of the stack uses (known debt; endpoint
// hardening scheduled). Best-effort throughout — calendar sync must
// never affect app startup.

'use strict';

const { expandIcsFeed } = require('./ics');

// KV rides the lib/kv-client chokepoint (ADR-070). A 5xx on the feeds
// read now THROWS instead of returning null — a KV hiccup must not
// publish an empty events blob over good data.
const kv = require('../kv-client');
const COLLECTION = 'gpsfl:calendars';

const RANGE_BACK_DAYS = 21;   // matches the dashboard's visible window
const RANGE_AHEAD_DAYS = 90;
const SYNC_INTERVAL_MS = 60 * 60 * 1000; // hourly
const FETCH_TIMEOUT_MS = 20000;

async function kvGet(key) {
  return kv.kvGet(COLLECTION, key, { timeoutMs: FETCH_TIMEOUT_MS });
}

async function kvPut(key, value) {
  await kv.kvPut(COLLECTION, key, value, { timeoutMs: FETCH_TIMEOUT_MS });
}

/**
 * One full sync pass: registry → fetch each enabled feed → expand →
 * publish. Per-feed failures land in `errors` rather than aborting the
 * pass (one dead feed must not blank the others). Returns a summary.
 */
async function syncOnce() {
  const feeds = await kvGet('feeds');
  const list = Array.isArray(feeds) ? feeds.filter((f) => f && f.enabled && f.url) : [];
  const now = Date.now();
  const rangeStartMs = now - RANGE_BACK_DAYS * 86400000;
  const rangeEndMs = now + RANGE_AHEAD_DAYS * 86400000;

  const occurrences = [];
  const errors = [];
  for (const feed of list) {
    try {
      const url = String(feed.url).replace(/^webcal:\/\//i, 'https://');
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': 'OneReach-GPSForLife/1.0' },
        redirect: 'follow',
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      const { occurrences: occs } = expandIcsFeed(text, rangeStartMs, rangeEndMs);
      for (const o of occs) {
        occurrences.push({ ...o, feedId: feed.id, feedName: feed.name, color: feed.color });
      }
    } catch (error) {
      errors.push({ feedId: feed.id, feedName: feed.name, message: error.message });
    }
  }
  occurrences.sort((a, b) => a.startMs - b.startMs);

  await kvPut('events', { syncedAt: now, rangeStartMs, rangeEndMs, occurrences, errors });
  return { feeds: list.length, occurrences: occurrences.length, errors };
}

let timer = null;

/** Start the hourly sync loop (immediate first pass). Idempotent. */
function start() {
  if (timer) return;
  const run = () =>
    syncOnce()
      .then((s) => {
        if (s.feeds > 0 || s.errors.length > 0) {
          console.log(
            `[gps-for-life] calendar sync: ${s.occurrences} occurrences from ${s.feeds} feed(s)` +
              (s.errors.length ? `, ${s.errors.length} error(s)` : '')
          );
        }
      })
      .catch((e) => console.warn('[gps-for-life] calendar sync failed:', e.message));
  run();
  timer = setInterval(run, SYNC_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, syncOnce, _internals: { kvGet, kvPut, COLLECTION } };
