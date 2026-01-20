# Onereach.ai Punch List

> Master list of bugs, fixes, and small features to address.
> Updated: January 2026

---

## 🔴 Critical / Blocking

### App Distribution
- [ ] **Notarization not working** - App requires users to bypass Gatekeeper
  - Apple Developer account needed ($99/year)
  - App-specific password required
  - See: `NOTARIZATION-SETUP.md`
  - Files: `notarize-setup.sh`, `build-notarized.sh`

### Build & Release
- [x] ~~Checksum mismatch on auto-update~~ - Fixed in release-master.sh
- [ ] **Windows code signing** - Not implemented
  - See: `WINDOWS-SIGNING-GUIDE.md`
  - Requires EV certificate for SmartScreen trust

---

## 🟠 High Priority

### GSX Create
- [ ] **Task queue persistence** - Verify working across all edge cases
- [x] **Graceful shutdown** - Fixed in v3.8.12 with app quit handlers and forced window close
- [ ] **HUD position** - Sometimes resets after restart
- [ ] **Agent summaries** - Improve quality/relevance

### Video Editor
- [ ] **Voice selector UI** - Currently hardcoded to 'Rachel' voice
  - Location: `video-editor-app.js:2146`
  - Need UI to choose from 9 ElevenLabs voices
- [ ] **Preview AI audio** - Allow preview before applying
- [ ] **Batch processing** - Process multiple ranges at once
- [ ] **Undo/revert** - No undo for audio replacement
- [ ] **ADR track audio loading** - Not implemented
  - Location: `video-editor-app.js:8554`

### Spaces
- [ ] **Large space performance** - Slow with 500+ items
- [ ] **Search indexing** - Full-text search could be faster
- [ ] **Sync conflicts** - Better handling when GSX sync conflicts

---

## 🟡 Medium Priority

### Clipboard Manager
- [ ] **Image paste quality** - Some images lose quality
- [ ] **Large file handling** - Slow with files >50MB
- [ ] **Duplicate detection** - Sometimes misses near-duplicates

### Smart Export
- [ ] **Style guide caching** - Re-fetches on every export
- [ ] **PDF export formatting** - Some layouts break
- [ ] **Custom template editor** - No UI for editing templates

### External AI Agents
- [ ] **Session persistence** - Conversations lost on restart
- [ ] **Multi-window support** - Can't have same agent in multiple windows
- [ ] **Keyboard shortcuts** - No shortcuts for switching agents

### IDW Management
- [ ] **Bulk import/export** - No way to backup all IDW configs
- [ ] **Environment detection** - Sometimes misidentifies environment
- [ ] **GSX link validation** - No validation on URL entry

---

## 🟢 Low Priority / Nice to Have

### UI/UX Polish
- [x] **Spaces UI redesign** - Tufte-inspired polish with elegant icons (v3.8.13)
  - ✅ Replaced ALL emoji icons with clean SVG geometric shapes
  - ✅ Updated asset type icons (video, audio, code, PDF, image, HTML, URL, text, file)
  - ✅ Updated space container icons (circle, action buttons)
  - ✅ Applied Tufte principles: consistent spacing, symmetry, minimal decoration
  - ✅ Removed purple/blue accents → neutral gray palette
  - ✅ Standardized border-radius to 4px throughout
  - ✅ Removed gradients → solid colors only
  - ✅ Improved data density: 280px min columns, 12px gaps (15% more visible)
  - ✅ Faster transitions: 0.2s → 0.1s
  - ✅ Removed transform effects (no scale/translateY on hover)
  - ✅ Created reusable icon library (lib/icon-library.js) with 40+ icons
  - ✅ Comprehensive documentation (SPACES-DESIGN-SYSTEM.md, SPACES-TUFTE-POLISH-COMPLETE.md)
  - Files: clipboard-viewer.html (~150+ style changes), clipboard-viewer.js, lib/icon-library.js
- [ ] **Dark/light theme toggle** - Currently dark only
- [ ] **Font size preferences** - No global font scaling
- [ ] **Window position memory** - Some windows don't remember position
- [ ] **Keyboard navigation** - Incomplete in some modals
- [ ] **Loading states** - Some operations lack feedback

### Performance
- [ ] **Memory usage** - Can grow large with many spaces open
- [ ] **Startup time** - ~5s on cold start, could be faster
- [ ] **Background processes** - Some tasks block UI

### Developer Experience
- [ ] **Hot reload** - Need full restart for most changes
- [ ] **Debug logging** - Inconsistent log levels
- [x] **Test coverage - AI Conversation Capture** - E2E tests for automated conversation capture
  - ✅ Created comprehensive Playwright test suite (`test/e2e/ai-conversation-capture.spec.js`)
  - ✅ Tests all AI services: Claude, ChatGPT, Gemini, Grok, Perplexity
  - ✅ Tests conversation capture, Space creation, formatting, privacy controls
  - ✅ Added test IPC handlers in main.js
  - ✅ Quick start guide: `TEST-AI-CONVERSATION-QUICK-START.md`
  - ✅ Full documentation: `test/README-AI-CONVERSATION-TESTS.md`
  - Run with: `npm run test:e2e:ai-conversation`
- [ ] **Test coverage** - Many other features still lack automated tests

### Documentation
- [ ] **User guide** - No end-user documentation
- [x] **API documentation** - IPC API not fully documented
  - ✅ Created `TOOL-APP-SPACES-API-GUIDE.md` - Full CRUD HTTP API for external tools
  - Extended `spaces-api-server.js` with complete REST endpoints
- [ ] **Video tutorials** - None exist

---

## 🔵 Technical Debt

### Code Quality
- [ ] **TypeScript migration** - Only `aider-bridge-client.ts` is TS
- [ ] **ESLint configuration** - No linting enforcement
- [ ] **Consistent error handling** - Mix of try/catch patterns
- [ ] **Dead code removal** - Multiple `.bak` and legacy files

### Architecture
- [ ] **State management** - Mix of localStorage, IPC, and global vars
- [ ] **Module system** - Some circular dependencies
- [ ] **Preload script consolidation** - 12+ preload scripts

### Dependencies
- [ ] **Electron version** - Review for security updates
- [ ] **npm audit** - Address any vulnerabilities
- [ ] **Unused dependencies** - Cleanup package.json

---

## ✅ Recently Completed

- [x] **Space Filtering Race Condition Fix** (v3.8.14)
  - Fixed: Clicking a space would briefly show filtered items then revert to showing all
  - Root cause: Chunked rendering callbacks from previous renders continued running
  - Solution: Added render version tracking to cancel stale render operations
  - Also fixed: `onSpacesUpdate` listener calling non-existent `renderSpacesList()` function
  - Files: `clipboard-viewer.js`
- [x] **Bulk Operations for Spaces** (v3.8.16)
  - **Bulk Delete**: Select and delete multiple items at once
    - Multi-select checkboxes on all items (hidden by default, appear on hover)
    - Bulk actions toolbar with Select All, Deselect All, and Delete Selected
    - Backend API `items.deleteMany()` for efficient bulk deletion
    - Visual feedback: selected items highlighted, loading states during deletion
  - **Bulk Move**: Move multiple items to another space
    - "Move to Space" button in bulk actions toolbar
    - Dropdown picker showing all available spaces with item counts
    - Backend API `items.moveMany()` for efficient bulk moving
    - Excludes current space from dropdown options
  - IPC handlers: `clipboard:delete-items` and `clipboard:move-items`
  - Comprehensive error reporting with success/failure counts
  - Files: `clipboard-viewer.html`, `clipboard-viewer.js`, `spaces-api.js`, `clipboard-manager-v2-adapter.js`, `preload.js`
- [x] **Grok External AI Agent Integration** (v3.8.15)
  - Added Grok to external AI agents in setup wizard
  - Integrated with conversation capture system
  - Added Grok quick-add button in agent configuration
  - Conversation capture creates dedicated "Grok Conversations" Space (🚀 Gray)
  - Full support for URL detection (x.ai, grok.x.com)
  - Updated documentation: ROADMAP.md, test/EXTERNAL-AI-TEST-README.md
  - Files: `setup-wizard.html`, `main.js`, `src/ai-conversation-capture.js`
- [x] **Spaces Upload Integration** (v3.8.14)
  - Upload files from Spaces directly into ChatGPT, Claude, and file pickers
  - Native dialog wrapping: Shows "Choose from Computer" | "Choose from Spaces"
  - WebView button injection: Adds "📦 Spaces" button to file inputs
  - Settings toggle: Enable/disable in Settings → General
  - Files: `wrapped-dialog.js`, `spaces-upload-handler.js`, `spaces-picker.html`
  - Documentation: `SPACES-UPLOAD-QUICK-START.md`, `SPACES-UPLOAD-TESTING-GUIDE.md`
- [x] **Video Editor prompt() Fix** (v3.8.14)
  - Fixed crash when opening projects with no videos
  - Replaced browser prompt() with Electron-compatible modal
  - Added visual video selection UI with hover effects
  - Shows video metadata (duration, filename)
  - Documentation: `VIDEO-EDITOR-PROMPT-FIX.md`
- [x] **YouTube Download Status Fix** (v3.8.14)
  - Fixed download status not updating to "complete" after 100%
  - Fixed title staying as "Loading..." instead of actual video title
  - Fixed preview text not updating with final title
  - Added index persistence after download completes
  - Documentation: `YOUTUBE-DOWNLOAD-STATUS-FIX.md`
- [x] **Video Editor Spaces API Migration & FFprobe Fix** (v3.8.14)
  - Migrated to universal Spaces API for consistency
  - Added `window.spaces.api` with full CRUD operations
  - Backwards compatible with legacy methods
  - Created diagnostic tool (`diagnose-videos.js`)
  - Added FFprobe binary validation and better error messages
  - Documentation: Multiple guides created (see VIDEO-LOADING-RESOLUTION.md)
  - Note: Video path resolution works; FFprobe binary may need reinstallation
- [x] **Missing import fix** (v3.8.13)
  - Fixed closeAllGSXWindows not imported in main.js
  - Rebuilt keytar native module for ARM64 compatibility
  - Fixes: App launch error "js undefined undefined"
- [x] **Zombie window prevention and app quit fixes** (v3.8.12)
  - Added app lifecycle handlers (before-quit, window-all-closed, will-quit)
  - GSX window tracking system with forced close
  - IPC heartbeat system to prevent zombie windows
  - Proper cleanup of intervals and listeners
  - Close button in GSX toolbar for convenience
  - Fixes: App not quitting, windows not closing after hours open
- [x] **Spaces API tags not saving/retrieving** - Fixed tag handling in HTTP API
  - `handleSendToSpace` now extracts tags from request (root level or metadata.tags)
  - `items.get` now returns tags at root level consistently
  - Updated API documentation
- [x] Hardened release script with checksum verification (v3.7.0)
- [x] Task queue persistence for GSX Create (v3.7.0)
- [x] Graceful shutdown with state save (v3.7.0)
- [x] Phase-specific animations in GSX Create (v3.7.0)
- [x] Execute phase hexagon dot styling (v3.7.0)
- [x] Agent activity HUD with glassmorphism (v3.6.0)
- [x] LLM summarization of agent activity (v3.6.0)
- [x] Budget integration for summaries (v3.6.0)

---

## Notes

### Adding Items
When adding items to this list:
1. Choose appropriate priority section
2. Include brief description
3. Reference relevant files if known
4. Add any related documentation links

### Completing Items
When completing items:
1. Mark with [x]
2. Move to "Recently Completed" with version
3. Update any related documentation

### Priority Definitions
- 🔴 **Critical**: Blocks distribution or causes data loss
- 🟠 **High**: Significant user-facing issues
- 🟡 **Medium**: Improves experience but has workarounds  
- 🟢 **Low**: Nice to have, polish items
- 🔵 **Tech Debt**: Internal improvements

