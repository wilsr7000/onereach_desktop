# Onereach.ai Punch List

> Master list of bugs, fixes, and small features to address.
> Updated: January 2026 | Current Version: 3.10.0

---

## 🔴 Critical / Blocking

### App Distribution
- [ ] **Notarization not working** - App requires users to bypass Gatekeeper
  - Apple Developer account needed ($99/year)
  - App-specific password required
  - See: `NOTARIZATION-SETUP.md`
  - Files: `notarize-setup.sh`, `build-notarized.sh`

### Build & Release
- [x] ~~Checksum mismatch on auto-update~~ - Fixed in release-master.sh
- [ ] **Windows code signing** - Not implemented
  - See: `WINDOWS-SIGNING-GUIDE.md`
  - Requires EV certificate for SmartScreen trust

---

## 🟠 High Priority

### GSX Create
- [ ] **Task queue persistence** - Verify working across all edge cases
- [x] **Graceful shutdown** - Fixed in v3.8.12 with app quit handlers and forced window close
- [ ] **HUD position** - Sometimes resets after restart
- [ ] **Agent summaries** - Improve quality/relevance

### Video Editor
- [ ] **Voice selector UI** - Currently hardcoded to 'Rachel' voice
  - Location: `video-editor-app.js:2146`
  - Need UI to choose from 9 ElevenLabs voices
- [ ] **Preview AI audio** - Allow preview before applying
- [ ] **Batch processing** - Process multiple ranges at once
- [ ] **Undo/revert** - No undo for audio replacement
- [ ] **ADR track audio loading** - Not implemented
  - Location: `video-editor-app.js:8554`

### Voice / Agent Exchange
- [x] **Documentation Agent (RAG-grounded)** - New docs-agent answers app questions from official docs without hallucination
  - Self-contained RAG: chunks markdown by section headers, embeds via ai-service, cosine similarity search
  - Anti-hallucination system prompt refuses when docs don't cover the topic
  - Registered in agent-registry, participates in exchange auction
  - Eval tests: deterministic fact-checking + LLM-as-judge hallucination detection
  - E2E tests: documentation completeness (all doc files + HTML windows + content sections)
  - Files: `packages/agents/docs-agent.js`, `test/evals/docs-answer-quality.eval.js`, `test/e2e/documentation-completeness.spec.js`
- [x] **Voice feedback loop (mic self-listening)** - TTS output picked up by mic, causing garbled/hallucinated transcriptions (v3.17.x)
  - Mic gating: `voice-speaker.js` signals `hud-api.js` on speech start/end
  - `voice-listener.js` drops audio + clears input buffer while TTS plays
  - VAD events during playback are suppressed to prevent false triggers
  - Files: `voice-speaker.js`, `voice-listener.js`, `lib/hud-api.js`
- [x] **Transcript quality filter (garbled/hallucination guard)** - Realtime API hallucinates multi-language gibberish from noise (v3.17.x)
  - Two-stage filter in `hud-api.js`: fast heuristic (multi-script, short non-Latin) + LLM micro-check
  - Replaces old regex `isLikelyGarbledTranscription()` in exchange-bridge
  - Saves ~$0.005 per garbage transcript (avoids 19-agent auction on noise)
  - Fail-open design: if filter errors, transcript passes through
  - Files: `lib/hud-api.js`, `src/voice-task-sdk/exchange-bridge.js`
- [x] **Orb migrated to HUD API** - Orb now submits tasks, handles events, and manages disambiguation via centralized HUD API (v3.17.x)
  - Task submission: `window.agentHUD.submitTask()` replaces `window.orbAPI.submit()`
  - Full pipeline: transcript filter -> dedup -> Router -> exchange auction -> voice cues
  - Task-tool mapping: events route back to orb via `toolId: 'orb'`
  - Speech state: centralized `onSpeechState()` from HUD API replaces local `isSpeaking`
  - Disambiguation: `agentHUD.selectDisambiguationOption()` / `cancelDisambiguation()` replaces legacy
  - Lifecycle events: `agentHUD.onLifecycle()` / `onResult()` replace `orbAPI.onTaskEvent()`
  - Low-level stays on `orbAPI`: Realtime WebSocket, raw audio, function calls, window controls
  - Files: `orb.html`, `preload-hud-api.js`, `lib/hud-api.js`
- [ ] **MasterOrchestrator missing module** - `Cannot find module '../../packages/task-exchange/src/reputation/store'`
  - Location: `packages/agents/master-orchestrator.js`

### Spaces
- [x] **SPACE Framework metadata schema v2.0** - Extensible core schema for Spaces and Items
  - Created `lib/metadata-schema.js` with factory functions, validation, migration, context extraction
  - Five SPACE namespaces: System, Physical, Attributes, Communication, Events
  - Auto-migration from v1.0 to v2.0 on read (backward compatible)
  - Content-type-specific extensions (video, audio, image, code, pdf, url)
  - Open extension slot for domain-specific data
  - `extractSpaceContext()` / `extractItemContext()` for AI agent consumption
  - Files: `lib/metadata-schema.js`, `clipboard-storage-v2.js`
- [x] **Quick Search & Deep Search API** - Full search exposed over HTTP for external tools
  - Expanded `GET /api/search` (Quick Search) with all keyword options: depth, fuzzy, highlights, offset
  - Added `GET /api/search/suggestions` for autocomplete/typeahead
  - Added `POST /api/search/deep` (Deep Search) exposing existing GenerativeFilterEngine over HTTP
  - Added `GET /api/search/deep/filters` for filter type discovery
  - Updated TOOL-APP-SPACES-API-GUIDE.md with full docs
  - Files: `spaces-api-server.js`, `TOOL-APP-SPACES-API-GUIDE.md`
- [x] **Data Source Asset Type** - New `data-source` item type for MCP, API, and web scraping sources
  - Subtypes: `mcp`, `api`, `web-scraping` with full connection config, auth reference (no secrets stored), CRUD operations
  - UI: tile cards with status badges, metadata modal with connection/auth/operations editor, create dialog
  - REST API: `/api/data-sources` discovery endpoint for external agents, test connectivity, document management
  - GSX Push: data-source items push to graph with sourceType, protocol, auth type, operations, visibility
  - AI metadata generation for data sources
  - Files: `lib/metadata-schema.js`, `content-ingestion.js`, `clipboard-storage-v2.js`, `clipboard-viewer.js`, `clipboard-viewer.html`, `lib/icon-library.js`, `preload.js`, `clipboard-manager-v2-adapter.js`, `spaces-api-server.js`, `spaces-api.js`, `metadata-generator.js`, `TOOL-APP-SPACES-API-GUIDE.md`
- [ ] **Large space performance** - Slow with 500+ items
- [ ] **Search indexing** - Full-text search could be faster
- [ ] **Sync conflicts** - Better handling when GSX sync conflicts

### GSX Capture
- [ ] **P2P Dual Recording (Phase 1)** - Riverside-style session mode
  - [x] Session mode tab with Host/Join UI
  - [x] OmniGraph signaling module (lib/capture-signaling.js)
  - [x] Memorable single-word session codes (300+ word list)
  - [x] Native WebRTC with vanilla ICE (no third-party deps)
  - [x] Split-view layout with participant labels
  - [x] IPC bridges for session lifecycle
  - [x] Synchronized recording start/stop via data channel
  - [ ] End-to-end testing with two app instances
  - Files: recorder.html, recorder.js, preload-recorder.js, lib/capture-signaling.js
- [x] **Live Captions + Post-Recording Diarized Transcript** (v3.13.x)
  - Live captions during recording via OpenAI Realtime API (WebSocket streaming)
  - Taps mixed audio (system + mic) at 24kHz, converts to PCM16, streams to Whisper
  - Caption overlay at bottom of preview with toggle button (C key shortcut)
  - Auto-triggers ElevenLabs Scribe diarized transcription after save-to-space
  - Saves transcription.json + transcription.txt with speaker labels alongside recording
  - **Live transcript .md file** written to target space every 5s for agent consumption
    - Structured markdown with timestamps, session metadata, recording status
    - Written to `live-transcript.md` in the selected space (or gsx-agent fallback)
    - Agents can poll this file to evaluate and emit events in real time
    - Final flush on recording stop marks file as ended
  - **Meeting Monitor Agent** -- real-time health + conversation monitor
    - Auto-starts when recording begins, stops when recording ends
    - Polls `live-transcript.md` every 10s: parses health table + transcript lines
    - Rule-based fast checks: audio silence (30s+), dead video track, captions disconnected
    - LLM-based transcript analysis: detects "you broke up", "can't see your screen", etc.
    - Emits toast alerts in the recorder with specific fix suggestions
    - 30s cooldown between alerts to avoid spam; alert history saved to agent memory
    - Health metrics in transcript: video/mic/desktop active, audio level (RMS), silence detection, errors
    - System diagnostics: CPU % (app), load average, memory % + free MB, battery state, throttled windows
    - Reuses existing ResourceManager for CPU/memory/battery (no duplicate monitoring)
    - Agent detects: high CPU (>80%), high memory (>85%), battery power, throttled windows
  - Files: recorder.html, recorder.js, preload-recorder.js, packages/agents/meeting-monitor-agent.js, packages/agents/agent-registry.js
- [ ] **P2P Dual Recording (Phase 2)** - Guest track transfer
  - [ ] Transfer guest recording to host via WebRTC data channel
  - [ ] Save both tracks to Space
- [ ] **P2P Dual Recording (Phase 3)** - Post-processing
  - [ ] FFmpeg merge with layout options (side-by-side, PiP, speaker view)

---

## 🟡 Medium Priority

### Clipboard Manager
- [ ] **Image paste quality** - Some images lose quality
- [ ] **Large file handling** - Slow with files >50MB
- [ ] **Duplicate detection** - Sometimes misses near-duplicates

### Smart Export
- [ ] **Style guide caching** - Re-fetches on every export
- [ ] **PDF export formatting** - Some layouts break
- [ ] **Custom template editor** - No UI for editing templates

### External AI Agents
- [ ] **Session persistence** - Conversations lost on restart
- [ ] **Multi-window support** - Can't have same agent in multiple windows
- [ ] **Keyboard shortcuts** - No shortcuts for switching agents

### Custom Agents
- [x] **App Agent** - Voice agent that knows all app features (v3.10.x)
  - Answers questions about any feature
  - Guided tours for each product
  - Tracks which features user has explored
  - Files: `packages/agents/app-agent.js`, `packages/agents/agent-registry.js`
- [x] **Recorder Agent** - Voice agent that launches video capture (v3.10.x)
  - "Record a video" / "Start recording" opens GSX Capture
  - "Capture my screen" hints at screen recording mode
  - "Record for [space name]" pre-selects space for saving
  - Files: `packages/agents/recorder-agent.js`, `packages/agents/agent-registry.js`
- [ ] **Agent dashboard** - See which agents are working
- [ ] **Agent chaining** - Connect agents to work together

### IDW Management
- [ ] **Bulk import/export** - No way to backup all IDW configs
- [ ] **Environment detection** - Sometimes misidentifies environment
- [ ] **GSX link validation** - No validation on URL entry

---

## 🟢 Low Priority / Nice to Have

### UI/UX Polish
- [x] **Spaces UI redesign** - Tufte-inspired polish with elegant icons (v3.8.13)
  - ✅ Replaced ALL emoji icons with clean SVG geometric shapes
  - ✅ Updated asset type icons (video, audio, code, PDF, image, HTML, URL, text, file)
  - ✅ Updated space container icons (circle, action buttons)
  - ✅ Applied Tufte principles: consistent spacing, symmetry, minimal decoration
  - ✅ Removed purple/blue accents → neutral gray palette
  - ✅ Standardized border-radius to 4px throughout
  - ✅ Removed gradients → solid colors only
  - ✅ Improved data density: 280px min columns, 12px gaps (15% more visible)
  - ✅ Faster transitions: 0.2s → 0.1s
  - ✅ Removed transform effects (no scale/translateY on hover)
  - ✅ Created reusable icon library (lib/icon-library.js) with 40+ icons
  - ✅ Comprehensive documentation (SPACES-DESIGN-SYSTEM.md, SPACES-TUFTE-POLISH-COMPLETE.md)
  - Files: clipboard-viewer.html (~150+ style changes), clipboard-viewer.js, lib/icon-library.js
- [x] **GSX Capture UI redesign** - Complete UX overhaul (v3.10.x)
  - Replaced all emojis with SVG icons throughout
  - New deep-space dark theme with purple/blue undertones
  - Glassmorphism panels with backdrop-filter blur effects
  - Mode tabs (Camera / Screen / Screen + Camera) replacing dropdown menus
  - 3-2-1 countdown animation before recording starts
  - Real-time audio level meter visualization
  - Keyboard shortcuts (Space=record, Esc=stop, S=save, ,=settings)
  - Animated record button with pulsing ring effect
  - Red glow border on preview during recording
  - Collapsible settings panel with smooth transitions
  - Improved status messages with slide-up animation
  - Shortcuts bar showing available keyboard commands
  - Files: recorder.html
- [x] **Dark/light theme toggle** - Removed from settings (dark-only by design) (v3.13.0)
- [ ] **Font size preferences** - No global font scaling
- [ ] **Window position memory** - Some windows don't remember position
- [ ] **Keyboard navigation** - Incomplete in some modals
- [ ] **Loading states** - Some operations lack feedback

### Performance
- [ ] **Memory usage** - Can grow large with many spaces open
- [ ] **Startup time** - ~5s on cold start, could be faster
- [ ] **Background processes** - Some tasks block UI

### Developer Experience
- [ ] **Hot reload** - Need full restart for most changes
- [x] **Debug logging** - Centralized logging event queue with REST + WebSocket API (v3.12.5)
  - All ~3,000 console.log calls migrated to structured `log.info/warn/error/debug(category, message, data)`
  - Central event queue (`lib/log-event-queue.js`) with ring buffer, file persistence, stats
  - REST API at `http://127.0.0.1:47292` (GET /logs, /logs/stats, /logs/stream, POST /logs)
  - WebSocket at `ws://127.0.0.1:47292/ws` for real-time streaming to external tools
  - IPC bridge (`window.logging`) for renderer processes
  - Settings toggle: `diagnosticLogging` in Settings > General (off/error/warn/info/debug)
  - REST control: `GET/POST /logging/level` for external tools (Cursor) to read/change level at runtime
  - Persisted via `settings-manager.js` -- survives reboots, Cursor can enable/disable without user
  - Shared `attachLogForwarder()` in `browserWindow.js` captures renderer console + crash events
  - Version-stamped log entries (`v` field on every event from `package.json`)
  - Full documentation: `LOGGING-API.md`
- [x] **Test coverage - AI Conversation Capture** - E2E tests for automated conversation capture
  - ✅ Created comprehensive Playwright test suite (`test/e2e/ai-conversation-capture.spec.js`)
  - ✅ Tests all AI services: Claude, ChatGPT, Gemini, Grok, Perplexity
  - ✅ Tests conversation capture, Space creation, formatting, privacy controls
  - ✅ Added test IPC handlers in main.js
  - ✅ Quick start guide: `TEST-AI-CONVERSATION-QUICK-START.md`
  - ✅ Full documentation: `test/README-AI-CONVERSATION-TESTS.md`
  - Run with: `npm run test:e2e:ai-conversation`
- [ ] **Test coverage** - Many features still lack automated tests
  - [x] Voice Orb: 57 structural/functional E2E tests (`test/e2e/voice-orb.spec.js`, `npm run test:orb`)
  - [x] Voice Orb: 68 agent corpus tests (`test/e2e/voice-orb-corpus.spec.js`, `npm run test:orb:corpus`)
    - 30 single-turn queries (6 agents, natural language variations, typos, slang)
    - 6 conversation history pipeline tests (validates exchange.ts fix)
    - 6 multi-turn scenarios (needsInput, cancel, repeat, correction, pronoun resolution)
    - 4 concurrent execution tests
    - 3 serial execution tests
    - 3 task decomposition tests
    - 5 failure/cascade/requeue tests
    - 2 agent subtask infrastructure tests
    - 8 edge cases (garbled, filler, empty, long, ambiguous, dedup, caps, punctuation)
    - 1 cross-agent routing test
  - [ ] Other windows need similar deep E2E coverage (beyond smoke tests)

### Documentation
- [ ] **User guide** - No end-user documentation
- [x] **API documentation** - IPC API not fully documented
  - ✅ Created `TOOL-APP-SPACES-API-GUIDE.md` - Full CRUD HTTP API for external tools
  - Extended `spaces-api-server.js` with complete REST endpoints
- [ ] **Video tutorials** - None exist

---

## 🔵 Technical Debt

### Code Quality
- [ ] **TypeScript migration** - Only `aider-bridge-client.ts` is TS
- [ ] **ESLint configuration** - No linting enforcement
- [x] **Consistent error handling in browserWindow.js** - safeSend/safeExecuteJS helpers standardize error handling (v3.12.x)
- [ ] **Consistent error handling** - Mix of try/catch patterns in other files
- [ ] **Dead code removal** - Multiple `.bak` and legacy files

### Architecture
- [x] **Centralized AI Service** - Unified `lib/ai-service.js` for all LLM providers (OpenAI, Anthropic)
  - Model profiles (fast/standard/powerful/vision/realtime/etc.) configurable in settings
  - Auto-retry with exponential backoff, provider fallback, circuit breakers
  - Pre-call budget gate + post-call cost recording via existing budget-manager
  - IPC bridge for renderer processes (`window.ai.chat()` etc.)
  - All phases complete: agents (18+), tools (video-editor, clipboard, metadata, smart-export), voice/realtime, lib/, src/
  - Old wrappers deprecated: claude-api.js, openai-api.js, unified-claude.js (retained for compatibility)
  - DALL-E image generation migrated via `ai.imageGenerate()`, video transcription via extended `ai.transcribe()`
  - whisperSpeech.ts direct fetch fallback marked `@deprecated` with warning
  - Comprehensive debug logging added across ai-service.js and both adapters (controlled by AI_LOG_LEVEL env)
  - Only remaining exception: voice-sdk-package TypeScript copy (separate package)
- [ ] **State management** - Mix of localStorage, IPC, and global vars
- [ ] **Module system** - Some circular dependencies
- [ ] **Preload script consolidation** - 12+ preload scripts

### Dependencies
- [ ] **Electron version** - Review for security updates
- [ ] **npm audit** - Address any vulnerabilities
- [ ] **Unused dependencies** - Cleanup package.json

---

## Recently Completed

- [x] **Daily Brief Time-Awareness: Past vs Upcoming Events** (v3.14.x)
  - Bug: Daily brief described past events in future tense ("Your first meeting is at 9 AM" when it's 3 PM)
  - Fix: `generateMorningBrief()` now splits events into completed/in-progress/upcoming with status per event
  - `renderBriefForSpeech()` uses correct tense (past tense for completed, present for in-progress, future for upcoming)
  - Added `currentMeeting` (in-progress) and `nextMeeting` (next upcoming) to brief data
  - Free time now shows remaining free time (not total day) when briefing mid-day
  - Conflicts filtered to only show upcoming ones
  - LLM composition prompt updated with explicit time-awareness rules
  - Files: `lib/calendar-store.js`, `packages/agents/daily-brief-agent.js`

- [x] **Memory Management Agent: Cross-Agent Memory Orchestrator** (v3.14.x)
  - Overhauled `packages/agents/memory-agent.js` from single-profile manager to full cross-agent memory orchestrator
  - Uses Claude 4.6 Opus (`powerful` profile with adaptive thinking) for deep reasoning about memory changes
  - On every request, loads the global user profile AND all agent memory files (~20 agents)
  - Opus analyzes the full memory context and decides which agents need updates (not just the user profile)
  - Applies targeted section edits to each relevant agent memory in a single pass
  - Example: "I moved to Portland" -> updates profile Home City + weather agent Home Location + any other agent with Berkeley reference
  - Example: "My name is Robb" -> updates profile Name + scans all agents for name references
  - Example: "Make my daily brief shorter" -> updates daily-brief-agent Briefing Preferences directly
  - "What do you know about me?" synthesizes info from ALL agent memories, not just the profile
  - Handles: view, update, delete, clear_all (with cross-agent cleanup)
  - Audit trail: logs all changes and deletions to agent memory for review
  - **Passive conversation observation**: watches ALL completed conversations and automatically learns
    - Hooked into `task:settled` in `exchange-bridge.js` (replaces old profile-only `extractAndSaveUserFacts`)
    - After every successful agent interaction, `observeConversation()` analyzes the conversation
    - AI determines if anything is worth remembering and routes facts to the right agent memories
    - Example: user tells weather-agent "Portland weather, I just moved there" -> auto-updates profile Home City + weather agent Home Location
    - Rate-limited (45s cooldown) + deduplication buffer to avoid excessive API calls
    - Skips trivial interactions (<8 chars), failed tasks, and self-observations
    - Uses `fast` profile for observation (lightweight), `powerful` profile for explicit memory commands
  - Dependency injection (`_setDeps`) for testability
  - 32 unit tests covering: context gathering, cross-agent updates, deletion, clear_all, LLM contract, edge cases, passive observation pipeline
  - Files: `packages/agents/memory-agent.js`, `test/unit/memory-agent-cross-agent.test.js`, `src/voice-task-sdk/exchange-bridge.js`

- [x] **Daily Brief Orchestration: Scalable Multi-Agent Morning Brief** (v3.12.5)
  - Problem: Morning brief was hardcoded in calendar agent, manually calling weather agent. Would not scale to 10+ agents.
  - Solution: Introduced `getBriefing()` protocol -- agents declare briefing capability, orchestrator discovers and calls them in parallel.
  - 7 briefing agents: time (p1), weather (p2), calendar (p3), email (p4), action-items (p5), meeting-notes (p6), decisions (p7)
  - Priority-sorted contributions composed into cohesive speech via LLM (with simple-concat fallback)
  - Per-agent timeouts (5s) + total timeout (8s) for reliability
  - Pre-screen optimization: 1 fast LLM call narrows 19 agents to ~3-4 candidates before auction (replaces 19 per-agent LLM calls)
  - Routing cache from prior work caches morning brief route after first success
  - New agents just implement `getBriefing()` and are auto-discovered -- zero changes to orchestrator
  - `getBriefingAgents()` exported from agent-registry for discovery
  - 14/14 tests passing (agent discovery, individual contributions, parallel collection, orchestration, priority sorting, scaling)
  - Files: `packages/agents/calendar-agent.js`, `packages/agents/agent-registry.js`, `packages/agents/time-agent.js`, `packages/agents/weather-agent.js`, `packages/agents/email-agent.js`, `packages/agents/action-item-agent.js`, `packages/agents/meeting-notes-agent.js`, `packages/agents/decision-agent.js`, `src/voice-task-sdk/exchange-bridge.js`

- [x] **Full Calendar Agent Overhaul: Recurring Events, Morning Brief, Conflict Detection, Smart Scheduling** (v3.12.5)
  - Built `lib/calendar-store.js`: persistent local calendar with recurring event expansion, conflict detection, free-slot finder, morning brief generation
  - Recurring patterns: daily, weekdays, weekly, biweekly, monthly, yearly, custom with exceptions and per-occurrence overrides
  - Morning brief: day rundown with event count, recurring vs one-off breakdown, conflicts, back-to-back detection, free time, tomorrow preview
  - Conflict detection: finds overlapping events, suggests alternative times, reports back-to-back transitions
  - Free slot finder: respects working hours, finds available blocks of configurable minimum duration
  - Week summary: total meetings, busiest day, free days
  - Integrated into existing calendar-agent.js alongside omnical API support
  - New LLM understanding for: morning_brief, add_recurring, find_free_slots, week_summary, resolve_conflicts
  - Multi-turn flow for recurring creation when details are missing
  - Brief scheduler with configurable morning/evening times
  - Files: `lib/calendar-store.js` (new), `packages/agents/calendar-agent.js` (enhanced)

- [x] **Voice Orb Double-Response Fix** (v3.12.5)
  - Fixed: Pausing music (and other quick tasks) produced two spoken responses (ack + result)
  - Solution: Deferred agent ack by 2.5 seconds; cancelled if task completes before ack fires
  - Added Speech Event Guard test section (#11) to voice-orb-corpus.spec.js to catch this class of bug
  - Files: `src/voice-task-sdk/exchange-bridge.js`, `test/e2e/voice-orb-corpus.spec.js`

- [x] **Test Audit Orchestrator: Auto-Diagnosis + Fix-on-Fail Protocol** (v3.12.5)
  - **Problem**: When the orchestrator found a test failure, it just recorded "failed" and moved on. No diagnostic context was provided, so the AI agent had no information to fix the issue. Task exchange tests only checked if source code constants exist, never tested the actual exchange.
  - Added `_diagnoseFailure()` engine: on every failure, automatically gathers relevant source files, recent log server errors (filtered by area), exchange port health, and produces a specific `FIX:` instruction
  - Added `AREA_SOURCE_MAP`: maps 14 test areas to their source files so diagnosis always points to the right code
  - Added `_suggestFix()`: pattern-matches error types (missing IPC handler, endpoint 404, service down, module not found, exchange not running) and returns specific fix instructions with file paths
  - Added `_checkExchangePort()`: TCP port check on 3456 to verify exchange is actually running (not just that code exists)
  - Added real task exchange tests: `_testExchangeHealth()`, `_testTaskSubmission()`, `_testTaskCancel()` that check port health + verify IPC handlers exist in correct files
  - Added `diagnose <id>` CLI command for on-demand diagnosis of any item
  - Wired diagnosis into `_executeItem()` so every failure auto-outputs DIAGNOSIS block
  - Updated `test-audit.mdc` rule: made fix-on-fail MANDATORY -- AI agent must read diagnosis and fix code immediately, not skip
  - Files: `test/audit/orchestrator.js`, `test/audit/cli.js`, `.cursor/rules/test-audit.mdc`

- [x] **Task Exchange E2E Tests Rewrite -- All Tests Were Silently Broken + LLM Evaluation** (v3.12.5)
  - **Bug fixed**: Every test in `task-exchange.spec.js` was passing while testing nothing. Root cause was three compounding issues:
    1. Wrong IPC namespace: tests called `task-exchange:*` but real handlers are `voice-task-sdk:*`
    2. Channels not in preload whitelist: main window `api.invoke()` has a strict whitelist that doesn't include any task exchange channels, so every call returned `Promise.reject("Invalid invoke channel")`
    3. `.catch(() => null)` swallowed all errors, and `expect(result).toBeDefined()` always passed
  - Fix: Complete rewrite with two-tier test strategy:
    - **Tier 1 (Deterministic)**: Hard assertions on exchange infrastructure, task lifecycle, edge cases (empty input, dedup, gibberish, rapid-fire, cancel) -- no AI needed
    - **Tier 2 (LLM-as-judge)**: Submits real queries through full exchange pipeline, waits for settlement, then LLM evaluates routing accuracy and response quality against per-query rubrics. Score >= 70 required to pass. Deterministic fallback when AI unavailable.
  - All tests use `electronApp.evaluate()` calling `exchange-bridge` functions directly in the main process
  - Added `checkExchangeHealth()` helper to shared test harness
  - Added `submitAndWaitForSettlement()` helper that polls task status until terminal (SETTLED/DEAD_LETTER/HALTED) or timeout
  - Added `llmJudge()` helper that asks `ai.json()` (profile: fast) to score results against rubrics
  - Routing corpus: time, weather, smalltalk, search, app-settings queries with expected agent patterns
  - Edge-case corpus: gibberish, single-word, very-long/multi-topic input, rapid-fire submissions
  - Files: `test/e2e/task-exchange.spec.js`, `test/e2e/helpers/electron-app.js`

- [x] **Conversation History Pipeline Fix + Agent Test Corpus** (v3.12.5)
  - **Bug fixed**: `exchange.ts` line 590 hardcoded `conversationHistory: []` in bid context, dropping all conversation history passed by exchange-bridge. Agents relied on a file-based workaround instead of the proper metadata path.
  - Fix: exchange.ts now passes `task.metadata.conversationHistory` through to bidders via `BiddingContext`
  - Fix: unified-bidder.js now prefers task metadata over file read (file kept as fallback)
  - Fix: Added `conversationText` field to `BiddingContext` type in types/index.ts
  - Created comprehensive agent test corpus: `test/e2e/voice-orb-corpus.spec.js` (68 tests)
    - Single-turn routing (30 queries), history pipeline (6), multi-turn (6), concurrent (4), serial (3), decomposition (3), failure/cascade (5), subtask infra (2), edge cases (8), cross-routing (1)
  - Added `npm run test:orb:corpus` and `npm run test:orb:all` commands
  - Files: `packages/task-exchange/src/exchange/exchange.ts`, `packages/agents/unified-bidder.js`, `packages/task-exchange/src/types/index.ts`, `test/e2e/voice-orb-corpus.spec.js`, `package.json`

- [x] **Voice Orb E2E Test Suite + Bug Fix** (v3.12.5)
  - **Bug fixed**: `global.toggleOrbWindow` was never defined -- function existed but was not attached to `global`, so the smoke test was silently testing nothing (the `if (typeof global.toggleOrbWindow === 'function')` guard always returned false)
  - Added `global.toggleOrbWindow` and `global.showOrbWindow` assignments in `main.js` (consistent with `global.openSettingsWindowGlobal` and `global.openDashboardWindow` pattern)
  - Added `global.orbWindow` reference for window property inspection
  - Created comprehensive E2E test: `test/e2e/voice-orb.spec.js` (57 tests)
    - Window lifecycle (create, show, hide, toggle)
    - Window properties (always-on-top, frameless, transparent, position)
    - Full API surface verification (30+ methods across orbAPI, clipboardAPI, agentHUD)
    - Voice Task SDK integration (status, queues, task management)
    - Chat panel expand/collapse via IPC
    - Position management, click-through toggle
    - Connection status, TTS availability, Agent Composer integration
    - UI element rendering (orb circle, chat panel, input fields)
    - Text chat UI: open panel, type text, render messages, close panel
    - Task submission: agentHUD.submitTask() end-to-end pipeline (text-only, no voice)
    - Queue management: list, stats, pause/resume
    - Event listeners: lifecycle, result, disambiguation, needsInput (register/unregister)
    - Full round-trip: submit task, observe lifecycle events, receive result
    - Disambiguation: cancel, select with invalid state (graceful error handling)
    - NeedsInput: respondToInput with invalid taskId (graceful error handling)
    - Rapid duplicate submissions (deduplication or queuing)
    - Position persistence: set position, read back
    - Context menu: verify expected items exist
    - Legacy orbAPI.submit() classification path
    - Error monitoring throughout
  - Added `npm run test:orb` command and included in `test:journey`
  - Files: `main.js`, `test/e2e/voice-orb.spec.js`, `package.json`

- [x] **Deep Testing & Bug Fix Round 5-9** (v3.12.5)
  - Fixed API handlers returning 500 for "not found" errors -- 8 handlers now properly return 404 with NOT_FOUND code
    - Affected handlers: handleAddItem, handleGetSpace, handleGetItem, handleListItems, handleUpdateItem, handleDeleteItem, handleMoveItem, handleUpdateSpace, handleDeleteSpace
  - Fixed inner API layer (`spaces-api.js`) logging "not found" errors as error level -- downgraded to debug for item lookups and "add to missing space" scenarios
  - Downgraded auto-metadata generation failures from error to warn (non-critical background task, fails when API keys not configured)
  - Downgraded clipboard auto AI metadata failures from error to warn in `clipboard-manager-v2-adapter.js`
  - Fixed `pricing-config.js` crash when `resolveModelName` receives non-string input (undefined, null, object) -- added type guard with graceful fallback to default model
  - Verified across 9 test rounds covering: 404/400 handling, CRUD, 6 content types, tags CRUD, bulk parallel ops (10 concurrent), race conditions (create+delete), item lifecycle (create->tag->pin->move->delete), large content (up to 1MB), unicode/emoji/special chars, search, smart folders, space metadata, WebSocket upgrade, SSE stream, CORS, 76 file integrity checks, 33 module require chains, 27 agent loads, 11 pricing calculations, 5 preload scripts, 6 HTML files, 49 icons
  - Final verification: 26/26 comprehensive suite passing, 0 errors on startup, 0 app errors after full test suite
  - Files: `spaces-api-server.js`, `spaces-api.js`, `clipboard-manager-v2-adapter.js`, `pricing-config.js`

- [x] **Code Scan & Bug Fix Round 3-4** (v3.12.5)
  - Fixed `gpt-5.2` fallback in main.js LLM usage tracker (model doesn't exist, changed to `gpt-4o`)
  - Fixed `gpt-5.2` references in deprecated openai-api.js (5 instances)
  - Fixed broken require for `migrate-to-v2-storage` -- script doesn't exist, added graceful fallback
  - Added null guards to smart folder CRUD operations (`data.folders` could be undefined)
  - Scanned codebase: verified all pricing callers use `.totalCost`, all critical imports resolve
  - Files: `main.js`, `openai-api.js`, `clipboard-manager-v2-adapter.js`, `spaces-api.js`

- [x] **Deep Testing & Bug Fix Round 2** (v3.12.5)
  - Fixed clipboard index save race condition (ENOENT on rename) -- unique temp filenames + concurrency guard
  - Fixed OpenAI `gpt-5.2` 400 errors in ai-service.js -- model doesn't exist, changed to `gpt-4o`
  - Fixed DuckDB nested transaction errors -- added `_dbTransaction()` serialization mutex across all 4 transaction sites
  - Fixed metadata race condition -- auto-metadata update on deleted items downgraded from error to debug
  - Fixed GET /api/spaces/:id response inconsistency -- now returns wrapped `{ space: {...} }` matching POST/LIST
  - Fixed content validation errors returning 500 -- invalid types now return 400 with VALIDATION_ERROR code
  - Added /api/search/suggest alias for /api/search/suggestions endpoint
  - Removed false "Failed to mount conversion routes" warning (raw HTTP server, not Express)
  - Downgraded fire-and-forget DuckDB errors (insert, delete, pin, move, space ops) from error to warn
  - Files: `clipboard-storage-v2.js`, `lib/ai-service.js`, `spaces-api-server.js`, `spaces-api.js`, `clipboard-manager-v2-adapter.js`

- [x] **Settings Panel Redesign** (v3.13.0)
  - Added tabbed sidebar navigation (6 tabs: API Keys, AI Configuration, OneReach Login, GSX File Sync, Budget, General)
  - Removed deprecated settings: Theme dropdown (unimplemented), Headless Claude (3 settings, superseded by AI service), legacy screenshot metadata toggle, Voice Context Provider toggles (5 toggles, never wired to backend)
  - Added Budget controls UI (enable tracking, show estimates, confirmation threshold)
  - Added AI Conversation Capture controls (9 sub-settings now configurable)
  - Fixed typo: `privateModeBySefault` -> `privateModeByDefault` in settings-manager.js
  - Fixed default provider mismatch (aligned to `anthropic`)
  - Updated E2E tests and test plans

- [x] **File Conversion Service: 59 Agentic Converter Agents** (v3.12.2)
  - Built `lib/conversion-service.js` -- central orchestrator with registry, pipeline resolver, job manager
  - Built `lib/converters/base-converter-agent.js` -- base class with plan/execute/evaluate lifecycle, agentic retry, comprehensive event logging
  - 59 converter agents across 12 categories: Image (4), Video (6), Audio (4), Markdown (6), HTML (3), PDF (4), Office (10), Data (5), URL (5), Playbook (6), Code (4), AI Generation (2)
  - Playbook validator + LLM diagnostics for structured note validation
  - REST API via `lib/conversion-routes.js`, IPC bridge in preload.js, `window.convert` API
  - 799 tests (792 unit + 7 eval) across 66 test files -- all passing
  - Event logging: 20+ structured event types per conversion for debugging (converter:start, plan, execute, evaluate, retry, success/fail)
  - Pipeline resolver: BFS graph traversal for multi-step conversions (e.g., PDF -> Playbook via pdf-to-text -> content-to-playbook)
  - Documentation: `lib/converters/README.md`, `CONVERSION-API.md`

- [x] **Full API Migration: LLM + HUD + Spaces v3 Git** (v3.17.x)
  - **Phase 1 - LLM API Consolidation**: Migrated 8 files from direct fetch/https.request to `lib/ai-service.js`:
    - `embedder.ts` (both copies) -> `ai.embed()`
    - `answerGenerator.ts` (both copies) -> `ai.chat()`
    - `whisperSpeech.ts` (both copies) -> `ai.transcribe()` via injectable `transcribeFn`
    - `main.js` test-openai-connection -> `ai.chat()`
    - `clipboard-manager-v2-adapter.js` -> new `ai.imageEdit()`
  - Added `ai.imageEdit()` and `ai.imageGenerate()` to `ai-service.js` and `openai-adapter.js` (DALL-E/gpt-image-1)
  - Extended `ai.transcribe()` with `timestampGranularities` and `verbose_json` support (word-level timestamps)
  - Removed dead `_getOpenAIApiKey()` code from `exchange-bridge.js`
  - Legacy wrappers already marked `@deprecated` (claude-api.js, unified-claude.js, openai-api.js)
  - **Phase 2 - HUD API Completion**: Extended `lib/hud-api.js` with:
    - Disambiguation support (emit, subscribe, select, cancel)
    - Multi-turn conversation (emitNeedsInput, onNeedsInput, respondToInput)
    - Agent-specific submission via `targetAgentId` option
    - Queue statistics via `getQueueStats()`
    - Transcription proxy via `transcribeAudio()`
  - Wired exchange-bridge disambiguation/needs-input events through centralized HUD API
  - Added HUD API event listeners to `orb.html` and `command-hud.html`
  - Updated `preload-hud-api.js` with all new IPC methods
  - **Phase 3 - Spaces v3 Git Integration**: Added Git versioning to agent-space-registry:
    - `_commitAgentSpaceChange()` helper with descriptive commit messages
    - Auto-commits on create, assign, remove, toggle, set-default, delete operations
    - Non-blocking: Git failures don't break operations
  - **Testing**: 166 passing tests (51 new), covering all new methods
  
- [x] **App Menu API Refactor** (v3.16.x)
  - Extracted GSX auto-login system (~1,520 lines) from `menu.js` into `lib/gsx-autologin.js`
  - Extracted GSX window tracking into `lib/gsx-window-tracker.js`
  - Broke `createMenu` into section builder modules under `lib/menu-sections/`
  - Promoted `MenuDataManager` as single Menu API entry point with `refresh()`, `rebuild()`, `refreshGSXLinks()`, `findMenuItem()`, `getOpenableItems()`
  - Updated 20+ direct `require('./menu')` call sites in `main.js` to use `global.menuDataManager`
  - Updated `exchange-bridge.js` and `app-agent.js` to use `MenuDataManager` for menu item search
  - Reduced `menu.js` from ~4,900 lines to ~1,700 lines (65% reduction)

- [x] **Centralized HUD API + Agent Spaces Architecture** (v3.15.x)
  - Agent Space Registry (`lib/agent-space-registry.js`) - groups agents by context (Git-backed Spaces v3.0)
  - Centralized HUD API (`lib/hud-api.js`) - unified task submission, events, items for any tool
  - Remote Agent Client (`lib/remote-agent-client.js`) - HTTP protocol for GSX-hosted agents (bid/execute/health)
  - Shared preload (`preload-hud-api.js`) - `window.agentHUD` available in orb, command HUD, recorder
  - Space-scoped bidding - exchange filters agents by `task.metadata.agentFilter` during auction
  - 3 meeting agents: action-item-agent, decision-agent, meeting-notes-agent (defaultSpaces: meeting-agents)
  - Glass HUD overlay in recorder with colored name pills, @mention, agent toggles, P2P sync
  - Agent Manager updated with meeting agent entries and space badges
  - 115 automated tests in `test-hud-api.js` (all passing)

- [x] **Persistent Memory & Session Continuity** (v3.14.x)
  - Global User Profile (`lib/user-profile-store.js`) - cross-agent shared memory about the user
  - Conversation persistence across restarts (save/restore to `conversation-state.json`, 1hr staleness)
  - Session summaries - LLM-generated 1-line summaries archived to `session-summaries.md` (last 10)
  - Active learning pipeline - extracts user facts from interactions, saves to profile (rate-limited)
  - User profile injected into bidding context and task metadata for all agents
  - Weather agent syncs home location to global profile (not just agent memory)

- [x] **Task Exchange Architecture Overhaul** (v3.13.x)
  - All keyword/regex bidding removed from every agent -- 100% LLM-based routing via unified-bidder.js
  - Added `executionType` property to all agents (informational/action/system) for fast-path guidance
  - Result-in-bid fast path: informational agents can answer directly in bid, skipping execution
  - Lock/unlock task lifecycle with HUD countdown timer and events
  - Error agent (system, bidExcluded) for graceful failure handling on dead-letter tasks
  - LLM-based disambiguation replaces keyword-based getSuggestionsForTask()
  - Task decomposition: decomposeIfNeeded() splits composite requests before auction
  - submitSubtask.andWait() for agents to await subtask results with Promise
  - Master evaluator cost guard (skip LLM when top bid is dominant)
  - Multi-agent execution: executeSeries() and executeParallel() in exchange.ts
  - Default subtask routing changed from 'locked' to 'open' for fair auctions
  - HUD: lock indicator, decomposition banner, error-routed banner

- [x] **GSX Capture screen/camera recording fix + full audio mixing + Spaces save** (v3.12.x)
  - Fixed: `desktopCapturer` removed from preload context in Electron 39 (main-process only now)
  - Moved screen source enumeration to main process IPC handler (`recorder:get-screen-sources`)
  - Updated `preload-recorder.js` to use IPC instead of direct `desktopCapturer` call
  - Added missing `AudioWorklet` and `WebAudio` blink features to recorder BrowserWindow (needed for audio mixing)
  - Added `experimentalFeatures: true` to recorder webPreferences
  - Full audio mixing for ALL screen recording modes (not just PiP):
    - Desktop/system audio capture with volume control
    - Microphone audio with volume control
    - External Mic 1 and External Mic 2 with independent volume controls
    - AudioContext-based mixing with real-time gain adjustment
    - Audio Mixing panel now visible for both Screen and Screen + Camera modes
  - **Recordings now save to Spaces properly:**
    - Rewritten `recorder:save-to-space` handler uses `clipboardManager.storage.addItem()` instead of raw file writes
    - Videos indexed as `type: 'file'` with `fileCategory: 'video'` so they appear in Spaces UI
    - Registered in DuckDB, JSON index, and in-memory history
    - UI notified automatically so recording shows up in Spaces immediately
    - Space selection is now required (no more silent save to hidden folder)
    - Success message shows space name
  - **Upfront space selection on launch:**
    - "Save to" space selector always visible between mode tabs and controls bar
    - Pulses with red border when no space is chosen to prompt user
    - Pre-populated from recorder agent instructions (spaceId)
    - Syncs bidirectionally with save dialog space dropdown
    - Audio mixing panel now shown for screen mode (not just PiP)
  - Proper resource cleanup on mode switch and window close
  - Replaced all emoji icons with Tufte SVG icons (mic, desktop, external mic labels, instructions header, optgroup labels)
  - Added new icons to icon library: `microphone`, `monitor`, `camera`, `layers`, `list`
  - Files: `recorder.js`, `preload-recorder.js`, `recorder.html`, `lib/icon-library.js`
- [x] **Main window hardening and bug fixes** (v3.12.x)
  - Destroyed window crash prevention: `safeSend()` and `safeExecuteJS()` helpers guard all IPC and JS injection
  - Memory leak fix: `gsxAutoLoginState` Map entries cleaned up on GSX window close
  - Timer leak fix: auto-login retry functions abort when window is destroyed
  - Canvas data corruption fix: removed `toDataURL` override that added random noise to ALL canvas exports
  - Shutdown state fix: `isShuttingDown` flag resets properly on window recreation
  - Injection vulnerability fix: GSX auth status uses `JSON.stringify` instead of template literals in injected JS
  - Code deduplication: extracted `sendFileToBlackHoleWidget()`, eliminating ~150 lines of duplicated download-to-space logic
  - IPC listener leak fix: widget-ready listener now has 10s timeout cleanup
  - Context menu crash fix: null/destroyed guards prevent errors during shutdown
  - Auth token broadcast: guards against sending to destroyed windows
  - CSP hardened: removed `*` wildcard from all 5 Content-Security-Policy blocks (main, secure, wizard, test, GSX windows)
  - Files: `browserWindow.js`
- [x] **Spaces resilience and hardening** (v3.12.x)
  - Path traversal protection: file paths validated and resolved to stay within space directory (spaces-api.js, spaces-api-server.js)
  - Request body size limit (10 MB) and malformed URL/request error handling (spaces-api-server.js)
  - ID and path segment validation for spaceId, itemId, folderId, filePath, tagName (spaces-api-server.js)
  - Index load: fallback to default index when both primary and backup are corrupt; optional .corrupt rename (clipboard-storage-v2.js)
  - Async index save: retry with backoff on failure (clipboard-storage-v2.js)
  - DuckDB: mark unavailable and single retry after reinit on connection-style errors (clipboard-storage-v2.js)
  - ensureDirectories wrapped in try/catch with clear error (clipboard-storage-v2.js)
  - JSON parse errors return 400 with code INVALID_JSON; structured error codes across handlers (spaces-api-server.js)
  - limit/offset query params clamped (max 1000, non-negative) (spaces-api-server.js)
  - WebSocket max payload size 1 MB (spaces-api-server.js)
  - /api/status includes databaseReady and database status (spaces-api-server.js)
  - Extension auth token: retry write once and log when not persisted (spaces-api-server.js)
  - Files: `spaces-api.js`, `spaces-api-server.js`, `clipboard-storage-v2.js`
- [x] **GSX Push to Graph - Assets & Spaces** (v3.10.x)
  - Push individual assets or entire spaces to GSX ecosystem (Files + Graph)
  - Two-layer storage: Binary files to GSX Files API, all metadata to OmniGraph
  - Schema-first workflow following Graph Ontology Guide
  - Features:
    - Push modal with public/private visibility selection
    - Bulk push with progress tracking
    - Context menu actions: Push, Push Changes, Unpush, Change Visibility
    - Copy links: File URL, Share Link, Graph Node ID
    - GSX tab in metadata panel showing status and links
    - Status indicators: Not Pushed, Pushed, Changed Locally, Unpushed
    - Galaxy-themed status icons with pulse animation for changes
  - Files: `omnigraph-client.js`, `spaces-api.js`, `clipboard-viewer.html`, `clipboard-viewer.js`, `lib/icon-library.js`, `clipboard-storage-v2.js`, `main.js`, `preload.js`
- [x] **Metadata Modal AI Tab Missing for PDFs** (v3.10.x)
  - Fixed AI tab visibility in metadata modal - was only showing for web-monitor items
  - Now shows "AI" tab for all items (PDFs, images, files, etc.) with "Generate with AI" button
  - Web-monitor items show "AI Watch" tab with monitoring instructions
  - Files: `clipboard-viewer.js` (line 4420-4430)
- [x] **Calendar Agent Duplicate Execution Fix** (v3.10.x)
  - Fixed: Calendar tasks executing twice when submitted
  - Root cause: Deduplication key included `task.id` which is unique per submission
  - Solution: Changed dedup key to use normalized content only, increased window to 5 seconds
  - File: `packages/agents/calendar-agent.js`
- [x] **IDW Tab Persistence Fix** (v3.10.x)
  - Fixed: IDW tabs not persisting across app restarts
  - Root causes identified and fixed:
    1. `saveTabState()` used `tab.webview.src` which may be empty during async token injection → now uses `tab.currentUrl`
    2. `save-tabs-state` IPC message was never sent from main process → added to `before-quit` handler
    3. Plus button opened homeUrl instead of chatUrl → fixed to prioritize chatUrl
  - Also added:
    - Validation to skip invalid tabs (empty URLs) during restoration
    - `beforeunload` event handler as backup for saving tabs
  - Files: `browser-renderer.js`, `main.js`
- [x] **Custom Agent Improvements** (v3.10.0)
  - Better voice command routing to the right agent
  - Undo/revert support when editing custom agents
  - New agents work immediately without app restart
  - Improved reliability with automatic retry on failures
- [x] **Space Filtering Race Condition Fix** (v3.8.14)
  - Fixed: Clicking a space would briefly show filtered items then revert to showing all
  - Root cause: Chunked rendering callbacks from previous renders continued running
  - Solution: Added render version tracking to cancel stale render operations
  - Also fixed: `onSpacesUpdate` listener calling non-existent `renderSpacesList()` function
  - Files: `clipboard-viewer.js`
- [x] **Bulk Operations for Spaces** (v3.8.16)
  - **Bulk Delete**: Select and delete multiple items at once
    - Multi-select checkboxes on all items (hidden by default, appear on hover)
    - Bulk actions toolbar with Select All, Deselect All, and Delete Selected
    - Backend API `items.deleteMany()` for efficient bulk deletion
    - Visual feedback: selected items highlighted, loading states during deletion
  - **Bulk Move**: Move multiple items to another space
    - "Move to Space" button in bulk actions toolbar
    - Dropdown picker showing all available spaces with item counts
    - Backend API `items.moveMany()` for efficient bulk moving
    - Excludes current space from dropdown options
  - IPC handlers: `clipboard:delete-items` and `clipboard:move-items`
  - Comprehensive error reporting with success/failure counts
  - Files: `clipboard-viewer.html`, `clipboard-viewer.js`, `spaces-api.js`, `clipboard-manager-v2-adapter.js`, `preload.js`
- [x] **Grok External AI Agent Integration** (v3.8.15)
  - Added Grok to external AI agents in setup wizard
  - Integrated with conversation capture system
  - Added Grok quick-add button in agent configuration
  - Conversation capture creates dedicated "Grok Conversations" Space (🚀 Gray)
  - Full support for URL detection (x.ai, grok.x.com)
  - Updated documentation: ROADMAP.md, test/EXTERNAL-AI-TEST-README.md
  - Files: `setup-wizard.html`, `main.js`, `src/ai-conversation-capture.js`
- [x] **Spaces Upload Integration** (v3.8.14)
  - Upload files from Spaces directly into ChatGPT, Claude, and file pickers
  - Native dialog wrapping: Shows "Choose from Computer" | "Choose from Spaces"
  - WebView button injection: Adds "📦 Spaces" button to file inputs
  - Settings toggle: Enable/disable in Settings → General
  - Files: `wrapped-dialog.js`, `spaces-upload-handler.js`, `spaces-picker.html`
  - Documentation: `SPACES-UPLOAD-QUICK-START.md`, `SPACES-UPLOAD-TESTING-GUIDE.md`
- [x] **Video Editor prompt() Fix** (v3.8.14)
  - Fixed crash when opening projects with no videos
  - Replaced browser prompt() with Electron-compatible modal
  - Added visual video selection UI with hover effects
  - Shows video metadata (duration, filename)
  - Documentation: `VIDEO-EDITOR-PROMPT-FIX.md`
- [x] **YouTube Download Status Fix** (v3.8.14)
  - Fixed download status not updating to "complete" after 100%
  - Fixed title staying as "Loading..." instead of actual video title
  - Fixed preview text not updating with final title
  - Added index persistence after download completes
  - Documentation: `YOUTUBE-DOWNLOAD-STATUS-FIX.md`
- [x] **Video Editor Spaces API Migration & FFprobe Fix** (v3.8.14)
  - Migrated to universal Spaces API for consistency
  - Added `window.spaces.api` with full CRUD operations
  - Backwards compatible with legacy methods
  - Created diagnostic tool (`diagnose-videos.js`)
  - Added FFprobe binary validation and better error messages
  - Documentation: Multiple guides created (see VIDEO-LOADING-RESOLUTION.md)
  - Note: Video path resolution works; FFprobe binary may need reinstallation
- [x] **Missing import fix** (v3.8.13)
  - Fixed closeAllGSXWindows not imported in main.js
  - Rebuilt keytar native module for ARM64 compatibility
  - Fixes: App launch error "js undefined undefined"
- [x] **Zombie window prevention and app quit fixes** (v3.8.12)
  - Added app lifecycle handlers (before-quit, window-all-closed, will-quit)
  - GSX window tracking system with forced close
  - IPC heartbeat system to prevent zombie windows
  - Proper cleanup of intervals and listeners
  - Close button in GSX toolbar for convenience
  - Fixes: App not quitting, windows not closing after hours open
- [x] **Spaces API tags not saving/retrieving** - Fixed tag handling in HTTP API
  - `handleSendToSpace` now extracts tags from request (root level or metadata.tags)
  - `items.get` now returns tags at root level consistently
  - Updated API documentation
- [x] Hardened release script with checksum verification (v3.7.0)
- [x] Task queue persistence for GSX Create (v3.7.0)
- [x] Graceful shutdown with state save (v3.7.0)
- [x] Phase-specific animations in GSX Create (v3.7.0)
- [x] Execute phase hexagon dot styling (v3.7.0)
- [x] Agent activity HUD with glassmorphism (v3.6.0)
- [x] LLM summarization of agent activity (v3.6.0)
- [x] Budget integration for summaries (v3.6.0)

---

## Notes

### Adding Items
When adding items to this list:
1. Choose appropriate priority section
2. Include brief description
3. Reference relevant files if known
4. Add any related documentation links

### Completing Items
When completing items:
1. Mark with [x]
2. Move to "Recently Completed" with version
3. Update any related documentation

### Priority Definitions
- 🔴 **Critical**: Blocks distribution or causes data loss
- 🟠 **High**: Significant user-facing issues
- 🟡 **Medium**: Improves experience but has workarounds  
- 🟢 **Low**: Nice to have, polish items
- 🔵 **Tech Debt**: Internal improvements

