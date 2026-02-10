# 34 -- Native Dialogs

## Overview

Native Electron `dialog.showMessageBox` dialogs triggered from various menu items and system events. These are OS-native modals, not HTML windows.

**Key files:** `menu.js`, `main.js`, `browserWindow.js`

## Prerequisites

- App running
- Various features configured (for context-specific dialogs)

## Features

### Keyboard Shortcuts Dialog
- Triggered from Help > Keyboard Shortcuts
- Info dialog listing all keyboard shortcuts
- Multi-line formatted text

### Validate & Clean Storage Dialog
- Triggered from Manage Spaces > Validate & Clean Storage
- Question dialog with 3 buttons: Check Only, Check & Fix, Cancel
- Shows validation results after scan

### Storage Summary Dialog
- Triggered from Manage Spaces > Storage Summary
- Info dialog showing storage statistics
- Space count, item count, total size

### Claude Code Status Dialog
- Triggered from Tools > Claude Code Status
- Info or Warning dialog depending on status
- Shows connection state, version, recent activity

### Bug Report Dialog
- Triggered from Help > Report a Bug (Cmd+Shift+B)
- Multi-button dialog: GitHub Issue, Email, Copy to Clipboard, Save to File, Cancel
- Collects system info, error logs, and description

### Export Debug Info Dialog
- Triggered from Help > Export Debug Info
- Multi-button dialog: Copy to Clipboard, Save to File, Cancel
- Exports system info, settings (sanitized), error logs

### Check for Updates Dialog
- Triggered from Help > Check for Updates
- Info dialog when auto-update not configured
- Shows current version and update instructions

### Backup Selection Dialog
- Triggered from Help > Manage Backups > View Available Backups
- Question dialog listing available backups
- Select a backup to restore from

### Download Handler Dialog
- Triggered when a file download occurs in the browser
- Question dialog: Save to Downloads, Save to Space, Cancel
- Context-dependent based on file type

### GSX Sync Result Dialogs
- Triggered after GSX file sync operations
- Info dialog on success (files synced, time elapsed)
- Error dialog on failure (error details)

### ElevenLabs Test Dialog
- Triggered from Help (test) > Test ElevenLabs APIs
- Info dialog showing API test results
- TTS, SFX, voice list results

---

## Checklist

### Keyboard Shortcuts
- [ ] [M] Help > Keyboard Shortcuts opens dialog
- [ ] [M] Dialog lists all keyboard shortcuts
- [ ] [M] OK button closes dialog

### Validate & Clean Storage
- [ ] [M] Manage Spaces > Validate & Clean Storage opens dialog
- [ ] [M] "Check Only" runs validation without changes
- [ ] [P] Validation results display item count, issues found
- [ ] [M] "Check & Fix" runs validation with auto-fix
- [ ] [P] Fixed items count shows in results
- [ ] [M] "Cancel" closes without action

### Storage Summary
- [ ] [M] Manage Spaces > Storage Summary opens dialog
- [ ] [P] Shows total spaces count
- [ ] [P] Shows total items count
- [ ] [P] Shows total storage size

### Claude Code Status
- [ ] [M] Tools > Claude Code Status opens dialog
- [ ] [P] Shows connection status
- [ ] [P] Shows version information if connected
- [ ] [M] Dialog closes on OK

### Bug Report
- [ ] [M] Help > Report a Bug opens multi-button dialog
- [ ] [M] "GitHub Issue" opens GitHub in browser with pre-filled template
- [ ] [M] "Email" opens email client with debug info
- [ ] [M] "Copy to Clipboard" copies debug info
- [ ] [M] "Save to File" saves debug info to disk
- [ ] [P] Debug info includes system info, version, error logs

### Export Debug Info
- [ ] [M] Help > Export Debug Info opens dialog
- [ ] [M] "Copy to Clipboard" copies sanitized debug data
- [ ] [M] "Save to File" saves to chosen location
- [ ] [P] Exported data excludes API keys and sensitive settings

### Check for Updates
- [ ] [M] Help > Check for Updates opens dialog
- [ ] [P] Shows current version number
- [ ] [P] Shows update instructions or status

### Backup Selection
- [ ] [M] Help > Manage Backups > View Available Backups opens dialog
- [ ] [P] Lists available backup files with dates
- [ ] [M] Selecting a backup and confirming initiates restore
- [ ] [M] Cancel closes without action

### Download Handler
- [ ] [M] Downloading a file triggers the dialog
- [ ] [M] "Save to Downloads" saves to Downloads folder
- [ ] [M] "Save to Space" opens space picker then saves
- [ ] [M] "Cancel" cancels the download

### GSX Sync Results
- [ ] [P] Successful sync shows info dialog with stats
- [ ] [P] Failed sync shows error dialog with details
- [ ] [M] OK button closes the result dialog

### ElevenLabs Test
- [ ] [M] Help (test) > Test ElevenLabs APIs triggers tests
- [ ] [P] Results dialog shows TTS test result
- [ ] [P] Results dialog shows SFX test result
- [ ] [P] Results dialog shows voice list result

---

## Automation Notes

- Native Electron dialogs are NOT accessible via Playwright page selectors
- Playwright can intercept dialog events via `electronApp.evaluate()` or by mocking `dialog.showMessageBox`
- Alternative: use `app.on('dialog')` or override `dialog` module in test mode
- Download handler testable by triggering a download in a browser tab
- Bug report and debug export content verifiable by intercepting clipboard
- Storage summary and validation results depend on actual space data
- Most dialog tests require manual interaction due to native OS rendering
