# Onereach.ai Punch List

> Master list of bugs, fixes, and small features to address.
> Updated: February 2026 | Current Version: 4.2.0

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

### Web Monitors
- [x] **Web monitors completely broken** - All monitor items had empty URLs, never checked (v4.1.x)
  - Root cause: `clipboard:check-website` handler created `type: 'text'` change-notification items in web-monitors space; migration then corrupted them to `type: 'web-monitor'` with empty URLs
  - Fix 1: Migration now extracts URLs from content text ("URL: https://..."), deduplicates items by URL, keeps one canonical monitor per URL
  - Fix 2: `check-website` handler now calls `handleWebsiteChange()` (updates timeline) instead of creating new items
  - Fix 3: Startup sync re-registers clipboard monitors into WebsiteMonitor in-memory state
  - Fix 4: `check-monitor-now` recovers URL from content if index field is empty
  - Fix 5: Removed stray label syntax (`info:`) in `createWebsiteMonitorFromURL`
  - Files: `clipboard-manager-v2-adapter.js`

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

### Playbook Executor Service
- [x] **Claude Code Runner Modernization** - Replace execSync with async spawn (v3.20.x)
  - Non-blocking execution, concurrent sessions via Map, --output-format json/stream-json
  - Session management (--resume, --session-id), safety controls (--max-turns, --max-budget-usd)
  - MCP config injection, real token tracking from JSON response
  - Files: `lib/claude-code-runner.js`

### First-Class Custom Agents
- [x] **Phase 1: ai-service migration** - Replace Claude Code CLI spawns with ai.chat() in executeLocalAgent()
  - Custom agents now use centralized AI service instead of heavy CLI binary spawns
  - Conversation history included for multi-turn context
  - Files: `src/voice-task-sdk/exchange-bridge.js`
- [x] **Phase 2: Agent schema v2** - Upgraded agent config with voice, acks, memory, briefing, multiTurn
  - Schema migration for existing agents, new AGENT_SCHEMA_VERSION constant
  - Files: `src/voice-task-sdk/agent-store.js`
- [x] **Phase 3: Thinking pattern for custom agents** - Memory, learning, subtask support
  - Custom agents now initialize memory, load preferences, learn from interactions
  - Custom agents with briefing.enabled contribute to daily brief
  - Files: `src/voice-task-sdk/exchange-bridge.js`, `packages/agents/daily-brief-agent.js`
- [x] **Phase 4: v2 agent generator** - Enriched config output with bidding guidance
  - Generator uses ai.chat() (not CLI), produces voice, acks, memory, briefing config
  - Structured HIGH/LOW CONFIDENCE bidding guidance in prompts
  - Files: `lib/ai-agent-generator.js`
- [x] **Phase 5: Composer UX upgrade** - Voice picker, memory/briefing toggles, test status
  - Agent preview card shows v2 config controls (voice, memory, briefing, multi-turn)
  - Controls sync changes back to draft in real-time
  - Files: `claude-code-ui.html`, `preload-claude-code.js`, `main.js`
- [x] **Phase 6: Testing pipeline** - Scenario generation, validation, persistence
  - Auto-generate positive/negative test scenarios from agent description
  - Full test suite runner with result persistence to agent-store
  - Test status badge (passed/failed) in composer UI
  - Files: `lib/agent-auto-tester.js`, `preload-claude-code.js`, `main.js`
- [x] **Playbook Executor** - Job-based async execution of playbooks in Spaces (v3.20.x)
  - REST API on port 47291: POST /api/playbook/execute, GET jobs/:id, POST respond, cancel
  - Human-in-the-loop pause/resume via _pause.json convention
  - Loads space context (playbook, data sources, assets), builds system prompt, executes via Claude Code
  - Stores typed outputs (UI, documents, data, code) back into space
  - Files: `lib/playbook-executor.js`, `spaces-api-server.js`
- [x] **Spaces Sync Layer** - Git commit + GSX Files + OmniGraph sync (v3.20.x)
  - Push: local git commit, upload files to GSX, upsert metadata + ticket status to OmniGraph
  - Pull: fetch remote state from graph
  - Files: `lib/spaces-sync.js`
- [x] **Playbook Agent** - Voice/HUD agent for playbook execution (v3.20.x)
  - Handles "Run the playbook in my space", status checks, question relay, cancel
  - Files: `packages/agents/playbook-agent.js`
- [x] **Playbook IPC + Preload Bridges** - window.playbook and window.sync APIs (v3.20.x)
  - Files: `main.js`, `preload.js`, `preload-spaces.js`, `preload-minimal.js`
- [x] **Playbook API Tests** - Unit + E2E with UXmag email use case (v3.20.x)
  - Files: `test/unit/playbook-executor.test.js`, `test/e2e/playbook-api.spec.js`

### Voice / Agent Exchange
- [x] **Calendar Agent: replaced regex pre-routing with LLM-driven classification** - "Cancel the Weekly Sync" was misrouted to recurring creation because regex matched "Weekly Sync"
  - Root cause: 6 regex-based pre-route detectors (`_isBriefRequest`, `_isRecurringRequest`, etc.) matched keywords in event names, ignoring user intent -- violated project's "no regex classification" rule
  - Fix: Removed all regex pre-routing. All requests now flow through `_askLLMAboutCalendar` which understands intent semantically. Updated the LLM system prompt to cover all action types (morning_brief, week_summary, find_free_slots, add_recurring, resolve_conflicts, delete_event, add_event, event_details). Added `recurring_create` handler to `_handleLocalAction`.
  - File: `packages/agents/calendar-agent.js`
- [x] **Calendar Agent empty-response crash** - Opus 4.6 with adaptive thinking returns empty text content (~247 occurrences)
  - Root cause: `thinking: true` consumed all output tokens for thinking, returned empty text block
  - Systemic fix: Downgraded from `powerful` (Opus $0.11/call) to `standard` (Sonnet ~$0.005/call) -- calendar queries are data lookup, not deep reasoning
  - Removed `thinking: true` from all 3 ai.chat() calls (main query, intent understanding, recurring parsing)
  - Trimmed system prompt from ~1100 words to ~250 words (removed pre-routed action handlers that never reach the LLM)
  - Protected UI rendering in try/catch; fixed error logging (Error objects serialized as `{}`)
  - Files: `packages/agents/calendar-agent.js`, `.cursorrules`
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
- [x] **Orb Control API for external apps** - Web apps in webviews can programmatically control the Voice Orb
  - API: `window.orbControl` with hide, show, toggle, isVisible, getStatus
  - HUD items: addHUDItem, removeHUDItem, getHUDItems, clearHUDItems (scoped to toolId 'external-app')
  - Events: onVisibilityChange, onStatusChange (with cleanup functions)
  - Security: Only available to OneReach sites (via preload-minimal.js gating)
  - Follows shared-preload-module pattern (like preload-hud-api.js)
  - Files: `preload-orb-control.js`, `preload-minimal.js`, `main.js`
- [x] **Search Agent: GSX Search Serper API** - Search agent now uses OneReach GSX Search Serper API as primary search method
  - Primary: GSX Search API (`GET /gsx-search?query=`) returns structured Google results via Serper
  - Fallback 1: Webview search (hidden BrowserWindow)
  - Fallback 2: DuckDuckGo Instant Answer + Lite APIs
  - Parses organic results, People Also Ask, and Knowledge Graph
  - Endpoint: `https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/gsx-search`
  - Files: `packages/agents/search-agent.js`

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
- [x] **Remote Space Discovery** - Discover and import spaces from OmniGraph by email
  - OmniGraph queries: `getSpacesByUser(email)` for owned spaces, `getSharedWithMe(email)` for shared
  - Combined `discoverSpaces(email)` deduplicates and returns unified list with source (owned/shared)
  - Spaces API `discovery` namespace: `discoverRemoteSpaces()`, `importRemoteSpace()`, `importAll()`
  - REST API: `GET /api/spaces/discover`, `POST /api/spaces/discover` (import)
  - IPC: `spaces:discover`, `spaces:discover:import` with preload bridge
  - Auto-polling (60s interval with exponential backoff on failure) + manual "Discover Spaces" button
  - Discovery banner UI in Spaces Manager with per-space checkboxes and import controls
  - Files: `omnigraph-client.js`, `spaces-api.js`, `spaces-api-server.js`, `main.js`, `preload-spaces.js`, `lib/spaces-sync.js`, `clipboard-viewer.js`, `clipboard-viewer.html`
- [ ] **Large space performance** - Slow with 500+ items
- [ ] **Search indexing** - Full-text search could be faster
- [ ] **Sync conflicts** - Better handling when GSX sync conflicts

### WISER Meeting
- [x] **Space selector in session setup** - Added space dropdown to "Start a WISER Meeting" page so users can select a space directly from the setup panel instead of scrolling to the bottom panel
  - Session space selector syncs bidirectionally with main targetSpace and save dialog
  - Highlights with red border when no space selected and user tries to host
  - Files: recorder.html
- [x] **Mobile PiP self-view on guest page** - Guest page now shows a FaceTime-style floating self-view overlay on mobile instead of 50/50 split
  - Remote participant takes full screen, local video is a small rounded overlay (bottom-right)
  - Draggable via touch with viewport clamping
  - Mirrored (selfie-style) for natural appearance
  - Auto-switches between PiP (mobile) and grid (desktop) on resize/rotation
  - Files: lib/capture-guest-page.js
- [x] **Guest page remote audio fix** - Added explicit play() for remote audio tracks on guest page
  - Browsers block autoplay; now retries on next user gesture with "Tap anywhere to enable audio" prompt
  - Fixed Electron autoplay-policy switch (was set too late, after app.whenReady)
  - Files: lib/capture-guest-page.js, main.js
- [x] **Guest page meeting controls** - Added essential meeting controls to guest page
  - Mute/unmute microphone toggle (circular button with icon swap, mutes LiveKit track)
  - Camera on/off toggle (circular button with icon swap, mutes LiveKit camera track)
  - Device settings panel (gear icon opens slide-up with mic and camera dropdowns)
  - Device switching republishes tracks to LiveKit, respects current mute/camera-off state
  - Files: lib/capture-guest-page.js
- [ ] **P2P Dual Recording (Phase 1)** - Riverside-style session mode
  - [x] Session mode tab with Host/Join UI
  - [x] OmniGraph signaling module (lib/capture-signaling.js)
  - [x] Memorable single-word session codes (300+ word list)
  - [x] Native WebRTC with vanilla ICE (no third-party deps)
  - [x] Split-view layout with participant labels
  - [x] IPC bridges for session lifecycle
  - [x] Synchronized recording start/stop via data channel
  - [ ] End-to-end testing with two app instances (requires two machines on same LAN)
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
- [x] **P2P Dual Recording (Phase 2)** - Guest track transfer (v3.20.x)
  - [x] Transfer guest recording to host via WebRTC data channel
  - [x] Chunked binary transfer (16KB chunks) with backpressure handling
  - [x] Progress overlay with real-time byte counter
  - [x] Save both tracks to Space (host track via save-to-space, guest track via save-guest-track IPC)
  - Files: `recorder.html`, `recorder.js`, `preload-recorder.js`
- [x] **P2P Dual Recording (Phase 3)** - Post-processing (v3.20.x)
  - [x] FFmpeg merge with layout options: side-by-side, PiP (host main), PiP (guest main)
  - [x] Layout picker dialog with visual previews
  - [x] Real-time merge progress via IPC events
  - [x] Merged video saved to Space as MP4 (libx264 + AAC)
  - [x] Auto-probes both tracks for dimensions, scales to matching height
  - [x] Audio mixed from both tracks (amix)
  - Files: `recorder.html`, `recorder.js`, `preload-recorder.js`

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
  - "Record a video" / "Start recording" opens WISER Meeting
  - "Capture my screen" hints at screen recording mode
  - "Record for [space name]" pre-selects space for saving
  - Files: `packages/agents/recorder-agent.js`, `packages/agents/agent-registry.js`
- [ ] **Agent dashboard** - See which agents are working
- [ ] **Agent chaining** - Connect agents to work together

### IDW Management
- [x] **IDW Store uses OmniGraph** - Store directory now queries graph DB IDW nodes instead of hardcoded staging API
  - Replaced direct HTTPS POST to `em.staging.api.onereach.ai` with OmniGraph Cypher query
  - Added `getIDWDirectory()` and `getIDW()` methods to `omnigraph-client.js`
  - Auto-initializes OmniGraph from settings if not already configured
  - Files: `omnigraph-client.js`, `main.js`
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
- [x] **WISER Meeting UI redesign** - Complete UX overhaul (v3.10.x)
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

- [x] **Calendar Agent v3 Refactor** (v4.3.0)
  - **Deleted**: Monolithic `calendar-agent.js` (4800 lines) -- inconsistent routing, keyword fallbacks, unvalidated LLM dates
  - **New: `lib/calendar-data.js`** -- Pure synchronous analysis functions: analyzeDay/Week/Month, findConflicts, findFreeSlots, getNextEvent, enrichEvent, deduplicateEvents. All take `now` parameter for testability. 65 unit tests.
  - **New: `lib/calendar-fetch.js`** -- Async API layer: fetchEventsForRange, resolveTimeframe (pure JS date resolution), resolveEventDate, verified mutations (createEventVerified, deleteEventVerified, editEventVerified). All mutations re-fetch and confirm. 27 unit tests.
  - **New: `lib/calendar-format.js`** -- Pure rendering: buildDayUISpec, buildEventsUISpec, buildBriefUISpec, spokenDaySummary, extractMeetingLink, confirmCreate/Delete/Edit. 39 unit tests.
  - **New: `packages/agents/calendar-query-agent.js`** -- Read schedule, next meeting, availability, conflicts, free slots, join meeting, morning brief. LLM intent parsing with structured routing.
  - **New: `packages/agents/calendar-create-agent.js`** -- Create events with LLM detail extraction, guest resolution via contact-store, multi-turn for missing fields, verified creation.
  - **New: `packages/agents/calendar-edit-agent.js`** -- Move/rename/change attendees via delete+recreate pattern, disambiguation for multiple matches, verified edit.
  - **New: `packages/agents/calendar-delete-agent.js`** -- Cancel events with name search, ordinal disambiguation, verified deletion.
  - **Updated**: agent-registry.js, daily-brief-agent.js, agent-space-registry.js, voice-coordinator.js, action-item-agent.js, agent-manager.html, meeting-link-extraction.test.js
  - All 1910 unit tests pass (131 new calendar tests)
  - Files: `lib/calendar-data.js`, `lib/calendar-fetch.js`, `lib/calendar-format.js`, `packages/agents/calendar-{query,create,edit,delete}-agent.js`

- [x] **Browser Automation Agent** (v4.2.0)
  - **New: `lib/browser-automation.js`** -- Playwright-based singleton service managing an isolated Chromium browser with ref-based accessibility snapshot interaction (navigate, snapshot, act, screenshot, evaluate, tab/cookie management, idle auto-shutdown)
  - **New: `packages/agents/browser-agent.js`** -- Task exchange agent that uses LLM reasoning to autonomously plan and execute browser actions step-by-step. Safety guardrails: max 20 actions/task, 60s timeout, domain blocklist, no password entry without confirmation, screenshot audit trail.
  - **Registered** in `agent-registry.js` -- auto-connects via exchange-bridge, LLM-based bidding
  - **IPC bridge** -- `window.browserAutomation` API exposed in `preload.js` with full IPC handlers in `main.js`
  - **Web scraper consolidation** -- `web-scraper.js` refactored from Puppeteer to use `browser-automation.js` (shared Playwright instance)
  - **Settings UI** -- New "Browser Automation" tab in settings.html with enable/disable, headless toggle, max actions, idle timeout, max tabs, blocked domains
  - Files: `lib/browser-automation.js`, `packages/agents/browser-agent.js`, `packages/agents/agent-registry.js`, `main.js`, `preload.js`, `web-scraper.js`, `settings.html`, `ROADMAP.md`

- [x] **Orb & Task Exchange Architecture Refactoring** (v3.14.x)
  - **Consolidated task submission paths**: Removed 3 legacy `orbAPI.submit()` fallbacks in orb.html and deprecated `voice-task-sdk:submit` IPC. All submissions now go through `agentHUD.submitTask()` -> `hud-api` -> `processSubmit()`.
  - **Extracted exchange-bridge modules**: Created `lib/exchange/voice-coordinator.js` (voice personalities, config), `lib/exchange/conversation-history.js` (conversation tracking, session summaries, active learning), and `lib/exchange/subtask-registry.js` (subtask API, input schema processor). Reduced `exchange-bridge.js` from 4,797 to 3,943 lines.
  - **Decoupled exchange-bridge / hud-api circular dependency**: Created `lib/exchange/event-bus.js` shared EventEmitter singleton. `hud-api.js` no longer holds a direct `_exchangeBridge` reference -- uses the event bus for pull-based operations (`getExchange`, `processSubmit`, `cancelTask`).
  - **Extracted orb audio module**: Created `lib/orb/orb-audio.js` (AudioContext management, WAV/PCM playback, ready chime). Loaded as `<script>` in orb.html.
  - **Introduced orb state machine**: Created `lib/orb/orb-state.js` with formal phase transitions (`idle` -> `listening` -> `processing` -> `speaking`), event system, and transition guards. Integrated at key orb lifecycle points.
  - **Renamed HUD API**: `window.hudAPI` -> `window.commandHUD` in `preload-command-hud.js`, `command-hud.html`, and all test files. `window.agentHUD` remains the canonical task API.
  - **Eliminated preload duplication**: Removed ~100 lines of inline orb-control code from `preload-minimal.js` and `preload-spaces.js`. Both now use `require('./preload-orb-control')` shared module.
  - Files: `exchange-bridge.js`, `hud-api.js`, `orb.html`, `preload-orb.js`, `preload-command-hud.js`, `preload-minimal.js`, `preload-spaces.js`, `command-hud.html`, + 5 new modules in `lib/exchange/` and `lib/orb/`

- [x] **Daily Brief Pipeline Overhaul: 5 Fixes** (v3.14.x)
  - **Double greeting fix**: Time-agent `getBriefing()` no longer includes "Good morning" -- only provides time/date facts. LLM composer handles the single greeting. Previously: "Good morning. Good morning. It's 11:51 AM..."
  - **Decomposition fix**: Daily brief requests ("give me my brief", "catch me up", etc.) are now excluded from task decomposition. The daily-brief-agent already orchestrates weather/calendar/email internally -- decomposing caused duplicate work, dead-lettered subtasks, and chaos.
  - **Memory header duplication fix**: `parseMarkdownSections()` now strips `# Title` lines from the `_header` section so `rebuildMarkdown()` doesn't duplicate them. Fixed all 18+ agent memory files that had accumulated 2-10 duplicate title lines.
  - **Weather fallback**: Added Open-Meteo (free, no API key) as fallback when wttr.in times out. Both `_fetchWeather()` and `_fetchWeatherData()` now try wttr.in first, then Open-Meteo. Includes geocoding (city name to lat/lon) and WMO weather code translation.
  - **Composition cost reduction**: Brief composition switched from `powerful` profile with extended thinking (Claude 4.6 Opus) to `standard` profile (Claude Sonnet). Formatting a brief into speech doesn't need deep reasoning.
  - **Calendar data source fix**: `getBriefing()` was only reading from the local calendar store (empty) instead of fetching from the omnical API (Apple Calendar). Now calls `_fetchEvents(false)` to get real events. Also bumped per-agent timeout from 5s to 8s and total timeout from 12s to 15s to accommodate the API call.
  - Files: `packages/agents/time-agent.js`, `packages/agents/daily-brief-agent.js`, `packages/agents/calendar-agent.js`, `packages/agents/weather-agent.js`, `lib/agent-memory-store.js`, `src/voice-task-sdk/exchange-bridge.js`

- [x] **Full Spatial Awareness: Multi-Monitor, Edge Snap, Per-Display Memory** (v3.14.x)
  - New centralized screen service (`lib/screen-service.js`) replaces all `screen.getPrimaryDisplay()` with display-aware logic
  - Fixed HUD positioning bug: HUD now centers on the actual visible 80x80 orb, not the 400x550 window origin (~300px offset fix)
  - Multi-monitor support: orb, HUD, Black Hole, GSX Create, and QR scanner all use the correct display
  - Per-display position memory: orb remembers its position on each monitor; "welcome home" when a display is reconnected
  - Edge magnetism: 20px snap zone on screen edges and corners (applied on drag release, zero jank)
  - Display change listener: handles monitor plug/unplug/resolution change at runtime
  - Agent screen context: display geometry, orb position, and frontmost app injected into task metadata
  - 43 unit tests covering all geometry, snap, per-display memory, and multi-monitor scenarios

- [x] **Daily Brief Time-Awareness: Past vs Upcoming Events** (v3.14.x)
  - Bug: Daily brief described past events in future tense ("Your first meeting is at 9 AM" when it's 3 PM)
  - Fix: `generateMorningBrief()` now splits events into completed/in-progress/upcoming with status per event
  - `renderBriefForSpeech()` uses correct tense (past tense for completed, present for in-progress, future for upcoming)
  - Added `currentMeeting` (in-progress) and `nextMeeting` (next upcoming) to brief data
  - Free time now shows remaining free time (not total day) when briefing mid-day
  - Conflicts filtered to only show upcoming ones
  - LLM composition prompt updated with explicit time-awareness rules
  - Files: `lib/calendar-store.js`, `packages/agents/daily-brief-agent.js`

- [x] **Calendar Agent: Time-Aware LLM Event Formatting** (v3.14.x)
  - Bug: `_askLLMAboutCalendar()` sent a flat chronological list under "UPCOMING EVENTS" -- events already over today still appeared as upcoming, no indication of current or next meeting
  - Fix: Events now grouped by temporal status: ALREADY OVER, HAPPENING NOW, NEXT UP, LATER TODAY, and future days grouped by day
  - Relative time annotations added: "ended 2 hr ago", "25 min remaining", "starts in 15 minutes"
  - LLM system prompt updated with time-awareness rules (past/present/future tense per section)
  - Future-day events now grouped under day headers (with "TOMORROW" label for next day)
  - File: `packages/agents/calendar-agent.js`

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

- [x] **WISER Meeting screen/camera recording fix + full audio mixing + Spaces save** (v3.12.x)
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

