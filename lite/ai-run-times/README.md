# lite/ai-run-times -- Flipboard-style article reader

Public surface: `getAiRunTimesApi()` from `./api.ts`. Renderer
surface: `window.lite.aiRunTimes`.

This module ports the full app's
`Flipboard-IDW-Feed/uxmag.html` -- a polished article reader with
RSS fetching, in-app reading, content preferences, and reading log
export.

> **TTS pulled.** The "Listen" feature, audio playlist, queue, and
> the `lite/ai/` service that powered them were removed in the
> first-run UX hardening pass. The OpenAI key dependency wasn't
> earning its keep for a single feature. Bringing TTS back is a
> separate chunk -- it would re-introduce `lite/ai/`, the Settings
> -> AI section, the Listen UI, and the `cachedTts` IPC.

The Agentic University menu's "AI Run Times" item routes here
(replaces the v1 placeholder that opened `uxmag.com` in the
generic Learning Browser). The dedicated reader window
(`ai-run-times.html`) carries the polished UX.

## Features

- **RSS fetcher** (main process, `net.fetch`-style): up to 5
  redirects, 15s timeout, decodes named + numeric HTML entities,
  parses RSS 2.0 + WordPress `content:encoded`, extracts
  `media:thumbnail` / `<enclosure>` / first `<img>` for tile cover.
- **Article extractor** (main process): Readability-style
  heuristic -- `<article>` -> `<main>` -> known content classes
  (`.entry-content`, `.post-content`, `.article-body`,
  `.content-body`, `.td-post-content`) -> largest `<div>` by
  inner-text length. Strips `<script>`, `<style>`, `<noscript>`,
  `<iframe>`, `<nav>`, `<aside>`, `<form>`, `<header>`,
  `<footer>`, `<svg>`, and inline event handlers. 200wpm reading
  time calculation.
- **Tile grid** with images, source domain pill, reading time
  pill, "New" / "Read" badges (auto-derived from publish date and
  reading log).
- **Article overlay reader**: Lite-styled modal with reading-time
  badge, source pill, and Open Original button.
  Auto-records article-opened in the reading log.
- **Content preferences**: 7 categories (matches full app's
  `contentPreferences`). Saved in KV; the tile grid filters by
  category overlap.
- **Feed sources**: ships with `uxmag.com/feed/` enabled.
  `addFeedSource(label, url)` lets users add more in
  `Settings -> AI Run Times` (future Settings section).
  `removeFeedSource(id)` deletes the source AND its cached
  articles. `toggleFeedSource(id, enabled)` flips the active flag.
- **Reading log**: per-article entry with `openedAt`,
  `finishedAt`, `wordCount`, `listenedToCompletion`. Capped at
  1000 entries (oldest pruned). `exportReadingLog()` returns the
  full log as a JSON string for download.
- **Article cache**: capped at 200 entries (oldest pruned by
  publishedAt). Re-upserts preserve cached `contentHtml` /
  `wordCount` / `readingTimeMinutes`.
- *(TTS playlist removed -- see banner at the top.)*

## Usage

### Main process

```typescript
import { getAiRunTimesApi } from '../ai-run-times/api.js';

const api = getAiRunTimesApi();
const sources = await api.listFeedSources();
const result = await api.refreshFeed();
// result.fetchedCount / result.newArticles / result.perFeed[]

const articles = await api.listArticles();
const article = await api.fetchArticleBody(articles[0].id);
// article.contentHtml + wordCount + readingTimeMinutes populated
```

### Renderer (via preload bridge)

```typescript
const articles = await window.lite!.aiRunTimes!.listArticles();
const refreshed = await window.lite!.aiRunTimes!.refreshFeed();
const article = await window.lite!.aiRunTimes!.fetchArticleBody(articles[0].id);
const json = await window.lite!.aiRunTimes!.exportReadingLog();
```

## Public API surface

| Method | Purpose | Bridged |
|---|---|---|
| `listArticles()` | All cached articles, newest first | Yes |
| `getArticle(id)` | Single article | Yes |
| `refreshFeed()` | Fetch enabled sources, parse, merge cache | Yes |
| `fetchArticleBody(id)` | Lazy-fetch article HTML + reading time | Yes |
| `listPreferences()` / `savePreferences(ids)` | 7 content categories | Yes |
| `listFeedSources()` / `addFeedSource()` / `removeFeedSource()` / `toggleFeedSource()` | Feed source CRUD | Yes |
| `listReadingLog()` / `recordRead()` / `clearReadingLog()` / `exportReadingLog()` | Reading log + JSON export | Yes |
| `onEvent(handler)` | Subscribe to typed events (ADR-032) | No (main only) |

(IPC also exposes `lite:ai-run-times:open-window` to open the
reader window from outside, e.g. from the Agentic University menu.)

## Error catalog

All errors extend `AiRunTimesError` (which extends `LiteError`).

| Code | When | Remediation |
|---|---|---|
| `ART_FEED_FETCH_FAILED` | RSS HTTP error / timeout / network / too many redirects | Check feed URL in Settings; verify network |
| `ART_ARTICLE_FETCH_FAILED` | Article HTML fetch failed | Open the original in your browser to verify reachability |
| `ART_BAD_INPUT` | Empty url / label, invalid http URL, unknown preference id, duplicate feed url | Validate input |
| `ART_NOT_FOUND` | `removeFeedSource(id)` / `toggleFeedSource(id, ...)` / `setArticleContent(id, ...)` for an unknown id | Refresh the feed |
| `ART_PERSISTENCE_FAILED` | KV write rejected | Check KV server (Settings -> Diagnostics); restart usually recovers |

## Events (ADR-032)

Subscribe via `getAiRunTimesApi().onEvent(handler)`.

Names (full catalog in `./events.ts`):

- Spans: `ai-run-times.refresh-feed.{start,finish,fail}`,
  `ai-run-times.fetch-article.{start,finish,fail}`
- Activity: `window.opened`, `article.opened`, `article.finished`,
  `preferences.saved`, `feed-source.added/removed/toggled`,
  `reading-log.exported/cleared`, `changed`
- IPC entries (per ADR-030): `ipc.{list-articles, refresh-feed,
  get-article, fetch-article-body, list-preferences,
  save-preferences, list-reading-log, record-read,
  clear-reading-log, export-reading-log, list-feed-sources,
  add-feed-source, remove-feed-source, toggle-feed-source,
  open-window}`

The `record-read` IPC handler emits `article.opened` (when
`finishedAt` is null) or `article.finished` (when `finishedAt` is
set, with a best-effort `durationMs` derived from `openedAt` ->
`finishedAt`). Per-feed refresh failures emit
`getLoggingApi().warn('ai-run-times', 'feed fetch failed', ...)`
so an individual broken feed inside an otherwise-OK refresh is
still observable in the central log.

## Persistence

KV collection: `lite-ai-run-times`, key: `default`. Single blob:

```typescript
{
  schemaVersion: 1,
  feedSources: FeedSource[],   // always contains the default uxmag feed
  preferences: Preference[],   // always 7, with `enabled` flags
  articles: Article[],         // capped at 200, sorted publishedAt desc
  readingLog: ReadingLogEntry[], // capped at 1000, newest first
}
```

Writes are atomic via `lite/kv/api.ts`. No second JSON file (vs
full app's drift-prone dual-store pattern).

## Window security

The reader window uses the standard Lite preload (so the renderer
can call `window.lite.aiRunTimes.*` and `window.lite.ai.tts(...)`).
`sandbox: false` is required for `fetch()` and the `Audio` API in
the renderer. CSP enforces:
- `script-src 'self'` (no inline scripts -- the renderer is a
  bundled `ai-run-times.js`)
- `connect-src 'self'` (no XHR / fetch from the renderer; all
  HTTP goes through main-process `lite:ai-run-times:*` IPC)
- `media-src 'self' data: blob:` (so generated audio Blobs play)

External article links open via `<a target="_blank">`, which
Electron routes through its default external-link handler (OS
browser).

## Hardening roadmap

| Phase | Trigger | Change |
|---|---|---|
| **R0** -- this PR | -- | RSS only; hardcoded WordPress shape; OpenAI TTS only |
| **R1** | Feed sources need to live with the org | Pull `FeedSource[]` from OAGI (`Feed` node type); user-added feeds still in KV |
| **R2** | Per-article TTS quality preference | Allow per-article voice override (`recordRead({voice})`) |
| **R3** | Atom / JSON Feed support | Add `parseAtomFeed` / `parseJsonFeed`; `fetchAndParseFeed` dispatches by `Content-Type` |
| **R4** | Reading position memory | Persist `scrollPosition` in `ReadingLogEntry`, restore on next open |
| **R5** | Cross-device reading log sync | Move reading log into OAGI (`ReadingEvent` node type) |
| **R6** | Audio Script generation (full app feature) | `getAiApi().chat()` to summarize / restructure article into a podcast-style script before TTS |

## File layout

```
lite/ai-run-times/
  README.md             (this file)
  api.ts                PUBLIC -- AiRunTimesApi, AiRunTimesError, AI_RUN_TIMES_ERROR_CODES, types
  fetcher.ts            INTERNAL -- RSS + article HTML fetching + parsing
  store.ts              INTERNAL -- KV-backed persistence
  errors.ts             INTERNAL -- AiRunTimesError + codes
  events.ts             INTERNAL -- AI_RUN_TIMES_EVENTS + AiRunTimesEvent union
  types.ts              INTERNAL -- Article, FeedSource, Preference, ReadingLogEntry, AiRunTimesStorageBlob, defaults
  main.ts               INTERNAL -- initAiRunTimes() registers IPC + window factory
  window.ts             INTERNAL -- BrowserWindow factory (single-instance reader)
  feed.html             INTERNAL (renderer) -- copied to ai-run-times.html
  feed.css              INTERNAL (renderer) -- copied to ai-run-times.css
  feed-renderer.ts      INTERNAL (renderer) -- bundled to ai-run-times.js
```

Per Rule 11, **only `api.ts` is importable from other modules.**

## Tests

- `lite/test/unit/ai-run-times-api.test.ts` -- conformance + behavior
- `lite/test/unit/ai-run-times-store.test.ts` -- KV persistence,
  dedupe, pruning, multi-listener `onChange` isolation
- `lite/test/unit/ai-run-times-fetcher.test.ts` -- RSS parsing
  (CDATA, entities, missing fields, redirects, status code mapping),
  `extractArticleContent` heuristic, `countWords`,
  `stableArticleId`
- `lite/test/integration/typed-onevent.test.ts` -- typed narrowing
- `lite/test/integration/event-coverage.test.ts` -- IPC + activity
  events

## Borrowed patterns (studied, not imported)

- `Flipboard-IDW-Feed/uxmag-script.js` (full app, ~3500 LOC) --
  `FlipboardReader` class shape: tile grid + article viewer +
  playlist bar + content preferences. Lite ports the structure
  but rewrites in TS-strict modules + bundled renderer.
  Deliberately NOT ported: Twitter embeds, Font Awesome icons (we
  use unicode + inline SVG), the Service Worker
  (`Flipboard-IDW-Feed/sw.js` -- not needed in Electron), the
  download-readingLogs-from-disk hack (replaced with
  `URL.createObjectURL` + anchor-click in the renderer).
- `Flipboard-IDW-Feed/main.js` -- main-process RSS fetch with
  redirect handling, `net.request` shape. Lite uses `fetch()`
  directly (Electron 22+) with `AbortSignal` for timeouts.
- `Flipboard-IDW-Feed/preload.js` -- `flipboardAPI` bridge
  surface. Lite collapses into the standard `window.lite.*`
  pattern via `preload-lite.ts`.
- `lite/neon/credentials.ts` -- the `CredentialsProvider` pattern
  for the AI service's API key.
- `lite/idw/store.ts` -- KV blob shape, dedupe-by-id, listener
  isolation in `emitChange`.
- `lite/idw/catalog.css` + `lite/university/tutorials.css` --
  visual language: dark background, hover-lift cards, accent
  variables, toast layout, skeleton shimmer.
