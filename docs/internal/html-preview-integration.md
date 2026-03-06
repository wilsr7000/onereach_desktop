# HTML Preview Integration Guide

This guide shows how to integrate both thumbnail generation and live preview for HTML content in the spaces manager.

## System Overview

The HTML preview system provides:
1. **Visual thumbnails** - Generated using Chrome headless or SVG fallback
2. **Interactive preview** - Live iframe rendering on demand
3. **Multiple viewing options** - Inline, modal, or external browser

## Implementation Steps

### 1. Add to Clipboard Manager (Main Process)

In `clipboard-manager.js`, add the HTML preview system:

```javascript
// At the top of the file
const { HTMLPreviewSystem } = require('./html-preview-system');

// In the constructor
constructor() {
    // ... existing code ...
    this.htmlPreviewSystem = new HTMLPreviewSystem();
}

// Modify addToHistory method to generate thumbnails for HTML
async addToHistory(item) {
    // ... existing code ...
    
    // Generate thumbnail for HTML content
    if (item.type === 'html' && !item.thumbnail) {
        try {
            item.thumbnail = await this.htmlPreviewSystem.generateHTMLThumbnail(item);
        } catch (error) {
            console.error('Error generating HTML thumbnail:', error);
            // Will use fallback SVG
        }
    }
    
    // ... rest of existing code ...
}

// Add IPC handler for thumbnail generation
ipcMain.handle('clipboard:generate-html-thumbnail', async (event, item) => {
    try {
        return await this.htmlPreviewSystem.generateHTMLThumbnail(item);
    } catch (error) {
        console.error('Error generating thumbnail:', error);
        return null;
    }
});
```

### 2. Update Clipboard Viewer (Renderer Process)

In `clipboard-viewer.js`, integrate the HTML rendering:

```javascript
// At the top after other globals
let currentHistoryItems = []; // Store for preview access

// In renderHistory function, save items
function renderHistory(items = history) {
    currentHistoryItems = items; // Save for preview access
    
    // ... existing rendering code ...
    
    historyList.innerHTML = items.map(item => {
        let contentHtml = '';
        
        // ... existing type checks ...
        
        // Enhanced HTML rendering
        if (item.type === 'html' || 
            (item.metadata && item.metadata.type === 'generated-document')) {
            
            // Use the new HTML preview renderer
            contentHtml = renderHTMLItemWithPreview(item);
        }
        
        // ... rest of rendering ...
    }).join('');
}

// Add the HTML item renderer
function renderHTMLItemWithPreview(item) {
    const thumbnail = item.thumbnail || '';
    const title = item.metadata?.title || item.text || 'HTML Document';
    const hasContent = !!(item.content || item.html);
    
    return `
        <div class="html-item-wrapper">
            <div class="html-thumbnail-container">
                ${thumbnail ? 
                    `<img src="${thumbnail}" class="html-thumbnail" alt="Preview" />` :
                    `<div class="html-placeholder">
                        <span>🌐</span>
                        <span>HTML</span>
                    </div>`
                }
            </div>
            <div class="html-info">
                <div class="html-title">${escapeHtml(title)}</div>
                ${hasContent ? 
                    `<button class="preview-toggle" onclick="toggleHTMLPreview('${item.id}')">
                        👁 Preview
                    </button>` : 
                    ''
                }
            </div>
            <div class="html-preview-frame" id="preview-${item.id}" style="display: none;">
                <div class="preview-controls">
                    <button onclick="openInModal('${item.id}')">⛶</button>
                    <button onclick="closePreview('${item.id}')">✕</button>
                </div>
                <iframe class="preview-iframe" id="iframe-${item.id}"></iframe>
            </div>
        </div>
    `;
}

// Preview control functions
function toggleHTMLPreview(itemId) {
    const preview = document.getElementById(`preview-${itemId}`);
    const iframe = document.getElementById(`iframe-${itemId}`);
    const item = currentHistoryItems.find(i => i.id === itemId);
    
    if (!preview || !item) return;
    
    if (preview.style.display === 'none') {
        preview.style.display = 'block';
        
        // Load content if not already loaded
        if (!iframe.srcdoc) {
            iframe.srcdoc = item.content || item.html || '';
        }
    } else {
        preview.style.display = 'none';
    }
}

function closePreview(itemId) {
    const preview = document.getElementById(`preview-${itemId}`);
    if (preview) preview.style.display = 'none';
}

function openInModal(itemId) {
    const item = currentHistoryItems.find(i => i.id === itemId);
    if (!item) return;
    
    // Create modal
    const modal = document.createElement('div');
    modal.className = 'html-modal-overlay';
    modal.innerHTML = `
        <div class="html-modal">
            <div class="modal-header">
                <h3>${escapeHtml(item.metadata?.title || 'HTML Preview')}</h3>
                <button onclick="this.closest('.html-modal-overlay').remove()">✕</button>
            </div>
            <iframe class="modal-iframe" srcdoc="${escapeHtml(item.content || item.html)}"></iframe>
        </div>
    `;
    document.body.appendChild(modal);
}
```

### 3. Add CSS Styles

In `clipboard-viewer.html`, add these styles:

```css
/* HTML Preview Styles */
.html-item-wrapper {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    background: rgba(255, 255, 255, 0.02);
    border-radius: 8px;
}

.html-thumbnail-container {
    width: 100%;
    height: 200px;
    overflow: hidden;
    border-radius: 6px;
    background: #f5f5f5;
}

.html-thumbnail {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.html-placeholder {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #f0f0f0, #e0e0e0);
    color: #666;
    font-size: 14px;
    gap: 8px;
}

.html-placeholder span:first-child {
    font-size: 36px;
}

.html-info {
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.html-title {
    flex: 1;
    font-weight: 500;
    font-size: 14px;
    color: rgba(255, 255, 255, 0.9);
}

.preview-toggle {
    padding: 4px 12px;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    color: rgba(255, 255, 255, 0.8);
    cursor: pointer;
    font-size: 12px;
    transition: all 0.2s;
}

.preview-toggle:hover {
    background: rgba(255, 255, 255, 0.15);
    color: white;
}

.html-preview-frame {
    margin-top: 10px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    overflow: hidden;
    background: white;
}

.preview-controls {
    display: flex;
    gap: 8px;
    padding: 8px;
    background: rgba(0, 0, 0, 0.05);
    justify-content: flex-end;
}

.preview-controls button {
    padding: 4px 8px;
    background: white;
    border: 1px solid #ddd;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
}

.preview-controls button:hover {
    background: #f0f0f0;
}

.preview-iframe {
    width: 100%;
    height: 400px;
    border: none;
    display: block;
}

/* Modal Styles */
.html-modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
}

.html-modal {
    width: 90%;
    max-width: 1200px;
    height: 80vh;
    background: #1e1e1e;
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
}

.modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.modal-header h3 {
    margin: 0;
    color: white;
}

.modal-header button {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.6);
    font-size: 24px;
    cursor: pointer;
    padding: 4px 8px;
}

.modal-iframe {
    flex: 1;
    border: none;
    background: white;
}

/* Grid View Adjustments */
.grid-view .html-item-wrapper {
    height: 100%;
}

.grid-view .html-thumbnail-container {
    height: 150px;
}

.grid-view .html-info {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    margin-top: 8px;
}

.grid-view .preview-toggle {
    padding: 2px 8px;
    font-size: 11px;
}
```

## Performance Optimization

1. **Lazy Thumbnail Generation**: Generate thumbnails only when items come into view
2. **Caching**: Cache generated thumbnails to avoid regeneration
3. **Fallback**: Use SVG placeholders when Chrome is unavailable
4. **Progressive Loading**: Load iframe content only when preview is opened

## Usage Flow

1. **Initial View**: User sees HTML items with visual thumbnails
2. **Preview**: Click "Preview" button to expand inline iframe
3. **Full View**: Click fullscreen icon for modal view
4. **External**: Option to open in default browser

## Benefits

- **Visual Recognition**: Instantly identify HTML content by thumbnail
- **Quick Preview**: View HTML without leaving the app
- **Full Interaction**: Interact with HTML content in iframe
- **Flexibility**: Multiple viewing options for different needs

This implementation provides the best user experience for managing HTML content in spaces! 