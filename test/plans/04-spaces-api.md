# Spaces API Test Plan

## Prerequisites

- App running (`npm start`)
- Spaces API healthy (`curl http://127.0.0.1:47291/api/status`)
- No critical spaces that could be damaged by test CRUD operations

## Features Documentation

The Spaces API (`spaces-api-server.js`) runs on port 47291 and provides a REST interface for managing Spaces, items, tags, metadata, sharing, search, smart folders, file operations, and GSX graph integration. All responses are JSON. The API supports file uploads via multipart POST and has extensive search capabilities including deep search with filters.

**Key files:** `spaces-api-server.js`, `spaces-api.js`, `clipboard-storage-v2.js`
**Port:** 47291
**Base URL:** `http://127.0.0.1:47291`

## Checklist

### Server Health
- [ ] `[A]` `GET /api/status` returns 200 with version and database status
- [ ] `[A]` `GET /api/database/status` returns DuckDB index status

### Spaces CRUD
- [ ] `[A]` `POST /api/spaces` creates a new space, returns `{ success, space }`
- [ ] `[A]` `GET /api/spaces` lists all spaces as `{ spaces: [...] }`
- [ ] `[A]` `GET /api/spaces/:id` returns single space details
- [ ] `[A]` `PUT /api/spaces/:id` updates space name/description
- [ ] `[A]` `DELETE /api/spaces/:id` removes space, returns 200

### Items CRUD
- [ ] `[A]` `GET /api/spaces/:id/items` returns `{ items: [...], total }` 
- [ ] `[A]` `GET /api/spaces/:id/items/:itemId` returns single item
- [ ] `[A]` `PUT /api/spaces/:id/items/:itemId` updates item content/metadata
- [ ] `[A]` `DELETE /api/spaces/:id/items/:itemId` removes item
- [ ] `[A]` `POST /api/spaces/:id/items/:itemId/move` moves item to another space
- [ ] `[A]` `POST /api/spaces/:id/items/:itemId/pin` toggles pin status

### File Upload
- [ ] `[A]` `POST /api/spaces/:id/items/upload` accepts multipart file, returns created item
- [ ] `[A]` `POST /api/send-to-space` sends text content to a space

### Tags
- [ ] `[A]` `POST /api/spaces/:id/items/:itemId/tags` adds a tag
- [ ] `[A]` `GET /api/spaces/:id/items/:itemId/tags` returns item tags
- [ ] `[A]` `DELETE /api/spaces/:id/items/:itemId/tags/:tagName` removes a tag
- [ ] `[A]` `GET /api/spaces/:id/tags` lists all tags in a space
- [ ] `[A]` `GET /api/tags/search?tags=foo,bar` returns items matching tags

### Search
- [ ] `[A]` `GET /api/search?q=keyword` returns matching items
- [ ] `[A]` `GET /api/search?q=keyword&spaceId=X` scopes search to a space
- [ ] `[A]` `GET /api/search/suggestions?q=partial` returns suggestions
- [ ] `[P]` `POST /api/search/deep` with filters returns refined results

### Metadata
- [ ] `[A]` `GET /api/spaces/:id/metadata` returns space-level metadata
- [ ] `[A]` `PUT /api/spaces/:id/metadata` updates space metadata
- [ ] `[A]` `GET /api/spaces/:id/metadata/versions` returns version history
- [ ] `[A]` `POST /api/spaces/:id/metadata/versions` creates a new version entry

### Sharing
- [ ] `[P]` `POST /api/spaces/:id/share` shares space with email (requires valid email)
- [ ] `[A]` `GET /api/spaces/:id/share` lists shares for a space
- [ ] `[A]` `GET /api/shares` returns items shared with current user

### Smart Folders
- [ ] `[A]` `POST /api/smart-folders` creates smart folder with filter criteria
- [ ] `[A]` `GET /api/smart-folders` lists all smart folders
- [ ] `[A]` `GET /api/smart-folders/:id/items` returns items matching folder criteria
- [ ] `[A]` `DELETE /api/smart-folders/:id` removes smart folder

### Error Handling
- [ ] `[A]` Invalid space ID returns 400 or 404
- [ ] `[A]` Missing required fields return 400 with error message
- [ ] `[M]` Large payload (10MB+) handled gracefully

## Automation Notes

- **Existing coverage:** `test/e2e/api-integration.spec.js` (12 tests: health, logs, CRUD basics)
- **Gaps:** Tags, search, metadata, sharing, smart folders, file upload, error handling
- **Spec file:** Extend `api-integration.spec.js` or create `spaces-api-extended.spec.js`
- **Strategy:** All `[A]` items can be tested with `fetch()` calls -- no UI needed
