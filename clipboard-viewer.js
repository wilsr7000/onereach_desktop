// Global state
let currentFilter = 'all';
let currentSpace = null;
let history = [];
let spaces = [];
let contextMenuItem = null;
let spacesEnabled = true;
let activeSpaceId = null;
let currentView = 'list'; // Add view state
let screenshotCaptureEnabled = true;
let selectedTags = []; // Tags currently selected for filtering
let allTags = {}; // Map of tag -> count

// Helper function to get asset paths in Electron
function getAssetPath(filename) {
    // Use relative path from the HTML file location
    return `assets/${filename}`;
}

// Initialize
async function init() {
    const loadingOverlay = document.getElementById('loadingOverlay');
    const errorDisplay = document.getElementById('errorDisplay');
    const errorMessage = document.getElementById('errorMessage');
    
    try {
        console.log('Initializing clipboard viewer...');
        console.log('window object keys:', Object.keys(window));
        console.log('window.api available?', !!window.api);
        console.log('window.clipboard available?', !!window.clipboard);
        console.log('window.clipboard methods:', window.clipboard ? Object.keys(window.clipboard) : 'N/A');
        
        // Wait a bit for preload to fully initialize if needed
        if (!window.clipboard) {
            console.log('Clipboard API not ready, waiting...');
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        // If clipboard API is still not available, show a helpful error
        if (!window.clipboard) {
            throw new Error('The clipboard manager is not initialized. Please close this window and try again.');
        }
        
        // Test the getHistory method directly
        if (window.clipboard && window.clipboard.getHistory) {
            console.log('Testing getHistory method...');
            try {
                const testData = await window.clipboard.getHistory();
                console.log('Test getHistory result:', testData);
            } catch (testErr) {
                console.error('Test getHistory failed:', testErr);
            }
        }
        
        // Get spaces enabled state
        spacesEnabled = await window.clipboard.getSpacesEnabled();
        console.log('Spaces enabled:', spacesEnabled);
        updateSpacesVisibility();
        
        // Get screenshot capture state
        screenshotCaptureEnabled = await window.clipboard.getScreenshotCaptureEnabled();
        console.log('Screenshot capture enabled:', screenshotCaptureEnabled);
        updateScreenshotIndicator();
        
        // Get active space
        await updateActiveSpace();
        console.log('Active space ID:', activeSpaceId);
        
        await loadSpaces();
        console.log('Loaded spaces:', spaces.length);
        
        await loadHistory();
        console.log('Loaded history items:', history.length);
        
        setupEventListeners();
        setupPreviewEventListeners();
        
        // Set default view
        setView('list');
        
        // Focus search on load
        document.getElementById('searchInput').focus();
        
        // Hide loading overlay on success
        if (loadingOverlay) {
            loadingOverlay.style.display = 'none';
        }
        
        // Listen for history updates to automatically refresh when documents are saved
        window.clipboard.onHistoryUpdate(async (updatedHistory) => {
            console.log('[Clipboard Viewer] History updated, refreshing...');
            // Check if we need to switch spaces
            const savedSpaceId = localStorage.getItem('pendingSwitchToSpace');
            if (savedSpaceId) {
                localStorage.removeItem('pendingSwitchToSpace');
                currentSpace = savedSpaceId;
                await window.clipboard.setCurrentSpace(currentSpace);
                
                // Update UI to show selected space
                document.querySelectorAll('.space-item').forEach(item => {
                    item.classList.remove('active');
                });
                const spaceItem = document.querySelector(`[data-space-id="${savedSpaceId}"]`);
                if (spaceItem) {
                    spaceItem.classList.add('active');
                }
            }
            
            // Reload history
            await loadHistory();
        });
    } catch (error) {
        console.error('Error initializing clipboard viewer:', error);
        
        // Hide loading overlay
        if (loadingOverlay) {
            loadingOverlay.style.display = 'none';
        }
        
        // Show error display instead of alert
        if (errorDisplay && errorMessage) {
            errorMessage.textContent = error.message || 'An unknown error occurred while loading the clipboard manager.';
            errorDisplay.style.display = 'block';
        } else {
            // Fallback to alert if error display elements don't exist
            alert('Failed to initialize clipboard viewer: ' + error.message);
        }
    }
}

// Set view mode
function setView(view) {
    currentView = view;
    const historyList = document.getElementById('historyList');
    
    // Update list classes
    historyList.classList.remove('grid-view', 'list-view');
    historyList.classList.add(`${view}-view`);
    
    // Update button states
    document.querySelectorAll('.view-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === view);
    });
    
    // Re-render to apply view-specific styles
    renderHistory();
}

// Update spaces visibility based on enabled state
function updateSpacesVisibility() {
    const sidebar = document.querySelector('.sidebar');
    const mainLayout = document.querySelector('.main-layout');
    
    if (spacesEnabled) {
        sidebar.style.display = 'flex';
        mainLayout.style.gridTemplateColumns = '280px 1fr';
    } else {
        sidebar.style.display = 'none';
        mainLayout.style.gridTemplateColumns = '1fr';
        // Reset to "All Items" view when spaces are disabled
        currentSpace = null;
    }
}

// Load spaces
async function loadSpaces() {
    spaces = await window.clipboard.getSpaces();
    renderSpaces();
}

// Load history
async function loadHistory() {
    try {
        console.log('Loading history for space:', currentSpace);
        
        let rawData;
        if (currentSpace === null) {
            console.log('Calling window.clipboard.getHistory()...');
            rawData = await window.clipboard.getHistory();
            console.log('Raw data from getHistory:', rawData);
            console.log('Type of rawData:', typeof rawData);
            console.log('Is rawData an array?', Array.isArray(rawData));
            
            // Try to parse if it's a string
            if (typeof rawData === 'string') {
                try {
                    history = JSON.parse(rawData);
                    console.log('Parsed string data to array, length:', history.length);
                } catch (parseErr) {
                    console.error('Failed to parse string data:', parseErr);
                    history = [];
                }
            } else if (Array.isArray(rawData)) {
                history = rawData;
                console.log('Data is already an array, length:', history.length);
            } else if (rawData && typeof rawData === 'object') {
                // Maybe it's wrapped in an object
                console.log('Data is an object, keys:', Object.keys(rawData));
                if (rawData.data && Array.isArray(rawData.data)) {
                    history = rawData.data;
                } else if (rawData.items && Array.isArray(rawData.items)) {
                    history = rawData.items;
                } else {
                    console.error('Unknown data structure:', rawData);
                    history = [];
                }
            } else {
                console.error('Unexpected data type:', typeof rawData, rawData);
                history = [];
            }
        } else {
            history = await window.clipboard.getSpaceItems(currentSpace);
        }
        
        console.log('Final history length:', history.length);
        
        // Debug: log the actual data structure
        if (history && history.length > 0) {
            console.log('First item structure:', JSON.stringify(history[0], null, 2));
        } else {
            console.log('History is empty or null:', history);
        }
        
        // Ensure history is an array
        if (!Array.isArray(history)) {
            console.error('History is not an array after processing:', history);
            history = [];
        }
        
        renderHistory();
        await updateItemCounts();
    } catch (error) {
        console.error('Error loading history:', error);
        console.error('Error stack:', error.stack);
        // Show error to user
        const historyList = document.getElementById('historyList');
        if (historyList) {
            historyList.innerHTML = `
                <div class="empty-state">
                    <img src="${getAssetPath('or-logo.png')}" class="empty-logo" alt="OneReach Logo">
                    <div class="empty-icon">⚠️</div>
                    <div class="empty-text">Error loading items</div>
                    <div class="empty-hint">${error.message}</div>
                </div>
            `;
        }
        history = [];
    }
}

// Render spaces in sidebar
// Generate smart title for clipboard items
function generateTitleForItem(item) {
    // Priority 1: Use existing title from metadata
    if (item.metadata?.title) {
        return item.metadata.title;
    }
    
    // Priority 2: Use fileName for files
    if (item.fileName && item.type === 'file') {
        return item.fileName;
    }
    
    // Priority 3: Auto-generate based on content
    if (item.type === 'text' || item.type === 'html') {
        const content = item.plainText || item.text || item.content || item.preview || '';
        
        // Check if it's a URL
        if (content.trim().match(/^https?:\/\//)) {
            try {
                const url = new URL(content.trim());
                return `Link: ${url.hostname}`;
            } catch (e) {
                return 'Web Link';
            }
        }
        
        // Extract first line or sentence as title
        const firstLine = content.split('\n')[0].trim();
        if (firstLine.length > 0 && firstLine.length <= 60) {
            // First line is good length - use it
            return firstLine;
        } else if (firstLine.length > 60) {
            // First line too long - find first sentence
            const firstSentence = firstLine.match(/^[^.!?]+[.!?]/);
            if (firstSentence && firstSentence[0].length <= 60) {
                return firstSentence[0].trim();
            }
            // Truncate first line
            return firstLine.substring(0, 57) + '...';
        }
        
        // Extract key words if possible
        const words = content.trim().split(/\s+/).slice(0, 6).join(' ');
        if (words.length > 0) {
            return words.length <= 50 ? words : words.substring(0, 47) + '...';
        }
    }
    
    // Priority 4: Use source information
    if (item.source && item.source !== 'clipboard') {
        return `From ${item.source}`;
    }
    
    // Priority 5: Use type-based default
    const typeNames = {
        'text': 'Text Note',
        'html': 'Rich Content',
        'image': 'Image',
        'code': 'Code Snippet',
        'url': 'Web Link',
        'file': 'File',
        'pdf': 'PDF Document',
        'video': 'Video',
        'audio': 'Audio',
        'screenshot': 'Screenshot'
    };
    
    return typeNames[item.type] || typeNames[item.fileType] || 'Clipboard Item';
}

// Setup drag-and-drop and paste functionality for spaces
function setupSpaceDragAndDrop() {
    const spaceItems = document.querySelectorAll('.space-item');
    
    spaceItems.forEach(spaceItem => {
        const spaceId = spaceItem.dataset.spaceId;
        
        // DRAG AND DROP FUNCTIONALITY
        spaceItem.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            spaceItem.style.background = 'rgba(99, 102, 241, 0.3)';
            spaceItem.style.borderLeft = '3px solid rgba(99, 102, 241, 1)';
        });
        
        spaceItem.addEventListener('dragleave', (e) => {
            e.preventDefault();
            spaceItem.style.background = '';
            spaceItem.style.borderLeft = '';
        });
        
        spaceItem.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            // Reset visual state
            spaceItem.style.background = '';
            spaceItem.style.borderLeft = '';
            
            try {
                // Get dropped item ID
                const itemId = e.dataTransfer.getData('text/plain');
                
                if (!itemId) {
                    console.log('[Drag] No item ID in drag data');
                    return;
                }
                
                console.log('[Drag] Dropping item', itemId, 'into space', spaceId);
                
                // Move item to this space
                const result = await window.clipboard.moveToSpace(itemId, spaceId);
                
                if (result.success) {
                    showNotification('✅ Moved to ' + (spaceItem.querySelector('.space-name')?.textContent || 'space'));
                    await loadSpaces();
                    await loadHistory();
                } else {
                    showNotification('❌ Failed to move item');
                }
                
            } catch (error) {
                console.error('[Drag] Error moving item:', error);
                showNotification('❌ Error: ' + error.message);
            }
        });
        
        // RIGHT-CLICK PASTE FUNCTIONALITY
        spaceItem.addEventListener('contextmenu', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            // Create custom context menu
            const existingMenu = document.getElementById('spaceContextMenu');
            if (existingMenu) existingMenu.remove();
            
            const menu = document.createElement('div');
            menu.id = 'spaceContextMenu';
            menu.style.cssText = `
                position: fixed;
                left: ${e.clientX}px;
                top: ${e.clientY}px;
                background: #1a1a25;
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 8px;
                padding: 4px;
                z-index: 10000;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
                min-width: 180px;
            `;
            
            const spaceName = spaceItem.querySelector('.space-name')?.textContent || 'this space';
            
            menu.innerHTML = `
                <div class="context-menu-item" data-action="paste" style="
                    padding: 8px 12px;
                    cursor: pointer;
                    border-radius: 4px;
                    font-size: 13px;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    color: rgba(255, 255, 255, 0.9);
                ">
                    <span>📋</span>
                    <span>Paste into ${spaceName}</span>
                </div>
                <div class="context-menu-item" data-action="paste-file" style="
                    padding: 8px 12px;
                    cursor: pointer;
                    border-radius: 4px;
                    font-size: 13px;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    color: rgba(255, 255, 255, 0.9);
                ">
                    <span>📎</span>
                    <span>Paste File into ${spaceName}</span>
                </div>
            `;
            
            document.body.appendChild(menu);
            
            // Add hover effects
            menu.querySelectorAll('.context-menu-item').forEach(item => {
                item.addEventListener('mouseenter', () => {
                    item.style.background = 'rgba(99, 102, 241, 0.3)';
                });
                item.addEventListener('mouseleave', () => {
                    item.style.background = '';
                });
                
                item.addEventListener('click', async () => {
                    const action = item.dataset.action;
                    
                    if (action === 'paste') {
                        await pasteIntoSpace(spaceId);
                    } else if (action === 'paste-file') {
                        await pasteFileIntoSpace(spaceId);
                    }
                    
                    menu.remove();
                });
            });
            
            // Close menu on click outside
            const closeMenu = (e) => {
                if (!menu.contains(e.target)) {
                    menu.remove();
                    document.removeEventListener('click', closeMenu);
                }
            };
            setTimeout(() => document.addEventListener('click', closeMenu), 0);
            
            // Close on escape
            const closeOnEscape = (e) => {
                if (e.key === 'Escape') {
                    menu.remove();
                    document.removeEventListener('keydown', closeOnEscape);
                }
            };
            document.addEventListener('keydown', closeOnEscape);
        });
    });
}

// Paste clipboard content into a space (HARDENED VERSION)
async function pasteIntoSpace(spaceId) {
    try {
        console.log('[Paste] Pasting clipboard content into space:', spaceId);
        
        // Ensure clipboard API is available
        if (!window.api || !window.api.invoke) {
            throw new Error('Clipboard API not available. Please try again.');
        }
        
        if (!window.clipboard) {
            throw new Error('Clipboard manager not initialized. Please try again.');
        }
        
        // Get comprehensive clipboard data including file paths
        const clipboardData = await window.api.invoke('get-clipboard-data');
        
        console.log('[Paste] Clipboard data:', {
            hasText: clipboardData?.hasText,
            hasHtml: clipboardData?.hasHtml,
            hasImage: clipboardData?.hasImage,
            textLength: clipboardData?.text?.length || 0,
            htmlLength: clipboardData?.html?.length || 0
        });
        
        // Validation: Check if clipboard has any content
        if (!clipboardData) {
            showNotification('❌ Failed to read clipboard');
            return;
        }
        
        const spaceName = spaces.find(s => s.id === spaceId)?.name || 'Space';
        let result;
        
        // IMPROVED Priority order: Image > Text > HTML (prefer text over HTML for simple content)
        
        // 1. Handle IMAGE (highest priority)
        if (clipboardData.hasImage && clipboardData.imageDataUrl) {
            console.log('[Paste] Detected: IMAGE');
            
            result = await window.clipboard.addImage({
                dataUrl: clipboardData.imageDataUrl,
                fileName: `Pasted Image ${new Date().toLocaleTimeString()}.png`,
                fileSize: clipboardData.imageDataUrl.length,
                spaceId: spaceId
            });
            
            if (result?.success) {
                showNotification(`✅ Image pasted into ${spaceName}`);
            } else {
                const errorMsg = result?.error || 'Failed to paste image';
                console.error('[Paste] Image error:', errorMsg);
                throw new Error(errorMsg);
            }
        }
        // 2. Handle TEXT (prefer text over HTML to avoid false HTML detection)
        else if (clipboardData.hasText && clipboardData.text && !clipboardData.hasHtml) {
            const text = clipboardData.text.trim();
            console.log('[Paste] Detected: TEXT (no HTML)', text.substring(0, 50));
            
            result = await window.clipboard.addText({
                content: text,
                spaceId: spaceId
            });
            
            if (result?.success) {
                if (result.isYouTube) {
                    showNotification(`✅ YouTube video queued for download into ${spaceName}`);
                } else {
                    showNotification(`✅ Text pasted into ${spaceName}`);
                }
            } else {
                const errorMsg = result?.error || 'Failed to paste text';
                console.error('[Paste] Text error:', errorMsg);
                throw new Error(errorMsg);
            }
        }
        // 3. Handle HTML (Rich content) - only if hasHtml is true
        else if (clipboardData.hasHtml && clipboardData.html) {
            console.log('[Paste] Detected: HTML (rich content)', clipboardData.html.substring(0, 100));
            
            result = await window.clipboard.addHtml({
                content: clipboardData.html,
                plainText: clipboardData.text || '',
                spaceId: spaceId
            });
            
            if (result?.success) {
                showNotification(`✅ Rich content pasted into ${spaceName}`);
            } else {
                const errorMsg = result?.error || 'Failed to paste HTML';
                console.error('[Paste] HTML error:', errorMsg);
                throw new Error(errorMsg);
            }
        }
        // 4. Fallback: Has text but with HTML (treat as text)
        else if (clipboardData.hasText && clipboardData.text) {
            const text = clipboardData.text.trim();
            console.log('[Paste] Detected: TEXT (ignoring basic HTML wrapper)', text.substring(0, 50));
            
            result = await window.clipboard.addText({
                content: text,
                spaceId: spaceId
            });
            
            if (result?.success) {
                showNotification(`✅ Text pasted into ${spaceName}`);
            } else {
                const errorMsg = result?.error || 'Failed to paste text';
                console.error('[Paste] Text fallback error:', errorMsg);
                throw new Error(errorMsg);
            }
        }
        // 5. Nothing to paste
        else {
            showNotification('❌ Nothing to paste - clipboard is empty');
            return;
        }
        
        // Reload to show new item
        console.log('[Paste] Reloading spaces and history...');
        setTimeout(async () => {
            await loadSpaces();
            await loadHistory();
        }, 800);
        
    } catch (error) {
        console.error('[Paste] Error pasting into space:', error);
        const errorMessage = error?.message || String(error) || 'Unknown error';
        showNotification('❌ Failed to paste: ' + errorMessage);
    }
}

// Paste FILE from clipboard into a space (HARDENED VERSION)
async function pasteFileIntoSpace(spaceId) {
    try {
        console.log('[PasteFile] Pasting file from clipboard into space:', spaceId);
        
        // Get file paths from clipboard via backend
        const fileData = await window.api.invoke('get-clipboard-files');
        
        if (!fileData || !fileData.files || fileData.files.length === 0) {
            showNotification('❌ No files in clipboard');
            return;
        }
        
        const spaceName = spaces.find(s => s.id === spaceId)?.name || 'Space';
        const files = fileData.files;
        
        console.log('[PasteFile] Found', files.length, 'file(s):', files);
        
        // Process each file
        for (const filePath of files) {
            console.log('[PasteFile] Processing file:', filePath);
            
            try {
                const result = await window.clipboard.addFile({
                    filePath: filePath,
                    spaceId: spaceId
                });
                
                if (!result?.success) {
                    console.error('[PasteFile] Failed to add file:', filePath, result?.error);
                }
            } catch (fileError) {
                console.error('[PasteFile] Error adding file:', filePath, fileError);
            }
        }
        
        showNotification(`✅ ${files.length} file(s) pasted into ${spaceName}`);
        
        // Reload to show new items
        setTimeout(async () => {
            await loadSpaces();
            await loadHistory();
        }, 800);
        
    } catch (error) {
        console.error('[PasteFile] Error:', error);
        showNotification('❌ Failed to paste file: ' + error.message);
    }
}

// Show notification helper
function showNotification(message) {
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: #1a1a25;
        color: white;
        padding: 12px 20px;
        border-radius: 8px;
        border: 1px solid rgba(99, 102, 241, 0.5);
        z-index: 10001;
        font-size: 13px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
        animation: slideIn 0.3s ease-out;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease-out';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function renderSpaces() {
    const spacesList = document.getElementById('spacesList');
    
    // Always show "All Items" first
    let html = `
        <div class="space-item ${currentSpace === null ? 'active' : ''}" data-space-id="null">
            <span class="space-icon">∞</span>
            <span class="space-name">All Items</span>
            <span class="space-count">-</span>
        </div>
    `;
    
    // Sort spaces by lastUsed (most recent first), then by createdAt
    const sortedSpaces = [...spaces].sort((a, b) => {
        const aLastUsed = a.lastUsed || a.createdAt || 0;
        const bLastUsed = b.lastUsed || b.createdAt || 0;
        return bLastUsed - aLastUsed; // Most recent first
    });
    
    // Add user-created spaces (sorted by most recently used)
    sortedSpaces.forEach(space => {
        html += `
            <div class="space-item ${currentSpace === space.id ? 'active' : ''}" data-space-id="${space.id}">
                <span class="space-icon">${space.icon}</span>
                <span class="space-name">${space.name}</span>
                <span class="space-count">${space.itemCount || 0}</span>
                <div class="space-actions">
                    <div class="space-action" data-action="notebook" data-space-id="${space.id}" title="Open Notebook">▣</div>
                    <div class="space-action" data-action="pdf" data-space-id="${space.id}" title="Export">📄</div>
                    <div class="space-action" data-action="edit" data-space-id="${space.id}">✎</div>
                    <div class="space-action" data-action="delete" data-space-id="${space.id}">✕</div>
                </div>
            </div>
        `;
    });
    
    spacesList.innerHTML = html;
    
    // Add drag-and-drop and paste functionality to each space item
    setupSpaceDragAndDrop();
}

// Render history list
function renderHistory(items = history) {
    console.log('renderHistory called with', items ? items.length : 0, 'items');
    const historyList = document.getElementById('historyList');
    const itemCount = document.getElementById('itemCount');
    
    if (!historyList) {
        console.error('historyList element not found!');
        return;
    }
    
    if (!items || items.length === 0) {
        console.log('No items to render, showing empty state');
        historyList.innerHTML = `
            <div class="empty-state">
                <img src="${getAssetPath('or-logo.png')}" class="empty-logo" alt="OneReach Logo">
                <div class="empty-icon">📋</div>
                <div class="empty-text">No items in this space</div>
                <div class="empty-hint">Copy something to add it here</div>
            </div>
        `;
        if (itemCount) itemCount.textContent = '0 items';
        return;
    }
    
    console.log('Rendering', items.length, 'items');
    
    try {
        historyList.innerHTML = items.map(item => {
          try {
            // Check if item is downloading FIRST - render special placeholder
            const isDownloading = item.metadata?.downloadStatus === 'downloading';
            const downloadError = item.metadata?.downloadStatus === 'error';
            
            if (isDownloading) {
                const title = item.metadata?.title || 'Video';
                const progress = item.metadata?.downloadProgress || 0;
                const shortTitle = title.length > 40 ? title.substring(0, 40) + '...' : title;
                const timeAgo = formatTimeAgo(item.timestamp);
                const statusText = item.metadata?.downloadStatusText || 'Downloading';
                
                return `
                    <div class="history-item downloading" data-id="${item.id}" data-download-status="downloading" draggable="true">
                        <div class="item-header">
                            <div class="item-type">
                                <span class="type-icon type-video">▶</span>
                                <span class="item-time">${timeAgo}</span>
                            </div>
                        </div>
                        <div class="video-tile downloading-tile">
                            <div class="video-tile-badge">
                                <span class="video-badge-icon">▶</span>
                                <span class="video-badge-text">VIDEO</span>
                                <span class="download-status-badge">Downloading</span>
                            </div>
                            <div class="video-tile-content">
                                <div class="video-tile-title">${escapeHtml(shortTitle)}</div>
                                <div class="download-progress-bar">
                                    <div class="download-progress-fill" style="width: ${progress}%"></div>
                                </div>
                                <div class="video-tile-meta">
                                    <span class="video-meta-item">${progress > 0 ? Math.round(progress) + '%' : statusText}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }
            
            if (downloadError) {
                const title = item.metadata?.title || 'Video';
                const shortTitle = title.length > 40 ? title.substring(0, 40) + '...' : title;
                const timeAgo = formatTimeAgo(item.timestamp);
                const errorMsg = item.metadata?.downloadError || 'Download failed';
                
                return `
                    <div class="history-item download-error" data-id="${item.id}" data-download-status="error" draggable="true">
                        <div class="item-header">
                            <div class="item-type">
                                <span class="type-icon type-error">!</span>
                                <span class="item-time">${timeAgo}</span>
                            </div>
                        </div>
                        <div class="video-tile error-tile">
                            <div class="video-tile-badge">
                                <span class="video-badge-icon error">!</span>
                                <span class="video-badge-text">VIDEO</span>
                                <span class="error-status-badge">Failed</span>
                            </div>
                            <div class="video-tile-content">
                                <div class="video-tile-title">${escapeHtml(shortTitle)}</div>
                                <div class="video-tile-desc error-text">${escapeHtml(errorMsg.substring(0, 80))}</div>
                            </div>
                        </div>
                        <div class="item-actions">
                            <button class="action-btn" data-action="delete" title="Delete">×</button>
                        </div>
                    </div>
                `;
            }
            
            const icon = getTypeIcon(item.type, item.source, item.fileType, item.fileCategory, item.metadata);
            const timeAgo = formatTimeAgo(item.timestamp);
            
            let contentHtml = '';
            if (item.type === 'image') {
                // Check if this is a large image
                if (item.largeImage) {
                    // Show a placeholder for large images
                    const sizeText = item.imageSize ? formatFileSize(item.imageSize) : 'Large Image';
                    contentHtml = `
                        <div class="large-image-placeholder">
                            <div class="file-icon">▣</div>
                            <div class="file-details">
                                <div class="file-name">Large Image</div>
                                <div class="file-meta">
                                    <span>${sizeText}</span>
                                    <span>Click to copy</span>
                                </div>
                            </div>
                        </div>
                    `;
                } else if (item.thumbnail || item.content) {
                    // Use thumbnail if available, otherwise use content
                    const imageSrc = item.thumbnail || item.content;
                    contentHtml = `<img src="${imageSrc}" class="item-image" data-full-image="${item.content}">`;
                } else {
                    // Fallback for images without content
                    contentHtml = `
                        <div class="image-placeholder">
                            <div class="file-icon">▣</div>
                            <div class="file-name">Image</div>
                        </div>
                    `;
                }
            } else if (item.type === 'file') {
                // Handle file types
                if (item.fileType === 'video' || item.fileCategory === 'video') {
                    // Get video metadata for better display
                    // Prefer AI-generated metadata over YouTube metadata
                    const title = item.metadata?.title || item.fileName || 'Video';
                    const shortDesc = item.metadata?.shortDescription || '';
                    const uploader = item.metadata?.uploader || item.metadata?.channel || '';
                    const duration = item.metadata?.duration || '';
                    const isYouTube = item.metadata?.source === 'youtube' || item.metadata?.youtubeUrl;
                    const hasAudio = !!item.metadata?.audioPath;
                    const hasTranscript = !!item.metadata?.transcript;
                    
                    // Get thumbnail - prefer local extracted, fallback to YouTube thumbnail
                    const thumbnail = item.metadata?.localThumbnail 
                        ? `file://${item.metadata.localThumbnail}`
                        : (item.metadata?.thumbnail || item.thumbnail || '');
                    
                    // Check for additional features
                    const hasStoryBeats = !!item.metadata?.storyBeats && item.metadata.storyBeats.length > 0;
                    const hasSpeakers = !!item.metadata?.speakers && item.metadata.speakers.length > 0;
                    const hasTopics = !!item.metadata?.topics && item.metadata.topics.length > 0;
                    
                    // Build status indicators
                    let statusIndicators = '';
                    statusIndicators += '<span class="video-feature-badge video">Video</span>';
                    if (hasAudio) statusIndicators += '<span class="video-feature-badge audio">Audio</span>';
                    if (hasTranscript) statusIndicators += '<span class="video-feature-badge transcript">Transcript</span>';
                    if (hasStoryBeats) statusIndicators += '<span class="video-feature-badge beats">Story Beats</span>';
                    if (hasSpeakers) statusIndicators += `<span class="video-feature-badge speakers">${item.metadata.speakers.length} Speaker${item.metadata.speakers.length > 1 ? 's' : ''}</span>`;
                    
                    contentHtml = `
                        <div class="video-tile ${thumbnail ? 'has-thumbnail' : ''}">
                            ${thumbnail ? `
                                <div class="video-tile-thumbnail">
                                    <img src="${thumbnail}" alt="Video thumbnail">
                                    <div class="video-play-overlay">▶</div>
                                    ${duration ? `<span class="video-duration-badge">${escapeHtml(duration)}</span>` : ''}
                                </div>
                            ` : ''}
                            <div class="video-tile-info">
                                <div class="video-tile-badge">
                                    <span class="video-badge-icon">▶</span>
                                    <span class="video-badge-text">VIDEO</span>
                                    ${isYouTube ? '<span class="video-source-badge">YouTube</span>' : ''}
                                </div>
                                <div class="video-tile-content">
                                    <div class="video-tile-title">${escapeHtml(title)}</div>
                                    ${shortDesc ? `<div class="video-tile-desc">${escapeHtml(shortDesc)}</div>` : ''}
                                    <div class="video-tile-meta">
                                        ${uploader ? `<span class="video-meta-item">${escapeHtml(uploader)}</span>` : ''}
                                        ${!thumbnail && duration ? `<span class="video-meta-item">${escapeHtml(duration)}</span>` : ''}
                                        <span class="video-meta-item">${formatFileSize(item.fileSize)}</span>
                                    </div>
                                    ${statusIndicators ? `<div class="video-features">${statusIndicators}</div>` : ''}
                                </div>
                            </div>
                        </div>
                    `;
                } else if (item.fileType === 'audio') {
                    // For audio files, show file info - use Preview button to play
                    contentHtml = `
                        <div class="file-info" style="display: flex; align-items: center; gap: 12px;">
                            <div class="file-icon" style="font-size: 28px;">🎵</div>
                            <div class="file-details">
                                <div class="file-name">${escapeHtml(item.fileName)}</div>
                                <div class="file-meta">
                                    <span>${formatFileSize(item.fileSize)}</span>
                                    <span>${item.fileExt ? item.fileExt.toUpperCase() : ''}</span>
                                    <span style="color: rgba(100, 200, 255, 0.8);">Click ◎ Preview to play</span>
                                </div>
                            </div>
                        </div>
                    `;
                } else if (item.fileType === 'image-file' && item.thumbnail) {
                    contentHtml = `
                        <img src="${item.thumbnail}" class="item-image">
                        <div class="file-info">
                            <div class="file-icon">▣</div>
                            <div class="file-details">
                                <div class="file-name">${escapeHtml(item.fileName)}</div>
                                <div class="file-meta">
                                    <span>${formatFileSize(item.fileSize)}</span>
                                    <span>${item.fileExt ? item.fileExt.toUpperCase() : ''}</span>
                                </div>
                            </div>
                        </div>
                    `;
                } else if (item.fileType === 'pdf' && item.thumbnail) {
                    // For PDFs with pagination support
                    contentHtml = `
                        <div class="pdf-preview-container" data-item-id="${item.id}" data-current-page="1" data-total-pages="${item.pageCount || 1}">
                            <div class="pdf-thumbnail-wrapper">
                                <img src="${item.thumbnail}" class="item-image pdf-thumbnail" title="${escapeHtml(item.fileName)} - ${formatFileSize(item.fileSize)}" alt="PDF Preview">
                                <div class="pdf-page-overlay" style="display: none;">
                                    <div class="page-number">Page <span class="current-page-num">1</span></div>
                                    <div class="page-note">Showing preview of page 1</div>
                                </div>
                            </div>
                            <div class="pdf-controls">
                                <button class="pdf-nav-btn pdf-prev" data-action="pdf-prev" ${(item.pageCount || 1) <= 1 ? 'disabled' : ''}>◀</button>
                                <span class="pdf-page-info">Page 1 of ${item.pageCount || 1}</span>
                                <button class="pdf-nav-btn pdf-next" data-action="pdf-next" ${(item.pageCount || 1) <= 1 ? 'disabled' : ''}>▶</button>
                            </div>
                            <div class="pdf-loading" style="display: none;">
                                <div class="loading-spinner"></div>
                            </div>
                        </div>
                    `;
                } else if (item.fileCategory === 'code' && ['.html', '.htm'].includes(item.fileExt) && item.thumbnail) {
                    contentHtml = `
                        <img src="${item.thumbnail}" class="item-image">
                        <div class="file-info">
                            <div class="file-icon">◐</div>
                            <div class="file-details">
                                <div class="file-name">${escapeHtml(item.fileName)}</div>
                                <div class="file-meta">
                                    <span>${formatFileSize(item.fileSize)}</span>
                                    <span>${item.fileExt ? item.fileExt.toUpperCase() : ''}</span>
                                </div>
                            </div>
                        </div>
                    `;
                } else if (item.fileType === 'flow') {
                    contentHtml = `
                        <div class="file-info">
                            <div class="file-icon">⧉</div>
                            <div class="file-details">
                                <div class="file-name">${escapeHtml(item.fileName)}</div>
                                <div class="file-meta">
                                    <span>${formatFileSize(item.fileSize)}</span>
                                    <span>GSX Flow</span>
                                </div>
                            </div>
                        </div>
                    `;
                } else if (item.fileType === 'notebook') {
                    contentHtml = `
                        <div class="file-info">
                            <div class="file-icon">◉</div>
                            <div class="file-details">
                                <div class="file-name">${escapeHtml(item.fileName)}</div>
                                <div class="file-meta">
                                    <span>${formatFileSize(item.fileSize)}</span>
                                    <span>Jupyter Notebook</span>
                                </div>
                            </div>
                        </div>
                    `;
                    if (item.thumbnail && !item.thumbnail.includes('placeholder')) {
                        contentHtml = `<img src="${item.thumbnail}" class="item-image">` + contentHtml;
                    }
                } else {
                    // Other file types
                    const fileIcon = getFileIcon(item.fileCategory, item.fileExt);
                    contentHtml = `
                        <div class="file-info">
                            <div class="file-icon">${fileIcon}</div>
                            <div class="file-details">
                                <div class="file-name">${escapeHtml(item.fileName)}</div>
                                <div class="file-meta">
                                    <span>${formatFileSize(item.fileSize)}</span>
                                    <span>${item.fileExt ? item.fileExt.toUpperCase() : ''}</span>
                                </div>
                            </div>
                        </div>
                    `;
                    if (item.content) {
                        contentHtml += `<div class="item-content code">${escapeHtml(item.preview)}</div>`;
                    }
                }
            } else if (item.type === 'generated-document' || (item.metadata && item.metadata.type === 'generated-document')) {
                // Handle generated documents
                const templateName = item.metadata?.templateName || 'Document';
                const generatedDate = new Date(item.metadata?.generatedAt || item.timestamp).toLocaleDateString();
                contentHtml = `
                    <div class="generated-document-preview">
                        <div class="doc-header">
                            <span class="doc-badge">✨ AI Generated</span>
                            <span class="doc-template">${templateName}</span>
                        </div>
                        <div class="doc-title">${escapeHtml(item.text || item.plainText || 'Generated Document')}</div>
                        <div class="doc-meta">Generated on ${generatedDate}</div>
                        <div class="doc-preview">
                            <iframe srcdoc="${escapeHtml(item.content || item.html)}" style="width: 100%; height: 200px; border: 1px solid #e0e0e0; border-radius: 4px;"></iframe>
                        </div>
                    </div>
                `;
            } else if (item.type === 'html' && !item.metadata?.type) {
                // Regular HTML content
                if (item.thumbnail) {
                    contentHtml = `
                        <img src="${item.thumbnail}" class="item-image" alt="HTML Preview">
                        <div class="item-content">${escapeHtml(item.preview || item.plainText || item.text)}</div>
                    `;
                } else {
                    const title = generateTitleForItem(item);
                    contentHtml = `
                        ${title ? `<div class="item-title">${escapeHtml(title)}</div>` : ''}
                        <div class="item-content">${escapeHtml(item.preview || item.plainText || item.text)}</div>
                    `;
                }
            } else if (item.source === 'code') {
                const title = generateTitleForItem(item);
                contentHtml = `
                    ${title ? `<div class="item-title">${escapeHtml(title)}</div>` : ''}
                    <div class="item-content code">${escapeHtml(item.preview)}</div>
                `;
            } else {
                const title = generateTitleForItem(item);
                contentHtml = `
                    ${title ? `<div class="item-title">${escapeHtml(title)}</div>` : ''}
                    <div class="item-content">${escapeHtml(item.preview)}</div>
                `;
            }
            
            // Handle text files with thumbnails
            if (item.type === 'file' && item.thumbnail && !item.thumbnail.includes('svg+xml')) {
                const textExtensions = ['.txt', '.md', '.log', '.csv', '.tsv'];
                const codeExtensions = ['.js', '.ts', '.jsx', '.tsx', '.json', '.html', '.htm', '.css', '.scss', '.sass', '.less', 
                                        '.py', '.java', '.cpp', '.c', '.h', '.rb', '.go', '.rs', '.swift', '.kt', '.php', '.sh', 
                                        '.yaml', '.yml', '.xml', '.sql', '.r', '.m', '.mm', '.lua', '.pl', '.ps1', '.bat'];
                
                if (textExtensions.includes(item.fileExt) || codeExtensions.includes(item.fileExt)) {
                    contentHtml = `
                        <div class="text-preview-container">
                            <img src="${item.thumbnail}" class="item-image text-thumbnail" title="${escapeHtml(item.fileName)} - ${formatFileSize(item.fileSize)}" alt="Text Preview">
                            <div class="file-info">
                                <div class="file-icon">${getFileIcon(item.fileCategory, item.fileExt)}</div>
                                <div class="file-details">
                                    <div class="file-name">${escapeHtml(item.fileName)}</div>
                                    <div class="file-meta">
                                        <span>${formatFileSize(item.fileSize)}</span>
                                        <span>${item.fileExt ? item.fileExt.toUpperCase() : ''}</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    `;
                }
            }
            
            const typeClass = item.type === 'file' ? `type-${item.fileCategory || 'file'}` : `type-${item.source || item.type}`;
            
            return `
                <div class="history-item ${item.pinned ? 'pinned' : ''}" data-id="${item.id}" draggable="true">
                    <div class="item-header">
                        <div class="item-type">
                            <span class="type-icon ${typeClass}">${icon}</span>
                            <span class="item-time">${timeAgo}</span>
                            ${item.metadata?.context?.app?.name ? `<span class="item-source" title="${escapeHtml(item.metadata.context.contextDisplay || '')}">from ${escapeHtml(item.metadata.context.app.name)}</span>` : ''}
                        </div>
                    </div>
                    ${contentHtml}
                    <div class="item-actions">
                        <button class="action-btn" data-action="preview" title="Preview/Edit">
                            ◎
                        </button>
                        <button class="action-btn copy" data-action="copy" title="Copy to Clipboard">
                            ⧉
                        </button>
                        <button class="action-btn" data-action="edit-metadata" title="Edit Metadata">
                            ✎
                        </button>
                        <button class="action-btn ${item.pinned ? 'pinned' : ''}" data-action="pin" title="Pin">
                            ${item.pinned ? '◈' : '◇'}
                        </button>
                        <button class="action-btn" data-action="menu" title="More">⋮</button>
                    </div>
                </div>
            `;
          } catch (itemError) {
            console.error('Error rendering item:', item.id, itemError);
            // Return a placeholder for broken items
            return `
                <div class="history-item error-item" data-id="${item.id || 'unknown'}">
                    <div class="item-header">
                        <div class="item-type">
                            <span class="type-icon">⚠️</span>
                            <span class="item-time">Error</span>
                        </div>
                    </div>
                    <div class="item-content" style="color: rgba(255,100,100,0.8);">
                        Failed to render item: ${itemError.message}
                    </div>
                    <div class="item-actions">
                        <button class="action-btn" data-action="delete" title="Delete">🗑️</button>
                    </div>
                </div>
            `;
          }
        }).join('');
        
        itemCount.textContent = `${items.length} item${items.length !== 1 ? 's' : ''}`;
    } catch (error) {
        console.error('Error rendering history:', error);
        console.error('Error stack:', error.stack);
        // Try to identify which item caused the error
        console.error('Items that may have caused error:', items.map(i => ({ id: i.id, type: i.type, metadata: i.metadata })));
        historyList.innerHTML = `
            <div class="empty-state">
                <img src="${getAssetPath('or-logo.png')}" class="empty-logo" alt="OneReach Logo">
                <div class="empty-icon">⚠️</div>
                <div class="empty-text">Error rendering items</div>
                <div class="empty-hint">${error.message}</div>
                <button onclick="window.clipboard.clearCorruptItems && window.clipboard.clearCorruptItems()" style="margin-top: 16px; padding: 8px 16px; background: rgba(255,100,100,0.3); border: 1px solid rgba(255,100,100,0.5); border-radius: 6px; color: white; cursor: pointer;">Clear Corrupt Items</button>
            </div>
        `;
        itemCount.textContent = 'Error';
    }
}

// Update item counts for all spaces
async function updateItemCounts() {
    console.log('Updating item counts for spaces:', spaces);
    
    // Update "All Items" count - get the actual total count
    const allItemsEl = document.querySelector('[data-space-id="null"] .space-count');
    if (allItemsEl) {
        try {
            // Always get the full history count for "All Items"
            const allItems = await window.clipboard.getHistory();
            const totalCount = Array.isArray(allItems) ? allItems.length : 0;
            console.log(`Updating All Items count: ${totalCount}`);
            allItemsEl.textContent = totalCount;
        } catch (error) {
            console.error('Error getting total count:', error);
            // Fallback to current history length
            allItemsEl.textContent = history ? history.length : 0;
        }
    }
    
    // Update each space count
    spaces.forEach(space => {
        const spaceEl = document.querySelector(`[data-space-id="${space.id}"] .space-count`);
        if (spaceEl) {
            console.log(`Updating count for space ${space.name}: ${space.itemCount}`);
            spaceEl.textContent = space.itemCount || 0;
        }
    });
    
    // Also update the total count in header (current view count)
    const itemCount = document.getElementById('itemCount');
    if (itemCount && history) {
        itemCount.textContent = `${history.length} item${history.length !== 1 ? 's' : ''}`;
    }
}

// Get icon for content type
function getTypeIcon(type, source, fileType, fileCategory, metadata) {
    if (type === 'generated-document' || (metadata && metadata.type === 'generated-document')) return '✨';
    if (type === 'file') {
        if (fileType === 'pdf') return '▥';
        if (fileType === 'flow') return '⧉';
        if (fileType === 'notebook') return '◉';
        if (fileType === 'video') return '▶';
        if (fileType === 'audio') return '♫';
        if (fileType === 'image-file') return '▣';
        if (fileCategory === 'code') return '{ }';
        if (fileCategory === 'document') return '▤';
        if (fileCategory === 'archive') return '◱';
        if (fileCategory === 'data') return '⊞';
        if (fileCategory === 'design') return '◈';
        if (fileCategory === 'flow') return '⧉';
        if (fileCategory === 'notebook') return '◉';
        return '◎';
    }
    if (source === 'code') return '{ }';
    if (source === 'data') return '⊞';
    if (source === 'spreadsheet') return '▦';
    if (source === 'url') return '⚯';
    if (source === 'email') return '✉';
    if (type === 'image') return '▣';
    if (type === 'html') return '◔';
    return '▬';
}

function getFileIcon(category, ext) {
    // Specific file type icons
    const extIcons = {
        '.pdf': '▥',
        '.doc': '▤',
        '.docx': '▤',
        '.xls': '▦',
        '.xlsx': '▦',
        '.ppt': '▧',
        '.pptx': '▧',
        '.zip': '◱',
        '.rar': '◱',
        '.7z': '◱',
        '.txt': '▬',
        '.md': '▭',
        '.json': '⊞',
        '.xml': '⊞',
        '.csv': '⊞',
        '.yaml': '⊞',
        '.yml': '⊞',
        '.tsv': '⊞',
        '.html': '◐',
        '.htm': '◐',
        '.css': '◑',
        '.scss': '◑',
        '.sass': '◑',
        '.less': '◑',
        '.ipynb': '◉',
        '.fig': '◈',
        '.sketch': '◈',
        '.xd': '◈',
        '.ai': '◇',
        '.psd': '◇',
        '.psb': '◇',
        '.indd': '◈',
        '.afdesign': '◈',
        '.afphoto': '◇'
    };
    
    if (extIcons[ext]) return extIcons[ext];
    
    // Check for special file names
    const fileName = ext; // ext parameter might contain filename for special cases
    if (fileName && fileName.toLowerCase().startsWith('flowsource_')) {
        return '⧉';
    }
    
    // Category-based icons
    if (category === 'code') return '{ }';
    if (category === 'document') return '▤';
    if (category === 'archive') return '◱';
    if (category === 'media') return '▷';
    if (category === 'data') return '⊞';
    if (category === 'design') return '◈';
    if (category === 'flow') return '⧉';
    
    return '◎';
}

function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Format time ago
function formatTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

// Escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================
// Tag Filtering Functions
// ============================================

// Extract all unique tags from items
function extractAllTags(items) {
    const tagCounts = {};
    
    items.forEach(item => {
        // Get tags from metadata
        const tags = item.metadata?.tags || item.tags || [];
        if (Array.isArray(tags)) {
            tags.forEach(tag => {
                if (typeof tag === 'string' && tag.trim()) {
                    const normalizedTag = tag.trim().toLowerCase();
                    tagCounts[normalizedTag] = (tagCounts[normalizedTag] || 0) + 1;
                }
            });
        }
    });
    
    return tagCounts;
}

// Update the tag dropdown with available tags
function updateTagDropdown() {
    const container = document.getElementById('tagPillsContainer');
    if (!container) return;
    
    // Get items based on current space
    const items = currentSpace === null ? history : history.filter(item => item.spaceId === currentSpace);
    allTags = extractAllTags(items);
    
    // Sort tags by count (most used first), then alphabetically
    const sortedTags = Object.entries(allTags)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 30); // Limit to top 30 tags
    
    if (sortedTags.length === 0) {
        container.innerHTML = '<div style="color: rgba(255,255,255,0.4); font-size: 11px;">No tags found</div>';
        return;
    }
    
    container.innerHTML = sortedTags.map(([tag, count]) => {
        const isSelected = selectedTags.includes(tag);
        return `<div class="tag-pill ${isSelected ? 'selected' : ''}" data-tag="${escapeHtml(tag)}">
            <span>${escapeHtml(tag)}</span>
            <span class="tag-pill-count">(${count})</span>
        </div>`;
    }).join('');
    
    // Add click handlers
    container.querySelectorAll('.tag-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            const tag = pill.dataset.tag;
            toggleTag(tag);
        });
    });
}

// Toggle a tag selection
function toggleTag(tag) {
    const index = selectedTags.indexOf(tag);
    if (index === -1) {
        selectedTags.push(tag);
    } else {
        selectedTags.splice(index, 1);
    }
    
    updateTagUI();
    filterItems();
}

// Remove a tag
function removeTag(tag) {
    const index = selectedTags.indexOf(tag);
    if (index !== -1) {
        selectedTags.splice(index, 1);
        updateTagUI();
        filterItems();
    }
}

// Clear all selected tags
function clearAllTags() {
    selectedTags = [];
    updateTagUI();
    filterItems();
}

// Update tag UI (button state, selected tags display, dropdown pills)
function updateTagUI() {
    const tagBtn = document.getElementById('tagFilterBtn');
    const tagCount = document.getElementById('tagCount');
    const selectedTagsContainer = document.getElementById('selectedTags');
    
    // Update button state
    if (tagBtn) {
        if (selectedTags.length > 0) {
            tagBtn.classList.add('has-tags');
        } else {
            tagBtn.classList.remove('has-tags');
        }
    }
    
    // Update count badge
    if (tagCount) {
        if (selectedTags.length > 0) {
            tagCount.textContent = selectedTags.length;
            tagCount.style.display = 'inline';
        } else {
            tagCount.style.display = 'none';
        }
    }
    
    // Update selected tags display
    if (selectedTagsContainer) {
        if (selectedTags.length > 0) {
            selectedTagsContainer.innerHTML = selectedTags.map(tag => 
                `<div class="selected-tag" data-tag="${escapeHtml(tag)}">
                    <span>${escapeHtml(tag)}</span>
                    <span class="remove-tag" data-tag="${escapeHtml(tag)}">✕</span>
                </div>`
            ).join('');
            
            // Add remove handlers
            selectedTagsContainer.querySelectorAll('.remove-tag').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    removeTag(btn.dataset.tag);
                });
            });
        } else {
            selectedTagsContainer.innerHTML = '';
        }
    }
    
    // Update dropdown pills
    updateTagDropdown();
}

// Check if an item matches the selected tags
function itemMatchesTags(item) {
    if (selectedTags.length === 0) return true;
    
    const itemTags = item.metadata?.tags || item.tags || [];
    if (!Array.isArray(itemTags)) return false;
    
    const normalizedItemTags = itemTags.map(t => 
        typeof t === 'string' ? t.trim().toLowerCase() : ''
    );
    
    // Item must have ALL selected tags (AND logic)
    return selectedTags.every(tag => normalizedItemTags.includes(tag));
}

// Initialize tag filter UI
function initTagFilter() {
    const tagBtn = document.getElementById('tagFilterBtn');
    const tagDropdown = document.getElementById('tagDropdown');
    const clearBtn = document.getElementById('clearTagsBtn');
    
    if (tagBtn && tagDropdown) {
        // Toggle dropdown
        tagBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            tagDropdown.classList.toggle('visible');
            if (tagDropdown.classList.contains('visible')) {
                updateTagDropdown();
            }
        });
        
        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!tagDropdown.contains(e.target) && e.target !== tagBtn) {
                tagDropdown.classList.remove('visible');
            }
        });
        
        // Prevent dropdown close when clicking inside
        tagDropdown.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }
    
    if (clearBtn) {
        clearBtn.addEventListener('click', clearAllTags);
    }
}

// ============================================
// Filter items (with tag support)
// ============================================

// Filter items
function filterItems() {
    let items = currentSpace === null ? history : history.filter(item => item.spaceId === currentSpace);
    
    // Apply type filter
    if (currentFilter !== 'all') {
        items = items.filter(item => {
            if (currentFilter === 'pinned') return item.pinned;
            if (currentFilter === 'text') {
                // Include text type and .md files (but not html type - that has its own filter now)
                if (item.type === 'text') return item.source !== 'code' && item.source !== 'url' && item.source !== 'data' && item.source !== 'spreadsheet';
                if (item.type === 'file' && item.fileExt === '.md') return true;
                return false;
            }
            if (currentFilter === 'html') {
                // HTML type items and .html files
                if (item.type === 'html') return true;
                if (item.type === 'generated-document' || item.metadata?.type === 'generated-document') return true;
                if (item.type === 'file' && (item.fileExt === '.html' || item.fileExt === '.htm')) return true;
                return false;
            }
            if (currentFilter === 'code') return item.source === 'code' || (item.type === 'file' && item.fileCategory === 'code');
            if (currentFilter === 'design') return item.type === 'file' && item.fileCategory === 'design';
            if (currentFilter === 'flow') return item.type === 'file' && (item.fileType === 'flow' || item.fileCategory === 'flow');
            if (currentFilter === 'notebook') return item.type === 'file' && (item.fileType === 'notebook' || item.fileCategory === 'notebook');
            if (currentFilter === 'data') return item.source === 'data' || (item.type === 'file' && item.fileCategory === 'data');
            if (currentFilter === 'spreadsheet') return item.source === 'spreadsheet' || (item.type === 'file' && (item.fileExt === '.xls' || item.fileExt === '.xlsx' || item.fileExt === '.ods'));
            if (currentFilter === 'pdf') return item.type === 'file' && item.fileType === 'pdf';
            if (currentFilter === 'url') return item.source === 'url';
            if (currentFilter === 'image') return item.type === 'image';
            if (currentFilter === 'video') return item.type === 'file' && item.fileType === 'video';
            if (currentFilter === 'audio') return item.type === 'file' && item.fileType === 'audio';
            if (currentFilter === 'file') return item.type === 'file';
            if (currentFilter === 'screenshot') return item.isScreenshot === true;
            return false;
        });
    }
    
    // Apply tag filter
    if (selectedTags.length > 0) {
        items = items.filter(itemMatchesTags);
    }
    
    renderHistory(items);
}

// Search items
async function searchItems(query) {
    if (!query) {
        await loadHistory();
        filterItems();
        return;
    }
    
    const results = await window.clipboard.search(query);
    let filtered = results;
    
    // Apply space filter
    if (currentSpace !== null) {
        filtered = filtered.filter(item => item.spaceId === currentSpace);
    }
    
    // Apply type filter
    if (currentFilter !== 'all') {
        filtered = filtered.filter(item => {
            if (currentFilter === 'code') return item.source === 'code' || (item.type === 'file' && item.fileCategory === 'code');
            if (currentFilter === 'design') return item.type === 'file' && item.fileCategory === 'design';
            if (currentFilter === 'flow') return item.type === 'file' && (item.fileType === 'flow' || item.fileCategory === 'flow');
            if (currentFilter === 'notebook') return item.type === 'file' && (item.fileType === 'notebook' || item.fileCategory === 'notebook');
            if (currentFilter === 'data') return item.source === 'data' || (item.type === 'file' && item.fileCategory === 'data');
            if (currentFilter === 'spreadsheet') return item.source === 'spreadsheet' || (item.type === 'file' && (item.fileExt === '.xls' || item.fileExt === '.xlsx' || item.fileExt === '.ods'));
            if (currentFilter === 'pdf') return item.type === 'file' && item.fileType === 'pdf';
            if (currentFilter === 'url') return item.source === 'url';
            if (currentFilter === 'image') return item.type === 'image';
            if (currentFilter === 'video') return item.type === 'file' && item.fileType === 'video';
            if (currentFilter === 'audio') return item.type === 'file' && item.fileType === 'audio';
            if (currentFilter === 'file') return item.type === 'file';
            if (currentFilter === 'text') {
                if (item.type === 'text') return item.source !== 'code' && item.source !== 'url';
                if (item.type === 'file' && item.fileExt === '.md') return true;
                return false;
            }
            if (currentFilter === 'html') {
                if (item.type === 'html') return true;
                if (item.type === 'generated-document' || item.metadata?.type === 'generated-document') return true;
                if (item.type === 'file' && (item.fileExt === '.html' || item.fileExt === '.htm')) return true;
                return false;
            }
            if (currentFilter === 'screenshot') return item.isScreenshot === true;
            return false;
        });
    }
    
    // Apply tag filter
    if (selectedTags.length > 0) {
        filtered = filtered.filter(itemMatchesTags);
    }
    
    renderHistory(filtered);
}

// Show context menu with smart positioning to prevent cut-off
function showContextMenu(e, itemId) {
    e.preventDefault();
    e.stopPropagation();
    
    const contextMenu = document.getElementById('contextMenu');
    contextMenuItem = itemId;
    
    const padding = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Use clientX/clientY for fixed positioning (viewport-relative)
    const x = e.clientX;
    const y = e.clientY;
    
    // Show off-screen to measure
    contextMenu.style.left = '-9999px';
    contextMenu.style.top = '-9999px';
    contextMenu.style.display = 'block';
    
    // Get menu dimensions
    const rect = contextMenu.getBoundingClientRect();
    const mw = rect.width;
    const mh = rect.height;
    
    // Calculate available space
    const spaceRight = vw - x - padding;
    const spaceLeft = x - padding;
    const spaceBelow = vh - y - padding;
    const spaceAbove = y - padding;
    
    let finalX, finalY;
    
    // Horizontal: prefer right, flip to left if needed
    if (mw <= spaceRight) {
        finalX = x;
    } else if (mw <= spaceLeft) {
        finalX = x - mw;
    } else {
        // Not enough space either side - fit to widest side
        finalX = spaceRight >= spaceLeft ? vw - mw - padding : padding;
    }
    
    // Vertical: prefer below, flip above if needed
    if (mh <= spaceBelow) {
        finalY = y;
    } else if (mh <= spaceAbove) {
        finalY = y - mh;
    } else {
        // Menu taller than available space - position at top with padding
        finalY = padding;
    }
    
    // Clamp to viewport bounds
    finalX = Math.max(padding, Math.min(finalX, vw - mw - padding));
    finalY = Math.max(padding, Math.min(finalY, vh - mh - padding));
    
    // Apply position
    contextMenu.style.left = `${Math.round(finalX)}px`;
    contextMenu.style.top = `${Math.round(finalY)}px`;
}

// Hide context menu
function hideContextMenu() {
    document.getElementById('contextMenu').style.display = 'none';
    contextMenuItem = null;
}

// Show space modal
function showSpaceModal(space = null) {
    const modal = document.getElementById('spaceModal');
    const title = document.getElementById('modalTitle');
    const nameInput = document.getElementById('spaceName');
    const saveBtn = document.getElementById('modalSave');
    const exportPDFBtn = document.getElementById('modalExportPDF');
    
    // Notebook fields
    const descriptionInput = document.getElementById('spaceDescription');
    const objectiveInput = document.getElementById('spaceObjective');
    const instructionsInput = document.getElementById('spaceInstructions');
    const tagsInput = document.getElementById('spaceTags');
    const linksInput = document.getElementById('spaceLinks');
    
    if (space) {
        title.textContent = 'Edit Space';
        nameInput.value = space.name;
        saveBtn.textContent = 'Update Space';
        
        // Show PDF export button for existing spaces
        exportPDFBtn.style.display = 'inline-block';
        exportPDFBtn.onclick = () => handlePDFExport(space);
        
        // Load notebook data if exists
        if (space.notebook) {
            descriptionInput.value = space.notebook.description || '';
            objectiveInput.value = space.notebook.objective || '';
            instructionsInput.value = space.notebook.instructions || '';
            tagsInput.value = (space.notebook.tags || []).join(', ');
            linksInput.value = (space.notebook.links || []).join('\n');
        } else {
            descriptionInput.value = '';
            objectiveInput.value = '';
            instructionsInput.value = '';
            tagsInput.value = '';
            linksInput.value = '';
        }
        
        // Select the current icon
        document.querySelectorAll('.icon-option').forEach(opt => {
            opt.classList.toggle('selected', opt.dataset.icon === space.icon);
        });
    } else {
        title.textContent = 'Create New Space';
        nameInput.value = '';
        saveBtn.textContent = 'Create Space';
        
        // Hide PDF export button for new spaces
        exportPDFBtn.style.display = 'none';
        
        // Clear notebook fields
        descriptionInput.value = '';
        objectiveInput.value = '';
        instructionsInput.value = '';
        tagsInput.value = '';
        linksInput.value = '';
        
        // Select default icon
        document.querySelectorAll('.icon-option').forEach(opt => {
            opt.classList.toggle('selected', opt.dataset.icon === '◆');
        });
    }
    
    modal.style.display = 'flex';
    nameInput.focus();
    
    // Store space being edited
    modal.dataset.spaceId = space ? space.id : '';
    
    // Update preview on input
    updateNotebookPreview();
}

// Generate notebook preview
function updateNotebookPreview() {
    const name = document.getElementById('spaceName').value || 'New Space';
    const description = document.getElementById('spaceDescription').value;
    const objective = document.getElementById('spaceObjective').value;
    const instructions = document.getElementById('spaceInstructions').value;
    const tags = document.getElementById('spaceTags').value;
    const links = document.getElementById('spaceLinks').value;
    
    if (!description && !objective && !instructions) {
        document.querySelector('.notebook-preview').style.display = 'none';
        return;
    }
    
    // Generate preview of notebook structure
    let preview = `# ${name} Space\n\n`;
    
    if (description) {
        preview += `## Description\n${description}\n\n`;
    }
    
    if (objective) {
        preview += `## Objective\n${objective}\n\n`;
    }
    
    if (instructions) {
        preview += `## Instructions\n${instructions}\n\n`;
    }
    
    if (tags) {
        preview += `## Tags\n${tags.split(',').map(t => `- ${t.trim()}`).join('\n')}\n\n`;
    }
    
    if (links) {
        preview += `## Related Links\n${links.split('\n').filter(l => l.trim()).map(l => `- ${l.trim()}`).join('\n')}`;
    }
    
    document.getElementById('notebookPreview').textContent = preview;
    document.querySelector('.notebook-preview').style.display = 'block';
}

// Hide space modal
function hideSpaceModal() {
    document.getElementById('spaceModal').style.display = 'none';
}

// Handle PDF export - now opens preview window
async function handlePDFExport(space) {
    try {
        // Show loading notification
        showNotification({
            title: 'Export Preview',
            body: 'Opening export preview...',
            type: 'info'
        });
        
        // Open the preview window with basic HTML (no AI)
        await window.clipboard.openExportPreview(space.id, { useAI: false });
        
    } catch (error) {
        console.error('Error opening export preview:', error);
        showNotification({
            title: 'Error',
            body: error.message || 'Failed to open export preview',
            type: 'error'
        });
    }
}

// Show notification
function showNotification(options) {
    // Create notification element
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: ${options.type === 'success' ? 'rgba(76, 175, 80, 0.9)' : 'rgba(244, 67, 54, 0.9)'};
        color: #fff;
        padding: 16px 24px;
        border-radius: 8px;
        font-size: 14px;
        z-index: 10000;
        animation: slideIn 0.3s ease;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        max-width: 400px;
    `;
    
    notification.innerHTML = `
        <div style="font-weight: 500; margin-bottom: 4px;">${options.title}</div>
        <div style="opacity: 0.9;">${options.body}</div>
    `;
    
    // Add animation keyframes
    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideIn {
            from {
                opacity: 0;
                transform: translateX(100px);
            }
            to {
                opacity: 1;
                transform: translateX(0);
            }
        }
    `;
    document.head.appendChild(style);
    
    document.body.appendChild(notification);
    
    // Remove after 5 seconds
    setTimeout(() => {
        notification.style.opacity = '0';
        notification.style.transform = 'translateX(100px)';
        setTimeout(() => {
            notification.remove();
            style.remove();
        }, 300);
    }, 5000);
}

// Show move to space modal
async function showMoveToSpaceModal(itemId) {
    // Create a temporary modal for space selection
    const modalHtml = `
        <div class="modal-overlay" id="moveToSpaceModal" style="display: flex;">
            <div class="modal" style="width: 400px;">
                <h2 class="modal-title">Move to Space</h2>
                <div class="space-select-list" style="max-height: 300px; overflow-y: auto; margin: 20px 0;">
                    ${spaces.map(space => `
                        <div class="space-select-item" data-space-id="${space.id}" style="
                            display: flex;
                            align-items: center;
                            padding: 12px;
                            cursor: pointer;
                            border-radius: 8px;
                            margin-bottom: 8px;
                            background: rgba(255, 255, 255, 0.05);
                            transition: all 0.2s;
                        ">
                            <span class="space-icon" style="font-size: 18px; margin-right: 12px;">${space.icon}</span>
                            <span class="space-name" style="flex: 1;">${space.name}</span>
                            <span class="space-count" style="font-size: 12px; color: rgba(255, 255, 255, 0.5);">${space.itemCount || 0} items</span>
                        </div>
                    `).join('')}
                </div>
                <div class="modal-buttons">
                    <button class="btn btn-secondary" onclick="document.getElementById('moveToSpaceModal').remove()">Cancel</button>
                </div>
            </div>
        </div>
    `;
    
    // Add the modal to the page
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    // Add hover effects with inline event handlers
    const modal = document.getElementById('moveToSpaceModal');
    modal.querySelectorAll('.space-select-item').forEach(item => {
        item.addEventListener('mouseenter', () => {
            item.style.background = 'rgba(255, 255, 255, 0.1)';
        });
        item.addEventListener('mouseleave', () => {
            item.style.background = 'rgba(255, 255, 255, 0.05)';
        });
        item.addEventListener('click', async () => {
            const spaceId = item.dataset.spaceId;
            try {
                await window.clipboard.moveToSpace(itemId, spaceId);
                await loadSpaces();  // Reload spaces to update counts
                await loadHistory();
                modal.remove();
                hideContextMenu();
            } catch (error) {
                console.error('Error moving item to space:', error);
                alert('Failed to move item: ' + error.message);
                modal.remove();
            }
        });
    });
    
    // Close on escape
    const closeOnEscape = (e) => {
        if (e.key === 'Escape') {
            modal.remove();
            document.removeEventListener('keydown', closeOnEscape);
        }
    };
    document.addEventListener('keydown', closeOnEscape);
    
    // Close on click outside
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.remove();
        }
    });
}

// Show paste to space modal (for Cmd+V when no space is selected)
async function showPasteToSpaceModal() {
    // Create a modal for space selection
    const modalHtml = `
        <div class="modal-overlay" id="pasteToSpaceModal" style="display: flex;">
            <div class="modal" style="width: 400px;">
                <h2 class="modal-title">📋 Paste into Space</h2>
                <p style="color: rgba(255, 255, 255, 0.6); margin-bottom: 16px; font-size: 13px;">
                    Choose a space to paste your clipboard content into:
                </p>
                <div class="space-select-list" style="max-height: 300px; overflow-y: auto; margin: 20px 0;">
                    <div class="space-select-item" data-space-id="unclassified" style="
                        display: flex;
                        align-items: center;
                        padding: 12px;
                        cursor: pointer;
                        border-radius: 8px;
                        margin-bottom: 8px;
                        background: rgba(255, 255, 255, 0.05);
                        transition: all 0.2s;
                    ">
                        <span class="space-icon" style="font-size: 18px; margin-right: 12px;">📥</span>
                        <span class="space-name" style="flex: 1;">Unclassified</span>
                    </div>
                    ${spaces.map(space => `
                        <div class="space-select-item" data-space-id="${space.id}" style="
                            display: flex;
                            align-items: center;
                            padding: 12px;
                            cursor: pointer;
                            border-radius: 8px;
                            margin-bottom: 8px;
                            background: rgba(255, 255, 255, 0.05);
                            transition: all 0.2s;
                        ">
                            <span class="space-icon" style="font-size: 18px; margin-right: 12px;">${space.icon}</span>
                            <span class="space-name" style="flex: 1;">${space.name}</span>
                            <span class="space-count" style="font-size: 12px; color: rgba(255, 255, 255, 0.5);">${space.itemCount || 0} items</span>
                        </div>
                    `).join('')}
                </div>
                <div class="modal-buttons">
                    <button class="btn btn-secondary" onclick="document.getElementById('pasteToSpaceModal').remove()">Cancel</button>
                </div>
            </div>
        </div>
    `;
    
    // Add the modal to the page
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    // Add hover effects and click handlers
    const modal = document.getElementById('pasteToSpaceModal');
    modal.querySelectorAll('.space-select-item').forEach(item => {
        item.addEventListener('mouseenter', () => {
            item.style.background = 'rgba(99, 102, 241, 0.3)';
        });
        item.addEventListener('mouseleave', () => {
            item.style.background = 'rgba(255, 255, 255, 0.05)';
        });
        item.addEventListener('click', async () => {
            const spaceId = item.dataset.spaceId;
            modal.remove();
            
            try {
                await pasteIntoSpace(spaceId);
            } catch (error) {
                console.error('[PasteModal] Error pasting:', error);
                showNotification('❌ Failed to paste: ' + error.message);
            }
        });
    });
    
    // Close on escape
    const closeOnEscape = (e) => {
        if (e.key === 'Escape') {
            modal.remove();
            document.removeEventListener('keydown', closeOnEscape);
        }
    };
    document.addEventListener('keydown', closeOnEscape);
    
    // Close on click outside
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.remove();
        }
    });
}

// Build dynamic HTML for metadata fields based on schema
function buildDynamicMetadataFields(metadata, schema) {
    let html = '';
    
    const fieldRenderers = {
        'string': (key, label, value) => `
            <div class="form-group">
                <label class="form-label">${label}</label>
                <input type="text" class="form-input dynamic-field" data-field="${key}" value="${escapeHtml(value || '')}" placeholder="${label}">
            </div>
        `,
        'textarea': (key, label, value) => `
            <div class="form-group">
                <label class="form-label">${label}</label>
                <textarea class="form-input dynamic-field" data-field="${key}" rows="4" placeholder="${label}">${escapeHtml(value || '')}</textarea>
            </div>
        `,
        'array': (key, label, value) => {
            const displayValue = Array.isArray(value) ? value.join(', ') : value || '';
            return `
                <div class="form-group">
                    <label class="form-label">${label} <span style="font-size: 11px; opacity: 0.6;">(comma-separated)</span></label>
                    <input type="text" class="form-input dynamic-field" data-field="${key}" value="${escapeHtml(displayValue)}" placeholder="${label}">
                </div>
            `;
        },
        'list': (key, label, value) => {
            const displayValue = Array.isArray(value) ? value.join('\n') : value || '';
            return `
                <div class="form-group">
                    <label class="form-label">${label} <span style="font-size: 11px; opacity: 0.6;">(one per line)</span></label>
                    <textarea class="form-input dynamic-field" data-field="${key}" rows="5" placeholder="${label}">${escapeHtml(displayValue)}</textarea>
                </div>
            `;
        }
    };
    
    // Define field types for rendering
    const fieldTypes = {
        'description': 'textarea',
        'longDescription': 'textarea',
        'shortDescription': 'string',
        'notes': 'textarea',
        'instructions': 'textarea',
        'extracted_text': 'textarea',
        'tags': 'array',
        'topics': 'array',
        'speakers': 'array',
        'keyPoints': 'list',
        'actionItems': 'list',
        'functions': 'array',
        'dependencies': 'array',
        'entities': 'array',
        'keyFields': 'array',
        'visible_urls': 'array',
        'storyBeats': 'list'
    };
    
    // Render fields based on schema
    schema.fields.forEach(fieldKey => {
        const label = schema.labels[fieldKey] || fieldKey.charAt(0).toUpperCase() + fieldKey.slice(1).replace(/([A-Z])/g, ' $1');
        const value = metadata[fieldKey];
        const type = fieldTypes[fieldKey] || 'string';
        const renderer = fieldRenderers[type] || fieldRenderers['string'];
        
        html += renderer(fieldKey, label, value);
    });
    
    return html;
}

// Get metadata schema for asset type
function getMetadataSchemaForType(item) {
    const type = item.fileType || item.fileCategory || item.type;
    
    // Define schemas with type-specific fields
    const schemas = {
        'video': {
            fields: ['title', 'shortDescription', 'longDescription', 'category', 'topics', 'speakers', 'keyPoints', 'targetAudience', 'tags', 'notes'],
            labels: {
                'shortDescription': 'Short Description',
                'longDescription': 'Long Description', 
                'category': 'Video Type',
                'keyPoints': 'Key Points',
                'targetAudience': 'Target Audience'
            }
        },
        'audio': {
            fields: ['title', 'description', 'audioType', 'topics', 'speakers', 'keyPoints', 'genre', 'tags', 'notes'],
            labels: {
                'audioType': 'Audio Type',
                'genre': 'Genre'
            }
        },
        'code': {
            fields: ['title', 'description', 'language', 'purpose', 'functions', 'dependencies', 'complexity', 'tags', 'notes'],
            labels: {
                'language': 'Programming Language',
                'purpose': 'Purpose',
                'functions': 'Functions/Classes',
                'dependencies': 'Dependencies',
                'complexity': 'Complexity Level'
            }
        },
        'pdf': {
            fields: ['title', 'description', 'documentType', 'subject', 'category', 'purpose', 'topics', 'tags', 'notes'],
            labels: {
                'documentType': 'Document Type',
                'subject': 'Subject',
                'category': 'Category',
                'purpose': 'Purpose'
            }
        },
        'data': {
            fields: ['title', 'description', 'dataType', 'format', 'entities', 'keyFields', 'purpose', 'tags', 'notes'],
            labels: {
                'dataType': 'Data Type',
                'format': 'Format',
                'entities': 'Entities',
                'keyFields': 'Key Fields',
                'purpose': 'Purpose'
            }
        },
        'image': {
            fields: ['title', 'description', 'category', 'extracted_text', 'visible_urls', 'app_detected', 'instructions', 'tags', 'notes'],
            labels: {
                'category': 'Image Type',
                'extracted_text': 'Extracted Text',
                'visible_urls': 'Visible URLs',
                'app_detected': 'App/Source',
                'instructions': 'Usage Instructions'
            }
        },
        'html': {
            fields: ['title', 'description', 'documentType', 'topics', 'keyPoints', 'author', 'source', 'tags', 'notes'],
            labels: {
                'documentType': 'Document Type',
                'keyPoints': 'Key Points',
                'author': 'Author',
                'source': 'Source'
            }
        },
        'url': {
            fields: ['title', 'description', 'urlType', 'platform', 'topics', 'category', 'purpose', 'tags', 'notes'],
            labels: {
                'urlType': 'URL Type',
                'platform': 'Platform/Website',
                'category': 'Category',
                'purpose': 'Purpose'
            }
        }
    };
    
    // Add TEXT schema
    schemas.text = {
        fields: ['title', 'description', 'contentType', 'topics', 'keyPoints', 'actionItems', 'tags', 'notes'],
        labels: {
            'contentType': 'Content Type',
            'keyPoints': 'Key Points',
            'actionItems': 'Action Items'
        }
    };
    
    // Match item type to schema
    if (type === 'video' || item.fileCategory === 'video') return schemas.video;
    if (type === 'audio' || item.fileCategory === 'audio') return schemas.audio;
    if (item.fileCategory === 'code' || item.source === 'code') return schemas.code;
    if (type === 'pdf' || item.fileExt === '.pdf') return schemas.pdf;
    if (item.fileCategory === 'data' || ['.json', '.csv', '.yaml'].includes(item.fileExt)) return schemas.data;
    if (item.type === 'image' || item.isScreenshot) return schemas.image;
    if (item.type === 'html' || item.html) return schemas.html;
    // URL detection - single URL with no spaces
    if (item.content && item.content.trim().match(/^https?:\/\/[^\s]+$/)) return schemas.url;
    if (item.type === 'text') return schemas.text;
    
    // Default: basic schema
    return {
        fields: ['title', 'description', 'tags', 'notes'],
        labels: {}
    };
}

// Show metadata modal with DYNAMIC fields based on asset type
async function showMetadataModal(itemId) {
    const modal = document.getElementById('metadataModal');

    // Get current metadata AND item
    const result = await window.clipboard.getMetadata(itemId);
    
    if (!result.success) {
        alert('Could not load metadata');
        return;
    }
    
    const metadata = result.metadata;
    const item = history.find(h => h.id === itemId);
    
    if (!item) {
        alert('Item not found');
        return;
    }
    
    // Get schema for this asset type
    const schema = getMetadataSchemaForType(item);
    
    // Build dynamic form fields
    const dynamicFields = buildDynamicMetadataFields(metadata, schema);
    
    // Insert dynamic fields into modal
    const dynamicContainer = document.getElementById('dynamicMetadataFields');
    if (dynamicContainer) {
        dynamicContainer.innerHTML = dynamicFields;
    }
    
    // Store schema for save
    modal.dataset.itemId = itemId;
    modal.dataset.schema = JSON.stringify(schema);
    
    // Update header with asset info
    const assetType = item.fileCategory || item.fileType || item.type;
    const typeConfig = {
        'video': { icon: '🎬', name: 'Video', color: '#8b5cf6' },
        'audio': { icon: '🎵', name: 'Audio', color: '#f59e0b' },
        'code': { icon: '💻', name: 'Code', color: '#10b981' },
        'pdf': { icon: '📄', name: 'PDF', color: '#ef4444' },
        'data': { icon: '📊', name: 'Data', color: '#06b6d4' },
        'image': { icon: '🖼️', name: 'Image', color: '#ec4899' },
        'html': { icon: '🗂️', name: 'Document', color: '#6366f1' },
        'url': { icon: '🌐', name: 'Web Link', color: '#3b82f6' },
        'text': { icon: '📝', name: 'Text', color: '#64748b' },
        'file': { icon: '📁', name: 'File', color: '#78716c' }
    };
    
    const config = typeConfig[assetType] || typeConfig['file'];
    
    // Update header - with null checks
    const assetIconEl = document.getElementById('metadataAssetIcon');
    const titleEl = document.getElementById('metadataTitle');
    const typeBadgeEl = document.getElementById('metadataTypeBadge');
    const fileNameEl = document.getElementById('metadataFileName');
    
    if (assetIconEl) assetIconEl.textContent = config.icon;
    if (titleEl) titleEl.textContent = metadata.title || item.fileName || 'Untitled';
    if (typeBadgeEl) typeBadgeEl.textContent = config.name;
    if (fileNameEl) fileNameEl.textContent = item.fileName || '';
    
    // Update tags display
    const tagsSection = document.getElementById('tagsDisplaySection');
    const tagsContainer = document.getElementById('metadataTagsDisplay');
    if (tagsSection && tagsContainer) {
        const tags = metadata.tags || [];
        if (tags.length > 0) {
            tagsSection.style.display = 'block';
            tagsContainer.innerHTML = tags.map(tag => 
                `<span class="metadata-tag">${escapeHtml(tag)}</span>`
            ).join('');
        } else {
            tagsSection.style.display = 'none';
        }
    }
    
    // Reset to first tab
    switchMetadataTab('details');
    
    // Setup tab handlers
    document.querySelectorAll('.metadata-tab').forEach(tab => {
        tab.onclick = () => switchMetadataTab(tab.dataset.tab);
    });
    
    // Setup close button
    document.getElementById('metadataCloseBtn').onclick = hideMetadataModal;
    
    // Handle transcript tab for video/audio
    const transcriptTab = document.getElementById('transcriptTab');
    const transcriptTextarea = document.getElementById('metaTranscript');
    const transcriptInfo = document.getElementById('metaTranscriptInfo');
    const fetchTranscriptBtn = document.getElementById('fetchTranscriptBtn');
    const copyTranscriptBtn = document.getElementById('copyTranscriptBtn');
    
    // Check if this is a video/audio item
    const isMedia = item && (
        item.fileCategory === 'video' || 
        item.fileCategory === 'audio' ||
        item.fileType?.startsWith('video/') ||
        item.fileType?.startsWith('audio/')
    );
    const isYouTube = metadata.source === 'youtube' || metadata.youtubeUrl;
    
    // Show/hide transcript tab
    if (transcriptTab) {
        transcriptTab.style.display = isMedia ? 'block' : 'none';
    }
    
    if (isMedia && transcriptTextarea) {
        
        // Try to load transcript
        const transcriptResult = await window.clipboard.getTranscription(itemId);
        
        // Store transcript data for toggle
        let plainTranscript = '';
        let timecodedTranscript = '';
        
        if (transcriptResult.success && transcriptResult.hasTranscription) {
            plainTranscript = transcriptResult.transcription;
            
            // Generate timecoded version if segments available
            if (transcriptResult.segments && transcriptResult.segments.length > 0) {
                timecodedTranscript = transcriptResult.segments.map(seg => 
                    `[${seg.startFormatted || formatSegmentTime(seg.start)}] ${seg.text}`
                ).join('\n');
            } else if (metadata.transcript?.segments?.length > 0) {
                // Try from metadata
                timecodedTranscript = metadata.transcript.segments.map(seg => 
                    `[${seg.startFormatted || formatSegmentTime(seg.start)}] ${seg.text}`
                ).join('\n');
            }
            
            // Helper to format time
            function formatSegmentTime(seconds) {
                const h = Math.floor(seconds / 3600);
                const m = Math.floor((seconds % 3600) / 60);
                const s = Math.floor(seconds % 60);
                const ms = Math.floor((seconds % 1) * 1000);
                return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
            }
            
            // Default to plain text
            transcriptTextarea.value = plainTranscript;
            
            // Show info about the transcript
            let infoText = `${transcriptResult.transcription.length.toLocaleString()} characters`;
            if (transcriptResult.source === 'youtube') {
                infoText += ' • From YouTube captions';
                if (transcriptResult.isAutoGenerated) infoText += ' (auto-generated)';
                if (transcriptResult.language) infoText += ` • ${transcriptResult.language}`;
            } else if (transcriptResult.source === 'whisper') {
                infoText += ' • Transcribed with Whisper';
            }
            if (timecodedTranscript) {
                infoText += ' • Timecodes available';
            }
            transcriptInfo.textContent = infoText;
            fetchTranscriptBtn.style.display = 'none';
            
            // Set up timecode toggle
            const timecodeToggle = document.getElementById('showTimecodeToggle');
            if (timecodeToggle && timecodedTranscript) {
                timecodeToggle.disabled = false;
                timecodeToggle.onchange = () => {
                    if (timecodeToggle.checked) {
                        transcriptTextarea.value = timecodedTranscript;
                    } else {
                        transcriptTextarea.value = plainTranscript;
                    }
                };
            } else if (timecodeToggle) {
                timecodeToggle.disabled = true;
            }
        } else {
            transcriptTextarea.value = '';
            transcriptTextarea.placeholder = 'No transcript available';
            transcriptInfo.textContent = isYouTube ? 'YouTube transcript not fetched yet' : 'No transcript available';
            
            // Show fetch button for YouTube videos
            if (isYouTube) {
                fetchTranscriptBtn.style.display = 'inline-block';
                fetchTranscriptBtn.onclick = async () => {
                    fetchTranscriptBtn.disabled = true;
                    fetchTranscriptBtn.textContent = 'Fetching...';
                    transcriptInfo.textContent = 'Fetching transcript from YouTube...';
                    
                    try {
                        const fetchResult = await window.youtube.fetchTranscriptForItem(itemId);
                        if (fetchResult.success) {
                            transcriptTextarea.value = fetchResult.transcription;
                            transcriptInfo.textContent = `${fetchResult.transcription.length.toLocaleString()} characters • From YouTube captions`;
                            fetchTranscriptBtn.style.display = 'none';
                        } else {
                            transcriptInfo.textContent = 'Error: ' + fetchResult.error;
                            fetchTranscriptBtn.textContent = 'Retry';
                            fetchTranscriptBtn.disabled = false;
                        }
                    } catch (e) {
                        transcriptInfo.textContent = 'Error: ' + e.message;
                        fetchTranscriptBtn.textContent = 'Retry';
                        fetchTranscriptBtn.disabled = false;
                    }
                };
            } else {
                fetchTranscriptBtn.style.display = 'none';
            }
        }
        
        // Copy button handler
        if (copyTranscriptBtn) {
            copyTranscriptBtn.onclick = () => {
                const text = transcriptTextarea.value;
                if (text) {
                    navigator.clipboard.writeText(text);
                    copyTranscriptBtn.textContent = '✓ Copied!';
                    setTimeout(() => { copyTranscriptBtn.textContent = '📋 Copy'; }, 2000);
                }
            };
        }
        
        // Extract Audio button - show for video files
        const extractAudioBtn = document.getElementById('extractAudioBtn');
        const isVideo = item?.fileCategory === 'video' || item?.fileType?.startsWith('video/');
        if (isVideo && extractAudioBtn) {
            // Check if audio already extracted
            if (metadata.audioPath) {
                extractAudioBtn.textContent = '🎵 Download Audio';
                extractAudioBtn.style.display = 'inline-block';
                extractAudioBtn.onclick = () => {
                    // Open file in finder/downloads
                    if (window.electron?.shell?.showItemInFolder) {
                        window.electron.shell.showItemInFolder(metadata.audioPath);
                    } else {
                        alert('Audio file saved at: ' + metadata.audioPath);
                    }
                };
            } else {
                extractAudioBtn.textContent = '🎵 Extract Audio';
                extractAudioBtn.style.display = 'inline-block';
                extractAudioBtn.onclick = async () => {
                    extractAudioBtn.disabled = true;
                    extractAudioBtn.textContent = '⏳ 0%';
                    
                    // Set up progress listener
                    let removeProgressListener = null;
                    if (window.clipboard.onAudioExtractProgress) {
                        removeProgressListener = window.clipboard.onAudioExtractProgress((data) => {
                            if (data.itemId === itemId) {
                                extractAudioBtn.textContent = `⏳ ${data.percent}%`;
                            }
                        });
                    }
                    
                    try {
                        const result = await window.clipboard.extractAudio(itemId);
                        
                        // Clean up listener
                        if (removeProgressListener) removeProgressListener();
                        
                        if (result.success) {
                            extractAudioBtn.textContent = '✅ Audio Ready';
                            extractAudioBtn.style.background = 'rgba(34, 197, 94, 0.6)';
                            
                            // Update button to download
                            setTimeout(() => {
                                extractAudioBtn.textContent = '🎵 Download Audio';
                                extractAudioBtn.style.background = '';
                                extractAudioBtn.disabled = false;
                                extractAudioBtn.onclick = () => {
                                    if (window.electron?.shell?.showItemInFolder) {
                                        window.electron.shell.showItemInFolder(result.audioPath);
                                    } else {
                                        alert('Audio file saved at: ' + result.audioPath);
                                    }
                                };
                            }, 2000);
                        } else {
                            extractAudioBtn.textContent = '❌ Failed';
                            alert('Error: ' + result.error);
                            setTimeout(() => {
                                extractAudioBtn.textContent = '🎵 Extract Audio';
                                extractAudioBtn.disabled = false;
                            }, 2000);
                        }
                    } catch (e) {
                        // Clean up listener
                        if (removeProgressListener) removeProgressListener();
                        
                        extractAudioBtn.textContent = '❌ Error';
                        alert('Error: ' + e.message);
                        setTimeout(() => {
                            extractAudioBtn.textContent = '🎵 Extract Audio';
                            extractAudioBtn.disabled = false;
                        }, 2000);
                    }
                };
            }
        } else if (extractAudioBtn) {
            extractAudioBtn.style.display = 'none';
        }
        
        // Identify Speakers button - show if there's a transcript
        const identifySpeakersBtn = document.getElementById('identifySpeakersBtn');
        if (transcriptResult.success && transcriptResult.hasTranscription) {
            identifySpeakersBtn.style.display = 'inline-block';
            identifySpeakersBtn.onclick = async () => {
                console.log('[SpeakerID-UI] Button clicked!');
                const currentTranscript = transcriptTextarea.value;
                if (!currentTranscript) {
                    console.log('[SpeakerID-UI] No transcript to process');
                    return;
                }
                
                console.log('[SpeakerID-UI] Transcript length:', currentTranscript.length);
                
                identifySpeakersBtn.disabled = true;
                identifySpeakersBtn.textContent = '⏳ Analyzing...';
                transcriptInfo.textContent = 'AI is analyzing the transcript to identify speakers...';
                
                try {
                    // Get rich context from video metadata to help identify speakers
                    let contextHint = '';
                    
                    // YouTube/video metadata
                    if (metadata.title) contextHint += `VIDEO TITLE: ${metadata.title}\n`;
                    if (metadata.uploader) contextHint += `CHANNEL/UPLOADER: ${metadata.uploader}\n`;
                    if (metadata.youtubeId) contextHint += `YOUTUBE ID: ${metadata.youtubeId}\n`;
                    
                    // Full description is very helpful for identifying speakers
                    if (metadata.description) {
                        contextHint += `\nVIDEO DESCRIPTION:\n${metadata.description}\n`;
                    }
                    
                    // Tags can provide context
                    if (metadata.tags && metadata.tags.length > 0) {
                        contextHint += `\nTAGS: ${metadata.tags.join(', ')}\n`;
                    }
                    
                    // Any AI-generated description
                    if (metadata.aiDescription) {
                        contextHint += `\nAI-GENERATED CONTEXT:\n${metadata.aiDescription}\n`;
                    }
                    
                    // Notes from user
                    if (metadata.notes) {
                        contextHint += `\nUSER NOTES: ${metadata.notes}\n`;
                    }
                    
                    console.log('[SpeakerID-UI] Context hint length:', contextHint.length);
                    
                    console.log('[SpeakerID-UI] Calling identifySpeakers IPC...');
                    
                    // Set up progress listener
                    let removeProgressListener = null;
                    if (window.clipboard.onSpeakerIdProgress) {
                        removeProgressListener = window.clipboard.onSpeakerIdProgress((progress) => {
                            console.log('[SpeakerID-UI] Progress:', progress.status);
                            
                            // Update status text
                            if (progress.chunk && progress.total) {
                                const pct = Math.round((progress.chunk / progress.total) * 100);
                                identifySpeakersBtn.textContent = `⏳ ${pct}%`;
                                transcriptInfo.textContent = progress.status;
                            } else {
                                transcriptInfo.textContent = progress.status;
                            }
                            
                            // Show partial results as they come in
                            if (progress.partialResult) {
                                transcriptTextarea.value = progress.partialResult;
                            }
                        });
                    }
                    
                    const result = await window.clipboard.identifySpeakers({
                        itemId: itemId,
                        transcript: currentTranscript,
                        contextHint: contextHint
                    });
                    
                    // Clean up progress listener
                    if (removeProgressListener) removeProgressListener();
                    
                    console.log('[SpeakerID-UI] Got result:', result?.success, result?.error);
                    
                    if (result.success) {
                        transcriptTextarea.value = result.transcript;
                        transcriptInfo.textContent = `Speakers identified with ${result.model} • ${result.transcript.length.toLocaleString()} characters`;
                        identifySpeakersBtn.textContent = '✓ Done';
                        identifySpeakersBtn.style.background = 'rgba(34, 197, 94, 0.6)';
                        setTimeout(() => {
                            identifySpeakersBtn.textContent = '✨ Re-analyze';
                            identifySpeakersBtn.style.background = '';
                            identifySpeakersBtn.disabled = false;
                        }, 3000);
                    } else {
                        transcriptInfo.textContent = 'Error: ' + result.error;
                        identifySpeakersBtn.textContent = '✨ Retry';
                        identifySpeakersBtn.disabled = false;
                    }
                } catch (e) {
                    console.error('[SpeakerID] Error:', e);
                    transcriptInfo.textContent = 'Error: ' + e.message;
                    identifySpeakersBtn.textContent = '✨ Retry';
                    identifySpeakersBtn.disabled = false;
                }
            };
        } else if (identifySpeakersBtn) {
            identifySpeakersBtn.style.display = 'none';
        }
    }
    
    // AI fields - with null checks for missing elements
    const aiGenerated = document.getElementById('metaAiGenerated');
    const aiAssisted = document.getElementById('metaAiAssisted');
    const aiModel = document.getElementById('metaAiModel');
    const aiProvider = document.getElementById('metaAiProvider');
    const aiPrompt = document.getElementById('metaAiPrompt');
    const aiContext = document.getElementById('metaAiContext');
    
    if (aiGenerated) aiGenerated.checked = metadata.ai_generated || false;
    if (aiAssisted) aiAssisted.checked = metadata.ai_assisted || false;
    if (aiModel) aiModel.value = metadata.ai_model || '';
    if (aiProvider) aiProvider.value = metadata.ai_provider || '';
    if (aiPrompt) aiPrompt.value = metadata.ai_prompt || '';
    if (aiContext) aiContext.value = metadata.ai_context || '';
    
    // Read-only fields - with null checks
    const dateCreatedEl = document.getElementById('metaDateCreated');
    const authorEl = document.getElementById('metaAuthor');
    const versionEl = document.getElementById('metaVersion');
    const idEl = document.getElementById('metaId');
    
    if (dateCreatedEl) dateCreatedEl.textContent = metadata.dateCreated ? new Date(metadata.dateCreated).toLocaleString() : 'Unknown';
    if (authorEl) authorEl.textContent = metadata.author || 'Unknown';
    if (versionEl) versionEl.textContent = metadata.version || '1.0.0';
    if (idEl) idEl.textContent = metadata.id || itemId;
    
    // Set source/context fields
    const sourceEl = document.getElementById('metaSource');
    const contextEl = document.getElementById('metaContext');
    
    if (sourceEl) {
        sourceEl.value = metadata.source || item.source || '';
    }
    
    if (contextEl) {
        if (metadata.context && metadata.context.contextDisplay) {
            contextEl.value = metadata.context.contextDisplay;
        } else if (metadata.ai_context) {
            contextEl.value = metadata.ai_context;
        } else {
            contextEl.value = '';
        }
    }
    
    // Show modal
    modal.style.display = 'flex';
}

// Hide metadata modal
function hideMetadataModal() {
    document.getElementById('metadataModal').style.display = 'none';
}

// Switch metadata modal tab
function switchMetadataTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('.metadata-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabName);
    });
    
    // Update tab panels
    document.querySelectorAll('.metadata-tab-panel').forEach(panel => {
        panel.classList.remove('active');
    });
    
    const targetPanel = document.getElementById('tab' + tabName.charAt(0).toUpperCase() + tabName.slice(1));
    if (targetPanel) {
        targetPanel.classList.add('active');
    }
}

// Toggle transcript section expanded/collapsed
function toggleTranscriptSection() {
    const content = document.getElementById('transcriptContent');
    const icon = document.getElementById('transcriptToggleIcon');
    const preview = document.getElementById('transcriptPreview');
    
    if (content.style.display === 'none') {
        content.style.display = 'block';
        icon.style.transform = 'rotate(90deg)';
        preview.style.display = 'none';
    } else {
        content.style.display = 'none';
        icon.style.transform = 'rotate(0deg)';
        preview.style.display = 'inline';
    }
}

// Save metadata from DYNAMIC fields
async function saveMetadata() {
    // #region agent log
    fetch('http://127.0.0.1:7246/ingest/135f91ed-6c73-4b7b-94fb-e5a12a4650b9',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'clipboard-viewer.js:saveMetadata:start',message:'Starting metadata save',data:{},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'SAVE'})}).catch(()=>{});
    // #endregion
    
    const modal = document.getElementById('metadataModal');
    const itemId = modal.dataset.itemId;
    
    // #region agent log
    fetch('http://127.0.0.1:7246/ingest/135f91ed-6c73-4b7b-94fb-e5a12a4650b9',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'clipboard-viewer.js:saveMetadata:itemId',message:'Got itemId',data:{itemId,hasModal:!!modal,datasetSchema:modal?.dataset?.schema?.substring(0,100)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'SAVE'})}).catch(()=>{});
    // #endregion
    
    let schema;
    try {
        schema = JSON.parse(modal.dataset.schema || '{"fields":[]}');
    } catch (parseError) {
        // #region agent log
        fetch('http://127.0.0.1:7246/ingest/135f91ed-6c73-4b7b-94fb-e5a12a4650b9',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'clipboard-viewer.js:saveMetadata:schemaParseError',message:'Schema parse failed',data:{error:parseError.message,schemaString:modal?.dataset?.schema?.substring(0,200)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'SAVE'})}).catch(()=>{});
        // #endregion
        schema = {fields: []};
    }

    // Collect all dynamic field values
    const updates = {};
    
    document.querySelectorAll('.dynamic-field').forEach(field => {
        const key = field.dataset.field;
        let value = field.value.trim();
        
        // Parse based on field type
        if (key === 'tags' || key === 'topics' || key === 'speakers' || key === 'dependencies' || key === 'functions' || key === 'entities' || key === 'keyFields' || key === 'visible_urls') {
            // Array fields (comma-separated)
            updates[key] = value ? value.split(',').map(v => v.trim()).filter(v => v) : [];
        } else if (key === 'keyPoints' || key === 'actionItems' || key === 'storyBeats') {
            // List fields (line-separated)
            updates[key] = value ? value.split('\n').map(v => v.trim()).filter(v => v) : [];
        } else {
            // String fields
            updates[key] = value;
        }
    });

    console.log('[SaveMetadata] Saving dynamic fields:', updates);
    
    // #region agent log
    fetch('http://127.0.0.1:7246/ingest/135f91ed-6c73-4b7b-94fb-e5a12a4650b9',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'clipboard-viewer.js:saveMetadata:dynamicFields',message:'Collected dynamic fields',data:{fieldCount:Object.keys(updates).length,fields:Object.keys(updates)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'SAVE'})}).catch(()=>{});
    // #endregion

    // Legacy field fallback (if no dynamic fields)
    if (Object.keys(updates).length === 0) {
        // Parse tags/topics
        const tagsInput = document.getElementById('metaTags')?.value?.split(',').map(t => t.trim()).filter(t => t) || [];

        const speakersInput = document.getElementById('metaSpeakers')?.value?.split(',').map(s => s.trim()).filter(s => s) || [];
        const storyBeatsInput = document.getElementById('metaStoryBeats')?.value?.split('\n').map(b => b.trim()).filter(b => b) || [];
        
        updates.title = document.getElementById('metaTitle')?.value || '';
        updates.description = document.getElementById('metaDescription')?.value || '';
        updates.notes = document.getElementById('metaNotes')?.value || '';
        updates.instructions = document.getElementById('metaInstructions')?.value || '';
        updates.tags = tagsInput;
        updates.source = document.getElementById('metaSource')?.value || '';
        if (speakersInput.length > 0) updates.speakers = speakersInput;
        if (storyBeatsInput.length > 0) updates.storyBeats = storyBeatsInput;
        
        // #region agent log
        fetch('http://127.0.0.1:7246/ingest/135f91ed-6c73-4b7b-94fb-e5a12a4650b9',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'clipboard-viewer.js:saveMetadata:legacyFields',message:'Using legacy fields',data:{fieldCount:Object.keys(updates).length,fields:Object.keys(updates)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'SAVE'})}).catch(()=>{});
        // #endregion
    }
    
    // #region agent log
    fetch('http://127.0.0.1:7246/ingest/135f91ed-6c73-4b7b-94fb-e5a12a4650b9',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'clipboard-viewer.js:saveMetadata:beforeSave',message:'About to call updateMetadata',data:{itemId,updateKeys:Object.keys(updates)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'SAVE'})}).catch(()=>{});
    // #endregion
    
    // Save to backend
    try {
        const result = await window.clipboard.updateMetadata(itemId, updates);
        
        // #region agent log
        fetch('http://127.0.0.1:7246/ingest/135f91ed-6c73-4b7b-94fb-e5a12a4650b9',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'clipboard-viewer.js:saveMetadata:result',message:'updateMetadata result',data:{success:result?.success,error:result?.error},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'SAVE'})}).catch(()=>{});
        // #endregion
        
        if (result.success) {
            hideMetadataModal();
            await loadHistory();
            showNotification('✅ Metadata saved');
        } else {
            alert('Failed to save metadata: ' + (result.error || 'Unknown error'));
        }
    } catch (saveError) {
        // #region agent log
        fetch('http://127.0.0.1:7246/ingest/135f91ed-6c73-4b7b-94fb-e5a12a4650b9',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'clipboard-viewer.js:saveMetadata:exception',message:'Save threw exception',data:{error:saveError.message,stack:saveError.stack?.substring(0,500)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'SAVE'})}).catch(()=>{});
        // #endregion
        alert('Error saving metadata: ' + saveError.message);
    }
}

// Generate metadata with AI
async function generateMetadataWithAI() {
    const modal = document.getElementById('metadataModal');
    const itemId = modal.dataset.itemId;
    
    // Get AI prompt from textarea
    const customPrompt = document.getElementById('aiPrompt').value.trim();
    
    // Get API settings
    const settings = await window.api.getSettings();
    if (!settings.llmApiKey) {
        // Update status
        const statusEl = document.getElementById('aiGenerationStatus');
        statusEl.textContent = 'Please configure your API key in Settings first';
        statusEl.style.display = 'block';
        statusEl.style.color = '#ff6464';
        
        // Optionally open settings
        if (confirm('API key required. Open settings now?')) {
            await window.api.send('open-settings');
        }
        return;
    }
    
    // Show loading state
    const generateBtn = document.getElementById('generateMetadataBtn');
    const originalText = generateBtn.textContent;
    generateBtn.textContent = 'Generating...';
    generateBtn.disabled = true;
    
    const statusEl = document.getElementById('aiGenerationStatus');
    statusEl.textContent = 'Analyzing content with AI...';
    statusEl.style.display = 'block';
    statusEl.style.color = 'rgba(255, 255, 255, 0.6)';
    
    try {
        // Call AI generation
        const result = await window.clipboard.generateMetadataAI(
            itemId, 
            settings.llmApiKey,
            customPrompt
        );
        
        if (result.success) {
            // Update DYNAMIC form fields with generated metadata
            const metadata = result.metadata;
            
            console.log('[AI Generate] Generated metadata:', metadata);
            
            // Update all dynamic fields
            document.querySelectorAll('.dynamic-field').forEach(field => {
                const key = field.dataset.field;
                const value = metadata[key];
                
                if (value !== undefined && value !== null) {
                    if (Array.isArray(value)) {
                        // Array fields - join with comma or newline
                        if (key === 'keyPoints' || key === 'actionItems' || key === 'storyBeats') {
                            field.value = value.join('\n');
                        } else {
                            field.value = value.join(', ');
                        }
                    } else {
                        field.value = value;
                    }
                    
                    // Flash this field
                    field.style.transition = 'background-color 0.3s';
                    field.style.backgroundColor = 'rgba(59, 130, 246, 0.2)';
                    setTimeout(() => {
                        field.style.backgroundColor = '';
                    }, 1000);
                }
            });
            
            // Update status
            statusEl.textContent = '✓ Metadata generated successfully! Review and save.';
            statusEl.style.color = '#64ff64';
            
            // Auto-save after a delay (give user time to review)
            setTimeout(() => {
                statusEl.textContent = 'Review the generated metadata and click Save to apply changes.';
            }, 3000);
            
        } else {
            // Show error
            statusEl.textContent = `Error: ${result.error || 'Failed to generate metadata'}`;
            statusEl.style.color = '#ff6464';
        }
    } catch (error) {
        console.error('Error generating metadata:', error);
        statusEl.textContent = `Error: ${error.message || 'Failed to generate metadata'}`;
        statusEl.style.color = '#ff6464';
    } finally {
        // Restore button state
        generateBtn.textContent = originalText;
        generateBtn.disabled = false;
    }
}

// Show copy notification
function showCopyNotification() {
    // Create notification element
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(100, 200, 255, 0.9);
        color: #000;
        padding: 12px 24px;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        z-index: 10000;
        animation: slideUp 0.3s ease;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    `;
    notification.textContent = '✓ Copied to clipboard';
    
    // Add animation keyframes
    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideUp {
            from {
                opacity: 0;
                transform: translate(-50%, 20px);
            }
            to {
                opacity: 1;
                transform: translate(-50%, 0);
            }
        }
    `;
    document.head.appendChild(style);
    
    document.body.appendChild(notification);
    
    // Remove after 2 seconds
    setTimeout(() => {
        notification.style.opacity = '0';
        notification.style.transform = 'translate(-50%, 20px)';
        setTimeout(() => {
            notification.remove();
            style.remove();
        }, 300);
    }, 2000);
}

// Update active space indicator
async function updateActiveSpace() {
    // Get the current active space from clipboard manager
    try {
        const status = await window.clipboard.getActiveSpace();
        activeSpaceId = status.spaceId;
        updateActiveSpaceIndicator();
        updateScreenshotIndicator(); // Also update screenshot indicator
    } catch (error) {
        console.error('Error getting active space:', error);
    }
}

// Update the visual indicator for active space
function updateActiveSpaceIndicator() {
    const indicator = document.getElementById('activeSpaceIndicator');
    const icon = document.getElementById('activeSpaceIcon');
    const label = document.getElementById('activeSpaceLabel');
    
    if (activeSpaceId === null) {
        indicator.classList.remove('visible');
    } else {
        const space = spaces.find(s => s.id === activeSpaceId);
        if (space) {
            icon.textContent = space.icon;
            label.textContent = `Capturing to: ${space.name}`;
            indicator.classList.add('visible');
        } else {
            indicator.classList.remove('visible');
        }
    }
}

// Update screenshot capture indicator
function updateScreenshotIndicator() {
    const indicator = document.getElementById('screenshotIndicator');
    const button = indicator.querySelector('button');
    const statusText = indicator.querySelector('span:nth-child(2)');
    
    if (screenshotCaptureEnabled && activeSpaceId) {
        indicator.style.display = 'flex';
        statusText.textContent = 'Screenshot capture enabled';
        indicator.style.background = 'rgba(100, 255, 100, 0.1)';
        indicator.style.borderBottomColor = 'rgba(100, 255, 100, 0.2)';
        indicator.style.color = '#64ff64';
        button.textContent = 'Disable';
        button.onclick = () => toggleScreenshotCapture(false);
    } else if (screenshotCaptureEnabled && !activeSpaceId) {
        indicator.style.display = 'none'; // Hide if no active space
    } else {
        indicator.style.display = 'flex';
        statusText.textContent = 'Screenshot capture disabled';
        indicator.style.background = 'rgba(255, 100, 100, 0.1)';
        indicator.style.borderBottomColor = 'rgba(255, 100, 100, 0.2)';
        indicator.style.color = '#ff6464';
        button.textContent = 'Enable';
        button.onclick = () => toggleScreenshotCapture(true);
    }
}

// Toggle screenshot capture
async function toggleScreenshotCapture(enable) {
    const result = await window.clipboard.toggleScreenshotCapture(enable);
    if (result.success) {
        screenshotCaptureEnabled = result.enabled;
        updateScreenshotIndicator();
    }
}

// Make toggleScreenshotCapture available globally for onclick
window.toggleScreenshotCapture = toggleScreenshotCapture;

// Setup event listeners
function setupEventListeners() {
    // Window controls
    document.getElementById('closeBtn').addEventListener('click', () => {
        window.close();
    });
    
    document.getElementById('minimizeBtn').addEventListener('click', () => {
        // For now, these controls are decorative
        // The window can be minimized using standard OS controls
    });
    
    document.getElementById('maximizeBtn').addEventListener('click', () => {
        // For now, these controls are decorative
        // The window can be maximized using standard OS controls
    });
    
    // View toggle
    document.querySelectorAll('.view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            setView(btn.dataset.view);
        });
    });
    
    // Search input
    document.getElementById('searchInput').addEventListener('input', (e) => {
        searchItems(e.target.value);
    });
    
    // Filter buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.dataset.filter;
            filterItems();
        });
    });
    
    // Initialize tag filter
    initTagFilter();
    
    // Space selection
    document.getElementById('spacesList').addEventListener('click', async (e) => {
        const spaceItem = e.target.closest('.space-item');
        if (!spaceItem) return;
        
        const action = e.target.closest('[data-action]');
        if (action) {
            e.stopPropagation();
            const spaceId = action.dataset.spaceId;
            
            if (action.dataset.action === 'edit') {
                const space = spaces.find(s => s.id === spaceId);
                if (space) showSpaceModal(space);
            } else if (action.dataset.action === 'delete') {
                if (confirm('Are you sure you want to delete this space? Items will be moved to "All Items".')) {
                    await window.clipboard.deleteSpace(spaceId);
                    await loadSpaces();
                    if (currentSpace === spaceId) {
                        currentSpace = null;
                        await loadHistory();
                    }
                }
            } else if (action.dataset.action === 'notebook') {
                // Open the space's README.ipynb
                await window.clipboard.openSpaceNotebook(spaceId);
            } else if (action.dataset.action === 'pdf') {
                // Export space
                const space = spaces.find(s => s.id === spaceId);
                if (space) handlePDFExport(space);
            }
            return;
        }
        
        // Select space
        const spaceId = spaceItem.dataset.spaceId;
        currentSpace = spaceId === 'null' ? null : spaceId;
        await window.clipboard.setCurrentSpace(currentSpace);
        
        document.querySelectorAll('.space-item').forEach(item => {
            item.classList.remove('active');
        });
        spaceItem.classList.add('active');

        await loadHistory();
        updateTagDropdown(); // Refresh available tags for this space
        filterItems();
    });
    
    // Add space button
    document.getElementById('addSpaceBtn').addEventListener('click', () => {
        showSpaceModal();
    });
    
    // History item double-click to open preview
    document.getElementById('historyList').addEventListener('dblclick', async (e) => {
        const item = e.target.closest('.history-item');
        if (item) {
            e.preventDefault();
            e.stopPropagation();
            const itemId = item.dataset.id;
            await showPreviewModal(itemId);
        }
    });
    
    // History item actions
    document.getElementById('historyList').addEventListener('click', async (e) => {
        // #region agent log
        fetch('http://127.0.0.1:7246/ingest/135f91ed-6c73-4b7b-94fb-e5a12a4650b9',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'clipboard-viewer.js:historyList:click',message:'Click event fired',data:{targetTag:e.target.tagName,targetClass:e.target.className,targetDataAction:e.target.dataset?.action},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'CLICK'})}).catch(()=>{});
        // #endregion
        
        const item = e.target.closest('.history-item');
        if (!item) {
            // #region agent log
            fetch('http://127.0.0.1:7246/ingest/135f91ed-6c73-4b7b-94fb-e5a12a4650b9',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'clipboard-viewer.js:historyList:noItem',message:'No history-item found',data:{},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'CLICK'})}).catch(()=>{});
            // #endregion
            return;
        }

        const action = e.target.closest('[data-action]');
        // #region agent log
        fetch('http://127.0.0.1:7246/ingest/135f91ed-6c73-4b7b-94fb-e5a12a4650b9',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'clipboard-viewer.js:historyList:actionCheck',message:'Action button check',data:{hasAction:!!action,actionType:action?.dataset?.action,itemId:item.dataset.id},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'CLICK'})}).catch(()=>{});
        // #endregion
        
        if (action) {
            e.stopPropagation();
            const actionType = action.dataset.action;
            const itemId = item.dataset.id;
            
            // #region agent log
            fetch('http://127.0.0.1:7246/ingest/135f91ed-6c73-4b7b-94fb-e5a12a4650b9',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'clipboard-viewer.js:historyList:actionDispatch',message:'Dispatching action',data:{actionType,itemId},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'CLICK'})}).catch(()=>{});
            // #endregion
            
            if (actionType === 'preview') {
                await showPreviewModal(itemId);
            } else if (actionType === 'pin') {
                await window.clipboard.togglePin(itemId);
                await loadHistory();
            } else if (actionType === 'copy') {
                // Check if it's an audio file that needs special handling
                const historyItem = history.find(h => h.id === itemId);
                if (historyItem && historyItem.type === 'file' && historyItem.fileType === 'audio') {
                    // Load audio data first
                    try {
                        const audioResult = await window.clipboard.getAudioData(itemId);
                        if (audioResult.success) {
                            // Update the audio element with the data URL
                            const audioElement = document.getElementById(`audio-${itemId}`);
                            if (audioElement) {
                                audioElement.src = audioResult.dataUrl;
                                audioElement.parentElement.style.display = 'block';
                                // Also update the status text
                                const statusElement = item.querySelector('.audio-status');
                                if (statusElement) {
                                    statusElement.textContent = 'Audio loaded - ready to play';
                                    statusElement.style.color = '#64ff64';
                                }
                            }
                        } else {
                            // Show error
                            const statusElement = item.querySelector('.audio-status');
                            if (statusElement) {
                                statusElement.textContent = audioResult.error || 'Failed to load audio';
                                statusElement.style.color = '#ff6464';
                            }
                        }
                    } catch (error) {
                        console.error('Error loading audio:', error);
                        const statusElement = item.querySelector('.audio-status');
                        if (statusElement) {
                            statusElement.textContent = 'Error loading audio file';
                            statusElement.style.color = '#ff6464';
                        }
                    }
                }
                
                // Always use the backend paste handler to ensure consistent plain text copying
                await window.clipboard.pasteItem(itemId);
                // Show a brief notification that item was copied
                showCopyNotification();
            } else if (actionType === 'edit-metadata') {
                // #region agent log
                fetch('http://127.0.0.1:7246/ingest/135f91ed-6c73-4b7b-94fb-e5a12a4650b9',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'clipboard-viewer.js:edit-metadata:before',message:'About to call showMetadataModal',data:{itemId},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'META'})}).catch(()=>{});
                // #endregion
                try {
                    await showMetadataModal(itemId);
                    // #region agent log
                    fetch('http://127.0.0.1:7246/ingest/135f91ed-6c73-4b7b-94fb-e5a12a4650b9',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'clipboard-viewer.js:edit-metadata:after',message:'showMetadataModal completed',data:{itemId},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'META'})}).catch(()=>{});
                    // #endregion
                } catch (err) {
                    // #region agent log
                    fetch('http://127.0.0.1:7246/ingest/135f91ed-6c73-4b7b-94fb-e5a12a4650b9',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'clipboard-viewer.js:edit-metadata:error',message:'showMetadataModal FAILED',data:{itemId,error:err.message,stack:err.stack?.substring(0,500)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'META'})}).catch(()=>{});
                    // #endregion
                    console.error('Metadata modal error:', err);
                }
            } else if (actionType === 'menu') {
                showContextMenu(e, itemId);
            } else if (actionType === 'delete') {
                // Direct delete action (used for error items)
                if (confirm('Delete this item?')) {
                    await window.clipboard.deleteItem(itemId);
                    await loadHistory();
                    await loadSpaces();
                }
            } else if (actionType === 'pdf-prev' || actionType === 'pdf-next') {
                // Handle PDF navigation
                console.log('PDF navigation clicked:', actionType);
                const pdfContainer = e.target.closest('.pdf-preview-container');
                if (!pdfContainer) {
                    console.log('No PDF container found');
                    return;
                }
                
                const currentPage = parseInt(pdfContainer.dataset.currentPage) || 1;
                const totalPages = parseInt(pdfContainer.dataset.totalPages) || 1;
                console.log('Current page:', currentPage, 'Total pages:', totalPages);
                
                let newPage = currentPage;
                if (actionType === 'pdf-prev' && currentPage > 1) {
                    newPage = currentPage - 1;
                } else if (actionType === 'pdf-next' && currentPage < totalPages) {
                    newPage = currentPage + 1;
                }
                
                console.log('New page:', newPage);
                
                if (newPage !== currentPage) {
                    // Update page number
                    pdfContainer.dataset.currentPage = newPage;
                    
                    // Update page info text
                    const pageInfo = pdfContainer.querySelector('.pdf-page-info');
                    if (pageInfo) {
                        pageInfo.textContent = `Page ${newPage} of ${totalPages}`;
                    }
                    
                    // Update button states
                    const prevBtn = pdfContainer.querySelector('.pdf-prev');
                    const nextBtn = pdfContainer.querySelector('.pdf-next');
                    if (prevBtn) prevBtn.disabled = newPage <= 1;
                    if (nextBtn) nextBtn.disabled = newPage >= totalPages;
                    
                    // Update page overlay
                    const overlay = pdfContainer.querySelector('.pdf-page-overlay');
                    const pageNumSpan = pdfContainer.querySelector('.current-page-num');
                    if (overlay && pageNumSpan) {
                        pageNumSpan.textContent = newPage;
                        // Show overlay for pages other than 1
                        overlay.style.display = newPage !== 1 ? 'flex' : 'none';
                    }
                    
                    // Show loading
                    const loading = pdfContainer.querySelector('.pdf-loading');
                    if (loading) loading.style.display = 'block';
                    
                    // Request thumbnail for new page (will show page 1 thumbnail due to limitation)
                    try {
                        console.log('Requesting PDF thumbnail for item:', itemId, 'page:', newPage);
                        const pdfThumbnail = await window.clipboard.getPDFPageThumbnail(itemId, newPage);
                        console.log('PDF thumbnail result:', pdfThumbnail);
                        if (pdfThumbnail.success) {
                            const img = pdfContainer.querySelector('.pdf-thumbnail');
                            if (img) {
                                // Keep the same thumbnail since we can only show page 1
                                // The overlay will indicate which page we're viewing
                                console.log('Updated PDF thumbnail (showing page 1 preview)');
                            }
                        }
                    } catch (error) {
                        console.error('Error loading PDF page:', error);
                    } finally {
                        if (loading) loading.style.display = 'none';
                    }
                } else {
                    console.log('Page did not change');
                }
            }
        } else {
            // Handle click on item itself
            const itemId = item.dataset.id;
            
            // Check if it's an audio file that needs special handling
            const historyItem = history.find(h => h.id === itemId);
            if (historyItem && historyItem.type === 'file' && historyItem.fileType === 'audio') {
                // For audio files, just load them for playback instead of pasting
                try {
                    const audioResult = await window.clipboard.getAudioData(itemId);
                    if (audioResult.success) {
                        // Update the audio element with the data URL
                        const audioElement = document.getElementById(`audio-${itemId}`);
                        if (audioElement) {
                            audioElement.src = audioResult.dataUrl;
                            audioElement.parentElement.style.display = 'block';
                            // Also update the status text
                            const statusElement = item.querySelector('.audio-status');
                            if (statusElement) {
                                statusElement.textContent = 'Audio loaded - ready to play';
                                statusElement.style.color = '#64ff64';
                            }
                            // Don't close window for audio files
                            return;
                        }
                    } else {
                        // Show error
                        const statusElement = item.querySelector('.audio-status');
                        if (statusElement) {
                            statusElement.textContent = audioResult.error || 'Failed to load audio';
                            statusElement.style.color = '#ff6464';
                        }
                        return;
                    }
                } catch (error) {
                    console.error('Error loading audio:', error);
                    const statusElement = item.querySelector('.audio-status');
                    if (statusElement) {
                        statusElement.textContent = 'Error loading audio file';
                        statusElement.style.color = '#ff6464';
                    }
                    return;
                }
            }
            
            // Check if it's a generated document
            if (historyItem && historyItem.type === 'generated-document') {
                // For generated documents, copy the HTML content and don't close
                const htmlContent = historyItem.content || historyItem.html;
                if (htmlContent) {
                    // Create a temporary div to convert HTML to rich text
                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = htmlContent;
                    
                    // Copy as both HTML and plain text
                    const selection = window.getSelection();
                    const range = document.createRange();
                    document.body.appendChild(tempDiv);
                    range.selectNodeContents(tempDiv);
                    selection.removeAllRanges();
                    selection.addRange(range);
                    
                    try {
                        document.execCommand('copy');
                        showCopyNotification();
                        // Don't close for generated documents - user might want to explore
                    } catch (err) {
                        console.error('Failed to copy generated document:', err);
                        // Fallback to regular paste
                        await window.clipboard.pasteItem(itemId);
                        window.close();
                    } finally {
                        selection.removeAllRanges();
                        document.body.removeChild(tempDiv);
                    }
                } else {
                    // Fallback to regular paste
                    await window.clipboard.pasteItem(itemId);
                    window.close();
                }
            } else {
                // For other items, paste and close
                await window.clipboard.pasteItem(itemId);
                window.close();
            }
        }
    });
    
    // Context menu actions
    document.getElementById('contextMenu').addEventListener('click', async (e) => {
        const action = e.target.closest('[data-action]');
        if (!action || !contextMenuItem) return;
        
        if (action.dataset.action === 'move-to-space') {
            // Show a custom space selection modal instead of using prompt
            showMoveToSpaceModal(contextMenuItem);
        } else if (action.dataset.action === 'edit-metadata') {
            await showMetadataModal(contextMenuItem);
        } else if (action.dataset.action === 'show-in-finder') {
            await window.clipboard.showItemInFinder(contextMenuItem);
        } else if (action.dataset.action === 'pin') {
            await window.clipboard.togglePin(contextMenuItem);
            await loadHistory();
        } else if (action.dataset.action === 'delete') {
            await window.clipboard.deleteItem(contextMenuItem);
            await loadHistory();
            // Force refresh spaces to ensure counts are updated
            await loadSpaces();
        }
        
        hideContextMenu();
    });
    
    // Icon picker
    document.getElementById('iconPicker').addEventListener('click', (e) => {
        const option = e.target.closest('.icon-option');
        if (!option) return;
        
        document.querySelectorAll('.icon-option').forEach(opt => {
            opt.classList.remove('selected');
        });
        option.classList.add('selected');
    });
    
    // Modal buttons
    document.getElementById('modalSave').addEventListener('click', async () => {
        const name = document.getElementById('spaceName').value.trim();
        if (!name) {
            alert('Please enter a space name');
            return;
        }
        
        const icon = document.querySelector('.icon-option.selected').dataset.icon;
        const spaceId = document.getElementById('spaceModal').dataset.spaceId;
        
        // Collect notebook data
        const notebook = {
            description: document.getElementById('spaceDescription').value.trim(),
            objective: document.getElementById('spaceObjective').value.trim(),
            instructions: document.getElementById('spaceInstructions').value.trim(),
            tags: document.getElementById('spaceTags').value.split(',').map(t => t.trim()).filter(t => t),
            links: document.getElementById('spaceLinks').value.split('\n').map(l => l.trim()).filter(l => l),
            author: await window.clipboard.getCurrentUser(),
            createdAt: spaceId ? undefined : new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        
        if (spaceId) {
            // Update existing space
            await window.clipboard.updateSpace(spaceId, { name, icon, notebook });
        } else {
            // Create new space
            await window.clipboard.createSpace({ name, icon, notebook });
        }
        
        hideSpaceModal();
        await loadSpaces();
    });
    
    document.getElementById('modalCancel').addEventListener('click', hideSpaceModal);
    
    // Metadata modal buttons
    document.getElementById('metadataSave').addEventListener('click', saveMetadata);
    document.getElementById('metadataCancel').addEventListener('click', hideMetadataModal);
    document.getElementById('generateMetadataBtn').addEventListener('click', generateMetadataWithAI);
    
    // Listen for updates
    window.clipboard.onHistoryUpdate(async (updatedHistory) => {
        history = updatedHistory;
        updateTagDropdown(); // Refresh available tags
        filterItems();
        await updateItemCounts();
    });
    
    // Listen for spaces updates - set up the listener directly
    window.electron.on('clipboard:spaces-updated', async (event, updatedSpaces) => {
        console.log('Spaces updated:', updatedSpaces);
        spaces = updatedSpaces;
        renderSpaces();
        await updateItemCounts();
    });
    
    // Keyboard shortcuts
    document.addEventListener('keydown', async (e) => {
        // Cmd+V / Ctrl+V - Paste into current space or show space chooser
        if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
            // Don't intercept if user is typing in an input field
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
                return;
            }
            
            e.preventDefault();
            
            // If a space is selected, paste directly into it
            if (currentSpace) {
                const spaceName = spaces.find(s => s.id === currentSpace)?.name || 'Current Space';
                console.log('[Keyboard Paste] Pasting into current space:', currentSpace, spaceName);
                
                try {
                    await pasteIntoSpace(currentSpace);
                } catch (error) {
                    console.error('[Keyboard Paste] Error:', error);
                    showNotification('❌ Failed to paste: ' + error.message);
                }
            } else {
                // No space selected - show space chooser
                console.log('[Keyboard Paste] No space selected, showing chooser');
                showPasteToSpaceModal();
            }
            return;
        }
        
        // Escape key handling
        if (e.key === 'Escape') {
            if (document.getElementById('metadataModal').style.display === 'flex') {
                hideMetadataModal();
            } else if (document.getElementById('spaceModal').style.display === 'flex') {
                hideSpaceModal();
            } else if (document.getElementById('contextMenu').style.display === 'block') {
                hideContextMenu();
            } else {
                window.close();
            }
        }
    });
    
    // Click outside to close context menu
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#contextMenu')) {
            hideContextMenu();
        }
    });
    
    // Listen for spaces toggle from main process
    window.clipboard.onSpacesToggled = (callback) => {
        window.electron.on('clipboard:spaces-toggled', (event, enabled) => {
            spacesEnabled = enabled;
            updateSpacesVisibility();
            
            // If spaces were disabled, reload history to show all items
            if (!enabled && currentSpace !== null) {
                currentSpace = null;
                loadHistory();
            }
        });
    };
    
    // Initialize spaces toggle listener
    window.clipboard.onSpacesToggled();
    
    // Listen for active space changes from main process
    window.clipboard.onActiveSpaceChanged = (callback) => {
        window.electron.on('clipboard:active-space-changed', (event, data) => {
            activeSpaceId = data.spaceId;
            updateActiveSpaceIndicator();
            updateScreenshotIndicator(); // Update screenshot indicator too
        });
    };
    
    // Initialize active space listener
    window.clipboard.onActiveSpaceChanged();
    
    // Initialize spaces update listener
    window.clipboard.onSpacesUpdate();
    
    // Listen for screenshot capture toggle events
    window.electron.on('clipboard:screenshot-capture-toggled', (event, enabled) => {
        screenshotCaptureEnabled = enabled;
        updateScreenshotIndicator();
    });
    
    // Listen for screenshot space selection
    window.electron.on('clipboard:select-space-for-screenshot', async (data) => {
        const { screenshotPath, fileName } = data;
        
        // Show modal to select space
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.style.display = 'flex';
        
        const modalContent = `
            <div class="modal" style="width: 400px;">
                <h2 class="modal-title">Select Space for Screenshot</h2>
                <p style="margin-bottom: 20px; color: rgba(255, 255, 255, 0.7);">
                    Choose where to save: ${fileName}
                </p>
                <div class="space-selector" style="max-height: 300px; overflow-y: auto;">
                    ${spaces.map(space => `
                        <div class="space-option" data-space-id="${space.id}" style="
                            padding: 12px;
                            margin: 8px 0;
                            background: rgba(255, 255, 255, 0.05);
                            border-radius: 8px;
                            cursor: pointer;
                            display: flex;
                            align-items: center;
                            gap: 12px;
                            transition: background 0.2s;
                        " onmouseover="this.style.background='rgba(255, 255, 255, 0.1)'" 
                           onmouseout="this.style.background='rgba(255, 255, 255, 0.05)'">
                            <span style="font-size: 24px;">${space.icon}</span>
                            <div>
                                <div style="font-weight: 500;">${space.name}</div>
                                <div style="font-size: 12px; opacity: 0.7;">${space.itemCount || 0} items</div>
                            </div>
                        </div>
                    `).join('')}
                </div>
                <div class="modal-buttons">
                    <button class="btn btn-secondary" id="screenshotCancel">Cancel</button>
                </div>
            </div>
        `;
        
        modal.innerHTML = modalContent;
        document.body.appendChild(modal);
        
        // Handle space selection
        modal.querySelectorAll('.space-option').forEach(option => {
            option.addEventListener('click', async () => {
                const spaceId = option.dataset.spaceId;
                await window.clipboard.completeScreenshot({ 
                    screenshotPath, 
                    spaceId,
                    stats: data.stats,
                    ext: data.ext
                });
                modal.remove();
            });
        });
        
        // Handle cancel
        modal.querySelector('#screenshotCancel').addEventListener('click', () => {
            modal.remove();
        });
    });

    // Notebook field listeners for live preview
    ['spaceName', 'spaceDescription', 'spaceObjective', 'spaceInstructions', 'spaceTags', 'spaceLinks'].forEach(id => {
        const element = document.getElementById(id);
        if (element) {
            element.addEventListener('input', updateNotebookPreview);
        }
    });
}

// Preview/Edit Panel Functions
let currentPreviewItem = null;
let isEditMode = false;
let originalContent = '';

// Image editing state
let imageEditHistory = []; // Stack of previous image states for undo
let currentImageData = null; // Current image data URL

// Show preview modal for an item
async function showPreviewModal(itemId) {
    const historyItem = history.find(h => h.id === itemId);
    
    if (!historyItem) {
        console.error('Item not found:', itemId);
        return;
    }
    
    // Use video-specific modal for video files
    const isVideo = historyItem.fileType === 'video' || 
                    historyItem.fileCategory === 'video' ||
                    historyItem.fileType?.startsWith('video/') ||
                    (historyItem.metadata?.source === 'youtube') ||
                    (historyItem.metadata?.youtubeUrl);
    
    console.log('[Preview] Item type check:', { 
        fileType: historyItem.fileType, 
        fileCategory: historyItem.fileCategory,
        source: historyItem.metadata?.source,
        isVideo 
    });
    
    if (isVideo) {
        showVideoPreviewModal(itemId);
        return;
    }
    
    const modal = document.getElementById('previewModal');
    currentPreviewItem = historyItem;
    isEditMode = false;
    
    // Update title based on item type
    const title = document.getElementById('previewModalTitle');
    const typeLabel = getTypeLabel(historyItem);
    title.textContent = `Preview: ${typeLabel}`;
    
    // Update item info
    document.getElementById('previewItemType').textContent = `Type: ${typeLabel}`;
    document.getElementById('previewItemSize').textContent = `Size: ${getContentSize(historyItem)}`;
    document.getElementById('previewItemDate').textContent = `Date: ${new Date(historyItem.timestamp).toLocaleString()}`;
    document.getElementById('previewItemSource').textContent = `Source: ${historyItem.source || historyItem.metadata?.context?.app?.name || 'Unknown'}`;
    
    // Get full content
    let fullContent = '';
    try {
        const result = await window.clipboard.getItemContent(itemId);
        if (result.success) {
            fullContent = result.content;
            originalContent = fullContent;
        } else {
            fullContent = historyItem.content || historyItem.preview || 'Unable to load content';
            originalContent = fullContent;
        }
    } catch (error) {
        console.error('Error loading content:', error);
        fullContent = historyItem.content || historyItem.preview || 'Error loading content';
        originalContent = fullContent;
    }
    
    // Show appropriate view based on content type
    hideAllPreviewModes();
    
    // Helper function to check if content looks like actual HTML
    const looksLikeHtml = (content) => {
        if (!content || typeof content !== 'string') return false;
        // Check for common HTML patterns - must have actual HTML tags
        const htmlPattern = /<\s*(html|head|body|div|span|p|a|img|table|ul|ol|li|h[1-6]|script|style|link|meta|form|input|button|header|footer|nav|section|article)[^>]*>/i;
        return htmlPattern.test(content);
    };
    
    if (historyItem.type === 'image' || (historyItem.type === 'file' && historyItem.fileType === 'image-file')) {
        // Show image preview
        const imgSrc = historyItem.content || historyItem.thumbnail || fullContent;
        document.getElementById('previewImage').src = imgSrc;
        currentImageData = imgSrc; // Store for AI editing
        document.getElementById('previewImageMode').style.display = 'block';
        document.getElementById('previewModeBtn').style.display = 'none'; // Text edit not available for images
        
        // Reset image edit state
        resetImageEditState();
    } else if (historyItem.type === 'file' && (historyItem.fileType === 'audio' || historyItem.fileType === 'video' || historyItem.fileCategory === 'audio' || historyItem.fileCategory === 'video')) {
        // Show audio/video preview with transcription option
        const isAudio = historyItem.fileType === 'audio' || historyItem.fileCategory === 'audio';
        const mediaType = isAudio ? 'Audio' : 'Video';
        
        // Display file info with media player - compact layout
        let mediaHtml = `
            <div style="display: flex; align-items: center; gap: 16px; margin-bottom: 16px;">
                <div style="font-size: 40px;">${isAudio ? '🎵' : '🎬'}</div>
                <div>
                    <div style="font-size: 14px; font-weight: 500; color: rgba(255, 255, 255, 0.9);">${escapeHtml(historyItem.fileName || 'Media File')}</div>
                    <div style="font-size: 11px; color: rgba(255, 255, 255, 0.5);">${formatFileSize(historyItem.fileSize)} • ${historyItem.fileExt?.toUpperCase() || mediaType}</div>
                </div>
            </div>
            <div id="mediaPlayerContainer">
                <${isAudio ? 'audio' : 'video'} id="previewMediaPlayer" controls style="width: 100%; ${isAudio ? 'height: 54px;' : 'max-height: 250px;'}" preload="auto">
                    Your browser does not support the ${isAudio ? 'audio' : 'video'} element.
                </${isAudio ? 'audio' : 'video'}>
                <div id="mediaLoadStatus" style="text-align: center; margin-top: 8px; font-size: 11px; color: rgba(255, 255, 255, 0.5);">Loading media...</div>
            </div>
        `;
        
        const viewMode = document.getElementById('previewViewMode');
        viewMode.innerHTML = mediaHtml;
        viewMode.style.display = 'block';
        // Reset text-specific styles for media content
        viewMode.style.whiteSpace = 'normal';
        viewMode.style.fontFamily = 'inherit';
        viewMode.style.overflow = 'visible';
        viewMode.style.flex = 'none';
        viewMode.style.minHeight = 'auto';
        document.getElementById('previewModeBtn').style.display = 'none';
        
        // Show transcription section for audio/video
        document.getElementById('transcriptionSection').style.display = 'block';
        resetTranscriptionState();
        
        // Show video editor section for video files only
        if (!isAudio) {
            document.getElementById('videoEditorSection').style.display = 'block';
        }
        
        // Load the media file
        loadMediaForPreview(historyItem);
        
        // Load attached transcription if exists
        loadAttachedTranscription(historyItem.id);
    } else if ((historyItem.type === 'generated-document') || (historyItem.metadata?.type === 'generated-document')) {
        // Generated documents should always render as HTML
        const iframe = document.getElementById('previewHtmlFrame');
        iframe.srcdoc = fullContent || historyItem.html || '';
        document.getElementById('previewHtmlMode').style.display = 'block';
        document.getElementById('previewModeBtn').style.display = 'inline-block';
    } else if (historyItem.type === 'html') {
        // For 'html' type, check if content actually looks like HTML
        // Use the raw html property if available, otherwise check the fullContent
        const htmlContent = historyItem.html || fullContent;
        
        if (looksLikeHtml(htmlContent)) {
            // Show HTML preview in iframe
            const iframe = document.getElementById('previewHtmlFrame');
            iframe.srcdoc = htmlContent;
            document.getElementById('previewHtmlMode').style.display = 'block';
            document.getElementById('previewModeBtn').style.display = 'inline-block';
        } else {
            // Content doesn't look like HTML, show as plain text
            document.getElementById('previewViewMode').textContent = fullContent;
            document.getElementById('previewViewMode').style.display = 'block';
            document.getElementById('previewModeBtn').style.display = 'inline-block';
            // Show TTS for plain text content (even if type is 'html')
            document.getElementById('textToSpeechSection').style.display = 'block';
        }
    } else if (isMarkdownContent(fullContent, historyItem)) {
        // Show Markdown preview
        document.getElementById('markdownRendered').innerHTML = renderMarkdown(fullContent);
        document.getElementById('previewMarkdownMode').style.display = 'block';
        document.getElementById('previewModeBtn').style.display = 'inline-block';
        // Show TTS for markdown
        document.getElementById('textToSpeechSection').style.display = 'block';
    } else {
        // Show text preview (default)
        const viewMode = document.getElementById('previewViewMode');
        viewMode.textContent = fullContent;
        viewMode.style.display = 'block';
        // Reset to text-appropriate styles
        viewMode.style.whiteSpace = 'pre-wrap';
        viewMode.style.fontFamily = "'Monaco', 'Consolas', monospace";
        viewMode.style.overflow = 'auto';
        viewMode.style.flex = '1';
        document.getElementById('previewModeBtn').style.display = 'inline-block';
        // Show TTS for plain text
        document.getElementById('textToSpeechSection').style.display = 'block';
    }
    
    // Reset TTS state then check for attached audio
    resetTTSState();
    
    // Load attached TTS audio if exists (async but we don't need to await)
    if (currentPreviewItem && currentPreviewItem.id) {
        console.log('[TTS] Calling loadAttachedTTSAudio for:', currentPreviewItem.id);
        loadAttachedTTSAudio(currentPreviewItem.id).then(hasAudio => {
            console.log('[TTS] loadAttachedTTSAudio returned:', hasAudio);
        }).catch(err => {
            console.error('[TTS] loadAttachedTTSAudio error:', err);
        });
    }
    
    // Reset edit mode button
    updateEditModeButton();
    
    // Show modal
    modal.style.display = 'flex';
}

// Hide all preview modes
function hideAllPreviewModes() {
    document.getElementById('previewViewMode').style.display = 'none';
    document.getElementById('previewEditMode').style.display = 'none';
    document.getElementById('previewImageMode').style.display = 'none';
    document.getElementById('previewHtmlMode').style.display = 'none';
    document.getElementById('previewMarkdownMode').style.display = 'none';
    document.getElementById('textToSpeechSection').style.display = 'none';
    document.getElementById('transcriptionSection').style.display = 'none';
    document.getElementById('videoEditorSection').style.display = 'none';
}

// Reset TTS state
function resetTTSState() {
    document.getElementById('ttsAudioContainer').style.display = 'none';
    document.getElementById('saveTtsAudioBtn').style.display = 'none';
    document.getElementById('ttsStatus').style.display = 'none';
    document.getElementById('ttsButtonIcon').textContent = '🎙️';
    document.getElementById('ttsButtonText').textContent = 'Generate Audio';
    document.getElementById('generateSpeechBtn').disabled = false;
    
    const audioPlayer = document.getElementById('ttsAudioPlayer');
    audioPlayer.src = '';
    audioPlayer.load();
    
    window.currentTTSAudioData = null;
    window.currentTTSVoice = null;
    window.ttsAudioAttached = false;
}

// Load attached TTS audio for an item
async function loadAttachedTTSAudio(itemId) {
    try {
        console.log('[TTS] Loading attached audio for item:', itemId);
        const result = await window.clipboard.getTTSAudio(itemId);
        console.log('[TTS] Get audio result:', result);
        
        if (result && result.success && result.hasAudio && result.audioData) {
            console.log('[TTS] Audio data length:', result.audioData.length);
            
            // Audio is attached to this item
            window.currentTTSAudioData = result.audioData;
            window.currentTTSVoice = result.voice || 'nova';
            window.ttsAudioAttached = true;
            
            // Set the voice selector to match
            const voiceSelect = document.getElementById('ttsVoiceSelect');
            if (voiceSelect && result.voice) {
                voiceSelect.value = result.voice;
            }
            
            // IMPORTANT: Show the TTS section container first
            const ttsSection = document.getElementById('textToSpeechSection');
            ttsSection.style.display = 'block';
            console.log('[TTS] TTS section display:', ttsSection.style.display);
            
            // Show the audio container
            const audioContainer = document.getElementById('ttsAudioContainer');
            audioContainer.style.display = 'block';
            console.log('[TTS] Audio container display:', audioContainer.style.display);
            
            // Get the audio player
            const audioPlayer = document.getElementById('ttsAudioPlayer');
            
            // Create a blob from base64 and use blob URL (more reliable than data URL)
            const byteCharacters = atob(result.audioData);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray], { type: 'audio/mpeg' });
            const blobUrl = URL.createObjectURL(blob);
            
            console.log('[TTS] Created blob URL:', blobUrl);
            
            audioPlayer.src = blobUrl;
            audioPlayer.load(); // Explicitly load the audio
            
            // Wait for audio to load
            audioPlayer.onloadedmetadata = () => {
                console.log('[TTS] Audio loaded successfully, duration:', audioPlayer.duration);
            };
            
            audioPlayer.onerror = (e) => {
                console.error('[TTS] Audio load error:', e);
            };
            
            document.getElementById('saveTtsAudioBtn').style.display = 'none'; // Already saved
            
            showTTSStatus('🔊 Audio attached to this item', 'success');
            
            return true;
        } else {
            console.log('[TTS] No audio attached - result:', result);
        }
    } catch (error) {
        console.error('[TTS] Error loading attached TTS audio:', error);
    }
    return false;
}

// Generate speech from text using OpenAI TTS
async function generateSpeech() {
    const btn = document.getElementById('generateSpeechBtn');
    const btnIcon = document.getElementById('ttsButtonIcon');
    const btnText = document.getElementById('ttsButtonText');
    const statusEl = document.getElementById('ttsStatus');
    const voice = document.getElementById('ttsVoiceSelect').value;
    
    // Get the text content
    let textContent = '';
    if (currentPreviewItem) {
        // Get from the preview/edit textarea or original content
        const editTextarea = document.getElementById('previewEditTextarea');
        if (editTextarea.value) {
            textContent = editTextarea.value;
        } else {
            textContent = originalContent || currentPreviewItem.content || currentPreviewItem.preview || '';
        }
    }
    
    if (!textContent || textContent.trim().length === 0) {
        showTTSStatus('No text content to convert', 'error');
        return;
    }
    
    // Strip markdown/HTML for cleaner speech
    textContent = textContent
        .replace(/```[\s\S]*?```/g, '') // Remove code blocks
        .replace(/`[^`]+`/g, '') // Remove inline code
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Replace links with text
        .replace(/[#*_~]/g, '') // Remove markdown formatting
        .replace(/<[^>]*>/g, '') // Remove HTML tags
        .replace(/\n{3,}/g, '\n\n') // Normalize line breaks
        .trim();
    
    // OpenAI TTS has a limit of ~4096 characters
    if (textContent.length > 4000) {
        textContent = textContent.substring(0, 4000) + '...';
        showTTSStatus('Text truncated to 4000 characters for TTS', 'warning');
    }
    
    try {
        btn.disabled = true;
        btnIcon.textContent = '⏳';
        btnText.textContent = 'Generating...';
        showTTSStatus('Generating speech with OpenAI TTS HD...', 'info');
        
        // Call the backend to generate speech
        const result = await window.clipboard.generateSpeech({
            text: textContent,
            voice: voice
        });
        
        if (result.success && result.audioData) {
            // Create audio blob and URL
            const audioBlob = base64ToBlob(result.audioData, 'audio/mpeg');
            const audioUrl = URL.createObjectURL(audioBlob);
            
            // Set up audio player
            const audioPlayer = document.getElementById('ttsAudioPlayer');
            audioPlayer.src = audioUrl;
            
            // Store the audio data for saving
            window.currentTTSAudioData = result.audioData;
            window.currentTTSVoice = voice;
            
            // Show audio player
            document.getElementById('ttsAudioContainer').style.display = 'block';
            
            showTTSStatus('⏳ Saving audio...', 'info');
            
            // Auto-save the audio immediately
            try {
                const saveResult = await window.clipboard.saveTTSAudio({
                    audioData: result.audioData,
                    voice: voice,
                    sourceItemId: currentPreviewItem?.id,
                    sourceText: (originalContent || '').substring(0, 100),
                    attachToSource: true
                });
                
                if (saveResult.success) {
                    window.ttsAudioAttached = true;
                    document.getElementById('saveTtsAudioBtn').style.display = 'none';
                    showTTSStatus('✓ Audio generated and saved!', 'success');
                } else {
                    // Show save button as fallback
                    document.getElementById('saveTtsAudioBtn').style.display = 'inline-block';
                    showTTSStatus('✓ Audio generated! Click Save to keep it.', 'warning');
                }
            } catch (saveError) {
                console.error('Auto-save failed:', saveError);
                document.getElementById('saveTtsAudioBtn').style.display = 'inline-block';
                showTTSStatus('✓ Audio generated! Click Save to keep it.', 'warning');
            }
            
            // Auto-play
            audioPlayer.play().catch(() => {
                // Autoplay might be blocked, that's ok
            });
        } else {
            throw new Error(result.error || 'Failed to generate speech');
        }
    } catch (error) {
        console.error('TTS Error:', error);
        showTTSStatus('Error: ' + error.message, 'error');
    } finally {
        btn.disabled = false;
        btnIcon.textContent = '🎙️';
        btnText.textContent = 'Generate Audio';
    }
}

// Save TTS audio - attaches to source item
async function saveTTSAudio() {
    if (!window.currentTTSAudioData) {
        showTTSStatus('No audio to save', 'error');
        return;
    }
    
    const btn = document.getElementById('saveTtsAudioBtn');
    const originalText = btn.textContent;
    
    try {
        btn.disabled = true;
        btn.textContent = '⏳ Saving...';
        
        const result = await window.clipboard.saveTTSAudio({
            audioData: window.currentTTSAudioData,
            voice: window.currentTTSVoice,
            sourceItemId: currentPreviewItem?.id,
            sourceText: (originalContent || '').substring(0, 100),
            attachToSource: true  // Attach to the original item
        });
        
        if (result.success) {
            window.ttsAudioAttached = true;
            
            if (result.attached) {
                showTTSStatus('✓ Audio attached to this item!', 'success');
                // Hide the save button since it's now attached
                btn.style.display = 'none';
                
                showNotification({
                    title: 'Audio Attached',
                    body: 'TTS audio is now part of this item',
                    type: 'success'
                });
            } else {
                showTTSStatus('✓ Audio saved as new item!', 'success');
                await loadHistory();
                
                showNotification({
                    title: 'Audio Saved',
                    body: 'TTS audio has been saved to your space',
                    type: 'success'
                });
            }
        } else {
            throw new Error(result.error || 'Failed to save audio');
        }
    } catch (error) {
        console.error('Save TTS Error:', error);
        showTTSStatus('Error saving: ' + error.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

// Show TTS status message
function showTTSStatus(message, type = 'info') {
    const statusEl = document.getElementById('ttsStatus');
    statusEl.textContent = message;
    statusEl.style.display = 'block';
    
    // Set color based on type
    switch (type) {
        case 'error':
            statusEl.style.color = 'rgba(239, 68, 68, 0.9)';
            break;
        case 'warning':
            statusEl.style.color = 'rgba(251, 191, 36, 0.9)';
            break;
        case 'success':
            statusEl.style.color = 'rgba(34, 197, 94, 0.9)';
            break;
        default:
            statusEl.style.color = 'rgba(100, 200, 255, 0.9)';
    }
}

// Helper: Convert base64 to Blob
function base64ToBlob(base64, mimeType) {
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mimeType });
}

// Load media file for preview
async function loadMediaForPreview(item) {
    console.log('[Media] loadMediaForPreview called for:', item.id, item.fileName);
    
    // Small delay to ensure DOM is ready
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const mediaPlayer = document.getElementById('previewMediaPlayer');
    const statusEl = document.getElementById('mediaLoadStatus');
    
    if (!mediaPlayer) {
        console.error('[Media] No media player element found!');
        return;
    }
    
    try {
        statusEl.textContent = 'Loading media...';
        statusEl.style.color = 'rgba(255, 255, 255, 0.5)';
        
        // Get the audio/video data
        console.log('[Media] Calling getAudioData for:', item.id);
        const result = await window.clipboard.getAudioData(item.id);
        console.log('[Media] getAudioData result:', result.success, 'isVideo:', result.isVideo, 'hasFilePath:', !!result.filePath, 'hasDataUrl:', !!result.dataUrl);
        
        if (result.success) {
            // Handle video files - use file path directly (no memory loading)
            if (result.isVideo && result.filePath) {
                console.log('[Media] Using file path directly for video:', result.filePath);
                
                // Use file:// protocol for local files
                mediaPlayer.src = `file://${result.filePath}`;
                mediaPlayer.load();
                
                // Wait for metadata to load
                mediaPlayer.onloadedmetadata = () => {
                    console.log('[Media] Video metadata loaded, duration:', mediaPlayer.duration);
                    statusEl.textContent = `Ready to play (${Math.round(mediaPlayer.duration)}s)`;
                    statusEl.style.color = 'rgba(34, 197, 94, 0.8)';
                };
                
                mediaPlayer.onerror = (e) => {
                    console.error('[Media] Video player error:', e);
                    statusEl.textContent = 'Error playing video';
                    statusEl.style.color = 'rgba(239, 68, 68, 0.8)';
                };
                
                // Store for video editor
                window.currentMediaFilePath = result.filePath;
                window.currentMediaItem = item;
                console.log('[Media] Video set up successfully');
                return;
            }
            
            // Handle audio files with data URL
            if (result.dataUrl) {
                // Extract base64 data and create blob URL (more reliable)
                const matches = result.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
                if (matches) {
                    const mimeType = matches[1];
                    const base64Data = matches[2];
                    
                    // Convert base64 to blob
                    const byteCharacters = atob(base64Data);
                    const byteNumbers = new Array(byteCharacters.length);
                    for (let i = 0; i < byteCharacters.length; i++) {
                        byteNumbers[i] = byteCharacters.charCodeAt(i);
                    }
                    const byteArray = new Uint8Array(byteNumbers);
                    const blob = new Blob([byteArray], { type: mimeType });
                    const blobUrl = URL.createObjectURL(blob);
                    
                    console.log('[Media] Created blob URL:', blobUrl, 'size:', blob.size);
                    
                    mediaPlayer.src = blobUrl;
                    mediaPlayer.load(); // Explicitly load
                    
                    // Wait for metadata to load
                    mediaPlayer.onloadedmetadata = () => {
                        console.log('[Media] Metadata loaded, duration:', mediaPlayer.duration);
                        statusEl.textContent = `Ready to play (${Math.round(mediaPlayer.duration)}s)`;
                        statusEl.style.color = 'rgba(34, 197, 94, 0.8)';
                    };
                    
                    mediaPlayer.onerror = (e) => {
                        console.error('[Media] Player error:', e);
                        statusEl.textContent = 'Error playing media';
                        statusEl.style.color = 'rgba(239, 68, 68, 0.8)';
                    };
                    
                    // Store for transcription
                    window.currentMediaData = result.dataUrl;
                    window.currentMediaItem = item;
                    console.log('[Media] Audio loaded successfully');
                } else {
                    // Fallback: use data URL directly
                    console.log('[Media] Using data URL directly');
                    mediaPlayer.src = result.dataUrl;
                    mediaPlayer.load();
                    
                    window.currentMediaData = result.dataUrl;
                    window.currentMediaItem = item;
                    statusEl.textContent = 'Ready to play';
                    statusEl.style.color = 'rgba(34, 197, 94, 0.8)';
                }
            }
        } else {
            console.error('[Media] Failed to load media:', result.error);
            statusEl.textContent = result.error || 'Unable to load media file';
            statusEl.style.color = 'rgba(239, 68, 68, 0.8)';
            
            window.currentMediaData = null;
            window.currentMediaFilePath = null;
            window.currentMediaItem = null;
        }
    } catch (error) {
        console.error('[Media] Error loading media:', error);
        statusEl.textContent = 'Error: ' + error.message;
        statusEl.style.color = 'rgba(239, 68, 68, 0.8)';
        
        window.currentMediaData = null;
        window.currentMediaFilePath = null;
        window.currentMediaItem = null;
    }
}

// Reset transcription state
function resetTranscriptionState() {
    document.getElementById('transcriptionResult').style.display = 'none';
    document.getElementById('transcriptionStatus').style.display = 'none';
    document.getElementById('transcriptionText').textContent = '';
    document.getElementById('transcribeButtonIcon').textContent = '🎤';
    document.getElementById('transcribeButtonText').textContent = 'Transcribe';
    document.getElementById('transcribeBtn').disabled = false;
    
    window.currentTranscription = null;
    window.transcriptionAttached = false;
}

// Load attached transcription for an item
async function loadAttachedTranscription(itemId) {
    try {
        console.log('[Transcription] Loading attached transcription for:', itemId);
        const result = await window.clipboard.getTranscription(itemId);
        
        if (result.success && result.hasTranscription && result.transcription) {
            console.log('[Transcription] Found attached transcription, length:', result.transcription.length);
            
            window.currentTranscription = result.transcription;
            window.transcriptionAttached = true;
            
            // Show the transcription
            document.getElementById('transcriptionText').textContent = result.transcription;
            document.getElementById('transcriptionResult').style.display = 'block';
            
            // Update button to show it's already done
            document.getElementById('transcribeButtonIcon').textContent = '✓';
            document.getElementById('transcribeButtonText').textContent = 'Transcribed';
            
            showTranscriptionStatus('📝 Transcription attached to this item', 'success');
            
            return true;
        }
    } catch (error) {
        console.error('[Transcription] Error loading:', error);
    }
    return false;
}

// Open current video in Video Editor
async function openInVideoEditor() {
    if (!currentPreviewItem) {
        console.error('[VideoEditor] No current preview item');
        return;
    }
    
    console.log('[VideoEditor] Opening video for item:', currentPreviewItem.id, currentPreviewItem.fileName);
    
    try {
        // First, get the actual file path from the backend
        const pathResult = await window.clipboard.getVideoPath(currentPreviewItem.id);
        console.log('[VideoEditor] getVideoPath result:', pathResult);
        
        if (!pathResult.success || !pathResult.filePath) {
            console.error('[VideoEditor] Could not find video file:', pathResult.error);
            showNotification({
                type: 'error',
                title: 'Video Not Found',
                message: pathResult.error || 'Unable to locate video file'
            });
            return;
        }
        
        const filePath = pathResult.filePath;
        console.log('[VideoEditor] Opening video in editor:', filePath);
        
        // Send IPC to open video editor with this file
        const result = await window.clipboard.openVideoEditor(filePath);
        
        if (!result.success) {
            console.error('[VideoEditor] Failed to open editor:', result.error);
            showNotification({
                type: 'error',
                title: 'Failed to Open Editor',
                message: result.error || 'Unknown error'
            });
            return;
        }
        
        // Close the preview modal
        document.getElementById('previewModal').style.display = 'none';
        showNotification({
            type: 'success',
            title: 'Video Editor',
            message: 'Opening video editor...'
        });
    } catch (error) {
        console.error('[VideoEditor] Error opening video editor:', error);
        showNotification({
            type: 'error',
            title: 'Error',
            message: 'Failed to open Video Editor: ' + error.message
        });
    }
}

// Transcribe audio/video using OpenAI Whisper
async function transcribeMedia() {
    const btn = document.getElementById('transcribeBtn');
    const btnIcon = document.getElementById('transcribeButtonIcon');
    const btnText = document.getElementById('transcribeButtonText');
    const statusEl = document.getElementById('transcriptionStatus');
    const language = document.getElementById('transcriptionLanguage').value;
    
    // Check for either audio data or video file path
    const hasMedia = window.currentMediaData || window.currentMediaFilePath;
    if (!hasMedia || !window.currentMediaItem) {
        showTranscriptionStatus('No media loaded', 'error');
        return;
    }
    
    try {
        btn.disabled = true;
        btnIcon.textContent = '⏳';
        btnText.textContent = 'Transcribing...';
        
        // For videos, show extracting audio message
        const isVideo = window.currentMediaFilePath && !window.currentMediaData;
        if (isVideo) {
            showTranscriptionStatus('Extracting audio from video...', 'info');
        } else {
            showTranscriptionStatus('Sending audio to OpenAI Whisper...', 'info');
        }
        
        // Call the backend to transcribe
        const result = await window.clipboard.transcribeAudio({
            itemId: window.currentMediaItem.id,
            language: language || undefined
        });
        
        if (result.success && result.transcription) {
            // Store and display transcription
            window.currentTranscription = result.transcription;
            
            document.getElementById('transcriptionText').textContent = result.transcription;
            document.getElementById('transcriptionResult').style.display = 'block';
            
            showTranscriptionStatus('⏳ Saving transcription...', 'info');
            
            // Auto-save the transcription to the source item
            try {
                const saveResult = await window.clipboard.saveTranscription({
                    transcription: result.transcription,
                    sourceItemId: window.currentMediaItem.id,
                    sourceFileName: window.currentMediaItem.fileName,
                    attachToSource: true
                });
                
                if (saveResult.success && saveResult.attached) {
                    window.transcriptionAttached = true;
                    showTranscriptionStatus(`✓ Transcription saved! (${result.transcription.length} characters)`, 'success');
                    
                    // Update button to show it's done
                    btnIcon.textContent = '✓';
                    btnText.textContent = 'Transcribed';
                } else {
                    showTranscriptionStatus(`✓ Transcription complete! (${result.transcription.length} characters)`, 'success');
                }
            } catch (saveError) {
                console.error('Error saving transcription:', saveError);
                showTranscriptionStatus(`✓ Transcription complete! (${result.transcription.length} characters)`, 'success');
            }
        } else {
            throw new Error(result.error || 'Failed to transcribe');
        }
    } catch (error) {
        console.error('Transcription Error:', error);
        showTranscriptionStatus('Error: ' + error.message, 'error');
    } finally {
        btn.disabled = false;
        if (!window.transcriptionAttached) {
            btnIcon.textContent = '🎤';
            btnText.textContent = 'Transcribe';
        }
    }
}

// Copy transcription to clipboard
async function copyTranscription() {
    if (!window.currentTranscription) {
        showTranscriptionStatus('No transcription to copy', 'error');
        return;
    }
    
    try {
        await navigator.clipboard.writeText(window.currentTranscription);
        showTranscriptionStatus('✓ Copied to clipboard!', 'success');
    } catch (error) {
        console.error('Copy error:', error);
        showTranscriptionStatus('Error copying: ' + error.message, 'error');
    }
}

// Save transcription as text item
async function saveTranscription() {
    if (!window.currentTranscription) {
        showTranscriptionStatus('No transcription to save', 'error');
        return;
    }
    
    const btn = document.getElementById('saveTranscriptionBtn');
    const originalText = btn.innerHTML;
    
    try {
        btn.disabled = true;
        btn.innerHTML = '⏳ Saving...';
        
        const result = await window.clipboard.saveTranscription({
            transcription: window.currentTranscription,
            sourceItemId: window.currentMediaItem?.id,
            sourceFileName: window.currentMediaItem?.fileName
        });
        
        if (result.success) {
            showTranscriptionStatus('✓ Transcription saved to your space!', 'success');
            
            // Refresh history
            await loadHistory();
            
            showNotification({
                title: 'Transcription Saved',
                body: 'Audio transcription has been saved as a text item',
                type: 'success'
            });
        } else {
            throw new Error(result.error || 'Failed to save');
        }
    } catch (error) {
        console.error('Save transcription error:', error);
        showTranscriptionStatus('Error saving: ' + error.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

// Show transcription status message
function showTranscriptionStatus(message, type = 'info') {
    const statusEl = document.getElementById('transcriptionStatus');
    statusEl.textContent = message;
    statusEl.style.display = 'block';
    
    // Set color based on type
    switch (type) {
        case 'error':
            statusEl.style.color = 'rgba(239, 68, 68, 0.9)';
            break;
        case 'warning':
            statusEl.style.color = 'rgba(251, 191, 36, 0.9)';
            break;
        case 'success':
            statusEl.style.color = 'rgba(34, 197, 94, 0.9)';
            break;
        default:
            statusEl.style.color = 'rgba(251, 191, 36, 0.9)';
    }
}

// Simple Markdown to HTML renderer
function renderMarkdown(text) {
    if (!text) return '';
    
    let html = text;
    
    // Escape HTML first
    html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    
    // Code blocks (fenced) - must be before other processing
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
        return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`;
    });
    
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    
    // Headers
    html = html.replace(/^#{6}\s+(.+)$/gm, '<h6>$1</h6>');
    html = html.replace(/^#{5}\s+(.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^#{4}\s+(.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^#{3}\s+(.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^#{2}\s+(.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^#{1}\s+(.+)$/gm, '<h1>$1</h1>');
    
    // Bold and italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/___(.+?)___/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/_(.+?)_/g, '<em>$1</em>');
    
    // Strikethrough
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
    
    // Links and images
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    
    // Blockquotes
    html = html.replace(/^&gt;\s+(.+)$/gm, '<blockquote>$1</blockquote>');
    // Merge consecutive blockquotes
    html = html.replace(/<\/blockquote>\n<blockquote>/g, '\n');
    
    // Horizontal rules
    html = html.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '<hr>');
    
    // Task lists
    html = html.replace(/^(\s*)[-*]\s+\[x\]\s+(.+)$/gim, '$1<li><input type="checkbox" checked disabled> $2</li>');
    html = html.replace(/^(\s*)[-*]\s+\[\s?\]\s+(.+)$/gim, '$1<li><input type="checkbox" disabled> $2</li>');
    
    // Unordered lists
    html = html.replace(/^[-*+]\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
    
    // Ordered lists
    html = html.replace(/^\d+\.\s+(.+)$/gm, '<oli>$1</oli>');
    html = html.replace(/(<oli>.*<\/oli>\n?)+/g, (match) => {
        return '<ol>' + match.replace(/<\/?oli>/g, (tag) => tag.replace('oli', 'li')) + '</ol>';
    });
    
    // Tables
    html = html.replace(/^\|(.+)\|$/gm, (match, content) => {
        const cells = content.split('|').map(c => c.trim());
        // Check if it's a separator row
        if (cells.every(c => /^[-:]+$/.test(c))) {
            return '<!-- table separator -->';
        }
        const isHeader = html.indexOf(match) === html.indexOf('|');
        const cellTag = isHeader ? 'th' : 'td';
        return '<tr>' + cells.map(c => `<${cellTag}>${c}</${cellTag}>`).join('') + '</tr>';
    });
    html = html.replace(/<!-- table separator -->\n?/g, '');
    html = html.replace(/(<tr>.*<\/tr>\n?)+/g, '<table>$&</table>');
    
    // Paragraphs - wrap remaining text blocks
    html = html.replace(/^(?!<[a-z]|$)(.+)$/gm, '<p>$1</p>');
    
    // Clean up extra paragraph tags around block elements
    html = html.replace(/<p>(<(h[1-6]|ul|ol|li|blockquote|pre|table|hr)[^>]*>)/g, '$1');
    html = html.replace(/(<\/(h[1-6]|ul|ol|li|blockquote|pre|table)>)<\/p>/g, '$1');
    
    // Clean up empty paragraphs
    html = html.replace(/<p>\s*<\/p>/g, '');
    
    return html;
}

// Check if content is Markdown
function isMarkdownContent(content, item) {
    // Check file extension
    if (item?.fileExt === '.md') return true;
    
    // Check content patterns
    if (!content || typeof content !== 'string') return false;
    
    let mdScore = 0;
    if (/^#{1,6}\s+.+/m.test(content)) mdScore += 2;
    if (/\[.+?\]\(.+?\)/.test(content)) mdScore += 2;
    if (/```[\s\S]*?```/.test(content)) mdScore += 2;
    if (/^\s*[-*+]\s+.+/m.test(content)) mdScore += 1;
    if (/\*\*[^*]+\*\*/.test(content)) mdScore += 1;
    if (/^>\s+.+/m.test(content)) mdScore += 1;
    
    return mdScore >= 2;
}

// Toggle between view and edit mode
function togglePreviewEditMode() {
    if (!currentPreviewItem) return;
    
    isEditMode = !isEditMode;
    
    // Helper function to check if content looks like actual HTML
    const looksLikeHtml = (content) => {
        if (!content || typeof content !== 'string') return false;
        const htmlPattern = /<\s*(html|head|body|div|span|p|a|img|table|ul|ol|li|h[1-6]|script|style|link|meta|form|input|button|header|footer|nav|section|article)[^>]*>/i;
        return htmlPattern.test(content);
    };
    
    if (isEditMode) {
        // Switch to edit mode
        hideAllPreviewModes();
        
        // Get current content
        let content = originalContent;
        
        // For generated documents or actual HTML, get the source
        if (currentPreviewItem.metadata?.type === 'generated-document') {
            content = originalContent || currentPreviewItem.html || currentPreviewItem.content || '';
        } else if (currentPreviewItem.type === 'html') {
            // Check if it's actual HTML or just text
            const htmlContent = currentPreviewItem.html || originalContent;
            content = looksLikeHtml(htmlContent) ? htmlContent : originalContent;
        }
        
        const textarea = document.getElementById('previewEditTextarea');
        textarea.value = content;
        document.getElementById('previewEditMode').style.display = 'flex';
        
        // Update character count
        updateEditStats();
        
        // Focus textarea
        textarea.focus();
    } else {
        // Switch back to view mode
        hideAllPreviewModes();
        
        if (currentPreviewItem.type === 'image' || (currentPreviewItem.type === 'file' && currentPreviewItem.fileType === 'image-file')) {
            document.getElementById('previewImageMode').style.display = 'block';
        } else if (currentPreviewItem.metadata?.type === 'generated-document') {
            document.getElementById('previewHtmlMode').style.display = 'block';
        } else if (currentPreviewItem.type === 'html') {
            // Check if it's actual HTML
            const htmlContent = currentPreviewItem.html || originalContent;
            if (looksLikeHtml(htmlContent)) {
                document.getElementById('previewHtmlMode').style.display = 'block';
            } else {
                document.getElementById('previewViewMode').style.display = 'block';
            }
        } else if (isMarkdownContent(originalContent, currentPreviewItem)) {
            // Show Markdown preview with potentially updated content
            const textarea = document.getElementById('previewEditTextarea');
            const currentContent = textarea.value;
            document.getElementById('markdownRendered').innerHTML = renderMarkdown(currentContent);
            document.getElementById('previewMarkdownMode').style.display = 'block';
        } else {
            document.getElementById('previewViewMode').style.display = 'block';
        }
    }
    
    updateEditModeButton();
}

// Update the edit mode button text/icon
function updateEditModeButton() {
    const btn = document.getElementById('previewModeBtn');
    const icon = document.getElementById('previewModeIcon');
    
    if (isEditMode) {
        icon.textContent = '◉';
        btn.innerHTML = '<span id="previewModeIcon">◉</span> View';
    } else {
        icon.textContent = '✎';
        btn.innerHTML = '<span id="previewModeIcon">✎</span> Edit';
    }
}

// Update edit stats (character count, etc.)
function updateEditStats() {
    const textarea = document.getElementById('previewEditTextarea');
    const stats = document.getElementById('previewEditStats');
    const charCount = textarea.value.length;
    const lineCount = textarea.value.split('\n').length;
    const wordCount = textarea.value.trim() ? textarea.value.trim().split(/\s+/).length : 0;
    
    stats.textContent = `${charCount.toLocaleString()} characters | ${wordCount.toLocaleString()} words | ${lineCount.toLocaleString()} lines`;
}

// Save edited content
async function savePreviewContent() {
    if (!currentPreviewItem) return;
    
    const textarea = document.getElementById('previewEditTextarea');
    const newContent = textarea.value;
    
    // Check if content actually changed
    if (newContent === originalContent) {
        showNotification({
            title: 'No Changes',
            body: 'Content has not been modified',
            type: 'info'
        });
        return;
    }
    
    try {
        // Save the updated content
        const result = await window.clipboard.updateItemContent(currentPreviewItem.id, newContent);
        
        if (result.success) {
            originalContent = newContent;
            
            // Update the view mode content
            document.getElementById('previewViewMode').textContent = newContent;
            
            // If HTML, update the iframe too
            if (currentPreviewItem.type === 'html' || currentPreviewItem.metadata?.type === 'generated-document') {
                document.getElementById('previewHtmlFrame').srcdoc = newContent;
            }
            
            showNotification({
                title: 'Saved',
                body: 'Content has been updated successfully',
                type: 'success'
            });
            
            // Reload history to reflect changes
            await loadHistory();
            
            // Switch back to view mode
            togglePreviewEditMode();
        } else {
            showNotification({
                title: 'Error',
                body: result.error || 'Failed to save content',
                type: 'error'
            });
        }
    } catch (error) {
        console.error('Error saving content:', error);
        showNotification({
            title: 'Error',
            body: error.message || 'Failed to save content',
            type: 'error'
        });
    }
}

// Cancel editing and revert
function cancelPreviewEdit() {
    const textarea = document.getElementById('previewEditTextarea');
    textarea.value = originalContent;
    togglePreviewEditMode();
}

// Copy preview content
async function copyPreviewContent() {
    if (!currentPreviewItem) return;
    
    try {
        await window.clipboard.pasteItem(currentPreviewItem.id);
        showCopyNotification();
    } catch (error) {
        console.error('Error copying content:', error);
    }
}

// Hide preview modal
function hidePreviewModal() {
    document.getElementById('previewModal').style.display = 'none';
    currentPreviewItem = null;
    isEditMode = false;
}

// Get type label for display
function getTypeLabel(item) {
    if (item.type === 'generated-document' || item.metadata?.type === 'generated-document') return 'Generated Document';
    if (item.type === 'file') {
        if (item.fileType === 'pdf') return 'PDF Document';
        if (item.fileType === 'video') return 'Video';
        if (item.fileType === 'audio') return 'Audio';
        if (item.fileType === 'image-file') return 'Image File';
        if (item.fileCategory === 'code') return 'Code File';
        if (item.fileCategory === 'document') return 'Document';
        return item.fileExt ? item.fileExt.toUpperCase().replace('.', '') + ' File' : 'File';
    }
    if (item.type === 'image') return 'Image';
    if (item.type === 'html') return 'HTML Content';
    if (item.source === 'code') return 'Code';
    if (item.source === 'url') return 'URL';
    return 'Text';
}

// Get content size for display
function getContentSize(item) {
    if (item.fileSize) return formatFileSize(item.fileSize);
    if (item.content) return formatFileSize(item.content.length);
    if (item.preview) return formatFileSize(item.preview.length);
    return '-';
}

// AI Image Editing Functions

// Apply AI edit to image
async function applyImageEdit() {
    if (!currentPreviewItem) return;
    
    const promptInput = document.getElementById('imageEditPrompt');
    const userPrompt = promptInput.value.trim();
    
    if (!userPrompt) {
        showImageEditStatus('Please enter editing instructions', 'error');
        return;
    }
    
    const statusEl = document.getElementById('imageEditStatus');
    const applyBtn = document.getElementById('applyImageEditBtn');
    const originalBtnText = applyBtn.innerHTML;
    
    try {
        // Show loading state
        applyBtn.innerHTML = '⏳ Processing...';
        applyBtn.disabled = true;
        showImageEditStatus('Sending image to AI for editing...', 'info');
        
        // Get current image data
        const imageEl = document.getElementById('previewImage');
        const imageData = currentImageData || imageEl.src;
        
        // Save current state to history before edit
        imageEditHistory.push(imageData);
        updateImageHistoryUI();
        
        // Get API settings
        const settings = await window.api.getSettings();
        if (!settings.llmApiKey) {
            throw new Error('API key not configured. Please set up your API key in Settings.');
        }
        
        // Call AI image edit
        const result = await window.clipboard.editImageWithAI({
            itemId: currentPreviewItem.id,
            imageData: imageData,
            prompt: userPrompt,
            apiKey: settings.llmApiKey
        });
        
        if (result.success && result.editedImage) {
            // Update the displayed image
            currentImageData = result.editedImage;
            imageEl.src = result.editedImage;
            
            showImageEditStatus('✓ Edit applied! Choose how to save below.', 'success');
            promptInput.value = ''; // Clear the prompt
            
            // Show undo button and save options
            document.getElementById('undoImageEditBtn').style.display = 'inline-block';
            document.getElementById('imageSaveOptions').style.display = 'block';
        } else {
            // Remove the history entry since edit failed
            imageEditHistory.pop();
            updateImageHistoryUI();
            
            // Check if we got a description (AI analysis preview) or need OpenAI key
            if (result.needsOpenAIKey || result.description) {
                // Show the AI analysis in a modal or expanded view
                showImageEditAnalysis(result.description, result.error, result.needsOpenAIKey);
            } else {
                throw new Error(result.error || 'Failed to edit image');
            }
        }
    } catch (error) {
        console.error('Error applying image edit:', error);
        showImageEditStatus(`Error: ${error.message}`, 'error');
    } finally {
        applyBtn.innerHTML = originalBtnText;
        applyBtn.disabled = false;
    }
}

// Undo last image edit
function undoImageEdit() {
    if (imageEditHistory.length === 0) {
        showImageEditStatus('Nothing to undo', 'info');
        return;
    }
    
    // Pop the last state and restore it
    const previousState = imageEditHistory.pop();
    currentImageData = previousState;
    
    const imageEl = document.getElementById('previewImage');
    imageEl.src = previousState;
    
    updateImageHistoryUI();
    showImageEditStatus('✓ Undo successful', 'success');
    
    // Hide undo button and save options if no more history
    if (imageEditHistory.length === 0) {
        document.getElementById('undoImageEditBtn').style.display = 'none';
        document.getElementById('imageSaveOptions').style.display = 'none';
    }
}

// Replace original image with edited version
async function replaceOriginalImage() {
    if (!currentPreviewItem || !currentImageData) {
        showImageEditStatus('No edited image to save', 'error');
        return;
    }
    
    const btn = document.getElementById('replaceOriginalBtn');
    const originalText = btn.innerHTML;
    
    try {
        btn.innerHTML = '⏳ Saving...';
        btn.disabled = true;
        
        // Call IPC to update the original item's image
        const result = await window.clipboard.updateItemImage(currentPreviewItem.id, currentImageData);
        
        if (result.success) {
            showImageEditStatus('✓ Original image replaced!', 'success');
            
            // Clear edit history since we've saved
            imageEditHistory = [];
            updateImageHistoryUI();
            
            // Hide save options
            document.getElementById('imageSaveOptions').style.display = 'none';
            document.getElementById('undoImageEditBtn').style.display = 'none';
            
            // Refresh the history list to show updated thumbnail
            await loadHistory();
            
            showNotification({
                title: 'Image Saved',
                body: 'Original image has been replaced with your edit',
                type: 'success'
            });
        } else {
            throw new Error(result.error || 'Failed to save image');
        }
    } catch (error) {
        console.error('Error replacing image:', error);
        showImageEditStatus('Error: ' + error.message, 'error');
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

// Save edited image as a new clipboard item
async function saveImageAsNew() {
    if (!currentImageData) {
        showImageEditStatus('No edited image to save', 'error');
        return;
    }
    
    const btn = document.getElementById('saveAsNewBtn');
    const originalText = btn.innerHTML;
    
    try {
        btn.innerHTML = '⏳ Saving...';
        btn.disabled = true;
        
        // Call IPC to create a new clipboard item with this image
        const result = await window.clipboard.saveImageAsNew(currentImageData, {
            sourceItemId: currentPreviewItem?.id,
            description: 'AI-edited image'
        });
        
        if (result.success) {
            showImageEditStatus('✓ Saved as new item!', 'success');
            
            // Clear edit history since we've saved
            imageEditHistory = [];
            updateImageHistoryUI();
            
            // Hide save options
            document.getElementById('imageSaveOptions').style.display = 'none';
            document.getElementById('undoImageEditBtn').style.display = 'none';
            
            // Refresh the history list to show new item
            await loadHistory();
            
            showNotification({
                title: 'Image Saved',
                body: 'Edited image saved as a new clipboard item',
                type: 'success'
            });
        } else {
            throw new Error(result.error || 'Failed to save image');
        }
    } catch (error) {
        console.error('Error saving image as new:', error);
        showImageEditStatus('Error: ' + error.message, 'error');
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

// Update the image history UI
function updateImageHistoryUI() {
    const historyEl = document.getElementById('imageEditHistory');
    const countEl = document.getElementById('editHistoryCount');
    
    if (imageEditHistory.length > 0) {
        historyEl.style.display = 'block';
        countEl.textContent = imageEditHistory.length;
    } else {
        historyEl.style.display = 'none';
    }
}

// Show AI image analysis (when actual editing isn't available)
function showImageEditAnalysis(description, fullMessage, needsOpenAIKey = false) {
    // Create a modal to show the AI analysis
    const existingModal = document.getElementById('imageAnalysisModal');
    if (existingModal) existingModal.remove();
    
    const modal = document.createElement('div');
    modal.id = 'imageAnalysisModal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.8);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 3000;
    `;
    
    const title = needsOpenAIKey ? 'OpenAI API Key Required' : 'AI Image Analysis';
    const icon = needsOpenAIKey ? '🔑' : '✨';
    
    let analysisSection = '';
    if (description) {
        analysisSection = `
            <div style="background: rgba(139, 92, 246, 0.1); border: 1px solid rgba(139, 92, 246, 0.2); border-radius: 8px; padding: 16px; margin-bottom: 16px;">
                <p style="margin: 0 0 12px 0; color: rgba(255, 255, 255, 0.7); font-size: 13px;">
                    The AI has analyzed your image and editing request:
                </p>
                <div style="color: rgba(255, 255, 255, 0.9); line-height: 1.6; white-space: pre-wrap; font-size: 14px;">
                    ${description.replace(/\n/g, '<br>')}
                </div>
            </div>
        `;
    }
    
    const noteContent = needsOpenAIKey 
        ? `<strong>🔑 Add OpenAI API Key:</strong> To edit images with AI, add your OpenAI API key in <strong>Settings → AI Image Editing</strong>. 
           Get your key at <a href="#" onclick="window.electronAPI?.openExternal?.('https://platform.openai.com/api-keys')" style="color: #8b5cf6;">platform.openai.com</a>`
        : `<strong>⚠️ Note:</strong> Image editing requires an OpenAI API key. Add it in Settings to enable this feature.`;
    
    modal.innerHTML = `
        <div style="background: rgba(40, 40, 40, 0.98); border-radius: 12px; padding: 24px; max-width: 600px; max-height: 80vh; overflow-y: auto; border: 1px solid rgba(139, 92, 246, 0.3); box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);">
            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
                <span style="font-size: 24px;">${icon}</span>
                <h3 style="margin: 0; color: #8b5cf6;">${title}</h3>
            </div>
            
            ${analysisSection}
            
            <div style="background: rgba(255, 200, 100, 0.1); border: 1px solid rgba(255, 200, 100, 0.3); border-radius: 8px; padding: 12px; margin-bottom: 16px;">
                <p style="margin: 0; color: rgba(255, 200, 100, 0.9); font-size: 12px;">
                    ${noteContent}
                </p>
            </div>
            
            <div style="display: flex; justify-content: flex-end; gap: 8px;">
                ${needsOpenAIKey ? `<button onclick="window.electronAPI?.openSettings?.(); this.closest('#imageAnalysisModal').remove();" class="btn" style="background: rgba(139, 92, 246, 0.2); color: #8b5cf6; border: 1px solid rgba(139, 92, 246, 0.3);">
                    Open Settings
                </button>` : ''}
                <button onclick="this.closest('#imageAnalysisModal').remove()" class="btn btn-primary" style="background: #8b5cf6;">
                    ${needsOpenAIKey ? 'Close' : 'Got it'}
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Close on click outside
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
    });
    
    // Close on Escape
    const closeOnEscape = (e) => {
        if (e.key === 'Escape') {
            modal.remove();
            document.removeEventListener('keydown', closeOnEscape);
        }
    };
    document.addEventListener('keydown', closeOnEscape);
}

// Show image edit status message
function showImageEditStatus(message, type = 'info') {
    const statusEl = document.getElementById('imageEditStatus');
    statusEl.style.display = 'block';
    statusEl.textContent = message;
    
    // Set color based on type
    switch (type) {
        case 'success':
            statusEl.style.color = '#64ff64';
            break;
        case 'error':
            statusEl.style.color = '#ff6464';
            break;
        default:
            statusEl.style.color = 'rgba(255, 255, 255, 0.6)';
    }
    
    // Auto-hide success messages
    if (type === 'success') {
        setTimeout(() => {
            statusEl.style.display = 'none';
        }, 3000);
    }
}

// Reset image edit state when opening a new image
function resetImageEditState() {
    imageEditHistory = [];
    currentImageData = null;
    document.getElementById('imageEditPrompt').value = '';
    document.getElementById('undoImageEditBtn').style.display = 'none';
    document.getElementById('imageEditStatus').style.display = 'none';
    document.getElementById('imageEditHistory').style.display = 'none';
}

// Save edited image
async function saveEditedImage() {
    if (!currentPreviewItem || !currentImageData) return;
    
    try {
        const result = await window.clipboard.updateItemImage(currentPreviewItem.id, currentImageData);
        
        if (result.success) {
            showImageEditStatus('✓ Image saved!', 'success');
            // Clear history after save
            imageEditHistory = [];
            updateImageHistoryUI();
            document.getElementById('undoImageEditBtn').style.display = 'none';
            
            // Refresh history to show updated thumbnail
            await loadHistory();
        } else {
            throw new Error(result.error || 'Failed to save image');
        }
    } catch (error) {
        showImageEditStatus(`Save error: ${error.message}`, 'error');
    }
}

// Setup preview modal event listeners
function setupPreviewEventListeners() {
    // Mode toggle button
    document.getElementById('previewModeBtn').addEventListener('click', togglePreviewEditMode);
    
    // Copy button
    document.getElementById('previewCopyBtn').addEventListener('click', copyPreviewContent);
    
    // Close button
    document.getElementById('previewClose').addEventListener('click', hidePreviewModal);
    
    // Edit mode buttons
    document.getElementById('previewEditCancel').addEventListener('click', cancelPreviewEdit);
    document.getElementById('previewEditSave').addEventListener('click', savePreviewContent);
    
    // Update stats on input
    document.getElementById('previewEditTextarea').addEventListener('input', updateEditStats);
    
    // AI Image editing buttons
    document.getElementById('applyImageEditBtn').addEventListener('click', applyImageEdit);
    document.getElementById('undoImageEditBtn').addEventListener('click', undoImageEdit);
    document.getElementById('replaceOriginalBtn').addEventListener('click', replaceOriginalImage);
    document.getElementById('saveAsNewBtn').addEventListener('click', saveImageAsNew);
    
    // Text-to-Speech buttons
    document.getElementById('generateSpeechBtn').addEventListener('click', generateSpeech);
    document.getElementById('saveTtsAudioBtn').addEventListener('click', saveTTSAudio);
    
    // Transcription buttons
    document.getElementById('transcribeBtn').addEventListener('click', transcribeMedia);
    document.getElementById('copyTranscriptionBtn').addEventListener('click', copyTranscription);
    document.getElementById('saveTranscriptionBtn').addEventListener('click', saveTranscription);
    
    // Video Editor button
    document.getElementById('openVideoEditorBtn').addEventListener('click', openInVideoEditor);
    
    // Close on Escape when preview is open
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.getElementById('previewModal').style.display === 'flex') {
            if (isEditMode) {
                cancelPreviewEdit();
            } else {
                hidePreviewModal();
            }
        }
    });
    
    // Click outside to close
    document.getElementById('previewModal').addEventListener('click', (e) => {
        if (e.target.id === 'previewModal') {
            if (isEditMode) {
                // Ask to confirm if in edit mode
                if (confirm('Discard unsaved changes?')) {
                    hidePreviewModal();
                }
            } else {
                hidePreviewModal();
            }
        }
    });
}

// Smart Export function
async function smartExportSpace(spaceId) {
    try {
        // Check if settings are configured
        const settings = await window.api.getSettings();
        if (!settings.llmApiKey) {
            showNotification({
                title: 'API Key Required',
                body: 'Please configure your LLM API key in Settings to use Smart Export',
                type: 'error'
            });
            
            // Open settings window
            await window.api.send('open-settings');
            return;
        }
        
        // Show loading notification
        showNotification({
            title: 'Smart Export',
            body: 'Opening AI-powered export preview...',
            type: 'info'
        });
        
        // Open smart export preview
        await window.clipboard.smartExportSpace(spaceId);
        
    } catch (error) {
        console.error('Error opening smart export:', error);
        showNotification({
            title: 'Error',
            body: error.message || 'Failed to open smart export',
            type: 'error'
        });
    }
}

// ========== VIDEO PREVIEW MODAL ==========

// Format seconds to timecode
function formatSegmentTimeGlobal(seconds) {
    if (!seconds && seconds !== 0) return '00:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
        return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// Auto-generate AI summary when modal opens
async function autoGenerateSummary(itemId, transcript, title, descriptionEl) {
    try {
        const result = await window.clipboard.generateSummary({
            itemId: itemId,
            transcript: transcript,
            title: title
        });
        
        if (result.success) {
            descriptionEl.innerHTML = formatSummaryText(result.summary);
            
            // Update local item metadata
            if (currentVideoItem && currentVideoItem.metadata) {
                currentVideoItem.metadata.aiSummary = result.summary;
            }
        } else {
            descriptionEl.innerHTML = `<p style="color: rgba(255,100,100,0.8);">Failed to generate summary: ${result.error}</p>`;
        }
    } catch (err) {
        descriptionEl.innerHTML = `<p style="color: rgba(255,100,100,0.8);">Error: ${err.message}</p>`;
    }
}

// Format AI summary text with proper paragraphs and bullet points
function formatSummaryText(text) {
    if (!text) return '';
    
    // Escape HTML first
    const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    
    // Split by double newlines (sections)
    const sections = escaped
        .split(/\n\n+/)
        .map(s => s.trim())
        .filter(s => s.length > 0);
    
    // Process each section
    return sections.map(section => {
        // Check if this is a header (OVERVIEW:, KEY POINTS:, MAIN TAKEAWAYS:)
        const headerMatch = section.match(/^(OVERVIEW|KEY POINTS|MAIN TAKEAWAYS|SUMMARY):\s*/i);
        if (headerMatch) {
            const header = headerMatch[1].toUpperCase();
            const content = section.substring(headerMatch[0].length).trim();
            
            // Check if content has bullet points
            if (content.includes('•') || content.includes('- ')) {
                const bullets = content
                    .split(/\n/)
                    .map(line => line.trim())
                    .filter(line => line.length > 0)
                    .map(line => {
                        // Remove bullet character and format
                        const bulletContent = line.replace(/^[•\-]\s*/, '');
                        return `<li style="margin-bottom: 8px; line-height: 1.5;">${bulletContent}</li>`;
                    })
                    .join('');
                return `<div style="margin-bottom: 16px;"><strong style="color: rgba(139, 92, 246, 0.9); font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">${header}</strong><ul style="margin: 8px 0 0 0; padding-left: 20px; list-style: none;">${bullets}</ul></div>`;
            } else {
                return `<div style="margin-bottom: 16px;"><strong style="color: rgba(139, 92, 246, 0.9); font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">${header}</strong><p style="margin: 8px 0 0 0; line-height: 1.6;">${content.replace(/\n/g, '<br>')}</p></div>`;
            }
        }
        
        // Check if section contains bullet points
        if (section.includes('•') || section.match(/^\s*-\s/m)) {
            const lines = section.split(/\n/);
            let html = '';
            let inList = false;
            
            lines.forEach(line => {
                const trimmed = line.trim();
                if (trimmed.startsWith('•') || trimmed.startsWith('- ')) {
                    if (!inList) {
                        html += '<ul style="margin: 8px 0; padding-left: 20px; list-style: disc;">';
                        inList = true;
                    }
                    const bulletContent = trimmed.replace(/^[•\-]\s*/, '');
                    html += `<li style="margin-bottom: 6px; line-height: 1.5;">${bulletContent}</li>`;
                } else if (trimmed) {
                    if (inList) {
                        html += '</ul>';
                        inList = false;
                    }
                    html += `<p style="margin: 0 0 8px 0; line-height: 1.6;">${trimmed}</p>`;
                }
            });
            
            if (inList) html += '</ul>';
            return `<div style="margin-bottom: 12px;">${html}</div>`;
        }
        
        // Regular paragraph
        return `<p style="margin: 0 0 12px 0; line-height: 1.6;">${section.replace(/\n/g, '<br>')}</p>`;
    }).join('');
}

let currentVideoItem = null;
let videoTranscriptPlain = '';
let videoTranscriptTimecoded = '';

// Show video preview modal
async function showVideoPreviewModal(itemId) {
    console.log('[VideoModal] Opening video preview for:', itemId);
    
    const modal = document.getElementById('videoPreviewModal');
    if (!modal) {
        console.error('[VideoModal] Modal element not found!');
        return;
    }
    
    // Fetch fresh item data to ensure we have the latest file paths
    let item = history.find(h => h.id === itemId);
    
    // Try to get fresh data from backend
    try {
        const freshHistory = await window.clipboard.getHistory();
        const freshItem = freshHistory.find(h => h.id === itemId);
        if (freshItem) {
            item = freshItem;
            // Update the history array as well
            const idx = history.findIndex(h => h.id === itemId);
            if (idx >= 0) {
                history[idx] = freshItem;
            }
        }
    } catch (e) {
        console.warn('[VideoModal] Could not refresh item data:', e);
    }
    
    if (!item) {
        console.error('[VideoModal] Video item not found:', itemId);
        return;
    }
    
    console.log('[VideoModal] Item data:', { 
        filePath: item.filePath, 
        content: item.content,
        metadataFilePath: item.metadata?.filePath 
    });
    
    currentVideoItem = item;
    const metadata = item.metadata || {};
    
    // Set video source - find the actual VIDEO file, not audio
    const videoPlayer = document.getElementById('videoModalPlayer');
    let videoPath = null;
    
    // Video file extensions to look for
    const videoExtensions = ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.m4v'];
    const audioExtensions = ['.mp3', '.wav', '.aac', '.m4a', '.ogg'];
    
    const isVideoFile = (path) => {
        if (!path || typeof path !== 'string') return false;
        const lower = path.toLowerCase();
        return videoExtensions.some(ext => lower.endsWith(ext));
    };
    
    const isAudioFile = (path) => {
        if (!path || typeof path !== 'string') return false;
        const lower = path.toLowerCase();
        return audioExtensions.some(ext => lower.endsWith(ext));
    };
    
    // Collect all possible paths to check
    const possiblePaths = [
        metadata.filePath,
        item.filePath,
        item.content,
        metadata.videoPath  // in case we have a separate videoPath field
    ];
    
    console.log('[VideoModal] Checking possible paths:', possiblePaths);
    
    // First, try to find a video file
    for (const path of possiblePaths) {
        if (isVideoFile(path)) {
            videoPath = path;
            break;
        }
    }
    
    // If no explicit video found, try any non-audio file
    if (!videoPath) {
        for (const path of possiblePaths) {
            if (path && typeof path === 'string' && !isAudioFile(path) && path.includes('/')) {
                videoPath = path;
                break;
            }
        }
    }
    
    console.log('[VideoModal] Looking for video file:', {
        metadataFilePath: metadata.filePath,
        itemFilePath: item.filePath,
        itemContent: item.content,
        foundPath: videoPath
    });
    
    if (videoPath) {
        // Ensure file:// protocol
        if (!videoPath.startsWith('file://')) {
            videoPath = `file://${videoPath}`;
        }
        videoPlayer.src = videoPath;
        
        // Set poster image (thumbnail) to avoid black frame
        if (metadata.localThumbnail) {
            let thumbnailPath = metadata.localThumbnail;
            if (!thumbnailPath.startsWith('file://')) {
                thumbnailPath = `file://${thumbnailPath}`;
            }
            videoPlayer.poster = thumbnailPath;
            console.log('[VideoModal] Poster image set to:', thumbnailPath);
        }
        
        videoPlayer.style.display = 'block';
        console.log('[VideoModal] Video source set to:', videoPath);
    } else {
        console.warn('[VideoModal] No video file found for item:', item.id);
        // Show a message in the player area
        const playerContainer = videoPlayer.parentElement;
        playerContainer.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:rgba(255,255,255,0.5);font-size:14px;">Video file not found</div>';
    }
    
    // Set title and meta
    document.getElementById('videoModalTitle').textContent = metadata.title || item.fileName || 'Video';
    document.getElementById('videoModalChannel').textContent = metadata.uploader || metadata.channel || 'Unknown';
    document.getElementById('videoModalDuration').textContent = metadata.duration || '--:--';
    document.getElementById('videoModalSize').textContent = formatFileSize(item.fileSize || 0);
    
    // Source badge
    const sourceBadge = document.getElementById('videoModalSource');
    if (metadata.source === 'youtube' || metadata.youtubeUrl) {
        sourceBadge.textContent = 'YouTube';
        sourceBadge.style.display = 'inline';
    } else {
        sourceBadge.style.display = 'none';
    }
    
    // Feature badges
    const badgesContainer = document.getElementById('videoModalBadges');
    let badges = '<span class="video-feature-badge video">Video</span>';
    if (metadata.audioPath) badges += '<span class="video-feature-badge audio">Audio</span>';
    if (metadata.transcript) badges += '<span class="video-feature-badge transcript">Transcript</span>';
    if (metadata.storyBeats && metadata.storyBeats.length > 0) badges += '<span class="video-feature-badge beats">Story Beats</span>';
    if (metadata.speakers && metadata.speakers.length > 0) badges += `<span class="video-feature-badge speakers">${metadata.speakers.length} Speaker${metadata.speakers.length > 1 ? 's' : ''}</span>`;
    badgesContainer.innerHTML = badges;
    
    // Overview tab - show AI summary if available, otherwise show YouTube description with option to generate
    const descriptionEl = document.getElementById('videoDescription');
    const generateBtn = document.getElementById('generateSummaryBtn');
    
    if (metadata.aiSummary) {
        // Show AI-generated summary with proper formatting
        descriptionEl.innerHTML = formatSummaryText(metadata.aiSummary);
        generateBtn.style.display = 'none';
    } else if (videoTranscriptPlain) {
        // Has transcript but no AI summary - auto-generate it
        descriptionEl.innerHTML = '<p style="color: rgba(255,255,255,0.5); font-style: italic;"><span style="display: inline-block; animation: pulse 1.5s infinite;">⏳</span> Generating AI summary from transcript...</p>';
        generateBtn.style.display = 'none';
        
        // Auto-generate summary
        autoGenerateSummary(item.id, videoTranscriptPlain, metadata.title || item.fileName, descriptionEl);
    } else if (metadata.longDescription || metadata.youtubeDescription) {
        // No transcript but has YouTube description - show it
        descriptionEl.innerHTML = formatSummaryText(metadata.longDescription || metadata.youtubeDescription);
        generateBtn.style.display = 'none';
    } else {
        // No content at all
        descriptionEl.textContent = 'No description available.';
        generateBtn.style.display = 'none';
    }
    
    // Topics
    const topicsContainer = document.getElementById('videoTopics');
    if (metadata.topics && metadata.topics.length > 0) {
        topicsContainer.innerHTML = metadata.topics.map(t => `<span class="video-topic-badge">${escapeHtml(t)}</span>`).join('');
    } else {
        topicsContainer.innerHTML = '<span class="no-content">No topics identified</span>';
    }
    
    // Speakers
    const speakersContainer = document.getElementById('videoSpeakers');
    if (metadata.speakers && metadata.speakers.length > 0) {
        speakersContainer.innerHTML = metadata.speakers.map(s => `<div class="video-speaker">• ${escapeHtml(s)}</div>`).join('');
    } else {
        speakersContainer.innerHTML = '<span class="no-content">No speakers identified</span>';
    }
    
    // Transcript tab - always use metadata.transcript (will contain speaker labels if identified)
    videoTranscriptPlain = '';
    videoTranscriptTimecoded = '';
    
    if (metadata.transcript) {
        videoTranscriptPlain = typeof metadata.transcript === 'string' ? metadata.transcript : metadata.transcript.text || '';
        
        // Generate timecoded version (only if speakers haven't been identified)
        if (!metadata.speakersIdentified && metadata.transcriptSegments && metadata.transcriptSegments.length > 0) {
            videoTranscriptTimecoded = metadata.transcriptSegments.map(seg => 
                `[${seg.startFormatted || formatSegmentTimeGlobal(seg.start)}] ${seg.text}`
            ).join('\n');
        }
        
        console.log('[VideoModal] Loaded transcript, speakers identified:', !!metadata.speakersIdentified);
    }
    
    // Update Identify Speakers button based on whether speakers are already identified
    const identifySpeakersBtn = document.getElementById('videoIdentifySpeakers');
    if (identifySpeakersBtn) {
        if (metadata.speakersIdentified) {
            identifySpeakersBtn.innerHTML = '<span>🔄</span> Re-identify Speakers';
            identifySpeakersBtn.title = `Last identified: ${new Date(metadata.speakersIdentifiedAt).toLocaleString()} (Model: ${metadata.speakersIdentifiedModel})`;
        } else {
            identifySpeakersBtn.innerHTML = '<span>✨</span> Identify Speakers';
            identifySpeakersBtn.title = 'Use AI to identify and label speakers in the transcript';
        }
    }
    
    const transcriptText = document.getElementById('videoTranscriptText');
    transcriptText.textContent = videoTranscriptPlain || 'No transcript available. Click "Identify Speakers" to generate one.';
    
    // Story beats tab
    const beatsContainer = document.getElementById('videoStoryBeats');
    if (metadata.storyBeats && metadata.storyBeats.length > 0) {
        beatsContainer.innerHTML = metadata.storyBeats.map((beat, i) => `
            <div class="story-beat">
                <div class="story-beat-number">${i + 1}</div>
                <div class="story-beat-text">${escapeHtml(beat)}</div>
            </div>
        `).join('');
    } else {
        beatsContainer.innerHTML = '<span class="no-content">No story beats available. Story beats will be generated when AI metadata is created.</span>';
    }
    
    // Details tab
    document.getElementById('videoFileName').textContent = item.fileName || '-';
    document.getElementById('videoFileSize').textContent = formatFileSize(item.fileSize || 0);
    document.getElementById('videoFileDuration').textContent = metadata.duration || '-';
    document.getElementById('videoFileSource').textContent = metadata.source || item.source || 'Local';
    document.getElementById('videoFileDate').textContent = new Date(item.timestamp).toLocaleString();
    document.getElementById('videoFileUrl').textContent = metadata.youtubeUrl || '-';
    
    // Update audio button state
    const audioBtn = document.getElementById('videoDownloadAudio');
    if (metadata.audioPath) {
        audioBtn.innerHTML = '<span>🎵</span> Download Audio';
        audioBtn.disabled = false;
    } else {
        audioBtn.innerHTML = '<span>🎵</span> Extract Audio';
        audioBtn.disabled = false;
    }
    
    // Update transcript button state
    const transcriptBtn = document.getElementById('videoCopyTranscript');
    transcriptBtn.disabled = !videoTranscriptPlain;
    
    // Reset to first tab
    switchVideoTab('overview');
    
    // Show modal
    modal.style.display = 'flex';
}

// Switch video tabs
function switchVideoTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('.video-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabName);
    });
    
    // Update tab content
    document.querySelectorAll('.video-tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById('tab' + tabName.charAt(0).toUpperCase() + tabName.slice(1)).classList.add('active');
}

// Close video modal
function closeVideoModal() {
    const modal = document.getElementById('videoPreviewModal');
    const videoPlayer = document.getElementById('videoModalPlayer');
    videoPlayer.pause();
    videoPlayer.src = '';
    videoPlayer.poster = '';
    modal.style.display = 'none';
    currentVideoItem = null;
}

// Setup video modal event listeners
function setupVideoModalListeners() {
    // Close button
    document.getElementById('videoModalClose').addEventListener('click', closeVideoModal);
    
    // Click outside to close
    document.getElementById('videoPreviewModal').addEventListener('click', (e) => {
        if (e.target.id === 'videoPreviewModal') closeVideoModal();
    });
    
    // Tab switching
    document.querySelectorAll('.video-tab').forEach(tab => {
        tab.addEventListener('click', () => switchVideoTab(tab.dataset.tab));
    });
    
    // Timecode toggle
    document.getElementById('videoTimecodeToggle').addEventListener('change', (e) => {
        const transcriptText = document.getElementById('videoTranscriptText');
        if (e.target.checked && videoTranscriptTimecoded) {
            transcriptText.textContent = videoTranscriptTimecoded;
        } else {
            transcriptText.textContent = videoTranscriptPlain || 'No transcript available.';
        }
    });
    
    // Identify speakers button
    document.getElementById('videoIdentifySpeakers').addEventListener('click', async () => {
        if (!currentVideoItem) return;
        
        const btn = document.getElementById('videoIdentifySpeakers');
        const status = document.getElementById('videoTranscriptStatus');
        
        btn.disabled = true;
        btn.innerHTML = '<span>⏳</span> Analyzing...';
        status.textContent = 'Identifying speakers...';
        status.style.color = 'rgba(255, 255, 255, 0.7)';
        
        // Set up progress listener
        let removeProgressListener = null;
        if (window.clipboard.onSpeakerIdProgress) {
            removeProgressListener = window.clipboard.onSpeakerIdProgress((progress) => {
                console.log('[VideoModal-SpeakerID] Progress:', progress.status);
                
                // Update button and status with progress
                if (progress.chunk && progress.total) {
                    const pct = Math.round((progress.chunk / progress.total) * 100);
                    btn.innerHTML = `<span>⏳</span> ${pct}%`;
                    status.textContent = progress.status;
                } else {
                    status.textContent = progress.status;
                }
                
                // Update transcript with partial results
                if (progress.partialResult) {
                    document.getElementById('videoTranscriptText').textContent = progress.partialResult;
                    videoTranscriptPlain = progress.partialResult;
                }
            });
        }
        
        // Set a timeout to show warning if taking too long
        const timeoutWarning = setTimeout(() => {
            status.textContent = 'Still processing... This may take up to 2 minutes for long transcripts.';
            status.style.color = 'rgba(255, 200, 100, 0.8)';
        }, 30000); // Show warning after 30 seconds
        
        try {
            const metadata = currentVideoItem.metadata || {};
            const contextHint = [metadata.title, metadata.uploader, metadata.youtubeDescription].filter(Boolean).join(' | ');
            
            console.log('[VideoModal-SpeakerID] Starting speaker identification...');
            const result = await window.clipboard.identifySpeakers({
                itemId: currentVideoItem.id,
                transcript: videoTranscriptPlain,
                contextHint: contextHint
            });
            
            clearTimeout(timeoutWarning);
            
            // Clean up progress listener
            if (removeProgressListener) {
                removeProgressListener();
            }
            
            console.log('[VideoModal-SpeakerID] Result:', result);
            
            if (result.success) {
                document.getElementById('videoTranscriptText').textContent = result.transcript;
                videoTranscriptPlain = result.transcript;
                status.textContent = `✅ Speakers identified successfully! (Model: ${result.model})`;
                status.style.color = 'rgba(100, 255, 100, 0.9)';
                
                // Reload history to get updated metadata from disk, then refresh modal
                setTimeout(async () => {
                    await loadHistory();
                    status.textContent = '';
                    showVideoPreviewModal(currentVideoItem.id);
                }, 2000);
            } else {
                const errorMsg = result.error || 'Failed to identify speakers';
                console.error('[VideoModal-SpeakerID] Error:', errorMsg);
                status.textContent = '❌ Error: ' + errorMsg;
                status.style.color = 'rgba(255, 100, 100, 0.9)';
                
                // Show alert with full error
                alert('Speaker Identification Failed\n\n' + errorMsg + '\n\nPlease check your API key and model settings.');
            }
        } catch (err) {
            clearTimeout(timeoutWarning);
            console.error('[VideoModal-SpeakerID] Exception:', err);
            
            const errorMsg = err.message || 'Unknown error occurred';
            status.textContent = '❌ Error: ' + errorMsg;
            status.style.color = 'rgba(255, 100, 100, 0.9)';
            
            // Show alert with full error
            alert('Speaker Identification Failed\n\n' + errorMsg + '\n\nCheck the console for more details.');
            
            // Clean up progress listener on error
            if (removeProgressListener) {
                removeProgressListener();
            }
        }
        
        btn.disabled = false;
        btn.innerHTML = '<span>✨</span> Identify Speakers';
    });
    
    // Download audio button
    document.getElementById('videoDownloadAudio').addEventListener('click', async () => {
        if (!currentVideoItem) return;
        
        const btn = document.getElementById('videoDownloadAudio');
        const metadata = currentVideoItem.metadata || {};
        
        if (metadata.audioPath) {
            // Open audio file location
            if (window.electron?.shell?.showItemInFolder) {
                window.electron.shell.showItemInFolder(metadata.audioPath);
            } else {
                alert('Audio file: ' + metadata.audioPath);
            }
        } else {
            // Extract audio
            btn.disabled = true;
            btn.innerHTML = '<span>⏳</span> 0%';
            
            // Set up progress listener
            let removeProgressListener = null;
            if (window.clipboard.onAudioExtractProgress) {
                removeProgressListener = window.clipboard.onAudioExtractProgress((data) => {
                    if (data.itemId === currentVideoItem.id) {
                        btn.innerHTML = `<span>⏳</span> ${data.percent}%`;
                    }
                });
            }
            
            try {
                const result = await window.clipboard.extractAudio(currentVideoItem.id);
                
                // Clean up listener
                if (removeProgressListener) removeProgressListener();
                
                if (result.success) {
                    btn.innerHTML = '<span>✅</span> Audio Ready!';
                    setTimeout(() => {
                        btn.innerHTML = '<span>🎵</span> Download Audio';
                        btn.disabled = false;
                        showVideoPreviewModal(currentVideoItem.id);
                    }, 1500);
                } else {
                    alert('Failed to extract audio: ' + (result.error || 'Unknown error'));
                    btn.innerHTML = '<span>🎵</span> Extract Audio';
                    btn.disabled = false;
                }
            } catch (err) {
                // Clean up listener
                if (removeProgressListener) removeProgressListener();
                
                alert('Error: ' + err.message);
                btn.innerHTML = '<span>🎵</span> Extract Audio';
                btn.disabled = false;
            }
        }
    });
    
    // Copy transcript button
    document.getElementById('videoCopyTranscript').addEventListener('click', () => {
        if (videoTranscriptPlain) {
            navigator.clipboard.writeText(videoTranscriptPlain);
            const btn = document.getElementById('videoCopyTranscript');
            const originalText = btn.innerHTML;
            btn.innerHTML = '<span>✅</span> Copied!';
            setTimeout(() => btn.innerHTML = originalText, 1500);
        }
    });
    
    // Generate AI Summary button
    document.getElementById('generateSummaryBtn').addEventListener('click', async () => {
        if (!currentVideoItem || !videoTranscriptPlain) return;
        
        const btn = document.getElementById('generateSummaryBtn');
        const descriptionEl = document.getElementById('videoDescription');
        
        btn.disabled = true;
        btn.innerHTML = '<span>⏳</span> Generating...';
        descriptionEl.textContent = 'Generating AI summary from transcript...';
        
        try {
            const metadata = currentVideoItem.metadata || {};
            const result = await window.clipboard.generateSummary({
                itemId: currentVideoItem.id,
                transcript: videoTranscriptPlain,
                title: metadata.title || currentVideoItem.fileName
            });
            
            if (result.success) {
                // Format paragraphs properly
                descriptionEl.innerHTML = formatSummaryText(result.summary);
                btn.style.display = 'none';
                
                // Update local metadata
                if (currentVideoItem.metadata) {
                    currentVideoItem.metadata.aiSummary = result.summary;
                }
            } else {
                descriptionEl.textContent = 'Failed to generate summary: ' + result.error;
                btn.innerHTML = '<span>✨</span> Retry';
                btn.disabled = false;
            }
        } catch (err) {
            descriptionEl.textContent = 'Error: ' + err.message;
            btn.innerHTML = '<span>✨</span> Retry';
            btn.disabled = false;
        }
    });
    
    // Open file button
    document.getElementById('videoOpenFile').addEventListener('click', () => {
        if (currentVideoItem?.filePath) {
            if (window.electron?.shell?.showItemInFolder) {
                window.electron.shell.showItemInFolder(currentVideoItem.filePath);
            }
        }
    });
    
    // ESC to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.getElementById('videoPreviewModal').style.display === 'flex') {
            closeVideoModal();
        }
    });
}

// Setup drag events for history items
function setupHistoryItemDrag() {
    const historyList = document.getElementById('historyList');
    
    if (!historyList) return;
    
    // Use event delegation for dynamically created history items
    historyList.addEventListener('dragstart', (e) => {
        const historyItem = e.target.closest('.history-item');
        if (!historyItem) return;
        
        const itemId = historyItem.dataset.id;
        if (!itemId) return;
        
        console.log('[Drag] Started dragging item:', itemId);
        
        // Set drag data
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', itemId);
        
        // Visual feedback
        historyItem.style.opacity = '0.5';
        
        // Store the item being dragged
        historyItem.classList.add('dragging');
    });
    
    historyList.addEventListener('dragend', (e) => {
        const historyItem = e.target.closest('.history-item');
        if (!historyItem) return;
        
        // Reset visual state
        historyItem.style.opacity = '1';
        historyItem.classList.remove('dragging');
    });
}

// Initialize when DOM is ready
// Add a small delay to ensure preload script is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    // Wait a moment for preload to be ready
    setTimeout(() => {
        init();
        setupVideoModalListeners();
        setupHistoryItemDrag();
    }, 100);
}); 