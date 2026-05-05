# Onereach Lite

A signed, notarized, auto-updating Electron desktop kernel that ships independently from the full Onereach.ai app while sharing only the `lib/` layer. Built with the [strangler pattern](DECISIONS.md#adr-001-same-repo-strangler-over-from-scratch-rewrite): start with a minimal kernel, port one feature at a time through a hardening contract, never rewrite from scratch.

This README orients new contributors and module consumers. Read it first.

---

## Quick links

- **Constitution**: [LITE-RULES.md](LITE-RULES.md) — the rules every PR is held to.
- **Module structure**: [PORTING.md](PORTING.md#module-structure) — how every module is shaped.
- **Decision log**: [DECISIONS.md](DECISIONS.md) — every architectural choice, with rationale.
- **Bug list**: [LITE-PUNCH-LIST.md](LITE-PUNCH-LIST.md) — open issues specific to lite.
- **Strategic plan**: `.cursor/plans/onereach_lite_strangler_build_*.plan.md`.

---

## Modules

Every lite module exposes a public typed API via `<module>/api.ts`. Consumers import only from there. See [Rule 11](LITE-RULES.md#the-rules) and [PORTING.md "Module Structure"](PORTING.md#module-structure).

| Module | Public API | Purpose | Status | Docs |
|---|---|---|---|---|
| [`logging/`](logging/) | [`logging/api.ts`](logging/api.ts) | Centralized logs + structured events + spans + in-process subscriptions. Every module's observability funnels through here. | Hardened | [`logging/README.md`](logging/README.md) |
| [`kv/`](kv/) | [`kv/api.ts`](kv/api.ts) | Key-value storage backed by the OneReach Edison KV flow. Generic — any module can use it. | Hardened | [`kv/README.md`](kv/README.md) |
| [`bug-report/`](bug-report/) | [`bug-report/api.ts`](bug-report/api.ts) | User-filed bug reports with mandatory redaction, KV-backed CRUD, modal UI. | Hardened | [`bug-report/README.md`](bug-report/README.md) |
| [`auth/`](auth/) | [`auth/api.ts`](auth/api.ts) | GSX sign-in v1 — opens auth window, captures `mult` / `or` cookies, persists session via KV. Edison only. Token stays main-process only. | Porting | [`auth/README.md`](auth/README.md) |
| [`totp/`](totp/) | [`totp/api.ts`](totp/api.ts) | OneReach 2FA authenticator — keychain-backed TOTP secret + live code window opened from `Tools -> Authenticator...`. Secret stays in keychain; user copies code into OneReach 2FA prompt. | Porting | [`totp/README.md`](totp/README.md) |
| [`health/`](health/) | [`health/api.ts`](health/api.ts) | Pull-based current-state snapshot of the app — open windows, sign-in status, TOTP / Neon configuration, recent error counts. Counterpart to the central event log. Attached to bug reports. Type cannot carry secrets. | Hardened | [`health/README.md`](health/README.md) |

Future modules (preferences, shell, spaces, idw) follow the same shape. See [`PORTING.md`](PORTING.md) "Active Ports" / "Deferred Queue".

---

## Consuming a module's API

The discipline is the same for every module:

```typescript
// 1. Import only from the module's api.ts -- never reach into store.ts,
//    main.ts, client.ts, etc.
import { getKVApi, KVError, KV_ERROR_CODES } from '../kv/api.js';
import { getLoggingApi } from '../logging/api.js';

// 2. Get the singleton.
const kv = getKVApi();
const log = getLoggingApi();

// 3. Wrap network operations in a span; errors are structured.
const span = log.start('settings.save', { key: 'theme' });
try {
  await kv.set('settings', 'theme', 'dark');
  span.finish({ ok: true });
} catch (err) {
  span.fail(err);
  if (err instanceof KVError && err.code === KV_ERROR_CODES.TIMEOUT) {
    return retry();
  }
  throw err;
}
```

For testing, every module exposes `_setFooApiForTesting(stub)` and `_resetFooApiForTesting()`. See [`bug-report/api.ts`](bug-report/api.ts), [`kv/api.ts`](kv/api.ts), and [`logging/api.ts`](logging/api.ts) for the canonical examples.

---

## Error handling

Every error a lite module surfaces extends [`LiteError`](errors.ts). One uniform shape across the whole kernel:

```typescript
import { LiteError, isLiteError } from '../errors.js';

try {
  await someLiteApi.doThing();
} catch (err) {
  if (isLiteError(err)) {
    // Stable code -- safe to branch on.
    if (err.code === 'KV_TIMEOUT') return showRetry();

    // Verbose, log-friendly.
    logger.error(err.formatForLog());
    // [KV_TIMEOUT] KV get timed out after 5000ms
    //   context: {"op":"get","collection":"lite-bugs","key":"x"}
    //   remediation: Check your network connection. ...
    //   cause: AbortError: aborted

    // Short, user-facing.
    toast(err.formatForUser());
    // "KV get timed out after 5000ms Check your network connection. ..."

    // Structured for IPC / JSON logging.
    sink.write(err.toJSON());
  } else {
    throw err; // not ours -- bubble up
  }
}
```

Every `LiteError` carries:
- **`code`** — stable string, namespaced by module (`KV_*`, `BR_*`, future `SETTINGS_*`)
- **`message`** — log-friendly description ("KV set failed: HTTP 500 from ...")
- **`context`** — structured fields (op, collection, key, status, body preview, etc.)
- **`remediation`** — short action-oriented hint ("Check your network and try again")
- **`cause`** — the underlying `Error` if this is a wrap

The full code catalog per module:
- Logging — [`logging/README.md` "Error catalog"](logging/README.md#error-catalog)
- KV — [`kv/README.md` "Error catalog"](kv/README.md#error-catalog)
- Bug-report — [`bug-report/README.md` "Error catalog"](bug-report/README.md#error-catalog)

**Where errors and events go**: every error and every event written via `getLoggingApi()` lands in the lite log queue at port 47392 and is automatically captured into bug reports' `recentLogs` field — so users filing bugs include causal context without any per-site instrumentation. See [`logging/README.md` "Bug-report integration"](logging/README.md#bug-report-integration-the-streams-payoff).

---

## Adding a new module

Follow the canonical shape recorded in [`PORTING.md` "Module Structure"](PORTING.md#module-structure). The short version:

```
lite/<module>/
  api.ts          # PUBLIC -- typed interface + getFooApi() singleton
  main.ts         # INTERNAL -- IPC handlers + lifecycle
  store.ts        # INTERNAL -- state / persistence (optional)
  contracts/      # zod schemas per IPC channel (Phase 0b enforces)
  README.md       # Per-module docs (this README links to it)
```

Required steps:

1. Copy [`bug-report/api.ts`](bug-report/api.ts) as the template — rename, swap types, drop unused methods.
2. Define module-specific error codes following the pattern in [`bug-report/store.ts`](bug-report/store.ts) (`BUG_REPORT_ERROR_CODES`) or [`kv/client.ts`](kv/client.ts) (`KV_ERROR_CODES`).
3. Make every error a subclass of `LiteError` (`FooError extends LiteError`). Re-export the class + codes from `api.ts`.
4. Add `<module>/README.md` documenting public surface, usage, error catalog. Link from this README's "Modules" table.
5. Register a port-status block in [`PORTING.md`](PORTING.md) "Active Ports".
6. Land tests for the public API singleton (mirror [`test/unit/bug-report-api.test.ts`](test/unit/bug-report-api.test.ts)).
7. Add an ADR to [`DECISIONS.md`](DECISIONS.md) if the module makes a non-obvious design choice.
8. Update this README's "Modules" table.

Cross-module imports must go through `api.ts` only — never reach into `store.ts`, `main.ts`, etc. (Rule 11.)

---

## Running

```bash
# Type-check (no emit)
npm run lite:typecheck

# Build (esbuild bundles main, preload, modal)
npm run lite:build

# Build + run in dev mode (Electron picks up the bundles)
npm run lite:dev

# Run unit tests
npm run lite:test:unit

# Package a signed macOS installer
npm run lite:package:mac
```

Lite runs on different ports than the full app so both can be open at once:

| Service | Lite | Full |
|---|---|---|
| Log server | 47392 | 47292 |
| Spaces (when ported) | 47391 | 47291 |

See [`LITE-RULES.md` "Port Configuration"](LITE-RULES.md#port-configuration) for the full table.

---

## Layout

```
lite/
  README.md              # this file
  LITE-RULES.md          # the rules
  PORTING.md             # per-port hardening status + module-structure template
  DECISIONS.md           # ADR-format decision log
  LITE-PUNCH-LIST.md     # bugs & small features specific to lite
  SIGNING-SPIKE.md       # macOS code-signing investigation log
  errors.ts              # shared LiteError base class
  main-lite.ts           # main-process entry
  preload-lite.ts        # single preload (one for the whole app)
  placeholder.html       # main-window content
  about.html             # Windows About dialog
  electron-builder.json  # packaging config
  esbuild.config.mjs     # bundler config
  tsconfig.json          # strict TS config
  vitest.config.ts       # test runner config
  playwright.config.ts   # E2E test runner config
  menu/                  # menu registry + builder + seed
  logging/               # centralized logs + events + spans + subscriptions
  kv/                    # key-value storage module
  bug-report/            # user bug-report module
  auth/                  # GSX sign-in v1 module (Edison)
  totp/                  # OneReach 2FA authenticator (Tools -> Authenticator...)
  updater/               # auto-update lifecycle
  test/                  # unit + integration + e2e
  scripts/               # build helpers (record-lib-sha, etc.)
```

---

## Documentation index

| What | Where |
|---|---|
| Rules every PR follows | [`LITE-RULES.md`](LITE-RULES.md) |
| Architecture decisions | [`DECISIONS.md`](DECISIONS.md) |
| Per-module README | `<module>/README.md` (e.g. [`kv/README.md`](kv/README.md), [`bug-report/README.md`](bug-report/README.md)) |
| Per-module API surface | `<module>/api.ts` (JSDoc on every method) |
| Per-module error codes | `<module>/README.md` "Error catalog" |
| Module-shape template | [`PORTING.md` "Module Structure"](PORTING.md#module-structure) |
| Port status & history | [`PORTING.md`](PORTING.md) |
| Open bugs | [`LITE-PUNCH-LIST.md`](LITE-PUNCH-LIST.md) |
| Strategic phase plan | `.cursor/plans/onereach_lite_strangler_build_*.plan.md` |
| Code-signing notes | [`SIGNING-SPIKE.md`](SIGNING-SPIKE.md) |
