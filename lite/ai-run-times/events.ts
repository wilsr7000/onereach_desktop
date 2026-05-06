/**
 * AI Run Times module event types -- per-module typed event surface (ADR-032).
 */

import type { EventRecord } from '../logging/events.js';

export const AI_RUN_TIMES_EVENTS = {
  // Spans (start / finish / fail). Emitted via `getLoggingApi().start(...)`
  // which produces all three in one fluent chain; we list them here so
  // event-name-conformance + typed-onevent can validate the surface.
  REFRESH_FEED_START: 'ai-run-times.refresh-feed.start',
  REFRESH_FEED_FINISH: 'ai-run-times.refresh-feed.finish',
  REFRESH_FEED_FAIL: 'ai-run-times.refresh-feed.fail',
  FETCH_ARTICLE_START: 'ai-run-times.fetch-article.start',
  FETCH_ARTICLE_FINISH: 'ai-run-times.fetch-article.finish',
  FETCH_ARTICLE_FAIL: 'ai-run-times.fetch-article.fail',
  // Activity (instant). One event per state change the user can
  // observe in the UI.
  WINDOW_OPENED: 'ai-run-times.window.opened',
  ARTICLE_OPENED: 'ai-run-times.article.opened',
  ARTICLE_FINISHED: 'ai-run-times.article.finished',
  PREFERENCES_SAVED: 'ai-run-times.preferences.saved',
  FEED_SOURCE_ADDED: 'ai-run-times.feed-source.added',
  FEED_SOURCE_REMOVED: 'ai-run-times.feed-source.removed',
  FEED_SOURCE_TOGGLED: 'ai-run-times.feed-source.toggled',
  READING_LOG_EXPORTED: 'ai-run-times.reading-log.exported',
  READING_LOG_CLEARED: 'ai-run-times.reading-log.cleared',
  CHANGED: 'ai-run-times.changed',
  // IPC entry events (per ADR-030). Every IPC handler emits its
  // entry event BEFORE doing any real work, so renderer-driven
  // activity is observable in `/logs?category=ai-run-times` even
  // when the call ultimately fails or is malformed.
  IPC_LIST_ARTICLES: 'ai-run-times.ipc.list-articles',
  IPC_REFRESH_FEED: 'ai-run-times.ipc.refresh-feed',
  IPC_GET_ARTICLE: 'ai-run-times.ipc.get-article',
  IPC_FETCH_ARTICLE_BODY: 'ai-run-times.ipc.fetch-article-body',
  IPC_LIST_PREFERENCES: 'ai-run-times.ipc.list-preferences',
  IPC_SAVE_PREFERENCES: 'ai-run-times.ipc.save-preferences',
  IPC_LIST_READING_LOG: 'ai-run-times.ipc.list-reading-log',
  IPC_RECORD_READ: 'ai-run-times.ipc.record-read',
  IPC_CLEAR_READING_LOG: 'ai-run-times.ipc.clear-reading-log',
  IPC_EXPORT_READING_LOG: 'ai-run-times.ipc.export-reading-log',
  IPC_LIST_FEED_SOURCES: 'ai-run-times.ipc.list-feed-sources',
  IPC_ADD_FEED_SOURCE: 'ai-run-times.ipc.add-feed-source',
  IPC_REMOVE_FEED_SOURCE: 'ai-run-times.ipc.remove-feed-source',
  IPC_TOGGLE_FEED_SOURCE: 'ai-run-times.ipc.toggle-feed-source',
  IPC_OPEN_WINDOW: 'ai-run-times.ipc.open-window',
} as const;

export type AiRunTimesEventName =
  (typeof AI_RUN_TIMES_EVENTS)[keyof typeof AI_RUN_TIMES_EVENTS];

interface ArtBase {
  id: string;
  timestamp: string;
  category: 'ai-run-times';
}

export interface ArtRefreshStartEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.REFRESH_FEED_START;
  level: 'info';
  data: { feedCount: number };
}
export interface ArtRefreshFinishEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.REFRESH_FEED_FINISH;
  level: 'info';
  data: { fetchedCount: number; newArticles: number; durationMs: number };
}
export interface ArtRefreshFailEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.REFRESH_FEED_FAIL;
  level: 'error';
  data: { code: string };
}
export interface ArtFetchArticleStartEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.FETCH_ARTICLE_START;
  level: 'info';
  data: { articleId: string };
}
export interface ArtFetchArticleFinishEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.FETCH_ARTICLE_FINISH;
  level: 'info';
  data: { articleId: string; wordCount: number; readingTimeMinutes: number; durationMs: number };
}
export interface ArtFetchArticleFailEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.FETCH_ARTICLE_FAIL;
  level: 'error';
  data: { articleId: string; code: string };
}

export interface ArtWindowOpenedEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.WINDOW_OPENED;
  level: 'info';
}
export interface ArtArticleOpenedEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.ARTICLE_OPENED;
  level: 'info';
  data: { articleId: string };
}
export interface ArtArticleFinishedEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.ARTICLE_FINISHED;
  level: 'info';
  data: { articleId: string; durationMs: number; listened: boolean };
}
export interface ArtPreferencesSavedEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.PREFERENCES_SAVED;
  level: 'info';
  data: { enabledCount: number };
}
export interface ArtFeedSourceAddedEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.FEED_SOURCE_ADDED;
  level: 'info';
  data: { feedId: string };
}
export interface ArtFeedSourceRemovedEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.FEED_SOURCE_REMOVED;
  level: 'info';
  data: { feedId: string };
}
export interface ArtFeedSourceToggledEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.FEED_SOURCE_TOGGLED;
  level: 'info';
  data: { feedId: string; enabled: boolean };
}
export interface ArtReadingLogExportedEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.READING_LOG_EXPORTED;
  level: 'info';
  data: { entryCount: number };
}
export interface ArtReadingLogClearedEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.READING_LOG_CLEARED;
  level: 'info';
}
// TTS_PLAYBACK_* events removed -- TTS was pulled along with
// `lite/ai/`. Bringing TTS back is a separate chunk that re-adds
// these event names to AI_RUN_TIMES_EVENTS + the union below.

export interface ArtChangedEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.CHANGED;
  level: 'info';
  data: { reason: 'articles' | 'preferences' | 'feed-sources' | 'reading-log' };
}

// IPC entries
export interface ArtIpcListArticlesEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.IPC_LIST_ARTICLES;
  level: 'info';
}
export interface ArtIpcRefreshFeedEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.IPC_REFRESH_FEED;
  level: 'info';
}
export interface ArtIpcGetArticleEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.IPC_GET_ARTICLE;
  level: 'info';
}
export interface ArtIpcFetchArticleBodyEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.IPC_FETCH_ARTICLE_BODY;
  level: 'info';
}
export interface ArtIpcListPreferencesEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.IPC_LIST_PREFERENCES;
  level: 'info';
}
export interface ArtIpcSavePreferencesEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.IPC_SAVE_PREFERENCES;
  level: 'info';
}
export interface ArtIpcListReadingLogEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.IPC_LIST_READING_LOG;
  level: 'info';
}
export interface ArtIpcRecordReadEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.IPC_RECORD_READ;
  level: 'info';
}
export interface ArtIpcClearReadingLogEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.IPC_CLEAR_READING_LOG;
  level: 'info';
}
export interface ArtIpcExportReadingLogEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.IPC_EXPORT_READING_LOG;
  level: 'info';
}
export interface ArtIpcListFeedSourcesEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.IPC_LIST_FEED_SOURCES;
  level: 'info';
}
export interface ArtIpcAddFeedSourceEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.IPC_ADD_FEED_SOURCE;
  level: 'info';
}
export interface ArtIpcRemoveFeedSourceEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.IPC_REMOVE_FEED_SOURCE;
  level: 'info';
}
export interface ArtIpcToggleFeedSourceEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.IPC_TOGGLE_FEED_SOURCE;
  level: 'info';
}
export interface ArtIpcOpenWindowEvent extends ArtBase {
  name: typeof AI_RUN_TIMES_EVENTS.IPC_OPEN_WINDOW;
  level: 'info';
}

export type AiRunTimesEvent =
  | ArtRefreshStartEvent
  | ArtRefreshFinishEvent
  | ArtRefreshFailEvent
  | ArtFetchArticleStartEvent
  | ArtFetchArticleFinishEvent
  | ArtFetchArticleFailEvent
  | ArtWindowOpenedEvent
  | ArtArticleOpenedEvent
  | ArtArticleFinishedEvent
  | ArtPreferencesSavedEvent
  | ArtFeedSourceAddedEvent
  | ArtFeedSourceRemovedEvent
  | ArtFeedSourceToggledEvent
  | ArtReadingLogExportedEvent
  | ArtReadingLogClearedEvent
  | ArtChangedEvent
  | ArtIpcListArticlesEvent
  | ArtIpcRefreshFeedEvent
  | ArtIpcGetArticleEvent
  | ArtIpcFetchArticleBodyEvent
  | ArtIpcListPreferencesEvent
  | ArtIpcSavePreferencesEvent
  | ArtIpcListReadingLogEvent
  | ArtIpcRecordReadEvent
  | ArtIpcClearReadingLogEvent
  | ArtIpcExportReadingLogEvent
  | ArtIpcListFeedSourcesEvent
  | ArtIpcAddFeedSourceEvent
  | ArtIpcRemoveFeedSourceEvent
  | ArtIpcToggleFeedSourceEvent
  | ArtIpcOpenWindowEvent;

export function isAiRunTimesEvent(ev: EventRecord): ev is EventRecord & AiRunTimesEvent {
  return Object.values(AI_RUN_TIMES_EVENTS).includes(ev.name as AiRunTimesEventName);
}
