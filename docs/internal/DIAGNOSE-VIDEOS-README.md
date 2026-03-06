# Video Diagnostic Tool

Quick tool to check the health of video files in OR-Spaces storage.

## Usage

### Check All Videos
```bash
node diagnose-videos.js
```

### Check Specific Video
```bash
node diagnose-videos.js cc8e39b458303e4a41a8b38564ea805f
```

### Check Videos in a Space
```bash
node diagnose-videos.js --space 9a4f8a6ba7d7801a3500e53807b8da1b
```

## What It Checks

- ✅ Video file exists on disk
- ✅ Metadata file present
- ✅ Filename matches index
- ✅ File size is reasonable (not 0 bytes)
- ✅ Directory structure is correct

## Output

### Healthy Video
```
✓ - Video is healthy
```

### Minor Issues
```
⚠ - Video has warnings (but still works)
```

### Critical Issues
```
✗ - Video has critical problems
```

## Example Output

```
╔════════════════════════════════════════════╗
║  OR-Spaces Video Diagnostic Tool          ║
╚════════════════════════════════════════════╝

[SUCCESS] Loaded index with 126 items
[INFO] Found 2 video items

Diagnosis Summary:
  Total videos: 2
  Healthy: 1
  With issues: 1
  Critical: 0

Items with issues:
  YouTube Video aR20FWCCjAs.mp4
    ID: 8f65452b3383a4edbdf762005c876ca4
    Space: 9a4f8a6ba7d7801a3500e53807b8da1b
    - [warning] Video filename does not match index
```

## Exit Codes

- `0` - No critical issues
- `1` - Critical issues found (missing files, etc.)

## When to Use

- Before opening a project
- After cleaning up Spaces
- When videos won't load
- Periodically for maintenance

## Location

Storage location: `~/Documents/OR-Spaces/`

## Related

- See `SPACES-API-VIDEO-EDITOR-MIGRATION.md` for API details
- See `VIDEO-LOADING-ISSUE-SUMMARY.md` for troubleshooting
