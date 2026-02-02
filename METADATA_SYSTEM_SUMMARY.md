# Specialized Metadata System - Summary

## ✅ What Was Built

### NEW: **9 Specialized Metadata Handlers**

Each asset type now has its own AI prompt and processing logic:

1. 📸 **Images** - Vision analysis, text extraction, app detection
2. 🎬 **Videos** - Thumbnail + transcript analysis, speaker identification
3. 🎵 **Audio** - Transcript processing, speaker detection, topic extraction
4. 💻 **Code** - Language detection, function extraction, dependency analysis
5. 📄 **PDFs** - Document type identification, subject analysis
6. 📊 **Data Files** - Schema analysis, entity extraction
7. 📝 **Text** - Content type detection, action item extraction
8. 🌐 **URLs** - Platform identification, resource categorization
9. 🗂️ **HTML** - Document structure analysis, section extraction

---

## Key Improvements

### 1. **Space Context Integration** 🧠

**Before:**
```
Prompt: "Analyze this image"
```

**After:**
```
Prompt: "Analyze this image for the 'Web Development' Space
        (Purpose: Frontend development)
        Space tags: react, css, ui
        
        How does this relate to Frontend development?"
```

**Result:** AI understands project context and generates better metadata!

### 2. **Type-Specific Prompts** 🎯

**Each type gets targeted questions:**

**Code:**
- What does this code do?
- What language/framework?
- What functions/classes?
- How complex?

**Video:**
- What's the topic?
- Who are the speakers?
- What are the key points?
- What's the format (tutorial/interview)?

**PDF:**
- What type of document?
- What's the subject?
- What's the purpose?

### 3. **Richer Metadata Fields** 📊

**Type-specific fields:**

**Videos get:**
- `shortDescription`, `longDescription`
- `speakers`, `keyPoints`
- `targetAudience`
- `category` (tutorial|interview|presentation)

**Code gets:**
- `language`, `functions`
- `dependencies`, `complexity`
- `purpose`

**PDFs get:**
- `documentType`, `subject`
- `category`, `purpose`

---

## How It Works

### Flow Diagram

```
Item Captured
  ↓
Get Space Context
  ├─ Space name
  ├─ Space purpose
  ├─ Space tags
  └─ Project type
  ↓
Determine Asset Type
  ↓
Route to Specialized Handler
  ├─ Image → generateImageMetadata()
  ├─ Video → generateVideoMetadata()
  ├─ Audio → generateAudioMetadata()
  ├─ Code → generateTextMetadata(code)
  ├─ PDF → generatePdfMetadata()
  ├─ Data → generateDataMetadata()
  ├─ HTML → generateHtmlMetadata()
  ├─ URL → generateUrlMetadata()
  └─ File → generateFileMetadata()
  ↓
Build Specialized Prompt
  ├─ Type-specific questions
  ├─ Space context included
  └─ Relevant analysis requirements
  ↓
Call Claude API
  ↓
Parse JSON Response
  ↓
Save Metadata
  ↓
✅ Done!
```

---

## Code Organization

### metadata-generator.js (NEW)
```javascript
class MetadataGenerator {
  // Space context
  getSpaceContext(spaceId)
  
  // Specialized handlers (9 types)
  generateImageMetadata(item, imageData, apiKey, spaceContext)
  generateVideoMetadata(item, thumbnail, apiKey, spaceContext)
  generateAudioMetadata(item, apiKey, spaceContext)
  generateTextMetadata(item, apiKey, spaceContext)  // Code & text
  generateHtmlMetadata(item, apiKey, spaceContext)
  generatePdfMetadata(item, thumbnail, apiKey, spaceContext)
  generateDataMetadata(item, apiKey, spaceContext)
  generateUrlMetadata(item, apiKey, spaceContext)
  generateFileMetadata(item, apiKey, spaceContext)
  
  // Prompt builders (9 types)
  buildImagePrompt(item, spaceContext)
  buildVideoPrompt(item, spaceContext)
  // ... etc for each type
  
  // Main router
  generateMetadataForItem(itemId, apiKey, customPrompt)
  
  // Helpers
  getImageData(item)
  extractMediaType(dataUrl)
  extractBase64(dataUrl)
  callClaude(messageContent, apiKey)
}
```

---

## Usage Examples

### Auto-Generation (On Capture)

```javascript
// User copies screenshot
→ Clipboard captures it
→ Saves to "Design Work" Space
→ Gets Space context: {name: "Design Work", purpose: "UI mockups"}
→ Detects type: screenshot/image
→ Calls: generateImageMetadata(item, imageData, apiKey, spaceContext)
→ Builds specialized image prompt with Space context
→ Claude analyzes with context awareness
→ Returns rich metadata with UI-specific tags
→ Saves and notifies user
```

### Manual Generation (Button)

```javascript
// User clicks "✨ Generate AI Metadata" on a code snippet
→ Gets item from storage
→ Gets Space context: {name: "API Project", projectType: "Node.js"}
→ Detects type: code
→ Calls: generateTextMetadata(item, apiKey, spaceContext)
→ Builds code-specific prompt mentioning Node.js project
→ Claude analyzes as code in context of Node.js API
→ Returns: language, functions, dependencies, complexity
→ UI updates with rich code metadata
```

---

## Benefits Summary

### For Users 👤
- ✅ Better titles on all items
- ✅ More accurate categorization
- ✅ Richer, more useful metadata
- ✅ Context-aware tags
- ✅ Easier to find items later

### For Organization 📁
- ✅ Items properly categorized
- ✅ Space-relevant tagging
- ✅ Project context preserved
- ✅ Better search results

### For AI Quality 🤖
- ✅ Type-specific analysis
- ✅ Context-aware prompts
- ✅ Better field extraction
- ✅ More accurate results

---

## Files Created/Modified

### NEW Files (1)
1. **metadata-generator.js** - 800+ lines
   - Complete specialized system
   - 9 asset handlers
   - Space context integration

### Modified Files (1)
2. **clipboard-manager-v2-adapter.js**
   - Integrated new system (3 locations)
   - Replaced old generateAIMetadata calls

### Documentation (1)
3. **SPECIALIZED_METADATA_SYSTEM.md**
   - Complete guide
   - Examples for each type
   - Prompt samples

---

## Testing Checklist

### Per Asset Type:

**Images:**
- [ ] Screenshot → Detailed analysis with app name
- [ ] Check Space context is mentioned in metadata

**Videos:**
- [ ] YouTube video → Speakers and topics extracted
- [ ] Space context influences categorization

**Audio:**
- [ ] Podcast → Topics and speakers identified
- [ ] Space tags incorporated

**Code:**
- [ ] JavaScript → Functions and dependencies found
- [ ] Project type context used

**Text:**
- [ ] Notes → Action items extracted
- [ ] Space purpose guides analysis

---

## API Costs

**Same as before:** ~$0.01 per item
**But:** Better quality metadata for same cost!

---

## Status

✅ **COMPLETE - READY FOR TESTING**

**Confidence:** 95%+

**Next:**
1. Rebuild app
2. Test with different asset types
3. Verify Space context is working
4. Check metadata quality

---

## Rebuild Command

```bash
cd /Users/richardwilson/Onereach_app
npm run package:mac
open dist/mac-arm64/Onereach.ai.app
```

**Each asset type now gets specialized, context-aware metadata!** 🎉
