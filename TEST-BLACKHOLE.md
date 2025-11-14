# Black Hole Widget Test Checklist

## Critical Components
These components MUST work together for the black hole widget to function:

### 1. **clipboard-manager-v2-adapter.js**
- ✅ Only ONE `createBlackHoleWindow()` method should exist
- ✅ Must use `app.getAppPath()` for preload path, NOT `__dirname`
- ✅ Preload must have `sandbox: false` in webPreferences
- ✅ Window size: 150x150 (normal), 600x800 (modal expanded)

### 2. **browser-renderer.js**
- ✅ 3-second hover timeout to open widget
- ✅ Position calculation must center over purple button
- ✅ Paste detection at document level (not button level)

### 3. **black-hole.js**
- ✅ Must handle `paste-clipboard-data` IPC message
- ✅ `alwaysAskForSpace` should default to true for paste
- ✅ Modal resize sends `black-hole:resize-window` IPC

### 4. **main.js**
- ✅ `black-hole:trigger-paste` handler reads clipboard directly
- ✅ Sends `paste-clipboard-data` to widget

## Quick Test Procedure

1. **Test Hover:**
   - Hover over purple button for 3 seconds
   - ✅ Transparent bubble should appear over the button

2. **Test Paste:**
   - Copy some text
   - Press Cmd+V while bubble is open
   - ✅ Window should expand to 600x800
   - ✅ Space selection modal should appear
   - ✅ Select space → content added → window shrinks

3. **Test Drag & Drop:**
   - Drag a file over purple button
   - ✅ Bubble should appear
   - Drop file
   - ✅ Space selection modal should appear

## Common Issues & Fixes

### Issue: "window.clipboard undefined" in modal
**Cause:** Preload script not loading
**Fix:** Check `clipboard-manager-v2-adapter.js`:
- Line ~588: Must use `app.getAppPath()` not `__dirname`
- Line ~608: Must have `sandbox: false`

### Issue: Bubble appears in wrong position
**Cause:** Wrong positioning calculation
**Fix:** Check `browser-renderer.js`:
- Line ~514: Position calculation should center over button

### Issue: Modal too small or broken
**Cause:** Window not resizing properly
**Fix:** Check `clipboard-manager-v2-adapter.js`:
- Line ~930: resize handler must expand to 600x800

### Issue: Paste not triggering modal
**Cause:** IPC handlers missing or wrong
**Fix:** Check chain:
1. `browser-renderer.js` → sends `black-hole:trigger-paste`
2. `main.js` → reads clipboard, sends `paste-clipboard-data`
3. `black-hole.js` → receives data, shows modal

## DO NOT MODIFY WITHOUT TESTING:
- `clipboard-manager-v2-adapter.js` lines 576-638 (createBlackHoleWindow)
- `clipboard-manager-v2-adapter.js` lines 930-956 (resize handler)
- `browser-renderer.js` lines 495-534 (openBlackHole function)
- `main.js` lines 2296-2331 (black-hole:trigger-paste handler)
- `black-hole.js` lines 269-312 (paste-clipboard-data handler)

## Version History
- v1.5.0: Fixed duplicate method issue, preload path, positioning
- v1.4.9: Restored 3-second hover, ensured space chooser for paste
- v1.4.8: Added direct clipboard reading
- v1.4.7: Initial paste handling attempt
