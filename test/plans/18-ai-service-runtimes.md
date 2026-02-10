# 18 -- AI Service & Runtimes

## Overview

The centralized AI service layer (`lib/ai-service.js`) with provider adapters (`lib/ai-providers/`), model profile system, circuit breakers, budget gating, and fallback chains. Covers the full AI infrastructure stack including provider switching, cost tracking, and error resilience.

**Key files:** `lib/ai-service.js`, `lib/ai-providers/openai-adapter.js`, `lib/ai-providers/anthropic-adapter.js`, `claude-api.js` (deprecated), `openai-api.js` (deprecated), `pricing-config.js`

## Prerequisites

- App running with valid API keys for OpenAI and Anthropic configured in Settings
- Budget Manager initialized
- LLM Usage Tracker active

## Features

### AI Service Singleton
- Proxy-based singleton: `require('./lib/ai-service')` returns instance methods directly
- Lazy initialization on first call
- Settings-driven configuration (API keys, model profiles)

### Model Profiles
- 8 capability tiers: `fast`, `standard`, `powerful`, `large`, `vision`, `realtime`, `embedding`, `transcription`
- Each profile maps to a provider + model + fallback
- Overridable via `settings.aiModelProfiles`

### Unified API Methods
- `chat(opts)` -- standard chat completion
- `chatStream(opts)` -- async generator streaming
- `complete(prompt, opts)` -- single-prompt convenience
- `json(prompt, opts)` -- JSON mode, returns parsed object
- `vision(imageData, prompt, opts)` -- image analysis
- `embed(input, opts)` -- text embeddings
- `transcribe(audioBuffer, opts)` -- Whisper transcription with word timestamps
- `imageGenerate(prompt, opts)` -- DALL-E image generation
- `imageEdit(imageBuffer, prompt, opts)` -- GPT image editing
- `testConnection(provider)` -- connectivity test
- `resetCircuit(provider)` -- manual circuit breaker reset

### Provider Adapters
- **OpenAI adapter:** chat, chatStream, vision, embed, transcribe, tts, imageEdit, imageGenerate
- **Anthropic adapter:** chat, chatStream, vision
- SSE stream parsing for both providers
- Token estimation (~4 chars/token)

### Resilience
- Auto-retry with exponential backoff (max 3 retries, 1s-30s delay)
- Retries on HTTP 429/500/502/503
- Provider fallback: primary fails -> tries fallback provider
- Circuit breaker per provider: opens after 5 consecutive failures, resets after 60s

### Budget Integration
- Pre-call budget gate via `BudgetManager.preCheckBudget()`
- Post-call usage recording via `LLMUsageTracker`
- Throws `BudgetExceededError` on hard limits
- Session-level cost tracking by profile

### Deprecated Clients
- `claude-api.js` and `openai-api.js` retained for backward compatibility
- Both emit deprecation warnings directing to `lib/ai-service.js`

---

## Checklist

### Service Initialization
- [ ] [A] Require `lib/ai-service` returns a functional proxy singleton
- [ ] [A] Service initializes lazily on first API call
- [ ] [A] Missing API keys throw clear error with instructions

### Model Profiles
- [ ] [A] All 8 default profiles resolve to valid provider+model combinations
- [ ] [A] Custom profile overrides via settings are respected
- [ ] [A] Requesting an unknown profile throws descriptive error

### Chat & Completion
- [ ] [A] `chat()` returns a valid response with usage stats
- [ ] [A] `complete()` returns a string response
- [ ] [A] `json()` returns a parsed JSON object
- [ ] [A] `chatStream()` yields incremental tokens via async generator
- [ ] [P] `chat()` with different profiles routes to correct provider

### Vision & Media
- [ ] [A] `vision()` accepts base64 image and returns description
- [ ] [A] `embed()` returns a float array of expected dimensionality
- [ ] [A] `transcribe()` accepts audio buffer and returns text with timestamps
- [ ] [P] `imageGenerate()` returns a valid image URL or base64
- [ ] [P] `imageEdit()` accepts image buffer and returns modified image

### Streaming
- [ ] [A] `chatStream()` yields `content_block_delta` events for Anthropic
- [ ] [A] `chatStream()` yields SSE `data:` events for OpenAI
- [ ] [A] Stream terminates cleanly on completion
- [ ] [A] Stream handles mid-stream errors gracefully

### Retry & Fallback
- [ ] [A] 429 response triggers retry with exponential backoff
- [ ] [A] 500/502/503 responses trigger retry
- [ ] [A] After max retries, falls back to alternate provider
- [ ] [A] Fallback provider receives the same request parameters
- [ ] [A] Both providers failing throws `AllProvidersFailedError`

### Circuit Breaker
- [ ] [A] 5 consecutive failures open the circuit
- [ ] [A] Open circuit throws `CircuitOpenError` immediately (no API call)
- [ ] [A] Circuit resets after 60s cooldown
- [ ] [A] `resetCircuit(provider)` manually resets the breaker
- [ ] [A] Half-open state allows a single probe request

### Budget Integration
- [ ] [A] Pre-call budget check blocks requests when hard limit exceeded
- [ ] [A] `BudgetExceededError` includes remaining budget and estimated cost
- [ ] [A] Successful calls record usage via `LLMUsageTracker`
- [ ] [A] Session cost tracking accumulates correctly across calls
- [ ] [P] Budget warning thresholds (50%, 75%, 90%) trigger notifications

### Connection Testing
- [ ] [A] `testConnection('openai')` succeeds with valid key
- [ ] [A] `testConnection('anthropic')` succeeds with valid key
- [ ] [A] `testConnection()` with invalid key returns descriptive failure

### Deprecated Clients
- [ ] [A] `claude-api.js` emits deprecation warning on load
- [ ] [A] `openai-api.js` emits deprecation warning on load
- [ ] [A] Deprecated clients still function for backward compatibility

### Provider Adapters
- [ ] [A] OpenAI adapter handles JSON mode (`response_format: { type: "json_object" }`)
- [ ] [A] Anthropic adapter handles system prompt as separate parameter
- [ ] [A] Both adapters parse SSE streams correctly
- [ ] [A] Token estimation is within 20% accuracy for English text

---

## Automation Notes

- Most tests are unit/integration tests runnable without launching the full Electron app
- Mock HTTP responses for provider adapters to avoid real API costs
- Use small prompts and `max_tokens: 10` for real API tests to minimize cost
- Circuit breaker tests need a mock server returning 500s
- Budget tests can use the `BudgetManager` directly with test limits
- Streaming tests should verify async iterator protocol compliance
