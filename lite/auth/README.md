# `lite/auth/` — GSX Sign-In

Captures the OneReach GSX session token after the user signs in and selects their account, persists the session via [`lite/kv/`](../kv/), and exposes the token to main-process consumers via a typed API.

- **Public API**: [`api.ts`](api.ts) — `AuthApi` interface, `getAuthApi()` singleton, error class & codes
- **Internal**:
  - [`store.ts`](store.ts) — cookie capture + KV persistence + `AuthError` definition (`@internal`)
  - [`window.ts`](window.ts) — auth `BrowserWindow` factory with navigation containment (`@internal`)
  - [`main.ts`](main.ts) — main-process IPC handlers + lifecycle (`@internal`)
  - [`types.ts`](types.ts) — `Environment`, `AuthSession`, `EnvironmentConfig`
- **Tests**: [`../test/unit/auth-api.test.ts`](../test/unit/auth-api.test.ts), [`../test/unit/auth-errors.test.ts`](../test/unit/auth-errors.test.ts), [`../test/unit/auth-store.test.ts`](../test/unit/auth-store.test.ts), [`../test/integration/auth-integration.test.ts`](../test/integration/auth-integration.test.ts)
- **Decision rationale**: [DECISIONS.md ADR-026 (sign-in v1 captures cookies; user fills the form)](../DECISIONS.md#adr-026-lite-gsx-sign-in-v1-captures-session-cookies-user-fills-the-onereach-form)

---

## What it is

The auth module opens an Electron `BrowserWindow` pointing at GSX (`https://studio.edison.onereach.ai` in v1) and lets the user complete the OneReach sign-in ceremony themselves — typing email/password, completing 2FA, picking their account from the OneReach picker. A session-cookie listener on the window's partition watches for the `mult` and `or` cookies. Once both arrive AND a KV write succeeds, the window closes and `signIn()` resolves with an `AuthSession`.

The captured `mult` cookie value is the OneReach API bearer token (`Authorization: Bearer <value>`). It is held main-process only — `getToken()` is intentionally NOT exposed via the preload bridge. Future consumer modules that need to call OneReach APIs do so from main and inject the header themselves.

```typescript
// Main-process consumer
import { getAuthApi } from '../auth/api.js';

const auth = getAuthApi();
await auth.signIn('edison');           // opens window, resolves on capture
const token = auth.getToken('edison'); // raw mult cookie value
const headers = { Authorization: `Bearer ${token}` };
```

```typescript
// Renderer (placeholder.html) — note the bridge omits getToken
const result = await window.lite.auth.signIn('edison');
console.log('signed in as', result.session.email, 'account', result.session.accountId);
```

---

## v1 scope (deliberately narrow)

| What v1 ships | What v1 deliberately skips |
|---|---|
| Edison environment only | Staging / dev / production (stubbed in `Environment` union; `AUTH_UNSUPPORTED_ENV` for now) |
| One account per env | Multi-account picker UI (`auth-multi-account` in `PORTING.md` deferred queue) |
| User types their own email/password | Email/password auto-fill, account-picker auto-click |
| Lite auto-fills TOTP when configured | Backup / recovery code handling |
| Cookie capture + KV persistence | Cross-partition token propagation (full app's pattern; not needed since v1 has one partition per env) |
| Placeholder-window button | Menu entry (`auth-menu-entry` deferred to keep kernel menu tidy) |

See [`../PORTING.md`](../PORTING.md) chunk `auth-signin-v1` for the full scope and deferred follow-ups.

---

## API quick reference

| Method | Returns | Throws? | Notes |
|---|---|---|---|
| `signIn(env, opts?)` | `Promise<AuthSession>` | Yes (`AuthError`) | Opens window, captures cookies, persists to KV. Concurrent calls coalesce. |
| `signOut(env)` | `Promise<void>` | **No (soft-fail)** | Removes cookies + KV record + in-memory state. Best-effort. |
| `getSession(env)` | `AuthSession \| null` | No | Synchronous; returns the rehydrated or in-memory session. |
| `getToken(env)` | `string \| null` | No | Returns the raw `mult` cookie value (the API bearer). Cheaper than `getTokenBundle` when the caller only needs `mult`. |
| `getTokenBundle(env)` | `AuthTokenBundle \| null` | No | Returns both raw cookie values (`mult` + `or`) + capturedAt. **Bridged to renderers** for the Settings → Account verification UI. Returns null until the next sign-in after a restart. |
| `hasValidSession(env)` | `boolean` | No | True if there's a session AND `expiresAt` (if known) is in the future. |
| `onSessionChanged(cb)` | `() => void` (unsubscribe) | No | Fires on every sign-in/sign-out. |

See [`api.ts`](api.ts) for full JSDoc.

---

## Persistence shape

KV collection: `lite-auth-sessions`
KV key: `${environment}:${accountId}` (e.g. `edison:05bd3c92-5d3c-4dc5-a95d-0c584695cea4`)

```typescript
interface AuthSession {
  environment: Environment;   // 'edison' | 'staging' | 'dev' | 'production'
  accountId: string;          // UUID extracted from the or cookie or URL
  email?: string;             // from decoded or cookie if present
  capturedAt: number;         // ms epoch
  expiresAt?: number;         // ms epoch, from cookie.expirationDate * 1000
}
```

The raw `mult` token is **NOT** persisted in KV — it lives only in `Map<Environment, string>` inside `AuthStore`. After an app restart, `hydrate()` (called automatically at boot by `initAuth`) reloads the metadata, but `getToken()` returns null until the user signs in again. This is a deliberate security trade-off: tokens stay ephemeral across restarts.

### Boot-time hydration race

`initAuth` kicks off `hydrate()` in the background at boot, but it isn't synchronous — KV roundtrip takes ~300-500ms in practice. To prevent renderers (e.g. the placeholder window) from seeing a "Sign in" button before hydration completes, two things happen:

1. The `lite:auth:get-session` and `lite:auth:has-valid-session` IPC handlers `await` `hydrate()` before reading. Concurrent calls (boot-time + first renderer probe) coalesce on a shared in-flight Promise so KV is hit exactly once.
2. After hydration, `AuthStore` fires the `session-changed` callback for every rehydrated session. Subscribers that registered after boot (the placeholder's `onSessionChanged` listener attaches when the script loads) still receive the rehydrated state via this broadcast — belt-and-suspenders against any future timing change.

---

## Error catalog

Every error is an `AuthError` (extends `LiteError`). Inspect `.code` to branch.

| Code | Meaning | Remediation |
|---|---|---|
| `AUTH_CANCELLED` | User closed the auth window before both cookies arrived. | "Click Sign in to GSX to try again." |
| `AUTH_TIMEOUT` | Cookies didn't arrive within the timeout (default 5 min). | "Try signing in again." |
| `AUTH_KV_FAILED` | Cookies were captured but the KV write rejected. Window closes. | The `KVError` is in `.cause`; remediation is taken from it. |
| `AUTH_UNSUPPORTED_ENV` | Caller passed an env not in `SUPPORTED_ENVIRONMENTS`. | "v1 supports edison only." |
| `AUTH_INVALID_COOKIE` | The `or` cookie value couldn't be decoded, OR no `accountId` could be found in the payload or URL. | "Make sure to pick an account in GSX before closing the window." |

```typescript
import { getAuthApi, AuthError, AUTH_ERROR_CODES, isLiteError } from '../auth/api.js';

try {
  await getAuthApi().signIn('edison');
} catch (err) {
  if (err instanceof AuthError) {
    if (err.code === AUTH_ERROR_CODES.CANCELLED) return; // user backed out
    toast(err.formatForUser());        // "Sign-in timed out... Try signing in again."
    log.error(err.formatForLog());     // structured for diagnostics
  }
}
```

---

## Event taxonomy

Per ADR-030, the auth module emits structured events through the central log. Per ADR-032, these are exposed as a typed `AuthEvent` discriminated union with `getAuthApi().onEvent()`. The typed constants in [`lite/auth/events.ts`](./events.ts) (`AUTH_EVENTS`) are the source of truth.

| Event | When | Typed payload |
|---|---|---|
| `auth.signIn.start` / `.finish` / `.fail` | First (non-coalesced) `signIn()` call boundary | `data: { env }` / `data: { env, accountId }` + `durationMs` / `durationMs` + top-level `error` |
| `auth.signIn.coalesced` | A subsequent in-flight `signIn()` returns the original promise | `data: { env }` |
| `auth.signOut.start` / `.finish` | `signOut()` boundary; never `.fail` (soft-fail cleanup) | `data: { env }` / `data: { env, hadSession }` + `durationMs` |
| `auth.hydrate.start` / `.finish` / `.fail` | `hydrate()` boundary; idempotent, repeat calls return early before this fires | (no data) / `data: { count }` + `durationMs` / `durationMs` + `error` |
| `auth.session.read` | Sync `getSession()` call | `data: { env, hasSession }` |
| `auth.ipc.sign-in` / `.sign-out` / `.get-session` / `.has-valid-session` | IPC handlers entered | (no data) |

The `signIn` span fires once per coalesced cluster — concurrent callers share the same span (and the same `Promise`). The `auth.signIn.coalesced` event marks each non-first caller so the coalescing is observable.

`getToken` and `hasValidSession` (sync, main-process-only) do NOT emit events — they're called frequently and are pure reads.

**Subscribing with type narrowing:**

```typescript
import { getAuthApi, AUTH_EVENTS, type AuthEvent } from '../auth/api.js';

getAuthApi().onEvent((ev: AuthEvent) => {
  switch (ev.name) {
    case AUTH_EVENTS.SIGN_IN_FINISH:
      // ev.data narrowed to { env, accountId }
      metrics.gauge('auth.account', { env: ev.data.env, id: ev.data.accountId });
      break;
    case AUTH_EVENTS.SIGN_IN_COALESCED:
      metrics.increment('auth.signIn.coalesced', { env: ev.data.env });
      break;
    case AUTH_EVENTS.SIGN_IN_FAIL:
      sentry.capture(ev.error);
      break;
  }
});
```

## Token redaction guarantee

Cookie values are **NEVER** logged. Only metadata: `valueLength`, `domain`, `expirationDate`, `httpOnly`, `secure`, `sameSite`, `path`, `name`. This invariant is enforced by a unit test in [`../test/unit/auth-store.test.ts`](../test/unit/auth-store.test.ts) that captures every log call during a sign-in and asserts the captured token value never appears as a substring in any message or data payload. A second test enforces the same for the raw `or` cookie payload.

If you add a new log call in `store.ts`, do not log `cookie.value` directly. Use the `cookieMetadata(cookie)` helper in `store.ts` for any cookie-related log.

## Token reveal in Settings (ADR-026 amendment)

`getTokenBundle(env)` returns both captured cookie values (`mult` + `or`) plus their `capturedAt` and per-cookie expiration. The bundle is bridged to renderers (`window.lite.auth.getTokenBundle(env)`) and consumed exclusively by the Settings → Account section so users can verify both cookies were captured and copy individual values for manual debugging.

Constraints preserved:

- **Never persisted.** The bundle lives only in `AuthStore.tokenBundles`. KV holds the `AuthSession` shape only (env, accountId, email, capturedAt, expiresAt).
- **Never logged.** Token values are not part of any log message or data payload. The redaction test catches regressions.
- **Ephemeral across restarts.** The map is cleared on app restart; `getTokenBundle` returns null until the user signs in again, even when the persisted `AuthSession` rehydrates from KV. The Settings → Account UI displays "Tokens are cleared on app restart … sign back in to refresh them in this view." in that case.
- **Cleared on sign-out.** `signOut(env)` deletes the bundle along with the cookies and KV record.

---

## Renderer bridge (`window.lite.auth`)

The preload exposes a narrowed surface. `getToken()` is intentionally not bridged — the token never crosses IPC.

```typescript
window.lite.auth.signIn('edison').then(({ session }) => { ... });
window.lite.auth.signOut('edison');
window.lite.auth.getSession('edison').then(({ session }) => { ... });
window.lite.auth.hasValidSession('edison').then(({ valid }) => { ... });

// Subscribe to changes from anywhere in the app.
const off = window.lite.auth.onSessionChanged(({ env, session }) => {
  // re-render UI
});

// Parse a thrown signIn error into the structured AuthError shape.
try {
  await window.lite.auth.signIn('edison');
} catch (err) {
  const authErr = window.lite.auth.parseError(err); // { code, message, remediation, ... }
  if (authErr) showBanner(authErr.message + ' ' + authErr.remediation);
}
```

The placeholder window (`lite/placeholder.html`) is the canonical consumer.

---

## Testing

Per Rule 12 (LITE-RULES.md / ADR-024):

- **API conformance** — [`auth-api.test.ts`](../test/unit/auth-api.test.ts) runs `runApiConformanceContract`.
- **Error conformance** — [`auth-errors.test.ts`](../test/unit/auth-errors.test.ts) runs `runErrorConformanceContract` for `AuthError`.
- **Store behavior** — [`auth-store.test.ts`](../test/unit/auth-store.test.ts) covers happy path, all five error codes, in-flight coalescing, existing-session probe, signOut symmetry, and the **token redaction assertion**.
- **Wire format** — [`auth-integration.test.ts`](../test/integration/auth-integration.test.ts) drives the real `EdisonKVClient` against [`startInMemoryKVServer`](../test/harness/mocks/in-memory-kv-server.ts), verifying the persisted shape and that the raw token is never written to KV.
- **`window.ts` coverage**: manual smoke only in v1 — automated E2E is tracked as `auth-signin-e2e` in `PORTING.md` deferred queue (needs a fake OneReach auth server harness).

Tests mock `electron` with `vi.mock` so they run under Node's vitest runner without an Electron host.

---

## Borrowed patterns (studied, never imported)

Per LITE-RULES.md cherry-pick discipline:

- `multi-tenant-store.js:387-469` — session cookie listener pattern (`session.cookies.on('changed', ...)` filtered to `mult` / `or`)
- `multi-tenant-store.js:81-87` — safe OneReach domain validation (prevents subdomain attacks)
- `multi-tenant-store.js:573` — environment extraction from cookie domain
- `gsx-autologin.js:1063-1120` — per-account session partition shape

All rewritten in TS-strict within `lite/auth/`. No `import` from full's root files or `packages/`.

---

## What auto-fill exists?

Lite now handles the narrow 2FA step during sign-in (ADR-034):

- User still types email/password in the OneReach popup.
- When OneReach shows a TOTP prompt, Lite detects the auth frame.
- Lite calls `getTotpApi().getCurrentCode()`.
- Lite fills and submits the current 6-digit code.
- Cookie capture continues unchanged and closes the window once `mult` + `or` persist.

Email/password auto-fill and account-picker auto-select are deliberately still out of scope. The full app's `gsx-autologin.js` ports the entire OneReach auth ceremony into the kernel: form fill, TOTP, account picker auto-click, retry/backoff, status overlay. Lite only ports the TOTP slice because that removes the biggest login friction while keeping the auth surface small.

### How TOTP auto-fill detects the form

The OneReach auth UI is a SPA — by the time Electron's `did-finish-load` fires, the React tree usually hasn't mounted the TOTP `<input>` yet. A one-shot `document.querySelector` at that moment finds nothing and silently gives up.

To handle this, [`totp-autofill.ts`](./totp-autofill.ts) injects [`buildWaitForAuthFormScript`](../../lib/auth-scripts.js) into every OneReach frame in the tree (main frame + every iframe + every popup window). That script installs a `MutationObserver` and resolves only when an email, password, or TOTP input actually shows up in the DOM (or after a 10s timeout). The auto-fill then checks `is2FAPage`, generates the code via `getTotpApi().getCurrentCode()`, fills it with React-compatible input events (`buildFillTOTPScript`), and clicks the verify/continue/confirm button (`buildSubmitButtonScript`).

OneReach can render the 2FA prompt either in a frame inside the auth window OR in a `window.open` popup the auth window opens. The watcher attaches to popups via `webContents.on('did-create-window', ...)` so both paths are covered without the caller having to know which one OneReach picks today.

Every step writes an `info` log line under the `auth` category (`auth-totp-autofill: started watching`, `: scan`, `: form wait resolved`, `: filled and submitted 2FA code`, etc.). No path returns silently — when the auto-fill does nothing, the log says exactly why. Token values, TOTP secrets, and the generated 6-digit code are never logged.

### What if the user has 2FA on OneReach but Lite has no secret saved?

(ADR-046) The watcher detects the 2FA prompt, calls `getCurrentCode()`, the keychain is empty, and `TotpError(NO_SECRET)` throws. Without a hint, the user just stares at the OneReach prompt with no idea what's happening. The fix:

- The watcher fires `onTwoFactorNeedsSetup({source, frameUrl, ...})` exactly once per `startTotpAutofill` call (gated by `RuntimeState.needsSetupNotified`).
- The auth store forwards that to its `twoFactorNeedsSetupSubscribers`, then `lite/auth/main.ts` broadcasts `lite:auth:2fa-needs-setup` to every renderer window.
- `window.lite.auth.on2FANeedsSetup(handler)` lets renderers (chrome / placeholder / future surfaces) wire a contextual banner with an "Open Settings -> Two-Factor" button.

The notification is best-effort: it doesn't block the sign-in flow, and the renderer is free to ignore it. But every renderer that uses the auth bridge today (chrome, placeholder) shows the banner.

## OAuth popups: in-app vs OS browser (ADR-046)

Earlier versions of the auth window denied every non-OneReach popup and called `shell.openExternal(url)` instead. That worked for "open this article in your browser" but silently broke "Sign in with Google" because:

1. User clicks "Sign in with Google" inside the OneReach auth page.
2. OneReach calls `window.open('https://accounts.google.com/...')`.
3. Electron denies the popup -> Lite opens accounts.google.com in Safari.
4. OAuth completes in Safari, sets cookies on `accounts.google.com` in Safari's jar.
5. The OneReach auth page is still waiting for the popup-postMessage that never comes.

The fix lives in [`oauth-popup.ts`](./oauth-popup.ts). `setWindowOpenHandler` now calls `buildPopupHandler({partition, ...})`, which:

- Allows OAuth IdP popups (Google, Microsoft, Apple, Auth0, Okta, GitHub, Atlassian, Slack, Zoom, OpenAI, Anthropic, X) as in-app child Electron windows that inherit the auth window's `persist:lite-auth-<env>` partition. Cookies land in the right jar; postMessage works; the parent navigates to the post-auth state.
- Routes everything else to `shell.openExternal` (the previous behavior, preserved for non-OAuth content).
- Also keeps `*.onereach.ai` popups allowed (some OneReach flows pop a child window for SSO / account picker).

The same helper is used by [`lite/main-window/window.ts`](../main-window/window.ts) for each agent tab and [`lite/idw/browser-window.ts`](../idw/browser-window.ts) for the placeholder fallback. Each surface passes its own partition so OAuth state stays isolated across tabs (per-tab `persist:tab-<uuid>`) but shared inside one tab's session.

Allowlist matching is exact-host or subdomain (`accounts.google.com` matches; `accounts.google.com.evil.com` does NOT). Adding entries means a one-line edit to `OAUTH_POPUP_ALLOWLIST`.
