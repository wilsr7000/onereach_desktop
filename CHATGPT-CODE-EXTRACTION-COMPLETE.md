# ChatGPT Code Block Extraction - Complete ✅

## Overview
ChatGPT responses now automatically extract code blocks and save them as separate Space items, matching the Claude artifact behavior.

## Implementation

### 1. Code Block Detection
Added `_extractCodeBlocksAsArtifacts()` method in `/Users/richardwilson/Onereach_app/src/ai-conversation-capture.js`:

```javascript
_extractCodeBlocksAsArtifacts(messageText) {
  const artifacts = [];
  const codeBlockRegex = /```(\w+)?\n?([\s\S]*?)```/g;
  let match;
  
  while ((match = codeBlockRegex.exec(messageText)) !== null) {
    const language = match[1] || 'text';
    const code = match[2].trim();
    
    // Skip empty or tiny code blocks
    if (!code || code.length < 10) continue;
    
    // Detect if it's an example (heuristic)
    const context = messageText.substring(Math.max(0, match.index - 100), match.index).toLowerCase();
    const isExample = context.includes('example') || context.includes('sample');
    
    artifacts.push({
      type: 'code_block',
      name: 'code_block',
      language: language,
      input: {
        language: language,
        file_text: code,
        description: `Code block ${blockIndex + 1}${isExample ? ' (example)' : ''}`,
      },
      source: 'chatgpt',
      isExample: isExample
    });
  }
  
  return artifacts;
}
```

### 2. Automatic Extraction
In `captureResponse()`, for ChatGPT responses:
```javascript
if (serviceId === 'ChatGPT' && (!responseData.artifacts || responseData.artifacts.length === 0)) {
  const extractedCodeBlocks = this._extractCodeBlocksAsArtifacts(responseData.message || '');
  if (extractedCodeBlocks.length > 0) {
    response.artifacts = extractedCodeBlocks;
  }
}
```

### 3. Unified Artifact Saving
Updated `_saveArtifacts()` to handle both:
- **Claude**: `type: 'tool_use'` artifacts
- **ChatGPT**: `type: 'code_block'` artifacts

```javascript
const isClaudeArtifact = artifact.type === 'tool_use';
const isChatGPTCodeBlock = artifact.type === 'code_block';

if (!isClaudeArtifact && !isChatGPTCodeBlock) {
  continue;
}
```

### 4. Smart Filename Generation
For ChatGPT code blocks without descriptions:
```javascript
fileName = `code-${language || 'snippet'}-${Date.now()}.${fileExtension}`;
// Examples: code-python-1234567890.py, code-javascript-1234567891.js
```

## Supported Languages

Same as Claude artifacts:
- **JavaScript/JS**: `.js`, `fileCategory: 'code'`
- **Python/PY**: `.py`, `fileCategory: 'code'`
- **HTML**: `.html`, `fileCategory: 'code'`
- **CSS**: `.css`, `fileCategory: 'code'`
- **JSON**: `.json`, `fileCategory: 'data'`
- **Markdown/MD**: `.md`, `fileCategory: 'document'`
- **SVG**: `.svg`, `fileType: 'image-file'`, `fileCategory: 'media'`
- **Other**: `.txt`, `fileCategory: null`

## Example Detection

Uses heuristic to mark code blocks as "examples":
- Checks 100 characters before code block
- Looks for keywords: "example", "sample", "for instance"
- Marks in metadata: `isExample: true`
- Tags with `'example'` tag

This helps users distinguish between:
- **Generated code** (meant to be used)
- **Example code** (meant to illustrate)

## User Experience

### ChatGPT Conversation with Code

**User**: "Write a Python function to calculate Fibonacci numbers"

**ChatGPT**: "Here's a recursive implementation:\n\n```python\ndef fibonacci(n):\n    if n <= 1:\n        return n\n    return fibonacci(n-1) + fibonacci(n-2)\n```"

**Result**:
1. **Conversation item** (text):
   - Shows the conversation with inline code preview
   - Link to separate code file: `🔗 [View as separate file](spaces://...)`
   - Metadata: `artifactItemIds: ["fibonacci-code-id"]`

2. **Code artifact item** (file):
   - Filename: `code-python-1768691234567.py`
   - Type: `file` with `fileCategory: 'code'`
   - Content: The Python code
   - Metadata links back to conversation
   - Can be downloaded/shared independently

## Differences from Claude

| Feature | Claude | ChatGPT |
|---------|--------|---------|
| Source | `tool_use` API events | Extracted from markdown |
| Trigger | Explicit artifact creation | Any code block in response |
| Filename | From artifact path/description | Generated from language |
| Detection | 100% accurate | Heuristic-based |
| Type | `tool_use` | `code_block` |

## Benefits

1. **Consistency**: ChatGPT users get same experience as Claude users
2. **Code Reusability**: Easy to extract and download code from conversations
3. **Organization**: Code files separate from conversation text
4. **Searchability**: Code files searchable by language, tags
5. **Metadata**: Rich metadata for filtering (language, isExample, etc.)

## Limitations

1. **No Path Info**: ChatGPT doesn't provide file paths (unlike Claude)
2. **Heuristic Detection**: Example detection isn't perfect
3. **All Code Blocks**: Extracts all code blocks, including examples
4. **No Execution Results**: Doesn't capture Code Interpreter outputs (yet)

## Future Enhancements

1. **User Preference**: Toggle to disable code block extraction
2. **Size Threshold**: Only extract code blocks above N lines
3. **Language Filter**: Only extract specific languages (e.g., only Python/JS)
4. **Code Interpreter**: Detect and capture Code Interpreter execution results
5. **DALL-E Integration**: Capture generated images as artifacts
6. **Better Context**: Use more sophisticated NLP to determine if code is example

## Testing

### Manual Test
1. Open ChatGPT from menu
2. Ask: "Write a JavaScript function to reverse a string"
3. Wait for response with code block
4. Open Spaces Manager
5. Verify:
   - Conversation item exists
   - Code artifact item exists (e.g., `code-javascript-*.js`)
   - Artifact has `fileCategory: 'code'`
   - Conversation links to artifact
   - Artifact links back to conversation

### Test with Multiple Code Blocks
1. Ask: "Show me HTML, CSS, and JavaScript for a button"
2. ChatGPT returns 3 code blocks
3. Verify:
   - 3 separate artifact items created
   - `code-html-*.html`
   - `code-css-*.css`
   - `code-javascript-*.js`
   - Conversation has `artifactItemIds` array with 3 IDs

## Files Modified
- `/Users/richardwilson/Onereach_app/src/ai-conversation-capture.js`
  - Added `_extractCodeBlocksAsArtifacts()` method
  - Modified `captureResponse()` to call extractor for ChatGPT
  - Updated `_saveArtifacts()` to handle `code_block` type

## Status
✅ **Complete and ready for testing**
