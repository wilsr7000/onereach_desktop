/**
 * AI Run Times module -- PUBLIC API.
 *
 * The only file other lite modules should import from in this
 * module. Per ADR-019 / Rule 11, cross-module imports go through
 * `<module>/api.ts` -- never reach into `store.ts`, `fetcher.ts`,
 * or any other internal file.
 *
 * AI Run Times is the polished Flipboard-style article reader: it
 * fetches RSS feeds, displays tiles, lets users read articles in
 * an overlay, supports content preferences, persists a reading
 * log (with JSON export), and (when an OpenAI key is configured)
 * generates TTS audio with a queueable playlist.
 *
 * v1 ships with one default feed source (UX Magazine -- OneReach's
 * article home). Users can add / remove feed sources in
 * Settings -> AI Run Times.
 *
 * Tests: `_setAiRunTimesApiForTesting(stub)`, `_resetAiRunTimesApiForTesting()`.
 */

import { AiRunTimesStore } from './store.js';
import {
  fetchAndParseFeed,
  fetchArticleContent,
  type FetchArticleResult,
} from './fetcher.js';
import {
  AiRunTimesError,
  AI_RUN_TIMES_ERROR_CODES,
} from './errors.js';
import {
  AI_RUN_TIMES_EVENTS,
  isAiRunTimesEvent,
  type AiRunTimesEvent,
} from './events.js';
import type {
  Article,
  FeedSource,
  Preference,
  PreferenceId,
  ReadingLogEntry,
} from './types.js';
import { getLoggingApi } from '../logging/api.js';
import type { EventRecord } from '../logging/events.js';

// ── Re-export public types ────────────────────────────────────────────────

export type {
  Article,
  FeedSource,
  Preference,
  PreferenceId,
  ReadingLogEntry,
  AiRunTimesStorageBlob,
} from './types.js';
export {
  PREFERENCE_IDS,
  READING_TIME_WPM,
  ARTICLE_CACHE_MAX,
  READING_LOG_MAX,
  DEFAULT_FEED_SOURCE,
  DEFAULT_PREFERENCES,
  AI_RUN_TIMES_MODULE_VERSION,
} from './types.js';

export type { AiRunTimesErrorCode, AiRunTimesErrorOptions } from './errors.js';
export { AiRunTimesError, AI_RUN_TIMES_ERROR_CODES };

export type {
  AiRunTimesEvent,
  AiRunTimesEventName,
  ArtRefreshStartEvent,
  ArtRefreshFinishEvent,
  ArtRefreshFailEvent,
  ArtFetchArticleStartEvent,
  ArtFetchArticleFinishEvent,
  ArtFetchArticleFailEvent,
  ArtWindowOpenedEvent,
  ArtArticleOpenedEvent,
  ArtArticleFinishedEvent,
  ArtPreferencesSavedEvent,
  ArtFeedSourceAddedEvent,
  ArtFeedSourceRemovedEvent,
  ArtFeedSourceToggledEvent,
  ArtReadingLogExportedEvent,
  ArtReadingLogClearedEvent,
  ArtTtsPlaybackStartEvent,
  ArtTtsPlaybackFinishEvent,
  ArtTtsPlaybackFailEvent,
  ArtChangedEvent,
} from './events.js';
export { AI_RUN_TIMES_EVENTS, isAiRunTimesEvent };

export { LiteError, isLiteError } from '../errors.js';

// ── Public API surface ────────────────────────────────────────────────────

export interface RefreshFeedResult {
  /** Number of feeds that responded successfully. */
  fetchedCount: number;
  /** Number of new (previously unseen) articles added across all feeds. */
  newArticles: number;
  /** Per-feed results -- success or per-feed error code. */
  perFeed: Array<
    | { feedId: string; ok: true; articleCount: number; newArticles: number }
    | { feedId: string; ok: false; code: string; message: string }
  >;
}

export interface AiRunTimesApi {
  /** All cached articles, newest first. */
  listArticles(): Promise<Article[]>;
  /** Single article by id, or null if absent. */
  getArticle(id: string): Promise<Article | null>;
  /**
   * Fetch enabled feed sources, parse each, and merge results into
   * the cache. Always succeeds when ANY feed succeeds; returns
   * per-feed status. Throws only if persistence fails.
   */
  refreshFeed(): Promise<RefreshFeedResult>;
  /**
   * Fetch the full HTML of a single article and persist it. Returns
   * the updated Article with `contentHtml`, `wordCount`, and
   * `readingTimeMinutes` populated.
   */
  fetchArticleBody(id: string): Promise<Article>;

  /** Content preferences (7 categories, with `enabled` per id). */
  listPreferences(): Promise<Preference[]>;
  /** Persist enabled preference set. Returns the updated list. */
  savePreferences(enabledIds: PreferenceId[]): Promise<Preference[]>;

  /** Feed sources. v1 ships with one default; user can add more. */
  listFeedSources(): Promise<FeedSource[]>;
  addFeedSource(input: { label: string; url: string }): Promise<FeedSource>;
  removeFeedSource(id: string): Promise<{ ok: true }>;
  toggleFeedSource(id: string, enabled: boolean): Promise<FeedSource>;

  /** Reading log -- newest first, capped at 1000. */
  listReadingLog(): Promise<ReadingLogEntry[]>;
  recordRead(entry: {
    articleId: string;
    title: string;
    link: string;
    wordCount: number;
    finishedAt?: string | null;
    listenedToCompletion?: boolean;
  }): Promise<ReadingLogEntry>;
  /** Clear the reading log. Idempotent. */
  clearReadingLog(): Promise<{ ok: true }>;
  /** Export the reading log as JSON (string). */
  exportReadingLog(): Promise<string>;

  /** Subscribe to typed AI Run Times events. */
  onEvent(handler: (event: AiRunTimesEvent) => void): () => void;
}

let _instance: AiRunTimesApi | null = null;

export function getAiRunTimesApi(): AiRunTimesApi {
  if (_instance === null) {
    _instance = buildDefaultApi();
  }
  return _instance;
}

export function _resetAiRunTimesApiForTesting(): void {
  _instance = null;
}

export function _setAiRunTimesApiForTesting(api: AiRunTimesApi): void {
  _instance = api;
}

/** Build an api around a custom store (for tests). */
export function buildAiRunTimesApi(store: AiRunTimesStore): AiRunTimesApi {
  return makeApi(store);
}

// ── default implementation ────────────────────────────────────────────────

function buildDefaultApi(): AiRunTimesApi {
  return makeApi(new AiRunTimesStore());
}

function makeApi(store: AiRunTimesStore): AiRunTimesApi {
  return {
    listArticles: () => store.listArticles(),
    getArticle: (id) => store.getArticle(id),

    refreshFeed: async () => {
      const sources = (await store.listFeedSources()).filter((f) => f.enabled);
      const span = getLoggingApi().start('ai-run-times.refresh-feed', {
        feedCount: sources.length,
      });
      const perFeed: RefreshFeedResult['perFeed'] = [];
      let newArticles = 0;
      let fetchedCount = 0;
      try {
        for (const source of sources) {
          try {
            const articles = await fetchAndParseFeed({
              url: source.url,
              feedId: source.id,
            });
            const { newCount } = await store.upsertArticles(articles, source.id);
            perFeed.push({
              feedId: source.id,
              ok: true,
              articleCount: articles.length,
              newArticles: newCount,
            });
            newArticles += newCount;
            fetchedCount += 1;
          } catch (err) {
            const e = err as Error & { code?: string };
            perFeed.push({
              feedId: source.id,
              ok: false,
              code: e.code ?? 'ART_FEED_FETCH_FAILED',
              message: e.message ?? 'feed fetch failed',
            });
          }
        }
        const result: RefreshFeedResult = { fetchedCount, newArticles, perFeed };
        span.finish({ data: { fetchedCount, newArticles } });
        return result;
      } catch (err) {
        span.fail(err as Error);
        throw err;
      }
    },

    fetchArticleBody: async (id) => {
      const article = await store.getArticle(id);
      if (article === null) {
        throw new AiRunTimesError({
          code: AI_RUN_TIMES_ERROR_CODES.NOT_FOUND,
          message: `fetchArticleBody: article not found: ${id}`,
          context: { op: 'fetchArticleBody', id },
        });
      }
      // Use cached body when present.
      if (article.contentHtml !== null && article.wordCount > 0) {
        return article;
      }
      const span = getLoggingApi().start('ai-run-times.fetch-article', {
        articleId: id,
      });
      try {
        const fetched: FetchArticleResult = await fetchArticleContent({
          url: article.link,
        });
        const updated = await store.setArticleContent(
          id,
          fetched.html,
          fetched.wordCount,
          fetched.readingTimeMinutes
        );
        span.finish({
          data: {
            articleId: id,
            wordCount: fetched.wordCount,
            readingTimeMinutes: fetched.readingTimeMinutes,
          },
        });
        return updated;
      } catch (err) {
        span.fail(err as Error);
        throw err;
      }
    },

    listPreferences: () => store.listPreferences(),
    savePreferences: async (enabledIds) => {
      const result = await store.savePreferences(enabledIds);
      getLoggingApi().event(AI_RUN_TIMES_EVENTS.PREFERENCES_SAVED, {
        enabledCount: result.filter((p) => p.enabled).length,
      });
      return result;
    },

    listFeedSources: () => store.listFeedSources(),
    addFeedSource: async (input) => {
      const result = await store.addFeedSource(input);
      getLoggingApi().event(AI_RUN_TIMES_EVENTS.FEED_SOURCE_ADDED, { feedId: result.id });
      return result;
    },
    removeFeedSource: async (id) => {
      await store.removeFeedSource(id);
      getLoggingApi().event(AI_RUN_TIMES_EVENTS.FEED_SOURCE_REMOVED, { feedId: id });
      return { ok: true };
    },
    toggleFeedSource: async (id, enabled) => {
      const result = await store.toggleFeedSource(id, enabled);
      getLoggingApi().event(AI_RUN_TIMES_EVENTS.FEED_SOURCE_TOGGLED, {
        feedId: id,
        enabled: result.enabled,
      });
      return result;
    },

    listReadingLog: () => store.listReadingLog(),
    recordRead: (entry) => store.recordRead(entry),
    clearReadingLog: async () => {
      await store.clearReadingLog();
      getLoggingApi().event(AI_RUN_TIMES_EVENTS.READING_LOG_CLEARED);
      return { ok: true };
    },
    exportReadingLog: async () => {
      const json = await store.exportReadingLog();
      const entryCount = (JSON.parse(json) as { entryCount: number }).entryCount;
      getLoggingApi().event(AI_RUN_TIMES_EVENTS.READING_LOG_EXPORTED, { entryCount });
      return json;
    },

    onEvent: (handler) =>
      getLoggingApi().onEvent('ai-run-times.*', (ev: EventRecord) => {
        if (isAiRunTimesEvent(ev)) {
          handler(ev as unknown as AiRunTimesEvent);
        }
      }),
  };
}
