# `lite/totp/` — Authenticator (2FA codes)

A built-in OneReach 2FA authenticator: stores the user's OneReach authenticator secret in the OS keychain, generates the current 6-digit GSX / OneReach 2FA code from that secret, and exposes QR-scan / clipboard-scan / manual secret-entry helpers. The renderer UI lives in Settings -> Two-Factor.

- **Public API**: [`api.ts`](api.ts) — `TotpApi` interface, `getTotpApi()` singleton, error class & codes
- **Internal**:
  - [`store.ts`](store.ts) — keychain wrapper via `keytar` (`@internal`)
  - [`manager.ts`](manager.ts) — pure TOTP code generation via `otplib` (`@internal`)
  - [`qr-scanner.ts`](qr-scanner.ts) — `desktopCapturer` + `jsqr` + clipboard scanning (`@internal`)
  - [`errors.ts`](errors.ts) — `TotpError` + `TOTP_ERROR_CODES` (extracted to break a cycle between store + manager)
  - [`main.ts`](main.ts) — main-process IPC handlers + `initTotp` / teardown (`@internal`)
  - The authenticator UI now lives at [`../settings/sections/two-factor.ts`](../settings/sections/two-factor.ts), hosted by the Settings window per [ADR-031](../DECISIONS.md#adr-031-settings-window-with-one-section-per-adr-019-two-factor-migrates-from-standalone-tools-window). The standalone `lite/totp/window.ts` was deleted as part of that chunk; this module is now data-only (keychain, code generation, QR scan).
  - [`types.ts`](types.ts) — `Environment`-style types + protocol constants (`TOTP_STEP_SECONDS = 30`, `TOTP_CODE_DIGITS = 6`)
  - Renderer UI is bundled with Settings (see [`../settings/settings.html`](../settings/settings.html), [`../settings/settings.css`](../settings/settings.css), and the [`mountTwoFactor`](../settings/sections/two-factor.ts) section).
- **Tests**: [`../test/unit/totp-api.test.ts`](../test/unit/totp-api.test.ts), [`../test/unit/totp-errors.test.ts`](../test/unit/totp-errors.test.ts), [`../test/unit/totp-manager.test.ts`](../test/unit/totp-manager.test.ts), [`../test/unit/totp-store.test.ts`](../test/unit/totp-store.test.ts), [`../test/integration/totp-integration.test.ts`](../test/integration/totp-integration.test.ts)
- **Decision rationale**: [DECISIONS.md ADR-027](../DECISIONS.md#adr-027-lite-totp-authenticator-widget-auto-fill-remains-deferred)

---

## What it is

The OneReach sign-in flow (`lite/auth/`) per [ADR-026](../DECISIONS.md#adr-026-lite-gsx-sign-in-v1-captures-session-cookies-user-fills-the-onereach-form) lets the user fill the OneReach form themselves — including the 6-digit 2FA code. That code is generated from a long-lived authenticator secret (the same secret your phone authenticator stores after scanning the setup QR code). This module stores that secret on this Mac and generates the current GSX / OneReach 2FA code when Settings -> Two-Factor is open.

Important distinction:

- **Input**: the OneReach authenticator secret / setup QR code (configured once).
- **Output**: the rotating 6-digit GSX / OneReach 2FA code (copied into the login popup).

Do not paste the current 6-digit login code into Settings. Paste or scan the setup secret.

Security guarantees:

- The authenticator secret is stored in the macOS Keychain / system credential vault.
- The secret is not written to app settings, logs, bug reports, or KV storage.
- Lite never shows the saved secret again after setup.
- Lite only displays the temporary six-digit code, which expires every 30 seconds.
- Lite reads the same OneReach authenticator secret used by the full Onereach.ai app, so existing full-app 2FA setup can generate codes here too.

During Lite sign-in, `lite/auth/` can now auto-fill the OneReach 2FA prompt from this module's generated code (ADR-034). The Settings -> Two-Factor UI remains the setup/trust/fallback surface: configure the authenticator secret here, verify the generated code, or copy it manually if auto-fill ever cannot run.

```typescript
import { getTotpApi } from '../totp/api.js';

const totp = getTotpApi();

// Setup paths
await totp.saveSecret('JBSWY3DPEHPK3PXP', { issuer: 'OneReach', account: 'alice' });
const fromQr = await totp.scanQrFromScreen();   // returns { saved, issuer?, account? }
const fromClip = await totp.scanQrFromClipboard();

// Read the live code
const info = await totp.getCurrentCode();
console.log(info.formattedCode, '-- expires in', info.timeRemaining, 's');

// Remove
await totp.deleteSecret();
```

---

## v1 scope

| Ships in v1 | Deferred |
|---|---|
| Live code + 30s countdown UI | Email/password auto-fill |
| TOTP auto-fill during Lite sign-in | Account-picker auto-select |
| QR scan from screen, clipboard, or manual entry | Backup / recovery codes UI |
| Two-Factor section inside `Onereach.ai Lite -> Settings...` (single-instance window via [`lite/settings/`](../settings/)) | E2E spec (`totp-authenticator-e2e`, `settings-e2e`) |
| Single TOTP secret per app | Multi-secret / multi-account authenticator |

See [`../PORTING.md`](../PORTING.md) chunks `totp-authenticator-v1` and `auth-totp-autofill-v1` for the full scope.

---

## API quick reference

| Method | Returns | Throws? | Notes |
|---|---|---|---|
| `hasSecret()` | `Promise<boolean>` | No | Cheap keychain probe. |
| `getMetadata()` | `Promise<TotpSecretMetadata \| null>` | No | Returns `null` if nothing stored or read fails. |
| `saveSecret(secret, extra?)` | `Promise<SaveSecretResult>` | Yes (`TotpError`) | Validates Base32 + writes to keychain. |
| `scanQrFromScreen()` | `Promise<QrScanResult>` | Yes (`TOTP_SCREEN_CAPTURE_FAILED`) | One-shot scan + parse + save. |
| `scanQrFromClipboard()` | `Promise<QrScanResult>` | No | Empty clipboard returns `{saved: false, reason: 'no-qr-found'}`. |
| `getCurrentCode()` | `Promise<TotpCodeInfo>` | Yes (`TotpError`) | The hot path the authenticator UI polls every second. |
| `deleteSecret()` | `Promise<void>` | Yes (`TOTP_KEYCHAIN_FAILED`) | Idempotent for the "nothing to delete" case. |

See [`api.ts`](api.ts) for the full JSDoc.

---

## Persistence

OS Keychain via `keytar`. Two entries:

| Service | Account | Value |
|---|---|---|
| `OneReach.ai-TOTP` | `onereach-unified-login` | Raw Base32 secret string (same service/account as the full app) |
| `OneReach.ai-TOTP-meta` | `onereach-unified-login` | Lite metadata JSON: `{issuer?, account?, savedAt, secretLength}` |

**Shared with the full app.** Full uses `OneReach.ai-TOTP` / `onereach-unified-login`, and Lite now reads/writes the same secret so an existing full-app OneReach 2FA setup immediately generates codes in Lite. For backward compatibility, Lite also reads and deletes the earlier spike-only fallback entry (`OneReach.ai-Lite-TOTP` / `lite-totp-secret`) if no shared secret exists.

---

## Error catalog

Every error is a `TotpError` (extends `LiteError`). Inspect `.code` to branch.

| Code | Meaning | Remediation hint |
|---|---|---|
| `TOTP_NO_SECRET` | `getCurrentCode` was called but no secret is stored. | Open Settings -> Two-Factor and add the OneReach authenticator secret or setup QR first. |
| `TOTP_INVALID_SECRET` | The given string isn't valid Base32 or is too short. | Make sure you copied the full secret. A-Z and 2-7 only, ≥16 chars. |
| `TOTP_KEYCHAIN_FAILED` | `keytar` rejected the read/write/delete. | Make sure macOS Keychain is unlocked. |
| `TOTP_GENERATION_FAILED` | `otplib` rejected the secret at code-generation time. | The stored secret is malformed; remove and re-add. |
| `TOTP_NO_QR_FOUND` | The scanner ran but no QR code was found in the image. | Make sure the QR is fully visible, then try again. |
| `TOTP_NOT_AUTHENTICATOR_QR` | A QR was decoded but it's not an `otpauth://` URI. | Re-scan the OneReach 2FA setup QR (not a website link). |
| `TOTP_SCREEN_CAPTURE_FAILED` | `desktopCapturer.getSources` returned nothing or threw. | Grant Screen Recording permission in macOS System Settings. |

```typescript
import { getTotpApi, TotpError, TOTP_ERROR_CODES } from '../totp/api.js';

try {
  await getTotpApi().getCurrentCode();
} catch (err) {
  if (err instanceof TotpError) {
    if (err.code === TOTP_ERROR_CODES.NO_SECRET) {
      promptUserToSetupTotp();
    } else {
      toast(err.formatForUser());
    }
  }
}
```

---

## Secret redaction guarantee

The TOTP secret value is **NEVER** logged. Only metadata: `secretLength`, `hasIssuer`, `hasAccount`, `savedAt`, etc. This invariant is enforced by [`../test/unit/totp-store.test.ts`](../test/unit/totp-store.test.ts) which captures every log call during a full save → read → delete cycle and asserts the secret value never appears as a substring in any message or data payload.

If you add a new log call in `store.ts` or `manager.ts`, do not log `secret` directly. Use the metadata fields the existing log calls demonstrate.

The ephemeral 6-digit code IS allowed to be logged (it's regenerated every 30s and has low blast radius), but only the QR-scan and code-generation paths actually do.

---

## Renderer bridge (`window.lite.totp`)

The preload exposes a narrowed surface. The secret bytes are write-only; there is no `getSecret`.

```typescript
const { hasSecret } = await window.lite.totp.hasSecret();
if (!hasSecret) {
  await window.lite.totp.saveSecret(userInputBase32);
}
const info = await window.lite.totp.getCurrentCode();
display(info.formattedCode, info.timeRemaining);

// Subscribe to errors via the standard parseError helper
try {
  await window.lite.totp.scanQrFromScreen();
} catch (err) {
  const totpErr = window.lite.totp.parseError(err);
  if (totpErr) showBanner(totpErr.message + ' ' + totpErr.remediation);
}
```

The Two-Factor section in [`lite/settings/sections/two-factor.ts`](../settings/sections/two-factor.ts) is the canonical consumer. The section calls `window.lite.totp.*` from inside the Settings window's renderer.

---

## macOS screen-recording permission

`scanQrFromScreen()` uses Electron's `desktopCapturer.getSources({types: ['screen']})`, which requires Screen Recording permission on macOS. On first use, macOS prompts. If denied:

- The call resolves with `TOTP_SCREEN_CAPTURE_FAILED` (no sources or empty thumbnail).
- The renderer's friendly error tells the user to grant the permission in System Settings → Privacy & Security → Screen Recording, restart the app, and try again.
- The clipboard and manual paths don't need this permission, so the user has fallbacks.

---

## Testing

Per Rule 12 (LITE-RULES.md / ADR-024):

- **API conformance** — [`totp-api.test.ts`](../test/unit/totp-api.test.ts) runs `runApiConformanceContract`.
- **Error conformance** — [`totp-errors.test.ts`](../test/unit/totp-errors.test.ts) runs `runErrorConformanceContract` for `TotpError`.
- **Manager** — [`totp-manager.test.ts`](../test/unit/totp-manager.test.ts) tests pure TOTP math against `otplib` (no mocks).
- **Store** — [`totp-store.test.ts`](../test/unit/totp-store.test.ts) covers happy path, all error codes, idempotent delete, and the **secret redaction assertion**.
- **Integration** — [`totp-integration.test.ts`](../test/integration/totp-integration.test.ts) drives the full pipeline (manager + store + scanner) with a Map-backed `FakeKeychain` and a `FakeScanner` emitting canned `otpauth://` URIs. Verifies QR-path and manual-path persistence are equivalent.
- **`window.ts` coverage**: not applicable -- the standalone authenticator window was deleted in ADR-031. The Two-Factor section is hosted inside the Settings window; coverage is via `settings-e2e` + `totp-authenticator-e2e` in `PORTING.md` deferred queue.

Tests mock `electron`, `keytar`, and `jsqr` with `vi.mock` so they run under Node's vitest runner without an Electron host or system keychain.

---

## Borrowed patterns (studied, never imported)

Per LITE-RULES.md cherry-pick discipline:

- `lib/totp-manager.js` — TOTP `generate` / `verify` / `parseOTPAuthURI` shape (rewritten in TS-strict around `otplib`)
- `lib/qr-scanner.js` — `desktopCapturer` + `jsqr` + BGRA→RGBA conversion (rewritten in TS-strict)
- `credential-manager.js:512-572` — TOTP keychain save/get/delete (rewritten in TS-strict, narrower surface, separate service name)
- `settings.html:943-1026` — live-code + countdown UI shape (rewritten in TS, no jQuery, no inline scripts per CSP)

All rewritten in TS-strict within `lite/totp/`. No `import` from full's root files or `packages/`.

---

## How auto-fill uses this module

`lite/auth/totp-autofill.ts` consumes `getTotpApi().getCurrentCode()` when the Lite sign-in popup reaches the OneReach TOTP prompt. It fills and submits the current code, but never receives or logs the saved secret.

The full app's `gsx-autologin.js` ports the entire OneReach auth ceremony — form detection, email/password fill, TOTP timing windows, retry/backoff, account-picker autoclick. Lite ports only the TOTP slice: user still types email/password and chooses an account, while Lite handles the generated 2FA code if a secret is configured.
