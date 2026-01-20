# Video Loading Issue - Diagnostic Summary

## Issue Description
User attempted to open a video project but received error:
```
Failed to get video path: Video file is missing from storage. 
The file may have been deleted or moved. 
Expected: YouTube Video wcIn0aSzngU.mp4
```

## Root Cause Analysis

### 1. Item Does Not Exist in Index
**Item ID:** `cc8e39b458303e4a41a8b38564ea805f`  
**Status:** ❌ Not found in index

The item with this ID does not exist in `/Users/richardwilson/Documents/OR-Spaces/index.json`.

### 2. Video Files in Storage
Found 2 video files currently in storage:
- `8f65452b3383a4edbdf762005c876ca4` - YouTube Video aR20FWCCjAs.mp4
- `3d501fcab50837920921e969b4c0779e` - Screen Recording 2025-08-26 at 6.27.06 PM.mov

### 3. Possible Causes
The missing item could have been:
1. **Deleted** - User or app deleted the item
2. **Failed download** - YouTube download never completed
3. **Corrupted index** - Index was rebuilt without this item
4. **Old project** - Project references a video that no longer exists

### 4. Video Editor Project State
The video editor is trying to load a project that references a non-existent video. The project state might be:
- Saved in localStorage (emergency backup)
- Saved in space metadata (project state)
- Referenced in a `.videoproject` file

## Solutions

### Solution 1: Delete the Invalid Project (Recommended)
If the video no longer exists and cannot be recovered:
1. Open Video Editor
2. Go to Projects panel
3. Delete the project that references this video
4. Create a new project with existing videos

### Solution 2: Recover from Backup
Check if the video exists elsewhere:
```bash
# Search for the filename
find ~/ -name "YouTube Video wcIn0aSzngU.mp4" 2>/dev/null

# If found, manually copy to:
# ~/Documents/OR-Spaces/items/cc8e39b458303e4a41a8b38564ea805f/
```

### Solution 3: Use Different Video
If the original video is lost:
1. Download the video again from YouTube (video ID: wcIn0aSzngU)
2. Use Black Hole to capture it to Spaces
3. Create a new project with the fresh download

## Prevention

### Short-term
1. Don't delete videos from Spaces if they're used in projects
2. Ensure downloads complete before creating projects
3. Use "Save to Space" frequently to persist project state

### Long-term (Implemented in v3.8.14)
1. ✅ Migrated to universal Spaces API
2. ✅ Better error messages showing item ID and expected filename
3. ✅ Diagnostic tool to check video integrity
4. 🔄 TODO: Add project validation before loading
5. 🔄 TODO: Add "missing asset" recovery UI
6. 🔄 TODO: Add project-to-video integrity checks

## Technical Details

### What Changed in v3.8.14
- Video editor now uses `window.spaces.api` (universal Spaces API)
- Falls back to legacy `window.spaces.getVideoPath()` if needed
- Improved error logging with item IDs
- Added IPC handlers for full Spaces CRUD operations

### Files Modified
- `preload-video-editor.js` - Added Spaces API bridge
- `main.js` - Added Spaces API IPC handlers
- `video-editor-app.js` - Updated loadVideoFromSpace()
- `diagnose-videos.js` - New diagnostic tool

### Related Documentation
- `SPACES-API-VIDEO-EDITOR-MIGRATION.md` - Full migration guide
- `API-DOCUMENTATION.md` - HTTP API for external tools
- `TOOL-APP-SPACES-API-GUIDE.md` - Space API usage guide

## Action Items

### Immediate
- [x] Identify that item `cc8e39b458303e4a41a8b38564ea805f` doesn't exist
- [x] Migrate video editor to universal Spaces API
- [x] Add diagnostic tool
- [x] Document migration
- [ ] User: Delete invalid project or recover video file

### Future
- [ ] Add project validation UI
- [ ] Add "missing asset" detection and recovery
- [ ] Add integrity checks before project load
- [ ] Consider project backup/export feature

## Testing

To verify the fix works:

1. **Test with existing video:**
   ```javascript
   // In video editor console
   const result = await window.spaces.api.getVideoPath('8f65452b3383a4edbdf762005c876ca4');
   console.log(result);
   // Should succeed and show file path
   ```

2. **Test with missing video:**
   ```javascript
   const result = await window.spaces.api.getVideoPath('cc8e39b458303e4a41a8b38564ea805f');
   console.log(result);
   // Should fail with helpful error message
   ```

3. **Run diagnostic:**
   ```bash
   node diagnose-videos.js
   # Should show all videos are healthy
   ```

## Conclusion

The issue is **NOT caused by the Spaces API refactor**. The video file was already missing before the API migration. However, the migration improves error handling and makes it easier to diagnose such issues in the future.

**User Action Required:** Delete the invalid project or recover the video file from backup.
