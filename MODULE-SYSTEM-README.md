# OneReach Module System

The OneReach desktop application now supports a modular architecture that allows you to extend its functionality by installing custom web app modules.

## Overview

Modules are self-contained web applications that run in separate windows and have full access to Node.js APIs and the file system. They can be distributed as ZIP files and installed via URL or local file.

## Module Structure

A module must have the following structure:

```
my-module/
├── manifest.json    (required)
├── index.html      (or main file specified in manifest)
├── main.js         (optional - for main process code)
├── preload.js      (optional - for preload scripts)
├── package.json    (optional - for npm dependencies)
├── icon.png        (optional - for menu/window icon)
└── ... other assets
```

### Manifest File

The `manifest.json` file defines the module configuration:

```json
{
  "id": "unique-module-id",
  "name": "Module Display Name",
  "version": "1.0.0",
  "description": "Module description",
  "main": "index.html",
  "mainProcess": "main.js",         // Optional: Main process script
  "preload": "preload.js",          // Optional: Preload script
  "icon": "icon.png",               // Optional: Icon file
  "menuLabel": "Menu Item Label",   // Label shown in Modules menu
  "windowOptions": {                // Optional: BrowserWindow options
    "width": 800,
    "height": 600,
    "resizable": true,
    "minimizable": true,
    "maximizable": true
  },
  "dataDirectory": "module-data"    // Directory name for module data storage
}
```

## Installing Modules

### From URL
1. Go to `Modules` menu → `Install Module from URL...`
2. Enter the URL of the module ZIP file
3. Click Install

### From Local File
1. Go to `Modules` menu → `Install Module from File...`
2. Select the module ZIP file
3. Click Open

## Module Development

### Basic Example

Here's a simple calculator module example:

**manifest.json:**
```json
{
  "id": "calculator",
  "name": "Calculator",
  "version": "1.0.0",
  "main": "index.html",
  "menuLabel": "Calculator",
  "windowOptions": {
    "width": 400,
    "height": 600
  }
}
```

**index.html:**
```html
<!DOCTYPE html>
<html>
<head>
    <title>Calculator</title>
</head>
<body>
    <h1>Simple Calculator</h1>
    <!-- Your calculator UI here -->
    
    <script>
        // You have full Node.js access
        const fs = require('fs');
        const path = require('path');
        
        // Access the module's data directory
        const { remote } = require('electron');
        const dataPath = remote.getCurrentWindow().moduleDataPath;
        
        // Save/load data as needed
        function saveData(data) {
            fs.writeFileSync(
                path.join(dataPath, 'data.json'), 
                JSON.stringify(data)
            );
        }
    </script>
</body>
</html>
```

### File System Access

Modules have full file system access through Node.js APIs:

```javascript
const fs = require('fs');
const path = require('path');

// Module's dedicated data directory
const dataPath = window.moduleDataPath;

// Read a file
const data = fs.readFileSync(path.join(dataPath, 'config.json'), 'utf8');

// Write a file
fs.writeFileSync(path.join(dataPath, 'output.txt'), 'Hello World');

// Create directories
fs.mkdirSync(path.join(dataPath, 'subdirectory'), { recursive: true });
```

### Claude API Access

Modules have access to the Claude API through the app's authentication system. The `moduleAPI` object is automatically injected into all module windows:

```javascript
// Check if Claude API is available
const isAvailable = await moduleAPI.claude.testConnection();

// Simple text completion
const response = await moduleAPI.claude.complete("Write a haiku about coding", {
    maxTokens: 100,
    temperature: 0.7
});

// Chat conversation
const messages = [
    { role: 'user', content: 'Hello!' },
    { role: 'assistant', content: 'Hi there! How can I help?' },
    { role: 'user', content: 'Tell me about JavaScript' }
];
const response = await moduleAPI.claude.chat(messages);

// Generate metadata (like clipboard manager)
const metadata = await moduleAPI.claude.generateMetadata(
    "function add(a, b) { return a + b; }",
    "code",
    "Focus on function purpose"
);

// Analyze logs or content
const analysis = await moduleAPI.claude.analyze(
    "Analyze these error logs: ...",
    { maxTokens: 1000 }
);

// Access other app services
const appVersion = await moduleAPI.app.getVersion();
const hasApiKey = await moduleAPI.settings.hasApiKey('anthropic');
```

**Note**: The Claude API key must be configured in the main application settings. Modules cannot access the API key directly for security reasons.

### Using NPM Packages

If your module needs npm packages:

1. Include a `package.json` in your module
2. The module manager will automatically run `npm install` during installation

**package.json:**
```json
{
  "name": "my-module",
  "version": "1.0.0",
  "dependencies": {
    "axios": "^1.6.0",
    "lodash": "^4.17.21"
  }
}
```

### Main Process Scripts

For advanced functionality, you can include main process scripts:

**main.js:**
```javascript
const { ipcMain } = require('electron');

// This runs in the main process when the module is loaded
console.log('Module main process script loaded');

// Set up IPC handlers for your module
ipcMain.handle('my-module:special-action', async (event, data) => {
    // Perform main process operations
    return { success: true, result: 'Done!' };
});
```

## Module Data Storage

Each module gets its own data directory at:
- macOS: `~/Library/Application Support/Onereach.ai/modules-data/{dataDirectory}/`
- Windows: `%APPDATA%/Onereach.ai/modules-data/{dataDirectory}/`
- Linux: `~/.config/Onereach.ai/modules-data/{dataDirectory}/`

The `dataDirectory` name is specified in your manifest.json.

## Module Lifecycle

1. **Installation**: Module is downloaded, extracted, and dependencies installed
2. **Menu Integration**: Module appears in the Modules menu
3. **Launch**: Clicking the menu item opens the module in a new window
4. **Data Persistence**: Module can read/write to its data directory
5. **Updates**: Re-install a module to update it
6. **Removal**: Use the module manager to uninstall modules

## Best Practices

1. **Unique IDs**: Use reverse domain notation (e.g., `com.example.mymodule`)
2. **Version Management**: Follow semantic versioning
3. **Error Handling**: Handle file system errors gracefully
4. **User Data**: Store user data in the provided data directory
5. **Performance**: Don't block the UI thread with heavy operations
6. **Security**: Validate user inputs and sanitize file paths

## Distribution

To distribute your module:

1. Create all module files in a directory
2. Ensure manifest.json is valid
3. Zip the directory (not its contents)
4. Host the ZIP file on a web server
5. Share the URL with users

## Example Modules

You can find example modules in the `example-module/` directory:
- Calculator: Simple calculator with history storage
- Note Taker: Text editor with file management
- Task Manager: Todo list with categories

## Troubleshooting

- **Module doesn't appear in menu**: Check manifest.json for errors
- **Module won't install**: Ensure ZIP structure is correct
- **Dependencies fail**: Check package.json syntax
- **File access errors**: Ensure you're using the correct data path

## Future Enhancements

Planned features for the module system:
- Module marketplace/registry
- Auto-updates for modules
- Inter-module communication
- Module permissions system
- Module UI templates 