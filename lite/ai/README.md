# lite/ai -- Lite AI service (OpenAI v1)

Public surface: `getAiApi()` from `./api.ts`. Renderer surface:
`window.lite.ai`.

This module is the centralized AI endpoint for Lite -- mirrors the
full app's `lib/ai-service.js` philosophy ("never make direct
fetch/https.request calls to OpenAI / Anthropic from feature
modules"). v1 supports OpenAI only with a BYO-key model: the user
provides their own OpenAI API key in `Settings -> AI`, the key
persists in KV, and every call adds an `Authorization: Bearer`
header.

The first consumer is **AI Run Times** (TTS for article playback).
Future consumers (Spaces summarization, IDW chat presets, Voice
Orb) plug in by calling `getAiApi().chat({...})` or `tts({...})`
without each module reinventing OpenAI plumbing.

## Usage

### Main process

```typescript
import { getAiApi } from '../ai/api.js';

const api = getAiApi();
const status = await api.status();
if (!status.hasApiKey) {
  // Open Settings -> AI to configure
  return;
}

const audio = await api.tts({
  text: 'Hello world',
  voice: 'nova',
  format: 'mp3',
  feature: 'my-feature',
});
// audio.audio is a Uint8Array, audio.mimeType is 'audio/mpeg'

const reply = await api.chat({
  messages: [
    { role: 'system', content: 'You are a brief assistant.' },
    { role: 'user', content: 'Summarize OneReach Studio in one sentence.' },
  ],
  maxTokens: 100,
  feature: 'my-feature',
});
// reply.content is the model's text
```

### Renderer (via preload bridge)

```typescript
const status = await window.lite!.ai!.status();

const audio = await window.lite!.ai!.tts({
  text: 'Hello world',
  voice: 'nova',
});
// audio.audioBase64 is a base64-encoded string -- decode + play

const reply = await window.lite!.ai!.chat({
  messages: [{ role: 'user', content: 'Hi' }],
  maxTokens: 50,
});
```

## Public API surface

| Method | Purpose | Bridged to renderer |
|---|---|---|
| `tts(req)` | Text-to-speech via OpenAI `/v1/audio/speech` | Yes (audio as base64) |
| `chat(req)` | Chat completion via `/v1/chat/completions` | Yes |
| `status()` | Public configuration snapshot (no API key) | Yes |
| `configure(config)` | Persist API key + voice / model defaults | Yes |
| `onEvent(handler)` | Subscribe to typed `AiEvent`s (ADR-032) | No (main only) |

## Error catalog

All errors extend `AiError` (which extends `LiteError`).

| Code | When | Remediation |
|---|---|---|
| `AI_NOT_CONFIGURED` | `tts()` / `chat()` called before an API key is saved | Open Settings -> AI and paste an OpenAI API key |
| `AI_RATE_LIMITED` | OpenAI returned 429 | Wait + retry (OpenAI rate-limits per organization) |
| `AI_HTTP` | OpenAI returned a non-2xx, non-429 status (401, 500, etc.) | 401 -> check API key in Settings; otherwise see OpenAI status page |
| `AI_NETWORK` | DNS / TCP / TLS failure | Check network connection |
| `AI_TIMEOUT` | Request exceeded 60s | Retry; check OpenAI status |
| `AI_BAD_INPUT` | Empty text, empty messages, text > 4096 chars | Validate input before calling |

## Events (ADR-032)

Subscribe via `getAiApi().onEvent(handler)`.

Names (full catalog in `./events.ts`):

- Spans: `ai.tts.{start,finish,fail}`, `ai.chat.{start,finish,fail}`,
  `ai.configure.{start,finish,fail}`
- IPC entries (per ADR-030): `ai.ipc.tts`, `ai.ipc.chat`,
  `ai.ipc.status`, `ai.ipc.configure`

## Security posture

- **API key persistence**: KV today (`lite-ai-config / default`).
  `status()` returns `hasApiKey: boolean`, never the value itself.
  The Settings form starts empty even when one is saved (paste-only
  to overwrite; type `clear` to delete).
- **Logging**: API key NEVER logged. Token / completion counts +
  HTTP status codes log; raw text input / output does NOT log.
- **Network**: direct to `api.openai.com` -- no proxy, no
  intermediary. The user's key, prompt text, and audio audio
  responses transit only between Lite and OpenAI.
- **Cost containment**: every call carries an optional `feature`
  label so future cost-tracking layers can attribute spend.

## Hardening roadmap

| Phase | Trigger | Change |
|---|---|---|
| **A0** -- this PR | -- | OpenAI only; API key in KV; BYO-key |
| **A1** | Pilot expands beyond developers | Move API key to OS keychain via `keytar` (mirrors `lite/totp/store.ts`); `CredentialsProvider` interface unchanged |
| **A2** | Need org-managed keys | Add `BearerCredentialsProvider` that fetches from OneReach backend; `client.ts` switch case adds new variant; call sites unchanged |
| **A3** | Need provider parity | Add `lite/ai/providers/anthropic.ts`, `gemini.ts`; `AiApi` grows `profile` parameter (mirrors full app's `ai-service.js` profile system) |
| **A4** | Cost tracking | Wire `feature` label into a `lite/budget/` module |

## File layout

```
lite/ai/
  README.md           (this file)
  api.ts              PUBLIC -- AiApi singleton, AiError, AI_ERROR_CODES, types
  client.ts           INTERNAL -- OpenAI HTTP client (fetch + AbortSignal)
  credentials.ts      INTERNAL -- KVAiCredentialsProvider, StaticAiCredentialsProvider
  errors.ts           INTERNAL -- AiError + AI_ERROR_CODES
  events.ts           INTERNAL -- AI_EVENTS + AiEvent union + isAiEvent
  main.ts             INTERNAL -- initAi() registers IPC handlers
  types.ts            INTERNAL -- TtsRequest/Response, ChatRequest/Response, AiConfig, AiStatus
```

Per Rule 11, **only `api.ts` is importable from other modules.**

## Tests

- `lite/test/unit/ai-api.test.ts` -- conformance + behavior
- `lite/test/unit/ai-client.test.ts` -- HTTP request shape, status
  code -> error code mapping, abort -> timeout, fetch throw -> network
- `lite/test/integration/typed-onevent.test.ts` -- typed narrowing
- `lite/test/integration/event-coverage.test.ts` -- IPC + span events

## Borrowed patterns (studied, not imported)

- `lib/ai-service.js` (full app) -- centralized AI endpoint
  philosophy + `chat({profile, system, messages, maxTokens,
  temperature, jsonMode, feature})` shape. Lite simplifies: no
  profile system in v1 (single OpenAI provider), no jsonMode (not
  needed for current consumers), no centralized cost tracking
  (deferred to A4).
- `lib/ai-providers/openai-adapter.js` -- OpenAI request body shape
  (`response_format` for TTS; `model / messages / max_tokens` for
  chat).
- `lite/neon/credentials.ts` -- `CredentialsProvider` abstraction
  for forward-security swaps without changing call sites
  (ADR-033).
- `lite/totp/store.ts` -- the keychain-backed pattern that A1 will
  adopt for the API key.
