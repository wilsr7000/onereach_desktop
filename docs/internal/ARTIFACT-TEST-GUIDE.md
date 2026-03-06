# Quick Test Guide - Artifact Separation

## How to Test

### 1. Restart the App
```bash
# Kill the current app and restart
npm start
```

### 2. Open Claude from Menu
- Click menu → Claude (or press hotkey)
- Wait for Claude window to load

### 3. Create an Artifact
Ask Claude to create something:

**Option A - Simple SVG**:
```
create a circle svg
```

**Option B - Multiple Files**:
```
create a simple HTML page with inline CSS
```

**Option C - Code**:
```
write a python function to calculate fibonacci numbers
```

### 4. Check Spaces Manager
Open Spaces Manager and look for:

1. **Conversation item**:
   - Should show clean conversation text
   - Should have artifact link like: `🔗 [View full artifact](spaces://...)`
   - NO embedded code blocks for artifacts

2. **Artifact item(s)**:
   - Separate item(s) for each artifact
   - Proper filename (e.g., `circle.svg`, `fibonacci.py`)
   - Click to view full content

### 5. Verify Metadata

**Conversation Item**:
- Metadata should include `artifactItemIds: ["id1", "id2", ...]`

**Artifact Item**:
- Metadata should include:
  - `sourceType: "ai-artifact"`
  - `conversationItemId: "parent-conv-id"`
  - `aiService: "Claude"`
  - `artifactName: "create_file"`

### 6. Check Console Logs
Look for these log messages:

```
✅ Saved artifact as item {item-id}
Saved {N} artifacts as separate items
Updated conversation with artifact references
```

## Expected Results

### ✅ Success Indicators
- Conversation shows artifact links (not full code)
- Artifacts saved as separate items
- Both items in same Space (Claude Conversations)
- Bidirectional metadata linking
- Proper file extensions on artifacts

### ❌ Failure Indicators
- Conversation still shows embedded code blocks
- No separate artifact items created
- Missing `artifactItemIds` in conversation metadata
- Artifacts saved in wrong space

## Common Issues

### Issue: Still showing embedded code
**Cause**: Using old cached code
**Fix**: Hard restart app (quit completely, then `npm start`)

### Issue: No artifact items created
**Cause**: `_saveArtifacts` might have failed silently
**Fix**: Check console for error messages starting with `[ConversationCapture] Failed to save artifact`

### Issue: Artifacts in wrong space
**Cause**: Space ID mismatch
**Fix**: Check that artifacts use same `spaceId` as conversation

## Debug Commands

### Check a specific conversation
Open Spaces Manager, find conversation item, view raw metadata:
- Should see `artifactItemIds: [...]`

### Check an artifact
Find artifact item, view raw metadata:
- Should see `conversationItemId`, `sourceType`, etc.

### View terminal logs
Look for detailed logs:
```
[ConversationCapture] Saving artifact: {filename}
[ConversationCapture] ✅ Saved artifact as item {id}
```

## Test Different Artifact Types

1. **SVG**: `create a star svg`
2. **JavaScript**: `write a JS function to sort arrays`
3. **Python**: `write a python class for a todo list`
4. **HTML**: `create a simple HTML form`
5. **CSS**: `write CSS for a card component`
6. **JSON**: `create a JSON config file example`

Each should save with proper extension and be viewable separately!
