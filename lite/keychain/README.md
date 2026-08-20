# `lite/keychain/` — Keychain Traffic Control

Prevents the keytar teardown SIGABRT (ADR-075): every keychain call registers in one in-flight registry, and quit holds the door until the registry is empty — then a one-way fuse stops new calls from reaching keytar at all.

- **Public API**: [`api.ts`](api.ts) — `trackKeychainBackend()`, `trackKeychainCall()`, `pendingKeychainCalls()`, `drainKeychain()`, `armKeychainFuse()` / `keychainFuseArmed()`, plus the Rule 12 singleton (`getKeychainApi()`)
- **Tests**: [`../test/unit/keychain-quiesce.test.ts`](../test/unit/keychain-quiesce.test.ts) (behavior + require-site inventory + quit wiring), [`../test/unit/keychain-api.test.ts`](../test/unit/keychain-api.test.ts) (conformance)
- **Decision rationale**: [DECISIONS.md ADR-075](../DECISIONS.md#adr-075-keychain-traffic-control--quit-drains-keytar-before-node-teardown)

---

## The crash this prevents

Crash report `Onereach.ai Lite-2026-08-20-112705.ips`:

```
__cxa_throw                          ← keytar throws a C++ exception
keytar.node +26960 / +26708 / +21368
uv__work_done → uv_run
node::Environment::CleanupHandles()  ← ...while Node is tearing down
node::Environment::RunCleanup()
→ std::terminate → SIGABRT           ← macOS "quit unexpectedly" dialog
```

keytar runs every keychain call on the libuv threadpool. When the process starts quitting while one is in flight, Node's teardown drains the pool with the runtime half-dismantled; keytar's completion throws a C++ `Napi::Error`, nothing above native code can catch it, and the process aborts — an OS crash dialog for an app that was exiting on purpose. Same native-throw family as the 2026-08-12 keytar SIGABRT in the logging incident.

A native throw is uncatchable from JS, so the fix is traffic control, not exception handling.

## The three layers

1. **The registry** — every `require('keytar')` wraps the module in `trackKeychainBackend()` (a Proxy, so methods we never anticipated are covered too). Consumers: `auth/session-vault.ts`, `ai/key-store.ts`, `totp/store.ts`. A source-inventory test fails on any unwrapped require site — a fourth keytar consumer cannot silently reopen the crash window.
2. **The quit gate** (`main-lite.ts`) — `before-quit` and `will-quit` both consult `keychainQuitGate()`: pending calls hold the quit (`event.preventDefault()`), drain (2s cap per round, 3 rounds max across both checkpoints), then re-quit. Capped because the logging incident showed securityd can wedge for 45s+ — a quit that hangs is worse than a rare teardown abort.
3. **The fuse** — once `will-quit` passes its gate there is no checkpoint left, so `armKeychainFuse()` makes any later call reject immediately instead of reaching keytar. "Rejected and logged" beats "aborted the process and lost anyway". One-way; only a new process resets it.

## Signals

Once Chromium's browser main is up, it owns the POSIX sigaction for SIGTERM/SIGINT and routes them through Electron's normal quit — the gate runs. `process.once` handlers in `main-lite.ts` cover only the sliver before Chromium installs its handler. Verified live: SIGTERM at 0.45–2.5s after launch, 10/10 clean exits with both quit breadcrumbs, zero aborts (the pre-fix baseline aborted 5/5).

## Quit breadcrumbs

The gate writes one-line breadcrumbs to **stderr** (`[lite] quit: before-quit`, `[lite] quit(will-quit): draining N…`) because the async file logger races a quitting process and loses. When diagnosing a shutdown in the field, stderr is the record that survives.

## Out of scope

Mid-run keytar aborts (wedged securityd during normal operation) — that is a keytar-replacement conversation (the package is archived upstream), not a quit-path one.
