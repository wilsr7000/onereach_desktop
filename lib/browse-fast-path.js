'use strict';

const stealth = require('./browser-stealth');

const SEARCH_RESULT_LIMIT = 5;
const CONTENT_CACHE = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached(key) {
  const entry = CONTENT_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    CONTENT_CACHE.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  CONTENT_CACHE.set(key, { data, timestamp: Date.now() });
  if (CONTENT_CACHE.size > 200) {
    const oldest = CONTENT_CACHE.keys().next().value;
    CONTENT_CACHE.delete(oldest);
  }
}

async function searchDuckDuckGo(query, maxResults = SEARCH_RESULT_LIMIT) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;

  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': stealth.getUserAgent() },
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) return { results: [], error: `HTTP ${resp.status}` };

    const data = await resp.json();
    const results = [];

    if (data.AbstractText) {
      results.push({
        title: data.AbstractSource || 'Summary',
        snippet: data.AbstractText,
        url: data.AbstractURL || '',
      });
    }

    if (data.RelatedTopics) {
      for (const topic of data.RelatedTopics.slice(0, maxResults)) {
        if (topic.Text && topic.FirstURL) {
          results.push({ title: topic.Text.slice(0, 100), snippet: topic.Text, url: topic.FirstURL });
        }
      }
    }

    return { results: results.slice(0, maxResults), source: 'duckduckgo' };
  } catch (err) {
    return { results: [], error: err.message, source: 'duckduckgo' };
  }
}

async function fetchAndExtract(url, opts = {}) {
  const cached = getCached(url);
  if (cached) return { ...cached, fromCache: true };

  const timeout = opts.timeout || 10000;

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': stealth.getUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Ch-Ua': stealth.getSecChUa(),
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"macOS"',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    });

    if (!resp.ok) {
      return { text: '', error: `HTTP ${resp.status}`, status: resp.status, url, extractionMethod: 'http' };
    }

    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      const text = await resp.text();
      const result = { text: text.slice(0, 8000), metadata: { url, contentType }, extractionMethod: 'http' };
      setCache(url, result);
      return result;
    }

    const html = await resp.text();
    const extracted = extractFromHtml(html, url, opts.maxLength || 8000);

    if (extracted.text.length < 100 && !opts.noFallback) {
      return { ...extracted, needsBrowser: true, extractionMethod: 'http-insufficient' };
    }

    setCache(url, extracted);
    return { ...extracted, extractionMethod: 'http' };
  } catch (err) {
    return { text: '', error: err.message, url, needsBrowser: true, extractionMethod: 'http-failed' };
  }
}

function extractFromHtml(html, url, maxLength) {
  const metadata = {};
  metadata.url = url;

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  metadata.title = titleMatch ? decodeEntities(titleMatch[1].trim()) : '';

  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
  metadata.description = descMatch ? decodeEntities(descMatch[1]) : '';

  const ogTitle = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
  if (ogTitle) metadata.ogTitle = decodeEntities(ogTitle[1]);

  const ogImage = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  if (ogImage) metadata.ogImage = ogImage[1];

  // JSON-LD
  const ldMatches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  const structuredData = [];
  for (const m of ldMatches) {
    try { structuredData.push(JSON.parse(m[1])); } catch (_) {}
  }
  if (structuredData.length) metadata.structuredData = structuredData;

  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (text.length > maxLength) text = text.slice(0, maxLength) + '\n[...truncated]';

  return { text, metadata };
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

async function query(queryText, opts = {}) {
  const maxSources = opts.maxSources || SEARCH_RESULT_LIMIT;
  const startTime = Date.now();

  const searchResult = await searchDuckDuckGo(queryText, maxSources);

  if (searchResult.results.length === 0) {
    return {
      answer: null,
      sources: [],
      path: 'search-api',
      latencyMs: Date.now() - startTime,
      error: searchResult.error || 'No results found',
    };
  }

  if (!opts.deepExtract) {
    return {
      answer: null,
      sources: searchResult.results,
      path: 'search-api',
      latencyMs: Date.now() - startTime,
    };
  }

  const urls = searchResult.results
    .filter((r) => r.url)
    .slice(0, Math.min(maxSources, 3));

  const extractions = await Promise.allSettled(
    urls.map((r) => fetchAndExtract(r.url, { maxLength: opts.maxLength || 4000 }))
  );

  const sources = extractions.map((e, i) => {
    if (e.status === 'fulfilled') {
      return { ...urls[i], extractedText: e.value.text, metadata: e.value.metadata, needsBrowser: e.value.needsBrowser };
    }
    return { ...urls[i], error: e.reason?.message };
  });

  return {
    answer: null,
    sources,
    path: 'http-fetch',
    latencyMs: Date.now() - startTime,
    needsBrowser: sources.some((s) => s.needsBrowser),
  };
}

async function extractUrl(url, opts = {}) {
  const result = await fetchAndExtract(url, opts);

  if (result.needsBrowser && opts.fallbackToBrowser) {
    return { ...result, fallbackNeeded: true };
  }

  return result;
}

function clearCache() {
  CONTENT_CACHE.clear();
}

function getCacheStats() {
  return { size: CONTENT_CACHE.size, maxSize: 200, ttlMs: CACHE_TTL };
}

module.exports = { query, extractUrl, fetchAndExtract, searchDuckDuckGo, clearCache, getCacheStats };
