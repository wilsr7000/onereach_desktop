# 24 -- Black Hole (Space Drop)

## Overview

Floating translucent overlay bubble for drag-and-drop content upload to Spaces. Features a space picker modal with search, recent spaces, and content preview.

**Key files:** `black-hole.html`, `black-hole.js`, `preload.js`

## Prerequisites

- App running with at least one Space created
- Black Hole window accessible via menu or keyboard shortcut

## Features

### Drop Zone
- 80px circular translucent bubble with glass-morphism styling
- Expands to 120px on drag-over (hover state)
- Ghost-zone visual effect
- Grab/grabbing cursor states
- Window is always-on-top and transparent

### Space Picker Modal
- Fixed header: "Save to Space"
- Scrollable space list with icon, name, item count, and checkmark for selection
- Recent space chips (pill-shaped quick selectors)
- Search input with search icon to filter spaces
- Content preview showing dropped content type and text
- Cancel and Save buttons
- Saving indicator: spinner + "Saving..." replaces buttons during save

### Content Handling
- Accepts dragged text, images, files, and URLs
- Displays content preview before saving
- Ripple animation on successful save
- Error text on failed save
- Status text below bubble for feedback

---

## Checklist

### Window Lifecycle
- [ ] [A] Black Hole opens via menu (Cmd+Shift+B) or Manage Spaces menu
- [ ] [A] Window loads without console errors
- [ ] [A] Window is transparent and always-on-top
- [ ] [A] Window closes cleanly

### Drop Zone
- [ ] [M] Bubble renders as 80px translucent circle
- [ ] [M] Dragging content over bubble expands it to 120px
- [ ] [M] Cursor changes to grab/grabbing on hover
- [ ] [M] Ghost-zone visual effect is visible

### Drag and Drop
- [ ] [M] Dropping text opens space picker modal
- [ ] [M] Dropping an image opens space picker modal
- [ ] [M] Dropping a file opens space picker modal
- [ ] [M] Dropping a URL opens space picker modal
- [ ] [M] Content preview shows the correct type and text

### Space Picker Modal
- [ ] [M] Modal opens with "Save to Space" header
- [ ] [P] Space list populates from Spaces API
- [ ] [M] Recent spaces appear as chip buttons
- [ ] [M] Clicking a recent space chip selects it
- [ ] [M] Search input filters the space list
- [ ] [M] Clicking a space item selects it (checkmark appears)
- [ ] [M] Only one space can be selected at a time

### Save Flow
- [ ] [M] "Save" button is enabled when a space is selected
- [ ] [M] Clicking "Save" shows saving indicator (spinner)
- [ ] [P] Content is saved to the selected space
- [ ] [M] Success: ripple animation plays
- [ ] [M] Error: error text displays below bubble
- [ ] [M] "Cancel" closes the modal without saving

### Integration
- [ ] [A] Saved content appears in the target Space (verify via Spaces API)
- [ ] [A] Content type is correctly identified (text, image, file, URL)
- [ ] [M] Status text provides feedback after operation

---

## Automation Notes

- Window lifecycle testable via IPC / `electronApp.evaluate()`
- Drag-and-drop is difficult to automate in Electron overlays -- mostly manual
- Space picker modal DOM can be inspected via Playwright page evaluation
- Save verification can check Spaces API for the new item
- Glass-morphism and animation effects are visual-only -- manual verification
- Search filtering can be tested by setting input value and checking filtered list
