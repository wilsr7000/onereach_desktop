# YouTube Download: Crash Recovery & Cancellation

## Overview
Enhanced YouTube download system with crash recovery and download cancellation capabilities.

## Features

### 1. Automatic Crash Recovery
On app startup, the system automatically:
- Scans for items stuck in "downloading" state
- Checks if the video file actually exists
- **If file exists**: Updates the item to "complete" with proper title
- **If file missing**: Marks as "error" with "Download interrupted" message

### 2. Download Cancellation
Users can now cancel long-running downloads:
- Each download is tracked in `activeDownloads` Map
- Supports graceful cancellation via AbortController
- Updates item status to "cancelled" with 🚫 icon

### 3. Progress Tracking
- Real-time progress updates during download
- Simulated progress indicator for better UX
- Status persists across progress updates

## API Usage

### Cancel a Download
```javascript
// Get the item ID (placeholderId) of the downloading video
const result = await window.youtube.cancelDownload(placeholderId);
console.log(result.success ? 'Cancelled!' : 'Failed');
```

### Get Active Downloads
```javascript
const result = await window.youtube.getActiveDownloads();
result.downloads.forEach(dl => {
  console.log(`Item ${dl.placeholderId}: ${dl.progress}% (${dl.duration}ms elapsed)`);
});
```

## Implementation Details

### Active Downloads Tracking
```javascript
this.activeDownloads = new Map();
// Structure: Map<placeholderId, { controller, progress, url, startTime }>
```

### Cleanup on Startup
```javascript
cleanupOrphanedDownloads() {
  // 1. Find items with downloadStatus === 'downloading'
  // 2. Check if video file exists
  // 3. If exists: mark complete
  // 4. If missing: mark as error
}
```

### Download States
- `downloading` - Active download in progress
- `complete` - Successfully downloaded
- `cancelled` - User cancelled the download
- `error` - Download failed or interrupted

## Files Modified

### clipboard-manager-v2-adapter.js
1. Added `activeDownloads` Map to track downloads
2. Added `cleanupOrphanedDownloads()` method (runs on startup)
3. Added `cancelDownload(placeholderId)` method
4. Updated `downloadYouTubeInBackground()` to:
   - Use AbortController for cancellation
   - Track download in activeDownloads
   - Clean up on completion/error/cancellation
   - Check for cancellation during download
5. Added IPC handlers:
   - `youtube:cancel-download`
   - `youtube:get-active-downloads`

### preload.js
Added to `window.youtube` API:
- `cancelDownload(placeholderId)`
- `getActiveDownloads()`

## UI Integration Examples

### Show Cancel Button During Download
```javascript
// In clipboard viewer or Spaces UI
const activeDownloads = await window.youtube.getActiveDownloads();
const isDownloading = activeDownloads.downloads.some(d => d.placeholderId === itemId);

if (isDownloading) {
  // Show cancel button
  button.onclick = async () => {
    await window.youtube.cancelDownload(itemId);
    refreshUI();
  };
}
```

### Monitor Active Downloads
```javascript
// Update UI every 2 seconds
setInterval(async () => {
  const result = await window.youtube.getActiveDownloads();
  updateDownloadsList(result.downloads);
}, 2000);
```

## Benefits

### Crash Recovery
- **No more orphaned items**: Stuck downloads are automatically fixed on startup
- **Data integrity**: Completed downloads are properly recognized
- **User clarity**: Failed downloads show clear error messages

### Cancellation
- **User control**: Can stop long downloads (e.g., 2-hour videos)
- **Resource management**: Frees up bandwidth and disk space
- **Better UX**: Users aren't stuck waiting for unwanted downloads

## Testing

### Test Crash Recovery
1. Start a YouTube download
2. Force quit the app (Command+Q or kill process)
3. Restart the app
4. Check the item - should show proper status:
   - If video file exists: "complete" with actual title
   - If video missing: "error" with "Download interrupted"

### Test Cancellation
1. Start downloading a long YouTube video
2. Get active downloads: `await window.youtube.getActiveDownloads()`
3. Cancel it: `await window.youtube.cancelDownload(placeholderId)`
4. Check item shows "🚫 Download cancelled"

## Future Enhancements

Possible improvements:
- Retry failed downloads with exponential backoff
- Resume interrupted downloads (requires yt-dlp resume support)
- Batch cancel multiple downloads
- Download queue with priority management
- Bandwidth throttling for downloads
- Notification when downloads complete
