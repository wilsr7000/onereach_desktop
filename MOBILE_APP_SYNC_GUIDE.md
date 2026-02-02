# Mobile App Spaces Sync Guide

This document explains how to save content from the mobile app so it syncs seamlessly with the Onereach desktop app's Spaces system.

---

## 🏗️ Architecture Overview

The Onereach Spaces system uses a **local-first architecture** with optional cloud sync:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Mobile App    │     │   Desktop App   │     │   GSX Cloud     │
│   (iOS/Android) │     │   (macOS/Win)   │     │   (OneReach)    │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         ▼                       ▼                       │
┌─────────────────────────────────────────┐             │
│     Local Storage: ~/Documents/OR-Spaces │◄───────────┤
│                                          │    Sync    │
│  • index.json (master index)             │───────────►│
│  • items/{id}/ (content files)           │            │
│  • spaces/{id}/ (space configs)          │            │
└──────────────────────────────────────────┘            │
                                                        │
                                          ┌─────────────▼─────────────┐
                                          │  GSX Files Cloud Storage  │
                                          │  Complete-Backup/         │
                                          │  ├── OR-Spaces/           │
                                          │  └── App-Config/          │
                                          └───────────────────────────┘
```

### How It Works

1. **Local Storage First** - All content saves locally to `~/Documents/OR-Spaces/`
2. **Instant Availability** - Content appears immediately in any local app
3. **Cloud Sync (Optional)** - Desktop app syncs local storage to GSX Files cloud
4. **Cross-Device Access** - Restore from GSX to new device, content appears locally

---

## 📁 Local Storage Location

### Base Directory
```
~/Documents/OR-Spaces/
```

**Platform-specific paths:**
- **macOS:** `/Users/{username}/Documents/OR-Spaces/`
- **iOS (iCloud):** Use iCloud Documents container, sync to `OR-Spaces/`
- **Android:** `/storage/emulated/0/Documents/OR-Spaces/` or app-specific external storage
- **Windows:** `C:\Users\{username}\Documents\OR-Spaces\`

### Directory Structure
```
OR-Spaces/
├── index.json                    # Master index (REQUIRED)
├── index.json.backup            # Auto-backup of index
├── items/                       # All content items
│   └── {item-id}/              # One folder per item
│       ├── content.{ext}       # Actual content (txt, png, mp4, etc.)
│       ├── metadata.json       # Item metadata (REQUIRED)
│       ├── thumbnail.png       # Thumbnail preview (optional)
│       ├── transcript.txt      # Transcription (for video/audio)
│       └── transcription-speakers.txt  # Speaker-labeled transcript
└── spaces/                      # Space configurations
    └── {space-id}/
        └── space-metadata.json  # Space metadata
```

---

## 📝 index.json Structure (Master Index)

This file tracks ALL items. **You MUST update this when adding items.**

```json
{
  "version": "2.0",
  "lastModified": "2024-12-16T10:30:00.000Z",
  "items": [
    {
      "id": "abc123def456",
      "type": "video",
      "dateAdded": "2024-12-16T10:30:00.000Z",
      "lastModified": "2024-12-16T10:30:00.000Z",
      "spaceId": "work",
      "contentPath": "items/abc123def456/video.mp4",
      "thumbnailPath": "items/abc123def456/thumbnail.png",
      "metadataPath": "items/abc123def456/metadata.json",
      "fileName": "video.mp4",
      "fileSize": 15728640,
      "fileType": "video/mp4",
      "preview": "Video title or first line of text...",
      "source": "mobile-app",
      "sourceDevice": "iPhone 15 Pro"
    }
  ],
  "spaces": [
    {
      "id": "unclassified",
      "name": "Unclassified",
      "icon": "◯",
      "color": "#64c8ff"
    },
    {
      "id": "work",
      "name": "Work",
      "icon": "💼",
      "color": "#3b82f6"
    }
  ],
  "preferences": {
    "spacesEnabled": true,
    "currentSpace": "unclassified"
  }
}
```

---

## 📄 Item metadata.json Structure

**Every item MUST have a `metadata.json` in its folder.**

### Core Fields (All Types)
```json
{
  "id": "abc123def456",
  "type": "video",
  "dateCreated": "2024-12-16T10:30:00.000Z",
  "author": "mobile-user",
  "source": "mobile-app",
  "sourceDevice": "iPhone 15 Pro",
  "tags": ["meeting", "important"],
  "title": "Team Meeting Recording",
  "description": "Weekly sync meeting with the team",
  "notes": "Follow up on action items"
}
```

### Video-Specific Fields
```json
{
  "id": "abc123def456",
  "type": "video",
  "dateCreated": "2024-12-16T10:30:00.000Z",
  "author": "mobile-user",
  "source": "mobile-app",
  "tags": ["meeting"],
  
  // Video metadata
  "title": "Team Meeting",
  "description": "Weekly sync",
  "duration": 3600.5,
  "resolution": "1920x1080",
  "fps": 30,
  "codec": "h264",
  
  // Transcription (if available)
  "transcript": "Full transcript text here...",
  "transcriptSegments": [
    {
      "text": "Hello",
      "start": 0.0,
      "end": 0.5
    },
    {
      "text": "everyone",
      "start": 0.5,
      "end": 1.2
    }
  ],
  "transcriptionSource": "whisper",
  "transcriptionDate": "2024-12-16T10:35:00.000Z",
  "transcriptLanguage": "en",
  
  // Scenes/Markers (for video editor)
  "scenes": [
    {
      "id": 1,
      "name": "Introduction",
      "type": "range",
      "inTime": 0,
      "outTime": 120,
      "duration": 120,
      "color": "#3b82f6",
      "description": "Opening remarks",
      "transcription": "Transcript for this scene...",
      "tags": ["intro"],
      "createdAt": "2024-12-16T10:30:00.000Z"
    }
  ],
  
  // Download info (if from URL)
  "downloadStatus": "complete",
  "originalUrl": "https://youtube.com/watch?v=...",
  "downloadedAt": "2024-12-16T10:30:00.000Z"
}
```

### Image-Specific Fields
```json
{
  "id": "img123",
  "type": "image",
  "dateCreated": "2024-12-16T10:30:00.000Z",
  "source": "mobile-app",
  
  "title": "Screenshot of Dashboard",
  "description": "Analytics dashboard showing Q4 metrics",
  "tags": ["screenshot", "analytics"],
  
  // Image metadata
  "category": "screenshot",
  "width": 1920,
  "height": 1080,
  "format": "png",
  
  // OCR extracted text (if scanned)
  "extracted_text": "Revenue: $1.2M..."
}
```

### Audio-Specific Fields
```json
{
  "id": "audio123",
  "type": "audio",
  "dateCreated": "2024-12-16T10:30:00.000Z",
  
  "title": "Voice Memo",
  "audioType": "voice-memo",
  "duration": 180.5,
  "format": "mp3",
  "bitrate": 128,
  
  // Transcription
  "transcript": "Full transcript...",
  "transcriptSegments": [...],
  "transcriptionSource": "whisper"
}
```

### Text-Specific Fields
```json
{
  "id": "text123",
  "type": "text",
  "dateCreated": "2024-12-16T10:30:00.000Z",
  
  "title": "Meeting Notes",
  "contentType": "notes",
  "topics": ["project", "deadline"],
  "keyPoints": ["Launch Q2", "Budget approved"],
  "actionItems": ["Review designs", "Schedule meeting"]
}
```

---

## 🔑 Generating Item IDs

Use a unique identifier that won't collide. Recommended format:

```javascript
// JavaScript
const itemId = crypto.randomBytes(16).toString('hex');
// Result: "8f65452b3383a4edbdf762005c876ca4"

// Swift
let itemId = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
// Result: "8f65452b3383a4edbdf762005c876ca4"

// Kotlin
val itemId = UUID.randomUUID().toString().replace("-", "").lowercase()
```

---

## 📤 Adding a New Item (Step by Step)

### 1. Generate Item ID
```
itemId = "8f65452b3383a4edbdf762005c876ca4"
```

### 2. Create Item Directory
```
OR-Spaces/items/8f65452b3383a4edbdf762005c876ca4/
```

### 3. Save Content File
```
OR-Spaces/items/8f65452b3383a4edbdf762005c876ca4/video.mp4
```

### 4. Create metadata.json
```json
{
  "id": "8f65452b3383a4edbdf762005c876ca4",
  "type": "video",
  "dateCreated": "2024-12-16T10:30:00.000Z",
  "author": "mobile-user",
  "source": "mobile-app",
  "sourceDevice": "iPhone 15 Pro",
  "title": "My Video",
  "duration": 120.5,
  "tags": []
}
```

### 5. Generate Thumbnail (Optional but Recommended)
Save as `thumbnail.png` (recommended: 320x180 for videos, 200x200 for images)

### 6. Update index.json
**CRITICAL:** You must add an entry to the `items` array:

```json
{
  "id": "8f65452b3383a4edbdf762005c876ca4",
  "type": "video",
  "dateAdded": "2024-12-16T10:30:00.000Z",
  "lastModified": "2024-12-16T10:30:00.000Z",
  "spaceId": "unclassified",
  "contentPath": "items/8f65452b3383a4edbdf762005c876ca4/video.mp4",
  "thumbnailPath": "items/8f65452b3383a4edbdf762005c876ca4/thumbnail.png",
  "metadataPath": "items/8f65452b3383a4edbdf762005c876ca4/metadata.json",
  "fileName": "video.mp4",
  "fileSize": 15728640,
  "fileType": "video/mp4",
  "preview": "My Video",
  "source": "mobile-app"
}
```

---

## 🔄 Sync Considerations

### File Locking
- The desktop app may have `index.json` open
- Use atomic writes (write to temp file, then rename)
- Consider file locking mechanisms on iOS/Android

### Conflict Resolution
```javascript
// Pseudo-code for safe index update
function updateIndex(newItem) {
  const index = JSON.parse(readFile("index.json"));
  
  // Check if item already exists
  const existing = index.items.find(i => i.id === newItem.id);
  if (existing) {
    // Update existing
    Object.assign(existing, newItem);
    existing.lastModified = new Date().toISOString();
  } else {
    // Add new
    index.items.push(newItem);
  }
  
  index.lastModified = new Date().toISOString();
  
  // Atomic write
  writeFile("index.json.tmp", JSON.stringify(index, null, 2));
  rename("index.json.tmp", "index.json");
}
```

### iCloud/Cloud Sync
If using iCloud Documents:
1. Store in app's iCloud container
2. Create symlink or sync `OR-Spaces/` folder
3. Handle iCloud conflict files (`.icloud` extensions)

---

## 📱 Transcription Format for Videos

For the teleprompter/transcript sync to work, save word-level timestamps:

```json
{
  "transcriptSegments": [
    { "text": "Hello", "start": 0.0, "end": 0.35 },
    { "text": "everyone", "start": 0.35, "end": 0.82 },
    { "text": "and", "start": 0.82, "end": 0.95 },
    { "text": "welcome", "start": 0.95, "end": 1.35 }
  ],
  "transcript": "Hello everyone and welcome...",
  "transcriptionSource": "whisper",
  "transcriptionDate": "2024-12-16T10:35:00.000Z"
}
```

**Important:** 
- `start` and `end` are in **seconds** (float)
- `transcriptionSource: "whisper"` indicates accurate timestamps
- Other sources like `"youtube"` or `"evenly-distributed"` have less accurate timing

---

## ✅ Checklist for Mobile App Integration

- [ ] Save content to `~/Documents/OR-Spaces/items/{id}/`
- [ ] Create `metadata.json` with required fields
- [ ] Update `index.json` with new item entry
- [ ] Generate thumbnail for visual items
- [ ] Use consistent date format: ISO 8601 (`"2024-12-16T10:30:00.000Z"`)
- [ ] Set `source: "mobile-app"` to identify mobile-added items
- [ ] Set `sourceDevice` to identify which device added it
- [ ] Handle file locking for concurrent access
- [ ] Test sync by adding item on mobile, verifying it appears in desktop app

---

## 🧪 Testing Sync

After adding an item from mobile:

1. Open desktop app
2. Go to Spaces
3. Look for new item in "Unclassified" (or target space)
4. Verify:
   - Thumbnail displays correctly
   - Clicking opens the content
   - Metadata shows correctly in details panel
   - For videos: teleprompter shows transcript (if provided)

---

---

## ☁️ GSX Cloud Sync

### How Cloud Sync Works

The desktop app can sync local OR-Spaces to **GSX Files** (OneReach cloud storage):

```
Local                              Cloud (GSX Files)
~/Documents/OR-Spaces/      →      Complete-Backup/OR-Spaces/
                                   ├── index.json
                                   ├── Spaces/
                                   │   ├── Work/
                                   │   │   └── {items...}
                                   │   ├── Personal/
                                   │   └── Unclassified/
                                   └── spaces/
                                       └── {space-metadata...}
```

### Sync Triggers (Desktop App)

- **Manual:** Menu → GSX → File Sync → "Complete Backup"
- **Manual:** Settings → GSX File Sync → "Sync Now"
- **Auto-sync:** Can be enabled in settings (syncs on changes)

### What Gets Synced to GSX

| Local Path | GSX Remote Path |
|------------|-----------------|
| `~/Documents/OR-Spaces/` | `Complete-Backup/OR-Spaces/` |
| `~/Library/Application Support/Onereach.ai/` | `Complete-Backup/App-Config/` |

### For Mobile App: GSX Sync Options

**Option A: Let Desktop Handle Sync**
1. Mobile saves to local `OR-Spaces/` folder
2. Desktop app detects changes
3. Desktop syncs to GSX on next backup

**Option B: Direct GSX Sync from Mobile**
If you want mobile to sync directly to GSX:

```javascript
// Use @or-sdk/files-sync-node or equivalent for your platform

import { GSXFilesClient } from '@or-sdk/files-sync-node';

const client = new GSXFilesClient({
  token: 'your-gsx-token',
  environment: 'production' // or 'staging'
});

// Sync a single file
await client.pushLocalPathToFiles(
  localFilePath,           // e.g., "items/abc123/video.mp4"
  `OR-Spaces/${remotePath}`, // e.g., "OR-Spaces/items/abc123/video.mp4"
  { isPublic: false }
);

// Sync entire directory
await client.syncLocalToRemote(
  '/path/to/OR-Spaces',
  'Complete-Backup/OR-Spaces',
  { recursive: true }
);
```

### GSX Token

To sync to GSX, you need a token:
1. Log into GSX Studio
2. Go to Settings → API Tokens
3. Create a token with Files access
4. Store securely (encrypted) in your mobile app

### Sync Best Practices

1. **Sync index.json first** - Master index must be current
2. **Atomic operations** - Write to temp file, then rename
3. **Handle conflicts** - Check `lastModified` timestamps
4. **Incremental sync** - Only sync changed items (compare timestamps)
5. **Retry on failure** - Network issues are common on mobile

### Auto-Sync Considerations

If implementing auto-sync from mobile:

```javascript
// Track what needs syncing
const pendingSyncItems = [];

// When adding new item locally
function onItemAdded(itemId) {
  pendingSyncItems.push({
    id: itemId,
    type: 'item',
    timestamp: Date.now()
  });
  scheduleSyncDebounced();
}

// Debounced sync (don't sync every keystroke)
const scheduleSyncDebounced = debounce(async () => {
  if (pendingSyncItems.length === 0) return;
  if (!navigator.onLine) return; // Wait for network
  
  const toSync = [...pendingSyncItems];
  pendingSyncItems.length = 0;
  
  for (const item of toSync) {
    await syncItemToGSX(item.id);
  }
  
  // Always sync index after items
  await syncIndexToGSX();
}, 5000); // 5 second debounce
```

---

## 🔄 Cross-Device Workflow

### Scenario: Add on Mobile, View on Desktop

1. **Mobile:** User records video
2. **Mobile:** Saves to `~/Documents/OR-Spaces/items/{id}/`
3. **Mobile:** Updates `index.json`
4. **Sync:** iCloud/Dropbox syncs OR-Spaces folder (if configured)
   - OR Desktop pulls from GSX if mobile pushed there
5. **Desktop:** Opens app, loads `index.json`
6. **Desktop:** Video appears in Spaces

### Scenario: Add on Desktop, Restore to New Mobile

1. **Desktop:** User downloads YouTube video
2. **Desktop:** Saves to local OR-Spaces
3. **Desktop:** User clicks "Complete Backup" → syncs to GSX
4. **New Mobile:** User installs app
5. **New Mobile:** Downloads OR-Spaces from GSX
6. **New Mobile:** Restores to `~/Documents/OR-Spaces/`
7. **Mobile App:** Reads `index.json`, all content available

---

## 📞 Support

If items don't appear:
1. Check `index.json` has the item entry
2. Verify `contentPath` and `metadataPath` are correct
3. Check `metadata.json` exists in item folder
4. Restart desktop app to reload index
5. **For sync issues:** Check GSX token is valid, check network

Common issues:
- Missing `index.json` entry (item won't show)
- Wrong `contentPath` (file not found)
- Invalid JSON (parsing errors)
- Missing `type` field (unknown content type)
- **GSX sync failed:** Token expired or network timeout
- **Conflict:** Same item modified on multiple devices (check timestamps)

---

## 📊 Summary: Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        DATA FLOW SUMMARY                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. SAVE LOCALLY (Required)                                        │
│     ┌──────────────┐                                                │
│     │ Mobile App   │ ──► ~/Documents/OR-Spaces/                    │
│     │ Desktop App  │     ├── index.json          ◄── MUST UPDATE   │
│     └──────────────┘     ├── items/{id}/                           │
│                          │   ├── content.mp4                       │
│                          │   ├── metadata.json   ◄── REQUIRED      │
│                          │   └── thumbnail.png                     │
│                          └── spaces/{id}/                          │
│                                                                     │
│  2. SYNC TO CLOUD (Optional, Desktop handles this)                 │
│     ┌──────────────┐                                                │
│     │ Desktop App  │ ──► GSX Files (OneReach Cloud)                │
│     │ "Complete    │     Complete-Backup/                          │
│     │  Backup"     │     ├── OR-Spaces/                            │
│     └──────────────┘     └── App-Config/                           │
│                                                                     │
│  3. RESTORE ON NEW DEVICE                                          │
│     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐    │
│     │ GSX Files    │ ──► │ Download     │ ──► │ Local        │    │
│     │ Cloud        │     │ to device    │     │ OR-Spaces/   │    │
│     └──────────────┘     └──────────────┘     └──────────────┘    │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  KEY POINTS:                                                        │
│  • Local storage is the source of truth                            │
│  • Always update index.json when adding items                      │
│  • GSX sync is handled by desktop app (or implement SDK)           │
│  • Use same folder structure on all platforms                      │
│  • Timestamps in ISO 8601 format                                   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 🤖 AI Implementation Instructions

**For AI assistants building mobile app sync features:** Follow these instructions exactly to ensure content appears in the desktop app's Spaces modal.

### Critical Path: Where to Save Files

```
BASE DIRECTORY (REQUIRED):
~/Documents/OR-Spaces/

Full paths by platform:
- macOS:    /Users/{username}/Documents/OR-Spaces/
- iOS:      Use app's iCloud Documents container → sync to OR-Spaces/
- Android:  /storage/emulated/0/Documents/OR-Spaces/
- Windows:  C:\Users\{username}\Documents\OR-Spaces\
```

### Step-by-Step: Adding a New Item

**STEP 1: Generate a unique ID**
```javascript
// Use crypto random or UUID
const itemId = crypto.randomBytes(8).toString('hex'); // e.g., "a1b2c3d4e5f6g7h8"
// Or: const itemId = uuidv4().replace(/-/g, '').substring(0, 16);
```

**STEP 2: Create item directory**
```
OR-Spaces/items/{itemId}/
```

**STEP 3: Save content file**
```
OR-Spaces/items/{itemId}/content.{ext}
OR-Spaces/items/{itemId}/{original-filename}  // For files, use original name
```

Supported extensions:
- **Video:** `.mp4`, `.mov`, `.webm`, `.mkv`
- **Image:** `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.heic`
- **Audio:** `.mp3`, `.wav`, `.m4a`, `.aac`
- **Text:** `.txt`, `.md`, `.html`
- **Code:** `.js`, `.ts`, `.py`, `.json`, `.css`
- **Docs:** `.pdf`

**STEP 4: Create metadata.json (REQUIRED)**
```json
{
  "id": "a1b2c3d4e5f6g7h8",
  "type": "video",
  "dateCreated": "2024-12-16T21:45:00.000Z",
  "author": "mobile-user",
  "source": "mobile-app",
  "tags": [],
  "scenes": [],
  "title": "My Video",
  "description": "Optional description",
  "duration": 125.5,
  "transcriptSegments": [],
  "transcriptionSource": null
}
```

**STEP 5: Create thumbnail (RECOMMENDED)**
```
OR-Spaces/items/{itemId}/thumbnail.png
```
- Size: 320x180 recommended (16:9) or 320x320 (square)
- Format: PNG or JPEG
- For video: Extract frame at 10% duration

**STEP 6: Update index.json (CRITICAL)**

Read existing `OR-Spaces/index.json`, add entry to `items` array:

```json
{
  "id": "a1b2c3d4e5f6g7h8",
  "type": "video",
  "timestamp": 1702759500000,
  "dateAdded": "2024-12-16T21:45:00.000Z",
  "spaceId": "unclassified",
  "contentPath": "items/a1b2c3d4e5f6g7h8/video.mp4",
  "thumbnailPath": "items/a1b2c3d4e5f6g7h8/thumbnail.png",
  "metadataPath": "items/a1b2c3d4e5f6g7h8/metadata.json",
  "fileName": "video.mp4",
  "fileSize": 15728640,
  "fileType": "video/mp4",
  "fileCategory": "video",
  "preview": "First 100 chars of text or video title...",
  "source": "mobile-app",
  "pinned": false
}
```

Update `lastModified` in index root:
```json
{
  "version": "2.0",
  "lastModified": "2024-12-16T21:45:00.000Z",
  "items": [...],
  "spaces": [...]
}
```

### Type Field Values

| Content Type | `type` value | `fileCategory` |
|--------------|--------------|----------------|
| Video | `"video"` or `"file"` | `"video"` |
| Image | `"image"` or `"file"` | `"image"` |
| Audio | `"audio"` or `"file"` | `"audio"` |
| Text | `"text"` | `"text"` |
| Rich Text/HTML | `"html"` | `"document"` |
| Screenshot | `"image"` | `"screenshot"` |
| PDF | `"file"` | `"document"` |

### Creating/Using Spaces

To assign items to a Space (not just "Unclassified"):

**1. Check if space exists in index.json `spaces` array**
```json
{
  "spaces": [
    {
      "id": "unclassified",
      "name": "Unclassified",
      "icon": "◯",
      "color": "#64c8ff"
    },
    {
      "id": "work-project-xyz",
      "name": "Work Project XYZ",
      "icon": "📁",
      "color": "#22c55e"
    }
  ]
}
```

**2. Create space directory and metadata (if new space)**
```
OR-Spaces/spaces/{space-id}/space-metadata.json
```

**space-metadata.json structure:**
```json
{
  "version": "1.0",
  "spaceId": "work-project-xyz",
  "name": "Work Project XYZ",
  "icon": "📁",
  "color": "#22c55e",
  "createdAt": "2024-12-16T21:45:00.000Z",
  "updatedAt": "2024-12-16T21:45:00.000Z",
  "author": "mobile-user",
  "projectConfig": {
    "setupComplete": false,
    "currentVersion": 0,
    "mainFile": null,
    "description": null,
    "targetUsers": null,
    "stylePreference": null
  },
  "files": {},
  "assets": {},
  "approvals": {},
  "versions": []
}
```

**3. Set `spaceId` in the item's index entry**
```json
{
  "id": "a1b2c3d4e5f6g7h8",
  "spaceId": "work-project-xyz",  // ← Use the space ID here
  ...
}
```

### Video/Audio Specific: Transcriptions

For transcribed content, add to `metadata.json`:

```json
{
  "transcriptSegments": [
    { "text": "Hello", "start": 0.0, "end": 0.5 },
    { "text": "world", "start": 0.5, "end": 1.0 }
  ],
  "transcriptionSource": "whisper",
  "transcriptionDate": "2024-12-16T21:45:00.000Z",
  "transcript": "Hello world"
}
```

Also create companion text files:
```
OR-Spaces/items/{itemId}/transcription.txt        # Plain text
OR-Spaces/items/{itemId}/transcription-speakers.txt  # With speaker labels
```

### Video Specific: Scene Markers

For video markers/scenes, add to `metadata.json`:

```json
{
  "scenes": [
    {
      "id": 1,
      "name": "Introduction",
      "type": "range",
      "inTime": 0,
      "outTime": 30.5,
      "duration": 30.5,
      "color": "#3b82f6",
      "description": "Opening segment",
      "transcription": "Words spoken in this segment...",
      "tags": ["intro"],
      "notes": ""
    },
    {
      "id": 2,
      "name": "Key Point",
      "type": "spot",
      "time": 45.2,
      "color": "#22c55e"
    }
  ]
}
```

### Complete Example: Adding a Video

```javascript
async function saveVideoToSpaces(videoFile, thumbnailData, metadata) {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  
  // Configuration
  const SPACES_ROOT = path.join(os.homedir(), 'Documents', 'OR-Spaces');
  const itemId = crypto.randomBytes(8).toString('hex');
  const itemDir = path.join(SPACES_ROOT, 'items', itemId);
  
  // 1. Create item directory
  fs.mkdirSync(itemDir, { recursive: true });
  
  // 2. Copy video file
  const videoFileName = metadata.originalName || 'video.mp4';
  const videoPath = path.join(itemDir, videoFileName);
  fs.copyFileSync(videoFile, videoPath);
  const stats = fs.statSync(videoPath);
  
  // 3. Save thumbnail
  if (thumbnailData) {
    const thumbPath = path.join(itemDir, 'thumbnail.png');
    fs.writeFileSync(thumbPath, thumbnailData);
  }
  
  // 4. Create metadata.json
  const itemMetadata = {
    id: itemId,
    type: 'video',
    dateCreated: new Date().toISOString(),
    author: 'mobile-user',
    source: 'mobile-app',
    tags: metadata.tags || [],
    scenes: metadata.scenes || [],
    title: metadata.title || videoFileName,
    description: metadata.description || '',
    duration: metadata.duration || 0,
    transcriptSegments: metadata.transcriptSegments || [],
    transcriptionSource: metadata.transcriptionSource || null
  };
  
  fs.writeFileSync(
    path.join(itemDir, 'metadata.json'),
    JSON.stringify(itemMetadata, null, 2)
  );
  
  // 5. Update index.json
  const indexPath = path.join(SPACES_ROOT, 'index.json');
  let index = { version: '2.0', items: [], spaces: [{ id: 'unclassified', name: 'Unclassified', icon: '◯', color: '#64c8ff' }] };
  
  if (fs.existsSync(indexPath)) {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  }
  
  // Add item to index
  index.items.push({
    id: itemId,
    type: 'video',
    timestamp: Date.now(),
    dateAdded: new Date().toISOString(),
    spaceId: metadata.spaceId || 'unclassified',
    contentPath: `items/${itemId}/${videoFileName}`,
    thumbnailPath: thumbnailData ? `items/${itemId}/thumbnail.png` : null,
    metadataPath: `items/${itemId}/metadata.json`,
    fileName: videoFileName,
    fileSize: stats.size,
    fileType: 'video/mp4',
    fileCategory: 'video',
    preview: metadata.title || videoFileName,
    source: 'mobile-app',
    pinned: false
  });
  
  index.lastModified = new Date().toISOString();
  
  // Write index (with backup)
  if (fs.existsSync(indexPath)) {
    fs.copyFileSync(indexPath, indexPath + '.backup');
  }
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  
  return itemId;
}
```

### Validation Checklist

Before saving, verify:

- [ ] `OR-Spaces/` directory exists
- [ ] Item ID is unique (not in index already)
- [ ] `metadata.json` has required fields: `id`, `type`, `dateCreated`
- [ ] Content file exists at the `contentPath`
- [ ] `index.json` entry has: `id`, `type`, `timestamp`, `spaceId`, `contentPath`, `metadataPath`
- [ ] Paths use forward slashes and are relative to `OR-Spaces/`
- [ ] Timestamps are ISO 8601 format
- [ ] File sizes are in bytes (not KB/MB)

### Error Recovery

If items don't appear in desktop app:

1. **Check index.json is valid JSON** - Parse error = nothing loads
2. **Verify item folder exists** - `OR-Spaces/items/{id}/`
3. **Verify metadata.json exists** - Required for item to display
4. **Check contentPath is correct** - Must match actual file location
5. **Restart desktop app** - Reloads index from disk

### Cloud Sync Notes

The desktop app handles GSX cloud sync automatically. Mobile apps should:

1. **Write to local `OR-Spaces/` first** (this is required)
2. **Optionally** implement GSX SDK for direct cloud push
3. **Or** rely on iCloud/Dropbox to sync the folder
4. **Or** let desktop app handle cloud backup on next launch

The desktop "Complete Backup" feature syncs the entire `OR-Spaces/` folder to GSX Files cloud storage.















