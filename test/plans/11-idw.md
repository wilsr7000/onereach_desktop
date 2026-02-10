# IDW Test Plan

## Prerequisites

- App running (`npm start`)
- OneReach credentials configured in Settings (for IDW store fetch)
- Network access to `em.staging.api.onereach.ai` (for directory fetch)

## Features Documentation

IDW (Intelligent Digital Worker) environments are OneReach chatbot interfaces that open in isolated browser tabs within the app. They are managed via the IDW Store (`idw-store.html`), Setup Wizard (`setup-wizard.html`), or direct settings entry. Each IDW has an ID, label, chat URL, environment, and optional description. IDW entries are stored in both `settings-manager.js` (as `idwEnvironments`) and synced to `idw-entries.json` for menu compatibility. When an IDW is opened, it gets an isolated session partition and multi-tenant token injection.

**Key files:** `idw-store.html`, `setup-wizard.html`, `menu-data-manager.js`, `lib/menu-sections/idw-gsx-builder.js`
**IPC namespace:** `idw-store:*`, settings IDW sync
**Storage:** `idwEnvironments` setting + `idw-entries.json`

## Checklist

### IDW Store
- [ ] `[P]` IDW Store window opens without errors (`idw-store.html`)
- [ ] `[P]` Store fetches directory from API (network request succeeds)
- [ ] `[M]` Browse available IDWs -- list renders with names and descriptions
- [ ] `[M]` Install IDW from store -- item added to `idwEnvironments` setting

### Menu Integration
- [ ] `[P]` Installed IDW appears in the IDW menu section
- [ ] `[M]` Click IDW menu item -- new tab opens with IDW chat URL
- [ ] `[M]` IDW tab loads in isolated partition (session cookies separate from other tabs)

### Setup Wizard
- [ ] `[M]` Setup Wizard opens without errors (`setup-wizard.html`)
- [ ] `[M]` Add IDW manually via URL entry -- IDW appears in settings and menu
- [ ] `[M]` Remove IDW via wizard -- IDW removed from settings and menu

### Environment Sync
- [ ] `[A]` `idw-entries.json` stays in sync with `idwEnvironments` setting after save
- [ ] `[A]` Menu rebuilds after IDW list changes (no stale menu items)

## Automation Notes

- **Existing coverage:** None
- **Gaps:** All items need new tests
- **Spec file:** Create `test/e2e/idw.spec.js`
- **Strategy:** Store fetch can be tested via IPC evaluate; menu integration via menu inspection
- **Note:** IDW Store directory fetch requires network -- may need mock in CI
