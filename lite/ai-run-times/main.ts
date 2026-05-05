/**
 * AI Run Times main-process orchestration.
 *
 * Owns:
 *   - IPC handlers for `lite:ai-run-times:*`
 *   - The reader window factory + `lite:ai-run-times:open-window` IPC
 *
 * Per ADR-019 / Rule 11, this module is the boundary between
 * Electron IPC and the typed `AiRunTimesApi`. Per ADR-030, every
 * handler emits an instant `ai-run-times.ipc.<verb>` event on entry.
 */

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  getAiRunTimesApi,
  AiRunTimesError,
  type Article,
  type FeedSource,
  type Preference,
  type PreferenceId,
  type ReadingLogEntry,
  type RefreshFeedResult,
} from './api.js';
import { AI_RUN_TIMES_EVENTS } from './events.js';
import { openAiRunTimesWindow, closeAiRunTimesWindow } from './window.js';
import { getLoggingApi } from '../logging/api.js';

export const AI_RUN_TIMES_IPC = {
  LIST_ARTICLES: 'lite:ai-run-times:list-articles',
  REFRESH_FEED: 'lite:ai-run-times:refresh-feed',
  GET_ARTICLE: 'lite:ai-run-times:get-article',
  FETCH_ARTICLE_BODY: 'lite:ai-run-times:fetch-article-body',
  LIST_PREFERENCES: 'lite:ai-run-times:list-preferences',
  SAVE_PREFERENCES: 'lite:ai-run-times:save-preferences',
  LIST_FEED_SOURCES: 'lite:ai-run-times:list-feed-sources',
  ADD_FEED_SOURCE: 'lite:ai-run-times:add-feed-source',
  REMOVE_FEED_SOURCE: 'lite:ai-run-times:remove-feed-source',
  TOGGLE_FEED_SOURCE: 'lite:ai-run-times:toggle-feed-source',
  LIST_READING_LOG: 'lite:ai-run-times:list-reading-log',
  RECORD_READ: 'lite:ai-run-times:record-read',
  CLEAR_READING_LOG: 'lite:ai-run-times:clear-reading-log',
  EXPORT_READING_LOG: 'lite:ai-run-times:export-reading-log',
  OPEN_WINDOW: 'lite:ai-run-times:open-window',
} as const;

export interface InitAiRunTimesOptions {
  preloadPath: string;
  /** Path to bundled ai-run-times.html. */
  htmlPath: string;
  getParentWindow: () => BrowserWindow | null;
  logger?: {
    info: (message: string, data?: unknown) => void;
    warn: (message: string, data?: unknown) => void;
    error: (message: string, data?: unknown) => void;
  };
}

export interface AiRunTimesHandle {
  teardown(): void;
}

let registered = false;
let initOpts: InitAiRunTimesOptions | null = null;

export function initAiRunTimes(opts: InitAiRunTimesOptions): AiRunTimesHandle {
  const log = opts.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  if (registered) return { teardown: teardownInternal };
  initOpts = opts;
  const api = getAiRunTimesApi();

  ipcMain.handle(AI_RUN_TIMES_IPC.LIST_ARTICLES, async (): Promise<Article[]> => {
    getLoggingApi().event(AI_RUN_TIMES_EVENTS.IPC_LIST_ARTICLES);
    return api.listArticles();
  });

  ipcMain.handle(AI_RUN_TIMES_IPC.REFRESH_FEED, async (): Promise<RefreshFeedResult> => {
    getLoggingApi().event(AI_RUN_TIMES_EVENTS.IPC_REFRESH_FEED);
    try {
      return await api.refreshFeed();
    } catch (err) {
      if (err instanceof AiRunTimesError) {
        log.warn('refresh-feed rejected', { code: err.code });
        throw new Error(JSON.stringify({ __aiRunTimesError: err.toJSON() }));
      }
      throw err;
    }
  });

  ipcMain.handle(
    AI_RUN_TIMES_IPC.GET_ARTICLE,
    async (_e: IpcMainInvokeEvent, payload: { id?: unknown }): Promise<Article | null> => {
      getLoggingApi().event(AI_RUN_TIMES_EVENTS.IPC_GET_ARTICLE);
      const id = nonEmptyString(payload?.id, 'id');
      return api.getArticle(id);
    }
  );

  ipcMain.handle(
    AI_RUN_TIMES_IPC.FETCH_ARTICLE_BODY,
    async (_e: IpcMainInvokeEvent, payload: { id?: unknown }): Promise<Article> => {
      const id = nonEmptyString(payload?.id, 'id');
      try {
        return await api.fetchArticleBody(id);
      } catch (err) {
        if (err instanceof AiRunTimesError) {
          log.warn('fetch-article-body rejected', { code: err.code });
          throw new Error(JSON.stringify({ __aiRunTimesError: err.toJSON() }));
        }
        throw err;
      }
    }
  );

  ipcMain.handle(AI_RUN_TIMES_IPC.LIST_PREFERENCES, async (): Promise<Preference[]> => {
    getLoggingApi().event(AI_RUN_TIMES_EVENTS.IPC_LIST_PREFERENCES);
    return api.listPreferences();
  });

  ipcMain.handle(
    AI_RUN_TIMES_IPC.SAVE_PREFERENCES,
    async (
      _e: IpcMainInvokeEvent,
      payload: { enabledIds?: unknown }
    ): Promise<Preference[]> => {
      getLoggingApi().event(AI_RUN_TIMES_EVENTS.IPC_SAVE_PREFERENCES);
      const ids = stringArray(payload?.enabledIds, 'enabledIds') as PreferenceId[];
      try {
        return await api.savePreferences(ids);
      } catch (err) {
        if (err instanceof AiRunTimesError) {
          log.warn('save-preferences rejected', { code: err.code });
          throw new Error(JSON.stringify({ __aiRunTimesError: err.toJSON() }));
        }
        throw err;
      }
    }
  );

  ipcMain.handle(AI_RUN_TIMES_IPC.LIST_FEED_SOURCES, async (): Promise<FeedSource[]> => {
    getLoggingApi().event(AI_RUN_TIMES_EVENTS.IPC_LIST_FEED_SOURCES);
    return api.listFeedSources();
  });

  ipcMain.handle(
    AI_RUN_TIMES_IPC.ADD_FEED_SOURCE,
    async (
      _e: IpcMainInvokeEvent,
      payload: { label?: unknown; url?: unknown }
    ): Promise<FeedSource> => {
      getLoggingApi().event(AI_RUN_TIMES_EVENTS.IPC_ADD_FEED_SOURCE);
      const label = nonEmptyString(payload?.label, 'label');
      const url = nonEmptyString(payload?.url, 'url');
      try {
        return await api.addFeedSource({ label, url });
      } catch (err) {
        if (err instanceof AiRunTimesError) {
          log.warn('add-feed-source rejected', { code: err.code });
          throw new Error(JSON.stringify({ __aiRunTimesError: err.toJSON() }));
        }
        throw err;
      }
    }
  );

  ipcMain.handle(
    AI_RUN_TIMES_IPC.REMOVE_FEED_SOURCE,
    async (_e: IpcMainInvokeEvent, payload: { id?: unknown }): Promise<{ ok: true }> => {
      getLoggingApi().event(AI_RUN_TIMES_EVENTS.IPC_REMOVE_FEED_SOURCE);
      const id = nonEmptyString(payload?.id, 'id');
      try {
        return await api.removeFeedSource(id);
      } catch (err) {
        if (err instanceof AiRunTimesError) {
          log.warn('remove-feed-source rejected', { code: err.code });
          throw new Error(JSON.stringify({ __aiRunTimesError: err.toJSON() }));
        }
        throw err;
      }
    }
  );

  ipcMain.handle(
    AI_RUN_TIMES_IPC.TOGGLE_FEED_SOURCE,
    async (
      _e: IpcMainInvokeEvent,
      payload: { id?: unknown; enabled?: unknown }
    ): Promise<FeedSource> => {
      getLoggingApi().event(AI_RUN_TIMES_EVENTS.IPC_TOGGLE_FEED_SOURCE);
      const id = nonEmptyString(payload?.id, 'id');
      const enabled = payload?.enabled === true;
      try {
        return await api.toggleFeedSource(id, enabled);
      } catch (err) {
        if (err instanceof AiRunTimesError) {
          log.warn('toggle-feed-source rejected', { code: err.code });
          throw new Error(JSON.stringify({ __aiRunTimesError: err.toJSON() }));
        }
        throw err;
      }
    }
  );

  ipcMain.handle(AI_RUN_TIMES_IPC.LIST_READING_LOG, async (): Promise<ReadingLogEntry[]> => {
    getLoggingApi().event(AI_RUN_TIMES_EVENTS.IPC_LIST_READING_LOG);
    return api.listReadingLog();
  });

  ipcMain.handle(
    AI_RUN_TIMES_IPC.RECORD_READ,
    async (
      _e: IpcMainInvokeEvent,
      payload: {
        articleId?: unknown;
        title?: unknown;
        link?: unknown;
        wordCount?: unknown;
        finishedAt?: unknown;
        listenedToCompletion?: unknown;
      }
    ): Promise<ReadingLogEntry> => {
      getLoggingApi().event(AI_RUN_TIMES_EVENTS.IPC_RECORD_READ);
      const articleId = nonEmptyString(payload?.articleId, 'articleId');
      const title = typeof payload?.title === 'string' ? payload.title : '';
      const link = typeof payload?.link === 'string' ? payload.link : '';
      const wordCount =
        typeof payload?.wordCount === 'number' && Number.isFinite(payload.wordCount)
          ? Math.max(0, Math.floor(payload.wordCount))
          : 0;
      const finishedAt =
        typeof payload?.finishedAt === 'string' ? payload.finishedAt : null;
      const listenedToCompletion = payload?.listenedToCompletion === true;
      try {
        return await api.recordRead({
          articleId,
          title,
          link,
          wordCount,
          finishedAt,
          listenedToCompletion,
        });
      } catch (err) {
        if (err instanceof AiRunTimesError) {
          log.warn('record-read rejected', { code: err.code });
          throw new Error(JSON.stringify({ __aiRunTimesError: err.toJSON() }));
        }
        throw err;
      }
    }
  );

  ipcMain.handle(AI_RUN_TIMES_IPC.CLEAR_READING_LOG, async (): Promise<{ ok: true }> => {
    return api.clearReadingLog();
  });

  ipcMain.handle(AI_RUN_TIMES_IPC.EXPORT_READING_LOG, async (): Promise<string> => {
    return api.exportReadingLog();
  });

  ipcMain.handle(AI_RUN_TIMES_IPC.OPEN_WINDOW, async (): Promise<{ ok: true }> => {
    getLoggingApi().event(AI_RUN_TIMES_EVENTS.IPC_OPEN_WINDOW);
    if (initOpts === null) {
      throw new Error('initAiRunTimes must be called before opening the window');
    }
    openAiRunTimesWindow({
      parent: initOpts.getParentWindow(),
      htmlPath: initOpts.htmlPath,
      preloadPath: initOpts.preloadPath,
    });
    getLoggingApi().event(AI_RUN_TIMES_EVENTS.WINDOW_OPENED);
    return { ok: true };
  });

  registered = true;
  log.info('ai-run-times initialized', {});
  return { teardown: teardownInternal };
}

function teardownInternal(): void {
  if (!registered) return;
  for (const ch of Object.values(AI_RUN_TIMES_IPC)) {
    try {
      ipcMain.removeHandler(ch);
    } catch {
      /* best-effort */
    }
  }
  try {
    closeAiRunTimesWindow();
  } catch {
    /* best-effort */
  }
  registered = false;
  initOpts = null;
}

/** @internal -- exposed for tests. */
export function _isAiRunTimesRegisteredForTesting(): boolean {
  return registered;
}

// ── helpers ──────────────────────────────────────────────────────────────

function nonEmptyString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return v;
}

function stringArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw new Error(`${field} must be an array of strings`);
  }
  return v;
}
