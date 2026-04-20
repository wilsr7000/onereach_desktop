# Onereach.ai Punch List

> Master list of bugs, fixes, and small features to address.
> Updated: April 2026 | Current Version: 4.9.0

---

## 🔴 Critical / Blocking

### App Distribution
- [ ] **Notarization not producing valid signatures** - macOS won't persist mic/camera TCC permissions, so users see the same permission dialog on every launch (known user-visible bug)
  - **Root cause**: electron-builder 26.8.1 + Electron 41.2.1 produces bundles with nested code signatures that fail `codesign --verify --deep --strict`. Current `package.json` has `strictVerify: false` and `gatekeeperAssess: false` to silently skip this check, but the underlying malformed signatures cause Apple's notarization service to reject the bundle and cause macOS TCC to never persist the grant (`TeamIdentifier=not set`).
  - **Fixed in this release cycle**: `scripts/release-master.sh` now sources `.env.notarization` so notarization *can* run (previously silently skipped for months). Creds: `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD`. The `.env.notarization` file is gitignored.
  - **Still needs**: investigation of the electron-builder/Electron signing bug. Possible paths: (1) downgrade electron-builder to a known-working version, (2) upgrade to a newer one with this fixed, (3) add custom afterPack script that re-signs consistently with `--deep` + notarize manually. Until this is fixed, every release will continue to have the mic-dialog-loop on fresh installs.
  - Files: `scripts/notarize.js`, `scripts/notarize-manual.js`, `scripts/release-master.sh`, `package.json` (build.mac config), `.env.notarization` (local, gitignored)
  - Apple Developer account: active ($99/year)
  - See: `NOTARIZATION-SETUP.md`, `notarize-setup.sh`, `build-notarized.sh`

### Build & Release
- [x] ~~Checksum mismatch on auto-update~~ - Fixed in release-master.sh
- [x] **Auto-update + graceful-shutdown hardening pass** (v4.8.2) - Full audit and fix of every code path where upgrade/reboot could fail:
  - **Single-instance lock**: Prevents double-launch race during ShipIt install. Second launch brings existing window to front instead of spawning a rogue process that holds ports and corrupts the bundle swap. (`main.js` `requestSingleInstanceLock()` + `second-instance` handler)
  - **State saved before update-triggered quit**: Previously `isUpdatingApp` caused both `before-quit` AND `will-quit` to skip all cleanup so ShipIt could proceed -- but that also meant tabs, orb position, conversation state were lost across every update. New `_saveStateBeforeUpdate()` runs inside `performUpdateInstall` with a 1.5 s total budget, per-save 500 ms cap, then windows are destroyed and ShipIt proceeds. (`main.js`)
  - **Pre-flight writable check**: `/Applications/Onereach.ai.app` and its parent are checked for W_OK before `quitAndInstall`. If read-only (corporate ACLs, wrong ownership), the user sees "Download Manually" dialog instead of silently failing and entering the retry loop. (`main.js` `_checkAppBundleWritable`)
  - **Renderer install path now tracks version**: The in-app update banner's `install` IPC used to call `performUpdateInstall(null)`, meaning `lastAttemptVersion` was never written and `verifyUpdateOnStartup` couldn't detect a failed install. Now tracks `_lastDownloadedUpdate.version` in the `update-downloaded` event handler and passes it through. (`main.js`)
  - **Failure dialog shown on 1st failure** (was 2nd): User is informed after the very first failed update instead of after two full cycles. Same "Download Manually / Try Again / Skip" options, phrased less alarmingly for first occurrence. (`main.js` `verifyUpdateOnStartup`)
  - **`shutdown-ready` actually shortens the timer**: Previously a 1.5 s fixed delay regardless of whether the renderer was done. Now `shutdown-ready` IPC from renderer destroys immediately; added new `shutdown-blocked` handler that extends the budget to 5 s for long saves. (`browserWindow.js`)
  - **Full audit report**: read-only audits cover detection/download/verify/install/recovery + shutdown lifecycle, state preservation, crash recovery, multi-instance. Remaining Medium findings documented for future work (overlapping checks, partial-release recovery, `offerManualDownload` dead code).
- [ ] **Windows code signing** - Not implemented
  - See: `WINDOWS-SIGNING-GUIDE.md`
  - Requires EV certificate for SmartScreen trust

---

## 🟠 High Priority

### Self-learning + temporal awareness + memory grooming (v4.8.2)
- **Problem**: Even with reflection in place, the learning signals were disappearing. Low-quality judgments didn't change anything. Agent memory grew unbounded with duplicates. Every conversation felt like turn 1 -- no awareness of "yesterday you were working on X" or "at this time you usually do Y". User asked for a "remarkable self-learning" system that feels smart, not narrow.

- **Six-part fix that turns signals into behaviour**:

  1. **Memory Curator** (`lib/agent-learning/memory-curator.js`) -- periodic background grooming of per-agent memory files:
     - Dedupes fuzzy duplicate lines (Jaccard >= 0.75 on token set) so repeat reflections don't pile up.
     - Ages out dated entries past each section's `maxAgeDays` cap (Learning Notes 90d, Recent History 60d, Change Log 60d, Deleted Facts 30d).
     - Key-value sections (Learned Preferences) collapse by key; newest-first-wins so corrections take effect.
     - Respects per-agent 6h cooldown; caps sweep at 25 agents so a cron tick can't pin the main loop.
     - User-edited sections (User Notes, About) are never touched -- hand-added facts survive forever.
     - Runs automatically every 6 hours via `lib/agent-learning/index.js` `_runCuratorSweep`; also invalidates the retriever cache for any agent whose memory changed.

  2. **Temporal Context** (`lib/temporal-context.js`) -- rolling model of user activity, persisted to `userData/temporal/state.json`:
     - **RECENT**: last 20 interactions with bucket classification -- powers "most recent activity N min ago" signal.
     - **HOURLY**: per-hour buckets for last 7 days -- powers "at this hour you usually ask about X" signal (fires when sample >= 3).
     - **DAILY**: per-day buckets for last 14 days -- powers "yesterday's top topics" signal for cross-session continuity.
     - Prunes automatically; footprint is KB not MB because we store counts not transcripts.
     - `classifyBucket()` recognises: local-search / weather / directions / news / time / calendar / email / tasks / factual / playbook / other (kept in sync with slow-success-tracker).
     - Recorded from `exchange-bridge.js` on every successful interaction. Failures are excluded so timeouts don't become fake habits.
     - `getPromptSummary()` produces a 3-5 line text block injected into every bid evaluation (see #6).

  3. **Relevance Retriever** (`lib/agent-learning/memory-retriever.js`) -- top-K memory retrieval instead of load-everything:
     - Score = relevance (Jaccard on content words) * 0.6 + recency (exp decay, 30-day half life) * 0.25 + density * 0.1 + pin boost * 0.05.
     - `[pin]` marker in any line keeps it reliably floated to the top regardless of age.
     - 30s cache per agent so repeated queries inside a conversation don't re-read Spaces.
     - `retrieveText({ agentId, query, topK })` returns just the top K lines as strings -- meant for direct prompt splicing.

  4. **Reflection -> Memory feedback loop** (`lib/agent-learning/index.js`) -- the main closure:
     - Subscribes to `learning:low-quality-answer` and `learning:negative-feedback` events.
     - When LLM-as-judge flags a low-quality answer, writes a dated entry to the producing agent's "Learning Notes": *"2026-04-15: Low-quality answer (reflector 0.42) on '...'. Issues: ungrounded; vague."*
     - When user says "that was wrong", writes an even stronger entry: *"2026-04-15: User flagged answer as wrong. Prior response: '...'. Input was: '...'."*
     - Master Orchestrator's `buildEvaluationPrompt` already reads these back via `_getAgentStatsSnapshot`. Quality history now has teeth -- next bid evaluation sees the track record.

  5. **omni-data-agent integration** (`packages/agents/omni-data-agent.js`):
     - `getRelevantContext()` now always attaches `temporal` (summary string) when the temporal-context module has any data.
     - When an agent is specifically named, also attaches `relevantMemory` -- top 5 lines from that agent's memory scored against the task content.
     - Preferences + location continue to come from the live services. Net result: any agent calling `omniData.getRelevantContext(task, agentInfo)` now gets location + units + temporal + top-5-memory + live context in one shot.

  6. **unified-bidder integration** (`packages/agents/unified-bidder.js`):
     - `buildEvaluationPrompt` now includes a new "TEMPORAL CONTEXT" section between session summaries and current situation.
     - Bidders see: *"Most recent activity (3 min ago): 'coffee shops near me' [local-search]. At this hour you usually ask about: calendar (5 past times). Yesterday's top topics: email, tasks, local-search. Time of day: morning, tue"*.
     - Makes every bid evaluation temporally aware -- picks change when the same question at 8am means "morning briefing" vs at 3pm means "ad-hoc lookup".

- **Test coverage** (+39 tests, all passing):
  - `test/unit/agent-learning/memory-curator.test.js` -- 14 tests: dedup (case + whitespace insensitive), age-out with dated lines, undated lines preserved, size capping, keyvalue newest-first merge, score ranking by recency + density.
  - `test/unit/agent-learning/memory-retriever.test.js` -- 7 tests: relevance ranking, recency boost, pin marker, zero-relevance drop, density cap, cache invalidation.
  - `test/unit/temporal-context.test.js` -- 18 tests: bucket classification (13 cases), recording, recent top 3, hour-pattern surfaces at sample >= 3, yesterday top, time-of-day labels, prompt summary content, 7-day pruning.
  - 3,759 of 3,762 total tests pass (same 3 pre-existing `omnigraph-client` failures unrelated).

- **What the user feels**:
  - Ask "coffee shops nearby" at 8am: agent sees "morning, tuesday, yesterday you asked about email + tasks + local-search" + "you usually ask about calendar at this hour" and routes better than a fresh instance would.
  - Ask a follow-up question 5 min later: agent sees "most recent activity 5 min ago: 'coffee shops nearby'" and can resolve pronouns correctly.
  - After the same class of query fails 2 times over a week, the slow-success tracker fires the "want me to build a dedicated agent?" suggestion.
  - After a low-quality answer, the next bid evaluation for a similar query sees *"Low-quality answer (reflector 0.42) on '...'"* in that agent's memory, and picks differently.
  - Memory stays bounded: every 6 hours the curator runs, dedupes fuzzy duplicates, ages out anything older than the section's retention, and caps sections. Hand-edited User Notes survive untouched.

- **Remaining for v4.8.3**:
  - Cross-agent learning propagation: when memory-agent learns "user moved to Berkeley" it should atomically update every agent that mentions location, not just the one speaking.
  - Auto-retry when reflector returns low-quality AND a more-reliable backup exists. Requires TTS hold-back.
  - Vector embeddings for memory retrieval (current token-Jaccard is good enough for the 90th percentile; embeddings would catch paraphrase matches).
  - A live-app eval runner for the golden-task corpus (drives the real exchange, not just schema checks).

### Reflection + evals: agents now judge their own answers (v4.8.2)
- **Problem**: Everything we shipped before v4.8.2 improved *plumbing* (routing, timeouts, listening, location) but nothing actually looked at an agent's output and asked *"was that a good answer?"*. Search Agent could synthesize hallucinated answers from empty search results and the system would report `success: true`. No self-critique. No eval harness in production use. User called this out directly: "I think what might be missing in our agents is reflection."
- **Fixes (six pieces)**:

  1. **LLM-as-judge reflection layer** (`lib/agent-learning/answer-reflector.js`) -- runs asynchronously after every task that returns a final answer. Scores the output 0-1 on four axes:
     - `grounded` -- does the answer use the evidence actually available? Or fabricate?
     - `relevant` -- does it address the user's actual question?
     - `complete` -- actionable and sufficient, or a vague non-answer?
     - `confident` -- tone matches the strength of evidence?

     Overall < 0.55 flags as low-quality. Fire-and-forget so it never blocks the UI. Coalesces duplicate reflections. Sample-rate hooks (high-conf agents get spot-checked, not every task). Opt-out via `agent.skipReflection = true` (Docs Agent already has its own RAG judge). Uses `fast` profile with 400 max tokens.

  2. **Exchange-bridge wiring** (`src/voice-task-sdk/exchange-bridge.js`) -- after task settles, reflector gets `{ agent, task, result, evidence }` and emits:
     - `learning:reflection` (generic, always for reflected tasks)
     - `learning:low-quality-answer` (only when overall < threshold)
     Reflection scores are stamped on `task.metadata.reflectionOverall/Scores/Issues` so Master Orchestrator's next `provideFeedback` call sees quality, not just success. Low-quality outcomes also feed the slow-success tracker as a "soft bust" so the proactive "build an agent for this" suggestion fires on pure quality failures, not just latency ones.

  3. **Search Agent grounding + evidence return** (`packages/agents/search-agent.js`) -- after synthesis, a cheap in-band grounding check (`_checkGrounding`) compares answer content-words to retrieved snippets:
     - `grounded` (>=45% overlap) -- trust the answer
     - `weak` (>=20%) -- treat with caution
     - `ungrounded` (<20%) -- likely fabricated
     - `no-evidence` -- search returned nothing
     The grade is returned in `result.data.groundingHint` and `result.data.searchResults` is populated with the top 7 evidence items so the reflector can properly score groundedness against actual sources, not against a claimed URL list.

  4. **Golden-task eval harness** (`test/evals/fixtures/golden-tasks.json` + `test/evals/golden-tasks.eval.js`) -- checked-in regression corpus of 9 production tasks. Each entry: userInput, expected winning agent, expected behavior (answer/clarify/route), forbidden strings we never want back, and a `why` field explaining the historical context. Includes the Berkeley-coffee case and the "find me a dentist" implicit-local case. Runs in two modes: fast schema/static validation (`npm run test:evals`), and `EVAL_LIVE=1` for full-pipeline runs against the actual agent runtime before release.

  5. **Outcome-based bid audit** (`packages/agents/master-orchestrator.js`) -- when `provideFeedback` runs post-settle, it now sees `task.metadata.bustCount`, `bustedAgents`, and `reflectionOverall`:
     - Busted primaries get a Learning Notes entry explaining what happened.
     - The backup that actually rescued the task gets credit ("Consider bidding higher on this class next time.")
     - Reflector-low-quality answers get recorded on the producing agent's memory even when it returned `success: true`.
     Net effect: the next time the Master Orchestrator evaluates bids for a similar task, `_getAgentStatsSnapshot` has both quantitative (success-rate, latency) and qualitative (reflection scores) signals baked into agent memory.

  6. **User negative-feedback channel** (`src/voice-task-sdk/exchange-bridge.js`) -- voice shortcuts like *"that was wrong"*, *"that didn't answer my question"*, *"no that's not it"*, *"wrong answer"* are intercepted in `processSubmit` *before* routing. Emits `learning:negative-feedback` with the targeted agent (from conversation history) and broadcasts to all renderer windows. `InteractionCollector._onNegativeFeedback` flips the last interaction's `success: false`, updates `error: 'user_negative_feedback'`, and recomputes the agent's failure-rate signal. The loop closes: one explicit user "wrong" has more weight than three silent successes.

- **Test coverage**:
  - `test/unit/agent-learning/answer-reflector.test.js` -- 13 tests covering shouldReflect gating, score normalisation (clamp), low-quality detection, coalescing duplicates, error resilience (never throws), agent stats aggregation.
  - `test/unit/search-agent-grounding.test.js` -- 5 tests: grounded/weak/ungrounded/no-evidence grading, empty input.
  - `test/unit/agent-learning/interaction-collector.test.js` -- 5 new tests: 2 new subscribers, negative-feedback flipping success, reflection marking low-quality, reflection leaving good answers alone, unknown-agent ignored.
  - `test/evals/golden-tasks.eval.js` -- 14 fixture schema/semantic tests that run on `npm run test:evals`.
  - Total: 37 new tests, all passing. 3,720 of 3,723 in full suite pass (the 3 failures are pre-existing `omnigraph-client` unrelated to this work).

- **Still ahead for v4.8.3**:
  - Live pipeline runner for the golden-task eval (boots the Electron runtime, runs each task end-to-end, asserts forbidden-string absence + behaviour + reflection scores).
  - Reflection-driven auto-retry: when a task comes back low-quality and a reasonable alternative agent exists, silently retry before the user hears the answer. Requires streaming TTS hold-back so we don't speak twice.
  - HUD thumbs-down UI (clicks as well as voice for the negative-feedback channel).

### Production-readiness push -- remaining context + UX gaps (v4.8.2)
- [x] **Search Agent asks when stuck, instead of saying "I don't know"** -- If a location-implicit query comes in without any location data, Search Agent returns `needsInput` with "What city are you in?" so the orb opens the mic (awaitingInput state, 30s timeout) instead of the old silent-failure path. Same handling for post-search empty results: offers to let the user narrow it down. (`packages/agents/search-agent.js`)
- [x] **Proactive "I could build an agent for this"** -- New `lib/agent-learning/slow-success-tracker.js` classifies slow-successes into coarse buckets (local-search / weather / directions / news / time / factual / other). After 2+ slow-successes in the same bucket, speaks a one-time offer to build a dedicated agent. Throttled per-bucket (24h) and globally (5 min) so it never nags. The suggestion is spoken via the existing `voice-speaker` 2.5s after the primary response, so the user hears it as a natural follow-up; the orb extends its listening window to 12s so the user can say "yes" / "build that" without tapping anything. (`lib/agent-learning/slow-success-tracker.js`, `src/voice-task-sdk/exchange-bridge.js`, `orb.html`, `preload-orb.js`)
- [x] **OS-locale preferences** -- New `lib/system-preferences.js` derives intelligent defaults for units (°F/°C, mi/km, lb/kg), time format (12h/24h), date format (MDY/DMY/YMD), and week start (Sunday/Monday) from `app.getLocale()` + `app.getLocaleCountryCode()`. A Japanese user now gets metric + 24h + YMD + Sunday week-start out of the box; the old path assumed US defaults globally. `omni-data-agent.js` layers OS defaults under any user-overrides from `main.md`, so agents always have a full preference snapshot without asking. Always injected for Search Agent and Weather Agent. (`lib/system-preferences.js`, `packages/agents/omni-data-agent.js`, `main.js`)
- **Test coverage**:
  - `test/unit/system-preferences.test.js` -- 8 tests: US/UK/Japan/Germany/unknown-locale defaults, user overrides beat locale, cache invalidates on override.
  - `test/unit/agent-learning/slow-success-tracker.test.js` -- 15 tests: bucket classification (local-search groups coffee/cafe/pharmacy/nearby/closest; weather groups forecast/rain/temperature), threshold logic, per-class cooldown, global cooldown, input validation.
  - Updated `test/unit/agent-learning/interaction-collector.test.js` for new `learning:slow-success` subscription.
- **Remaining gaps** (out of scope for this pass, candidate for v4.8.3):
  - Deep active-app content (URL of active tab, selection, document text) for "summarize this" use cases. `situationContext` in the exchange-bridge provides window-level focus; content requires a separate per-product extractor.
  - Agent-builder integration with `orb:proactive-suggestion` acceptance: today the user has to say "build that agent" explicitly. Natural-language acceptance ("yes", "sure", "okay do it") should auto-route to `agent-builder-agent` with the tracked `queryClass` and `agentIdea` as `capabilityGap` metadata.
  - Memory of user preference overrides across sessions (today: in-memory only).

### Live location for agents (v4.8.2)
- [x] **Agents used a stale value from memory for location, not the user's actual current location** -- User complaint: "location should check my precise location not some saved location in memory unless precise is not available." This was the root cause of the coffee-shop-in-Berkeley incident.
- **Before**: `omni-data-agent.js` was the only location source. It read `location` from `gsx-agent/main.md` -- a static markdown file the user edits manually. If you moved cities and didn't update the file, every agent answered as if you were still in the old one.
- **After**: New `lib/location-service.js` main-process module maintains a live, source-ranked location:
  1. **PRECISE** -- GPS/WiFi-assisted coords from `navigator.geolocation` (CoreLocation on macOS), pushed by the orb renderer on startup via `location:report-precise` IPC. Typical accuracy: 10-100m. TTL 10 min.
  2. **IP** -- ipapi.co lookup at service boot and on demand. Accuracy: ~5-50km (city level). TTL 30 min.
  3. **STORED** -- Last known value persisted to `userData/location/last-known.json` so the app has something usable on first launch when offline.
  4. **DEFAULT** -- Value from `main.md` via omni-data-agent. Only used when everything else has failed.
- **Freshness guarantees**: `getLocation({ freshMs })` lets callers force a refresh. `getSnapshot()` is synchronous (no network) for agents that need cheap prompt injection. Concurrent IP fetches are coalesced.
- **Integration**:
  - `packages/agents/omni-data-agent.js` `_mergeLocation()` layers the live snapshot over stored values so `query('location')`, `getAll()`, and `getRelevantContext()` all return the freshest precise data -- stored fields like home address are preserved but city/region/coords/timezone come from the live source.
  - Location keyword list widened from 9 terms to 30+ covering nearby/around here/local/restaurant/cafe/pharmacy/directions/etc. Previous list missed "coffee" entirely -- the exact trigger for the Berkeley incident.
  - `packages/agents/search-agent.js` `_isImplicitlyLocal()` detects queries about "here" that don't name a city ("coffee shops nearby", "find a pharmacy", "closest gym") and auto-enhances with the live city before hitting the Serper API.
- **Permissions**: Orb session permits `geolocation`. macOS `Info.plist` gets `NSLocationUsageDescription` / `NSLocationWhenInUseUsageDescription` so the system prompt is clear about why we need it.
- **Preload**: `window.api.getLocation(opts)` and `window.api.reportLocation(payload)` expose the service to any renderer.
- **Renderer hook**: `orb.html` opportunistically calls `navigator.geolocation.getCurrentPosition()` on load and pushes the result. If denied, falls through to IP silently -- agents never see "unknown" unless the user is fully offline.
- **Test coverage**:
  - `test/unit/location-service.test.js` -- 9 tests: reportPrecise validation, source priority (precise > IP > stored > unknown), IP backfill, staleness fallback, sync snapshot purity.
  - `test/unit/search-agent-local-detection.test.js` -- 16 tests: implicit-local phrases ("nearby", "around here", "closest"), local-noun + local-intent patterns, negative cases ("weather in Tokyo", "latest iPhone news", "capital of France").

### Orb: asks follow-up questions but doesn't listen (v4.8.2)
- [x] **Orb asks a question but immediately goes idle instead of waiting for your answer** -- User complaint: "System asks follow up questions which is great but is not listening for the answer."
  - **Root cause**: Two paths exist for multi-turn conversation:
    1. **Explicit `needsInput` protocol**: agent returns `{ needsInput: { prompt: '...' } }` -> orb transitions to `awaitingInput` with a 30s timeout. Works correctly.
    2. **Implicit question in response text**: agent returns a message like *"Want me to open directions?"* or *"Would you like the full list?"* without setting `needsInput`. The response-router only looked at the `needsInput` flag, so these went through the standard dwell-listen path (5-6s minus a 2.5s TTS echo-suppression cooldown = ~3s effective listening). The user couldn't possibly answer in that window.
  - **Most agents don't set `needsInput`** -- they just speak conversational questions. That's the path that was broken.
- [x] **Fix**: `lib/orb/orb-response-router.js` now detects implicit questions from the response text:
  - Trailing `?` (most reliable signal)
  - Interrogative leads (`who`, `what`, `when`, `would you like`, `do you want`, `should i`, etc.)
  - Follow-up offer phrases (`anything else`, `want me to`, `which one`, etc.)
  - Only applied to short messages (<= 25 words) to avoid false positives in long paragraphs that just happen to contain "how".
  - When detected, the route is flagged with `awaitAnswer: true` and uses `DWELL.IMPLICIT_QUESTION = 25000ms` (5x longer than the old `SHORT_INFO` dwell).
  - `orb.html` sees `route.awaitAnswer` and sets `_pendingNeedsInput = true`, which routes through the same `awaitingInput` state as the explicit protocol: TTS speaks the question, a ready chime plays, the mic re-opens, and a 30s `AWAIT_TIMEOUT_MS` auto-idles if the user doesn't speak.
  - Wired in both renderer paths: `agentHUD.onResult` (built-in agents) and the function-call / `respondToFunction` path.
  - **Files changed**: `lib/orb/orb-response-router.js`, `orb.html`
  - **Test coverage**: `test/unit/orb-response-router.test.js` -- 12 new tests covering trailing `?`, interrogative leads, follow-up offers, false-positive negatives, and priority over explicit `needsInput`.

### Orb resilience (v4.8.2)
- [x] **Orb hung for 2+ minutes on "find a coffee shop nearby"** - Root cause analysis from logs (incident 2026-04-17 17:07-17:09):
  - User asked "Where is a good place around here to get coffee?" -- webview Google search returned ERR_ABORTED, DuckDuckGo returned 0 results -> agent answered empty (the "knew I was in Berkeley then didn't" moment -- Google's URL hinted at geolocation, but the agent couldn't use it)
  - User re-asked "Find a good coffee shop nearby in Berkeley"
  - 3 agents bid with identical confidence (0.92): Browser Agent, Browsing Agent, Search Agent. Master Orchestrator LLM said *"functionally equivalent, pick first qualified"* and picked Browser Agent
  - Browser Agent (Desktop Autopilot Tier 2, Playwright) timed out after 60s
  - Exchange cascaded sequentially -> Browsing Agent also timed out after 60s
  - Exchange cascaded -> Search Agent (Serper API) succeeded in 6s
  - Total user wait: 2m 10s
- [x] **Fixes:**
  - **Master Orchestrator now receives agent history in the bid prompt**: success rate, avg latency, failure count injected per bid. Prompt explicitly forbids the "functionally equivalent, pick first" tie-break and requires use of History data (prefer higher success rate, lower latency; API-based beats browser-automation for equivalent capability). (`packages/agents/master-orchestrator.js` `_getAgentStatsSnapshot` + updated prompt)
  - **Default bid execution timeout dropped 60s -> 30s** (`src/voice-task-sdk/exchange-bridge.js` line 1183). Halves the user-perceived wait when an agent hangs. Agents that legitimately need more time set `executionTimeoutMs` explicitly.
  - **Browser Agent + Browsing Agent pinned at 45s** via explicit `executionTimeoutMs` so they still get time for real automation but can't burn the full 60s before the cascade moves on.
  - **Bust tracking per task**: `task.metadata.bustCount` and `bustedAgents[]` now accumulate across fallback attempts, so the learning loop can distinguish "fast success" from "succeeded after 2 timeouts". (`exchange-bridge.js` task:busted handler)
  - **New `learning:slow-success` event**: When a task succeeds only after one or more busts, the exchange bus emits a signal that captures the winning agent, busted agents, and total wait time. The `InteractionCollector` records it as a partial capability gap so the opportunity evaluator can propose either (a) re-weighting bids for this task class or (b) a purpose-built agent. (`lib/agent-learning/interaction-collector.js` `_onSlowSuccess`)
  - **`learning:interaction` now includes `bustCount` and `bustedAgents`**: downstream consumers have the full retry picture, not just the final winner.
- [ ] **Still needs (future work)**:
  - Location-aware fallback: when the agent encounters "around here" / "nearby" and has no location context, it should use IP geolocation or `navigator.geolocation` instead of returning empty results (the trigger for this incident). Wire `src/voice-task-sdk/context/providers/location.ts` into the unified-bidder context injection.
  - Proactive agent-builder suggestion after N slow-successes for the same task class (e.g. "I've had trouble with coffee-shop queries a few times -- want me to build a location-aware agent?"). Hook into `agent-builder-agent` via `learning:slow-success` aggregation threshold.
  - Fast-fail path in `search-agent` when both webview Google AND DuckDuckGo return 0 results: should escalate to "need more info from user" (e.g. "I couldn't find coffee shops -- what city are you in?") rather than returning empty to synthesis.

### Email Agent (IMAP)
- [ ] **Email Agent IMAP Integration** - Replace stubbed email-agent with real IMAP/SMTP connectivity
  - Added `imapflow`, `nodemailer`, `mailparser` dependencies
  - New `lib/email-service.js`: multi-account IMAP connection manager with IDLE, reconnect state machine, SMTP sending
  - New `lib/email-thread-engine.js`: RFC 5322 thread assembly + AI-assisted triage scoring (velocity, recency, direct/CC, sender importance, awaiting-reply, depth, sentiment)
  - Extended `credential-manager.js` with email password helpers (keytar)
  - Added "Email Accounts" tab in `settings.html` with guided setup wizard for Gmail, Outlook, Yahoo, iCloud, Custom IMAP
  - Registered `email:*` IPC channels, wired handlers in `main.js`, exposed `window.email.*` in preload
  - Rewrote `packages/agents/email-agent.js`: triage, threaded conversations, multi-account, real inbox/search/send
  - Files: `lib/email-service.js`, `lib/email-thread-engine.js`, `credential-manager.js`, `settings.html`, `preload.js`, `main.js`, `lib/ipc-registry.js`, `packages/agents/email-agent.js`

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
- [x] **Migrate GSX Create from Aider to Claude Code** (v4.8.0)
  - New `lib/gsx-create-engine.js` (305 lines) -- Aider-compatible interface over `claude-code-runner`
  - New `lib/gsx-branch-manager.js` (240 lines) -- replaces inline `BranchAiderManager` in main.js
  - One Claude Code session per branch with `--resume` for conversation continuity
  - Removed Python runtime: deleted `aider-bridge-client.{js,ts}`, `aider_bridge/`, `src/aider/`, `aider-bridge-integration-example.ts`, `test/fixtures/aider-responses.js`, `test/e2e/gsx-create.spec.js.legacy`
  - Simplified `dependency-manager.js`: dropped `checkAider()`, `installAllMissing` for aider-chat, Python/pipx now optional (not required)
  - Renamed `aider-ui.html` -> `gsx-create.html`
  - Removed `deps:get-aider-python` IPC handler + `window.deps.getAiderPython` preload bridge
  - Removed `aider_bridge/**/*` from `package.json` asarUnpack
  - Replaced `createMockAiderBridge` with `createMockGSXCreateEngine` in test mocks
  - 19 new unit tests in `test/unit/gsx-create-engine.test.js` (all pass)
  - Live smoke test: engine spawns bundled Claude Code, round-trip in ~5s, cost tracking works
  - IPC channel names kept as `aider:*` for renderer compatibility (internal detail)
- [ ] **Task queue persistence** - Verify working across all edge cases
- [x] **Graceful shutdown** - Fixed in v3.8.12 with app quit handlers and forced window close
- [ ] **HUD position** - Sometimes resets after restart
- [ ] **Agent summaries** - Improve quality/relevance

### Edison SDK & Dev Tools
- [x] **Edison SDK Integration (Phase 0)** - Installed and integrated 13 Edison platform SDKs with centralized manager
  - `lib/edison-sdk-manager.js`: token management, lazy init, 14 multi-step test functions, quick actions
  - Settings UI: Edison SDKs tab with connection config, test dashboard, interactive exploration
  - IPC bridge: 7 channels in preload.js + main.js for renderer access
  - SDKs: key-value-storage, flows, bots, deployer, discovery, library, files-sync, accounts, api-tokens, files, step-templates, tags, data-hub-svc
  - 11/14 tests pass, 2 partial (token auth limitations), 1 known fail (KV needs user-level token)
  - Files: `lib/edison-sdk-manager.js`, `settings.html`, `preload.js`, `main.js`, `package.json`
- [x] **GSX Dev Tools Menu (Phase 1)** - COMPLETE
  - [x] Dev Tools menu via `lib/menu-sections/dev-tools-builder.js` (flow context, event log, library, SDK dashboard)
  - [x] Flow context tracking via `lib/gsx-flow-context.js` -- intercepts Edison API calls in GSX windows
  - [x] Structured event logging via `lib/edison-event-logger.js` with `callFlow()` backend
  - [x] Library Browser window (`library-browser.html`) -- search, browse step templates
  - [x] Bottom toolbar overlay in GSX BrowserWindow (flow label, step count, updates reactively)
  - [x] Configure Step -- discovers "Step configurator API" flow by name, calls it with step data, shows progress modal with refresh/confirm/activate guidance
    - `findFlowByName()` + `getFlowHttpPath()` in `lib/edison-sdk-manager.js` (cached discovery)
    - `configure-step.html` progress UI with phased status updates
  - Files: `lib/gsx-flow-context.js`, `lib/menu-sections/dev-tools-builder.js`, `lib/edison-event-logger.js`, `library-browser.html`, `lib/gsx-autologin.js`, `menu.js`, `main.js`, `preload.js`, `configure-step.html`

### Video Editor
- [x] **Voice selector UI** - Was hardcoded to 'Rachel' voice
  - Fixed: All voice generation functions now read from the existing `elevenLabsVoiceSelect` dropdown (9 voices)
  - Files: `video-editor-app.js`
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
- [x] **Calendar create/delete agents broken** (v4.5.x)
  - **Delete: searched wrong events** -- `getEventsForDay` returns a 14-day window; the delete agent searched ALL of them instead of filtering to the specific day. "Cancel today's standup" could match a standup from next week.
  - Fix: Run events through `analyzeDay()` to filter to the target day before name-matching
  - **Delete: empty searchText returned no results** -- If the LLM couldn't extract a search term, every event was skipped (`if (!searchLower) return false`). Now falls back to showing all events for the day and asking the user to pick.
  - **Delete: no-match unhelpful** -- Error message didn't show what events exist. Now lists the day's events so the user can retry with the right name.
  - **Create: multi-turn injected "null" into LLM** -- `_resumeMissingFields` built a synthetic query like `Create "Meeting" on null at null`, confusing the LLM on re-execution. Now only includes non-null fields.
  - Files: `packages/agents/calendar-delete-agent.js`, `packages/agents/calendar-create-agent.js`
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
- [x] **MasterOrchestrator missing module** - `Cannot find module '../../packages/task-exchange/src/reputation/store'`
  - Fixed: Removed broken reputation store imports, replaced with logging
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
- [x] **Large space performance (Phase 1)** - Debounced search input + deferred content loading
  - Search input now debounced at 250ms (was firing on every keystroke)
  - `getSpaceItems()` no longer loads full content for every item (500 disk reads eliminated)
  - Added `loadItemContent()` for on-demand content loading
  - Files: `clipboard-viewer.js`, `clipboard-manager-v2-adapter.js`, `preload.js`
- [ ] **Large space performance (Phase 2)** - Virtual scrolling for 1000+ items
- [ ] **Search indexing** - Full-text search could be faster
- [ ] **Sync conflicts** - Better handling when GSX sync conflicts

### WISER Meeting
- [x] **Screen share presentation layout + dedicated container** - Screen share tracks were appended into the same participant container as camera, causing video stacking; no screen share button in session controls
  - Screen share tracks now render in a dedicated `.screen-share-container` above the participant grid
  - Added presentation layout mode: screen share fills top area, participants go to a bottom thumbnail strip
  - Added screen share button to session media controls bar (mute/camera/bg/screen share)
  - Added "You are sharing your screen" banner with stop button
  - Mirrored all fixes in the guest page (`capture-guest-page.js`) with version bump to 7
  - TrackUnsubscribed handlers now detect screen share removal and revert layout
  - Files: recorder.html, lib/capture-guest-page.js
- [x] **Screen share blank in Electron 41** - Screen capture produced blank frames because `getUserMedia` with `chromeMediaSource: 'desktop'` is deprecated
  - Added `setDisplayMediaRequestHandler` on the recorder session so `getDisplayMedia()` receives the correct source
  - Replaced all `getUserMedia({ chromeMediaSource: 'desktop' })` calls with `getDisplayMedia()` (screen capture, PiP, LiveKit session share)
  - Updated legacy system audio fallback from deprecated approach to display media handler with loopback
  - Added `recorder:set-screen-source` IPC + preload bridge to pass selected source ID to the handler
  - Files: recorder.js, recorder.html, preload-recorder.js
- [ ] **Meeting Hub Landing Page** - Riverside-style hub shown when WISER Meeting opens
  - New Meeting: Live Meeting (host via LiveKit), Quick Record (solo camera/screen/both), Schedule (generate room link)
  - Join Meeting: enter meeting ID/room name, validate against GSX KV, connect as guest via LiveKit
  - Space selector is required before any flow -- all recordings, transcripts, and notes save there
  - Hub syncs name and space to all downstream selectors (targetSpace, saveSpace, sessionSpaceSelect)
  - Home button in title bar to return to hub when not recording
  - Files: recorder.html
- [x] **Meeting Rooms Sidebar** - Persistent sidebar in WISER Meeting hub showing all Spaces as perpetual meeting rooms
  - Each Space has a stable room name derived from its name (e.g., "Team Standup" -> `team-standup`)
  - Perpetual meeting link per room: `{guestPageUrl}?room={roomName}` -- URL never changes
  - Sidebar shows all non-system spaces with icon, name, room slug, Copy Link and Host buttons
  - Click a room to pre-select that space in the hub; Host button starts a live meeting immediately
  - Filter/search rooms by name; sidebar syncs bidirectionally with hub space selector
  - Guest page now polls for host with "Waiting for host to start" message instead of immediate error
  - Files: recorder.html, lib/capture-guest-page.js
- [ ] **Default transcription ON** - Live captions enabled by default for every recording
  - captionsEnabled defaults to true; CC toggle and overlay set to active on init
  - Warning shown if OpenAI API key missing ("Live transcription unavailable")
  - CSP updated to allow wss://api.openai.com for live transcription WebSocket
  - Files: recorder.html
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
- [x] **Spaces copy button unclickable -- orb window blocking clicks** (v4.5.x)
  - Voice Orb window (`alwaysOnTop: true`, `transparent: true`) blocked clicks to any window behind it because native click-through (`setIgnoreMouseEvents`) was never wired up -- the IPC handler was a no-op
  - CSS `pointer-events: none` only works at web level, not at OS level; on macOS the entire window rectangle intercepted clicks even over transparent areas
  - Fix: Enabled `setIgnoreMouseEvents(true, { forward: true })` at window creation so transparent areas pass clicks through
  - Added mouseenter/mouseleave handlers in `orb.html` on all interactive regions (orb, context menu, chat panel, sound settings) to toggle click-through off when the cursor enters the orb and back on when it leaves
  - Files: `main.js`, `orb.html`
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
  - ✅ **Swagger UI** (v4.2.0) - Interactive OpenAPI 3.0 docs at `http://127.0.0.1:47291/api/docs/`
    - 92 REST endpoints documented (Spaces, Logs, Conversion, GSX, Git, Playbooks, Transcripts, etc.)
    - WebSocket protocols documented (Agent Exchange, Log Server, Spaces)
    - IPC APIs documented (Browsing, AI Service, Spaces)
    - 15 reusable schemas, 27 tag groups
    - Files: `docs/openapi-spec.js`, `spaces-api-server.js` (docs route handler)
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

- [x] **Agent System v2 -- default all phases ON, retire flag guards from production code** (v4.9.0)
  - **Why:** The flag-gated rollout was appropriate during development but left two parallel systems running side-by-side in production. Every task path had an `if (isAgentFlagEnabled(...))` branch that chose between "legacy" and "v2" behavior. User feedback: "I don't want duplicate systems. More code, more confusion." This commit resolves that by making v2 the only system.
  - **Flag defaults flipped to TRUE** in [lib/agent-system-flags.js](lib/agent-system-flags.js). Every phase (typedTaskContract, councilMode, learnedWeights, roleBasedVoterPool, variantSelector, perCriterionBidding, bidTimeClarification, adequacyLoop, httpGateway) is on by default. The flag module survives solely as a runtime opt-out.
  - **Flag guards removed** from production call sites: `lib/hud-api.js` (7 guards), `packages/agents/unified-bidder.js` (3 guards), `src/voice-task-sdk/exchange-bridge.js` (2 guards), `lib/agent-gateway.js` (1 guard). The v2 code paths now run unconditionally; the fail-open try/catch wrappers remain as safety nets.
  - **HTTP Gateway wired into [main.js](main.js)** so it binds at app boot (loopback 127.0.0.1:47293) and stops cleanly on app shutdown. Respects `httpGateway` at boot time only (router-level check removed).
  - **Umbrella flag semantics corrected**: `AGENT_SYS_AGENT_SYS_V2=0` (env) or `{ agentSysV2: false }` (settings) now actually disables every phase flag, matching what the doc promised. Per-flag overrides still win over the umbrella, so a user can disable everything but explicitly re-enable one capability if needed.
  - **Tests updated**: `DEFAULT_FLAGS all defaults are on` replaces `all off`; `flag-off baseline` suite in `unified-bidder-learned-weights.test.js` retired (weights now unconditional; fresh agents return 1.0 via cold-start guard so baseline behavior is preserved); `agent-gateway.test.js` router-level flag test removed.
  - **Adoption doc** ([docs/internal/AGENT-SYSTEM-V2.md](docs/internal/AGENT-SYSTEM-V2.md)) rewritten around "opting OUT of a specific capability" since the default is now all-on.
  - **Verification**: full unit suite 4893 passing, 4 pre-existing unrelated failures. Agent-surface regression 807/807 (both with flags at default and with umbrella explicitly off). Live E2E spec 11/11 passing. Zero lint errors.
  - **What remains as "duplicate state"**: the 6 routing Maps in `lib/hud-api.js` (`_taskToolMap`, `_taskSpaceMap`, `_taskTimestamps`, `_hudItems`, `_disambiguationStates`, `_needsInputRequests`) are still dual-written alongside `lib/exchange/task-store`. That's a deeper refactor (many readers across the codebase) and is tracked as follow-up work -- not a duplicate SYSTEM, just duplicate WRITES of the same data.
  - Files: `lib/agent-system-flags.js`, `lib/hud-api.js`, `lib/agent-gateway.js`, `lib/agent-ui-renderer.js` (n/a), `packages/agents/unified-bidder.js`, `src/voice-task-sdk/exchange-bridge.js`, `main.js`, `docs/internal/AGENT-SYSTEM-V2.md`, `test/unit/agent-system-flags.test.js`, `test/unit/agent-gateway.test.js`, `test/unit/unified-bidder-learned-weights.test.js`

- [x] **Agent System v2 -- complete multi-phase upgrade** (v4.9.0)
  - **Summary**: 8 flag-gated phases (0, 1, 1.5, 2, 3, 4, 5, 6) landed together under one version bump. Default behavior is unchanged; flip `AGENT_SYS_AGENT_SYS_V2=1` (or per-phase flags) to enable. 269 new unit tests, 637 in the aggregate regression suite, zero lint errors, zero behavioral regressions. Full per-phase details below.
  - **What it delivers**:
    - **Council aggregation** (`variant: 'council'`) -- multi-agent weighted scoring with conflict detection, consuming the existing `lib/evaluation/consolidator` that was previously only reachable via IPC.
    - **Learned weights** in `unified-bidder.selectWinner` -- 0.5-1.5 multiplier from `lib/meta-learning/agent-memory` so overconfident agents must clear a weighted threshold.
    - **Role/space voter pool** + **auto variant selector** -- tasks scoped to `meeting-agents` no longer solicit bids from `sound-effects-agent`; callers can omit `variant` and let a cheap classifier pick.
    - **Per-criterion expertise** + **bid-time clarification** -- agents declare `expertise: { criterionId: 0.0-1.0 }` and may emit `needsClarification` to pause the auction for a user answer.
    - **Adequacy loop** -- `needsInput.adequacy.maxTurns` bounds multi-turn elicitation so agents can probe until the answer is usable, not just until the user spoke once.
    - **HTTP Gateway** on 127.0.0.1:47293 -- `POST /submit-task`, `GET /events/:taskId` (SSE with past-timeline replay), `POST /respond-input`, `POST /select-disambiguation`, `POST /cancel-task`, `GET /health`. CLI tools and future flow-runtime integration call the same auction the orb uses.
    - **Named rubrics** -- `task.rubric: 'plan_review' | 'plan_proposal' | 'decision_record' | 'meeting_outcome'` auto-expands into `criteria[]`. Seven built-in rubrics in `lib/task-rubrics/` (pre-existing `code_generation`, `code_refactor`, `bug_fix`, `test_generation`, `documentation`, plus the four new planning/decision rubrics).
    - **Seeded expertise** on `decision-agent`, `meeting-notes-agent`, `action-item-agent` so council mode against `meeting_outcome` / `decision_record` rubrics produces differentiated per-criterion scores out of the box.
    - **Adoption guide** at [docs/internal/AGENT-SYSTEM-V2.md](docs/internal/AGENT-SYSTEM-V2.md) + learning-subsystem boundary doc at [docs/internal/LEARNING-SUBSYSTEMS.md](docs/internal/LEARNING-SUBSYSTEMS.md).
  - **Principles preserved**:
    - Every new code path is flag-gated and fail-open. No flag change, no behavior change.
    - No new keyword classification. Per .cursorrules "Classification Approach", all routing stays LLM-based.
    - Dependency injection over monkey-patching: council runner, bidder, and variant selector accept override hooks so tests run deterministic-millisecond without fighting CommonJS module resolution.
    - One facade for learning: all outcome writes go through `lib/learning/index.js` `recordBidOutcome`. Meta-learning and agent-learning cannot drift apart again.
    - Backups remain wired via the exchange's `task:busted` path; the learned-weight multiplier does NOT disrupt backup fallback.
  - **Rollout recommendation**: enable in this order with a day between each -- `typedTaskContract` (observability), `roleBasedVoterPool` (cost savings), `councilMode` (new capability), `learnedWeights` (calibration), `variantSelector` (auto-dispatch), `perCriterionBidding` + `bidTimeClarification` (richer councils), `adequacyLoop`, `httpGateway` (when a remote caller exists).
  - Files (new): `lib/agent-system-flags.js`, `lib/task.js`, `lib/learning/index.js`, `lib/agent-gateway.js`, `lib/exchange/task-store.js`, `lib/exchange/council-adapter.js`, `lib/exchange/council-runner.js`, `lib/exchange/voter-pool.js`, `lib/exchange/variant-selector.js`, `lib/exchange/adequacy-tracker.js`, `lib/task-rubrics/planning.js`, `docs/internal/LEARNING-SUBSYSTEMS.md`, `docs/internal/AGENT-SYSTEM-V2.md`, plus 11 new unit-test files.
  - Files (edited): `src/voice-task-sdk/core/types.ts`, `src/voice-task-sdk/agent-stats.js`, `src/voice-task-sdk/exchange-bridge.js`, `lib/hud-api.js`, `lib/agent-ui-renderer.js`, `lib/orb/orb-response-router.js`, `lib/task-rubrics/index.js`, `packages/agents/unified-bidder.js`, `packages/agents/agent-registry.js`, `packages/agents/decision-agent.js`, `packages/agents/meeting-notes-agent.js`, `packages/agents/action-item-agent.js`, `package.json`.

- [x] **Agent-system upgrade, Phase 6 -- HTTP Gateway + SSE shell for flow extraction** (v4.9.0)
  - **Why:** The agent system should be callable by non-Electron tools (CLI, web dashboard, future flow runtime) without reinventing the pipeline. Phase 6 adds a thin HTTP shim that delegates every route to the same main-process functions the in-app orb and command HUD already use. Purely additive.
  - **Routes** in [lib/agent-gateway.js](lib/agent-gateway.js): `POST /submit-task`, `POST /respond-input`, `POST /select-disambiguation`, `POST /cancel-task`, `GET /events/:taskId` (SSE with past-timeline replay then live broadcast), `GET /health`, CORS preflight.
  - **SSE replay uses Phase 0's durable timeline**: on subscribe, the past `getTaskTimeline(taskId)` events are re-emitted, then the stream stays open for live `broadcastLifecycle` calls. Keep-alive heartbeat every 25s. Clean unsubscribe on client `close`.
  - **Flag-gated + loopback-only**: disabled by default; only bound to 127.0.0.1 when `startAgentGateway()` is invoked. Default port 47293 (follows the log-server/Spaces-API pattern).
  - **Verification**: 19 new tests in [test/unit/agent-gateway.test.js](test/unit/agent-gateway.test.js) covering the flag gate, all four POST routes with delegation + validation, CORS preflight, unknown-route 404, SSE replay ordering, live broadcast, cross-task isolation, and unsubscribe cleanup.
  - **Unlocks**: a browser tab or CLI can now `curl -X POST /submit-task` and `curl -N /events/:taskId` to interact with the exact same auction the orb uses. Flow-runtime integration becomes a transport hookup, not a rewrite.
  - Files: `lib/agent-gateway.js`, `test/unit/agent-gateway.test.js`

- [x] **Agent-system upgrade, Phase 5 -- probeUntilAdequate multi-turn elicitation loop** (v4.9.0)
  - **Why:** The existing `needsInput` protocol was single-shot: whatever the user said next got accepted regardless of whether it actually answered the question. Agents that needed a specific shape of answer (a number, a date range, a concrete example) had to reinvent the loop every time.
  - **Adequacy tracker** ([lib/exchange/adequacy-tracker.js](lib/exchange/adequacy-tracker.js)): pure in-memory state module that tracks turn counts and history per task with a 5-minute TTL matching the existing needs-input expiry. Exposes `open`, `increment`, `shouldContinue`, `exhausted`, `clear`, `getEntry`, `getHistory`, `buildExhaustedResult`. Hard-caps loops at a task-defined `maxTurns` (defaults to 3).
  - **Protocol additions** (agent-returned):
    ```
    needsInput: {
      prompt: 'What's the target audience?',
      adequacy: {
        requires: 'a specific demographic',   // human-readable, surfaces in fallback
        maxTurns: 3,
        retryPrompt: 'Could you be more specific?'
      }
    }
    ```
  - **routePendingInput** in [src/voice-task-sdk/exchange-bridge.js](src/voice-task-sdk/exchange-bridge.js) now, when `adequacyLoop` flag is on AND the chained `needsInput` carries an adequacy block, increments the tracker, checks `shouldContinue`, and on max-turns exhaustion emits a graceful `adequacy-exhausted` result ("I couldn't get a clear answer..."). Agent voice and conversation history are preserved through the loop so the user doesn't notice the scaffolding.
  - **Orb dwell constant**: new `DWELL.ADEQUACY_RETRY = 8000` in [lib/orb/orb-response-router.js](lib/orb/orb-response-router.js) -- longer than CONFIRMATION (3500) so the user can rephrase, shorter than IMPLICIT_QUESTION (25000) because the system is actively listening.
  - **Verification**: 20 new tests in [test/unit/adequacy-tracker.test.js](test/unit/adequacy-tracker.test.js) covering open / increment / shouldContinue / exhausted / clear / maxTurns defaulting / history immutability / end-to-end loop.
  - **Unlocks**: deeper conversational agents (interviewers, tutors, plan critics) can loop reliably without each reinventing the state machine. Phase 4's bid-time clarification + Phase 5's execution-time adequacy loop together give the system two complementary elicitation protocols.
  - Files: `lib/exchange/adequacy-tracker.js`, `src/voice-task-sdk/exchange-bridge.js`, `lib/orb/orb-response-router.js`, `test/unit/adequacy-tracker.test.js`

- [x] **Agent-system upgrade, Phase 4 -- Per-criterion expertise + bid-time clarification** (v4.9.0)
  - **Why:** The biggest greenfield of the plan and the direct enabler for real plan-evaluation. Agents could previously only emit a single-scalar confidence per task; a rubric-style evaluation (Q1-Q22 in your original use case) had no contract for per-criterion judgment, and an agent with critical context missing had no way to ask for it before committing a score.
  - **Agent registry additions** ([packages/agents/agent-registry.js](packages/agents/agent-registry.js)): two new optional properties -- `expertise: { criterionId: 0.0-1.0 }` (self-declared per-criterion confidence) and `canProbeAtBidTime: boolean` (opt-in to the bid-time clarification protocol). Validator enforces shape and numeric range so typos fail loudly.
  - **Bid prompt enrichment** ([packages/agents/unified-bidder.js](packages/agents/unified-bidder.js)): when `perCriterionBidding` flag is on AND the task carries `criteria[]`, the bid prompt grows a CRITERIA block that surfaces each criterion and the agent's self-declared expertise percentage. Response shape grows `criteria: [{ id, score, rationale }]`. When `bidTimeClarification` flag is on AND the agent opted in via `canProbeAtBidTime`, the prompt adds a CLARIFICATION section and the response may include `needsClarification: { question, blocks }`. Parser preserves both new fields; old bids still work.
  - **Council adapter per-criterion pass-through** ([lib/exchange/council-adapter.js](lib/exchange/council-adapter.js)): `bidToEvaluation` now consumes per-criterion scores from the bid when present, falling back to fanning the overall confidence when absent. Each criterion's comment carries the bid's per-criterion rationale instead of the generic overall reasoning. Phase 1's backward-compatible behavior is preserved for bids that don't opt in.
  - **Council-runner bid-time clarification loop** ([lib/exchange/council-runner.js](lib/exchange/council-runner.js)): new `askUser` and `maxClarifyRounds` options. When any bid returns `needsClarification`, the runner emits a `bid:needs-clarification` lifecycle event, awaits the user's answer via the injected `askUser` handler, appends it to the task's `metadata.clarifications[]` and `conversationText`, and re-polls the SAME agents with the enriched task. Bounded loop (default 1 round) so a misbehaving agent can't stall the auction. Empty answers, askUser throwing, or maxRounds exhausted all cleanly break out.
  - **Verification**: 20 new tests in [test/unit/per-criterion-bidding.test.js](test/unit/per-criterion-bidding.test.js) covering registry validation (9 tests), adapter per-criterion consumption + clamping + backward-compat (5), and the clarification loop with/without askUser, max-rounds guard, empty-answer early-break, thrown-error tolerance, and execution-task propagation (6).
  - **Unlocks**: genuine rubric-style plan evaluation. An agent can now say "I'd bid 0.9 on clarity and 0.4 on risk, but I need to know X before I score feasibility" -- the auction pauses, asks the user, resumes. The council mode's weighted aggregate and conflict detection become meaningful.
  - Files: `packages/agents/agent-registry.js`, `packages/agents/unified-bidder.js`, `lib/exchange/council-adapter.js`, `lib/exchange/council-runner.js`, `test/unit/per-criterion-bidding.test.js`

- [x] **Agent-system upgrade, Phase 3 -- Role/space-based voter pool + auto variant selector** (v4.9.0)
  - **Why:** Every enabled agent bid on every task, burning tokens when obvious specialists should have been the only bidders (a task into `meeting-agents` was pulling sound-effects-agent into the auction). Also, the caller had to know whether a task was winner-style or council-style -- that burden belonged to the system.
  - **Voter pool** ([lib/exchange/voter-pool.js](lib/exchange/voter-pool.js)): `isAgentEligible`, `filterEligibleAgents`, `buildAgentFilter`. Policy: generalist agents (no declared `defaultSpaces`) always bid; specialist agents (with `defaultSpaces`) bid only when the task's `spaceId` is one of their declared spaces. `bidExcluded` still dominates. Cost-avoidance short-circuit: if filtering would drop nobody, return `null` so the exchange skips the filter path entirely.
  - **Variant selector** ([lib/exchange/variant-selector.js](lib/exchange/variant-selector.js)): small cached LLM micro-call (~80 tokens, fast profile) classifies a task into `winner | council | lead_plus_probers`. 60s cache keyed on normalized task text. Falls back to `winner` on any error. Supports dependency injection via `options.classifier` so tests run instantly with zero LLM calls.
  - **hud-api.submitTask wiring**: in [lib/hud-api.js](lib/hud-api.js), when `variantSelector` flag is on and caller didn't specify `variant`, the micro-classifier fills it in. When the resolved variant is `council` and `councilMode` flag is on, the council path fires. When `roleBasedVoterPool` flag is on and the task has a `spaceId`, the submit pipeline now pre-computes `metadata.agentFilter` from the voter pool so the exchange receives a scoped bidder list. The Phase 1 `_runCouncilSubmission` also filters its agent list via `filterEligibleAgents` when the flag is on.
  - **Verification**: 29 new tests in [test/unit/voter-pool.test.js](test/unit/voter-pool.test.js) (13) and [test/unit/variant-selector.test.js](test/unit/variant-selector.test.js) (16) covering specialist/generalist policy, bidExcluded dominance, no-mutation, cache hits / TTL, invalid-variant fallback, classifier-throw fallback, and empty-content short-circuit.
  - **Unlocks**: callers stop needing to predeclare the variant for normal use, and space-scoped tools (meeting recorder, GSX project editor) stop soliciting irrelevant bids.
  - Files: `lib/exchange/voter-pool.js`, `lib/exchange/variant-selector.js`, `lib/hud-api.js`, `test/unit/voter-pool.test.js`, `test/unit/variant-selector.test.js`

- [x] **Agent-system upgrade, Phase 2 -- Learned-weight consumer in unified-bidder.selectWinner** (v4.9.0)
  - **Why:** The app had a full weighting model in `lib/meta-learning/agent-memory.js` (`getRecommendedWeight`, 0.5-1.5 range from win/success history) that was never consumed by the live auction. Every agent's 0.85 was taken at face value regardless of historical accuracy. Phase 2 closes that loop with a single hook in `selectWinner`.
  - **selectWinner multiplier**: in [packages/agents/unified-bidder.js](packages/agents/unified-bidder.js) `selectWinner(bids)`, when the `learnedWeights` flag is on, each bid's raw confidence is multiplied by `getLearnedWeight(agentId)` from the Phase 1.5 facade. The effective confidence is clamped to `[0,1]` and used for both the 0.5 threshold check and re-sorting. Raw and effective values plus the weight are annotated onto the bid for HUD / A-B logging.
  - **Fail-open**: any exception in the weighting branch (facade throws, flag module missing, etc.) falls back to the pre-Phase-2 raw-confidence path so learning glue can never break winner selection.
  - **No data? No change**: for agents without enough historical samples, `getLearnedWeight` returns 1.0 and the behavior is identical to before.
  - **Phase 1.5 facade glue**: [lib/learning/index.js](lib/learning/index.js) exposes `getLearnedWeight(agentId, context?)` which reads `lib/meta-learning/agent-memory.js` via its lazy singleton. The facade is the ONLY place the bidder or council path calls into learning, so later phases can swap the weighting store without touching the bidder.
  - **Back-compat bid shape**: hook also handles the old-style exchange bids where the id lives on `bid.agent.id` instead of `bid.agentId`.
  - **Verification**: 12 new unit tests (`test/unit/unified-bidder-learned-weights.test.js`) covering baseline-off, weighting-on, re-sort, threshold promotion/demotion, clamping, facade error fallback, and legacy bid shape. All 546 combined tests pass; zero regressions.
  - **Unlocks**: real calibration of the auction. Agents that historically overconfident-bid on tasks they fail now need to actually clear the weighted 0.5 floor before winning.
  - Files: `packages/agents/unified-bidder.js`, `test/unit/unified-bidder-learned-weights.test.js`

- [x] **Agent-system upgrade, Phase 1.5 -- Learning subsystem consolidation + facade** (v4.9.0)
  - **Why:** The repo has two overlapping learning stacks: `lib/meta-learning/` (weighting, governance, conflict resolution) keyed on agentType, and `lib/agent-learning/` (improvement loop, memory curation, interaction collection, playbook writer) keyed on agentId. Without a documented boundary, Phase 2 could have picked the wrong one, and future phases would keep drifting the two apart.
  - **Authoritative boundary doc**: [docs/internal/LEARNING-SUBSYSTEMS.md](docs/internal/LEARNING-SUBSYSTEMS.md) defines each subsystem's job, keying convention, read/write surface, consumers, the one-way dependency rule (agent-learning may read meta-learning, not vice versa), and a decision table for "which subsystem for which question".
  - **Single facade for every call site**: [lib/learning/index.js](lib/learning/index.js) exposes `recordBidOutcome({ agentId, taskId, confidence, won, success, durationMs, error, evaluationId? })` which fans out best-effort to agent-stats (raw counters), meta-learning (accuracy memory, only when an evaluationId is supplied), and agent-learning (interaction collector). An error in any one store cannot prevent the others from recording.
  - **`getLearnedWeight(agentId)`** surfaces the meta-learning weight with a 1.0 fallback for missing data, clamped to `[0.5, 1.5]`. Consumed by Phase 2.
  - **`getAgentSnapshot(agentId)`** composes stats + weight + memory for diagnostics / HUD.
  - **Dependency injection over monkey-patching**: the council-runner (Phase 1) and the bidder (Phase 2) accept override hooks (`getBids`, `getLearnedWeight`) so tests can swap learning paths without fighting Vitest module resolution. Used throughout the new test suite.
  - **Verification**: 18 new unit tests (`test/unit/learning-facade.test.js`) covering fan-out success, partial failure isolation, evaluationId gating, accuracy derivation, out-of-range weight clamping, and snapshot composition.
  - **Unlocks**: Phase 2's hook lands on a stable facade; future phases (4, 5) write through the same entry point; a decision is recorded so the two stacks cannot keep diverging.
  - Files: `lib/learning/index.js`, `docs/internal/LEARNING-SUBSYSTEMS.md`, `test/unit/learning-facade.test.js`

- [x] **Agent-system upgrade, Phase 1 -- Council aggregation wired to the live auction** (v4.9.0)
  - **Why:** `lib/evaluation/consolidator.js` already implemented weighted scoring, conflict detection (20-point spread threshold), per-criterion consolidation, and epistemic framing, but it only reached dynamically-generated EvalAgents via IPC -- never the 27 built-in agents that actually run. Phase 1 closes that split-brain with an adapter + a variant switch in the live submission path. Zero reconstruction.
  - **Bid -> evaluation adapter**: [lib/exchange/council-adapter.js](lib/exchange/council-adapter.js) translates a `unified-bidder` bid (`{ confidence, reasoning, plan, hallucinationRisk, result }`) into the consolidator's evaluation shape (`{ agentType, agentId, overallScore, criteria[], strengths, concerns, suggestions }`). Pure data transformation -- no LLM calls. High-confidence reasoning becomes a strength, low-confidence becomes a concern, high hallucination risk is flagged. Task criteria are expanded per-bidder (Phase 4 will replace the fan-out with real per-criterion scores).
  - **Council orchestration**: [lib/exchange/council-runner.js](lib/exchange/council-runner.js) exposes `runCouncil(task, agents, options)` -- it collects bids via the existing bidder, filters to qualifying bidders by a confidence floor (default 0.5), optionally executes informational agents in parallel with `maxParallel` + `executionTimeoutMs` guards, feeds evaluations to `EvaluationConsolidator.consolidate(...)`, and returns `{ aggregateScore, confidence, agentScores, consolidatedCriteria, conflicts, suggestions, weightingMode, epistemicFraming }`. Informational-only by default so side-effectful action agents don't fan out writes. Lifecycle callback emits `bids-collected`, `execution:started|done`, `consolidation:done|conflicts`.
  - **hud-api.submitTask dispatch**: when `variant: 'council'` is set AND the `councilMode` flag is on, [lib/hud-api.js](lib/hud-api.js) short-circuits the normal transcript-filter / router / exchange.submit pipeline and calls the runner. Council lifecycle events are mirrored into the Phase 0 task timeline (`council:submitted`, `council:bids-collected`, `council:consolidation:done`, ...). Result is emitted via the normal `emitResult` channel so every tool (orb, recorder, command-HUD) renders it for free.
  - **HUD renderer**: new `consolidatedEvaluation` spec type in [lib/agent-ui-renderer.js](lib/agent-ui-renderer.js) renders aggregate score, per-agent rows with weight bars and trend arrows, a conflict block with high/low scorers and resolution, up to 3 suggestions, primary drivers, and a "Review recommended" badge when the consolidator's uncertainty is high. HTML-escaped throughout.
  - **Dependency injection in the runner**: `getBids` and `executeAgent` options let tests and alternative bidders (Phase 4 per-criterion) plug in without mocking. Side-effect: Phase 1 tests run deterministically against the real consolidator in milliseconds.
  - **Verification**: 64 new unit tests across `test/unit/council-adapter.test.js` (36), `test/unit/council-runner.test.js` (17), `test/unit/agent-ui-consolidated-evaluation.test.js` (11). Every existing test (hud-api, consolidator, agent-registry-crud, agent-execute-contract, agent-conformance) still passes.
  - **Behavior today**: identical to before. Everything is flag-gated. Set `AGENT_SYS_COUNCIL_MODE=1` and pass `variant: 'council'` in `submitTask` options to activate council aggregation.
  - **Unlocks**: plan evaluation, multi-agent judgments, any task that genuinely benefits from multiple perspectives. Later phases (3 auto-variant-selector, 4 per-criterion bidding) layer on top without changing this contract.
  - Files: `lib/exchange/council-adapter.js`, `lib/exchange/council-runner.js`, `lib/agent-ui-renderer.js`, `lib/hud-api.js`, `test/unit/council-adapter.test.js`, `test/unit/council-runner.test.js`, `test/unit/agent-ui-consolidated-evaluation.test.js`

- [x] **Agent-system upgrade, Phase 0 -- Live-path Task contract, state consolidation, feature flags** (v4.9.0)
  - **Why:** Foundation for the multi-phase agent-system upgrade (`.cursor/plans/agent-system-upgrade-phases_*`). Walkthrough of the code showed most "new work" was really integration of already-built subsystems (`lib/evaluation/consolidator.js`, `lib/meta-learning/*`, `lib/agent-learning/*`, bid-history persistence in `src/voice-task-sdk/agent-stats.js`) that weren't reaching the live auction path. Phase 0 lays the pins needed by every subsequent phase.
  - **Feature flags (`lib/agent-system-flags.js`)**: mirrors the `lib/naturalness-flags.js` pattern -- env var -> settings store -> default OFF. Per-phase flags plus an umbrella `agentSysV2` for dogfooding. Explicit per-flag overrides win over the umbrella. 22 new unit tests (`test/unit/agent-system-flags.test.js`).
  - **Typed Task contract**: extended `src/voice-task-sdk/core/types.ts` with optional `description`, `criteria[]`, `rubric`, `variant` ('winner' | 'council' | 'lead_plus_probers'), `toolId`, `spaceId`, `targetAgentId`, `parentTaskId`, `metadata`. Added `lib/task.js` with `buildTask` / `normalizeTask` / `toSubmitPayload` so main-process JS can depend on the shape without a TS build. 27 new unit tests (`test/unit/task-builder.test.js`).
  - **Task store (`lib/exchange/task-store.js`)**: single home for the six state Maps spread across `lib/hud-api.js` (`_taskToolMap`, `_taskSpaceMap`, `_taskTimestamps`, `_hudItems`, `_disambiguationStates`, `_needsInputRequests`). Exposes CRUD for routing, bucketed HUD items with merge-update, disambiguation + needs-input with independent TTLs, and `sweep(now)` that reproduces the legacy stale-entry cleanup verbatim. 29 new unit tests (`test/unit/task-store.test.js`).
  - **Durable task timeline**: extended `src/voice-task-sdk/agent-stats.js` (the existing on-disk agent stats store) with `recordTaskLifecycle`, `getTaskTimeline`, `getRecentLifecycle`, `pruneTaskTimeline`. Persists to `userData/agents/task-timeline.json` with a 2000-event ring buffer. Reused the bid-history persistence pattern rather than building a new event-log module. 12 new unit tests (`test/unit/agent-stats-lifecycle.test.js`).
  - **Live-path wiring (dual-write, flag-gated)**: when `typedTaskContract` is on, `lib/hud-api.js` mirrors every routing mutation into the new task store and records lifecycle events via the timeline. Exchange-bridge's main auction submit also emits a `queued` lifecycle event. All writes are best-effort wrapped in try/catch so the new code can never break the auction.
  - **Verification**: Phase 0 unit tests (87 new) all green; broader sweep across `hud-api`, `consolidator`, `agent-registry-crud`, `agent-execute-contract`, `agent-conformance` = 452 tests passing with zero regressions. No lint errors on any edited file.
  - **Unlocks**: Phase 1 can wire the existing `EvaluationConsolidator` to the live auction via `task.variant`. Phase 2's learned-weight consumer has the bid-event log to read from. Phase 6's HTTP Gateway has the task-timeline for SSE replay. Nothing behaves differently yet -- all flags default off.
  - Files: `lib/agent-system-flags.js`, `lib/task.js`, `lib/exchange/task-store.js`, `src/voice-task-sdk/agent-stats.js`, `src/voice-task-sdk/core/types.ts`, `lib/hud-api.js`, `src/voice-task-sdk/exchange-bridge.js`, `test/unit/agent-system-flags.test.js`, `test/unit/task-builder.test.js`, `test/unit/task-store.test.js`, `test/unit/agent-stats-lifecycle.test.js`

- [x] **IDW opens to account picker instead of forwarding to the right account** (v4.8.2)
  - Symptom: clicking an IDW in the menu sometimes landed on the OneReach account picker instead of the IDW; a second click on the same IDW usually worked.
  - Root cause: every IDW click minted a fresh random session partition (`persist:tab-{ts}-{random}`) in `browser-renderer.js`. The multi-tenant store injected whatever `mult` cookie it had cached for that environment -- which, for users with multiple accounts, was often for a different account than the clicked IDW. OneReach then showed the account picker. The "second click works" behavior came from `multi-tenant-store.js` capturing the updated `mult` cookie after first-click login and serving it to the next click. This mirrored the earlier GSX bug fixed in v4.5.x ("GSX Menu Logs Into Wrong Account"); IDW tabs never got the per-identity partition treatment.
  - Fix 1: menu click now forwards `idwId` and `environment` through `menu-action` -> `open-in-new-tab` (`lib/menu-sections/idw-gsx-builder.js`, `main.js` both `open-idw-url` handlers).
  - Fix 2: renderer uses a stable partition `persist:idw-{idwId}` when `idwId` is present, so each IDW has its own persistent session across clicks and app restarts (`browser-renderer.js`).
  - Fix 3: if a tab is already open on that IDW partition, focus it instead of spawning a duplicate.
  - Fix 4: added `validIdwPattern` (`/^persist:idw-[a-zA-Z0-9_-]{1,64}$/`) to the partition allow-list in `multi-tenant:inject-token` so token injection into the new partition isn't rejected as an invalid format (`main.js`).
  - Net behavior: first login in an IDW now persists in that IDW's partition; every subsequent click lands straight in the correct account, even after app restart (via existing `saveTabState` / `loadSavedTabs`).
  - Files: `lib/menu-sections/idw-gsx-builder.js`, `main.js`, `browser-renderer.js`

- [x] **Orb agent-builder follow-ups: auto-retry, budget precheck, live progress, 3-way voice response** (v4.8.0)
  - **Auto-retry:** After a successful Claude Code build, the original request is re-submitted through the exchange so the newly-registered agent can bid on it. Loop-guarded via a `retriedAfterBuild` metadata flag so a second failed match doesn't trigger another build. Success message becomes *"Done. I built X in about 30 seconds. Running your original request now..."*
  - **Budget precheck:** `buildAgentWithClaudeCode` now calls `budgetManager.checkBudget($0.08 estimate)` before spending any tokens. If blocked, it returns `{ success: false, budgetBlocked: true }` instantly with no LLM calls; agent-builder surfaces this as a Playbooks re-ask ("we're close to the daily budget cap").
  - **Live progress on the orb:** New `onProgress` callback in the builder emits `{ stage, message }` events at every phase (start/plan/generate/save/done/failed). `agent-builder-agent` forwards these through the exchange event bus as `agent-builder:progress` events, which the exchange-bridge relays to `showCommandHUD` -- so the user sees *"Designing the agent..."* -> *"Writing the agent..."* -> *"Saving and registering..."* instead of a silent 30-45s gap.
  - **3-way voice response:** When the build is offered, the user can now say *"yes"* (build with Claude Code), *"playbook"* (use Playbooks instead), or *"no"* (polite decline). The offer message now includes the escape hatch inline: *"Or say 'playbook' to plan it first."*
  - 16 new unit tests (46 total for the feature) + 21-assertion live smoke test covering all four paths with real Claude Code
  - Files: `lib/claude-code-agent-builder.js`, `packages/agents/agent-builder-agent.js`, `src/voice-task-sdk/exchange-bridge.js`, `test/unit/claude-code-agent-builder.test.js`, `test/unit/agent-builder-claude-code.test.js`

- [x] **Orb offers to build new agents with Claude Code** (v4.8.0)
  - When the orb can't match any agent and the request is `easy` or `medium` effort, `agent-builder-agent` now offers **"Want me to build it right now? It'll take about 30 seconds."** instead of defaulting to the external WISER Playbooks drafting tool
  - New `lib/claude-code-agent-builder.js` orchestrates `planAgent` (via bundled Claude Code) -> `generateAgentFromDescription` -> `agentStore.createAgent` in one call
  - On user confirmation, the agent is built and persisted in ~30-45s for ~$0.03
  - Built agent is immediately available for bidding; success message tells the user "try your original request again"
  - `hard` and `not_feasible` requests still route to WISER Playbooks (unchanged)
  - Claude Code build failures fall back gracefully to the Playbooks path with a re-ask prompt
  - Incidental fix: `BaseAgent.create()` now binds `this` to the agent when calling `onExecute`, so helper methods like `this._assessFeasibility(...)` actually work. Previously these threw TypeError and the wrapper's catch-all returned a generic error -- affecting `agent-builder-agent` and `sound-effects-agent`.
  - 30 new unit tests in `test/unit/claude-code-agent-builder.test.js` and `test/unit/agent-builder-claude-code.test.js`
  - Live smoke test verified: built a "Dad Joke Agent" end-to-end from a voice-style request, agent persisted to store with keywords
  - Files: `lib/claude-code-agent-builder.js` (new), `packages/agents/agent-builder-agent.js`, `packages/agents/base-agent.js`, `test/unit/claude-code-agent-builder.test.js` (new), `test/unit/agent-builder-claude-code.test.js` (new)

- [x] **App-wide security, reliability, and hardening pass** (v4.8.0)
  - **Security:**
    - Redacted secrets in `settings:get-all` IPC (new `settings:get-all-sensitive` for settings UI only)
    - Path confinement on `aider:read-file` / `write-file` / `delete-file` / `watch-file` (Spaces/userData/tmp only)
    - Allow-list for `terminal:exec` (blocks dangerous shell patterns at the IPC boundary)
    - Dev mode now always uses `safeStorage` when available (previously stored API keys plaintext)
    - Allow-list for MCP commands in playbook executor (`npx`, `node`, `uvx`, `bunx` only) + sanitizes env secrets
    - Removed partial API key logging (was leaking 15-char prefix to log server)
    - Tightened OAuth popup allow-list: hostname-suffix match instead of URL substring (blocks `evil.com/oauth`)
    - Ran `npm audit fix` (30 -> 5 vulns; remaining 5 are in devDeps only)
    - Removed unused `@anthropic-ai/sdk` dependency
  - **Reliability:**
    - Wired `activeRequestId` in `GSXCreateEngine` so `shutdown()` actually cancels in-flight Claude Code processes
    - Serialized `runPrompt` / `runPromptStreaming` calls so concurrent invocations don't corrupt session state
    - `cancelAll()` on Claude Code runner invoked on app quit (no more orphan CLI processes)
    - Playwright browser-automation `stop()` called on app quit
    - `safeSend()` helper in `lib/safe-send.js` replaces ~6 risky `webContents.send` callsites that lacked destroy checks
    - `aider:watch-file` capped at 100 concurrent watchers, all closed on quit
    - Fixed `triggerGraphSync` TOCTOU race (concurrent callers now share a single in-flight promise)
    - Fixed `tab-partitions-response` race (request-id matching instead of `ipcMain.once`)
    - Logged every per-item graph sync failure (was silent `catch (_) {}`)
    - Unified `browsing:get-auth-pool-domains` error shape
  - **Memory:**
    - Capped `_jobs` Map in playbook-executor (100 terminal jobs, oldest evicted)
    - Capped `_htmlCache` in url-to-html (200 entries, LRU)
    - Capped `searchCache` in webview-search-service (100 entries, LRU)
    - `budget-manager` `setInterval` handle stored + cleared on shutdown
    - Log server + Spaces API server stopped on app quit for clean port release
  - **Cleanup:**
    - Deleted `_legacy/` folder (unused)
    - Removed hardcoded `/Users/richardwilson/` paths from test files
    - Added `engines: { node: ">=20.0.0" }` to package.json
    - Fixed version drift (PUNCH-LIST was 4.7.1, package.json 4.7.2)
    - Updated docs to reference `gsx-create.html` (renamed in v4.8.0)
  - Files: `main.js`, `preload.js`, `settings-manager.js`, `settings.html`, `budget-manager.js`, `dependency-manager.js`, `lib/gsx-create-engine.js`, `lib/graph-library-sync.js`, `lib/playbook-executor.js`, `lib/converters/url-to-html.js`, `lib/safe-send.js` (new), `packages/agents/webview-search-service.js`, `clipboard-manager-v2-adapter.js`, `recorder.js`, `package.json`, `test/test-metadata-api-integration.js`, `test-elevenlabs-integration.js`, `test-file-count.js`, docs

- [x] **Upgrade `powerful` profile to Claude Opus 4.7** (v4.7.x)
  - Replaced `claude-opus-4-6` with `claude-opus-4-7` in `lib/ai-service.js` (both `powerful` primary and `large` fallback)
  - Added Opus 4.7 + Opus 4.6 pricing entries in `pricing-config.js` (both at standard Opus tier: $15/$75 per 1M)
  - Updated `opus` / `claude-opus` / `claude-4-opus` aliases and partial-match fallback to resolve to 4.7
  - Added missing `claude-haiku-4-5-20251001` pricing entry (used by `fast` profile)
  - Updated doc comments in `memory-agent.js`, `anthropic-adapter.js`, `.cursorrules`, test files
  - Bundled Claude Code upgraded to v2.1.112 (from 2.1.104) via `scripts/download-claude-code.js`
- [x] **Microphone permission prompt loops on macOS (deployed app)** (v4.7.x)
  - Built app was missing `NSMicrophoneUsageDescription` / `NSCameraUsageDescription` in Info.plist
  - macOS couldn't persist the permission grant, so the dialog reappeared every time
  - Fix: Added `extendInfo` to `mac` build config in `package.json`
- [x] **Agent Self-Learning System** (v4.7.x)
  - Fully automatic system that monitors agent interactions, detects improvement opportunities (frustration, capability gaps, proactive usefulness), and improves agents silently
  - 7 new modules in `lib/agent-learning/`: interaction collector, opportunity evaluator, known-agent-issues registry, improvement engine, UI improver, quality verifier, playbook writer, orchestrator
  - LLM-as-judge verification: never deploys if any test case degraded
  - Silent testing: all verification bypasses exchange/TTS/HUD pipeline
  - Three-layer budget control: app global limits + learning daily cap ($0.50 default) + per-operation count caps
  - Audit trail via Agent Product Manager space (playbooks for every improvement)
  - 42 unit tests across 4 test files
  - Integration: `exchange-bridge.js` emits `learning:interaction` and `learning:capability-gap` events; `main.js` initializes after exchange bridge
  - Files: `lib/agent-learning/*.js`, `src/voice-task-sdk/exchange-bridge.js`, `main.js`

- [x] **Auto-upgrade bundled Claude Code on build** (v4.7.x)
  - `scripts/download-claude-code.js` now checks installed version vs latest on npm; only re-downloads when a newer version exists
  - `scripts/release-master.sh` runs the update automatically as a new step before building
  - Added `--force` flag and `npm run update-claude` / `update-claude:force` scripts
  - Files: `scripts/download-claude-code.js`, `scripts/release-master.sh`, `package.json`

- [x] **Fix recursive situation snapshot crash** (v4.7.1)
  - Situation logger snapshots recursively nested previous snapshots via recentLogs, causing single log entries to reach 300+ MB
  - This triggered macOS disk-write termination and V8 OOM crashes after ~24 minutes of runtime
  - Fix: Strip recentActivity from enqueued snapshots, filter situation entries from recentLogs, cap file-write data at 64 KB
  - Files: `action-executor.js`, `lib/log-event-queue.js`

- [x] **Mode Card Welcome Experience** (v4.6.x)
  - Replaced 5-slide intro wizard and changelog with single rotating mode card per launch
  - 9 cards covering Conversational Experience Modes: Seek, Learn, Monitor, Plan, Create, Train, Coordinate, Simulate, Browse
  - Organized under 3 parents: Acquire Knowledge, Do, Explore
  - Shows one card per load, rotates sequentially, never the same twice until full cycle
  - Compact 500x420 frameless modal, "Got it" dismiss
  - Files: `intro-wizard.html`, `preload-intro-wizard.js`, `settings-manager.js`, `main.js`

- [x] **GSX Teacher Agent** (v4.6.x)
  - Built-in tutor agent (`packages/agents/teacher-agent.js`) with 8-module curriculum (28 lessons)
  - Modules: Getting Started, Power User, Building Agents, Building Skills, Creating IDW, App Capabilities, Knowledge Models, Using Spaces
  - LLM-based intent classification (next_lesson, specific_lesson, question, exercise, progress)
  - Progress tracking via agent memory -- remembers completed lessons across sessions
  - Hands-on exercises with guided walkthroughs for each lesson
  - Opens relevant app windows during lessons (Settings, Agent Manager, Video Editor, etc.)
  - Registered as `teacher-agent` in agent-registry.js

- [x] **App Self-Healing System** (v4.6.x)
  - External watchdog process (`lib/watchdog.js`): pings `/health` every 15s, auto-restarts app after 45s unresponsive
  - Internal health monitor (`lib/health-monitor.js`): event loop lag detection, CPU/memory monitoring, renderer auto-reload
  - Post-crash notification: reads `crash-recovery.json` on boot, notifies user what happened
  - Situation-aware logging: every log entry includes `context` (focusedWindow, flowId, stepId)
  - Periodic situation snapshots every 60s logged as `category: 'situation'`
  - Unified `GET /app/status` endpoint: situation + log stats + recent logs + errors in one call
  - Health data included in `app-situation` snapshots
  - Bug fixes: double-response in log-server POST handlers, context cache shallow-copy, watchdog packaged-app relaunch
  - Files: `lib/watchdog.js`, `lib/health-monitor.js`, `lib/log-event-queue.js`, `lib/log-server.js`, `action-executor.js`, `main.js`

- [x] **Desktop Autopilot** (v4.6.x)
  - Unified facade (`lib/desktop-autopilot.js`) combining browser automation, app control, and macOS system control
  - Adopted `browser-use` npm package (v0.5) to replace custom Playwright wrapper for browser automation
  - Custom LLM adapter (`lib/browser-use-adapter.js`) routes all AI calls through `lib/ai-service.js` for cost tracking
  - 6 new agent tools in `lib/agent-tools.js`: `desktop_browse`, `desktop_app_action`, `desktop_app_situation`, `desktop_applescript`, `desktop_mouse`, `desktop_keyboard`
  - 7 new actions in `action-executor.js` under `desktop` category
  - REST endpoints: `GET /app/desktop/status`, `POST /app/desktop/browser/*`, `POST /app/desktop/system/*`
  - Settings UI: renamed Browser Automation tab to Automation, added master toggle + 3 sub-toggles
  - Off by default; System Control (AppleScript/mouse/keyboard) is double-gated
  - Browser agent updated to use Desktop Autopilot as primary path with legacy fallback
  - Docs: Section 9 added to `APP-CONTROL-API-REFERENCE.md`

- [x] **Centralized App Control API** (v4.5.x)
  - Expanded `action-executor.js` from ~20 to 120+ registered actions covering every app operation
  - Categories: windows, IDW, GSX, agents (CRUD + execution + memory), settings, modules, tabs, credentials, budget, AI, voice, video, backup, dev-tools, learning, share, system
  - Added REST API: `GET/POST /app/actions` on log server (port 47292) for external control
  - Added `action:execute`, `action:list`, `action:has`, `action:info` to preload.js invoke whitelist
  - Refactored menu.js to use `executeAction()` for GSX Create, Video Editor, Recorder, Module Manager
  - 26 unit tests in `test/unit/action-executor.test.js` (registry shape, param validation, execution, category coverage)
  - Comprehensive docs: `docs/internal/APP-CONTROL-API-REFERENCE.md`
  - Updated `docs/openapi-spec.js` with `/app/actions` endpoints and `lib/ipc-registry.js` with action channels
  - Files: `action-executor.js`, `lib/log-server.js`, `menu.js`, `preload.js`, `docs/openapi-spec.js`, `lib/ipc-registry.js`

- [x] **Invisible window layers blocking desktop** (v4.5.x)
  - **IDW loading overlay never removed**: Full-screen overlay (`z-index: 9999`) injected into main window via `executeJavaScript` was never cleaned up; when content window closed and main window re-appeared, the overlay blocked the entire UI
  - Fix: Remove `#loading-overlay` on both the `closed` and error paths in `browserWindow.js`
  - **Smart Export modal orphaned**: Created with `parent: getFocusedWindow()` (could be null) and no `closed` handler; if parent closed first or IPC never fired, the modal persisted invisibly
  - Fix: Fall back to `mainWindow` when no focused window; add `closed` handler
  - **Auth popup never closed**: SSO popup only closed on specific callback URL; no timeout, no tracking, duplicates could pile up
  - Fix: Track in `global._ssoAuthPopup` to prevent duplicates; add 90s auto-close timeout; add `closed` handler
  - **Black Hole input dialog leaked Promise**: Only closed via IPC response; if user closed the window manually (Cmd+W), the Promise never resolved and the IPC listener leaked
  - Fix: Add `closed` handler that resolves the Promise and removes the IPC listener
  - **Create Data Source overlay not removed on error**: If `addDataSource()` threw, the full-screen overlay stayed, blocking the Spaces UI
  - Fix: Call `overlay.remove()` in the catch block
  - Files: `browserWindow.js`, `main.js`, `clipboard-viewer.js`

- [x] **Phase A: Auth module consolidation -- eliminate selector drift** (v4.5.x)
  - Created `lib/auth-scripts.js` -- single source of truth for all auth CSS selectors and injectable script builders (11 exports)
  - Replaced 31 inline `executeJavaScript` auth scripts across 3 files with shared builder calls
  - `browser-renderer.js`: 11 inline scripts replaced (form detection, page type, login fill, 2FA fill, account select, auth status check)
  - `browserWindow.js`: 7 inline scripts replaced; fixed React `.value` bug in 2FA fill (was using `codeField.value = code` instead of `nativeInputValueSetter`)
  - `lib/gsx-autologin.js`: 13 inline scripts replaced; removed local `AUTH_SELECTORS` (was missing `verificationCode`, `twoFactorCode`)
  - Added heuristic 2FA fallback: detects single visible short numeric input + auth text patterns
  - Added `preload.js` bridge so renderer process can access builders via `window.authScripts`
  - Unit test validates all builders produce parseable JS with special character escaping
  - Files: `lib/auth-scripts.js` (new), `browser-renderer.js`, `browserWindow.js`, `lib/gsx-autologin.js`, `preload.js`, `test/unit/auth-scripts.test.js` (new)

- [x] **Auto-login fails: post-auth monitor can't detect 2FA page** (v4.5.x)
  - `monitorPostAuth` used narrower 2FA selectors than the cross-origin path, missing `input[maxlength="6"]` and `input[name="verificationCode"]`
  - After successful login form submission, the 2FA page was misidentified as `login` for all 12 polls, causing timeout
  - Aligned 2FA selectors in `monitorPostAuth`, `attemptAutoLogin`, and `fill2FACode` with the broader set used in `attemptCrossOrigin2FA`
  - Added text-based 2FA detection fallback (matches "verification code", "6-digit", etc.)
  - File: `browser-renderer.js`

- [x] **WISER Meeting screen share not visible to other participants** (v4.5.x)
  - Screen capture was only displayed locally — never published to LiveKit room
  - Added `sessionToggleScreenShare`, `sessionPublishScreenShare`, `sessionStopScreenShare` methods to publish screen track via `localParticipant.publishTrack` with `Track.Source.ScreenShare`
  - Intercepted screen/both mode switches during active session to stay in session mode
  - Updated TrackSubscribed handlers (host, guest-in-hub, guest page) to use `objectFit: contain` for screen share tracks
  - Files: `recorder.html`, `lib/capture-guest-page.js`

- [x] **Memory Usage Optimization** (v4.5.x)
  - Added `backgroundThrottling: false` to all 27+ BrowserWindow instances across `browserWindow.js` and `main.js` to reduce idle memory/CPU from background windows
  - Fixed GSX partition leak: added `unregisterPartition` and `removeCookieListener` calls in GSX window close handler (`browserWindow.js`)
  - Fixed auth window listener accumulation: moved `ipc-message` listener out of `did-finish-load` so only one listener is registered per auth window (`browserWindow.js`)
  - Fixed tab close login state leak: `closeTab()` now cleans up `autoLoginState`, `tabsWithActiveLogin`, and `globalLoginQueue` (`browser-renderer.js`)
  - Fixed Blob URL leaks in `clipboard-viewer.js` (TTS audio, media preview) and `video-editor-app.js` (video upload, audio import) -- now revokes old URLs before replacing
  - Added unsubscribe returns to event listeners in `preload-smart-export.js`, `preload-command-hud.js`, `preload-command-palette.js`, `preload-external-ai.js`
  - Added 200-message cap to `ai-conversation-capture.js` to prevent unbounded message array growth
  - Added 500-entry limit to IDW Feed image cache (`uxmag-script.js`) and 50-entry limit to orb SFX cache (`orb-sound-library.js`)
  - Files: `browserWindow.js`, `main.js`, `browser-renderer.js`, `clipboard-viewer.js`, `video-editor-app.js`, `preload-smart-export.js`, `preload-command-hud.js`, `preload-command-palette.js`, `preload-external-ai.js`, `src/ai-conversation-capture.js`, `Flipboard-IDW-Feed/uxmag-script.js`, `lib/orb/orb-sound-library.js`, `lib/gsx-autologin.js`

- [x] **GSX Menu Logs Into Wrong Account** (v4.5.x)
  - Root cause 1: all GSX windows in the same IDW environment shared a single session partition (`persist:gsx-edison`), so once you authenticated as Account A, opening a tool for Account B reused Account A's cookies
  - Root cause 2: after login + 2FA, multi-account users see an account picker page, but the GSX auto-login had zero handling for it -- the flow only detected login, 2FA, and errors
  - Fix 1: Include `accountId` in the partition key (`persist:gsx-edison-{accountId}`) so each account gets its own isolated session
  - Fix 2: Removed the global `gsxAccountId` settings override -- every GSX window was overwriting the shared setting, causing "last account wins" in menu generation and browser tab account selection
  - Fix 3: Added account selection detection to `waitForPostSubmitTransition` -- now detects account picker elements after login/2FA submit
  - Fix 4: Added `selectAccountInAuthFrame` function (4 strategies: link href, data attributes, HTML content match, form submit) to auto-click the correct account
  - Fix 5: Added `handleAccountSelection` orchestrator that selects the account and waits for the auth frame to disappear
  - Fix 6: Threaded `targetAccountId` from the URL through `gsxAutoLoginState` so it's available at the account selection step
  - Files: `lib/gsx-autologin.js`

- [x] **GSX Auto-Login Reliability Overhaul** (v4.5.x)
  - Root cause: entire auto-login flow used blind `sleep()` delays (800ms-2400ms) to wait for React forms to render, causing failures when the auth server was slow or fast
  - Fix 1: Replaced sleep-retry loop with MutationObserver-based `waitForAuthForm()` -- resolves instantly when form inputs appear, with 10s timeout fallback
  - Fix 2: Replaced blind 1500ms post-submit sleep with `waitForPostSubmitTransition()` -- observes for 2FA page, error messages, or auth frame redirect
  - Fix 3: Wired up dead "Try Again" button -- added `retryAutoLogin` to preload IPC bridge + per-window `webContents.ipc` handler
  - Fix 4: Centralized auth selectors into `AUTH_SELECTORS` constant and extracted `findAuthFrame`/`waitForAuthFrame` helpers to eliminate duplicated selector strings
  - Fix 5: Fixed broken rate-limit log message (`Math` as property name, empty template placeholders)
  - Fix 6: Deleted orphaned `lib/auto-login.js` (unused `AutoLoginManager` class, never imported)
  - Files: `lib/gsx-autologin.js`, `preload.js`

- [x] **GSX IDW Refresh Button Race Condition** (v4.5.x)
  - The toolbar refresh button in GSX IDW windows sometimes did nothing when clicked
  - Root cause: `clearCacheAndReload()` uses fire-and-forget `ipcRenderer.send` (returns `undefined`), so `|| location.reload()` always ran too, creating a race between main-process `reloadIgnoringCache()` and renderer `location.reload()` that could leave the page in a broken navigation state
  - Fix 1: Replaced `clearCacheAndReload?.() || location.reload()` with proper `if/else` so only one reload mechanism fires
  - Fix 2: Added `win.isDestroyed()` guards and a 3-second timeout on `session.clearCache()` so reload always proceeds even if cache clear hangs
  - Files: `lib/gsx-autologin.js`, `main.js`

- [x] **GSX Refresh Still Blocked by beforeunload** (v4.5.x)
  - Refresh button still sometimes did nothing even after the race-condition fix
  - Root cause: GSX pages (OneReach platform SPAs) register `beforeunload` handlers for unsaved-state protection. `reloadIgnoringCache()` triggers `beforeunload`, and without a `will-prevent-unload` handler Electron silently honors the page's prevention, so the reload never happens
  - Secondary cause: Module-manager web tool windows used `preload-spaces.js` which lacked `clearCacheAndReload`, so they always fell back to `location.reload()` with the same blocking issue
  - Fix 1: Added a one-time `will-prevent-unload` override in the `clear-cache-and-reload` IPC handler so user-initiated refresh always goes through
  - Fix 2: Added `clearCacheAndReload` and `triggerMissionControl` to `preload-spaces.js` so web tool windows use the IPC path
  - Files: `main.js`, `preload-spaces.js`

- [x] **Unified Bidder Simplification** (v4.5.x)
  - Rewrote bidder evaluation prompt: removed 150 lines of hand-holding (example queries, domain routing rules, calendar/time/weather heuristics) and replaced with a simple 30-line capability-matching prompt
  - Rewrote ALL 26 agent prompts from example-based (HIGH/LOW CONFIDENCE + sample phrases + "do NOT bid" lists) to capability-based (describe what the agent does, let the LLM figure out if requests match)
  - Removed regex-based sanity checks (`indicatesNoMatch`, `indicatesClearMatch`) that overrode LLM confidence scores -- violates the 100% LLM routing policy
  - Fixed cache: replaced two-tier fuzzy key system (regex pronoun detection + truncated context hashing) with exact-match cache keys (agent ID + full task content)
  - Fixed agent generator template (`lib/ai-agent-generator.js`): no longer requires new agents to include HIGH/LOW CONFIDENCE bidding sections
  - Root cause: "Create a new playlist and exclude songs similar to..." was dead-lettered because the DJ agent bid 0.00 -- the LLM was overwhelmed by the verbose prompt and didn't recognize playlist creation as a DJ capability
  - Agents updated: dj-agent, calendar-query-agent, calendar-create-agent, calendar-edit-agent, calendar-delete-agent, time-agent, weather-agent, daily-brief-agent, email-agent, memory-agent, orchestrator-agent, app-agent, help-agent, search-agent, smalltalk-agent, docs-agent, spelling-agent, browsing-agent, browser-agent, recorder-agent, playbook-agent, action-item-agent, sound-effects-agent, media-agent, meeting-monitor-agent, error-agent
  - Files: `packages/agents/*.js`, `lib/ai-agent-generator.js`, `packages/agents/unified-bidder.js`, `test/unit/unified-bidder.test.js`, `test/unit/dj-agent.test.js`, `test/unit/weather-agent.test.js`, `test/unit/browsing-agent.test.js`

- [x] **Memory Editor Core Component** (v4.5.x)
  - New `lib/memory-editor-api.js` -- backend API with pending edit queue, CRUD, AI chat editing
  - New `preload-memory-editor.js` -- IPC bridge exposing `window.memoryEditor`
  - New `memory-editor.html` -- sidebar, markdown editor with live preview, diff view, chat panel
  - `createMemoryEditorWindow()` in `main.js` with IPC registration and export
  - Modified `memory-agent.js` to route changes through editor (proposeEdit) when editor is open, falling back to direct writes when closed
  - Added to Tools menu, action-executor, and app-agent product catalog for voice access
  - Supports: review-before-apply flow, on-demand editing, AI-powered chat edits via `fast` profile

- [x] **Bidding Inverse Sanity Check** (v4.5.x)
  - Fixed brittleness in 100% LLM-based agent routing where the LLM would return near-zero confidence despite reasoning that described a clear match (e.g., "direct, explicit request" with 0.05 confidence)
  - Added inverse sanity check: when reasoning indicates a clear match but confidence is below 0.3, boost to 0.85
  - Applied to both single-agent and batch evaluation paths in `unified-bidder.js`
  - Added "Build an agent for this" as a fallback option on all rephrase disambiguation responses
  - Improved `generateClarificationOptions` prompt to correctly classify straightforward requests as `capability_gap` when agents fail to bid
  - Fixed HUD rendering bug where `opt.action` was displayed instead of `opt.description` for disambiguation options

- [x] **AI Error Diagnosis for Custom Agents** (v4.5.x)
  - When a non-system (user-created) agent fails execution, the error-agent now runs AI-powered diagnosis via `ai.diagnoseAgentFailure()` and `ai.generateAgentFix()`
  - Built-in (system) agents continue to get the original canned error messages -- no AI cost for known agent failures
  - Diagnosis produces root cause, category, confidence, and suggested fix
  - User is offered disambiguation options: "Fix it now" (opens Agent Composer with diagnosis), "Open in Agent Composer" (inspect the agent), "Try again" (resubmit), or "Skip"
  - Failed agent ID tracked through `task:busted` events via `task.metadata.lastAgentId` (since `assignedAgent` is cleared on re-auction)
  - Agent name, execution type, and prompt stored on task metadata at assignment time for diagnostic context
  - Files: `packages/agents/error-agent.js`, `src/voice-task-sdk/exchange-bridge.js`, `lib/hud-api.js`

- [x] **Graceful Capability Gap Handling** (v4.5.x)
  - When no agent can handle a request, the system now distinguishes between "ambiguous request" (rephrase) and "capability gap" (no agent exists for this)
  - Capability gaps get a **build proposal**: effort level (small/medium/large), estimated token cost per use, LLM call breakdown, named integration point, and required tools
  - Three actionable options: "Create a build playbook" (generates full playbook to Spaces), "Build it now" (opens Agent Composer with description), "Add to wishlist" (silent ack)
  - **Playbook generation**: Standard-profile LLM generates a structured Markdown playbook (goal, architecture, implementation steps, LLM prompt draft, cost estimate, testing plan) and saves it to the Capability Wishlist space
  - Persists capability gaps with full build proposal metadata to a "Capability Wishlist" space -- deduplicated
  - Voice commands "build a playbook for this/that" and "build an agent for this/that" resolve pronouns from conversation history
  - Pre-screen filter widened from 4 to 6 candidates with improved specialist-aware prompt
  - Removed 4 leftover debug fetch calls to port 7242 in orb.html (CSP violations)
  - Files: `src/voice-task-sdk/exchange-bridge.js`, `src/voice-task-sdk/integration.js`, `lib/hud-api.js`, `orb.html`

- [x] **Keychain Prompt Reduction** (v4.5.x)
  - Lazy-load `keytar` module (deferred from module-load to first actual credential access)
  - Session-level cache with 5-minute TTL for all `getPassword` and `findCredentials` calls
  - Cache invalidation on writes ensures freshness
  - Reduces macOS Keychain prompts from 4 (one per service name) to 0 for repeat reads within a session
  - Modified: `credential-manager.js`

- [x] **Command Palette + Discoverability** (v4.5.x)
  - Cmd+K opens a Spotlight-style overlay to search all features, agents, spaces, AI services, and voice commands
  - Glassmorphism UI with fuzzy search, keyboard navigation (arrows + enter), category grouping
  - Aggregates data from: `getOpenableItems()` (menu features), `agent-registry` (28 agents), Spaces API, hardcoded voice commands
  - Execute actions: open windows (via `action-executor.js`), open URLs, navigate to spaces, submit voice commands (via HUD API)
  - BrowserWindow: frameless, transparent, always-on-top, centered on active display, hides on blur/escape
  - Help Agent upgraded from hardcoded 4-item response to dynamic categorized overview of all registered agents
  - "What can you do?" now returns a spoken summary + HTML panel grouping agents by: Productivity, Information, Media, Communication, Utility, System
  - Dependency injection (`_setDeps`) from exchange-bridge for testability
  - Files: `command-palette.html` (new), `preload-command-palette.js` (new), `main.js`, `packages/agents/help-agent.js`, `src/voice-task-sdk/exchange-bridge.js`

- [x] **Voice Orb Hardening** (v4.4.2)
  - `_onSpeakingEnd` now called on all `playTTSAudio` error/early-return paths (prevents stuck speaking state)
  - `processVoiceCommand` guard prevents overlapping concurrent submissions
  - `reconnected` handler transitions state machine back to `listening`
  - `resolveDisambiguation` error calls `endSession` instead of silently failing
  - Session generation counter prevents stale async mic setup from leaking media streams
  - Preflight guard: if `window.orbAPI` missing, orb shows failure message instead of crashing
  - Click/dblclick debounce (250ms) prevents accidental text-chat open on single click
  - Mic capture pre-acquired in parallel with WebSocket connect (eliminates ~1.2s speech clipping)
  - Early audio ring buffer streams captured PCM to WebSocket once connection ready
  - Listening UI (blue glow + chime) deferred until mic capture is confirmed live
  - "Your turn" cue + amber dwell (1500ms) + ready chime on agent follow-up questions
  - WebSocket reconnect timer stored and cleared on disconnect (prevents timer stacking)
  - `isConnecting` guard prevents duplicate connect attempts
  - IPC timeout wrapper (15-20s) on critical calls: connect, speak, respondToFunction, mic permission
  - Files: orb.html, lib/orb/orb-audio.js, voice-listener.js, preload-orb.js

- [x] **Alpha UX Polish Pass** (v4.4.1)
  - Fixed `ttsAudioInitialized` typo in orb-audio.js (ReferenceError on AudioContext resume failure)
  - HUD result message now scrollable (max-height + overflow)
  - Back/forward nav buttons visually disabled when no history
  - LLM badge emoji replaced with SVG icon
  - Black Hole tooltip explains its purpose
  - Orb shows specific mic-denied message with System Settings guidance
  - Orb shows fallback text when TTS speak fails
  - Orb now has visible type-a-message button and one-time first-use hint
  - Recorder shortcuts bar shows Pause (P) and Captions (C)
  - Recorder captions toggle checks for OpenAI API key, shows status message if missing
  - Recorder join panel updated from Host/Code fields to share-link UI
  - Recorder permission overlay includes macOS Settings recovery instructions
  - Spaces search differentiates "no results" from "empty space"
  - Spaces search shows loading indicator during async search
  - IDW container empty state explains what to do and links to setup
  - Browser webview `did-fail-load` injects styled error page with Retry button
  - Replaced ~25 alert()/confirm() calls in Spaces with styled toast and confirm modal
  - Replaced ~15 emoji instances (📎 🎤 🎵 🔄 📸 ❌ 🤖) with inline SVG icons
  - Files: orb.html, orb-audio.js, command-hud.html, tabbed-browser.html, browser-renderer.js, recorder.html, clipboard-viewer.js

- [x] **Calendar Micro UI Restored** (v4.4.1)
  - Calendar agent results now show styled event cards in the Command HUD instead of plain text
  - Root cause: agents returned declarative `ui` specs but the pipeline never converted them to `html`
  - Fix: `normalizeResult()` in agent-middleware now auto-converts `ui` specs to rendered HTML via `renderAgentUI()`
  - Daily-brief-agent now builds a calendar event UI card from calendar contributions
  - Calendar-query-agent's `getBriefing()` now passes event data through to the daily-brief-agent
  - Files: `packages/agents/agent-middleware.js`, `packages/agents/daily-brief-agent.js`, `packages/agents/calendar-query-agent.js`

- [x] **Double Audio Fix** (v4.4.0)
  - Fixed orb speaking responses twice when backend already handled TTS
  - Root cause: `orb.html` fallthrough path triggered `speaker.speak()` even when `suppressAIResponse: true`
  - Added `_currentSource` tracking in `lib/orb/orb-audio.js` to prevent audio overlap
  - Added duplicate event handler guard in `lib/orb/orb-event-router.js`
  - Files: `orb.html`, `lib/orb/orb-audio.js`, `lib/orb/orb-event-router.js`

- [x] **Idle Resource Optimization** (v4.4.0)
  - Adaptive polling: resource-manager.js reduces scan frequency from 30s to 120s when system is idle
  - Exchange-bridge reconnect: exponential backoff (caps at 60s) instead of fixed 5s intervals
  - App-context-capture: skips redundant captures when context hasn't changed
  - App-manager-agent: optimized polling and idle detection
  - Files: `resource-manager.js`, `src/voice-task-sdk/exchange-bridge.js`, `app-context-capture.js`, `app-manager-agent.js`

- [x] **Agent Structural Hardening** (v4.4.0)
  - All 15 built-in agents hardened with contract-conformant `execute()` signatures
  - Agents return `{ success, result }` consistently; never throw unguarded
  - Added `agent-middleware.js` with timeout, error boundary, input normalization
  - Added agent conformance test suite (`test/unit/agent-conformance.test.js`)
  - Added agent import smoke test (`test/unit/agent-import-smoke.test.js`)
  - Files: `packages/agents/*.js`, `packages/agents/agent-middleware.js`, `src/voice-task-sdk/exchange-bridge.js`

- [x] **Agent Tool Calling Infrastructure** (v4.4.0)
  - Added native tool/function calling support to Anthropic and OpenAI adapters (tools param, normalized `{toolCalls}` response shape)
  - New `chatWithTools()` method on AI service with automatic tool-use loop (max 10 rounds, safety cap, progress callback)
  - Created shared tool registry (`lib/agent-tools.js`): `shell_exec`, `file_read`, `file_write`, `file_list`, `web_search`, `spaces_search`, `spaces_add_item`, `get_current_time`
  - Shell safety filter blocks dangerous commands (rm -rf, sudo, mkfs, dd, chmod 777 /)
  - Agent middleware auto-injects tool capabilities when agents declare `tools` property
  - Exchange bridge routes tool-equipped agents through `chatWithTools` instead of plain `chat`
  - Registered `terminal:exec` IPC handler in main.js + `window.terminal` preload bridge
  - 28 new unit tests covering adapters, registry, dispatcher, tool execution, middleware, and `chatWithTools` validation
  - Files: `lib/agent-tools.js` (new), `lib/ai-service.js`, `lib/ai-providers/anthropic-adapter.js`, `lib/ai-providers/openai-adapter.js`, `packages/agents/agent-middleware.js`, `src/voice-task-sdk/exchange-bridge.js`, `main.js`, `preload.js`

- [x] **Agent Robustness: Edge-Case Testing & Fixes** (v4.5.1)
  - Created comprehensive chaos/edge-case test suite (`test/unit/agent-edge-cases.test.js`): 223 tests throwing random, adversarial, and malformed inputs at 6 agents (weather, DJ, daily brief, time, spelling, smalltalk)
  - Inputs tested: empty strings, unicode/emoji, XSS/SQL injection, path traversal, very long strings, numbers, gibberish, contradictory commands, profanity, off-topic queries, null-like values, multi-turn state corruption, concurrent execution
  - **Bug found & fixed**: `weather-agent.js` `extractLocation()` crashed on non-string inputs (number, boolean, object, array) -- added `typeof text !== 'string'` guard
  - Created `test/unit/weather-agent.test.js` (16 tests): location extraction, agent metadata, briefing interface, pending-state handling
  - Created `test/unit/dj-agent.test.js` (48 tests): pattern cache matching, mood detection, volume control, history parsing, response formatting, option generation
  - **Fixed stale test**: `test/unit/daily-brief-fixes.test.js` referenced deleted `calendar-agent.js` -- updated to `calendar-query-agent.js` and rewrote 4 assertions to match refactored `getBriefing()` implementation
  - All 3045 unit tests passing (151/152 files; 1 pre-existing failure in `ai-service.test.js`)

- [x] **Voice Orb: Stale Context, Wrong Name, TTS/Preload Crashes** (v4.5.2)
  - **Stale date injection**: `getContextString()` in `lib/user-profile-store.js` was returning stored `Date: February 8, 2026` to the LLM -- NormalizeIntent would then inject the wrong date into every query. Fix: now generates live date/time/day from system clock and filters out stored ephemeral keys.
  - **Ephemeral fact pollution**: Agents were writing transient facts (Current Time, Date, Day) to the profile, which would go stale immediately. Fix: `updateFact()` now rejects known temporal keys.
  - **Wrong user name**: Smalltalk agent stored names in its local memory (`User Name: doing`) instead of the global profile, and read from that local source. Fix: now reads/writes `Identity > Name` via `getUserProfile()`. Also tightened the name regex to require capitalized 2+ char names and reject common gerunds (Doing, Going, etc.).
  - **Stale text flashing in orb**: `hideTranscript()` removed CSS classes but never cleared `textContent`, so old text would flash when the tooltip reappeared. Fix: now clears `transcriptInner.textContent = ''` after fade-out.
  - **`ttsAudioInitialized` not defined**: `lib/orb/orb-audio.js` line 27 referenced `ttsAudioInitialized` instead of `_ttsAudioInitialized` (missing underscore), throwing ReferenceError in strict mode. Fix: corrected variable name.
  - **`preload-playbook-sync` crash**: `preload.js` required this module without try/catch, crashing the entire preload in sandboxed contexts. Fix: wrapped in try/catch.
  - **Daily Brief bid JSON truncation**: Unified bidder used `maxTokens: 200` which was too tight for verbose agents -- LLM output got truncated mid-JSON causing "Unterminated string" parse errors. Fix: bumped to 300 and added `repairTruncatedJSON()` fallback that attempts brace-closing repair and regex extraction.
  - Cleaned stale Key Facts from user profile (36 stale entries including old meeting data, music state, wrong dates)
  - Files: `orb.html`, `lib/orb/orb-audio.js`, `lib/user-profile-store.js`, `packages/agents/smalltalk-agent.js`, `packages/agents/unified-bidder.js`, `preload.js`

- [x] **Voice Orb Stability: Debug Telemetry Cleanup** (v4.5.0)
  - Removed 41 leftover debug telemetry blocks across 14+ files that were POSTing to a non-existent `http://127.0.0.1:7242/ingest/` debug server every 5 seconds
  - Files cleaned: `orb.html`, `voice-listener.js`, `voice-speaker.js`, `realtime-speech.js`, `exchange-bridge.js`, `main.js`, `recorder.js`, `recorder.html`, `command-hud.html`, `setup-wizard.html`, `menu-data-manager.js`, `openai-adapter.js`, `master-orchestrator.js`, `search-agent.js`, `unified-bidder.js`
  - Also cleaned stale CSP entries from `detached-video-player.html`, `video-editor.html`
  - Fixed `preload.js` crashing when `preload-speech.js` fails to load in sandboxed contexts (wrapped in try/catch so other APIs survive)
  - These telemetry calls were generating constant CSP violation errors in the orb window and fetch errors in the main process, flooding the log server with false positives
  - 108 orb unit tests + 57 orb E2E tests + 12 corpus tests all passing

- [x] **Browsing API (Comet-class)** (v4.4.0)
  - Session-based browsing via native Electron BrowserWindow (hidden or HITL modes)
  - Anti-detection stealth module (`lib/browser-stealth.js`): user agent, plugins, permissions, WebGL fingerprint, Chrome runtime mocking
  - Error/block detection (`lib/browse-error-detector.js`): CAPTCHA, auth walls, bot blocks, paywalls, consent banners with auto-dismiss
  - Fast-path search (`lib/browse-fast-path.js`): DuckDuckGo API + parallel HTTP extraction with content caching
  - Declarative agent template system (`lib/browsing-agent-template.js`): site-specific recipes, LLM fallback, retry/backoff, output schemas
  - LLM-driven task runner (`lib/browsing-task-runner.js`): observe/think/act loop, checkpoint/resume, model escalation
  - Core API (`lib/browsing-api.js`): session lifecycle, navigation, content extraction, accessibility snapshots, actions, screenshots, parallel sessions
  - IPC bridge in `main.js` and `preload.js` (`window.browsing`)
  - Dedicated preload for HITL windows (`preload-browsing-api.js`)
  - **Phase 3: Exchange-registered browsing agent** (`packages/agents/browsing-agent.js`): meta-agent with 7 starter templates (weather, web search, page reader, news, GitHub, form filler, page monitor), auto-routed via LLM bidding
  - **Safety guardrails** (`lib/browse-safety.js`): domain blocklist (localhost, private IPs, cloud consoles), sensitive field detection (passwords, credit cards, SSN), action limits per session, session duration caps, custom blocklist/limits API
  - **Multi-step orchestration** (`lib/browse-orchestrator.js`): `research()` with source synthesis, `workflow()` with variable interpolation and step chaining, `comparePages()` with parallel extraction and LLM comparison
  - **Comet-style session inheritance**: `createSession({ inheritSession: 'auto|pool|tab|chrome', targetUrl })` inherits auth from app tabs, shared auth pool, or Chrome profile cookies
  - **Shared auth pool**: `saveToAuthPool()` persists login cookies to `persist:auth-pool-{domain}` partitions; auto-reused by future sessions targeting the same domain
  - **Chrome cookie import** (`lib/chrome-cookie-import.js`): reads and decrypts cookies from Chrome's SQLite database (macOS Keychain AES-128-CBC), injects into Electron partitions
  - **Tab partition discovery**: IPC round-trip (`main.js` <-> `browser-renderer.js`) to find open app tabs by domain for cookie inheritance
  - **Phase 4: Reliability gap closure** (v4.5.0)
    - **Vision fallback**: Task runner detects low-element snapshots (<3 refs), takes screenshot and uses `ai.vision()` for visual understanding; configurable via `useVision: 'auto'|'always'|'never'`, capped at 5 vision calls per task
    - **Dual-backend architecture** (`lib/browser-backend.js`): `ElectronBackend` (default) and `PlaywrightBackend` (real Chrome via Playwright) behind a common interface; `createSession({ backend: 'chrome' })` for sites with aggressive bot detection
    - **Site-specific stealth profiles** (`lib/stealth-profiles.js`): domain/header/HTML-based detection registry for Cloudflare, DataDome, PerimeterX, reCAPTCHA/hCaptcha/Turnstile; enhanced injection script with canvas noise, audio noise, WebRTC blocking, font enumeration limiting
    - **Parameterized stealth** (`lib/browser-stealth.js`): `buildEnhancedScript(patches)` and `applyProfile(webContents, patches)` for per-site stealth configuration
    - **Multi-site E2E validation** (`test/e2e/browsing-sites-validation.spec.js`): parameterized tests against Wikipedia, Hacker News, httpbin, JSONPlaceholder, example.com with snapshot/extract/screenshot assertions
    - 97 vision/backend/stealth unit tests (all passing), 2712 total unit tests passing
  - New files: `lib/browsing-api.js`, `lib/browser-stealth.js`, `lib/browse-error-detector.js`, `lib/browse-fast-path.js`, `lib/browsing-agent-template.js`, `lib/browsing-task-runner.js`, `lib/browse-safety.js`, `lib/browse-orchestrator.js`, `lib/chrome-cookie-import.js`, `lib/browser-backend.js`, `lib/stealth-profiles.js`, `preload-browsing-api.js`, `packages/agents/browsing-agent.js`

- [x] **WebMCP Bidirectional Integration** (v4.3.x)
  - W3C `navigator.modelContext` API support (Chrome 146 / Electron 41 beta)
  - **Consumer**: Bridge script injected into webview tabs intercepts `registerTool()` calls, discovers tools, creates proxy agents in the exchange
  - **Provider**: Spaces (list, search, create, add item), Search (web search), Navigation (open URL, current page), Settings (read) exposed as WebMCP tools on app pages
  - **Exchange integration**: Proxy agents register via WebSocket, participate in LLM-based bidding, route execution back through IPC to webview `executeJavaScript()`
  - **Lifecycle**: Tools discovered on `did-finish-load`, cleared on `did-navigate`, cleaned up on tab close
  - **UI**: Purple badge on tabs showing WebMCP tool count
  - New files: `webmcp-bridge.js`, `lib/webmcp-consumer.js`, `lib/webmcp-provider.js`
  - Modified: `browser-renderer.js`, `main.js`, `preload.js`, `exchange-bridge.js`, `package.json`, `tabbed-browser.html`, `clipboard-viewer.html`, `settings.html`
  - Electron upgraded from 39 (Chromium 142) to 41 beta (Chromium 146)

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

