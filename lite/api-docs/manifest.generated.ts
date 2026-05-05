// THIS FILE IS GENERATED. Do not edit by hand.
// Source: lite/api-docs/manifest-builder.mjs
// Run: npm run lite:build:api-docs-manifest
// Per ADR-035, this manifest backs the in-app API Reference window.

import type { Manifest } from './types.js';

export const MANIFEST: Manifest = {
  "modules": [
    {
      "slug": "ai",
      "title": "Ai",
      "summary": "Lite AI service module -- PUBLIC API.\n\nThe only file other lite modules should import from in this\nmodule. Per ADR-019 / Rule 11, cross-module imports go through\n`<module>/api.ts` -- never reach into `client.ts`,\n`credentials.ts`, or any other internal file.\n\nv1 surface: TTS + chat completion via OpenAI. The provider is\nabstracted via `CredentialsProvider` (mirrors ADR-033's Neon\npattern) so a future provider (Anthropic, gemini, local) plugs\nin behind the same `AiApi` surface without consumer changes.\n\nTests: `_setAiApiForTesting(stub)` to inject a custom\nimplementation, `_resetAiApiForTesting()` to clear the singleton.",
      "surface": {
        "interfaceName": "AiApi",
        "interfaceDescription": "The public surface of the Lite AI module.\n\n**Error contract**: every method throws `AiError` (extends\n`LiteError`) on failure. Inspect `.code` to branch on\n`AI_NOT_CONFIGURED`, `AI_RATE_LIMITED`, `AI_HTTP`, `AI_NETWORK`,\n`AI_TIMEOUT`, `AI_BAD_INPUT`. `status()` does not throw -- it\nreturns the public configuration snapshot.",
        "methods": [
          {
            "name": "tts",
            "signature": "tts(req: TtsRequest): Promise<TtsResponse>",
            "description": "Generate speech from text. Returns raw audio bytes + MIME.",
            "tags": [],
            "examples": []
          },
          {
            "name": "chat",
            "signature": "chat(req: ChatRequest): Promise<ChatResponse>",
            "description": "Single-shot chat completion.",
            "tags": [],
            "examples": []
          },
          {
            "name": "status",
            "signature": "status(): Promise<AiStatus>",
            "description": "Public status snapshot. NEVER includes the API key.",
            "tags": [],
            "examples": []
          },
          {
            "name": "configure",
            "signature": "configure(config: AiConfig): Promise<void>",
            "description": "Persist a partial config update. Pass `apiKey: ''` to clear it.\nMAIN-PROCESS ONLY (renderer must use the Settings -> AI bridge).",
            "tags": [],
            "examples": []
          },
          {
            "name": "onEvent",
            "signature": "onEvent(handler: (event: AiEvent) => void): () => void;",
            "description": "Subscribe to typed AI events (ADR-032). Returns an unsubscribe.",
            "tags": [],
            "examples": []
          }
        ]
      },
      "events": {
        "constantName": "AI_EVENTS",
        "count": 13,
        "entries": [
          {
            "constantKey": "TTS_START",
            "name": "ai.tts.start",
            "description": ""
          },
          {
            "constantKey": "TTS_FINISH",
            "name": "ai.tts.finish",
            "description": ""
          },
          {
            "constantKey": "TTS_FAIL",
            "name": "ai.tts.fail",
            "description": ""
          },
          {
            "constantKey": "CHAT_START",
            "name": "ai.chat.start",
            "description": ""
          },
          {
            "constantKey": "CHAT_FINISH",
            "name": "ai.chat.finish",
            "description": ""
          },
          {
            "constantKey": "CHAT_FAIL",
            "name": "ai.chat.fail",
            "description": ""
          },
          {
            "constantKey": "CONFIGURE_START",
            "name": "ai.configure.start",
            "description": ""
          },
          {
            "constantKey": "CONFIGURE_FINISH",
            "name": "ai.configure.finish",
            "description": ""
          },
          {
            "constantKey": "CONFIGURE_FAIL",
            "name": "ai.configure.fail",
            "description": ""
          },
          {
            "constantKey": "IPC_TTS",
            "name": "ai.ipc.tts",
            "description": ""
          },
          {
            "constantKey": "IPC_CHAT",
            "name": "ai.ipc.chat",
            "description": ""
          },
          {
            "constantKey": "IPC_STATUS",
            "name": "ai.ipc.status",
            "description": ""
          },
          {
            "constantKey": "IPC_CONFIGURE",
            "name": "ai.ipc.configure",
            "description": ""
          }
        ]
      },
      "readme": "# lite/ai -- Lite AI service (OpenAI v1)\n\nPublic surface: `getAiApi()` from `./api.ts`. Renderer surface:\n`window.lite.ai`.\n\nThis module is the centralized AI endpoint for Lite -- mirrors the\nfull app's `lib/ai-service.js` philosophy (\"never make direct\nfetch/https.request calls to OpenAI / Anthropic from feature\nmodules\"). v1 supports OpenAI only with a BYO-key model: the user\nprovides their own OpenAI API key in `Settings -> AI`, the key\npersists in KV, and every call adds an `Authorization: Bearer`\nheader.\n\nThe first consumer is **AI Run Times** (TTS for article playback).\nFuture consumers (Spaces summarization, IDW chat presets, Voice\nOrb) plug in by calling `getAiApi().chat({...})` or `tts({...})`\nwithout each module reinventing OpenAI plumbing.\n\n## Usage\n\n### Main process\n\n```typescript\nimport { getAiApi } from '../ai/api.js';\n\nconst api = getAiApi();\nconst status = await api.status();\nif (!status.hasApiKey) {\n  // Open Settings -> AI to configure\n  return;\n}\n\nconst audio = await api.tts({\n  text: 'Hello world',\n  voice: 'nova',\n  format: 'mp3',\n  feature: 'my-feature',\n});\n// audio.audio is a Uint8Array, audio.mimeType is 'audio/mpeg'\n\nconst reply = await api.chat({\n  messages: [\n    { role: 'system', content: 'You are a brief assistant.' },\n    { role: 'user', content: 'Summarize OneReach Studio in one sentence.' },\n  ],\n  maxTokens: 100,\n  feature: 'my-feature',\n});\n// reply.content is the model's text\n```\n\n### Renderer (via preload bridge)\n\n```typescript\nconst status = await window.lite!.ai!.status();\n\nconst audio = await window.lite!.ai!.tts({\n  text: 'Hello world',\n  voice: 'nova',\n});\n// audio.audioBase64 is a base64-encoded string -- decode + play\n\nconst reply = await window.lite!.ai!.chat({\n  messages: [{ role: 'user', content: 'Hi' }],\n  maxTokens: 50,\n});\n```\n\n## Public API surface\n\n| Method | Purpose | Bridged to renderer |\n|---|---|---|\n| `tts(req)` | Text-to-speech via OpenAI `/v1/audio/speech` | Yes (audio as base64) |\n| `chat(req)` | Chat completion via `/v1/chat/completions` | Yes |\n| `status()` | Public configuration snapshot (no API key) | Yes |\n| `configure(config)` | Persist API key + voice / model defaults | Yes |\n| `onEvent(handler)` | Subscribe to typed `AiEvent`s (ADR-032) | No (main only) |\n\n## Error catalog\n\nAll errors extend `AiError` (which extends `LiteError`).\n\n| Code | When | Remediation |\n|---|---|---|\n| `AI_NOT_CONFIGURED` | `tts()` / `chat()` called before an API key is saved | Open Settings -> AI and paste an OpenAI API key |\n| `AI_RATE_LIMITED` | OpenAI returned 429 | Wait + retry (OpenAI rate-limits per organization) |\n| `AI_HTTP` | OpenAI returned a non-2xx, non-429 status (401, 500, etc.) | 401 -> check API key in Settings; otherwise see OpenAI status page |\n| `AI_NETWORK` | DNS / TCP / TLS failure | Check network connection |\n| `AI_TIMEOUT` | Request exceeded 60s | Retry; check OpenAI status |\n| `AI_BAD_INPUT` | Empty text, empty messages, text > 4096 chars | Validate input before calling |\n\n## Events (ADR-032)\n\nSubscribe via `getAiApi().onEvent(handler)`.\n\nNames (full catalog in `./events.ts`):\n\n- Spans: `ai.tts.{start,finish,fail}`, `ai.chat.{start,finish,fail}`,\n  `ai.configure.{start,finish,fail}`\n- IPC entries (per ADR-030): `ai.ipc.tts`, `ai.ipc.chat`,\n  `ai.ipc.status`, `ai.ipc.configure`\n\n## Security posture\n\n- **API key persistence**: KV today (`lite-ai-config / default`).\n  `status()` returns `hasApiKey: boolean`, never the value itself.\n  The Settings form starts empty even when one is saved (paste-only\n  to overwrite; type `clear` to delete).\n- **Logging**: API key NEVER logged. Token / completion counts +\n  HTTP status codes log; raw text input / output does NOT log.\n- **Network**: direct to `api.openai.com` -- no proxy, no\n  intermediary. The user's key, prompt text, and audio audio\n  responses transit only between Lite and OpenAI.\n- **Cost containment**: every call carries an optional `feature`\n  label so future cost-tracking layers can attribute spend.\n\n## Hardening roadmap\n\n| Phase | Trigger | Change |\n|---|---|---|\n| **A0** -- this PR | -- | OpenAI only; API key in KV; BYO-key |\n| **A1** | Pilot expands beyond developers | Move API key to OS keychain via `keytar` (mirrors `lite/totp/store.ts`); `CredentialsProvider` interface unchanged |\n| **A2** | Need org-managed keys | Add `BearerCredentialsProvider` that fetches from OneReach backend; `client.ts` switch case adds new variant; call sites unchanged |\n| **A3** | Need provider parity | Add `lite/ai/providers/anthropic.ts`, `gemini.ts`; `AiApi` grows `profile` parameter (mirrors full app's `ai-service.js` profile system) |\n| **A4** | Cost tracking | Wire `feature` label into a `lite/budget/` module |\n\n## File layout\n\n```\nlite/ai/\n  README.md           (this file)\n  api.ts              PUBLIC -- AiApi singleton, AiError, AI_ERROR_CODES, types\n  client.ts           INTERNAL -- OpenAI HTTP client (fetch + AbortSignal)\n  credentials.ts      INTERNAL -- KVAiCredentialsProvider, StaticAiCredentialsProvider\n  errors.ts           INTERNAL -- AiError + AI_ERROR_CODES\n  events.ts           INTERNAL -- AI_EVENTS + AiEvent union + isAiEvent\n  main.ts             INTERNAL -- initAi() registers IPC handlers\n  types.ts            INTERNAL -- TtsRequest/Response, ChatRequest/Response, AiConfig, AiStatus\n```\n\nPer Rule 11, **only `api.ts` is importable from other modules.**\n\n## Tests\n\n- `lite/test/unit/ai-api.test.ts` -- conformance + behavior\n- `lite/test/unit/ai-client.test.ts` -- HTTP request shape, status\n  code -> error code mapping, abort -> timeout, fetch throw -> network\n- `lite/test/integration/typed-onevent.test.ts` -- typed narrowing\n- `lite/test/integration/event-coverage.test.ts` -- IPC + span events\n\n## Borrowed patterns (studied, not imported)\n\n- `lib/ai-service.js` (full app) -- centralized AI endpoint\n  philosophy + `chat({profile, system, messages, maxTokens,\n  temperature, jsonMode, feature})` shape. Lite simplifies: no\n  profile system in v1 (single OpenAI provider), no jsonMode (not\n  needed for current consumers), no centralized cost tracking\n  (deferred to A4).\n- `lib/ai-providers/openai-adapter.js` -- OpenAI request body shape\n  (`response_format` for TTS; `model / messages / max_tokens` for\n  chat).\n- `lite/neon/credentials.ts` -- `CredentialsProvider` abstraction\n  for forward-security swaps without changing call sites\n  (ADR-033).\n- `lite/totp/store.ts` -- the keychain-backed pattern that A1 will\n  adopt for the API key.\n"
    },
    {
      "slug": "ai-run-times",
      "title": "Ai Run Times",
      "summary": "AI Run Times module -- PUBLIC API.\n\nThe only file other lite modules should import from in this\nmodule. Per ADR-019 / Rule 11, cross-module imports go through\n`<module>/api.ts` -- never reach into `store.ts`, `fetcher.ts`,\nor any other internal file.\n\nAI Run Times is the polished Flipboard-style article reader: it\nfetches RSS feeds, displays tiles, lets users read articles in\nan overlay, supports content preferences, persists a reading\nlog (with JSON export), and (when an OpenAI key is configured)\ngenerates TTS audio with a queueable playlist.\n\nv1 ships with one default feed source (UX Magazine -- OneReach's\narticle home). Users can add / remove feed sources in\nSettings -> AI Run Times.\n\nTests: `_setAiRunTimesApiForTesting(stub)`, `_resetAiRunTimesApiForTesting()`.",
      "surface": {
        "interfaceName": "AiRunTimesApi",
        "interfaceDescription": "",
        "methods": [
          {
            "name": "listArticles",
            "signature": "listArticles(): Promise<Article[]>",
            "description": "All cached articles, newest first.",
            "tags": [],
            "examples": []
          },
          {
            "name": "getArticle",
            "signature": "getArticle(id: string): Promise<Article | null>",
            "description": "Single article by id, or null if absent.",
            "tags": [],
            "examples": []
          },
          {
            "name": "refreshFeed",
            "signature": "refreshFeed(): Promise<RefreshFeedResult>",
            "description": "Fetch enabled feed sources, parse each, and merge results into\nthe cache. Always succeeds when ANY feed succeeds; returns\nper-feed status. Throws only if persistence fails.",
            "tags": [],
            "examples": []
          },
          {
            "name": "fetchArticleBody",
            "signature": "fetchArticleBody(id: string): Promise<Article>",
            "description": "Fetch the full HTML of a single article and persist it. Returns\nthe updated Article with `contentHtml`, `wordCount`, and\n`readingTimeMinutes` populated.",
            "tags": [],
            "examples": []
          },
          {
            "name": "listPreferences",
            "signature": "listPreferences(): Promise<Preference[]>",
            "description": "Content preferences (7 categories, with `enabled` per id).",
            "tags": [],
            "examples": []
          },
          {
            "name": "savePreferences",
            "signature": "savePreferences(enabledIds: PreferenceId[]): Promise<Preference[]>",
            "description": "Persist enabled preference set. Returns the updated list.",
            "tags": [],
            "examples": []
          },
          {
            "name": "listFeedSources",
            "signature": "listFeedSources(): Promise<FeedSource[]>",
            "description": "Feed sources. v1 ships with one default; user can add more.",
            "tags": [],
            "examples": []
          },
          {
            "name": "addFeedSource",
            "signature": "addFeedSource(input: { label: string; url: string }): Promise<FeedSource>",
            "description": "",
            "tags": [],
            "examples": []
          },
          {
            "name": "removeFeedSource",
            "signature": "removeFeedSource(id: string): Promise<{ ok: true }>",
            "description": "",
            "tags": [],
            "examples": []
          },
          {
            "name": "toggleFeedSource",
            "signature": "toggleFeedSource(id: string, enabled: boolean): Promise<FeedSource>",
            "description": "",
            "tags": [],
            "examples": []
          },
          {
            "name": "listReadingLog",
            "signature": "listReadingLog(): Promise<ReadingLogEntry[]>",
            "description": "Reading log -- newest first, capped at 1000.",
            "tags": [],
            "examples": []
          },
          {
            "name": "recordRead",
            "signature": "recordRead(entry: {\n    articleId: string;\n    title: string;\n    link: string;\n    wordCount: number;\n    finishedAt?: string | null;\n    listenedToCompletion?: boolean;\n  }): Promise<ReadingLogEntry>",
            "description": "",
            "tags": [],
            "examples": []
          },
          {
            "name": "clearReadingLog",
            "signature": "clearReadingLog(): Promise<{ ok: true }>",
            "description": "Clear the reading log. Idempotent.",
            "tags": [],
            "examples": []
          },
          {
            "name": "exportReadingLog",
            "signature": "exportReadingLog(): Promise<string>",
            "description": "Export the reading log as JSON (string).",
            "tags": [],
            "examples": []
          },
          {
            "name": "onEvent",
            "signature": "onEvent(handler: (event: AiRunTimesEvent) => void): () => void;",
            "description": "Subscribe to typed AI Run Times events.",
            "tags": [],
            "examples": []
          }
        ]
      },
      "events": {
        "constantName": "AI_RUN_TIMES_EVENTS",
        "count": 31,
        "entries": [
          {
            "constantKey": "REFRESH_FEED_START",
            "name": "ai-run-times.refresh-feed.start",
            "description": ""
          },
          {
            "constantKey": "REFRESH_FEED_FINISH",
            "name": "ai-run-times.refresh-feed.finish",
            "description": ""
          },
          {
            "constantKey": "REFRESH_FEED_FAIL",
            "name": "ai-run-times.refresh-feed.fail",
            "description": ""
          },
          {
            "constantKey": "FETCH_ARTICLE_START",
            "name": "ai-run-times.fetch-article.start",
            "description": ""
          },
          {
            "constantKey": "FETCH_ARTICLE_FINISH",
            "name": "ai-run-times.fetch-article.finish",
            "description": ""
          },
          {
            "constantKey": "FETCH_ARTICLE_FAIL",
            "name": "ai-run-times.fetch-article.fail",
            "description": ""
          },
          {
            "constantKey": "WINDOW_OPENED",
            "name": "ai-run-times.window.opened",
            "description": ""
          },
          {
            "constantKey": "ARTICLE_OPENED",
            "name": "ai-run-times.article.opened",
            "description": ""
          },
          {
            "constantKey": "ARTICLE_FINISHED",
            "name": "ai-run-times.article.finished",
            "description": ""
          },
          {
            "constantKey": "PREFERENCES_SAVED",
            "name": "ai-run-times.preferences.saved",
            "description": ""
          },
          {
            "constantKey": "FEED_SOURCE_ADDED",
            "name": "ai-run-times.feed-source.added",
            "description": ""
          },
          {
            "constantKey": "FEED_SOURCE_REMOVED",
            "name": "ai-run-times.feed-source.removed",
            "description": ""
          },
          {
            "constantKey": "FEED_SOURCE_TOGGLED",
            "name": "ai-run-times.feed-source.toggled",
            "description": ""
          },
          {
            "constantKey": "READING_LOG_EXPORTED",
            "name": "ai-run-times.reading-log.exported",
            "description": ""
          },
          {
            "constantKey": "READING_LOG_CLEARED",
            "name": "ai-run-times.reading-log.cleared",
            "description": ""
          },
          {
            "constantKey": "TTS_PLAYBACK_START",
            "name": "ai-run-times.tts.playback-start",
            "description": ""
          },
          {
            "constantKey": "TTS_PLAYBACK_FINISH",
            "name": "ai-run-times.tts.playback-finish",
            "description": ""
          },
          {
            "constantKey": "TTS_PLAYBACK_FAIL",
            "name": "ai-run-times.tts.playback-fail",
            "description": ""
          },
          {
            "constantKey": "CHANGED",
            "name": "ai-run-times.changed",
            "description": ""
          },
          {
            "constantKey": "IPC_LIST_ARTICLES",
            "name": "ai-run-times.ipc.list-articles",
            "description": ""
          },
          {
            "constantKey": "IPC_REFRESH_FEED",
            "name": "ai-run-times.ipc.refresh-feed",
            "description": ""
          },
          {
            "constantKey": "IPC_GET_ARTICLE",
            "name": "ai-run-times.ipc.get-article",
            "description": ""
          },
          {
            "constantKey": "IPC_LIST_PREFERENCES",
            "name": "ai-run-times.ipc.list-preferences",
            "description": ""
          },
          {
            "constantKey": "IPC_SAVE_PREFERENCES",
            "name": "ai-run-times.ipc.save-preferences",
            "description": ""
          },
          {
            "constantKey": "IPC_LIST_READING_LOG",
            "name": "ai-run-times.ipc.list-reading-log",
            "description": ""
          },
          {
            "constantKey": "IPC_RECORD_READ",
            "name": "ai-run-times.ipc.record-read",
            "description": ""
          },
          {
            "constantKey": "IPC_LIST_FEED_SOURCES",
            "name": "ai-run-times.ipc.list-feed-sources",
            "description": ""
          },
          {
            "constantKey": "IPC_ADD_FEED_SOURCE",
            "name": "ai-run-times.ipc.add-feed-source",
            "description": ""
          },
          {
            "constantKey": "IPC_REMOVE_FEED_SOURCE",
            "name": "ai-run-times.ipc.remove-feed-source",
            "description": ""
          },
          {
            "constantKey": "IPC_TOGGLE_FEED_SOURCE",
            "name": "ai-run-times.ipc.toggle-feed-source",
            "description": ""
          },
          {
            "constantKey": "IPC_OPEN_WINDOW",
            "name": "ai-run-times.ipc.open-window",
            "description": ""
          }
        ]
      },
      "readme": "# lite/ai-run-times -- Flipboard-style article reader with TTS\n\nPublic surface: `getAiRunTimesApi()` from `./api.ts`. Renderer\nsurface: `window.lite.aiRunTimes`.\n\nThis module ports the full app's\n`Flipboard-IDW-Feed/uxmag.html` -- a polished article reader with\nRSS fetching, in-app reading, content preferences, reading log\nexport, and (when an OpenAI key is configured in\n`Settings -> AI`) TTS audio playback with a queueable playlist.\n\nThe Agentic University menu's \"AI Run Times\" item routes here\n(replaces the v1 placeholder that opened `uxmag.com` in the\ngeneric Learning Browser). The dedicated reader window\n(`ai-run-times.html`) carries the polished UX.\n\n## Features\n\n- **RSS fetcher** (main process, `net.fetch`-style): up to 5\n  redirects, 15s timeout, decodes named + numeric HTML entities,\n  parses RSS 2.0 + WordPress `content:encoded`, extracts\n  `media:thumbnail` / `<enclosure>` / first `<img>` for tile cover.\n- **Article extractor** (main process): Readability-style\n  heuristic -- `<article>` -> `<main>` -> known content classes\n  (`.entry-content`, `.post-content`, `.article-body`,\n  `.content-body`, `.td-post-content`) -> largest `<div>` by\n  inner-text length. Strips `<script>`, `<style>`, `<noscript>`,\n  `<iframe>`, `<nav>`, `<aside>`, `<form>`, `<header>`,\n  `<footer>`, `<svg>`, and inline event handlers. 200wpm reading\n  time calculation.\n- **Tile grid** with images, source domain pill, reading time\n  pill, \"New\" / \"Read\" badges (auto-derived from publish date and\n  reading log).\n- **Article overlay reader**: Lite-styled modal with reading-time\n  badge, source pill, Listen button (TTS), Open Original button.\n  Auto-records article-opened in the reading log.\n- **Content preferences**: 7 categories (matches full app's\n  `contentPreferences`). Saved in KV; the tile grid filters by\n  category overlap.\n- **Feed sources**: ships with `uxmag.com/feed/` enabled.\n  `addFeedSource(label, url)` lets users add more in\n  `Settings -> AI Run Times` (future Settings section).\n  `removeFeedSource(id)` deletes the source AND its cached\n  articles. `toggleFeedSource(id, enabled)` flips the active flag.\n- **Reading log**: per-article entry with `openedAt`,\n  `finishedAt`, `wordCount`, `listenedToCompletion`. Capped at\n  1000 entries (oldest pruned). `exportReadingLog()` returns the\n  full log as a JSON string for download.\n- **Article cache**: capped at 200 entries (oldest pruned by\n  publishedAt). Re-upserts preserve cached `contentHtml` /\n  `wordCount` / `readingTimeMinutes`.\n- **TTS playlist** (when `lite/ai/` has an API key):\n  - Per-article \"Listen\" button adds to the queue.\n  - Long articles auto-chunk on sentence boundary at ~3500 chars.\n  - First chunk plays immediately; remaining chunks generate in\n    the background while playing (no upfront wait for huge\n    articles).\n  - Audio Blob URL revoked on cleanup (no memory leak across many\n    articles, fixing a known issue from the full app's\n    implementation).\n  - Queue auto-advances on chunk-end; finished article marks the\n    reading log entry as `listenedToCompletion: true`.\n  - Global play/pause/prev/next/seek bar at the top of the window.\n\n## Usage\n\n### Main process\n\n```typescript\nimport { getAiRunTimesApi } from '../ai-run-times/api.js';\n\nconst api = getAiRunTimesApi();\nconst sources = await api.listFeedSources();\nconst result = await api.refreshFeed();\n// result.fetchedCount / result.newArticles / result.perFeed[]\n\nconst articles = await api.listArticles();\nconst article = await api.fetchArticleBody(articles[0].id);\n// article.contentHtml + wordCount + readingTimeMinutes populated\n```\n\n### Renderer (via preload bridge)\n\n```typescript\nconst articles = await window.lite!.aiRunTimes!.listArticles();\nconst refreshed = await window.lite!.aiRunTimes!.refreshFeed();\nconst article = await window.lite!.aiRunTimes!.fetchArticleBody(articles[0].id);\nconst json = await window.lite!.aiRunTimes!.exportReadingLog();\n```\n\n## Public API surface\n\n| Method | Purpose | Bridged |\n|---|---|---|\n| `listArticles()` | All cached articles, newest first | Yes |\n| `getArticle(id)` | Single article | Yes |\n| `refreshFeed()` | Fetch enabled sources, parse, merge cache | Yes |\n| `fetchArticleBody(id)` | Lazy-fetch article HTML + reading time | Yes |\n| `listPreferences()` / `savePreferences(ids)` | 7 content categories | Yes |\n| `listFeedSources()` / `addFeedSource()` / `removeFeedSource()` / `toggleFeedSource()` | Feed source CRUD | Yes |\n| `listReadingLog()` / `recordRead()` / `clearReadingLog()` / `exportReadingLog()` | Reading log + JSON export | Yes |\n| `onEvent(handler)` | Subscribe to typed events (ADR-032) | No (main only) |\n\n(IPC also exposes `lite:ai-run-times:open-window` to open the\nreader window from outside, e.g. from the Agentic University menu.)\n\n## Error catalog\n\nAll errors extend `AiRunTimesError` (which extends `LiteError`).\n\n| Code | When | Remediation |\n|---|---|---|\n| `ART_FEED_FETCH_FAILED` | RSS HTTP error / timeout / network / too many redirects | Check feed URL in Settings; verify network |\n| `ART_ARTICLE_FETCH_FAILED` | Article HTML fetch failed | Open the original in your browser to verify reachability |\n| `ART_BAD_INPUT` | Empty url / label, invalid http URL, unknown preference id, duplicate feed url | Validate input |\n| `ART_NOT_FOUND` | `removeFeedSource(id)` / `toggleFeedSource(id, ...)` / `setArticleContent(id, ...)` for an unknown id | Refresh the feed |\n| `ART_PERSISTENCE_FAILED` | KV write rejected | Check KV server (Settings -> Diagnostics); restart usually recovers |\n\n## Events (ADR-032)\n\nSubscribe via `getAiRunTimesApi().onEvent(handler)`.\n\nNames (full catalog in `./events.ts`):\n\n- Spans: `ai-run-times.refresh-feed.{start,finish,fail}`,\n  `ai-run-times.fetch-article.{start,finish,fail}`\n- Activity: `window.opened`, `article.opened`, `article.finished`,\n  `preferences.saved`, `feed-source.added/removed/toggled`,\n  `reading-log.exported/cleared`,\n  `tts.playback-{start,finish,fail}`, `changed`\n- IPC entries (per ADR-030): `ipc.{list-articles, refresh-feed,\n  get-article, list-preferences, save-preferences,\n  list-reading-log, record-read, list-feed-sources,\n  add-feed-source, remove-feed-source, toggle-feed-source,\n  open-window}`\n\n## Persistence\n\nKV collection: `lite-ai-run-times`, key: `default`. Single blob:\n\n```typescript\n{\n  schemaVersion: 1,\n  feedSources: FeedSource[],   // always contains the default uxmag feed\n  preferences: Preference[],   // always 7, with `enabled` flags\n  articles: Article[],         // capped at 200, sorted publishedAt desc\n  readingLog: ReadingLogEntry[], // capped at 1000, newest first\n}\n```\n\nWrites are atomic via `lite/kv/api.ts`. No second JSON file (vs\nfull app's drift-prone dual-store pattern).\n\n## Window security\n\nThe reader window uses the standard Lite preload (so the renderer\ncan call `window.lite.aiRunTimes.*` and `window.lite.ai.tts(...)`).\n`sandbox: false` is required for `fetch()` and the `Audio` API in\nthe renderer. CSP enforces:\n- `script-src 'self'` (no inline scripts -- the renderer is a\n  bundled `ai-run-times.js`)\n- `connect-src 'self'` (no XHR / fetch from the renderer; all\n  HTTP goes through main-process `lite:ai-run-times:*` IPC)\n- `media-src 'self' data: blob:` (so generated audio Blobs play)\n\nExternal article links open via `<a target=\"_blank\">`, which\nElectron routes through its default external-link handler (OS\nbrowser).\n\n## Hardening roadmap\n\n| Phase | Trigger | Change |\n|---|---|---|\n| **R0** -- this PR | -- | RSS only; hardcoded WordPress shape; OpenAI TTS only |\n| **R1** | Feed sources need to live with the org | Pull `FeedSource[]` from OAGI (`Feed` node type); user-added feeds still in KV |\n| **R2** | Per-article TTS quality preference | Allow per-article voice override (`recordRead({voice})`) |\n| **R3** | Atom / JSON Feed support | Add `parseAtomFeed` / `parseJsonFeed`; `fetchAndParseFeed` dispatches by `Content-Type` |\n| **R4** | Reading position memory | Persist `scrollPosition` in `ReadingLogEntry`, restore on next open |\n| **R5** | Cross-device reading log sync | Move reading log into OAGI (`ReadingEvent` node type) |\n| **R6** | Audio Script generation (full app feature) | `getAiApi().chat()` to summarize / restructure article into a podcast-style script before TTS |\n\n## File layout\n\n```\nlite/ai-run-times/\n  README.md             (this file)\n  api.ts                PUBLIC -- AiRunTimesApi, AiRunTimesError, AI_RUN_TIMES_ERROR_CODES, types\n  fetcher.ts            INTERNAL -- RSS + article HTML fetching + parsing\n  store.ts              INTERNAL -- KV-backed persistence\n  errors.ts             INTERNAL -- AiRunTimesError + codes\n  events.ts             INTERNAL -- AI_RUN_TIMES_EVENTS + AiRunTimesEvent union\n  types.ts              INTERNAL -- Article, FeedSource, Preference, ReadingLogEntry, AiRunTimesStorageBlob, defaults\n  main.ts               INTERNAL -- initAiRunTimes() registers IPC + window factory\n  window.ts             INTERNAL -- BrowserWindow factory (single-instance reader)\n  feed.html             INTERNAL (renderer) -- copied to ai-run-times.html\n  feed.css              INTERNAL (renderer) -- copied to ai-run-times.css\n  feed-renderer.ts      INTERNAL (renderer) -- bundled to ai-run-times.js\n```\n\nPer Rule 11, **only `api.ts` is importable from other modules.**\n\n## Tests\n\n- `lite/test/unit/ai-run-times-api.test.ts` -- conformance + behavior\n- `lite/test/unit/ai-run-times-store.test.ts` -- KV persistence,\n  dedupe, pruning, multi-listener `onChange` isolation\n- `lite/test/unit/ai-run-times-fetcher.test.ts` -- RSS parsing\n  (CDATA, entities, missing fields, redirects, status code mapping),\n  `extractArticleContent` heuristic, `countWords`,\n  `stableArticleId`\n- `lite/test/integration/typed-onevent.test.ts` -- typed narrowing\n- `lite/test/integration/event-coverage.test.ts` -- IPC + activity\n  events\n\n## Borrowed patterns (studied, not imported)\n\n- `Flipboard-IDW-Feed/uxmag-script.js` (full app, ~3500 LOC) --\n  `FlipboardReader` class shape: tile grid + article viewer +\n  playlist bar + content preferences. Lite ports the structure\n  but rewrites in TS-strict modules + bundled renderer.\n  Deliberately NOT ported: Twitter embeds, Font Awesome icons (we\n  use unicode + inline SVG), the Service Worker\n  (`Flipboard-IDW-Feed/sw.js` -- not needed in Electron), the\n  download-readingLogs-from-disk hack (replaced with\n  `URL.createObjectURL` + anchor-click in the renderer).\n- `Flipboard-IDW-Feed/main.js` -- main-process RSS fetch with\n  redirect handling, `net.request` shape. Lite uses `fetch()`\n  directly (Electron 22+) with `AbortSignal` for timeouts.\n- `Flipboard-IDW-Feed/preload.js` -- `flipboardAPI` bridge\n  surface. Lite collapses into the standard `window.lite.*`\n  pattern via `preload-lite.ts`.\n- `lite/neon/credentials.ts` -- the `CredentialsProvider` pattern\n  for the AI service's API key.\n- `lite/idw/store.ts` -- KV blob shape, dedupe-by-id, listener\n  isolation in `emitChange`.\n- `lite/idw/catalog.css` + `lite/university/tutorials.css` --\n  visual language: dark background, hover-lift cards, accent\n  variables, toast layout, skeleton shimmer.\n"
    },
    {
      "slug": "auth",
      "title": "Auth",
      "summary": "Auth module -- PUBLIC API.\n\nThe only file other lite modules should import from in this module.\nPer ADR-019 / Rule 11 in `lite/LITE-RULES.md`, cross-module imports\ngo through `<module>/api.ts` -- never reach into `store.ts`,\n`window.ts`, `main.ts`, or any other internal file.\n\nPer ADR-026, v1 supports Edison only. The token captured by\n`signIn()` is held main-process only -- `getToken()` is intentionally\nNOT bridged to the renderer. Callers that need to make OneReach API\ncalls do so from main and inject the `Authorization` header themselves.\n\nUsage from another module (main process only):\n\n  import { getAuthApi } from '../auth/api.js';\n  const auth = getAuthApi();\n  await auth.signIn('edison');\n  const token = auth.getToken('edison'); // raw mult cookie value\n\nTests: `_setAuthApiForTesting(stub)` to inject a custom implementation,\n`_resetAuthApiForTesting()` to clear the singleton.",
      "surface": {
        "interfaceName": "AuthApi",
        "interfaceDescription": "The public surface of the auth module. All cross-module callers\nroute through this interface.\n\n**Error contract**: `signIn()` throws {@link AuthError} (extends\n`LiteError`) on failure. Inspect `.code` to branch:\n`AUTH_CANCELLED`, `AUTH_TIMEOUT`, `AUTH_KV_FAILED`,\n`AUTH_UNSUPPORTED_ENV`, `AUTH_INVALID_COOKIE`. `signOut()` and the\nread-only methods do not throw.\n\n**Token visibility**: `getToken()` is main-process only. The preload\nbridge (`window.lite.auth`) deliberately omits this method; future\nconsumer modules read the token from main and inject it into outgoing\nAPI requests themselves.\n\nSee `lite/auth/README.md` for the full error catalog and recipe-style\nusage examples.",
        "methods": [
          {
            "name": "signIn",
            "signature": "signIn(env: Environment, opts?: SignInOptions): Promise<AuthSession>",
            "description": "Open an Electron window pointing at GSX, capture the `mult` and\n`or` cookies once the user signs in and selects their account,\npersist the session to KV, close the window, and resolve.\n\nConcurrent calls for the same env coalesce on the first call's\npromise. Concurrent calls for different envs are independent.",
            "tags": [
              {
                "tag": "param",
                "value": "env Which OneReach environment to sign into. v1 supports\n  `edison` only -- other values reject with `AUTH_UNSUPPORTED_ENV`."
              },
              {
                "tag": "param",
                "value": "opts Optional per-call overrides (e.g. `timeoutMs`)."
              },
              {
                "tag": "returns",
                "value": "The captured {@link AuthSession}."
              },
              {
                "tag": "throws",
                "value": "{AuthError} `AUTH_CANCELLED` if the user closed the window\n  before both cookies were captured."
              },
              {
                "tag": "throws",
                "value": "{AuthError} `AUTH_TIMEOUT` if cookies didn't arrive within\n  the timeout (default 5 minutes)."
              },
              {
                "tag": "throws",
                "value": "{AuthError} `AUTH_KV_FAILED` if the cookies were captured\n  but persistence to KV rejected. Window closes either way."
              },
              {
                "tag": "throws",
                "value": "{AuthError} `AUTH_INVALID_COOKIE` if the captured `or`\n  cookie payload could not be decoded."
              },
              {
                "tag": "throws",
                "value": "{AuthError} `AUTH_UNSUPPORTED_ENV` for any env not in\n  {@link SUPPORTED_ENVIRONMENTS}."
              }
            ],
            "examples": [
              "try {\n  const session = await getAuthApi().signIn('edison');\n  console.log('signed in as', session.email, 'account', session.accountId);\n} catch (err) {\n  if (err instanceof AuthError) {\n    toast(err.formatForUser());\n  }\n}"
            ]
          },
          {
            "name": "signOut",
            "signature": "signOut(env: Environment): Promise<void>",
            "description": "Sign out of an environment. Removes the captured `mult` and `or`\ncookies from the partition AND deletes the persisted KV record.\nWithout removing the cookies, the next `signIn()` would silently\nre-use the cached session and never show a login form.\n\nSoft-fails: never throws. Cookie / KV cleanup failures are logged\nbut the in-memory session is always cleared.",
            "tags": [],
            "examples": []
          },
          {
            "name": "getSession",
            "signature": "getSession(env: Environment): AuthSession | null",
            "description": "Synchronously get the captured session for an env, or null if\nnone exists. Does NOT trigger a sign-in. Hydrates from KV lazily\nvia `hydrate()` -- callers that need cross-restart awareness\nshould `await` `hydrate()` first.",
            "tags": [],
            "examples": []
          },
          {
            "name": "getToken",
            "signature": "getToken(env: Environment): string | null",
            "description": "Synchronously get the raw `mult` cookie value for an env, or null\nif no session is captured. Use this in main-process code to\ninject `Authorization: Bearer <token>` headers when calling\nOneReach APIs.\n\nNote: as of the ADR-026 token-reveal amendment, `getTokenBundle`\nexposes both `mult` and `or` values (and is bridged to the\nrenderer for the Settings -> Account verification UI). Main-process\ncode that just needs the bearer token should still call\n`getToken(env)` -- it returns the same value as\n`getTokenBundle(env)?.multToken` and is the cheaper API.",
            "tags": [
              {
                "tag": "returns",
                "value": "The raw cookie value (typically a JWT or opaque token),\n  or null if there is no captured session for this env."
              }
            ],
            "examples": []
          },
          {
            "name": "getTokenBundle",
            "signature": "getTokenBundle(env: Environment): AuthTokenBundle | null",
            "description": "Synchronously get the captured token bundle (`mult` + `or`) for an\nenv, or null if no token is available. Per ADR-042, the bundle is\nrehydrated on boot from the persistent cookie jar of\n`persist:lite-auth-<env>` -- so it survives restarts as long as\nthe user signed in at least once before the cookie expired. After\na hard sign-out (which clears the partition), this returns null\nuntil a fresh sign-in completes.\n\nSurfaced for the Settings -> Account verification UI; returned\nvalues are bridged to renderers so users can confirm capture and\ncopy individual cookie values for manual debugging.",
            "tags": [
              {
                "tag": "returns",
                "value": "The captured token bundle, or null when no token is\n  available for this env."
              }
            ],
            "examples": []
          },
          {
            "name": "injectTokenIntoPartition",
            "signature": "injectTokenIntoPartition(\n    env: Environment,\n    partition: string\n  ): Promise<{ injected: boolean; reason?: string }>",
            "description": "Inject the captured `mult` cookie into a target tab partition's\nsession, scoped to the env's UI + API cookie domains. Per ADR-042,\nthis is what makes IDW agents recognize the user on the first\ntab open without showing the OneReach account picker.\n\nSoft-fail by design: returns `{ injected: false, reason: ... }`\nwhen no token is available, the env is unsupported, the cookie has\nexpired, or the underlying cookies.set call rejected. Callers\n(typically the main-window's tab attach flow) just log and proceed\nto navigate -- the agent will fall back to its own sign-in\npicker, which is the v1 baseline behaviour.\n\nMain-process callers only -- not bridged to the renderer.",
            "tags": [
              {
                "tag": "param",
                "value": "env Which OneReach environment's token to inject."
              },
              {
                "tag": "param",
                "value": "partition The destination tab partition string (e.g.\n  `persist:tab-<uuid>`)."
              },
              {
                "tag": "returns",
                "value": "Whether injection succeeded, plus a machine-readable\n  reason on failure."
              }
            ],
            "examples": []
          },
          {
            "name": "hasValidSession",
            "signature": "hasValidSession(env: Environment): boolean",
            "description": "True if there is a captured session for the env AND its\n`expiresAt` (if known) is in the future. Use this in callers that\nneed a quick \"is the user signed in\" check before triggering a\nsign-in flow.",
            "tags": [],
            "examples": []
          },
          {
            "name": "onSessionChanged",
            "signature": "onSessionChanged(cb: (env: Environment, session: AuthSession | null) => void): () => void;\n\n  /**\n   * Subscribe to typed auth events (ADR-032). Branch on `ev.name` for\n   * type-narrowed access to span data, IPC payloads, the\n   * `auth.signIn.coalesced` event, and serialized errors.\n   *\n   * @example\n   * ```typescript\n   * import { getAuthApi, AUTH_EVENTS } from '../auth/api.js';\n   * getAuthApi().onEvent((ev) => {\n   *   if (ev.name === AUTH_EVENTS.SIGN_IN_FINISH) {\n   *     metrics.timing('auth.signIn', ev.durationMs);\n   *     metrics.tag({ accountId: ev.data.accountId });\n   *   }\n   * });\n   * ```\n   */\n  onEvent(handler: (event: import('./events.js').AuthEvent) => void): () => void;",
            "description": "Subscribe to session changes. Fires whenever a sign-in completes\nor a sign-out happens. Returns an unsubscribe function.\n\nThe callback receives `(env, session)` where `session` is the new\nsession or `null` if the env was just signed out.",
            "tags": [],
            "examples": []
          }
        ]
      },
      "events": {
        "constantName": "AUTH_EVENTS",
        "count": 32,
        "entries": [
          {
            "constantKey": "SIGN_IN_START",
            "name": "auth.signIn.start",
            "description": ""
          },
          {
            "constantKey": "SIGN_IN_FINISH",
            "name": "auth.signIn.finish",
            "description": ""
          },
          {
            "constantKey": "SIGN_IN_FAIL",
            "name": "auth.signIn.fail",
            "description": ""
          },
          {
            "constantKey": "SIGN_IN_COALESCED",
            "name": "auth.signIn.coalesced",
            "description": ""
          },
          {
            "constantKey": "SIGN_OUT_START",
            "name": "auth.signOut.start",
            "description": ""
          },
          {
            "constantKey": "SIGN_OUT_FINISH",
            "name": "auth.signOut.finish",
            "description": ""
          },
          {
            "constantKey": "HYDRATE_START",
            "name": "auth.hydrate.start",
            "description": ""
          },
          {
            "constantKey": "HYDRATE_FINISH",
            "name": "auth.hydrate.finish",
            "description": ""
          },
          {
            "constantKey": "HYDRATE_FAIL",
            "name": "auth.hydrate.fail",
            "description": ""
          },
          {
            "constantKey": "INJECT_TOKEN_START",
            "name": "auth.inject-token.start",
            "description": ""
          },
          {
            "constantKey": "INJECT_TOKEN_FINISH",
            "name": "auth.inject-token.finish",
            "description": ""
          },
          {
            "constantKey": "INJECT_TOKEN_FAIL",
            "name": "auth.inject-token.fail",
            "description": ""
          },
          {
            "constantKey": "SESSION_READ",
            "name": "auth.session.read",
            "description": ""
          },
          {
            "constantKey": "WINDOW_OPENED",
            "name": "auth.window.opened",
            "description": ""
          },
          {
            "constantKey": "WINDOW_NAV_START",
            "name": "auth.window.nav-start",
            "description": ""
          },
          {
            "constantKey": "WINDOW_NAV_FINISH",
            "name": "auth.window.nav-finish",
            "description": ""
          },
          {
            "constantKey": "WINDOW_NAV_FAIL",
            "name": "auth.window.nav-fail",
            "description": ""
          },
          {
            "constantKey": "WINDOW_TITLE",
            "name": "auth.window.title",
            "description": ""
          },
          {
            "constantKey": "WINDOW_CLOSED",
            "name": "auth.window.closed",
            "description": ""
          },
          {
            "constantKey": "COOKIE_CAPTURED",
            "name": "auth.cookie.captured",
            "description": ""
          },
          {
            "constantKey": "COOKIE_PROBED",
            "name": "auth.cookie.probed",
            "description": ""
          },
          {
            "constantKey": "PERSIST_OK",
            "name": "auth.persist.ok",
            "description": ""
          },
          {
            "constantKey": "PERSIST_FAIL",
            "name": "auth.persist.fail",
            "description": ""
          },
          {
            "constantKey": "SSO_SKIP_ATTEMPT",
            "name": "auth.sso-skip.attempt",
            "description": ""
          },
          {
            "constantKey": "SSO_SKIP_CLICKED",
            "name": "auth.sso-skip.clicked",
            "description": ""
          },
          {
            "constantKey": "SSO_SKIP_NOT_FOUND",
            "name": "auth.sso-skip.not-found",
            "description": ""
          },
          {
            "constantKey": "SSO_SKIP_FAILED",
            "name": "auth.sso-skip.failed",
            "description": ""
          },
          {
            "constantKey": "IPC_SIGN_IN",
            "name": "auth.ipc.sign-in",
            "description": ""
          },
          {
            "constantKey": "IPC_SIGN_OUT",
            "name": "auth.ipc.sign-out",
            "description": ""
          },
          {
            "constantKey": "IPC_GET_SESSION",
            "name": "auth.ipc.get-session",
            "description": ""
          },
          {
            "constantKey": "IPC_GET_TOKEN_BUNDLE",
            "name": "auth.ipc.get-token-bundle",
            "description": ""
          },
          {
            "constantKey": "IPC_HAS_VALID_SESSION",
            "name": "auth.ipc.has-valid-session",
            "description": ""
          }
        ]
      },
      "readme": "# `lite/auth/` — GSX Sign-In\n\nCaptures the OneReach GSX session token after the user signs in and selects their account, persists the session via [`lite/kv/`](../kv/), and exposes the token to main-process consumers via a typed API.\n\n- **Public API**: [`api.ts`](api.ts) — `AuthApi` interface, `getAuthApi()` singleton, error class & codes\n- **Internal**:\n  - [`store.ts`](store.ts) — cookie capture + KV persistence + `AuthError` definition (`@internal`)\n  - [`window.ts`](window.ts) — auth `BrowserWindow` factory with navigation containment (`@internal`)\n  - [`main.ts`](main.ts) — main-process IPC handlers + lifecycle (`@internal`)\n  - [`types.ts`](types.ts) — `Environment`, `AuthSession`, `EnvironmentConfig`\n- **Tests**: [`../test/unit/auth-api.test.ts`](../test/unit/auth-api.test.ts), [`../test/unit/auth-errors.test.ts`](../test/unit/auth-errors.test.ts), [`../test/unit/auth-store.test.ts`](../test/unit/auth-store.test.ts), [`../test/integration/auth-integration.test.ts`](../test/integration/auth-integration.test.ts)\n- **Decision rationale**: [DECISIONS.md ADR-026 (sign-in v1 captures cookies; user fills the form)](../DECISIONS.md#adr-026-lite-gsx-sign-in-v1-captures-session-cookies-user-fills-the-onereach-form)\n\n---\n\n## What it is\n\nThe auth module opens an Electron `BrowserWindow` pointing at GSX (`https://studio.edison.onereach.ai` in v1) and lets the user complete the OneReach sign-in ceremony themselves — typing email/password, completing 2FA, picking their account from the OneReach picker. A session-cookie listener on the window's partition watches for the `mult` and `or` cookies. Once both arrive AND a KV write succeeds, the window closes and `signIn()` resolves with an `AuthSession`.\n\nThe captured `mult` cookie value is the OneReach API bearer token (`Authorization: Bearer <value>`). It is held main-process only — `getToken()` is intentionally NOT exposed via the preload bridge. Future consumer modules that need to call OneReach APIs do so from main and inject the header themselves.\n\n```typescript\n// Main-process consumer\nimport { getAuthApi } from '../auth/api.js';\n\nconst auth = getAuthApi();\nawait auth.signIn('edison');           // opens window, resolves on capture\nconst token = auth.getToken('edison'); // raw mult cookie value\nconst headers = { Authorization: `Bearer ${token}` };\n```\n\n```typescript\n// Renderer (placeholder.html) — note the bridge omits getToken\nconst result = await window.lite.auth.signIn('edison');\nconsole.log('signed in as', result.session.email, 'account', result.session.accountId);\n```\n\n---\n\n## v1 scope (deliberately narrow)\n\n| What v1 ships | What v1 deliberately skips |\n|---|---|\n| Edison environment only | Staging / dev / production (stubbed in `Environment` union; `AUTH_UNSUPPORTED_ENV` for now) |\n| One account per env | Multi-account picker UI (`auth-multi-account` in `PORTING.md` deferred queue) |\n| User types their own email/password | Email/password auto-fill, account-picker auto-click |\n| Lite auto-fills TOTP when configured | Backup / recovery code handling |\n| Cookie capture + KV persistence | Cross-partition token propagation (full app's pattern; not needed since v1 has one partition per env) |\n| Placeholder-window button | Menu entry (`auth-menu-entry` deferred to keep kernel menu tidy) |\n\nSee [`../PORTING.md`](../PORTING.md) chunk `auth-signin-v1` for the full scope and deferred follow-ups.\n\n---\n\n## API quick reference\n\n| Method | Returns | Throws? | Notes |\n|---|---|---|---|\n| `signIn(env, opts?)` | `Promise<AuthSession>` | Yes (`AuthError`) | Opens window, captures cookies, persists to KV. Concurrent calls coalesce. |\n| `signOut(env)` | `Promise<void>` | **No (soft-fail)** | Removes cookies + KV record + in-memory state. Best-effort. |\n| `getSession(env)` | `AuthSession \\| null` | No | Synchronous; returns the rehydrated or in-memory session. |\n| `getToken(env)` | `string \\| null` | No | Returns the raw `mult` cookie value (the API bearer). Cheaper than `getTokenBundle` when the caller only needs `mult`. |\n| `getTokenBundle(env)` | `AuthTokenBundle \\| null` | No | Returns both raw cookie values (`mult` + `or`) + capturedAt. **Bridged to renderers** for the Settings → Account verification UI. Returns null until the next sign-in after a restart. |\n| `hasValidSession(env)` | `boolean` | No | True if there's a session AND `expiresAt` (if known) is in the future. |\n| `onSessionChanged(cb)` | `() => void` (unsubscribe) | No | Fires on every sign-in/sign-out. |\n\nSee [`api.ts`](api.ts) for full JSDoc.\n\n---\n\n## Persistence shape\n\nKV collection: `lite-auth-sessions`\nKV key: `${environment}:${accountId}` (e.g. `edison:05bd3c92-5d3c-4dc5-a95d-0c584695cea4`)\n\n```typescript\ninterface AuthSession {\n  environment: Environment;   // 'edison' | 'staging' | 'dev' | 'production'\n  accountId: string;          // UUID extracted from the or cookie or URL\n  email?: string;             // from decoded or cookie if present\n  capturedAt: number;         // ms epoch\n  expiresAt?: number;         // ms epoch, from cookie.expirationDate * 1000\n}\n```\n\nThe raw `mult` token is **NOT** persisted in KV — it lives only in `Map<Environment, string>` inside `AuthStore`. After an app restart, `hydrate()` (called automatically at boot by `initAuth`) reloads the metadata, but `getToken()` returns null until the user signs in again. This is a deliberate security trade-off: tokens stay ephemeral across restarts.\n\n### Boot-time hydration race\n\n`initAuth` kicks off `hydrate()` in the background at boot, but it isn't synchronous — KV roundtrip takes ~300-500ms in practice. To prevent renderers (e.g. the placeholder window) from seeing a \"Sign in\" button before hydration completes, two things happen:\n\n1. The `lite:auth:get-session` and `lite:auth:has-valid-session` IPC handlers `await` `hydrate()` before reading. Concurrent calls (boot-time + first renderer probe) coalesce on a shared in-flight Promise so KV is hit exactly once.\n2. After hydration, `AuthStore` fires the `session-changed` callback for every rehydrated session. Subscribers that registered after boot (the placeholder's `onSessionChanged` listener attaches when the script loads) still receive the rehydrated state via this broadcast — belt-and-suspenders against any future timing change.\n\n---\n\n## Error catalog\n\nEvery error is an `AuthError` (extends `LiteError`). Inspect `.code` to branch.\n\n| Code | Meaning | Remediation |\n|---|---|---|\n| `AUTH_CANCELLED` | User closed the auth window before both cookies arrived. | \"Click Sign in to GSX to try again.\" |\n| `AUTH_TIMEOUT` | Cookies didn't arrive within the timeout (default 5 min). | \"Try signing in again.\" |\n| `AUTH_KV_FAILED` | Cookies were captured but the KV write rejected. Window closes. | The `KVError` is in `.cause`; remediation is taken from it. |\n| `AUTH_UNSUPPORTED_ENV` | Caller passed an env not in `SUPPORTED_ENVIRONMENTS`. | \"v1 supports edison only.\" |\n| `AUTH_INVALID_COOKIE` | The `or` cookie value couldn't be decoded, OR no `accountId` could be found in the payload or URL. | \"Make sure to pick an account in GSX before closing the window.\" |\n\n```typescript\nimport { getAuthApi, AuthError, AUTH_ERROR_CODES, isLiteError } from '../auth/api.js';\n\ntry {\n  await getAuthApi().signIn('edison');\n} catch (err) {\n  if (err instanceof AuthError) {\n    if (err.code === AUTH_ERROR_CODES.CANCELLED) return; // user backed out\n    toast(err.formatForUser());        // \"Sign-in timed out... Try signing in again.\"\n    log.error(err.formatForLog());     // structured for diagnostics\n  }\n}\n```\n\n---\n\n## Event taxonomy\n\nPer ADR-030, the auth module emits structured events through the central log. Per ADR-032, these are exposed as a typed `AuthEvent` discriminated union with `getAuthApi().onEvent()`. The typed constants in [`lite/auth/events.ts`](./events.ts) (`AUTH_EVENTS`) are the source of truth.\n\n| Event | When | Typed payload |\n|---|---|---|\n| `auth.signIn.start` / `.finish` / `.fail` | First (non-coalesced) `signIn()` call boundary | `data: { env }` / `data: { env, accountId }` + `durationMs` / `durationMs` + top-level `error` |\n| `auth.signIn.coalesced` | A subsequent in-flight `signIn()` returns the original promise | `data: { env }` |\n| `auth.signOut.start` / `.finish` | `signOut()` boundary; never `.fail` (soft-fail cleanup) | `data: { env }` / `data: { env, hadSession }` + `durationMs` |\n| `auth.hydrate.start` / `.finish` / `.fail` | `hydrate()` boundary; idempotent, repeat calls return early before this fires | (no data) / `data: { count }` + `durationMs` / `durationMs` + `error` |\n| `auth.session.read` | Sync `getSession()` call | `data: { env, hasSession }` |\n| `auth.ipc.sign-in` / `.sign-out` / `.get-session` / `.has-valid-session` | IPC handlers entered | (no data) |\n\nThe `signIn` span fires once per coalesced cluster — concurrent callers share the same span (and the same `Promise`). The `auth.signIn.coalesced` event marks each non-first caller so the coalescing is observable.\n\n`getToken` and `hasValidSession` (sync, main-process-only) do NOT emit events — they're called frequently and are pure reads.\n\n**Subscribing with type narrowing:**\n\n```typescript\nimport { getAuthApi, AUTH_EVENTS, type AuthEvent } from '../auth/api.js';\n\ngetAuthApi().onEvent((ev: AuthEvent) => {\n  switch (ev.name) {\n    case AUTH_EVENTS.SIGN_IN_FINISH:\n      // ev.data narrowed to { env, accountId }\n      metrics.gauge('auth.account', { env: ev.data.env, id: ev.data.accountId });\n      break;\n    case AUTH_EVENTS.SIGN_IN_COALESCED:\n      metrics.increment('auth.signIn.coalesced', { env: ev.data.env });\n      break;\n    case AUTH_EVENTS.SIGN_IN_FAIL:\n      sentry.capture(ev.error);\n      break;\n  }\n});\n```\n\n## Token redaction guarantee\n\nCookie values are **NEVER** logged. Only metadata: `valueLength`, `domain`, `expirationDate`, `httpOnly`, `secure`, `sameSite`, `path`, `name`. This invariant is enforced by a unit test in [`../test/unit/auth-store.test.ts`](../test/unit/auth-store.test.ts) that captures every log call during a sign-in and asserts the captured token value never appears as a substring in any message or data payload. A second test enforces the same for the raw `or` cookie payload.\n\nIf you add a new log call in `store.ts`, do not log `cookie.value` directly. Use the `cookieMetadata(cookie)` helper in `store.ts` for any cookie-related log.\n\n## Token reveal in Settings (ADR-026 amendment)\n\n`getTokenBundle(env)` returns both captured cookie values (`mult` + `or`) plus their `capturedAt` and per-cookie expiration. The bundle is bridged to renderers (`window.lite.auth.getTokenBundle(env)`) and consumed exclusively by the Settings → Account section so users can verify both cookies were captured and copy individual values for manual debugging.\n\nConstraints preserved:\n\n- **Never persisted.** The bundle lives only in `AuthStore.tokenBundles`. KV holds the `AuthSession` shape only (env, accountId, email, capturedAt, expiresAt).\n- **Never logged.** Token values are not part of any log message or data payload. The redaction test catches regressions.\n- **Ephemeral across restarts.** The map is cleared on app restart; `getTokenBundle` returns null until the user signs in again, even when the persisted `AuthSession` rehydrates from KV. The Settings → Account UI displays \"Tokens are cleared on app restart … sign back in to refresh them in this view.\" in that case.\n- **Cleared on sign-out.** `signOut(env)` deletes the bundle along with the cookies and KV record.\n\n---\n\n## Renderer bridge (`window.lite.auth`)\n\nThe preload exposes a narrowed surface. `getToken()` is intentionally not bridged — the token never crosses IPC.\n\n```typescript\nwindow.lite.auth.signIn('edison').then(({ session }) => { ... });\nwindow.lite.auth.signOut('edison');\nwindow.lite.auth.getSession('edison').then(({ session }) => { ... });\nwindow.lite.auth.hasValidSession('edison').then(({ valid }) => { ... });\n\n// Subscribe to changes from anywhere in the app.\nconst off = window.lite.auth.onSessionChanged(({ env, session }) => {\n  // re-render UI\n});\n\n// Parse a thrown signIn error into the structured AuthError shape.\ntry {\n  await window.lite.auth.signIn('edison');\n} catch (err) {\n  const authErr = window.lite.auth.parseError(err); // { code, message, remediation, ... }\n  if (authErr) showBanner(authErr.message + ' ' + authErr.remediation);\n}\n```\n\nThe placeholder window (`lite/placeholder.html`) is the canonical consumer.\n\n---\n\n## Testing\n\nPer Rule 12 (LITE-RULES.md / ADR-024):\n\n- **API conformance** — [`auth-api.test.ts`](../test/unit/auth-api.test.ts) runs `runApiConformanceContract`.\n- **Error conformance** — [`auth-errors.test.ts`](../test/unit/auth-errors.test.ts) runs `runErrorConformanceContract` for `AuthError`.\n- **Store behavior** — [`auth-store.test.ts`](../test/unit/auth-store.test.ts) covers happy path, all five error codes, in-flight coalescing, existing-session probe, signOut symmetry, and the **token redaction assertion**.\n- **Wire format** — [`auth-integration.test.ts`](../test/integration/auth-integration.test.ts) drives the real `EdisonKVClient` against [`startInMemoryKVServer`](../test/harness/mocks/in-memory-kv-server.ts), verifying the persisted shape and that the raw token is never written to KV.\n- **`window.ts` coverage**: manual smoke only in v1 — automated E2E is tracked as `auth-signin-e2e` in `PORTING.md` deferred queue (needs a fake OneReach auth server harness).\n\nTests mock `electron` with `vi.mock` so they run under Node's vitest runner without an Electron host.\n\n---\n\n## Borrowed patterns (studied, never imported)\n\nPer LITE-RULES.md cherry-pick discipline:\n\n- `multi-tenant-store.js:387-469` — session cookie listener pattern (`session.cookies.on('changed', ...)` filtered to `mult` / `or`)\n- `multi-tenant-store.js:81-87` — safe OneReach domain validation (prevents subdomain attacks)\n- `multi-tenant-store.js:573` — environment extraction from cookie domain\n- `gsx-autologin.js:1063-1120` — per-account session partition shape\n\nAll rewritten in TS-strict within `lite/auth/`. No `import` from full's root files or `packages/`.\n\n---\n\n## What auto-fill exists?\n\nLite now handles the narrow 2FA step during sign-in (ADR-034):\n\n- User still types email/password in the OneReach popup.\n- When OneReach shows a TOTP prompt, Lite detects the auth frame.\n- Lite calls `getTotpApi().getCurrentCode()`.\n- Lite fills and submits the current 6-digit code.\n- Cookie capture continues unchanged and closes the window once `mult` + `or` persist.\n\nEmail/password auto-fill and account-picker auto-select are deliberately still out of scope. The full app's `gsx-autologin.js` ports the entire OneReach auth ceremony into the kernel: form fill, TOTP, account picker auto-click, retry/backoff, status overlay. Lite only ports the TOTP slice because that removes the biggest login friction while keeping the auth surface small.\n\n### How TOTP auto-fill detects the form\n\nThe OneReach auth UI is a SPA — by the time Electron's `did-finish-load` fires, the React tree usually hasn't mounted the TOTP `<input>` yet. A one-shot `document.querySelector` at that moment finds nothing and silently gives up.\n\nTo handle this, [`totp-autofill.ts`](./totp-autofill.ts) injects [`buildWaitForAuthFormScript`](../../lib/auth-scripts.js) into every OneReach frame in the tree (main frame + every iframe + every popup window). That script installs a `MutationObserver` and resolves only when an email, password, or TOTP input actually shows up in the DOM (or after a 10s timeout). The auto-fill then checks `is2FAPage`, generates the code via `getTotpApi().getCurrentCode()`, fills it with React-compatible input events (`buildFillTOTPScript`), and clicks the verify/continue/confirm button (`buildSubmitButtonScript`).\n\nOneReach can render the 2FA prompt either in a frame inside the auth window OR in a `window.open` popup the auth window opens. The watcher attaches to popups via `webContents.on('did-create-window', ...)` so both paths are covered without the caller having to know which one OneReach picks today.\n\nEvery step writes an `info` log line under the `auth` category (`auth-totp-autofill: started watching`, `: scan`, `: form wait resolved`, `: filled and submitted 2FA code`, etc.). No path returns silently — when the auto-fill does nothing, the log says exactly why. Token values, TOTP secrets, and the generated 6-digit code are never logged.\n"
    },
    {
      "slug": "bug-report",
      "title": "Bug Report",
      "summary": "Bug-report module -- PUBLIC API.\n\nThis is the only file other lite modules should import from in this\nmodule. Per ADR-019 (and rule 11 in lite/LITE-RULES.md), cross-module\nimports go through `<module>/api.ts` -- never reach into store.ts,\nmain.ts, or any other internal file.\n\nThe bug-report module itself consumes the KV module via its public\nAPI (`../kv/api.ts`); see ADR-020 for why KV lives at the top level\nrather than buried inside bug-report.\n\nUsage from another module:\n\n  import { getBugReportApi } from '../bug-report/api.js';\n  const reports = await getBugReportApi().list();\n\nThe implementation backing `BugReportApi` is `BugReportStore` (in\nstore.ts), but the choice of backing class is an internal detail. If\nwe ever swap the implementation (caching layer, in-memory variant for\ntests, alternate cloud sink), only this file changes.\n\nInitialization: callers do not need to wire dependencies. The default\nsingleton lazily creates a `BugReportStore` with a console logger.\nTests can swap the implementation via `_setBugReportApiForTesting`.",
      "surface": {
        "interfaceName": "BugReportApi",
        "interfaceDescription": "The public surface of the bug-report module. All cross-module callers\nroute through this interface.\n\n**Error contract**:\n- `save()` and `read()` throw `BugReportError` (extends `LiteError`)\n  on failure. Inspect `.code` to branch (`BR_SAVE_FAILED`,\n  `BR_NOT_FOUND`, `BR_BAD_PAYLOAD`).\n- `list()`, `update()`, and `delete()` are **soft-fail**: they never\n  throw. Inspect the returned `kvWritten` / `kvUpdated` / `kvDeleted`\n  booleans plus the `kvError` string for failure UX.\n\nThe split is intentional: throws are reserved for \"the operation\ncannot succeed and there's nothing meaningful to return\" (e.g.\nNOT_FOUND from `read`). For mutations that have a partial-success\nshape (the in-memory payload is still valid even if the network\nwrite failed), we return a result object so the modal can render an\ninline error and let the user retry.\n\nSee `lite/bug-report/README.md` for the full error catalog and\nrecipe-style usage examples.",
        "methods": [
          {
            "name": "save",
            "signature": "save(payload: BugReportPayload): Promise<SaveResult>",
            "description": "Persist a new bug report.",
            "tags": [
              {
                "tag": "param",
                "value": "payload Already-redacted, schema-validated payload from\n  `capture()`. The `timestamp` field is the KV key."
              },
              {
                "tag": "returns",
                "value": "`{ kvWritten: true, kvError: null }` on success."
              },
              {
                "tag": "throws",
                "value": "{BugReportError} `BR_SAVE_FAILED` if the KV write rejected.\n  Inspect `.cause` for the underlying `KVError` (`.code`,\n  `.context`, `.remediation`)."
              }
            ],
            "examples": [
              "try {\n  await getBugReportApi().save(payload);\n} catch (err) {\n  if (err instanceof BugReportError) {\n    toast(err.formatForUser());      // \"Bug report save failed: ...\"\n    console.error(err.formatForLog()); // structured for diagnostics\n  }\n}"
            ]
          },
          {
            "name": "list",
            "signature": "list(): Promise<BugReportSummary[]>",
            "description": "List all reports, newest first. Soft-fails: returns `[]` on KV\nfailure so the modal can render an empty state instead of an\nerror.",
            "tags": [
              {
                "tag": "returns",
                "value": "Summaries (timestamp, version, description preview,\n  redaction stats, status, notes presence). Empty if no reports\n  are stored or KV is unreachable."
              }
            ],
            "examples": [
              "const reports = await getBugReportApi().list();\nfor (const r of reports) {\n  console.log(r.timestamp, r.descriptionPreview, r.status);\n}"
            ]
          },
          {
            "name": "read",
            "signature": "read(idOrPath: string): Promise<BugReportPayload>",
            "description": "Read a single report by id.",
            "tags": [
              {
                "tag": "param",
                "value": "idOrPath Either a bare timestamp (e.g.\n  `2026-05-04T01:02:03Z`) or the synthetic `kv:<timestamp>` form\n  produced by `list()`."
              },
              {
                "tag": "returns",
                "value": "The full payload, with legacy schemas migrated."
              },
              {
                "tag": "throws",
                "value": "{BugReportError} `BR_NOT_FOUND` if the id resolves to no\n  record. Remediation: refresh the list and retry."
              },
              {
                "tag": "throws",
                "value": "{BugReportError} `BR_BAD_PAYLOAD` if KV returned a value\n  that doesn't deserialize as a `BugReportPayload`."
              },
              {
                "tag": "throws",
                "value": "{KVError} on network/server failures (`KV_TIMEOUT`,\n  `KV_HTTP`, `KV_NETWORK`)."
              }
            ],
            "examples": [
              "const report = await getBugReportApi().read('kv:2026-05-04T01:02:03Z');"
            ]
          },
          {
            "name": "update",
            "signature": "update(\n    timestamp: string,\n    updates: { status?: BugReportStatus; notes?: string }\n  ): Promise<UpdateResult>",
            "description": "Update mutable fields (status, notes) on an existing report.\nNotes are redacted before save. Soft-fails: returns\n`{ kvUpdated: false, kvError: \"...\" }` on KV failure so the modal\ncan show an inline retry without losing the user's edits.",
            "tags": [
              {
                "tag": "param",
                "value": "timestamp The KV key (bare timestamp -- not the\n  `kv:<timestamp>` synthetic form)."
              },
              {
                "tag": "param",
                "value": "updates Partial mutation. Omit fields that should not change."
              },
              {
                "tag": "returns",
                "value": "The new payload (in-memory) plus a `kvUpdated` flag."
              }
            ],
            "examples": [
              "const result = await getBugReportApi().update('2026-05-04T01:02:03Z', {\n  status: 'resolved',\n  notes: 'Closed by ricky -- duplicate of #42',\n});\nif (!result.kvUpdated) toast(result.kvError ?? 'Update failed');"
            ]
          },
          {
            "name": "delete",
            "signature": "delete(timestamp: string): Promise<DeleteResult>",
            "description": "Delete a report. Soft-fails: returns\n`{ kvDeleted: false, kvError: \"...\" }` rather than throwing.",
            "tags": [
              {
                "tag": "param",
                "value": "timestamp The KV key."
              },
              {
                "tag": "returns",
                "value": "`{ kvDeleted: boolean, kvError: string | null }`."
              }
            ],
            "examples": [
              "const result = await getBugReportApi().delete('2026-05-04T01:02:03Z');\nif (!result.kvDeleted) toast(result.kvError ?? 'Delete failed');"
            ]
          },
          {
            "name": "onEvent",
            "signature": "onEvent(handler: (event: BugReportEvent) => void): () => void;",
            "description": "Subscribe to typed bug-report events (ADR-032). Branch on\n`ev.name` for type-narrowed access to span data, IPC payloads,\nand serialized errors.",
            "tags": [],
            "examples": [
              "const unsub = getBugReportApi().onEvent((ev) => {\n  switch (ev.name) {\n    case 'bug-report.save.finish':\n      metrics.timing('bug-report.save', ev.durationMs);\n      break;\n    case 'bug-report.save.fail':\n      sentry.capture(ev.data.error);\n      break;\n  }\n});"
            ]
          }
        ]
      },
      "events": {
        "constantName": "BUG_REPORT_EVENTS",
        "count": 22,
        "entries": [
          {
            "constantKey": "SAVE_START",
            "name": "bug-report.save.start",
            "description": ""
          },
          {
            "constantKey": "SAVE_FINISH",
            "name": "bug-report.save.finish",
            "description": ""
          },
          {
            "constantKey": "SAVE_FAIL",
            "name": "bug-report.save.fail",
            "description": ""
          },
          {
            "constantKey": "LIST_START",
            "name": "bug-report.list.start",
            "description": ""
          },
          {
            "constantKey": "LIST_FINISH",
            "name": "bug-report.list.finish",
            "description": ""
          },
          {
            "constantKey": "LIST_FAIL",
            "name": "bug-report.list.fail",
            "description": ""
          },
          {
            "constantKey": "READ_START",
            "name": "bug-report.read.start",
            "description": ""
          },
          {
            "constantKey": "READ_FINISH",
            "name": "bug-report.read.finish",
            "description": ""
          },
          {
            "constantKey": "READ_FAIL",
            "name": "bug-report.read.fail",
            "description": ""
          },
          {
            "constantKey": "UPDATE_START",
            "name": "bug-report.update.start",
            "description": ""
          },
          {
            "constantKey": "UPDATE_FINISH",
            "name": "bug-report.update.finish",
            "description": ""
          },
          {
            "constantKey": "UPDATE_FAIL",
            "name": "bug-report.update.fail",
            "description": ""
          },
          {
            "constantKey": "DELETE_START",
            "name": "bug-report.delete.start",
            "description": ""
          },
          {
            "constantKey": "DELETE_FINISH",
            "name": "bug-report.delete.finish",
            "description": ""
          },
          {
            "constantKey": "DELETE_FAIL",
            "name": "bug-report.delete.fail",
            "description": ""
          },
          {
            "constantKey": "IPC_CAPTURE",
            "name": "bug-report.ipc.capture",
            "description": ""
          },
          {
            "constantKey": "IPC_SAVE",
            "name": "bug-report.ipc.save",
            "description": ""
          },
          {
            "constantKey": "IPC_CLOSE",
            "name": "bug-report.ipc.close",
            "description": ""
          },
          {
            "constantKey": "IPC_LIST",
            "name": "bug-report.ipc.list",
            "description": ""
          },
          {
            "constantKey": "IPC_READ",
            "name": "bug-report.ipc.read",
            "description": ""
          },
          {
            "constantKey": "IPC_UPDATE",
            "name": "bug-report.ipc.update",
            "description": ""
          },
          {
            "constantKey": "IPC_DELETE",
            "name": "bug-report.ipc.delete",
            "description": ""
          }
        ]
      },
      "readme": "# `lite/bug-report/` — Bug Reports\n\nUser-filed bug reports with mandatory PII/secret redaction, KV-backed CRUD, and a modal UI for filing and triaging.\n\n- **Public API**: [`api.ts`](api.ts) — `BugReportApi` interface, `getBugReportApi()` singleton, error class & codes\n- **Internal**:\n  - [`store.ts`](store.ts) — KV-backed store + `BugReportError` definition (`@internal`)\n  - [`main.ts`](main.ts) — main-process IPC handlers + modal lifecycle (`@internal`)\n  - [`capture.ts`](capture.ts) — payload assembly + redaction\n  - [`modal.html`](modal.html) / [`modal.css`](modal.css) / [`modal.ts`](modal.ts) — renderer UI\n- **Tests**: [`../test/unit/bug-report-api.test.ts`](../test/unit/bug-report-api.test.ts), [`../test/unit/bug-report-store.test.ts`](../test/unit/bug-report-store.test.ts), [`../test/unit/bug-report-capture.test.ts`](../test/unit/bug-report-capture.test.ts)\n- **Decision rationale**: [DECISIONS.md ADR-008 (redaction)](../DECISIONS.md#adr-008-mandatory-default-on-bug-reporter-redaction), [ADR-019 (modular shape)](../DECISIONS.md#adr-019-modular-api-pattern-with-public-apits-per-module)\n\n---\n\n## What it is\n\nBug reports are user-filed records of \"this app misbehaved\". Each report carries the user's description, the app version + platform, the last several log lines, and redacted notes/status mutations from triage. Records live in the Edison KV store under collection `lite-bugs`, keyed by ISO timestamp.\n\nMandatory PII/secret redaction runs on every save and every notes update — the user cannot disable it. See [`bug-report-redaction-patterns.ts`](../bug-report-redaction-patterns.ts) for the regex catalog.\n\n```typescript\nimport { getBugReportApi } from '../bug-report/api.js';\n\nconst api = getBugReportApi();\nconst result = await api.save(payload);    // throws BugReportError on KV failure\nconst reports = await api.list();           // soft-fails to []\nconst report = await api.read(reports[0]!.filePath);\nconst updated = await api.update(report.timestamp, { status: 'resolved' });\nconst deleted = await api.delete(report.timestamp);\n```\n\n---\n\n## API quick reference\n\n| Method | Returns | Throws? | Notes |\n|---|---|---|---|\n| `save(payload)` | `Promise<SaveResult>` | Yes (`BugReportError`, `KVError`) | Persists to KV. Cause-chains the underlying KV failure. |\n| `list()` | `Promise<BugReportSummary[]>` | **No (soft-fail)** | Returns `[]` on KV failure; modal renders empty state. |\n| `read(idOrPath)` | `Promise<BugReportPayload>` | Yes (`BugReportError`, `KVError`) | Accepts bare timestamp or `kv:<timestamp>` synthetic id. |\n| `update(timestamp, partial)` | `Promise<UpdateResult>` | **No (soft-fail)** | Returns `{ kvUpdated, kvError }` so modal can render inline retry. Notes redacted before save. |\n| `delete(timestamp)` | `Promise<DeleteResult>` | **No (soft-fail)** | Returns `{ kvDeleted, kvError }`. |\n\nThe throw / soft-fail split is intentional. Throws are reserved for \"operation cannot succeed and there's nothing meaningful to return\" (e.g. `BR_NOT_FOUND` from `read`). Mutations that have a partial-success shape (the in-memory payload is still valid even if the network write failed) return a result object so the UI can show an inline error and let the user retry.\n\nFull JSDoc with `@throws` / `@example` per method is in [`api.ts`](api.ts) — your IDE renders it on hover.\n\n---\n\n## Usage patterns\n\n### Filing a report (from the modal renderer)\n\n```typescript\nconst payload = await window.bugReport.capture(userDescription);\nconst result = await window.bugReport.save(payload.payload);\nif (result.kvWritten) {\n  toast('Report sent. Thank you.');\n} else {\n  toast(result.kvError ?? 'Send failed');\n}\n```\n\nThe renderer-side bridge in [`preload-lite.ts`](../preload-lite.ts) wraps the IPC. The modal renderer never imports `getBugReportApi()` directly — it goes through `window.bugReport`.\n\n### Triaging from a different module (main process)\n\n```typescript\nimport { getBugReportApi, BugReportError } from '../bug-report/api.js';\n\nasync function markResolvedIfRecent(timestamp: string): Promise<void> {\n  try {\n    const report = await getBugReportApi().read(timestamp);\n    if (Date.parse(report.timestamp) > Date.now() - 86400_000) {\n      await getBugReportApi().update(timestamp, {\n        status: 'resolved',\n        notes: 'Auto-resolved by sweeper -- < 24h old',\n      });\n    }\n  } catch (err) {\n    if (err instanceof BugReportError && err.code === 'BR_NOT_FOUND') {\n      // Already deleted -- nothing to do\n      return;\n    }\n    throw err;\n  }\n}\n```\n\n### Testing\n\n```typescript\nimport { _setBugReportApiForTesting, _resetBugReportApiForTesting } from '../bug-report/api.js';\n\nbeforeEach(() => _resetBugReportApiForTesting());\n\nit('does the thing', async () => {\n  _setBugReportApiForTesting({\n    save: async () => ({ kvWritten: true, kvError: null }),\n    list: async () => [],\n    read: async () => { throw new BugReportError({ code: 'BR_NOT_FOUND', message: 'gone' }); },\n    update: async () => ({ payload: {} as never, kvUpdated: true, kvError: null }),\n    delete: async () => ({ kvDeleted: true, kvError: null }),\n  });\n  // run code under test\n});\n```\n\n---\n\n## Error catalog\n\n`save()` and `read()` throw `BugReportError` (extends [`LiteError`](../errors.ts)) on failure. `list()` / `update()` / `delete()` return result objects with a `kvError` field instead of throwing. KV-layer errors propagate through `.cause`.\n\n| Code | Method | When it fires | `.context` fields | Remediation surfaced to user |\n|---|---|---|---|---|\n| `BR_SAVE_FAILED` | `save()` | KV write rejected. `.cause` is the underlying `KVError`. | `op`, `timestamp`, `collection`, `kvCode?`, `kvStatus?` | Inherits the KV error's remediation if available; otherwise \"Check your network connection and try again. The report was not stored.\" |\n| `BR_NOT_FOUND` | `read()` | The id resolves to no record (deleted or wrong key). | `op`, `idOrPath`, `key`, `collection` | \"The report may have been deleted, or the identifier is wrong. Refresh the list and try again.\" |\n| `BR_BAD_PAYLOAD` | `read()` | KV returned a non-object value (corrupt or written by an incompatible client). | `op`, `key`, `collection`, `actualType` | \"The stored value is corrupt or written by an incompatible client. Delete the record and re-file the report.\" |\n\n### Catching\n\n```typescript\nimport { BugReportError, BUG_REPORT_ERROR_CODES } from '../bug-report/api.js';\nimport { KVError } from '../kv/api.js';\n\ntry {\n  await getBugReportApi().save(payload);\n} catch (err) {\n  if (err instanceof BugReportError) {\n    console.error(err.formatForLog());\n    //   [BR_SAVE_FAILED] Bug report save failed: KV set failed: HTTP 500 from ...\n    //     context: {\"op\":\"save\",\"timestamp\":\"...\",\"collection\":\"lite-bugs\",\"kvCode\":\"KV_HTTP\",\"kvStatus\":500}\n    //     remediation: The KV endpoint returned a server error. ...\n    //     cause: KVError: KV set failed: HTTP 500 ...\n\n    if (err.code === BUG_REPORT_ERROR_CODES.SAVE_FAILED) {\n      // Inspect the cause for KV-specific code\n      if (err.cause instanceof KVError && err.cause.code === 'KV_TIMEOUT') {\n        return queueRetry();\n      }\n    }\n    toast(err.formatForUser());\n  }\n  throw err;\n}\n```\n\nFor soft-fail methods, inspect the `kvError` string:\n\n```typescript\nconst result = await getBugReportApi().delete(timestamp);\nif (!result.kvDeleted) {\n  toast(result.kvError ?? 'Delete failed -- please retry.');\n}\n```\n\n---\n\n## Event taxonomy\n\nPer ADR-030, every store op + every IPC handler emits structured events through the central log. Per ADR-032, these are exposed as a typed `BugReportEvent` discriminated union with per-module `getBugReportApi().onEvent()`. The typed constants in [`lite/bug-report/events.ts`](./events.ts) (`BUG_REPORT_EVENTS`) are the source of truth.\n\n| Event | When | Typed payload |\n|---|---|---|\n| `bug-report.save.start` / `.finish` / `.fail` | `save()` boundary | `data: { timestamp }` / `data: { kvWritten }` + `durationMs` / `durationMs` + top-level `error` |\n| `bug-report.list.start` / `.finish` / `.fail` | `list()` boundary; `.fail` fires even though `list()` returns `[]` (soft-fail) | (no data) / `data: { count }` + `durationMs` / `durationMs` + `error` |\n| `bug-report.read.start` / `.finish` / `.fail` | `read()` boundary; `.fail` fires for `BR_NOT_FOUND` and `BR_BAD_PAYLOAD` | `data: { key }` / `durationMs` / `durationMs` + `error` |\n| `bug-report.update.start` / `.finish` / `.fail` | `update()` boundary | `data: { timestamp, hasStatusChange, hasNotesChange }` / `data: { kvUpdated }` + `durationMs` / `durationMs` + `error` |\n| `bug-report.delete.start` / `.finish` / `.fail` | `delete()` boundary | `data: { timestamp }` / `data: { kvDeleted }` + `durationMs` / `durationMs` + `error` |\n| `bug-report.ipc.capture` | IPC `lite:bug-report:capture` invoked | (no data) |\n| `bug-report.ipc.save` | IPC `lite:bug-report:save` invoked | (no data) |\n| `bug-report.ipc.close` | IPC `lite:bug-report:close` invoked | (no data) |\n| `bug-report.ipc.list` | IPC `lite:bug-report:list` invoked | (no data) |\n| `bug-report.ipc.read` | IPC `lite:bug-report:read` invoked | `data: { idOrPath }` |\n| `bug-report.ipc.update` | IPC `lite:bug-report:update` invoked | `data: { timestamp }` |\n| `bug-report.ipc.delete` | IPC `lite:bug-report:delete` invoked | `data: { timestamp }` |\n| `window.bug-report.ready-to-show` / `.closed` | Modal window lifecycle (emitted by `main-lite.ts` for the modal's parent) | — |\n\nNote: `error` info is at the **top level** of the event record (`ev.error`), not inside `ev.data`. Span finish/fail also carry `durationMs` at the top level.\n\n**Subscribing with type narrowing:**\n\n```typescript\nimport { getBugReportApi, BUG_REPORT_EVENTS, type BugReportEvent } from '../bug-report/api.js';\n\ngetBugReportApi().onEvent((ev: BugReportEvent) => {\n  switch (ev.name) {\n    case BUG_REPORT_EVENTS.SAVE_FINISH:\n      metrics.timing('bug-report.save', ev.durationMs);\n      break;\n    case BUG_REPORT_EVENTS.SAVE_FAIL:\n      sentry.capture(ev.error);\n      break;\n    case BUG_REPORT_EVENTS.UPDATE_START:\n      // ev.data narrowed to { timestamp; hasStatusChange; hasNotesChange }\n      audit.log('bug-update', ev.data.timestamp);\n      break;\n  }\n});\n```\n\nSpans only emit when the consumer wires a `spanEmitter` on the `StoreConfig`. The default config in `bug-report/api.ts` wires it to `getLoggingApi().start()`.\n\nThe bug-report **save** flow nests events under the parent: `bug-report.save.start` -> `kv.set.start` -> `kv.set.finish` -> `bug-report.save.finish`. Bug reports filed by users automatically capture this trace in `recentLogs`.\n\n## Redaction\n\nEvery `save()` and every `notes` update on `update()` runs through [`redact()`](../bug-report-redaction-patterns.ts). The current catalog (7 patterns):\n\n| Kind | What it matches |\n|---|---|\n| `OPENAI_KEY` | `sk-...` style OpenAI keys |\n| `AWS_ACCESS_KEY` | `AKIA...` access key IDs |\n| `GITHUB_PAT` | `ghp_...` personal access tokens |\n| `GITHUB_OAUTH` | `gho_...` OAuth tokens |\n| `JWT` | Three-segment base64url tokens (`<header>.<payload>.<sig>`) |\n| `BEARER_TOKEN` | Authorization-header-style `Bearer <token>` |\n| `API_KEY_ENV` | `API_KEY=` / `SECRET=` / `TOKEN=` env-style assignments |\n\nRedacted spans are replaced with `[REDACTED:<kind>]`. Per-bucket counts are emitted as cohort-level telemetry (per ADR-008 — never per-user-attributable).\n\nThe redaction layer is **mandatory and not user-disableable**. There is no opt-out toggle and there will not be one. Reports that include a \"do not redact\" toggle in the UI bypass the entire purpose of the layer.\n\nIf you need to add a new pattern (email, phone, IP, etc.), add it to [`lite/bug-report-redaction-patterns.ts`](../bug-report-redaction-patterns.ts) and add a corresponding test to [`lite/test/unit/redaction-patterns.test.ts`](../test/unit/redaction-patterns.test.ts). Note that broad patterns like email + phone tend to false-positive on legitimate identifiers in logs (timestamps that look like phone numbers, CDN cache keys that look like emails) -- weigh carefully before adding.\n\n---\n\n## IPC channel reference\n\nThe renderer talks to the main process exclusively via `window.bugReport` (set up in [`../preload-lite.ts`](../preload-lite.ts)). Channel names live in [`main.ts`](main.ts) `BUG_REPORT_IPC`.\n\n| Channel | Direction | Bridge method | Notes |\n|---|---|---|---|\n| `lite:bug-report:capture` | invoke | `window.bugReport.capture(description)` | Returns the assembled payload preview (already redacted). |\n| `lite:bug-report:save` | invoke | `window.bugReport.save(payload)` | Persists to KV. |\n| `lite:bug-report:list` | invoke | `window.bugReport.list()` | Returns `BugReportSummary[]`. |\n| `lite:bug-report:read` | invoke | `window.bugReport.read(idOrPath)` | Returns full payload. |\n| `lite:bug-report:update` | invoke | `window.bugReport.update(timestamp, partial)` | Returns `UpdateResult`. |\n| `lite:bug-report:delete` | invoke | `window.bugReport.delete(timestamp)` | Returns `DeleteResult`. |\n| `lite:bug-report:close` | send | `window.bugReport.close()` | Closes the modal window. |\n\nSchemas are hand-validated in `main.ts` today. Phase 0b's `schema-first-ipc` chunk will add zod-driven validation at the dispatcher.\n\n---\n\n## Test layering\n\n| Layer | File | Tests | What it asserts |\n|---|---|---|---|\n| Public API singleton | [`../test/unit/bug-report-api.test.ts`](../test/unit/bug-report-api.test.ts) | 6 | `getBugReportApi()` identity, reset, `_setForTesting` override, full CRUD round-trip via stub. |\n| Store (production class against fake KV) | [`../test/unit/bug-report-store.test.ts`](../test/unit/bug-report-store.test.ts) | 18 | save/list/read/update/delete behavior, KV failure handling, payload validation. Injects a `FakeKV implements KVApi`. |\n| Payload capture + redaction | [`../test/unit/bug-report-capture.test.ts`](../test/unit/bug-report-capture.test.ts) | 13 | Schema, redaction integration, legacy-payload migration. |\n| Error infrastructure | [`../test/unit/errors.test.ts`](../test/unit/errors.test.ts) | 17 | `BugReportError` is a `LiteError`, code branching. |\n\nE2E: [`../test/e2e/kernel-smoke.spec.ts`](../test/e2e/kernel-smoke.spec.ts) drives the full modal flow against a built signed app.\n\n---\n\n## Internal structure (for contributors)\n\n```\nlite/bug-report/\n  api.ts               <- you import only from here\n  main.ts              <- IPC handlers + modal lifecycle, @internal\n  store.ts             <- KV-backed store + BugReportError, @internal\n  capture.ts           <- payload assembly, redaction integration\n  modal.html           <- renderer template\n  modal.css            <- renderer styles\n  modal.ts             <- renderer logic (consumes window.bugReport)\n  README.md            <- this file\n```\n\nIf you need a method that isn't on `BugReportApi`, add it to `api.ts` (forward to `BugReportStore`). Don't import `store.ts` from another module.\n"
    },
    {
      "slug": "discovery",
      "title": "Discovery",
      "summary": "Discovery module -- PUBLIC API.\n\nThe only file other lite modules should import from in this module.\nPer ADR-019 / Rule 11 in `lite/LITE-RULES.md`, cross-module imports\ngo through `<module>/api.ts` -- never reach into `store.ts` or any\nother internal file.\n\nWraps `@or-sdk/discovery` so other modules can resolve OneReach\nservice URLs (KV, Flows, Bots, etc.) without importing the SDK.\n\nUsage from another module (main process only):\n\n  import { getDiscoveryApi } from '../discovery/api.js';\n  const url = await getDiscoveryApi().resolve('key-value-storage');\n\nTests: `_setDiscoveryApiForTesting(stub)` to inject a custom\nimplementation, `_resetDiscoveryApiForTesting()` to clear the\nsingleton.",
      "surface": {
        "interfaceName": "DiscoveryApi",
        "interfaceDescription": "The public surface of the discovery module.\n\n**Error contract**: `resolve()` and `list()` throw `DiscoveryError`\n(extends `LiteError`) on failure. Inspect `.code`:\n`DISCOVERY_NOT_AUTHENTICATED`, `DISCOVERY_NOT_FOUND`,\n`DISCOVERY_HTTP`, `DISCOVERY_NETWORK`.\n\n**Caching**: `resolve()` is cached per serviceKey (5-minute TTL by\ndefault) so cold-start cost is paid once per service per session.",
        "methods": [
          {
            "name": "resolve",
            "signature": "resolve(serviceKey: string): Promise<string>",
            "description": "Resolve a serviceKey to its base URL. Cached per serviceKey.",
            "tags": [
              {
                "tag": "param",
                "value": "serviceKey Stable identifier (e.g. `'key-value-storage'`)."
              },
              {
                "tag": "returns",
                "value": "The service base URL."
              },
              {
                "tag": "throws",
                "value": "{DiscoveryError} `DISCOVERY_NOT_AUTHENTICATED` when no token."
              },
              {
                "tag": "throws",
                "value": "{DiscoveryError} `DISCOVERY_NOT_FOUND` when the key isn't registered."
              },
              {
                "tag": "throws",
                "value": "{DiscoveryError} `DISCOVERY_HTTP` | `DISCOVERY_NETWORK` on transport failure."
              }
            ],
            "examples": []
          },
          {
            "name": "list",
            "signature": "list(): Promise<DiscoveryService[]>",
            "description": "List every service registered for the active account. Diagnostic\nuse only; feature modules should call `resolve()` directly.",
            "tags": [],
            "examples": []
          },
          {
            "name": "invalidateCache",
            "signature": "invalidateCache(): void",
            "description": "Drop the in-memory resolve cache. Call this on sign-out so a\nsubsequent sign-in (potentially as a different user) re-queries\ndiscovery instead of reusing stale URLs.",
            "tags": [],
            "examples": []
          },
          {
            "name": "onEvent",
            "signature": "onEvent(handler: (event: DiscoveryEvent) => void): () => void;",
            "description": "Subscribe to typed discovery events (ADR-032). Branch on `ev.name`\nfor type-narrowed access.",
            "tags": [],
            "examples": []
          }
        ]
      },
      "events": {
        "constantName": "DISCOVERY_EVENTS",
        "count": 7,
        "entries": [
          {
            "constantKey": "RESOLVE_START",
            "name": "discovery.resolve.start",
            "description": ""
          },
          {
            "constantKey": "RESOLVE_FINISH",
            "name": "discovery.resolve.finish",
            "description": ""
          },
          {
            "constantKey": "RESOLVE_FAIL",
            "name": "discovery.resolve.fail",
            "description": ""
          },
          {
            "constantKey": "LIST_START",
            "name": "discovery.list.start",
            "description": ""
          },
          {
            "constantKey": "LIST_FINISH",
            "name": "discovery.list.finish",
            "description": ""
          },
          {
            "constantKey": "LIST_FAIL",
            "name": "discovery.list.fail",
            "description": ""
          },
          {
            "constantKey": "CACHE_HIT",
            "name": "discovery.cache.hit",
            "description": ""
          }
        ]
      },
      "readme": "# `lite/discovery/` -- Service URL resolver\n\nWraps `@or-sdk/discovery` so other Lite modules can resolve OneReach service URLs (KV, Flows, Bots, etc.) at runtime instead of hardcoding endpoints. This is the seam that lets every subsequent SDK call ride on the signed-in user's `mult` token.\n\n- **Public API**: [`api.ts`](api.ts) -- `DiscoveryApi`, `getDiscoveryApi()`, `DiscoveryError`, `DISCOVERY_ERROR_CODES`\n- **Internal**:\n  - [`store.ts`](store.ts) -- `DiscoveryStore` SDK wrapper + cache (`@internal`)\n  - [`types.ts`](types.ts) -- `DiscoveryService`\n  - [`events.ts`](events.ts) -- typed event surface (ADR-032)\n- **Tests**: [`../test/unit/discovery-api.test.ts`](../test/unit/discovery-api.test.ts), [`../test/unit/discovery-store.test.ts`](../test/unit/discovery-store.test.ts)\n\n## Usage\n\n```typescript\nimport { getDiscoveryApi } from '../discovery/api.js';\n\nconst kvUrl = await getDiscoveryApi().resolve('key-value-storage');\n// 'https://...sdk-api.onereach.ai/keyvalue'\n```\n\n`resolve()` requires a signed-in user (token is read from `getAuthApi().getToken('edison')`). Signed-out callers see `DISCOVERY_NOT_AUTHENTICATED`.\n\n## Caching\n\nResolved URLs are cached per `serviceKey` for 5 minutes. Calling `resolve('key-value-storage')` 100 times pays the discovery roundtrip once. `invalidateCache()` clears the cache (called on sign-out).\n\n## Error catalog\n\n| Code | When | Remediation |\n|------|------|-------------|\n| `DISCOVERY_NOT_AUTHENTICATED` | No `mult` token (user signed out) | Sign in via Settings -> Account |\n| `DISCOVERY_NOT_FOUND` | Discovery returned 404 or no URL for the serviceKey | Confirm the serviceKey is registered |\n| `DISCOVERY_HTTP` | Non-2xx, non-404 response (incl. 401/403) | Check token freshness; sign out + back in |\n| `DISCOVERY_NETWORK` | Underlying fetch rejected (DNS / TCP / TLS) | Check network connectivity |\n\n## Discovery URL\n\nEdison uses `https://discovery.edison.api.onereach.ai`. Other environments (staging, dev, production) would land in `lite/auth/types.ts:ENVIRONMENT_CONFIGS` as part of the `auth-multi-env` chunk in `lite/PORTING.md`.\n\n## Borrowed pattern\n\nThe construction shape (token getter + discoveryUrl) mirrors `lib/edison-sdk-manager.js:298-308` -- the full app's pattern, studied but not imported (per `lite/LITE-RULES.md`).\n"
    },
    {
      "slug": "event-bus",
      "title": "Event Bus",
      "summary": "Event bus -- PUBLIC API.\n\nThe only file other lite modules should import from in this module.\nPer ADR-019 / Rule 11, cross-module imports go through `<module>/api.ts` --\nnever reach into `store.ts`, `translator.ts`, or any other internal file.\n\nThe bus projects raw module events (from the central logging queue)\ninto a small typed catalogue of `DomainEvent`s that other systems\nsubscribe to without coupling to module internals. Per ADR-043, the\nsubscription surface (`on`, `onPattern`, `recent`, `emit`) IS the\npublic API -- bridged to renderers via `window.lite.events.*`, and\ncalled directly by main-process consumers via `getEventBusApi()`.\n\nUsage from another lite module (main process):\n\n  import { getEventBusApi } from '../event-bus/api.js';\n  getEventBusApi().on('user.signed-in', (ev) => {\n    console.log(ev.data.email);\n  });\n\nUsage from a renderer (window):\n\n  window.lite.events.on('agent.tab.opened', (ev) => { ... });\n  const recent = await window.lite.events.recent('user.signed-in', 5);\n\nTests: `_setEventBusApiForTesting(stub)` to inject a custom\nimplementation, `_resetEventBusApiForTesting()` to clear the singleton.",
      "surface": {
        "interfaceName": "EventBusApi",
        "interfaceDescription": "The public surface of the event bus.\n\n**Subscription contract (per ADR-043):**\n  - `on(name, handler)`        -- type-narrowed by name; future-only by default\n  - `onPattern(glob, handler)` -- glob-matched (e.g. `agent.tab.*`); generic union\n  - `recent(name, limit)`      -- snapshot read; doesn't subscribe\n  - `emit(event)`              -- publish a domain event manually\n\nSubscriber callbacks receive the full domain event including\n`id` + `ts`. Throws inside a handler are swallowed and logged --\na buggy subscriber CANNOT bring down emission.\n\n**Renderer surface:** every method except `onEvent` (the bus's own\noperational events) is bridged via `window.lite.events.*`. The\nrenderer surface is async (Promise-wrapped) for `recent`, while\n`on` / `onPattern` register a listener that is called directly\nfrom preload-side IPC events.",
        "methods": [
          {
            "name": "on",
            "signature": "on<N extends DomainEventName>(\n    name: N,\n    handler: (event: Extract<DomainEvent, { name: N }>) => void,\n    opts?: SubscribeOptions\n  ): () => void;\n\n  /**\n   * Subscribe via a glob pattern (e.g. `agent.tab.*`, `user.*`,\n   * `*.signed-in`). The handler receives the full discriminated\n   * union; branch on `event.name` to narrow.\n   *\n   * Pass `'*'` to receive every domain event.\n   */\n  onPattern(\n    pattern: string,\n    handler: (event: DomainEvent) => void,\n    opts?: SubscribeOptions\n  ): () => void;\n\n  /**\n   * Snapshot read of the most-recent matching events. Pass `null`\n   * for `name` to read across all names. `limit` defaults to 50.\n   *\n   * Returns events in chronological order (oldest first within the\n   * snapshot, which is the same order subscribers see them).\n   */\n  recent(name: DomainEventName | null, limit?: number): DomainEvent[];\n\n  /** Total count of events currently in the ring buffer. */\n  size(): number;\n\n  /**\n   * Manually emit a domain event. Useful for tests, for one-off\n   * signals that don't map cleanly through the translator, or for\n   * domain events that originate outside the logging queue.\n   *\n   * The store enriches the event with `id` + `ts` before fanout, so\n   * callers pass the discriminated `{ name, data }` only. Type\n   * safety is enforced by the discriminated union -- TS narrows\n   * `data` based on `name` at the call site.\n   */\n  emit(event: Omit<DomainEvent, 'id' | 'ts'>): DomainEvent;\n\n  /**\n   * Subscribe to the bus's OWN operational events (translated,\n   * persist-ok/fail, hydrate, ipc.subscribe). Distinct from the\n   * domain-event subscriptions -- this surface mirrors every other\n   * lite module's `onEvent(handler)` per ADR-032.\n   *\n   * Main-process callers only -- not bridged to the renderer.\n   */\n  onEvent(handler: (event: EventBusEvent) => void): () => void;",
            "description": "Subscribe to a single domain event by name. Type narrows the\nhandler's `event.data` automatically.",
            "tags": [],
            "examples": [
              "getEventBusApi().on('user.signed-in', (ev) => {\n  metrics.tag({ accountId: ev.data.accountId });\n});"
            ]
          }
        ]
      },
      "events": {
        "constantName": "EVENT_BUS_EVENTS",
        "count": 8,
        "entries": [
          {
            "constantKey": "TRANSLATED",
            "name": "event-bus.translated",
            "description": ""
          },
          {
            "constantKey": "PERSIST_OK",
            "name": "event-bus.persist.ok",
            "description": ""
          },
          {
            "constantKey": "PERSIST_FAIL",
            "name": "event-bus.persist.fail",
            "description": ""
          },
          {
            "constantKey": "HYDRATE_START",
            "name": "event-bus.hydrate.start",
            "description": ""
          },
          {
            "constantKey": "HYDRATE_FINISH",
            "name": "event-bus.hydrate.finish",
            "description": ""
          },
          {
            "constantKey": "HYDRATE_FAIL",
            "name": "event-bus.hydrate.fail",
            "description": ""
          },
          {
            "constantKey": "IPC_SUBSCRIBE",
            "name": "event-bus.ipc.subscribe",
            "description": ""
          },
          {
            "constantKey": "IPC_RECENT",
            "name": "event-bus.ipc.recent",
            "description": ""
          }
        ]
      },
      "readme": "# `lite/event-bus/` — domain-event pub/sub\n\nPer ADR-043, the event bus sits **on top of** the central logging queue and projects raw module events (`auth.signIn.finish`, `idw.changed`, `main-window.open-tab.finish`, …) into a small, stable catalogue of **domain events** that other systems subscribe to without coupling to module internals.\n\n## Public surface — `getEventBusApi()`\n\n| Method | Purpose |\n|---|---|\n| `on(name, handler, opts?)` | Subscribe to a single domain event by exact name. Type narrows the handler's `event.data`. Returns unsubscribe. |\n| `onPattern(glob, handler, opts?)` | Subscribe via glob (`agent.tab.*`, `*.signed-in`, `*`). Returns unsubscribe. |\n| `recent(name \\| null, limit?)` | Snapshot read of the most-recent matching events from the ring buffer. |\n| `size()` | Count of events currently in the buffer. |\n| `emit(event)` | Manually publish a domain event. Goes through the same fanout + persistence path as translated events. |\n| `onEvent(handler)` | Subscribe to the bus's OWN operational events (translated, persist, hydrate). Main-process only. |\n\nSubscribers receive the full discriminated `DomainEvent` (`{ name, id, ts, data }`). Throws inside a handler are swallowed and logged — a buggy subscriber CANNOT bring down emission.\n\n## Renderer surface — `window.lite.events.*`\n\nSame shape as the main-process API. `recent` / `size` / `emit` are async (Promise-wrapped over IPC); `on` / `onPattern` register a listener directly via the preload-side broadcast channel.\n\n```js\nconst off = window.lite.events.on('user.signed-in', (ev) => {\n  console.log('hello', ev.data.email);\n});\n// later: off();\n\nconst recent = await window.lite.events.recent('agent.tab.opened', 10);\n```\n\n## Subscription contract\n\n- Default: future-only — `on` / `onPattern` returns events that fire *after* registration.\n- Opt-in: `{ replay: true }` — synchronously replay any matching events already in the ring buffer (most-recent-last) before any future events.\n- Snapshot: `recent(name, limit)` — does NOT subscribe; just reads the buffer.\n\n## Domain events (current catalogue)\n\n| Name | Trigger | Payload |\n|---|---|---|\n| `user.signed-in` | `auth.signIn.finish` | `{ env, accountId, email? }` |\n| `user.signed-out` | `auth.signOut.finish` | `{ env }` |\n| `agent.tab.opened` | `main-window.open-tab.finish` (wasFocus=false) | `{ tabId, url, label }` |\n| `agent.tab.focused` | `main-window.open-tab.finish` (wasFocus=true) | `{ tabId, idwId? }` |\n| `agent.tab.closed` | `main-window.close-tab.finish` | `{ tabId }` |\n| `agent.tab.activated` | `main-window.activate-tab.finish` | `{ tabId }` |\n| `token.injected` | `auth.inject-token.finish` (injected=true) | `{ env, partitionPrefix }` |\n| `update.available` | `updater.update-available` | `{ version }` |\n| `update.downloaded` | `updater.update-downloaded` | `{ version }` |\n| `idw.installed` | `idw.store.installed` | `{ id, kind, catalogId }` |\n| `bug-report.submitted` | `bug-report.save.finish` | `{ filePath, redactionBucket }` |\n\nAdding / changing the catalogue is an ADR-worthy event — subscribers depend on the shape staying stable.\n\n## Persistence\n\n- **Ring buffer** (`RING_BUFFER_MAX = 200`): in-memory, evicted oldest-first.\n- **KV mirror** (`lite-event-bus / default`): debounced 500ms after each mutation. Best-effort — on KV failure the in-memory state stays authoritative and the bus retries on the next push.\n- **Hydrate on boot**: `initEventBus()` reads the persisted blob and pre-populates the buffer, so renderer subscribers using `{ replay: true }` immediately after launch see history from the previous session.\n\n## Architecture\n\n```\nauth.signIn.finish event fires\n         ↓\nlogging queue\n         ↓\nevent-bus subscribed ('*')\n         ↓\ntranslator rule for 'auth.signIn.finish'\n         ↓\nDomainEvent { name: 'user.signed-in', data: { env, accountId, email? } }\n         ↓\nring buffer push + KV-debounced persist + EventEmitter fanout\n         ↓\n   ┌─ main-process subscribers (await getEventBusApi().on(...))\n   └─ webContents.send('lite:event-bus:event', ev) → all renderer windows\n                                                      ↓\n                                             window.lite.events.on(name, cb)\n```\n\n## Error catalog\n\n| Code | Meaning |\n|---|---|\n| `EB_UNKNOWN_NAME` | Caller passed a domain event name not in the catalogue. |\n| `EB_INVALID_INPUT` | Subscriber payload failed validation (renderer-side). |\n| `EB_PERSISTENCE_FAILED` | Underlying KV write rejected. Bus stays operational; in-memory state is authoritative. |\n\n## Files\n\n| File | Purpose |\n|---|---|\n| `api.ts` | Public API surface (`getEventBusApi()`) + re-exports. |\n| `types.ts` | `DomainEvent` discriminated union + `DOMAIN_EVENT_NAMES` source-of-truth list + persistence shape. |\n| `translator.ts` | Pure rules table mapping raw `EventRecord` → `DomainEvent`. |\n| `store.ts` | Ring buffer + KV persistence + EventEmitter fanout + glob matching. |\n| `errors.ts` | `EventBusError` + `EVENT_BUS_ERROR_CODES`. |\n| `events.ts` | Bus's OWN typed events (operational telemetry). |\n| `main.ts` | IPC handlers + boot init + cross-window broadcast. |\n\nSee [DECISIONS.md ADR-043](../DECISIONS.md) for the architectural rationale.\n"
    },
    {
      "slug": "health",
      "title": "Health",
      "summary": "Health module -- PUBLIC API.\n\nPer ADR-019 / Rule 11 in `lite/LITE-RULES.md`, cross-module imports\ngo through `<module>/api.ts` -- never reach into `store.ts` or\n`main.ts`.\n\nHealth answers \"what is true right now?\" -- a pull-based current-\nstate snapshot across documented lite modules. The counterpart to\nthe central event log (which answers \"what happened over time?\").\nNo mutable state is maintained; every call re-reads.\n\nUsage from another module:\n\n  import { getHealthApi } from '../health/api.js';\n  const snap = await getHealthApi().snapshot();\n  console.log(snap.auth.signedIn, snap.totp.configured);\n\nTests: `_setHealthApiForTesting(stub)` injects a custom\nimplementation, `_resetHealthApiForTesting()` clears the singleton.\n\nSecurity: the snapshot type (and its branches in `types.ts`) has\nNO fields for secrets. Token values, TOTP code/secret, and Neon\npasswords cannot be expressed in the type and are not produced by\nthe default store. See `lite/health/README.md` \"Security posture.\"",
      "surface": {
        "interfaceName": "HealthApi",
        "interfaceDescription": "The public surface of the health module.\n\n**Error contract**: `snapshot()` is best-effort and never throws.\nIf every backing module fails, the returned snapshot is a fully\npopulated object with safe fallback values in each section (e.g.\n`auth.signedIn = false`, `totp.configured = false`).",
        "methods": [
          {
            "name": "snapshot",
            "signature": "snapshot(): Promise<AppHealthSnapshot>",
            "description": "Build a fresh snapshot of \"what is true right now\" across\ndocumented lite modules. Best-effort: missing or failing\nsections produce safe fallbacks rather than throwing.",
            "tags": [
              {
                "tag": "returns",
                "value": "A complete `AppHealthSnapshot`. Always resolved; never\n  rejects."
              }
            ],
            "examples": [
              "import { getHealthApi } from '../health/api.js';\nconst snap = await getHealthApi().snapshot();\nif (!snap.auth.signedIn) showSignInPrompt();"
            ]
          }
        ]
      },
      "events": null,
      "readme": "# `lite/health/` — Health snapshot\n\nA pull-based current-state snapshot of Onereach.ai Lite. Answers **\"what is true right now?\"** — the counterpart to the central event log (which answers \"what happened over time?\").\n\n- **Public API**: [`api.ts`](api.ts) — `HealthApi` interface, `getHealthApi()` singleton\n- **Internal**:\n  - [`store.ts`](store.ts) — `HealthStore` pull-based aggregator (`@internal`)\n  - [`main.ts`](main.ts) — IPC + `initHealth` / `teardown` handle (`@internal`)\n  - [`types.ts`](types.ts) — shape definitions; secret-free by construction\n- **Tests**: [`../test/unit/health-api.test.ts`](../test/unit/health-api.test.ts), [`../test/unit/health-store.test.ts`](../test/unit/health-store.test.ts)\n- **Decision rationale**: [DECISIONS.md ADR-036](../DECISIONS.md#adr-036-pull-based-health-snapshot-separate-from-the-event-log)\n\n---\n\n## What it is\n\nA foundational diagnostic surface used for:\n\n1. Debugging — call `window.lite.health.snapshot()` from devtools to see open windows, sign-in status, TOTP / Neon configuration, recent error counts.\n2. Bug reports — every bug report attaches a `healthSnapshot` so triage can see \"what was the app's state when this was filed?\"\n3. Future Settings → Diagnostics — the eventual diagnostics surface will render this snapshot.\n4. E2E assertions — the harness can call the same snapshot to assert post-condition invariants.\n\nThe snapshot is **best-effort and never throws**. If a backing module is missing or its read fails, that section reports a safe fallback (e.g. `auth.signedIn = false`) and a logger warning is emitted.\n\n---\n\n## Security posture\n\nThe snapshot type **cannot express secrets**. There are no fields for:\n\n- raw `mult` / account tokens or cookies\n- TOTP secret value or current 6-digit code\n- Neon database password\n- API keys\n\nWhat it CAN include (developer-safe diagnostics):\n\n- token presence booleans (`hasMultToken`, `hasAccountToken`)\n- `accountId` / `email`\n- token expiry timestamp (`expiresAt`)\n- TOTP `secretLength` (count, not value)\n- TOTP `secondsRemaining` (1..30 countdown to next code)\n- Neon `hasPassword` boolean\n- Neon `endpoint` / `uri` / `user` / `database` (no auth)\n- window titles / URLs\n- recent error / warn counts\n- `lastError` string (event name + redacted message)\n\nBug-report redaction still runs over the serialized payload; if a future field accidentally lets a token-shaped string through, the redaction patterns catch it. A unit test asserts that token sentinels in mocked auth bundles do not appear in the final snapshot.\n\n---\n\n## Snapshot shape\n\n```typescript\ninterface AppHealthSnapshot {\n  schemaVersion: 1;\n  capturedAt: string;        // ISO timestamp\n  app: {\n    version: string;\n    platform: NodeJS.Platform;\n    arch: string;\n    uptimeMs: number;\n    userDataPath: string;\n    startedAt: number;        // ms epoch\n  };\n  windows: Array<{\n    id: number;\n    title: string;\n    url: string;\n    type: 'main' | 'settings' | 'auth' | 'bug-report' | 'about' | 'api-docs' | 'unknown';\n    focused: boolean;\n    visible: boolean;\n    destroyed: boolean;\n  }>;\n  auth: {\n    signedIn: boolean;\n    environment: 'edison';\n    accountId?: string;\n    email?: string;\n    hasMultToken: boolean;\n    hasAccountToken: boolean;\n    expiresAt?: number;\n  };\n  totp: {\n    configured: boolean;\n    metadata?: { issuer?: string; account?: string; secretLength?: number };\n    hasCurrentCode: boolean;\n    secondsRemaining?: number;\n  };\n  neon: {\n    configured: boolean;\n    ready: boolean;\n    endpoint?: string;\n    uri?: string;\n    user?: string;\n    database?: string;\n    hasPassword: boolean;\n  };\n  updater: {\n    failedAttempts: number;\n    lastAttemptVersion: string | null;\n    lastAttemptTime: string | null;\n  };\n  diagnostics: {\n    recentErrorCount: number;\n    recentWarnCount: number;\n    lastError?: string;\n  };\n}\n```\n\nSee [`types.ts`](types.ts) for the authoritative definitions.\n\n---\n\n## Consumer examples\n\n### Main process\n\n```typescript\nimport { getHealthApi } from '../health/api.js';\n\nconst snap = await getHealthApi().snapshot();\nif (!snap.auth.signedIn) {\n  // Surface a sign-in prompt before triggering a feature that needs auth.\n}\nif (snap.diagnostics.recentErrorCount > 5) {\n  // Trip a degraded-mode banner.\n}\n```\n\n### Renderer\n\n```typescript\nconst snap = await window.lite.health.snapshot();\nconsole.table(snap.windows);\n```\n\n### Bug-report integration\n\nThe bug-report module calls `getHealthApi().snapshot()` when assembling the capture payload (see [`../bug-report/main.ts`](../bug-report/main.ts) `buildPayload`). The snapshot lands in the saved record as the optional `healthSnapshot` field. If the snapshot fetch fails, the bug report is filed anyway — the snapshot is supplementary diagnostic context, not load-bearing evidence.\n\n---\n\n## API quick reference\n\n| Method | Returns | Throws? | Notes |\n|---|---|---|---|\n| `snapshot()` | `Promise<AppHealthSnapshot>` | No | Best-effort. Always resolved. Re-reads on every call (no cache). |\n\nSee [`api.ts`](api.ts) for full JSDoc and the `HEALTH_SCHEMA_VERSION` constant.\n\n---\n\n## Renderer bridge (`window.lite.health`)\n\n```typescript\nconst snap = await window.lite.health.snapshot();\n```\n\nThe bridge is shared between renderers — Settings → Diagnostics (future), placeholder window devtools, and any future health-aware affordance can call it without main-process plumbing. The IPC channel is `lite:health:snapshot` (registered by `initHealth` in [`main.ts`](main.ts)).\n\n---\n\n## Failure modes\n\n| Module | What can fail | Snapshot behavior |\n|---|---|---|\n| `auth` | `getSession` / `getToken` throw | `auth.signedIn = false`, all booleans `false`, no `accountId`/`email` |\n| `totp` | `hasSecret` throws | `totp.configured = false`, `hasCurrentCode = false` |\n| `totp` | `getCurrentCode` throws when configured | `totp.configured = true`, `hasCurrentCode = false`, `secondsRemaining` omitted |\n| `totp` | `getMetadata` throws when configured | snapshot still includes `configured = true`, no `metadata` |\n| `neon` | `status()` throws | `neon.configured = false`, `ready = false`, `hasPassword = false` |\n| `updater` | `readUpdateState` throws | `failedAttempts = 0`, `lastAttemptVersion = null` |\n| `diagnostics` | `recent('*', 200)` throws | counts `0`, no `lastError` |\n| `windows` | `getAllWindows()` throws | `windows: []` |\n\nEach failure path is exercised in [`../test/unit/health-store.test.ts`](../test/unit/health-store.test.ts).\n\n---\n\n## Why pull-based, not push-based?\n\nA push-based \"global mutable health object\" was considered. Rejected:\n\n- Push requires every module that mutates state to know to update the shared object.\n- The shared object becomes a coupling magnet — easy to add to, hard to remove from, hardest to know what's stale.\n- Reads with stale data are worse than reads that take 5ms to walk live state.\n- Pull-based reads compose with the modular API pattern (Rule 11 / ADR-019): each section reader calls only the relevant module's `<module>/api.ts`.\n\nPull-based is also testable: each section's reader is independently injectable (see [`store.ts`](store.ts) `HealthStoreConfig`).\n\n---\n\n## Borrowed patterns (studied, never imported)\n\nPer LITE-RULES.md cherry-pick discipline:\n\n- Full app health-monitor.js (in `lib/health-monitor.js`) — borrowed the high-level concept of an aggregating snapshot. Lite's version is far simpler (no SLI metrics, no rolling window) and is tightly scoped to documented lite modules.\n\nAll rewritten in TS-strict within `lite/health/`. No `import` from full's root files or `packages/`.\n"
    },
    {
      "slug": "idw",
      "title": "Idw",
      "summary": "IDW module -- PUBLIC API.\n\nThe only file other lite modules should import from in this module.\nPer ADR-019 / Rule 11 in `lite/LITE-RULES.md`, cross-module imports\ngo through `<module>/api.ts` -- never reach into `store.ts`,\n`menu-builder.ts`, or any other internal file.\n\nThe IDW module hosts the top-level \"IDW\" menu and the persistence\nlayer behind it. Six kinds of entries (IDWs, External Bots, Image\nCreators, Video Creators, Audio Generators, UI Design Tools) live\nin one unified data model. See `./types.ts` for the discriminated\n`IdwEntry` shape and `./kind-metadata.ts` for the per-kind UI +\nvalidation table.\n\nTests: `_setIdwApiForTesting(stub)` to inject a custom\nimplementation, `_resetIdwApiForTesting()` to clear the singleton.",
      "surface": {
        "interfaceName": "IdwApi",
        "interfaceDescription": "The public surface of the IDW module.\n\n**Error contract**: `add` / `update` / `remove` throw `IdwError`\n(extends `LiteError`) on failure. Inspect `.code` to branch on\n`IDW_NOT_FOUND`, `IDW_INVALID_INPUT`, `IDW_INVALID_URL`,\n`IDW_DUPLICATE`, `IDW_KIND_MISMATCH`, `IDW_PERSISTENCE_FAILED`.\n`list` / `listByKind` / `get` do not throw; they return empty /\nnull on failure.\n\n**Renderer surface**: `list`, `listByKind`, `get`, `add`, `update`,\n`remove`, `openStore`, `onChange`, `parseError` are bridged via\n`window.lite.idw.*`. The main-process-only `onEvent` is not\nbridged (use `window.logging.recent('idw.*')` from the renderer\nif you need historical events).",
        "methods": [
          {
            "name": "list",
            "signature": "list(): Promise<IdwEntry[]>",
            "description": "All entries, in storage order.",
            "tags": [],
            "examples": []
          },
          {
            "name": "listByKind",
            "signature": "listByKind(kind: AgentKind): Promise<IdwEntry[]>",
            "description": "Entries of the given kind only, in storage order.",
            "tags": [],
            "examples": []
          },
          {
            "name": "get",
            "signature": "get(id: string): Promise<IdwEntry | null>",
            "description": "Single entry by id, or null if absent.",
            "tags": [],
            "examples": []
          },
          {
            "name": "add",
            "signature": "add(entry: Partial<IdwEntry> & Pick<IdwEntry, 'kind' | 'label' | 'url'>): Promise<AddResult>",
            "description": "Add a new entry, OR (for `source='store'` entries with a matching\n`storeMetadata.catalogId`) update the existing one in place.\nReturns `{ entry, wasUpdate }` so callers can show \"Installed\"\nvs \"Updated\" toasts.",
            "tags": [
              {
                "tag": "throws",
                "value": "{IdwError} `IDW_DUPLICATE` if an explicit `id` collides."
              },
              {
                "tag": "throws",
                "value": "{IdwError} `IDW_INVALID_INPUT` for missing / wrong-type fields."
              },
              {
                "tag": "throws",
                "value": "{IdwError} `IDW_INVALID_URL` for non-http/https URLs."
              },
              {
                "tag": "throws",
                "value": "{IdwError} `IDW_KIND_MISMATCH` when a Store re-install changes kind."
              },
              {
                "tag": "throws",
                "value": "{IdwError} `IDW_PERSISTENCE_FAILED` if KV write rejects."
              }
            ],
            "examples": []
          },
          {
            "name": "update",
            "signature": "update(id: string, patch: Partial<IdwEntry>): Promise<IdwEntry>",
            "description": "Update mutable fields on an existing entry. `kind` cannot change.",
            "tags": [
              {
                "tag": "throws",
                "value": "{IdwError} `IDW_NOT_FOUND` if no entry with `id`."
              },
              {
                "tag": "throws",
                "value": "{IdwError} `IDW_KIND_MISMATCH` if patch tries to change kind."
              },
              {
                "tag": "throws",
                "value": "{IdwError} `IDW_INVALID_URL` for invalid url/apiUrl."
              },
              {
                "tag": "throws",
                "value": "{IdwError} `IDW_INVALID_INPUT` for invalid label / audio sub."
              },
              {
                "tag": "throws",
                "value": "{IdwError} `IDW_PERSISTENCE_FAILED` if KV write rejects."
              }
            ],
            "examples": []
          },
          {
            "name": "remove",
            "signature": "remove(id: string): Promise<void>",
            "description": "Remove an entry.",
            "tags": [
              {
                "tag": "throws",
                "value": "{IdwError} `IDW_NOT_FOUND` if no entry with `id`."
              },
              {
                "tag": "throws",
                "value": "{IdwError} `IDW_PERSISTENCE_FAILED` if KV write rejects."
              }
            ],
            "examples": []
          },
          {
            "name": "onChange",
            "signature": "onChange(handler: (entries: IdwEntry[]) => void): () => void;\n  /**\n   * Subscribe to typed IDW events (ADR-032). Returns an unsubscribe\n   * function.\n   */\n  onEvent(handler: (event: IdwEvent) => void): () => void;",
            "description": "Subscribe to mutations. Handler receives the latest entries each\ntime `add` / `update` / `remove` runs successfully. Returns an\nunsubscribe function.",
            "tags": [],
            "examples": []
          }
        ]
      },
      "events": {
        "constantName": "IDW_EVENTS",
        "count": 24,
        "entries": [
          {
            "constantKey": "ADD_START",
            "name": "idw.add.start",
            "description": ""
          },
          {
            "constantKey": "ADD_FINISH",
            "name": "idw.add.finish",
            "description": ""
          },
          {
            "constantKey": "ADD_FAIL",
            "name": "idw.add.fail",
            "description": ""
          },
          {
            "constantKey": "UPDATE_START",
            "name": "idw.update.start",
            "description": ""
          },
          {
            "constantKey": "UPDATE_FINISH",
            "name": "idw.update.finish",
            "description": ""
          },
          {
            "constantKey": "UPDATE_FAIL",
            "name": "idw.update.fail",
            "description": ""
          },
          {
            "constantKey": "REMOVE_START",
            "name": "idw.remove.start",
            "description": ""
          },
          {
            "constantKey": "REMOVE_FINISH",
            "name": "idw.remove.finish",
            "description": ""
          },
          {
            "constantKey": "REMOVE_FAIL",
            "name": "idw.remove.fail",
            "description": ""
          },
          {
            "constantKey": "CHANGED",
            "name": "idw.changed",
            "description": ""
          },
          {
            "constantKey": "OPENED",
            "name": "idw.opened",
            "description": ""
          },
          {
            "constantKey": "STORE_OPENED",
            "name": "idw.store.opened",
            "description": ""
          },
          {
            "constantKey": "STORE_INSTALLED",
            "name": "idw.store.installed",
            "description": ""
          },
          {
            "constantKey": "STORE_UPDATED",
            "name": "idw.store.updated",
            "description": ""
          },
          {
            "constantKey": "BROWSER_LOADING",
            "name": "idw.browser.loading",
            "description": ""
          },
          {
            "constantKey": "BROWSER_LOADED",
            "name": "idw.browser.loaded",
            "description": ""
          },
          {
            "constantKey": "IPC_LIST",
            "name": "idw.ipc.list",
            "description": ""
          },
          {
            "constantKey": "IPC_LIST_BY_KIND",
            "name": "idw.ipc.list-by-kind",
            "description": ""
          },
          {
            "constantKey": "IPC_GET",
            "name": "idw.ipc.get",
            "description": ""
          },
          {
            "constantKey": "IPC_ADD",
            "name": "idw.ipc.add",
            "description": ""
          },
          {
            "constantKey": "IPC_UPDATE",
            "name": "idw.ipc.update",
            "description": ""
          },
          {
            "constantKey": "IPC_REMOVE",
            "name": "idw.ipc.remove",
            "description": ""
          },
          {
            "constantKey": "IPC_OPEN",
            "name": "idw.ipc.open",
            "description": ""
          },
          {
            "constantKey": "IPC_OPEN_STORE",
            "name": "idw.ipc.open-store",
            "description": ""
          }
        ]
      },
      "readme": "# lite/idw -- IDW menu, manage UI, OAGI Store, placeholder browser\n\nPublic surface: `getIdwApi()` from `./api.ts`. Renderer surface:\n`window.lite.idw`.\n\nThis module owns the top-level **IDW** menu in Lite, the\nmanage-agents Settings section, the OAGI-driven catalog window\n(\"OAGI Store\"), and the shared placeholder browser window that\nloads each agent's URL when its menu item is clicked. It is the\nforerunner of the eventual tabbed IDW browser.\n\nThe data model is unified: one `IdwEntry` shape, six `kind` values\n(\"idw\", \"external-bot\", \"image-creator\", \"video-creator\",\n\"audio-generator\", \"ui-design-tool\"). Adding a new kind means\nappending to `AGENT_KINDS` + `KIND_META`.\n\n## Usage\n\n### Main process\n\n```typescript\nimport { getIdwApi, IdwError } from '../idw/api.js';\n\nconst all = await getIdwApi().list();\nconst bots = await getIdwApi().listByKind('external-bot');\n\ntry {\n  await getIdwApi().add({\n    kind: 'external-bot',\n    label: 'ChatGPT',\n    url: 'https://chat.openai.com',\n    source: 'manual',\n  });\n} catch (err) {\n  if (err instanceof IdwError && err.code === 'IDW_INVALID_URL') {\n    // surface to the form\n  }\n}\n```\n\n### Renderer\n\n```typescript\nconst entries = await window.lite!.idw!.list();\n\nconst result = await window.lite!.idw!.add({\n  kind: 'idw',\n  label: 'Sales',\n  url: 'https://chat.example.com/sales',\n  source: 'manual',\n});\n// result.wasUpdate is true if a Store catalogId match triggered an update.\n\n// Subscribe to live cross-window mutations.\nconst unsub = window.lite!.idw!.onChange((latest) => {\n  // re-render\n});\nunsub();\n\n// Open the OAGI Store catalog window.\nawait window.lite!.idw!.openStore();\n```\n\n## Configuration\n\nPersisted in KV collection `lite-idw-entries`, key `default` -- one\nJSON blob:\n\n```typescript\n{\n  schemaVersion: 1,\n  entries: IdwEntry[]\n}\n```\n\nNo second JSON file (unlike the full app). Atomic write semantics\ninherited from `lite/kv/api.ts`.\n\n## Public API surface\n\n| Method | Purpose | Bridged to renderer |\n|---|---|---|\n| `list()` | All entries in storage order | Yes |\n| `listByKind(kind)` | Filter by kind | Yes |\n| `get(id)` | Single entry or null | Yes |\n| `add(entry)` | Insert (or Store-update by catalogId) | Yes |\n| `update(id, patch)` | Mutate fields. `kind` cannot change | Yes |\n| `remove(id)` | Delete | Yes |\n| `onChange(handler)` | Subscribe to mutations | Yes (via broadcast) |\n| `onEvent(handler)` | Subscribe to typed events (ADR-032) | No (main-process only) |\n\n## Per-kind metadata (`./kind-metadata.ts`)\n\n| Kind | Plural | Default emoji | Accent var | Required fields |\n|---|---|---|---|---|\n| `idw` | IDWs | robot | `--accent-idw` | -- |\n| `external-bot` | External Bots | speech balloon | `--accent-external-bot` | -- |\n| `image-creator` | Image Creators | palette | `--accent-image-creator` | -- |\n| `video-creator` | Video Creators | clapper | `--accent-video-creator` | -- |\n| `audio-generator` | Audio Generators | musical note | `--accent-audio-generator` | `audio.subCategory` |\n| `ui-design-tool` | UI Design Tools | paintbrush | `--accent-ui-design-tool` | -- |\n\nAdding a new kind: append to `AGENT_KINDS` in `./types.ts`, append a\nrow to `KIND_META`, optionally add a `--accent-<kind>` variable in\n`./catalog.css` and `lite/settings/settings.css`. The menu builder,\nSettings section, and catalog renderer all pick it up automatically.\n\n## Error catalog\n\nAll errors extend `IdwError` (which extends `LiteError`).\n\n| Code | When | Remediation |\n|---|---|---|\n| `IDW_NOT_FOUND` | `get/update/remove` with unknown id | Refresh -- the entry may have been removed |\n| `IDW_INVALID_INPUT` | Required field missing or wrong type for the kind | Fill the missing field (label, audio sub-cat, etc.) |\n| `IDW_INVALID_URL` | URL missing, malformed, or not http/https | Provide an https:// URL |\n| `IDW_DUPLICATE` | Adding an explicit id that already exists | Use `update()` or pick a different label |\n| `IDW_KIND_MISMATCH` | `update` tries to change kind, OR Store catalogId matches a different kind | Remove + re-add of the desired kind |\n| `IDW_PERSISTENCE_FAILED` | KV write rejected | Check network; the change was not persisted |\n\n## Events (ADR-032)\n\nPer-module typed event surface. Subscribe via `getIdwApi().onEvent(handler)`.\n\nNames (full catalog in `./events.ts`):\n\n- CRUD spans: `idw.add.start/.finish/.fail`,\n  `idw.update.*`, `idw.remove.*`\n- Activity: `idw.changed`, `idw.opened`, `idw.store.opened`,\n  `idw.store.installed`, `idw.store.updated`,\n  `idw.browser.loading`, `idw.browser.loaded`\n- IPC entries (per ADR-030): `idw.ipc.list`, `idw.ipc.list-by-kind`,\n  `idw.ipc.get`, `idw.ipc.add`, `idw.ipc.update`, `idw.ipc.remove`,\n  `idw.ipc.open`, `idw.ipc.open-store`\n\n## Security posture\n\n- **Placeholder browser** (`./browser-window.ts`): NO preload --\n  third-party agent pages must not see `window.lite.*`. Sandboxed\n  + contextIsolated + no node integration. Persistent partition\n  `persist:lite-idw-browser` so cookies / localStorage persist\n  across closures within one shared session for all agents.\n- **Catalog window** (`./catalog-window.ts`): uses the standard Lite\n  preload so it can call `window.lite.neon.query` + `window.lite.idw.*`.\n- **URL validation**: defensive at the `openAgentInBrowser` boundary\n  -- invalid URLs surface a friendly dialog instead of crashing the\n  window. Validation is also enforced in `IdwStore.add/update`.\n- **External link handling**: `setWindowOpenHandler` denies child\n  Electron windows; `window.open()` and `target=\"_blank\"` clicks\n  route to the OS default browser via `shell.openExternal`.\n\n## Hardening roadmap\n\nThe shared placeholder browser is the seam for the eventual tabbed\nbrowser port:\n\n| Phase | Trigger | Change |\n|---|---|---|\n| **N0** -- this PR | -- | One singleton browser window, one URL at a time |\n| **N1** | Tabbed browser port lands | `loadURL(entry.url)` -> `createTabInBrowser(entry)`. Window + partition + security + click wiring all stay the same |\n| **N2** | A kind needs its own window class (e.g. wide aspect for video) | `kind-metadata.ts` grows a `windowFactory` field; click handler reads it |\n| **N3** | Per-kind partitions for security isolation | Replace shared `persist:lite-idw-browser` with `persist:lite-idw-<kind>` |\n\nOther future work documented in the plan (ADR-034 in\n`lite/DECISIONS.md`):\n- Per-IDW partitions (security review)\n- URL-pattern detection (full's `idw-registry.js`) -- belongs with\n  the tabbed browser port\n- Cmd+1..Cmd+9 accelerators (currently per ADR-015 -- no shortcuts)\n\n## File layout\n\n```\nlite/idw/\n  README.md          (this file)\n  api.ts             PUBLIC -- IdwApi, IdwError, IDW_ERROR_CODES, IDW_EVENTS, isIdwEvent, types\n  store.ts           INTERNAL -- IdwStore (KV-backed; validation; emits change + events)\n  events.ts          INTERNAL -- IDW_EVENTS, IdwEvent union, isIdwEvent\n  errors.ts          INTERNAL -- IdwError, IDW_ERROR_CODES\n  types.ts           INTERNAL -- IdwEntry, AgentKind, AudioSubCategory, AGENT_KINDS\n  kind-metadata.ts   INTERNAL -- KIND_META table (per-kind labels, accents, validation)\n  main.ts            INTERNAL -- initIdw() registers IPC, menu, window factories\n  menu-builder.ts    INTERNAL -- top:idw + per-kind sections + always-present items\n  browser-window.ts  INTERNAL -- shared placeholder browser singleton\n  catalog-window.ts  INTERNAL (main) -- catalog window factory\n  catalog-renderer.ts INTERNAL (renderer) -- entry: idw-store.js\n  catalog.html       INTERNAL (renderer) -- copied as idw-store.html\n  catalog.css        INTERNAL (renderer) -- copied as idw-store.css\n```\n\nPer Rule 11, **only `api.ts` is importable from other modules.**\n\n## Tests\n\n- `lite/test/unit/idw-api.test.ts` -- `runApiConformanceContract` +\n  `runErrorConformanceContract` + behavior\n- `lite/test/unit/idw-store.test.ts` -- per-kind validation,\n  dedupe-by-id, Store-update vs duplicate, KV round-trip\n- `lite/test/unit/idw-menu-builder.test.ts` -- top-level\n  registration, kind partitioning, empty-section omission, audio\n  sub-category submenus, click routing\n- `lite/test/unit/idw-types.test.ts` -- KIND_META completeness +\n  per-kind contracts\n- `lite/test/integration/idw-integration.test.ts` -- end-to-end\n  store + menu rebuild + multi-listener onChange\n- `lite/test/integration/typed-onevent.test.ts` -- IdwApi.onEvent\n  typed narrowing block\n- `lite/test/integration/event-coverage.test.ts` -- IDW module\n  emits spans for every op block\n\nThe Settings section (`lite/settings/sections/idws.ts`) is\nintentionally NOT unit-tested here -- per the plan's review fix,\nsections aren't unit-tested anywhere in lite today; manual smoke +\nfuture E2E covers it.\n\n## Borrowed patterns (studied, not imported)\n\n- `lib/menu-sections/idw-gsx-builder.js` (full app) -- per-IDW menu\n  shape (label + click handler emitting an action). Lite drops the\n  `accelerator: index < 9 ? 'CmdOrCtrl+...' : undefined` line per\n  ADR-015. Section structure (IDWs / External Bots / Image Creators\n  / etc.) mirrored 1-to-1.\n- `menu-data-manager.js` (full app) -- the validate / atomic-save /\n  debounced-refresh pattern. Lite simplifies: single KV blob, no\n  debounce (KV is fast and `onChange` is rare).\n- `omnigraph-client.js:getIDWDirectory` (full app) -- catalog\n  Cypher + graph-node-to-renderer mapping. Ported inline into\n  `lite/idw/catalog-renderer.ts`.\n- `idw-store.html` (full app) -- catalog visual layout (cards,\n  search, categories). Lite ports the structure as TS-strict\n  modular form, dropping inline scripts.\n- `lite/api-docs/window.ts` -- single-instance window factory pattern.\n- `lite/settings/sections/two-factor.ts` -- expandable inline form\n  pattern + `window.confirm` for destructive actions.\n"
    },
    {
      "slug": "kv",
      "title": "KV",
      "summary": "KV module -- PUBLIC API.\n\nThis is the only file other lite modules should import from in this\nmodule. Per ADR-019 and ADR-020 (and Rule 11 in lite/LITE-RULES.md),\ncross-module imports go through `<module>/api.ts` -- never reach into\n`client.ts` or any other internal file.\n\nUsage from a consumer module:\n\n  import { getKVApi, KVError } from '../kv/api.js';\n  const kv = getKVApi();\n  await kv.set('my-collection', 'key-1', { foo: 'bar' });\n  const value = await kv.get('my-collection', 'key-1');\n\nCollection names are the consumer's responsibility -- the KV module\nhas no opinion on naming or schema. (E.g. bug-report uses\n`lite-bugs`; future settings module would use its own.)\n\nTests: `_setKVApiForTesting(stub)` to inject a custom implementation,\n`_resetKVApiForTesting()` to clear the singleton.",
      "surface": {
        "interfaceName": "KVApi",
        "interfaceDescription": "The public surface of the KV module. Mirrors the underlying Edison\nkey-value HTTP API.\n\n**Error contract**: every method throws `KVError` (which extends\n`LiteError`) on network or server failures. Inspect `.code` for\nbranching (`KV_TIMEOUT`, `KV_HTTP`, `KV_NETWORK`), `.context` for\ndiagnostic fields, `.remediation` for a user-facing hint. See\n`lite/kv/README.md` for the full error catalog.\n\n**Collection naming**: collections are unscoped strings; the consumer\npicks the namespace (e.g. bug-report uses `lite-bugs`). The KV module\ndoes not enforce naming conventions.\n\n**Serialization**: values are JSON-encoded on the wire. Anything that\nsurvives `JSON.stringify` round-trips correctly; functions, undefined,\nMaps, Dates-as-Date-objects, etc. do not.",
        "methods": [
          {
            "name": "set",
            "signature": "set(collection: string, key: string, value: unknown): Promise<void>",
            "description": "Set (upsert) a record. Idempotent: writing the same key twice\noverwrites silently.",
            "tags": [
              {
                "tag": "param",
                "value": "collection Logical namespace; consumers pick (e.g. `lite-bugs`)."
              },
              {
                "tag": "param",
                "value": "key Unique within the collection."
              },
              {
                "tag": "param",
                "value": "value Anything `JSON.stringify`-able."
              },
              {
                "tag": "returns",
                "value": "Resolves when the server confirms the write."
              },
              {
                "tag": "throws",
                "value": "{KVError} `KV_TIMEOUT` if no response within configured timeout."
              },
              {
                "tag": "throws",
                "value": "{KVError} `KV_HTTP` if the server returned a non-2xx status."
              },
              {
                "tag": "throws",
                "value": "{KVError} `KV_NETWORK` if `fetch` itself rejected (DNS/TLS/etc)."
              }
            ],
            "examples": [
              "import { getKVApi, KVError } from '../kv/api.js';\ntry {\n  await getKVApi().set('settings', 'theme', { mode: 'dark' });\n} catch (err) {\n  if (err instanceof KVError && err.code === 'KV_TIMEOUT') retry();\n  else throw err;\n}"
            ]
          },
          {
            "name": "get",
            "signature": "get(collection: string, key: string): Promise<unknown | null>",
            "description": "Get a single record by key.",
            "tags": [
              {
                "tag": "param",
                "value": "collection The collection that holds the key."
              },
              {
                "tag": "param",
                "value": "key The key to look up."
              },
              {
                "tag": "returns",
                "value": "The deserialized value, or `null` if the key is absent.\n  `null` is also returned for the upstream \"No data found\" sentinel,\n  so callers don't need to handle two not-found shapes."
              },
              {
                "tag": "throws",
                "value": "{KVError} `KV_TIMEOUT` | `KV_HTTP` | `KV_NETWORK`. Note:\n  missing-key is NOT an error -- it returns `null`."
              }
            ],
            "examples": [
              "const settings = await getKVApi().get('settings', 'theme');\nif (settings === null) {\n  // First-run -- write defaults.\n}"
            ]
          },
          {
            "name": "listKeys",
            "signature": "listKeys(collection: string): Promise<string[]>",
            "description": "List all keys in a collection. Values are not fetched; use\n{@link KVApi.list} or follow up with `get()` per key.",
            "tags": [
              {
                "tag": "param",
                "value": "collection The collection to enumerate."
              },
              {
                "tag": "returns",
                "value": "Array of keys (order is not guaranteed). Empty array if\n  the collection is empty or has never been written."
              },
              {
                "tag": "throws",
                "value": "{KVError} `KV_TIMEOUT` | `KV_HTTP` | `KV_NETWORK`."
              }
            ],
            "examples": [
              "const keys = await getKVApi().listKeys('settings');\n// ['theme', 'language', ...]"
            ]
          },
          {
            "name": "list",
            "signature": "list(collection: string): Promise<KVRecord[]>",
            "description": "List keys + fetch each value in parallel. Convenience for callers\nthat want the full set in one call.\n\n**Cost**: 1 `listKeys` + N `get` requests in parallel. For large\ncollections, prefer `listKeys()` + per-key `get()` with your own\nbatching.\n\n**Partial-failure behavior**: per-key `get()` failures are logged\nand skipped, so a partial fetch still returns useful data. The top\n`list()` call only throws if `listKeys()` itself fails.",
            "tags": [
              {
                "tag": "param",
                "value": "collection The collection to enumerate."
              },
              {
                "tag": "returns",
                "value": "Array of `{ key, value }` records. Skips records whose\n  per-key `get()` failed."
              },
              {
                "tag": "throws",
                "value": "{KVError} `KV_TIMEOUT` | `KV_HTTP` | `KV_NETWORK` from the\n  underlying `listKeys()` call."
              }
            ],
            "examples": [
              "const records = await getKVApi().list('lite-bugs');\nfor (const { key, value } of records) {\n  console.log(key, value);\n}"
            ]
          },
          {
            "name": "delete",
            "signature": "delete(collection: string, key: string): Promise<void>",
            "description": "Delete a record. The upstream flow's DELETE may time out but\ntypically succeeds; treat timeouts as advisory.",
            "tags": [
              {
                "tag": "param",
                "value": "collection The collection holding the record."
              },
              {
                "tag": "param",
                "value": "key The key to delete."
              },
              {
                "tag": "returns",
                "value": "Resolves once the server confirms the delete."
              },
              {
                "tag": "throws",
                "value": "{KVError} `KV_TIMEOUT` | `KV_HTTP` | `KV_NETWORK`."
              }
            ],
            "examples": [
              "await getKVApi().delete('settings', 'theme');"
            ]
          },
          {
            "name": "onEvent",
            "signature": "onEvent(handler: (event: KvEvent) => void): () => void;",
            "description": "Subscribe to typed KV events (ADR-032). The handler receives a\ndiscriminated union (`KvEvent`) -- branch on `ev.name` for\ntype-narrowed access to `ev.data` / `ev.durationMs` / `ev.error`.\n\nReturns an unsubscribe function. Subscribing N times produces N\nhandlers; unsubscribe each independently. Subscribers that throw\nare isolated from other subscribers (see `LoggingApi.onEvent`).",
            "tags": [],
            "examples": [
              "const unsub = getKVApi().onEvent((ev) => {\n  switch (ev.name) {\n    case 'kv.set.finish':\n      metrics.timing('kv.set', ev.durationMs);\n      break;\n    case 'kv.set.fail':\n      sentry.capture(ev.data.error);\n      break;\n  }\n});\n// ... later\nunsub();"
            ]
          }
        ]
      },
      "events": {
        "constantName": "KV_EVENTS",
        "count": 15,
        "entries": [
          {
            "constantKey": "SET_START",
            "name": "kv.set.start",
            "description": ""
          },
          {
            "constantKey": "SET_FINISH",
            "name": "kv.set.finish",
            "description": ""
          },
          {
            "constantKey": "SET_FAIL",
            "name": "kv.set.fail",
            "description": ""
          },
          {
            "constantKey": "GET_START",
            "name": "kv.get.start",
            "description": ""
          },
          {
            "constantKey": "GET_FINISH",
            "name": "kv.get.finish",
            "description": ""
          },
          {
            "constantKey": "GET_FAIL",
            "name": "kv.get.fail",
            "description": ""
          },
          {
            "constantKey": "LIST_KEYS_START",
            "name": "kv.listKeys.start",
            "description": ""
          },
          {
            "constantKey": "LIST_KEYS_FINISH",
            "name": "kv.listKeys.finish",
            "description": ""
          },
          {
            "constantKey": "LIST_KEYS_FAIL",
            "name": "kv.listKeys.fail",
            "description": ""
          },
          {
            "constantKey": "LIST_START",
            "name": "kv.list.start",
            "description": ""
          },
          {
            "constantKey": "LIST_FINISH",
            "name": "kv.list.finish",
            "description": ""
          },
          {
            "constantKey": "LIST_FAIL",
            "name": "kv.list.fail",
            "description": ""
          },
          {
            "constantKey": "DELETE_START",
            "name": "kv.delete.start",
            "description": ""
          },
          {
            "constantKey": "DELETE_FINISH",
            "name": "kv.delete.finish",
            "description": ""
          },
          {
            "constantKey": "DELETE_FAIL",
            "name": "kv.delete.fail",
            "description": ""
          }
        ]
      },
      "readme": "# `lite/kv/` — Key-Value Storage\n\nHTTP-backed key-value storage for any lite module. Wraps the OneReach Edison KV flow behind a typed `KVApi`.\n\n- **Public API**: [`api.ts`](api.ts) — `KVApi` interface, `getKVApi()` singleton, error class & codes\n- **Internal**: [`client.ts`](client.ts) — `EdisonKVClient`, the HTTP wrapper. Do not import directly.\n- **Tests**: [`../test/unit/kv-api.test.ts`](../test/unit/kv-api.test.ts), [`../test/unit/kv-client.test.ts`](../test/unit/kv-client.test.ts)\n- **Decision rationale**: [DECISIONS.md ADR-020](../DECISIONS.md#adr-020-kv-promoted-to-top-level-lite-module)\n\n---\n\n## What it is\n\nA flat key/value store partitioned into named **collections**. Values round-trip through JSON. Operations are network calls under the hood — every method can fail and every method tells you exactly why.\n\n```typescript\nimport { getKVApi } from '../kv/api.js';\n\nconst kv = getKVApi();\nawait kv.set('settings', 'theme', { mode: 'dark', accent: '#888' });\nconst theme = await kv.get('settings', 'theme'); // -> { mode: 'dark', ... }\nconst keys = await kv.listKeys('settings');       // -> ['theme', ...]\nconst all = await kv.list('settings');            // -> [{ key, value }, ...]\nawait kv.delete('settings', 'theme');\n```\n\n---\n\n## API quick reference\n\n| Method | Returns | Throws? | Notes |\n|---|---|---|---|\n| `set(coll, key, value)` | `Promise<void>` | Yes | Idempotent upsert. Value JSON-encoded on the wire. |\n| `get(coll, key)` | `Promise<unknown \\| null>` | Network errors only | `null` when key absent. |\n| `listKeys(coll)` | `Promise<string[]>` | Yes | Returns `[]` for empty collection. Order not guaranteed. |\n| `list(coll)` | `Promise<KVRecord[]>` | Yes (only on `listKeys`; per-key get failures are skipped) | Cost: 1 listKeys + N gets in parallel. |\n| `delete(coll, key)` | `Promise<void>` | Yes | Upstream may time out but typically succeeds. |\n\nFull JSDoc with `@throws`/`@example` on every method is in [`api.ts`](api.ts) — your IDE renders it on hover.\n\n---\n\n## Usage patterns\n\n### First-run defaults\n\n```typescript\nconst value = await kv.get('settings', 'theme');\nif (value === null) {\n  await kv.set('settings', 'theme', defaults);\n}\n```\n\n### Per-collection isolation\n\nSame key in different collections is independent:\n\n```typescript\nawait kv.set('coll-a', 'shared', 'A');\nawait kv.set('coll-b', 'shared', 'B');\nawait kv.get('coll-a', 'shared'); // 'A'\nawait kv.get('coll-b', 'shared'); // 'B'\n```\n\n### Soft-failing render\n\nIf you'd rather render an empty UI than an error toast, swallow KV failures:\n\n```typescript\nasync function safeList(collection: string): Promise<KVRecord[]> {\n  try {\n    return await getKVApi().list(collection);\n  } catch (err) {\n    if (err instanceof KVError) console.warn(err.formatForLog());\n    return [];\n  }\n}\n```\n\n### Test injection\n\n```typescript\nimport { _setKVApiForTesting, _resetKVApiForTesting } from '../kv/api.js';\n\nbeforeEach(() => _resetKVApiForTesting());\n\nit('does the thing', () => {\n  const stub: KVApi = { /* in-memory impl */ };\n  _setKVApiForTesting(stub);\n  // run code under test -- it gets the stub\n});\n```\n\n---\n\n## Error catalog\n\nEvery method throws `KVError` (extends [`LiteError`](../errors.ts)) on failure. Stable codes are exported as `KV_ERROR_CODES`.\n\n| Code | When it fires | `.context` fields | Remediation surfaced to user |\n|---|---|---|---|\n| `KV_TIMEOUT` | Request didn't return within the configured timeout (default 5000ms; 2500ms for `listKeys`). | `op`, `collection`, `key?`, `timeoutMs` | \"Check your network connection. If you are on a slow link, the operation may need a longer timeout.\" |\n| `KV_HTTP` | Server returned non-2xx status. Message includes the status. | `op`, `collection`, `key?`, `status`, `body` (truncated 200 chars) | Status-specific: 401/403 → \"endpoint rejected as unauthorized\"; 404 → \"URL is reachable but path returned 404\"; 429 → \"rate-limiting; wait and retry\"; 5xx → \"transient — retry in a few seconds\". |\n| `KV_NETWORK` | Underlying `fetch` rejected (DNS, TCP, TLS, abort-not-timeout). | `op`, `collection`, `key?` | \"Check your network connection (DNS, VPN, captive portal). The Edison KV endpoint may be unreachable.\" |\n\n### Catching\n\n```typescript\nimport { KVError, KV_ERROR_CODES } from '../kv/api.js';\n\ntry {\n  await kv.set('coll', 'key', value);\n} catch (err) {\n  if (err instanceof KVError) {\n    console.error(err.formatForLog());\n    //   [KV_HTTP] KV set failed: HTTP 500 from https://...\n    //     context: {\"op\":\"set\",\"collection\":\"coll\",\"key\":\"key\",\"status\":500,\"body\":\"...\"}\n    //     remediation: The KV endpoint returned a server error. ...\n    //     cause: ...\n\n    if (err.code === KV_ERROR_CODES.TIMEOUT) {\n      return queueRetry();\n    }\n    if (err.code === KV_ERROR_CODES.HTTP && err.status === 429) {\n      return backoff();\n    }\n    toast(err.formatForUser()); // short combined message + remediation\n  }\n  throw err;\n}\n```\n\n---\n\n## Event taxonomy\n\nPer ADR-030, every KV operation emits a span (`<name>.start` / `.finish` or `.fail`) through the central event log. Per ADR-032, these events are exposed as a typed discriminated union (`KvEvent`) and a per-module subscription method (`getKVApi().onEvent()`). The typed catalog is the source of truth -- if it's not in `KV_EVENTS`, no event with that name is emitted.\n\n**Names.** Defined in [`lite/kv/events.ts`](./events.ts) as the `KV_EVENTS` constant:\n\n```typescript\nimport { KV_EVENTS, type KvEvent } from '../kv/api.js';\n// KV_EVENTS.SET_START === 'kv.set.start'\n// KV_EVENTS.SET_FINISH === 'kv.set.finish'\n// ...etc, 15 names total\n```\n\n**Event shapes** (typed via `KvEvent` discriminated union):\n\n| Event | When | Typed payload |\n|---|---|---|\n| `kv.set.start` | Entering `set()` | `data: { collection, key }` |\n| `kv.set.finish` | `set()` HTTP returned 2xx | `durationMs: number` |\n| `kv.set.fail` | `set()` threw `KVError` | `durationMs: number`, top-level `error: { code, message, ... }` |\n| `kv.get.start` | Entering `get()` | `data: { collection, key }` |\n| `kv.get.finish` | `get()` returned (including `null` for not-found) | `durationMs: number` |\n| `kv.get.fail` | `get()` threw `KVError` | `durationMs: number`, top-level `error` |\n| `kv.listKeys.start` / `.finish` / `.fail` | Each `listKeys()` call | `data: { collection }` / `durationMs` / `durationMs + error` |\n| `kv.list.start` / `.finish` / `.fail` | Each composite `list()` call (one outer span; inner listKeys + per-key get spans nested) | `data: { collection }` / `data: { count }` + `durationMs` / `durationMs + error` |\n| `kv.delete.start` / `.finish` / `.fail` | Each `delete()` call | `data: { collection, key }` / `durationMs` / `durationMs + error` |\n\nNote: error info is at the **top level** of the event record (`ev.error`), not inside `ev.data`. This matches the `EventRecord` shape Span.fail emits.\n\n**Subscribing with type narrowing:**\n\n```typescript\nimport { getKVApi, KV_EVENTS, type KvEvent } from '../kv/api.js';\n\nconst unsub = getKVApi().onEvent((ev: KvEvent) => {\n  switch (ev.name) {\n    case KV_EVENTS.SET_FINISH:\n      // ev narrowed to KvSetFinishEvent; ev.durationMs is number\n      metrics.timing('kv.set', ev.durationMs);\n      break;\n    case KV_EVENTS.SET_FAIL:\n      // ev narrowed to KvSetFailEvent; ev.error is SerializedEventError\n      sentry.capture(ev.error);\n      break;\n    case KV_EVENTS.LIST_FINISH:\n      // ev.data is { count: number }\n      console.log(`Listed ${ev.data.count} records`);\n      break;\n  }\n});\n// ... later\nunsub();\n```\n\n`onEvent` filters internally to `kv.*`; consumers never see other modules' events through this handler.\n\nSpans only emit when the consumer wires a `spanEmitter` on the `KVConfig`. The default config in `kv/api.ts` wires it to `getLoggingApi().start()`; tests can pass a stub or omit (silent path).\n\nAdding a new KV event requires updating BOTH `kv/events.ts` (typed constant + interface) AND the emit site. The meta-test in `lite/test/unit/event-name-conformance.test.ts` enforces this: it scans `kv/client.ts` for literal event names and fails if any aren't in `KV_EVENTS`.\n\n## Gotchas\n\n- **Collection names are caller-defined.** The KV module does not enforce naming. Pick a stable string (`lite-bugs`, `settings`, `prefs-<userid>`); never reuse another module's collection.\n- **Values must JSON round-trip.** `Date`, `Map`, `Set`, `BigInt`, functions, `undefined`, and circular refs do not survive `JSON.stringify`. Convert to ISO strings / arrays / numbers / null before `set()`.\n- **Anonymous auth.** The flow URL itself is the bearer of trust. Don't log it. Don't ship it in error messages exposed to users (the URL is masked in `formatForUser()` but appears in `formatForLog()`).\n- **`get()` returns `null` for two cases**: key missing, and upstream \"No data found\" sentinel. Treat both as \"absent\".\n- **`list()` swallows per-key get failures.** A partial list is returned. Inspect logs (`[kv] list per-key get failed`) for diagnostics.\n- **Default timeouts are tuned for the modal**: 5s for `set/get/delete`, 2.5s for `listKeys` (which runs while UI is waiting). Override via `KVConfig.timeoutMs` / `listTimeoutMs` for batch jobs.\n\n---\n\n## Test layering\n\n| Layer | File | Tests | What it asserts |\n|---|---|---|---|\n| HTTP contract | [`../test/unit/kv-client.test.ts`](../test/unit/kv-client.test.ts) | 20 | PUT/GET/POST/DELETE shape, JSON wrapping, \"No data found\" sentinel, timeout/abort, logger. Drives `EdisonKVClient` directly with a mocked `fetch`. |\n| Public-singleton | [`../test/unit/kv-api.test.ts`](../test/unit/kv-api.test.ts) | 6 | `getKVApi()` identity, reset, `_setForTesting` override, full CRUD round-trip via in-memory stub, collection isolation. |\n| Error infrastructure | [`../test/unit/errors.test.ts`](../test/unit/errors.test.ts) | 17 | `LiteError` base behavior, `KVError` is a `LiteError`, body truncation, code branching. |\n\n---\n\n## Internal structure (for contributors)\n\n```\nlite/kv/\n  api.ts         <- you import only from here\n  client.ts      <- HTTP wrapper, @internal\n  README.md      <- this file\n```\n\nThe `EdisonKVClient` class in `client.ts` is `@internal`. It is exported only because TypeScript without a barrel build can't truly hide it; the discipline is enforced by Rule 11 + JSDoc, and dep-cruiser will enforce at build time once Phase 0b lands.\n\nIf you need a method that isn't on `KVApi`, add it to `api.ts` (forward to the underlying client). Don't import `client.ts` from another module.\n"
    },
    {
      "slug": "logging",
      "title": "Logging",
      "summary": "Logging module -- PUBLIC API.\n\nThe only file other lite modules import from in this module. Per\nRule 11 / Rule 12 (LITE-RULES.md) and ADR-019 / ADR-024 / ADR-025\n(DECISIONS.md), cross-module imports go through `<module>/api.ts`.\n\nSurface:\n\n- **Logs** (`debug/info/warn/error(category, message, data?)`) --\n  classic level + category + message lines. Every modules' default\n  logger (e.g. `[bug-report]`, `[kv]`) routes through here so output\n  shows up in the lite log server (`/logs` HTTP, WebSocket, recent\n  buffer).\n\n- **Events** (`event(name, data?, level?)`, `start(name, data?)`) --\n  structured happenings with dotted names. `start()` returns a\n  `Span` that emits `<name>.start` immediately and `<name>.finish` /\n  `<name>.fail` when you call `.finish()` / `.fail()`.\n\n- **Subscriptions** (`onEvent(pattern, handler)`, `recent(pattern, limit?)`) --\n  in-process subscribers can match events by glob pattern; the\n  `recent()` ring buffer lets the bug reporter capture causal\n  context automatically.",
      "surface": {
        "interfaceName": "LoggingApi",
        "interfaceDescription": "The public surface of the logging module.\n\n**Error contract**: `event()`, `start()`, `onEvent()`, `recent()`\nthrow `LoggingError` (extends `LiteError`) on bad input (empty event\nnames, malformed patterns). Log methods (`debug/info/warn/error`)\nnever throw -- they fall back to silent if the underlying queue\nmisbehaves.\n\nSee `lite/logging/README.md` for the full event taxonomy and error\ncatalog.",
        "methods": [
          {
            "name": "debug",
            "signature": "debug(category: string, message: string, data?: unknown): void",
            "description": "Write a debug-level log line.",
            "tags": [],
            "examples": []
          },
          {
            "name": "info",
            "signature": "info(category: string, message: string, data?: unknown): void",
            "description": "Write an info-level log line.",
            "tags": [],
            "examples": []
          },
          {
            "name": "warn",
            "signature": "warn(category: string, message: string, data?: unknown): void",
            "description": "Write a warn-level log line.",
            "tags": [],
            "examples": []
          },
          {
            "name": "error",
            "signature": "error(category: string, message: string, data?: unknown): void",
            "description": "Write an error-level log line.",
            "tags": [],
            "examples": []
          },
          {
            "name": "event",
            "signature": "event(name: string, data?: unknown, level?: LogLevel): void",
            "description": "Emit an instant event. Convention: dotted name `module.action` or\n`module.action.outcome` (e.g. `kv.set`, `bug-report.save.failed`).",
            "tags": [
              {
                "tag": "throws",
                "value": "{LoggingError} `LOGGING_INVALID_EVENT_NAME` if `name` is\n  empty or contains whitespace."
              }
            ],
            "examples": []
          },
          {
            "name": "start",
            "signature": "start(name: string, data?: unknown): Span",
            "description": "Start a span. Returns a {@link Span} you finish() or fail(). Auto-emits\n`<name>.start` now, `<name>.finish` (or `.fail`) when you complete it.",
            "tags": [
              {
                "tag": "throws",
                "value": "{LoggingError} `LOGGING_INVALID_EVENT_NAME` if `name` is\n  empty or contains whitespace."
              }
            ],
            "examples": []
          },
          {
            "name": "onEvent",
            "signature": "onEvent(pattern: string, handler: (event: EventRecord) => void): () => void;\n\n  /**\n   * Synchronously get the last N matching events from the ring buffer.\n   * Returns newest-first.\n   *\n   * @throws {LoggingError} `LOGGING_INVALID_PATTERN` if `pattern` is\n   *   empty.\n   */\n  recent(pattern: string, limit?: number): EventRecord[];",
            "description": "Subscribe to events whose name matches `pattern` (glob: `kv.*`,\n`*.fail`, `*`). Returns an unsubscribe function.",
            "tags": [
              {
                "tag": "throws",
                "value": "{LoggingError} `LOGGING_INVALID_PATTERN` if `pattern` is\n  empty."
              }
            ],
            "examples": []
          }
        ]
      },
      "events": null,
      "readme": "# `lite/logging/` — Centralized Logs + Events\n\nThe single funnel for everything that happens in the lite app. Every log line, every structured event, every span — all flow through this module's API and end up in one place: the lite log queue at port 47392.\n\n- **Public API**: [`api.ts`](api.ts) — `LoggingApi` interface, `getLoggingApi()` singleton, error class & codes\n- **Internal**:\n  - [`store.ts`](store.ts) — `LoggingStore` wrapping the lib `LogEventQueue`. `@internal`.\n  - [`events.ts`](events.ts) — `EventRecord`, `Span`, `matchPattern`, `serializeError`. Re-exported via `api.ts`.\n- **Tests**: [`../test/unit/logging-api.test.ts`](../test/unit/logging-api.test.ts), [`../test/unit/logging-events.test.ts`](../test/unit/logging-events.test.ts), [`../test/integration/logging-flow.test.ts`](../test/integration/logging-flow.test.ts)\n- **Decision rationale**: [DECISIONS.md ADR-025](../DECISIONS.md#adr-025-centralized-event-logger-as-a-module)\n\n---\n\n## What it is\n\nThree coordinated surfaces on a single underlying queue:\n\n1. **Logs** — classic `level + category + message + data`. Goes to the lib queue, the log server (`/logs` HTTP, WebSocket), and the queue's ring buffer.\n2. **Events** — semantic happenings with dotted names (`kv.set`, `bug-report.save.failed`). Same queue mirror, plus a local ring buffer the API exposes via `recent()`.\n3. **Spans** — paired `<name>.start` / `<name>.finish` (or `.fail`) events with correlation ids and `durationMs`. Returned from `start()`; idempotent so try/finally is safe.\n\nModules consume `getLoggingApi()` and never write to `console.log` for production observability. The kernel boot, the updater, bug-report's store-level activity, and KV's HTTP traffic all funnel here.\n\n```typescript\nimport { getLoggingApi } from '../logging/api.js';\n\nconst log = getLoggingApi();\n\n// Logs\nlog.info('settings', 'theme changed', { newTheme: 'dark' });\n\n// Instant event\nlog.event('bug-report.opened');\n\n// Span\nconst span = log.start('kv.set', { collection: 'lite-bugs', key: 'x' });\ntry {\n  await kv.set('lite-bugs', 'x', payload);\n  span.finish({ ok: true });\n} catch (err) {\n  span.fail(err);\n  throw err;\n}\n\n// In-process subscription\nconst unsub = log.onEvent('kv.*', (ev) => console.log(ev.name, ev.data));\nunsub(); // detach when done\n\n// Snapshot the last 50 KV events\nconst recentKv = log.recent('kv.*', 50);\n```\n\n---\n\n## API quick reference\n\n| Method | Returns | Throws? | Notes |\n|---|---|---|---|\n| `debug/info/warn/error(category, message, data?)` | `void` | No | Routes to the lib queue. Never throws. |\n| `event(name, data?, level?)` | `void` | Yes | Validates `name` is non-empty + no whitespace. |\n| `start(name, data?)` | `Span` | Yes | Emits `<name>.start` immediately. Span is idempotent. |\n| `onEvent(pattern, handler)` | `() => void` | Yes | Returns unsubscribe. Pattern: `kv.*`, `*.fail`, `*`. |\n| `recent(pattern, limit?)` | `EventRecord[]` | Yes | Newest-first. Default `limit=50`. |\n\nFull JSDoc with `@throws` / `@example` per method is in [`api.ts`](api.ts) — your IDE renders it on hover.\n\n---\n\n## Event taxonomy\n\nUse dotted names. The first segment becomes the event's `category` (which is also the lib-queue category, so `/logs?category=kv` filters correctly).\n\nConventions:\n\n- **`module.action`** — instant event, no span. E.g. `bug-report.opened`, `app.boot`.\n- **`module.action.outcome`** — completion event. E.g. `kv.set.start`, `kv.set.finish`, `kv.set.fail`.\n- **Use `start()` for spans**, not manual `<x>.start` + `<x>.finish` pairs. Spans wire correlation ids and durations for you.\n- **Lowercase, hyphens for compound module names** (`bug-report.*`), match the module folder name.\n\nWhat NOT to do:\n\n- Whitespace in event names (rejected).\n- Names without a dot — they work but you lose category routing.\n- Event names that change every call (e.g. `kv.set.${key}`) — these blow up the ring buffer's distinct-name index. Use `data` for variability.\n\n---\n\n## Spans\n\n```typescript\nconst span = log.start('bug-report.save', { timestamp: payload.timestamp });\ntry {\n  await store.write(payload);\n  span.finish({ kvWritten: true }); // emits bug-report.save.finish\n} catch (err) {\n  span.fail(err); // emits bug-report.save.fail with serialized error\n  throw err;\n}\n```\n\nSpan semantics:\n\n- **`finish(data?)`** — emits `<name>.finish` with `level: 'info'`, `durationMs`, your `data`.\n- **`fail(error, data?)`** — emits `<name>.fail` with `level: 'error'`, `durationMs`, the serialized error, and your `data`.\n- **Idempotent**: calling `finish()` twice (or `fail()` after `finish()`) is a no-op. Lets you wrap `finish/fail` in `try/finally` without double-emitting.\n- **No nested-span auto-tracking**: child spans must pass `parentSpanId` in `data` if they care.\n\n`LiteError` instances passed to `fail()` serialize to `{ code, message, remediation, context, name }`. Plain `Error` instances become `{ code: 'UNKNOWN', message, name }`. Non-Error values stringify.\n\nSpans are **main-process only**. Renderer code that wants span-shaped instrumentation should emit paired instant events:\n\n```typescript\nwindow.logging.event('save.start', { id });\ntry {\n  await someWork();\n  window.logging.event('save.finish', { id, ok: true });\n} catch (err) {\n  window.logging.event('save.fail', { id, error: String(err) }, 'error');\n  throw err;\n}\n```\n\n---\n\n## Subscriptions\n\nTwo patterns, same buffer:\n\n```typescript\n// 1. Live: be notified when matching events arrive.\nconst unsub = log.onEvent('*.fail', (ev) => {\n  metrics.increment(`failures.${ev.category}`);\n});\n// later\nunsub();\n\n// 2. Snapshot: pull the last N matching events synchronously.\nconst last20 = log.recent('kv.*', 20);\n```\n\nPattern syntax (see `matchPattern` in [`events.ts`](events.ts)):\n\n- `*` — match anything (including empty)\n- `prefix.*` — anything starting with `prefix.` (the dot is required)\n- `*.suffix` — anything ending with `.suffix`\n- `prefix.*.suffix` — both ends, anything in between\n- `exact.name` — exact match only\n\nSubscriber failures are isolated — if your handler throws, the publisher continues to deliver to other subscribers and emits a warning to the queue under category `logging`.\n\n---\n\n## Cross-module event catalog (ADR-030)\n\nEvery lite module that performs work emits structured events through this central log. Event names follow `<module>.<action>` (instant) or `<module>.<action>.start` / `.finish` / `.fail` (span). The first dotted segment becomes the queue category, so `/logs?category=<module>` filters.\n\nPer ADR-032, modules with public APIs additionally expose:\n1. A const-typed event-name catalog (`KV_EVENTS`, `BUG_REPORT_EVENTS`, etc.)\n2. A discriminated union of typed event records (`KvEvent`, `BugReportEvent`, etc.)\n3. A per-module subscription method (`getKVApi().onEvent()`, `getBugReportApi().onEvent()`, etc.) that filters and type-narrows automatically\n\nThe typed events files are the source of truth for what each module emits. A meta-test (`lite/test/unit/event-name-conformance.test.ts`) enforces correspondence between emit-site literals and the typed catalog.\n\n| Module | Events | Typed catalog | Subscription | Docs |\n|---|---|---|---|---|\n| `app` (main-lite.ts) | `app.boot.start` / `.finish` / `.fail`, `app.window-all-closed`, `app.before-quit`, `app.second-instance` | — (no public API) | use `getLoggingApi().onEvent('app.*', ...)` | inline in [`main-lite.ts`](../main-lite.ts) |\n| `window` (main-lite.ts) | `window.main.ready-to-show` / `.closed`, `window.about.ready-to-show` / `.closed` | — | use `getLoggingApi().onEvent('window.*', ...)` | inline in [`main-lite.ts`](../main-lite.ts) |\n| `menu` (build-menu.ts) | `menu.click`, `menu.click.failed` | — | use `getLoggingApi().onEvent('menu.*', ...)` | inline in [`menu/build-menu.ts`](../menu/build-menu.ts) |\n| `kv` | 15 spans (5 ops × 3) | [`KV_EVENTS`](../kv/events.ts) / `KvEvent` | `getKVApi().onEvent(handler)` | [`kv/README.md`](../kv/README.md#event-taxonomy) |\n| `bug-report` | 5 spans (15) + 7 IPC | [`BUG_REPORT_EVENTS`](../bug-report/events.ts) / `BugReportEvent` | `getBugReportApi().onEvent(handler)` | [`bug-report/README.md`](../bug-report/README.md#event-taxonomy) |\n| `auth` | 3 spans (8) + coalesced + session.read + 4 IPC | [`AUTH_EVENTS`](../auth/events.ts) / `AuthEvent` | `getAuthApi().onEvent(handler)` | [`auth/README.md`](../auth/README.md#event-taxonomy) |\n| `updater` | 2 spans (6) + 3 IPC | [`UPDATER_EVENTS`](../updater/events.ts) / `UpdaterEvent` | `onUpdaterEvent(handler)` (free fn; updater handle is nullable across teardown) | inline in [`updater/check.ts`](../updater/check.ts) and [`updater/index.ts`](../updater/index.ts) |\n| `totp` | 7 IPC events (`totp.ipc.<verb>`) | — (deferred until typed events land for totp) | use `getLoggingApi().onEvent('totp.*', ...)` | inline in [`totp/main.ts`](../totp/main.ts) |\n| `logging` | self-events when subscriber callbacks throw (under category `logging`) | — | this module |\n\nGlob patterns to filter:\n\n| Goal | Pattern |\n|---|---|\n| All operations starting | `*.start` |\n| All operation failures | `*.fail` |\n| All KV activity | `kv.*` |\n| All IPC invocations | `*.ipc.*` |\n| All app lifecycle | `app.*` |\n| All boot activity (boot span only) | `app.boot.*` |\n| All window lifecycle | `window.*` |\n\n## Bug-report integration (the streams payoff)\n\nWhen a user files a bug, the report's `recentLogs` field is populated by querying the lite log server's `/logs?limit=200` endpoint. **Because every event written via `event()`, `start()`, `finish()`, `fail()` is mirrored to the lib queue, every event automatically appears in `recentLogs`.**\n\nThis means bug reports get causal context for free:\n\n- A failing `kv.set` emits `kv.set.start` → `kv.set.fail` with serialized error\n- A bug-report `save()` emits `bug-report` log lines on success and on failure\n- All of those land in `recentLogs` redacted, in chronological order\n\nNo instrumentation at the bug-report site needed. If a future round wants a structured `recentEvents: EventRecord[]` field on the payload (instead of just stringified log lines), bump the schema version then; it's purely additive.\n\n---\n\n## Renderer bridge\n\n`window.logging` exposes:\n\n```typescript\ninterface LoggingBridge {\n  debug(category, message, data?): void;\n  info(category, message, data?): void;\n  warn(category, message, data?): void;\n  error(category, message, data?): void;\n  event(name, data?, level?): void;\n  recent(pattern, limit?): Promise<EventRecord[]>;\n  // No `start()` -- spans are main-process only. Use paired events.\n  // No `onEvent()` -- in-process subscription doesn't cross IPC. The\n  // renderer can poll `recent()` if it needs reactive updates.\n}\n```\n\nIPC channels (defined in [`../main-lite.ts`](../main-lite.ts)):\n\n- `lite:logging:enqueue` (one-way) — `debug/info/warn/error`\n- `lite:logging:event` (one-way) — `event()`\n- `lite:logging:recent` (invoke) — `recent()`\n\n---\n\n## Error catalog\n\n`event()`, `start()`, `onEvent()`, `recent()` throw `LoggingError` (extends `LiteError`) on bad input. Codes are exported as `LOGGING_ERROR_CODES`.\n\n| Code | When it fires | Remediation |\n|---|---|---|\n| `LOGGING_INVALID_EVENT_NAME` | Empty event name, or contains whitespace. | Use a non-empty dotted name with no whitespace (e.g. `kv.set`, `bug-report.save.failed`). |\n| `LOGGING_INVALID_PATTERN` | `onEvent` or `recent` got an empty / non-string pattern. | Pass a non-empty glob (`kv.*`, `*.fail`, `*`). |\n\nCatching:\n\n```typescript\nimport { LoggingError, LOGGING_ERROR_CODES } from '../logging/api.js';\n\ntry {\n  log.event('');\n} catch (err) {\n  if (err instanceof LoggingError && err.code === LOGGING_ERROR_CODES.INVALID_EVENT_NAME) {\n    // pass through to the test harness, fail loudly\n  }\n  throw err;\n}\n```\n\nLog methods (`debug/info/warn/error`) **never throw** — they fall back to silent if the underlying queue misbehaves. Failing observability should never cascade into failing the operation being logged.\n\n---\n\n## Test layering\n\n| Layer | File | Tests | What it asserts |\n|---|---|---|---|\n| Public-singleton conformance | [`../test/unit/logging-api.test.ts`](../test/unit/logging-api.test.ts) | 35 | Singleton, reset, `_setForTesting`, all 8 expected methods, error conformance for `LoggingError`, span lifecycle, event emission, recent buffer, onEvent pattern matching, validation throws. |\n| Internal pieces | [`../test/unit/logging-events.test.ts`](../test/unit/logging-events.test.ts) | 16 | `matchPattern` (every glob shape), `serializeError` (LiteError, plain Error, non-Error, circular), `Span` lifecycle (finish, fail, idempotency, accessors). |\n| Real-queue integration | [`../test/integration/logging-flow.test.ts`](../test/integration/logging-flow.test.ts) | 8 | LoggingStore writes to a real queue, spans correlate end-to-end, BugReportStore + EdisonKVClient route logs through the central queue, span around real save/fail flow. |\n\n---\n\n## Internal structure (for contributors)\n\n```\nlite/logging/\n  api.ts          <- you import only from here\n  store.ts        <- LoggingStore + LoggingError, @internal\n  events.ts       <- Event/Span types, matchPattern, serializeError\n  README.md       <- this file\n```\n\nIf you need a method that isn't on `LoggingApi`, add it to `api.ts`. Don't import `store.ts` or `events.ts` from another module (Rule 11).\n\nIf you find yourself wanting log shipping, durable persistence, or remote ingestion: **don't add it here**. The bug reporter is the path off-device for diagnostic data; the queue is local-only by design (see ADR-025 for the rationale).\n"
    },
    {
      "slug": "main-window",
      "title": "Main Window",
      "summary": "Main window module -- PUBLIC API.\n\nThe only file other lite modules should import from in this module.\nPer ADR-019 / Rule 11 in `lite/LITE-RULES.md`, cross-module imports\ngo through `<module>/api.ts` -- never reach into `store.ts`,\n`window.ts`, or any other internal file.\n\nThe main-window module hosts lite's tabbed agent browser. Each tab\nis a sandboxed `WebContentsView` running a third-party agent in its\nown persistent partition. The chrome (tab bar) is a separate\nwebContents loaded from `lite/main-window/chrome.html`.\n\nSee `./types.ts` for `Tab`, `OpenTabInput`, `TabsBlob`. See ADR-038\nin `lite/DECISIONS.md` for the full architectural rationale.\n\nTests: `_setMainWindowApiForTesting(stub)` to inject a custom\nimplementation, `_resetMainWindowApiForTesting()` to clear the singleton.",
      "surface": {
        "interfaceName": "MainWindowApi",
        "interfaceDescription": "The public surface of the main-window module.\n\n**Error contract**: `openTab` / `closeTab` / `activateTab` throw\n`MainWindowError` (extends `LiteError`) on failure. Inspect `.code`\nto branch on `MW_NOT_FOUND`, `MW_INVALID_INPUT`, `MW_INVALID_URL`,\n`MW_DUPLICATE_PARTITION`, `MW_PERSISTENCE_FAILED`. `list` / `get` /\n`getActiveTabId` do not throw; they return empty / null on failure.\n\n**Renderer surface**: `openTab`, `closeTab`, `activateTab`,\n`listTabs`, `getActiveTabId`, `onTabsChanged`, `parseError` are\nbridged via `window.lite.mainWindow.*` to the chrome (tab bar)\nwebContents only -- agent tabs themselves have no preload and\ncannot reach this surface.",
        "methods": [
          {
            "name": "listTabs",
            "signature": "listTabs(): Promise<Tab[]>",
            "description": "All open tabs, in display order.",
            "tags": [],
            "examples": []
          },
          {
            "name": "get",
            "signature": "get(id: string): Promise<Tab | null>",
            "description": "Single tab by id, or null if absent.",
            "tags": [],
            "examples": []
          },
          {
            "name": "getActiveTabId",
            "signature": "getActiveTabId(): Promise<string | null>",
            "description": "Active tab id, or null if no tabs are open.",
            "tags": [],
            "examples": []
          },
          {
            "name": "openTab",
            "signature": "openTab(input: OpenTabInput): Promise<OpenTabResult>",
            "description": "Open a new tab, OR (when `idwId` matches an existing tab) focus\nthe existing one. Returns `{ tab, wasFocus }` so callers can choose\n\"Opened\" vs \"Focused\" toast copy.",
            "tags": [
              {
                "tag": "throws",
                "value": "{MainWindowError} `MW_INVALID_INPUT` for missing / wrong-type fields."
              },
              {
                "tag": "throws",
                "value": "{MainWindowError} `MW_INVALID_URL` for non-http/https URLs."
              },
              {
                "tag": "throws",
                "value": "{MainWindowError} `MW_DUPLICATE_PARTITION` if the generated partition collides."
              },
              {
                "tag": "throws",
                "value": "{MainWindowError} `MW_PERSISTENCE_FAILED` if KV write rejects."
              }
            ],
            "examples": []
          },
          {
            "name": "closeTab",
            "signature": "closeTab(id: string): Promise<void>",
            "description": "Close a tab. If the closed tab was active, picks the next sibling\n(or the previous one if the closed tab was the last). When no tabs\nremain, sets `activeId` to null.",
            "tags": [
              {
                "tag": "throws",
                "value": "{MainWindowError} `MW_NOT_FOUND` if no tab with `id`."
              },
              {
                "tag": "throws",
                "value": "{MainWindowError} `MW_PERSISTENCE_FAILED` if KV write rejects."
              }
            ],
            "examples": []
          },
          {
            "name": "activateTab",
            "signature": "activateTab(id: string): Promise<void>",
            "description": "Set the active tab. The chrome (tab bar) and the window factory\nsubscribe via `onTabsChanged`; activating triggers a view swap.",
            "tags": [
              {
                "tag": "throws",
                "value": "{MainWindowError} `MW_NOT_FOUND` if no tab with `id`."
              },
              {
                "tag": "throws",
                "value": "{MainWindowError} `MW_PERSISTENCE_FAILED` if KV write rejects."
              }
            ],
            "examples": []
          },
          {
            "name": "goHome",
            "signature": "goHome(): Promise<void>",
            "description": "Clear the active tab id without closing any tab -- the chrome's\n\"Home\" pill calls this when the user wants to see the welcome\nview. The window factory hides every tab view when activeId is\nnull, so the chrome's home content shows through. Idempotent.",
            "tags": [],
            "examples": []
          },
          {
            "name": "setTabUrl",
            "signature": "setTabUrl(id: string, url: string): Promise<void>",
            "description": "Update a tab's last-known URL. Called from the window factory on\n`did-navigate-in-page` / `did-navigate` events. Soft-fails on\nunknown ids (race-safe).",
            "tags": [],
            "examples": []
          },
          {
            "name": "setTabLabel",
            "signature": "setTabLabel(id: string, label: string): Promise<void>",
            "description": "Update a tab's display label. Called when a tab's `<title>`\nresolves. Soft-fails on unknown ids.",
            "tags": [],
            "examples": []
          },
          {
            "name": "onTabsChanged",
            "signature": "onTabsChanged(handler: (tabs: Tab[], activeId: string | null) => void): () => void;\n  /**\n   * Subscribe to typed main-window events (ADR-032). Returns an unsubscribe.\n   */\n  onEvent(handler: (event: MainWindowEvent) => void): () => void;",
            "description": "Subscribe to mutations. Handler receives the latest tab list +\nactiveId each time the store mutates. Returns an unsubscribe.",
            "tags": [],
            "examples": []
          }
        ]
      },
      "events": {
        "constantName": "MAIN_WINDOW_EVENTS",
        "count": 18,
        "entries": [
          {
            "constantKey": "OPEN_TAB_START",
            "name": "main-window.open-tab.start",
            "description": ""
          },
          {
            "constantKey": "OPEN_TAB_FINISH",
            "name": "main-window.open-tab.finish",
            "description": ""
          },
          {
            "constantKey": "OPEN_TAB_FAIL",
            "name": "main-window.open-tab.fail",
            "description": ""
          },
          {
            "constantKey": "CLOSE_TAB_START",
            "name": "main-window.close-tab.start",
            "description": ""
          },
          {
            "constantKey": "CLOSE_TAB_FINISH",
            "name": "main-window.close-tab.finish",
            "description": ""
          },
          {
            "constantKey": "CLOSE_TAB_FAIL",
            "name": "main-window.close-tab.fail",
            "description": ""
          },
          {
            "constantKey": "ACTIVATE_TAB_START",
            "name": "main-window.activate-tab.start",
            "description": ""
          },
          {
            "constantKey": "ACTIVATE_TAB_FINISH",
            "name": "main-window.activate-tab.finish",
            "description": ""
          },
          {
            "constantKey": "ACTIVATE_TAB_FAIL",
            "name": "main-window.activate-tab.fail",
            "description": ""
          },
          {
            "constantKey": "CHANGED",
            "name": "main-window.changed",
            "description": ""
          },
          {
            "constantKey": "TAB_NAVIGATED",
            "name": "main-window.tab.navigated",
            "description": ""
          },
          {
            "constantKey": "TAB_LOAD_START",
            "name": "main-window.tab.load-start",
            "description": ""
          },
          {
            "constantKey": "TAB_LOAD_FINISH",
            "name": "main-window.tab.load-finish",
            "description": ""
          },
          {
            "constantKey": "TAB_LOAD_FAIL",
            "name": "main-window.tab.load-fail",
            "description": ""
          },
          {
            "constantKey": "IPC_OPEN_TAB",
            "name": "main-window.ipc.open-tab",
            "description": ""
          },
          {
            "constantKey": "IPC_CLOSE_TAB",
            "name": "main-window.ipc.close-tab",
            "description": ""
          },
          {
            "constantKey": "IPC_ACTIVATE_TAB",
            "name": "main-window.ipc.activate-tab",
            "description": ""
          },
          {
            "constantKey": "IPC_LIST_TABS",
            "name": "main-window.ipc.list-tabs",
            "description": ""
          }
        ]
      },
      "readme": "# lite/main-window -- main window + tab store\n\nPublic surface: `getMainWindowApi()` from `./api.ts`. Renderer\nsurface: `window.lite.mainWindow` (under construction).\n\nThis module owns the Lite main window's `BrowserWindow` factory\nand a per-tab persistence store. Tabs persist to KV (per\n`./store.ts`) so the user's open tabs survive restart.\n\nStatus: **work in progress** -- this README is a stub kept in\nplace so the api-docs manifest test (`api-docs-manifest.test.ts`)\nkeeps passing while the module's public surface stabilizes. Add\nthe full design notes (error catalog, events, partitions, etc.)\nbefore promoting this module out of WIP.\n\n## Sketch\n\n| Method | Purpose |\n|---|---|\n| `openTab(input)` | Create a new tab, persist it, broadcast `lite:main-window:changed` |\n| `closeTab(id)` | Remove a tab by id |\n| `activateTab(id)` | Mark a tab active |\n| `listTabs()` | All tabs in display order |\n| `getActive()` | Currently-active tab id |\n| `goHome()` | Activate the home tab |\n\n## Errors (from `./errors.ts`)\n\n- `MAIN_WINDOW_NOT_FOUND` -- tab id doesn't exist\n- `MAIN_WINDOW_DUPLICATE_PARTITION` -- attempted to open two tabs with the same persistent partition\n- `MAIN_WINDOW_INVALID_URL` -- non-http/https URL passed to `openTab`\n- `MAIN_WINDOW_INVALID_INPUT` -- malformed payload\n- `MAIN_WINDOW_PERSISTENCE_FAILED` -- KV write failed\n\n## File layout\n\n```\nlite/main-window/\n  README.md   (this file -- stub)\n  api.ts      PUBLIC -- MainWindowApi singleton\n  errors.ts   INTERNAL -- MainWindowError\n  events.ts   INTERNAL -- MAIN_WINDOW_EVENTS\n  main.ts     INTERNAL -- initMainWindow(): IPC handlers + window factory wiring\n  store.ts    INTERNAL -- TabStore, KV-backed\n```\n\nPer Rule 11, **only `api.ts` is importable from other modules.**\n"
    },
    {
      "slug": "neon",
      "title": "NEON",
      "summary": "Neon module -- PUBLIC API.\n\nThe only file other lite modules should import from in this module.\nPer ADR-019 / Rule 11 in `lite/LITE-RULES.md`, cross-module imports\ngo through `<module>/api.ts` -- never reach into `client.ts`,\n`credentials.ts`, or any other internal file.\n\nThe Neon module provides Cypher access to a OneReach Neo4j (Neon)\nAura instance via the `/omnidata/neon` Edison flow. Phase N0 ships\na minimal surface (`query`, `ping`, `status`, `configure`,\n`onEvent`); typed CRUD helpers and write-blocking land later as\nseparate ports per `lite/PORTING.md` \"chunk: neon\".\n\n**Security posture (Phase N0)**: credentials travel in the request\nbody. The endpoint is expected to harden later (bearer tokens or\nmTLS); the `CredentialsProvider` abstraction in\n`./credentials.ts` is the seam where the new wire format lands\nwithout changing call sites. See `./README.md` \"Hardening roadmap\".\n\nTests: `_setNeonApiForTesting(stub)` to inject a custom\nimplementation, `_resetNeonApiForTesting()` to clear the singleton.",
      "surface": {
        "interfaceName": "NeonApi",
        "interfaceDescription": "The public surface of the Neon module.\n\n**Error contract**: `query` and `ping` throw `NeonError` (extends\n`LiteError`) on failure. Inspect `.code` to branch on\n`NEON_NOT_CONFIGURED`, `NEON_TIMEOUT`, `NEON_HTTP`, `NEON_NETWORK`,\n`NEON_QUERY`, or `NEON_BAD_INPUT`. `status()` and `onEvent()` do\nnot throw. `configure()` throws on KV write failure (passes through\nthe underlying `KVError`).\n\n**Renderer surface**: `query`, `status`, `testConnection` are\nbridged to the renderer via `window.lite.neon.*`. `configure` is\nintentionally NOT bridged -- credentials writes happen from the\nSettings UI through a dedicated flow.",
        "methods": [
          {
            "name": "query",
            "signature": "query(cypher: string, parameters?: Record<string, unknown>): Promise<NeonRecord[]>",
            "description": "Run a Cypher query against the configured Neon endpoint.",
            "tags": [
              {
                "tag": "param",
                "value": "cypher Non-empty Cypher string. Use bound parameters\n  (`$name`) instead of string-concatenating user input."
              },
              {
                "tag": "param",
                "value": "parameters Bound-parameter map. Values are JSON-serialized\n  on the wire."
              },
              {
                "tag": "returns",
                "value": "Records keyed by Cypher RETURN aliases. Node values are\n  normalized to `{ id, labels, properties }`; relationship values\n  to `{ id, type, start, end, properties }`."
              },
              {
                "tag": "throws",
                "value": "{NeonError} `NEON_NOT_CONFIGURED` when endpoint or\n  credentials are missing."
              },
              {
                "tag": "throws",
                "value": "{NeonError} `NEON_TIMEOUT` if no response within timeout."
              },
              {
                "tag": "throws",
                "value": "{NeonError} `NEON_HTTP` for non-2xx server responses."
              },
              {
                "tag": "throws",
                "value": "{NeonError} `NEON_NETWORK` for fetch-level failures."
              },
              {
                "tag": "throws",
                "value": "{NeonError} `NEON_QUERY` when the server accepted the\n  request but Cypher execution failed."
              },
              {
                "tag": "throws",
                "value": "{NeonError} `NEON_BAD_INPUT` for empty / non-string cypher."
              }
            ],
            "examples": [
              "const rows = await getNeonApi().query(\n  'MATCH (p:Person {email: $email}) RETURN p LIMIT 1',\n  { email: 'rich@example.com' }\n);"
            ]
          },
          {
            "name": "ping",
            "signature": "ping(): Promise<boolean>",
            "description": "Cheap connectivity check. Runs `RETURN 1 AS ok` and returns\n`true` on success. Throws `NeonError` on any failure (so the\ncaller can inspect `.code` for the actual reason).",
            "tags": [],
            "examples": []
          },
          {
            "name": "status",
            "signature": "status(): Promise<NeonStatus>",
            "description": "Read the current Neon client status. Always returns a snapshot;\nnever throws. Includes `ready: true` only when endpoint, URI,\nand password are all configured.",
            "tags": [],
            "examples": []
          },
          {
            "name": "configure",
            "signature": "configure(config: NeonConfig): Promise<void>",
            "description": "Persist a partial configuration update via the active credentials\nprovider. Fields omitted from `config` are left unchanged. Pass\n`password: ''` to clear the password explicitly.\n\n**Main-process only.** This method is intentionally NOT bridged\nto the renderer -- the Settings UI calls it via a dedicated\nsettings IPC, not via `window.lite.neon.configure`.",
            "tags": [
              {
                "tag": "throws",
                "value": "Underlying `KVError` if the persistence layer rejects."
              }
            ],
            "examples": []
          },
          {
            "name": "onEvent",
            "signature": "onEvent(handler: (event: NeonEvent) => void): () => void;",
            "description": "Subscribe to typed Neon events (ADR-032). The handler receives\na discriminated union (`NeonEvent`) -- branch on `ev.name` for\ntype-narrowed access to `ev.data` / `ev.durationMs` / `ev.error`.\n\nReturns an unsubscribe function. Subscribers that throw are\nisolated from other subscribers (see `LoggingApi.onEvent`).",
            "tags": [],
            "examples": [
              "const unsub = getNeonApi().onEvent((ev) => {\n  switch (ev.name) {\n    case 'neon.query.finish':\n      metrics.timing('neon.query', ev.durationMs);\n      break;\n    case 'neon.query.fail':\n      sentry.capture(ev.error);\n      break;\n  }\n});\nunsub();"
            ]
          }
        ]
      },
      "events": {
        "constantName": "NEON_EVENTS",
        "count": 13,
        "entries": [
          {
            "constantKey": "QUERY_START",
            "name": "neon.query.start",
            "description": ""
          },
          {
            "constantKey": "QUERY_FINISH",
            "name": "neon.query.finish",
            "description": ""
          },
          {
            "constantKey": "QUERY_FAIL",
            "name": "neon.query.fail",
            "description": ""
          },
          {
            "constantKey": "PING_START",
            "name": "neon.ping.start",
            "description": ""
          },
          {
            "constantKey": "PING_FINISH",
            "name": "neon.ping.finish",
            "description": ""
          },
          {
            "constantKey": "PING_FAIL",
            "name": "neon.ping.fail",
            "description": ""
          },
          {
            "constantKey": "CONFIGURE_START",
            "name": "neon.configure.start",
            "description": ""
          },
          {
            "constantKey": "CONFIGURE_FINISH",
            "name": "neon.configure.finish",
            "description": ""
          },
          {
            "constantKey": "CONFIGURE_FAIL",
            "name": "neon.configure.fail",
            "description": ""
          },
          {
            "constantKey": "IPC_QUERY",
            "name": "neon.ipc.query",
            "description": ""
          },
          {
            "constantKey": "IPC_STATUS",
            "name": "neon.ipc.status",
            "description": ""
          },
          {
            "constantKey": "IPC_TEST_CONNECTION",
            "name": "neon.ipc.test-connection",
            "description": ""
          },
          {
            "constantKey": "IPC_CONFIGURE",
            "name": "neon.ipc.configure",
            "description": ""
          }
        ]
      },
      "readme": "# lite/neon -- Neon (Neo4j Aura) Cypher client\n\nPublic surface: `getNeonApi()` from `./api.ts`. Renderer surface:\n`window.lite.neon`.\n\nThis module gives Lite first-class, App-API access to a OneReach Neon\n(Neo4j Aura) database via the Edison `/omnidata/neon` flow. **It is\nNOT the full app's `omnigraph-client.js`.** OmniGraph is never\nimported, never referenced. Phase N0 ships a minimal transport;\ntyped CRUD helpers (e.g. `upsertSpace`, `upsertAsset`) arrive with\nthe feature ports that need them.\n\n## Usage\n\n### Main process\n\n```typescript\nimport { getNeonApi, NeonError } from '../neon/api.js';\n\nconst rows = await getNeonApi().query(\n  'MATCH (p:Person {email: $email}) RETURN p LIMIT 1',\n  { email: 'rich@example.com' }\n);\n\ntry {\n  const ok = await getNeonApi().ping();\n} catch (err) {\n  if (err instanceof NeonError && err.code === 'NEON_NOT_CONFIGURED') {\n    // Direct user to Settings -> Neon\n  }\n}\n```\n\n### Renderer\n\n```typescript\nconst result = await window.lite!.neon!.query(\n  'MATCH (n) RETURN count(n) AS c'\n);\nconst status = await window.lite!.neon!.status();\nconst probe  = await window.lite!.neon!.testConnection();\n```\n\n`window.lite.neon.configure(...)` is intentionally **not** exposed.\nThe Settings page calls a different IPC flow (`lite:neon:configure`)\ngated through the Settings -> Neon section.\n\n## Configuration\n\nPersisted in KV collection `lite-neon-config`, key `default`:\n\n```typescript\n{\n  endpoint: string;   // e.g. https://em.edison.api.onereach.ai/http/35254342-.../omnidata/neon\n  uri: string;        // neo4j+s://40c812ef.databases.neo4j.io\n  user: string;       // 'neo4j'\n  password: string;   // <secret>\n  database: string;   // 'neo4j'\n}\n```\n\nThe Settings -> Neon section is the user-facing path. For first-run\nor scripted setup, the same record can be written via the KV API:\n\n```javascript\nawait window.lite.kv.set('lite-neon-config', 'default', { ... });\n```\n\n## Public API surface\n\n| Method | Returns | Throws | Bridged to renderer |\n|---|---|---|---|\n| `query(cypher, params?)` | `NeonRecord[]` | `NeonError` | Yes |\n| `ping()` | `boolean` | `NeonError` | No (use `testConnection`) |\n| `status()` | `NeonStatus` | -- | Yes |\n| `testConnection()` *(IPC only)* | `{ ok, error?, code? }` | -- | Yes |\n| `configure(config)` | `void` | `KVError`, `NeonError` | No (Settings flow only) |\n| `onEvent(handler)` | unsubscribe fn | -- | No |\n\n## Error catalog\n\nAll errors extend `NeonError` (which extends `LiteError`).\n\n| Code | When | Remediation |\n|---|---|---|\n| `NEON_NOT_CONFIGURED` | Endpoint or credentials missing | Open Settings -> Neon and fill in the endpoint URL, URI, and password |\n| `NEON_TIMEOUT` | Request didn't return within timeout (default 30s) | Check network; consider raising timeoutMs |\n| `NEON_HTTP` | Server returned non-2xx | Status-specific (401/403/404/429/5xx all carry tailored hints) |\n| `NEON_NETWORK` | `fetch` rejected before any HTTP response | Check DNS/VPN/captive portal; the endpoint may be unreachable |\n| `NEON_QUERY` | Server accepted but Cypher itself failed | Inspect the Cypher and parameters |\n| `NEON_BAD_INPUT` | Empty / non-string Cypher passed | Pass a non-empty Cypher string |\n\nCatch with either `instanceof NeonError` (Neon-specific) or\n`instanceof LiteError` (generic across all lite modules).\n\n## Events\n\nPer ADR-032, the module emits typed events through the central\nlogging API. Subscribe via `getNeonApi().onEvent(handler)`.\n\nNames (full catalog in `./events.ts`):\n\n- `neon.query.start` / `.finish` / `.fail`\n- `neon.ping.start` / `.finish` / `.fail`\n- `neon.configure.start` / `.finish` / `.fail`\n- `neon.ipc.query`, `neon.ipc.status`, `neon.ipc.test-connection`,\n  `neon.ipc.configure` (instant events; ADR-030)\n\n## Security posture (Phase N0)\n\n**Today**: credentials travel in the request body\n(`neonUri`, `neonUser`, `neonPassword`, `database`). The Edison\n`/omnidata/neon` flow accepts this shape. The renderer can run any\nCypher (read or write) -- same trust boundary as\n`window.lite.kv.set()`.\n\n**Why this is OK for now**: Lite is single-tenant, single-user, with\nno untrusted code in any renderer. The KV creds storage is the same\ntrust boundary the user already accepts for Auth tokens.\n\n**The Settings UI never displays the password back to the renderer**\nonce saved. Status checks return `hasPassword: boolean`, never the\nvalue itself. This matches Auth's main-process-only `getToken`\nposture.\n\n## Hardening roadmap\n\nThe `CredentialsProvider` abstraction in `./credentials.ts` is the\nseam for future security work. Each phase below changes one file\n(plus a switch case in `client.ts:buildRequest`) -- no call site\nchanges:\n\n| Phase | Trigger | Change |\n|---|---|---|\n| **N0** -- this PR | -- | `KVCredentialsProvider` returning `{ kind: 'basic-in-body', ... }` |\n| **N1** | First feature port that needs typed graph ops | New module e.g. `lite/spaces/graph.ts` calls `getNeonApi().query()` |\n| **N2** | Endpoint requires bearer auth | New `BearerCredentialsProvider` (reads from `getAuthApi().getToken('edison')`) + 1 case in `buildRequest` |\n| **N3** | Endpoint requires OAuth2 / mTLS | Add provider variant + switch case |\n| **N4** | Renderer trust needs reduction | Add `cypher` validator at IPC, expose `window.lite.neon.queryRead` / `queryWrite`. Existing `query` becomes `queryWrite` for back-compat |\n\n## Forward-compat (what `lite/neon` will NOT do)\n\n- **Typed CRUD helpers** (`upsertSpace`, `upsertAsset`,\n  `ensurePerson`) -- those land in feature modules\n  (e.g. `lite/spaces/graph.ts`), not here\n- **Cypher escape-string utility** -- callers use bound `parameters`,\n  never string concatenation\n- **Async-job polling pattern** -- `/omnidata/neon` is inline; if a\n  future endpoint switches, add it then\n- **Result chunking for large payloads** -- not needed for graph CRUD\n- **Settings UI** -- already exists via `lite/settings/sections/neon.ts`\n\n## File layout\n\n```\nlite/neon/\n  README.md          (this file)\n  api.ts             PUBLIC -- NeonApi interface, getNeonApi()\n  client.ts          INTERNAL -- EdisonNeonClient (HTTP wrapper)\n  credentials.ts     INTERNAL -- CredentialsProvider + KV/Static providers\n  errors.ts          INTERNAL -- NeonError, NEON_ERROR_CODES\n  events.ts          INTERNAL -- NEON_EVENTS, NeonEvent union, isNeonEvent\n  main.ts            INTERNAL -- initNeon() registers IPC\n  types.ts           INTERNAL -- NeonRecord, NeonNode, NeonRelationship, etc.\n```\n\nPer Rule 11, **only `api.ts` is importable from other modules.** The\nother files are module-internal; tests import them directly through\n`./client.js` / `./credentials.js` paths but no production code does.\n\n## Tests\n\n- `lite/test/unit/neon-api.test.ts` -- `runApiConformanceContract`\n  (Rule 12) + module-specific behavior\n- `lite/test/unit/neon-errors.test.ts` -- `runErrorConformanceContract`\n- `lite/test/unit/neon-client.test.ts` -- HTTP wrapper happy path +\n  every error code\n- `lite/test/unit/neon-credentials.test.ts` -- KV provider round-trip\n  + Static provider semantics\n- `lite/test/integration/neon-integration.test.ts` -- end-to-end\n  through the IPC layer with a fake fetch backend\n\n## Borrowed patterns\n\n- `lite/kv/client.ts` -- timeout/abort/error-normalization shape\n  copied wholesale; only the wire format differs\n- `lite/auth/api.ts` -- \"main-process-only credential\" pattern\n  (`configure` not bridged)\n- `lite/auth/main.ts` -- JSON-error-over-IPC pattern with\n  `parseError` on the renderer side\n- `omnigraph-client.js` (full app) -- *studied for the request body\n  shape only*; no code imported\n"
    },
    {
      "slug": "settings",
      "title": "Settings",
      "summary": "Settings module -- PUBLIC API.\n\nThe only file other lite modules should import from in this module.\nPer ADR-019 / Rule 11 in `lite/LITE-RULES.md`, cross-module imports\ngo through `<module>/api.ts` -- never reach into `main.ts`,\n`window.ts`, or any other internal file.\n\nPer ADR-031, v1 ships one section (Two-Factor). The Settings window\nis opened via the `Onereach.ai Lite -> Settings...` menu entry; the\n`open()` method here is also exposed as `window.lite.settings.open()`\nvia the preload bridge so future placeholder UI (e.g. a Manage 2FA\nbutton) can deep-link in.\n\nNo error class in v1 -- failures inside the Two-Factor section bubble\nthrough `TotpError` (see `lite/totp/api.ts`).\n\nTests: `_setSettingsApiForTesting(stub)` to inject a custom\nimplementation, `_resetSettingsApiForTesting()` to clear the singleton.",
      "surface": {
        "interfaceName": "SettingsApi",
        "interfaceDescription": "The public surface of the Settings module.\n\n**Error contract**: `open()` is fire-and-forget; opening failures are\nlogged but never thrown back to the caller. Section-level failures\nsurface inside the section's UI.",
        "methods": [
          {
            "name": "open",
            "signature": "open(sectionId?: string): void",
            "description": "Open (or focus) the Settings window. Idempotent: subsequent calls\nfocus the existing window instead of opening a second.",
            "tags": [
              {
                "tag": "param",
                "value": "sectionId Optional section to deep-link to (e.g. 'idws',\n  'oagi', 'two-factor'). When provided, the window opens with\n  the matching section activated. When the window is already\n  open, the existing window is focused and switched to the\n  target section. Unknown ids are ignored (renderer falls back\n  to the first section)."
              }
            ],
            "examples": []
          }
        ]
      },
      "events": null,
      "readme": "# `lite/settings/` — Settings window\n\nA small Settings window opened from `Onereach.ai Lite -> Settings...`. v1 ships one section — Two-Factor — which re-hosts the existing TOTP authenticator UI inside the Settings shell. Future sections (Account, Updates, Diagnostics, About) land as additional `mount(el)` functions in `lite/settings/sections/`.\n\n- **Public API**: [`api.ts`](api.ts) — `SettingsApi` interface, `getSettingsApi()` singleton\n- **Internal**:\n  - [`main.ts`](main.ts) — IPC + `initSettings` / `teardown` handle (`@internal`)\n  - [`window.ts`](window.ts) — single-instance `BrowserWindow` factory (`@internal`)\n  - [`types.ts`](types.ts) — `SectionDescriptor` shape\n  - [`settings.html`](settings.html) / [`settings.css`](settings.css) / [`settings.ts`](settings.ts) — renderer shell\n  - [`sections/two-factor.ts`](sections/two-factor.ts) — Two-Factor section renderer (consumes `getTotpApi()` via `window.lite.totp.*`)\n- **Tests**: [`../test/unit/settings-api.test.ts`](../test/unit/settings-api.test.ts)\n- **Decision rationale**: [DECISIONS.md ADR-031](../DECISIONS.md#adr-031-settings-window-with-one-section-per-adr-019-two-factor-migrates-from-standalone-tools-window)\n\n---\n\n## What it is\n\nThe Settings window is the canonical home for configurable surfaces in lite. Its first complete section is Two-Factor, which generates the current GSX / OneReach 2FA code from a saved authenticator secret. Subsequent sections (Account, Updates, Diagnostics, About) are appended to a hand-written list in [`settings.ts`](settings.ts) without changing the shell.\n\nTwo-Factor workflow:\n\n1. Add the OneReach authenticator secret once (scan the setup QR, paste a QR image, or enter the long Base32 secret key).\n2. Settings stores that secret in the OS keychain via `lite/totp/`.\n3. Settings generates the rotating six-digit code (`847 293` style).\n4. During Lite sign-in, the auth popup can auto-fill that generated code when OneReach asks for 2FA. The user can still copy it manually from Settings as a fallback.\n\nThe Two-Factor section does **not** accept the current six-digit login code as input. It accepts the long-lived authenticator secret and then generates the login code used by Lite's sign-in flow.\n\nSecurity notes shown in the UI:\n\n- The authenticator secret is stored in the macOS Keychain / system credential vault.\n- The secret is not written to app settings, logs, bug reports, or KV storage.\n- Lite never shows the saved secret again after setup.\n- Lite only displays the temporary six-digit code, which expires every 30 seconds.\n- Lite reads the same OneReach authenticator secret used by the full Onereach.ai app, so existing full-app 2FA setup can generate codes here too.\n\nThe window opens from `Onereach.ai Lite -> Settings...` (macOS app-menu convention), positioned between About and Quit. No accelerator is bound (`Cmd+,` is the macOS convention but per `.cursorrules` accelerators are user-named, not added speculatively).\n\n```typescript\n// Main-process consumer\nimport { getSettingsApi } from '../settings/api.js';\ngetSettingsApi().open();   // open or focus the Settings window\n```\n\n```typescript\n// Renderer\nawait window.lite.settings.open();\n```\n\n---\n\n## Sections shipped in v1\n\nThe shell renders a sidebar tab + content pane per entry in the `SECTIONS` list (see [`settings.ts`](settings.ts)). Tabs are lazily mounted on first activation and disposed on window close.\n\n| Section id | Title | Implementation |\n|---|---|---|\n| `account` | Account | [`sections/account.ts`](sections/account.ts) -- consumes `window.lite.auth.*`. Sign in / sign out for OneReach Edison. |\n| `two-factor` | Two-Factor | [`sections/two-factor.ts`](sections/two-factor.ts) -- consumes `window.lite.totp.*` to configure the authenticator secret and generate the current GSX / OneReach 2FA code. |\n| `oagi` | OAGI | [`sections/neon.ts`](sections/neon.ts) -- consumes `window.lite.neon.*`. Configure the OAGI / Neon endpoint, Neo4j Aura URI, and credentials. |\n| `updates` | Updates | placeholder copy; auto-update mechanics live in [`lite/updater/`](../updater/) |\n| `diagnostics` | Diagnostics | [`sections/diagnostics.ts`](sections/diagnostics.ts) -- consumes `window.lite.health.snapshot()` (ADR-036). Renders a current-state snapshot across documented Lite modules: app metadata, open windows, auth / TOTP / Neon / updater state, recent error/warn counts. Refresh + Copy as JSON. Snapshot type cannot carry secrets. |\n| `developer` | Developer | [`sections/developer.ts`](sections/developer.ts) -- one button: Open API Reference. |\n| `about` | About | placeholder copy |\n\n---\n\n## API quick reference\n\n| Method | Returns | Throws? | Notes |\n|---|---|---|---|\n| `open()` | `void` | No | Idempotent. Opens or focuses the Settings window. No-op until `initSettings()` runs at boot. |\n\nSee [`api.ts`](api.ts) for full JSDoc.\n\n---\n\n## How to add a new section\n\nThe shell auto-builds the sidebar tab and content pane from the section descriptor — you don't touch [`settings.html`](settings.html). To add a new section:\n\n1. **Write** the renderer logic in `lite/settings/sections/<id>.ts` exporting a `mount<Id>(container) -> disposer | undefined` function. Use the [`SectionDescriptor['mount']`](types.ts) type.\n\n2. **Append** to the section list in [`settings.ts`](settings.ts):\n\n   ```typescript\n   const SECTIONS: SectionDescriptor[] = [\n     // ...existing entries...\n     {\n       id: 'general',\n       title: 'General',\n       icon: ICON_GENERAL,        // 16x16 inline SVG, currentColor stroke\n       mount: mountGeneral,\n     },\n   ];\n   ```\n\n3. **Add** any section-specific styles to [`settings.css`](settings.css) under a section-prefixed class (e.g. `.gen-something` for \"general\"). Shell styles (`.btn-primary`, `.btn-secondary`, `.banner.*`, `.pane-*`) are shared.\n\n4. **Add** a section-specific README block here if the section consumes a non-trivial backing module.\n\nThe list is still hand-written rather than a runtime registry; promote when 3+ sections need conditional visibility / order overrides (per ADR-031 \"registry deferred until needed\").\n\n---\n\n## Renderer bridge (`window.lite.settings`)\n\nThe preload exposes a single method:\n\n```typescript\nawait window.lite.settings.open();   // opens or focuses Settings\n```\n\nThe bridge is shared between renderers — the placeholder window can call `window.lite.settings.open()` to deep-link future \"Manage 2FA\" or \"Configure\" affordances directly into Settings.\n\n---\n\n## Persistence\n\nNone in v1. The TOTP secret already lives in keychain via `lite/totp/store.ts`; Settings has no own state.\n\nWhen future sections need persistence, they will use [`lite/kv/`](../kv/) under collection `lite-settings` — non-secrets only. Secrets continue to use the OS keychain via `keytar` per the pattern in `lite/totp/` and `lite/auth/`.\n\n---\n\n## Why no real \"section registry\" yet?\n\nADR-031 picks the simplest forward-compatible shape: a hand-written list of `SectionDescriptor` in [`settings.ts`](settings.ts). Adding a section means appending to a list and adding a mount point in HTML — about 5 lines per section. A real registry (with order, conditional visibility, lazy loading, etc.) becomes worth it when there are 3+ sections; until then, the indirection costs more than it saves.\n\n---\n\n## Testing\n\nPer Rule 12 (LITE-RULES.md / ADR-024):\n\n- **API conformance** -- [`settings-api.test.ts`](../test/unit/settings-api.test.ts) runs `runApiConformanceContract` with `expectedMethods: ['open']`.\n- **Section behavior** -- exercised via `lite/totp/` tests since the Two-Factor section is a thin renderer over `getTotpApi()`. Settings does not own the data path.\n- **`window.ts` coverage** -- manual smoke only in v1 (the BrowserWindow factory is the same shape as `lite/auth/window.ts`). E2E is tracked as `settings-e2e` in `PORTING.md` deferred queue.\n\n---\n\n## Borrowed patterns (studied, never imported)\n\nPer LITE-RULES.md cherry-pick discipline:\n\n- Full app `settings.html:36-101` -- sidebar + content-area layout (lite mirrors this with sidebar tabs + lazy-mounted panes; full's `onclick=\"...\"` handlers are replaced with `addEventListener` because lite's CSP forbids inline scripts)\n- Full app `settings.html:481-551` -- sidebar tab markup (icon + label, active-state border)\n- Full app `settings.html:943-1026` -- two-factor UI shape, already adapted in ADR-027 and now relocated into [`sections/two-factor.ts`](sections/two-factor.ts)\n- Single-instance window pattern from the deleted `lite/totp/window.ts` and `lite/bug-report/main.ts`\n\nAll rewritten in TS-strict within `lite/settings/`. No `import` from full's root files or `packages/`.\n"
    },
    {
      "slug": "totp",
      "title": "TOTP",
      "summary": "TOTP module -- PUBLIC API.\n\nThe only file other lite modules should import from in this module.\nPer ADR-019 / Rule 11 in `lite/LITE-RULES.md`, cross-module imports\ngo through `<module>/api.ts` -- never reach into `store.ts`,\n`manager.ts`, `qr-scanner.ts`, or any other internal file.\n\nPer ADR-027:\n  - Lite ships an authenticator widget (live code + countdown).\n    Auto-fill into the OneReach 2FA form is NOT in v1; the user\n    copies the code themselves.\n  - The TOTP secret value never round-trips back to the renderer\n    after save. `getCurrentCode()` returns the ephemeral code; the\n    secret stays in keychain.\n\nUsage from another module:\n\n  import { getTotpApi } from '../totp/api.js';\n  const totp = getTotpApi();\n  if (await totp.hasSecret()) {\n    const info = await totp.getCurrentCode();\n    console.log(info.formattedCode);\n  }\n\nTests: `_setTotpApiForTesting(stub)` to inject a custom implementation,\n`_resetTotpApiForTesting()` to clear the singleton.",
      "surface": {
        "interfaceName": "TotpApi",
        "interfaceDescription": "The public surface of the TOTP module.\n\n**Error contract**: every method except `hasSecret` and `getMetadata`\n(which return null on missing/error) throws {@link TotpError}.\nInspect `.code` to branch.\n\n**Secret visibility**: the secret bytes are write-only via\n`saveSecret` / `scanQrFromScreen` / `scanQrFromClipboard`. There is\nno `getSecret` -- by design.",
        "methods": [
          {
            "name": "hasSecret",
            "signature": "hasSecret(): Promise<boolean>",
            "description": "True if a secret is currently stored. Cheap.",
            "tags": [],
            "examples": []
          },
          {
            "name": "getMetadata",
            "signature": "getMetadata(): Promise<TotpSecretMetadata | null>",
            "description": "Public metadata about the stored secret, or null if none.",
            "tags": [],
            "examples": []
          },
          {
            "name": "saveSecret",
            "signature": "saveSecret(secret: string, extra?: { issuer?: string; account?: string }): Promise<SaveSecretResult>",
            "description": "Save a Base32 secret (manual-entry path). Validates the secret;\nrejects with `TOTP_INVALID_SECRET` if format is wrong.",
            "tags": [
              {
                "tag": "throws",
                "value": "{TotpError} `TOTP_INVALID_SECRET` | `TOTP_KEYCHAIN_FAILED`"
              }
            ],
            "examples": []
          },
          {
            "name": "scanQrFromScreen",
            "signature": "scanQrFromScreen(): Promise<QrScanResult>",
            "description": "Scan the user's screen for a QR code. If found AND the QR encodes\nan `otpauth://` URI, parses it and saves the secret in one\noperation. Returns metadata; never returns the secret value.",
            "tags": [
              {
                "tag": "throws",
                "value": "{TotpError} `TOTP_SCREEN_CAPTURE_FAILED` if the screen\n  capture itself failed (e.g. permission denied)."
              }
            ],
            "examples": []
          },
          {
            "name": "scanQrFromClipboard",
            "signature": "scanQrFromClipboard(): Promise<QrScanResult>",
            "description": "Scan the clipboard image for a QR code. Used as a fallback to the\nscreen-recording path -- the user copies the QR image to the\nclipboard, then triggers this. No screen-recording permission\nrequired.",
            "tags": [],
            "examples": []
          },
          {
            "name": "getCurrentCode",
            "signature": "getCurrentCode(): Promise<TotpCodeInfo>",
            "description": "Read the live 6-digit code + countdown.",
            "tags": [
              {
                "tag": "throws",
                "value": "{TotpError} `TOTP_NO_SECRET` | `TOTP_KEYCHAIN_FAILED` | `TOTP_GENERATION_FAILED`"
              }
            ],
            "examples": []
          },
          {
            "name": "deleteSecret",
            "signature": "deleteSecret(): Promise<void>",
            "description": "Delete the stored secret. Idempotent: no-op if nothing stored.",
            "tags": [],
            "examples": []
          }
        ]
      },
      "events": null,
      "readme": "# `lite/totp/` — Authenticator (2FA codes)\n\nA built-in OneReach 2FA authenticator: stores the user's OneReach authenticator secret in the OS keychain, generates the current 6-digit GSX / OneReach 2FA code from that secret, and exposes QR-scan / clipboard-scan / manual secret-entry helpers. The renderer UI lives in Settings -> Two-Factor.\n\n- **Public API**: [`api.ts`](api.ts) — `TotpApi` interface, `getTotpApi()` singleton, error class & codes\n- **Internal**:\n  - [`store.ts`](store.ts) — keychain wrapper via `keytar` (`@internal`)\n  - [`manager.ts`](manager.ts) — pure TOTP code generation via `otplib` (`@internal`)\n  - [`qr-scanner.ts`](qr-scanner.ts) — `desktopCapturer` + `jsqr` + clipboard scanning (`@internal`)\n  - [`errors.ts`](errors.ts) — `TotpError` + `TOTP_ERROR_CODES` (extracted to break a cycle between store + manager)\n  - [`main.ts`](main.ts) — main-process IPC handlers + `initTotp` / teardown (`@internal`)\n  - The authenticator UI now lives at [`../settings/sections/two-factor.ts`](../settings/sections/two-factor.ts), hosted by the Settings window per [ADR-031](../DECISIONS.md#adr-031-settings-window-with-one-section-per-adr-019-two-factor-migrates-from-standalone-tools-window). The standalone `lite/totp/window.ts` was deleted as part of that chunk; this module is now data-only (keychain, code generation, QR scan).\n  - [`types.ts`](types.ts) — `Environment`-style types + protocol constants (`TOTP_STEP_SECONDS = 30`, `TOTP_CODE_DIGITS = 6`)\n  - Renderer UI is bundled with Settings (see [`../settings/settings.html`](../settings/settings.html), [`../settings/settings.css`](../settings/settings.css), and the [`mountTwoFactor`](../settings/sections/two-factor.ts) section).\n- **Tests**: [`../test/unit/totp-api.test.ts`](../test/unit/totp-api.test.ts), [`../test/unit/totp-errors.test.ts`](../test/unit/totp-errors.test.ts), [`../test/unit/totp-manager.test.ts`](../test/unit/totp-manager.test.ts), [`../test/unit/totp-store.test.ts`](../test/unit/totp-store.test.ts), [`../test/integration/totp-integration.test.ts`](../test/integration/totp-integration.test.ts)\n- **Decision rationale**: [DECISIONS.md ADR-027](../DECISIONS.md#adr-027-lite-totp-authenticator-widget-auto-fill-remains-deferred)\n\n---\n\n## What it is\n\nThe OneReach sign-in flow (`lite/auth/`) per [ADR-026](../DECISIONS.md#adr-026-lite-gsx-sign-in-v1-captures-session-cookies-user-fills-the-onereach-form) lets the user fill the OneReach form themselves — including the 6-digit 2FA code. That code is generated from a long-lived authenticator secret (the same secret your phone authenticator stores after scanning the setup QR code). This module stores that secret on this Mac and generates the current GSX / OneReach 2FA code when Settings -> Two-Factor is open.\n\nImportant distinction:\n\n- **Input**: the OneReach authenticator secret / setup QR code (configured once).\n- **Output**: the rotating 6-digit GSX / OneReach 2FA code (copied into the login popup).\n\nDo not paste the current 6-digit login code into Settings. Paste or scan the setup secret.\n\nSecurity guarantees:\n\n- The authenticator secret is stored in the macOS Keychain / system credential vault.\n- The secret is not written to app settings, logs, bug reports, or KV storage.\n- Lite never shows the saved secret again after setup.\n- Lite only displays the temporary six-digit code, which expires every 30 seconds.\n- Lite reads the same OneReach authenticator secret used by the full Onereach.ai app, so existing full-app 2FA setup can generate codes here too.\n\nDuring Lite sign-in, `lite/auth/` can now auto-fill the OneReach 2FA prompt from this module's generated code (ADR-034). The Settings -> Two-Factor UI remains the setup/trust/fallback surface: configure the authenticator secret here, verify the generated code, or copy it manually if auto-fill ever cannot run.\n\n```typescript\nimport { getTotpApi } from '../totp/api.js';\n\nconst totp = getTotpApi();\n\n// Setup paths\nawait totp.saveSecret('JBSWY3DPEHPK3PXP', { issuer: 'OneReach', account: 'alice' });\nconst fromQr = await totp.scanQrFromScreen();   // returns { saved, issuer?, account? }\nconst fromClip = await totp.scanQrFromClipboard();\n\n// Read the live code\nconst info = await totp.getCurrentCode();\nconsole.log(info.formattedCode, '-- expires in', info.timeRemaining, 's');\n\n// Remove\nawait totp.deleteSecret();\n```\n\n---\n\n## v1 scope\n\n| Ships in v1 | Deferred |\n|---|---|\n| Live code + 30s countdown UI | Email/password auto-fill |\n| TOTP auto-fill during Lite sign-in | Account-picker auto-select |\n| QR scan from screen, clipboard, or manual entry | Backup / recovery codes UI |\n| Two-Factor section inside `Onereach.ai Lite -> Settings...` (single-instance window via [`lite/settings/`](../settings/)) | E2E spec (`totp-authenticator-e2e`, `settings-e2e`) |\n| Single TOTP secret per app | Multi-secret / multi-account authenticator |\n\nSee [`../PORTING.md`](../PORTING.md) chunks `totp-authenticator-v1` and `auth-totp-autofill-v1` for the full scope.\n\n---\n\n## API quick reference\n\n| Method | Returns | Throws? | Notes |\n|---|---|---|---|\n| `hasSecret()` | `Promise<boolean>` | No | Cheap keychain probe. |\n| `getMetadata()` | `Promise<TotpSecretMetadata \\| null>` | No | Returns `null` if nothing stored or read fails. |\n| `saveSecret(secret, extra?)` | `Promise<SaveSecretResult>` | Yes (`TotpError`) | Validates Base32 + writes to keychain. |\n| `scanQrFromScreen()` | `Promise<QrScanResult>` | Yes (`TOTP_SCREEN_CAPTURE_FAILED`) | One-shot scan + parse + save. |\n| `scanQrFromClipboard()` | `Promise<QrScanResult>` | No | Empty clipboard returns `{saved: false, reason: 'no-qr-found'}`. |\n| `getCurrentCode()` | `Promise<TotpCodeInfo>` | Yes (`TotpError`) | The hot path the authenticator UI polls every second. |\n| `deleteSecret()` | `Promise<void>` | Yes (`TOTP_KEYCHAIN_FAILED`) | Idempotent for the \"nothing to delete\" case. |\n\nSee [`api.ts`](api.ts) for the full JSDoc.\n\n---\n\n## Persistence\n\nOS Keychain via `keytar`. Two entries:\n\n| Service | Account | Value |\n|---|---|---|\n| `OneReach.ai-TOTP` | `onereach-unified-login` | Raw Base32 secret string (same service/account as the full app) |\n| `OneReach.ai-TOTP-meta` | `onereach-unified-login` | Lite metadata JSON: `{issuer?, account?, savedAt, secretLength}` |\n\n**Shared with the full app.** Full uses `OneReach.ai-TOTP` / `onereach-unified-login`, and Lite now reads/writes the same secret so an existing full-app OneReach 2FA setup immediately generates codes in Lite. For backward compatibility, Lite also reads and deletes the earlier spike-only fallback entry (`OneReach.ai-Lite-TOTP` / `lite-totp-secret`) if no shared secret exists.\n\n---\n\n## Error catalog\n\nEvery error is a `TotpError` (extends `LiteError`). Inspect `.code` to branch.\n\n| Code | Meaning | Remediation hint |\n|---|---|---|\n| `TOTP_NO_SECRET` | `getCurrentCode` was called but no secret is stored. | Open Settings -> Two-Factor and add the OneReach authenticator secret or setup QR first. |\n| `TOTP_INVALID_SECRET` | The given string isn't valid Base32 or is too short. | Make sure you copied the full secret. A-Z and 2-7 only, ≥16 chars. |\n| `TOTP_KEYCHAIN_FAILED` | `keytar` rejected the read/write/delete. | Make sure macOS Keychain is unlocked. |\n| `TOTP_GENERATION_FAILED` | `otplib` rejected the secret at code-generation time. | The stored secret is malformed; remove and re-add. |\n| `TOTP_NO_QR_FOUND` | The scanner ran but no QR code was found in the image. | Make sure the QR is fully visible, then try again. |\n| `TOTP_NOT_AUTHENTICATOR_QR` | A QR was decoded but it's not an `otpauth://` URI. | Re-scan the OneReach 2FA setup QR (not a website link). |\n| `TOTP_SCREEN_CAPTURE_FAILED` | `desktopCapturer.getSources` returned nothing or threw. | Grant Screen Recording permission in macOS System Settings. |\n\n```typescript\nimport { getTotpApi, TotpError, TOTP_ERROR_CODES } from '../totp/api.js';\n\ntry {\n  await getTotpApi().getCurrentCode();\n} catch (err) {\n  if (err instanceof TotpError) {\n    if (err.code === TOTP_ERROR_CODES.NO_SECRET) {\n      promptUserToSetupTotp();\n    } else {\n      toast(err.formatForUser());\n    }\n  }\n}\n```\n\n---\n\n## Secret redaction guarantee\n\nThe TOTP secret value is **NEVER** logged. Only metadata: `secretLength`, `hasIssuer`, `hasAccount`, `savedAt`, etc. This invariant is enforced by [`../test/unit/totp-store.test.ts`](../test/unit/totp-store.test.ts) which captures every log call during a full save → read → delete cycle and asserts the secret value never appears as a substring in any message or data payload.\n\nIf you add a new log call in `store.ts` or `manager.ts`, do not log `secret` directly. Use the metadata fields the existing log calls demonstrate.\n\nThe ephemeral 6-digit code IS allowed to be logged (it's regenerated every 30s and has low blast radius), but only the QR-scan and code-generation paths actually do.\n\n---\n\n## Renderer bridge (`window.lite.totp`)\n\nThe preload exposes a narrowed surface. The secret bytes are write-only; there is no `getSecret`.\n\n```typescript\nconst { hasSecret } = await window.lite.totp.hasSecret();\nif (!hasSecret) {\n  await window.lite.totp.saveSecret(userInputBase32);\n}\nconst info = await window.lite.totp.getCurrentCode();\ndisplay(info.formattedCode, info.timeRemaining);\n\n// Subscribe to errors via the standard parseError helper\ntry {\n  await window.lite.totp.scanQrFromScreen();\n} catch (err) {\n  const totpErr = window.lite.totp.parseError(err);\n  if (totpErr) showBanner(totpErr.message + ' ' + totpErr.remediation);\n}\n```\n\nThe Two-Factor section in [`lite/settings/sections/two-factor.ts`](../settings/sections/two-factor.ts) is the canonical consumer. The section calls `window.lite.totp.*` from inside the Settings window's renderer.\n\n---\n\n## macOS screen-recording permission\n\n`scanQrFromScreen()` uses Electron's `desktopCapturer.getSources({types: ['screen']})`, which requires Screen Recording permission on macOS. On first use, macOS prompts. If denied:\n\n- The call resolves with `TOTP_SCREEN_CAPTURE_FAILED` (no sources or empty thumbnail).\n- The renderer's friendly error tells the user to grant the permission in System Settings → Privacy & Security → Screen Recording, restart the app, and try again.\n- The clipboard and manual paths don't need this permission, so the user has fallbacks.\n\n---\n\n## Testing\n\nPer Rule 12 (LITE-RULES.md / ADR-024):\n\n- **API conformance** — [`totp-api.test.ts`](../test/unit/totp-api.test.ts) runs `runApiConformanceContract`.\n- **Error conformance** — [`totp-errors.test.ts`](../test/unit/totp-errors.test.ts) runs `runErrorConformanceContract` for `TotpError`.\n- **Manager** — [`totp-manager.test.ts`](../test/unit/totp-manager.test.ts) tests pure TOTP math against `otplib` (no mocks).\n- **Store** — [`totp-store.test.ts`](../test/unit/totp-store.test.ts) covers happy path, all error codes, idempotent delete, and the **secret redaction assertion**.\n- **Integration** — [`totp-integration.test.ts`](../test/integration/totp-integration.test.ts) drives the full pipeline (manager + store + scanner) with a Map-backed `FakeKeychain` and a `FakeScanner` emitting canned `otpauth://` URIs. Verifies QR-path and manual-path persistence are equivalent.\n- **`window.ts` coverage**: not applicable -- the standalone authenticator window was deleted in ADR-031. The Two-Factor section is hosted inside the Settings window; coverage is via `settings-e2e` + `totp-authenticator-e2e` in `PORTING.md` deferred queue.\n\nTests mock `electron`, `keytar`, and `jsqr` with `vi.mock` so they run under Node's vitest runner without an Electron host or system keychain.\n\n---\n\n## Borrowed patterns (studied, never imported)\n\nPer LITE-RULES.md cherry-pick discipline:\n\n- `lib/totp-manager.js` — TOTP `generate` / `verify` / `parseOTPAuthURI` shape (rewritten in TS-strict around `otplib`)\n- `lib/qr-scanner.js` — `desktopCapturer` + `jsqr` + BGRA→RGBA conversion (rewritten in TS-strict)\n- `credential-manager.js:512-572` — TOTP keychain save/get/delete (rewritten in TS-strict, narrower surface, separate service name)\n- `settings.html:943-1026` — live-code + countdown UI shape (rewritten in TS, no jQuery, no inline scripts per CSP)\n\nAll rewritten in TS-strict within `lite/totp/`. No `import` from full's root files or `packages/`.\n\n---\n\n## How auto-fill uses this module\n\n`lite/auth/totp-autofill.ts` consumes `getTotpApi().getCurrentCode()` when the Lite sign-in popup reaches the OneReach TOTP prompt. It fills and submits the current code, but never receives or logs the saved secret.\n\nThe full app's `gsx-autologin.js` ports the entire OneReach auth ceremony — form detection, email/password fill, TOTP timing windows, retry/backoff, account-picker autoclick. Lite ports only the TOTP slice: user still types email/password and chooses an account, while Lite handles the generated 2FA code if a secret is configured.\n"
    },
    {
      "slug": "university",
      "title": "University",
      "summary": "Agentic University module -- PUBLIC API.\n\nThe only file other lite modules should import from in this\nmodule. Per ADR-019 / Rule 11, cross-module imports go through\n`<module>/api.ts` -- never reach into `curated-content.ts`,\n`menu-builder.ts`, or any other internal file.\n\nThe University module hosts the top-level **Agentic University**\nmenu (Open LMS, Quick Starts -> View All Tutorials + courses, AI\nRun Times) plus a polished tutorials catalog\nwindow. All link items open in a shared Lite-native \"Learning\nBrowser\" window (separate persistent partition from the IDW\nplaceholder browser, so OAGI logins don't bleed into university\nviewing).\n\nForward-compat: the curated catalog is hand-maintained for v1;\na future port can pull from OAGI as `Course` / `Tutorial` node\ntypes (similar pattern to `lite/idw/catalog-renderer.ts`).\n\nTests: `_setUniversityApiForTesting(stub)` to inject a custom\nimplementation, `_resetUniversityApiForTesting()` to clear the\nsingleton.",
      "surface": {
        "interfaceName": "UniversityApi",
        "interfaceDescription": "The public surface of the Agentic University module. Mostly\nread-only -- the catalog is hand-curated and the only\nmutations are click-driven (open URL in Learning Browser, open\ntutorials window).\n\n**Error contract**: `get()` returns null for unknown ids (does\nNOT throw). `openCourse(id)` / `openEntry(id)` throw\n`UniversityError` with code `UNIV_NOT_FOUND` when the id is not\ncurated. Callers should branch on `instanceof UniversityError`\n(or check `.code`).",
        "methods": [
          {
            "name": "list",
            "signature": "list(): Promise<LearningEntry[]>",
            "description": "All curated learning entries, in catalog display order.",
            "tags": [],
            "examples": []
          },
          {
            "name": "listByKind",
            "signature": "listByKind(kind: LearningKind): Promise<LearningEntry[]>",
            "description": "Filter the curated catalog by kind.",
            "tags": [],
            "examples": []
          },
          {
            "name": "get",
            "signature": "get(id: string): Promise<LearningEntry | null>",
            "description": "Single curated entry by id, or null if absent.",
            "tags": [],
            "examples": []
          },
          {
            "name": "onEvent",
            "signature": "onEvent(handler: (event: UniversityEvent) => void): () => void;",
            "description": "Subscribe to typed University events (ADR-032). Returns an\nunsubscribe function.",
            "tags": [],
            "examples": []
          }
        ]
      },
      "events": {
        "constantName": "UNIVERSITY_EVENTS",
        "count": 8,
        "entries": [
          {
            "constantKey": "OPENED",
            "name": "university.opened",
            "description": ""
          },
          {
            "constantKey": "TUTORIALS_OPENED",
            "name": "university.tutorials.opened",
            "description": ""
          },
          {
            "constantKey": "BROWSER_LOADING",
            "name": "university.browser.loading",
            "description": ""
          },
          {
            "constantKey": "BROWSER_LOADED",
            "name": "university.browser.loaded",
            "description": ""
          },
          {
            "constantKey": "IPC_LIST",
            "name": "university.ipc.list",
            "description": ""
          },
          {
            "constantKey": "IPC_GET",
            "name": "university.ipc.get",
            "description": ""
          },
          {
            "constantKey": "IPC_OPEN",
            "name": "university.ipc.open",
            "description": ""
          },
          {
            "constantKey": "IPC_OPEN_TUTORIALS",
            "name": "university.ipc.open-tutorials",
            "description": ""
          }
        ]
      },
      "readme": "# lite/university -- Agentic University menu, tutorials catalog, Learning Browser\n\nPublic surface: `getUniversityApi()` from `./api.ts`. Renderer\nsurface: `window.lite.university`.\n\nThis module owns the top-level **Agentic University** menu in\nLite, a polished tutorials catalog window, and a shared Lite-native\n\"Learning Browser\" window that loads each link in-app. Mirrors the\nfull app's `_buildUniversityMenu` shape from\n`lib/menu-sections/idw-gsx-builder.js` plus the\n[test/plans/30-documentation-tutorials.md](test/plans/30-documentation-tutorials.md)\nspec.\n\nThe catalog is hand-curated in `./curated-content.ts` for v1.\nForward-compat: a future port can replace `CURATED` with a\nfunction that pulls `Course` / `Tutorial` node types from OAGI\n(same Cypher / mapping pattern as\n`lite/idw/catalog-renderer.ts`).\n\n## Menu structure\n\n```\nAgentic University                  (top:university, order 80)\n  Open LMS                          -> Learning Browser\n  --- (separator)\n  Quick Starts                      (submenu)\n    View All Tutorials              -> opens the Lite tutorials catalog window\n    --- (separator)\n    Getting Started                 -> Learning Browser\n    Building Your First Agent       -> Learning Browser\n    Workflow Fundamentals           -> Learning Browser\n    API Integration                 -> Learning Browser\n  --- (separator)\n  AI Run Times                      -> Learning Browser\n```\n\nNO accelerators (per ADR-015).\n\n## Usage\n\n### Main process\n\n```typescript\nimport { getUniversityApi } from '../university/api.js';\n\nconst all = await getUniversityApi().list();\nconst courses = await getUniversityApi().listByKind('course');\nconst lms = await getUniversityApi().get('lms');\n```\n\n### Renderer (tutorials catalog)\n\n```typescript\nconst entries = await window.lite!.university!.list();\nawait window.lite!.university!.open('first-agent'); // routes to Learning Browser\nawait window.lite!.university!.openTutorials();      // opens the catalog window\n```\n\n`window.lite.university` exposes ONLY read methods +\n`open` + `openTutorials`. Mutations are out of scope -- the catalog\nis hand-curated, not user-editable.\n\n## Public API surface\n\n| Method | Purpose | Bridged to renderer |\n|---|---|---|\n| `list()` | All curated entries, in display order | Yes |\n| `listByKind(kind)` | Filter by `LearningKind` | Yes |\n| `get(id)` | Single entry, or null | Yes |\n| `open(id)` *(IPC only)* | Open in Learning Browser | Yes |\n| `openTutorials()` *(IPC only)* | Open the tutorials catalog window | Yes |\n| `onEvent(handler)` | Subscribe to typed events (ADR-032) | No (main only) |\n\n## Per-kind metadata (`./curated-content.ts`)\n\n| Kind | Plural | Default emoji | Accent var | Used by |\n|---|---|---|---|---|\n| `lms` | LMS | classical building | `--accent-lms` | Top-level \"Open LMS\" |\n| `course` | Courses | books | `--accent-course` | Quick Starts items |\n| `tutorial` | Tutorials | graduation cap | `--accent-tutorial` | (reserved for future) |\n| `feed` | Feeds | newspaper | `--accent-feed` | \"AI Run Times\" |\n| `method` | Methods | compass | `--accent-method` | Catalog-only reference content |\n\n## Error catalog\n\nAll errors extend `UniversityError` (which extends `LiteError`).\n\n| Code | When | Remediation |\n|---|---|---|\n| `UNIV_NOT_FOUND` | `open(id)` with an unknown id | Refresh -- the catalog may have changed |\n| `UNIV_INVALID_URL` | Curated entry has a malformed / non-http URL | Bug in the curated catalog; report it |\n\n## Events (ADR-032)\n\nSubscribe via `getUniversityApi().onEvent(handler)`.\n\nNames (full catalog in `./events.ts`):\n\n- Activity: `university.opened`, `university.tutorials.opened`,\n  `university.browser.loading`, `university.browser.loaded`\n- IPC entries (per ADR-030): `university.ipc.list`,\n  `university.ipc.get`, `university.ipc.open`,\n  `university.ipc.open-tutorials`\n\n## Security posture\n\n- **Learning Browser** (`./browser-window.ts`): NO preload --\n  third-party content (LMS, Wiser Method, UX Mag) cannot see\n  `window.lite.*`. Sandboxed + contextIsolated + no node\n  integration. Persistent partition `persist:lite-university` --\n  separate from IDW's so course session cookies don't bleed into\n  agent sessions.\n- **Tutorials catalog window** (`./tutorials-window.ts`): uses the\n  standard Lite preload so the renderer can call\n  `window.lite.university.list/open`.\n- **URL validation**: defensive at the\n  `openLearningInBrowser` boundary -- invalid URLs surface a\n  friendly dialog instead of crashing the window. Validation also\n  enforced at `resolveEntryStrict` (curated catalog).\n- **External link handling**: `setWindowOpenHandler` denies child\n  Electron windows; `window.open()` and `target=\"_blank\"` clicks\n  route to the OS default browser via `shell.openExternal`.\n\n## Hardening roadmap\n\nThe hand-curated catalog is the seam for the eventual OAGI-driven\ncontent port:\n\n| Phase | Trigger | Change |\n|---|---|---|\n| **U0** -- this PR | -- | Hand-curated catalog in `./curated-content.ts` |\n| **U1** | Course content lands in OAGI | Replace `CURATED` with an OAGI Cypher fetch (mirrors `lite/idw/catalog-renderer.ts`) |\n| **U2** | A kind needs its own window class | `KIND_UI` grows a `windowFactory` field |\n| **U3** | Per-context partition isolation | Replace shared `persist:lite-university` with per-domain partitions |\n\n## File layout\n\n```\nlite/university/\n  README.md              (this file)\n  api.ts                 PUBLIC -- UniversityApi, UniversityError, UNIVERSITY_ERROR_CODES, KIND_UI, types\n  curated-content.ts     INTERNAL -- CURATED catalog + KIND_UI + URL constants\n  events.ts              INTERNAL -- UNIVERSITY_EVENTS, UniversityEvent union, isUniversityEvent\n  errors.ts              INTERNAL -- UniversityError, UNIVERSITY_ERROR_CODES\n  types.ts               INTERNAL -- LearningEntry, LearningKind, LEARNING_KINDS\n  main.ts                INTERNAL -- initUniversity() registers IPC + menu + windows\n  menu-builder.ts        INTERNAL -- top:university + items, no onChange (static catalog)\n  browser-window.ts      INTERNAL -- shared Learning Browser singleton\n  tutorials-window.ts    INTERNAL (main) -- catalog window factory\n  tutorials-renderer.ts  INTERNAL (renderer) -- entry: university-tutorials.js\n  tutorials.html         INTERNAL (renderer) -- copied as university-tutorials.html\n  tutorials.css          INTERNAL (renderer) -- copied as university-tutorials.css\n```\n\nPer Rule 11, **only `api.ts` is importable from other modules.**\n\n## Tests\n\n- `lite/test/unit/university-api.test.ts` -- `runApiConformanceContract`\n  + `runErrorConformanceContract` + behavior\n- `lite/test/unit/university-curated.test.ts` -- catalog coverage,\n  URL validity, KIND_UI completeness\n- `lite/test/unit/university-menu-builder.test.ts` -- top-level\n  registration, click routing, teardown\n- `lite/test/integration/typed-onevent.test.ts` -- typed narrowing\n  block\n- `lite/test/integration/event-coverage.test.ts` -- university\n  block (IPC + activity events)\n\n## Borrowed patterns (studied, not imported)\n\n- `menu.js:_buildUniversityMenu` (full app) -- menu structure\n  (Open LMS / Quick Starts / AI Run Times); copied\n  shape, replaced full-app `openLearningWindow` call with Lite-native\n  Learning Browser.\n- `lib/gsx-autologin.js:openLearningWindow` -- learning window\n  pattern (1600x1000 BrowserWindow, backgroundThrottling: false,\n  loading indicator). Lite simplifies: standard Lite chrome\n  (1400x900), drops the injected loading CSS (Electron's default\n  is fine).\n- `tutorials.html` (full app) -- Netflix-style hero + carousel +\n  grid. Lite ports the hero + grid as a polished card grid;\n  carousel + dynamic content fetch deferred to U1.\n- `lite/idw/catalog-window.ts` + `catalog-renderer.ts` -- catalog\n  window pattern + cards-with-hover-lift.\n- `lite/idw/browser-window.ts` -- placeholder browser pattern\n  (separate persistent partition, no preload, deny popups).\n"
    }
  ],
  "untyped": [
    {
      "slug": "updater",
      "title": "Updater",
      "reason": "Init-pattern module (no public api.ts). Drives auto-update via electron-updater. See updater/index.ts and the typed event catalog at updater/events.ts (UPDATER_EVENTS)."
    },
    {
      "slug": "menu",
      "title": "Menu",
      "reason": "Internal-only registry pattern (no public api.ts). Builds the application menu from menu/seed.ts via menu/registry.ts. Events: menu.click, menu.click.failed."
    }
  ],
  "generatedAt": "2026-05-05T17:59:48.220Z"
} as const;
