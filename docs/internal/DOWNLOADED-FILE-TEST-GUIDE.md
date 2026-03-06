# Test Guide - Downloaded File Artifacts

## Quick Test

### 1. Restart the App
```bash
# Quit completely and restart
npm start
```

### 2. Open Claude
- From app menu → Claude
- Wait for window to load

### 3. Ask Claude to Generate a Document
Try one of these prompts:

**Option A - Word Document**:
```
Create a Word document with a simple table showing Q1 sales data
```

**Option B - PDF**:
```
Create a PDF invoice with line items
```

**Option C - Excel**:
```
Create an Excel spreadsheet with sample employee data
```

### 4. Download the Generated File
- Claude will show the file preview
- Click the **download button** in Claude's UI
- File will download normally

### 5. Check Spaces Manager
Open Spaces Manager and verify you see **3 items**:

1. **Conversation** (text)
   - Shows the chat
   - Has 2 artifact links

2. **JavaScript Code** (file, code category)
   - The code that generates the document
   - Can view/download

3. **Generated Document** (file, document category)
   - The actual .docx/.pdf/.xlsx file
   - **Can download directly from Spaces**
   - Preview should work (if supported)

### 6. Verify Metadata

**Conversation Item**:
- Check metadata has: `artifactItemIds: ["code-id", "doc-id"]`

**Document Artifact**:
- Check metadata has:
  - `sourceType: "ai-artifact"`
  - `conversationItemId: "conv-id"`
  - `fileCategory: "document"`
  - `aiService: "Claude"`

## Expected Console Output

```
[Claude] Download detected: simple-document.docx
[Claude] 📦 Artifact download detected: simple-document.docx
[Claude] ✅ Artifact downloaded to temp: simple-document.docx
[ConversationCapture] captureDownloadedArtifact called for Claude: simple-document.docx
[ConversationCapture] Found conversation: Claude:abc-123
[ConversationCapture] Read file: 12345 bytes
[ConversationCapture] ✅ Captured downloaded artifact: simple-document.docx (12345 bytes)
[ConversationCapture] Saving 2 artifacts as separate items...
[ConversationCapture] Saving artifact: creating-a-simple-document.js
[ConversationCapture] ✅ Saved artifact as item {id1}
[ConversationCapture] Saving binary file: simple-document.docx (12345 bytes)
[ConversationCapture] ✅ Saved artifact as item {id2}
[ConversationCapture] Updated conversation with artifact references
```

## Troubleshooting

### Issue: No .docx item created
**Check**: Did you click the download button?
**Fix**: Must actually download the file for capture to trigger

### Issue: Only 2 items (conversation + code)
**Check**: Look for error in console: "Failed to capture downloaded artifact"
**Possible causes**:
- Temp file permissions issue
- File too large
- Download failed/cancelled

### Issue: Document shows as generic "file" not "document"
**Check**: Metadata should have `fileCategory: "document"`
**If missing**: Restart app with fresh code

### Issue: Can't open .docx from Spaces
**Check**: Is fileData present in metadata?
**Check**: Try downloading from Spaces Manager

## Test Different File Types

1. **Word**: `create a word doc with lorem ipsum`
2. **PDF**: `create a pdf with a simple diagram`
3. **Excel**: `create an xlsx with budget data`
4. **PowerPoint**: `create a pptx with 3 slides`
5. **HTML**: `create a standalone html page` (may be text, not download)

## Success Criteria

✅ Download triggers artifact capture
✅ File saved as base64 in Spaces
✅ Proper file extension and category
✅ Bidirectional metadata linking
✅ File downloadable from Spaces Manager
✅ Conversation shows link to document
✅ Temp file cleaned up after capture

## Notes

- Only works when user actually downloads the file
- If you don't click download, only code is captured
- Large files may take a moment to encode to base64
- Works for Claude only (ChatGPT has different artifact model)
