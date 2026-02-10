# Web Monitoring Test Plan

## Prerequisites

- App running (`npm start`)
- Spaces API healthy on port 47291
- A test space designated for monitor captures
- Network access to a stable test URL (e.g., `https://example.com`)

## Features Documentation

The Web Monitoring system (`website-monitor.js`) uses Playwright for browser automation to periodically check websites for changes. Users can create monitors with a URL, optional CSS selector for targeting specific elements, and a check interval. The system generates SHA-256 content hashes for change detection, captures screenshots (optional), generates diffs, and saves changes to a designated Space. Monitors can be paused, resumed, and deleted. Change history is tracked per monitor.

**Key files:** `website-monitor.js`, `clipboard-manager-v2-adapter.js` (IPC handlers)
**IPC namespace:** `clipboard:add-website-monitor`, `clipboard:check-website`, `clipboard:get-website-monitors`, `clipboard:get-monitor-history`, `clipboard:pause-website-monitor`, `clipboard:resume-website-monitor`, `clipboard:remove-website-monitor`
**Storage:** Monitors in JSON file, snapshots in dedicated directory

## Checklist

### Monitor CRUD
- [ ] `[A]` `clipboard:add-website-monitor({ url, name, selector, interval, spaceId })` creates monitor
- [ ] `[A]` `clipboard:get-website-monitors()` returns list including new monitor
- [ ] `[A]` `clipboard:remove-website-monitor(monitorId)` removes monitor
- [ ] `[A]` After remove, monitor no longer appears in list

### Manual Check
- [ ] `[A]` `clipboard:check-website(monitorId)` triggers immediate check, returns result
- [ ] `[A]` Check result includes content hash and timestamp
- [ ] `[P]` Check captures screenshot when screenshot option enabled

### Change Detection
- [ ] `[A]` First check establishes baseline hash
- [ ] `[A]` Second check of unchanged page returns same hash (no change detected)
- [ ] `[P]` When page changes, new check returns different hash and diff

### Pause/Resume
- [ ] `[A]` `clipboard:pause-website-monitor(monitorId)` pauses monitor
- [ ] `[A]` Paused monitor does not run periodic checks
- [ ] `[A]` `clipboard:resume-website-monitor(monitorId)` resumes periodic checks

### CSS Selector Targeting
- [ ] `[P]` Monitor with CSS selector only captures content from that element
- [ ] `[P]` Monitor without selector captures full page body

### History and Space Integration
- [ ] `[A]` `clipboard:get-monitor-history(monitorId)` returns array of check results
- [ ] `[P]` Detected changes are saved as items in the designated Space

## Automation Notes

- **Existing coverage:** None
- **Gaps:** All items need new tests
- **Spec file:** Create `test/e2e/web-monitoring.spec.js`
- **Strategy:** Create monitor for `https://example.com`, run checks via IPC, verify hashes
- **Note:** Change detection test needs a URL that actually changes, or a local test server
- **Tip:** Use `electronApp.evaluate` to call IPC handlers directly for all operations
