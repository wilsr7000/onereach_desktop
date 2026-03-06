# Spaces Upload Integration - Testing Guide

## Overview

The Spaces Upload Integration allows users to upload files from Spaces directly into file pickers throughout the app. This guide covers testing all integration points.

## Feature Toggle

**Setting**: Settings → General Settings → Spaces Upload Integration  
**Default**: Enabled  
**Effect**: When enabled, all file pickers show "Choose from Spaces" option

## Testing Scenarios

### 1. Settings Toggle

**Test**: Verify setting control works
- [ ] Open Settings
- [ ] Find "Spaces Upload Integration" toggle
- [ ] Toggle OFF → save → reopen app
- [ ] Verify no "Choose from Spaces" dialogs appear
- [ ] Toggle ON → save → reopen app
- [ ] Verify "Choose from Spaces" dialogs reappear

### 2. Native Dialog Wrapping

**Test**: GSX Create folder selection
1. Open GSX Create (Aider UI)
2. Click "Select Folder" or "Open Repository"
3. Dialog should appear: "Choose from Computer" | "Choose from Spaces" | "Cancel"
4. Click "Choose from Computer" → Native picker opens
5. Select a folder → Should work normally
6. Repeat, click "Choose from Spaces" → Spaces picker opens
7. Select items → Should return file paths

**Expected**: Dialog appears before every native file picker in the app

### 3. WebView Button Injection (ChatGPT)

**Test**: File upload in ChatGPT
1. Open Browser → Navigate to chatgpt.com
2. Log in (if needed)
3. Start a new chat
4. Look for the paperclip/attachment icon
5. Click to upload → Native browser file picker opens
6. Look for "📦 Spaces" button next to the file input
7. Click "📦 Spaces" button → Spaces picker window opens
8. Select files from Spaces → Click "Select"
9. Files should appear in ChatGPT's upload queue
10. Send message with files → Should upload correctly

**Expected**: Spaces button appears, files inject successfully

### 4. WebView Button Injection (Claude)

**Test**: File upload in Claude
1. Open Browser → Navigate to claude.ai
2. Log in (if needed)
3. Start a new conversation
4. Look for the file attachment option
5. Click to upload → Look for "📦 Spaces" button
6. Click "📦 Spaces" button → Spaces picker window opens
7. Select files → Click "Select"
8. Files should appear in Claude's upload area
9. Send message with files → Should upload correctly

**Expected**: Spaces button appears, files inject successfully

### 5. Generic Web Form

**Test**: Any website with file upload
1. Open Browser → Navigate to a site with file upload (e.g., Google Drive, Dropbox)
2. Find file upload button/area
3. Click to upload
4. Look for "📦 Spaces" button
5. Click button → Spaces picker opens
6. Select files → Confirm upload works

**Sites to test**:
- [ ] Google Drive
- [ ] Dropbox
- [ ] Gmail (attachment)
- [ ] Generic HTML form

### 6. Spaces Picker Functionality

**Test**: Browse and select from Spaces
1. Open Spaces picker (via any method above)
2. Verify all Spaces appear in sidebar
3. Click on a Space → Items load in grid
4. Use filter buttons → Items filter correctly
5. Use search box → Items filter by search
6. Click items → Selection toggles (purple border)
7. Select multiple items → Counter updates
8. Click "Cancel" → Picker closes, nothing selected
9. Select items → Click "Select" → Files returned

**Expected**: All UI functions work smoothly

### 7. File Type Handling

**Test**: Different item types export correctly

**Text items**:
- [ ] Select text item → Exports as .txt or .md
- [ ] File contains correct content
- [ ] Uploads to chat successfully

**Code items**:
- [ ] Select code item → Exports with proper extension
- [ ] File contains correct content
- [ ] Syntax highlighting works in chat

**Image items**:
- [ ] Select image → Exports as image file
- [ ] Image displays in chat preview
- [ ] Can send with message

**Native file items**:
- [ ] Select file item → Uses original file path
- [ ] File uploads correctly
- [ ] Large files work (videos, etc.)

### 8. Multi-File Selection

**Test**: Upload multiple files at once
1. Open Spaces picker
2. Select 3-5 items of different types
3. Click "Select"
4. Verify all files appear in upload queue
5. Upload should succeed for all files

**Expected**: All selected items upload correctly

### 9. Temp File Cleanup

**Test**: Temp files are cleaned up
1. Upload text/code/image items (creates temp files)
2. Check temp directory: `os.tmpdir()/spaces-upload-*`
3. Wait 5 minutes OR quit app
4. Verify temp files are deleted

**Expected**: No orphaned temp files remain

### 10. Error Handling

**Test**: Graceful failure scenarios

**No items selected**:
- [ ] Open picker → Click "Select" without selecting → Should close gracefully

**Network issues**:
- [ ] Open picker while offline → Should show error or empty state

**Invalid file**:
- [ ] Select item with missing file → Should skip gracefully

**Disabled feature**:
- [ ] Disable in settings → Verify no errors occur

## Known Limitations

### Won't Work In
- Sites using shadow DOM exclusively (rare)
- Drag-and-drop only uploads (no `<input>` element)
- Sites with custom file pickers (non-standard)
- Sites with strict CSP blocking file:// protocol

### Edge Cases
- Some modern React/Vue apps may require page reload to see button
- Button position may vary based on site's CSS
- Some sites may style the button unexpectedly

## Troubleshooting

### Button doesn't appear in webview
- Check: Is setting enabled?
- Check: Does page have `<input type="file">`?
- Try: Reload the page
- Check console: Look for injection errors

### Files don't inject into chat
- Check: Browser console for errors
- Verify: Files exist at returned paths
- Check: CSP allows file:// protocol
- Try: Use native picker instead

### Dialog doesn't appear for native pickers
- Check: Is setting enabled?
- Verify: `wrapped-dialog.js` is loaded correctly
- Check: `dialog` import uses wrapped version
- Restart app and try again

### Spaces picker shows no spaces
- Check: Spaces API is initialized
- Verify: OR-Spaces directory exists
- Check: Index is loaded correctly
- Try: Reload app

## Success Criteria

✅ Feature is working if:
- Dialog appears for native file pickers
- Buttons appear in ChatGPT/Claude
- Can browse all Spaces in picker
- Can select and upload files successfully
- Can disable feature in settings
- Temp files are cleaned up
- No linter errors

## Feedback Welcome

If you encounter issues:
1. Check console for error messages
2. Verify setting is enabled
3. Try different file types
4. Report specific site/scenario where it fails
