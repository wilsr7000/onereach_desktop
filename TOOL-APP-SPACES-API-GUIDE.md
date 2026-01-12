# Tool App Spaces API Guide

This document explains how external tool applications can save content to and interact with the OneReach Spaces system via HTTP API.

---

## 🏗️ Architecture Overview

The OneReach app runs a local HTTP server that external tools can use to interact with Spaces:

```
┌─────────────────────┐
│   Your Tool App     │
│   (Any language)    │
└──────────┬──────────┘
           │ HTTP Requests
           ▼
┌─────────────────────┐
│  Spaces API Server  │
│  127.0.0.1:47291    │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  OR-Spaces Storage  │
│  ~/Documents/OR-Spaces/
└─────────────────────┘
```

**Base URL:** `http://127.0.0.1:47291`

**Note:** The server only accepts connections from localhost for security.

---

## 📡 API Endpoints

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

---

## 🗂️ Spaces CRUD Operations

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

## 📦 Items CRUD Operations

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

## 🏷️ Tags Operations

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

## 🔍 Search

### Search Across All Spaces
```http
GET /api/search?q=meeting+notes&spaceId=work-project&type=text&limit=20
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | string | Search query |
| `spaceId` | string | Limit to specific space |
| `type` | string | Filter by item type |
| `searchTags` | boolean | Also search in tags (default: true) |
| `limit` | number | Max results |

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
      "score": 0.95
    }
  ],
  "total": 5
}
```

---

## 📁 Smart Folders

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

## 🏷️ Metadata Operations

Metadata endpoints allow you to manage rich metadata for spaces, files, and assets.

### Get Space Metadata
```http
GET /api/spaces/:spaceId/metadata
```

**Response:**
```json
{
  "id": "my-project",
  "name": "My Project",
  "description": "Project description",
  "created": "2024-01-15T10:30:00Z",
  "modified": "2024-01-20T15:45:00Z",
  "assets": {
    "logo": { "path": "assets/logo.png", "type": "image" },
    "banner": { "path": "assets/banner.jpg", "type": "image" }
  },
  "projectConfig": {
    "type": "video-project",
    "settings": {}
  },
  "versions": [],
  "approvals": {}
}
```

### Update Space Metadata
```http
PUT /api/spaces/:spaceId/metadata
Content-Type: application/json

{
  "description": "Updated project description",
  "customField": "Custom value"
}
```

**Note:** This merges with existing metadata, not replaces.

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
```http
GET /api/spaces/:spaceId/metadata/versions
```

**Response:**
```json
{
  "versions": [
    {
      "version": "1.0.0",
      "date": "2024-01-15T10:30:00Z",
      "notes": "Initial release",
      "author": "user@example.com"
    },
    {
      "version": "1.1.0",
      "date": "2024-01-20T15:45:00Z",
      "notes": "Added new features",
      "author": "user@example.com"
    }
  ]
}
```

### Add Version
```http
POST /api/spaces/:spaceId/metadata/versions
Content-Type: application/json

{
  "version": "1.2.0",
  "notes": "Bug fixes and improvements",
  "author": "user@example.com"
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

## 💻 Code Examples

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

## 🔐 Error Handling

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
| `INVALID_SPACE_ID` | 400 | Space ID not found |
| `INVALID_ITEM_TYPE` | 400 | Unsupported content type |
| `EMPTY_CONTENT` | 400 | Content cannot be empty |
| `NOT_FOUND` | 404 | Resource not found |
| `SERVER_ERROR` | 500 | Internal server error |

**Example Error Response:**
```json
{
  "error": "Missing spaceId or content",
  "code": "MISSING_REQUIRED_FIELD"
}
```

---

## 🧪 Testing the Connection

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

## 📋 Quick Reference

| Operation | Method | Endpoint |
|-----------|--------|----------|
| Server Status | GET | `/api/status` |
| Force Reload Index | POST | `/api/reload` |
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
| Search Items | GET | `/api/search?q=...` |
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

---

## ⚠️ Important Notes

### Known API Behaviors

| Endpoint | Behavior |
|----------|----------|
| `GET /api/spaces/:id/items/:itemId` | Always returns full content (no `includeContent` param needed) |
| `GET /api/spaces/:id/items?includeContent=true` | The `includeContent` param is only for listing multiple items |
| `POST /api/reload` | Forces index reload from disk - use when external processes modified storage |

### Cache Behavior

The API maintains an in-memory cache for performance. The cache is automatically invalidated when:
- Items are deleted
- Items are moved between spaces
- Index is explicitly reloaded via `POST /api/reload`

If you experience stale data from external modifications, call `POST /api/reload` to refresh.

---

1. **Localhost Only**: The API only accepts connections from `127.0.0.1` for security.

2. **App Must Be Running**: The OneReach app must be running for the API to be available.

3. **Content Size**: Large content (images, files) should be sent as file paths when possible, not base64.

4. **Rate Limiting**: There's no explicit rate limit, but avoid excessive requests.

5. **Atomic Operations**: All write operations are atomic - they either succeed completely or fail.

6. **Space ID "unclassified"**: Use `"unclassified"` as the default space ID if no specific space is needed.

---

## 💡 Best Practices

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
// ✅ Correct - use send-to-space
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

## 🆘 Troubleshooting

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

### Debugging API Issues

If you're encountering errors, open the OneReach app's Developer Tools (View → Toggle Developer Tools) and check the **main process console** for detailed error messages. The server logs all unmatched routes with this format:

```
[SpacesAPI] Unmatched route: { pathname: '/api/...', method: 'GET', pathParts: [...] }
```

This helps identify if your request URL is malformed or if there's a routing issue.

---

## 📞 Support

For issues with the Spaces API:
1. Check the OneReach app console for error messages (View → Toggle Developer Tools)
2. Verify your request format matches the examples
3. Check the PUNCH-LIST.md for known issues

