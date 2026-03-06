# What's New in Onereach.ai

> Your AI-powered creative workstation for capturing, organizing, and creating.
> Version: 3.10.0 | January 2026

---

## Spaces: Your Content Hub

Spaces is where all your creative assets live - images, videos, code, conversations, and more. Think of it as an intelligent clipboard that remembers everything.

### Creating and Organizing Spaces

1. **Create a Space** - Click the + button or use `Cmd+N`
2. **Drag & Drop** - Drop files, images, URLs, or text directly into a Space
3. **Search** - Find anything instantly with full-text search

### Bulk Operations (New in v3.8.16)

Select and manage multiple items at once:

1. **Multi-Select** - Hover over items to see checkboxes, click to select
2. **Select All** - Use the toolbar button to select everything
3. **Bulk Delete** - Remove multiple items in one click
4. **Bulk Move** - Move selected items to another Space

### Upload from Spaces to AI Services (New in v3.8.14)

Share your Spaces content directly with ChatGPT, Claude, and other AI tools:

1. When an AI asks for a file upload, you'll see **"Choose from Spaces"**
2. Browse your Spaces and select the content
3. It's automatically uploaded to the AI conversation

This works in:
- ChatGPT file uploads
- Claude file attachments
- Any file picker dialog

---

## Capturing AI Conversations

Automatically save your conversations from external AI services to Spaces.

### Supported AI Services

| Service | Auto-Capture | Space Created |
|---------|--------------|---------------|
| ChatGPT | Yes | "ChatGPT Conversations" |
| Claude | Yes | "Claude Conversations" |
| Gemini | Yes | "Gemini Conversations" |
| Grok | Yes | "Grok Conversations" |
| Perplexity | Yes | "Perplexity Conversations" |

### How It Works

1. Open any external AI agent from the app
2. Have your conversation as normal
3. When you close the window, the conversation is automatically saved
4. Find it in the corresponding Space

### What Gets Captured

- Full conversation text (your prompts + AI responses)
- Timestamps
- Source URL
- Any code blocks or formatted content

---

## AI Creators: Generate Content

Access all the major AI creation tools from one place.

### Image Generators
- **Midjourney** - Artistic image generation
- **DALL-E** - OpenAI's image creator
- **Ideogram** - Text-in-image specialist
- **Leonardo AI** - Game art and illustrations

### Video Generators
- **Veo 3** - Google's video AI
- **Runway** - Professional video generation
- **Pika** - Quick video clips
- **Kling** - Motion and animation

### Audio Generators
- **ElevenLabs** - Voice synthesis
- **Suno** - Music creation
- **Udio** - Song generation

### UI Design Tools
- **Stitch** - AI design assistant
- **Figma AI** - Design automation

### How to Use

1. Go to **External AI Agents** in the sidebar
2. Click any AI service to open it
3. Create your content
4. Download or save to Spaces

---

## IDW Hub: Manage Digital Workers

Connect and manage your OneReach.ai Intelligent Digital Workers.

### Adding an IDW

1. Open **IDW Hub** from the sidebar
2. Click **Add IDW**
3. Enter the GSX link URL
4. Configure display name and environment

### IDW Features

- **Quick Access** - Launch any IDW with one click
- **Environment Switching** - Toggle between staging/production
- **Agent Explorer** - Browse available agent capabilities
- **Favorites** - Pin frequently used IDWs

### GSX Link Format

```
https://your-environment.onereach.ai/gsx?skill=skill-id
```

---

## Video Editor: AI-Powered Editing

Edit videos with intelligent features like automatic transcription and AI voice replacement.

### Smart Transcription

For YouTube videos and other content with existing captions:
- **Instant** - Extracts from existing data in < 1 second
- **Free** - No API costs for videos with captions

For other videos:
- Uses OpenAI Whisper for accurate transcription

### AI Voice Replacement (ElevenLabs)

Replace audio segments with AI-generated voice:

1. Mark IN and OUT points on your video
2. Click **Auto-Transcribe** to get the text
3. Click **Replace Audio with ElevenLabs**
4. Choose from 9 professional voices
5. New video created with AI voice

### Available Voices

| Voice | Type | Style |
|-------|------|-------|
| Rachel | Female | Calm, clear (default) |
| Bella | Female | Soft, warm |
| Domi | Female | Strong, confident |
| Josh | Male | Deep, authoritative |
| Adam | Male | Deep, rich |
| Sam | Male | Young, energetic |

**Setup:** Add your ElevenLabs API key in Settings

---

## Clipboard Manager

Never lose copied content again.

### Features

- **History** - Access everything you've copied
- **Source Tracking** - Know where content came from
- **Quick Paste** - Keyboard shortcuts for fast access
- **Space Integration** - Save clipboard items to Spaces

### Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Open Clipboard | `Cmd+Shift+V` |
| Save to Space | `Cmd+S` |
| Search History | `Cmd+F` |

---

## Smart Export

Export your Spaces content in various formats with AI-powered formatting.

### Export Formats

- **Markdown** - Clean, portable text
- **HTML** - Web-ready content
- **PDF** - Print-ready documents
- **Word** - Microsoft Word format
- **JSON** - Structured data

### Style Guide Import

Import a URL to match the writing style:

1. Click **Import Style Guide**
2. Paste a URL (blog post, article, documentation)
3. AI extracts the writing style
4. Your exports match that style

---

## GSX Create: AI Development Assistant

Build apps and agents with AI assistance.

### Features

- **Task Queue** - Queue up multiple tasks
- **7-Phase Workflow** - Plan → Research → Design → Code → Test → Review → Deploy
- **Real-time Updates** - See progress as work happens
- **Budget Tracking** - Monitor LLM costs

### Creating Custom Agents

1. Open **Agent Manager**
2. Click **Create Agent**
3. Define:
   - **Name** - What to call your agent
   - **Keywords** - Trigger words (e.g., "weather", "forecast")
   - **Prompt** - What your agent does
4. Enable and test

### Agent Types

| Type | Use For |
|------|---------|
| LLM | Conversational responses |
| AppleScript | Mac automation |
| Node.js | Code execution |

---

## Quick Tips

### Organizing Content

- Use **descriptive Space names** - "Project X Assets" not "Stuff"
- **Tag important items** - Makes searching easier
- **Archive old Spaces** - Keep your workspace clean

### Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| New Space | `Cmd+N` |
| Search | `Cmd+F` |
| Settings | `Cmd+,` |
| Quick Paste | `Cmd+Shift+V` |

### Getting Help

- **Help Agent** - Say "help" or "what can you do"
- **Documentation** - Check the docs folder
- **Settings** - Configure API keys and preferences

---

## Recent Updates

### v3.8.16
- Bulk delete and move for Spaces items

### v3.8.15
- Grok integration for conversation capture

### v3.8.14
- Upload from Spaces to ChatGPT/Claude
- Video Editor fixes for project loading
- YouTube download status improvements

### v3.8.13
- Clean, modern Spaces design
- New icon library (no more emoji clutter)

---

## Setup Checklist

1. [ ] Add OpenAI API key (Settings → API Keys)
2. [ ] Add ElevenLabs API key for voice features
3. [ ] Connect your IDWs in IDW Hub
4. [ ] Install browser extension for web capture
5. [ ] Set up your first Space

---

*For detailed setup guides, see the individual product documentation files.*
