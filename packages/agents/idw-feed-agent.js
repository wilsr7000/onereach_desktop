/**
 * IDW Feed Agent -- what is new in the feeds the Flipboard IDW Feed reads
 * (UX Magazine + the OneReach blog, see Flipboard-IDW-Feed/uxmag-script.js),
 * compressed to one { line, spoken } item per article for the daily brief
 * and for "what's new in my feed" questions.
 *
 * Sources are RSS; override with settings `idwFeed.urls`
 * ([{ url, source }]). Read-only, no key required.
 */

'use strict';

const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

const DEFAULT_FEEDS = [
  { url: 'https://uxmag.com/feed', source: 'UX Magazine' },
  { url: 'https://onereach.ai/feed/', source: 'OneReach' },
];
const FRESH_HOURS = 48;
const MAX_ITEMS = 5;
const FETCH_TIMEOUT_MS = 6000;

function settingsGet(key) {
  try {
    const sm = global.settingsManager;
    return sm && typeof sm.get === 'function' ? sm.get(key) : undefined;
  } catch (_) {
    return undefined;
  }
}

function resolveFeeds(deps) {
  if (deps && Array.isArray(deps.feeds)) return deps.feeds;
  const custom = settingsGet('idwFeed.urls');
  if (Array.isArray(custom) && custom.length) {
    return custom.filter((f) => f && typeof f.url === 'string').map((f) => ({ url: f.url, source: f.source || f.url }));
  }
  return DEFAULT_FEEDS;
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&rsquo;/g, '’')
    .replace(/&#8220;|&ldquo;/g, '“')
    .replace(/&#8221;|&rdquo;/g, '”')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse RSS 2.0 / Atom into [{ title, link, publishedMs, summary }].
 * fast-xml-parser is a declared dependency (package.json).
 */
function parseFeed(xml) {
  const { XMLParser } = require('fast-xml-parser');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', cdataPropName: '__cdata' });
  const doc = parser.parse(String(xml || ''));
  const text = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string' || typeof v === 'number') return String(v);
    if (typeof v === 'object') return text(v.__cdata !== undefined ? v.__cdata : v['#text']);
    return '';
  };
  const out = [];
  const rssItems = doc?.rss?.channel?.item;
  const atomEntries = doc?.feed?.entry;
  const list = Array.isArray(rssItems) ? rssItems : rssItems ? [rssItems] : Array.isArray(atomEntries) ? atomEntries : atomEntries ? [atomEntries] : [];
  for (const it of list) {
    const title = stripHtml(text(it.title));
    if (!title) continue;
    let link = text(it.link);
    if (!link && it.link && typeof it.link === 'object') link = it.link['@_href'] || '';
    const dateRaw = text(it.pubDate) || text(it.published) || text(it.updated) || text(it['dc:date']);
    const publishedMs = dateRaw ? new Date(dateRaw).getTime() : NaN;
    const summary = stripHtml(text(it.description) || text(it.summary) || text(it['content:encoded']) || text(it.content));
    out.push({ title, link, publishedMs: Number.isFinite(publishedMs) ? publishedMs : null, summary });
  }
  return out;
}

async function fetchText(url, { fetchImpl } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const res = await (fetchImpl || globalThis.fetch)(url, {
      headers: { 'User-Agent': 'Onereach-Desktop-IDW-Feed/1.0', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function ago(ms, now) {
  if (!ms) return '';
  const h = Math.round((now - ms) / 3600000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h} hr${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/**
 * Compress feed articles into { line, spoken } items: fresh ones first
 * (last FRESH_HOURS), else the newest few so the section is never empty
 * when the feeds are alive. Pure; exported for tests.
 */
function compressFeed(articlesBySource, { now = Date.now() } = {}) {
  const all = [];
  for (const { source, articles } of articlesBySource) {
    for (const a of articles || []) all.push({ ...a, source });
  }
  all.sort((a, b) => (b.publishedMs || 0) - (a.publishedMs || 0));
  const fresh = all.filter((a) => a.publishedMs && now - a.publishedMs <= FRESH_HOURS * 3600000);
  const chosen = (fresh.length ? fresh : all).slice(0, MAX_ITEMS);
  const items = chosen.map((a) => ({
    kind: 'article',
    line: `${a.source} · ${a.title}${a.publishedMs ? ` · ${ago(a.publishedMs, now)}` : ''}`,
    spoken: `From ${a.source}: ${a.title}.`,
    link: a.link || null,
  }));
  const sources = articlesBySource.map((s) => s.source).join(' and ');
  const headline = all.length === 0
    ? `Nothing new in the feed${sources ? ` (${sources})` : ''}`
    : fresh.length
      ? `${fresh.length} new article${fresh.length !== 1 ? 's' : ''} in the last ${FRESH_HOURS / 24} days`
      : `Nothing new in the last ${FRESH_HOURS / 24} days; latest from ${sources}`;
  const lines = [`${headline}.`];
  for (const it of items) lines.push(`- ${it.line}`);
  return { headline, content: lines.join('\n'), items };
}

async function readFeeds(deps) {
  const feeds = resolveFeeds(deps);
  const results = await Promise.all(
    feeds.map(async (f) => {
      try {
        const xml = await fetchText(f.url, { fetchImpl: deps && deps.fetchImpl });
        return { source: f.source, articles: parseFeed(xml) };
      } catch (err) {
        log.info('agent', '[idw-feed-agent] feed unavailable', { source: f.source, error: err.message });
        return { source: f.source, articles: [], error: err.message };
      }
    })
  );
  return results;
}

let _deps = null;
function _setDepsForTests(deps) {
  _deps = deps || null;
}

const idwFeedAgent = {
  id: 'idw-feed-agent',
  name: 'IDW Feed',
  description:
    'Reads the IDW feed (UX Magazine and the OneReach blog, the same sources as the Flipboard IDW Feed) and reports what is new, one line per article. Contributes a Feed section to the daily brief.',
  voice: 'echo',
  acks: ['Checking the feed.', 'Let me see what is new.'],
  categories: ['information', 'news', 'feed'],
  keywords: ['feed', 'idw feed', 'news feed', 'what is new', 'articles', 'ux magazine', 'onereach blog', 'flipboard'],
  executionType: 'action',
  estimatedExecutionMs: 4000,
  dataSources: ['rss'],

  prompt: `IDW Feed Agent reads the RSS feeds behind the Flipboard IDW Feed (UX Magazine, the OneReach blog) and lists the newest articles.

HIGH confidence: "what's new in my feed", "any new articles", "what did UX Magazine post", "latest from the OneReach blog".
LOW confidence: general web search, news about a specific topic not in these feeds, anything not about the feed.`,

  capabilities: ['List new articles from the IDW feed sources', 'Contribute a Feed section to the daily brief'],

  /** Daily-brief contribution. */
  async getBriefing() {
    const section = 'Feed';
    try {
      const results = await readFeeds(_deps);
      if (results.every((r) => r.error)) return { section, priority: 7, content: null };
      const { headline, content, items } = compressFeed(results, { now: (_deps && _deps.now) || Date.now() });
      return { section, priority: 7, content, headline, items };
    } catch (err) {
      log.warn('agent', '[idw-feed-agent] getBriefing failed', { error: err.message });
      return { section, priority: 7, content: null };
    }
  },

  async execute(task) {
    try {
      const query = ((task && (task.content || task.text)) || '').trim();
      if (!query) return { success: true, message: 'Ask me what is new in your feed.' };
      const results = await readFeeds(_deps);
      const { headline, items } = compressFeed(results, { now: (_deps && _deps.now) || Date.now() });
      const spoken = items.length ? `${headline}. ${items.map((i) => i.spoken).join(' ')}` : `${headline}.`;
      return { success: true, message: spoken, spokenSummary: spoken, visualText: [headline, ...items.map((i) => i.line)].join('\n') };
    } catch (err) {
      log.warn('agent', '[idw-feed-agent] execute failed', { error: err.message });
      return { success: false, message: `I couldn't read the feed: ${err.message}` };
    }
  },

  _setDepsForTests,
  _compressFeed: compressFeed,
  _parseFeed: parseFeed,
  DEFAULT_FEEDS,
};

module.exports = idwFeedAgent;
