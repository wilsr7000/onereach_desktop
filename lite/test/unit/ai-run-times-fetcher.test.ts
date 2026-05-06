/**
 * AI Run Times fetcher tests -- pure RSS / HTML parsing.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  parseRssFeed,
  stableArticleId,
  countWords,
  fetchAndParseFeed,
  fetchArticleContent,
  _setFetchImplForTesting,
  _resetFetchImplForTesting,
} from '../../ai-run-times/fetcher.js';
import { AI_RUN_TIMES_ERROR_CODES } from '../../ai-run-times/errors.js';

const SAMPLE_RSS = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>UX Mag</title>
    <item>
      <title><![CDATA[Designing for AI in 2026]]></title>
      <link>https://uxmag.com/articles/designing-for-ai-2026</link>
      <description><![CDATA[<p>How thinking has shifted&hellip;</p><img src="https://uxmag.com/img/cover.jpg" />]]></description>
      <pubDate>Sun, 04 May 2025 18:00:00 +0000</pubDate>
      <dc:creator>Jane Doe</dc:creator>
      <category>Conversational Design</category>
      <category>AI Trends</category>
    </item>
    <item>
      <title>Workflow Composition Patterns</title>
      <link>https://uxmag.com/articles/workflow-composition</link>
      <description>Plain text description.</description>
      <pubDate>Sat, 03 May 2025 12:00:00 +0000</pubDate>
    </item>
  </channel>
</rss>`;

afterEach(() => {
  _resetFetchImplForTesting();
});

describe('parseRssFeed', () => {
  it('parses a basic RSS feed into articles', () => {
    const articles = parseRssFeed(SAMPLE_RSS, 'uxmag');
    expect(articles.length).toBe(2);
    const first = articles[0];
    expect(first?.title).toBe('Designing for AI in 2026');
    expect(first?.link).toBe('https://uxmag.com/articles/designing-for-ai-2026');
    expect(first?.author).toBe('Jane Doe');
    expect(first?.categories).toEqual(['Conversational Design', 'AI Trends']);
    expect(first?.thumbnailUrl).toBe('https://uxmag.com/img/cover.jpg');
    expect(first?.publishedAt).toMatch(/^2025-05-04T18:00:00/);
    expect(first?.feedId).toBe('uxmag');
  });

  it('decodes HTML entities and CDATA', () => {
    const articles = parseRssFeed(SAMPLE_RSS, 'uxmag');
    const first = articles[0];
    expect(first?.description).toContain('shifted\u2026'); // &hellip;
  });

  it('handles items without optional fields', () => {
    const articles = parseRssFeed(SAMPLE_RSS, 'uxmag');
    const second = articles[1];
    expect(second?.author).toBeNull();
    expect(second?.categories).toEqual([]);
    expect(second?.thumbnailUrl).toBeNull();
  });

  it('skips items missing title or link', () => {
    const noLink = `
      <rss>
        <channel>
          <item>
            <title>No link</title>
          </item>
          <item>
            <link>https://x</link>
          </item>
          <item>
            <title>OK</title>
            <link>https://x/2</link>
          </item>
        </channel>
      </rss>`;
    expect(parseRssFeed(noLink, 'f').length).toBe(1);
  });
});

describe('stableArticleId', () => {
  it('produces a 16-char hex id', () => {
    const id = stableArticleId('https://example.com/a');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable for the same input', () => {
    expect(stableArticleId('https://example.com/a')).toBe(
      stableArticleId('https://example.com/a')
    );
  });

  it('is different for different inputs', () => {
    expect(stableArticleId('https://example.com/a')).not.toBe(
      stableArticleId('https://example.com/b')
    );
  });
});

describe('countWords', () => {
  it('counts words after stripping HTML', () => {
    expect(countWords('<p>Hello world, how are you?</p>')).toBe(5);
  });

  it('returns 0 for empty / whitespace input', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   <p></p>   ')).toBe(0);
  });

  it('handles html entities', () => {
    expect(countWords('<p>It&rsquo;s a test</p>')).toBe(3);
  });
});

describe('fetchAndParseFeed (with stub fetch)', () => {
  it('returns parsed articles on 200', async () => {
    _setFetchImplForTesting(
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => SAMPLE_RSS,
        headers: new Headers(),
      } as unknown as Response) as unknown as typeof fetch
    );
    const articles = await fetchAndParseFeed({ url: 'https://example.com/feed', feedId: 'x' });
    expect(articles.length).toBe(2);
  });

  it('maps non-2xx to ART_FEED_FETCH_FAILED', async () => {
    _setFetchImplForTesting(
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'oops',
        headers: new Headers(),
      } as unknown as Response) as unknown as typeof fetch
    );
    await expect(
      fetchAndParseFeed({ url: 'https://example.com/feed', feedId: 'x' })
    ).rejects.toMatchObject({ code: AI_RUN_TIMES_ERROR_CODES.FEED_FETCH_FAILED });
  });

  it('maps fetch throw to ART_FEED_FETCH_FAILED', async () => {
    _setFetchImplForTesting(
      vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch
    );
    await expect(
      fetchAndParseFeed({ url: 'https://example.com/feed', feedId: 'x' })
    ).rejects.toMatchObject({ code: AI_RUN_TIMES_ERROR_CODES.FEED_FETCH_FAILED });
  });

  it('follows a single redirect', async () => {
    let calls = 0;
    _setFetchImplForTesting(
      vi.fn().mockImplementation(async () => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: false,
            status: 301,
            text: async () => '',
            headers: new Headers({ location: 'https://example.com/feed-final' }),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          text: async () => SAMPLE_RSS,
          headers: new Headers(),
        } as unknown as Response;
      }) as unknown as typeof fetch
    );
    const articles = await fetchAndParseFeed({ url: 'https://example.com/feed', feedId: 'x' });
    expect(articles.length).toBe(2);
    expect(calls).toBe(2);
  });
});

describe('fetchArticleContent (with stub fetch)', () => {
  it('returns the raw HTML verbatim plus word count + reading time', async () => {
    // Renderer-side extraction landed in `article-extractor.ts`. The
    // fetcher now ships untouched HTML and just produces a coarse
    // word-count for the "X min read" badge.
    const html = `<html><body><article>${'<p>Body content here. </p>'.repeat(30)}</article></body></html>`;
    _setFetchImplForTesting(
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => html,
        headers: new Headers(),
      } as unknown as Response) as unknown as typeof fetch
    );
    const result = await fetchArticleContent({ url: 'https://example.com/a' });
    // Raw HTML round-trips intact (no extraction applied here).
    expect(result.html).toBe(html);
    expect(result.html).toMatch(/<html><body><article>/);
    expect(result.html).toContain('Body content here');
    expect(result.wordCount).toBeGreaterThan(50);
    expect(result.readingTimeMinutes).toBeGreaterThanOrEqual(1);
  });
});
