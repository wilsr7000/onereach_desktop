# AI Conversation Asset Type - Quick Start

## What's New?

AI conversations are now **first-class assets** in your Spaces! Like style-guides and journey-maps, conversations now have:

- 💬 **Special icon** for easy identification
- 📊 **Rich metadata** linking media to specific messages
- 🖼️ **Embedded image previews** in markdown
- 🔍 **Filterable** by conversation type
- 🗂️ **Dedicated Spaces** for each AI service

## How It Works

### 1. Automatic Capture
When you chat with any AI service (Claude, ChatGPT, Gemini, Perplexity, Grok), conversations are automatically captured and saved to dedicated Spaces:

- **"Claude Conversations"** 🤖 - All Claude chats
- **"ChatGPT Conversations"** 💬 - All ChatGPT chats
- **"Gemini Conversations"** 🔷 - All Gemini chats
- And so on...

### 2. View Conversations
Open the **Clipboard Viewer** (Spaces Manager):

1. Look for service-specific spaces (e.g., "Claude Conversations")
2. Conversations show with 💬 icon
3. Click to view with Claude-like formatting:
   - Role headers (👤 You, 🤖 Claude)
   - Timestamps for each message
   - Inline image previews
   - Full-resolution media links

### 3. Filter Conversations
In Clipboard Viewer:
- Click filter dropdown
- Select "chatbot-conversation"
- See only AI conversations across all services

### 4. Find Related Media
Every image or file attached to a conversation:
- Is saved as a separate full-resolution item
- Contains metadata linking it to the conversation
- Shows which message it belongs to
- Preserves attachment order

## Example Conversation View

```markdown
# 🤖 Conversation with Claude

**Started:** 1/17/2026, 12:14:47 PM
**Model:** claude-sonnet-4
**Exchanges:** 2

---

### 👤 You
*12:14:47 PM*

Can you analyze this screenshot?

---

### 🤖 Claude
*12:14:52 PM*

I can see the screenshot shows a dashboard with three key metrics...

![screenshot.png](spaces://abc123/img456)
📎 *Attachment:* [screenshot.png](spaces://abc123/img456) (full resolution)

---

<sub>Conversation ID: conv-1768680887314</sub>
<sub>Attachments: 1 image(s)</sub>
```

## Metadata Structure

### Conversation Metadata
Each conversation item includes:
- `conversationId` - Unique ID
- `aiService` - Which AI (Claude, ChatGPT, etc.)
- `model` - Model name (claude-sonnet-4, gpt-4, etc.)
- `startTime` - When conversation started
- `exchangeCount` - Number of back-and-forth exchanges
- `tags` - ["ai-conversation", "claude"]

### Media Metadata
Each attached image/file includes:
- `linkedToConversation` - Parent conversation ID
- `linkedToConversationItem` - Parent item ID in Space
- `aiService` - AI service name
- `messageIndex` - Which message (0, 1, 2...)
- `messageTimestamp` - Exact message time
- `attachmentOrder` - Order within message (0, 1, 2...)

## Advanced Features

### Query API
From developer console or IPC:

```javascript
// Get all media for a conversation
const media = await window.api.conversation.getMedia(spaceId, conversationId);

// Returns array of items with full metadata:
// [{ id, type, metadata: { linkedToConversation, messageIndex, ... } }]
```

### Space-Level Asset Tracking
Each Space tracks conversation assets:
- Total message count
- Total attachment count  
- Last updated time
- Model used

## Benefits

1. **Never lose a conversation** - All AI interactions automatically saved
2. **Context preserved** - Images linked to specific messages
3. **Easy retrieval** - Filter and search by service, date, or content
4. **Full resolution** - Both preview and full-quality media
5. **Organized** - Dedicated Space for each AI service
6. **Consistent** - Same system as other design assets

## Privacy Controls

All existing privacy features still work:
- ⏸️ **Pause** - Temporarily stop capture
- 🚫 **Don't Save This** - Mark specific conversation
- 🔒 **Private Mode** - Browser-level privacy
- ⏮️ **Undo** - 5-minute window to undo save
- 🗑️ **Delete** - Remove saved conversations anytime

## Tips

- **Conversations auto-save** after each AI response
- **Media is extracted** from all supported AI services
- **Conversations group** in service-specific Spaces
- **Filter by 💬** to see all conversations across services
- **Click links** for full-resolution media
- **Search works** - Find conversations by content

## Technical Details

For developers and power users:

- **Asset Type:** `chatbot-conversation`
- **Detection:** Looks for `messages[]` array + AI metadata
- **Storage:** Text item with embedded JSON + separate media items
- **Linking:** Media → Message → Conversation (full chain)
- **Icons:** Service-specific (🤖 Claude, 💬 ChatGPT, etc.)
- **Formats:** Markdown with embedded `spaces://` URLs

---

**The system is fully automatic - just chat with your AI and everything is saved!**
