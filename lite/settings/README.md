# `lite/settings/` — Settings window

A small Settings window opened from `Onereach.ai Lite -> Settings...`. v1 ships one section — Two-Factor — which re-hosts the existing TOTP authenticator UI inside the Settings shell. Future sections (Account, Updates, Diagnostics, About) land as additional `mount(el)` functions in `lite/settings/sections/`.

- **Public API**: [`api.ts`](api.ts) — `SettingsApi` interface, `getSettingsApi()` singleton
- **Internal**:
  - [`main.ts`](main.ts) — IPC + `initSettings` / `teardown` handle (`@internal`)
  - [`window.ts`](window.ts) — single-instance `BrowserWindow` factory (`@internal`)
  - [`types.ts`](types.ts) — `SectionDescriptor` shape
  - [`settings.html`](settings.html) / [`settings.css`](settings.css) / [`settings.ts`](settings.ts) — renderer shell
  - [`sections/two-factor.ts`](sections/two-factor.ts) — Two-Factor section renderer (consumes `getTotpApi()` via `window.lite.totp.*`)
- **Tests**: [`../test/unit/settings-api.test.ts`](../test/unit/settings-api.test.ts)
- **Decision rationale**: [DECISIONS.md ADR-031](../DECISIONS.md#adr-031-settings-window-with-one-section-per-adr-019-two-factor-migrates-from-standalone-tools-window)

---

## What it is

The Settings window is the canonical home for configurable surfaces in lite. Its first complete section is Two-Factor, which generates the current GSX / OneReach 2FA code from a saved authenticator secret. Subsequent sections (Account, Updates, Diagnostics, About) are appended to a hand-written list in [`settings.ts`](settings.ts) without changing the shell.

Two-Factor workflow:

1. Add the OneReach authenticator secret once (scan the setup QR, paste a QR image, or enter the long Base32 secret key).
2. Settings stores that secret in the OS keychain via `lite/totp/`.
3. Settings generates the rotating six-digit code (`847 293` style).
4. During Lite sign-in, the auth popup can auto-fill that generated code when OneReach asks for 2FA. The user can still copy it manually from Settings as a fallback.

The Two-Factor section does **not** accept the current six-digit login code as input. It accepts the long-lived authenticator secret and then generates the login code used by Lite's sign-in flow.

Security notes shown in the UI:

- The authenticator secret is stored in the macOS Keychain / system credential vault.
- The secret is not written to app settings, logs, bug reports, or KV storage.
- Lite never shows the saved secret again after setup.
- Lite only displays the temporary six-digit code, which expires every 30 seconds.
- Lite reads the same OneReach authenticator secret used by the full Onereach.ai app, so existing full-app 2FA setup can generate codes here too.

The window opens from `Onereach.ai Lite -> Settings...` (macOS app-menu convention), positioned between About and Quit. No accelerator is bound (`Cmd+,` is the macOS convention but per `.cursorrules` accelerators are user-named, not added speculatively).

```typescript
// Main-process consumer
import { getSettingsApi } from '../settings/api.js';
getSettingsApi().open();   // open or focus the Settings window
```

```typescript
// Renderer
await window.lite.settings.open();
```

---

## Sections shipped in v1

The shell renders a sidebar tab + content pane per entry in the `SECTIONS` list (see [`settings.ts`](settings.ts)). Tabs are lazily mounted on first activation and disposed on window close.

| Section id | Title | Implementation |
|---|---|---|
| `account` | Account | [`sections/account.ts`](sections/account.ts) -- consumes `window.lite.auth.*`. Sign in / sign out for OneReach Edison. |
| `two-factor` | Two-Factor | [`sections/two-factor.ts`](sections/two-factor.ts) -- consumes `window.lite.totp.*` to configure the authenticator secret and generate the current GSX / OneReach 2FA code. |
| `oagi` | OAGI | [`sections/neon.ts`](sections/neon.ts) -- consumes `window.lite.neon.*`. Configure the OAGI / Neon endpoint, Neo4j Aura URI, and credentials. |
| `updates` | Updates | placeholder copy; auto-update mechanics live in [`lite/updater/`](../updater/) |
| `diagnostics` | Diagnostics | [`sections/diagnostics.ts`](sections/diagnostics.ts) -- consumes `window.lite.health.snapshot()` (ADR-036). Renders a current-state snapshot across documented Lite modules: app metadata, open windows, auth / TOTP / Neon / updater state, recent error/warn counts. Refresh + Copy as JSON. Snapshot type cannot carry secrets. |
| `developer` | Developer | [`sections/developer.ts`](sections/developer.ts) -- one button: Open API Reference. |
| `about` | About | placeholder copy |

---

## API quick reference

| Method | Returns | Throws? | Notes |
|---|---|---|---|
| `open()` | `void` | No | Idempotent. Opens or focuses the Settings window. No-op until `initSettings()` runs at boot. |

See [`api.ts`](api.ts) for full JSDoc.

---

## How to add a new section

The shell auto-builds the sidebar tab and content pane from the section descriptor — you don't touch [`settings.html`](settings.html). To add a new section:

1. **Write** the renderer logic in `lite/settings/sections/<id>.ts` exporting a `mount<Id>(container) -> disposer | undefined` function. Use the [`SectionDescriptor['mount']`](types.ts) type.

2. **Append** to the section list in [`settings.ts`](settings.ts):

   ```typescript
   const SECTIONS: SectionDescriptor[] = [
     // ...existing entries...
     {
       id: 'general',
       title: 'General',
       icon: ICON_GENERAL,        // 16x16 inline SVG, currentColor stroke
       mount: mountGeneral,
     },
   ];
   ```

3. **Add** any section-specific styles to [`settings.css`](settings.css) under a section-prefixed class (e.g. `.gen-something` for "general"). Shell styles (`.btn-primary`, `.btn-secondary`, `.banner.*`, `.pane-*`) are shared.

4. **Add** a section-specific README block here if the section consumes a non-trivial backing module.

The list is still hand-written rather than a runtime registry; promote when 3+ sections need conditional visibility / order overrides (per ADR-031 "registry deferred until needed").

---

## Renderer bridge (`window.lite.settings`)

The preload exposes a single method:

```typescript
await window.lite.settings.open();   // opens or focuses Settings
```

The bridge is shared between renderers — the placeholder window can call `window.lite.settings.open()` to deep-link future "Manage 2FA" or "Configure" affordances directly into Settings.

---

## Persistence

None in v1. The TOTP secret already lives in keychain via `lite/totp/store.ts`; Settings has no own state.

When future sections need persistence, they will use [`lite/kv/`](../kv/) under collection `lite-settings` — non-secrets only. Secrets continue to use the OS keychain via `keytar` per the pattern in `lite/totp/` and `lite/auth/`.

---

## Why no real "section registry" yet?

ADR-031 picks the simplest forward-compatible shape: a hand-written list of `SectionDescriptor` in [`settings.ts`](settings.ts). Adding a section means appending to a list and adding a mount point in HTML — about 5 lines per section. A real registry (with order, conditional visibility, lazy loading, etc.) becomes worth it when there are 3+ sections; until then, the indirection costs more than it saves.

---

## Testing

Per Rule 12 (LITE-RULES.md / ADR-024):

- **API conformance** -- [`settings-api.test.ts`](../test/unit/settings-api.test.ts) runs `runApiConformanceContract` with `expectedMethods: ['open']`.
- **Section behavior** -- exercised via `lite/totp/` tests since the Two-Factor section is a thin renderer over `getTotpApi()`. Settings does not own the data path.
- **`window.ts` coverage** -- manual smoke only in v1 (the BrowserWindow factory is the same shape as `lite/auth/window.ts`). E2E is tracked as `settings-e2e` in `PORTING.md` deferred queue.

---

## Borrowed patterns (studied, never imported)

Per LITE-RULES.md cherry-pick discipline:

- Full app `settings.html:36-101` -- sidebar + content-area layout (lite mirrors this with sidebar tabs + lazy-mounted panes; full's `onclick="..."` handlers are replaced with `addEventListener` because lite's CSP forbids inline scripts)
- Full app `settings.html:481-551` -- sidebar tab markup (icon + label, active-state border)
- Full app `settings.html:943-1026` -- two-factor UI shape, already adapted in ADR-027 and now relocated into [`sections/two-factor.ts`](sections/two-factor.ts)
- Single-instance window pattern from the deleted `lite/totp/window.ts` and `lite/bug-report/main.ts`

All rewritten in TS-strict within `lite/settings/`. No `import` from full's root files or `packages/`.
