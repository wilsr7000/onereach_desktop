# OneReach Module Packaging Guide for Claude

## Overview
You are helping to package a web application as a OneReach desktop module. OneReach modules are self-contained web apps that run in Electron windows with full Node.js access and Claude API integration.

## Module Requirements

### 1. Manifest File (manifest.json)
Every module MUST have a `manifest.json` file in the root directory:

```json
{
  "id": "unique-module-id",
  "name": "Module Display Name",
  "version": "1.0.0",
  "description": "Brief description of the module",
  "main": "index.html",
  "menuLabel": "Menu Item Label",
  "windowOptions": {
    "width": 1200,
    "height": 800,
    "minWidth": 800,
    "minHeight": 600
  },
  "dataDirectory": "module-data-folder-name"
}
```

### 2. File Structure
```
module-name/
├── manifest.json      (REQUIRED)
├── index.html         (or whatever is specified in manifest "main")
├── app.js            (your application logic)
├── styles.css        (your styles)
├── package.json      (if you need npm packages)
└── assets/           (images, icons, etc.)
```

## Data Storage Pattern

OneReach modules should ALWAYS use the provided data directory for persistent storage:

```javascript
// CORRECT - Use the module data directory
const fs = require('fs');
const path = require('path');

// This is automatically injected by OneReach
const dataPath = window.moduleDataPath;

// Save data
function saveData(data) {
    // Ensure directory exists
    if (!fs.existsSync(dataPath)) {
        fs.mkdirSync(dataPath, { recursive: true });
    }
    
    const filePath = path.join(dataPath, 'data.json');
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Load data
function loadData() {
    const filePath = path.join(dataPath, 'data.json');
    if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    return null;
}

// INCORRECT - Don't use these:
// ❌ localStorage - gets cleared
// ❌ indexedDB - not reliable across app updates  
// ❌ hardcoded paths like '/Users/...' 
// ❌ app directory - gets overwritten on updates
```

## Claude API Access

OneReach provides Claude API access through the `moduleAPI` object:

```javascript
// Check if Claude API is configured
async function checkClaude() {
    const isAvailable = await moduleAPI.claude.testConnection();
    if (!isAvailable) {
        alert('Please configure Claude API in the main app settings');
        return false;
    }
    return true;
}

// Simple text completion
async function generateText(prompt) {
    try {
        const response = await moduleAPI.claude.complete(prompt, {
            maxTokens: 500,
            temperature: 0.7
        });
        return response;
    } catch (error) {
        console.error('Claude error:', error);
        return null;
    }
}

// Chat conversation
let chatHistory = [];

async function sendMessage(userMessage) {
    chatHistory.push({ role: 'user', content: userMessage });
    
    try {
        const response = await moduleAPI.claude.chat(chatHistory, {
            maxTokens: 1000
        });
        
        chatHistory.push({ role: 'assistant', content: response });
        return response;
    } catch (error) {
        console.error('Chat error:', error);
        return 'Sorry, an error occurred.';
    }
}

// Analyze content
async function analyzeContent(content, instructions) {
    try {
        const analysis = await moduleAPI.claude.analyze(
            `${instructions}\n\nContent:\n${content}`,
            { maxTokens: 2000 }
        );
        return analysis;
    } catch (error) {
        console.error('Analysis error:', error);
        return null;
    }
}
```

## Converting Existing Web Apps

### 1. Update File Access
Replace any file operations with Node.js fs module:

```javascript
// Before (web app)
localStorage.setItem('data', JSON.stringify(data));

// After (OneReach module)
const fs = require('fs');
const path = require('path');
fs.writeFileSync(path.join(window.moduleDataPath, 'data.json'), JSON.stringify(data));
```

### 2. Update API Calls
If your app uses external APIs, you can continue using fetch() or use Node.js modules:

```javascript
// Both work in OneReach modules
const response = await fetch('https://api.example.com/data');

// Or use Node.js modules
const https = require('https');
```

### 3. Handle Module Lifecycle
Add initialization when the module loads:

```javascript
// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
    // Load saved data
    const savedData = loadData();
    if (savedData) {
        restoreAppState(savedData);
    }
    
    // Check Claude availability
    const hasClaudeAccess = await moduleAPI.claude.testConnection();
    updateUIBasedOnClaude(hasClaudeAccess);
});

// Save data before window closes
window.addEventListener('beforeunload', () => {
    const currentState = getAppState();
    saveData(currentState);
});
```

## Complete Example Structure

Here's a template for converting a web app:

**manifest.json:**
```json
{
  "id": "my-webapp",
  "name": "My Web App",
  "version": "1.0.0",
  "description": "My awesome web app as a OneReach module",
  "main": "index.html",
  "menuLabel": "My Web App",
  "windowOptions": {
    "width": 1200,
    "height": 800
  },
  "dataDirectory": "my-webapp-data"
}
```

**index.html:**
```html
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>My Web App</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <!-- Your existing HTML -->
    <div id="app">
        <!-- Your app content -->
    </div>
    
    <!-- Load your JavaScript -->
    <script src="app.js"></script>
</body>
</html>
```

**app.js:**
```javascript
// Node.js modules
const fs = require('fs');
const path = require('path');

// Data storage
const dataPath = window.moduleDataPath;

// Initialize app
async function initApp() {
    // Load saved data
    const savedData = loadData();
    
    // Check Claude API
    const claudeAvailable = await moduleAPI.claude.testConnection();
    
    // Your app initialization
    setupUI();
    if (savedData) {
        restoreState(savedData);
    }
    
    // Enable AI features if available
    if (claudeAvailable) {
        enableAIFeatures();
    }
}

// Data persistence
function saveData(data) {
    if (!fs.existsSync(dataPath)) {
        fs.mkdirSync(dataPath, { recursive: true });
    }
    fs.writeFileSync(
        path.join(dataPath, 'app-data.json'),
        JSON.stringify(data, null, 2)
    );
}

function loadData() {
    const filePath = path.join(dataPath, 'app-data.json');
    if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    return null;
}

// AI features using Claude
async function enhanceWithAI(text) {
    try {
        const enhanced = await moduleAPI.claude.complete(
            `Enhance this text: ${text}`,
            { maxTokens: 200 }
        );
        return enhanced;
    } catch (error) {
        console.error('AI enhancement failed:', error);
        return text; // Return original if AI fails
    }
}

// Start the app
document.addEventListener('DOMContentLoaded', initApp);

// Save state on exit
window.addEventListener('beforeunload', () => {
    const state = getCurrentState();
    saveData(state);
});
```

## Packaging Instructions

1. Create a directory with your module name
2. Add all files (manifest.json, HTML, JS, CSS, assets)
3. Create a ZIP file containing the directory
4. The ZIP structure should be:
   ```
   my-module.zip
   └── my-module/
       ├── manifest.json
       ├── index.html
       └── ... other files
   ```

## Common Pitfalls to Avoid

1. **Don't use localStorage/sessionStorage** - Use file system instead
2. **Don't hardcode paths** - Use `window.moduleDataPath`
3. **Don't assume Claude is available** - Always check with `testConnection()`
4. **Don't store sensitive data unencrypted** - Consider encryption for sensitive data
5. **Don't modify files outside moduleDataPath** - Stay in your sandbox

## Testing Your Module

Before packaging:
1. Ensure manifest.json is valid JSON
2. Test all file operations use moduleDataPath
3. Handle cases where Claude API might not be configured
4. Test window resizing with your windowOptions
5. Verify all assets are included and paths are relative

## Module Capabilities

Your module has access to:
- Full Node.js APIs (fs, path, crypto, etc.)
- Claude AI through moduleAPI
- Network requests (fetch, http/https modules)
- System information through moduleAPI.app
- File system within moduleDataPath
- All browser APIs

## Questions to Answer for Claude

When asking Claude to package your web app, provide:
1. Your current file structure
2. What data needs to be persisted
3. Whether you want AI features added
4. Your preferred window size
5. The menu label you want
6. Any npm packages you need

Claude can then help you:
- Create the manifest.json
- Update your code for file storage
- Add Claude AI integration
- Structure the module correctly
- Create the ZIP package

## Example Prompt for Claude

"I have a web app with these files: [list files]. It currently uses localStorage to save user preferences and todo items. I want to convert it to a OneReach module that uses Claude to help users write better todo descriptions. The app should be 1000x700 pixels and appear in the menu as 'Smart Todo List'. Can you help me convert it?" 