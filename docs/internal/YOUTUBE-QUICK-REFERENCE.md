# YouTube Download - Quick Reference

## For Users

### What's Fixed
✅ Videos no longer stuck in "Downloading..." state  
✅ App crashes don't leave broken items  
✅ Can cancel unwanted downloads  

### How to Cancel a Download
1. Find the downloading video in your Spaces/Clipboard viewer
2. Look for the cancel button next to the progress bar
3. Click "Cancel" - download stops immediately
4. Item shows "🚫 Download cancelled"

### After App Crash
When you restart the app:
- **Completed downloads**: Automatically fixed, show proper title
- **Incomplete downloads**: Marked as "❌ Download interrupted"

## For Developers

### Cancel a Download
```javascript
await window.youtube.cancelDownload(placeholderId);
```

### Check Active Downloads
```javascript
const result = await window.youtube.getActiveDownloads();
console.log(result.downloads);
// [{placeholderId, progress, url, duration}, ...]
```

### Download States
- `downloading` - In progress (can cancel)
- `complete` - Successfully finished
- `cancelled` - User cancelled
- `error` - Failed or interrupted

### UI Integration
See `YOUTUBE-CANCEL-UI-EXAMPLE.js` for complete examples:
- Add cancel button to downloading items
- Show active downloads widget
- Progress bar with percentage

## Technical Details

### Files Changed
1. `clipboard-manager-v2-adapter.js` - Core logic
2. `preload.js` - API exposure
3. Documentation files

### Key Features
- **Crash Recovery**: `cleanupOrphanedDownloads()` runs on startup
- **Cancellation**: AbortController-based, tracked in Map
- **Persistence**: Synchronous saves ensure data integrity

### Testing
```bash
# Start the app
npm start

# In developer console:
await window.youtube.getActiveDownloads()
await window.youtube.cancelDownload('item-id-here')
```

## Troubleshooting

### Download Still Shows "Downloading" After Crash
**Fix**: Restart the app - automatic cleanup runs on startup

### Can't Cancel Download
**Check**: 
1. Item is actually in "downloading" state
2. Get active downloads to verify it's tracked
3. Check console for error messages

### Item Shows Wrong Status
**Fix**: 
1. Check `~/Documents/OR-Spaces/items/[item-id]/metadata.json`
2. Run cleanup manually if needed
3. Restart app to trigger automatic cleanup

## API Reference

### window.youtube.cancelDownload(placeholderId)
**Returns**: `{ success: boolean, error?: string }`  
**Description**: Cancels an active download  
**Example**:
```javascript
const result = await window.youtube.cancelDownload('abc123');
if (result.success) {
  console.log('Cancelled!');
}
```

### window.youtube.getActiveDownloads()
**Returns**: `{ success: boolean, downloads: Array }`  
**Description**: Gets list of currently downloading items  
**Example**:
```javascript
const result = await window.youtube.getActiveDownloads();
result.downloads.forEach(dl => {
  console.log(`${dl.placeholderId}: ${dl.progress}%`);
});
```

## Best Practices

### When to Use Cancel
- Long videos you don't want anymore
- Wrong video URL pasted
- Need to free up bandwidth
- App closing and don't want to wait

### When to Let Download Complete
- Short videos (< 5 minutes)
- Important content you need
- Already > 80% downloaded

### Monitoring Downloads
```javascript
// Check every 5 seconds
setInterval(async () => {
  const result = await window.youtube.getActiveDownloads();
  if (result.downloads.length > 0) {
    console.log(`${result.downloads.length} downloads active`);
  }
}, 5000);
```

## Summary

**Problem**: Videos stuck in loading state, no way to cancel, crashes leave orphans  
**Solution**: Auto-cleanup on startup + cancellation support + robust state management  
**Result**: Reliable, controllable YouTube downloads with crash resilience
