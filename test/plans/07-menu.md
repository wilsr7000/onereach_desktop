# Menu Test Plan

## Prerequisites

- App running (`npm start`)
- At least one IDW environment configured (for dynamic menu items)
- Module Manager has at least one module installed (for Tools menu)

## Features Documentation

The application menu (`menu.js`) is built dynamically with 8 top-level sections: App (macOS), IDW, GSX, Agentic University, Manage Spaces, Tools, Help, and Share. Several sections contain dynamic items that refresh when settings change: IDW environments, GSX links, installed modules, and web tools. The menu system uses `MenuDataManager` for data and section builders in `lib/menu-sections/`. Context menus are also available in webviews and on tab right-click.

**Key files:** `menu.js`, `lib/menu-sections/idw-gsx-builder.js`, `menu-data-manager.js`
**Refresh triggers:** Settings save, IDW add/remove, module update, `menuDataManager.refresh()`

## Checklist

### Menu Structure
- [ ] `[A]` Application menu is present (not null) after app launch
- [ ] `[A]` Menu has expected top-level items (IDW, GSX, University, Manage Spaces, Tools, Help, Share)
- [ ] `[P]` Each top-level menu has at least one submenu item

### IDW Menu (Dynamic)
- [ ] `[M]` IDW environments appear as numbered menu items
- [ ] `[M]` Clicking an IDW item opens it in a new tab
- [ ] `[M]` "Explore IDW Store" opens the IDW Store window
- [ ] `[M]` "Add/Remove" opens the Setup Wizard

### Tools Menu
- [ ] `[M]` "Toggle Voice Orb" toggles the orb (Cmd+Shift+O)
- [ ] `[M]` "Manage Agents..." opens Agent Manager window
- [ ] `[M]` "Create Agent with AI..." opens Agent Composer (Cmd+Shift+G)
- [ ] `[M]` Installed modules appear as menu items under Tools

### Manage Spaces Menu
- [ ] `[M]` "Show Clipboard History" opens Spaces Manager (Cmd+Shift+V)
- [ ] `[M]` "Open Black Hole" opens Black Hole window (Cmd+Shift+U)

### Keyboard Shortcuts
- [ ] `[A]` Cmd+Shift+O triggers orb toggle (verify via window state)
- [ ] `[A]` Cmd+Shift+H opens Health Dashboard (verify window appears)
- [ ] `[A]` Cmd+, opens Settings window (verify window appears)

### Menu Refresh
- [ ] `[P]` Add IDW via setup wizard -- menu updates to include new item without restart
- [ ] `[P]` Install a module -- Tools menu updates to include new module item
- [ ] `[A]` No error-level logs during menu construction (check log server)

## Automation Notes

- **Existing coverage:** None (no menu-specific spec file)
- **Gaps:** Menu item presence can be tested via `electronApp.evaluate` on `Menu.getApplicationMenu()`
- **Spec file:** Create `test/e2e/menu.spec.js`
- **Strategy:** Use `electronApp.evaluate(({ Menu }) => { ... })` to inspect menu structure programmatically
