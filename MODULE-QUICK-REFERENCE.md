# OneReach Module Quick Reference

## Essential Code Snippets

### 1. Basic Module Setup
```javascript
// At the top of your main JS file
const fs = require('fs');
const path = require('path');
const dataPath = window.moduleDataPath;
```

### 2. Save/Load Data
```javascript
// Save any JSON-serializable data
function saveData(key, data) {
    if (!fs.existsSync(dataPath)) {
        fs.mkdirSync(dataPath, { recursive: true });
    }
    fs.writeFileSync(
        path.join(dataPath, `${key}.json`),
        JSON.stringify(data, null, 2)
    );
}

// Load saved data
function loadData(key) {
    const filePath = path.join(dataPath, `${key}.json`);
    if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    return null;
}
```

### 3. Claude API Quick Access
```javascript
// Quick AI text generation
async function aiGenerate(prompt) {
    try {
        return await moduleAPI.claude.complete(prompt);
    } catch (error) {
        console.error('AI Error:', error);
        return null;
    }
}

// Quick chat response
async function aiChat(messages) {
    try {
        return await moduleAPI.claude.chat(messages);
    } catch (error) {
        console.error('Chat Error:', error);
        return null;
    }
}
```

### 4. Initialize Module
```javascript
document.addEventListener('DOMContentLoaded', async () => {
    // Check Claude availability
    const hasAI = await moduleAPI.claude.testConnection();
    
    // Load saved state
    const savedState = loadData('app-state');
    
    // Initialize your app
    if (savedState) {
        restoreState(savedState);
    }
    
    // Enable/disable AI features
    toggleAIFeatures(hasAI);
});

// Auto-save on exit
window.addEventListener('beforeunload', () => {
    saveData('app-state', getCurrentState());
});
```

### 5. Error Handling Pattern
```javascript
async function safeAICall(fn) {
    try {
        const hasAI = await moduleAPI.claude.testConnection();
        if (!hasAI) {
            throw new Error('Claude API not configured');
        }
        return await fn();
    } catch (error) {
        console.error('AI operation failed:', error);
        // Fallback behavior
        return null;
    }
}

// Usage
const result = await safeAICall(async () => {
    return await moduleAPI.claude.complete('Generate a name');
});
```

## Manifest.json Template
```json
{
  "id": "your-module-id",
  "name": "Your Module Name",
  "version": "1.0.0",
  "description": "What your module does",
  "main": "index.html",
  "menuLabel": "Menu Label",
  "windowOptions": {
    "width": 1200,
    "height": 800,
    "minWidth": 600,
    "minHeight": 400
  },
  "dataDirectory": "your-module-data"
}
```

## File Organization
```
your-module/
├── manifest.json       # Required metadata
├── index.html         # Entry point
├── app.js            # Main logic
├── styles.css        # Styles
├── package.json      # NPM deps (optional)
└── assets/           # Images, etc.
```

## Available APIs

### moduleAPI.claude
- `.testConnection()` - Check if API is configured
- `.complete(prompt, options)` - Text completion
- `.chat(messages, options)` - Chat conversation
- `.generateMetadata(content, type)` - Generate metadata
- `.analyze(content, options)` - Analyze content

### moduleAPI.settings
- `.get(key)` - Get app setting (no API keys)
- `.hasApiKey(provider)` - Check if API key exists

### moduleAPI.app
- `.getVersion()` - App version
- `.getName()` - App name
- `.getPath(name)` - Get system path

## Common Options
```javascript
// Claude API options
{
    maxTokens: 1000,      // Max response length
    temperature: 0.7,     // Creativity (0-1)
    model: 'claude-3-haiku-20240307'  // Model selection
}
```

## Don'ts
- ❌ Don't use localStorage (use fs instead)
- ❌ Don't hardcode paths
- ❌ Don't assume Claude is always available
- ❌ Don't access files outside moduleDataPath
- ❌ Don't store unencrypted sensitive data

## Dos
- ✅ Always check Claude availability
- ✅ Handle errors gracefully
- ✅ Save state regularly
- ✅ Use relative paths for assets
- ✅ Test without Claude API configured 