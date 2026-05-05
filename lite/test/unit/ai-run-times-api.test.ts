/**
 * AI Run Times API conformance + behavior tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getAiRunTimesApi,
  buildAiRunTimesApi,
  _resetAiRunTimesApiForTesting,
  _setAiRunTimesApiForTesting,
  AiRunTimesError,
  AI_RUN_TIMES_ERROR_CODES,
  AI_RUN_TIMES_EVENTS,
  isAiRunTimesEvent,
  type AiRunTimesApi,
  type AiRunTimesErrorCode,
} from '../../ai-run-times/api.js';
import { AiRunTimesStore } from '../../ai-run-times/store.js';
import { FakeKV } from '../harness/index.js';
import { runApiConformanceContract } from '../harness/api-conformance.js';
import { runErrorConformanceContract } from '../harness/error-conformance.js';

runApiConformanceContract<AiRunTimesApi>({
  name: 'AiRunTimesApi',
  getInstance: getAiRunTimesApi,
  resetForTesting: _resetAiRunTimesApiForTesting,
  setForTesting: _setAiRunTimesApiForTesting,
  expectedMethods: [
    'listArticles',
    'getArticle',
    'refreshFeed',
    'fetchArticleBody',
    'listPreferences',
    'savePreferences',
    'listFeedSources',
    'addFeedSource',
    'removeFeedSource',
    'toggleFeedSource',
    'listReadingLog',
    'recordRead',
    'clearReadingLog',
    'exportReadingLog',
    'onEvent',
  ],
});

runErrorConformanceContract<AiRunTimesError>({
  name: 'AiRunTimesError',
  ErrorClass: AiRunTimesError,
  codeEnum: AI_RUN_TIMES_ERROR_CODES,
  modulePrefix: 'ART_',
  constructErrorWithCode: (code) =>
    new AiRunTimesError({
      code: code as AiRunTimesErrorCode,
      message: 'sample',
      context: { op: 'sample' },
    }),
});

describe('AiRunTimesApi behavior', () => {
  let api: AiRunTimesApi;
  beforeEach(() => {
    _resetAiRunTimesApiForTesting();
    const store = new AiRunTimesStore({ kvApi: new FakeKV() });
    api = buildAiRunTimesApi(store);
  });

  it('listFeedSources returns the default uxmag feed', async () => {
    const sources = await api.listFeedSources();
    expect(sources.length).toBeGreaterThan(0);
    expect(sources[0]?.id).toBe('uxmag');
    expect(sources[0]?.url).toContain('uxmag.com');
  });

  it('listPreferences returns 7 preferences, all enabled by default', async () => {
    const prefs = await api.listPreferences();
    expect(prefs.length).toBe(7);
    expect(prefs.every((p) => p.enabled)).toBe(true);
  });

  it('savePreferences disables unselected ids', async () => {
    const updated = await api.savePreferences(['conv-design', 'ai-trends']);
    expect(updated.find((p) => p.id === 'conv-design')?.enabled).toBe(true);
    expect(updated.find((p) => p.id === 'ai-trends')?.enabled).toBe(true);
    expect(updated.find((p) => p.id === 'enterprise-ai')?.enabled).toBe(false);
  });

  it('addFeedSource validates URL', async () => {
    await expect(api.addFeedSource({ label: 'Bad', url: 'not-a-url' })).rejects.toMatchObject({
      code: AI_RUN_TIMES_ERROR_CODES.BAD_INPUT,
    });
    await expect(api.addFeedSource({ label: 'Bad', url: 'ftp://uxmag.com/' })).rejects.toMatchObject({
      code: AI_RUN_TIMES_ERROR_CODES.BAD_INPUT,
    });
  });

  it('addFeedSource rejects duplicates', async () => {
    await api.addFeedSource({ label: 'Test', url: 'https://example.com/feed' });
    await expect(
      api.addFeedSource({ label: 'Test 2', url: 'https://example.com/feed' })
    ).rejects.toMatchObject({ code: AI_RUN_TIMES_ERROR_CODES.BAD_INPUT });
  });

  it('removeFeedSource throws NOT_FOUND for unknown id', async () => {
    await expect(api.removeFeedSource('does-not-exist')).rejects.toMatchObject({
      code: AI_RUN_TIMES_ERROR_CODES.NOT_FOUND,
    });
  });

  it('toggleFeedSource flips enabled', async () => {
    const sources = await api.listFeedSources();
    const id = sources[0]?.id ?? '';
    const flipped = await api.toggleFeedSource(id, false);
    expect(flipped.enabled).toBe(false);
    const flippedBack = await api.toggleFeedSource(id, true);
    expect(flippedBack.enabled).toBe(true);
  });

  it('recordRead persists, then listReadingLog returns it', async () => {
    await api.recordRead({
      articleId: 'art1',
      title: 'Hello',
      link: 'https://example.com/1',
      wordCount: 100,
    });
    const log = await api.listReadingLog();
    expect(log.length).toBe(1);
    expect(log[0]?.articleId).toBe('art1');
  });

  it('exportReadingLog returns parseable JSON', async () => {
    await api.recordRead({
      articleId: 'art1',
      title: 'Hi',
      link: 'https://example.com/1',
      wordCount: 100,
    });
    const json = await api.exportReadingLog();
    const parsed = JSON.parse(json) as { entryCount: number; entries: unknown[] };
    expect(parsed.entryCount).toBe(1);
    expect(parsed.entries.length).toBe(1);
  });

  it('clearReadingLog wipes the log', async () => {
    await api.recordRead({
      articleId: 'art1',
      title: 'Hi',
      link: 'https://example.com/1',
      wordCount: 100,
    });
    expect((await api.listReadingLog()).length).toBe(1);
    await api.clearReadingLog();
    expect((await api.listReadingLog()).length).toBe(0);
  });
});

describe('isAiRunTimesEvent narrowing', () => {
  it('matches by event name', () => {
    for (const name of Object.values(AI_RUN_TIMES_EVENTS)) {
      expect(
        isAiRunTimesEvent({
          id: '1',
          timestamp: 't',
          name,
          level: 'info',
          category: 'ai-run-times',
        })
      ).toBe(true);
    }
    expect(
      isAiRunTimesEvent({
        id: '1',
        timestamp: 't',
        name: 'kv.set.start',
        level: 'info',
        category: 'kv',
      })
    ).toBe(false);
  });
});

describe('_setAiRunTimesApiForTesting', () => {
  beforeEach(() => {
    _resetAiRunTimesApiForTesting();
  });

  it('overrides the singleton', () => {
    const stub = {
      listArticles: vi.fn(),
      getArticle: vi.fn(),
      refreshFeed: vi.fn(),
      fetchArticleBody: vi.fn(),
      listPreferences: vi.fn(),
      savePreferences: vi.fn(),
      listFeedSources: vi.fn(),
      addFeedSource: vi.fn(),
      removeFeedSource: vi.fn(),
      toggleFeedSource: vi.fn(),
      listReadingLog: vi.fn(),
      recordRead: vi.fn(),
      clearReadingLog: vi.fn(),
      exportReadingLog: vi.fn(),
      onEvent: vi.fn().mockReturnValue(() => undefined),
    } as unknown as AiRunTimesApi;
    _setAiRunTimesApiForTesting(stub);
    expect(getAiRunTimesApi()).toBe(stub);
  });
});
