// Cross-platform helper to convert file path to file:// URL
// Works on both Windows (C:\path\to\file) and Unix (/path/to/file)
function pathToFileUrl(filePath) {
    if (!filePath) return '';
    // Already a file:// URL
    if (filePath.startsWith('file://')) return filePath;
    // Already a data: URL
    if (filePath.startsWith('data:')) return filePath;
    
    // Normalize backslashes to forward slashes (Windows paths)
    let normalized = filePath.replace(/\\/g, '/');
    
    // Handle Windows drive letters (C: -> /C:)
    if (/^[a-zA-Z]:/.test(normalized)) {
        normalized = '/' + normalized;
    }
    
    // Encode special characters in path components, but preserve slashes
    const encoded = normalized.split('/').map(component => 
        encodeURIComponent(component).replace(/%3A/g, ':') // Keep colons for drive letters
    ).join('/');
    
    return 'file://' + encoded;
}

// Global state
let currentFilter = 'all';
let currentSpace = null;
let history = [];
let spacesData = [];  // Renamed from 'spaces' to avoid conflict with window.spaces API
let contextMenuItem = null;
let spacesEnabled = true;
let activeSpaceId = null;
let currentView = 'list'; // Add view state
let screenshotCaptureEnabled = true;
let selectedTags = []; // Tags currently selected for filtering
let allTags = {}; // Map of tag -> count
let selectedItems = new Set(); // Track selected item IDs for bulk operations

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
        
        // Wait for preload with exponential backoff (much faster than fixed 500ms wait)
        if (!window.clipboard) {
            console.log('Clipboard API not ready, waiting with backoff...');
            let delay = 10;
            const maxDelay = 200;
            const maxAttempts = 10;
            for (let attempt = 0; attempt < maxAttempts && !window.clipboard; attempt++) {
                await new Promise(resolve => setTimeout(resolve, delay));
                delay = Math.min(delay * 2, maxDelay);
            }
        }
        
        // If clipboard API is still not available, show a helpful error
        if (!window.clipboard) {
            throw new Error('The clipboard manager is not initialized. Please restart the app and try again.');
        }
        
        console.log('✓ Clipboard API is available');
        
        // PERFORMANCE: Hide loading overlay immediately to show UI shell
        // This makes the app feel much more responsive
        if (loadingOverlay) {
            loadingOverlay.style.display = 'none';
        }
        
        // Set up event listeners immediately so UI is interactive
        setupEventListeners();
        setupPreviewEventListeners();
        setView('list');
        
        
        document.getElementById('searchInput').focus();
        
        
        // PERFORMANCE: Parallelize independent API calls
        console.log('Loading data in parallel...');
        const [spacesEnabledResult, screenshotResult, activeSpaceResult, spacesResult] = await Promise.all([
            window.clipboard.getSpacesEnabled(),
            window.clipboard.getScreenshotCaptureEnabled(),
            window.clipboard.getActiveSpace(),
            window.clipboard.getSpaces()
        ]);
        
        // Apply results
        spacesEnabled = spacesEnabledResult;
        console.log('Spaces enabled:', spacesEnabled);
        updateSpacesVisibility();
        
        screenshotCaptureEnabled = screenshotResult;
        console.log('Screenshot capture enabled:', screenshotCaptureEnabled);
        updateScreenshotIndicator();
        
        // Set active space from result
        activeSpaceId = activeSpaceResult?.spaceId || null;
        updateActiveSpaceIndicator();
        console.log('Active space ID:', activeSpaceId);
        
        // Set spaces data and render
        spacesData = spacesResult || [];
        renderSpaces();
        console.log('Loaded spaces:', spacesData.length);
        
        // Load history (depends on currentSpace which may be set by spaces data)
        await loadHistory();
        console.log('Loaded history items:', history.length);
        
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
    historyList.classList.remove('grid-view', 'list-view', 'grouped-view');
    historyList.classList.add(`${view}-view`);
    
    // Update button states
    document.querySelectorAll('.view-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === view);
    });
    
    // Re-render to apply view-specific styles
    if (view === 'grouped') {
        renderGroupedView();
    } else {
        renderHistory();
    }
}

// Update spaces visibility based on enabled state
function updateSpacesVisibility() {
    const sidebar = document.querySelector('.sidebar');
    const mainLayout = document.querySelector('.main-layout');
    
    if (spacesEnabled) {
        sidebar.style.display = 'flex';
        mainLayout.style.gridTemplateColumns = '300px 1fr';
    } else {
        sidebar.style.display = 'none';
        mainLayout.style.gridTemplateColumns = '1fr';
        // Reset to "All Items" view when spaces are disabled
        currentSpace = null;
    }
}

// Load spaces
async function loadSpaces() {
    spacesData = await window.clipboard.getSpaces();
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
            const result = await window.clipboard.getSpaceItems(currentSpace);
            // Handle both { success, items } format and raw array format
            if (result && result.items && Array.isArray(result.items)) {
                history = result.items;
            } else if (Array.isArray(result)) {
                history = result;
            } else {
                console.error('Unexpected space items format:', result);
                history = [];
            }
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
                    <div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" style="width: 40px; height: 40px;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
                    <div class="empty-text">Error loading items</div>
                    <div class="empty-hint">${error.message}</div>
                </div>
            `;
        }
        history = [];
    }
}

// Render spaces in sidebar

// Generate auto-title for AI conversations from first user message
function generateConversationTitle(firstMessageContent, provider) {
    if (!firstMessageContent) {
        return `${provider} Conversation`;
    }
    
    const text = firstMessageContent.trim();
    
    // Remove common prefixes like "Can you", "Please", "I want to", etc.
    let cleanText = text
        .replace(/^(can you|could you|please|i want to|i need to|i'd like to|help me|tell me|explain|show me|write|create|make|build|how do i|how can i|what is|what are|why is|why are)\s+/i, '')
        .trim();
    
    // If the cleaned text is too short, use original
    if (cleanText.length < 10) {
        cleanText = text;
    }
    
    // Extract first sentence or meaningful chunk
    const sentenceMatch = cleanText.match(/^[^.!?\n]+[.!?]?/);
    let title = sentenceMatch ? sentenceMatch[0].trim() : cleanText;
    
    // Remove trailing punctuation for cleaner title
    title = title.replace(/[.!?,;:]+$/, '').trim();
    
    // Truncate if too long
    if (title.length > 50) {
        title = title.substring(0, 47) + '...';
    }
    
    // Capitalize first letter
    title = title.charAt(0).toUpperCase() + title.slice(1);
    
    return title || `${provider} Conversation`;
}

// Get provider-specific icon SVG for AI conversations
function getProviderIcon(providerClass) {
    switch (providerClass) {
        case 'claude':
            // Claude/Anthropic - stylized "C" 
            return `<svg viewBox="0 0 24 24" fill="currentColor" style="width: 18px; height: 18px;">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15h-2v-2h2v2zm2.07-7.75l-.9.92C11.45 10.9 11 11.5 11 13h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H6c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/>
            </svg>`;
        case 'chatgpt':
            // ChatGPT/OpenAI - hexagon style
            return `<svg viewBox="0 0 24 24" fill="currentColor" style="width: 18px; height: 18px;">
                <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.8956zm16.0993 3.8558L12.6 8.3829l2.02-1.1638a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.4069-.6813zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.1408 1.6465 4.4708 4.4708 0 0 1 .5765 3.0137zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.5056-2.6067-1.5056z"/>
            </svg>`;
        case 'grok':
            // Grok/X - X logo style
            return `<svg viewBox="0 0 24 24" fill="currentColor" style="width: 18px; height: 18px;">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
            </svg>`;
        case 'gemini':
            // Gemini/Google - sparkle style
            return `<svg viewBox="0 0 24 24" fill="currentColor" style="width: 18px; height: 18px;">
                <path d="M12 0L14.59 9.41L24 12L14.59 14.59L12 24L9.41 14.59L0 12L9.41 9.41L12 0Z"/>
            </svg>`;
        default:
            // Default chat icon
            return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 18px; height: 18px;">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>`;
    }
}

// Generate smart title for clipboard items
function generateTitleForItem(item) {
    // Priority 1: Use existing title from metadata (but ensure it's a string)
    if (item.metadata?.title && typeof item.metadata.title === 'string') {
        return item.metadata.title;
    }
    
    // Special handling for chatbot conversations
    if (item.jsonSubtype === 'chatbot-conversation') {
        const aiService = item.metadata?.aiService || 'AI';
        const exchangeCount = item.metadata?.exchangeCount || 0;
        const date = new Date(item.metadata?.startTime || item.timestamp).toLocaleDateString();
        return `${aiService} Conversation - ${exchangeCount} exchanges (${date})`;
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
                // Check for external file drop first
                if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                    const fileCount = e.dataTransfer.files.length;
                    console.log('[Drag] External file drop detected:', fileCount, 'file(s)');
                    
                    const spaceName = spaceItem.querySelector('.space-name')?.textContent || 'space';
                    let successCount = 0;
                    
                    // Show progress for multiple files
                    if (fileCount > 1) {
                        showNotification(`Processing ${fileCount} files...`);
                    }
                    
                    for (let i = 0; i < fileCount; i++) {
                        const file = e.dataTransfer.files[i];
                        console.log('[Drag] Processing file:', file.name, file.type, file.size);
                        
                        // Update progress for large batches
                        if (fileCount > 3 && (i + 1) % 3 === 0) {
                            showNotification(`Processing file ${i + 1} of ${fileCount}...`);
                        }
                        
                        try {
                            // Read file content - always as data URL to preserve binary data
                            const reader = new FileReader();
                            const fileContent = await new Promise((resolve, reject) => {
                                reader.onload = () => resolve(reader.result);
                                reader.onerror = reject;
                                reader.readAsDataURL(file);  // Always use data URL for proper binary handling
                            });
                            
                            // Use the appropriate add method based on type
                            let result;
                            if (file.type.startsWith('image/')) {
                                // addImage expects: dataUrl, fileName, fileSize, spaceId
                                result = await window.clipboard.addImage({
                                    dataUrl: fileContent,  // This is already a data URL from readAsDataURL
                                    fileName: file.name,
                                    fileSize: file.size,
                                    spaceId: spaceId
                                });
                            } else {
                                // addFile expects: fileData (base64), fileName, fileType, fileSize, spaceId
                                // Extract base64 from data URL
                                const fileData = fileContent.split(',')[1] || fileContent;
                                
                                result = await window.clipboard.addFile({
                                    fileData: fileData,
                                    fileName: file.name,
                                    fileType: file.type,
                                    fileSize: file.size,
                                    spaceId: spaceId
                                });
                            }
                            
                            if (result && (result.id || result.success)) {
                                successCount++;
                                console.log('[Drag] File added successfully:', file.name);
                            }
                        } catch (fileError) {
                            console.error('[Drag] Error processing file:', file.name, fileError);
                        }
                    }
                    
                    if (successCount > 0) {
                        showNotification(`Added ${successCount} file${successCount > 1 ? 's' : ''} to ${spaceName}`);
                        await loadSpaces();
                        await loadHistory();
                    } else {
                        showNotification('❌ Failed to add files');
                    }
                    return;
                }
                
                // Check for internal item drag (moving between spaces)
                const itemId = e.dataTransfer.getData('text/plain');
                
                if (!itemId) {
                    console.log('[Drag] No item ID or files in drag data');
                    return;
                }
                
                console.log('[Drag] Dropping item', itemId, 'into space', spaceId);
                
                // Move item to this space
                const result = await window.clipboard.moveToSpace(itemId, spaceId);
                
                if (result.success) {
                    showNotification('Moved to ' + (spaceItem.querySelector('.space-name')?.textContent || 'space'));
                    await loadSpaces();
                    await loadHistory();
                } else {
                    showNotification('❌ Failed to move item');
                }
                
            } catch (error) {
                console.error('[Drag] Error handling drop:', error);
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
        
        const spaceName = spacesData.find(s => s.id === spaceId)?.name || 'Space';
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
                showNotification(`Image pasted into ${spaceName}`);
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
            console.log('[Paste] Calling addText with spaceId:', spaceId);
            
            result = await window.clipboard.addText({
                content: text,
                spaceId: spaceId
            });
            
            console.log('[Paste] addText result:', JSON.stringify(result, null, 2));
            
            if (result?.success) {
                if (result.isYouTube) {
                    showNotification(`YouTube video queued for download into ${spaceName}`);
                } else if (result.isWebMonitor) {
                    showNotification(`Now monitoring: ${result.monitorName || text}`);
                } else {
                    showNotification(`Text pasted into ${spaceName}`);
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
                showNotification(`Rich content pasted into ${spaceName}`);
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
                showNotification(`Text pasted into ${spaceName}`);
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
        
        const spaceName = spacesData.find(s => s.id === spaceId)?.name || 'Space';
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
        
        showNotification(` ${files.length} file(s) pasted into ${spaceName}`);
        
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

// Show notification helper - simple version (full implementation is below)
// This is kept for compatibility but the main implementation is the unified one below

function renderSpaces() {
    const spacesList = document.getElementById('spacesList');
    
    // Always show "All Items" first
    const allItemsIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/></svg>';
    
    let html = `
        <div class="space-item ${currentSpace === null ? 'active' : ''}" data-space-id="null">
            <span class="space-icon">${allItemsIcon}</span>
            <span class="space-name">All Items</span>
            <span class="space-count">-</span>
        </div>
    `;
    
    // Separate system spaces from user spaces
    const systemSpaces = spacesData.filter(s => s.isSystem);
    const userSpaces = spacesData.filter(s => !s.isSystem);
    
    // Sort user spaces by lastUsed (most recent first), then by createdAt
    const sortedUserSpaces = [...userSpaces].sort((a, b) => {
        const aLastUsed = a.lastUsed || a.createdAt || 0;
        const bLastUsed = b.lastUsed || b.createdAt || 0;
        return bLastUsed - aLastUsed; // Most recent first
    });
    
    const defaultSpaceIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="8"/></svg>';
    const actionIcons = {
        notebook: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 7h16M4 12h16M4 17h10"/></svg>',
        pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
        edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
        delete: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
    };
    
    // Helper function to render a space item
    const renderSpaceItem = (space, isSystem = false) => {
        const spaceName = typeof space.name === 'string' ? space.name : (space.name?.toString() || 'Unnamed Space');
        const spaceIcon = (space.icon && space.icon.includes('<svg')) ? space.icon : defaultSpaceIcon;
        
        // Get unviewed changes count for badge (Web Monitors feature)
        const unviewedCount = space.unviewedChanges || 0;
        const badgeHtml = unviewedCount > 0 
            ? `<span class="change-badge">${unviewedCount}</span>` 
            : '';
        
        // System spaces don't show delete button
        const deleteAction = isSystem 
            ? '' 
            : `<div class="space-action" data-action="delete" data-space-id="${space.id}">${actionIcons.delete}</div>`;
        
        return `
            <div class="space-item ${currentSpace === space.id ? 'active' : ''} ${isSystem ? 'system-space' : ''}" data-space-id="${space.id}">
                <span class="space-icon">${spaceIcon}</span>
                <span class="space-name">${escapeHtml(spaceName)}</span>
                ${badgeHtml}
                <span class="space-count">${space.itemCount || 0}</span>
                <div class="space-actions">
                    <div class="space-action" data-action="notebook" data-space-id="${space.id}" title="Open Notebook">${actionIcons.notebook}</div>
                    <div class="space-action" data-action="pdf" data-space-id="${space.id}" title="Export">${actionIcons.pdf}</div>
                    <div class="space-action" data-action="edit" data-space-id="${space.id}">${actionIcons.edit}</div>
                    ${deleteAction}
                </div>
            </div>
        `;
    };
    
    // Add system spaces first (Web Monitors, etc.)
    systemSpaces.forEach(space => {
        html += renderSpaceItem(space, true);
    });
    
    // Add separator if there are both system and user spaces
    if (systemSpaces.length > 0 && sortedUserSpaces.length > 0) {
        html += '<div class="space-separator"></div>';
    }
    
    // Add user-created spaces (sorted by most recently used)
    sortedUserSpaces.forEach(space => {
        html += renderSpaceItem(space, false);
    });
    
    spacesList.innerHTML = html;
    
    // Add drag-and-drop and paste functionality to each space item
    setupSpaceDragAndDrop();
}

// Render history list
// PERFORMANCE: Batch size for chunked rendering
const RENDER_BATCH_SIZE = 50;
// Track current render to cancel previous chunked renders
let currentRenderVersion = 0;

// Helper function to render a single history item to HTML
function renderHistoryItemToHtml(item) {
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
            
            const icon = getTypeIcon(item.type, item.source, item.fileType, item.fileCategory, item.metadata, item.jsonSubtype, item.tags, item.preview || item.content);
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
                        ? pathToFileUrl(item.metadata.localThumbnail)
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
                    // For audio files, show enhanced audio tile design
                    const duration = item.metadata?.duration || '';
                    contentHtml = `
                        <div class="audio-tile-design">
                            <div class="audio-tile-icon">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                    <path d="M9 18V5l12-2v13"/>
                                    <circle cx="6" cy="18" r="3"/>
                                    <circle cx="18" cy="16" r="3"/>
                                </svg>
                            </div>
                            <div class="file-details" style="flex: 1;">
                                <div class="file-name" style="font-size: 13px; margin-bottom: 4px;">${escapeHtml(item.fileName)}</div>
                                <div class="file-meta" style="gap: 8px;">
                                    <span class="asset-type-badge badge-audio">Audio</span>
                                    <span>${formatFileSize(item.fileSize)}</span>
                                    ${duration ? `<span>${duration}</span>` : ''}
                                </div>
                                <div style="font-size: 10px; color: rgba(236, 72, 153, 0.7); margin-top: 6px;">Click ◎ to preview</div>
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
            } else if (item.metadata?.type === 'ai-conversation') {
                // Redesigned AI Conversation tile
                const provider = item.metadata?.provider || item.metadata?.serviceId || item.metadata?.aiService || 'AI';
                const messageCount = item.metadata?.messageCount || item.metadata?.exchangeCount || 0;
                const hasArtifacts = item.metadata?.hasArtifacts || false;
                const hasCode = item.metadata?.hasCode || false;
                const hasFiles = item.metadata?.hasFiles || false;
                const hasImages = item.metadata?.hasImages || false;
                
                // Get messages from jsonData for title/question extraction
                const messages = item.metadata?.jsonData?.messages || [];
                const firstUserMessage = messages.find(m => m.role === 'user');
                
                // Generate auto-title from first user message
                const conversationTitle = generateConversationTitle(firstUserMessage?.content, provider);
                
                // Get first question for display (truncated)
                const firstQuestion = firstUserMessage?.content?.trim() || '';
                const truncatedQuestion = firstQuestion.length > 80 
                    ? '"' + firstQuestion.substring(0, 77) + '..."'
                    : firstQuestion ? '"' + firstQuestion + '"' : '';
                
                // Format date
                const convDate = item.metadata?.startTime || item.metadata?.jsonData?.startTime || item.timestamp;
                const formattedDate = convDate ? new Date(convDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
                
                // Determine provider class for styling
                const providerLower = provider.toLowerCase();
                let providerClass = 'claude';
                if (providerLower.includes('chatgpt') || providerLower.includes('openai')) providerClass = 'chatgpt';
                else if (providerLower.includes('grok')) providerClass = 'grok';
                else if (providerLower.includes('gemini') || providerLower.includes('google')) providerClass = 'gemini';
                
                // Get provider icon
                const providerIcon = getProviderIcon(providerClass);
                
                // Check for thumbnail (first image in conversation)
                const media = item.metadata?.jsonData?.media || [];
                const firstImage = media.find(m => m.type?.startsWith('image/') || m.mimeType?.startsWith('image/'));
                const thumbnailHtml = firstImage?.dataUrl 
                    ? `<div class="ai-conv-thumb"><img src="${firstImage.dataUrl}" alt=""></div>`
                    : '';
                
                // Build content badges
                let badgesHtml = '';
                if (hasCode) badgesHtml += '<span class="ai-conv-badge code" title="Has code blocks">{ }</span>';
                if (hasArtifacts) badgesHtml += '<span class="ai-conv-badge artifact" title="Has artifacts">★</span>';
                if (hasFiles) badgesHtml += '<span class="ai-conv-badge files" title="Has files">📎</span>';
                
                contentHtml = `
                    <div class="ai-conversation-tile redesigned">
                        <div class="ai-conv-header">
                            <div class="ai-conv-provider-icon ${providerClass}">
                                ${providerIcon}
                            </div>
                            <div class="ai-conv-title-area">
                                <div class="ai-conv-title">${escapeHtml(conversationTitle)}</div>
                                ${truncatedQuestion ? `<div class="ai-conv-question">${escapeHtml(truncatedQuestion)}</div>` : ''}
                            </div>
                        </div>
                        <div class="ai-conv-footer">
                            ${thumbnailHtml}
                            <div class="ai-conv-meta">
                                <span>${messageCount} message${messageCount !== 1 ? 's' : ''}</span>
                                ${formattedDate ? `<span class="ai-conv-date">${formattedDate}</span>` : ''}
                            </div>
                            ${badgesHtml ? `<div class="ai-conv-badges">${badgesHtml}</div>` : ''}
                        </div>
                    </div>
                `;
            } else if (item.type === 'generated-document' || (item.metadata && item.metadata.type === 'generated-document')) {
                // Handle generated documents
                const templateName = item.metadata?.templateName || 'Document';
                const generatedDate = new Date(item.metadata?.generatedAt || item.timestamp).toLocaleDateString();
                contentHtml = `
                    <div class="generated-document-preview">
                        <div class="doc-header">
                            <span class="doc-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 12px; height: 12px; display: inline-block; vertical-align: middle; margin-right: 4px;"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> AI Generated</span>
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
            } else if (item.source === 'url') {
                // Enhanced URL tile card design
                const urlText = item.preview || item.content || item.text || '';
                let displayUrl = urlText;
                let domain = '';
                try {
                    const urlObj = new URL(urlText);
                    domain = urlObj.hostname;
                    displayUrl = urlText.length > 60 ? urlText.substring(0, 60) + '...' : urlText;
                } catch (e) {
                    displayUrl = urlText.length > 60 ? urlText.substring(0, 60) + '...' : urlText;
                }
                contentHtml = `
                    <div class="url-tile-card">
                        <div class="url-tile-favicon">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 20px; height: 20px; color: rgba(59, 130, 246, 0.8);">
                                <circle cx="12" cy="12" r="10"/>
                                <line x1="2" y1="12" x2="22" y2="12"/>
                                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                            </svg>
                        </div>
                        <div class="url-tile-info">
                            <div class="url-tile-title">${escapeHtml(displayUrl)}</div>
                            ${domain ? `<div class="url-tile-domain"><span class="asset-type-badge badge-url">Link</span>${escapeHtml(domain)}</div>` : ''}
                        </div>
                    </div>
                `;
            } else if (item.type === 'web-monitor') {
                // Web Monitor preview card
                const monitorName = item.name || 'Website';
                const monitorUrl = item.url || '';
                const status = item.status || 'active';
                const changeCount = item.changeCount || 0;
                const lastChecked = item.lastChecked ? new Date(item.lastChecked).toLocaleString() : 'Never';
                
                let domain = '';
                try {
                    domain = new URL(monitorUrl).hostname;
                } catch (e) {
                    domain = monitorUrl;
                }
                
                const statusColor = status === 'active' ? '#10b981' : status === 'paused' ? '#f59e0b' : '#ef4444';
                const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
                
                contentHtml = `
                    <div class="web-monitor-card">
                        <div class="web-monitor-header">
                            <div class="web-monitor-icon">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 24px; height: 24px; color: #4a9eff;">
                                    <circle cx="12" cy="12" r="10"/>
                                    <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                                </svg>
                            </div>
                            <div class="web-monitor-info">
                                <div class="web-monitor-name">${escapeHtml(monitorName)}</div>
                                <div class="web-monitor-url">${escapeHtml(domain)}</div>
                            </div>
                            <div class="web-monitor-status" style="background: ${statusColor}20; color: ${statusColor};">
                                <span class="status-dot" style="background: ${statusColor};"></span>
                                ${statusLabel}
                            </div>
                        </div>
                        <div class="web-monitor-stats">
                            <div class="web-monitor-stat">
                                <span class="stat-value">${changeCount}</span>
                                <span class="stat-label">Changes</span>
                            </div>
                            <div class="web-monitor-stat">
                                <span class="stat-value">${lastChecked === 'Never' ? '-' : lastChecked.split(',')[0]}</span>
                                <span class="stat-label">Last Check</span>
                            </div>
                        </div>
                    </div>
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
            
            const typeClass = isPlaybookNote(item) ? 'type-playbook' : (item.type === 'file' ? `type-${item.fileCategory || 'file'}` : `type-${item.source || item.type}`);
            const isSelected = selectedItems.has(item.id);
            
            // Determine the display type for CSS styling
            const getDisplayType = () => {
                if (item.type === 'generated-document' || item.metadata?.type === 'generated-document') return 'generated-document';
                if (item.metadata?.type === 'ai-conversation') return 'ai-conversation';
                if (item.type === 'image') return 'image';
                if (item.type === 'file') {
                    if (item.fileType === 'video' || item.fileCategory === 'video') return 'video';
                    if (item.fileType === 'audio' || item.fileCategory === 'audio') return 'audio';
                    if (item.fileType === 'pdf' || item.fileExt === '.pdf') return 'pdf';
                    if (item.fileType === 'presentation' || item.fileCategory === 'presentation') return 'presentation';
                    if (item.fileCategory === 'code') return 'code';
                    if (item.fileCategory === 'image' || item.fileType === 'image-file') return 'image';
                    return 'file';
                }
                if (item.type === 'html') return 'html';
                if (item.source === 'code') return 'code';
                if (item.source === 'url' || item.type === 'url') return 'url';
                return item.type || 'text';
            };
            const displayType = getDisplayType();
            
            return `
                <div class="history-item ${item.pinned ? 'pinned' : ''} ${isSelected ? 'selected' : ''} tile-${displayType}" data-id="${item.id}" data-type="${displayType}" data-source="${item.source || ''}" draggable="true">
                    <div class="item-checkbox-wrapper">
                        <div class="item-checkbox ${isSelected ? 'checked' : ''}" data-item-id="${item.id}"></div>
                    </div>
                    <div class="item-header">
                        <div class="item-type">
                            <span class="type-icon ${typeClass}">${icon}</span>
                            <span class="item-time">${timeAgo}</span>
                            ${item.metadata?.context?.app?.name ? `<span class="item-source" title="${escapeHtml(item.metadata.context.contextDisplay || '')}">from ${escapeHtml(item.metadata.context.app.name)}</span>` : ''}
                            ${item._scoreBadge || ''}
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
                        <button class="action-btn float-btn" data-action="float" title="Float for drag to external apps">
                            ⬛
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
                            <span class="type-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>
                            <span class="item-time">Error</span>
                        </div>
                    </div>
                    <div class="item-content" style="color: rgba(255,100,100,0.8);">
                        Failed to render item: ${itemError.message}
                    </div>
                    <div class="item-actions">
                        <button class="action-btn" data-action="delete" title="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 14px; height: 14px;"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
                    </div>
                </div>
            `;
    }
}

// Main render function with chunked rendering for large lists
function renderHistory(items = history) {
    console.log('renderHistory called with', items ? items.length : 0, 'items');
    const historyList = document.getElementById('historyList');
    const itemCount = document.getElementById('itemCount');
    
    // Increment render version to cancel any pending chunked renders from previous calls
    const thisRenderVersion = ++currentRenderVersion;
    
    if (!historyList) {
        console.error('historyList element not found!');
        return;
    }
    
    if (!items || items.length === 0) {
        console.log('No items to render, showing empty state');
        historyList.innerHTML = `
            <div class="empty-state">
                <img src="${getAssetPath('or-logo.png')}" class="empty-logo" alt="OneReach Logo">
                <div class="empty-text">No items in this space</div>
                <div class="empty-hint">Copy something to add it here</div>
            </div>
        `;
        if (itemCount) itemCount.textContent = '0 items';
        return;
    }
    
    console.log('Rendering', items.length, 'items');
    
    try {
        // PERFORMANCE: For small lists, render all at once (fast path)
        if (items.length <= RENDER_BATCH_SIZE) {
            historyList.innerHTML = items.map(item => renderHistoryItemToHtml(item)).join('');
            itemCount.textContent = `${items.length} item${items.length !== 1 ? 's' : ''}`;
            return;
        }
        
        // PERFORMANCE: For large lists, render in chunks to avoid jank
        console.log('Using chunked rendering for', items.length, 'items');
        
        // Render first batch immediately for fast initial paint
        const firstBatch = items.slice(0, RENDER_BATCH_SIZE);
        historyList.innerHTML = firstBatch.map(item => renderHistoryItemToHtml(item)).join('');
        itemCount.textContent = `${items.length} item${items.length !== 1 ? 's' : ''}`;
        
        // Render remaining items in chunks via requestAnimationFrame
        let currentIndex = RENDER_BATCH_SIZE;
        
        function renderNextBatch() {
            // Cancel if a newer render has started
            if (thisRenderVersion !== currentRenderVersion) {
                console.log('Chunked render cancelled (newer render started)');
                return;
            }
            
            if (currentIndex >= items.length) return;
            
            const batch = items.slice(currentIndex, currentIndex + RENDER_BATCH_SIZE);
            const batchHtml = batch.map(item => renderHistoryItemToHtml(item)).join('');
            
            // Append to existing content
            historyList.insertAdjacentHTML('beforeend', batchHtml);
            
            currentIndex += RENDER_BATCH_SIZE;
            
            // Schedule next batch if more items remain
            if (currentIndex < items.length) {
                requestAnimationFrame(renderNextBatch);
            }
        }
        
        // Start rendering remaining batches on next frame
        requestAnimationFrame(renderNextBatch);
        
    } catch (error) {
        console.error('Error rendering history:', error);
        console.error('Error stack:', error.stack);
        // Try to identify which item caused the error
        console.error('Items that may have caused error:', items.map(i => ({ id: i.id, type: i.type, metadata: i.metadata })));
        historyList.innerHTML = `
            <div class="empty-state">
                <img src="${getAssetPath('or-logo.png')}" class="empty-logo" alt="OneReach Logo">
                <div class="empty-icon">!</div>
                <div class="empty-text">Error rendering items</div>
                <div class="empty-hint">${error.message}</div>
                <button onclick="window.clipboard.clearCorruptItems && window.clipboard.clearCorruptItems()" style="margin-top: 16px; padding: 8px 16px; background: rgba(255,100,100,0.3); border: 1px solid rgba(255,100,100,0.5); border-radius: 6px; color: white; cursor: pointer;">Clear Corrupt Items</button>
            </div>
        `;
        itemCount.textContent = 'Error';
    }
}

// Collapsed state for tag groups (persisted in localStorage)
let collapsedTagGroups = JSON.parse(localStorage.getItem('collapsedTagGroups') || '{}');

// Tag colors (persisted in localStorage, keyed by space)
let tagColors = JSON.parse(localStorage.getItem('tagColors') || '{}');

// Preset tag colors for color picker
const TAG_COLOR_PRESETS = [
    '#ff6b6b', // Red
    '#ff9f43', // Orange
    '#feca57', // Yellow
    '#1dd1a1', // Green
    '#54a0ff', // Blue
    '#5f27cd', // Purple
    '#ff6b9d', // Pink
    '#00d2d3', // Cyan
    '#a29bfe', // Lavender
    '#636e72', // Gray
];

// Save collapsed state to localStorage
function saveCollapsedState() {
    localStorage.setItem('collapsedTagGroups', JSON.stringify(collapsedTagGroups));
}

// Get tag color for current space
function getTagColor(tag) {
    const spaceKey = currentSpace || '__all__';
    return tagColors[spaceKey]?.[tag] || null;
}

// Set tag color for current space
function setTagColor(tag, color) {
    const spaceKey = currentSpace || '__all__';
    if (!tagColors[spaceKey]) {
        tagColors[spaceKey] = {};
    }
    if (color) {
        tagColors[spaceKey][tag] = color;
    } else {
        delete tagColors[spaceKey][tag];
    }
    localStorage.setItem('tagColors', JSON.stringify(tagColors));
}

// Show tag color picker context menu
function showTagColorPicker(e, tag) {
    e.preventDefault();
    e.stopPropagation();
    
    // Remove any existing color picker
    const existingPicker = document.getElementById('tagColorPicker');
    if (existingPicker) existingPicker.remove();
    
    const currentColor = getTagColor(tag);
    
    const picker = document.createElement('div');
    picker.id = 'tagColorPicker';
    picker.className = 'tag-color-picker';
    picker.innerHTML = `
        <div class="tag-color-picker-header">
            <span>Color for "${tag}"</span>
        </div>
        <div class="tag-color-picker-colors">
            ${TAG_COLOR_PRESETS.map(color => `
                <div class="tag-color-option ${currentColor === color ? 'selected' : ''}" 
                     data-color="${color}" 
                     style="background: ${color};">
                </div>
            `).join('')}
            <div class="tag-color-option clear-color ${!currentColor ? 'selected' : ''}" 
                 data-color="" 
                 title="No color">
                ✕
            </div>
        </div>
    `;
    
    document.body.appendChild(picker);
    
    // Position the picker near the click
    const rect = e.target.closest('.sidebar-tag-item')?.getBoundingClientRect() || { right: e.clientX, top: e.clientY };
    picker.style.position = 'fixed';
    picker.style.left = `${rect.right + 8}px`;
    picker.style.top = `${rect.top}px`;
    
    // Make sure it doesn't go off screen
    const pickerRect = picker.getBoundingClientRect();
    if (pickerRect.right > window.innerWidth) {
        picker.style.left = `${rect.left - pickerRect.width - 8}px`;
    }
    if (pickerRect.bottom > window.innerHeight) {
        picker.style.top = `${window.innerHeight - pickerRect.height - 8}px`;
    }
    
    // Handle color selection
    picker.querySelectorAll('.tag-color-option').forEach(option => {
        option.addEventListener('click', () => {
            const color = option.dataset.color;
            setTagColor(tag, color || null);
            picker.remove();
            updateSidebarTags();
            if (currentView === 'grouped') {
                filterItems();
            }
        });
    });
    
    // Close picker when clicking outside
    const closePicker = (e) => {
        if (!picker.contains(e.target)) {
            picker.remove();
            document.removeEventListener('click', closePicker);
        }
    };
    setTimeout(() => document.addEventListener('click', closePicker), 0);
}

// Toggle tag group collapse state
function toggleTagGroup(tag) {
    collapsedTagGroups[tag] = !collapsedTagGroups[tag];
    saveCollapsedState();
    renderGroupedView();
}

// Render items grouped by tags
function renderGroupedView(items = history) {
    console.log('renderGroupedView called with', items ? items.length : 0, 'items');
    const historyList = document.getElementById('historyList');
    const itemCount = document.getElementById('itemCount');
    
    if (!historyList) {
        console.error('historyList element not found!');
        return;
    }
    
    if (!items || items.length === 0) {
        historyList.innerHTML = `
            <div class="empty-state">
                <img src="${getAssetPath('or-logo.png')}" class="empty-logo" alt="OneReach Logo">
                <div class="empty-text">No items in this space</div>
                <div class="empty-hint">Copy something to add it here</div>
            </div>
        `;
        if (itemCount) itemCount.textContent = '0 items';
        return;
    }
    
    // Group items by tags
    const tagGroups = {};
    const untaggedItems = [];
    
    items.forEach(item => {
        const itemTags = item.metadata?.tags || item.tags || [];
        if (!Array.isArray(itemTags) || itemTags.length === 0) {
            untaggedItems.push(item);
        } else {
            // Add item to each tag group it belongs to
            itemTags.forEach(tag => {
                if (typeof tag === 'string' && tag.trim()) {
                    const normalizedTag = tag.trim().toLowerCase();
                    if (!tagGroups[normalizedTag]) {
                        tagGroups[normalizedTag] = [];
                    }
                    tagGroups[normalizedTag].push(item);
                }
            });
        }
    });
    
    // Sort tag groups by count (most items first), then alphabetically
    const sortedTags = Object.keys(tagGroups).sort((a, b) => {
        const countDiff = tagGroups[b].length - tagGroups[a].length;
        if (countDiff !== 0) return countDiff;
        return a.localeCompare(b);
    });
    
    // Build HTML for grouped view
    let html = '';
    
    sortedTags.forEach(tag => {
        const tagItems = tagGroups[tag];
        const isCollapsed = collapsedTagGroups[tag] === true;
        const chevron = isCollapsed ? '▶' : '▼';
        const color = getTagColor(tag);
        const colorIndicator = color ? `<span class="tag-group-color" style="background: ${color};"></span>` : '';
        const borderStyle = color ? `border-left-color: ${color};` : '';
        
        html += `
            <div class="tag-group" data-tag="${escapeHtml(tag)}" style="${borderStyle}">
                <div class="tag-group-header" onclick="toggleTagGroup('${escapeHtml(tag)}')">
                    <span class="tag-group-chevron">${chevron}</span>
                    ${colorIndicator}
                    <span class="tag-group-name">${escapeHtml(tag)}</span>
                    <span class="tag-group-count">(${tagItems.length})</span>
                </div>
                <div class="tag-group-items ${isCollapsed ? 'collapsed' : ''}" style="${borderStyle}">
                    ${tagItems.map(item => renderHistoryItemToHtml(item)).join('')}
                </div>
            </div>
        `;
    });
    
    // Add untagged items at the end
    if (untaggedItems.length > 0) {
        const isCollapsed = collapsedTagGroups['__untagged__'] === true;
        const chevron = isCollapsed ? '▶' : '▼';
        
        html += `
            <div class="tag-group untagged-group" data-tag="__untagged__">
                <div class="tag-group-header" onclick="toggleTagGroup('__untagged__')">
                    <span class="tag-group-chevron">${chevron}</span>
                    <span class="tag-group-name">Untagged</span>
                    <span class="tag-group-count">(${untaggedItems.length})</span>
                </div>
                <div class="tag-group-items ${isCollapsed ? 'collapsed' : ''}">
                    ${untaggedItems.map(item => renderHistoryItemToHtml(item)).join('')}
                </div>
            </div>
        `;
    }
    
    historyList.innerHTML = html;
    
    // Update item count (show unique items, not duplicated across groups)
    const uniqueItemCount = items.length;
    if (itemCount) itemCount.textContent = `${uniqueItemCount} item${uniqueItemCount !== 1 ? 's' : ''}`;
}

// Update item counts for all spaces
async function updateItemCounts() {
    console.log('Updating item counts for spaces:', spacesData);
    
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
    spacesData.forEach(space => {
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
function getTypeIcon(type, source, fileType, fileCategory, metadata, jsonSubtype, tags, preview) {
    // Check JSON subtypes first (works for both file and text items)
    if (jsonSubtype === 'style-guide') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px;"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>';
    if (jsonSubtype === 'journey-map') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px;"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';
    if (jsonSubtype === 'chatbot-conversation') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    
    if (type === 'generated-document' || (metadata && metadata.type === 'generated-document')) return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px;"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
    // Check for Playbook notes (notes created in Playbook app) - checks metadata, tags, and content marker
    if (isPlaybookNote({ metadata, tags, content: preview })) return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px;"><path d="M4 7h16M4 12h16M4 17h10"/></svg>';
    if (type === 'file') {
        if (fileType === 'pdf') return '▥';
        if (fileType === 'flow') return '⧉';
        if (fileType === 'notebook') return '◉';
        if (fileType === 'presentation' || fileCategory === 'presentation') return '▦';
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
    if (type === 'web-monitor') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px;"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
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

/**
 * Open specialized editor for style guides or journey maps
 * @param {Object} item - The clipboard item with jsonSubtype property
 */
async function openSpecializedEditor(item) {
    if (!item || !item.jsonSubtype) {
        console.warn('[SpecializedEditor] Item does not have a JSON subtype');
        await showMetadataModal(item.id);
        return;
    }
    
    console.log('[SpecializedEditor] Opening editor for:', item.jsonSubtype, item.fileName);
    
    try {
        let result;
        
        if (item.jsonSubtype === 'style-guide') {
            // Open Style Guide Editor
            result = await window.clipboard.openStyleGuideEditor(item.id);
            if (!result.success) {
                // Fallback: Show in Finder if editor not available
                console.warn('[SpecializedEditor] Style Guide Editor not available:', result.error);
                showNotification({
                    type: 'warning',
                    title: 'Style Guide Editor',
                    message: 'Opening file location. Style Guide Editor app may not be configured.',
                    duration: 3000
                });
                await window.clipboard.showItemInFinder(item.id);
            }
        } else if (item.jsonSubtype === 'journey-map') {
            // Open Journey Map Editor
            result = await window.clipboard.openJourneyMapEditor(item.id);
            if (!result.success) {
                // Fallback: Show in Finder if editor not available
                console.warn('[SpecializedEditor] Journey Map Editor not available:', result.error);
                showNotification({
                    type: 'warning',
                    title: 'Journey Map Editor',
                    message: 'Opening file location. Journey Map Editor app may not be configured.',
                    duration: 3000
                });
                await window.clipboard.showItemInFinder(item.id);
            }
        } else {
            // Unknown subtype, fall back to metadata modal
            console.warn('[SpecializedEditor] Unknown JSON subtype:', item.jsonSubtype);
            await showMetadataModal(item.id);
        }
    } catch (error) {
        console.error('[SpecializedEditor] Error opening editor:', error);
        showNotification({
            type: 'error',
            title: 'Editor Error',
            message: `Could not open ${item.jsonSubtype} editor: ${error.message}`,
            duration: 5000
        });
        // Fall back to metadata modal
        await showMetadataModal(item.id);
    }
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

// Open file in system default application
async function openFileInSystem(filePath) {
    try {
        if (window.clipboard && window.clipboard.openInSystem) {
            const result = await window.clipboard.openInSystem(filePath);
            if (!result.success) {
                console.error('Failed to open file:', result.error);
                alert('Failed to open file: ' + (result.error || 'Unknown error'));
            }
        } else {
            // Fallback: try using shell.openPath via IPC
            console.error('openInSystem not available');
            alert('Unable to open file - feature not available');
        }
    } catch (error) {
        console.error('Error opening file:', error);
        alert('Error opening file: ' + error.message);
    }
}

// Extract Playbook note ID from item (checks all storage locations)
function extractPlaybookNoteId(item) {
    if (!item) return null;
    
    console.log('[Playbook] Checking item for Playbook ID:', {
        hasMetadata: !!item.metadata,
        _playbookNoteId: item.metadata?._playbookNoteId,
        playbookNoteId: item.metadata?.playbookNoteId,
        tags: item.tags,
        contentPreview: (item.content || item.preview || '').substring(0, 100)
    });
    
    // 1. Check metadata (_playbookNoteId or playbookNoteId)
    if (item.metadata?._playbookNoteId) {
        console.log('[Playbook] Found in metadata._playbookNoteId:', item.metadata._playbookNoteId);
        return item.metadata._playbookNoteId;
    }
    if (item.metadata?.playbookNoteId) {
        console.log('[Playbook] Found in metadata.playbookNoteId:', item.metadata.playbookNoteId);
        return item.metadata.playbookNoteId;
    }
    
    // 2. Check tags for playbook-note:uuid format
    if (item.tags && Array.isArray(item.tags)) {
        for (const tag of item.tags) {
            if (tag.startsWith('playbook-note:')) {
                const id = tag.replace('playbook-note:', '');
                console.log('[Playbook] Found in tags:', id);
                return id;
            }
        }
    }
    
    // 3. Check content for [PLAYBOOK:uuid] marker
    const content = item.content || item.preview || '';
    const playbookMarkerMatch = content.match(/\[PLAYBOOK:([a-f0-9-]+)\]/i);
    if (playbookMarkerMatch) {
        console.log('[Playbook] Found in content marker:', playbookMarkerMatch[1]);
        return playbookMarkerMatch[1];
    }
    
    console.log('[Playbook] No Playbook ID found in item');
    return null;
}

// Check if item is a Playbook note
function isPlaybookNote(item) {
    return !!extractPlaybookNoteId(item);
}

// Open Playbook note in GSX Playbook tool
function openInPlaybook() {
    if (!currentPreviewItem) {
        console.error('No item selected for Playbook');
        return;
    }
    
    const playbookNoteId = extractPlaybookNoteId(currentPreviewItem);
    if (!playbookNoteId) {
        console.error('No Playbook note ID found');
        showNotification({ type: 'error', message: 'This item is not a Playbook note' });
        return;
    }
    
    // GSX Playbook deep link format
    const baseUrl = 'https://files.edison.api.onereach.ai/public/35254342-4a2e-475b-aec1-18547e517e29/playbook/index.html';
    const deepLink = `${baseUrl}?playbook=${playbookNoteId}`;
    
    console.log('[Playbook] Opening Playbook note:', playbookNoteId, deepLink);
    
    // Open in internal GSX window (not external browser)
    if (window.clipboard && window.clipboard.openGSXWindow) {
        window.clipboard.openGSXWindow(deepLink, 'Playbook');
        showNotification({ type: 'success', message: 'Opening in Playbook...' });
    } else if (window.electronAPI && window.electronAPI.openExternal) {
        // Fallback to external browser
        window.electronAPI.openExternal(deepLink);
        showNotification({ type: 'success', message: 'Opening in browser...' });
    } else {
        // Last resort fallback
        window.open(deepLink, '_blank');
        showNotification({ type: 'info', message: 'Opened in new tab' });
    }
}

// Show document fallback (for non-DOCX or conversion errors)
function showDocumentFallback(viewMode, historyItem, filePath) {
    // Get file icon based on extension
    let fileIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 48px; height: 48px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>';
    if (historyItem.fileExt === '.docx' || historyItem.fileExt === '.doc') {
        fileIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="#2b579a" stroke-width="1.5" style="width: 48px; height: 48px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><text x="12" y="16" text-anchor="middle" font-size="6" font-weight="bold" fill="#2b579a" stroke="none">W</text></svg>';
    } else if (historyItem.fileExt === '.pdf') {
        fileIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="1.5" style="width: 48px; height: 48px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><text x="12" y="16" text-anchor="middle" font-size="5" font-weight="bold" fill="#dc2626" stroke="none">PDF</text></svg>';
    }
    
    viewMode.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 20px; padding: 40px;">
            <div style="opacity: 0.8;">${fileIcon}</div>
            <div style="text-align: center;">
                <div style="font-size: 16px; font-weight: 500; color: rgba(255, 255, 255, 0.9); margin-bottom: 8px;">${escapeHtml(historyItem.fileName || 'Document')}</div>
                <div style="font-size: 12px; color: rgba(255, 255, 255, 0.5);">${formatFileSize(historyItem.fileSize)} ${historyItem.fileExt ? '• ' + historyItem.fileExt.toUpperCase().replace('.', '') : ''}</div>
                ${historyItem.metadata?.title ? `<div style="font-size: 13px; color: rgba(255, 255, 255, 0.7); margin-top: 12px; max-width: 400px;">${escapeHtml(historyItem.metadata.title)}</div>` : ''}
                ${historyItem.metadata?.description ? `<div style="font-size: 11px; color: rgba(255, 255, 255, 0.5); margin-top: 8px; max-width: 400px; line-height: 1.4;">${escapeHtml(historyItem.metadata.description.substring(0, 200))}${historyItem.metadata.description.length > 200 ? '...' : ''}</div>` : ''}
            </div>
            <button onclick="openFileInSystem('${escapeHtml(filePath)}')" style="
                padding: 10px 24px;
                background: rgba(255, 255, 255, 0.1);
                border: 1px solid rgba(255, 255, 255, 0.2);
                border-radius: 6px;
                color: rgba(255, 255, 255, 0.9);
                cursor: pointer;
                font-size: 13px;
                transition: all 0.2s;
            " onmouseover="this.style.background='rgba(255,255,255,0.15)'" onmouseout="this.style.background='rgba(255,255,255,0.1)'">
                Open in Default App
            </button>
        </div>
    `;
    viewMode.style.display = 'flex';
    viewMode.style.whiteSpace = 'normal';
    viewMode.style.fontFamily = 'inherit';
    viewMode.style.overflow = 'auto';
    viewMode.style.flex = '1';
    document.getElementById('previewModeBtn').style.display = 'none';
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
                    <span class="remove-tag" data-tag="${escapeHtml(tag)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 10px; height: 10px;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>
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
    
    // Update sidebar tags
    updateSidebarTags();
}

// Update sidebar tags list
function updateSidebarTags() {
    const container = document.getElementById('sidebarTagsList');
    const countEl = document.getElementById('sidebarTagsCount');
    if (!container) return;
    
    // Get items based on current space
    const items = currentSpace === null ? history : history.filter(item => item.spaceId === currentSpace);
    const tagCounts = extractAllTags(items);
    
    // Sort tags by count (most used first), then alphabetically
    const sortedTags = Object.entries(tagCounts)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    
    // Update count badge
    if (countEl) {
        countEl.textContent = sortedTags.length;
    }
    
    if (sortedTags.length === 0) {
        container.innerHTML = '<div class="sidebar-tags-empty">No tags in this space</div>';
        return;
    }
    
    container.innerHTML = sortedTags.map(([tag, count]) => {
        const isSelected = selectedTags.includes(tag);
        const color = getTagColor(tag);
        const colorStyle = color ? `background: ${color}; border-color: ${color};` : '';
        return `
            <div class="sidebar-tag-item ${isSelected ? 'selected' : ''}" 
                 data-tag="${escapeHtml(tag)}"
                 draggable="false">
                <span class="sidebar-tag-indicator" style="${colorStyle}"></span>
                <span class="sidebar-tag-name">${escapeHtml(tag)}</span>
                <span class="sidebar-tag-count">${count}</span>
            </div>
        `;
    }).join('');
    
    // Add click handlers
    container.querySelectorAll('.sidebar-tag-item').forEach(item => {
        // Right-click for color picker
        item.addEventListener('contextmenu', (e) => {
            showTagColorPicker(e, item.dataset.tag);
        });
        
        item.addEventListener('click', () => {
            const tag = item.dataset.tag;
            toggleTag(tag);
        });
        
        // Add drag-over handlers for tag assignment
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            item.classList.add('drag-over');
        });
        
        item.addEventListener('dragleave', () => {
            item.classList.remove('drag-over');
        });
        
        item.addEventListener('drop', async (e) => {
            e.preventDefault();
            item.classList.remove('drag-over');
            const tag = item.dataset.tag;
            
            // Get the dragged item ID
            const itemId = e.dataTransfer.getData('text/plain');
            if (itemId) {
                await addTagToItem(itemId, tag);
            }
        });
    });
}

// Add a tag to an item
async function addTagToItem(itemId, tag) {
    try {
        // Find the item
        const item = history.find(h => h.id === itemId);
        if (!item) return;
        
        // Get current tags
        const currentTags = item.metadata?.tags || item.tags || [];
        const normalizedTag = tag.trim().toLowerCase();
        
        // Check if tag already exists
        const normalizedCurrentTags = currentTags.map(t => t.trim().toLowerCase());
        if (normalizedCurrentTags.includes(normalizedTag)) {
            console.log('Tag already exists on item');
            return;
        }
        
        // Add the tag
        const newTags = [...currentTags, tag];
        
        // Update the item metadata
        await window.clipboard.updateItemMetadata(itemId, { tags: newTags });
        
        // Update local state
        if (item.metadata) {
            item.metadata.tags = newTags;
        } else {
            item.metadata = { tags: newTags };
        }
        item.tags = newTags;
        
        // Refresh UI
        updateTagUI();
        if (currentView === 'grouped') {
            filterItems();
        }
        
        console.log(`Added tag "${tag}" to item ${itemId}`);
    } catch (error) {
        console.error('Error adding tag to item:', error);
    }
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
// Generative Search
// ============================================

let generativeSearchPanel = null;
let generativeSearchProgressCleanup = null;

// Initialize Generative Search UI
function initGenerativeSearch() {
    const searchBtn = document.getElementById('generativeSearchBtn');
    const panelContainer = document.getElementById('generativeSearchPanelContainer');
    
    
    if (!searchBtn || !panelContainer) {
        console.log('[GenerativeSearch] UI elements not found');
        return;
    }
    
    // Check if GenerativeSearchPanel class is available
    if (typeof GenerativeSearchPanel === 'undefined') {
        console.log('[GenerativeSearch] Panel class not loaded');
        return;
    }
    
    // Create the panel
    generativeSearchPanel = new GenerativeSearchPanel(panelContainer, {
        currentSpace: currentSpace,
        onSearch: async (options) => {
            try {
                // Setup progress listener
                if (generativeSearchProgressCleanup) {
                    generativeSearchProgressCleanup();
                }
                generativeSearchProgressCleanup = window.clipboard.generativeSearch.onProgress((progress) => {
                    if (generativeSearchPanel) {
                        generativeSearchPanel.updateProgress(
                            progress.percentComplete,
                            `Processing ${progress.processed}/${progress.total} items...`
                        );
                    }
                });
                
                // Run search
                const results = await window.clipboard.generativeSearch.search(options);
                
                // Cleanup progress listener
                if (generativeSearchProgressCleanup) {
                    generativeSearchProgressCleanup();
                    generativeSearchProgressCleanup = null;
                }
                
                return results;
            } catch (error) {
                if (generativeSearchProgressCleanup) {
                    generativeSearchProgressCleanup();
                    generativeSearchProgressCleanup = null;
                }
                throw error;
            }
        },
        onResults: (results) => {
            if (results && results.length > 0) {
                // Render the search results
                renderGenerativeSearchResults(results);
            } else {
                // Clear and show message
                filterItems();
            }
        },
        onCancel: () => {
            window.clipboard.generativeSearch.cancel();
            if (generativeSearchProgressCleanup) {
                generativeSearchProgressCleanup();
                generativeSearchProgressCleanup = null;
            }
        }
    });
    
    // Toggle panel visibility
    searchBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isVisible = panelContainer.style.display !== 'none';
        
        if (isVisible) {
            panelContainer.style.display = 'none';
            searchBtn.classList.remove('active');
        } else {
            panelContainer.style.display = 'block';
            searchBtn.classList.add('active');
            generativeSearchPanel.setCurrentSpace(currentSpace);
            generativeSearchPanel.show();
        }
    });
    
    // Close panel when clicking outside
    document.addEventListener('click', (e) => {
        if (!panelContainer.contains(e.target) && e.target !== searchBtn && !searchBtn.contains(e.target)) {
            if (panelContainer.style.display !== 'none') {
                panelContainer.style.display = 'none';
                searchBtn.classList.remove('active');
            }
        }
    });
    
    // Prevent panel close when clicking inside
    panelContainer.addEventListener('click', (e) => {
        e.stopPropagation();
    });
    
    console.log('[GenerativeSearch] Initialized');
}

// Render generative search results with scores
function renderGenerativeSearchResults(results) {
    // FIX: Changed from 'historyContainer' to 'historyList' - the correct element ID
    const container = document.getElementById('historyList');
    if (!container) return;
    
    // Add search results indicator
    let resultsIndicator = document.querySelector('.generative-results-indicator');
    if (!resultsIndicator) {
        resultsIndicator = document.createElement('div');
        resultsIndicator.className = 'generative-results-indicator';
        container.parentNode.insertBefore(resultsIndicator, container);
    }
    resultsIndicator.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; background: linear-gradient(135deg, rgba(147, 51, 234, 0.1), rgba(79, 70, 229, 0.1)); border: 1px solid rgba(147, 51, 234, 0.2); border-radius: 8px; margin-bottom: 12px;">
            <span style="color: rgba(200, 180, 255, 0.9); font-size: 13px;">
                AI Search: ${results.length} items found, sorted by relevance
            </span>
            <button onclick="clearGenerativeSearchResults()" style="background: rgba(147, 51, 234, 0.2); border: 1px solid rgba(147, 51, 234, 0.3); color: rgba(200, 180, 255, 0.9); padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;">
                Clear Results
            </button>
        </div>
    `;
    
    // Render the items with score badges and tooltips
    const itemsWithScoreBadges = results.map((item, idx) => {
        const score = item._search?.compositeScore || 0;
        const scores = item._search?.scores || {};
        
        
        // Build tooltip explaining the relevance
        // Prioritize the LLM's reason explanation if available
        const reason = item._search?.reason;
        
        let tooltip;
        if (reason) {
            // Use the LLM's explanation
            tooltip = `${Math.round(score)}% Match\n\n${reason}`;
        } else {
            // Fall back to score breakdown if no reason provided
            const scoreDetails = Object.entries(scores)
                .filter(([key]) => key !== 'reason') // Exclude reason from scores list
                .map(([filterId, value]) => {
                    if (typeof value !== 'number') return null;
                    const filterName = filterId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                    return `${filterName}: ${Math.round(value)}%`;
                })
                .filter(Boolean)
                .join('\n');
            
            tooltip = scoreDetails 
                ? `AI Relevance: ${Math.round(score)}%\n\nScore Breakdown:\n${scoreDetails}`
                : `AI Relevance: ${Math.round(score)}%`;
        }
        
        // Create tooltip content as data attribute (for custom tooltip)
        const tooltipData = encodeURIComponent(tooltip);
        
        const badgeHtml = `<span class="gs-score-badge" data-tooltip="${tooltipData}" style="background: linear-gradient(135deg, rgba(147, 51, 234, 0.3), rgba(79, 70, 229, 0.3)); padding: 2px 8px; border-radius: 4px; font-size: 10px; color: rgba(200, 180, 255, 0.9); margin-left: 8px; cursor: help; position: relative;">${Math.round(score)}%</span>`;
        return {
            ...item,
            _scoreBadge: badgeHtml
        };
    });
    
    
    // Use existing render function
    renderHistory(itemsWithScoreBadges, { showScoreBadges: true });
    
}

// Clear generative search results
function clearGenerativeSearchResults() {
    const indicator = document.querySelector('.generative-results-indicator');
    if (indicator) {
        indicator.remove();
    }
    
    // Reset to normal view
    filterItems();
    
    // Clear panel results
    if (generativeSearchPanel) {
        generativeSearchPanel.clearResults();
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
            if (currentFilter === 'playbook') return isPlaybookNote(item);
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
            // Style-guide, journey-map, and chatbot-conversation can be either file type or text type (pasted JSON)
            // Check both item.jsonSubtype and item.metadata.jsonSubtype since data may be stored in either location
            if (currentFilter === 'style-guide') return item.jsonSubtype === 'style-guide' || item.metadata?.jsonSubtype === 'style-guide';
            if (currentFilter === 'journey-map') return item.jsonSubtype === 'journey-map' || item.metadata?.jsonSubtype === 'journey-map';
            if (currentFilter === 'chatbot-conversation') return item.jsonSubtype === 'chatbot-conversation' || item.metadata?.jsonSubtype === 'chatbot-conversation';
            if (currentFilter === 'spreadsheet') return item.source === 'spreadsheet' || (item.type === 'file' && (item.fileExt === '.xls' || item.fileExt === '.xlsx' || item.fileExt === '.ods'));
            if (currentFilter === 'presentation') return item.type === 'file' && (item.fileCategory === 'presentation' || item.fileExt === '.ppt' || item.fileExt === '.pptx' || item.fileExt === '.key' || item.fileExt === '.odp');
            if (currentFilter === 'pdf') return item.type === 'file' && item.fileType === 'pdf';
            if (currentFilter === 'url') return item.source === 'url';
            if (currentFilter === 'image') return item.type === 'image' || (item.type === 'file' && item.fileType === 'image-file');
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
    
    // Render with appropriate view mode
    if (currentView === 'grouped') {
        renderGroupedView(items);
    } else {
        renderHistory(items);
    }
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
            // Style-guide, journey-map, and chatbot-conversation can be either file type or text type (pasted JSON)
            // Check both item.jsonSubtype and item.metadata.jsonSubtype since data may be stored in either location
            if (currentFilter === 'style-guide') return item.jsonSubtype === 'style-guide' || item.metadata?.jsonSubtype === 'style-guide';
            if (currentFilter === 'journey-map') return item.jsonSubtype === 'journey-map' || item.metadata?.jsonSubtype === 'journey-map';
            if (currentFilter === 'chatbot-conversation') return item.jsonSubtype === 'chatbot-conversation' || item.metadata?.jsonSubtype === 'chatbot-conversation';
            if (currentFilter === 'spreadsheet') return item.source === 'spreadsheet' || (item.type === 'file' && (item.fileExt === '.xls' || item.fileExt === '.xlsx' || item.fileExt === '.ods'));
            if (currentFilter === 'presentation') return item.type === 'file' && (item.fileCategory === 'presentation' || item.fileExt === '.ppt' || item.fileExt === '.pptx' || item.fileExt === '.key' || item.fileExt === '.odp');
            if (currentFilter === 'pdf') return item.type === 'file' && item.fileType === 'pdf';
            if (currentFilter === 'url') return item.source === 'url';
            if (currentFilter === 'image') return item.type === 'image' || (item.type === 'file' && item.fileType === 'image-file');
            if (currentFilter === 'video') return item.type === 'file' && item.fileType === 'video';
            if (currentFilter === 'audio') return item.type === 'file' && item.fileType === 'audio';
            if (currentFilter === 'file') return item.type === 'file';
            if (currentFilter === 'text') {
                if (item.type === 'text') return item.source !== 'code' && item.source !== 'url';
                if (item.type === 'file' && item.fileExt === '.md') return true;
                return false;
            }
            if (currentFilter === 'playbook') return isPlaybookNote(item);
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
    
    // Render with appropriate view mode
    if (currentView === 'grouped') {
        renderGroupedView(filtered);
    } else {
        renderHistory(filtered);
    }
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

// Handle export - opens format selection modal
async function handlePDFExport(space) {
    try {
        // Open the new multi-format export modal
        if (window.clipboard.openFormatModal) {
            await window.clipboard.openFormatModal(space.id);
        } else {
            // Fallback to old export preview
            showNotification({
                title: 'Export Preview',
                body: 'Opening export preview...',
                type: 'info'
            });
            await window.clipboard.openExportPreview(space.id, { useAI: false });
        }
        
    } catch (error) {
        console.error('Error opening export modal:', error);
        showNotification({
            title: 'Error',
            body: error.message || 'Failed to open export options',
            type: 'error'
        });
    }
}

// Handle direct format export (called from format modal)
async function handleFormatExport(spaceId, format, options = {}) {
    try {
        showNotification({
            title: 'Generating Export',
            body: `Creating ${format.toUpperCase()} document...`,
            type: 'info'
        });
        
        const result = await window.clipboard.generateExport({
            format,
            spaceId,
            options
        });
        
        if (result.success) {
            showNotification({
                title: 'Export Complete',
                body: `Document saved successfully`,
                type: 'success'
            });
        } else if (!result.canceled) {
            throw new Error(result.error || 'Export failed');
        }
        
    } catch (error) {
        console.error('Error generating export:', error);
        showNotification({
            title: 'Export Failed',
            body: error.message || 'Failed to generate document',
            type: 'error'
        });
    }
}

// Show notification (handles both string and object formats)
// This function is intentionally duplicated to override the simpler one above
function showNotification(options) {
    // Handle string input (simple message)
    if (typeof options === 'string') {
        options = { message: options, type: 'info' };
    }
    
    // Determine colors based on type
    let bgColor = 'rgba(26, 26, 37, 0.95)';
    let borderColor = 'rgba(99, 102, 241, 0.5)';
    if (options.type === 'success') {
        bgColor = 'rgba(16, 185, 129, 0.9)';
        borderColor = 'rgba(16, 185, 129, 0.8)';
    } else if (options.type === 'error') {
        bgColor = 'rgba(239, 68, 68, 0.9)';
        borderColor = 'rgba(239, 68, 68, 0.8)';
    } else if (options.type === 'warning') {
        bgColor = 'rgba(245, 158, 11, 0.9)';
        borderColor = 'rgba(245, 158, 11, 0.8)';
    }
    
    // Create notification element
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: ${bgColor};
        color: #fff;
        padding: 12px 20px;
        border-radius: 8px;
        border: 1px solid ${borderColor};
        font-size: 13px;
        z-index: 10001;
        animation: notifSlideIn 0.3s ease;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
        max-width: 400px;
    `;
    
    // Build content - support both {title, body} and {message} formats
    const title = options.title;
    const body = options.body || options.message || '';
    
    if (title) {
        notification.innerHTML = `
            <div style="font-weight: 500; margin-bottom: 4px;">${title}</div>
            <div style="opacity: 0.9;">${body}</div>
        `;
    } else {
        notification.textContent = body;
    }
    
    // Add animation keyframes if not already added
    if (!document.getElementById('notif-animations')) {
        const style = document.createElement('style');
        style.id = 'notif-animations';
        style.textContent = `
            @keyframes notifSlideIn {
                from { opacity: 0; transform: translateX(100px); }
                to { opacity: 1; transform: translateX(0); }
            }
            @keyframes notifSlideOut {
                from { opacity: 1; transform: translateX(0); }
                to { opacity: 0; transform: translateX(100px); }
            }
        `;
        document.head.appendChild(style);
    }
    
    document.body.appendChild(notification);
    
    // Remove after 4 seconds
    setTimeout(() => {
        notification.style.animation = 'notifSlideOut 0.3s ease forwards';
        setTimeout(() => notification.remove(), 300);
    }, 4000);
}

// Show move to space modal
async function showMoveToSpaceModal(itemId) {
    // Create a temporary modal for space selection
    const modalHtml = `
        <div class="modal-overlay" id="moveToSpaceModal" style="display: flex;">
            <div class="modal" style="width: 400px;">
                <h2 class="modal-title">Move to Space</h2>
                <div class="space-select-list" style="max-height: 300px; overflow-y: auto; margin: 20px 0;">
                    ${spacesData.map(space => `
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
                            <span class="space-name" style="flex: 1;">${escapeHtml(typeof space.name === 'string' ? space.name : 'Unnamed Space')}</span>
                            <span class="space-count" style="font-size: 12px; color: rgba(255, 255, 255, 0.5);">${space.itemCount || 0} items</span>
                        </div>
                    `).join('')}
                    <!-- Create New Space Accordion -->
                    <div id="createNewSpaceAccordion" style="margin-top: 8px;">
                        <div class="create-space-header" id="createNewSpaceHeader" style="
                            display: flex;
                            align-items: center;
                            padding: 12px;
                            cursor: pointer;
                            border-radius: 8px;
                            border: 2px dashed rgba(255, 255, 255, 0.2);
                            background: rgba(99, 102, 241, 0.1);
                            transition: all 0.2s;
                        ">
                            <span class="chevron" id="createSpaceChevron" style="margin-right: 8px; transition: transform 0.2s; color: rgba(99, 102, 241, 1);">▶</span>
                            <span style="font-size: 18px; margin-right: 12px;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 18px; height: 18px;"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></span>
                            <span style="flex: 1; color: rgba(99, 102, 241, 1);">Create New Space</span>
                        </div>
                        <div class="create-space-form" id="createNewSpaceForm" style="
                            display: none;
                            padding: 16px;
                            background: rgba(0, 0, 0, 0.3);
                            border-radius: 8px;
                            margin-top: 8px;
                            border: 1px solid rgba(99, 102, 241, 0.2);
                        ">
                            <div style="margin-bottom: 12px;">
                                <input type="text" id="newSpaceNameMove" placeholder="Enter space name..." style="
                                    width: 100%;
                                    padding: 10px;
                                    background: rgba(255, 255, 255, 0.05);
                                    border: 1px solid rgba(255, 255, 255, 0.2);
                                    border-radius: 6px;
                                    color: #fff;
                                    font-size: 14px;
                                ">
                            </div>
                            <div style="margin-bottom: 12px;">
                                <div style="font-size: 12px; color: rgba(255, 255, 255, 0.5); margin-bottom: 6px;">Icon</div>
                                <div id="iconPickerMove" style="display: flex; gap: 8px; flex-wrap: wrap;">
                                    <div class="icon-option-inline selected" data-icon="◆" style="
                                        width: 32px;
                                        height: 32px;
                                        display: flex;
                                        align-items: center;
                                        justify-content: center;
                                        border-radius: 6px;
                                        background: rgba(255, 255, 255, 0.1);
                                        cursor: pointer;
                                        transition: all 0.2s;
                                        border: 2px solid transparent;
                                    ">◆</div>
                                    <div class="icon-option-inline" data-icon="●" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">●</div>
                                    <div class="icon-option-inline" data-icon="■" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">■</div>
                                    <div class="icon-option-inline" data-icon="▲" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">▲</div>
                                    <div class="icon-option-inline" data-icon="◉" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">◉</div>
                                    <div class="icon-option-inline" data-icon="◎" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">◎</div>
                                    <div class="icon-option-inline" data-icon="◇" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">◇</div>
                                    <div class="icon-option-inline" data-icon="○" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">○</div>
                                    <div class="icon-option-inline" data-icon="□" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">□</div>
                                    <div class="icon-option-inline" data-icon="△" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">△</div>
                                </div>
                            </div>
                            <div style="display: flex; gap: 8px;">
                                <button id="cancelCreateMove" style="
                                    flex: 1;
                                    padding: 10px;
                                    background: rgba(255, 255, 255, 0.1);
                                    border: 1px solid rgba(255, 255, 255, 0.2);
                                    border-radius: 6px;
                                    color: #fff;
                                    cursor: pointer;
                                    font-size: 14px;
                                    transition: all 0.2s;
                                ">Cancel</button>
                                <button id="confirmCreateMove" style="
                                    flex: 1;
                                    padding: 10px;
                                    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
                                    border: none;
                                    border-radius: 6px;
                                    color: #fff;
                                    cursor: pointer;
                                    font-size: 14px;
                                    font-weight: 500;
                                    transition: all 0.2s;
                                ">Create</button>
                            </div>
                        </div>
                    </div>
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
    
    // Setup accordion for "Create New Space"
    const createHeader = document.getElementById('createNewSpaceHeader');
    const createForm = document.getElementById('createNewSpaceForm');
    const createChevron = document.getElementById('createSpaceChevron');
    const newSpaceInput = document.getElementById('newSpaceNameMove');
    const iconPicker = document.getElementById('iconPickerMove');
    const cancelBtn = document.getElementById('cancelCreateMove');
    const confirmBtn = document.getElementById('confirmCreateMove');
    
    // Hover effects for header
    createHeader.addEventListener('mouseenter', () => {
        createHeader.style.background = 'rgba(99, 102, 241, 0.2)';
        createHeader.style.borderColor = 'rgba(99, 102, 241, 0.5)';
    });
    createHeader.addEventListener('mouseleave', () => {
        createHeader.style.background = 'rgba(99, 102, 241, 0.1)';
        createHeader.style.borderColor = 'rgba(255, 255, 255, 0.2)';
    });
    
    // Toggle accordion
    createHeader.addEventListener('click', () => {
        const isExpanded = createForm.style.display !== 'none';
        if (isExpanded) {
            createForm.style.display = 'none';
            createChevron.style.transform = 'rotate(0deg)';
        } else {
            createForm.style.display = 'block';
            createChevron.style.transform = 'rotate(90deg)';
            setTimeout(() => newSpaceInput.focus(), 100);
        }
    });
    
    // Icon picker selection
    iconPicker.querySelectorAll('.icon-option-inline').forEach(option => {
        option.addEventListener('click', () => {
            iconPicker.querySelectorAll('.icon-option-inline').forEach(opt => {
                opt.classList.remove('selected');
                opt.style.borderColor = 'transparent';
                opt.style.background = 'rgba(255, 255, 255, 0.1)';
            });
            option.classList.add('selected');
            option.style.borderColor = 'rgba(99, 102, 241, 0.8)';
            option.style.background = 'rgba(99, 102, 241, 0.2)';
        });
        option.addEventListener('mouseenter', () => {
            if (!option.classList.contains('selected')) {
                option.style.background = 'rgba(255, 255, 255, 0.15)';
            }
        });
        option.addEventListener('mouseleave', () => {
            if (!option.classList.contains('selected')) {
                option.style.background = 'rgba(255, 255, 255, 0.1)';
            }
        });
    });
    
    // Cancel button
    cancelBtn.addEventListener('click', () => {
        createForm.style.display = 'none';
        createChevron.style.transform = 'rotate(0deg)';
        newSpaceInput.value = '';
    });
    
    // Create button - will be wired up in next step
    confirmBtn.addEventListener('click', async () => {
        const name = newSpaceInput.value.trim();
        if (!name) {
            alert('Please enter a space name');
            return;
        }
        
        const selectedIcon = iconPicker.querySelector('.icon-option-inline.selected');
        const icon = selectedIcon ? selectedIcon.dataset.icon : '◆';
        
        try {
            // Create the space
            const result = await window.clipboard.createSpace({ name, icon, notebook: {} });
            const newSpaceId = result?.space?.id;
            
            if (newSpaceId) {
                // Move the item to the new space
                await window.clipboard.moveToSpace(itemId, newSpaceId);
                await loadSpaces();
                await loadHistory();
                modal.remove();
                hideContextMenu();
                showNotification(`✓ Moved to new space "${name}"`);
            } else {
                throw new Error('Failed to create space');
            }
        } catch (error) {
            console.error('Error creating space and moving item:', error);
            alert('Failed to create space: ' + error.message);
        }
    });
    
    // Enter key to submit
    newSpaceInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            confirmBtn.click();
        } else if (e.key === 'Escape') {
            cancelBtn.click();
        }
    });
    
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
                <h2 class="modal-title">Paste into Space</h2>
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
                        <span class="space-icon" style="font-size: 18px; margin-right: 12px;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 18px; height: 18px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></span>
                        <span class="space-name" style="flex: 1;">Unclassified</span>
                    </div>
                    ${spacesData.map(space => `
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
                            <span class="space-name" style="flex: 1;">${escapeHtml(typeof space.name === 'string' ? space.name : 'Unnamed Space')}</span>
                            <span class="space-count" style="font-size: 12px; color: rgba(255, 255, 255, 0.5);">${space.itemCount || 0} items</span>
                        </div>
                    `).join('')}
                    <!-- Create New Space Accordion -->
                    <div id="createNewSpaceAccordionPaste" style="margin-top: 8px;">
                        <div class="create-space-header" id="createNewSpaceHeaderPaste" style="
                            display: flex;
                            align-items: center;
                            padding: 12px;
                            cursor: pointer;
                            border-radius: 8px;
                            border: 2px dashed rgba(255, 255, 255, 0.2);
                            background: rgba(99, 102, 241, 0.1);
                            transition: all 0.2s;
                        ">
                            <span class="chevron" id="createSpaceChevronPaste" style="margin-right: 8px; transition: transform 0.2s; color: rgba(99, 102, 241, 1);">▶</span>
                            <span style="font-size: 18px; margin-right: 12px;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 18px; height: 18px;"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></span>
                            <span style="flex: 1; color: rgba(99, 102, 241, 1);">Create New Space</span>
                        </div>
                        <div class="create-space-form" id="createNewSpaceFormPaste" style="
                            display: none;
                            padding: 16px;
                            background: rgba(0, 0, 0, 0.3);
                            border-radius: 8px;
                            margin-top: 8px;
                            border: 1px solid rgba(99, 102, 241, 0.2);
                        ">
                            <div style="margin-bottom: 12px;">
                                <input type="text" id="newSpaceNamePaste" placeholder="Enter space name..." style="
                                    width: 100%;
                                    padding: 10px;
                                    background: rgba(255, 255, 255, 0.05);
                                    border: 1px solid rgba(255, 255, 255, 0.2);
                                    border-radius: 6px;
                                    color: #fff;
                                    font-size: 14px;
                                ">
                            </div>
                            <div style="margin-bottom: 12px;">
                                <div style="font-size: 12px; color: rgba(255, 255, 255, 0.5); margin-bottom: 6px;">Icon</div>
                                <div id="iconPickerPaste" style="display: flex; gap: 8px; flex-wrap: wrap;">
                                    <div class="icon-option-inline selected" data-icon="◆" style="
                                        width: 32px;
                                        height: 32px;
                                        display: flex;
                                        align-items: center;
                                        justify-content: center;
                                        border-radius: 6px;
                                        background: rgba(255, 255, 255, 0.1);
                                        cursor: pointer;
                                        transition: all 0.2s;
                                        border: 2px solid transparent;
                                    ">◆</div>
                                    <div class="icon-option-inline" data-icon="●" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">●</div>
                                    <div class="icon-option-inline" data-icon="■" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">■</div>
                                    <div class="icon-option-inline" data-icon="▲" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">▲</div>
                                    <div class="icon-option-inline" data-icon="◉" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">◉</div>
                                    <div class="icon-option-inline" data-icon="◎" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">◎</div>
                                    <div class="icon-option-inline" data-icon="◇" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">◇</div>
                                    <div class="icon-option-inline" data-icon="○" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">○</div>
                                    <div class="icon-option-inline" data-icon="□" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">□</div>
                                    <div class="icon-option-inline" data-icon="△" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">△</div>
                                </div>
                            </div>
                            <div style="display: flex; gap: 8px;">
                                <button id="cancelCreatePaste" style="
                                    flex: 1;
                                    padding: 10px;
                                    background: rgba(255, 255, 255, 0.1);
                                    border: 1px solid rgba(255, 255, 255, 0.2);
                                    border-radius: 6px;
                                    color: #fff;
                                    cursor: pointer;
                                    font-size: 14px;
                                    transition: all 0.2s;
                                ">Cancel</button>
                                <button id="confirmCreatePaste" style="
                                    flex: 1;
                                    padding: 10px;
                                    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
                                    border: none;
                                    border-radius: 6px;
                                    color: #fff;
                                    cursor: pointer;
                                    font-size: 14px;
                                    font-weight: 500;
                                    transition: all 0.2s;
                                ">Create</button>
                            </div>
                        </div>
                    </div>
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
    
    // Setup accordion for "Create New Space"
    const createHeader = document.getElementById('createNewSpaceHeaderPaste');
    const createForm = document.getElementById('createNewSpaceFormPaste');
    const createChevron = document.getElementById('createSpaceChevronPaste');
    const newSpaceInput = document.getElementById('newSpaceNamePaste');
    const iconPicker = document.getElementById('iconPickerPaste');
    const cancelBtn = document.getElementById('cancelCreatePaste');
    const confirmBtn = document.getElementById('confirmCreatePaste');
    
    // Hover effects for header
    createHeader.addEventListener('mouseenter', () => {
        createHeader.style.background = 'rgba(99, 102, 241, 0.2)';
        createHeader.style.borderColor = 'rgba(99, 102, 241, 0.5)';
    });
    createHeader.addEventListener('mouseleave', () => {
        createHeader.style.background = 'rgba(99, 102, 241, 0.1)';
        createHeader.style.borderColor = 'rgba(255, 255, 255, 0.2)';
    });
    
    // Toggle accordion
    createHeader.addEventListener('click', () => {
        const isExpanded = createForm.style.display !== 'none';
        if (isExpanded) {
            createForm.style.display = 'none';
            createChevron.style.transform = 'rotate(0deg)';
        } else {
            createForm.style.display = 'block';
            createChevron.style.transform = 'rotate(90deg)';
            setTimeout(() => newSpaceInput.focus(), 100);
        }
    });
    
    // Icon picker selection
    iconPicker.querySelectorAll('.icon-option-inline').forEach(option => {
        option.addEventListener('click', () => {
            iconPicker.querySelectorAll('.icon-option-inline').forEach(opt => {
                opt.classList.remove('selected');
                opt.style.borderColor = 'transparent';
                opt.style.background = 'rgba(255, 255, 255, 0.1)';
            });
            option.classList.add('selected');
            option.style.borderColor = 'rgba(99, 102, 241, 0.8)';
            option.style.background = 'rgba(99, 102, 241, 0.2)';
        });
        option.addEventListener('mouseenter', () => {
            if (!option.classList.contains('selected')) {
                option.style.background = 'rgba(255, 255, 255, 0.15)';
            }
        });
        option.addEventListener('mouseleave', () => {
            if (!option.classList.contains('selected')) {
                option.style.background = 'rgba(255, 255, 255, 0.1)';
            }
        });
    });
    
    // Cancel button
    cancelBtn.addEventListener('click', () => {
        createForm.style.display = 'none';
        createChevron.style.transform = 'rotate(0deg)';
        newSpaceInput.value = '';
    });
    
    // Create button - create space and paste immediately
    confirmBtn.addEventListener('click', async () => {
        const name = newSpaceInput.value.trim();
        if (!name) {
            alert('Please enter a space name');
            return;
        }
        
        const selectedIcon = iconPicker.querySelector('.icon-option-inline.selected');
        const icon = selectedIcon ? selectedIcon.dataset.icon : '◆';
        
        try {
            // Create the space
            const result = await window.clipboard.createSpace({ name, icon, notebook: {} });
            const newSpaceId = result?.space?.id;
            
            if (newSpaceId) {
                // Paste into the new space
                modal.remove();
                await pasteIntoSpace(newSpaceId);
                showNotification(`✓ Pasted into new space "${name}"`);
            } else {
                throw new Error('Failed to create space');
            }
        } catch (error) {
            console.error('[PasteModal] Error creating space and pasting:', error);
            showNotification('❌ Failed to create space: ' + error.message);
        }
    });
    
    // Enter key to submit
    newSpaceInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            confirmBtn.click();
        } else if (e.key === 'Escape') {
            cancelBtn.click();
        }
    });
    
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
    if (item.type === 'image' || item.isScreenshot || (item.type === 'file' && item.fileType === 'image-file')) return schemas.image;
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
        'video': { 
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="5" width="20" height="14" rx="2"/><polygon points="10 8 16 12 10 16"/></svg>', 
            name: 'Video', 
            color: '#8b5cf6' 
        },
        'audio': { 
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>', 
            name: 'Audio', 
            color: '#f59e0b' 
        },
        'code': { 
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>', 
            name: 'Code', 
            color: '#10b981' 
        },
        'pdf': { 
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M7 11h10M7 15h10"/></svg>', 
            name: 'PDF', 
            color: '#ef4444' 
        },
        'data': { 
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 7h10M7 12h10M7 17h6"/></svg>', 
            name: 'Data', 
            color: '#06b6d4' 
        },
        'image': { 
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>', 
            name: 'Image', 
            color: '#ec4899' 
        },
        'html': { 
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>', 
            name: 'Document', 
            color: '#6366f1' 
        },
        'url': { 
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>', 
            name: 'Web Link', 
            color: '#3b82f6' 
        },
        'web-monitor': { 
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/><path d="M12 6v6l4 2"/></svg>', 
            name: 'Web Monitor', 
            color: '#4a9eff' 
        },
        'text': { 
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 7h16M4 12h16M4 17h10"/></svg>', 
            name: 'Text', 
            color: '#64748b' 
        },
        'file': { 
            icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>', 
            name: 'File', 
            color: '#78716c' 
        }
    };
    
    const config = typeConfig[assetType] || typeConfig['file'];
    
    // Update header - with null checks
    const assetIconEl = document.getElementById('metadataAssetIcon');
    const titleEl = document.getElementById('metadataTitle');
    const typeBadgeEl = document.getElementById('metadataTypeBadge');
    const fileNameEl = document.getElementById('metadataFileName');
    
    if (assetIconEl) assetIconEl.innerHTML = config.icon; // Use innerHTML for SVG
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
                    setTimeout(() => { copyTranscriptBtn.textContent = 'Copy'; }, 2000);
                }
            };
        }
        
        // Extract Audio button - show for video files
        const extractAudioBtn = document.getElementById('extractAudioBtn');
        const isVideo = item?.fileCategory === 'video' || item?.fileType?.startsWith('video/');
        if (isVideo && extractAudioBtn) {
            // Check if audio already extracted
            if (metadata.audioPath) {
                extractAudioBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle; margin-right: 6px;"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg> Download Audio';
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
                extractAudioBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle; margin-right: 6px;"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg> Extract Audio';
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
                            extractAudioBtn.textContent = 'Audio Ready';
                            extractAudioBtn.style.background = 'rgba(34, 197, 94, 0.6)';
                            
                            // Update button to download
                            setTimeout(() => {
                                extractAudioBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle; margin-right: 6px;"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg> Download Audio';
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
                                extractAudioBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle; margin-right: 6px;"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg> Extract Audio';
                                extractAudioBtn.disabled = false;
                            }, 2000);
                        }
                    } catch (e) {
                        // Clean up listener
                        if (removeProgressListener) removeProgressListener();
                        
                        extractAudioBtn.textContent = '❌ Error';
                        alert('Error: ' + e.message);
                        setTimeout(() => {
                            extractAudioBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle; margin-right: 6px;"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg> Extract Audio';
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
                            identifySpeakersBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle; margin-right: 6px;"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> Re-analyze';
                            identifySpeakersBtn.style.background = '';
                            identifySpeakersBtn.disabled = false;
                        }, 3000);
                    } else {
                        transcriptInfo.textContent = 'Error: ' + result.error;
                        identifySpeakersBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle; margin-right: 6px;"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> Retry';
                        identifySpeakersBtn.disabled = false;
                    }
                } catch (e) {
                    console.error('[SpeakerID] Error:', e);
                    transcriptInfo.textContent = 'Error: ' + e.message;
                    identifySpeakersBtn.textContent = 'Retry';
                    identifySpeakersBtn.disabled = false;
                }
            };
        } else if (identifySpeakersBtn) {
            identifySpeakersBtn.style.display = 'none';
        }
    }
    
    // ========================================
    // WEB MONITOR TAB HANDLING
    // ========================================
    console.log('[MetadataModal] Item type check:', {
        itemId: item.id,
        itemType: item.type,
        spaceId: item.spaceId,
        isWebMonitor: item.type === 'web-monitor'
    });
    const isWebMonitor = item.type === 'web-monitor';
    const monitorTab = document.getElementById('monitorTab');
    const aiTab = document.getElementById('aiTab');
    
    // Show/hide AI tab based on item type
    console.log('[MetadataModal] AI Tab setup:', { aiTab: !!aiTab, isWebMonitor });
    if (aiTab) {
        aiTab.style.display = isWebMonitor ? 'inline-flex' : 'none';
        console.log('[MetadataModal] AI tab display set to:', aiTab.style.display);
    }
    
    // Show/hide AI Watch section vs generic AI section
    const aiWatchSection = document.getElementById('aiWatchSection');
    const aiGenericSection = document.getElementById('aiGenericSection');
    console.log('[MetadataModal] AI sections:', { aiWatchSection: !!aiWatchSection, aiGenericSection: !!aiGenericSection });
    if (aiWatchSection) {
        aiWatchSection.style.display = isWebMonitor ? 'block' : 'none';
    }
    if (aiGenericSection) {
        aiGenericSection.style.display = isWebMonitor ? 'none' : 'block';
    }
    
    // Populate AI Watch fields for web monitors
    if (isWebMonitor) {
        const watchPrompt = document.getElementById('aiWatchPrompt');
        const ignorePrompt = document.getElementById('aiIgnorePrompt');
        const autoSummarize = document.getElementById('aiAutoSummarize');
        const summaryStyle = document.getElementById('aiSummaryStyle');
        
        const aiSettings = item.settings?.aiWatch || metadata.settings?.aiWatch || {};
        
        if (watchPrompt) watchPrompt.value = aiSettings.watchFor || '';
        if (ignorePrompt) ignorePrompt.value = aiSettings.ignore || '';
        if (autoSummarize) autoSummarize.checked = aiSettings.autoSummarize !== false;
        if (summaryStyle) summaryStyle.value = aiSettings.summaryStyle || 'brief';
    }
    
    if (monitorTab) {
        monitorTab.style.display = isWebMonitor ? 'inline-flex' : 'none';
    }
    
    if (isWebMonitor) {
        // Switch to monitor tab for web-monitor items
        switchMetadataTab('monitor');
        
        // Populate monitor status
        const statusValue = document.getElementById('monitorStatusValue');
        const lastChecked = document.getElementById('monitorLastChecked');
        const nextCheck = document.getElementById('monitorNextCheck');
        const changeCount = document.getElementById('monitorChangeCount');
        
        const status = item.status || metadata.status || 'active';
        const statusDotClass = status === 'active' ? 'active' : status === 'paused' ? 'paused' : 'error';
        const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
        
        if (statusValue) {
            statusValue.innerHTML = `<span class="status-dot ${statusDotClass}"></span> ${statusLabel}`;
        }
        
        if (lastChecked) {
            const lastCheckedTime = item.lastChecked || metadata.lastChecked;
            lastChecked.textContent = lastCheckedTime 
                ? new Date(lastCheckedTime).toLocaleString() 
                : 'Never';
        }
        
        // Get check interval (default 30 min)
        const checkIntervalMins = item.settings?.checkInterval || metadata.settings?.checkInterval || 30;
        
        if (nextCheck) {
            // Calculate next check based on custom interval
            const lastTime = item.lastChecked || metadata.lastChecked;
            if (lastTime) {
                const nextTime = new Date(new Date(lastTime).getTime() + checkIntervalMins * 60 * 1000);
                const now = new Date();
                const minsUntil = Math.max(0, Math.round((nextTime - now) / 60000));
                if (minsUntil > 60) {
                    nextCheck.textContent = `In ${Math.round(minsUntil / 60)}h`;
                } else if (minsUntil > 0) {
                    nextCheck.textContent = `In ${minsUntil} min`;
                } else {
                    nextCheck.textContent = 'Soon';
                }
            } else {
                // Format the default next check text
                if (checkIntervalMins >= 60) {
                    nextCheck.textContent = `In ${checkIntervalMins / 60}h`;
                } else {
                    nextCheck.textContent = `In ${checkIntervalMins} min`;
                }
            }
        }
        
        if (changeCount) {
            const timeline = item.timeline || metadata.timeline || [];
            changeCount.textContent = timeline.length.toString();
        }
        
        // Format interval for display
        const formatInterval = (mins) => {
            if (mins < 60) return `${mins} minutes`;
            if (mins === 60) return '1 hour';
            if (mins < 1440) return `${mins / 60} hours`;
            return 'daily';
        };
        
        // Populate timeline
        const timelineContainer = document.getElementById('monitorTimeline');
        const timeline = item.timeline || metadata.timeline || [];
        
        console.log('[Monitor Tab] Timeline container found:', !!timelineContainer);
        console.log('[Monitor Tab] Timeline data:', timeline);
        console.log('[Monitor Tab] Timeline length:', timeline.length);
        
        if (timelineContainer) {
            if (timeline.length === 0) {
                timelineContainer.innerHTML = `
                    <div class="monitor-timeline-empty">
                        No changes detected yet. The monitor will check this URL every ${formatInterval(checkIntervalMins)}.
                    </div>
                `;
            } else {
                timelineContainer.innerHTML = timeline.map((change, index) => {
                    const isBaseline = change.type === 'baseline';
                    const dotClass = isBaseline ? 'timeline-dot baseline' : 'timeline-dot';
                    const summary = change.summary || (isBaseline ? 'Initial baseline captured' : 'Content changed');
                    return `
                    <div class="monitor-timeline-item ${isBaseline ? 'baseline' : ''}" data-index="${index}">
                        <div class="${dotClass}"></div>
                        <div class="timeline-content">
                            <div class="timeline-time">${new Date(change.timestamp).toLocaleString()}</div>
                            <div class="timeline-summary">${isBaseline ? '📸 ' : ''}${escapeHtml(summary)}</div>
                        </div>
                    </div>
                `;
                }).join('');
                
                // Add click handlers to timeline items
                timelineContainer.querySelectorAll('.monitor-timeline-item').forEach(el => {
                    el.addEventListener('click', () => {
                        const index = parseInt(el.dataset.index);
                        showMonitorChangeDetail(timeline[index], index, timeline);
                        
                        // Mark as selected
                        timelineContainer.querySelectorAll('.monitor-timeline-item').forEach(i => 
                            i.classList.remove('selected')
                        );
                        el.classList.add('selected');
                    });
                });
                
                // Auto-select the most recent change
                if (timeline.length > 0) {
                    const firstItem = timelineContainer.querySelector('.monitor-timeline-item');
                    if (firstItem) {
                        firstItem.click();
                    }
                }
            }
        }
        
        // Setup control buttons
        const checkNowBtn = document.getElementById('checkNowBtn');
        const pauseMonitorBtn = document.getElementById('pauseMonitorBtn');
        const toggleAiDescBtn = document.getElementById('toggleAiDescBtn');
        const aiDescToggleLabel = document.getElementById('aiDescToggleLabel');
        
        const aiEnabled = item.settings?.aiDescriptions || metadata.settings?.aiDescriptions || false;
        if (aiDescToggleLabel) {
            aiDescToggleLabel.textContent = aiEnabled ? 'Disable AI Descriptions' : 'Enable AI Descriptions';
        }
        
        if (pauseMonitorBtn) {
            pauseMonitorBtn.innerHTML = status === 'paused' 
                ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 14px; height: 14px;"><polygon points="5 3 19 12 5 21 5 3"/></svg> Resume'
                : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 14px; height: 14px;"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pause';
        }
        
        // Check Now button
        if (checkNowBtn) {
            checkNowBtn.onclick = async () => {
                checkNowBtn.disabled = true;
                checkNowBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 14px; height: 14px; animation: spin 1s linear infinite;"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Checking...';
                try {
                    const result = await window.clipboard.checkMonitorNow(itemId);
                    if (result.success) {
                        showNotification('Check complete' + (result.changed ? ' - Changes detected!' : ' - No changes'));
                        // Refresh the modal
                        await showMetadataModal(itemId);
                    } else {
                        showNotification('Check failed: ' + result.error, 'error');
                    }
                } catch (e) {
                    showNotification('Error: ' + e.message, 'error');
                }
                checkNowBtn.disabled = false;
                checkNowBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 14px; height: 14px;"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Check Now';
            };
        }
        
        // Pause/Resume button
        if (pauseMonitorBtn) {
            pauseMonitorBtn.onclick = async () => {
                try {
                    const newStatus = status === 'paused' ? 'active' : 'paused';
                    const result = await window.clipboard.setMonitorStatus(itemId, newStatus);
                    if (result.success) {
                        showNotification(newStatus === 'paused' ? 'Monitor paused' : 'Monitor resumed');
                        await showMetadataModal(itemId);
                    }
                } catch (e) {
                    showNotification('Error: ' + e.message, 'error');
                }
            };
        }
        
        // AI toggle button
        if (toggleAiDescBtn) {
            toggleAiDescBtn.onclick = async () => {
                try {
                    const newSetting = !aiEnabled;
                    const result = await window.clipboard.setMonitorAiEnabled(itemId, newSetting);
                    if (result.success) {
                        showNotification(newSetting ? 'AI descriptions enabled' : 'AI descriptions disabled');
                        await showMetadataModal(itemId);
                    }
                } catch (e) {
                    showNotification('Error: ' + e.message, 'error');
                }
            };
        }
        
        // Check frequency selector
        const checkFrequencySelect = document.getElementById('checkFrequencySelect');
        if (checkFrequencySelect) {
            // Set current value
            const currentInterval = item.settings?.checkInterval || metadata.settings?.checkInterval || 30;
            checkFrequencySelect.value = currentInterval.toString();
            
            // Handle change
            checkFrequencySelect.onchange = async () => {
                try {
                    const newInterval = parseInt(checkFrequencySelect.value, 10);
                    const result = await window.clipboard.setMonitorCheckInterval(itemId, newInterval);
                    if (result.success) {
                        const intervalText = newInterval < 60 
                            ? `${newInterval} minutes` 
                            : newInterval === 60 
                                ? '1 hour'
                                : `${newInterval / 60} hours`;
                        showNotification(`Check frequency set to ${intervalText}`);
                    }
                } catch (e) {
                    showNotification('Error: ' + e.message, 'error');
                }
            };
        }
    }
    // ========================================
    // END WEB MONITOR TAB HANDLING
    // ========================================
    
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

// AI Watch preset instructions
const AI_WATCH_PRESETS = {
    price: {
        watchFor: "Monitor for any price changes on products or services. Alert me if:\n- Prices increase or decrease\n- New sales or discounts appear\n- Products go on clearance\n- Shipping costs change",
        ignore: "Ignore minor formatting changes to price displays"
    },
    jobs: {
        watchFor: "Watch for job posting changes:\n- New job listings added\n- Positions removed or filled\n- Changes to job requirements or descriptions\n- Salary/compensation updates",
        ignore: "Ignore changes to application counts or posting dates"
    },
    status: {
        watchFor: "Monitor for status and availability changes:\n- Service outages or incidents\n- Maintenance announcements\n- Status changes (operational/degraded/down)\n- Recovery notifications",
        ignore: "Ignore timestamp updates if status hasn't changed"
    },
    news: {
        watchFor: "Track new content:\n- New blog posts or articles\n- Press releases\n- News updates\n- Featured content changes",
        ignore: "Ignore sidebar widgets, comment counts, or social share numbers"
    },
    stock: {
        watchFor: "Monitor inventory and availability:\n- Out of stock notifications\n- Back in stock alerts\n- Low stock warnings\n- Pre-order availability changes",
        ignore: "Ignore exact quantity numbers if item is still in stock"
    }
};

// Set AI watch preset
function setWatchPreset(presetName) {
    const preset = AI_WATCH_PRESETS[presetName];
    if (!preset) return;
    
    const watchPrompt = document.getElementById('aiWatchPrompt');
    const ignorePrompt = document.getElementById('aiIgnorePrompt');
    
    if (watchPrompt) watchPrompt.value = preset.watchFor;
    if (ignorePrompt) ignorePrompt.value = preset.ignore || '';
    
    // Show feedback
    const statusEl = document.getElementById('watchSaveStatus');
    if (statusEl) {
        statusEl.textContent = `${presetName.charAt(0).toUpperCase() + presetName.slice(1)} preset loaded`;
        statusEl.style.color = 'rgba(99, 102, 241, 0.8)';
        setTimeout(() => { statusEl.textContent = ''; }, 2000);
    }
}

// Save AI watch instructions
async function saveAIWatchInstructions() {
    const modal = document.getElementById('metadataModal');
    const itemId = modal?.dataset?.itemId;
    if (!itemId) return;
    
    const watchPrompt = document.getElementById('aiWatchPrompt')?.value || '';
    const ignorePrompt = document.getElementById('aiIgnorePrompt')?.value || '';
    const autoSummarize = document.getElementById('aiAutoSummarize')?.checked ?? true;
    const summaryStyle = document.getElementById('aiSummaryStyle')?.value || 'brief';
    
    const statusEl = document.getElementById('watchSaveStatus');
    if (statusEl) {
        statusEl.textContent = 'Saving...';
        statusEl.style.color = 'rgba(255, 255, 255, 0.5)';
    }
    
    try {
        // Get current item to preserve other settings
        const item = history.find(h => h.id === itemId);
        const currentSettings = item?.settings || {};
        
        // Update AI watch settings
        const updatedSettings = {
            ...currentSettings,
            aiWatch: {
                watchFor: watchPrompt,
                ignore: ignorePrompt,
                autoSummarize: autoSummarize,
                summaryStyle: summaryStyle
            }
        };
        
        // Save via IPC
        const result = await window.clipboard.updateMetadata(itemId, { settings: updatedSettings });
        
        if (result.success) {
            // Update local history
            if (item) {
                item.settings = updatedSettings;
            }
            
            if (statusEl) {
                statusEl.textContent = 'Saved!';
                statusEl.style.color = 'rgba(16, 185, 129, 0.8)';
                setTimeout(() => { statusEl.textContent = ''; }, 2000);
            }
        } else {
            throw new Error(result.error || 'Save failed');
        }
    } catch (error) {
        console.error('[AI Watch] Save error:', error);
        if (statusEl) {
            statusEl.textContent = 'Error saving';
            statusEl.style.color = 'rgba(239, 68, 68, 0.8)';
        }
    }
}

// Close screenshot lightbox
function closeScreenshotLightbox() {
    const lightbox = document.querySelector('.screenshot-lightbox');
    if (lightbox) {
        lightbox.remove();
    }
}

// Open screenshot in lightbox for full-size viewing
function openScreenshotLightbox(imgSrc) {
    // Remove any existing lightbox first
    closeScreenshotLightbox();
    
    // Create lightbox
    const lightbox = document.createElement('div');
    lightbox.className = 'screenshot-lightbox';
    lightbox.onclick = function(e) {
        // Close if clicking the background (not the image)
        if (e.target === lightbox) {
            closeScreenshotLightbox();
        }
    };
    
    lightbox.innerHTML = `
        <img src="${imgSrc}" alt="Screenshot">
        <button class="screenshot-lightbox-close" onclick="closeScreenshotLightbox()" title="Close (Escape)">×</button>
        <div class="screenshot-lightbox-hint">Click background, X button, or press Escape to close</div>
    `;
    
    // Close on Escape key
    const handleEscape = (e) => {
        if (e.key === 'Escape') {
            closeScreenshotLightbox();
            document.removeEventListener('keydown', handleEscape);
        }
    };
    document.addEventListener('keydown', handleEscape);
    
    document.body.appendChild(lightbox);
}

// Show details for a selected monitor change
function showMonitorChangeDetail(change, index, timeline) {
    const detailContainer = document.getElementById('monitorChangeDetail');
    if (!detailContainer) return;
    
    detailContainer.style.display = 'block';
    
    const isBaseline = change.type === 'baseline';
    
    // Screenshots
    const screenshotBefore = document.getElementById('screenshotBefore');
    const screenshotAfter = document.getElementById('screenshotAfter');
    
    // Get screenshot cards to update labels
    const beforeCard = screenshotBefore?.closest('.monitor-screenshot-card');
    const afterCard = screenshotAfter?.closest('.monitor-screenshot-card');
    
    // Get the screenshots container and apply single-screenshot class for baseline
    const screenshotsContainer = document.querySelector('.monitor-screenshots');
    
    if (isBaseline) {
        // For baseline, show single full-width screenshot
        if (screenshotsContainer) {
            screenshotsContainer.classList.add('single-screenshot');
        }
        if (beforeCard) {
            const label = beforeCard.querySelector('.screenshot-label');
            if (label) label.innerHTML = 'Baseline Capture <span class="expand-hint">Click to expand</span>';
        }
        if (afterCard) {
            afterCard.style.display = 'none';
        }
        
        if (screenshotBefore) {
            if (change.screenshotPath) {
                // Handle both file paths and data URLs
                const imgSrc = change.screenshotPath.startsWith('data:') 
                    ? change.screenshotPath 
                    : `file://${change.screenshotPath}`;
                screenshotBefore.innerHTML = `<img src="${imgSrc}" alt="Baseline screenshot" onclick="openScreenshotLightbox(this.src)">`;
            } else {
                screenshotBefore.innerHTML = '<div class="screenshot-placeholder">Baseline screenshot not available</div>';
            }
        }
    } else {
        // For changes, show before/after
        if (beforeCard) {
            const label = beforeCard.querySelector('.screenshot-label');
            if (label) label.textContent = 'Before';
        }
        if (afterCard) {
            afterCard.style.display = '';
        }
        
        // Show both before/after for changes
        if (screenshotsContainer) {
            screenshotsContainer.classList.remove('single-screenshot');
        }
        if (beforeCard) {
            const label = beforeCard.querySelector('.screenshot-label');
            if (label) label.innerHTML = 'Before <span class="expand-hint">Click to expand</span>';
        }
        if (afterCard) {
            afterCard.style.display = '';
            const label = afterCard.querySelector('.screenshot-label');
            if (label) label.innerHTML = 'After <span class="expand-hint">Click to expand</span>';
        }
        
        if (screenshotBefore) {
            const beforePath = change.screenshotBeforePath || change.beforeScreenshotPath;
            if (beforePath) {
                const imgSrc = beforePath.startsWith('data:') ? beforePath : `file://${beforePath}`;
                screenshotBefore.innerHTML = `<img src="${imgSrc}" alt="Before" onclick="openScreenshotLightbox(this.src)">`;
            } else {
                screenshotBefore.innerHTML = '<div class="screenshot-placeholder">No screenshot</div>';
            }
        }
        
        if (screenshotAfter) {
            const afterPath = change.screenshotAfterPath || change.afterScreenshotPath;
            if (afterPath) {
                const imgSrc = afterPath.startsWith('data:') ? afterPath : `file://${afterPath}`;
                screenshotAfter.innerHTML = `<img src="${imgSrc}" alt="After" onclick="openScreenshotLightbox(this.src)">`;
            } else {
                screenshotAfter.innerHTML = '<div class="screenshot-placeholder">No screenshot</div>';
            }
        }
    }
    
    // Text diff section
    const diffSection = document.querySelector('.monitor-diff-section');
    const diffContainer = document.getElementById('monitorDiff');
    const diffStats = document.getElementById('diffStats');
    
    if (isBaseline) {
        // For baseline, show summary info instead of diff
        if (diffSection) diffSection.style.display = 'block';
        if (diffContainer) {
            const textLength = change.textLength || 0;
            diffContainer.innerHTML = `
                <div class="baseline-info">
                    <div class="baseline-info-item">
                        <span class="baseline-label">Status:</span>
                        <span class="baseline-value">Initial baseline captured</span>
                    </div>
                    <div class="baseline-info-item">
                        <span class="baseline-label">Page content:</span>
                        <span class="baseline-value">${textLength > 0 ? `${textLength.toLocaleString()} characters` : 'Captured'}</span>
                    </div>
                    <div class="baseline-info-item">
                        <span class="baseline-label">Next check:</span>
                        <span class="baseline-value">Changes from this baseline will appear here</span>
                    </div>
                </div>
            `;
        }
        if (diffStats) diffStats.innerHTML = 'Baseline';
    } else if (diffContainer && change.diff) {
        if (diffSection) diffSection.style.display = 'block';
        const diff = change.diff;
        let addedCount = 0;
        let removedCount = 0;
        
        // Parse diff lines
        const diffLines = Array.isArray(diff) ? diff : (diff.lines || []);
        
        const diffHtml = diffLines.map(line => {
            if (typeof line === 'string') {
                if (line.startsWith('+')) {
                    addedCount++;
                    return `<div class="diff-line added">${escapeHtml(line)}</div>`;
                } else if (line.startsWith('-')) {
                    removedCount++;
                    return `<div class="diff-line removed">${escapeHtml(line)}</div>`;
                } else {
                    return `<div class="diff-line unchanged">${escapeHtml(line)}</div>`;
                }
            } else if (line.type) {
                if (line.type === 'added') {
                    addedCount++;
                    return `<div class="diff-line added">+ ${escapeHtml(line.text || line.content)}</div>`;
                } else if (line.type === 'removed') {
                    removedCount++;
                    return `<div class="diff-line removed">- ${escapeHtml(line.text || line.content)}</div>`;
                } else {
                    return `<div class="diff-line unchanged">${escapeHtml(line.text || line.content)}</div>`;
                }
            }
            return '';
        }).join('');
        
        diffContainer.innerHTML = diffHtml || '<div class="diff-placeholder">No text differences recorded</div>';
        
        if (diffStats) {
            diffStats.innerHTML = `<span class="added">+${addedCount}</span> / <span class="removed">-${removedCount}</span>`;
        }
    } else if (diffContainer) {
        if (diffSection) diffSection.style.display = 'block';
        diffContainer.innerHTML = '<div class="diff-placeholder">No text differences recorded</div>';
        if (diffStats) diffStats.innerHTML = '';
    }
    
    // AI Description
    const aiDescContainer = document.getElementById('monitorAiDescription');
    const aiDescContent = document.getElementById('aiDescContent');
    
    if (aiDescContainer && aiDescContent) {
        if (isBaseline) {
            // No AI description for baseline
            aiDescContainer.style.display = 'none';
        } else if (change.aiDescription || change.aiSummary) {
            aiDescContainer.style.display = 'block';
            aiDescContent.textContent = change.aiDescription || change.aiSummary;
        } else {
            aiDescContainer.style.display = 'none';
        }
    }
}

// Switch metadata modal tab
function switchMetadataTab(tabName) {
    console.log('[MetadataModal] Switching to tab:', tabName);
    
    // Update tab buttons
    document.querySelectorAll('.metadata-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabName);
    });
    
    // Update tab panels
    document.querySelectorAll('.metadata-tab-panel').forEach(panel => {
        panel.classList.remove('active');
    });
    
    const panelId = 'tab' + tabName.charAt(0).toUpperCase() + tabName.slice(1);
    const targetPanel = document.getElementById(panelId);
    console.log('[MetadataModal] Looking for panel:', panelId, 'Found:', !!targetPanel);
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
    const modal = document.getElementById('metadataModal');
    const itemId = modal.dataset.itemId;
    
    let schema;
    try {
        schema = JSON.parse(modal.dataset.schema || '{"fields":[]}');
    } catch (parseError) {
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
    }
    
    // Save to backend
    try {
        const result = await window.clipboard.updateMetadata(itemId, updates);
        
        if (result.success) {
            hideMetadataModal();
            await loadHistory();
            showNotification('Metadata saved');
        } else {
            alert('Failed to save metadata: ' + (result.error || 'Unknown error'));
        }
    } catch (saveError) {
        alert('Error saving metadata: ' + saveError.message);
    }
}

// Generate metadata with AI
async function generateMetadataWithAI() {
    console.log('[AI Generate] Button clicked - starting metadata generation');
    
    const modal = document.getElementById('metadataModal');
    const itemId = modal.dataset.itemId;
    console.log('[AI Generate] Item ID:', itemId);
    
    // Get AI prompt from textarea
    const customPrompt = document.getElementById('aiPrompt').value.trim();
    
    // Get API settings
    const settings = await window.api.getSettings();
    console.log('[AI Generate] Settings loaded:', {
        hasApiKey: !!settings.llmApiKey,
        claudePreferHeadless: settings.claudePreferHeadless,
        llmProvider: settings.llmProvider
    });
    
    // Check if we have ANY way to generate metadata:
    // 1. API key is set (OpenAI or Anthropic), OR
    // 2. Headless Claude is enabled (uses web login, no API key needed)
    const hasApiKey = !!settings.llmApiKey;
    const hasHeadlessClaude = settings.claudePreferHeadless !== false; // Default is true
    
    console.log('[AI Generate] Can proceed:', { hasApiKey, hasHeadlessClaude });
    
    if (!hasApiKey && !hasHeadlessClaude) {
        // Update status
        console.log('[AI Generate] No AI method available - showing error');
        const statusEl = document.getElementById('aiGenerationStatus');
        statusEl.textContent = 'Please configure your API key in Settings, or enable Headless Claude';
        statusEl.style.display = 'block';
        statusEl.style.color = '#ff6464';
        
        // Optionally open settings
        if (confirm('No AI method available. Open settings now?')) {
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
        console.log('[AI Generate] Calling generateMetadataAI for item:', itemId);
        const result = await window.clipboard.generateMetadataAI(
            itemId, 
            settings.llmApiKey,
            customPrompt
        );
        
        console.log('[AI Generate] Result received:', result);
        
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
        const space = spacesData.find(s => s.id === activeSpaceId);
        if (space) {
            // Use innerHTML for SVG icons, textContent for plain text icons
            if (space.icon && space.icon.includes('<svg')) {
                icon.innerHTML = space.icon;
            } else {
                icon.textContent = space.icon || '';
            }
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
    
    // Bulk action buttons
    document.getElementById('selectAllBtn').addEventListener('click', () => {
        selectAllItems();
    });
    
    document.getElementById('deselectAllBtn').addEventListener('click', () => {
        deselectAllItems();
    });
    
    document.getElementById('bulkMoveBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleBulkMoveDropdown();
    });
    
    document.getElementById('bulkDeleteBtn').addEventListener('click', async () => {
        await bulkDeleteItems();
    });
    
    // Close bulk move dropdown when clicking outside
    document.addEventListener('click', (e) => {
        const dropdown = document.getElementById('bulkMoveDropdown');
        const moveBtn = document.getElementById('bulkMoveBtn');
        if (dropdown && !dropdown.contains(e.target) && e.target !== moveBtn && !moveBtn.contains(e.target)) {
            dropdown.classList.remove('visible');
        }
    });
    
    // Search input
    document.getElementById('searchInput').addEventListener('input', (e) => {
        searchItems(e.target.value);
    });
    
    // Filter buttons
    const filterButtons = document.querySelectorAll('.filter-btn');
    
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
    
    // Initialize generative search
    initGenerativeSearch();
    
    // Space selection
    document.getElementById('spacesList').addEventListener('click', async (e) => {
        const spaceItem = e.target.closest('.space-item');
        if (!spaceItem) return;
        
        const action = e.target.closest('[data-action]');
        if (action) {
            e.stopPropagation();
            const spaceId = action.dataset.spaceId;
            
            if (action.dataset.action === 'edit') {
                const space = spacesData.find(s => s.id === spaceId);
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
                const space = spacesData.find(s => s.id === spaceId);
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
        updateSidebarTags(); // Refresh sidebar tags for this space
        filterItems();
    });
    
    // Add space button
    document.getElementById('addSpaceBtn').addEventListener('click', () => {
        showSpaceModal();
    });
    
    // AI Search score badge tooltip handler
    // Strategy: Look for badge as CHILD of the hovered history-item, not as ancestor
    let scoreTooltip = null;
    let tooltipTarget = null;
    
    document.getElementById('historyList').addEventListener('mouseover', (e) => {
        // Find the history item (parent container)
        const historyItem = e.target.closest('.history-item');
        if (!historyItem) return;
        
        // Look for a badge CHILD element inside this history item
        const badge = historyItem.querySelector('.gs-score-badge');
        
        
        if (badge && badge.dataset.tooltip && tooltipTarget !== historyItem) {
            // Remove existing tooltip
            if (scoreTooltip) scoreTooltip.remove();
            
            tooltipTarget = historyItem;
            
            // Create tooltip
            scoreTooltip = document.createElement('div');
            scoreTooltip.className = 'gs-score-tooltip';
            scoreTooltip.textContent = decodeURIComponent(badge.dataset.tooltip);
            document.body.appendChild(scoreTooltip);
            
            // Position near the badge
            const rect = badge.getBoundingClientRect();
            scoreTooltip.style.left = `${rect.left}px`;
            scoreTooltip.style.top = `${rect.bottom + 8}px`;
            
            
            // Adjust if off-screen
            const tooltipRect = scoreTooltip.getBoundingClientRect();
            if (tooltipRect.right > window.innerWidth) {
                scoreTooltip.style.left = `${window.innerWidth - tooltipRect.width - 10}px`;
            }
            if (tooltipRect.bottom > window.innerHeight) {
                scoreTooltip.style.top = `${rect.top - tooltipRect.height - 8}px`;
            }
        }
    });
    
    document.getElementById('historyList').addEventListener('mouseout', (e) => {
        const historyItem = e.target.closest('.history-item');
        // Only remove if we're leaving the history item entirely
        if (historyItem && historyItem === tooltipTarget && !historyItem.contains(e.relatedTarget)) {
            if (scoreTooltip) {
                scoreTooltip.remove();
                scoreTooltip = null;
            }
            tooltipTarget = null;
        }
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
        const item = e.target.closest('.history-item');
        if (!item) {
            return;
        }
        
        // Handle checkbox clicks
        const checkbox = e.target.closest('.item-checkbox');
        if (checkbox) {
            e.stopPropagation();
            const itemId = checkbox.dataset.itemId;
            toggleItemSelection(itemId);
            return;
        }

        const action = e.target.closest('[data-action]');
        
        if (action) {
            e.stopPropagation();
            const actionType = action.dataset.action;
            const itemId = item.dataset.id;
            
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
                try {
                    // Check if item is a style-guide or journey-map to open specialized editor
                    const item = history.find(h => h.id === itemId);
                    if (item && item.jsonSubtype) {
                        await openSpecializedEditor(item);
                    } else {
                        await showMetadataModal(itemId);
                    }
                } catch (err) {
                    console.error('Metadata modal error:', err);
                }
            } else if (actionType === 'menu') {
                showContextMenu(e, itemId);
            } else if (actionType === 'float') {
                // Float the item for dragging to external apps
                try {
                    const result = await window.electron.ipcRenderer.invoke('clipboard:float-item', itemId);
                    if (result && result.success) {
                        console.log('[Float] Created float card for:', itemId);
                    } else {
                        console.error('[Float] Failed to create float card:', result?.error);
                    }
                } catch (err) {
                    console.error('[Float] Error creating float card:', err);
                }
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
            
            // For all non-audio items, open preview/edit mode
            await showPreviewModal(itemId);
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
            // Check if item is a style-guide or journey-map to open specialized editor
            const item = history.find(h => h.id === contextMenuItem);
            if (item && item.jsonSubtype) {
                await openSpecializedEditor(item);
            } else {
                await showMetadataModal(contextMenuItem);
            }
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
        console.log('[Clipboard Viewer] Modal Save clicked');
        const name = document.getElementById('spaceName').value.trim();
        if (!name) {
            alert('Please enter a space name');
            return;
        }
        
        const icon = document.querySelector('.icon-option.selected').dataset.icon;
        const spaceId = document.getElementById('spaceModal').dataset.spaceId;
        console.log('[Clipboard Viewer] Saving space:', { name, icon, spaceId: spaceId || 'NEW' });
        
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
        
        let newSpaceId = null;
        if (spaceId) {
            // Update existing space
            console.log('[Clipboard Viewer] Updating existing space:', spaceId);
            await window.clipboard.updateSpace(spaceId, { name, icon, notebook });
        } else {
            // Create new space
            console.log('[Clipboard Viewer] Creating new space:', name);
            const result = await window.clipboard.createSpace({ name, icon, notebook });
            console.log('[Clipboard Viewer] Create space result:', result);
            newSpaceId = result?.space?.id;
            console.log('[Clipboard Viewer] New space ID:', newSpaceId);
        }
        
        hideSpaceModal();
        await loadSpaces();
        console.log('[Clipboard Viewer] Spaces reloaded, count:', spaces.length);
        
        // If we created a new space, select it
        if (newSpaceId) {
            console.log('[Clipboard Viewer] Selecting newly created space:', newSpaceId);
            changeSpace(newSpaceId);
        }
    });
    
    document.getElementById('modalCancel').addEventListener('click', () => {
        console.log('[Space Modal] Cancel clicked');
        hideSpaceModal();
    });
    
    // Click outside to close space modal
    document.getElementById('spaceModal').addEventListener('click', (e) => {
        if (e.target.id === 'spaceModal') {
            console.log('[Space Modal] Clicked outside, closing');
            hideSpaceModal();
        }
    });
    
    // Metadata modal buttons
    document.getElementById('metadataSave').addEventListener('click', saveMetadata);
    document.getElementById('metadataCancel').addEventListener('click', hideMetadataModal);
    document.getElementById('generateMetadataBtn').addEventListener('click', generateMetadataWithAI);
    
    // Listen for updates
    window.clipboard.onHistoryUpdate(async (updatedHistory) => {
        history = updatedHistory;
        updateTagDropdown(); // Refresh available tags
        updateSidebarTags(); // Refresh sidebar tags
        filterItems();
        await updateItemCounts();
    });
    
    // Listen for spaces updates - set up the listener directly
    window.electron.on('clipboard:spaces-updated', async (event, updatedSpaces) => {
        console.log('Spaces updated:', updatedSpaces);
        spacesData = updatedSpaces;
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
                const spaceName = spacesData.find(s => s.id === currentSpace)?.name || 'Current Space';
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
    
    // Initialize spaces toggle listener with proper callback
    window.clipboard.onSpacesToggled((enabled) => {
        spacesEnabled = enabled;
        // Refresh UI if needed when spaces are toggled
    });
    
    // Listen for active space changes from main process
    window.clipboard.onActiveSpaceChanged((data) => {
        activeSpaceId = data.spaceId;
        updateActiveSpaceIndicator();
        updateScreenshotIndicator(); // Update screenshot indicator too
    });
    
    // Initialize spaces update listener with proper callback
    window.clipboard.onSpacesUpdate((spaces) => {
        // Update local spaces list when it changes
        if (spaces) {
            spacesData = spaces;
            renderSpaces();
        }
    });
    
    // Listen for screenshot capture toggle events
    window.electron.on('clipboard:screenshot-capture-toggled', (event, enabled) => {
        screenshotCaptureEnabled = enabled;
        updateScreenshotIndicator();
    });
    
    // Drag and drop file upload
    const mainContent = document.querySelector('.main-content');
    const historyList = document.getElementById('historyList');
    
    // Prevent default drag behaviors
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        mainContent.addEventListener(eventName, preventDefaults, false);
        document.body.addEventListener(eventName, preventDefaults, false);
    });
    
    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }
    
    // Highlight drop area when dragging
    ['dragenter', 'dragover'].forEach(eventName => {
        mainContent.addEventListener(eventName, () => {
            mainContent.style.background = 'rgba(100, 200, 255, 0.1)';
            mainContent.style.border = '2px dashed rgba(100, 200, 255, 0.5)';
        }, false);
    });
    
    ['dragleave', 'drop'].forEach(eventName => {
        mainContent.addEventListener(eventName, () => {
            mainContent.style.background = '';
            mainContent.style.border = '';
        }, false);
    });
    
    // Handle dropped files
    mainContent.addEventListener('drop', async (e) => {
        const dt = e.dataTransfer;
        const files = [...dt.files];
        
        if (files.length === 0) return;
        
        // Get current space
        const spaceId = currentSpace;
        const spaceName = spaceId ? spaces.find(s => s.id === spaceId)?.name || 'Unknown' : 'All Items';
        
        console.log(`Dropping ${files.length} file(s) into space:`, spaceName);
        
        // Show processing message
        showNotification(`⏳ Uploading ${files.length} file(s)...`);
        
        // Process each file
        let successCount = 0;
        for (const file of files) {
            try {
                // Read file as data URL
                const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = (e) => resolve(e.target.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });
                
                // Determine file type
                let fileType = 'file';
                if (file.type.startsWith('image/')) {
                    fileType = 'image-file';
                } else if (file.type === 'application/pdf') {
                    fileType = 'pdf';
                }
                
                console.log('Adding file:', file.name, 'to space:', spaceId, 'type:', fileType);
                console.log('File size:', file.size, 'bytes');
                console.log('Data URL length:', dataUrl.length);
                
                try {
                    // Use the image handler for all files - it saves content properly
                    const result = await window.electron.ipcRenderer.invoke('black-hole:add-image', {
                        fileName: file.name,
                        dataUrl: dataUrl,
                        fileSize: file.size,
                        spaceId: spaceId
                    });
                    
                    console.log('✓ File added result:', result);
                    
                    if (result && result.success) {
                        successCount++;
                        console.log('✓ Success count:', successCount);
                    } else {
                        const errorMsg = `File result invalid: ${JSON.stringify(result)}`;
                        console.error('❌', errorMsg);
                        alert(errorMsg);
                    }
                } catch (error) {
                    const errorMsg = `Error adding file: ${error.message || error}`;
                    console.error('❌', errorMsg, error);
                    alert(errorMsg);
                }
            } catch (error) {
                console.error('Error uploading file:', file.name, error);
            }
        }
        
        // Wait a moment for files to be written to disk
        console.log('Waiting for files to be saved...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Reload history to show new files
        console.log('Reloading history after file upload...');
        await loadHistory();
        console.log('History loaded, item count:', history.length);
        renderHistory();
        console.log('History rendered');
        
        // Show success message
        if (successCount > 0) {
            if (files.length === 1) {
                showNotification(`✓ Added ${files[0].name} to ${spaceName}`);
            } else {
                showNotification(`✓ Added ${successCount} file(s) to ${spaceName}`);
            }
        } else {
            showNotification(`❌ Failed to add files`);
        }
    }, false);
    
    // Helper function to show notifications
    function showNotification(message) {
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 60px;
            right: 20px;
            background: rgba(100, 200, 255, 0.95);
            color: white;
            padding: 12px 20px;
            border-radius: 8px;
            font-size: 14px;
            z-index: 10000;
            animation: slideIn 0.3s ease-out;
        `;
        notification.textContent = message;
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.style.animation = 'slideOut 0.3s ease-out';
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }
    
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
                    ${spacesData.map(space => `
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
        type: historyItem.type,
        isVideo 
    });
    
    if (isVideo) {
        showVideoPreviewModal(itemId);
        return;
    }
    
    // Use metadata modal for web-monitor items (shows Monitor tab with diffs)
    if (historyItem.type === 'web-monitor') {
        console.log('[Preview] Redirecting web-monitor item to metadata modal');
        showMetadataModal(itemId);
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
        // For image files, content may be a file path - prefer thumbnail (data URL) for display
        let imgSrc;
        if (historyItem.type === 'file' && historyItem.fileType === 'image-file') {
            // For image files, prefer thumbnail which should be a data URL
            imgSrc = historyItem.thumbnail || historyItem.content;
        } else {
            // For regular images (pasted), content is the data URL
            imgSrc = historyItem.content || historyItem.thumbnail || fullContent;
        }
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
                <div style="font-size: 40px;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 40px; height: 40px;">${isAudio ? '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>' : '<rect x="2" y="5" width="20" height="14" rx="2"/><polygon points="10 8 16 12 10 16"/>'}</svg></div>
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
    } else if (isPlaybookNote(historyItem)) {
        // Playbook notes - MUST come before Markdown check since Playbook content is often Markdown
        // Show Playbook note preview - render as Markdown with metadata header
        const viewMode = document.getElementById('previewViewMode');
        
        // Strip [PLAYBOOK:uuid] marker from content if present
        let playbookContent = fullContent.replace(/\[PLAYBOOK:[a-f0-9-]+\]\s*/gi, '').trim();
        
        // Get Playbook metadata for header
        const playbookTitle = historyItem.metadata?._title || historyItem.metadata?.title || 'Playbook Note';
        const playbookKeywords = historyItem.metadata?._keywords || historyItem.metadata?.keywords || [];
        
        // Check if content looks like Markdown
        const isMarkdown = isMarkdownContent(playbookContent, historyItem);
        
        if (isMarkdown && typeof marked !== 'undefined') {
            // Render as Markdown
            const iframe = document.getElementById('previewHtmlFrame');
            const renderedHtml = marked.parse(playbookContent);
            
            // Build header with Playbook info
            const keywordsHtml = playbookKeywords.length > 0 
                ? `<div class="playbook-keywords">${playbookKeywords.map(k => `<span class="keyword-tag">${escapeHtml(k)}</span>`).join(' ')}</div>` 
                : '';
            
            const playbookHtml = `
                <!DOCTYPE html>
                <html>
                <head>
                    <style>
                        body {
                            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                            line-height: 1.6;
                            padding: 20px;
                            background: #1e1e1e;
                            color: rgba(255, 255, 255, 0.9);
                            max-width: 800px;
                            margin: 0 auto;
                        }
                        .playbook-header {
                            border-bottom: 1px solid rgba(100, 200, 255, 0.3);
                            padding-bottom: 12px;
                            margin-bottom: 20px;
                        }
                        .playbook-title {
                            font-size: 18px;
                            font-weight: 600;
                            color: rgba(100, 200, 255, 0.9);
                            margin: 0 0 8px 0;
                            display: flex;
                            align-items: center;
                            gap: 8px;
                        }
                        .playbook-icon {
                            width: 18px;
                            height: 18px;
                        }
                        .playbook-keywords {
                            display: flex;
                            flex-wrap: wrap;
                            gap: 6px;
                            margin-top: 8px;
                        }
                        .keyword-tag {
                            background: rgba(100, 200, 255, 0.15);
                            color: rgba(100, 200, 255, 0.9);
                            padding: 2px 8px;
                            border-radius: 10px;
                            font-size: 11px;
                        }
                        h1, h2, h3, h4, h5, h6 { color: rgba(255, 255, 255, 0.95); margin-top: 1.5em; }
                        p { margin: 1em 0; }
                        ul, ol { padding-left: 2em; }
                        code { background: rgba(255, 255, 255, 0.1); padding: 2px 6px; border-radius: 3px; font-family: 'Monaco', monospace; }
                        pre { background: rgba(255, 255, 255, 0.05); padding: 12px; border-radius: 6px; overflow-x: auto; }
                        pre code { background: none; padding: 0; }
                        blockquote { border-left: 3px solid rgba(100, 200, 255, 0.5); margin-left: 0; padding-left: 1em; color: rgba(255, 255, 255, 0.7); }
                        a { color: #6eb5ff; }
                        table { border-collapse: collapse; width: 100%; margin: 1em 0; }
                        th, td { border: 1px solid rgba(255, 255, 255, 0.2); padding: 8px; text-align: left; }
                        th { background: rgba(255, 255, 255, 0.1); }
                    </style>
                </head>
                <body>
                    <div class="playbook-header">
                        <div class="playbook-title">
                            <svg class="playbook-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 7h16M4 12h16M4 17h10"/></svg>
                            ${escapeHtml(playbookTitle)}
                        </div>
                        ${keywordsHtml}
                    </div>
                    ${renderedHtml}
                </body>
                </html>
            `;
            iframe.srcdoc = playbookHtml;
            document.getElementById('previewHtmlMode').style.display = 'block';
            viewMode.style.display = 'none';
        } else {
            // Plain text Playbook - show with nice formatting
            viewMode.innerHTML = `
                <div style="padding: 20px;">
                    <div style="border-bottom: 1px solid rgba(100, 200, 255, 0.3); padding-bottom: 12px; margin-bottom: 20px;">
                        <div style="font-size: 16px; font-weight: 600; color: rgba(100, 200, 255, 0.9); display: flex; align-items: center; gap: 8px;">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 16px; height: 16px;"><path d="M4 7h16M4 12h16M4 17h10"/></svg>
                            ${escapeHtml(playbookTitle)}
                        </div>
                        ${playbookKeywords.length > 0 ? `
                            <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px;">
                                ${playbookKeywords.map(k => `<span style="background: rgba(100, 200, 255, 0.15); color: rgba(100, 200, 255, 0.9); padding: 2px 8px; border-radius: 10px; font-size: 11px;">${escapeHtml(k)}</span>`).join('')}
                            </div>
                        ` : ''}
                    </div>
                    <pre style="white-space: pre-wrap; font-family: -apple-system, BlinkMacSystemFont, sans-serif; line-height: 1.6; margin: 0;">${escapeHtml(playbookContent)}</pre>
                </div>
            `;
            viewMode.style.display = 'block';
            viewMode.style.whiteSpace = 'normal';
            viewMode.style.fontFamily = 'inherit';
            viewMode.style.overflow = 'auto';
            viewMode.style.flex = '1';
        }
        
        // Show edit button and TTS for Playbook
        document.getElementById('previewModeBtn').style.display = 'inline-block';
        document.getElementById('textToSpeechSection').style.display = 'block';
    } else if (isMarkdownContent(fullContent, historyItem) || historyItem.jsonSubtype === 'chatbot-conversation' || historyItem.metadata?.jsonSubtype === 'chatbot-conversation') {
        // Show Markdown preview (always for chatbot conversations)
        const markdownContainer = document.getElementById('markdownRendered');
        markdownContainer.innerHTML = renderMarkdown(fullContent);
        
        // Add special styling for chatbot conversations
        if (historyItem.jsonSubtype === 'chatbot-conversation' || historyItem.metadata?.jsonSubtype === 'chatbot-conversation') {
            markdownContainer.classList.add('chatbot-conversation');
        } else {
            markdownContainer.classList.remove('chatbot-conversation');
        }
        
        document.getElementById('previewMarkdownMode').style.display = 'block';
        document.getElementById('previewModeBtn').style.display = 'inline-block';
        // Show TTS for markdown
        document.getElementById('textToSpeechSection').style.display = 'block';
    } else if (historyItem.type === 'file' && historyItem.fileCategory === 'document') {
        // Show document file preview - handle DOCX specially
        const isDocx = historyItem.fileExt === '.docx';
        
        if (isDocx && window.clipboard.convertDocxToHtml) {
            // Show loading state
            const viewMode = document.getElementById('previewViewMode');
            viewMode.innerHTML = `
                <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 200px; gap: 16px;">
                    <div style="font-size: 14px; color: rgba(255, 255, 255, 0.6);">Loading document...</div>
                </div>
            `;
            viewMode.style.display = 'flex';
            
            // Convert DOCX to HTML
            try {
                const result = await window.clipboard.convertDocxToHtml(fullContent);
                if (result.success && result.html) {
                    // Show in HTML preview mode (editable)
                    const iframe = document.getElementById('previewHtmlFrame');
                    // Add editable styling to the iframe content
                    const editableHtml = `
                        <!DOCTYPE html>
                        <html>
                        <head>
                            <style>
                                body {
                                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                                    line-height: 1.6;
                                    padding: 20px;
                                    background: #1e1e1e;
                                    color: rgba(255, 255, 255, 0.9);
                                    max-width: 800px;
                                    margin: 0 auto;
                                }
                                h1, h2, h3, h4, h5, h6 { color: rgba(255, 255, 255, 0.95); margin-top: 1.5em; }
                                p { margin: 1em 0; }
                                ul, ol { padding-left: 2em; }
                                table { border-collapse: collapse; width: 100%; margin: 1em 0; }
                                th, td { border: 1px solid rgba(255, 255, 255, 0.2); padding: 8px; text-align: left; }
                                th { background: rgba(255, 255, 255, 0.1); }
                                a { color: #6eb5ff; }
                                img { max-width: 100%; height: auto; }
                                blockquote { border-left: 3px solid rgba(255, 255, 255, 0.3); margin-left: 0; padding-left: 1em; color: rgba(255, 255, 255, 0.7); }
                            </style>
                        </head>
                        <body contenteditable="true">
                            ${result.html}
                        </body>
                        </html>
                    `;
                    iframe.srcdoc = editableHtml;
                    document.getElementById('previewHtmlMode').style.display = 'block';
                    document.getElementById('previewModeBtn').style.display = 'inline-block';
                    viewMode.style.display = 'none';
                    
                    // Store original for change detection
                    originalContent = result.html;
                } else {
                    // Fallback to file info display
                    showDocumentFallback(viewMode, historyItem, fullContent);
                }
            } catch (error) {
                console.error('Error converting DOCX:', error);
                showDocumentFallback(viewMode, historyItem, fullContent);
            }
        } else {
            // Non-DOCX documents - show file info with open button
            const viewMode = document.getElementById('previewViewMode');
            showDocumentFallback(viewMode, historyItem, fullContent);
        }
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
    
    // For Playbook notes, update the Edit button to show "Edit in Playbook" and hide the separate button
    const editInPlaybookBtn = document.getElementById('editInPlaybookBtn');
    const previewModeBtn = document.getElementById('previewModeBtn');
    const isPlaybook = isPlaybookNote(historyItem);
    
    console.log('[Preview] Playbook check result:', { isPlaybook, itemId: historyItem.id, metadata: historyItem.metadata, tags: historyItem.tags });
    
    if (editInPlaybookBtn) {
        // Hide the separate "Edit in Playbook" button since main Edit button now handles it
        editInPlaybookBtn.style.display = 'none';
    }
    
    if (previewModeBtn && isPlaybook) {
        // Change Edit button to show "Edit in Playbook" for Playbook notes
        previewModeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle;"><path d="M4 7h16M4 12h16M4 17h10"/></svg> Edit in Playbook`;
        previewModeBtn.style.background = 'rgba(100, 200, 255, 0.15)';
        previewModeBtn.style.borderColor = 'rgba(100, 200, 255, 0.3)';
    } else if (previewModeBtn) {
        // Reset to default Edit button
        previewModeBtn.innerHTML = `<span id="previewModeIcon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle;"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></span> Edit`;
        previewModeBtn.style.background = '';
        previewModeBtn.style.borderColor = '';
    }
    
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
    document.getElementById('ttsButtonIcon').innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 14px; height: 14px;"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
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
        btnIcon.textContent = '';
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
                
                // Use file:// protocol for local files (cross-platform)
                mediaPlayer.src = pathToFileUrl(result.filePath);
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
            
            showTranscriptionStatus('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle; margin-right: 6px;"><path d="M4 7h16M4 12h16M4 17h10"/></svg> Transcription attached to this item', 'success');
            
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
    
    // Preserve <sub> tags by temporarily replacing them
    const subTags = [];
    html = html.replace(/<sub>(.*?)<\/sub>/g, (match, content) => {
        subTags.push(content);
        return `__SUB_TAG_${subTags.length - 1}__`;
    });
    
    // Escape HTML first
    html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    
    // Restore <sub> tags
    html = html.replace(/__SUB_TAG_(\d+)__/g, (match, index) => {
        return `<sub>${subTags[index]}</sub>`;
    });
    
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
    
    // For Playbook notes, open in Playbook tool instead of in-app editor
    if (isPlaybookNote(currentPreviewItem)) {
        openInPlaybook();
        return;
    }
    
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
    
    // Guard against null elements
    if (!btn) return;
    
    if (isEditMode) {
        if (icon) icon.textContent = '◉';
        btn.innerHTML = '<span id="previewModeIcon">◉</span> View';
    } else {
        if (icon) icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 14px; height: 14px;"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
        btn.innerHTML = '<span id="previewModeIcon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 14px; height: 14px;"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></span> Edit';
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
        if (item.fileType === 'presentation' || item.fileCategory === 'presentation') return 'Presentation';
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
        showImageEditStatus('Loading full-resolution image...', 'info');
        
        // Get current image data - prefer full resolution for image files
        const imageEl = document.getElementById('previewImage');
        let imageData = currentImageData || imageEl.src;
        
        // For image files, try to load the full-resolution original
        if (currentPreviewItem.type === 'file' && currentPreviewItem.fileType === 'image-file' && currentPreviewItem.id) {
            try {
                // Request full image from main process
                const fullImage = await window.clipboard.getItemContent(currentPreviewItem.id);
                if (fullImage && fullImage.startsWith('data:image')) {
                    imageData = fullImage;
                    console.log('[AI Edit] Using full-resolution image');
                }
            } catch (e) {
                console.log('[AI Edit] Could not load full image, using thumbnail:', e);
            }
        }
        
        showImageEditStatus('Sending image to AI for editing...', 'info');
        
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
    const icon = needsOpenAIKey ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 14px; height: 14px;"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 14px; height: 14px;"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
    
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
        ? `<strong><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle; margin-right: 4px;"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Add OpenAI API Key:</strong> To edit images with AI, add your OpenAI API key in <strong>Settings → AI Image Editing</strong>. 
           Get your key at <a href="#" onclick="window.electronAPI?.openExternal?.('https://platform.openai.com/api-keys')" style="color: #8b5cf6;">platform.openai.com</a>`
        : `<strong><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle; margin-right: 4px;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> Note:</strong> Image editing requires an OpenAI API key. Add it in Settings to enable this feature.`;
    
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
    
    // Edit in Playbook button
    document.getElementById('editInPlaybookBtn').addEventListener('click', openInPlaybook);
    
    // Copy button
    document.getElementById('previewCopyBtn').addEventListener('click', copyPreviewContent);
    
    // Close buttons (both the X in header and the Close button at bottom)
    document.getElementById('previewClose').addEventListener('click', hidePreviewModal);
    document.getElementById('previewCloseX').addEventListener('click', hidePreviewModal);
    
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
            videoPath = pathToFileUrl(videoPath);
        }
        videoPlayer.src = videoPath;
        
        // Set poster image (thumbnail) to avoid black frame
        if (metadata.localThumbnail) {
            let thumbnailPath = metadata.localThumbnail;
            if (!thumbnailPath.startsWith('file://')) {
                thumbnailPath = pathToFileUrl(thumbnailPath);
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
            identifySpeakersBtn.innerHTML = 'Identify Speakers';
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
        audioBtn.innerHTML = '<span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle; margin-right: 6px;"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></span> Extract Audio';
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
                status.textContent = `Speakers identified successfully! (Model: ${result.model})`;
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
        btn.innerHTML = '<span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle; margin-right: 6px;"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></span> Identify Speakers';
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
                    btn.innerHTML = 'Audio Ready!';
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
            btn.innerHTML = 'Copied!';
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
                btn.innerHTML = '<span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle; margin-right: 6px;"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></span> Retry';
                btn.disabled = false;
            }
        } catch (err) {
            descriptionEl.textContent = 'Error: ' + err.message;
            btn.innerHTML = 'Retry';
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
    
    if (!historyList) {
        console.error('[Drag] historyList not found!');
        return;
    }
    
    console.log('[Drag] Setting up drag handlers on historyList');
    
    // Debug: capture phase listener to see ALL drag events
    document.addEventListener('dragstart', (e) => {
        console.log('[Drag DEBUG] Document dragstart - target:', e.target.tagName, e.target.className);
    }, true);
    
    // Use event delegation for dynamically created history items
    // IMPORTANT: Keep this synchronous - async breaks drag in some browsers
    historyList.addEventListener('dragstart', (e) => {
        console.log('[Drag] dragstart event fired! target:', e.target.tagName, e.target.className);
        
        const historyItem = e.target.closest('.history-item');
        if (!historyItem) {
            console.log('[Drag] dragstart fired but no .history-item found in ancestors');
            console.log('[Drag] Target element:', e.target.outerHTML?.substring(0, 200));
            return;
        }
        
        const itemId = historyItem.dataset.id;
        if (!itemId) {
            console.log('[Drag] history-item found but no data-id');
            return;
        }
        
        console.log('[Drag] Started dragging item:', itemId);
        
        // Set drag data for internal app use - MUST be synchronous
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', itemId);
        
        // Visual feedback
        historyItem.style.opacity = '0.5';
        
        // Store the item being dragged
        historyItem.classList.add('dragging');
        
        // Trigger native drag for external apps/web pages (fire and forget)
        // This allows the item to be dropped onto web upload fields, Finder, etc.
        window.electron?.ipcRenderer?.invoke('clipboard:start-native-drag', itemId)
            .then(result => {
                if (result && result.success) {
                    console.log('[Drag] Native drag initiated for:', result.filePath);
                }
            })
            .catch(err => {
                // Native drag may not be available for all item types
                console.log('[Drag] Native drag not available:', err.message);
            });
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
// ============================================
// BULK SELECTION & ACTIONS
// ============================================

/**
 * Toggle selection of an item
 */
function toggleItemSelection(itemId) {
    if (selectedItems.has(itemId)) {
        selectedItems.delete(itemId);
    } else {
        selectedItems.add(itemId);
    }
    
    updateBulkActionToolbar();
    updateItemCheckbox(itemId);
}

/**
 * Select all visible items
 */
function selectAllItems() {
    const visibleItems = document.querySelectorAll('.history-item:not(.downloading)');
    visibleItems.forEach(item => {
        const itemId = item.dataset.id;
        if (itemId) {
            selectedItems.add(itemId);
        }
    });
    
    updateBulkActionToolbar();
    updateAllCheckboxes();
}

/**
 * Deselect all items
 */
function deselectAllItems() {
    selectedItems.clear();
    updateBulkActionToolbar();
    updateAllCheckboxes();
}

/**
 * Update the bulk action toolbar visibility and count
 */
function updateBulkActionToolbar() {
    const toolbar = document.getElementById('bulkActionsToolbar');
    const selectedCount = document.getElementById('selectedCount');
    
    if (selectedItems.size > 0) {
        toolbar.classList.add('visible');
        selectedCount.textContent = selectedItems.size;
    } else {
        toolbar.classList.remove('visible');
    }
}

/**
 * Update a single item's checkbox state
 */
function updateItemCheckbox(itemId) {
    const checkbox = document.querySelector(`.item-checkbox[data-item-id="${itemId}"]`);
    if (!checkbox) return;
    
    const item = checkbox.closest('.history-item');
    if (selectedItems.has(itemId)) {
        checkbox.classList.add('checked');
        item.classList.add('selected');
    } else {
        checkbox.classList.remove('checked');
        item.classList.remove('selected');
    }
}

/**
 * Update all checkboxes to match selection state
 */
function updateAllCheckboxes() {
    document.querySelectorAll('.item-checkbox').forEach(checkbox => {
        const itemId = checkbox.dataset.itemId;
        if (!itemId) return;
        
        const item = checkbox.closest('.history-item');
        if (selectedItems.has(itemId)) {
            checkbox.classList.add('checked');
            item.classList.add('selected');
        } else {
            checkbox.classList.remove('checked');
            item.classList.remove('selected');
        }
    });
}

/**
 * Delete multiple selected items
 */
async function bulkDeleteItems() {
    if (selectedItems.size === 0) return;
    
    const count = selectedItems.size;
    const confirmMsg = `Are you sure you want to delete ${count} item${count > 1 ? 's' : ''}? This cannot be undone.`;
    
    if (!confirm(confirmMsg)) {
        return;
    }
    
    try {
        // Show loading state with count
        const deleteBtn = document.getElementById('bulkDeleteBtn');
        const originalText = deleteBtn.innerHTML;
        deleteBtn.innerHTML = `<span>Deleting ${count} item${count > 1 ? 's' : ''}...</span>`;
        deleteBtn.disabled = true;
        
        // Convert Set to Array for API call
        const itemIds = Array.from(selectedItems);
        
        // Call the bulk delete API
        const result = await window.clipboard.deleteItems(itemIds);
        
        if (result.success) {
            console.log(`[Bulk Delete] Successfully deleted ${result.deleted} items`);
            
            if (result.failed > 0) {
                alert(`Deleted ${result.deleted} items. Failed to delete ${result.failed} items.\n\nErrors:\n${result.errors.join('\n')}`);
            }
            
            // Clear selection
            selectedItems.clear();
            updateBulkActionToolbar();
            
            // Reload history to reflect changes
            await loadHistory();
        } else {
            console.error('[Bulk Delete] Failed:', result.error);
            alert(`Failed to delete items: ${result.error}`);
        }
        
        // Restore button
        deleteBtn.innerHTML = originalText;
        deleteBtn.disabled = false;
        
    } catch (error) {
        console.error('[Bulk Delete] Error:', error);
        alert(`Error deleting items: ${error.message}`);
        
        // Restore button
        const deleteBtn = document.getElementById('bulkDeleteBtn');
        deleteBtn.innerHTML = '<span>×</span><span>Delete Selected</span>';
        deleteBtn.disabled = false;
    }
}

/**
 * Toggle the bulk move dropdown
 */
function toggleBulkMoveDropdown() {
    const dropdown = document.getElementById('bulkMoveDropdown');
    const isVisible = dropdown.classList.contains('visible');
    
    if (isVisible) {
        dropdown.classList.remove('visible');
    } else {
        // Populate the dropdown with spaces
        populateBulkMoveSpaces();
        dropdown.classList.add('visible');
    }
}

/**
 * Populate the bulk move dropdown with available spaces
 */
function populateBulkMoveSpaces() {
    const spacesList = document.getElementById('bulkMoveSpacesList');
    
    // Filter out the current space
    const availableSpaces = spacesData.filter(space => {
        // If viewing "All Items" (currentSpace is null), all spaces are available
        if (currentSpace === null) return true;
        // Otherwise, exclude the current space
        return space.id !== currentSpace;
    });
    
    // Add "All Items" option if not currently viewing it
    let html = '';
    if (currentSpace !== null) {
        html += `
            <div class="bulk-move-space-option" data-space-id="null">
                <div class="bulk-move-space-icon">∞</div>
                <div class="bulk-move-space-name">All Items</div>
            </div>
        `;
    }
    
    // Add all other spaces
    availableSpaces.forEach(space => {
        const itemCount = history.filter(item => item.spaceId === space.id).length;
        html += `
            <div class="bulk-move-space-option" data-space-id="${space.id}">
                <div class="bulk-move-space-icon">${space.icon && space.icon.includes('<svg') ? space.icon : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 16px; height: 16px;"><circle cx="12" cy="12" r="8"/></svg>'}</div>
                <div class="bulk-move-space-name">${escapeHtml(space.name)}</div>
                <div class="bulk-move-space-count">${itemCount}</div>
            </div>
        `;
    });
    
    if (html === '') {
        html = '<div style="padding: 12px; text-align: center; color: rgba(255, 255, 255, 0.4); font-size: 12px;">No other spaces available</div>';
    }
    
    spacesList.innerHTML = html;
    
    // Add click handlers
    document.querySelectorAll('.bulk-move-space-option').forEach(option => {
        option.addEventListener('click', async () => {
            const targetSpaceId = option.dataset.spaceId;
            await bulkMoveItems(targetSpaceId);
        });
    });
}

/**
 * Move selected items to a different space
 */
async function bulkMoveItems(targetSpaceId) {
    if (selectedItems.size === 0) return;
    
    // Close the dropdown
    document.getElementById('bulkMoveDropdown').classList.remove('visible');
    
    const count = selectedItems.size;
    
    try {
        // Show loading state on move button with count
        const moveBtn = document.getElementById('bulkMoveBtn');
        const originalText = moveBtn.innerHTML;
        moveBtn.innerHTML = `<span>Moving ${count} item${count > 1 ? 's' : ''}...</span>`;
        moveBtn.disabled = true;
        
        // Convert Set to Array for API call
        const itemIds = Array.from(selectedItems);
        
        // Get target space name for confirmation
        let targetSpaceName = 'All Items';
        if (targetSpaceId && targetSpaceId !== 'null') {
            const targetSpace = spacesData.find(s => s.id === targetSpaceId);
            targetSpaceName = targetSpace ? targetSpace.name : 'Unknown Space';
        }
        
        // Call the bulk move API
        const result = await window.clipboard.moveItems(itemIds, targetSpaceId === 'null' ? null : targetSpaceId);
        
        if (result.success) {
            console.log(`[Bulk Move] Successfully moved ${result.moved} items to ${targetSpaceName}`);
            
            if (result.failed > 0) {
                alert(`Moved ${result.moved} items to "${targetSpaceName}". Failed to move ${result.failed} items.\n\nErrors:\n${result.errors.join('\n')}`);
            }
            
            // Clear selection
            selectedItems.clear();
            updateBulkActionToolbar();
            
            // Reload history to reflect changes
            await loadHistory();
            
            // Update spaces list to refresh counts
            await loadSpaces();
        } else {
            console.error('[Bulk Move] Failed:', result.error);
            alert(`Failed to move items: ${result.error}`);
        }
        
        // Restore button
        moveBtn.innerHTML = originalText;
        moveBtn.disabled = false;
        
    } catch (error) {
        console.error('[Bulk Move] Error:', error);
        alert(`Error moving items: ${error.message}`);
        
        // Restore button
        const moveBtn = document.getElementById('bulkMoveBtn');
        moveBtn.innerHTML = '<span>→</span><span>Move to Space</span>';
        moveBtn.disabled = false;
    }
}

// ============================================
// INITIALIZATION
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    init();
    setupVideoModalListeners();
    setupHistoryItemDrag();
}); 