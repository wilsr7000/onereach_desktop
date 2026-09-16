/**
 * Slack Agent -- what is waiting for you on Slack: mentions and direct
 * messages since your last morning, compressed into one item each for the
 * daily brief (screen + voice) and for "what's new on Slack" questions.
 *
 * Auth: a Slack USER token (xoxp-...) in settings `slackUserToken` (or env
 * SLACK_USER_TOKEN). Scopes: search:read, im:read, im:history, users:read.
 * Without a token the agent says so in one line and does nothing else --
 * it never asks the user to paste a token into chat.
 *
 * Plain fetch against the Slack Web API (no SDK: @slack/web-api is only a
 * transitive dependency here and would not survive packaging).
 */

'use strict';

const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

const SLACK_API = 'https://slack.com/api';
const LOOKBACK_HOURS = 16;
const MAX_DMS = 10;
const CALL_TIMEOUT_MS = 4000;
const TOTAL_BUDGET_MS = 7000;

function settingsGet(key) {
  try {
    const sm = global.settingsManager;
    return sm && typeof sm.get === 'function' ? sm.get(key) : undefined;
  } catch (_) {
    return undefined;
  }
}

function resolveToken(deps) {
  if (deps && deps.token !== undefined) return deps.token;
  const fromSettings = settingsGet('slackUserToken');
  if (typeof fromSettings === 'string' && fromSettings.trim()) return fromSettings.trim();
  const fromEnv = process.env.SLACK_USER_TOKEN;
  return typeof fromEnv === 'string' && fromEnv.trim() ? fromEnv.trim() : null;
}

/** One Slack Web API call (GET with query params). Throws on !ok. */
async function slackCall(method, params, { token, fetchImpl }) {
  const url = `${SLACK_API}/${method}?${new URLSearchParams(params || {}).toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const res = await (fetchImpl || globalThis.fetch)(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.ok !== true) {
      throw new Error(`slack ${method}: ${(body && body.error) || `HTTP ${res.status}`}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function snippet(text, max = 90) {
  const t = String(text || '')
    .replace(/<@[A-Z0-9]+>/g, '@someone')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:[^>]+)>/g, 'link')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1).trim()}…` : t;
}

function timeAgo(tsSeconds, now) {
  const ms = now - Number(tsSeconds) * 1000;
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min ago`;
  const hrs = Math.round(min / 60);
  return `${hrs} hr${hrs === 1 ? '' : 's'} ago`;
}

/**
 * Compress mentions + DMs into { line, spoken } items and a section text.
 * Pure; exported for tests.
 */
function compressSlack({ mentions = [], dms = [] }, { now = Date.now() } = {}) {
  const items = [];
  for (const m of mentions.slice(0, 5)) {
    const where = m.channel ? `#${m.channel}` : 'a channel';
    const who = m.user || 'someone';
    items.push({
      kind: 'mention',
      line: `${where} · ${who}: “${snippet(m.text)}”${m.ts ? ` · ${timeAgo(m.ts, now)}` : ''}`,
      spoken: `${who} mentioned you in ${where.replace('#', '')}: ${snippet(m.text, 70)}.`,
    });
  }
  for (const d of dms.slice(0, 5)) {
    const who = d.user || 'someone';
    items.push({
      kind: 'dm',
      line: `DM · ${who}: “${snippet(d.text)}”${d.count > 1 ? ` (+${d.count - 1} more)` : ''}${d.ts ? ` · ${timeAgo(d.ts, now)}` : ''}`,
      spoken: `A direct message from ${who}: ${snippet(d.text, 70)}.`,
    });
  }
  const headline =
    mentions.length === 0 && dms.length === 0
      ? 'Nothing new on Slack'
      : `${mentions.length} mention${mentions.length !== 1 ? 's' : ''}, ${dms.length} DM${dms.length !== 1 ? 's' : ''} waiting`;
  const lines = [`${headline}.`];
  for (const it of items) lines.push(`- ${it.line}`);
  return { headline, content: lines.join('\n'), items };
}

/**
 * Read mentions + DMs since the lookback window. Bounded: at most MAX_DMS
 * DM channels are opened, and the whole read stops at TOTAL_BUDGET_MS.
 */
async function readSlackDigest({ token, fetchImpl, now = Date.now() }) {
  const started = Date.now();
  const overBudget = () => Date.now() - started > TOTAL_BUDGET_MS;
  const call = (method, params) => slackCall(method, params, { token, fetchImpl });
  // The window is enforced on message timestamps below; a date modifier in
  // the search query would be a UTC day and drop yesterday-evening mentions.
  const sinceSec = Math.floor((now - LOOKBACK_HOURS * 3600000) / 1000);

  const me = await call('auth.test', {});
  const userId = me.user_id;
  const names = new Map();
  const nameOf = async (uid) => {
    if (!uid) return null;
    if (names.has(uid)) return names.get(uid);
    if (overBudget()) return null;
    try {
      const info = await call('users.info', { user: uid });
      const n = info.user?.profile?.display_name || info.user?.real_name || info.user?.name || uid;
      names.set(uid, n);
      return n;
    } catch (_) {
      names.set(uid, null);
      return null;
    }
  };

  const mentions = [];
  try {
    const search = await call('search.messages', {
      query: `<@${userId}>`,
      sort: 'timestamp',
      sort_dir: 'desc',
      count: 20,
    });
    for (const m of search.messages?.matches || []) {
      if (m.user === userId) continue;
      if (Number(m.ts) < sinceSec) continue;
      mentions.push({
        channel: m.channel?.name || null,
        user: m.username || (await nameOf(m.user)),
        text: m.text,
        ts: m.ts,
      });
    }
  } catch (err) {
    log.info('agent', '[slack-agent] search.messages unavailable', { error: err.message });
  }

  const dms = [];
  try {
    const list = await call('conversations.list', { types: 'im', limit: 100, exclude_archived: true });
    const ims = (list.channels || []).filter((c) => !c.is_user_deleted).slice(0, MAX_DMS);
    for (const im of ims) {
      if (overBudget()) break;
      let hist;
      try {
        hist = await call('conversations.history', { channel: im.id, oldest: String(sinceSec), limit: 10 });
      } catch (_) {
        continue;
      }
      const theirs = (hist.messages || []).filter((m) => m.user && m.user !== userId && !m.subtype);
      if (theirs.length === 0) continue;
      dms.push({ user: await nameOf(im.user), text: theirs[0].text, ts: theirs[0].ts, count: theirs.length });
    }
  } catch (err) {
    log.info('agent', '[slack-agent] conversations.list unavailable', { error: err.message });
  }

  return { mentions, dms };
}

const NOT_CONNECTED =
  'Slack isn\'t connected. Add a Slack user token as "slackUserToken" in Settings to get mentions and DMs here.';

let _deps = null;
function _setDepsForTests(deps) {
  _deps = deps || null;
}

const slackAgent = {
  id: 'slack-agent',
  name: 'Slack',
  description:
    'Reads what is waiting for you on Slack -- mentions and direct messages since your last morning -- and contributes them to the daily brief. Read-only; never posts.',
  voice: 'coral',
  acks: ['Checking Slack.', 'Let me look at your mentions.'],
  categories: ['productivity', 'communication', 'slack'],
  keywords: ['slack', 'mentions', 'mentioned me', 'direct messages', 'dms', 'slack messages', 'what is new on slack'],
  executionType: 'action',
  estimatedExecutionMs: 4000,
  dataSources: ['slack-web-api'],

  prompt: `Slack Agent reads the user's Slack mentions and direct messages (read-only) and reports what is waiting.

HIGH confidence: "what's new on Slack", "any Slack mentions?", "did anyone DM me", "Slack messages since yesterday".
LOW confidence: sending or replying to Slack messages (not supported), email, calendar, tickets, anything not about Slack.

Without a Slack user token configured it says so and does nothing else.`,

  capabilities: ['List recent Slack mentions', 'List direct messages waiting', 'Contribute a Slack section to the daily brief'],

  /** Daily-brief contribution. */
  async getBriefing() {
    const section = 'Slack';
    try {
      const token = resolveToken(_deps);
      if (!token) return { section, priority: 6, content: NOT_CONNECTED, notConnected: true, items: [] };
      const digest = await readSlackDigest({ token, fetchImpl: _deps && _deps.fetchImpl, now: (_deps && _deps.now) || Date.now() });
      const { headline, content, items } = compressSlack(digest, { now: (_deps && _deps.now) || Date.now() });
      return { section, priority: 6, content, headline, items };
    } catch (err) {
      log.warn('agent', '[slack-agent] getBriefing failed', { error: err.message });
      return { section, priority: 6, content: 'Slack is unavailable right now.', items: [] };
    }
  },

  async execute(task) {
    try {
      const token = resolveToken(_deps);
      if (!token) return { success: true, message: NOT_CONNECTED };
      const query = ((task && (task.content || task.text)) || '').trim();
      if (!query) return { success: true, message: 'Ask me for your Slack mentions or direct messages.' };
      const digest = await readSlackDigest({ token, fetchImpl: _deps && _deps.fetchImpl, now: (_deps && _deps.now) || Date.now() });
      const { headline, items } = compressSlack(digest, { now: (_deps && _deps.now) || Date.now() });
      const spoken = items.length ? `${headline}. ${items.map((i) => i.spoken).join(' ')}` : `${headline}.`;
      return { success: true, message: spoken, spokenSummary: spoken, visualText: [headline, ...items.map((i) => i.line)].join('\n') };
    } catch (err) {
      log.warn('agent', '[slack-agent] execute failed', { error: err.message });
      return { success: false, message: `I couldn't reach Slack: ${err.message}` };
    }
  },

  _setDepsForTests,
  _compressSlack: compressSlack,
  _readSlackDigest: readSlackDigest,
};

module.exports = slackAgent;
