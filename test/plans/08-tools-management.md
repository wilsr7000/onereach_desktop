# Tools Management Test Plan

## Prerequisites

- App running (`npm start`)
- Module API bridge initialized (happens on startup)

## Features Documentation

Tools are managed via the Module Manager (`module-api-bridge.js`). There are two types: **Modules** (installed packages with local code) and **Web Tools** (external URLs opened in isolated webview tabs). Adding a web tool also auto-creates an agent for it. Tools appear in the application Tools menu. The Module Manager provides IPC handlers for listing, adding, opening, and deleting tools.

**Key files:** `module-api-bridge.js`, `module-ai-reviewer.js`
**IPC namespace:** `module:*`
**Storage:** `web-tools.json` (user data directory)

## Checklist

### Web Tools CRUD
- [ ] `[A]` `module:get-web-tools()` returns array of web tools (may be empty)
- [ ] `[A]` `module:add-web-tool({ name, url, description })` creates tool and returns it
- [ ] `[A]` After add, `module:get-web-tools()` includes the new tool
- [ ] `[A]` `module:delete-web-tool(toolId)` removes tool from list
- [ ] `[P]` Adding a web tool auto-creates a matching agent (verify via `agents:list`)

### Opening Tools
- [ ] `[M]` `module:open-web-tool(toolId)` opens tool URL in a new tab with isolated partition
- [ ] `[M]` Tool tab loads the correct URL and functions normally

### Module Items
- [ ] `[A]` `module:get-module-items()` returns installed modules (may be empty)
- [ ] `[M]` Opening a module launches its corresponding window/UI

### Menu Integration
- [ ] `[P]` Added web tools appear in the Tools menu after menu refresh

## Automation Notes

- **Existing coverage:** None
- **Gaps:** All items need new tests
- **Spec file:** Create `test/e2e/tools-management.spec.js`
- **Strategy:** IPC-level tests via `electronApp.evaluate` for CRUD; menu integration via menu inspection
