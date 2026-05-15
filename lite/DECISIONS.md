# Onereach Lite -- Architecture Decision Records

This file is the authoritative log of architectural decisions made for Onereach Lite. New decisions append. Superseded decisions are marked, not deleted.

ADR format: ID, Date, Status, Context, Decision, Consequences, Supersedes / Superseded-by.

---

## ADR-001: Same-repo strangler over from-scratch rewrite

- **Date**: 2026-05-03
- **Status**: Accepted
- **Context**: The full app at `gsx-power-user` (~370K LOC, 856 JS files, 309 tests) is feature-rich but architecturally heavy. The user wanted to ship a stripped-down version they could debug, with features ported in weekly. The two main options were (a) a from-scratch rewrite in a new repo, or (b) a strangler/kernel pattern in the same repo that shares only `lib/`.
- **Decision**: Strangler pattern in the same repo. Lite lives at `lite/`. Both apps share `lib/`. Full continues hardening as the source of truth; lite is the launch trajectory.
- **Consequences**:
  - Zero setup tax compared to a new repo
  - "Pulling features from the full version" becomes a porting workflow, not a cross-repo dance
  - Discipline is required to prevent code from leaking between the two apps -- six-layer isolation enforces this
  - One commit history captures both apps' evolution

---

## ADR-002: Plain HTML + TypeScript renderer for kernel; Vue 3 deferred

- **Date**: 2026-05-03
- **Status**: Accepted
- **Context**: The strategic plan committed to Vue 3 for the lite renderer. The kernel has only two surfaces (placeholder window + bug-report modal), making full Vue + Vite tooling disproportionate.
- **Decision**: Kernel renderer is plain HTML + TypeScript bundled with esbuild. Vue 3 + Vite are introduced at the `shell-window-vue-tabs` port -- the first content-tab port that needs SFC tooling.
- **Consequences**:
  - Kernel ships with ~200 lines of TS instead of a Vue app skeleton
  - Build pipeline is simpler (esbuild, no Vue plugin, no SFC handling)
  - Renderer toolchain decision is preserved for the first content port to make
  - Migrating placeholder + modal to Vue at port time is trivial (small surface)

---

## ADR-003: `lib/` shared between apps; `packages/` not shared with lite

- **Date**: 2026-05-03
- **Status**: Accepted
- **Context**: Both apps need shared infrastructure. The full app has two reusable code locations: `lib/` (well-factored utilities like `ai-service.js` and `log-event-queue.js`) and `packages/` (large, deeply-app-coupled agent infrastructure). Lite needs the former; the latter is full-app-specific.
- **Decision**: `lib/` is shared infrastructure -- both apps import freely. `packages/` is forbidden to lite -- dep-cruiser blocks `lite/` -> `packages/` imports. If something in `packages/` should be shared, it gets promoted to `lib/` first as a deliberate act, full-app-verified, both CODEOWNERS sign off.
- **Consequences**:
  - Lite's import surface is tightly bounded
  - Promoting code from `packages/` to `lib/` is a known, documented pattern
  - Any port that needs `packages/` content cherry-picks (rewrite in TS within `lite/`, never import)

---

## ADR-004: Same creds, separate `userData`, separate ports

- **Date**: 2026-05-03
- **Status**: Accepted
- **Context**: Internal users will run lite alongside full. Lite must not corrupt full's local state, but should reuse the same cloud-backed credentials and keys to not require duplicate setup.
- **Decision**: Lite shares AI provider keys (keychain), OneReach SSO session (if technically possible), OmniGraph + Spaces cloud backend, macOS signing identity. Lite has separate Electron `userData` (`com.onereach.lite`), separate log/exchange/spaces ports, separate update channel, separate Windows signing identity, separate keychain entries for app-specific state.
- **Consequences**:
  - Lite cannot accidentally read or corrupt full's local files
  - Lite users see their cloud-stored content (Spaces, OmniGraph) without re-onboarding
  - Per-app AI cost accounting (ADR-009) is required so lite's API usage doesn't burn full's quota silently

---

## ADR-005: Single-writer-authoritative as conflict resolution default

- **Date**: 2026-05-03
- **Status**: Accepted (default; override decision required entering Phase 2)
- **Context**: Conflict resolution for graph-edge writes is a real engineering project. Last-write-wins silently destroys edges; CRDT is heavy. Phase 2 ports against a stable target need a committed default.
- **Decision**: Default conflict resolution is single-writer-authoritative with explicit conflict surfacing. The writer is the device with focus / most recent foreground; conflicts surface in UI rather than silently merging. CRDT becomes a Phase 3+ replacement of a documented mechanism, not a do-over.
- **Consequences**:
  - Phase 2 ports can write graph edges without re-architecture risk
  - Override decision required entering Phase 2 if a port needs CRDT semantics
  - Conflicts are visible to users rather than hidden

---

## ADR-006: SHA-pinning for `lib/` rollback

- **Date**: 2026-05-03
- **Status**: Accepted
- **Context**: Both apps share `lib/`, so a `lib/` change that breaks lite subtly (and only surfaces in pilot) would otherwise block both release trains. Need a way to ship lite against a pinned `lib/` while full evolves.
- **Decision**: Lite's release artifact records the SHA of `lib/` it was built against. Lite's CI checks out `lib/` at that pinned SHA when building lite releases. Before allowing a lite release, CI runs full's test suite against the lite-pinned `lib/` SHA -- a three-way check.
- **Consequences**:
  - Lite can ship against a stable `lib/` while full advances
  - Drift becomes explicit (visible in release artifact metadata)
  - Upgrade path: promote `lib/` to a workspace package with internal semver and have lite pin a version. Defer until pain is real.

---

## ADR-007: Kill-switch fail-open by default; grace window in Phase 3

- **Date**: 2026-05-03
- **Status**: Accepted
- **Context**: Phase 1 ships a kill-switch alongside auto-update. Fail-open vs fail-closed matters for blast radius.
- **Decision**: Phase 1 kill-switch fails open on unreachable endpoint (don't brick fleets on a DNS blip). Phase 3 hardens with a configurable grace window: default 72 hours since last successful fetch; past grace, fail-closed with a user-facing "connect to network" dialog. Configurable per-deployment by pilot customer.
- **Consequences**:
  - Phase 1 prioritizes availability over enforcement
  - Phase 3 closes the DoS-as-bypass vector
  - Pilot customers can override the grace window for their device fleet realities

---

## ADR-008: Mandatory default-on bug-reporter redaction

- **Date**: 2026-05-03
- **Status**: Accepted
- **Context**: Bug reports capture log lines that may contain secrets (API keys, tokens, env vars). A bug-reporter without redaction is a known leak vector; an opt-in toggle isn't enough because users will hit "include all" without thinking.
- **Decision**: Bug reporter runs a mandatory default-on redaction pass before the user sees the payload, regardless of any opt-in toggles. Patterns live in a versioned file (`lite/bug-report-redaction-patterns.ts`), audited at Phase 3 security review. Detected matches masked as `[REDACTED:KIND]` in preview. User can further redact the already-redacted payload.
- **Consequences**:
  - Cannot ship a "raw payload" version even if user opts in
  - Pattern updates require explicit code review (not config tweaks)
  - Telemetry on redaction counts is cohort-only, never per-user-attributable (re-identification via correlation prevented)

---

## ADR-009: Two-tier test data isolation (stub at PR, tenant at CI required)

- **Date**: 2026-05-03
- **Status**: Accepted
- **Context**: Lite integration tests need test data without touching production OmniGraph. A pure stub catches contract violations but misses semantic bugs; a real test tenant catches semantic bugs but is heavier and can be polluted.
- **Decision**: PR tier uses zod-schema-generated stub (hermetic, regenerated from contract every test run). CI required tier uses real test tenant in OmniGraph (sandboxed, cleans up after itself). Stub generator and runtime validator both derive from the same zod schema -- single source of truth drives all three artifacts (stub, validator, contract test).
- **Consequences**:
  - Schema cannot drift between stub and validator
  - PR tier stays fast; CI required tier catches real-world bugs
  - Production OmniGraph is never touched by tests

---

## ADR-010: Chunk failure recovery policy with no escape hatches

- **Date**: 2026-05-03
- **Status**: Accepted
- **Context**: Once chunk hardening contract is enforced (Phase 0b+), post-merge regression of any criterion needs a recovery policy. The pressure-to-ship moment will quietly degrade the contract if the policy isn't named.
- **Decision**: Criteria 1-4 regression blocks merges to main immediately. Criteria 5 and 6 regression blocks the next release tag with a one-PR-cycle grace window; past grace, the chunk is reverted, not shipped with debt. No "ship-with-debt-tracked-in-PORTING.md" option. PORTING.md auto-derives `status: regressed` from CI signal.
- **Consequences**:
  - The contract has no escape hatches
  - Phase 2 entry adds a release valve (regression-fix branch + time-boxed contract bypass with two CODEOWNERS sign-offs) for declared incidents -- but only for criteria 1-4 (5 and 6 already have grace windows)
  - Bypasses are audited in this DECISIONS.md file as structured incident entries

---

## ADR-011: Slim-kernel-first strategy

- **Date**: 2026-05-03
- **Status**: Accepted
- **Context**: User wanted lite to ship as the absolute minimum first, then add features one at a time. The strategic plan had a much fatter Phase 0a (Spaces, IDW, Tools, etc.).
- **Decision**: Phase 0a kernel ships with: an installable executable using full's icon, a single placeholder window, two top-level menus (Onereach.ai Lite with About + Quit; Help with Report a Bug), bug reporter writing to a local file. No tabs, no Vue, no AI, no Spaces, no IDWs. Menu builder is registry-driven from day 1 so future ports add menu entries without touching the builder.
- **Consequences**:
  - Phase 0a is structural plumbing, not feature-bearing
  - Each subsequent feature is its own hardened chunk under the contract
  - Bug reporter ships without a Spaces sink (writes to `userData/lite-bugs/` only); the cloud sink lights up automatically when Spaces ports

---

## ADR-012: Shared app icon with full

- **Date**: 2026-05-03
- **Status**: Accepted
- **Context**: A lite-specific icon would visually distinguish the two apps in the dock. But it's a designer task that would block kernel work, and the productName + window title are already distinct enough.
- **Decision**: Lite uses full's `assets/icon.icns`, `assets/tray-icon.png`, and `assets/icon.ico` directly. Visual differentiation comes from `productName` ("Onereach.ai Lite") and window title prefix during dogfooding.
- **Consequences**:
  - Slight visual confusion in dock during dogfooding (two same-icon apps)
  - One less Phase 0a todo
  - If a designer makes a lite-specific icon later, swapping is a one-line config change in `lite/electron-builder.json`

---

## ADR-013: Vue 3 deferred to first content-tab port

- **Date**: 2026-05-03
- **Status**: Accepted
- **Context**: ADR-002 chose plain HTML + TS for kernel. This ADR records the explicit deferral of Vue 3 introduction.
- **Decision**: Vue 3 + Vite are introduced at the `shell-window-vue-tabs` port -- the first port that adds tabbed content to the shell window. Kernel ships without any Vue dependency. esbuild bundles kernel TS; Vite (or another Vue-aware bundler) takes over at port time.
- **Consequences**:
  - Kernel `package.json` has no Vue dependency
  - First content port has additional bundler-migration work
  - Future ports build on Vue once introduced; kernel's HTML files stay vanilla

---

## ADR-014: Report a Bug placed in the app menu, not Help

- **Date**: 2026-05-03
- **Status**: **Superseded by ADR-016** (2026-05-03)
- **Context**: Initial kernel scope (ADR-011) had two top-level menus -- Onereach.ai Lite (About + Quit) and Help (Report a Bug). After the bug reporter shipped and was tested live, the Help menu had only one item, which felt like extra clicks for the most-used kernel action and added an unnecessary top-level entry to the menu bar.
- **Decision**: Report a Bug... moves into the Onereach.ai Lite app menu, between About and Quit (order 50). The Help top-level placeholder is no longer registered. Future ports that need Help (documentation links, feedback, etc.) can register `top:help` and add their items -- the menu builder's "no children -> no render" rule keeps the menu bar minimal until then.
- **Consequences**:
  - Kernel menu structure simplifies from 2 top-levels (5 entries total) to 1 top-level (4 entries total)
  - Cmd+Shift+/ accelerator is unchanged
  - The Playwright smoke test was updated to assert the new structure
  - Renamed registry id from `help:report-bug` to `app:report-bug` to match the new parent (registry ids are internal-only, not externally referenced)
- **Superseded by**: ADR-016 -- the user clarified the original instruction was "don't add Report a Bug to the apple menu," not "move it there." This ADR was generated by the agent rationalizing an action it had already taken, rather than recording a deliberate decision -- a misuse of the ADR pattern flagged in ADR-016.

---

## ADR-015: No keyboard shortcuts unless explicitly requested

- **Date**: 2026-05-03
- **Status**: Accepted (also captured as a top-level rule in `.cursorrules` "Keyboard Shortcuts")
- **Context**: The kernel originally bound `CmdOrCtrl+Shift+/` to Report a Bug and `CmdOrCtrl+Q` (via `role: 'quit'`'s default on macOS) to Quit. Discoverable shortcuts seemed friendly, but they were added on the agent's initiative -- not requested -- and once they exist they're hard to unbind muscle memory for.
- **Decision**: No keyboard shortcuts are bound by default in lite. This includes:
  - No `accelerator` on any registry entry
  - No `role:` on items where the role provides a platform-default accelerator (e.g. `role: 'quit'` on macOS auto-binds Cmd+Q). Items use `click:` handlers with explicit `label:` instead.
  - No renderer-side `keydown` / `keyup` handlers binding keys to actions (Esc, Cmd+Enter, etc.)
  - No `globalShortcut.register` calls
  - No HTML `accesskey` attributes
  - The user adds shortcuts by name when they want them. Discoverability comes from menu labels and visible buttons.
  - `top:app` keeps `role: 'appMenu'` because that role positions the menu correctly on macOS (no accelerator side effect).
- **Consequences**:
  - All three kernel menu items (About, Report a Bug, Quit) lose their previous accelerators
  - Quit menu item moved from `role: 'quit'` to `click: () => app.quit()` to suppress the role's default Cmd+Q on macOS
  - `SeedHandlers` gained an `onQuit` callback so `seed.ts` can wire quit without importing `electron.app` directly
  - Modal renderer's `keydown` handlers (Esc to close, Cmd+Enter to send) were removed; modal closes via the Cancel button only
  - The Playwright smoke test now asserts every item has `accelerator === null` and `role === null` -- this acts as a regression guard if a future port reintroduces a shortcut without the user asking
  - The "Keyboard Shortcuts" section of `.cursorrules` makes this rule project-wide for all future agent work, not lite-specific

---

## ADR-016: Help menu kept; Report a Bug stays as Help submenu (revert of ADR-014)

- **Date**: 2026-05-03
- **Status**: Accepted (supersedes ADR-014)
- **Context**: ADR-014 moved Report a Bug from Help into the app menu. Side effect: the Help top-level became childless and the menu builder's "no children -> no render" rule made the Help menu disappear from the menu bar entirely. The user noticed and clarified the original instruction was "don't put Report a Bug in the apple menu" -- a correction to a proposed move, not a directive to move it. ADR-014 was the agent rationalizing the move-and-side-effect after the fact.
- **Decision**:
  - Restore the original kernel menu structure: Onereach.ai Lite [About, Quit] + Help [Report a Bug].
  - The registry id reverts from `app:report-bug` back to `help:report-bug` (parent `top:help`).
  - All accelerator + role-on-item rules from ADR-015 still apply -- no shortcuts, no role-driven items, click handlers only.
  - Hold ADR-014 marked as Superseded rather than deleted, so the misstep is auditable.
- **Process lesson** (recorded so the agent doesn't repeat it):
  - When a user instruction's grammar is ambiguous ("remove report to apple menu item" was read as a directive to move; was actually a correction to not move), ASK for clarification rather than picking the most plausible parse and proceeding.
  - When an architectural rule (`no children -> no render`) silently changes user-visible state in response to a content change, that's a question, not a feature -- flag it and confirm before applying.
  - ADRs document deliberate decisions, not actions the agent took and then justified. ADR-014 was the latter and should not have been written.
- **Consequences**:
  - Menu structure returns to 2 top-levels, 3 items, all click-only with no accelerators.
  - Smoke test + unit tests + DECISIONS.md ADR-014 marked superseded -- changes applied in one batch.
  - The "no children -> no render" registry rule remains in place for genuine placeholders (`top:tools`, `top:idw`, etc. registered by future ports). It is not relaxed -- because the failure was an instruction-parsing mistake, not a rule problem. (If the rule itself proves problematic in future, that's a separate decision logged here.)

---

## ADR-017: Help menu uses label only, not `role: 'help'` (avoid Apple feedback injection)

- **Date**: 2026-05-03
- **Status**: Accepted
- **Context**: With `role: 'help'` set on `top:help`, macOS recognized the menu as the system Help menu (via Cocoa's NSHelpMenu) and auto-injected:
  1. A Search field (searches all menu labels in the app -- mildly useful)
  2. A "Send <AppName> Feedback to Apple..." item, which opens Apple's Feedback Assistant
- The Apple feedback item is added by macOS, not us. It's only visible to users enrolled in the Apple Developer Program, the Apple Beta Software Program, or AppleSeed for IT (so most enterprise users won't see it). When clicked, it routes the user's feedback to **Apple's database**, not to us. Per [Michael Tsai's blog (2015)](https://mjtsai.com/blog/2015/06/23/send-appname-feedback-sends-to-apple/) citing Brian Webster, third-party developers have repeatedly reported confused users who clicked this item thinking they were filing a bug to the app developer, and the developer never received it.
- We have our own working bug reporter (`help:report-bug` -> file in `userData/lite-bugs/`) sitting in the same Help menu. Having a sibling item that silently siphons user-perceived bug reports to Apple is exactly the failure mode Webster described.
- **Decision**: Drop `role: 'help'` from `top:help`. Use `label: 'Help'` only. The menu still renders ("Help" appears in the menu bar with our Report a Bug... item inside) but macOS doesn't recognize it as the system Help menu and doesn't inject anything.
- **Consequences**:
  - Lose the macOS Help-search affordance (most users don't know it exists; small loss)
  - "Send Onereach.ai Lite Feedback to Apple..." no longer appears for beta/developer users (the desired outcome)
  - Our own Report a Bug becomes the unambiguous feedback channel
  - Smoke test updated: previously asserted `topLevels[1]?.role === 'help'`; now asserts `topLevels[1]?.role === null` and `topLevels[1]?.label === 'Help'`
  - Unit test updated: previously asserted both top-levels kept their roles; now asserts only `top:app` has a role and `top:help` is label-only
  - macOS users who specifically want Help-search can still use the global `Help > Search` macOS feature for *other* apps -- this only affects our app

---

## ADR-018: Info.plist help-book keys to suppress macOS Help-menu auto-injection

- **Date**: 2026-05-03
- **Status**: Accepted (extends ADR-017)
- **Context**: ADR-017 removed `role: 'help'` from the `top:help` menu registration, expecting that to stop macOS from auto-adding the search field and "Send <AppName> Feedback to Apple..." item. Testing showed those still appeared in the Help menu even without the role. Cause: macOS Cocoa also detects help menus by title -- a top-level menu titled "Help" is recognized as the system Help menu regardless of role.
- **Decision**: The documented fix per [electron/electron#8431](https://github.com/electron/electron/issues/8431) is to add two keys to the app's Info.plist:
  - `CFBundleHelpBookFolder: "OnereachLite.help"`
  - `CFBundleHelpBookName: "com.onereach.lite.help"`
- These tell macOS the app brings its own help system, which suppresses the auto-injected default topics (search field + Apple feedback item). The values can point to a non-existent help book; macOS just needs them present.
- Added to `lite/electron-builder.json` under `mac.extendInfo` so the keys make it into the packaged app's Info.plist.
- **Consequences**:
  - **Packaged builds** (`npm run lite:package:mac`): the auto-injected items disappear. Help menu shows only what we register.
  - **Dev mode** (`npm run lite:dev`): the auto-injected items still appear. Reason: Electron's own bundle is what macOS sees in dev, and we don't modify Electron's Info.plist. This is acceptable because (a) dev mode is for developers, who already understand the tooling artifact, and (b) the kernel-smoke-test runs against the packaged build where the fix is in effect.
  - Comment in `seed.ts` references both ADR-017 and ADR-018 to make the dev-vs-packaged behavior visible to anyone reading the registration site.
  - We do NOT actually ship a help book -- the keys point to non-existent paths. Acceptable per the upstream Electron issue resolution.
- **Process lesson**: when a fix has dev-vs-packaged behavior that differs, document the dev-mode caveat at the registration site and in the ADR. Otherwise the next person to see the menu in dev will think the fix didn't take.

---

## ADR-019: Modular API pattern with public `api.ts` per module

- **Date**: 2026-05-03
- **Status**: Accepted
- **Context**: Lite needs a modular structure that scales as ports land without recreating the pain points the full app accumulated: 20+ preload scripts, an IPC channel registry that drifted from reality and turned into pure documentation, ad-hoc `global.X` cross-module wiring, and a 21k-line `main.js` that mixed lifecycle, IPC handlers, and module internals. At the same time, full got the parts that worked right -- per-module typed APIs, namespaced IPC verbs, singleton getters keyed on app-id -- and those should carry over.
- **Decision**: Every lite module exposes a public typed API via `<module>/api.ts`. Cross-module imports go through that interface only. The module's `main.ts`, `store.ts`, `kv-client.ts`, and any other internal files are not part of the public surface, even though TypeScript cannot truly hide them without a build-time barrel layer. Discipline is enforced by:
  1. The rule itself (Rule 11 in `LITE-RULES.md`).
  2. JSDoc `@internal` markers on internal classes (e.g. `BugReportStore`).
  3. dep-cruiser configuration (Phase 0b) that fails the build on cross-module reach-throughs.
- **Patterns adopted from full**:
  - **Per-module singletons** via `getFooApi()` -- keeps lifecycle simple, no DI container, no service locator. Works because we have one process and a small module count.
  - **Namespaced IPC channels**: `lite:<module>:<verb>` (e.g. `lite:bug-report:list`). Matches full's convention so the cognitive load of moving between codebases stays low.
  - **Public typed surface per module** with re-exported types from internal files. Callers see the interface, not the implementation class.
  - **Single preload script** (`lite/preload-lite.ts`) that namespaces each module under `window.<module>` (e.g. `window.bugReport`). One CSP, one IPC contract surface, one place to audit.
- **Patterns deliberately rejected**:
  - **Multiple preload scripts (one per module)**. Full's 12+ preload scripts caused real bugs (different CSPs in different windows, IPC bridge drift, hard-to-find regressions). Lite stays at one preload.
  - **IPC channel registry as documentation only**. Full had `lib/ipc-registry.js` that enumerated every channel name -- but new channels were added without registering, and the registry decoupled from reality. Until Phase 0b's `schema-first-ipc` chunk lands runtime validation against `<module>/contracts/`, channel names are checked at the call site only. No central registry that pretends to be authoritative.
  - **`global.X` cross-module references.** Every cross-module call goes through the public API.
  - **A service registry / DI container.** Adds value when lifecycle ordering, hot reload, or cross-module health checks become real -- not in 0a or 0b.
- **Canonical example**: `lite/bug-report/api.ts` exports `BugReportApi`, `getBugReportApi()`, `_resetBugReportApiForTesting()`, `_setBugReportApiForTesting(api)`. The implementation lazily instantiates `BugReportStore` (internal class). `lite/bug-report/main.ts` consumes the API via `getBugReportApi()` rather than instantiating the store directly.
- **Consequences**:
  - **Each port is structurally identical.** Adding a new module is "copy bug-report's shape, swap the verbs." Reduces decision fatigue and onboarding friction.
  - **Modules are isolated.** A change to `bug-report/store.ts` cannot break `settings/main.ts`, because `settings` only sees `bug-report/api.ts`. Refactors stay local.
  - **Implementation is swappable.** If we need a caching layer, an in-memory test variant, or an alternate cloud sink, only `api.ts` changes -- callers are unaffected.
  - **Test injection is uniform.** Every module exposes `_setFooApiForTesting()` and `_resetFooApiForTesting()`. Test setup looks the same across modules.
  - **dep-cruiser becomes the enforcement seam** in Phase 0b. The rule "no module imports `<peer>/store.ts`, `<peer>/main.ts`, etc." is one config block, applies to every module past, present, future.
- **Documentation**: The pattern, folder template, six rules, and starter `api.ts` template are recorded in [`PORTING.md`](PORTING.md) "Module Structure". Future ports reference that section.

---

## ADR-020: KV promoted to top-level lite module

- **Date**: 2026-05-03
- **Status**: Accepted (extends ADR-019)
- **Context**: The Edison key-value HTTP client (`EdisonKVClient`) was originally written as part of bug-report (`lite/bug-report/kv-client.ts`) because bug-report was the first KV consumer. But KV is a generic capability -- any future module needing remote key-value storage (settings sync, preferences, telemetry counters, cohort flags) would benefit from the same client, the same timeouts, the same error handling, and the same logger. Leaving KV inside bug-report would force every future consumer to either (a) reach into `bug-report/kv-client.ts` -- violating Rule 11 / ADR-019 -- or (b) duplicate the client in their own module.
- **Decision**: Extract KV into its own top-level lite module at `lite/kv/`, with `lite/kv/api.ts` as the public surface and `lite/kv/client.ts` as the (now-internal) `EdisonKVClient`. The bug-report module consumes KV via `getKVApi()` from `../kv/api.js`, exactly as any future module would. The KV module has no opinion on collection names or schemas -- those are the consumer's responsibility.
- **Public surface** (`lite/kv/api.ts`):
  - `KVApi` interface with `set`, `get`, `listKeys`, `list`, `delete` -- identical to the existing `EdisonKVClient` shape (no API redesign; pure relocation).
  - `getKVApi()` returns the lazily-instantiated singleton.
  - `_resetKVApiForTesting()` / `_setKVApiForTesting(api)` test seams (matches ADR-019).
  - Re-exports `KVError`, `KVRecord`, `KVConfig` so consumers don't need to know about `client.ts`.
- **Why now, not later**: KV will be needed by the next several ports (settings, preferences). Promoting it before those ports start avoids a bigger rename later. Cost is small (~60 lines of TS, one mechanical move) and the structural pattern is now uniform across modules.
- **Why flat, not scoped**: Considered a fluent `getKVApi().scope('lite-bugs').set(key, value)` shape. Rejected because (a) it doesn't simplify the existing call sites, (b) collections are typically static per consumer (bug-report only ever uses `lite-bugs`), and (c) flat matches the underlying HTTP API verbatim. Scoped builders can be added later as a non-breaking helper if call sites multiply.
- **What stays at the consumer**: Collection names. Bug-report's `KV_COLLECTION = 'lite-bugs'` lives in `bug-report/store.ts`, not in the KV module. The KV module is collection-agnostic. This keeps the rule of least knowledge at the seam: the KV module knows the protocol, the consumer knows its data.
- **Consequences**:
  - **Pattern uniformity**: bug-report and KV now share the same shape (`api.ts` + internal files + singleton getter + reset helper). Every future module copies that.
  - **Test layering**: `kv-client.test.ts` continues to drive the internal class directly (HTTP-contract tests, 20 tests). `kv-api.test.ts` is added at the public-singleton layer (4-6 tests). `bug-report-store.test.ts` injects a `FakeKV implements KVApi` -- it tests against the public interface, not the implementation class. Cleaner mock pattern (no `super()` hoops, no inheriting fields it doesn't need).
  - **Future consumers** (settings, preferences) consume KV via `getKVApi()` exactly the way bug-report does. No need for KV-specific infrastructure in each consumer.
  - **Reduced bug-report surface**: bug-report no longer owns the KV client. Easier to reason about; bug-report's responsibility is bug data, not transport.
  - **Stale documentation** (the original `kv-client.ts` header referenced "ADR-019" before the modular pattern ADR-019 existed) is fixed in the move.
- **Process lesson**: When a generic capability is built inside a specific consumer first, promoting it later is mechanical -- if the public API was already typed cleanly. Continue this pattern: keep new modules' surfaces typed via interfaces from day one so a future promotion is a relocation, not a rewrite.

---

## ADR-021: Lite ships from the same public repo as full, separated by channel + tag prefix

- **Date**: 2026-05-03
- **Status**: **Superseded by ADR-028** (2026-05-04) -- the same-repo plan didn't survive contact with electron-updater's GitHub provider, which uses GitHub's `releases/latest` endpoint and can only point at one release per repo. Live-test caught it (the running app saw full's `v4.8.0` instead of our lite release). See ADR-028 for the separate-repo replacement.
- **Context**: Lite needs to deliver auto-updates without forcing internal pilot users to manage GitHub tokens (which they would need if lite published to the private source repo). Full already publishes to a public distribution repo (`wilsr7000/Onereach_Desktop_App`) that anyone can read. The question is whether lite should (a) ship to its own public repo, (b) share full's repo with combined release tags, or (c) share full's repo on a separate channel and tag prefix.
- **Decision**: Option (c). Lite publishes to `wilsr7000/Onereach_Desktop_App` -- the same public repo as full -- but on a separate update channel (`latest-lite`) and a separate release-tag prefix (`lite-vX.Y.Z`). electron-updater's per-channel YAML resolution (`latest-mac.yml` for full, `latest-lite-mac.yml` for lite) keeps the artifacts cleanly separated within a single repository.
- **What this is NOT**:
  - Not combined releases. Each app gets its own tag (`vX.Y.Z` for full, `lite-vX.Y.Z` for lite). Independent release cadences -- lite can ship weekly without dragging full along.
  - Not a separate repo. Two repos would duplicate the GitHub release plumbing, splinter user-facing download URLs, and complicate the `gh` CLI scripting.
- **Mechanics**:
  - `lite/electron-builder.json`'s `publish.repo` is `Onereach_Desktop_App` (was the source repo before this ADR -- mistakenly).
  - `lite/electron-builder.json`'s `publish.channel` is `latest-lite`. electron-updater resolves this to `latest-lite-mac.yml` automatically.
  - **YAML filename is `<channel>-mac.yml`, NOT `<base>-<suffix>.yml`** -- electron-updater's `Provider.getCustomChannelName(channel)` appends `-mac` AFTER the channel name (see `node_modules/electron-updater/out/providers/Provider.js`). So channel `latest-lite` produces filename `latest-lite-mac.yml`. An earlier draft of this ADR had `latest-mac-lite.yml`, which 404s in production -- caught by the live update test (`test-update-live.mjs`) when the local server received `GET /latest-lite-mac.yml` instead of the expected name.
  - `lite/scripts/release-lite.sh` is the lite counterpart to `scripts/release-master.sh`. Same hand-rolled `latest-lite-mac.yml` with verified checksums (avoiding the electron-builder 26.x nested-signature bug), tagged `lite-vX.Y.Z`.
  - `RELEASES_URL` for lite's "Download Manually" button points to the same repo's releases page (`https://github.com/wilsr7000/Onereach_Desktop_App/releases`). Users land on a page listing both apps' tags -- distinguishable by the `lite-` prefix.
- **Distinguishing the two apps in the same repo**:
  - Tag prefix: `lite-v0.1.0` vs `v3.0.4`.
  - Asset filename prefix: `Onereach.ai Lite-...dmg` vs `Onereach.ai-...dmg`.
  - YAML filename: `latest-lite-mac.yml` vs `latest-mac.yml`.
  - Release title: includes the prefix, so the GitHub release listing reads naturally.
- **Coexistence with full**: distinct bundle IDs (`com.onereach.lite` vs `com.gsx.poweruser`), distinct `userData`, distinct ports -- so the two updaters never see each other's state. A user with both apps installed receives independent updates from the same repo via channel resolution.
- **Consequences**:
  - **Zero token friction for pilots.** Pilot users install lite from the public repo and receive updates without auth. Same convenience full has.
  - **Single release listing.** All Onereach.ai desktop releases (full + lite) are visible in one place. Discoverability across the two apps is improved.
  - **Independent cadences preserved.** Lite's much smaller surface area lets it iterate weekly during the strangler ports without coupling to full's release rhythm.
  - **One CI/CD surface to maintain.** Same `gh release create` pattern, same notarization creds, same checksum-regeneration script (mirrored, not shared).
  - **A future external pilot may want a dedicated repo** (clean URL, separate documentation, GitHub Discussions per app). Migrating from same-repo to dedicated-repo later is a config change in `lite/electron-builder.json` plus a one-time YAML republish at the new URL. Cost stays low.

---

## ADR-022: Auto-updater ported into lite at full parity

- **Date**: 2026-05-03
- **Status**: Accepted (consumes ADR-007 kill-switch as a future companion)
- **Context**: Lite needs to deliver auto-updates that match full's behavior so internal pilots don't experience surprise regressions in the update path. Three options were evaluated: (a) ship lite without auto-updater (manual download only), (b) port the minimum viable updater (init + check + download + install + cross-restart failure detection), or (c) port at full parity including rollback backups, bundle-writability pre-flight, and bounded state-save-before-quit.
- **Decision**: Option (c) -- full parity. Lite gets every behavior full has, ported as TypeScript-strict modules under `lite/updater/`. Each module borrows patterns (not imports) from a specific range in `main.js` or `rollback-manager.js` and is rewritten to lite's idioms.
- **Modules**:
  - `lite/updater/types.ts` -- shared shapes (UpdateState, UpdaterStatus, BackupRecord)
  - `lite/updater/init.ts` -- electron-updater config (autoDownload=false, autoInstallOnAppQuit=true, allowDowngrade=false). Borrowed from `main.js:360-370`.
  - `lite/updater/state.ts` -- `userData/update-state.json` read/write/clear. Borrowed from `main.js:16695-16723`.
  - `lite/updater/verify.ts` -- cross-restart install verification. Borrowed from `main.js:16725-16783`. Dialog copy preserved verbatim so users see consistent UX between full and lite.
  - `lite/updater/lifecycle.ts` -- electron-updater event handlers + dialogs. Borrowed from `main.js:16806-16988`.
  - `lite/updater/install.ts` -- bundle-writability pre-flight, save-state, force-destroy, quitAndInstall, 10s safety net. Borrowed from `main.js:17120-17302`.
  - `lite/updater/save-state.ts` -- bounded save with per-hook + total budgets (1.5s total, 500ms per hook). Borrowed from `main.js:17158-17223`. Lite's hook surface is currently empty -- placeholder for future ports (Spaces local cache, settings, etc.) to register their own.
  - `lite/updater/backups.ts` -- userData/app-backups/v<version>/, last 3 retained. Borrowed from `rollback-manager.js`. Lite's variant is structurally identical but slimmer because lite has minimal local state in Phase 0a -- the marker file alone is enough; future ports extend `createBackup()` to copy real state next to it.
  - `lite/updater/check.ts` -- 30s timeout, in-flight coalescing, auto vs manual branch. Borrowed from `main.js:17001-17063`.
  - `lite/updater/menu-wiring.ts` -- registers `Help -> Check for Updates...` (id `help:check-for-updates`, no accelerator per ADR-015).
  - `lite/updater/index.ts` -- orchestration: wires init -> backups -> check -> lifecycle -> install -> menu, exposes IPC handlers for `window.updater`.
- **Wiring touchpoints in `lite/main-lite.ts`**:
  - `verifyUpdateOnStartup()` runs after `app.whenReady` and BEFORE creating the placeholder window -- mirrors full's `main.js:1847`.
  - `initUpdater()` runs after `seedKernelMenu()` + `initMenu()` so `top:help` exists for the new child item to attach to.
  - `updaterHandle.teardown()` runs in `before-quit` for clean test re-launches and graceful shutdown.
- **Renderer surface** (`lite/preload-lite.ts`): `window.updater` exposes `check({ manual })`, `install()`, `getState()`, `onStatus(cb)` -- enough for a future placeholder banner / status pill in lite's main window.
- **What's deliberately NOT ported** (and why):
  - **Custom restore script generator** (`rollback-manager.js`'s `createRestoreScript`). Full's restore is a manual `.sh` the user runs to re-mark a previous version. Lite has no users for this yet -- if pilot feedback demands rollback UI, this gets ported as a follow-up chunk.
  - **Aider/agent-specific state-save hooks**. Full's `_saveStateBeforeUpdate` saves tabs, voice orb position, conversation history -- none of which lite has yet. Lite's `save-state.ts` is the same scaffolding with an empty hook list; ports register their own as they land.
  - **Help menu "Manage Backups" submenu**. Full exposes Open Backups Folder + View Available Backups in Help. Lite's kernel keeps the Help menu minimal (just Report a Bug + Check for Updates). Adds in a future Backups port if usage justifies it.
- **Coexistence with ADR-007 (kill-switch)**: both subsystems poll independently for now (updater every 6 hours, kill-switch's interval TBD in Phase 1). Both fail-open by default. When ADR-007 is operationalized, a follow-up ADR will decide whether to share a single periodic check task or keep them independent. No coupling in this ADR.
- **Consequences**:
  - **Pilot UX matches full's exactly.** Same dialogs, same buttons, same backup behavior, same failure-detection across restart. No surprise regressions for users moving between the two apps.
  - **Future ports inherit working save-state hooks for free.** A Spaces port that lands a local cache just calls `registerSaveHook({ id: 'spaces', run: ... })` -- the install path picks it up automatically.
  - **electron-updater is now a Phase 0a dependency** (was always a runtime dep of full, but lite's kernel didn't load it until this ADR). esbuild externalizes it in `lite/esbuild.config.mjs` so the bundle stays small.
  - **The 10s safety-net `process.exit(0)` is real**: lite's E2E updater scenarios need to allow ~12s for clean restart. Documented in the harness README.
  - **Bundle-writability pre-flight is macOS-only**. On Windows the install path delegates to NSIS which has its own permission handling.
- **Reference implementation**: every module in `lite/updater/` carries a header naming the borrowed file + line range, and the commit message that lands the port follows the cherry-pick discipline rule from `LITE-RULES.md`.

---

## ADR-023: General lite test harness as the standard for all port tests

- **Date**: 2026-05-03
- **Status**: Accepted
- **Context**: The kernel smoke test (`lite/test/e2e/kernel-smoke.spec.ts`) was the first E2E spec lite had. Adding the updater port would have meant a second spec with ~80 lines of repeated boilerplate -- launch the .app, wait for the log server, find the bug-report modal, parse the menu structure, etc. Without a shared harness this duplication would compound with every future port.
- **Decision**: Adopt `lite/test/harness/` as the reusable foundation for all lite tests. The harness has five modules: launch (boot/teardown of the built lite app, with optional isolated userData), menu (introspection + clicking), windows (find/wait by URL), log-server (HTTP client for `:47392`), userdata (snapshot bug reports / update-state / app-backups). A barrel re-exports them. Layered harnesses (e.g. `lite/test/harness/updater/`) extend the general one with port-specific scenarios.
- **Inspiration (not import)**: full's `test/e2e/helpers/electron-app.js` -- a 488-line module with launch/close, snapshot-errors, Spaces API helpers, Task Exchange health, AI cost monitoring, etc. Lite borrows the *shape* (typed launch handle, log-server snapshot, isolated userData) but stays narrow -- lite has no Spaces API, no Task Exchange, no AI calls in the kernel.
- **Refactoring proof-of-concept**: `lite/test/e2e/kernel-smoke.spec.ts` was rewritten to use the harness. Net change: removed `getBuiltExecutable` boilerplate, removed inline `app.evaluate` for menu parsing, removed inline `listJsonFiles` for bug-report state. The spec is now ~50% shorter and reads as test logic rather than test infrastructure.
- **What goes in the general harness vs a layered one**:
  - **General harness** = anything every lite port will need: launch, menu introspection, log-server queries, basic userData snapshots.
  - **Layered harness** (e.g. `updater/`) = scenarios specific to one port: local update server, fixture builders, dev-app-update.yml injection, composed flows like "boot vA, point at server, click Check, assert request landed".
  - The rule: if two ports would benefit from the same helper, it lives in the general harness.
- **Test layering**:
  - **Unit tests** (`lite/test/unit/`) -- pure logic, no Electron, mock the auto-updater interface. Run via `npm run lite:test:unit`.
  - **Integration tests** (`lite/test/integration/`) -- mock electron, exercise multi-module interactions like `initUpdater()` registering its menu + IPC. Run via `npm run lite:test:harness`.
  - **E2E tests** (`lite/test/e2e/`) -- launch the BUILT lite app via the harness, drive menus, assert observable state. Run via `npm run lite:test:e2e`. E2E updater specs live under `lite/test/e2e/updater/`; run them in isolation via `npm run lite:test:e2e:updater`.
- **Conventions every harness consumer follows**:
  - Always launch with an isolated `userDataDir` (the harness creates a tempdir if not supplied -- and cleans it on `closeLite()`).
  - Always pair `launchLite` with `closeLite` in `afterEach`/`afterAll` -- ownership of the tempdir is tracked by the handle.
  - Skip gracefully if no built lite app is present (`testInfo.skip(true, '...')`) so contributors who haven't run `lite:package:mac` aren't blocked.
  - Use `clickMenuItemById` over `clickMenuItem` (label-based) when the registry id exists -- ids are stable across copy changes.
- **Consequences**:
  - **Adding a new port is mechanical.** Copy bug-report's structure (per ADR-019), add a corresponding `lite/test/harness/<port>/` if the port has its own scenarios, layer scenarios on top of the general harness primitives.
  - **Boilerplate stays low.** A new spec is "launch handle + assert" rather than "launch handle + window discovery + menu parsing + assert".
  - **Harness changes are reviewed once, benefit everyone.** Improving `launchLite` (faster boot, better cleanup) lifts every spec automatically.
  - **The harness is excluded from coverage thresholds** (`lite/vitest.config.ts`). Coverage is tracked on real port code, not test infrastructure.
  - **A README at `lite/test/harness/README.md` documents the surface** with worked examples. Updater-specific scenarios get their own README at `lite/test/harness/updater/README.md`.
- **Future evolution**: as more ports land, expect the layered-harness folder count to grow (`harness/spaces/`, `harness/idw/`, etc.). The general harness should stay narrow -- if it starts accreting domain-specific helpers, that's a signal to lift them into a new layered folder.

---

## ADR-024: Test harness with enforced module conformance contract

- **Date**: 2026-05-03
- **Status**: Accepted (extends ADR-019, ADR-023)
- **Context**: ADR-019 established that every module exposes a public `api.ts` with `getFooApi()`, `_resetFooApiForTesting()`, and `_setFooApiForTesting()`. ADR-023 established the general E2E harness for booting the built lite app. As ports start to land in earnest, two new failure modes emerged that neither ADR addressed:
  1. **API shape drift**: module A's `api.ts` could quietly diverge from the convention (forget the singleton, lose `setForTesting`, drop a method) and nothing would catch it until consumers broke.
  2. **Module-without-tests escape**: nothing forced a new module to have contract tests at all. A 12-rule constitution is documentation; without enforcement, the rule erodes.
- **Decision**: Add a contract-enforcement layer to the harness:
  1. **`runApiConformanceContract`** -- a shared test suite every module's `api.ts` runs through. Asserts singleton identity, lazy init, reset semantics, `setForTesting` override, and that every method in `expectedMethods` is a function.
  2. **`runErrorConformanceContract`** -- a shared test suite every module-specific error class runs through. Asserts the class extends `LiteError`, codes follow `<MODULE_PREFIX>_<WHAT>` SCREAMING_SNAKE convention, instance fields populate, formatters (`formatForLog`, `formatForUser`, `toJSON`) work, context is frozen.
  3. **Meta-test** at `lite/test/unit/module-conformance.test.ts` that scans `lite/` for `<module>/api.ts` files and asserts each has a `lite/test/unit/<module>-api.test.ts` that calls `runApiConformanceContract`. **Adding a module without a contract test fails the build.** This is the load-bearing piece -- without it, Rule 12 is aspirational; with it, it's policy.
- **Tier model** (also recorded in `lite/test/HARNESS.md`):
  | Tier | Path | Speed | What it catches |
  |---|---|---|---|
  | Unit | `test/unit/` | <1ms/test | Pure logic, mocks |
  | Contract | filtered subset | <1ms/test | API shape conformance |
  | Integration | `test/integration/` | 50-150ms/test | Real HTTP wire format via `startInMemoryKVServer()` |
  | E2E | `test/e2e/` | 2-10s/test | Built signed app, real menu/IPC/window |
- **In-memory KV server**: a `node:http`-backed stub that speaks the OneReach Edison KV protocol (PUT/GET/POST/DELETE with the JSON-stringified `itemValue` wrapping). Lets integration tests drive the *real* `EdisonKVClient` against a real network without mocking `fetch`. Catches wire-format drift mocks miss (e.g. body-shape regressions, status-code-specific remediation logic).
- **What's deliberately NOT in scope**:
  - **Mutation testing**: not yet -- the codebase is too small to amortize the runtime.
  - **Performance benchmarks**: separate concern; conformance is correctness-only.
  - **Auto-generated API mocks**: `setForTesting()` accepting a hand-rolled stub is enough; generators add ceremony for marginal benefit.
  - **Snapshot tests**: too brittle for typed module APIs; the conformance contract + module-specific behavior tests are stricter and smaller.
  - **Full mock of every module's wire format**: KV gets the in-memory server because it's the cross-cutting backbone. Future modules with a network surface get one when needed; not preemptively.
- **Why enforcement, not voluntary**: a 12-rule list of conventions becomes 5 followed conventions and 7 ignored ones in 6 months. The meta-test is the difference between "we should do this" and "you can't merge without doing this."
- **Consequences**:
  - **Adding a new module is paint-by-numbers.** The HARNESS.md "5-step recipe" walks through the exact files to create. If you skip the contract test, CI fails with a specific message pointing at the missing file.
  - **Refactors are safer.** If someone changes `BugReportApi` and forgets to update `expectedMethods`, the contract test fails immediately rather than after consumers break.
  - **The contract is short and uniform.** New modules don't reinvent how to test a singleton; they import a function and pass a config. The cognitive load of "is my API shaped correctly" drops to zero.
  - **Integration tier catches what mocks miss.** The KV in-memory server proved its value during the round-trip test; a wire-format change in `EdisonKVClient` would now fail a contract test, not a customer's bug report.
  - **Coverage stays focused on real code.** The harness is excluded from the 80% coverage threshold (already in `lite/vitest.config.ts`). Coverage rigor goes on port code, not test infrastructure.
  - **The general harness keeps growing.** Layered scenarios (`harness/bug-report/`, `harness/updater/`) live in their own folders so the general harness stays narrow; if two modules want the same helper, lift it into the general harness (per ADR-023).
- **Tooling alignment**:
  - npm scripts: `lite:test:unit`, `lite:test:contract` (filtered to conformance describe blocks), `lite:test:integration`, `lite:test:e2e`, `lite:test:all` (everything except E2E, which needs a built signed app).
  - Vitest config already excludes `test/harness/**` from being picked up as test files (only `test/unit/**` and `test/integration/**` run).
- **Process lesson**: the meta-test pattern (one test that scans the codebase and asserts a structural rule) is general-purpose. If we ever want to enforce another structural rule (e.g. "every module has a README.md", "every IPC channel has a contract"), the same shape applies: glob the filesystem, assert presence, fail with an actionable message.

---

## ADR-025: Centralized event logger as a top-level lite module

- **Date**: 2026-05-04
- **Status**: Accepted (extends ADR-019, ADR-022, ADR-023, ADR-024)
- **Context**: After porting bug-report and KV through the modular pattern (ADR-019 + ADR-020), each module ended up with its own console-based default logger -- `[bug-report-store]` and `[kv]` lines went to `console.log`, NOT to the lite log queue at port 47392. That created a real blind spot: those events didn't appear in `/logs` HTTP, didn't show up on the WebSocket stream, and (most importantly) didn't get auto-captured into bug reports via `recentLogs`. The log server already existed and the lib `LogEventQueue` was already shared, but no module was wrapping that infrastructure as a typed API in the lite lineup. Modules ported in the future would inherit the same blind spot.
- **Decision**: Promote logging to a top-level lite module at `lite/logging/`, with `lite/logging/api.ts` as the public surface. The module wraps the existing lib `LogEventQueue` singleton (same one that drives port 47392), so events emitted via `getLoggingApi()` automatically show up in the log server output. Existing modules (`bug-report`, `kv`) migrate their `defaultConfig()` loggers to consume `getLoggingApi()` instead of `console.log`. Future modules consume the same API as their default observability path.
- **Scope**: logs + structured events + spans + in-process subscriptions + ring-buffer queries (`recent()`). The most comprehensive option from the planning round, deliberately chosen over "just logs" because:
  - **Spans** give cause-and-effect causality (`kv.set.start` -> `kv.set.finish` with durationMs and correlation id) that pure timestamped log lines cannot.
  - **Structured events** (`event()`, dotted names with category routing) let consumers branch programmatically rather than parsing prose.
  - **Subscriptions and `recent()`** let in-process consumers (the bug reporter, future health monitor) capture causal context without per-site instrumentation.
- **Patterns adopted**:
  - **Single API surface** (`LoggingApi`) covering all three concerns. Keeps the import surface small per Rule 11.
  - **Lib `LogEventQueue` as internal implementation**. The lite module wraps but does not re-implement; the queue is the shared infrastructure between full and lite (per ADR-003) and we preserve that.
  - **Events mirrored to the queue with structured `data: { eventName, spanId, durationMs, error }`**. So events appear in `/logs` and on the WebSocket without a parallel transport.
  - **Local ring buffer for `recent()`** separate from the lib queue's ring buffer. Holds only structured events (not console mirror entries) so `recent()` is fast and shape-predictable.
  - **Error serialization preserves `LiteError` structure** (code, message, remediation, context). Plain `Error` falls back to name+message. Serialization is a pure function in `events.ts`.
  - **Span idempotency** -- `finish()` after `finish()` is a no-op, so try/finally is safe.
- **Patterns deliberately rejected**:
  - **Renderer-side spans**: cross-IPC span lifecycle is a footgun (state lives in the main process; sending Span over IPC doesn't survive serialization without bookkeeping). Renderers emit paired instant events (`<name>.start` / `<name>.finish`) via the `event()` channel instead.
  - **Log shipping to a remote service**: keep observability local. The bug reporter is the path off-device for diagnostic data (per ADR-008's redaction discipline). Adding a separate shipping channel multiplies the attack surface.
  - **Durable persistence beyond the existing 10000-event lib ring buffer**: not warranted at kernel scale; the bug reporter already captures `recentLogs` for incident review.
  - **Automatic span instrumentation via decorators or proxies**: too clever, hurts debugging. Hand-roll spans where they matter; explicit is better than magic.
  - **Structured `recentEvents: EventRecord[]` field on the bug-report payload**: events already flow into `recentLogs` via the queue mirror, so a parallel structured array would be redundant. Adding it later is purely additive (just a schema version bump) if programmatic analysis needs it.
- **Migration**: bug-report's `defaultConfig().logger` and KV's `defaultConfig().logger` switched to `getLoggingApi()[level](category, message, data)`. Tests that inject their own logger via the constructor are unaffected. The migration is additive: the API surface (`logger?: (level, message, data) => void`) didn't change.
- **Renderer bridge**: `window.logging` extends with `event()`, `recent()`. New IPC channels: `lite:logging:event` (one-way send), `lite:logging:recent` (invoke). `start()` / `Span` stay main-process only.
- **Tier coverage**:
  - Unit (`test/unit/logging-api.test.ts`, `test/unit/logging-events.test.ts`): conformance contract + error conformance + behavior.
  - Integration (`test/integration/logging-flow.test.ts`): real LoggingStore + real BugReportStore + real EdisonKVClient against the in-memory KV server, proving the migration works end-to-end and spans correlate across module boundaries.
  - Harness mock: `test/harness/mocks/fake-logging.ts` -- `FakeLogging implements LoggingApi`. Used by future ports' tests.
- **Consequences**:
  - **Every event now has one place to look**: port 47392 / `/logs?category=<module>`. Bug reports automatically include them via `recentLogs`.
  - **Future ports get observability for free**: copy `defaultConfig() = { logger: (l, m, d) => getLoggingApi()[l]('<module>', m, d) }` and the module is wired in.
  - **Performance footprint is small**: one map lookup per log call (the queue dispatch), one array push to the ring buffer per event, one EventEmitter loop per event for subscribers. No allocations beyond the EventRecord itself.
  - **Spans force a discipline**: callers think "what am I instrumenting" and "what does failure look like" at the call site. Pays off the moment debugging gets non-trivial.
  - **The general harness gains a third primitive** (FakeLogging) alongside FakeKV and the in-memory KV server. Pattern is consistent; new modules' tests don't reinvent.
- **Process lesson**: when a piece of shared infrastructure exists in `lib/` but no module wraps it, every consumer either reaches into the lib directly or reinvents the wheel. The fix is the modular API pattern (ADR-019) applied to the infrastructure: even if it's "just" a wrapper, the typed API surface and the migration of existing consumers is what closes the gap. The wrapper itself is mechanical; the value is the discipline.

---

## ADR-026: Lite GSX sign-in v1 captures session cookies; user fills the OneReach form

- **Date**: 2026-05-04
- **Status**: Accepted
- **Context**: Lite needs the OneReach `mult` token to call OneReach APIs from future ports (Spaces, IDW, help-agent). The full app's `gsx-autologin.js` ports the entire auth ceremony into the kernel: form fill, TOTP, account picker auto-click, retry logic, rate limiting, status overlay. ~2000 LOC of fragile surface area that has to track every tweak OneReach makes to its auth UI. Lite v1 needs the token, not the ceremony.
- **Decision**: Lite v1 opens an Electron window pointed at GSX Edison (`https://studio.edison.onereach.ai`) and lets the user sign in themselves -- typing their email/password, completing 2FA in the real OneReach UI, picking their account from the OneReach picker. A session-cookie listener on the auth window's partition captures the `mult` and `or` cookies as OneReach sets them. Once both arrive AND a KV write succeeds, the window closes and `signIn()` resolves with an `AuthSession`. The token never crosses IPC -- it stays main-process only; future modules read it via `getAuthApi().getToken(env)`.
- **Scope (deliberately narrow for v1)**:
  - Edison only. The `Environment` type lists `edison | staging | dev | production` so call sites compile against the union, but `signIn()` rejects with `AUTH_UNSUPPORTED_ENV` for anything other than edison.
  - One account per env. Multi-account picker UI in Lite is a follow-up.
  - No keychain. Email is stored in the KV-backed session record so the placeholder can show "Signed in as alice@..." without a second prompt; password is never stored.
- **Borrowed patterns (studied, never imported)**:
  - `multi-tenant-store.js:387-469` -- session cookie listener pattern (`session.cookies.on('changed', ...)` + filter to `mult` / `or` + per-env storage)
  - `multi-tenant-store.js:81-87` -- safe OneReach domain validation (prevents subdomain attacks like `api.onereach.ai.attacker.com`)
  - `multi-tenant-store.js:573` -- environment extraction from cookie domain via regex
  - `gsx-autologin.js:1063-1120` -- per-account session partition shape (`persist:gsx-<env>-<accountId>` -> Lite uses `persist:lite-auth-<env>` since v1 is single-account-per-env)
- **Patterns deliberately rejected**:
  - **Auto-fill of email/password/TOTP** -- separate `lite/auth-autofill/` module if pilot users complain. Auto-fill makes us re-implement form detection, TOTP timing windows, retry/backoff, and React-form-fill quirks. The user typing is more reliable.
  - **Account-picker auto-click** -- the user clicks their account in the real OneReach UI. We watch the cookie jar afterward.
  - **Cross-partition token propagation** -- v1 has one partition per env (`persist:lite-auth-edison`); all consumers run from main and read via `getAuthApi().getToken('edison')`. The full app's per-tab partitions + propagation logic doesn't apply.
  - **Authorization header capture from network requests** -- the cookie value is the source of truth; intercepting headers is redundant and adds an attack surface.
  - **Renderer-visible token** -- `window.lite.auth` exposes `signIn`, `signOut`, `getSession`, `hasValidSession`, `onSessionChanged`. `getToken()` is intentionally NOT bridged. Consumer modules that need to call OneReach APIs do so from main and inject `Authorization` headers themselves.
  - **Menu entry** -- v1 ships only the placeholder button. The `app:sign-in` menu item is deferred to keep the kernel menu tidy.
- **Critical correctness items folded into the implementation**:
  - **Cookie domain matching is broad.** The `mult` cookie is set on `.edison.api.onereach.ai`, not `.edison.onereach.ai`. The store uses both suffixes plus the safe-domain validator from `multi-tenant-store.js:81-87`.
  - **Cookie listener attaches BEFORE the BrowserWindow is constructed.** Order is `attach -> createWindow -> loadURL` so we never miss a Set-Cookie that fires during the initial redirect.
  - **Existing-session probe.** On the auth window's first `did-finish-load`, the store calls `ses.cookies.get({ name: 'mult' })` and `ses.cookies.get({ name: 'or' })`. If both exist with valid expiry and the URL has left `auth.*`, treat as immediate capture (still gated on KV).
  - **KV failure closes the window and rejects.** No half-state -- either both cookies are persisted or `signIn()` rejects with `AUTH_KV_FAILED` and the placeholder shows the error inline.
  - **In-flight guard.** Concurrent `signIn(env)` calls coalesce on the same promise.
  - **Sign-in timeout.** `SIGN_IN_TIMEOUT_MS = 5 * 60_000`, configurable per call. Fires `AUTH_TIMEOUT` and closes the window.
  - **Navigation containment.** `will-navigate` and `setWindowOpenHandler` allow only `*.onereach.ai`; everything else routes to `shell.openExternal`.
  - **Token redaction guarantee.** Cookie values are never logged. Only `valueLength`, `domain`, `expirationDate`, `httpOnly`, `secure`, `sameSite`. A unit test captures all log output and asserts no token value substring.
- **Persistence shape**: KV collection `lite-auth-sessions`, key `${environment}:${accountId}`. The shape `{environment, accountId, email?, capturedAt, expiresAt?}` plus the raw `mult` token kept main-process-only in `Map<Environment, AuthSession>`. Multi-account becomes a natural extension later (different `accountId` -> different key).
- **Consequences**:
  - **~300 LOC** vs. the full app's ~2000 LOC for the equivalent capability.
  - **Robust to OneReach UI changes** -- we never read the form. Cookies are a stable contract.
  - **Token-stays-in-main** is a real security boundary, testable in isolation. Renderers only see metadata.
  - **First sign-in requires typing.** Auto-fill is a follow-up if pilot users push back.
  - **Single-account per env in v1.** Switch by signing out and back in.
- **Process lesson**: when the goal is a token, not a UX, watching the cookie jar beats automating the form. Let OneReach own the auth ceremony; we only care about the artifact it leaves behind.
- **2026-05-04 amendment -- token reveal in Settings**:
  - The original "renderer-visible token" rejection was about not bridging tokens generally (no `getToken` on the preload). Pilot users want to verify, in-app, that both `mult` and `or` were captured -- and to copy individual cookie values when they're hand-debugging an Edison API call from a terminal. Loading the underlying KV record in a SQLite browser to inspect this was the workaround; that's bad UX and also not fully informative because the `mult` token is never persisted.
  - **Decision**: add `getTokenBundle(env): AuthTokenBundle | null` to `AuthApi` and bridge it as `window.lite.auth.getTokenBundle(env)`. The Settings → Account section consumes it, displays both raw values inline with a per-token Copy button, and labels them with length + per-cookie expiration. After a restart the bundle is null until the next sign-in; the UI states this explicitly.
  - **Constraints unchanged**:
    - Tokens are still **not persisted** -- they live only in `AuthStore.tokenBundles` (in-memory `Map<Environment, AuthTokenBundle>`).
    - Tokens are still **never logged** -- the existing redaction tests in `auth-store.test.ts` catch the `mult` value; the second redaction test catches the raw `or` value.
    - Tokens are still **cleared on sign-out**.
  - **Patterns deliberately rejected (this amendment)**:
    - Per-window IPC scoping (only Settings can call `getTokenBundle`). Lite's single shared preload makes this awkward; the user explicitly chose the simpler "any renderer can call it" surface. Future ports that ship to wider audiences can revisit if needed.
    - Default-masked display with a Show toggle. The user wanted the value visible immediately for copy/debug; masking adds friction for the actual use case.
  - **Consequences**:
    - The Settings → Account UI now answers "did the token capture work?" without leaving the app.
    - The token-stays-in-main boundary becomes "tokens stay in main except when an explicit Settings-driven IPC asks for them." A new bridge call is the only path; opportunistic leaks (logs, KV, headers) remain blocked.
    - Renderer code still cannot call `getToken(env)` -- only `getTokenBundle(env)`. The two methods are kept distinct so main-side consumers (future ports calling OneReach APIs) don't pay the bundle-construction cost on the hot read path.

---

## ADR-027: Lite TOTP authenticator widget; auto-fill remains deferred

- **Date**: 2026-05-04
- **Status**: Accepted (extends ADR-026)
- **Context**: ADR-026 established that the user fills the OneReach form themselves during sign-in. That works for email/password but the OneReach 2FA prompt requires a 6-digit TOTP code that the user typically reads off their phone. Pilot users want a "code-here" affordance inside lite so they don't have to grab their phone every sign-in. The full app already solves this with a built-in authenticator (TOTP secret stored in keychain + live code display in Settings + auto-fill into the OneReach form via `gsx-autologin.js`).
- **Decision**: Lite v1 ships a TOTP authenticator widget — a small Electron window opened from `Tools -> Authenticator...` that displays the live 6-digit code with a 30-second countdown, like Google Authenticator. The user copies the code into the OneReach 2FA prompt themselves. **NO auto-fill of the OneReach form.** Auto-fill remains deferred as `auth-autofill` in `lite/PORTING.md`.
- **What this decision is NOT**:
  - Not a deviation from ADR-026 -- the OneReach form is still filled by the user. The authenticator just removes the trip to the phone.
  - Not a Settings window (the `settings-window` chunk in the deferred queue stays where it is). The TOTP UI lives in its own dedicated window that future Settings can later embed by calling `getTotpApi()`.
  - Not "Lite does 2FA" -- this is OneReach's TOTP, displayed by lite. Lite has no auth boundary of its own.
- **Patterns adopted**:
  - **New top-level module** `lite/totp/` with the canonical shape (api.ts / store.ts / main.ts / window.ts / types.ts plus the renderer assets) per ADR-019.
  - **Pure code generation in `manager.ts`**, separated from keychain storage in `store.ts`. Lets unit tests exercise TOTP math without keytar mocks.
  - **Keychain via `keytar`** (already in `package.json`, already externalized in esbuild). Initial service name was `OneReach.ai-Lite-TOTP`, but post-implementation UX review changed this to the full app's canonical `OneReach.ai-TOTP` / `onereach-unified-login` so existing OneReach 2FA setup immediately generates codes in Lite. The old Lite-only keychain entry remains a read/delete fallback for users who saved during the spike.
  - **First Tools menu entry**. Adds the `top:tools` placeholder per `lite/PORTING.md` "Menu Entry Registration Template". Future tool ports register alongside.
  - **Authenticator window opens as a small auxiliary window** parented to the placeholder window (like the bug-report modal), modeled directly on `lite/bug-report/main.ts`'s window factory.
  - **Three setup paths**: QR scan from screen (`desktopCapturer` + `jsqr`), QR from clipboard image, manual Base32 entry. All three normalize to the same secret-save flow.
- **Patterns deliberately rejected**:
  - **Auto-fill into the OneReach form**. Tracked separately as `auth-autofill` in `lite/PORTING.md` deferred queue. The detection + form-fill machinery in `gsx-autologin.js` (~600 LOC of React-aware DOM probing, retry, account-picker autoclick) is exactly what ADR-026 deliberately did NOT port. Adding it later requires preload + frame access in the auth window -- a separate architectural decision.
  - **Strictly separate Lite-only TOTP keychain**. Rejected after UX review: the point of this feature is to create the GSX / OneReach code from the user's existing authenticator setup, just like the full app. Sharing the canonical full-app TOTP keychain entry is the least surprising behavior.
  - **Renderer-visible secret over IPC**. Manual entry necessarily crosses IPC (the user types it in the renderer), but the saved secret is never round-tripped back. The QR-scan + clipboard-scan paths save the secret in main directly; the renderer only sees `{success, issuer, account}` -- never the secret bytes.
  - **Rendering the secret as text anywhere except the manual-entry input during typing**. The "configured" state shows only the live code + countdown, never the secret.
  - **Embedding the TOTP UI in the placeholder window**. Crowds the launch screen and conflates "kernel features" with "auth tools." Dedicated window + menu entry is cleaner and embeddable into Settings later.
- **Observability + redaction guarantee** (extends the ADR-026 redaction discipline):
  - The TOTP secret is NEVER logged. Only metadata (length in characters, presence boolean, key-rotation timestamp). Enforced by a unit test that captures all log output and asserts no captured secret substring.
  - The current code IS logged (it's ephemeral, 30s lifetime, low blast radius), with the same `[totp]` category routing through `lite/logging/`.
  - QR-scan results log only `{found: boolean, issuer, account, secretLength}` -- never the otpauth URI or secret value.
- **Consequences**:
  - **~250 LOC** for the module proper, ~150 LOC for the renderer + HTML/CSS, ~150 LOC for tests. Far smaller than auto-fill would be (~600+ LOC for form detection + retry alone).
  - **Pilot users get the convenience without lite owning the auth ceremony**. If OneReach changes their 2FA UI, our authenticator keeps working (we don't read the form).
  - **First Tools menu lands**. The `top:tools` placeholder is now wired; future tool ports inherit the menu strategy without re-deciding.
  - **Auto-fill is strictly additive**. When `auth-autofill` lands later, it depends on `lite/totp/` already being there -- the TOTP module doesn't change.
  - **Cost**: user has to set up TOTP once in lite even if they already did in full. Documented as deliberate.
  - **Cost**: user still types the code into the OneReach form. We optimized for "no phone needed," not "no typing needed." Auto-fill closes that loop later if pilots want it.
- **Borrowed patterns** (studied, not imported):
  - `lib/totp-manager.js` -- TOTP generate/verify/parse-otpauth-URI shape (rewritten in TS-strict around `otplib`)
  - `lib/qr-scanner.js` -- `desktopCapturer` + `jsqr` + BGRA->RGBA conversion (rewritten in TS-strict)
  - `credential-manager.js:512-572` -- TOTP keychain save/get/delete via `keytar` (rewritten in TS-strict, narrower surface, separate service name)
  - `settings.html:943-1026` -- the live-code + countdown UI shape (rewritten in TS, no jQuery)
- **Process lesson**: when porting a feature that's currently entangled with another (TOTP is wired into auto-login in the full app), separate the data layer (TOTP code generation + keychain) from the use-site (auto-fill). The data layer is independently useful (authenticator widget); the use-site comes later as additive scope. This is the same shape as ADR-020 promoting KV out of bug-report.

---

## ADR-028: Lite ships from its own dedicated public repo (supersedes ADR-021)

- **Date**: 2026-05-04
- **Status**: Accepted (supersedes ADR-021)
- **Context**: ADR-021 chose to publish lite to full's existing public repo (`wilsr7000/Onereach_Desktop_App`) using a separate update channel (`latest-lite`) to differentiate. The reasoning was "one CI surface, one user-facing release listing, no second repo to maintain." Live-test caught a fundamental incompatibility with that plan: **electron-updater's `GitHubProvider` calls GitHub's `releases/latest` endpoint to find the release**, then looks for the channel YAML inside that release. GitHub's `releases/latest` returns whichever release is marked Latest -- only ONE release per repo can hold that flag. So when lite+full live in the same repo:
  - If full's tag is Latest, lite's updater 404s on `latest-lite-mac.yml` (it's looking inside full's release, where the file doesn't exist)
  - If lite's tag is Latest, full's updater would similarly 404 on `latest-mac.yml` AND lite-v* shows up as the "Latest" download for casual repo visitors expecting full
  - The two apps are mutually exclusive at the "which release is Latest" level
- **What we tried first**: marked lite-v99.0.0 as `--prerelease=false --latest` to make it GitHub's Latest. Test passed. But then full's auto-update would have broken for any user, and the public release listing showed lite as the headline release. Cleanly impossible to coexist.
- **Decision**: Lite gets its own public distribution repo: **`wilsr7000/Onereach_Lite_Desktop_App`**. The naming mirrors full's `wilsr7000/Onereach_Desktop_App` so the parallel structure is obvious. Each repo's "Latest" is per-app; the two updaters never see each other's releases. The shared-channel YAML naming complexity from ADR-021 disappears: lite uses the default `latest` channel and the standard `latest-mac.yml` filename.
- **Mechanics**:
  - `lite/electron-builder.json`'s `publish.repo` is `Onereach_Lite_Desktop_App` (was `Onereach_Desktop_App` per the now-superseded ADR-021).
  - `lite/electron-builder.json`'s `publish.channel` is **removed** (defaults to `latest`).
  - `lite/scripts/release-lite.sh`'s `PUBLIC_REPO` is `wilsr7000/Onereach_Lite_Desktop_App` and `LITE_YAML` is `latest-mac.yml`.
  - `lite/updater/index.ts`'s `RELEASES_URL` points at the new repo's releases page.
  - The release tag prefix `lite-vX.Y.Z` is preserved -- it doesn't conflict with anything since this repo only holds lite tags. We keep the prefix so every tag everywhere in any repo identifies the app at a glance.
  - The harness (`lite/test/harness/updater/`) drops the `latest-lite` channel default; tests use the default `latest`.
- **Cost we accepted**:
  - **Two public repos to maintain.** In practice: one extra `gh repo create`, one extra README. Negligible.
  - **Discoverability split.** Users find lite at `Onereach_Lite_Desktop_App`, full at `Onereach_Desktop_App`. Each repo's README cross-links to the other. A future `onereach.ai/downloads` page would consolidate.
  - **No "single CI/CD surface".** That benefit from ADR-021 was illusory anyway -- the release scripts are already separate (`release-master.sh` for full, `release-lite.sh` for lite).
- **Coexistence with full** (the original requirement): both apps run side-by-side, install side-by-side, auto-update independently, never collide. Distinct bundle IDs, userData, ports remain unchanged. The only thing that changed vs ADR-021 is the public download URL.
- **Process lesson**: live-test the integration end-to-end before declaring an ADR done. ADR-021 read plausible because the channel feature exists in electron-updater -- but the feature interacts with GitHub's release-selection logic in a way that the docs don't surface. The local-server test passed because it bypassed the GitHub provider; the GitHub test is what caught the bug. Future ADRs that involve a third-party SDK should include a "smoke test: end-to-end with the real provider" step before being marked Accepted.
- **Migration cost from ADR-021**: trivial in this case because no public lite-v* releases existed yet. If we'd shipped lite-v0.1.0 via ADR-021's scheme and pilot users had it installed, migrating would have required: (a) a one-time YAML republish at the new repo, (b) a forced manual update for existing users, OR (c) a transitional release at both URLs. Caught it before that pain.

---

## ADR-029: Signing/notarization deferred to pre-launch -- ship "broken-but-functional" same as full app

- **Date**: 2026-05-04
- **Status**: Accepted (deferred work tracked in `lite/SIGNING-SPIKE.md` + `lite/LITE-PUNCH-LIST.md` Critical/Blocking)
- **Context**: The SIGNING-SPIKE documented an electron-builder 26.x + Electron 41.x signing-order bug that produces bundles failing `codesign --verify --deep --strict` ("nested code is modified or invalid"). We attempted Path C (custom `afterPack` re-sign script in inner-first dependency order). The script works mechanically -- signs all 8 nested items + the outer .app -- but the resulting signature still has `TeamIdentifier=not set` because the underlying issue is in `@electron/osx-sign` / codesign chain validation, NOT just signing order. Production full app (`/Applications/Onereach.ai.app`) ships with the EXACT same broken signature today and auto-updates work for users.
- **Three asks were on the table**:
  1. Make the build succeed and produce a usable .app -- **DONE** via `strictVerify: false` + the existing electron-builder signing pass (no resign needed for "good enough")
  2. Make `codesign --verify --deep --strict` pass -- not done (upstream bug, partial fix attempted, not productive to pursue further before more important work)
  3. Make notarization succeed -- not done (requires #2)
- **Decision**: For testing and early distribution, ship lite with the same broken-but-functional signature full ships with today:
  - macOS shows a one-time "App can't be opened because Apple cannot check it for malicious software" warning on first install -- user right-clicks → Open to bypass
  - All subsequent launches and auto-updates work without prompts (Squirrel.Mac uses laxer verification at install-time than `--strict` requires)
  - This is exactly what full app users experience today; lite gives them the same UX, no worse
- **What we built and kept anyway** (so the eventual fix is fast to land):
  - `scripts/resign-deep.js` -- the inner-first re-sign module. **Opt-in via `RESIGN=1` env var**, default OFF. Currently produces no improvement (TeamIdentifier still missing), but the framework is in place for the eventual proper fix.
  - `scripts/notarize.js` -- updated to call resign-deep optionally before notarization. Has SKIP_RESIGN, SKIP_NOTARIZE escape hatches.
  - `lite/electron-builder.json` -- `strictVerify: false` + `notarize: false` (matches full's current production config)
- **What's required before public launch** (tracked in `LITE-PUNCH-LIST.md` Critical/Blocking):
  - Resolve the TeamIdentifier issue -- options: (a) explicit `--requirements` pinning to standard Apple-anchor DR pattern, (b) explicit cert via SHA1 hash via `--keychain`, (c) wait for upstream `@electron/osx-sign` fix, (d) bypass osx-sign entirely with manual codesign+notarize via separate script. None tried yet.
  - Once `codesign --verify --deep --strict` passes, flip `notarize: true` in electron-builder.json
  - Run a real notarization round-trip (`xcrun notarytool submit`) and confirm Apple accepts the bundle
  - Verify with `spctl --assess` that Gatekeeper passes the assessed bundle without prompts
- **Why defer**: signing fix is upstream-blocked, has no user-impact today (full ships with same state), and consumes time better spent on lite features. The `RESIGN=1` opt-in keeps the work visible without making it the default.
- **Why this is OK for "early distribution"**:
  - Internal pilot users are technical enough to right-click → Open one time
  - Auto-update works (proven end-to-end against the new dedicated repo per ADR-028)
  - The public README at `wilsr7000/Onereach_Lite_Desktop_App` documents the bypass step
  - No worse than full app today
- **Why this is NOT OK for general public launch**:
  - "App is damaged" warnings damage trust at first impression
  - macOS may not persist mic/camera permissions properly (full app has known TCC issues from this)
  - Apple may eventually block unsigned/improperly-signed apps entirely (Sequoia hardened the rules)

---

## ADR-030: Universal event instrumentation across lite modules

- **Date**: 2026-05-04
- **Status**: Accepted (extends ADR-019, ADR-024, ADR-025)
- **Context**: ADR-025 promoted the centralized event logger as a top-level module with `event()` / `start()` / `Span` / `recent()` APIs. After that round, every module's log lines flowed through `getLoggingApi()`, but the **`event()` and `start()` halves of the API had zero production callers**. Module operations emitted log lines (`store: kv save ok`) but no structured spans, IPC handlers didn't log their invocation, lifecycle hooks (window-all-closed, before-quit, second-instance, BrowserWindow ready/closed) were silent, menu clicks weren't observable, and 8 catch blocks still used `console.error`. The events tier of ADR-025 was infrastructure with no users.
- **Decision**: Instrument every meaningful operation in lite to emit structured events through `getLoggingApi()`. Three classes:
  1. **Spans on async module operations**: every method that does network or persistence work wraps in `<module>.<op>.start` / `.finish` / `.fail` via a `spanEmitter` callback on the module's config (`KVConfig.spanEmitter`, `StoreConfig.spanEmitter`, etc.). Default config in each `api.ts` wires the callback to `getLoggingApi().start()`. Tests can pass a stub or omit (silent fallback).
  2. **Instant events on IPC entry, lifecycle, and sync ops**: `<module>.ipc.<verb>` for every IPC handler invocation; `app.boot.start/finish/fail` span; `app.window-all-closed`, `app.before-quit`, `app.second-instance`, `window.<name>.ready-to-show`, `window.<name>.closed`, `menu.click`, `menu.click.failed`, `auth.session.read`. Sync ops emit instant `event()` not spans (no duration to track).
  3. **Console.* migration**: 8 `console.error` / `console.warn` calls in catch blocks (main-lite.ts, menu/build-menu.ts, updater/state.ts) replaced with `getLoggingApi().error()` / `.warn()`. The boot banner and pre-queue boot guard stay on raw console (executed before `getLoggingApi()` can resolve).
- **Naming convention** (locked in):
  - **Operation spans**: `<module>.<methodName>` (camelCase preserves the API method name; `kv.set`, `auth.signIn`, `bug-report.update`).
  - **Instant events**: `<module>.<noun>` or `<module>.<noun>.<state>` (`menu.click`, `auth.session.read`, `app.window-all-closed`).
  - **IPC handlers**: `<module>.ipc.<verb>` (verb taken from the IPC channel name, hyphenated for multi-word: `auth.ipc.has-valid-session`).
  - **Lifecycle**: `app.<event>` and `window.<name>.<event>`.
- **Span semantics**:
  - `.start` is mandatory; `.finish` OR `.fail` (never both).
  - `data.spanId` correlates `.start` to its `.finish` / `.fail` so consumers can stitch traces.
  - `data.durationMs` on `.finish` and `.fail` is computed in `Span.finish()` / `Span.fail()` (no per-call duration tracking at the call site).
  - `Span.fail(err)` serializes `err` via `serializeError` -- if `err instanceof LiteError`, fields surface as `error: { code, message, remediation, context }`; plain `Error` becomes `error: { code: 'UNKNOWN', message }`.
  - Idempotent: a span can `.finish()` then `.fail()` (or vice versa) without crashing or double-emitting.
- **Coalesce semantics** (auth-specific, generalizable):
  - `auth.signIn` is concurrent-call-coalesced. Only the first caller's span fires; subsequent callers emit `auth.signIn.coalesced` events so the coalescing is observable but doesn't double-count durations.
- **Error-path semantics** (bug-report-specific):
  - `list()` and `delete()` are soft-fail (return result objects, never throw). Their spans STILL emit `.fail` if the underlying KV op rejects -- so failures are observable even though the consumer doesn't see a thrown error.
  - `read()` and `save()` are hard-fail (throw `BugReportError`). Span behavior matches the throw.
- **What's exempt** (deliberate):
  - **Boot banner** and **pre-queue boot guard** in main-lite.ts: execute before `getLoggingApi()` can resolve the lib queue. Stay on raw console.
  - **Build/CLI scripts** (`esbuild.config.mjs`, `lite/scripts/*.mjs`): tooling output, not the running app.
  - **Logging IPC channels** (`lite:logging:enqueue`, `lite:logging:event`, `lite:logging:recent`): the work each handler performs IS the event log. Adding `logging.ipc.<verb>` events would double the queue volume without diagnostic value, and risks subtle recursion if the logging module ever logs at debug level inside `event()`.
  - **`getToken()` and `hasValidSession()`** (auth, sync, main-only): called frequently, pure reads. No observability requirement.
  - **`updater/check.ts`'s `coalesce path`** (already returning the in-flight promise): no second span emission per ADR's coalesce rule.
- **Patterns deliberately rejected**:
  - **Auto-instrumentation via decorators or proxy magic**: too clever, hurts debugging. Hand-roll spans where they matter; explicit is better than magic.
  - **Distributed tracing / OpenTelemetry shape**: spans are local-only correlation, not cross-process. Adding W3C trace-id format adds ceremony for marginal benefit at this scale.
  - **Renderer-side spans**: cross-IPC span lifecycle is a footgun (state lives in main; sending Span over IPC requires bookkeeping). Renderers emit paired instant events via `window.logging.event('foo.start')` / `event('foo.finish')` instead.
  - **Per-call duration logging at the call site**: `Span.finish()` computes `durationMs` from the `.start` timestamp. Callers don't measure.
  - **A registry of valid event names**: would require coordination across modules and create a coupling layer. Convention + tests are enough; if drift becomes a problem, add a regex-based meta-test.
- **Test strategy**:
  - **Integration coverage**: `lite/test/integration/event-coverage.test.ts` -- one test per instrumented op, asserts `<op>.start` and `<op>.finish` (or `.fail`) appear, share a `spanId`, and the finish has a numeric `durationMs`. Catches "we forgot to instrument X".
  - **Cross-module tracing**: tests that nesting works (`bug-report.save.start` precedes inner `kv.set.start` in the queue order, all spanIds are unique).
  - **Harness helpers**: `expectEvent(client, pattern)`, `expectSpan(client, name)`, `expectSpanFail(client, name)` for ergonomic assertion in any test.
- **Migration impact**: existing modules' tests are unaffected (they inject their own loggers / spanEmitters or omit them entirely). Public API surfaces gain optional `spanEmitter` / `eventEmitter` config fields; no breaks.
- **Consequences**:
  - **Every operation in the app becomes traceable end-to-end** with durations and correlation IDs. Bug reports automatically capture this trace via `recentLogs`.
  - **Future ports get observability for free**: copy the `defaultConfig() = { logger, spanEmitter }` pattern and the new module is wired in.
  - **The "what just happened?" question is answerable from `/logs?category=<module>` or `getLoggingApi().recent('<module>.*')`** without per-site instrumentation work.
  - **Performance footprint is small**: each span = 2 queue writes + ring buffer push + EventEmitter dispatch. Negligible at kernel scale.
  - **Bundle size grew ~5KB** (the spanEmitter wiring across modules + new harness helpers).
- **Process lesson**: when adding an API tier (events, spans), instrument the existing modules at the same time -- otherwise the API tier ships with zero users and the docs lie about coverage. The spanEmitter-via-config pattern is the cleanest seam: callers that don't care can omit it; callers that want spans wire the default.

---

## ADR-031: Settings window with one section per ADR-019; Two-Factor migrates from standalone Tools window

- **Date**: 2026-05-04
- **Status**: Accepted (extends ADR-019, ADR-027)
- **Context**: ADR-027 shipped TOTP as a standalone Tools-menu window because Settings did not exist yet. As more configurable surfaces appear (account, updates, diagnostics, about), the standalone-window-per-feature pattern multiplies windows and menu entries -- each new feature would need its own top-level menu item and its own BrowserWindow. That spreads configuration across the menu bar instead of consolidating it where users instinctively look.
- **Decision**: Promote `settings-window` from the deferred queue to active ports. Add a new `lite/settings/` module with a Settings BrowserWindow opened from `Onereach.ai Lite -> Settings...` (macOS app-menu convention). v1 ships ONE section -- Two-Factor -- which re-hosts the existing TOTP authenticator UI inside the Settings shell. The standalone Tools -> Authenticator window is REPLACED, not kept alongside.
- **Scope (deliberately narrow for v1)**:
  - One section: Two-Factor. Other sections (Account, Updates, Diagnostics, About) land as additional `mount(el)` functions in `lite/settings/sections/` in follow-up chunks.
  - No section-registry framework yet. `lite/settings/settings.ts` walks a hand-written list of sections and calls `mount(el)` for each. Promote to a registry when there are 3+ sections.
  - No new persistence layer. The TOTP secret already lives in keychain via `lite/totp/store.ts`. Settings has no own state in v1. When future sections need persistence, they will use `lite/kv/` under collection `lite-settings`.
  - No `Cmd+,` accelerator. Per `.cursorrules` "no shortcuts unless explicitly requested." macOS convention is `Cmd+,` for Settings, but it stays unbound until a user names it.
- **What changes**:
  - `Tools -> Authenticator...` menu entry is removed.
  - The Tools top-level menu placeholder also goes away (no children left); the registry's `getChildren` semantics in `lite/menu/registry.ts` mean an empty top-level auto-hides, so this is a clean removal.
  - `lite/totp/window.ts`, `lite/totp/authenticator.html`, `lite/totp/authenticator.css`, `lite/totp/authenticator.ts` are deleted -- their content migrates into the Settings shell + `sections/two-factor.ts`.
  - `lite/totp/main.ts` loses `openAuthenticator()` from its `TotpHandle`. All `lite:totp:*` IPC handlers stay -- the Settings Two-Factor section consumes them unchanged.
  - The TOTP module's public `api.ts` surface is UNCHANGED -- ADR-027's contract holds. Settings is purely a new consumer.
- **What stays the same**:
  - All TOTP redaction guarantees (secret never logged, secret value never crosses IPC after save).
  - All TOTP error codes + the `TotpError` class.
  - TOTP uses the full app's canonical keychain entry (`OneReach.ai-TOTP` / `onereach-unified-login`), with a legacy fallback for the earlier Lite-only spike entry.
  - The placeholder window's Sign-in card -- this work is purely additive to the launch UI.
- **Patterns adopted**:
  - **Settings shell + sections** -- the shell is a thin BrowserWindow + scrolling main element. Each section is a `mount(container) -> disposer` function in `lite/settings/sections/`. No Vue, no framework; plain TS rendering, matching the kernel's "plain HTML + TypeScript" stance from ADR-002.
  - **First child of the app menu beyond About + Quit** -- Settings is the canonical "between About and Quit" slot on macOS. Order 50 (About is 0, Quit is 100).
  - **Single-instance window** -- subsequent clicks on Settings... focus the existing window instead of opening a second. Same pattern as the deleted `lite/totp/window.ts` and the bug-report modal.
- **Patterns deliberately rejected**:
  - **Sidebar + tabs** like the full app's `settings.html`. Lite has 1 section in v1 and at most ~5 likely sections; a vertical scroll list is simpler and reads better at small window sizes.
  - **Real persistence layer in v1**. Tempting to add `lite-settings` KV collection now for future use, but YAGNI -- TOTP already manages its own keychain state, and adding a layer "just in case" is exactly the over-engineering the slim-kernel ethos avoids (ADR-011).
  - **Section registry in v1**. The hand-written section list in `settings.ts` is sufficient for one section. Promoting too early adds indirection without value.
  - **Keeping the standalone Authenticator window alongside Settings**. Two entry points to the same UI fragments user mental models. If a faster path to "show me the code right now" is needed later, a quick-access affordance can land WITHIN the placeholder window (e.g. a small live-code indicator) without resurrecting the standalone window.
  - **`Cmd+,` accelerator** even though it's macOS convention. Per the no-shortcuts rule, the user names accelerators, not us.
- **Consequences**:
  - **Single home for configuration**. As Account/Updates/Diagnostics sections land, they go into Settings -- not into new windows or new top-level menus.
  - **One fewer window class to maintain**. The standalone Authenticator code goes away entirely.
  - **One fewer top-level menu**. Tools disappears in v1 (auto-hides via the registry); future tool-style features can re-introduce it deliberately when they have a non-Settings nature.
  - **Cost: open Settings (one click) instead of Tools-menu shortcut to view a code mid-sign-in**. Sub-second penalty; the Two-Factor card sits at the top of Settings so the live code is visible immediately.
  - **The first commit also rolls in the debug-instrumentation cleanup from the cancellation-fix verification** (ADR-026 follow-up) -- that work landed evidence the fix worked but the instrumentation was not removed because the agent got mid-flow mode-switched. This chunk's first step strips it.
- **Borrowed patterns** (studied, never imported):
  - Full app `settings.html:481-551` -- sidebar tab structure (lite uses scroll-list, not tabs)
  - Full app `settings.html:943-1026` -- two-factor UI shape, already adapted into `lite/totp/authenticator.{html,ts}` per ADR-027
  - Single-instance window pattern from `lite/totp/window.ts` (which we delete) and `lite/bug-report/main.ts`
- **Process lesson**: when a feature ships as a standalone window because a hosting Settings page does not exist yet (ADR-027), capture the migration plan in the same ADR. ADR-027 already named `auth-autofill` as a follow-up chunk that depends on `lite/totp/`; this ADR (031) documents the second predictable follow-up: hosting the same feature inside the eventual Settings shell. Future modules that ship "standalone windows pending Settings" should carry the same migration commitment in their ADR.

---

## ADR-032: Per-module typed event APIs (discriminated unions + onEvent helper)

- **Date**: 2026-05-04
- **Status**: Accepted (extends ADR-025, ADR-030)
- **Context**: After ADR-030 ("Universal Event Instrumentation"), every module emits events through `getLoggingApi().event()` / `start()`. Consumers had to either (a) know event names by string and read them out of the generic `EventRecord`, or (b) import `getLoggingApi()` and subscribe to a glob like `'kv.*'` with no type information. The first is fragile (strings drift; renames don't propagate); the second forces consumers to widen the universe of "any module's events" instead of focusing on the module they care about. The user's framing was: "the events should be APIs." That request implies typed names + typed payloads + per-module subscription, not just raw queue access.
- **Decision**: Each module that emits events exposes a public **typed event surface** consisting of three pieces, co-located with its `api.ts`:
  1. A `<MODULE>_EVENTS` `as const` constants object listing every emitted name (e.g. `KV_EVENTS.SET_FINISH = 'kv.set.finish'`).
  2. A discriminated union of typed event records (e.g. `KvEvent = KvSetStartEvent | KvSetFinishEvent | ...`) -- branching on `ev.name` narrows `ev.data`, `ev.durationMs`, and `ev.error` per variant.
  3. A per-module `onEvent(handler)` method on the public API (or a free function on modules whose handle is nullable, e.g. `onUpdaterEvent` for the updater) that filters `getLoggingApi().onEvent('<module>.*', ...)` and casts to the module's typed union.
  Consumers code against the typed surface and never touch the generic `EventRecord` shape unless they explicitly want cross-module observability.
- **What ships in this ADR (4 modules instrumented)**:
  - `lite/kv/events.ts` -- 15 names (5 ops × 3 outcomes), `KvEvent` union, `getKVApi().onEvent()`.
  - `lite/bug-report/events.ts` -- 22 names (15 spans + 7 IPC), `BugReportEvent` union, `getBugReportApi().onEvent()`.
  - `lite/auth/events.ts` -- 14 names (8 spans + coalesced + session.read + 4 IPC), `AuthEvent` union, `getAuthApi().onEvent()`.
  - `lite/updater/events.ts` -- 9 names (6 spans + 3 IPC), `UpdaterEvent` union, `onUpdaterEvent()` free function (the handle owned by `initUpdater()` may be `null` across teardown; the event log outlives the handle).
- **Convention**:
  - The error from a span fail is at the **top level** of the event record (`ev.error`), not inside `ev.data`. This mirrors the actual `EventRecord` shape Span.fail emits via `lite/logging/store.ts:buildRecord()`.
  - Module-specific subscription methods filter to the module's prefix; cross-module subscribers must use `getLoggingApi().onEvent('*', ...)` or `getLoggingApi().recent('*')` directly.
  - Adding a new event requires updating BOTH `events.ts` (typed constant + interface + union) AND the emit site.
- **Enforcement**:
  - `lite/test/unit/event-name-conformance.test.ts` scans each module's source files for literal `.event('...')` and `.start('...')` and `spanEmitter?.('...')` calls and asserts every literal name is in `<MODULE>_EVENTS`. Catches drift between code and typed catalog. Dynamic names (template literals like `` `kv.${op}` ``) are skipped here -- they're verified at runtime by `lite/test/integration/event-coverage.test.ts`.
  - `lite/test/integration/typed-onevent.test.ts` proves the runtime path: each module's `onEvent()` delivers events when ops run, switch on `ev.name` narrows `ev.data` / `ev.durationMs` / `ev.error` correctly, unsubscribe detaches, and cross-module noise is filtered out.
  - The API conformance contract (`runApiConformanceContract`, ADR-024) was extended to include `onEvent` in `expectedMethods` for each module. A subsequently-added typed event surface must update the contract or the meta-test fails.
- **Patterns rejected**:
  - **Auto-generated types from runtime emissions** -- considered (e.g. by parsing call sites with TS AST), rejected because it lags the code and creates a phantom build step. Hand-written events.ts files are the price of typed events.
  - **A single central `LiteEvent` union** mixing all modules -- rejected because it forces consumers to handle (or explicitly default-case) every event in the app even when they only care about one module. Per-module unions match the modular API pattern (Rule 11 / ADR-019).
  - **Runtime validation (zod / type-guards on every event)** -- rejected because the producer side is statically typed (Span / event() take typed args) and the consumer side narrows via `switch (ev.name)`. Adding zod buys nothing except CPU and bundle size; the typed catalog is the contract.
  - **Decorating modules' classes** (`@onEvent('kv.set.finish')` style) -- rejected because lite avoids decorators entirely (no `experimentalDecorators`) and because explicit `switch` is more readable.
  - **Auto-generating per-event interfaces from a JSON catalog** -- rejected for the same lag reason as auto-generated types; if the developer is going to update a JSON file, they may as well update the .ts file directly with full editor support.
- **Consequences**:
  - **Type-safe consumers**: a UI that wants to badge KV failures writes `if (ev.name === KV_EVENTS.SET_FAIL) { showToast(ev.error.message); }` and the compiler verifies `ev.error` exists on that variant.
  - **Renames are mechanical**: rename the constant, the emit site, the interface; the typecheck flags every consumer.
  - **The catalog is documentation**: each `events.ts` is the source-of-truth for "what does this module emit?" Module READMEs link to `events.ts` rather than describing each event in prose.
  - **Adding a new event has a clear checklist**: emit-site, `<MODULE>_EVENTS` constant, typed interface, add to union. The meta-test catches missing pieces.
  - **Bundle cost**: ~50 lines per module × 4 modules ≈ 200 lines new TS, all stripped at runtime (interfaces) except the `<MODULE>_EVENTS` constant objects (~15 string entries each). Negligible.
  - **One conflict captured**: ADR-031 number was originally claimed by this work, but `lite/settings/` (concurrent untracked work) had reserved ADR-031 for "Settings window + sections." This ADR took ADR-032 instead. Process lesson: when adding cross-cutting infra during a session, check the ADR ledger (and the LITE-PUNCH-LIST) for in-flight reservations BEFORE committing to a number in code.
- **Process lesson**: per the user's framing ("events should be APIs"), expose the names + types + subscription as part of each module's public surface. The temptation to "just let consumers subscribe to the generic logging API" is real but wrong -- it leaks every module's emission shape across module boundaries and erases the type system's leverage. Per-module typed events keep the modular boundary AND expose observability as a first-class capability.

---

## ADR-033: Neon (Neo4j Aura) module: pluggable credentials, no OmniGraph

- **Date**: 2026-05-04
- **Status**: Accepted
- **Context**: Lite needs a Neo4j (Neon) Cypher client to support graph features. The full app's `omnigraph-client.js` (~2,500 LOC, 130+ call sites, dual-transport with deprecated direct-Aura fallback, async-job polling pattern, embedded typed CRUD for ~30 entity types, embedded SDP-chunking for capture sessions) is fundamentally not a fit for Lite's slim-kernel philosophy. Beyond size, it carries assumptions (gsx auth model, capture session signaling, sync-v5 wiring) that are full-app concerns. The user's framing was: "I want to replace OmniGraph. I don't want it in this app at all." Plus: "assume in the future we will make NEON endpoint more secure" -- so the current `creds-in-body` wire format is known to be transitional.
- **Decision**: Ship a new Lite-native module `lite/neon/` that:
  1. Imports zero code from `omnigraph-client.js`. The full module stays where it is; lite never references it.
  2. Exposes a minimal API: `query(cypher, parameters?)`, `ping()`, `status()`, `configure(config)`, `onEvent(handler)`. No typed CRUD helpers in the transport client -- those will live in feature modules (e.g. `lite/spaces/graph.ts`) when their respective ports happen.
  3. Hides the credential transport behind a `CredentialsProvider` interface (`lite/neon/credentials.ts`). Today the provider returns `{ kind: 'basic-in-body', uri, user, password, database }` and the client embeds those in the body. When the endpoint hardens (bearer / OAuth2 / mTLS), a new provider variant + one new switch case in `client.ts:buildRequest` lands -- call sites stay unchanged. The discriminated `NeonCredentials` union is the forward-security seam.
  4. Persists settings in KV collection `lite-neon-config`, key `default`. The Settings -> Neon section is the user-facing path; for first-run / scripted setup the same record can be written via `window.lite.kv.set(...)`.
  5. Bridges `query`, `status`, `testConnection`, `configure`, `parseError` to the renderer via `window.lite.neon.*`. `configure` is bridged but only the Settings -> Neon section is expected to call it; `status()` returns `hasPassword: boolean`, never the password value (mirrors auth's `getToken` posture).
- **Renderer trust posture (Phase N0)**: any renderer can run any Cypher (read or write). Same trust boundary as `window.lite.kv.set()`. The README documents this explicitly so a future reader sees it's a deliberate choice. When the endpoint adds RBAC, the server enforces. If we later need to tighten the IPC boundary, a Cypher validator + `queryRead`/`queryWrite` split is documented in the README's Hardening roadmap (Phase N4).
- **Settings UI**: registered as a section in the existing `lite/settings/` module per ADR-031 (`Settings -> Neon`, between `two-factor` and `updates`). The section consumes `window.lite.neon.*` directly; it does not reach into the Neon module's internals (Rule 11). The password field is masked + show/hide toggle, with placeholder text indicating when a password is already saved (`leave blank to keep`).
- **Consequences**:
  - Lite never depends on full's `omnigraph-client.js` (Rule 1 honored). Full is unchanged.
  - Future endpoint hardening (bearer, OAuth, mTLS) lands as a new `CredentialsProvider` variant + one client switch case. No call site changes.
  - Typed graph operations (`upsertSpace`, etc.) live with their feature ports, not in the transport client. This keeps `lite/neon/` minimal (~600 LOC source vs 2,500 in full's omnigraph).
  - The `KVCredentialsProvider` reads from KV on every request -- no caching trickery. When a real Lite Settings module/UI wants to swap to keychain or another store, only the provider changes.
  - The renderer surface is intentionally small: `query` / `status` / `testConnection` / `configure` / `parseError`. Adding more (typed CRUD helpers) requires the feature port that needs them, not speculative work in the transport.
- **Patterns rejected**:
  - **Strangle full's omnigraph into a "lite-compatible" subset** -- rejected: violates Rule 4 (`packages/` not imported), and the dual-transport complexity is exactly what we're moving away from.
  - **Expose typed CRUD upfront** -- rejected: speculative; build out as we go.
  - **Hardcode the endpoint** -- rejected: per-environment URLs and the Settings UI are first-class. The provider abstracts that too.
  - **Bridge `configure` only to a separate "settings-neon" channel** -- rejected: simpler to bridge it on `window.lite.neon` and document the convention. The ipcMain handler does not enforce caller; it could be added later.
  - **Block writes by default at the IPC boundary** -- considered, deferred. Documented in the README as Phase N4. Lite's renderer is our code; same trust as `window.lite.kv.set()`.
- **Files** (all new, ~2,200 lines including tests):
  - Source: `lite/neon/{api,client,credentials,errors,events,main,types}.ts` + `README.md`
  - Settings UI: `lite/settings/sections/neon.ts` + section entry in `lite/settings/settings.ts` + styles in `lite/settings/settings.css`
  - Wiring: `lite/preload-lite.ts` (window.lite.neon bridge), `lite/lite-window.d.ts` (types), `lite/main-lite.ts` (initNeon + teardown)
  - Tests: `lite/test/unit/{neon-api,neon-client,neon-credentials}.test.ts`, `lite/test/integration/neon-integration.test.ts`, `lite/test/integration/typed-onevent.test.ts` (Neon block), `lite/test/integration/event-coverage.test.ts` (Neon block), `lite/test/unit/event-name-conformance.test.ts` (neon in MODULES)
- **Process lesson**: existing settings module (ADR-031) already supports section-by-section growth. Adding a third section took one new file (`sections/neon.ts`) plus three lines in `settings.ts`. That's the strangler discipline working as designed -- no new "settings shell" had to be built.

---

## Future Decisions

New ADRs append below as they're made. Use the next sequential ID (ADR-037, ADR-038, ...).

---

## ADR-034: Lite auth popup auto-fills OneReach TOTP only; email/password and account selection stay manual

- **Date**: 2026-05-04
- **Status**: Accepted (extends ADR-026, ADR-027, ADR-031)
- **Context**: ADR-026 intentionally made the Lite auth popup passive: the user filled the OneReach form and Lite watched for `mult` / `or` cookies. ADR-027 added a TOTP code generator, and ADR-031 moved the generator UI into Settings -> Two-Factor. That still left a poor login experience: when OneReach asks for 2FA, the user must leave the auth popup, open Settings, copy the code, return to the auth popup, paste, and submit. The full app already proves a better path in `lib/gsx-autologin.js`: detect the 2FA page, generate a TOTP code, fill it with React-compatible input events, and submit.
- **Decision**: Add `auth-totp-autofill-v1`: Lite's auth popup auto-fills **only the OneReach TOTP code**. Email/password remain manual. Account selection remains manual. Existing cookie capture remains unchanged. The auth popup watches for an `auth.*.onereach.ai` frame, detects a visible TOTP input, calls `getTotpApi().getCurrentCode()`, fills the code using the full app's `lib/auth-scripts.js` builders, and submits with the standard verify/continue/confirm buttons.
- **Scope**:
  - Detect 2FA pages in the Lite auth BrowserWindow only.
  - Use `lite/totp/` as the source of truth for code generation.
  - If no TOTP secret exists (`TOTP_NO_SECRET`), do nothing to the page; user can still copy the code manually from Settings once configured.
  - If the code is near expiration, wait for the next 30-second window before filling.
  - Retry a small number of times on invalid/expired code.
- **Patterns adopted**:
  - Reuse `lib/auth-scripts.js` directly (allowed: `lib/` is shared by Lite and full; no upward full-app dependency). These script builders are already factored for cross-origin frame execution and React-compatible input mutation.
  - Keep automation main-process only. The auth window still has no preload and no renderer bridge.
  - Keep code/secret redaction: never log the six-digit code, never log the TOTP secret.
- **Patterns deliberately rejected**:
  - **Email/password auto-fill** -- larger credential UX + keychain surface; not required to remove the 2FA friction.
  - **Account-picker auto-select** -- account choice is user-specific and can remain manual until a later multi-account chunk.
  - **Full `gsx-autologin.js` port** -- too much surface for Lite's login-token flow (overlays, toolbar, GSX window chrome, retry UI).
- **Consequences**:
  - The login popup becomes materially smoother: user enters credentials, Lite handles the 2FA code, cookie capture continues.
  - Settings -> Two-Factor remains useful for setup, trust/explanation, and fallback.
  - The code path touches security-sensitive auth UI, so tests must cover no-secret no-op, detection, fill+submit success, and no secret/code logging.
- **2026-05-04 amendment -- detection model + observability**:
  - The first implementation triggered a single `document.querySelector` on Electron's navigation events (`did-navigate`, `did-finish-load`, ...) and silently returned when no TOTP input was present. Live logs from a real sign-in proved this was a no-op: zero `auth-totp-autofill:*` lines fired across a 50-second sign-in even though the user reached and completed the 2FA page. Two compounding bugs:
    1. **SPA timing race**: OneReach renders the TOTP input after `did-finish-load`, so the one-shot probe always missed it. The full app already solved this in `lib/gsx-autologin.js:594` via `waitForAuthForm` (a `MutationObserver` injected into the frame).
    2. **No observability**: every failure path returned without logging, so the only signal was "nothing happened."
  - Fix:
    - Inject `buildWaitForAuthFormScript` (Promise + MutationObserver, 10s timeout) into every OneReach frame on every navigation event. `is2FAPage: true` is the trigger; everything else logs and waits for the next event. Per-frame de-dup via `(processId, routingId)` prevents parallel waits on the same frame.
    - Attach the same watcher to popup windows opened by the auth window via `webContents.on('did-create-window', ...)`. OneReach's `auth.<env>.onereach.ai` may render in a `window.open` popup; the watcher recurses so both layouts work.
    - Every step writes an `info` log under category `auth`: `started watching`, `tracking popup window`, `scan`, `skip non-onereach frame`, `waiting for auth form`, `form wait resolved`, `waiting for fresh code window`, `filled and submitted 2FA code`, plus `fill failed` / `submit threw` / `getCurrentCode failed` warnings. The redaction rules from the original decision are preserved -- the six-digit code, the TOTP secret, and cookie values are still never logged.
  - The contract from the original ADR is unchanged: only the OneReach TOTP code is filled, email/password and account selection stay manual.

---

## ADR-035: API Reference window with build-time manifest harvested from module sources

- **Date**: 2026-05-04
- **Status**: Accepted (extends ADR-019, ADR-024, ADR-031, ADR-032)
- **Context**: Lite has 7 modules exposing public APIs (`kv`, `bug-report`, `auth`, `logging`, `neon`, `settings`, `totp`) and four observability surfaces (the typed event catalogs from ADR-032). Each module owns its `README.md`, its `api.ts` interface (Rule 11), and its `events.ts` (where applicable). Anyone trying to consume these APIs today has to open the source tree -- which is fine for the agent and the author but a real cost for any second human reading the code. The user wants a single in-app surface that lists every API and what it does. The shipped goal is "a button in Settings that pops up a large window that lists all APIs, organized well, with docs."
- **Decision**: Add a new `lite/api-docs/` module that ships a single-instance `BrowserWindow` (~1200×800) with a two-pane layout: sidebar of modules + content area showing per-module documentation. The doc data is harvested at build time from the actual module sources -- `api.ts`, `events.ts`, and `README.md` -- by `lite/api-docs/manifest-builder.ts`, written to `lite/api-docs/manifest.generated.ts`, and bundled into the renderer. The window is opened from a new "Developer" section in Settings that holds a single button: "Open API Reference."
- **Source-of-truth flow** (build time, before esbuild):
  1. Walk `lite/<module>/api.ts` for every directory with one. Extract: top-of-file JSDoc (the module summary), the `XApi` interface name, each method signature + its preceding JSDoc (description + `@example` blocks).
  2. Walk `lite/<module>/events.ts` (when present). Extract every entry of `<MODULE>_EVENTS` -- name, conventional category from the dotted prefix.
  3. Read `lite/<module>/README.md` verbatim if present.
  4. Combine into one `ModuleDoc` per module with stable shape (`{ slug, title, summary, surface: { interfaceName, methods: [...] }, events: [...], readme: '...' | null }`) and write `lite/api-docs/manifest.generated.ts` exporting an `as const`-typed array.
- **Renderer (browser side)**:
  - The bundled manifest is imported as a static module (no runtime FS, no IPC for content -- only `lite:api-docs:open` for window control).
  - Sidebar lists every module + a text filter; clicking a module renders its summary, public method cards, event taxonomy table, then the full README via `marked` (already a project dep at ^17.0.1).
  - Markdown rendering uses `marked` with a strict allowlist (no raw HTML execution; CSP `script-src 'self'` already enforces this).
- **What deliberately ships in v1**:
  - The 7 documented modules (`kv`, `bug-report`, `auth`, `logging`, `neon`, `settings`, `totp`).
  - A "Without typed API" footer listing modules that don't have an `api.ts` (`updater`, `menu`) with a one-line note pointing at their event taxonomies in `lite/logging/README.md`.
  - Settings "Developer" section with a single button.
- **What deliberately does NOT ship in v1**:
  - **Full-text search across all module docs.** A simple text filter on the sidebar list is enough at 7 modules. Promote to full-text when there are >10.
  - **Cross-module link resolution.** Markdown links between READMEs render as plain anchors. The window does not navigate when a link is clicked; users open external editors / GitHub for now. Add deep-linking when consumers ask for it.
  - **Search-engine-style URL routing inside the window.** No fragment URLs; selection state is per-session and lost on close.
  - **Hot reload of the manifest during dev.** The manifest is regenerated on every `npm run lite:build`. Authors who want live updates use `npm run lite:dev` which already rebuilds on change.
  - **A separate menu entry.** v1 ships only the Settings button. The Help menu's "Report a Bug" already carries the "I'm a developer; tell me how this works" intent indirectly; we can add a Help entry once external developers consume the window.
  - **A keyboard accelerator.** Per ADR-015, accelerators are user-named.
- **Patterns rejected**:
  - **Runtime introspection** of the loaded modules to derive method lists. TypeScript types are erased at runtime; class methods exist but JSDoc and `@example` blocks do not. Build-time harvesting from `api.ts` is the only way to keep prose docs in the same file as the surface.
  - **A single hand-written HTML doc page.** Drifts from code the moment a method is added without doc edits. Build-time harvesting + a meta-test (see Enforcement below) makes drift a CI failure instead of an aesthetic problem.
  - **Auto-generated TypeDoc** as the docs source. TypeDoc is excellent but its output is its own site, not an in-app window; embedding it would require shipping a static-site generator's output and a navigation shell that mimics our look. Manifest harvesting + `marked` is ~250 LOC versus integrating TypeDoc.
  - **Vendoring a markdown library.** `marked` is already a dep at ^17.0.1; using it adds zero new dependencies.
  - **A separate `api-docs.html` per module.** Single-window, single-renderer with sidebar nav matches the docs UX of every IDE / API explorer the user already knows; multiple windows multiplies state for no benefit at 7 modules.
- **Enforcement**:
  - `lite/test/unit/api-docs-manifest.test.ts` snapshots the harvest output for the 7 documented modules, asserting each appears with a non-empty `methods` array, and that `kv` (the canonical example) lists every method declared on `KVApi`. If a method is added to `KVApi` without a matching JSDoc, the test fails because the harvester produces an entry with `description: ''` and the assertion catches it.
  - The standard API conformance contract (`runApiConformanceContract`, ADR-024) covers `ApiDocsApi`. Adding `open()` requires adding it to `expectedMethods`.
- **Window mechanics**:
  - Single-instance: subsequent calls to `getApiDocsApi().open()` focus the existing window. Same pattern as Settings (ADR-031), bug-report modal, and the deleted authenticator window.
  - No persistence across app restarts. The window is stateless; closing and reopening rebuilds the renderer from the bundled manifest.
  - Logger / spanEmitter wired through `getLoggingApi()` per ADR-025; the window emits `api-docs.open` spans, `api-docs.module-viewed` per click, and `api-docs.filter-applied` (debounced) per filter change.
- **Consequences**:
  - **The lite app becomes self-documenting.** A new internal user can open Settings → Developer → Open API Reference and read every module's surface without leaving the app or opening the source tree.
  - **Module README files become first-class deliverables**, not just internal notes -- they render in-app for end users. Their tone should match (still developer-targeted; not user-facing prose).
  - **Adding a new module's docs is automatic** if the module has `api.ts` + `README.md`. No registration, no separate doc index. A future module shows up the moment its files exist.
  - **A drift surface gets a meta-test**: methods on an `XApi` interface that lack JSDoc cause the manifest snapshot to fail.
  - **Bundle size**: `marked` adds ~30 KB minified; the manifest itself is ~30-50 KB depending on README sizes. The Settings window is unaffected; only the API Reference window pays the cost when opened.
- **Process lesson**: the user's earlier request -- "I want the apps API's fully documented so modules can use them" (which produced the per-module README files and the structured `LiteError` class) -- closes its loop here. The READMEs already exist; what was missing was a way to read them inside the app without `cd lite && ls && code <module>/README.md`. Build-time manifest harvesting + `marked` finishes the job without new abstractions: the same files developers maintain become the in-app docs.

---

## ADR-036: Pull-based health snapshot, separate from the event log

- **Date**: 2026-05-04
- **Status**: Accepted (extends ADR-019, ADR-025, ADR-030)
- **Context**: The central event log (ADR-025, ADR-030) answers "what happened over time?" -- spans, IPC events, lifecycle markers. It does not answer "what is true *right now?*" Debugging, bug-report triage, future Settings → Diagnostics, and E2E post-condition assertions all need a current-state surface: open windows, sign-in status, TOTP / Neon configuration, recent error counts. Reconstructing this from the event log requires walking it backwards and inferring -- expensive and fragile. Push-based "global mutable health object" was considered (every mutating module updates a shared record) and rejected: it couples every module to the shared object, accumulates stale fields, and makes "who last touched this?" unanswerable.
- **Decision**: Add a new `lite/health/` module with a pull-based `HealthApi.snapshot()` that builds a fresh `AppHealthSnapshot` on every call. Each section reader calls only the relevant module's public api (`getAuthApi().getSession`, `getTotpApi().getMetadata`, `getNeonApi().status`, `readUpdateState()`, `getLoggingApi().recent`) -- no central state, no shared mutable object. Best-effort by design: each section is wrapped in its own try/catch and produces a safe fallback rather than throwing the whole snapshot away. Exposed via `window.lite.health.snapshot()` and attached as an optional `healthSnapshot` field on bug reports.
- **Source-of-truth flow** (every call):
  1. `HealthStore.snapshot()` runs each section reader in `Promise.all`.
  2. App metadata comes from injected config (version, startedAt, userDataPath) and `process.platform` / `process.arch`.
  3. Windows from `BrowserWindow.getAllWindows()`; classified by URL ending (`placeholder.html` -> `main`, etc.).
  4. Auth from `getAuthApi().getSession('edison')` + `getAuthApi().getToken('edison') !== null` for the `hasMultToken` boolean.
  5. TOTP from `hasSecret()` + `getMetadata()` + `getCurrentCode()` (only `timeRemaining` survives -- the code value is dropped).
  6. Neon from `status()`.
  7. Updater from `readUpdateState(userDataPath)`.
  8. Diagnostics walks `getLoggingApi().recent('*', 200)` and counts errors/warns; captures most-recent error name + redacted message.
- **Security posture (enforced by the type)**:
  - The snapshot type (and its branches in `lite/health/types.ts`) has NO fields for tokens, TOTP secrets, TOTP codes, or Neon passwords. By construction, those values cannot land in a snapshot -- there is no field to put them in.
  - Safe diagnostics ARE included: token presence booleans, account id, email, token expiry, TOTP secret length, Neon `hasPassword`, window titles/URLs, recent counts.
  - Bug-report redaction still runs over the serialized payload as a defence-in-depth measure. A unit test asserts that token sentinels in mocked auth bundles do not appear in the final snapshot.
- **What deliberately ships in v1**:
  - Seven sections: app, windows, auth (`edison` only), totp, neon, updater, diagnostics.
  - `window.lite.health.snapshot()` renderer bridge.
  - Bug-report integration: `getHealthApi().snapshot()` is called best-effort during capture; failure files the bug anyway.
- **What deliberately does NOT ship in v1**:
  - **Settings → Diagnostics UI.** The snapshot is the data source; the UI is a separate chunk.
  - **Remote health upload.** No telemetry endpoint. The snapshot only flows into bug reports (which are user-driven uploads to Edison KV) and devtools.
  - **Persisted snapshots.** Every call re-reads from live state. No KV cache, no on-disk file. If a feature later needs "snapshot at last shutdown," it can opt in to writing one via `bug-report` or its own KV collection.
  - **Push-based global mutable health object.** Rejected for coupling reasons (see Context).
  - **Multi-environment auth.** Lite is `edison`-only in v1. The shape leaves room for `staging` / `production` later by typing `environment: 'edison'` (will widen).
- **Patterns rejected**:
  - **Returning Result-shaped sections (`{ ok: true, data } | { ok: false, error }`).** Considered for explicit failure surfacing per section. Rejected because every consumer would need to branch on every section -- noisy. The "safe fallback" approach yields a uniform shape; consumers branch on the actual fields they care about (`auth.signedIn`, `totp.configured`).
  - **Caching the most recent snapshot.** Tempting (saves work for callers that take many snapshots in a row, e.g. a devtools poller). Rejected: caching introduces "is this stale?" -- exactly the problem we built pull-based to avoid. Reads are cheap (a few async calls + one Promise.all); cache when a measurable hot path appears.
  - **Async logger reader for diagnostics.** Considered subscribing to events in real-time and maintaining a count. Rejected for the same coupling reason as the global object: the snapshot is a read, not a stream.
- **Window classification** in `classifyWindow()`:
  - URL endings: `placeholder.html` -> `main`, `settings.html` -> `settings`, `api-docs.html` -> `api-docs`, `modal.html` -> `bug-report`, `about.html` -> `about`.
  - URLs containing `onereach.ai` or `gsx-` and titles containing `sign in` -> `auth`.
  - Anything else -> `unknown` (deliberately permissive: a third-party window opened by a future feature should not crash the snapshot).
- **Consequences**:
  - **A single function answers most "what state is the app in?" questions.** Triagers stop reverse-engineering from logs.
  - **Bug reports get richer.** Every report now carries an `AppHealthSnapshot` (when health is available); pre-ADR-036 reports are passed through migration without one.
  - **The type is the redaction policy.** Since the snapshot type has no fields for secrets, no future careless edit can leak one through this surface. The defence-in-depth (bug-report redaction over the serialized payload) catches anything that slips into a free-text field.
  - **Bundle / runtime cost is small.** No new deps. Reads are async-parallel; one snapshot is a few ms wall-clock at v1 module count.
  - **The api-docs window auto-discovers the new module.** No manual registration -- adding `lite/health/api.ts` + `lite/health/README.md` is enough; the manifest builder picks it up on the next `lite:build`.
- **Process lesson**: when the question is "what's true right now?", do not answer it by reconstructing from a stream. Build a pull-based reader that calls each module's public API. Push-based shared state is a coupling magnet; pull-based composition is the modular API pattern (Rule 11) extended to diagnostics.

---

## ADR-037: IDW v1 -- multi-category Agents in one menu, OAGI-driven Store, shared placeholder browser

- **Date**: 2026-05-04
- **Status**: Accepted
- **Context**: Lite needs a top-level **IDW** menu equivalent to full's, plus the manage UI and OAGI-driven catalog window. Full's IDW menu (`lib/menu-sections/idw-gsx-builder.js`) hosts six categories: organization-specific IDWs, External Bots, Image Creators, Video Creators, Audio Generators (with sub-categories), UI Design Tools. Full also persists IDWs in two stores (settings + `userData/idw-entries.json`) which has been a source of drift bugs (see `PUNCH-LIST.md`). And full opens IDW URLs as tabs in the tabbed browser, which Lite does not have yet. Per the user request, this chunk should also be ready for users to add 3rd-party Agents (not just IDWs), with a "really cool UX experience" inviting users to "start their journey of product expert."
- **Decision**: Ship a new Lite-native module `lite/idw/` that:
  1. **Unified data model** -- one `IdwEntry` type with a `kind` discriminator covering all six categories. Lives in one KV blob (`lite-idw-entries / default`). Single source of truth, no second JSON file.
  2. **Multi-category menu** -- `lite/idw/menu-builder.ts` registers `top:idw` with order 60 and partitions entries into per-kind sections in a fixed order (IDWs, External Bots, Image Creators, Video Creators, Audio Generators with sub-category submenus, UI Design Tools). Empty sections are omitted entirely. Always-present tail: `Manage Agents...` only; Store discovery lives inside Settings -> IDWs so the roster remains the primary surface. (No "Add Custom Agent" item -- the Settings -> IDWs section already exposes that affordance; surfacing it twice is noise.) Empty-state welcoming item: "Start your journey as a product expert -- manage agents to install your first agent." NO accelerators (per ADR-015).
  3. **Shared placeholder browser** -- `lite/idw/browser-window.ts` is one singleton `BrowserWindow` that loads the clicked agent's URL. Forerunner of the eventual tabbed browser; the swap point is a single `loadURL` -> `createTabInBrowser` line. NO preload (third-party page must not see `window.lite.*`); persistent partition `persist:lite-idw-browser`; `setWindowOpenHandler` denies child Electron windows and routes external links via `shell.openExternal`. Defensive URL validation surfaces a friendly dialog on invalid URLs (review-fix #14).
  4. **OAGI-driven Store** -- `lite/idw/catalog-window.ts` opens a polished catalog renderer (`catalog-renderer.ts`) that calls `window.lite.neon.query` to fetch IDW + Agent nodes from OAGI. Bucketed by `kind` property (Agent nodes fall back to `external-bot` if no explicit kind). Cross-references installed entries via `storeMetadata.catalogId` for "Installed" / "Update available" badges. The catalog Cypher is ported inline -- NOT added to `lite/neon/api.ts` (Neon module stays minimal; feature CRUD lives with the feature, per ADR-033).
  5. **Store-update semantics** -- when `add()` is called with `source: 'store'` and a `storeMetadata.catalogId` that matches an existing entry, the existing entry is UPDATED in place (preserving `id` and `installedAt`, setting `updatedAt`); returns `{ wasUpdate: true }`. Catches re-installs of newer Store versions cleanly (review-fix #9).
  6. **Settings -> IDWs section** (`lite/settings/sections/idws.ts`) -- "Your AI Roster" panel with welcome card (empty state), kind filter pills, unified card-rows table, inline-expand Edit form, animated Remove with `window.confirm`, dynamic Add form with kind selector + per-kind fields, inline URL validation. The section subscribes to `window.lite.idw.onChange` so installs from the Catalog window reflect live (review-fix #8).
  7. **Settings deep-link** -- extended `SettingsApi.open(sectionId?)` so the IDW menu's "Manage Agents..." and the Catalog's "Configure OAGI" empty-state can navigate to the right section. Implementation: `loadFile(htmlPath, { query: { section } })` on first open, `webContents.executeJavaScript` calling `window.__liteActivateSection(id)` on subsequent opens (review-fix #3).
  8. **Polished UX** -- per-kind accent design tokens (`--accent-idw`, `--accent-external-bot`, ...) shared between catalog and Settings styles; cards with hover-lift + soft shadows; skeleton shimmer loading; toast notifications; empty states with inline SVG illustrations and welcoming copy throughout. Search bar with backdrop-filter blur. Smooth section / row animations.
- **Renderer trust posture**: catalog window + Settings section call `window.lite.idw.add/update/remove` freely. Same trust boundary as `window.lite.kv.set()`. The placeholder browser, by contrast, has NO preload -- third-party agent pages cannot reach the lite IPC.
- **Consequences**:
  - Lite has zero dependency on full's `omnigraph-client.js` (Rule 1) or `menu-data-manager.js` -- both stay full-app territory.
  - Single KV blob means no drift between two stores. Atomic writes via `lite/kv/api.ts`.
  - Forward-compat: tabbed browser swap is one line; per-kind partition is one config change; new kind is one `KIND_META` row.
  - Catalog growth is automatic -- as the OAGI graph adds IDW or Agent nodes, the catalog populates without client changes.
  - Validation lives server-side in `IdwStore` (per-kind required fields, http/https URL only, no kind change on update).
- **Files** (~6,700 LOC across ~30 files):
  - Source: `lite/idw/{api,store,events,errors,types,kind-metadata,main,menu-builder,browser-window,catalog-window,catalog-renderer}.ts` + `catalog.html` + `catalog.css` + `README.md`
  - Settings UI: `lite/settings/sections/idws.ts` + section entry in `lite/settings/settings.ts` + `.idw-*` styles in `lite/settings/settings.css`
  - Settings deep-link: extended `lite/settings/{api,main,window,settings}.ts` to thread `sectionId?` through `open()`
  - Wiring: `lite/preload-lite.ts` (window.lite.idw bridge), `lite/lite-window.d.ts` (types), `lite/main-lite.ts` (initIdw + teardown), `lite/esbuild.config.mjs` (idw-store.{html,css,js} bundle)
  - Tests: `lite/test/unit/{idw-api,idw-store,idw-menu-builder,idw-types}.test.ts` + `event-name-conformance` MODULES extension; `lite/test/integration/idw-integration.test.ts` + `typed-onevent` IDW block + `event-coverage` IDW block
- **Patterns rejected**:
  - **Two persistence stores** (full's settings + JSON file) -- rejected: drift source, no upside.
  - **Cmd+1..Cmd+9 accelerators** (full's pattern) -- rejected per ADR-015 ("no shortcuts unless explicitly requested by name").
  - **Per-kind dedicated browser windows** -- considered for video creators (wide aspect). Rejected for v1: one shared placeholder is the simplest swap point for the tabbed browser. Reserved as a `kind-metadata.ts` field for later.
  - **Per-IDW persistent partitions** -- rejected for v1; one shared `persist:lite-idw-browser` partition. Per-IDW partitions land if/when a security review demands them.
  - **Renderer-side write-blocking** at the IPC boundary -- rejected for v1; same trust posture as other renderer surfaces. Could tighten later via a Cypher-style validator.
  - **Adding typed CRUD helpers to `lite/neon/api.ts`** -- rejected per ADR-033's "feature CRUD lives with the feature" rule. The catalog Cypher lives in `lite/idw/catalog-renderer.ts`.
  - **Onboarding modal** for first-run users -- rejected for v1. Lean on the welcoming copy in three surfaces (empty IDW menu, Settings welcome card, Store header). Modal can be added later if pilot users ask.
  - **Section unit tests** for `lite/settings/sections/idws.ts` -- rejected (review-fix #4): sections aren't unit-tested anywhere in lite today; introducing the pattern just for IDWs is scope creep. Manual smoke + future E2E covers the section.
- **Process lesson**: per the user's framing ("really cool UX experience" + "be ready for 3rd party Agents"), a unified data model with a `kind` discriminator beats six separate types. The visual polish (design tokens + hover-lift + skeleton shimmer + welcoming empty states) is the difference between a port that works and a port that delights. Treat empty states as a feature, not an afterthought.

---

## ADR-038: Multi-tab main window with sandboxed agent tabs (supersedes ADR-037 #3)

- **Date**: 2026-05-04
- **Status**: Accepted
- **Context**: ADR-037 anchored the IDW menu against a singleton placeholder browser window (`lite/idw/browser-window.ts`) with one shared `persist:lite-idw-browser` partition for ALL agents. That meant signing into ChatGPT-A and ChatGPT-B was impossible -- both saw the same session. The user's actual mental model (and full app's behavior) is "click an IDW, it opens a tab; click another, that's another tab; each tab has its own login." Time to deliver that.
- **Decision**: Ship a new `lite/main-window/` module that becomes lite's actual main window, replacing the placeholder. Each agent runs as a `WebContentsView` inside one `BaseWindow`, with a persistent partition unique to that tab.
  1. **`WebContentsView` over `<webview>`** -- Electron 30+ recommends `WebContentsView` (lite ships on 41.x). Lite is greenfield here (no `<webview>` migration cost) so we adopt the modern API. Construction is programmatic in main, not declarative in HTML, which actually fits lite's "main process owns lifecycle" pattern.
  2. **Per-tab persistent partition** -- `persist:tab-<short-uuid>` per opened tab. Rebuilt verbatim on relaunch from the tab's stored partition string so cookies, localStorage, IndexedDB persist. Different tabs of the same IDW (if we ever allow that) get different partitions; for v1 the menu dedupes by `idwId` so the natural mapping is one-tab-per-IDW.
  3. **No preload on tab views** -- third-party agent pages MUST NOT see `window.lite.*` or any other lite IPC bridge. `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, `setWindowOpenHandler` denies child Electron windows and routes external links via `shell.openExternal`. Same posture as ADR-037's placeholder browser, applied per-tab.
  4. **Chrome (tab bar) is a separate webContents** -- the `BaseWindow`'s top 36px is the tab bar UI loaded from `lite/main-window/chrome.html` with the kernel's standard preload, so it can call `window.lite.mainWindow.*`. Below it is the active tab's `WebContentsView`. Inactive tabs stay attached but get bounds `(0, 0, 0, 0)` (warm render state, no reload on switch). Resize recomputes the active tab's bounds.
  5. **Home tab** is always present and unclosable, leftmost. It hosts the placeholder content (sign-in status, "Open OAGI Store", "Add Custom Agent"). The placeholder window from ADR-019 is retired; its content moves into the Home tab.
  6. **IDW menu integration** -- the menu's `onOpenEntry` (today: `openAgentInBrowser`) now calls `mainWindowApi.openTab({ url, label, idwId, iconName? })`. Dedupe by `idwId` (focuses existing) per user's choice; manual external bots without an `idwId` always open a fresh tab. Same trust boundary as before (main-process only, no renderer write).
  7. **Persistence in KV** -- collection `lite-main-window-tabs / default` stores `{ tabs: [{ id, label, url, idwId?, partition, createdAt, updatedAt }], activeId, schemaVersion: 1 }`. Save on open/close/activate/navigate-finished. Restore on app boot: rebuild each tab's `WebContentsView` with its stored partition string and last-seen URL (per user's choice -- restore last URL, not the IDW's home URL). Cold start time stays small because views are created lazily as tabs activate.
  8. **Public API** (`lite/main-window/api.ts`): `openTab(input)`, `closeTab(id)`, `activateTab(id)`, `listTabs()`, `getActiveTabId()`, `onTabsChanged(handler)`. Errors via `MainWindowError` codes (`MW_NOT_FOUND`, `MW_INVALID_URL`, `MW_PERSISTENCE_FAILED`, `MW_DUPLICATE_PARTITION`). Bridge: `window.lite.mainWindow.*` is renderer-callable from the chrome webContents only -- not from agent tabs (they have no preload).
- **Renderer trust posture**: chrome (tab bar) calls `window.lite.mainWindow.*` freely; agent tabs cannot reach lite IPC. The chrome's CSP is `default-src 'self'`. This matches ADR-019's namespaced-bridges-with-strict-CSP rule.
- **Consequences**:
  - **Multiple sessions of the same agent are now possible** as soon as we relax the `idwId` dedupe (one config change). v1 keeps dedupe for tidiness; reserved for v2.
  - `lite/idw/browser-window.ts` becomes a thin shim that calls `mainWindowApi.openTab` (kept temporarily so tests don't break), then deleted in a follow-up.
  - The placeholder window goes away. Existing references (parent: mainWindow in Settings, About, etc.) update to the new main BaseWindow.
  - Out of scope for v1: tab drag-reorder, per-tab back/forward/reload buttons in chrome (users use Cmd+R / Cmd+[ / Cmd+] which still work natively on the focused webContents), URL bar, favicon fetching, "+ New Tab" button (the IDW menu IS the new-tab affordance for v1). Per-tab DevTools graduated into the app-level `Dev Tools` diagnostic menu after pilot debugging showed active agent tabs need first-class inspection.
- **Files** (~3,500 LOC across ~12 new files):
  - Source: `lite/main-window/{api,store,events,errors,types,main,window,chrome}.ts` + `chrome.html` + `chrome.css` + `README.md`
  - Wiring: `lite/preload-lite.ts` (window.lite.mainWindow bridge), `lite/lite-window.d.ts` (types), `lite/main-lite.ts` (boot main window instead of placeholder; teardown), `lite/idw/main.ts` (route onOpenEntry to mainWindowApi.openTab), `lite/esbuild.config.mjs` (chrome.{html,css,js} bundle)
  - Tests: `lite/test/unit/{main-window-api,main-window-store,main-window-types,main-window-errors}.test.ts` + `event-name-conformance` MAIN_WINDOW extension; `lite/test/integration/main-window-integration.test.ts` + `typed-onevent` block + `event-coverage` block
- **Patterns rejected**:
  - **`<webview>` tag-based tabs** (full app pattern) -- rejected: deprecated, declarative-in-HTML doesn't fit lite's main-owns-lifecycle pattern. WebContentsView is the modern equivalent.
  - **One BrowserWindow per tab** -- rejected: window-management chaos, no shared chrome, multiple Dock icons.
  - **localStorage persistence** (full app pattern) -- rejected: lite uses KV as canonical persistence (per ADR-020); localStorage would be drift.
  - **Per-IDW partitions** (mapping IDW -> stable partition string) -- considered: makes "log into this IDW once and the session persists across tab close/reopen" simpler. Rejected for v1 because the user explicitly wants "logged into more than one at a time" -- per-tab partitions are the prerequisite, even if v1 dedupes. We can layer per-IDW remapping on top later without changing the persistence shape.
  - **Default New Tab button in chrome** -- rejected for v1: the IDW menu is the canonical entry point; a "+" without UX is an attractive nuisance. Add later if pilot users ask.
  - **Per-tab back/forward/reload buttons in chrome** -- rejected for v1: native ⌘R / ⌘[ / ⌘] still work on the focused tab's webContents (Electron forwards them). Adding chrome buttons doubles the surface for marginal gain. Revisit if usability research demands.
- **Process lesson**: ADR-037 explicitly anchored the placeholder as "the swap point for the eventual tabbed browser." That pre-investment paid off -- the diff to land tabs is small (~12 new files, 5 file edits), and the per-IDW partition decision baked into ADR-037 (rejected then, kept reserved) directly enabled the per-tab partition decision now. Worth repeating: when shipping a temporary architecture, name the swap point in the ADR.

## ADR-039: Agentic University v1 -- shared Learning Browser, hand-curated tutorials, OAGI-ready

- **Status**: accepted, in force
- **Date**: 2026-05-04
- **Context**: Need to port the full app's "Agentic University" top-level menu (Open LMS, Quick Starts -> View All Tutorials + 4 courses, AI Run Times, Wiser Method) to Lite. The full app has three relevant pieces: `_buildUniversityMenu` in `menu.js` (menu structure), `openLearningWindow` in `lib/gsx-autologin.js` (in-app browser window for learning content), and `tutorials.html` + `tutorials.js` (Netflix-style catalog UI with dynamic content fetching). The `Flipboard-IDW-Feed/uxmag.html` AI Run Times feed is a separate ~600 LOC dynamic UI.
- **Decision**:
  1. **Top-level menu mirrors the full app's structure** -- "Agentic University" at order 80 (between GSX at 70 and Help at 100) with the same three tiers: Open LMS, Quick Starts (View All Tutorials + 4 courses), AI Run Times, Wiser Method. NO accelerators (per ADR-015).
  2. **All link items open in a shared Lite-native "Learning Browser"** -- one singleton BrowserWindow that loads whatever URL the user most recently clicked. Mirrors the IDW placeholder browser pattern (ADR-037) but with a SEPARATE persistent partition (`persist:lite-university`) so course session cookies don't bleed into IDW agent sessions.
  3. **No preload in the Learning Browser** -- third-party content (LMS, Wiser Method, UX Mag) cannot see `window.lite.*`. Sandboxed + contextIsolated + no node integration. `setWindowOpenHandler` denies child Electron windows; popups route to the OS default browser via `shell.openExternal`.
  4. **Tutorials catalog is a Lite-native polished window** -- new `lite/university/tutorials.html` with the same visual language as the IDW Store catalog: hero "Start your journey as a product expert" copy, per-kind accent variables, hover-lift cards, featured row + per-kind sections. NOT a port of the full app's `tutorials.html` (deferred -- carousel + dynamic-fetch land in U1).
  5. **Catalog is hand-curated for v1** -- `lite/university/curated-content.ts` exports `CURATED: ReadonlyArray<LearningEntry>` plus URL constants (`LMS_BASE_URL`, `AI_RUN_TIMES_URL`, `WISER_METHOD_URL`). Forward-compat: U1 replaces `CURATED` with an OAGI Cypher fetch (Course / Tutorial node types) -- same swap pattern as the IDW Store catalog.
  6. **AI Run Times menu item opens the source URL** -- `https://uxmag.com` in the Learning Browser. Defer the Flipboard feed UI port to a future chunk if pilot users actually want the in-app reading experience.
  7. **Module API is read-only** -- `UniversityApi.list / listByKind / get / onEvent`. No CRUD because there's no user-editable state. Click-driven mutations (open URL, open catalog) are IPC-level (`lite:university:open` and `lite:university:open-tutorials`) routing to main-process side effects, not state changes.
  8. **No Settings section** -- the catalog isn't user-editable. If a future user wants to change LMS URLs or hide entries, that's a Settings section then.
- **Why a separate partition** (vs sharing IDW's): LMS / Wiser Method / UX Mag are publisher-grade properties the user has long-term sessions with. IDW agents are conversation-scoped products with their own auth surfaces. Mixing the two means a compromised IDW page could ride a logged-in LMS session. Different trust contexts -> different partitions.
- **Why hand-curated for v1** (vs OAGI): the full app's catalog is hardcoded in JS, not OAGI-fed. Lite would have to invent the OAGI Course / Tutorial schema in this PR -- scope creep for what is, day one, a 7-item menu. The forward-compat path (U1) is well-known and the swap is one function (`CURATED` -> async `fetchCurated()`).
- **Why a polished tutorials catalog** (vs just opening the LMS): the welcoming copy + curated cards are the v1 onboarding hook ("Start your journey as a product expert"). Lite users land in the LMS having already seen what's worth their time. The catalog is Lite-shaped polish, not full-app rote port.
- **Why no Flipboard feed port for AI Run Times v1**: the full app's `Flipboard-IDW-Feed/uxmag.html` is ~600 LOC of dynamic feed UI with reading time, playlist controls, content preferences. Porting all that for a single menu item is poor ROI vs just opening the source URL in the Learning Browser. Add the Lite-native feed in a follow-up if pilot users actually want the in-app experience.
- **Consequences**:
  - +1 module of ~1,800 LOC (`lite/university/`), ~250 LOC of test, ~70 LOC of new lite/lite-window.d.ts + preload bridge.
  - One new top-level menu (order 80). One new shared singleton browser window. One new on-demand catalog window.
  - Two new persistent partitions (`persist:lite-university` for the Learning Browser + the tutorials catalog uses the standard Lite preload partition).
  - Read-only module -- no KV collection. No persistence concerns.
  - Forward-compat is named (U1 -> OAGI catalog, U2 -> per-kind windows, U3 -> per-domain partitions) so future work has clear seams.
- **Files** (~1,800 LOC across ~12 new files):
  - Source: `lite/university/{api,curated-content,types,errors,events,main,menu-builder,browser-window,tutorials-window,tutorials-renderer}.ts` + `tutorials.html` + `tutorials.css` + `README.md`
  - Wiring: `lite/preload-lite.ts` (window.lite.university bridge), `lite/lite-window.d.ts` (types), `lite/main-lite.ts` (initUniversity + teardown), `lite/esbuild.config.mjs` (university-tutorials.{html,css,js} bundle)
  - Tests: `lite/test/unit/{university-api,university-curated,university-menu-builder}.test.ts` + `event-name-conformance` UNIVERSITY extension; `lite/test/integration/typed-onevent.test.ts` University block + `event-coverage.test.ts` University block + `api-docs-manifest.test.ts` slug list
- **Patterns rejected**:
  - **`shell.openExternal` for everything** -- considered: simplest, no in-app browser. Rejected: breaks the user's flow and loses the in-app polish that the full app already established with `openLearningWindow`. The Learning Browser is the v1 expectation.
  - **Sharing IDW's placeholder browser partition** -- rejected: see "different trust contexts" above.
  - **Direct port of full app's `tutorials.html`** -- rejected: ~600 LOC of CSS + dynamic fetch logic with a Netflix-style carousel that nobody asked for in Lite. Lite-native polish is cheaper, more consistent with the rest of Lite, and easier to maintain.
  - **Direct port of full app's `Flipboard-IDW-Feed/uxmag.html`** for AI Run Times -- rejected: too heavy for v1; opening the source URL in the Learning Browser captures 90% of the value at 1% of the cost.
  - **Configurable URLs in Settings** -- rejected for v1: the catalog is hand-curated. If we let users edit URLs, we're committing to a Settings section + KV persistence + import/export semantics + diff-resolution UI. Defer until a real user asks.
  - **Per-IDW partition for Wiser Method** (separating it from LMS) -- rejected for v1: both are OneReach properties with the same trust profile. If pilot users report cross-contamination issues, U3 splits per-domain.
  - **Auto-injecting GSX login parameters** (full app `openLearningWindow` does this via `lib/gsx-autologin.js`) -- rejected: Lite has no GSX integration yet. The LMS is pure cookie-session-driven through the persistent partition. Adding GSX autologin is a separate chunk that depends on the GSX module landing first.
- **Process lesson**: ADR-037 named the IDW placeholder browser as "the swap point for the eventual tabbed browser" -- and ADR-038 redeemed that promise. Same spirit applies here: the Learning Browser is the swap point for U2 (per-kind dedicated windows) and U3 (per-domain partitions). When the eventual tabbed browser lands (ADR-038's main-window arrives), `lite/university/browser-window.ts` becomes a thin shim that calls `mainWindowApi.openTab` -- mirroring how `lite/idw/browser-window.ts` is planned to evolve. Keeping all "open URL in Lite chrome" calls behind a per-module factory (vs raw `loadURL`) means the eventual swap is mechanical.

## ADR-040: Lite AI service v1 -- OpenAI-only, BYO-key, narrow surface, profile-shape ready

- **Status**: accepted, in force
- **Date**: 2026-05-04
- **Context**: AI Run Times needs text-to-speech to reach feature parity with the full app's Flipboard reader. Lite has no AI service today (full app's `lib/ai-service.js` is a full-app dep we can't import per Rule 1). Future modules (Spaces summarization, IDW chat presets, Voice Orb, audio script generation) will also need AI calls. Decision needed: bake AI calls into AI Run Times directly, or add a centralized AI module now that future modules can share?
- **Decision**:
  1. **Add `lite/ai/` as a centralized AI service module today.** Mirrors the full app's principle that "no module makes raw OpenAI fetches"; AI Run Times consumes via `getAiApi().tts(...)`, not `fetch('https://api.openai.com/...')` from inside the renderer.
  2. **OpenAI only for v1** -- `provider: 'openai'`. Single-provider keeps the surface tight. Multi-provider is named in the hardening roadmap (A3) but deferred until a second consumer actually wants Anthropic / Gemini / local.
  3. **BYO-key model** -- the user pastes their own OpenAI API key in `Settings -> AI`. Lite has no OneReach-managed key proxy; v1 hits `api.openai.com` directly with `Authorization: Bearer <userKey>`.
  4. **Narrow v1 surface** -- `tts(req)` + `chat(req)` + `status()` + `configure(config)` + `onEvent(handler)`. NO `vision`, `embed`, `transcribe`, `imageGenerate`, `json` mode, or profile system in v1. Add when a consumer demands it.
  5. **`CredentialsProvider` abstraction** mirroring `lite/neon/credentials.ts` (ADR-033) -- `KVAiCredentialsProvider` is the production default; `StaticAiCredentialsProvider` is the test default. Forward-secure swap point: A1 swaps for a `KeychainCredentialsProvider` (mirroring `lite/totp/store.ts`); A2 adds a `BearerCredentialsProvider` for org-managed keys -- no consumer changes either way.
  6. **API key never logged or returned** -- `status()` returns `hasApiKey: boolean`; the Settings form starts empty even when one is saved (paste-only to overwrite; type `clear` to delete). Token / completion counts + HTTP status codes log; raw text input / output does NOT log.
  7. **TTS audio crosses IPC as base64** -- Electron IPC can't cleanly transport `Uint8Array` across the boundary on all versions; main encodes once, renderer decodes via `atob`. The wire cost is negligible relative to the audio payload itself.
- **Why centralize now** (vs inline in AI Run Times): the full app learned this lesson the hard way -- when the OpenAI API key handling, retry logic, and rate-limit handling lives in 5 places, every fix is 5 fixes. Adding `lite/ai/` once costs ~600 LOC; the second AI consumer (Spaces summarization, etc.) is then free.
- **Why OpenAI only**: TTS quality at the price/latency point the full app ships at is OpenAI's `tts-1`. Anthropic doesn't have TTS. Gemini's TTS is gated. Local TTS (Coqui, Piper) ships large model files. v1 picks the simple, working answer; A3 layers in providers when there's actual demand.
- **Why BYO-key**: a OneReach-managed key proxy is significant infrastructure (rate-limit-per-user, billing attribution, abuse prevention). Lite's pilot users are technical -- they have OpenAI accounts. A2 (org-managed bearer tokens via OneReach) is the path when Lite expands beyond developers.
- **Why no profile system in v1**: profiles (`fast` / `standard` / `powerful`) are useful when there are multiple providers / models to dispatch across. With one provider the profile dropdown is noise. Add when the second provider lands.
- **Consequences**:
  - +1 module of ~600 LOC (`lite/ai/`), ~400 LOC of test, ~70 LOC of preload bridge + types.
  - One new Settings section (`Settings -> AI`).
  - One new KV collection (`lite-ai-config`).
  - All future AI features in Lite go through this surface -- no exceptions, no exemptions.
  - Forward-compat is named (A1 keychain, A2 bearer, A3 multi-provider, A4 cost tracking) so future work has clear seams.
- **Files** (~600 LOC):
  - Source: `lite/ai/{api,client,credentials,errors,events,main,types}.ts` + `README.md`
  - Wiring: `lite/preload-lite.ts` (window.lite.ai bridge), `lite/lite-window.d.ts` (types), `lite/main-lite.ts` (initAi + teardown), `lite/settings/sections/ai.ts` + section registration
  - Tests: `lite/test/unit/{ai-api, ai-client}.test.ts` + `event-name-conformance` AI extension; `lite/test/integration/typed-onevent.test.ts` AI block + `event-coverage.test.ts` AI block
- **Patterns rejected**:
  - **Direct `fetch()` in `ai-run-times/feed-renderer.ts`** -- rejected: API key would have to cross to the renderer, breaking ADR-019 ("renderers never see secrets"); also burns the full-app lesson.
  - **OneReach-managed key proxy** -- considered but rejected for v1; see "why BYO-key" above.
  - **Full profile system today** (matching full app's `fast`/`standard`/`powerful`) -- rejected as YAGNI for one provider.
  - **Vision / embedding / transcription methods** -- rejected: no consumer needs them yet; adding them now means designing the surface without a real call site to validate against.
  - **Streaming chat completions** -- rejected for v1: AI Run Times wants whole-chunk audio; streaming chat is a separate consumer that doesn't exist yet.
  - **API key in OS keychain (A1) for v1** -- considered but rejected to keep scope tight; the swap is named in the roadmap and the `CredentialsProvider` abstraction pre-buys it.
  - **Per-call cost tracking** (full app has `lib/budget-tracker.js`) -- rejected: needs a `lite/budget/` module that doesn't exist; the `feature` parameter is plumbed end-to-end so the cost layer can attach without changing call sites.
- **Process lesson**: Two consumers triggered this module (AI Run Times today + Voice Orb / Spaces tomorrow). When the second consumer of an external service arrives, do NOT inline the second integration -- promote to a module first, then port both over. ADR-033 (Neon) made this call ahead of the second consumer; ADR-040 makes it AT the second consumer's arrival. Both work; ahead-of-time is cheaper if you can predict the consumer.

## ADR-041: AI Run Times v1 -- full feature parity port (reader + TTS playlist + reading log + OAGI-ready feed sources)

- **Status**: accepted, in force
- **Date**: 2026-05-04
- **Context**: ADR-039 deferred AI Run Times to "open uxmag.com in the Learning Browser" and named the Flipboard-style feed UI as a follow-up chunk. User asked for "AI Run Times working well, all features." The full app's `Flipboard-IDW-Feed/uxmag.html` is a ~6800 LOC application (3500 of script, 2200 of CSS, 360 of HTML, plus preload + main + service worker). It includes RSS fetching, article overlay reader, content preferences, reading log + JSON export, persistent caching, content-script generation, and a TTS audio playlist with prev/next/queue/playback bar.
- **Decision**:
  1. **Port the full feature set** (reader + preferences + reading log + persistent cache + TTS playlist) into a single Lite-shaped module: `lite/ai-run-times/`. ~2500 LOC of TS + ~600 LOC of CSS in Lite vs ~6800 in the full app -- the savings come from dropping Twitter embeds, Font Awesome, the service worker, dual-store persistence, and the localStorage-and-disk-and-cache hybrid in favor of one KV blob.
  2. **Dedicated reader window** (`ai-run-times.html`) -- 1400x900 single-instance BrowserWindow with the standard Lite preload. Routed from the Agentic University menu's "AI Run Times" item; replaces the v1 `shell.openExternal` placeholder.
  3. **Single KV blob** (`lite-ai-run-times` / `default`) holds feed sources, preferences, articles cache (capped 200), and reading log (capped 1000). Atomic writes; no second JSON file (avoiding the full app's drift bug between localStorage + cache + disk reading log).
  4. **Main-process RSS fetching + Readability-style article extraction**. Renderer NEVER fetches third-party content (CSP `connect-src 'self'`); main process handles redirects (up to 5), 15s timeout, named + numeric HTML entity decoding, RSS 2.0 + WordPress `content:encoded` parsing, `<article>`/`<main>`/known-content-class extraction.
  5. **TTS via `lite/ai/`** (not direct OpenAI calls). Per-article "Listen" button adds to the queue; long articles auto-chunk on sentence boundary at ~3500 chars; first chunk plays immediately while remaining chunks generate in the background; Audio Blob URL revoked on cleanup (fixes a known memory leak from the full app's implementation); queue auto-advances; finished article marks `listenedToCompletion: true` in the reading log.
  6. **Welcoming-on-empty-state**: when there are no cached articles (first open), the reader auto-refreshes the default uxmag feed silently. Subsequent opens show cached articles immediately.
  7. **Reading log download** as JSON (matches full app feature). `URL.createObjectURL` + anchor-click instead of full app's filesystem-write-then-open hack -- cleaner and fewer IPC roundtrips.
  8. **Forward-compat seams** named in the README's hardening roadmap: R1 (OAGI-driven feed sources), R3 (Atom / JSON Feed parsers), R4 (reading position memory), R5 (cross-device reading log via OAGI), R6 (audio script generation).
- **Why port everything in one chunk** (vs phased): the full app's reader is widely used and the user explicitly asked for "all features." Phased ports leave users in a worse state than the full app for weeks; one larger chunk has clear scope and a single ADR.
- **Why a dedicated window** (vs reusing the IDW or Learning Browser placeholder): the reader needs CSP `media-src` for audio Blobs, `sandbox: false` for Audio API, and the Lite preload for `window.lite.ai.tts(...)`. The Learning Browser is sandboxed + no-preload (third-party content); the IDW placeholder is sandboxed + no-preload too. Different needs -> dedicated window with its own security profile.
- **Why single KV blob** (vs separate collections): the full app has separate stores for articles cache + preferences + reading log + audio cache index, and the dual-write between localStorage + disk has caused user-reported "I lost my reading history" issues. One blob with atomic writes is the v1 simplification.
- **Why TTS through `lite/ai/`** (vs inline): see ADR-040. The second consumer of OpenAI is exactly when the centralized service has to land.
- **Why chunked TTS at 3500 chars** (vs full-article in one call): OpenAI TTS caps input at 4096 chars. Articles routinely exceed this. Splitting on sentence boundary preserves naturalness; first-chunk-plays-while-rest-generate gives instant feedback for huge articles.
- **Why hand-curate the default feed** (just uxmag for v1): same logic as ADR-037 / ADR-039 -- baked-in working defaults beat empty state. Future Settings section + R1 (OAGI-driven) handle the user-add and org-managed cases.
- **Consequences**:
  - +1 module of ~2500 LOC (`lite/ai-run-times/`), ~600 LOC of CSS, ~400 LOC of test, ~150 LOC of preload bridge + types.
  - One new dedicated reader window class.
  - One new KV collection (`lite-ai-run-times`).
  - One new top-level menu entry (the existing `Agentic University -> AI Run Times` rewires from "open uxmag.com in the Learning Browser" to "open the dedicated reader window" via `onOpenEntryOverride` in `main-lite.ts` -- keeps `lite/university/` from depending on `lite/ai-run-times/`).
  - The Flipboard-style polish becomes Lite's first reading-experience reference; future readers (Spaces RSS view, IDW conversation transcripts) can copy the pattern.
- **Files** (~2500 LOC across 11 new files + wiring):
  - Source: `lite/ai-run-times/{api,fetcher,store,errors,events,main,window,types,feed-renderer}.ts` + `feed.html` + `feed.css` + `README.md`
  - Wiring: `lite/preload-lite.ts` (window.lite.aiRunTimes bridge), `lite/lite-window.d.ts` (types), `lite/main-lite.ts` (initAiRunTimes + teardown + University menu override), `lite/esbuild.config.mjs` (ai-run-times.{html,css,js} bundle)
  - Tests: `lite/test/unit/{ai-run-times-api,ai-run-times-store,ai-run-times-fetcher}.test.ts` + `event-name-conformance` AI Run Times extension; `lite/test/integration/typed-onevent.test.ts` AI Run Times block + `event-coverage.test.ts` AI Run Times block
- **Patterns rejected**:
  - **Direct port of full app's renderer** (Twitter embeds, Font Awesome, service worker, in-renderer fetch) -- rejected: too much surface, non-essential dependencies, and the in-renderer fetch breaks Lite's CSP posture.
  - **Inline OpenAI calls in `feed-renderer.ts`** -- rejected: see ADR-040.
  - **`localStorage` for preferences / reading log** -- rejected: ADR-020 picks KV as the canonical persistence; localStorage drift is the bug we're avoiding.
  - **Render in main app's existing `tutorials.html` style** -- considered: would have visually unified Quick Starts + AI Run Times. Rejected: AI Run Times has a fundamentally different interaction model (read in-place + listen + queue) than tutorial cards; sharing CSS would constrain both.
  - **Open-original via `shell.openExternal`** -- considered. Rejected: `<a target="_blank">` with Electron's default external-link handling is identical UX with one less IPC round-trip.
  - **Per-feed dedicated cache collection** -- rejected: see "single KV blob" above.
  - **Full audio-script generation in v1** (full app uses GPT to restructure articles into podcast-style scripts before TTS) -- rejected for v1; named as R6. Reads articles verbatim today; the chat-based restructuring lands when `lite/ai/`'s chat method has matured under more consumers.
  - **Per-IDW partition for the reader window** -- rejected: AI Run Times has no per-feed login state; sharing the standard partition is correct.
- **Process lesson**: When porting a feature with both reading and AI components, port the AI service first (ADR-040), THEN port the feature (ADR-041). The reverse -- inlining AI calls in the feature first, refactoring to a service later -- means the second consumer pays for both jobs. Two-consumer-rule still applies: don't promote to a module until you have a second concrete consumer; here the predicted second consumer (Voice Orb / Spaces) made the case.

---

## ADR-042: Token persistence + per-tab injection (amends ADR-026)

- **Date**: 2026-05-05
- **Status**: Accepted (amends ADR-026's "tokens never persist across restarts")
- **Context**: Two related user-reported bugs traced to the same gap:
  1. **First-tab login asks the user to pick an account.** The full app's IDW agents (e.g. Marvin at `idw.edison.onereach.ai`) never show a picker on first open because `multi-tenant-store.js:659-856` injects the captured `mult` cookie into the per-tab partition before the agent navigates. Lite shipped without that injection (ADR-038), so each new tab's partition started cold and the agent fell back to its own picker.
  2. **Login tokens lost on restart.** ADR-026 explicitly held tokens in memory only -- a deliberate security-trade decision. After app restart, `tokenBundles` was empty even when the persisted `AuthSession` had rehydrated from KV. The user had to re-sign-in just to get the token back in memory; no IDW tab could be opened in a recognized state until they did.
- **Decision**: Land both fixes as one minimum-viable port of the full app's token-injection pipeline, scoped tight enough that we don't pull in `multi-tenant-store.js`'s 870 LOC.
  1. **Tokens persist via the auth partition's cookie jar, not a new on-disk file.** `lite/auth/window.ts` already opens the auth window with `partition: persist:lite-auth-<env>`. Electron's `persist:` partitions write cookies to disk by default. Lite was just not reading them back. `AuthStore.runHydrate()` now probes `session.fromPartition('persist:lite-auth-<env>').cookies.get({ name: 'mult', domain })` after loading the `AuthSession` records, repopulating the in-memory `tokens` and `tokenBundles` map. **No new disk write, no keychain entry, no encryption layer.** The trade-off vs ADR-026: tokens DO persist across restarts (until the cookie itself expires), but only inside Electron's per-partition cookie jar, which is the same place the full app keeps them. ADR-026's stricter stance is amended -- the security ceiling we pretended to enforce was illusory because Electron persisted the cookies anyway.
  2. **Injection helper on `AuthApi`.** `injectTokenIntoPartition(env, partition)` reads the in-memory `mult` token (or falls back to the auth partition probe), then `cookies.set()`s it on the target partition's session for both the env's UI domain (`.edison.onereach.ai`) and API domain (`.edison.api.onereach.ai`). Soft-fails on every failure mode -- `no-token`, `expired`, `unsupported-env`, `cookie-write-failed` -- so the IDW tab's `loadURL` never blocks on auth state.
  3. **Pre-navigate hook in `lite/main-window/window.ts:attachTab`.** Before each tab's first `loadURL`, detect the env via `getEnvironmentForUrl(tab.url)`. If matched, `await getAuthApi().injectTokenIntoPartition(env, tab.partition)`. Third-party agents (no env match) skip this step entirely -- security posture preserved.
  4. **Granular trace events.** Per the user's debugging request, the auth flow now emits typed events at every interesting point: `auth.window.opened` / `nav-start` / `nav-finish` / `nav-fail` / `title` / `closed`, `auth.cookie.captured` (with `via: cookie-event | probe`), `auth.persist.ok` / `persist.fail`, `auth.inject-token.start/finish/fail`. The lite event stream now tells the whole story of an auth attempt -- which page is opened, every redirect, page-load timings, the moment each cookie is captured, persist outcome, and any subsequent token injection into a tab. Cookie *values* never enter event payloads; only `valueLength` and metadata. The conformance test enforces start/finish/fail completeness.
  5. **CSP-warning suppression.** Setting `process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'` early in `main-lite.ts`. Lite's own windows all set strict CSPs (verified by grep); the warnings were exclusively from third-party agent renderers (ChatGPT, Claude, etc.) using `unsafe-eval`, which we cannot control. The suppression is dev-only -- packaged builds don't show these warnings either way -- and a comment at the call site documents the regression-detection grep for lite-owned windows.
- **Renderer trust posture**: unchanged. `injectTokenIntoPartition` is main-process only; not bridged to the renderer. The chrome (tab bar) sees only `getTokenBundle` shape via its existing renderer surface, with cookie *values* gated through `lite/auth/main.ts`'s "token reveal" handler.
- **Consequences**:
  - **First IDW tab open recognizes the user immediately.** The picker appears only when no captured token is available (user hasn't signed in yet) or the token has expired.
  - **Token survives app restart** for as long as the cookie's `expirationDate` allows. Today the OneReach `mult` cookie expires after the standard session lifetime; lite no longer prompts for a new sign-in inside that window.
  - **Sign-out still works correctly.** `signOut(env)` already removes the cookies from `persist:lite-auth-<env>` -- after sign-out, hydrate has nothing to recover, so injection naturally returns `no-token`.
  - **Cross-account isolation preserved.** Each per-tab partition still gets its OWN cookie set on injection. Two tabs of the same IDW (in a future v2 that relaxes ADR-038's dedupe rule) would inherit the same `mult` token but maintain independent session state for everything else.
- **Files** (~600 LOC delta):
  - `lite/auth/store.ts` -- `recoverTokenBundleFromAuthPartition`, `probeAuthPartitionCookie`, `injectTokenIntoPartition`, `getEnvironmentForUrl`. Wires `eventEmitter` through to window factory.
  - `lite/auth/window.ts` -- emits `auth.window.opened/nav-start/nav-finish/nav-fail/title/closed` via the threaded emitter; tracks per-navigation timing.
  - `lite/auth/events.ts` -- new typed events for inject-token span + window lifecycle + cookie capture + persist outcome; discriminated union extended.
  - `lite/auth/api.ts` -- exposes `injectTokenIntoPartition`; re-exports `getEnvironmentForUrl`, `isOneReachDomain`, `extractEnvironment`, `cookieDomainMatchesEnv` for cross-module use.
  - `lite/main-window/window.ts` -- `prepareTabAndLoad` calls injection before `loadURL` for OneReach URLs.
  - `lite/main-lite.ts` -- `ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'` with explanatory comment.
  - `lite/test/unit/auth-store.test.ts` -- `FakeCookieJar.set/flushStore`; new tests for hydrate-rehydrates-token, inject-writes-correct-domains, inject-rejects-expired, inject-soft-fails-on-write-error.
  - `lite/test/unit/auth-api.test.ts` -- `injectTokenIntoPartition` added to the conformance contract + stub.
- **Patterns rejected**:
  - **Encrypted on-disk token store** (full app's `multiTenantTokens` JSON via `settingsManager.set`) -- rejected: re-uses existing partition cookie jar instead. Same security posture, half the LOC, no new threat-model entry.
  - **Cookie listener for auto-recapture on rotation** -- considered: the full app re-injects to all active partitions when `mult` rotates mid-session. Rejected for v1: lite hasn't shipped long-running session telemetry yet, so we don't know if mid-session rotation is a real failure mode. Will add as v2 if pilot users report drop-outs.
  - **`accountId` injection** (the full app does NOT inject account binding either -- only `mult`). The agent picks up the user from the API token, then prompts for account selection on first arrival if the user has multiple. v1 mirrors that exactly.
- **Process lesson**: ADR-026's "tokens never persist" was honest about intent but blind to the underlying mechanism -- Electron persisted the cookies regardless of whether we read them back. The fix wasn't a security regression; it was just reading the disk we were already writing to. Worth checking before adding new persistence layers: "is the platform already storing this for us?"

---

## ADR-043: Domain event bus -- pub/sub layer on top of the logging queue

- **Date**: 2026-05-05
- **Status**: Accepted
- **Context**: Lite already has a central pub/sub primitive in `lite/logging/api.ts`: `event(name, data, level)` for emission, `onEvent(pattern, handler)` for glob-matched subscription, `recent(pattern, limit)` for snapshot reads. Every module also exposes a typed `onEvent` helper per ADR-032 -- `getAuthApi().onEvent(...)`, `getMainWindowApi().onEvent(...)` -- with category-level type narrowing. Two real gaps remained:
  1. **Domain events vs. internal event names.** Today, "user signed in" is a sequence of `auth.signIn.start` -> `auth.window.opened` -> ... -> `auth.signIn.finish` + `auth.persist.ok`. A subscriber that wants to react to "user signed in" has to know which one of those raw names is the canonical signal -- coupling them to auth's internals. Same problem for "tab opened", "update downloaded", "idw installed", etc.
  2. **Renderer access + late-subscriber replay.** `onEvent` is main-process only; `window.logging.recent` is async snapshot, not subscribe. So a window opened mid-flight misses events that already fired. Each module independently does its own `webContents.send` broadcast (e.g. `lite:idw:changed`) -- no unified surface.
- **Decision**: Ship a new `lite/event-bus/` module that **sits on top of** the logging queue (does not replace it) and adds:
  1. **Typed `DomainEvent` catalogue** -- a discriminated union (`user.signed-in`, `user.signed-out`, `agent.tab.opened/closed/activated/focused`, `token.injected`, `update.available/downloaded`, `idw.installed`, `bug-report.submitted`). The shape is the public contract; adding/changing entries is an ADR-worthy change.
  2. **Pure translator** (`translator.ts`) -- a rules table mapping raw `EventRecord` -> `DomainEvent | null`. No I/O, no state. Each rule has `match` + `project`. Rules deliberately project on `.finish` (success) span variants, not `.start` -- domain events represent OUTCOMES.
  3. **Ring buffer + KV mirror** (`store.ts`) -- in-memory bounded buffer (200 events) backed by a debounced (500ms) write to KV (`lite-event-bus / default`). On boot, `hydrate()` rehydrates the buffer so renderer subscribers using `{ replay: true }` immediately after launch see history from the previous session. Per the user's choice, persistence is durable, not in-memory-only.
  4. **Subscription surface as the public API** -- per the user's amend: `on(name, handler)`, `onPattern(glob, handler)`, `recent(name, limit)`, `size()`, `emit(event)` ARE the API (not internal helpers buried in store). Bridged to renderers via `window.lite.events.*` as a first-class namespace alongside `window.lite.idw`, `window.lite.mainWindow`, etc.
  5. **Opt-in replay** (per the user's choice) -- `on(name, handler)` is future-only by default; pass `{ replay: true }` to synchronously deliver matching events from the buffer first, then future events. Mirrors how `lite/idw`'s `onChange` works.
  6. **Cross-window broadcast** -- main-process subscribes once (via `onPattern('*')`) and relays every domain event to every open BrowserWindow via `webContents.send('lite:event-bus:event', ...)`. A preload-side fanout walks the registered renderer subscribers and dispatches by name. Renderers and main thus share one mental model.
  7. **Audit trail** -- every translation emits an `event-bus.translated` log event; persist outcomes emit `event-bus.persist.ok` / `persist.fail`; hydrate emits a span. The bus skips its own category when ingesting from the queue, preventing translation loops. Standard `/logs` view shows when each domain event fired and from which raw cause.
- **Renderer trust posture**: same as the existing `window.logging.recent` and `window.lite.idw.onChange` surfaces. A renderer-driven `emit()` is allowed but the main-process IPC handler validates `name` against the `DOMAIN_EVENT_NAMES` allowlist before pushing -- a renderer cannot inject arbitrary event names. The `data` payload is passed through unchecked (renderer-validated; no security boundary).
- **Consequences**:
  - **Decoupling.** Auth doesn't know who listens; main-window doesn't know what auth emits. Subscribers ask for `user.signed-in`, not `auth.signIn.finish`. The translator is the single point where the projection lives; everything else flows from it.
  - **Late subscribers solved.** A renderer that subscribes mid-flight can pass `{ replay: true }` and immediately see the most-recent matching events. `recent()` gives explicit snapshot reads. KV persistence carries the ring buffer across restarts.
  - **Type-safe end-to-end.** `on('user.signed-in', d => d.data.accountId)` -- TS narrows `data` based on the discriminator. The conformance test enforces every domain event name has at least one rule and every rule emits a known name.
  - **Auditable.** No invisible bus traffic: every translation, persist, and IPC entry surfaces in `/logs`.
- **Files** (~1,300 LOC across 7 new + ~25 LOC of edits):
  - Source: `lite/event-bus/{api,store,translator,types,errors,events,main}.ts` + `README.md`
  - Wiring: `lite/preload-lite.ts` (window.lite.events bridge with renderer-side glob match + replay), `lite/lite-window.d.ts` (LiteEventBusBridge), `lite/main-lite.ts` (initEventBus before initAuth)
  - Tests: `lite/test/unit/event-bus-{api,store,translator}.test.ts` + api-docs-manifest catalogue extension
- **Patterns rejected**:
  - **Replace the logging queue with the bus** -- rejected: the queue has its own correctness contract (ring buffer, glob `recent`, span lifecycle). Layering preserves the existing surface and lets any module emit raw events without knowing about domain projections.
  - **Auto-replay for every subscription** -- rejected per the user's choice. Default future-only avoids surprising double-handling for subscribers that maintain their own state machine; opt-in replay is explicit when you actually want it.
  - **In-memory-only ring buffer** -- considered. Rejected per the user's choice in favor of KV persistence: cross-restart replay is concretely useful for boot-time UIs (e.g. a renderer panel that wants the last few "user.signed-in" events without re-running the auth flow). Persist cost is bounded (200 events, ~50KB at most) and the debounce keeps writes under one per 500ms.
  - **Per-event-name preload listeners** (a separate IPC channel per name) -- rejected: simpler to send one event over `lite:event-bus:event` and dispatch in preload. Renderers register N handlers on M patterns without N*M IPC subscriptions.
  - **`emit` returns void** -- considered. Rejected: returning the enriched `DomainEvent` (`{ id, ts, ... }`) lets the caller correlate with logs and retry safely; no extra round-trip.
  - **Schema versioning machinery for the persisted blob** -- deferred to v2. The blob shape is `{ schemaVersion: 1, events }`; future schema bumps will add explicit migration steps. v1's `isLikelyDomainEvent` filter is permissive enough that a future shape change drops the old blob safely instead of crashing.
- **Process lesson**: when the user said "watch the event log and emit events other systems can listen for", 80% of that primitive already existed in `lite/logging`. The valuable layer was the *projection* (raw -> domain) and the *contract surface* (subscription as a first-class API). Building on top of an existing pub/sub instead of next to it kept the diff small and the audit trail intact.

---

## ADR-044: Lite KV transport via `@or-sdk/discovery` + `@or-sdk/key-value-storage`

- **Date**: 2026-05-05
- **Status**: Accepted
- **Context**: `lite/kv/` originally hit a hardcoded anonymous Edison flow URL (`https://em.edison.api.onereach.ai/http/.../keyvalue`) with no authentication. Every Lite install on every Mac wrote into the same shared bucket -- whoever wrote last won. When Rich cloned the repo and ran Lite for the first time, he saw the user's IDW menu, tabs, and account-id-shaped state from a sign-in he never performed. The interim fix yesterday added an `edison:<accountId>` client-side key prefix to two stores (idw, main-window), but five other collections (`lite-bugs`, `lite-neon-config`, `lite-ai-config`, `lite-event-bus`, `lite-event-bus`) still used the unscoped `default` key, and the underlying transport was still anonymous -- nothing actually proved the request came from the user whose accountId was in the key.
- **Decision**: Replace the anonymous Edison KV transport with `@or-sdk/key-value-storage` authenticated by the signed-in user's `mult` token, with the service URL discovered via `@or-sdk/discovery`. The OneReach KV service scopes records by `accountId` server-side (passed by the SDK on every request), so per-user isolation moves from "we hope the client puts the right prefix on the key" to "the server enforces the bucket". A new module `lite/discovery/` wraps the discovery SDK with the standard Lite shape (`api.ts` singleton, lazy 5-minute resolve cache, structured `DiscoveryError`); `lite/kv/sdk-client.ts` is a thin adapter that preserves the public `KVApi` surface (`set/get/listKeys/list/delete/onEvent`) so consumers (idw, main-window, bug-report, ai, neon) need ZERO changes. A one-shot `lite/kv/migration.ts` triggered from `main-lite.ts` on every `onSessionChanged('edison', session)` copies legacy blobs from BOTH layouts (per-account `edison:<accountId>` first, then global `default` fallback) into the user's authenticated namespace at `default`; idempotent via a `lite-migrations / migrated-from-default-v1` sentinel.
- **Consequences**:
  - **Multi-user isolation enforced server-side.** The bug Rich hit cannot recur. A user who has never signed in sees the kernel's empty state, not whoever last wrote to the shared anonymous bucket.
  - **Defense-in-depth gating.** Every store that touches KV (`idw`, `main-window`, `bug-report`, `neon`, `ai`) now accepts a `getActiveAccountId` resolver and returns empty / throws "sign in first" when no account is active, instead of falling through to a generic 401 from the SDK. Easier diagnostics, clearer UX.
  - **Existing pilot data preserved.** First sign-in after upgrade copies the legacy blobs into the user's bucket. Second sign-in is a no-op (sentinel found). New users start with an empty state and never see migration overhead.
  - **Cold-start latency.** First KV call per session pays a one-time ~200-500ms discovery resolve, then every subsequent call reuses the cached URL. Acceptable given the user-perceived "I just signed in" moment masks it.
  - **Forward seam for other SDKs.** Future ports needing `@or-sdk/flows`, `@or-sdk/users`, etc. layer in via `lite/discovery/api.ts` -- one more `getServiceUrl` call, no new infrastructure.
  - **Redundant client-side prefix removed.** The interim `edison:<accountId>` key prefix in `lite/idw/store.ts` and `lite/main-window/store.ts` is reverted to the singleton `'default'` key. Cache invalidation now tracks the active accountId rather than the key string; user-switch invalidation is preserved.
- **Files** (~1,000 LOC across new + ~150 LOC of edits):
  - New module: `lite/discovery/{api,store,events,types}.ts` + `README.md`
  - New transport: `lite/kv/sdk-client.ts`
  - New migration: `lite/kv/migration.ts`
  - Wiring: `lite/kv/api.ts` (default config), `lite/auth/types.ts` (`discoveryUrl` field), `lite/main-lite.ts` (onSessionChanged → migrate + invalidate cache)
  - Gating + prefix revert: `lite/idw/store.ts`, `lite/main-window/store.ts`, `lite/bug-report/store.ts`, `lite/neon/credentials.ts`, `lite/ai/credentials.ts` + their `api.ts` defaults
  - Tests: `lite/test/unit/discovery-api.test.ts`, `lite/test/unit/sdk-kv-client.test.ts`, `lite/test/unit/kv-migration.test.ts`, `lite/test/integration/kv-integration.test.ts` (rewritten)
- **Patterns rejected**:
  - **Keep the anonymous endpoint and just enforce client-side per-account keys** -- rejected: this is what yesterday's fix did and it left the door open for a malicious or buggy client to read another user's bucket by guessing accountIds. Server-side scoping is the only durable answer.
  - **Migrate by deleting the legacy data** -- rejected: pilots already have IDWs and tabs configured. Silent migration on first sign-in is the kindest UX; the legacy blob remains in the shared bucket as forensic evidence and gets cleaned up in a one-off pass post-pilot.
  - **Block sign-in on migration completion** -- rejected: migration runs in `void runKvMigration(...)` (background). Failures log a warning but never delay the user. The sentinel still gets written so failures don't keep retrying every sign-in.
  - **Replace the legacy `EdisonKVClient` outright** -- rejected: the migration module needs the legacy client to read the old anonymous endpoint. Keeping the class exported (with `@internal` discipline) is the right shape.
  - **Server-side migration triggered by the OneReach team** -- rejected: requires coordination with a server team and gives Lite no control over the per-install one-shot guarantee. Client-side migration scoped to the active accountId is self-contained.
- **Migration test coverage**: 9 unit tests guarding (a) sentinel honored on second sign-in, (b) per-account legacy → user `default`, (c) global `default` legacy → user `default` (when no per-account blob), (d) NO overwrite when user already has data, (e) clean install no-op, (f) idempotency, (g) no-account guard, (h) partial-failure tolerance (one collection fails, others copy, sentinel still written), (i) `COLLECTIONS_TO_MIGRATE` enumeration is exactly the four expected names.
- **Process lesson**: when an architectural fix to a shared resource lands, every existing collection living on that resource needs the same fix. The `gate-other-collections` step (bringing `bug-report`, `neon`, `ai` under the same `getActiveAccountId` resolver pattern as `idw` + `main-window`) was easy to forget but high-impact -- without it the leak resurfaces in a smaller window the next time someone forgets to gate a new module.

---

## ADR-045: Lite Files module via `@or-sdk/files` -- consumer-routed (no renderer bridge in v1)

- **Date**: 2026-05-05
- **Status**: Accepted
- **Context**: With KV moved to authenticated SDK transport (ADR-044), the next OneReach SDK Lite needed in-app was Files -- the per-account file storage backend. Two existing consumers had concrete need: (a) bug reports that today inline log dumps in the JSON payload (no place to attach screenshots / large logs), and (b) AI Run Times TTS, which regenerates audio from OpenAI on every replay (the in-memory `URL.createObjectURL(Blob)` leak from the full app's `Flipboard-IDW-Feed/uxmag.html` was already inherited and there's no cross-session cache). The Files SDK takes the same `{ token, accountId, discoveryUrl }` construction shape as KV, so per-user isolation is again server-side -- nothing new architecturally.
- **Decision**: Ship `lite/files/` as a new top-level module with the standard Lite shape (`api.ts` public singleton, `sdk-client.ts` `@internal`, `events.ts` typed surface per ADR-032, `errors.ts` structured codes). The public surface is the consumer-friendly subset of the SDK -- `upload / download / getDownloadUrl / get / list / createFolder / delete / deleteFolder / setTtl / setPrivacy / onEvent`. Auth is wired via the same `setFilesAuthBindings` indirection introduced for KV in ADR-044, so `lite/files/` does NOT static-import `lite/auth/` and dep-cruiser's `no-circular-in-lite` rule stays clean. Consumer integrations land in the same PR rather than as follow-ups so the seam is exercised end-to-end by real callers from day one.
- **Consequences**:
  - **Bug reports gain attachments without inflating the KV payload.** The payload carries `BugReportAttachment[]` (file references: key + name + contentType + size + uploadedAt), NOT the bytes. The bytes live in `lite-bugs/attachments/staging-<timestamp>/<safeName>` in the user's Files bucket, gated by their `mult` token and accountId server-side. Modal renderer picks a file -> base64 over `lite:bug-report:attach` IPC -> main decodes (10MB cap, sanitized filename, prefix-locked) and uploads -> returns the metadata for the renderer to collect before save. View-saved-bug uses `lite:bug-report:download-attachment` to resolve a fresh signed URL on demand.
  - **AI Run Times TTS becomes free on replay.** The renderer's `aiBridge.tts(...)` call is replaced with a new `lite:ai-run-times:cached-tts` IPC that hashes the chunk text + voice into a deterministic Files key (`ai-run-times/tts/<articleId>/<voice>-<sha1(text)>.mp3`), checks the cache first, and only generates via OpenAI on miss. Cached uploads carry a 30-day TTL so the user's bucket doesn't grow unbounded. Best-effort write -- if the cache upload fails, the user still gets the bytes (we already paid the OpenAI cost).
  - **The `setFilesAuthBindings` indirection mirrors `setKVAuthBindings`.** Tests for both now have the same shape; main-lite.ts has both bind calls back-to-back after initAuth. If we add a third SDK module (Bots, Flows, etc.), the same pattern repeats -- no new architectural decision needed.
  - **No renderer bridge in v1 (deliberate).** `window.lite.files.*` is NOT exposed. Renderers that need files go through their own module's IPC (the bug-report modal does this for attach/download). Reasons: (1) per-IPC validation / size caps / prefix locks live in one place per consumer (bug-report enforces a 10MB cap + prefix lock on download; a generic bridge would have to hardcode less safe defaults), (2) keeps the security review surface minimal until we have a real "user wants to upload arbitrary files" use case, (3) F1 hardening in the README documents the seam if it's needed later.
  - **Files-Sync deferred.** `@or-sdk/files-sync-node` (the "mirror a folder" engine `gsx-file-sync.js` uses) is heavier and serves a different mental model -- skipped for v1.
- **Files** (~1,200 LOC across 6 new + ~250 LOC of edits across 4 existing):
  - New module: `lite/files/{api,sdk-client,types,errors,events}.ts` + `README.md`
  - New tests: `lite/test/unit/files-api.test.ts` (20 tests) + `lite/test/integration/files-integration.test.ts` (12 tests) + 5 new tests across existing bug-report-{capture,store,api}.test.ts
  - Wiring: `lite/main-lite.ts` (`setFilesAuthBindings` after initAuth)
  - Consumer integration: `lite/bug-report/{main,store,capture,api,events}.ts` (attach + downloadAttachment IPCs, payload schema, summary count); `lite/ai-run-times/main.ts` (cached-tts IPC + cache-key helpers); `lite/test/unit/api-docs-manifest.test.ts` (add discovery + files to expected slugs); `lite/api-docs/manifest.generated.ts` (auto-regenerated)
- **Patterns rejected**:
  - **Renderer bridge `window.lite.files.*` in v1** -- rejected per the rationale above. Re-evaluate when a concrete consumer needs it.
  - **Bug-report attachment bytes in the payload** -- rejected. The current KV payload is JSON; encoding 10MB of base64 into it bloats the KV write 30%+ and forces every `list()` to download every report's bytes. Carrying file references keeps the payload small and lets the modal lazy-load attachments only when the user clicks "View".
  - **AI Run Times cache via KV** -- rejected. KV is for structured records, not blob storage. Caching MP3 chunks in KV would inflate the per-user blob to hundreds of MB and break the "one big JSON" assumption other code makes (see `lite/idw/store.ts` and `lite/main-window/store.ts`).
  - **Separate `setFilesAuthBindings` mechanism per module (e.g. cookie-style globals)** -- rejected. The setter pattern is the same one ADR-044 introduced for KV; making it identical means tests and consumers learn it once.
  - **Cache key without `voice` in the hash** -- rejected. Different voices produce different audio; without `voice` in the key, switching voices would replay the wrong audio from cache.
  - **Migrate existing bug reports to add empty `attachments: []`** -- rejected. The field is optional on `BugReportPayload` and `migrateLegacyPayload` doesn't synthesize it -- old reports continue to read cleanly, the modal just shows "0 attachments" implicitly.
- **Forward-compat seams (`F`-series, in `README.md`)**:
  - **F1**: per-renderer `window.lite.files.*` bridge -- adds a guarded IPC handler and updates `lite-window.d.ts` typings.
  - **F2**: `lite/files-sync/` wrapper around `@or-sdk/files-sync-node` -- different ergonomics, separate module.
  - **F3**: multi-env (`auth-multi-env` chunk lands first; files inherits per-env discoveryUrl + accountId from auth).
  - **F4**: resumable uploads -- the SDK's `uploadFileV2` is single-shot.
- **Process lesson**: shipping the seam without consumer integrations would have left the module untested in a real flow. Wiring bug-report attachments + ai-run-times TTS caching in the same PR caught two integration-level issues during development (the renderer-side base64 transport boundary, and the cache-write-must-not-throw rule for the TTS path) that pure unit tests on `lite/files/` couldn't have surfaced.

## ADR-046: First-run UX hardening -- OAuth popups stay in same partition + 2FA-needs-setup banner + onboarding checklist

- **Status**: accepted, in force
- **Date**: 2026-05-05
- **Context**: Initial-user UX audit identified five drop-off blockers (OAuth popups silently going to OS browser; TOTP autofill silently skipping when no secret; AUTH_CANCELLED showing nothing; "Open Two-Factor" link landing on Account; AI key dependency only surfaced after first Listen click) plus several discoverability problems. The user explicitly called out "Google login may not work because Electron blocks the popup" and "they may not have two-factor enabled on IDW so login may not require it" as the two friction points they wanted addressed. The fix needed to span auth window, IDW tabs, IDW placeholder, and the renderer surfaces.
- **Decision**:
  1. **OAuth popups stay in the opener's partition** via a shared `lite/auth/oauth-popup.ts` helper. `OAUTH_POPUP_ALLOWLIST` enumerates the well-known IdP origins (Google / Microsoft / Apple / Auth0 / Okta / GitHub / Atlassian / Slack / Zoom / OpenAI / Anthropic / X). `buildPopupHandler({partition, ...})` returns a handler that allows allowlisted URLs via `overrideBrowserWindowOptions.webPreferences.partition` (cookies land in the same jar) and routes everything else to `shell.openExternal` (the existing security posture, preserved for non-OAuth content).
  2. **`attachPopupLifecycle(parent, popup)`** auto-closes the popup when it navigates back to the parent's origin (OAuth callback completes) or the parent navigates away (post-auth landing), so the user isn't left with an orphaned popup window after sign-in.
  3. **Three popup-aware surfaces wired**: the OneReach auth window (`lite/auth/window.ts` -- `extraAllowPredicate` keeps `*.onereach.ai` allowed alongside the IdP allowlist), each main-window tab (`lite/main-window/window.ts` -- per-tab `persist:tab-<uuid>` partition), and the IDW placeholder fallback (`lite/idw/browser-window.ts` -- shared `persist:lite-idw-browser`).
  4. **Auth window parented** to whichever window has focus (`lite/auth/store.ts` default factory) so the auth window doesn't disappear behind Safari / VS Code / Slack on multi-monitor setups -- keeps first-time users from losing the sign-in flow.
  5. **2FA-needs-setup notification** when the autofill watcher detects a OneReach 2FA prompt AND `getCurrentCode()` throws `TOTP_NO_SECRET`. The `RuntimeState.needsSetupNotified` flag gates to one notification per `startTotpAutofill` call. The notification flows: `totp-autofill.ts` -> `AuthStore.twoFactorNeedsSetupSubscribers` -> `lite:auth:2fa-needs-setup` IPC broadcast -> `window.lite.auth.on2FANeedsSetup(handler)` -> contextual banner in chrome / placeholder with "Open Settings -> Two-Factor" button.
  6. **AUTH_CANCELLED surfaces a friendly hint banner** ("Sign-in window closed. Click Sign in to GSX to try again.") instead of silently flipping back to the bare button. `SignedOutHint` is now a discriminated union (`error` / `cancelled` / `twofa-needs-setup` / `null`); the renderer picks the right banner per case.
  7. **Two-Factor deep-links pass `'two-factor'`** so the contextual links go to the right Settings section. A `settings-deep-links.test.ts` lint test guards against regressions by scanning every renderer-surface `.ts` file for unscoped `settings.open()` calls.
  8. **AI key banner above the AI Run Times tile grid** -- on window open, calls `window.lite.ai.status()` and shows a one-line banner with "Open Settings" + Dismiss buttons when `hasApiKey === false`. Dismissal persists in `sessionStorage` so the user doesn't get re-nagged in the same session, but they DO get re-reminded next session (until they save a key, at which point the banner stops).
  9. **Settings -> AI promoted** above Updates so it's the 5th sidebar entry instead of the 7th. A small dot badge appears next to the AI section title when no API key is set, so the unfinished-setup signal is visible without entering the section.
  10. **IDW Add-form quick-add row** -- 5 buttons (ChatGPT / Claude / Gemini / Perplexity / Grok) at the top of the form. Click sets kind to `external-bot`, applies the preset's URL, focuses Save. The default kind stays `idw` (power-user path); the quick-add row is the obvious starting point for first-timers.
  11. **OAGI catalog distinguishes empty from malformed**: `lastRawRecordCount` captures the row count BEFORE `mapRecordToEntry` filtering. When `originalRows > 0 && mappedEntries === 0`, the renderer shows a "your administrator's nodes are missing required fields" empty state instead of the generic "no agents in your org yet" copy.
  12. **Onboarding checklist card** in the chrome home view: KV-backed via new `lite/onboarding/` module. Four steps (Sign in to GSX; save 2FA setup secret; add OpenAI key; open first agent). Auto-ticks as state changes (auth.onSessionChanged, mainWindow.onTabsChanged, focus poll for TOTP / AI). Hides when all four done OR explicitly dismissed.
  13. **Polish**: removed the static "v0.2 -- kernel" tagline (redundant with the dynamic version line); updated `main-lite.ts` header comment to describe the tabbed main window architecture (ADR-038 reality, not the old placeholder); added the missing Wiser Method menu item to `lite/university/menu-builder.ts` (the curated entry existed but wasn't registered, contradicting `PORTING.md`).
- **Why same-partition popups + allowlist** (vs allow-all): allow-all gives any third-party page in any tab the ability to spawn a child Electron window in the partition -- a meaningful surface for an attacker. The allowlist reduces that to "we trust these specific IdPs," which is the same trust model browsers apply to OAuth flows. Adding entries means a one-line edit to `OAUTH_POPUP_ALLOWLIST`.
- **Why the autofill notification is one-per-watcher** (vs per-frame): a OneReach 2FA prompt can render in nested frames with its own redirect chain; without dedupe the user could see five "needs setup" banners from one sign-in attempt. The `needsSetupNotified` flag is a tiny piece of state but a big UX improvement.
- **Why session-storage for AI banner dismissal** (vs KV): the dismissal is per-session UX preference, not a long-term setting. Re-reminding on next session is correct -- if the user dismissed-then-forgot, they'd never discover the dependency. Once they save a key, the banner stops permanently because `hasApiKey` becomes true.
- **Why a checklist card** (vs a tour or modal): tours fight the user, modals block the UI. A small card on the home view that ticks itself off is a passive, helpful signal. The user can dismiss it once it's stopped being useful. Forward-compat: more steps can append (e.g. "Add a feed source", "Configure Two-Factor").
- **Consequences**:
  - One new module (`lite/onboarding/`, ~400 LOC) + one new helper file (`lite/auth/oauth-popup.ts`, ~250 LOC) + diffs across 8 existing files.
  - Three new IPC channels (`lite:onboarding:*`).
  - One new broadcast (`lite:auth:2fa-needs-setup`).
  - Forward-secure: the OAuth allowlist is one place; future IdPs are one-line edits. The 2FA-needs-setup notification is one event; future "this feature isn't configured" prompts can use the same renderer banner pattern.
- **Files** (~2,400 LOC across ~30 files):
  - New: `lite/auth/oauth-popup.ts`, `lite/onboarding/{api,store,main,types}.ts`, plus 4 new test files (`oauth-popup.test.ts`, `settings-deep-links.test.ts`, `onboarding-store.test.ts`, `auth-twofa-needs-setup.test.ts`).
  - Modified (auth surfaces): `lite/auth/{window,store,main,api,totp-autofill}.ts`.
  - Modified (renderer surfaces): `lite/main-window/{chrome.ts,chrome.html,chrome.css,window.ts}`, `lite/placeholder.ts`, `lite/placeholder.html`, `lite/ai-run-times/{feed.html,feed.css,feed-renderer.ts}`, `lite/settings/settings.{ts,css}`, `lite/settings/sections/idws.ts`, `lite/idw/{browser-window,catalog-renderer}.ts`, `lite/university/menu-builder.ts`.
  - Wiring: `lite/preload-lite.ts`, `lite/lite-window.d.ts`, `lite/main-lite.ts`.
- **Patterns rejected**:
  - **Allow-all popups in opener partition** -- rejected: too broad an attack surface.
  - **Always pop a child window for ANY navigation away from `*.onereach.ai`** -- rejected: would break legitimate "open this article in your browser" use cases (Wiser Method links, Quick Starts, etc.).
  - **Show 2FA-needs-setup as a modal dialog** -- rejected: dialogs interrupt; banner is non-blocking and immediately actionable.
  - **Persist AI key banner dismissal in KV (forever-dismiss)** -- rejected: see "session-storage" reasoning above.
  - **Auto-open Settings -> Two-Factor when 2FA-needs-setup fires** -- rejected: the user is mid-sign-in; opening Settings on top of the auth window is hostile. The banner with an explicit Open button respects the user's flow.
  - **Onboarding tour** -- rejected for v1: tours are heavy to maintain and easy to dismiss without learning. Card-with-checklist is the lighter, equally-discoverable pattern.
- **Process lesson**: when an audit finds many small UX bugs that all stem from the same root cause (silent failures because nothing surfaces to the user), bundle the fixes into one chunk with a unifying theme. "Hardening" beats "drive-by patches" because the renderer banners + dot badge + checklist card all use the same visual language; users see them as a coherent product, not a series of one-off pop-ups.

## ADR-047: Slim lite bundle via explicit `node_modules` excludes + `npmRebuild=false`

- **Status**: accepted, in force
- **Date**: 2026-05-05
- **Context**: Lite shares `node_modules/` with the full app at the repo root because the strangler architecture (ADR-001) keeps both apps in one repo. Without overrides, electron-builder bundles every production dependency from the root `package.json` into the lite DMG -- which means lite ships ~240MB of native modules it never imports (better-sqlite3, canvas, sharp, ffmpeg-installer, ffprobe-installer, duckdb, the entire `@or-sdk/*` family, livekit, playwright, etc.). v0.0.2 weighed 283MB on disk and took ~8 minutes to build (and longer to upload to GitHub from a residential connection). For early distribution -- where a friend on a 4G connection might be the first downloader -- this was a discoverability disaster.
- **Decision**:
  1. **Explicit `!node_modules/<pkg>/**/*` excludes** in `lite/electron-builder.json`'s `files` array. The full app's root `package.json` lists ~55 production deps; lite needs exactly 4 of them (`electron-updater`, `otplib`, `jsqr`, `keytar`) declared in `lite/package.json`. The other ~51 are excluded explicitly. When the full app adds a new heavy dep, that dep MUST be added to the exclude list (or lite's bundle quietly grows). The exclude list is brittle but transparent -- a one-line regression is much easier to diagnose than a "magic" dependency-resolver mismatch.
  2. **`npmRebuild: false`** at the root of `lite/electron-builder.json`. Lite's only native runtime dep is `keytar`, which ships with prebuilt arm64 binaries (no source compile needed). Disabling `@electron/rebuild` saves the entire native-module rebuild step (~60-90sec per build). The full app keeps `npmRebuild: true` because it has many native deps that need recompilation against Electron's ABI.
  3. **Single source of truth for lite's deps + version is `lite/package.json`**. The release script (`lite/scripts/release-lite.sh`) bumps `lite/package.json`'s version, then invokes `lite/scripts/electron-builder-mac.mjs`. The runner reads `lite/package.json`, generates a merged `dist-lite/build-config.json` (extends `lite/electron-builder.json` with `extraMetadata.version` + `extraMetadata.dependencies`), and passes it to electron-builder via `--config`. The merged-temp-config indirection is necessary because electron-builder's flat CLI arg parser can't deserialize JSON object values at leaf nodes (`--config.extraMetadata.dependencies={...}` ends up as a STRING, which crashes the validator with "Cannot use 'in' operator").
  4. **`readLiteVersion()` in `lite/main-lite.ts` reads `lite/package.json` first** (bundled into app.asar, found at `__dirname/../../lite/package.json` in the packaged app). The defense check rejects the root `package.json` unless its `name` is `'onereach-lite'`, so lite never accidentally reports the full app's version even if path resolution drifts.
- **Why explicit excludes (vs an inverse `nodeModulesDirectories` pointing at a slim install)**: an inverse install means a separate `npm install` step in CI, a separate `node_modules/` tree on disk, and a divergence risk where lite's `node_modules` falls out of sync with full's lockfile. Explicit excludes use the existing `node_modules/` and only filter at packaging time -- one config file, no divergence. Cost: when full adds a new dep, someone has to remember to exclude it. Mitigation: the bundle-size sanity check in `release-lite.sh` (>150MB threshold) fires loudly if a heavy dep slips through.
- **Why `npmRebuild: false` is safe for lite (but not full)**: lite's runtime deps are 3 pure-JS (`electron-updater`, `otplib`, `jsqr`) + 1 native with prebuilds (`keytar`). The Electron framework version is pinned, so `keytar`'s prebuilt arm64/x64 binaries match the runtime. Full has ~10 native deps (better-sqlite3, canvas, sharp, etc.) that need ABI-matched recompilation against Electron's headers; disabling rebuild for full would corrupt those modules.
- **Why merged-temp-config (vs setting `directories.app: "lite"`)**: `directories.app: "lite"` would make electron-builder treat `lite/` as the app source root, which means electron-builder reads `lite/package.json` for production deps (lite's actual 4 deps -- exactly what we want) and `files` patterns become relative to `lite/` instead of the project root. But: `files` like `dist-lite/build/**/*`, `lib/**/*`, and asset paths like `assets/icon.icns` would all break. Each would need `../` prefixes; the maintenance cost was too high for the gain. The merged-temp-config approach keeps all paths working as-is.
- **Consequences**:
  - DMG: 283MB -> 165MB (-42%, -118MB).
  - Build time: 488s -> 118s (-76%).
  - GitHub upload time: 75 min hang -> 85 sec (residential connection).
  - First-time download for end users: roughly 4-7x faster on most connections.
  - The exclude list in `lite/electron-builder.json` is now a thing maintainers must update when full's dependencies change. The release script's bundle-size check (currently inline `if [ "$LITE_DMG_MB" -gt 150 ]` in `release-lite.sh`) catches regressions.
  - `keytar` is still bundled (520KB unpacked) -- it's the only runtime native dep lite uses and the only thing in `app.asar.unpacked/node_modules/` after the slim.
- **Files**:
  - Modified: `lite/electron-builder.json` (added `npmRebuild: false` + 47 exclude patterns), `lite/package.json` (added `dependencies` block as the source of truth), `lite/scripts/release-lite.sh` (now bumps `lite/package.json` and delegates to the runner), `package.json` (`lite:package:mac`/`:fast`/`:win`/`lite:publish:mac` scripts now invoke the runner).
  - New: `lite/scripts/electron-builder-mac.mjs` (the runner that generates the merged temp config and invokes electron-builder).
  - Auto-generated at build time: `dist-lite/build-config.json` (gitignored).
- **Patterns rejected**:
  - **`extraMetadata.dependencies` override alone** -- rejected: it changes ONLY the packaged metadata file (`app.asar/package.json`), not the actual file-copy step. electron-builder's bundler still scans the real `node_modules/` and copies everything matching the `files` filter. Verified via the v0.0.3 first-attempt build, which still came out at 283MB despite the override.
  - **`directories.app: "lite"`** -- see "merged-temp-config" rationale.
  - **A separate `lite/node_modules/`** -- divergence risk, doubled npm-install time, doubled disk usage.
  - **Inverse pattern (exclude all node_modules then re-include only keepers)** -- transitive deps would have to be listed manually too (electron-updater alone has ~12 transitives like builder-util-runtime, semver, lodash.escaperegexp, js-yaml, fs-extra, etc.). Explicit excludes scope to known heavy packages without needing to enumerate keeper transitives.
- **Process lesson**: "I'll add `extraMetadata.dependencies` and bundle size will drop" was a wrong-but-plausible mental model that cost ~8 minutes of build time to disprove. Always verify a slim claim by inspecting the packaged `node_modules/` directly (`du -sh dist-lite/mac-arm64/<App>.app/Contents/Resources/app.asar.unpacked/node_modules/*`) -- the real measurement, not the theoretical config.

---

## ADR-048: Lite Spaces Phase 3 -- writes + sharing + onboarding tour shipped as one bundled plan, seven independent chunks

- **Status**: accepted (plan-doc), pending implementation
- **Date**: 2026-05-13
- **Context**: Phase 1+2 of `lite/spaces/` ships read-only browse. The next slice has to deliver the demo loop end-to-end -- create a Space, file something into it, share it with a teammate -- because that's what teaches Spaces to a new user. The product question was: do we ship writes (Phase 3) and sharing as separate roadmap chunks, with onboarding stitched on later? Or bundle them into a single plan? Splitting fits the standard one-chunk-one-PR hardening discipline. Bundling preserves the demo-loop coherence -- writes alone don't teach the model, sharing alone has nothing to share, the tour alone has nothing to do. The first version of the plan bundled too aggressively (one phase, many sub-phases); the user critique was that "one phase" implicitly violated the per-chunk hardening contract and glossed over the real Edison dependencies for sharing.
- **Decision**:
  1. **Hybrid framing.** The plan is one strategic document for narrative coherence: cross-cutting concerns (Trust Principles, Measurement, Reversibility) live at the plan level, not duplicated per chunk. The hardening contract is per sub-phase: each of `spaces-3a` (Create / Rename / Delete), `spaces-3b` (Item creation seam), `spaces-3c` (Add to / Remove from Space), `spaces-3d` (Sharing UX), `spaces-3e0` (Tour prototype gate), `spaces-3e` (Tour code), `spaces-3f` (Recap + cleanup) ships as its own PR with its own [`lite/PORTING.md`](PORTING.md) entry.
  2. **Pre-plan dependencies on the critical path.** Two things block code start (not plan confirmation): (a) **Pre-A**: the item-source ADR (B1/B2/B3 -- which seam does the user use to author items?) ships in [`lite/DECISIONS.md`](DECISIONS.md) before any 3b code; recommended B1 (a new `lite/items/` module with `:AUTHORED_BY` provenance distinguishing user-authored from agent-produced). (b) **Pre-B**: the Edison D-series questions (D1-D7) about graph-level ACL semantics ship at [`lite/spaces/DISCOVERY-PHASE-3.md`](spaces/DISCOVERY-PHASE-3.md) and are sent to whoever owns Edison authorization in parallel with plan creation. Code in 3d cannot begin until D1-D4 return. The privacy review for the member-picker query ([`lite/spaces/PRIVACY-REVIEW-PICKER.md`](spaces/PRIVACY-REVIEW-PICKER.md)) ships before 3d code begins.
  3. **Trust Principles operationalized**, not asserted. The four principles from the existing Spaces plan (Suggest don't decide, Explainable, Reversible, Attributable) get a 4-row table per sub-phase showing how that sub-phase upholds each principle and naming the test that proves it. A new `lite/test/integration/spaces/trust-principles.test.ts` harness registers every Phase 3 mutation method alongside its inverse and fails the build if a mutation lands without one. This is the difference between "Reversible" as a slogan and "Reversible" as a CI gate.
  4. **Tour prototype gate (3e0) before tour code (3e).** The 90-second / 3-minute median + p95 claims are aspirational without evidence; 3e0 is a non-code prototype with 2-3 user tests that gates 3e. Skipping the gate ships a tour that COULD be 4 minutes p50 because step 4 was confusing and we didn't catch it. The cost of the prototype is one afternoon; the cost of skipping is permanent.
  5. **Tour entry from three places, not just empty state.** Empty-state CTA covers brand-new accounts. A permanent "How does this work?" button in the Spaces window header covers users who join an account with 50 existing Spaces (who arguably need orientation most). Settings -> Diagnostics "Replay" covers QA. The "users who already have Spaces" gap was the biggest hole in the v1 framing.
  6. **Cleanup-path failure matrix.** "Delete and start fresh" in 3f is multi-mutation (revoke shares, remove memberships, soft-delete items, soft-delete Space). The plan documents what UI shows when each step fails so the user is never left with worse state than starting over. Without this matrix, "delete and start fresh" can be the cardinal sin of an onboarding flow.
  7. **Measurement is first-class.** Tour ships with named events (`spaces.tour.start / .step.enter / .step.exit / .complete / .abandon`) for funnel analysis, not just span logging. Without these, we don't know which step kills people post-launch.
- **Consequences**:
  - Phase 3 is a multi-chunk multi-PR effort, sequenced via the dependency graph in the plan doc. No single PR ships "Phase 3."
  - Edison delivery cadence is on the critical path for 3d. Sending D1-D7 in parallel with plan-doc creation buys time.
  - The trust-principles harness lands as part of 3a (the first mutation chunk) so all subsequent chunks register against it; failure to register an inverse is build-red.
  - The tour prototype is gated by user-testing outcomes, not engineering velocity.
  - The plan doc itself is comparatively long, but cross-cutting concerns (Trust Principles, Measurement, Reversibility) are visible in one place rather than scattered.
- **Files**:
  - New: `.cursor/plans/lite_spaces_phase_3_writes_share_onboard_7e4c2a91.plan.md` (this trajectory's strategic doc)
  - New: `lite/spaces/DISCOVERY-PHASE-3.md` (Pre-B Edison D-series questions)
  - New: `lite/spaces/PRIVACY-REVIEW-PICKER.md` (member-picker privacy review)
  - New: `lite/test/integration/spaces/trust-principles.test.ts` (mutation/inverse harness, lands with 3a)
  - Modified: `lite/spaces/ROADMAP.md` (Phase 3 entry expands to writes + sharing + tour)
  - Modified: `lite/PORTING.md` (seven new chunks under Active Ports)
  - Modified: `lite/LITE-PUNCH-LIST.md` (intro-card / empty-state items collapse into "Phase 3 onboarding tour")
- **Patterns rejected**:
  - **One mega-PR for "Phase 3"** -- violates per-chunk hardening discipline; merge conflicts; impossible to review.
  - **Three separate plans (writes / sharing / tour)** -- splits cross-cutting concerns across docs; loses demo-loop narrative; Trust Principles get re-asserted three times instead of operationalized once.
  - **Skip the prototype gate, design the tour from intuition** -- v1 plan critique caught this: "median <= 90s" was made up, the prototype is the only way to know if the tour copy and step boundaries hold up.
  - **Tour from empty state only** -- excludes the user who joins an account with existing Spaces, who arguably most needs the tour.
  - **Approval queue + Librarian agents in this plan** -- they belong in Phase 4. Including them here drowns the 90-second demo loop in governance UX.
- **Supersedes**: nothing (extends the read-only foundation in [`.cursor/plans/spaces-manager-phases_5ab75078.plan.md`](../.cursor/plans/spaces-manager-phases_5ab75078.plan.md)).

---

## ADR-049: Item creation seam for Lite -- new `lite/items/` module with `:AUTHORED_BY` provenance

- **Status**: proposed (Pre-A blocker for ADR-048 Phase 3b)
- **Date**: 2026-05-13
- **Context**: Phase 3 of `lite/spaces/` requires the user to author and persist a `:Item` from the Lite UI -- step 2 of the onboarding tour ("Drop something into your Space") needs a real item to file. Today the entire mental model of `:Item` in OmniGraph is "something an agent or integration produced"; there's no Lite-side authoring path. The decision is which seam the user uses to author an item, and how the data model distinguishes user-authored items from agent-produced ones. The cost of getting this wrong is data-model fragmentation: if we add an authoring path for the tutorial only and remove it later, we leave a small population of `:Item` nodes with anomalous provenance; if we re-use existing seams (clipboard, IDW conversation, AI Run Times article) without unifying them, the user-authoring concept lives in three places at once.
- **Decision**: Adopt option **B1**: introduce a new `lite/items/` module with a narrow public API (`items.create`, `items.delete`, `items.undelete`, `items.get`, `items.list`) that creates `:Item` nodes with an `[:AUTHORED_BY]->(:Person)` edge to the current OneReach principal. The Cypher write attaches the principal at create-time in main process, not from renderer-supplied data, so the renderer cannot fabricate authorship. The module is generally available (not tour-scoped) so it can later host saved-from-clipboard, saved-from-IDW, and saved-from-AI-Run-Times consumers as those seams need it.
- **Rejected alternatives**:
  - **B2 -- re-use existing seams**: integration surface forks across three modules (clipboard, IDW, AI Run Times); none of them today produces `:Item` nodes with `:AUTHORED_BY`; bringing them all up to that contract is more work than introducing one canonical module. Also: the tour would need to teach the user three different "save into a Space" paths simultaneously, which fragments the demo.
  - **B3 -- tour assumes pre-existing items**: weakens the tour to "browse what someone else put there"; user never sees the create-and-file loop; doesn't demo what Spaces actually does in steady state. Acceptable as a graceful-degrade path if B1 is delayed, but not as the default.
- **Distinguishing user-authored from agent-produced**: the Phase 0.5 Q2 query revealed `:PRODUCED_BY` and `:AUTHORED_BY` are both already in the schema. Agents already use `:PRODUCED_BY`; humans use `:AUTHORED_BY`. The query in Phase 2 already projects whichever is present into the `producedBy` field on `ItemSummary`. No new schema work; just consistent use.
- **Consequences**:
  - New module `lite/items/` follows the standard module shape per [`PORTING.md`](PORTING.md): `api.ts`, `main.ts`, `store.ts`, `errors.ts`, `events.ts`, `contracts/`, `README.md`.
  - New error codes: `ITEMS_INVALID_KIND`, `ITEMS_TITLE_REQUIRED`, `ITEMS_TOO_LARGE`, `ITEMS_NOT_FOUND`, `ITEMS_FORBIDDEN`, `ITEMS_NOT_AUTHENTICATED`, `ITEMS_NOT_INITIALIZED`.
  - `ItemsApi` registered in the trust-principles harness with `create / delete-soft` and `delete-soft / undelete` as inverse pairs.
  - Renderer surface lives initially in the Spaces detail-panel composer; a generally-available "+" composer in the chrome (ahead of step 2 of the tour) is a follow-up chunk, not blocking Phase 3.
  - Forward-compat: future "save from clipboard / IDW / AI Run Times" features call `getItemsApi().create({ ... })` -- no new module per consumer.
- **Files**:
  - New: `lite/items/` module (Phase 3b chunk)
  - Renderer integration: `lite/spaces/spaces.ts` adds the "+" detail-panel composer
- **Test discipline**:
  - `items-api.test.ts` -- conformance contract per Rule 12 / ADR-024
  - `items-no-auto-create.test.ts` -- asserts no IPC fires `items.create` without a renderer trigger
  - `items-authored-by.test.ts` -- renderer-supplied principal cannot override the auth principal on create
  - `items-detail-attribution.test.ts` -- detail panel renders `:AUTHORED_BY` provenance line correctly
  - `trust-principles.test.ts` -- create -> delete -> undelete restores state
- **Open question**: ID strategy (server-issued vs client UUID). Tracked in Edison D-series question D8.

---

The chunk-failure-recovery release valve (Phase 2 entry) logs structured incident entries here -- one ADR per declared incident, with the two CODEOWNERS' sign-offs and the time-box.
