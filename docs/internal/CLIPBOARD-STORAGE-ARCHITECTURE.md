# Clipboard Storage Architecture

## Overview

The Onereach.ai clipboard/spaces system stores copied items in a structured file system at `~/Documents/OR-Spaces/`. This document explains how files are stored, how metadata is managed, and how the system ensures reliability.

## Storage Structure

```
~/Documents/OR-Spaces/
├── index.json                 # Master index of all items
├── index.json.backup          # Backup of index (auto-created)
├── items/                     # Individual item storage
│   ├── {item-id}/            # Unique folder per item
│   │   ├── content.{ext}     # Actual content file
│   │   ├── metadata.json     # Item metadata
│   │   └── thumbnail.png     # Optional thumbnail
│   └── ...
└── spaces/                    # Space definitions
    └── {space-id}.json       # Space configuration
```

## How Files Are Stored

### 1. **Text Items**
- Stored as `content.txt` or `content.html`
- Plain text or HTML format
- Small size, quick access

### 2. **Images**
- Stored as `content.png`, `content.jpg`, etc.
- Thumbnails generated and stored separately
- Base64 encoding for quick preview

### 3. **Files (Videos, Documents, etc.)**
- Stored with original filename
- Large files kept as-is, not loaded into memory
- Path reference stored in index

### 4. **Screenshots**
- Special category of images
- Auto-captured from clipboard
- Tagged with `isScreenshot: true`

## Metadata System

### Index Structure (`index.json`)
```json
{
  "version": "2.0",
  "lastModified": "2024-11-16T...",
  "items": [
    {
      "id": "unique-id-123",
      "type": "file|text|image|html",
      "spaceId": "unclassified",
      "timestamp": 1234567890,
      "preview": "First 100 chars...",
      "contentPath": "items/{id}/content.ext",
      "thumbnailPath": "items/{id}/thumbnail.png",
      "metadataPath": "items/{id}/metadata.json",
      // File-specific fields:
      "fileName": "video.mp4",
      "fileSize": 10485760,
      "fileType": "video/mp4"
    }
  ],
  "spaces": [...],
  "preferences": {...}
}
```

### Item Metadata (`metadata.json`)
```json
{
  "id": "unique-id-123",
  "type": "file",
  "dateCreated": "2024-11-16T...",
  "author": "username",
  "source": "clipboard|drag-drop|screenshot",
  "tags": [],
  "originalPath": "/original/path/to/file.ext"
}
```

### Video Metadata with Scenes (for Agentic Player)
Videos can have scene lists stored in their metadata for use with the Agentic Player:

```json
{
  "id": "video-item-123",
  "type": "file",
  "dateCreated": "2024-11-16T...",
  "author": "username",
  "source": "drag-drop",
  "tags": ["demo", "product"],
  "scenes": [
    {
      "id": 1,
      "name": "Introduction",
      "inTime": 0,
      "outTime": 30,
      "description": "Welcome and overview",
      "tags": ["intro", "overview"]
    },
    {
      "id": 2,
      "name": "Key Features",
      "inTime": 30,
      "outTime": 90,
      "description": "Main product features demo",
      "tags": ["features", "demo"]
    }
  ],
  "scenesUpdatedAt": "2024-11-16T..."
}
```

#### Scene Properties
| Property | Required | Description |
|----------|----------|-------------|
| `id` | Yes | Unique identifier within the video |
| `name` | Yes | Scene title |
| `inTime` | Yes | Start time in seconds |
| `outTime` | Yes | End time in seconds |
| `description` | No | Scene description |
| `tags` | No | Keywords for AI selection |
| `transcription` | No | What's said in the scene |

#### Video Scene APIs
```javascript
// Get scenes for a video
await window.clipboard.getVideoScenes(itemId);

// Update all scenes
await window.clipboard.updateVideoScenes(itemId, scenesArray);

// Add a single scene
await window.clipboard.addVideoScene(itemId, { name: "Scene", inTime: 0, outTime: 30 });

// Delete a scene
await window.clipboard.deleteVideoScene(itemId, sceneId);

// Get all videos with scenes
await window.clipboard.getVideosWithScenes(spaceId);
```

## Reliability Features

### 1. **File Validation**
- Files are checked for existence before operations
- Empty files (0 bytes) are skipped
- Inaccessible files are logged but don't break sync

### 2. **Index Integrity**
- Automatic backup before modifications
- Validation against actual file system
- Recovery from backup if corrupted

### 3. **Orphaned Data Handling**
- **Orphaned Metadata**: Index entries without corresponding files
- **Orphaned Directories**: File directories not in index
- **Cleanup Tools**: Manual and automatic cleanup options

### 4. **GSX Sync Improvements**
- Pre-validation of files before upload
- Skip problematic files instead of failing
- Progress reporting with warnings for skipped files
- Detailed logging of issues

## Storage Validation

### Manual Validation
Access via: **Manage Spaces → Validate & Clean Storage**

Options:
1. **Check Only**: Reports issues without fixing
2. **Check & Fix**: Automatically repairs issues

### What Gets Fixed
- ✅ Removes orphaned metadata entries
- ✅ Cleans up directories without index entries
- ✅ Removes references to deleted files
- ✅ Fixes corrupted index entries
- ✅ Creates backup before modifications

### Storage Summary
Access via: **Manage Spaces → Storage Summary**

Shows:
- Total storage size
- Number of items per type
- Largest files
- Space distribution

## Common Issues and Solutions

### Issue 1: Sync Hanging on Deleted File
**Cause**: Metadata points to non-existent file
**Solution**: Run "Validate & Clean Storage" with auto-fix

### Issue 2: Corrupted Index
**Cause**: Incomplete write or app crash
**Solution**: Automatically restored from `.backup` file

### Issue 3: Large Video Files
**Cause**: Videos can be very large and slow to sync
**Solution**: Files are validated before sync, large files tracked

### Issue 4: Permission Errors
**Cause**: File permissions changed
**Solution**: Skipped during sync with warning

## Best Practices

### 1. **Regular Maintenance**
- Run validation monthly
- Check storage summary for large files
- Clean up old items periodically

### 2. **Before GSX Sync**
- Run validation to clean orphaned entries
- Check storage summary for size
- Consider removing large videos if not needed

### 3. **Backup Strategy**
- Index is auto-backed up
- GSX sync creates cloud backup
- Consider manual backup before major cleanup

## File System Safety

### Delete Operations
- Items are removed from index first
- Physical files deleted after index update
- Directories cleaned up last
- All deletions logged

### Write Operations
- Temp files created first
- Atomic rename to final location
- Backup created before overwrites
- Rollback on failure

### Read Operations
- File existence checked first
- Size validation for integrity
- Fallback to cached data if available
- Graceful degradation on errors

## Performance Optimizations

### 1. **In-Memory Cache**
- Last 100 items cached
- Reduces disk I/O
- Fast retrieval for recent items

### 2. **Lazy Loading**
- Index loaded on startup
- Content loaded on demand
- Thumbnails generated asynchronously

### 3. **Batch Operations**
- Multiple items processed together
- Single index write for multiple changes
- Progress reporting for long operations

## Troubleshooting Commands

### Check Storage Location
```bash
ls -la ~/Documents/OR-Spaces/
```

### View Index Structure
```bash
cat ~/Documents/OR-Spaces/index.json | jq '.'
```

### Find Large Files
```bash
find ~/Documents/OR-Spaces/items -type f -size +10M
```

### Check Orphaned Directories
```bash
# In OR-Spaces/items/, directories not in index
ls ~/Documents/OR-Spaces/items/ | while read dir; do
  grep -q "\"id\": \"$dir\"" ~/Documents/OR-Spaces/index.json || echo "Orphaned: $dir"
done
```

## Migration from Old Storage

The system automatically migrates from the old location:
- Old: `~/Library/Application Support/Onereach.ai/OR-Spaces/`
- New: `~/Documents/OR-Spaces/`

Migration happens on first launch if old data exists.

## Summary

The clipboard storage system is designed for:
- **Reliability**: Multiple validation and recovery mechanisms
- **Performance**: Caching and lazy loading for speed
- **Safety**: Backups and atomic operations
- **Maintainability**: Clear structure and validation tools

The new validation features ensure that sync operations won't hang on deleted or corrupted files, making the system more robust and user-friendly.
