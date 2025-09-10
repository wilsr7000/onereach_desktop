# Onereach Module Packaging Guide (Compact)

Convert any web app into a Onereach module. Modules run in Electron with full Node.js access.

## Quick Structure

```
my-module.zip
├── manifest.json (required)
├── index.html (required)
├── app.js (optional)
├── styles.css (optional)
└── other files...
```

## manifest.json Template

```json
{
  "id": "unique-module-id",
  "name": "Module Display Name",
  "version": "1.0.0",
  "description": "What this module does",
  "main": "index.html",
  "window": {
    "width": 1200,
    "height": 800,
    "resizable": true
  }
}
```

## index.html Template

```html
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Module Name</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' 'unsafe-eval' https: data: blob:">
    <style>
        body { 
            font-family: -apple-system, system-ui, sans-serif;
            margin: 0;
            padding: 20px;
            background: #1a1a1a;
            color: #e0e0e0;
        }
    </style>
</head>
<body>
    <div id="app">
        <!-- Your content here -->
    </div>
    <script src="app.js"></script>
</body>
</html>
```

## app.js Template with File Storage & Claude API

```javascript
// File storage (replaces localStorage)
const MODULE_ID = 'unique-module-id'; // Match manifest.json

async function saveData(key, value) {
    try {
        const data = await window.api.invoke('module:read-data', MODULE_ID) || {};
        data[key] = value;
        await window.api.invoke('module:write-data', MODULE_ID, data);
        return true;
    } catch (error) {
        console.error('Save error:', error);
        return false;
    }
}

async function loadData(key) {
    try {
        const data = await window.api.invoke('module:read-data', MODULE_ID) || {};
        return data[key];
    } catch (error) {
        console.error('Load error:', error);
        return null;
    }
}

// Claude API usage
async function askClaude(prompt) {
    try {
        const response = await window.claudeAPI.complete({
            prompt: prompt,
            max_tokens: 1000
        });
        return response.completion;
    } catch (error) {
        console.error('Claude API error:', error);
        return null;
    }
}

// Example: Save/load user preferences
async function savePreferences(prefs) {
    await saveData('preferences', prefs);
}

async function loadPreferences() {
    return await loadData('preferences') || { theme: 'dark' };
}

// Example: Use Claude for text analysis
async function analyzeText(text) {
    const prompt = `Analyze this text and provide a brief summary: ${text}`;
    const result = await askClaude(prompt);
    
    // Save analysis history
    const history = await loadData('analysisHistory') || [];
    history.push({
        text: text,
        analysis: result,
        timestamp: Date.now()
    });
    await saveData('analysisHistory', history);
    
    return result;
}

// Initialize app
async function init() {
    // Load saved data
    const prefs = await loadPreferences();
    console.log('Loaded preferences:', prefs);
    
    // Check Claude API
    if (window.claudeAPI) {
        console.log('Claude API available');
    }
}

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
```

## Available APIs

```javascript
// File Storage
await window.api.invoke('module:write-data', moduleId, data);
await window.api.invoke('module:read-data', moduleId);
await window.api.invoke('module:delete-data', moduleId);

// Claude API
await window.claudeAPI.complete({ prompt, max_tokens });
await window.claudeAPI.chat({ messages, max_tokens });
await window.claudeAPI.generateMetadata(content, contentType);
await window.claudeAPI.analyzeContent(content, analysisType);

// System
await window.api.invoke('get-app-version');
await window.api.invoke('open-external', url);
```

## Conversion Rules

1. Replace `localStorage` → File storage functions above
2. Add CSP meta tag to HTML
3. Keep all assets in the ZIP
4. Test with: `npm install && zip -r module.zip manifest.json index.html app.js`
5. No external CDNs - include libraries in ZIP

## Complete Example: Note Taking App

**manifest.json:**
```json
{
  "id": "smart-notes",
  "name": "Smart Notes",
  "version": "1.0.0",
  "description": "AI-powered note taking",
  "main": "index.html"
}
```

**index.html:**
```html
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Smart Notes</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' 'unsafe-eval'">
</head>
<body>
    <h1>Smart Notes</h1>
    <textarea id="noteInput" placeholder="Write a note..."></textarea>
    <button onclick="saveNote()">Save</button>
    <button onclick="summarizeNotes()">AI Summary</button>
    <div id="notes"></div>
    <script src="app.js"></script>
</body>
</html>
```

**app.js:**
```javascript
const MODULE_ID = 'smart-notes';

async function saveNote() {
    const input = document.getElementById('noteInput');
    const notes = await loadData('notes') || [];
    notes.push({
        text: input.value,
        timestamp: Date.now()
    });
    await saveData('notes', notes);
    input.value = '';
    displayNotes();
}

async function summarizeNotes() {
    const notes = await loadData('notes') || [];
    const allText = notes.map(n => n.text).join('\n');
    const summary = await window.claudeAPI.complete({
        prompt: `Summarize these notes:\n${allText}`,
        max_tokens: 500
    });
    alert(summary.completion);
}

async function displayNotes() {
    const notes = await loadData('notes') || [];
    document.getElementById('notes').innerHTML = notes
        .map(n => `<p>${n.text}</p>`)
        .join('');
}

// Storage functions
async function saveData(key, value) {
    const data = await window.api.invoke('module:read-data', MODULE_ID) || {};
    data[key] = value;
    await window.api.invoke('module:write-data', MODULE_ID, data);
}

async function loadData(key) {
    const data = await window.api.invoke('module:read-data', MODULE_ID) || {};
    return data[key];
}

displayNotes();
```

Package: `zip -r smart-notes.zip manifest.json index.html app.js` 