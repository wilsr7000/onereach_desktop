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
- [ ] **Graceful shutdown** - Ensure all state saves on quit
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
- [ ] **Test coverage** - Many features lack automated tests

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

