# App Context Capture Feature

## Overview
The clipboard manager now captures context about which application you copied content from, providing valuable metadata about the source of your clipboard items.

## What Gets Captured

When you copy content, the system captures:

### 1. **Application Information**
- Application name (e.g., "Safari", "Visual Studio Code", "Slack")
- Bundle identifier (e.g., "com.apple.Safari")
- Timestamp of when the content was copied

### 2. **Window Context**
- Window title
- For browsers: Current URL and domain
- Enhanced source detection based on the app

### 3. **Smart Source Detection**
The system intelligently categorizes content based on the source application:

- **Code Editors**: `vscode`, `sublime`, `xcode`, `intellij`, `webstorm`
- **Browsers**: `browser-safari`, `browser-chrome`, `browser-firefox`, `browser-arc`
- **Communication**: `slack`, `discord`, `messages`, `mail`
- **Note-taking**: `notes`, `notion`, `obsidian`
- **Design Tools**: `figma`, `sketch`, `photoshop`, `illustrator`
- **Office Apps**: `word`, `excel`, `pages`, `numbers`, `keynote`
- **Terminal**: `terminal`, `iterm`

For browsers, it also captures the domain (e.g., `web-github-com`).

## How It Works

### Technical Implementation

1. **AppleScript Integration**: Uses macOS System Events to get the frontmost application
2. **Context Capture**: When content is added to clipboard, captures full context
3. **Metadata Storage**: Stores context in item metadata
4. **Display**: Shows source app in the Work Space Knowledge Manager UI

### Example Context Object
```javascript
{
  app: {
    name: "Google Chrome",
    bundleId: "com.google.Chrome",
    timestamp: 1703123456789
  },
  window: {
    windowTitle: "GitHub - microsoft/vscode",
    url: "https://github.com/microsoft/vscode",
    domain: "github.com"
  }
}
```

## User Benefits

### 1. **Better Organization**
- Quickly identify where content came from
- Filter items by source application
- Understand context when reviewing old clips

### 2. **Enhanced Search**
- Search for items from specific apps
- Find all code snippets from VS Code
- Locate all links from Safari

### 3. **Workflow Insights**
- See which apps you copy from most
- Track your workflow patterns
- Identify frequently used sources

## Privacy & Security

- Context capture is local only
- No data is sent to external servers
- Application names are captured, not content
- URLs are only captured from browsers, not other apps

## UI Display

### In List View
- Small badge shows "from [App Name]"
- Hover to see full context (window title, URL if applicable)
- Subtle styling to not distract from content

### In Metadata Modal
- Full context display in system information section
- Shows app name, window title, and domain if available

## Future Enhancements

### Planned Features
1. **Filter by App**: Add filter buttons for common apps
2. **App Icons**: Show app icons instead of text
3. **Statistics**: Show most used apps in a dashboard
4. **Smart Suggestions**: Suggest spaces based on app context
5. **Automation**: Auto-organize items based on source app

### Potential Integrations
- Link back to source document in supported apps
- Open original file/URL from clipboard item
- Sync with app-specific tags or categories

## Troubleshooting

### Context Not Captured
- Ensure app has Accessibility permissions
- Some apps may block AppleScript access
- System apps have better support than third-party apps

### Performance
- Context capture adds ~50-100ms to clipboard operations
- Cached for repeated copies from same app
- Async operation doesn't block clipboard

## Technical Details

### Files Modified
1. `app-context-capture.js` - Core context capture module
2. `clipboard-manager-v2-adapter.js` - Integration with clipboard manager
3. `clipboard-viewer.js` - UI display logic
4. `clipboard-viewer.html` - UI styling

### API Methods
- `getActiveApplication()` - Get frontmost app
- `getWindowContext()` - Get window details
- `getFullContext()` - Get complete context
- `enhanceSourceDetection()` - Smart source categorization

## Examples

### Code from VS Code
```
Source: Visual Studio Code
Window: "index.js — my-project"
Category: vscode
```

### Link from Safari
```
Source: Safari
Window: "Apple Developer Documentation"
URL: https://developer.apple.com/documentation/
Category: web-developer-apple-com
```

### Design from Figma
```
Source: Figma
Window: "Mobile App Design - Components"
Category: figma
``` 