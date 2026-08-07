# `lite/telemetry/` — Alpha Usage Telemetry

Per-install daily rollups for the alpha rollout, behind an Apple-style opt-in. Answers "how is the app behaving in the wild" — versions, crashes, surface usage — without measuring the person using it.

- **Public API**: [`api.ts`](api.ts) — `TelemetryApi`, `getTelemetryApi()` singleton, `CONSENT_DISCLOSURE`
- **Internal**:
  - [`consent.ts`](consent.ts) — the gate (`maySend`), the prompt policy (`shouldPrompt`), the disclosure + its runtime enforcement
  - [`identity.ts`](identity.ts) — random per-install UUID (deliberately not hardware-derived)
  - [`store.ts`](store.ts) — per-day counter accumulation + the seal-once day rollover
  - [`rollup.ts`](rollup.ts) — payload shaping (minute rounding, capped counter maps)
  - [`main.ts`](main.ts) — files, dialog, event subscriptions, tick, seal-and-send (`@internal`)
- **Tests**: [`../test/unit/telemetry-api.test.ts`](../test/unit/telemetry-api.test.ts), [`../test/unit/telemetry-consent.test.ts`](../test/unit/telemetry-consent.test.ts), [`../test/unit/telemetry-rollup.test.ts`](../test/unit/telemetry-rollup.test.ts), [`../test/unit/telemetry-identity-store.test.ts`](../test/unit/telemetry-identity-store.test.ts)

---

## The two rules

1. **Nothing leaves the machine without consent.** Opt-in, default off, revocable, never re-asked after a "no". `maySend()` is strict `=== 'granted'` — a malformed, tampered, or JSON-round-tripped record means NO. The app is fully functional with consent off, forever.

2. **The payload is a rollup, not a transcript.** Counts, versions, presence booleans. Never log lines, asset titles, file names, URLs, or anything typed. `CONSENT_DISCLOSURE` is code, and `disclosureViolations()` rejects any payload carrying a field the prompt didn't mention — adding a field fails tests until the disclosure is updated too.

## What one day's rollup contains

Version, platform/arch, app-open minutes (rounded — exact timings would reconstruct someone's working hours), launch count, error counts by category (capped, remainder as `__other`), surface-open counts from a fixed vocabulary, bug-reports-filed count, and four health presence booleans. See `DailyRollup` in [`types.ts`](types.ts).

## Where rollups go

Each install mints a random UUID on first run and, on first send, creates a **restricted** Space named `Lite Install <id8>` (ADR-051 visibility). The creating user is auto-granted access — you can always see what your machine reports — and the alpha maintainer is granted permanent access (ADR-052 `expiresAt: null`). One text item per day, `metadata.source = 'lite-telemetry'`.

## Consent lifecycle

- Boot (2.5s after window): `promptIfNeeded()` shows the one-time ask — dialog with the full disclosure, **Don't Share** as `cancelId` so Escape/dismiss is a NO.
- Settings → Diagnostics → **Usage sharing**: the decision is visible and reversible forever after.
- Consent granted on day 30 sends from day 30 — the backlog collected while unconsented is never shipped.

## Failure posture

Everything soft-fails: a graph outage, a missing Space, a corrupt state file — telemetry logs a warning and misses a day. It never surfaces an error to the user, never retries aggressively, and never blocks boot.
