# lite/onboarding

KV-backed first-run checklist for the chrome home view. Tracks
which onboarding steps the user has completed; the chrome card
auto-ticks them off and hides itself when everything is done OR
the user explicitly dismisses it.

Per ADR-046.

## Steps

Stable IDs in [`./types.ts`](./types.ts) -- new steps APPEND, existing
IDs never change so prior completion state survives upgrades.

| Step ID | Renderer label | Auto-completes when |
|---|---|---|
| `signed-in` | Sign in to GSX | `auth.onSessionChanged` fires with a non-null session |
| `two-factor-saved` | Save your 2FA setup secret (optional) | `totp.hasSecret()` returns true (polled on focus) |
| `openai-key-set` | Add an OpenAI API key (optional, for TTS) | `ai.status().hasApiKey === true` (polled on focus) |
| `first-agent-opened` | Open your first agent | `mainWindow.onTabsChanged` reports a non-empty tab list |

## Surface

```typescript
import { getOnboardingApi } from '../onboarding/api.js';

const api = getOnboardingApi();
const state = await api.load();
await api.markComplete('signed-in');
await api.dismiss();
const unsub = api.onChange((newState) => { ... });
```

Renderer side via `window.lite.onboarding`:

```typescript
const state = await window.lite!.onboarding!.load();
await window.lite!.onboarding!.markComplete('signed-in');
await window.lite!.onboarding!.dismiss();
```

## Persistence

KV collection: `lite-onboarding`, key: `default`. Single blob:

```typescript
{
  schemaVersion: 1,
  completedAt: { 'signed-in': '2026-05-05T...', ... },
  dismissedAt: '2026-05-05T...' | null,
}
```

Atomic writes via `lite/kv/api.ts`. `markComplete` is idempotent;
repeated calls preserve the earliest timestamp.

## Listener semantics

`onChange` listeners are isolated -- a throwing listener doesn't
prevent the others from receiving the change. Same pattern as
`lite/idw/store.ts`.

## What's NOT in scope (named so we don't lose them)

- **A wizard / coach-mark tour**: rejected for v1; the checklist
  card is the lighter pattern.
- **Per-account onboarding state**: today's state is per-device.
  If we need per-account, add `accountId` to the KV key.
- **More steps**: append to `ONBOARDING_STEP_IDS` and add a
  matching auto-complete trigger in `lite/main-window/chrome.ts`.

## Tests

[`lite/test/unit/onboarding-store.test.ts`](../test/unit/onboarding-store.test.ts):
default state, `markComplete` idempotence, `dismiss`, `reset`,
listener isolation, persistence across `OnboardingStore`
instances.

[`lite/test/unit/onboarding-api.test.ts`](../test/unit/onboarding-api.test.ts):
Rule-12 conformance contract (api singleton + reset + override).
