/**
 * AI Run Times -- Flipboard-style article reader types.
 *
 * Mirrors the full app's `Flipboard-IDW-Feed/uxmag-script.js` data
 * shapes (RSS-parsed `Article`, persisted reading log, content
 * preferences, feed source list) but reshaped for Lite's typed
 * persistence + event surface.
 *
 * Public types are re-exported from `api.ts`.
 */

/** Discriminator for content topics. Matches the full app's 7 categories. */
export const PREFERENCE_IDS = [
  'conv-design',
  'ai-analytics',
  'enterprise-ai',
  'implementation',
  'ai-trends',
  'llm-tech',
  'platform-updates',
] as const;
export type PreferenceId = (typeof PREFERENCE_IDS)[number];

/** A content preference the user can opt in / out of. */
export interface Preference {
  id: PreferenceId;
  label: string;
  description: string;
  enabled: boolean;
}

/** A single RSS feed source. v1 ships with one default; user can add more. */
export interface FeedSource {
  id: string;
  /** Display name in Settings -> AI Run Times. */
  label: string;
  /** Origin / RSS URL. Must be http(s). */
  url: string;
  /** Whether the feed is active. Disabled feeds aren't fetched. */
  enabled: boolean;
  /** When the user added this source. */
  addedAt: string;
  /** When the source was last successfully fetched. null if never. */
  lastFetchedAt: string | null;
}

/** Article tile + reader content. Persisted in the cache and sent to renderer. */
export interface Article {
  /** Stable id derived from `link` (sha256 first 16 chars). */
  id: string;
  /** Source feed id. */
  feedId: string;
  /** Headline. */
  title: string;
  /** Canonical article URL. */
  link: string;
  /** RSS description (HTML). May be empty. */
  description: string;
  /** Optional thumbnail / cover URL. */
  thumbnailUrl: string | null;
  /** Author name, when present in the feed. */
  author: string | null;
  /** RSS pubDate normalized to ISO8601. null if absent / unparseable. */
  publishedAt: string | null;
  /** Categories from the RSS `<category>` tags. */
  categories: string[];
  /** Cached full HTML content (when fetched). null until first article view. */
  contentHtml: string | null;
  /** When the content was fetched. null until first article view. */
  contentFetchedAt: string | null;
  /** Word count of the content (for reading time). 0 until fetched. */
  wordCount: number;
  /** Reading time in minutes (200 wpm). 0 until fetched. */
  readingTimeMinutes: number;
}

/** A single reading log entry (article opened / finished). */
export interface ReadingLogEntry {
  /** Article id. */
  articleId: string;
  /** Article title at the time of read (denormalized so log survives feed pruning). */
  title: string;
  /** Article link at the time of read. */
  link: string;
  /** When the user opened the article. ISO8601. */
  openedAt: string;
  /** When the user finished (closed the reader / TTS finished). null if still open. */
  finishedAt: string | null;
  /** Word count at the time of read. */
  wordCount: number;
  /** Whether TTS played to completion. */
  listenedToCompletion: boolean;
}

/** The aggregate KV blob persisted under `lite-ai-run-times` / `default`. */
export interface AiRunTimesStorageBlob {
  schemaVersion: 1;
  feedSources: FeedSource[];
  preferences: Preference[];
  /** Cached articles, keyed by id. */
  articles: Article[];
  /** Reading log entries, newest first. */
  readingLog: ReadingLogEntry[];
}

/** Reading time calculation rate -- 200 wpm matches the full app. */
export const READING_TIME_WPM = 200 as const;

/** How many articles to retain in the cache before pruning oldest. */
export const ARTICLE_CACHE_MAX = 200 as const;

/** How many reading log entries to retain. */
export const READING_LOG_MAX = 1000 as const;

/** Default feed source -- UX Magazine, OneReach's article home. */
export const DEFAULT_FEED_SOURCE: Omit<FeedSource, 'addedAt' | 'lastFetchedAt'> = {
  id: 'uxmag',
  label: 'UX Magazine',
  url: 'https://uxmag.com/feed/',
  enabled: true,
};

/** Default preference set, all enabled (mirrors full app's "select-all-as-default"). */
export const DEFAULT_PREFERENCES: Readonly<Preference[]> = Object.freeze([
  {
    id: 'conv-design',
    label: 'Conversational Design',
    description: 'Best practices for designing conversational AI experiences',
    enabled: true,
  },
  {
    id: 'ai-analytics',
    label: 'AI Analytics',
    description: 'Insights and analytics for AI performance',
    enabled: true,
  },
  {
    id: 'enterprise-ai',
    label: 'Enterprise AI',
    description: 'AI solutions for enterprise environments',
    enabled: true,
  },
  {
    id: 'implementation',
    label: 'Implementation Guides',
    description: 'Step-by-step implementation tutorials',
    enabled: true,
  },
  {
    id: 'ai-trends',
    label: 'AI Trends',
    description: 'Latest trends in artificial intelligence',
    enabled: true,
  },
  {
    id: 'llm-tech',
    label: 'LLM Technology',
    description: 'Large Language Model developments',
    enabled: true,
  },
  {
    id: 'platform-updates',
    label: 'Platform Updates',
    description: 'OneReach.ai platform updates and features',
    enabled: true,
  },
]);

/** Sentinel constant -- ensures the file has a value-level export. */
export const AI_RUN_TIMES_MODULE_VERSION = 1 as const;
