# Spaces Upload - Quick Start

## What Is It?

Upload files from your Spaces directly into ChatGPT, Claude, and any file picker - without saving to desktop first.

## How to Use

### In ChatGPT or Claude

1. Click the upload/attachment button
2. Look for the purple "📦 Spaces" button
3. Click it to open the Spaces picker
4. Browse your Spaces, select files
5. Click "Select" - files appear in the chat
6. Send your message as normal

### In Native File Pickers (GSX Create, etc.)

1. When you see a file picker dialog
2. You'll first see: "Choose from Computer" or "Choose from Spaces"
3. Click "Choose from Spaces"
4. Select files from the picker
5. Files are returned to the app

## Spaces Picker Features

- **Browse all Spaces** - Sidebar shows all your Spaces with item counts
- **Filter by type** - All, Files, Images, Text, Code
- **Search** - Find files quickly by name
- **Multi-select** - Click multiple items to upload several at once
- **Keyboard shortcuts**:
  - `Enter` - Select files
  - `Escape` - Cancel

## Settings

**Location**: Settings → General Settings  
**Toggle**: "Spaces Upload Integration"  
**Default**: Enabled

To disable:
1. Open Settings
2. Scroll to "General Settings"
3. Turn OFF "Spaces Upload Integration"
4. Save

When disabled, you'll see normal file pickers without the Spaces option.

## Supported Locations

### ✅ Works Great
- ChatGPT (chatgpt.com)
- Claude (claude.ai)
- GSX Create folder selection
- Most web forms (Google Drive, Dropbox, etc.)
- Native Electron file pickers

### ⚠️ May Not Work
- Sites with custom file pickers
- Drag-and-drop only uploads
- Sites using shadow DOM exclusively

## File Types

**All Spaces item types supported**:
- **Files** - PDFs, videos, documents (uploaded directly)
- **Text** - Notes, markdown (exported as .txt/.md)
- **Code** - Scripts, snippets (exported with proper extension)
- **Images** - Screenshots, photos (exported as image files)
- **HTML** - Web clippings (exported as .html)

## Tips

1. **Multi-select** - Click multiple items before clicking "Select"
2. **Search quickly** - Use the search box to filter hundreds of items
3. **Organize first** - Keep relevant files in dedicated Spaces for easy access
4. **Recent items** - New items appear first in the grid

## Troubleshooting

**Button doesn't appear**:
- Check if feature is enabled in Settings
- Try reloading the page
- Some sites may not show the button

**Files don't upload**:
- Check browser console for errors
- Try using "Choose from Computer" instead
- Report the specific website if it consistently fails

**Picker is empty**:
- Verify you have items in your Spaces
- Open Clipboard Viewer to confirm Spaces are working
- Try restarting the app

## Disable Instructions

Don't want this feature? Turn it off in Settings → General Settings → Spaces Upload Integration

The dialog also reminds you how to disable it each time it appears.
