# 35 -- Context Menu & Keyboard Shortcuts

## Overview

Right-click context menu in the main browser window and all global/local keyboard shortcuts across the application.

**Key files:** `menu.js`, `main.js`, `browserWindow.js`, `preload.js`

## Prerequisites

- App running with main window visible
- Some content loaded in tabs (for context menu targets)
- Various windows open (for per-window shortcuts)

## Features

### Context Menu (Right-Click)
- **Cut:** Available when text is selected in an editable field
- **Copy:** Available when text is selected
- **Paste:** Available when clipboard has content
- **Select All:** Always available
- **Send to Space:** Available when text is selected -- sends selection to a Space
- **Send Image to Space:** Available when right-clicking an image
- **Copy Image:** Available when right-clicking an image
- **Paste to Space:** Always available -- pastes clipboard content to a Space

### Global Keyboard Shortcuts
| Shortcut | Action |
|---|---|
| Cmd+1 through Cmd+9 | Open IDW environments 1-9 |
| Alt+1 through Alt+4 | Open External AI bots |
| Shift+Cmd+1 through Shift+Cmd+4 | Open Image Creators |
| Cmd+, | Open Settings |
| Cmd+A | Add/Remove IDW environments (Setup Wizard) |
| Cmd+Shift+V | Show Clipboard History / Spaces Manager |
| Cmd+Shift+U | Open Black Hole (Upload) |
| Cmd+Shift+B | Report a Bug |
| Cmd+Shift+O | Toggle Voice Orb |
| Cmd+Shift+A | Open GSX Create |
| Cmd+Shift+G | Create Agent with AI (Agent Composer) |
| Cmd+Shift+H | Open App Health Dashboard |
| Cmd+Q | Quit application |

### Test-Mode Shortcuts (toggle with Cmd+Alt+H)
| Shortcut | Action |
|---|---|
| Cmd+Shift+T | Open Integrated Test Runner |
| Cmd+Shift+L | Open Event Log Viewer |
| Cmd+Alt+H | Toggle test menu visibility |

### Per-Window Shortcuts
- **Video Editor:** Various editing shortcuts (documented in video-editor.html)
- **Recorder:** Space (record), Esc (stop), S (save), comma (settings)
- **Detached Player (local control):** Space (play/pause), arrows (seek), P (pin)
- **Intro Wizard:** Arrow keys (navigate slides), Enter (advance), Escape (close)
- **Format Picker:** Escape (close), Enter (create)
- **Command HUD Disambiguation:** 1-5 (select option), Escape (cancel)

### Edit Menu (Standard)
- Undo (Cmd+Z)
- Redo (Cmd+Shift+Z)
- Cut (Cmd+X)
- Copy (Cmd+C)
- Paste (Cmd+V)
- Paste and Match Style (Cmd+Shift+V)
- Delete
- Select All (Cmd+A)
- Speech: Start Speaking, Stop Speaking

---

## Checklist

### Context Menu -- Text
- [ ] [M] Right-click on selected text shows "Cut", "Copy", "Select All"
- [ ] [M] "Cut" removes text and copies to clipboard
- [ ] [M] "Copy" copies text to clipboard
- [ ] [M] "Paste" inserts clipboard content
- [ ] [M] "Select All" selects all text in the field

### Context Menu -- Send to Space
- [ ] [M] Right-click on selected text shows "Send to Space"
- [ ] [M] "Send to Space" opens space picker and saves selection
- [ ] [M] "Paste to Space" always appears in context menu
- [ ] [M] "Paste to Space" saves clipboard content to a Space

### Context Menu -- Images
- [ ] [M] Right-click on an image shows "Send Image to Space"
- [ ] [M] "Send Image to Space" saves the image to a Space
- [ ] [M] "Copy Image" copies the image to clipboard

### Global Shortcuts -- IDW
- [ ] [M] Cmd+1 opens first IDW environment
- [ ] [M] Cmd+2 through Cmd+9 open respective environments
- [ ] [M] Alt+1 through Alt+4 open external AI bots
- [ ] [M] Shift+Cmd+1 through Shift+Cmd+4 open image creators

### Global Shortcuts -- Tools
- [ ] [A] Cmd+, opens Settings window
- [ ] [A] Cmd+Shift+O toggles Voice Orb
- [ ] [A] Cmd+Shift+A opens GSX Create
- [ ] [A] Cmd+Shift+G opens Agent Composer
- [ ] [A] Cmd+Shift+H opens App Health Dashboard
- [ ] [A] Cmd+Shift+V opens Spaces Manager
- [ ] [A] Cmd+Shift+U opens Black Hole
- [ ] [M] Cmd+Shift+B opens Bug Report dialog

### Global Shortcuts -- Setup
- [ ] [A] Cmd+A opens Setup Wizard

### Test-Mode Shortcuts
- [ ] [A] Cmd+Alt+H toggles test menu visibility
- [ ] [A] Cmd+Shift+T opens Test Runner (when test menu visible)
- [ ] [A] Cmd+Shift+L opens Log Viewer (when test menu visible)

### Edit Menu
- [ ] [M] Cmd+Z undoes last action
- [ ] [M] Cmd+Shift+Z redoes last undone action
- [ ] [M] Cmd+X cuts selected content
- [ ] [M] Cmd+C copies selected content
- [ ] [M] Cmd+V pastes clipboard content
- [ ] [M] Cmd+A selects all content

### Recorder Shortcuts
- [ ] [M] Space bar starts/stops recording
- [ ] [M] Escape stops recording
- [ ] [M] S saves recording
- [ ] [M] Comma opens settings

### Detached Player Shortcuts (local control mode)
- [ ] [M] Space toggles play/pause
- [ ] [M] Left/right arrows seek
- [ ] [M] P toggles pin (always-on-top)

### Intro Wizard Shortcuts
- [ ] [M] Left/right arrows navigate slides
- [ ] [M] Enter advances to next slide
- [ ] [M] Escape closes wizard

### Format Picker Shortcuts
- [ ] [M] Escape closes the picker
- [ ] [M] Enter creates document (when format selected)

### HUD Disambiguation Shortcuts
- [ ] [M] 1-5 selects numbered option
- [ ] [M] Escape cancels disambiguation

---

## Automation Notes

- Context menu can be triggered via Playwright `page.click({ button: 'right' })`
- Context menu items are Electron native menus -- interaction requires `electronApp.evaluate()` or custom IPC
- Global shortcuts testable by sending keyboard events and verifying window opens
- Some shortcuts conflict (Cmd+Shift+V is both Spaces Manager and Paste without Style)
- Test-mode shortcuts require toggling test menu first
- Per-window shortcuts need the respective window focused
- Edit menu shortcuts are system-standard and typically "just work" in Electron
