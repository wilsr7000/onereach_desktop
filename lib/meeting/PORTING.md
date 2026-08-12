# WISER Meeting → Lite porting contract

This package (`lib/meeting/`) is the recorder subsystem's portable
core. The full app's **host shell** — `recorder.js` (main-process IPC),
`recorder.html` (13.3k-line renderer window), `preload-recorder.js` —
lives at the repo root and adapts this core to the full app. Porting to
Lite (the Tier-3 plan from ADR-061's assessment) means re-implementing
the shell against Lite's modules; the core moves as-is.

## What's in the core

| File | Role | Direct host deps |
|---|---|---|
| `livekit-service.js` | Room + token mint; credential precedence mintUrl > settings > legacy fallback | `../log-event-queue`, `../gsx-flow-context` (auth token for server mint) |
| `meeting-link-keys.js` | Per-install ECDSA P-256 link signing (KV is untrusted) | `../log-event-queue` |
| `meeting-schema.js` | Meeting object model (`fromSpaceItem`/`completeMeeting`/`toSpaceItem`) | `uuid` only |
| `meeting-templates.js` | Custom meeting templates | none |
| `capture-guest-page.js` | The published web guest page (`GUEST_PAGE_VERSION` gated) | none |
| `meeting-graph-bridge.js` | ADR-061 — mirror completed meetings into the shared graph | none (own fetch; creds duplicated from lite/neon — rotate together) |

Deliberately **not** in the core: `lib/meetings/` (the Meeting Starter /
Event agent cluster — a different feature), `meeting-classifier.js` /
`critical-meeting-rules.js` (calendar prep), and the dead pre-LiveKit
files (`capture-signaling.js`, `signaling-client.js`, `web-recorder.html`).

## Host-services seam table

What the shell provides around the core today, and the Lite module that
implements the same service for the port:

| Service | Full-app implementation | Lite equivalent |
|---|---|---|
| Structured logging | `lib/log-event-queue` | `lite/logging` |
| GSX auth token (server mint) | `lib/gsx-flow-context` | `lite/auth` (`getAuthApi().getSession('edison')`) |
| KV (token distribution: `wiser:meeting:tokens`, `wiser-room:<room>`) | GSX KV via recorder.js | `lite/kv` (same Edison OMNI keyvalue flow) |
| Guest-page publish | GSX Files via recorder.js | `lite/files` |
| Realtime transcription + post-meeting analysis | `lib/ai-service` (OpenAI key from settings) | `lite/ai` (has its own key config + deadlines) |
| Meeting/artifact persistence | local OR-Spaces (`clipboardManager`) + `meeting-graph-bridge` | `lite/spaces` items API + the same bridge (or native writes) |
| Settings | full-app settings store | `lite/settings` |
| FFmpeg merge | `@ffmpeg-installer/ffmpeg` + `fluent-ffmpeg` in recorder.js | ⚠ native binary — must be an asar-external in Lite's electron-builder config; externals have transitive deps (v0.0.46 boot-crash lesson) |
| Window + entitlements | recorder window in main.js/recorder.js | Lite already ships camera + microphone entitlements and usage strings; screen recording is a TCC grant, not an entitlement |

## Port order that matches the risk

1. Copy `lib/meeting/` into `lite/meeting/` (or import across — decide
   per Lite's dep-cruiser rules); swap the two host-dep requires.
2. Stand up a minimal recorder window in Lite loading `recorder.html`
   as-is (it is monolithic by design — refactor AFTER it runs).
3. Wire the seams per the table; keep `GUEST_PAGE_VERSION` single-
   sourced from this package so both apps publish the same guest page.
4. Ship the mint-URL credential path in Lite from day one — a
   fallback-free build is the precondition for rotating the leaked
   legacy LiveKit key (see `docs/internal/WISER-MEETING-SECURITY.md`).

## Invariants tests already pin

- The legacy LiveKit pair may exist ONLY in
  `lib/meeting/livekit-service.js` (`test/unit/leaked-credential-scan.test.js`).
- Guest-page multi-share behavior (`test/unit/capture-guest-page*.test.js`,
  33 tests) and real geometry (`test/e2e/meeting-screenshare-render.spec.js`).
- Bridge wire contract + shapes (`test/unit/meeting-graph-bridge.test.js`, 13 tests).
- IPC channel allow-lists (`test/unit/ipc-recorder.test.js`).
