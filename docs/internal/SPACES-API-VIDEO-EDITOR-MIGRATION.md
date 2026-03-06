# Spaces API Migration for Video Editor

## Overview

The video editor has been updated to use the universal Spaces API introduced in v3.8.x. This provides:
- Consistent API across all apps
- Better error handling and logging
- Forward compatibility with future storage improvements
- Backwards compatibility with existing projects

## What Changed

### Before (Legacy)
```javascript
// Direct IPC call to legacy handler
const result = await window.spaces.getVideoPath(videoId);
```

### After (Unified API)
```javascript
// Uses universal Spaces API with fallback
const result = await window.spaces.api.getVideoPath(videoId);
// Falls back to: window.spaces.getVideoPath(videoId) if needed
```

## API Structure

The video editor now has access to the full Spaces API:

```javascript
window.spaces.api = {
  // Convenience methods
  getVideoPath: (itemId) => Promise<{success, filePath, fileName, scenes, error}>,
  
  // Space management
  list: () => Promise<Space[]>,
  get: (spaceId) => Promise<Space>,
  create: (name, options) => Promise<Space>,
  update: (spaceId, data) => Promise<boolean>,
  delete: (spaceId) => Promise<boolean>,
  
  // Item management
  items: {
    list: (spaceId, options) => Promise<Item[]>,
    get: (spaceId, itemId) => Promise<Item>,
    add: (spaceId, item) => Promise<Item>,
    update: (spaceId, itemId, data) => Promise<boolean>,
    delete: (spaceId, itemId) => Promise<boolean>,
    move: (itemId, fromSpaceId, toSpaceId) => Promise<boolean>
  },
  
  // File access
  files: {
    getSpacePath: (spaceId) => Promise<string>,
    list: (spaceId, subPath) => Promise<FileInfo[]>,
    read: (spaceId, filePath) => Promise<string>,
    write: (spaceId, filePath, content) => Promise<boolean>
  }
}
```

## Troubleshooting Video Loading Issues

### Error: "Video file is missing from storage"

This error means the physical video file cannot be found on disk. Common causes:

#### 1. Check if the file exists
```bash
# Video files should be in:
~/Documents/OR-Spaces/items/<itemId>/<filename>.mp4

# Example:
ls -la ~/Documents/OR-Spaces/items/cc8e39b458303e4a41a8b38564ea805f/
```

#### 2. Verify the item exists in the index
```bash
# Check the index
cat ~/Documents/OR-Spaces/index.json | grep "cc8e39b458303e4a41a8b38564ea805f"
```

#### 3. Check for orphaned metadata
Sometimes the index entry exists but the file is missing:
```bash
# List all files in item directory
ls -la ~/Documents/OR-Spaces/items/cc8e39b458303e4a41a8b38564ea805f/
# Should contain: metadata.json, thumbnail.jpg, <video-file>.mp4
```

#### 4. Possible causes of missing files
- **Manual deletion** - File was deleted outside the app
- **Failed download** - YouTube/source download incomplete
- **Storage moved** - OR-Spaces folder was moved or renamed
- **Disk space** - Download failed due to full disk
- **Permissions** - App lacks write permissions

### Recovery Options

#### Option 1: Re-download the video
If it's a YouTube video, you can:
1. Delete the broken item from the space
2. Use Black Hole to re-capture the video
3. Create a new project with the fresh download

#### Option 2: Import from local file
If you have the video file elsewhere:
1. Copy it to: `~/Documents/OR-Spaces/items/<itemId>/`
2. Rename to match the expected filename (check logs)
3. Reload the video editor

#### Option 3: Rebuild the index
If multiple videos are missing:
```javascript
// In the app console
const { getSpacesAPI } = require('./spaces-api');
const api = getSpacesAPI();
await api.rebuildIndex(); // Scans all item directories
```

## Migration Notes for Developers

### Preload Changes
File: `preload-video-editor.js`

Added full Spaces API bridge with:
- Space CRUD operations
- Item CRUD operations  
- File system access
- Backwards-compatible `getVideoPath()` wrapper

### Main Process Changes
File: `main.js`

Added IPC handlers for:
- `spaces-api:getVideoPath` - Unified video path resolver
- `spaces-api:list` - List all spaces
- `spaces-api:get` - Get single space
- `spaces-api:items:*` - Full item CRUD
- `spaces-api:files:*` - File system access

### Renderer Changes
File: `video-editor-app.js`

Updated `loadVideoFromSpace()` to:
1. Try new Spaces API first
2. Fall back to legacy method if needed
3. Provide detailed error messages

## Future Improvements

### Phase 1: Full Migration (v3.9)
- Remove all direct ClipboardStorage access
- Use `spaces.api.items.get()` exclusively
- Add video-specific methods to Spaces API

### Phase 2: Metadata Enhancement (v4.0)
- Store project state in space metadata
- Link scenes to space items
- Version control for edits

### Phase 3: Multi-Space Projects (v4.1)
- Projects can reference videos from multiple spaces
- Smart folders for project assets
- Shared asset libraries

## Testing

### Manual Test Checklist
- [ ] Open existing project - should load via new API
- [ ] Create new project from space video - should work
- [ ] Load video with missing file - should show helpful error
- [ ] Legacy project compatibility - should still work

### Console Testing
```javascript
// Test new API
const result = await window.spaces.api.getVideoPath('cc8e39b458303e4a41a8b38564ea805f');
console.log(result);

// List all spaces
const spaces = await window.spaces.api.list();
console.log(spaces);

// Get space items
const items = await window.spaces.api.items.list('8c7ac216629d4f3325c92f34e2c7521c');
console.log(items);
```

## Related Files

- `spaces-api.js` - Universal API implementation
- `clipboard-storage-v2.js` - Storage backend
- `preload-video-editor.js` - IPC bridge
- `video-editor-app.js` - Renderer integration
- `main.js` - IPC handlers

## Support

If you encounter issues:
1. Check console logs (View > Toggle Developer Tools)
2. Verify file exists on disk
3. Check `~/Documents/OR-Spaces/index.json` integrity
4. File issue with:
   - Console logs
   - Item ID
   - Expected vs actual file path
