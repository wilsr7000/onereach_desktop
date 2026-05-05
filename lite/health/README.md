# `lite/health/` — Health snapshot

A pull-based current-state snapshot of Onereach.ai Lite. Answers **"what is true right now?"** — the counterpart to the central event log (which answers "what happened over time?").

- **Public API**: [`api.ts`](api.ts) — `HealthApi` interface, `getHealthApi()` singleton
- **Internal**:
  - [`store.ts`](store.ts) — `HealthStore` pull-based aggregator (`@internal`)
  - [`main.ts`](main.ts) — IPC + `initHealth` / `teardown` handle (`@internal`)
  - [`types.ts`](types.ts) — shape definitions; secret-free by construction
- **Tests**: [`../test/unit/health-api.test.ts`](../test/unit/health-api.test.ts), [`../test/unit/health-store.test.ts`](../test/unit/health-store.test.ts)
- **Decision rationale**: [DECISIONS.md ADR-036](../DECISIONS.md#adr-036-pull-based-health-snapshot-separate-from-the-event-log)

---

## What it is

A foundational diagnostic surface used for:

1. Debugging — call `window.lite.health.snapshot()` from devtools to see open windows, sign-in status, TOTP / Neon configuration, recent error counts.
2. Bug reports — every bug report attaches a `healthSnapshot` so triage can see "what was the app's state when this was filed?"
3. Future Settings → Diagnostics — the eventual diagnostics surface will render this snapshot.
4. E2E assertions — the harness can call the same snapshot to assert post-condition invariants.

The snapshot is **best-effort and never throws**. If a backing module is missing or its read fails, that section reports a safe fallback (e.g. `auth.signedIn = false`) and a logger warning is emitted.

---

## Security posture

The snapshot type **cannot express secrets**. There are no fields for:

- raw `mult` / account tokens or cookies
- TOTP secret value or current 6-digit code
- Neon database password
- API keys

What it CAN include (developer-safe diagnostics):

- token presence booleans (`hasMultToken`, `hasAccountToken`)
- `accountId` / `email`
- token expiry timestamp (`expiresAt`)
- TOTP `secretLength` (count, not value)
- TOTP `secondsRemaining` (1..30 countdown to next code)
- Neon `hasPassword` boolean
- Neon `endpoint` / `uri` / `user` / `database` (no auth)
- window titles / URLs
- recent error / warn counts
- `lastError` string (event name + redacted message)

Bug-report redaction still runs over the serialized payload; if a future field accidentally lets a token-shaped string through, the redaction patterns catch it. A unit test asserts that token sentinels in mocked auth bundles do not appear in the final snapshot.

---

## Snapshot shape

```typescript
interface AppHealthSnapshot {
  schemaVersion: 1;
  capturedAt: string;        // ISO timestamp
  app: {
    version: string;
    platform: NodeJS.Platform;
    arch: string;
    uptimeMs: number;
    userDataPath: string;
    startedAt: number;        // ms epoch
  };
  windows: Array<{
    id: number;
    title: string;
    url: string;
    type: 'main' | 'settings' | 'auth' | 'bug-report' | 'about' | 'api-docs' | 'unknown';
    focused: boolean;
    visible: boolean;
    destroyed: boolean;
  }>;
  auth: {
    signedIn: boolean;
    environment: 'edison';
    accountId?: string;
    email?: string;
    hasMultToken: boolean;
    hasAccountToken: boolean;
    expiresAt?: number;
  };
  totp: {
    configured: boolean;
    metadata?: { issuer?: string; account?: string; secretLength?: number };
    hasCurrentCode: boolean;
    secondsRemaining?: number;
  };
  neon: {
    configured: boolean;
    ready: boolean;
    endpoint?: string;
    uri?: string;
    user?: string;
    database?: string;
    hasPassword: boolean;
  };
  updater: {
    failedAttempts: number;
    lastAttemptVersion: string | null;
    lastAttemptTime: string | null;
  };
  diagnostics: {
    recentErrorCount: number;
    recentWarnCount: number;
    lastError?: string;
  };
}
```

See [`types.ts`](types.ts) for the authoritative definitions.

---

## Consumer examples

### Main process

```typescript
import { getHealthApi } from '../health/api.js';

const snap = await getHealthApi().snapshot();
if (!snap.auth.signedIn) {
  // Surface a sign-in prompt before triggering a feature that needs auth.
}
if (snap.diagnostics.recentErrorCount > 5) {
  // Trip a degraded-mode banner.
}
```

### Renderer

```typescript
const snap = await window.lite.health.snapshot();
console.table(snap.windows);
```

### Bug-report integration

The bug-report module calls `getHealthApi().snapshot()` when assembling the capture payload (see [`../bug-report/main.ts`](../bug-report/main.ts) `buildPayload`). The snapshot lands in the saved record as the optional `healthSnapshot` field. If the snapshot fetch fails, the bug report is filed anyway — the snapshot is supplementary diagnostic context, not load-bearing evidence.

---

## API quick reference

| Method | Returns | Throws? | Notes |
|---|---|---|---|
| `snapshot()` | `Promise<AppHealthSnapshot>` | No | Best-effort. Always resolved. Re-reads on every call (no cache). |

See [`api.ts`](api.ts) for full JSDoc and the `HEALTH_SCHEMA_VERSION` constant.

---

## Renderer bridge (`window.lite.health`)

```typescript
const snap = await window.lite.health.snapshot();
```

The bridge is shared between renderers — Settings → Diagnostics (future), placeholder window devtools, and any future health-aware affordance can call it without main-process plumbing. The IPC channel is `lite:health:snapshot` (registered by `initHealth` in [`main.ts`](main.ts)).

---

## Failure modes

| Module | What can fail | Snapshot behavior |
|---|---|---|
| `auth` | `getSession` / `getToken` throw | `auth.signedIn = false`, all booleans `false`, no `accountId`/`email` |
| `totp` | `hasSecret` throws | `totp.configured = false`, `hasCurrentCode = false` |
| `totp` | `getCurrentCode` throws when configured | `totp.configured = true`, `hasCurrentCode = false`, `secondsRemaining` omitted |
| `totp` | `getMetadata` throws when configured | snapshot still includes `configured = true`, no `metadata` |
| `neon` | `status()` throws | `neon.configured = false`, `ready = false`, `hasPassword = false` |
| `updater` | `readUpdateState` throws | `failedAttempts = 0`, `lastAttemptVersion = null` |
| `diagnostics` | `recent('*', 200)` throws | counts `0`, no `lastError` |
| `windows` | `getAllWindows()` throws | `windows: []` |

Each failure path is exercised in [`../test/unit/health-store.test.ts`](../test/unit/health-store.test.ts).

---

## Why pull-based, not push-based?

A push-based "global mutable health object" was considered. Rejected:

- Push requires every module that mutates state to know to update the shared object.
- The shared object becomes a coupling magnet — easy to add to, hard to remove from, hardest to know what's stale.
- Reads with stale data are worse than reads that take 5ms to walk live state.
- Pull-based reads compose with the modular API pattern (Rule 11 / ADR-019): each section reader calls only the relevant module's `<module>/api.ts`.

Pull-based is also testable: each section's reader is independently injectable (see [`store.ts`](store.ts) `HealthStoreConfig`).

---

## Borrowed patterns (studied, never imported)

Per LITE-RULES.md cherry-pick discipline:

- Full app health-monitor.js (in `lib/health-monitor.js`) — borrowed the high-level concept of an aggregating snapshot. Lite's version is far simpler (no SLI metrics, no rolling window) and is tightly scoped to documented lite modules.

All rewritten in TS-strict within `lite/health/`. No `import` from full's root files or `packages/`.
