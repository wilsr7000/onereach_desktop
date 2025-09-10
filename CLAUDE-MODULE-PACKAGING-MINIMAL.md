# Onereach Module - Minimal Guide

## Structure
```
module.zip: manifest.json + index.html + app.js
```

## manifest.json
```json
{
  "id": "module-id",
  "name": "Module Name",
  "version": "1.0.0",
  "description": "Description",
  "main": "index.html"
}
```

## index.html
```html
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Module</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' 'unsafe-eval' https: data: blob:">
</head>
<body>
    <div id="app"></div>
    <script src="app.js"></script>
</body>
</html>
```

## app.js (Storage + Claude API)
```javascript
const MODULE_ID = 'module-id';

// Storage
async function saveData(key, value) {
    const data = await window.api.invoke('module:read-data', MODULE_ID) || {};
    data[key] = value;
    await window.api.invoke('module:write-data', MODULE_ID, data);
}

async function loadData(key) {
    const data = await window.api.invoke('module:read-data', MODULE_ID) || {};
    return data[key];
}

// Claude API
async function askClaude(prompt) {
    const response = await window.claudeAPI.complete({
        prompt: prompt,
        max_tokens: 1000
    });
    return response.completion;
}

// Usage
await saveData('myKey', {data: 'value'});
const data = await loadData('myKey');
const answer = await askClaude('Question?');
```

## APIs Available
- `window.api.invoke('module:read-data', id)`
- `window.api.invoke('module:write-data', id, data)`
- `window.claudeAPI.complete({prompt, max_tokens})`
- `window.claudeAPI.chat({messages, max_tokens})`

## Key Rules
1. NO localStorage → Use saveData/loadData
2. Include CSP meta tag
3. Bundle all assets in ZIP
4. `zip -r module.zip manifest.json index.html app.js` 