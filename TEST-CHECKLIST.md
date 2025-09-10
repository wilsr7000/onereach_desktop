# Onereach.ai - Quick Test Checklist

## 🧬 Integrated Test Runner Available
**New!** Many of these tests can now be run automatically:
1. Press `Cmd+Alt+H` (Mac) or `Ctrl+Alt+H` (Windows) to activate test menu
2. Go to Help → 🧬 Integrated Test Runner
3. Run automated tests and track manual checklist items

See [TEST-RUNNER-GUIDE.md](./TEST-RUNNER-GUIDE.md) for details.

## Pre-Release Checklist (15 min)

### 🚀 Launch & Initialize
- [ ] App launches without errors
- [ ] Tray icon appears
- [ ] Main window opens (Cmd/Ctrl+Shift+V)
- [ ] Settings load correctly

### 📋 Clipboard Core
- [ ] Copy text → appears in history
- [ ] Copy image → thumbnail generated
- [ ] Copy code → syntax highlighted
- [ ] Copy URL → link detected
- [ ] Search works across all items

### 🕳️ Black Hole Widget
- [ ] Widget appears on screen
- [ ] Can drag and move widget
- [ ] Drag file → space selector modal appears
- [ ] File saves to selected space
- [ ] Widget position remembered

### 📁 Spaces
- [ ] Create new space with icon
- [ ] Move item between spaces
- [ ] Filter by space works
- [ ] Delete space → items go to Unclassified
- [ ] Space counts update correctly

### 🌐 IDW Integration
- [ ] Open IDW from menu
- [ ] IDW loads in app window
- [ ] Can navigate within IDW
- [ ] Multiple IDWs open in separate windows
- [ ] GSX tools menu populated

### 📤 Export
- [ ] Select items → Smart Export
- [ ] Generate article/document
- [ ] Preview looks correct
- [ ] Download as HTML/PDF works
- [ ] Regenerate produces new content

### ⚙️ Settings
- [ ] API keys save (check encryption)
- [ ] Toggle spaces on/off
- [ ] Clear history (items remain in storage)
- [ ] Changes persist after restart

### 🔄 Updates
- [ ] Check for updates works
- [ ] Update notification appears (if available)
- [ ] Rollback menu shows backups

### 🖥️ Platform-Specific

#### macOS Only
- [ ] PDF shows actual thumbnail
- [ ] Source app detected (Safari, Chrome, etc.)
- [ ] Screenshot auto-captured
- [ ] No permission errors

#### Windows Only
- [ ] PDF shows generic icon (no crash)
- [ ] File paths handled (C:\...)
- [ ] No chmod errors
- [ ] Tray icon works

### 🐛 Common Issues to Check
- [ ] Large clipboard content (>10MB)
- [ ] Special characters in text (emoji, unicode)
- [ ] Rapid copy/paste operations
- [ ] Network disconnected → AI features show offline
- [ ] Invalid API key → proper error message

## Critical Path (5 min)

If time is limited, test only these:

1. **Launch**: App starts, no errors
2. **Copy/Paste**: Text appears in history  
3. **Black Hole**: Can drag file
4. **Spaces**: Can create and switch
5. **Export**: Can generate document

## Post-Build Verification

After building:
- [ ] DMG/installer opens correctly
- [ ] App launches from Applications folder
- [ ] Code signing valid (no "damaged" message)
- [ ] Version number correct in About
- [ ] Auto-updater points to correct server

## Performance Sanity Check
- [ ] Launch time < 3 seconds
- [ ] No beach ball/spinning wheel during normal use
- [ ] Memory usage reasonable (< 300MB idle)
- [ ] CPU usage low when idle (< 5%)

---

**Time to complete**: 
- Full checklist: ~15 minutes
- Critical path: ~5 minutes
- Smoke test: ~2 minutes 