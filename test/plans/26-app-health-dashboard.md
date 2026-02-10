# 26 -- App Health Dashboard

## Overview

Nine-tab system health monitoring dashboard with Apple Health-style ring charts, activity feeds, spaces analytics, log viewer, LLM usage tracking, pipeline monitoring, agent diagnostics, broken item registry, and settings/maintenance controls.

**Key files:** `app-health-dashboard.html`, `app-health-dashboard.js`, `preload-health-dashboard.js`

## Prerequisites

- App running with health monitoring active
- Some activity data (items added, AI calls, etc.) for meaningful dashboard content

## Features

### Overview Tab
- 3 health rings (Apple Health-style SVG): Stability, Pipeline, Healing with overall score
- App status card: running status, uptime, memory usage, CPU
- Today's summary: items added, AI operations, errors, auto-fixed count
- Spaces health: utilization meter, active spaces count, total items
- LLM costs: per-provider (Claude/OpenAI) cost, call count, monthly totals
- Activity feed: live stream with real-time indicator
- Agent status banner: agent indicator, last scan time, fixes today

### Activity Tab
- Filterable/searchable activity table
- Filters: type, time range, space
- Search across activity text
- CSV export button

### Spaces Tab
- Table of spaces: items, size, last used, health status
- Analytics charts: items by type distribution, storage distribution

### Logs Tab
- Log viewer with auto-refresh toggle
- Level filter (debug/info/warn/error)
- Search across log messages
- Download logs, clear display, open log folder buttons

### LLM Usage Tab
- Provider cards: calls count, tokens used, cost, average cost per call
- Feature breakdown: which features use the most AI
- Recent operations list with timestamps

### Pipeline Tab
- Stage success rates: Validation, Storage, Thumbnail, Metadata
- Recent pipeline runs table with status
- Verification summary with "Run Full Integrity Check" button

### Agent Tab
- Agent status: Active/Paused with Run Now/Pause toggle
- Configuration: check interval (30s/1m/5m), auto-fix mode (aggressive/conservative/report), LLM provider, notifications toggle
- Today's activity stats
- Recent diagnoses list
- Issues requiring attention

### Broken Items Tab
- Issue registry with status filter (open/fixed/ignored)
- Current version vs archived issues
- Issue details with fix actions

### Settings Tab
- Refresh interval configuration
- Notifications toggle
- Data retention settings
- Export buttons: JSON, activity report, LLM report
- Maintenance: integrity check, clear cache, reset stats

---

## Checklist

### Window Lifecycle
- [ ] [A] Dashboard opens via menu (Cmd+Shift+H) or IPC
- [ ] [A] Window loads without console errors
- [ ] [A] Window closes cleanly
- [ ] [M] All 9 tabs render without errors

### Overview Tab
- [ ] [M] Health rings render as SVG with animated fill
- [ ] [P] Overall health score displays and is numeric
- [ ] [P] App status card shows uptime and memory
- [ ] [P] Today's summary shows item/AI/error counts
- [ ] [P] Spaces health shows utilization meter
- [ ] [P] LLM costs show per-provider breakdown
- [ ] [P] Activity feed displays recent events
- [ ] [P] Agent status banner shows last scan time

### Activity Tab
- [ ] [M] Activity table loads with data
- [ ] [M] Type filter dropdown filters entries
- [ ] [M] Time range filter works (1h, 24h, 7d, etc.)
- [ ] [M] Space filter narrows to specific space
- [ ] [M] Search input filters by text content
- [ ] [A] CSV export downloads a valid CSV file

### Spaces Tab
- [ ] [P] Spaces table lists all spaces with stats
- [ ] [P] Items, size, last used columns are accurate
- [ ] [M] Analytics charts render (items by type, storage distribution)

### Logs Tab
- [ ] [M] Log entries display with level-colored borders
- [ ] [M] Level filter toggles show/hide log levels
- [ ] [M] Search filters log entries
- [ ] [M] Auto-refresh toggle enables/disables polling
- [ ] [M] Download button saves log file
- [ ] [M] Clear display removes entries from view
- [ ] [M] Open log folder opens in Finder

### LLM Usage Tab
- [ ] [P] Provider cards show calls, tokens, cost for each provider
- [ ] [P] Average cost per call is calculated correctly
- [ ] [P] Feature breakdown lists AI features by usage
- [ ] [P] Recent operations show timestamps and costs

### Pipeline Tab
- [ ] [P] Stage success rates display percentages
- [ ] [P] Recent pipeline runs table shows status per run
- [ ] [P] Verification summary shows integrity status
- [ ] [M] "Run Full Integrity Check" button triggers check and shows results

### Agent Tab
- [ ] [P] Agent status shows Active or Paused
- [ ] [M] Pause/Run Now toggle changes agent state
- [ ] [M] Check interval dropdown changes frequency
- [ ] [M] Auto-fix mode selector changes strategy
- [ ] [M] LLM provider dropdown changes provider
- [ ] [M] Notifications toggle enables/disables alerts
- [ ] [P] Today's activity stats are accurate
- [ ] [P] Recent diagnoses list shows entries

### Broken Items Tab
- [ ] [P] Issue registry loads open/fixed/ignored items
- [ ] [M] Status filter switches between open/fixed/ignored
- [ ] [M] Issue details expand to show full information
- [ ] [M] Fix actions are available for open issues

### Settings Tab
- [ ] [M] Refresh interval selector changes polling frequency
- [ ] [M] Notifications toggle persists
- [ ] [M] Data retention settings save
- [ ] [A] JSON export downloads complete health data
- [ ] [A] Activity report export generates report
- [ ] [A] LLM report export generates report
- [ ] [M] Clear cache button clears cached data
- [ ] [M] Reset stats button resets counters

---

## Automation Notes

- Window lifecycle testable via IPC / smoke test pattern
- Health ring SVG attributes can be checked for correct values
- Activity and Spaces data require the app to have run with real activity
- CSV export can be verified by checking downloaded file content
- Log tab overlaps with the standalone Log Viewer (plan 27)
- Pipeline tab requires pipeline runs to have data
- Agent tab state changes can be triggered and verified via IPC
- Settings persistence can be verified across dashboard reloads
