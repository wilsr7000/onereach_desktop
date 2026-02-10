# 33 -- Pickers & Floating UIs

## Overview

Small, focused windows for selection and floating content display: Tab Picker, Spaces Picker, Float Card, and Detached Video Player.

**Key files:** `tab-picker.html`, `tab-picker.js`, `spaces-picker.html`, `spaces-picker-renderer.js`, `float-card.html`, `float-card.js`, `detached-video-player.html`

## Prerequisites

- App running
- Browser extension installed and connected (for Tab Picker)
- At least one Space with items (for Spaces Picker)
- Video loaded in Video Editor (for Detached Player)

## Features

### Tab Picker (`tab-picker.html`)
- Lists open browser tabs from the extension
- Each tab shows: favicon, title, URL, active badge
- Connection status indicator (green=connected, red=disconnected)
- Select a tab to attach
- Manual URL input as fallback
- Empty state when extension not installed
- Loading spinner while fetching tabs

### Spaces Picker (`spaces-picker.html`)
- Sidebar: list of all Spaces with icon, name, item count
- Content area: grid of items in selected Space
- Type filtering tabs: All, Files, Images, Text, Code
- Search functionality
- Multi-select support with selection count
- Tufte-inspired minimalist design (clean, light theme)
- SVG geometric icons

### Float Card (`float-card.html`)
- Glassmorphism design (blur, transparency, rounded corners)
- Draggable card for file upload
- Content preview: images, files with icon + name
- Close button (red on hover)
- "Drag to upload" hint text
- Success animation (green pulse, border color change)
- Window dragging support

### Detached Video Player (`detached-video-player.html`)
- Standalone always-on-top video player
- Remote-controlled from main Video Editor window
- Playback sync API: setSource, syncPlayback, getState, setPinned
- Pin indicator (always-on-top toggle)
- Time display (current / duration) in status bar
- Reports time updates back to main window via IPC
- Debug mode via URL param (`?debug=1`)
- Optional local control mode (`?localControl=1`)
- Keyboard shortcuts (Space, arrows, P for pin) in local control

---

## Checklist

### Tab Picker -- Window
- [ ] [A] Tab Picker opens via `createTabPickerWindow()` IPC
- [ ] [A] Window loads without console errors
- [ ] [A] Window closes cleanly

### Tab Picker -- Extension Connected
- [ ] [P] Connection status shows green dot when extension connected
- [ ] [P] Tab list populates with open browser tabs
- [ ] [M] Each tab shows favicon, title, URL
- [ ] [M] Active tab has "active" badge
- [ ] [M] Selecting a tab highlights it
- [ ] [M] "Attach Selected" button attaches the tab

### Tab Picker -- Extension Disconnected
- [ ] [P] Connection status shows red dot
- [ ] [M] Empty state message shows with setup link
- [ ] [M] Manual URL input is available
- [ ] [M] "Fetch" button accepts the URL

### Tab Picker -- Loading
- [ ] [M] Spinner shows while fetching tabs

### Spaces Picker -- Window
- [ ] [A] Spaces Picker opens via IPC
- [ ] [A] Window loads without console errors

### Spaces Picker -- Sidebar
- [ ] [P] Space list populates from Spaces API
- [ ] [M] Each space shows icon, name, item count
- [ ] [M] Clicking a space loads its items in the content area

### Spaces Picker -- Content Area
- [ ] [M] Items grid shows cards for each item
- [ ] [M] Cards show icon and name
- [ ] [M] Clicking an item selects it (border highlight)
- [ ] [M] Multiple items can be selected

### Spaces Picker -- Filtering
- [ ] [M] "All" tab shows all items
- [ ] [M] "Files" tab filters to file items
- [ ] [M] "Images" tab filters to image items
- [ ] [M] "Text" tab filters to text items
- [ ] [M] "Code" tab filters to code items

### Spaces Picker -- Search
- [ ] [M] Search input filters items by text
- [ ] [M] Clearing search restores all items

### Spaces Picker -- Selection
- [ ] [M] Selection count updates as items are selected
- [ ] [M] "Select" button confirms selection
- [ ] [M] "Cancel" button closes without selection

### Float Card -- Window
- [ ] [A] Float Card opens as floating overlay
- [ ] [A] Window is transparent with glassmorphism effect
- [ ] [A] Window closes cleanly

### Float Card -- Content
- [ ] [M] Image preview displays for image content
- [ ] [M] File icon + name displays for file content
- [ ] [M] "Drag to upload" hint is visible

### Float Card -- Interaction
- [ ] [M] Card is draggable (window dragging support)
- [ ] [M] Close button (X) closes the card
- [ ] [M] Close button turns red on hover
- [ ] [M] Dragging to target triggers upload
- [ ] [M] Success: green pulse animation plays

### Detached Player -- Window
- [ ] [A] Detached Player opens from Video Editor "detach" button
- [ ] [A] Window loads without console errors
- [ ] [A] Window is always-on-top by default

### Detached Player -- Playback
- [ ] [P] Video source set via `setSource()` from main window
- [ ] [P] Playback syncs with main Video Editor
- [ ] [M] Time display shows current / duration
- [ ] [P] Time updates reported back to main window

### Detached Player -- Pin
- [ ] [M] Pin indicator visible on hover
- [ ] [M] Toggling pin changes always-on-top state
- [ ] [P] `setPinned()` API changes pin state programmatically

### Detached Player -- Local Control
- [ ] [P] Local control mode enabled via `?localControl=1`
- [ ] [M] Space bar toggles play/pause
- [ ] [M] Arrow keys seek forward/backward
- [ ] [M] P key toggles pin

---

## Automation Notes

- Tab Picker requires browser extension connection -- mostly manual unless extension is mocked
- Spaces Picker testable via Playwright if space data exists
- Float Card glassmorphism is visual-only -- automation checks DOM state
- Detached Player sync testable by sending IPC commands from main Video Editor context
- Multi-select in Spaces Picker verifiable by counting selected DOM elements
- Pin state changes verifiable via window `alwaysOnTop` property
