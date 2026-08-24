/**
 * lib/kv-client.js — the full app's single Edison KV chokepoint (the KV
 * half of ADR-070's NEON access standard).
 *
 * Every /keyvalue2 URL in this repo is built by one of the three helpers
 * below, and every KV request rides kvFetch(), which owns the transport
 * concerns (abort-timeout, one retry on transient failure). The KV wire
 * has no comment channel, so unlike Cypher there is no caller tag —
 * centralizing URL construction and transport is the observability story.
 *
 * Three URL shapes exist on purpose — do not collapse them:
 *   sharedKvUrl()           the shared dev-account store (presence logs,
 *                           GPS-for-Life calendars, Note bodies, meeting
 *                           room payloads on the shared account)
 *   kvUrlForAccount(id)     an explicit account's store (tickets)
 *   kvUrlFromRefreshUrl(u)  the signed-in session's own account, derived
 *                           from its GSX refresh_token URL (meeting guest
 *                           pages, recorder room payloads)
 *
 * Error contract for the value helpers (kvGet/kvPut/kvDelete/kvList):
 *   - missing data (404 / empty body / "No data found.") → null result
 *   - server or network failure (5xx after retry, abort) → THROW.
 * Callers that used to map any failure to null were silently overwriting
 * good data after a KV hiccup (read fails → "empty" → write clobbers);
 * throwing forces the caller to skip the write instead.
 */

const SHARED_ACCOUNT = '35254342-4a2e-475b-aec1-18547e517e29';
const DEFAULT_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 300;

function kvUrlForAccount(accountId) {
  return `https://em.edison.api.onereach.ai/http/${accountId}/keyvalue2`;
}

function sharedKvUrl() {
  return kvUrlForAccount(SHARED_ACCOUNT);
}

/** The session account's KV store, from its GSX refresh_token URL. */
function kvUrlFromRefreshUrl(refreshUrl) {
  // trim(): stored refresh URLs have carried leading whitespace, which then
  // leaks into every derived URL (it was baked into the published guest
  // page). Browsers tolerate it; nothing else should have to.
  return String(refreshUrl).trim().replace('/refresh_token', '/keyvalue2');
}

function itemUrl(baseUrl, collection, key) {
  return `${baseUrl}?id=${encodeURIComponent(collection)}&key=${encodeURIComponent(key)}`;
}

/**
 * Transport: fetch with an abort-timeout and one retry on network error
 * or 5xx. Returns the Response (ok or not) — callers interpret status.
 * opts: { timeoutMs, retries, fetchImpl }
 */
async function kvFetch(url, init = {}, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const retries = opts.retries === undefined ? 1 : opts.retries;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const res = await fetchImpl(url, { ...init, signal: controller.signal });
      if (res.status >= 500 && attempt < retries) {
        lastError = new Error(`KV HTTP ${res.status}`);
        continue;
      }
      return res;
    } catch (error) {
      lastError = error;
      if (attempt >= retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/**
 * GET one value with the standard unwrap ({value} → JSON.parse).
 * null when the key is missing; throws on server/network failure.
 */
async function kvGet(collection, key, opts = {}) {
  const url = itemUrl(opts.url || sharedKvUrl(), collection, key);
  const res = await kvFetch(url, { method: 'GET', headers: { Accept: 'application/json' } }, opts);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV GET ${res.status}`);
  const text = await res.text();
  if (!text || text.trim() === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed && typeof parsed === 'object' && parsed.Status === 'No data found.') return null;
  if (parsed && typeof parsed === 'object' && 'value' in parsed) {
    try {
      return JSON.parse(parsed.value);
    } catch {
      return parsed.value;
    }
  }
  return parsed;
}

/** PUT one value (standard {id, key, itemValue} wire). Throws on !ok. */
async function kvPut(collection, key, value, opts = {}) {
  const url = itemUrl(opts.url || sharedKvUrl(), collection, key);
  const res = await kvFetch(
    url,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: collection, key, itemValue: JSON.stringify(value) }),
    },
    opts
  );
  if (!res.ok) throw new Error(`KV PUT ${res.status}`);
  return true;
}

/** DELETE one key. Returns true when the server accepted it. */
async function kvDelete(collection, key, opts = {}) {
  // keyvalue2 contract: DELETE reads {id, key} from the JSON BODY. The old
  // query-param shape gets a 200 with an error STRING in the body and
  // deletes nothing (live-probed 2026-08-20) — so a "successful" status is
  // not enough; an error text in the response means the delete didn't run.
  const res = await kvFetch(
    opts.url || sharedKvUrl(),
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: collection, key }),
    },
    opts
  );
  if (res.status === 404) return true; // already gone — idempotent success
  if (!res.ok) throw new Error(`KV DELETE ${res.status}`);
  const text = await res.text().catch(() => '');
  if (/invalid|error|cannot/i.test(text)) {
    throw new Error(`KV DELETE rejected: ${text.slice(0, 120)}`);
  }
  return true;
}

/** List a collection's keys → array of { key } records. */
async function kvList(collection, opts = {}) {
  const res = await kvFetch(
    opts.url || sharedKvUrl(),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: collection }),
    },
    opts
  );
  if (!res.ok) throw new Error(`KV LIST ${res.status}`);
  const data = await res.json().catch(() => null);
  const records = data?.getStorageData?.records || data?.records || data?.data?.records || data;
  return Array.isArray(records) ? records : [];
}

module.exports = {
  SHARED_ACCOUNT,
  DEFAULT_TIMEOUT_MS,
  sharedKvUrl,
  kvUrlForAccount,
  kvUrlFromRefreshUrl,
  kvFetch,
  kvGet,
  kvPut,
  kvDelete,
  kvList,
};
