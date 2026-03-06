# Style Guide Dropdown Feature

## Overview
The style guide functionality has been redesigned from two separate buttons to a unified dropdown menu that provides:
- Quick access to saved style guides
- Ability to create new style guides
- Options to apply default or custom styles

## User Interface

### Dropdown Menu
Located in the smart export preview toolbar, the dropdown includes:
- **🎨 Select Style Guide** - Default placeholder text (shows count of saved guides)
- **📐 Default (Journey Map)** - Reverts to the default Journey Map style
- **👁️ View Style Guide** - Opens the style guide preview window
- **────────────────** - Visual separator
- **[Saved Style Guides]** - Dynamically populated list with icons:
  - 📝 = Manually created (pasted CSS)
  - 🌐 = Generated from URLs
- **➕ Add New Style...** - Opens modal to create new style guide

### Add Style Guide Modal
The modal provides two methods for creating style guides:

#### 1. Paste CSS Tab
- Direct CSS input textarea
- Supports CSS variables for flexibility
- Example placeholder showing proper format
- Immediate save and apply functionality

#### 2. Generate from URLs Tab
- Multiple URL input fields
- Options to extract:
  - Color palette
  - Typography
  - Spacing system
  - Component styles
- Live preview of analyzed styles
- Automatic CSS generation

## Features

### Style Guide Management
- Save custom style guides with descriptive names
- Persistent storage in user data directory
- Apply saved styles with one click
- Styles are embedded in exported documents

### CSS Generation
- Extracts design patterns from websites
- Creates CSS custom properties (variables)
- Generates component-specific styles
- Maintains consistency across exports

### Style Application
- Removes previous custom styles before applying new ones
- Updates both preview and source code views
- Embeds styles with consistent ID (`custom-style-guide`)
- Preserves portability of exported documents

## Technical Implementation

### Files Modified
1. `smart-export-preview.html`
   - Replaced two buttons with dropdown
   - Added unified modal for both paste and URL methods
   - Implemented tab switching functionality
   - Added style guide management functions

2. `preload.js`
   - Added `getStyleGuides()` API
   - Added `saveStyleGuide()` API
   - Added `deleteStyleGuide()` API

3. `main.js`
   - Added IPC handlers for style guide operations
   - Stores style guides in `userData/style-guides.json`
   - Handles file I/O for persistence

### Data Structure
```javascript
{
  "custom-1234567890": {
    "id": "custom-1234567890",
    "name": "Corporate Blue Theme",
    "css": "/* CSS content */",
    "type": "custom",
    "createdAt": "2024-01-01T00:00:00.000Z"
  },
  "generated-1234567891": {
    "id": "generated-1234567891",
    "name": "Apple.com Style",
    "css": "/* Generated CSS */",
    "type": "generated",
    "urls": ["https://apple.com"],
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

## Usage Workflow

### Creating a Style Guide by Pasting CSS
1. Click dropdown → "➕ Add New Style..."
2. Enter a name for the style guide
3. Stay on "📋 Paste CSS" tab
4. Paste your CSS code
5. Click "Save Style Guide"

### Creating a Style Guide from URLs
1. Click dropdown → "➕ Add New Style..."
2. Enter a name for the style guide
3. Switch to "🌐 Generate from URLs" tab
4. Enter one or more website URLs
5. Select style elements to extract
6. Click "Analyze & Save"

### Applying a Style Guide
1. Click the dropdown
2. Select a saved style guide
3. Styles are immediately applied to the current export

### Reverting to Default
1. Click the dropdown
2. Select "Default Style"
3. All custom styles are removed

## Benefits
- **Consistency**: Reuse styles across multiple exports
- **Efficiency**: No need to recreate styles each time
- **Flexibility**: Mix manual CSS with AI-generated styles
- **Organization**: Named style guides for different purposes
- **Portability**: Styles are embedded in exported documents 