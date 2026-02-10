# Authentication Test Plan

## Prerequisites

- App running (`npm start`)
- OneReach account credentials available (email + password)
- TOTP secret available (for 2FA tests)

## Features Documentation

Authentication is handled by `auth-manager.js` for credential management and `multi-tenant-store.js` for token injection into isolated webview partitions. The flow is: user saves OneReach credentials in Settings, the app obtains authentication tokens, and tokens are injected as cookies into webview partitions before OneReach URLs load. TOTP (Time-based One-Time Password) support allows automatic 2FA code generation. Partitions can be registered for token refresh propagation.

**Key files:** `auth-manager.js`, `multi-tenant-store.js`, `settings.html` (OneReach credentials section)
**IPC namespace:** `onereach:*`, `totp:*`, `multi-tenant:*`
**Storage:** `auth-sessions.json` (user data directory)
**Cookie domains:** `.edison.onereach.ai`, `.edison.api.onereach.ai`

## Checklist

### Credential Storage
- [ ] `[A]` `onereach:save-credentials({ email, password })` stores credentials
- [ ] `[A]` `onereach:get-credentials()` retrieves stored email (password masked or hashed)
- [ ] `[A]` `onereach:delete-credentials()` removes stored credentials
- [ ] `[A]` After delete, `onereach:get-credentials()` returns null/empty

### TOTP
- [ ] `[A]` `onereach:save-totp({ secret })` stores TOTP secret
- [ ] `[A]` `totp:get-current-code()` returns a 6-digit code when secret is configured
- [ ] `[M]` TOTP display in Settings shows code with countdown timer
- [ ] `[M]` `totp:scan-qr-screen()` triggers screen QR code scanning

### Token Injection
- [ ] `[A]` `multi-tenant:has-token(environment)` returns boolean
- [ ] `[P]` `multi-tenant:inject-token({ environment, partition })` sets cookies on correct domains
- [ ] `[P]` Injected cookies cover both `.edison.onereach.ai` and `.edison.api.onereach.ai`

### Partition Management
- [ ] `[A]` `multi-tenant:register-partition({ environment, partition })` registers for refresh
- [ ] `[A]` `multi-tenant:unregister-partition({ environment, partition })` removes registration

## Automation Notes

- **Existing coverage:** None
- **Gaps:** All items need new tests
- **Spec file:** Create `test/e2e/authentication.spec.js`
- **Strategy:** Credential CRUD and TOTP testable via `electronApp.evaluate`
- **Note:** Token injection requires valid OneReach credentials -- may need test account or mock
- **Security:** Do not commit real credentials in test files; use env vars or test fixtures
