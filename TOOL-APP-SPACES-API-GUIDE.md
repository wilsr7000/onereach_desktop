# Tool App Spaces API Guide

This document explains how external tool applications can save content to and interact with the OneReach Spaces system via HTTP API.

---

## Architecture Overview

The OneReach app runs a local HTTP server that external tools can use to interact with Spaces. Version 3.0 adds Git-backed version control via `isomorphic-git` for full commit history, branching, merging, tagging, and diffing.

```
┌─────────────────────┐
│   Your Tool App     │
│   (Any language)    │
└──────────┬──────────┘
           │ HTTP Requests
           ▼
┌─────────────────────┐         ┌─────────────────────┐
│  Spaces API Server  │────────>│  OmniGraph (GSX)    │
│  127.0.0.1:47291    │  Push   │  Cloud Knowledge    │
└──────────┬──────────┘         │  Graph + Files      │
           │                    └─────────────────────┘
     ┌─────┴─────┐
     ▼           ▼
┌──────────┐ ┌──────────┐
│  DuckDB  │ │   Git    │
│  (index) │ │ (history)│
└──────┬───┘ └────┬─────┘
       └─────┬────┘
             ▼
┌─────────────────────┐
│  OR-Spaces Storage  │
│  ~/Documents/OR-Spaces/
└─────────────────────┘
```

**Base URL:** `http://127.0.0.1:47291`

**Note:** The server only accepts connections from localhost for security.

**Storage Engine:** Git-backed (v3.0). All text content and metadata is versioned. Binary files (images, video, audio) are excluded from Git tracking via `.gitignore` and managed by content hash.

---

## API Endpoints

### Status & Health

#### Check Server Status
```http
GET /api/status
```

**Response:**
```json
{
  "status": "ok",
  "version": "1.0.8",
  "extensionConnected": false,
  "port": 47291
}
```

#### Force Reload Index
```http
POST /api/reload
```

Use this endpoint when external processes have modified the storage and the in-memory index needs to be refreshed.

**Response:**
```json
{
  "success": true,
  "message": "Index reloaded from disk"
}
```

### Database (DuckDB)

#### Get Database Status

Check the status of the DuckDB full-text search index, including row counts and index health.

```http
GET /api/database/status
```

**Response:**
```json
{
  "available": true,
  "status": "ok",
  "rowCount": 150,
  "indexStatus": "ready"
}
```

If the database is not available, returns `503` with code `DATABASE_NOT_AVAILABLE`.

#### Rebuild Database

Force a full rebuild of the DuckDB index from disk. Use this when search results are stale or the index is corrupted.

```http
POST /api/database/rebuild
```

**Response:**
```json
{
  "success": true,
  "message": "Database rebuilt successfully",
  "rowCount": 150
}
```

---

## Spaces CRUD Operations

### List All Spaces
```http
GET /api/spaces
```

**Response:**
```json
{
  "spaces": [
    {
      "id": "unclassified",
      "name": "Unclassified",
      "icon": "◯",
      "color": "#64c8ff",
      "itemCount": 15
    },
    {
      "id": "work-project",
      "name": "Work Project",
      "icon": "💼",
      "color": "#3b82f6",
      "itemCount": 42
    }
  ]
}
```

### Get Space Details
```http
GET /api/spaces/:spaceId
```

**Response:**
```json
{
  "id": "work-project",
  "name": "Work Project",
  "icon": "💼",
  "color": "#3b82f6",
  "itemCount": 42,
  "path": "/Users/you/Documents/OR-Spaces/spaces/work-project",
  "metadata": {
    "createdAt": "2024-12-16T10:30:00.000Z",
    "projectConfig": { ... }
  }
}
```

### Create Space
```http
POST /api/spaces
Content-Type: application/json

{
  "name": "My New Project",
  "icon": "🚀",
  "color": "#22c55e"
}
```

**Response:**
```json
{
  "success": true,
  "space": {
    "id": "my-new-project-abc123",
    "name": "My New Project",
    "icon": "🚀",
    "color": "#22c55e",
    "itemCount": 0
  }
}
```

### Update Space
```http
PUT /api/spaces/:spaceId
Content-Type: application/json

{
  "name": "Renamed Project",
  "icon": "⭐",
  "color": "#f59e0b"
}
```

**Response:**
```json
{
  "success": true
}
```

### Delete Space
```http
DELETE /api/spaces/:spaceId
```

**Note:** Items are moved to "Unclassified" - they are not deleted.

**Response:**
```json
{
  "success": true
}
```

---

## Items CRUD Operations

### List Items in Space
```http
GET /api/spaces/:spaceId/items?limit=50&offset=0&type=text&pinned=true
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | number | Max items to return (default: all) |
| `offset` | number | Skip items for pagination |
| `type` | string | Filter by type: `text`, `image`, `file`, `html`, `code`, `video`, `audio` |
| `pinned` | boolean | Filter by pinned status |
| `tags` | string | Comma-separated tags (ALL must match) |
| `includeContent` | boolean | Include full content (slower) |

**Response:**
```json
{
  "items": [
    {
      "id": "item-abc123",
      "type": "text",
      "spaceId": "work-project",
      "timestamp": 1702759500000,
      "preview": "First 100 chars of content...",
      "pinned": false,
      "tags": ["important", "meeting-notes"],
      "fileName": null,
      "fileSize": null
    }
  ],
  "total": 42
}
```

### Get Single Item
```http
GET /api/spaces/:spaceId/items/:itemId
```

**Response:**
```json
{
  "id": "item-abc123",
  "type": "text",
  "spaceId": "work-project",
  "content": "Full content of the item...",
  "timestamp": 1702759500000,
  "preview": "First 100 chars...",
  "pinned": false,
  "tags": ["important"],
  "metadata": {
    "title": "Meeting Notes",
    "description": "Notes from team sync",
    "createdAt": "2024-12-16T10:30:00.000Z"
  }
}
```

### Add Item to Space (CREATE)
```http
POST /api/send-to-space
Content-Type: application/json

{
  "spaceId": "work-project",
  "type": "text",
  "content": "Your content here",
  "title": "Optional title",
  "sourceUrl": "https://example.com"
}
```

**Body Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `spaceId` | string | Yes | Target space ID |
| `content` | string | Yes* | Text, HTML, code, base64, or URL content (*required if no `filePath`) |
| `type` | string | No | Content type: `text`, `html`, `code`, `image`, `file`, `video`, `audio` |
| `title` | string | No | Display title for the item |
| `sourceUrl` | string | No | Source URL for provenance tracking |
| `tags` | string[] | No | Tags to apply to the item |
| `metadata` | object | No | Additional metadata (description, author, etc.) |
| `filePath` | string | No | Absolute path to a local file (alternative to `content` for file-based items) |
| `fileName` | string | No | Override filename (defaults to basename of `filePath`) |

> Either `content` or `filePath` must be provided. When both are present, `content` is used as the item content and `filePath` provides the file reference. See the [File Upload](#file-upload) section for details on `filePath` usage.

**Supported Types:**
| Type | Content Format | Description |
|------|----------------|-------------|
| `text` | Plain string | Text content |
| `html` | HTML string | Rich text/HTML content |
| `code` | Code string | Source code |
| `image` | Base64 or URL | Image data or URL |
| `file` | Base64 or path | File data |
| `video` | File path | Video file reference |
| `audio` | File path | Audio file reference |

**Full Request Example:**
```json
{
  "spaceId": "work-project",
  "type": "text",
  "content": "Meeting notes from today's sync...",
  "title": "Team Sync Notes",
  "sourceUrl": "https://notion.so/meeting-123",
  "tags": ["meeting", "weekly"],
  "metadata": {
    "description": "Weekly team sync meeting",
    "author": "My Tool App"
  }
}
```

**File Path Example:**
```json
{
  "spaceId": "work-project",
  "type": "file",
  "filePath": "/Users/me/Downloads/report.pdf",
  "fileName": "Q4-Report.pdf",
  "title": "Q4 Report"
}
```

**Note:** Tags can be passed either at the root level (`"tags": [...]`) or inside metadata (`"metadata": { "tags": [...] }`). Root-level tags take precedence.

**Response:**
```json
{
  "success": true,
  "itemId": "item-xyz789"
}
```

### Update Item
```http
PUT /api/spaces/:spaceId/items/:itemId
Content-Type: application/json

{
  "pinned": true,
  "preview": "Updated preview text"
}
```

**Response:**
```json
{
  "success": true
}
```

### Delete Item
```http
DELETE /api/spaces/:spaceId/items/:itemId
```

**Response:**
```json
{
  "success": true
}
```

### Move Item to Another Space
```http
POST /api/spaces/:spaceId/items/:itemId/move
Content-Type: application/json

{
  "toSpaceId": "another-space"
}
```

**Response:**
```json
{
  "success": true
}
```

### Toggle Item Pin
```http
POST /api/spaces/:spaceId/items/:itemId/pin
```

**Response:**
```json
{
  "success": true,
  "pinned": true
}
```

---

## Tags Operations

### Get Item Tags
```http
GET /api/spaces/:spaceId/items/:itemId/tags
```

**Response:**
```json
{
  "tags": ["important", "meeting-notes", "2024"]
}
```

### Set Item Tags (Replace All)
```http
PUT /api/spaces/:spaceId/items/:itemId/tags
Content-Type: application/json

{
  "tags": ["new-tag", "another-tag"]
}
```

### Add Tag to Item
```http
POST /api/spaces/:spaceId/items/:itemId/tags
Content-Type: application/json

{
  "tag": "urgent"
}
```

### Remove Tag from Item
```http
DELETE /api/spaces/:spaceId/items/:itemId/tags/:tagName
```

### List All Tags in Space
```http
GET /api/spaces/:spaceId/tags
```

**Response:**
```json
{
  "tags": [
    { "tag": "important", "count": 15 },
    { "tag": "meeting-notes", "count": 8 },
    { "tag": "2024", "count": 42 }
  ]
}
```

### Find Items by Tags
```http
GET /api/tags/search?tags=important,urgent&matchAll=true&spaceId=work-project
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `tags` | string | Comma-separated tags |
| `matchAll` | boolean | Require ALL tags (default: false = any) |
| `spaceId` | string | Limit to specific space |
| `limit` | number | Max results |

---

## Search

Spaces provides two search modes:

- **Quick Search** -- keyword-based, fast, local. No LLM calls.
- **Deep Search** -- LLM-powered semantic search. Items are evaluated by an AI model (GPT-5.2) against customizable filters and ranked by composite score.

---

### Quick Search

Fast keyword search with weighted relevance scoring, fuzzy matching, and highlights.

```http
GET /api/search?q=meeting+notes&spaceId=work-project&type=text&limit=20
```

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `q` | string | *(required)* | Search query |
| `spaceId` | string | | Limit to specific space |
| `type` | string | | Filter by item type |
| `depth` | string | `standard` | `quick` = index only (fastest), `standard` = index + metadata, `thorough` = index + metadata + full content |
| `searchTags` | boolean | `true` | Also search in tags |
| `searchMetadata` | boolean | `true` | Search in metadata fields (title, description, etc.) |
| `searchContent` | boolean | `false` | Search in full content for text items |
| `fuzzy` | boolean | `true` | Enable fuzzy matching |
| `fuzzyThreshold` | number | `0.7` | Fuzzy match threshold (0-1, higher = stricter) |
| `includeHighlights` | boolean | `true` | Include match highlights in results |
| `limit` | number | | Max results |
| `offset` | number | `0` | Skip first N results (for pagination) |

**Response:**
```json
{
  "results": [
    {
      "id": "item-abc123",
      "type": "text",
      "spaceId": "work-project",
      "preview": "Meeting notes with highlighted match...",
      "tags": ["meeting-notes"],
      "_search": {
        "score": 0.95,
        "matches": ["title", "tags"],
        "highlights": {
          "title": "**Meeting** **notes** from Monday"
        }
      }
    }
  ],
  "total": 5
}
```

**Depth modes explained:**

| Depth | Speed | What it searches |
|-------|-------|-----------------|
| `quick` | Fastest | In-memory index only. Good for typeahead / autocomplete. |
| `standard` | Medium | Index + on-disk metadata (title, description, tags, source info). |
| `thorough` | Slowest | Everything above + full content from disk (text bodies, code, etc.). |

---

### Search Suggestions

Get autocomplete suggestions based on existing tags, titles, and filenames.

```http
GET /api/search/suggestions?prefix=meet&limit=5
```

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prefix` | string | *(required)* | Prefix to match (also accepts `q`) |
| `limit` | number | `10` | Max suggestions |

**Response:**
```json
{
  "suggestions": [
    { "text": "meeting-notes", "type": "tag", "count": 12 },
    { "text": "Meeting with client", "type": "title", "count": 3 },
    { "text": "meetings-q1.pdf", "type": "file", "count": 1 }
  ]
}
```

---

### Deep Search

LLM-powered semantic search. Items are evaluated against one or more AI filters and ranked by a composite score. Use `GET /api/search/deep/filters` to discover available filters.

```http
POST /api/search/deep
Content-Type: application/json
```

**Request Body:**
```json
{
  "filters": [
    { "id": "useful_for", "input": "Q1 client presentation", "weight": 1.0, "threshold": 30 },
    { "id": "quality_score", "weight": 0.5, "threshold": 50 }
  ],
  "spaceId": "work-project",
  "mode": "quick",
  "userQuery": "anything about quarterly review",
  "limit": 20
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `filters` | array | Yes | One or more filter objects (see filter discovery below) |
| `filters[].id` | string | Yes | Filter type ID (e.g. `useful_for`, `quality_score`) |
| `filters[].input` | string | If required | Context for the filter (some filters require it) |
| `filters[].weight` | number | No | Relative weight (default 1.0) |
| `filters[].threshold` | number | No | Minimum score 0-100 to include (default 0) |
| `spaceId` | string | No | Limit to one space |
| `mode` | string | No | `quick` (fewer tokens) / `balanced` / `thorough` |
| `userQuery` | string | No | Natural-language context to guide scoring |
| `context` | string | No | Additional context for the AI |
| `limit` | number | No | Max results |

**Response:**
```json
{
  "results": [
    {
      "id": "item-abc",
      "type": "video",
      "title": "Quarterly Review Summary",
      "_search": {
        "compositeScore": 87,
        "scores": { "useful_for": 92, "quality_score": 78 },
        "reason": "Directly related to Q1 client presentation",
        "passesThresholds": true
      }
    }
  ],
  "total": 5,
  "cost": 0.003,
  "stats": {
    "totalItems": 42,
    "processedItems": 42,
    "completedBatches": 6
  }
}
```

> **Note:** Deep Search requires an OpenAI API key configured in app Settings. If no key is set, the endpoint returns 503 with an explanation.

---

### Deep Search Filter Discovery

List all available filter types grouped by category. Use this to build valid Deep Search requests.

```http
GET /api/search/deep/filters
```

**Response:**
```json
{
  "filterTypes": {
    "useful_for": {
      "id": "useful_for",
      "name": "Useful For",
      "description": "How useful this item would be for a specific purpose",
      "category": "purpose",
      "requiresInput": true,
      "inputPlaceholder": "Describe the purpose..."
    },
    "quality_score": {
      "id": "quality_score",
      "name": "Quality Score",
      "description": "Overall quality assessment of the content",
      "category": "quality"
    }
  },
  "categories": {
    "context": { "name": "Context Filters" },
    "quality": { "name": "Quality Filters" },
    "purpose": { "name": "Purpose Filters" },
    "content": { "name": "Content Filters" },
    "organizational": { "name": "Organizational Filters" }
  }
}
```

**Filter categories:**

| Category | Description |
|----------|-------------|
| `context` | Filters based on contextual relevance, recency, topic |
| `quality` | Quality scoring, completeness, clarity |
| `purpose` | How useful for a specific goal or audience |
| `content` | Content type, format, structure analysis |
| `organizational` | Team relevance, project alignment, workflow stage |

---

## Smart Folders

Smart folders are saved tag-based queries that create virtual views.

### List Smart Folders
```http
GET /api/smart-folders
```

### Create Smart Folder
```http
POST /api/smart-folders
Content-Type: application/json

{
  "name": "Important Items",
  "criteria": {
    "tags": ["important"],
    "types": ["text", "html"],
    "spaces": ["work-project"]
  },
  "icon": "⭐",
  "color": "#f59e0b"
}
```

### Get Smart Folder Items
```http
GET /api/smart-folders/:folderId/items?limit=50
```

### Delete Smart Folder
```http
DELETE /api/smart-folders/:folderId
```

---

## Metadata Operations

Metadata endpoints allow you to manage rich metadata for spaces, files, and assets.

All metadata follows the **SPACE Framework v3.0** schema, organizing context into five namespaces that AI agents can consume directly:

| Namespace | Category | What it captures |
|-----------|----------|-----------------|
| `system` | **S**ystem Insights | Health, sync status, integrations, processing state |
| `physical` | **P**hysical Locations | Storage paths, origin device, source URLs |
| `attributes` | **A**ttributes | Description, tags, author, category, capabilities |
| `communication` | **C**ommunication Context | Channels, related spaces, participants |
| `events` | **E**vent & Sequence Data | Activity log, milestones |

**Schema version:** 3.0 (Git-backed). Version history is tracked by Git commits, not metadata fields. The schema is fully extensible -- any field added to a SPACE namespace or the `extensions` slot is preserved across updates.

---

### Space SPACE Metadata

#### Get Space Metadata
```http
GET /api/spaces/:spaceId/metadata
```

**Response (v3.0 SPACE schema):**
```json
{
  "_schema": {
    "version": "3.0",
    "type": "space",
    "storageEngine": "git",
    "extensions": []
  },
  "id": "my-project",
  "name": "My Project",
  "icon": "circle",
  "color": "#3b82f6",
  "createdAt": "2024-01-15T10:30:00Z",
  "updatedAt": "2024-01-20T15:45:00Z",

  "system": {
    "health": "healthy",
    "itemCount": 42,
    "storageBytes": 1048576,
    "lastSyncAt": "2024-01-20T15:45:00Z",
    "syncStatus": "synced",
    "integrations": {
      "gsx": {
        "pushed": true,
        "graphId": "graph-abc123",
        "lastPushedAt": "2024-01-20T15:45:00Z"
      }
    },
    "errors": []
  },

  "physical": {
    "storagePath": "/Users/you/Documents/OR-Spaces/spaces/my-project",
    "originDevice": "MacBook-Pro",
    "region": null
  },

  "attributes": {
    "author": "richard",
    "description": "Client video project with review workflow",
    "tags": ["client-work", "video"],
    "category": "project",
    "visibility": "private",
    "isSystem": false,
    "capabilities": ["video-editing", "gsx-project"]
  },

  "communication": {
    "channels": ["project", "email"],
    "relatedSpaces": ["assets-library"],
    "sharedWith": [],
    "lastInteractionAt": "2024-01-20T15:45:00Z"
  },

  "events": {
    "activityLog": [],
    "milestones": []
  },

  "projectConfig": {
    "setupComplete": true,
    "mainFile": "index.html",
    "description": "Client video project",
    "targetUsers": "Marketing team",
    "stylePreference": "modern"
  },
  "files": {},
  "assets": {
    "logo": { "path": "assets/logo.png", "type": "image" },
    "banner": { "path": "assets/banner.jpg", "type": "image" }
  },
  "approvals": {},
  "extensions": {}
}
```

#### Update Space Metadata
```http
PUT /api/spaces/:spaceId/metadata
Content-Type: application/json

{
  "attributes": {
    "description": "Updated project description",
    "tags": ["client-work", "video", "approved"]
  },
  "communication": {
    "channels": ["project", "slack"]
  }
}
```

**Note:** This deep-merges with existing metadata. You can update any SPACE namespace independently -- fields you don't include are preserved.

---

### Item SPACE Metadata

When retrieving a single item, the response includes the full SPACE-framework metadata:

#### Get Single Item
```http
GET /api/spaces/:spaceId/items/:itemId
```

**Response (v3.0 SPACE schema in `metadata`):**
```json
{
  "id": "item-abc123",
  "type": "video",
  "spaceId": "my-project",
  "content": "/path/to/video.mp4",
  "timestamp": 1702759500000,
  "preview": "Project intro video",
  "metadata": {
    "_schema": {
      "version": "3.0",
      "type": "item",
      "contentType": "video",
      "storageEngine": "git"
    },
    "id": "item-abc123",
    "type": "video",
    "spaceId": "my-project",
    "dateCreated": "2024-12-16T10:30:00Z",
    "dateModified": "2024-12-18T09:15:00Z",

    "system": {
      "source": "drag-drop",
      "contentHash": "a1b2c3d4",
      "fileSize": 52428800,
      "mimeType": "video/mp4",
      "processingStatus": "enriched",
      "aiMetadata": {
        "generated": true,
        "generatedAt": "2024-12-16T10:35:00Z",
        "model": "claude-sonnet-4-20250514",
        "spaceContextUsed": true
      },
      "gsxPush": {
        "pushed": true,
        "pushedAt": "2024-12-17T14:00:00Z",
        "graphId": "node-xyz789",
        "status": "success",
        "error": null
      },
      "errors": []
    },

    "physical": {
      "sourceUrl": null,
      "sourceApp": "WISER Meeting",
      "deviceName": "MacBook-Pro",
      "filePath": "items/item-abc123/content.mp4"
    },

    "attributes": {
      "title": "Project Intro Video",
      "description": "30-second intro for the client presentation",
      "author": "richard",
      "tags": ["intro", "marketing", "approved"],
      "pinned": true,
      "notes": "Client approved final cut on Dec 18",
      "language": null
    },

    "communication": {
      "conversationId": null,
      "threadId": null,
      "participants": ["richard", "client-team"],
      "channel": "project"
    },

    "events": {
      "capturedAt": "2024-12-16T10:30:00Z",
      "sequence": 1,
      "relatedItems": ["item-def456"],
      "workflowStage": "approved"
    },

    "video": {
      "duration": 30.5,
      "resolution": "1920x1080",
      "codec": "h264",
      "frameRate": 30,
      "hasAudio": true,
      "transcription": "Welcome to our project overview...",
      "chapters": []
    },

    "scenes": [],
    "extensions": {}
  }
}
```

**Content-type namespaces** are included only for the relevant type:

| Item Type | Extra Namespace | Key Fields |
|-----------|----------------|------------|
| `video` | `video` | `duration`, `resolution`, `codec`, `frameRate`, `hasAudio`, `transcription`, `chapters` |
| `audio` | `audio` | `duration`, `sampleRate`, `channels`, `codec`, `transcription`, `speakers` |
| `image` | `image` | `width`, `height`, `format`, `colorSpace`, `hasAlpha` |
| `code` | `code` | `language`, `lineCount`, `framework`, `entryPoint` |
| `pdf` | `pdf` | `pageCount`, `hasOCR`, `extractedText` |
| `url` | `url` | `href`, `domain`, `lastCheckedAt`, `statusCode`, `contentType` |
| `text`, `html`, `file` | -- | Core SPACE namespaces only |

---

### Extending Metadata

Any SPACE namespace accepts additional fields via deep merge. For domain-specific data that doesn't fit a core namespace, use the `extensions` slot:

```http
PUT /api/spaces/:spaceId/metadata
Content-Type: application/json

{
  "extensions": {
    "budget-tracker": {
      "allocated": 5000,
      "spent": 2300,
      "currency": "USD"
    },
    "video-editor": {
      "timeline": { "tracks": 3, "duration": 120 },
      "exportPreset": "youtube-1080p"
    }
  }
}
```

Extensions are preserved across all updates and never overwritten by core schema changes.

---

### Get File Metadata
```http
GET /api/spaces/:spaceId/metadata/files/:filePath
```

**Example:** `GET /api/spaces/my-project/metadata/files/videos/intro.mp4`

**Response:**
```json
{
  "duration": 120.5,
  "resolution": "1920x1080",
  "codec": "h264",
  "transcribed": true,
  "tags": ["intro", "marketing"]
}
```

### Set File Metadata
```http
PUT /api/spaces/:spaceId/metadata/files/:filePath
Content-Type: application/json

{
  "duration": 120.5,
  "resolution": "1920x1080",
  "transcribed": true,
  "tags": ["intro", "marketing"]
}
```

---

### Get Asset Metadata
```http
GET /api/spaces/:spaceId/metadata/assets/:assetType
```

**Asset Types:** `logo`, `banner`, `thumbnail`, `icon`, or any custom type.

**Response:**
```json
{
  "path": "assets/logo.png",
  "type": "image",
  "width": 512,
  "height": 512,
  "uploadedAt": "2024-01-15T10:30:00Z"
}
```

### Set Asset Metadata
```http
PUT /api/spaces/:spaceId/metadata/assets/:assetType
Content-Type: application/json

{
  "path": "assets/logo.png",
  "type": "image",
  "width": 512,
  "height": 512
}
```

---

### Set Approval Status
```http
PUT /api/spaces/:spaceId/metadata/approvals/:itemType/:itemId
Content-Type: application/json

{
  "approved": true
}
```

**Use Cases:**
- Approve video segments before export
- Mark assets as client-approved
- Track review status of content

**Response:**
```json
{
  "success": true,
  "metadata": { /* updated space metadata */ }
}
```

---

### Get Version History

Version history is now powered by Git commits. The legacy endpoint still works and returns data in the same shape, hydrated from Git log.

```http
GET /api/spaces/:spaceId/metadata/versions
```

**Response (hydrated from Git):**
```json
{
  "versions": [
    {
      "sha": "a1b2c3d4e5f6...",
      "message": "Initial project setup",
      "author": { "name": "richard", "email": "richard@onereach.ai" },
      "timestamp": "2024-01-15T10:30:00Z"
    },
    {
      "sha": "f6e5d4c3b2a1...",
      "message": "Added new features",
      "author": { "name": "richard", "email": "richard@onereach.ai" },
      "timestamp": "2024-01-20T15:45:00Z"
    }
  ],
  "total": 2
}
```

**Note:** For full Git version control (branching, diffing, tagging), use the dedicated Git endpoints documented in the [Git Version Control](#git-version-control) section below.

### Add Version

Creating a version now creates a Git commit of all pending changes.

```http
POST /api/spaces/:spaceId/metadata/versions
Content-Type: application/json

{
  "notes": "Bug fixes and improvements",
  "author": "richard"
}
```

**Response:**
```json
{
  "sha": "c3d4e5f6a1b2...",
  "message": "Bug fixes and improvements",
  "author": "richard",
  "createdAt": "2024-01-22T09:00:00Z",
  "filesChanged": 3
}
```

---

### Get Project Configuration
```http
GET /api/spaces/:spaceId/metadata/project-config
```

**Response:**
```json
{
  "type": "video-project",
  "settings": {
    "resolution": "1080p",
    "frameRate": 30,
    "exportFormat": "mp4"
  },
  "workspace": {
    "layout": "timeline",
    "zoom": 1.0
  }
}
```

### Update Project Configuration
```http
PUT /api/spaces/:spaceId/metadata/project-config
Content-Type: application/json

{
  "type": "video-project",
  "settings": {
    "resolution": "4k",
    "frameRate": 60
  }
}
```

---

## GSX Graph Status & Schema

Endpoints for checking OmniGraph connectivity, browsing the graph schema, and retrieving statistics. The `/api/gsx/status` endpoint auto-initializes the OmniGraph client from settings if not yet configured.

---

### GSX Connection Status

```
GET /api/gsx/status
```

Returns the OmniGraph connection readiness. Auto-initializes from settings (`gsxRefreshUrl`) if the client has not been initialized yet.

**Response:**

```json
{
  "ready": true,
  "endpoint": "https://em.edison.api.onereach.ai/http/{accountId}/omnigraph",
  "graphName": "idw",
  "currentUser": "user@example.com",
  "connected": true,
  "nodeCount": 42
}
```

| Field | Type | Description |
|-------|------|-------------|
| `ready` | boolean | Whether the OmniGraph endpoint is configured |
| `endpoint` | string/null | The configured OmniGraph endpoint URL |
| `graphName` | string | Fixed graph name (always "idw") |
| `currentUser` | string/null | Current user for provenance tracking |
| `connected` | boolean | Whether a live connection test succeeded (only if ready) |
| `nodeCount` | number | Total nodes from connection test (only if connected) |

**cURL Example:**

```bash
curl http://127.0.0.1:47291/api/gsx/status
```

---

### Test Graph Connection

```
GET /api/gsx/test
```

Tests live connectivity to the OmniGraph API. Returns 503 if the client is not initialized.

**cURL Example:**

```bash
curl http://127.0.0.1:47291/api/gsx/test
```

---

### Graph Statistics

```
GET /api/gsx/stats
```

Returns counts of spaces and assets currently in the graph.

**Response:**

```json
{
  "spaces": 8,
  "assets": 12
}
```

**cURL Example:**

```bash
curl http://127.0.0.1:47291/api/gsx/stats
```

---

### List Graph Schemas

```
GET /api/gsx/schemas
```

Lists all entity schemas defined in the graph. Schemas describe the node types, their fields, and CRUD patterns for the Temporal Graph Honor System.

**Response:**

```json
{
  "schemas": [
    { "entity": "Asset", "description": "File/link attached to ticket. Types: document, image, video, link, code." },
    { "entity": "Person", "description": "User identified by email." },
    { "entity": "Schema", "description": "ONTOLOGY CORE. TEMPORAL GRAPH." }
  ]
}
```

**cURL Example:**

```bash
curl http://127.0.0.1:47291/api/gsx/schemas
```

---

### Get Entity Schema

```
GET /api/gsx/schema/:entity
```

Returns the full schema definition for a specific entity type (e.g., `Asset`, `Person`, `Space`).

**Path Parameters:**

| Parameter | Description |
|-----------|-------------|
| `entity` | Entity type name (e.g., `Asset`, `Person`, `Ticket`) |

**Response:**

```json
{
  "entity": "Asset",
  "version": "2.0.0",
  "description": "File/link attached to ticket.",
  "storagePattern": "graph",
  "instructions": "Create with provenance. Attach: (t)-[:HAS_ASSET]->(a)",
  "crudExamples": "{\"create\":\"CREATE (a:Asset {...}) RETURN a\",\"list\":\"MATCH ... RETURN a\"}",
  "created_by_app_name": "OntologySeedScript",
  "updated_at": 1770265110359
}
```

Returns 404 if the entity schema does not exist.

**cURL Example:**

```bash
curl http://127.0.0.1:47291/api/gsx/schema/Asset
```

---

## GSX Graph Push

Push items and spaces from local storage to the OmniGraph knowledge graph and GSX Files. These endpoints require the GSX connection to be initialized (auto-initialized from settings on first use). If GSX is not initialized, all endpoints return `503` with code `GSX_NOT_INITIALIZED`.

---

### Push Single Asset

Push a single item to the graph. Uploads the file to GSX Files and creates/updates the Asset node in OmniGraph.

```http
POST /api/spaces/:spaceId/items/:itemId/push
Content-Type: application/json

{
  "isPublic": false,
  "force": false
}
```

**Body Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `isPublic` | boolean | No | Whether the asset is publicly accessible (defaults to `false`) |
| `force` | boolean | No | Force push even if already synced (defaults to `false`) |

**Response (pushed):**
```json
{
  "success": true,
  "verified": true,
  "fileUrl": null,
  "fileLink": null,
  "graphNodeId": "asset_abc123def456",
  "version": "v1",
  "contentHash": "sha256:a1b2c3d4e5f6",
  "verification": {
    "graph": true,
    "graphDetails": { "spaceId": "work-project", "assetType": "text" },
    "file": false,
    "fileDetails": { "verified": false, "reason": "Not checked" },
    "timestamp": "2026-01-20T15:45:00.000Z"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `verified` | boolean | `true` only if the graph push was actually executed and verified |
| `graphNodeId` | string/null | The graph node ID (format: `asset_{itemId}`), null if graph unreachable |
| `fileUrl` | string/null | GSX Files URL, null if file sync not available |
| `fileLink` | string/null | Alias for `fileUrl` |
| `version` | string | Version string (e.g., `v1`, `v2`) |
| `contentHash` | string | SHA-256 content hash (format: `sha256:xxxx`) |
| `verification.graph` | boolean | Whether the graph write actually succeeded (not hardcoded) |
| `verification.file` | boolean | Whether the file URL was verified accessible |

**Response (skipped -- already synced):**
```json
{
  "success": true,
  "skipped": true,
  "message": "Already synced",
  "version": "v1"
}
```

> Use `"force": true` to re-push even when the content hash hasn't changed.

---

### Bulk Push Assets

Push multiple items to the graph in a single request.

```http
POST /api/spaces/:spaceId/items/push
Content-Type: application/json

{
  "itemIds": ["item-abc123", "item-def456"],
  "isPublic": false
}
```

**Body Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `itemIds` | string[] | Yes | Array of item IDs to push |
| `isPublic` | boolean | No | Whether assets are publicly accessible (defaults to `false`) |

**Response:**
```json
{
  "success": true,
  "pushed": [
    { "itemId": "item-abc123", "fileUrl": "https://files.gsx.ai/...", "version": 1 }
  ],
  "skipped": [
    { "itemId": "item-def456", "skipped": true, "message": "Already synced" }
  ],
  "failed": []
}
```

> Each entry in `pushed`, `skipped`, and `failed` includes the `itemId` plus the individual push result.

---

### Push Space

Push the space metadata to the graph. Optionally push all items within the space.

```http
POST /api/spaces/:spaceId/push
Content-Type: application/json

{
  "isPublic": false,
  "includeAssets": true
}
```

**Body Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `isPublic` | boolean | No | Public visibility (defaults to `false`) |
| `includeAssets` | boolean | No | Also push all items in the space (defaults to `false`) |

**Response:**
```json
{
  "success": true,
  "graphNodeId": "space-node-id",
  "assetsPushed": 12,
  "assetsSkipped": 3,
  "assetsFailed": 0
}
```

> `assetsSkipped` counts items already synced. `assetsFailed` counts items that encountered errors during push.

---

### Unpush Asset

Soft-delete an asset from the graph (marks it as removed, does not delete local content).

```http
POST /api/spaces/:spaceId/items/:itemId/unpush
```

**No request body required.**

**Response:**
```json
{
  "success": true,
  "message": "Asset unpushed"
}
```

---

### Unpush Space

Soft-delete a space from the graph.

```http
POST /api/spaces/:spaceId/unpush
Content-Type: application/json

{
  "includeAssets": true
}
```

**Body Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `includeAssets` | boolean | No | Also unpush all items in the space (defaults to `false`) |

**Response:**
```json
{
  "success": true,
  "message": "Space unpushed"
}
```

---

### Get Push Status

Check whether an item has been pushed to the graph and whether local changes exist since the last push.

```http
GET /api/spaces/:spaceId/items/:itemId/push-status
```

**Response:**
```json
{
  "status": "pushed",
  "fileUrl": "https://files.gsx.ai/...",
  "shareLink": "https://share.gsx.ai/...",
  "graphNodeId": "asset-node-id",
  "version": 1,
  "visibility": "private",
  "pushedAt": "2024-01-20T15:45:00Z",
  "pushedHash": "a1b2c3d4...",
  "localHash": "a1b2c3d4...",
  "hasLocalChanges": false,
  "history": []
}
```

**Status values:**

| Status | Description |
|--------|-------------|
| `pushed` | Item is synced with the graph, no local changes |
| `not_pushed` | Item has never been pushed |
| `unpushed` | Item was previously pushed but has been soft-deleted from the graph |
| `changed_locally` | Item was pushed but local content has changed since last push |
| `not_found` | Item ID does not exist locally |
| `error` | An error occurred checking push status |

---

### Change Visibility

Change whether an asset is publicly or privately visible in the graph.

```http
PUT /api/spaces/:spaceId/items/:itemId/visibility
Content-Type: application/json

{
  "isPublic": true
}
```

**Body Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `isPublic` | boolean | Yes | New visibility setting |

**Response:**
```json
{
  "success": true,
  "newVisibility": "public",
  "fileUrl": "https://files.gsx.ai/..."
}
```

---

### Get Links

Get all external links for a pushed asset (file URL, graph node ID, share link).

```http
GET /api/spaces/:spaceId/items/:itemId/links
```

**Response:**
```json
{
  "fileUrl": "https://files.gsx.ai/...",
  "graphNodeId": "asset-node-id",
  "shareLink": "https://share.gsx.ai/..."
}
```

---

## Sharing

Graph-based permission layer for sharing spaces and items with other users. Uses `SHARED_WITH` relationships in the OmniGraph with support for granular permissions and TTL expiry.

The permission model is defined as a first-class Schema entity in the graph. Any system can discover it via `GET /api/gsx/schema/Permission`.

---

### Permission Levels

| Level | Capabilities |
|-------|-------------|
| `read` | View space/asset, list items, download files |
| `write` | Read + add/edit/delete items, upload files, edit metadata |
| `admin` | Write + share with others, change visibility, manage approvals |
| `owner` | Implicit via `CREATED` relationship. Full control, cannot be revoked. |

### TTL Behavior

- `expiresIn` (seconds) is converted to an absolute `expiresAt` timestamp. Omit for no expiry.
- Expired shares are filtered at query time (lazy expiry). No background cleanup needed.
- The local `communication.sharedWith` array is pruned of stale entries on read.

---

### Share Space

```http
POST /api/spaces/:spaceId/share
Content-Type: application/json

{
  "email": "collaborator@example.com",
  "permission": "write",
  "expiresIn": 86400,
  "note": "Project collaboration"
}
```

**Body Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `email` | string | Yes | Email address of the person to share with |
| `permission` | string | Yes | `read`, `write`, or `admin` |
| `expiresIn` | number | No | TTL in seconds from now (omit for no expiry) |
| `note` | string | No | Optional message for the recipient |

**Response:**

```json
{
  "success": true,
  "share": {
    "email": "collaborator@example.com",
    "name": "collaborator",
    "permission": "write",
    "grantedAt": "2026-02-07T20:00:00.000Z",
    "expiresAt": "2026-02-08T20:00:00.000Z",
    "grantedBy": "owner@example.com"
  },
  "graphSynced": true
}
```

**cURL Example:**

```bash
curl -X POST http://127.0.0.1:47291/api/spaces/my-space-id/share \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "permission": "read"}'
```

---

### List Space Shares

```http
GET /api/spaces/:spaceId/share
```

Returns all active (non-expired) shares for a space. Reads from the graph when available, falls back to local metadata.

**Response:**

```json
{
  "shares": [
    {
      "email": "collaborator@example.com",
      "name": "collaborator",
      "role": "USER",
      "permission": "write",
      "grantedAt": 1707350400000,
      "expiresAt": null,
      "grantedBy": "owner@example.com",
      "note": "Project collaboration"
    }
  ]
}
```

**cURL Example:**

```bash
curl http://127.0.0.1:47291/api/spaces/my-space-id/share
```

---

### Revoke Space Share

```http
DELETE /api/spaces/:spaceId/share/:email
```

Removes the `SHARED_WITH` relationship and updates local metadata.

**Response:**

```json
{
  "success": true,
  "graphSynced": true
}
```

**cURL Example:**

```bash
curl -X DELETE http://127.0.0.1:47291/api/spaces/my-space-id/share/user@example.com
```

---

### Share Item

```http
POST /api/spaces/:spaceId/items/:itemId/share
Content-Type: application/json

{
  "email": "reviewer@example.com",
  "permission": "read",
  "expiresIn": 3600,
  "note": "Please review"
}
```

Same parameters as Share Space. Creates a `SHARED_WITH` relationship between the Person and Asset nodes.

**cURL Example:**

```bash
curl -X POST http://127.0.0.1:47291/api/spaces/my-space-id/items/item-123/share \
  -H "Content-Type: application/json" \
  -d '{"email": "reviewer@example.com", "permission": "read", "expiresIn": 3600}'
```

---

### List Item Shares

```http
GET /api/spaces/:spaceId/items/:itemId/share
```

Returns all active shares for an item.

**cURL Example:**

```bash
curl http://127.0.0.1:47291/api/spaces/my-space-id/items/item-123/share
```

---

### Revoke Item Share

```http
DELETE /api/spaces/:spaceId/items/:itemId/share/:email
```

**cURL Example:**

```bash
curl -X DELETE http://127.0.0.1:47291/api/spaces/my-space-id/items/item-123/share/reviewer@example.com
```

---

### My Shares

```http
GET /api/shares
```

Returns all spaces and items shared with the current user (graph-only, requires valid user email).

**Response:**

```json
{
  "shares": [
    {
      "id": "space-abc",
      "name": "Project Alpha",
      "type": "space",
      "permission": "write",
      "grantedAt": 1707350400000,
      "expiresAt": null,
      "grantedBy": "owner@example.com"
    },
    {
      "id": "item-xyz",
      "name": "Design Draft",
      "type": "asset",
      "permission": "read",
      "grantedAt": 1707350400000,
      "expiresAt": 1707436800000,
      "grantedBy": "team@example.com"
    }
  ]
}
```

**cURL Example:**

```bash
curl http://127.0.0.1:47291/api/shares
```

---

## File Upload

Upload binary files directly to a space using multipart/form-data (no base64 encoding needed). Supports files up to 100 MB.

---

### Upload File (Multipart)

```http
POST /api/spaces/:spaceId/items/upload
Content-Type: multipart/form-data
```

**Form Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | binary | Yes | The file to upload |
| `type` | string | No | Content type hint (`file`, `image`, `video`, etc.). Defaults to `file`. |
| `title` | string | No | Display title for the item |
| `tags` | string | No | JSON array string, e.g. `'["tag1","tag2"]'` |
| `sourceUrl` | string | No | Source URL for provenance |
| `metadata` | string | No | JSON object string with additional metadata |

**Response:**
```json
{
  "success": true,
  "itemId": "item-abc123",
  "fileName": "report.pdf",
  "fileSize": 1048576
}
```

**Example (cURL):**
```bash
curl -X POST http://127.0.0.1:47291/api/spaces/my-project/items/upload \
  -F "file=@/path/to/report.pdf" \
  -F "title=Q4 Report" \
  -F 'tags=["reports","q4"]'
```

---

### Send File by Path (JSON)

If the file already exists on the local machine, you can reference it by path instead of uploading. This avoids base64 overhead entirely.

```http
POST /api/send-to-space
Content-Type: application/json

{
  "spaceId": "my-project",
  "filePath": "/Users/me/Downloads/report.pdf",
  "fileName": "report.pdf",
  "type": "file",
  "title": "Q4 Report"
}
```

**Body Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `spaceId` | string | Yes | Target space ID |
| `filePath` | string | Yes* | Absolute path to local file (*required if no `content`) |
| `fileName` | string | No | Override filename (defaults to basename of filePath) |
| `content` | string | No | Text/base64 content (not needed when using filePath) |
| `type` | string | No | Content type hint (defaults to `file` when filePath is used) |
| `title` | string | No | Display title |
| `tags` | string[] | No | Tags to apply |

> Note: Either `content` or `filePath` must be provided. When both are present, `content` is used as the item content and `filePath` is used for the file copy.

---

## Space Files API

Direct read/write access to files within a space's storage directory. This is useful for tools that need to manage project files (HTML, CSS, JS, config files, etc.) directly.

All paths are relative to the space's root directory. Directory traversal (`../`) is blocked and returns `403` with code `PATH_TRAVERSAL`.

---

### List Files

List files and directories in a space's root (or a subdirectory).

```http
GET /api/spaces/:spaceId/files
```

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `subPath` | string | `""` | Subdirectory to list (relative to space root) |

**Response:**
```json
{
  "files": [
    {
      "name": "index.html",
      "isDirectory": false,
      "path": "/Users/you/Documents/OR-Spaces/spaces/my-project/index.html",
      "relativePath": "index.html"
    },
    {
      "name": "assets",
      "isDirectory": true,
      "path": "/Users/you/Documents/OR-Spaces/spaces/my-project/assets",
      "relativePath": "assets"
    }
  ],
  "total": 2
}
```

---

### Read File

Read the contents of a file. Returns the raw content with the appropriate MIME type.

```http
GET /api/spaces/:spaceId/files/:filePath
```

The `:filePath` can include subdirectories (e.g., `assets/logo.png`).

**Response for text files:** Returns raw text content with `Content-Type: text/html`, `text/plain`, `application/json`, etc.

**Response for binary files:** Returns raw binary content with `Content-Type: application/octet-stream`, `image/png`, etc.

**Response for directories:** Returns a JSON file listing (same format as List Files).

---

### Write File

Create or overwrite a file in the space directory. Parent directories are created automatically.

```http
PUT /api/spaces/:spaceId/files/:filePath
Content-Type: application/json

{
  "content": "<!DOCTYPE html>\n<html>...</html>"
}
```

Or with raw text body:

```http
PUT /api/spaces/:spaceId/files/:filePath
Content-Type: text/plain

Raw file content here...
```

**Response:**
```json
{
  "success": true,
  "filePath": "index.html"
}
```

---

### Delete File

Delete a file from the space directory.

```http
DELETE /api/spaces/:spaceId/files/:filePath
```

**Response:**
```json
{
  "success": true,
  "filePath": "old-file.txt"
}
```

---

## Git Version Control

Spaces v3.0 is backed by `isomorphic-git`, a pure JavaScript Git implementation running locally inside the Electron app. All text content and metadata is versioned automatically. Binary files (images, video, audio) are excluded from Git tracking via `.gitignore` to keep the repository lean.

These endpoints expose the full power of Git: commit history, branching, merging, diffing, tagging, and reverting. The underlying storage directory (`~/Documents/OR-Spaces/`) is the Git working tree.

> **Prerequisite:** The v2-to-v3 migration must be completed before Git endpoints are available. Use the migration endpoints below to trigger or check status.

---

### Git Commit Log

Retrieve the Git commit history for a space (or a specific file path within it).

```http
GET /api/spaces/:spaceId/git-versions
```

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `depth` | number | `50` | Maximum number of commits to return (capped at 500) |
| `filepath` | string | `spaces/:spaceId` | Restrict log to a specific file or directory path |

**Response:**
```json
{
  "versions": [
    {
      "sha": "a1b2c3d4e5f6789...",
      "message": "Updated playbook content",
      "author": "richard",
      "authorEmail": "richard@onereach.ai",
      "timestamp": "2024-01-25T03:30:00.000Z",
      "parentShas": ["9876543210abcdef..."]
    }
  ],
  "total": 1
}
```

**Example:** Get the last 10 commits for a specific item:
```bash
curl "http://127.0.0.1:47291/api/spaces/my-project/git-versions?depth=10&filepath=items/item-abc123/metadata.json"
```

---

### Create Git Commit

Commit pending changes to the repository. You can commit all changes or specify individual file paths.

```http
POST /api/spaces/:spaceId/git-versions
Content-Type: application/json

{
  "message": "Updated project files",
  "authorName": "richard",
  "authorEmail": "richard@onereach.ai",
  "filepaths": ["spaces/my-project/space-metadata.json"]
}
```

**Body Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | Yes | Commit message describing the changes |
| `authorName` | string | No | Author name (defaults to "system") |
| `authorEmail` | string | No | Author email (defaults to "system@onereach.ai") |
| `filepaths` | string[] | No | Specific files to commit. If omitted, commits all changed files. |

**Response:**
```json
{
  "success": true,
  "sha": "a1b2c3d4e5f6789...",
  "filesChanged": 2
}
```

---

### Git Diff

Compare changes between two commits, or between a commit and HEAD.

```http
GET /api/spaces/:spaceId/git-diff
```

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | string | Yes | Starting commit SHA or ref (e.g., branch name, tag) |
| `to` | string | No | Ending commit SHA or ref (defaults to `HEAD`) |

**Response:**
```json
{
  "changes": [
    {
      "filepath": "spaces/my-project/space-metadata.json",
      "status": "modified"
    },
    {
      "filepath": "items/item-abc123/metadata.json",
      "status": "added"
    }
  ],
  "total": 2
}
```

**Status values:** `added`, `modified`, `deleted`

**Example:** Diff the last two commits:
```bash
curl "http://127.0.0.1:47291/api/spaces/my-project/git-diff?from=abc1234&to=def5678"
```

---

### List Branches

List all local branches and identify which one is currently checked out.

```http
GET /api/spaces/:spaceId/git-branches
```

**Response:**
```json
{
  "branches": ["main", "feature/new-playbook", "agent/review-draft"],
  "current": "main"
}
```

---

### Create Branch

Create a new branch, optionally from a specific commit or ref, and optionally check it out immediately.

```http
POST /api/spaces/:spaceId/git-branches
Content-Type: application/json

{
  "name": "feature/new-playbook",
  "startPoint": "main",
  "checkout": true
}
```

**Body Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Branch name |
| `startPoint` | string | No | Commit SHA, branch name, or tag to branch from (defaults to HEAD) |
| `checkout` | boolean | No | Whether to switch to the new branch immediately (defaults to `false`) |

**Response:**
```json
{
  "success": true,
  "branch": "feature/new-playbook",
  "checkedOut": true
}
```

---

### Merge Branch

Merge another branch into the currently checked-out branch.

```http
POST /api/spaces/:spaceId/git-merge
Content-Type: application/json

{
  "theirs": "feature/new-playbook",
  "authorName": "richard",
  "authorEmail": "richard@onereach.ai",
  "message": "Merge feature/new-playbook into main"
}
```

**Body Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `theirs` | string | Yes | Name of the branch to merge into current |
| `authorName` | string | No | Author name for the merge commit |
| `authorEmail` | string | No | Author email for the merge commit |
| `message` | string | No | Custom merge commit message |

**Response (success):**
```json
{
  "success": true,
  "oid": "merge-commit-sha...",
  "alreadyMerged": false
}
```

**Response (conflict -- HTTP 409):**
```json
{
  "error": "Merge conflict",
  "code": "MERGE_CONFLICT",
  "details": "Automatic merge failed for spaces/my-project/space-metadata.json"
}
```

---

### Working Tree Status

Get the current working tree status: which files are new, modified, or deleted since the last commit.

```http
GET /api/spaces/:spaceId/git-status
```

**Response:**
```json
{
  "branch": "main",
  "staged": ["spaces/my-project/space-metadata.json"],
  "unstaged": ["items/item-abc123/metadata.json"],
  "untracked": ["items/item-new/metadata.json"],
  "conflicted": []
}
```

---

### List Tags

List all tags in the repository.

```http
GET /api/spaces/:spaceId/git-tags
```

**Response:**
```json
{
  "tags": ["v1.0.0", "v1.1.0", "release/2024-01"]
}
```

---

### Create Tag

Create an annotated tag at a specific commit (or HEAD).

```http
POST /api/spaces/:spaceId/git-tags
Content-Type: application/json

{
  "name": "v1.2.0",
  "message": "Release v1.2.0 - added review workflow",
  "ref": "HEAD",
  "authorName": "richard"
}
```

**Body Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Tag name (e.g., `v1.2.0`, `release/sprint-5`) |
| `message` | string | No | Annotation message for the tag |
| `ref` | string | No | Commit SHA or ref to tag (defaults to `HEAD`) |
| `authorName` | string | No | Author name for the annotated tag |

**Response:**
```json
{
  "success": true,
  "tag": "v1.2.0"
}
```

---

### Revert Commit

Create a new commit that undoes the changes introduced by a specific commit.

```http
POST /api/spaces/:spaceId/git-revert
Content-Type: application/json

{
  "sha": "a1b2c3d4e5f6789...",
  "authorName": "richard"
}
```

**Body Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sha` | string | Yes | The commit SHA to revert |
| `authorName` | string | No | Author name for the revert commit (defaults to "system") |

**Response:**
```json
{
  "success": true,
  "sha": "new-revert-commit-sha...",
  "message": "Revert: Updated playbook content"
}
```

---

### Migration: Trigger v2 to v3

Run the one-time migration from the legacy v2 metadata format to v3 Git-backed storage. This creates a full backup, initializes the Git repository, strips legacy fields, and writes the v3 version marker.

```http
POST /api/git/migration
```

**No request body required.**

**Response (first run):**
```json
{
  "success": true,
  "backupPath": "/Users/you/Documents/OR-Spaces-backup-20240120T154500",
  "commitSha": "initial-commit-sha...",
  "stats": {
    "spacesUpgraded": 5,
    "itemsUpgraded": 42,
    "legacyFilesRemoved": 3
  },
  "progressEvents": [
    { "step": "backup", "detail": "Creating backup...", "percent": 10, "timestamp": "..." },
    { "step": "init-git", "detail": "Initializing Git repository...", "percent": 30, "timestamp": "..." },
    { "step": "commit", "detail": "Creating initial commit...", "percent": 60, "timestamp": "..." },
    { "step": "upgrade-schemas", "detail": "Upgrading metadata schemas...", "percent": 80, "timestamp": "..." },
    { "step": "done", "detail": "Migration complete", "percent": 100, "timestamp": "..." }
  ]
}
```

**Response (already migrated):**
```json
{
  "success": true,
  "alreadyMigrated": true
}
```

**Response (failure -- HTTP 500):**
```json
{
  "error": "Migration failed",
  "code": "MIGRATION_ERROR",
  "details": "Detailed error message...",
  "backupPath": "/Users/you/Documents/OR-Spaces-backup-20240120T154500"
}
```

> **Important:** The backup is always created before any changes are made. If migration fails, restore from the backup path included in the error response.

---

### Migration: Check Status

Check whether the v2-to-v3 migration has been completed.

```http
GET /api/git/migration
```

**Response:**
```json
{
  "isV3": true,
  "isGitInitialized": true
}
```

---

## Code Examples

### JavaScript/Node.js

```javascript
const SPACES_API = 'http://127.0.0.1:47291';

// List all spaces
async function getSpaces() {
  const response = await fetch(`${SPACES_API}/api/spaces`);
  const data = await response.json();
  return data.spaces;
}

// Add content to a space
async function addToSpace(spaceId, content, options = {}) {
  const response = await fetch(`${SPACES_API}/api/send-to-space`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      spaceId,
      type: options.type || 'text',
      content,
      title: options.title,
      sourceUrl: options.sourceUrl,
      metadata: options.metadata
    })
  });
  
  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error || 'Failed to add item');
  }
  return result.itemId;
}

// Search for items
async function searchItems(query, options = {}) {
  const params = new URLSearchParams({ q: query, ...options });
  const response = await fetch(`${SPACES_API}/api/search?${params}`);
  return await response.json();
}

// Usage
async function main() {
  // Get spaces
  const spaces = await getSpaces();
  console.log('Available spaces:', spaces.map(s => s.name));
  
  // Add text content
  const itemId = await addToSpace('unclassified', 'Hello from my tool app!', {
    title: 'Test Item',
    sourceUrl: 'my-tool-app://test'
  });
  console.log('Created item:', itemId);
  
  // Search
  const results = await searchItems('hello');
  console.log('Found:', results.total, 'items');
}

main().catch(console.error);
```

### Python

```python
import requests

SPACES_API = 'http://127.0.0.1:47291'

def get_spaces():
    """List all available spaces"""
    response = requests.get(f'{SPACES_API}/api/spaces')
    response.raise_for_status()
    return response.json()['spaces']

def add_to_space(space_id, content, content_type='text', title=None, source_url=None, metadata=None):
    """Add content to a space"""
    payload = {
        'spaceId': space_id,
        'type': content_type,
        'content': content,
    }
    if title:
        payload['title'] = title
    if source_url:
        payload['sourceUrl'] = source_url
    if metadata:
        payload['metadata'] = metadata
    
    response = requests.post(
        f'{SPACES_API}/api/send-to-space',
        json=payload
    )
    response.raise_for_status()
    result = response.json()
    
    if not result.get('success'):
        raise Exception(result.get('error', 'Failed to add item'))
    
    return result['itemId']

def search_items(query, space_id=None, limit=20):
    """Search for items across spaces"""
    params = {'q': query, 'limit': limit}
    if space_id:
        params['spaceId'] = space_id
    
    response = requests.get(f'{SPACES_API}/api/search', params=params)
    response.raise_for_status()
    return response.json()

def delete_item(space_id, item_id):
    """Delete an item from a space"""
    response = requests.delete(f'{SPACES_API}/api/spaces/{space_id}/items/{item_id}')
    response.raise_for_status()
    return response.json()

# Usage
if __name__ == '__main__':
    # List spaces
    spaces = get_spaces()
    print(f"Available spaces: {[s['name'] for s in spaces]}")
    
    # Add content
    item_id = add_to_space(
        'unclassified',
        'Hello from Python!',
        title='Python Test',
        source_url='python://test'
    )
    print(f"Created item: {item_id}")
    
    # Search
    results = search_items('hello')
    print(f"Found {results['total']} items")
```

### cURL

```bash
# Check server status
curl http://127.0.0.1:47291/api/status

# List all spaces
curl http://127.0.0.1:47291/api/spaces

# Add text to a space
curl -X POST http://127.0.0.1:47291/api/send-to-space \
  -H "Content-Type: application/json" \
  -d '{
    "spaceId": "unclassified",
    "type": "text",
    "content": "Hello from curl!",
    "title": "Curl Test"
  }'

# Add HTML content
curl -X POST http://127.0.0.1:47291/api/send-to-space \
  -H "Content-Type: application/json" \
  -d '{
    "spaceId": "work-project",
    "type": "html",
    "content": "<h1>Report</h1><p>Generated content...</p>",
    "title": "Generated Report",
    "sourceUrl": "https://my-tool.com/report/123"
  }'

# Search for items
curl "http://127.0.0.1:47291/api/search?q=hello&limit=10"

# Get items from a space
curl "http://127.0.0.1:47291/api/spaces/unclassified/items?limit=10"

# Delete an item
curl -X DELETE http://127.0.0.1:47291/api/spaces/unclassified/items/item-abc123

# --- Git Version Control ---

# Check migration status
curl http://127.0.0.1:47291/api/git/migration

# Trigger v2 to v3 migration (run once)
curl -X POST http://127.0.0.1:47291/api/git/migration

# Get Git commit log for a space
curl "http://127.0.0.1:47291/api/spaces/my-project/git-versions?depth=10"

# Create a Git commit
curl -X POST http://127.0.0.1:47291/api/spaces/my-project/git-versions \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Updated project files",
    "authorName": "richard"
  }'

# View working tree status
curl http://127.0.0.1:47291/api/spaces/my-project/git-status

# Diff between two commits
curl "http://127.0.0.1:47291/api/spaces/my-project/git-diff?from=abc1234&to=HEAD"

# List branches
curl http://127.0.0.1:47291/api/spaces/my-project/git-branches

# Create and checkout a new branch
curl -X POST http://127.0.0.1:47291/api/spaces/my-project/git-branches \
  -H "Content-Type: application/json" \
  -d '{"name": "feature/review", "checkout": true}'

# Merge a branch
curl -X POST http://127.0.0.1:47291/api/spaces/my-project/git-merge \
  -H "Content-Type: application/json" \
  -d '{"theirs": "feature/review", "authorName": "richard"}'

# Create a tag
curl -X POST http://127.0.0.1:47291/api/spaces/my-project/git-tags \
  -H "Content-Type: application/json" \
  -d '{"name": "v1.0.0", "message": "First release"}'

# List all tags
curl http://127.0.0.1:47291/api/spaces/my-project/git-tags

# Revert a commit
curl -X POST http://127.0.0.1:47291/api/spaces/my-project/git-revert \
  -H "Content-Type: application/json" \
  -d '{"sha": "a1b2c3d4e5f6789", "authorName": "richard"}'

# --- GSX Graph Push ---

# Push an item to the graph
curl -X POST http://127.0.0.1:47291/api/spaces/my-project/items/item-abc123/push \
  -H "Content-Type: application/json" \
  -d '{"isPublic": false}'

# Bulk push items
curl -X POST http://127.0.0.1:47291/api/spaces/my-project/items/push \
  -H "Content-Type: application/json" \
  -d '{"itemIds": ["item-abc123", "item-def456"]}'

# Push entire space with all assets
curl -X POST http://127.0.0.1:47291/api/spaces/my-project/push \
  -H "Content-Type: application/json" \
  -d '{"includeAssets": true}'

# Get push status
curl http://127.0.0.1:47291/api/spaces/my-project/items/item-abc123/push-status

# Get links (file URL, graph node, share link)
curl http://127.0.0.1:47291/api/spaces/my-project/items/item-abc123/links

# Change visibility to public
curl -X PUT http://127.0.0.1:47291/api/spaces/my-project/items/item-abc123/visibility \
  -H "Content-Type: application/json" \
  -d '{"isPublic": true}'

# Force re-push (even if already synced)
curl -X POST http://127.0.0.1:47291/api/spaces/my-project/items/item-abc123/push \
  -H "Content-Type: application/json" \
  -d '{"isPublic": false, "force": true}'

# Unpush an item
curl -X POST http://127.0.0.1:47291/api/spaces/my-project/items/item-abc123/unpush

# Unpush entire space (including all assets)
curl -X POST http://127.0.0.1:47291/api/spaces/my-project/unpush \
  -H "Content-Type: application/json" \
  -d '{"includeAssets": true}'

# --- Database ---

# Check DuckDB index status
curl http://127.0.0.1:47291/api/database/status

# Rebuild DuckDB index
curl -X POST http://127.0.0.1:47291/api/database/rebuild

# --- File Upload ---

# Upload a file using multipart/form-data
curl -X POST http://127.0.0.1:47291/api/spaces/my-project/items/upload \
  -F "file=@/path/to/report.pdf" \
  -F "title=Q4 Report" \
  -F 'tags=["reports","q4"]'

# Send a local file by path (no upload needed)
curl -X POST http://127.0.0.1:47291/api/send-to-space \
  -H "Content-Type: application/json" \
  -d '{
    "spaceId": "my-project",
    "filePath": "/Users/me/Downloads/report.pdf",
    "type": "file",
    "title": "Q4 Report"
  }'

# --- Space Files API ---

# List files in a space
curl http://127.0.0.1:47291/api/spaces/my-project/files

# List files in a subdirectory
curl "http://127.0.0.1:47291/api/spaces/my-project/files?subPath=assets"

# Read a file
curl http://127.0.0.1:47291/api/spaces/my-project/files/index.html

# Write a file (JSON body)
curl -X PUT http://127.0.0.1:47291/api/spaces/my-project/files/README.md \
  -H "Content-Type: application/json" \
  -d '{"content": "# My Project\n\nProject documentation."}'

# Write a file (raw text body)
curl -X PUT http://127.0.0.1:47291/api/spaces/my-project/files/notes.txt \
  -H "Content-Type: text/plain" \
  -d "These are my project notes."

# Delete a file
curl -X DELETE http://127.0.0.1:47291/api/spaces/my-project/files/old-file.txt
```

### Shell Script Integration

```bash
#!/bin/bash
# save-to-spaces.sh - Save output to Spaces

SPACES_API="http://127.0.0.1:47291"
SPACE_ID="${SPACE_ID:-unclassified}"

# Function to save text to spaces
save_to_spaces() {
    local content="$1"
    local title="${2:-Command Output}"
    local type="${3:-text}"
    
    curl -s -X POST "$SPACES_API/api/send-to-space" \
        -H "Content-Type: application/json" \
        -d "$(jq -n \
            --arg spaceId "$SPACE_ID" \
            --arg type "$type" \
            --arg content "$content" \
            --arg title "$title" \
            '{spaceId: $spaceId, type: $type, content: $content, title: $title}'
        )"
}

# Usage: pipe command output to spaces
# echo "Hello World" | save_to_spaces "$(cat)" "My Title"

# Or save a command's output
# save_to_spaces "$(ls -la)" "Directory Listing"
```

---

## Error Handling

All endpoints return consistent error responses:

```json
{
  "error": "Error message here",
  "code": "ERROR_CODE"
}
```

**Common Error Codes:**
| Code | HTTP Status | Description |
|------|-------------|-------------|
| `MISSING_REQUIRED_FIELD` | 400 | Required field not provided |
| `INVALID_ID` | 400 | Invalid or non-existent space/item/folder ID |
| `INVALID_JSON` | 400 | Request body is not valid JSON |
| `INVALID_CONTENT_TYPE` | 400 | Expected a different Content-Type header (e.g., multipart/form-data) |
| `INVALID_INPUT` | 400 | Invalid parameter value (e.g., expected boolean) |
| `INVALID_PATH` | 400 | Invalid file path or tag name |
| `INVALID_OPERATION` | 400 | Operation not allowed (e.g., deleting the Unclassified space) |
| `EMPTY_CONTENT` | 400 | Content cannot be empty |
| `PATH_TRAVERSAL` | 403 | File path attempted to escape the space directory (`../`) |
| `NOT_FOUND` | 404 | Resource not found |
| `MERGE_CONFLICT` | 409 | Git merge conflict -- automatic merge failed |
| `FILE_TOO_LARGE` | 413 | Uploaded file exceeds the 100 MB limit |
| `PAYLOAD_TOO_LARGE` | 413 | Request body exceeds size limit |
| `SERVER_ERROR` | 500 | Internal server error |
| `MIGRATION_ERROR` | 500 | v2-to-v3 migration failed (backup path in response) |
| `DATABASE_NOT_AVAILABLE` | 503 | DuckDB database not initialized or unavailable |
| `GIT_NOT_INITIALIZED` | 503 | Git repository not initialized (migration not run) |
| `GSX_NOT_INITIALIZED` | 503 | GSX graph connection not configured |
| `SERVICE_UNAVAILABLE` | 503 | Required service not ready (e.g., deep search engine) |
| `NO_EXTENSION` | 503 | Browser extension not connected (for tab capture endpoints) |

**Example Error Response:**
```json
{
  "error": "Missing spaceId or content",
  "code": "MISSING_REQUIRED_FIELD"
}
```

---

## Testing the Connection

Before integrating, verify the server is running:

```bash
# Quick health check
curl -s http://127.0.0.1:47291/api/status | jq .

# Expected output:
# {
#   "status": "ok",
#   "version": "1.0.8",
#   "extensionConnected": false,
#   "port": 47291
# }
```

If the request fails, ensure:
1. OneReach app is running
2. You're connecting from localhost only
3. Port 47291 is not blocked by firewall

---

## Quick Reference

| Operation | Method | Endpoint |
|-----------|--------|----------|
| Server Status | GET | `/api/status` |
| Force Reload Index | POST | `/api/reload` |
| Database Status | GET | `/api/database/status` |
| Rebuild Database | POST | `/api/database/rebuild` |
| **Spaces** | | |
| List Spaces | GET | `/api/spaces` |
| Get Space | GET | `/api/spaces/:id` |
| Create Space | POST | `/api/spaces` |
| Update Space | PUT | `/api/spaces/:id` |
| Delete Space | DELETE | `/api/spaces/:id` |
| **Items** | | |
| List Items | GET | `/api/spaces/:id/items` |
| Get Item | GET | `/api/spaces/:id/items/:itemId` |
| Add Item | POST | `/api/send-to-space` |
| Update Item | PUT | `/api/spaces/:id/items/:itemId` |
| Delete Item | DELETE | `/api/spaces/:id/items/:itemId` |
| Move Item | POST | `/api/spaces/:id/items/:itemId/move` |
| Pin/Unpin | POST | `/api/spaces/:id/items/:itemId/pin` |
| **Tags** | | |
| Get Tags | GET | `/api/spaces/:id/items/:itemId/tags` |
| Set Tags | PUT | `/api/spaces/:id/items/:itemId/tags` |
| Add Tag | POST | `/api/spaces/:id/items/:itemId/tags` |
| Remove Tag | DELETE | `/api/spaces/:id/items/:itemId/tags/:tag` |
| List Space Tags | GET | `/api/spaces/:id/tags` |
| Search by Tags | GET | `/api/tags/search` |
| **Search** | | |
| Quick Search | GET | `/api/search?q=...` |
| Search Suggestions | GET | `/api/search/suggestions?prefix=...` |
| Deep Search | POST | `/api/search/deep` |
| Deep Search Filters | GET | `/api/search/deep/filters` |
| **Smart Folders** | | |
| List Folders | GET | `/api/smart-folders` |
| Create Folder | POST | `/api/smart-folders` |
| Get Folder Items | GET | `/api/smart-folders/:id/items` |
| Delete Folder | DELETE | `/api/smart-folders/:id` |
| **Metadata** | | |
| Get Space Metadata | GET | `/api/spaces/:id/metadata` |
| Update Space Metadata | PUT | `/api/spaces/:id/metadata` |
| Get File Metadata | GET | `/api/spaces/:id/metadata/files/:path` |
| Set File Metadata | PUT | `/api/spaces/:id/metadata/files/:path` |
| Get Asset Metadata | GET | `/api/spaces/:id/metadata/assets/:type` |
| Set Asset Metadata | PUT | `/api/spaces/:id/metadata/assets/:type` |
| Set Approval | PUT | `/api/spaces/:id/metadata/approvals/:type/:itemId` |
| Get Versions | GET | `/api/spaces/:id/metadata/versions` |
| Add Version | POST | `/api/spaces/:id/metadata/versions` |
| Get Project Config | GET | `/api/spaces/:id/metadata/project-config` |
| Update Project Config | PUT | `/api/spaces/:id/metadata/project-config` |
| **Data Sources** | | |
| List All Data Sources | GET | `/api/data-sources` |
| Get Data Source | GET | `/api/data-sources/:itemId` |
| Get Document | GET | `/api/data-sources/:itemId/document` |
| Update Document | PUT | `/api/data-sources/:itemId/document` |
| Get Operations | GET | `/api/data-sources/:itemId/operations` |
| Test Connectivity | POST | `/api/data-sources/:itemId/test` |
| **GSX Graph Status & Schema** | | |
| GSX Connection Status | GET | `/api/gsx/status` |
| Test Graph Connection | GET | `/api/gsx/test` |
| Graph Statistics | GET | `/api/gsx/stats` |
| List Graph Schemas | GET | `/api/gsx/schemas` |
| Get Entity Schema | GET | `/api/gsx/schema/:entity` |
| **Sharing** | | |
| Share Space | POST | `/api/spaces/:id/share` |
| List Space Shares | GET | `/api/spaces/:id/share` |
| Revoke Space Share | DELETE | `/api/spaces/:id/share/:email` |
| Share Item | POST | `/api/spaces/:id/items/:itemId/share` |
| List Item Shares | GET | `/api/spaces/:id/items/:itemId/share` |
| Revoke Item Share | DELETE | `/api/spaces/:id/items/:itemId/share/:email` |
| My Shares | GET | `/api/shares` |
| **GSX Graph Push** | | |
| Push Asset | POST | `/api/spaces/:id/items/:itemId/push` |
| Bulk Push Assets | POST | `/api/spaces/:id/items/push` |
| Push Space | POST | `/api/spaces/:id/push` |
| Unpush Asset | POST | `/api/spaces/:id/items/:itemId/unpush` |
| Unpush Space | POST | `/api/spaces/:id/unpush` |
| Get Push Status | GET | `/api/spaces/:id/items/:itemId/push-status` |
| Change Visibility | PUT | `/api/spaces/:id/items/:itemId/visibility` |
| Get Links | GET | `/api/spaces/:id/items/:itemId/links` |
| **File Upload** | | |
| Upload File (Multipart) | POST | `/api/spaces/:id/items/upload` |
| Send File by Path | POST | `/api/send-to-space` (with `filePath`) |
| **Space Files** | | |
| List Files | GET | `/api/spaces/:id/files` |
| Read File | GET | `/api/spaces/:id/files/:path` |
| Write File | PUT | `/api/spaces/:id/files/:path` |
| Delete File | DELETE | `/api/spaces/:id/files/:path` |
| **Git Version Control** | | |
| Git Commit Log | GET | `/api/spaces/:id/git-versions` |
| Create Git Commit | POST | `/api/spaces/:id/git-versions` |
| Git Diff | GET | `/api/spaces/:id/git-diff` |
| List Branches | GET | `/api/spaces/:id/git-branches` |
| Create Branch | POST | `/api/spaces/:id/git-branches` |
| Merge Branch | POST | `/api/spaces/:id/git-merge` |
| Working Tree Status | GET | `/api/spaces/:id/git-status` |
| List Tags | GET | `/api/spaces/:id/git-tags` |
| Create Tag | POST | `/api/spaces/:id/git-tags` |
| Revert Commit | POST | `/api/spaces/:id/git-revert` |
| **Migration** | | |
| Trigger v2-to-v3 Migration | POST | `/api/git/migration` |
| Check Migration Status | GET | `/api/git/migration` |

---

## Important Notes

### Known API Behaviors

| Endpoint | Behavior |
|----------|----------|
| `GET /api/spaces/:id/items/:itemId` | Always returns full content (no `includeContent` param needed) |
| `GET /api/spaces/:id/items?includeContent=true` | The `includeContent` param is only for listing multiple items |
| `POST /api/reload` | Forces index reload from disk - use when external processes modified storage |
| `GET /api/spaces/:id/metadata/versions` | Now returns Git commit history (hydrated to match legacy format) |
| `POST /api/spaces/:id/metadata/versions` | Now creates a Git commit instead of appending to metadata array |
| `GET /api/git/migration` | Returns `isV3: true` once migration is complete |

### Cache Behavior

The API maintains an in-memory cache for performance. The cache is automatically invalidated when:
- Items are deleted
- Items are moved between spaces
- Index is explicitly reloaded via `POST /api/reload`

If you experience stale data from external modifications, call `POST /api/reload` to refresh.

### Git Storage Behavior

- **Binary exclusion**: Images, video, audio, and other binary files are excluded from Git tracking via `.gitignore`. They are still stored on disk and served via the API, but not version-controlled.
- **Single repository**: All Spaces share one Git repository at `~/Documents/OR-Spaces/`. The `:spaceId` in Git endpoint paths is used to filter results, not to address separate repos.
- **Branch isolation**: AI agents and automation tools should create branches for proposed changes and merge them after review, rather than committing directly to `main`.
- **Commit frequency**: Commits are lightweight. It is fine to commit frequently -- after each meaningful change rather than batching.

---

1. **Localhost Only**: The API only accepts connections from `127.0.0.1` for security.

2. **App Must Be Running**: The OneReach app must be running for the API to be available.

3. **Content Size**: Large content (images, files) should be sent as file paths when possible, not base64.

4. **Rate Limiting**: There's no explicit rate limit, but avoid excessive requests.

5. **Atomic Operations**: All write operations are atomic - they either succeed completely or fail.

6. **Space ID "unclassified"**: Use `"unclassified"` as the default space ID if no specific space is needed.

7. **Migration Required**: Git endpoints return errors until the v2-to-v3 migration is complete. Check `GET /api/git/migration` before calling Git endpoints.

8. **Schema Version**: All metadata is now v3.0. The `_schema.storageEngine` field is set to `"git"`. Legacy fields (`events.versions`, `projectConfig.currentVersion`) have been removed.

9. **GSX Push**: Graph push endpoints require GSX to be initialized (happens automatically at app startup). Returns 503 if not ready.

10. **File Upload**: The multipart upload endpoint (`/api/spaces/:id/items/upload`) accepts files up to 100 MB. For larger files or files already on disk, use the `filePath` option on `POST /api/send-to-space` instead.

11. **Space Files API**: Direct file read/write operates on the space's storage directory. All paths are relative to the space root. Directory traversal is blocked.

---

## Best Practices

### Always Check Server Status First

Before making any API calls, verify the server is running and responsive:

```javascript
async function ensureConnected() {
  try {
    const response = await fetch('http://127.0.0.1:47291/api/status');
    if (!response.ok) throw new Error(`Status: ${response.status}`);
    const data = await response.json();
    return data.status === 'ok';
  } catch (error) {
    console.error('Spaces API not available:', error.message);
    return false;
  }
}
```

### Verify Spaces Before Using

Don't assume a space exists - always fetch the list first or handle 404 errors gracefully:

```javascript
async function getOrCreateSpace(spaceName) {
  // First, check if space exists
  const spaces = await fetch('http://127.0.0.1:47291/api/spaces')
    .then(r => r.json())
    .then(d => d.spaces);
  
  const existing = spaces.find(s => s.name === spaceName);
  if (existing) return existing.id;
  
  // Create if not found
  const response = await fetch('http://127.0.0.1:47291/api/spaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: spaceName })
  });
  const result = await response.json();
  return result.space.id;
}
```

### Handle Errors Gracefully

Always check response status and handle errors:

```javascript
async function safeApiCall(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  
  if (!response.ok) {
    // Log detailed error info for debugging
    console.error(`API Error [${response.status}]:`, data);
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  
  return data;
}
```

### Use the Correct Endpoint for Adding Items

The primary endpoint for adding content is `POST /api/send-to-space`, not `POST /api/spaces/:id/items`:

```javascript
// Correct - use send-to-space
await fetch('http://127.0.0.1:47291/api/send-to-space', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    spaceId: 'unclassified',
    type: 'text',
    content: 'My content'
  })
});
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Connection refused | Ensure OneReach app is running |
| "Space not found" | Use `/api/spaces` to list valid space IDs |
| Content not appearing | Check the response for error messages |
| Large file fails | Send file path instead of base64 content |
| Duplicate items | The API doesn't prevent duplicates - check before adding |
| 500 Internal Server Error | Check the main app console for detailed error logs |
| 404 Not Found on valid routes | Verify endpoint spelling; check app console for "Unmatched route" logs |
| Items not listing | Ensure spaceId exists; try `GET /api/spaces` first to verify |
| Git endpoint returns error | Run `GET /api/git/migration` to verify migration status; run `POST /api/git/migration` if not migrated |
| "Git not initialized" | The v2-to-v3 migration has not been run yet |
| Merge conflict (409) | Resolve conflicts manually or revert the merge; check the `details` field for the conflicting file |
| Binary files not in Git log | Binary files are excluded from Git tracking by design; they are still stored on disk |
| Version history looks different | Versions are now Git commits with `sha`, `message`, `author` fields instead of sequential numbers |
| GSX push returns 503 | GSX connection not initialized; ensure app started with valid credentials |
| File upload returns 413 | File exceeds 100 MB limit for multipart upload |
| Files API returns 403 | Path traversal attempt detected; use relative paths only, no `../` |
| File upload returns 400 | Ensure `Content-Type: multipart/form-data` header is set; include a `file` field |
| Search returns stale results | Rebuild the DuckDB index: `POST /api/database/rebuild` |
| Database status returns 503 | DuckDB not initialized; restart the app or wait for startup to complete |

### Debugging API Issues

If you're encountering errors, open the OneReach app's Developer Tools (View → Toggle Developer Tools) and check the **main process console** for detailed error messages. The server logs all unmatched routes with this format:

```
[SpacesAPI] Unmatched route: { pathname: '/api/...', method: 'GET', pathParts: [...] }
```

This helps identify if your request URL is malformed or if there's a routing issue.

---

## Data Sources API

Data sources are a special item type (`type: 'data-source'`) for storing connection configurations to external APIs, MCP servers, and web scraping targets. They live in any space and contain metadata describing how to connect, authenticate, and perform CRUD operations.

### Subtypes

- `api` - REST or GraphQL API endpoints
- `mcp` - Model Context Protocol servers (stdio, SSE, or streamable HTTP)
- `web-scraping` - HTML extraction targets with CSS selectors

### Auth Model

Data sources store auth **requirements** (type, header name, scopes, notes) but **never store actual secrets**. External agents must provide their own credentials when connecting.

### Discovery Endpoint

```http
GET /api/data-sources?sourceType=api&limit=50&offset=0
```

Returns all data sources across all spaces. Filterable by `sourceType`.

**Response:**
```json
{
  "items": [
    {
      "id": "ds-1234",
      "name": "OpenAI API",
      "spaceId": "my-project",
      "sourceType": "api",
      "connection": { "url": "https://api.openai.com/v1", "protocol": "rest", "method": "POST" },
      "auth": { "type": "bearer", "label": "OpenAI Key", "notes": "Get from platform.openai.com" },
      "operations": { "create": { "enabled": true, "endpoint": "/chat/completions", "method": "POST" } },
      "status": "active",
      "documentVisibility": "public"
    }
  ],
  "total": 1, "limit": 50, "offset": 0
}
```

### Get Single Data Source

```http
GET /api/data-sources/:itemId
```

### Get Description Document

```http
GET /api/data-sources/:itemId/document
```

Returns the Markdown description document and its visibility (public/private).

### Update Description Document

```http
PUT /api/data-sources/:itemId/document
Content-Type: application/json

{ "content": "# My API\nThis API provides...", "visibility": "public" }
```

### Get CRUD Operations

```http
GET /api/data-sources/:itemId/operations
```

Returns the base URL and configured CRUD operations for agent consumption.

### Test Connectivity

```http
POST /api/data-sources/:itemId/test
Content-Type: application/json

{ "credential": "sk-your-api-key-here" }
```

Tests the connection using the provided credential (not stored). Returns `success`, `statusCode`, and `responseTime`.

### Creating a Data Source via Items API

```http
POST /api/send-to-space
Content-Type: application/json

{
  "content": "{...dataSource JSON...}",
  "type": "data-source",
  "spaceId": "my-project",
  "metadata": {
    "dataSource": {
      "sourceType": "api",
      "connection": { "url": "https://api.example.com/v1", "protocol": "rest" },
      "auth": { "type": "bearer", "label": "Example Token", "notes": "Get from developer portal" },
      "operations": {
        "read": { "enabled": true, "endpoint": "/items/:id", "method": "GET" },
        "list": { "enabled": true, "endpoint": "/items", "method": "GET" }
      },
      "document": { "content": "# Example API", "visibility": "private" }
    }
  }
}
```

### Agent Workflow

1. Discover: `GET /api/data-sources?sourceType=api`
2. Get config: `GET /api/data-sources/:id`
3. Get operations: `GET /api/data-sources/:id/operations`
4. Read docs: `GET /api/data-sources/:id/document`
5. Connect to the actual data source using the config and your own credentials

---

## Support

For issues with the Spaces API:
1. Check the OneReach app console for error messages (View → Toggle Developer Tools)
2. Verify your request format matches the examples
3. Check the PUNCH-LIST.md for known issues

