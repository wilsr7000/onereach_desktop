# lite/help

Single-window user guide for Onereach.ai Lite.

## What this module does

Provides `Help → Onereach.ai Lite Help` in the application menu. Opens a
single-instance `BrowserWindow` rendering `help.html` — a TOC-sidebar +
scrolling-content document covering every Lite feature: sign-in, 2FA,
Settings, IDWs, Tools, AI Run Times, University, Bug Reports,
Auto-Update, logs, troubleshooting.

## Files

| File | Role |
|---|---|
| `help.html` | Static content. Sticky TOC sidebar + sectioned main area. |
| `help.css` | Layout + design-token styles. Extends `signature.css`. |
| `help.ts` | Renderer entry. Stamps the version, drives the TOC scroll-spy. Bundled to `dist-lite/build/help.js`. |
| `window.ts` | Single-instance `BrowserWindow` factory with `?section=<id>` deep-link support. |
| `menu-wiring.ts` | Registers `help:user-guide` under `top:help` at order 10. |
| `main.ts` | Orchestrator: `initHelp(opts)` returns a `HelpHandle` with `.open(sectionId?)` and `.teardown()`. |

## Wiring

`initHelp` is called from `lite/main-lite.ts` after the menu seed runs.
The kernel seed (`lite/menu/seed.ts`) leaves room above `Report a Bug...`
for the User Guide entry; this module fills it.

## Deep-linking to a section

`handle.open('two-factor')` opens (or focuses) the window and scrolls to
`#two-factor`. The renderer reads `?section=<id>` on first paint and the
window factory pokes `executeJavaScript` to scroll on subsequent calls.

Anchor ids in `help.html` follow the section names: `welcome`,
`getting-started`, `signing-in`, `two-factor`, `settings`, `ai-roster`,
`tools`, `ai-run-times`, `university`, `bug-reports`, `auto-update`,
`diagnostics`, `keyboard`, `privacy`, `troubleshooting`, `about`.

## Editing content

The help document is plain HTML — no Markdown pipeline. Edit
`help.html` directly. Section structure: each top-level `<section
id="...">` becomes one TOC entry; add it to the TOC nav in the same
file. The CSP forbids inline scripts, so any new interactivity goes in
`help.ts` (which is bundled, not loaded inline).

## Tests

`lite/test/unit/help-menu-wiring.test.ts` covers the menu registration:
parent, label, order, and click-handler invocation. The window factory
is exercised indirectly via `initHelp` in tests that mock the window
shell.
