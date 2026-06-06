/**
 * AI Run Times KV-backed store.
 *
 * Persists everything user-modifiable (feed sources, preferences,
 * reading log) AND the article cache in one KV blob:
 * `lite-ai-run-times` / `default`. Single blob keeps reads atomic
 * and avoids the dual-store drift bug from the full app.
 *
 * The store does NOT fetch -- callers (api.ts) handle network.
 * The store handles validation, dedupe (by id), pruning
 * (article cache + reading log), and onChange notifications.
 *
 * @internal
 */

import { getKVApi, KVError } from '../kv/api.js';
import {
  AiRunTimesError,
  AI_RUN_TIMES_ERROR_CODES,
  type AiRunTimesErrorCode,
} from './errors.js';
import {
  AI_RUN_TIMES_EVENTS,
  type AiRunTimesEvent,
} from './events.js';
import {
  ARTICLE_CACHE_MAX,
  DEFAULT_FEED_SOURCE,
  DEFAULT_PREFERENCES,
  PREFERENCE_IDS,
  READING_LOG_MAX,
  type AiRunTimesStorageBlob,
  type Article,
  type FeedSource,
  type Preference,
  type PreferenceId,
  type ReadingLogEntry,
} from './types.js';
import { getLoggingApi } from '../logging/api.js';
import type { EventRecord } from '../logging/events.js';

const KV_COLLECTION = 'lite-ai-run-times';
const KV_KEY = 'default';

export interface AiRunTimesStoreOptions {
  kvApi?: ReturnType<typeof getKVApi>;
  collection?: string;
  key?: string;
  /**
   * Returns the active accountId or `null` when signed out. Used to
   * invalidate the in-memory cache whenever the active session
   * changes — without this resolver, signing out then signing in as
   * a different user would keep showing the previous user's
   * articles / reading log / preferences until a refresh fired.
   *
   * `lite/ai-run-times/api.ts` wires this to
   * `getAuthApi().getSession('edison')?.accountId ?? null`.
   * Omitting it (e.g. in unit tests) falls back to a sentinel that
   * keeps caching working but never invalidates.
   */
  getActiveAccountId?: () => string | null;
}

type ChangeReason = 'articles' | 'preferences' | 'feed-sources' | 'reading-log';
type ChangeListener = (blob: AiRunTimesStorageBlob, reason: ChangeReason) => void;
type EventListener = (ev: AiRunTimesEvent) => void;

export class AiRunTimesStore {
  private readonly kvApi: ReturnType<typeof getKVApi>;
  private readonly collection: string;
  private readonly key: string;
  private readonly changeListeners = new Set<ChangeListener>();
  private readonly eventUnsubs = new Set<() => void>();
  private readonly getActiveAccountId: (() => string | null) | null;
  /** Cached blob — read on first access, refreshed after every write. */
  private cache: AiRunTimesStorageBlob | null = null;
  /**
   * The accountId the cache was populated for. Drives multi-user
   * isolation across sign-out/sign-in flows in the same process —
   * when the active accountId changes the cache resets so user A's
   * reading log can't leak to user B.
   */
  private cachedForAccountId: string | null | undefined = undefined;

  constructor(options: AiRunTimesStoreOptions = {}) {
    this.kvApi = options.kvApi ?? getKVApi();
    this.collection = options.collection ?? KV_COLLECTION;
    this.key = options.key ?? KV_KEY;
    this.getActiveAccountId = options.getActiveAccountId ?? null;
  }

  /**
   * Force a fresh KV read on next access + clear cached state.
   * Wired onto `auth.onSessionChanged` by `ai-run-times/api.ts`.
   * Idempotent.
   */
  invalidateCache(): void {
    this.cache = null;
    this.cachedForAccountId = undefined;
  }

  // ── reads ─────────────────────────────────────────────────────────────

  async load(): Promise<AiRunTimesStorageBlob> {
    return this.readBlob();
  }

  async listArticles(): Promise<Article[]> {
    return (await this.readBlob()).articles;
  }

  async getArticle(id: string): Promise<Article | null> {
    const blob = await this.readBlob();
    return blob.articles.find((a) => a.id === id) ?? null;
  }

  async listPreferences(): Promise<Preference[]> {
    return (await this.readBlob()).preferences;
  }

  async listFeedSources(): Promise<FeedSource[]> {
    return (await this.readBlob()).feedSources;
  }

  async listReadingLog(): Promise<ReadingLogEntry[]> {
    return (await this.readBlob()).readingLog;
  }

  // ── article cache mutations ───────────────────────────────────────────

  /**
   * Insert or update articles in the cache. Dedupes by `id` (source
   * URL hash). Existing entries are merged so cached `contentHtml` /
   * `wordCount` survives a feed refresh that doesn't re-fetch
   * article HTML.
   *
   * Newer articles are placed at the top. Caps at `ARTICLE_CACHE_MAX`
   * (oldest pruned).
   */
  async upsertArticles(incoming: Article[], feedId: string): Promise<{ newCount: number }> {
    if (!Array.isArray(incoming)) {
      throw new AiRunTimesError({
        code: AI_RUN_TIMES_ERROR_CODES.BAD_INPUT,
        message: 'upsertArticles: incoming must be an array',
        context: { op: 'upsertArticles' },
      });
    }
    const blob = await this.readBlob();
    const byId = new Map<string, Article>();
    for (const a of blob.articles) byId.set(a.id, a);
    let newCount = 0;
    for (const a of incoming) {
      if (typeof a.id !== 'string' || a.id.length === 0) continue;
      const existing = byId.get(a.id);
      if (existing === undefined) {
        byId.set(a.id, { ...a, feedId });
        newCount += 1;
      } else {
        // Preserve cached body if the refresh didn't include one.
        byId.set(a.id, {
          ...existing,
          ...a,
          feedId,
          contentHtml: a.contentHtml !== null ? a.contentHtml : existing.contentHtml,
          contentFetchedAt:
            a.contentFetchedAt !== null ? a.contentFetchedAt : existing.contentFetchedAt,
          wordCount: a.wordCount > 0 ? a.wordCount : existing.wordCount,
          readingTimeMinutes:
            a.readingTimeMinutes > 0 ? a.readingTimeMinutes : existing.readingTimeMinutes,
        });
      }
    }
    // Sort newest first (publishedAt desc; null last).
    const next = Array.from(byId.values()).sort(byPublishedAtDesc);
    blob.articles = next.slice(0, ARTICLE_CACHE_MAX);

    // Touch the feed's lastFetchedAt.
    const fs = blob.feedSources.find((f) => f.id === feedId);
    if (fs !== undefined) fs.lastFetchedAt = new Date().toISOString();

    await this.writeBlob(blob, 'articles');
    return { newCount };
  }

  /** Persist the fetched article body + reading time. */
  async setArticleContent(
    articleId: string,
    contentHtml: string,
    wordCount: number,
    readingTimeMinutes: number
  ): Promise<Article> {
    const blob = await this.readBlob();
    const idx = blob.articles.findIndex((a) => a.id === articleId);
    if (idx < 0) {
      throw notFound('setArticleContent', articleId);
    }
    const before = blob.articles[idx];
    if (before === undefined) throw notFound('setArticleContent', articleId);
    const updated: Article = {
      ...before,
      contentHtml,
      contentFetchedAt: new Date().toISOString(),
      wordCount,
      readingTimeMinutes,
    };
    blob.articles[idx] = updated;
    await this.writeBlob(blob, 'articles');
    return updated;
  }

  // ── preferences ───────────────────────────────────────────────────────

  async savePreferences(enabledIds: PreferenceId[]): Promise<Preference[]> {
    if (!Array.isArray(enabledIds)) {
      throw new AiRunTimesError({
        code: AI_RUN_TIMES_ERROR_CODES.BAD_INPUT,
        message: 'savePreferences: enabledIds must be an array of PreferenceId',
        context: { op: 'savePreferences' },
      });
    }
    const validIds = new Set<PreferenceId>(PREFERENCE_IDS);
    for (const id of enabledIds) {
      if (!validIds.has(id)) {
        throw new AiRunTimesError({
          code: AI_RUN_TIMES_ERROR_CODES.BAD_INPUT,
          message: `savePreferences: unknown preference id: ${id}`,
          context: { op: 'savePreferences', id },
        });
      }
    }
    const blob = await this.readBlob();
    const enabledSet = new Set<PreferenceId>(enabledIds);
    blob.preferences = blob.preferences.map((p) => ({
      ...p,
      enabled: enabledSet.has(p.id),
    }));
    await this.writeBlob(blob, 'preferences');
    return blob.preferences;
  }

  // ── feed sources ──────────────────────────────────────────────────────

  async addFeedSource(input: { label: string; url: string }): Promise<FeedSource> {
    const label = (input.label ?? '').trim();
    const url = (input.url ?? '').trim();
    if (label.length === 0) {
      throw badInput('addFeedSource', 'label is required');
    }
    if (!isValidHttpUrl(url)) {
      throw badInput('addFeedSource', 'url must be a valid http/https URL');
    }
    const blob = await this.readBlob();
    if (blob.feedSources.some((f) => f.url === url)) {
      throw badInput('addFeedSource', `feed already exists for url: ${url}`);
    }
    const id = `feed-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16)}`;
    const next: FeedSource = {
      id,
      label,
      url,
      enabled: true,
      addedAt: new Date().toISOString(),
      lastFetchedAt: null,
    };
    blob.feedSources.push(next);
    await this.writeBlob(blob, 'feed-sources');
    return next;
  }

  async removeFeedSource(id: string): Promise<void> {
    const blob = await this.readBlob();
    const idx = blob.feedSources.findIndex((f) => f.id === id);
    if (idx < 0) throw notFound('removeFeedSource', id);
    blob.feedSources.splice(idx, 1);
    // Also drop articles attributed to that feed.
    blob.articles = blob.articles.filter((a) => a.feedId !== id);
    await this.writeBlob(blob, 'feed-sources');
  }

  async toggleFeedSource(id: string, enabled: boolean): Promise<FeedSource> {
    const blob = await this.readBlob();
    const fs = blob.feedSources.find((f) => f.id === id);
    if (fs === undefined) throw notFound('toggleFeedSource', id);
    fs.enabled = enabled === true;
    await this.writeBlob(blob, 'feed-sources');
    return fs;
  }

  // ── reading log ───────────────────────────────────────────────────────

  /** Record (or update) a reading log entry. */
  async recordRead(entry: {
    articleId: string;
    title: string;
    link: string;
    wordCount: number;
    finishedAt?: string | null;
    listenedToCompletion?: boolean;
  }): Promise<ReadingLogEntry> {
    if (typeof entry.articleId !== 'string' || entry.articleId.length === 0) {
      throw badInput('recordRead', 'articleId is required');
    }
    const blob = await this.readBlob();
    const idx = blob.readingLog.findIndex((e) => e.articleId === entry.articleId);
    let logEntry: ReadingLogEntry;
    if (idx >= 0) {
      const before = blob.readingLog[idx];
      if (before === undefined) throw notFound('recordRead', entry.articleId);
      logEntry = {
        ...before,
        finishedAt:
          entry.finishedAt !== undefined ? entry.finishedAt : before.finishedAt,
        listenedToCompletion:
          entry.listenedToCompletion === true ? true : before.listenedToCompletion,
      };
      blob.readingLog[idx] = logEntry;
    } else {
      logEntry = {
        articleId: entry.articleId,
        title: entry.title,
        link: entry.link,
        openedAt: new Date().toISOString(),
        finishedAt: entry.finishedAt ?? null,
        wordCount: entry.wordCount,
        listenedToCompletion: entry.listenedToCompletion === true,
      };
      blob.readingLog.unshift(logEntry);
    }
    if (blob.readingLog.length > READING_LOG_MAX) {
      blob.readingLog = blob.readingLog.slice(0, READING_LOG_MAX);
    }
    await this.writeBlob(blob, 'reading-log');
    return logEntry;
  }

  async clearReadingLog(): Promise<void> {
    const blob = await this.readBlob();
    blob.readingLog = [];
    await this.writeBlob(blob, 'reading-log');
  }

  /** Export the entire reading log as a JSON string. */
  async exportReadingLog(): Promise<string> {
    const blob = await this.readBlob();
    return JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        entryCount: blob.readingLog.length,
        entries: blob.readingLog,
      },
      null,
      2
    );
  }

  // ── subscriptions ─────────────────────────────────────────────────────

  onChange(listener: ChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Subscribe to typed AiRunTimes events. */
  onEvent(listener: EventListener): () => void {
    const unsub = getLoggingApi().onEvent('ai-run-times.*', (ev: EventRecord) => {
      // filter by name list -- isAiRunTimesEvent re-checks but we keep the helper here
      listener(ev as unknown as AiRunTimesEvent);
    });
    this.eventUnsubs.add(unsub);
    return () => {
      unsub();
      this.eventUnsubs.delete(unsub);
    };
  }

  // ── internals ─────────────────────────────────────────────────────────

  private currentAccountId(): string | null {
    if (this.getActiveAccountId === null) return '__legacy__';
    const accountId = this.getActiveAccountId();
    if (typeof accountId !== 'string' || accountId.length === 0) return null;
    return accountId;
  }

  private async readBlob(): Promise<AiRunTimesStorageBlob> {
    const accountId = this.currentAccountId();
    // Signed-out short-circuit: return defaults without touching KV
    // so an unauthenticated read can't surface stale cross-user data.
    if (accountId === null) {
      return defaultBlob();
    }
    // Cache invalidation on account switch — same pattern as
    // lite/idw/store.ts and lite/tools/store.ts. A different
    // accountId means a different KV bucket, so the cached blob is
    // wrong.
    if (this.cache !== null && this.cachedForAccountId === accountId) return this.cache;

    try {
      const value = await this.kvApi.get(this.collection, this.key);
      if (value === null || value === undefined) {
        this.cache = defaultBlob();
        this.cachedForAccountId = accountId;
        return this.cache;
      }
      if (typeof value !== 'object' || Array.isArray(value)) {
        this.log('warn', 'ai-run-times-store: unexpected KV blob shape, resetting in-memory', {
          actualType: Array.isArray(value) ? 'array' : typeof value,
        });
        getLoggingApi().event(AI_RUN_TIMES_EVENTS.SELF_HEAL, {
          actualType: Array.isArray(value) ? 'array' : typeof value,
        });
        // Self-heal: overwrite the corrupt blob with a fresh empty
        // record. Fire-and-forget; a transient write failure just
        // defers the heal to the next read. Same pattern that
        // shipped in main-window / idw / tools.
        const fresh = defaultBlob();
        void this.kvApi.set(this.collection, this.key, fresh).catch((err) => {
          this.log('warn', 'ai-run-times-store: self-heal write failed', {
            error: (err as Error).message,
          });
        });
        this.cache = fresh;
        this.cachedForAccountId = accountId;
        return this.cache;
      }
      const normalized = normalizeBlob(value as Partial<AiRunTimesStorageBlob>);
      this.cache = normalized;
      this.cachedForAccountId = accountId;
      return normalized;
    } catch (err) {
      if (err instanceof KVError) {
        throw new AiRunTimesError({
          code: AI_RUN_TIMES_ERROR_CODES.PERSISTENCE_FAILED,
          message: 'Failed to read AI Run Times state from KV',
          cause: err,
          remediation:
            'Check the KV server (Settings -> Diagnostics). Restarting the app usually recovers.',
        });
      }
      throw err;
    }
  }

  /**
   * Minimal logger — defaults to silent. Real wiring lands when the
   * api factory passes a logger via options (next step).
   */
  private log(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void {
    try {
      getLoggingApi()[level]('ai-run-times', message, data);
    } catch {
      /* best-effort */
    }
  }

  private async writeBlob(
    blob: AiRunTimesStorageBlob,
    reason: ChangeReason
  ): Promise<void> {
    const accountId = this.currentAccountId();
    if (accountId === null) {
      throw new AiRunTimesError({
        code: AI_RUN_TIMES_ERROR_CODES.PERSISTENCE_FAILED,
        message: 'Cannot save AI Run Times state while signed out.',
        context: { reason, op: 'write', signedOut: true },
        remediation: 'Sign in to OneReach first.',
      });
    }
    try {
      await this.kvApi.set(this.collection, this.key, blob);
      // Refresh the cache for THIS accountId so subsequent reads
      // pick up the new state without a round-trip.
      this.cache = blob;
      this.cachedForAccountId = accountId;
    } catch (err) {
      if (err instanceof KVError) {
        throw new AiRunTimesError({
          code: AI_RUN_TIMES_ERROR_CODES.PERSISTENCE_FAILED,
          message: 'Failed to write AI Run Times state to KV',
          cause: err,
          context: { reason },
          remediation:
            'Check the KV server (Settings -> Diagnostics). Recent edits were not saved.',
        });
      }
      throw err;
    }
    this.emitChange(blob, reason);
    getLoggingApi().event(AI_RUN_TIMES_EVENTS.CHANGED, { reason });
  }

  private emitChange(blob: AiRunTimesStorageBlob, reason: ChangeReason): void {
    for (const listener of Array.from(this.changeListeners)) {
      try {
        listener(blob, reason);
      } catch {
        // isolate throwing listeners
      }
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function defaultBlob(): AiRunTimesStorageBlob {
  return {
    schemaVersion: 1,
    feedSources: [
      {
        ...DEFAULT_FEED_SOURCE,
        addedAt: new Date(0).toISOString(),
        lastFetchedAt: null,
      },
    ],
    preferences: DEFAULT_PREFERENCES.map((p) => ({ ...p })),
    articles: [],
    readingLog: [],
  };
}

function normalizeBlob(v: Partial<AiRunTimesStorageBlob>): AiRunTimesStorageBlob {
  const base = defaultBlob();
  const out: AiRunTimesStorageBlob = {
    schemaVersion: 1,
    feedSources: Array.isArray(v.feedSources)
      ? v.feedSources.filter((f) => isValidFeedSource(f))
      : base.feedSources,
    preferences:
      Array.isArray(v.preferences) && v.preferences.length > 0
        ? mergePreferences(v.preferences as Preference[])
        : base.preferences,
    articles: Array.isArray(v.articles)
      ? (v.articles as Article[]).filter((a) => typeof a.id === 'string' && a.id.length > 0)
      : [],
    readingLog: Array.isArray(v.readingLog) ? (v.readingLog as ReadingLogEntry[]) : [],
  };
  // Always ensure the default feed exists (so a wiped feedSources array still has uxmag).
  if (!out.feedSources.some((f) => f.id === DEFAULT_FEED_SOURCE.id)) {
    out.feedSources.unshift({
      ...DEFAULT_FEED_SOURCE,
      addedAt: new Date(0).toISOString(),
      lastFetchedAt: null,
    });
  }
  return out;
}

function isValidFeedSource(f: unknown): f is FeedSource {
  return (
    typeof f === 'object' &&
    f !== null &&
    typeof (f as FeedSource).id === 'string' &&
    typeof (f as FeedSource).url === 'string' &&
    typeof (f as FeedSource).label === 'string'
  );
}

function mergePreferences(saved: Preference[]): Preference[] {
  const savedById = new Map<string, Preference>();
  for (const p of saved) savedById.set(p.id, p);
  return DEFAULT_PREFERENCES.map((d) => {
    const s = savedById.get(d.id);
    return { ...d, enabled: s?.enabled ?? true };
  });
}

function byPublishedAtDesc(a: Article, b: Article): number {
  if (a.publishedAt === null && b.publishedAt === null) return 0;
  if (a.publishedAt === null) return 1;
  if (b.publishedAt === null) return -1;
  return b.publishedAt.localeCompare(a.publishedAt);
}

function isValidHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function notFound(op: string, id: string): AiRunTimesError {
  return new AiRunTimesError({
    code: AI_RUN_TIMES_ERROR_CODES.NOT_FOUND,
    message: `${op}: id not found: ${id}`,
    context: { op, id },
    remediation: 'Refresh the feed -- the article or feed may have been pruned.',
  });
}

function badInput(op: string, msg: string): AiRunTimesError {
  return new AiRunTimesError({
    code: AI_RUN_TIMES_ERROR_CODES.BAD_INPUT,
    message: `${op}: ${msg}`,
    context: { op },
  });
}

// Touch ART_RT errors to satisfy noUnusedLocals when only a subset is used.
type _ArtCodeUnused = AiRunTimesErrorCode;
void (null as unknown as _ArtCodeUnused);
