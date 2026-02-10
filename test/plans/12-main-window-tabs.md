# Main Window & Tabs Test Plan

## Prerequisites

- App running (`npm start`)
- Main window loaded (`tabbed-browser.html`)

## Features Documentation

The main window (`tabbed-browser.html`) is a tabbed browser interface managed by `browser-renderer.js`. Each tab is a `<webview>` element with an isolated session partition (`persist:tab-{timestamp}-{random}`). Tabs support multi-tenant token injection for OneReach URLs, preload script injection, microphone/WebRTC permissions, and popup handling. External URLs are blocked from navigating within the app and instead open in the system browser. The tab picker allows listing and capturing tab content.

**Key files:** `tabbed-browser.html`, `browser-renderer.js`, `browserWindow.js`
**IPC namespace:** `log:tab-*`, `tab-picker:*`, `tab-action`
**Window:** Main window, always present

## Checklist

### Window Load
- [ ] `[A]` Main window loads `tabbed-browser.html` successfully
- [ ] `[A]` Main window title is present and non-empty
- [ ] `[A]` No error-level logs during initial window load

### Tab Creation
- [ ] `[A]` Creating a new tab via IPC produces a tab with unique partition
- [ ] `[M]` New tab loads the specified URL correctly
- [ ] `[M]` Tab header shows URL/title and is clickable

### Tab Switching
- [ ] `[M]` Click a different tab -- content switches, previous tab hidden
- [ ] `[M]` Tab switching preserves page state (scroll position, form inputs)
- [ ] `[A]` Tab switch event logged (`log:tab-switched`)

### Tab Closing
- [ ] `[M]` Close tab via X button -- tab removed from header bar
- [ ] `[A]` Tab close event logged (`log:tab-closed`)
- [ ] `[P]` Closing tab cleans up partition and unregisters from IDW registry

### Multi-Tenant Token Injection
- [ ] `[P]` Opening a OneReach URL auto-detects environment and injects token
- [ ] `[P]` Token injection happens before page load completes (cookies set on correct domain)
- [ ] `[M]` User is auto-logged-in when opening IDW tab (no login prompt)

### Navigation Security
- [ ] `[A]` Navigation to non-allowed external URL is blocked (event logged)
- [ ] `[M]` Blocked URL opens in system default browser instead

### Tab Picker
- [ ] `[A]` `tab-picker:get-tabs()` returns list of open tabs with IDs and URLs
- [ ] `[P]` `tab-picker:capture-tab(tabId)` captures tab content/screenshot

## Automation Notes

- **Existing coverage:** `test/e2e/window-smoke.spec.js` (main window loads without errors)
- **Gaps:** Tab CRUD, switching, multi-tenant injection, navigation blocking
- **Spec file:** Create `test/e2e/tabs.spec.js`
- **Strategy:** Tab creation/closing testable via `electronApp.evaluate`; multi-tenant requires OneReach URL
