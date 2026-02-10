# Spaces UI Test Plan

## Prerequisites

- App running (`npm start`)
- At least one space with items exists
- Spaces API healthy on port 47291

## Features Documentation

The Spaces UI (`clipboard-viewer.html` + `clipboard-viewer.js`) is the primary visual interface for managing Spaces. It has a sidebar listing all spaces and a main content area showing items. Users can create/rename/delete spaces, add/move/delete items, view/edit metadata, trigger AI metadata generation, search and filter by tags, and use generative (AI-powered) search. The UI communicates with the main process via IPC through `window.clipboard.*` and `window.spaces.*` APIs.

**Key files:** `clipboard-viewer.html`, `clipboard-viewer.js`, `clipboard-manager-v2-adapter.js`
**Window:** Opened via `global.clipboardManager.createClipboardWindow()` or Cmd+Shift+V

## Checklist

### Window Lifecycle
- [ ] `[A]` Spaces Manager window opens without errors
- [ ] `[A]` Window renders sidebar with spaces list
- [ ] `[A]` Window body has substantial content (not blank)

### Space Management
- [ ] `[M]` Create new space via UI -- modal appears, enter name, space appears in sidebar
- [ ] `[M]` Rename space via right-click or edit button -- name updates
- [ ] `[M]` Delete space via UI -- confirmation dialog, space removed from sidebar
- [ ] `[P]` Space item count displays correctly in sidebar (compare with API count)

### Item Display
- [ ] `[M]` Items render in main content area with correct type icons
- [ ] `[M]` Scrolling through many items works smoothly (chunked loading)
- [ ] `[M]` Click item to select -- detail panel or highlight appears
- [ ] `[M]` Pin/unpin item -- pin icon toggles, item moves to top

### Item Actions
- [ ] `[P]` Copy item content to clipboard -- verify clipboard has correct content
- [ ] `[M]` Move item to another space -- move modal, select target, item moves
- [ ] `[M]` Delete item -- confirmation, item removed from list

### Metadata
- [ ] `[M]` Click metadata button -- metadata modal opens with fields populated
- [ ] `[M]` Edit metadata fields and save -- changes persist (verify via API)
- [ ] `[M]` AI metadata generation button triggers generation, fields populate with AI results

### Search and Filter
- [ ] `[P]` Type in search box -- items filter to matching results
- [ ] `[M]` Click tag in sidebar -- items filter to tagged items only
- [ ] `[M]` Generative search: enter natural language query, AI-powered results appear

## Automation Notes

- **Existing coverage:** `test/e2e/spaces-flow.spec.js` (6 tests: CRUD via API, window opens, items list)
- **Gaps:** UI interactions (modals, drag-drop, metadata editing, search)
- **Spec file:** Extend `spaces-flow.spec.js` with UI interaction tests
- **Note:** Many items are `[M]` because they require UI modal interaction and visual verification
