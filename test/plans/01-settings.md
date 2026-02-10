# Settings Test Plan

## Prerequisites

- App running (`npm start`)
- Log server healthy (`curl http://127.0.0.1:47292/health`)
- At least one API key configured (for LLM connection test)

## Features Documentation

The Settings window (`settings.html`) provides configuration for all app services via a tabbed sidebar layout. Settings are persisted by `settings-manager.js` in the user data directory. There are 6 tabs: API Keys, AI Configuration, OneReach Login, GSX File Sync, Budget, and General. Changes to some settings (logging level, IDW environments) take effect immediately without restart.

**Key files:** `settings.html`, `settings-manager.js`, `main.js` (IPC handlers)
**IPC namespace:** `settings:get-all`, `settings:save`, `settings:test-llm`
**Window:** Opened via `global.openSettingsWindowGlobal()` or menu

## Checklist

### Window Lifecycle
- [ ] `[A]` Settings window opens without errors (via `global.openSettingsWindowGlobal`)
- [ ] `[A]` Sidebar renders 6 tabs (API Keys, AI Configuration, OneReach Login, GSX File Sync, Budget, General)
- [ ] `[A]` Clicking each sidebar tab shows the correct content pane
- [ ] `[A]` Diagnostic logging dropdown exists with correct options (Off, Error, Warn, Info, Debug)

### Settings Persistence
- [ ] `[A]` `GET /logging/level` returns persisted level after save
- [ ] `[A]` Settings round-trip: save via REST, read back, values match
- [ ] `[A]` Logging level change applies immediately (`POST /logging/level`, verify via `GET /logging/level`)

### API Key Management
- [ ] `[M]` Enter an API key, save, reopen settings -- key field shows masked value
- [ ] `[M]` Test LLM Connection button sends `settings:test-llm` and shows success/failure toast
- [ ] `[M]` TOTP section: enter secret, verify code generates and countdown displays

### Budget Settings
- [ ] `[A]` Budget tab renders all 3 fields (enabled toggle, show estimates toggle, threshold input)
- [ ] `[A]` Budget settings save and reload correctly

### AI Conversation Capture
- [ ] `[A]` Conversation Capture subsection renders all controls under AI Configuration tab
- [ ] `[A]` Conversation Capture settings save and reload correctly

### Side Effects
- [ ] `[A]` IDW menu syncs when settings with `idwEnvironments` are saved (menu rebuilds)
- [ ] `[P]` Saving settings does not produce error-level logs (check log server after save)

## Automation Notes

- **Existing coverage:** `test/e2e/settings-flow.spec.js` (3 tests: window opens with sidebar tabs, logging level, persistence)
- **Gaps:** API key round-trip (requires real keys), TOTP functionality (requires screen interaction)
- **Spec file:** `test/e2e/settings-flow.spec.js`
