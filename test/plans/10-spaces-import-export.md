# Spaces Import/Export Test Plan

## Prerequisites

- App running (`npm start`)
- Spaces API healthy on port 47291
- A test space created for upload/export operations
- GSX configured (for push/unpush tests)
- Browser extension installed (for tab capture tests)

## Features Documentation

Spaces support importing content via file upload, the send-to-space API, and browser extension tab capture. Export is handled by Smart Export (`smart-export.js`) which can generate content in 9 formats: PDF, DOCX, PPTX, XLSX, CSV, HTML, Markdown, TXT, and Web Slides. GSX integration allows pushing assets to the OmniGraph and pulling them back.

**Key files:** `spaces-api-server.js` (upload endpoints), `smart-export.js`, `clipboard-manager-v2-adapter.js`
**IPC namespace:** `smart-export:*`
**Upload endpoint:** `POST /api/spaces/:id/items/upload` (multipart)
**Send endpoint:** `POST /api/send-to-space`

## Checklist

### File Upload
- [ ] `[A]` Upload text file via multipart POST -- item created with correct type
- [ ] `[A]` Upload image file via multipart POST -- item created with `image` type
- [ ] `[A]` Upload PDF file via multipart POST -- item created with `pdf` fileType
- [ ] `[P]` Upload large file (>5MB) -- handled without timeout or crash

### Send to Space
- [ ] `[A]` `POST /api/send-to-space` with text content -- item appears in target space
- [ ] `[A]` `POST /api/send-to-space` with image URL -- item created as image type
- [ ] `[A]` Sending to non-existent space returns error

### Smart Export
- [ ] `[A]` `smart-export:get-formats` returns list of 9 supported formats
- [ ] `[P]` Export space as PDF -- file generated, non-empty
- [ ] `[P]` Export space as Markdown -- file generated with correct content
- [ ] `[M]` Export space as PPTX -- file opens in presentation software
- [ ] `[M]` Export space as XLSX -- file opens in spreadsheet software

### GSX Push/Unpush
- [ ] `[P]` `POST /api/spaces/:id/items/:itemId/push` pushes asset (requires GSX connection)
- [ ] `[P]` `GET /api/spaces/:id/items/:itemId/push-status` returns push status
- [ ] `[P]` `POST /api/spaces/:id/items/:itemId/unpush` removes from graph

## Automation Notes

- **Existing coverage:** Basic Spaces CRUD in `api-integration.spec.js`
- **Gaps:** File upload, send-to-space, smart export, GSX push/unpush
- **Spec file:** Create `test/e2e/spaces-import-export.spec.js`
- **Strategy:** Upload tests use `fetch` with `FormData`; export tests use IPC via `electronApp.evaluate`
- **Note:** GSX tests require active GSX connection -- may need to skip in CI
