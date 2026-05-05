/**
 * AI Run Times store tests -- KV-backed persistence + dedupe + pruning.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AiRunTimesStore } from '../../ai-run-times/store.js';
import { ARTICLE_CACHE_MAX } from '../../ai-run-times/types.js';
import { AI_RUN_TIMES_ERROR_CODES } from '../../ai-run-times/errors.js';
import { FakeKV } from '../harness/index.js';

function makeStore(): AiRunTimesStore {
  return new AiRunTimesStore({ kvApi: new FakeKV() });
}

function fakeArticle(id: string, publishedAt: string | null = null): {
  id: string;
  feedId: string;
  title: string;
  link: string;
  description: string;
  thumbnailUrl: string | null;
  author: string | null;
  publishedAt: string | null;
  categories: string[];
  contentHtml: string | null;
  contentFetchedAt: string | null;
  wordCount: number;
  readingTimeMinutes: number;
} {
  return {
    id,
    feedId: 'uxmag',
    title: `Article ${id}`,
    link: `https://example.com/${id}`,
    description: '',
    thumbnailUrl: null,
    author: null,
    publishedAt,
    categories: [],
    contentHtml: null,
    contentFetchedAt: null,
    wordCount: 0,
    readingTimeMinutes: 0,
  };
}

describe('AiRunTimesStore.upsertArticles', () => {
  let store: AiRunTimesStore;
  beforeEach(() => {
    store = makeStore();
  });

  it('inserts new articles and reports newCount', async () => {
    const result = await store.upsertArticles(
      [fakeArticle('a'), fakeArticle('b')],
      'uxmag'
    );
    expect(result.newCount).toBe(2);
    const all = await store.listArticles();
    expect(all.length).toBe(2);
  });

  it('dedupes by id and preserves cached body', async () => {
    await store.upsertArticles([fakeArticle('a')], 'uxmag');
    await store.setArticleContent('a', '<p>cached body</p>', 100, 1);
    // Re-upsert with no body
    await store.upsertArticles([fakeArticle('a')], 'uxmag');
    const got = await store.getArticle('a');
    expect(got?.contentHtml).toBe('<p>cached body</p>');
    expect(got?.wordCount).toBe(100);
  });

  it('caps article cache at ARTICLE_CACHE_MAX', async () => {
    const many = Array.from({ length: ARTICLE_CACHE_MAX + 50 }, (_, i) =>
      fakeArticle(`a${i.toString().padStart(4, '0')}`, new Date(Date.now() - i * 60000).toISOString())
    );
    await store.upsertArticles(many, 'uxmag');
    const all = await store.listArticles();
    expect(all.length).toBe(ARTICLE_CACHE_MAX);
  });

  it('sorts articles by publishedAt descending', async () => {
    await store.upsertArticles(
      [
        fakeArticle('old', '2024-01-01T00:00:00.000Z'),
        fakeArticle('new', '2025-12-31T00:00:00.000Z'),
        fakeArticle('mid', '2024-06-01T00:00:00.000Z'),
      ],
      'uxmag'
    );
    const all = await store.listArticles();
    expect(all.map((a) => a.id)).toEqual(['new', 'mid', 'old']);
  });
});

describe('AiRunTimesStore.savePreferences', () => {
  it('rejects unknown preference ids', async () => {
    const store = makeStore();
    await expect(
      store.savePreferences(['conv-design', 'invalid' as unknown as 'conv-design'])
    ).rejects.toMatchObject({ code: AI_RUN_TIMES_ERROR_CODES.BAD_INPUT });
  });

  it('disables ids not in the enabled list', async () => {
    const store = makeStore();
    const result = await store.savePreferences(['conv-design']);
    expect(result.find((p) => p.id === 'conv-design')?.enabled).toBe(true);
    expect(result.find((p) => p.id === 'enterprise-ai')?.enabled).toBe(false);
  });
});

describe('AiRunTimesStore.recordRead', () => {
  it('inserts new entries newest-first', async () => {
    const store = makeStore();
    await store.recordRead({ articleId: 'a', title: 'A', link: 'x', wordCount: 100 });
    await store.recordRead({ articleId: 'b', title: 'B', link: 'y', wordCount: 200 });
    const log = await store.listReadingLog();
    expect(log.map((e) => e.articleId)).toEqual(['b', 'a']);
  });

  it('updates existing entry on subsequent recordRead', async () => {
    const store = makeStore();
    await store.recordRead({ articleId: 'a', title: 'A', link: 'x', wordCount: 100 });
    await store.recordRead({
      articleId: 'a',
      title: 'A',
      link: 'x',
      wordCount: 100,
      finishedAt: '2026-01-01T00:00:00.000Z',
      listenedToCompletion: true,
    });
    const log = await store.listReadingLog();
    expect(log.length).toBe(1);
    expect(log[0]?.finishedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(log[0]?.listenedToCompletion).toBe(true);
  });
});

describe('AiRunTimesStore feed sources', () => {
  it('default seed contains the uxmag feed', async () => {
    const store = makeStore();
    const sources = await store.listFeedSources();
    expect(sources.some((f) => f.id === 'uxmag')).toBe(true);
  });

  it('removeFeedSource also drops articles attributed to that feed', async () => {
    const store = makeStore();
    const created = await store.addFeedSource({ label: 'Test', url: 'https://example.com/feed' });
    await store.upsertArticles([fakeArticle('x')], created.id);
    expect((await store.listArticles()).length).toBe(1);
    await store.removeFeedSource(created.id);
    expect((await store.listArticles()).length).toBe(0);
  });
});

describe('AiRunTimesStore.onChange', () => {
  it('notifies listeners on writes; isolates throwers', async () => {
    const store = makeStore();
    const calls: Array<{ reason: string }> = [];
    const unsub1 = store.onChange(() => {
      throw new Error('first listener throws');
    });
    const unsub2 = store.onChange((_blob, reason) => calls.push({ reason }));
    await store.recordRead({ articleId: 'a', title: 'A', link: 'x', wordCount: 100 });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.reason).toBe('reading-log');
    unsub1();
    unsub2();
  });
});
