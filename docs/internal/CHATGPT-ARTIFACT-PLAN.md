# ChatGPT Artifact Support - Implementation Plan

## Current Status
- ✅ ChatGPT is configured in AI_SERVICE_CONFIG
- ✅ ChatGPT conversations are being captured
- ❌ ChatGPT doesn't have "artifacts" like Claude's tool_use format
- ❌ Code blocks in ChatGPT responses are embedded as markdown, not separate artifacts

## ChatGPT Response Formats

### 1. Standard Code Blocks
ChatGPT returns code in markdown format:
```markdown
Here's a Python function:

\`\`\`python
def fibonacci(n):
    if n <= 1:
        return n
    return fibonacci(n-1) + fibonacci(n-2)
\`\`\`
```

### 2. Code Interpreter (ChatGPT Plus/Pro)
- ChatGPT can execute Python code
- Returns code + execution results
- May include generated files (images, data files)

### 3. DALL-E Image Generation
- Separate endpoint
- Returns image URLs
- Not handled as "artifacts"

## Implementation Approach

### Option A: Extract Code Blocks as Artifacts (Recommended)
**When**: After ChatGPT response is captured
**Where**: In `_saveConversation()` or new method `_extractCodeBlocksAsArtifacts()`
**How**:
1. Parse the response markdown for code blocks: `\`\`\`language\\ncode\\n\`\`\``
2. Extract each code block as a separate artifact
3. Detect language from the fence
4. Generate filename from context or use default
5. Save as separate items with proper file type/category

**Pros**:
- Works with existing ChatGPT responses
- No changes to network capture needed
- User can download code easily
- Consistent UX with Claude artifacts

**Cons**:
- Not "true" artifacts (just extracted code blocks)
- May extract code that's meant as examples, not outputs

### Option B: Wait for Code Interpreter Detection
**When**: Network capture detects Code Interpreter execution
**Where**: In `main.js` network monitoring
**How**:
1. Detect Code Interpreter API responses
2. Extract executed code and results
3. Save as artifacts with execution context

**Pros**:
- Only real "generated" code
- Can include execution results

**Cons**:
- More complex implementation
- Requires ChatGPT Plus/Pro
- Need to understand Code Interpreter API format

### Option C: Hybrid Approach
- Extract code blocks for standard ChatGPT
- Special handling for Code Interpreter outputs
- User preference to enable/disable code block extraction

## Recommendation: Option A (Code Block Extraction)

Since Claude artifacts are actual tool outputs, we should provide similar functionality for ChatGPT by **automatically extracting code blocks** from responses.

## Implementation Steps

1. **Add code block extraction to `_saveConversation()`**
   - After conversation markdown is formatted
   - Before saving to Spaces
   - Parse for fenced code blocks

2. **Create `_extractCodeBlocks()` method**
   ```javascript
   _extractCodeBlocks(messageText) {
     const codeBlocks = [];
     const regex = /```(\w+)?\n([\s\S]*?)```/g;
     let match;
     while ((match = regex.exec(messageText)) !== null) {
       codeBlocks.push({
         language: match[1] || 'text',
         code: match[2].trim(),
         startIndex: match.index
       });
     }
     return codeBlocks;
   }
   ```

3. **Convert to artifact format**
   - Generate filename based on language
   - Set appropriate fileType/fileCategory
   - Create metadata linking to conversation

4. **Use existing `_saveArtifacts()` method**
   - Reuse the same logic we built for Claude
   - Pass extracted code blocks as "artifacts"

## User Experience

### ChatGPT Conversation with Code
**Before**: Code embedded in conversation
**After**: 
- Conversation item with code preview + link
- Separate file items for each code block
- Can download/share code independently

### Settings
Add preference: "Auto-extract code blocks as files"
- Default: enabled for ChatGPT
- User can disable if they prefer inline only

## Next Steps
1. Implement code block extraction
2. Test with various ChatGPT responses
3. Add user preference
4. Update documentation
