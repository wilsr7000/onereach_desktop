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
        
        // Wait for clipboard API with retries (up to 10 seconds)
        let attempts = 0;
        while (!window.clipboard && attempts < 20) {
            console.log('Clipboard API not ready, waiting... attempt', attempts + 1);
            await new Promise(resolve => setTimeout(resolve, 500));
            attempts++;
        }
        
        // If clipboard API is still not available, show a helpful error
        if (!window.clipboard) {
            throw new Error('The clipboard manager is not initialized. Please restart the app and try again.');
        }
        
        console.log('✓ Clipboard API is available');
        
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
    
    // Add user-created spaces
    spaces.forEach(space => {
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
                if (item.fileType === 'video') {
                    contentHtml = `
                        <div class="media-preview">
                            <video controls preload="metadata">
                                <source src="file://${item.filePath}">
                            </video>
                        </div>
                        <div class="file-info">
                            <div class="file-icon">▶</div>
                            <div class="file-details">
                                <div class="file-name">${escapeHtml(item.fileName)}</div>
                                <div class="file-meta">
                                    <span>${formatFileSize(item.fileSize)}</span>
                                    <span>${item.fileExt ? item.fileExt.toUpperCase() : ''}</span>
                                </div>
                            </div>
                        </div>
                    `;
                } else if (item.fileType === 'audio') {
                    // For audio files, we need to handle them differently due to Electron security
                    contentHtml = `
                        <div class="file-info">
                            <div class="file-icon">♫</div>
                            <div class="file-details">
                                <div class="file-name">${escapeHtml(item.fileName)}</div>
                                <div class="file-meta">
                                    <span>${formatFileSize(item.fileSize)}</span>
                                    <span>${item.fileExt ? item.fileExt.toUpperCase() : ''}</span>
                                    <span class="audio-status">Click copy to clipboard to play</span>
                                </div>
                            </div>
                        </div>
                        <div class="media-preview" style="display: none;">
                            <audio controls preload="metadata" id="audio-${item.id}">
                                Your browser does not support the audio element.
                            </audio>
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
                    contentHtml = `<div class="item-content">${escapeHtml(item.preview || item.plainText || item.text)}</div>`;
                }
            } else if (item.source === 'code') {
                contentHtml = `<div class="item-content code">${escapeHtml(item.preview)}</div>`;
            } else {
                contentHtml = `<div class="item-content">${escapeHtml(item.preview)}</div>`;
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
                <div class="history-item ${item.pinned ? 'pinned' : ''}" data-id="${item.id}">
                    <div class="item-header">
                        <div class="item-type">
                            <span class="type-icon ${typeClass}">${icon}</span>
                            <span class="item-time">${timeAgo}</span>
                            ${item.metadata?.context?.app?.name ? `<span class="item-source" title="${escapeHtml(item.metadata.context.contextDisplay || '')}">from ${escapeHtml(item.metadata.context.app.name)}</span>` : ''}
                        </div>
                    </div>
                    ${contentHtml}
                    <div class="item-actions">
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
        }).join('');
        
        itemCount.textContent = `${items.length} item${items.length !== 1 ? 's' : ''}`;
    } catch (error) {
        console.error('Error rendering history:', error);
        console.error('Error stack:', error.stack);
        historyList.innerHTML = `
            <div class="empty-state">
                <img src="${getAssetPath('or-logo.png')}" class="empty-logo" alt="OneReach Logo">
                <div class="empty-icon">⚠️</div>
                <div class="empty-text">Error rendering items</div>
                <div class="empty-hint">${error.message}</div>
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

// Filter items
function filterItems() {
    let items = currentSpace === null ? history : history.filter(item => item.spaceId === currentSpace);
    
    if (currentFilter !== 'all') {
        items = items.filter(item => {
            if (currentFilter === 'pinned') return item.pinned;
            if (currentFilter === 'text') return item.type === 'text' && item.source !== 'code' && item.source !== 'url' && item.source !== 'data' && item.source !== 'spreadsheet';
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
            if (currentFilter === 'text') return item.type === 'text' && item.source !== 'code' && item.source !== 'url';
            if (currentFilter === 'screenshot') return item.isScreenshot === true;
            return false;
        });
    }
    
    renderHistory(filtered);
}

// Show context menu
function showContextMenu(e, itemId) {
    e.preventDefault();
    e.stopPropagation();
    
    const contextMenu = document.getElementById('contextMenu');
    contextMenuItem = itemId;
    
    // Position the menu
    contextMenu.style.display = 'block';
    contextMenu.style.left = `${e.pageX}px`;
    contextMenu.style.top = `${e.pageY}px`;
    
    // Adjust position if menu goes off screen
    const rect = contextMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        contextMenu.style.left = `${e.pageX - rect.width}px`;
    }
    if (rect.bottom > window.innerHeight) {
        contextMenu.style.top = `${e.pageY - rect.height}px`;
    }
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

// Show metadata modal
async function showMetadataModal(itemId) {
    const modal = document.getElementById('metadataModal');
    
    // Get current metadata
    const result = await window.clipboard.getMetadata(itemId);
    if (!result.success) {
        alert('Could not load metadata');
        return;
    }
    
    const metadata = result.metadata;
    
    // Populate form fields
    document.getElementById('metaDescription').value = metadata.description || '';
    document.getElementById('metaNotes').value = metadata.notes || '';
    document.getElementById('metaInstructions').value = metadata.instructions || '';
    document.getElementById('metaTags').value = (metadata.tags || []).join(', ');
    document.getElementById('metaSource').value = metadata.source || '';
    
    // AI fields
    document.getElementById('metaAiGenerated').checked = metadata.ai_generated || false;
    document.getElementById('metaAiAssisted').checked = metadata.ai_assisted || false;
    document.getElementById('metaAiModel').value = metadata.ai_model || '';
    document.getElementById('metaAiProvider').value = metadata.ai_provider || '';
    document.getElementById('metaAiPrompt').value = metadata.ai_prompt || '';
    document.getElementById('metaAiContext').value = metadata.ai_context || '';
    
    // Read-only fields
    document.getElementById('metaDateCreated').textContent = metadata.dateCreated ? new Date(metadata.dateCreated).toLocaleString() : 'Unknown';
    document.getElementById('metaAuthor').textContent = metadata.author || 'Unknown';
    document.getElementById('metaVersion').textContent = metadata.version || '1.0.0';
    document.getElementById('metaId').textContent = metadata.id || itemId;
    
    // Set context if available
    const contextEl = document.getElementById('metaContext');
    if (metadata.context && metadata.context.contextDisplay) {
      contextEl.textContent = metadata.context.contextDisplay;
    } else if (result.metadata && result.metadata.context && result.metadata.context.contextDisplay) {
      // Check if context is in the result's metadata (for items without saved metadata)
      contextEl.textContent = result.metadata.context.contextDisplay;
    } else if (metadata.source) {
      contextEl.textContent = `Source: ${metadata.source}`;
    } else {
      // Try to get the source from the item itself
      const historyItem = history.find(h => h.id === itemId);
      if (historyItem && historyItem.source) {
        contextEl.textContent = `Source: ${historyItem.source}`;
      } else {
        contextEl.textContent = 'Unknown';
      }
    }
    
    // Store item ID for saving
    modal.dataset.itemId = itemId;
    
    // Show modal
    modal.style.display = 'flex';
    document.getElementById('metaDescription').focus();
}

// Hide metadata modal
function hideMetadataModal() {
    document.getElementById('metadataModal').style.display = 'none';
}

// Save metadata
async function saveMetadata() {
    const modal = document.getElementById('metadataModal');
    const itemId = modal.dataset.itemId;
    
    // Collect form data
    const updates = {
        description: document.getElementById('metaDescription').value,
        notes: document.getElementById('metaNotes').value,
        instructions: document.getElementById('metaInstructions').value,
        tags: document.getElementById('metaTags').value.split(',').map(t => t.trim()).filter(t => t),
        source: document.getElementById('metaSource').value,
        ai_generated: document.getElementById('metaAiGenerated').checked,
        ai_assisted: document.getElementById('metaAiAssisted').checked,
        ai_model: document.getElementById('metaAiModel').value,
        ai_provider: document.getElementById('metaAiProvider').value,
        ai_prompt: document.getElementById('metaAiPrompt').value,
        ai_context: document.getElementById('metaAiContext').value
    };
    
    // Save to backend
    const result = await window.clipboard.updateMetadata(itemId, updates);
    
    if (result.success) {
        hideMetadataModal();
        // Optionally reload to show updated tags
        await loadHistory();
    } else {
        alert('Failed to save metadata: ' + (result.error || 'Unknown error'));
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
            // Update form fields with generated metadata
            const metadata = result.metadata;
            
            document.getElementById('metaDescription').value = metadata.description || '';
            document.getElementById('metaNotes').value = metadata.notes || '';
            document.getElementById('metaInstructions').value = metadata.instructions || '';
            document.getElementById('metaTags').value = (metadata.tags || []).join(', ');
            document.getElementById('metaSource').value = metadata.source || '';
            
            // Update AI fields
            document.getElementById('metaAiGenerated').checked = metadata.ai_generated || false;
            document.getElementById('metaAiAssisted').checked = true; // Mark as AI assisted
            document.getElementById('metaAiModel').value = metadata.ai_model || '';
            document.getElementById('metaAiProvider').value = metadata.ai_provider || '';
            document.getElementById('metaAiPrompt').value = customPrompt || 'AI-generated metadata';
            document.getElementById('metaAiContext').value = metadata.ai_context || 'Generated using Claude AI';
            
            // Update status
            statusEl.textContent = '✓ Metadata generated successfully! Review and save.';
            statusEl.style.color = '#64ff64';
            
            // Flash the fields that were updated
            const fieldsToFlash = [
                'metaDescription', 'metaNotes', 'metaInstructions', 
                'metaTags', 'metaSource'
            ];
            
            fieldsToFlash.forEach(fieldId => {
                const field = document.getElementById(fieldId);
                if (field) {
                    field.style.transition = 'background-color 0.3s';
                    field.style.backgroundColor = 'rgba(59, 130, 246, 0.2)';
                    setTimeout(() => {
                        field.style.backgroundColor = '';
                    }, 1000);
                }
            });
            
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
        filterItems();
    });
    
    // Add space button
    document.getElementById('addSpaceBtn').addEventListener('click', () => {
        showSpaceModal();
    });
    
    // History item actions
    document.getElementById('historyList').addEventListener('click', async (e) => {
        const item = e.target.closest('.history-item');
        if (!item) return;
        
        const action = e.target.closest('[data-action]');
        if (action) {
            e.stopPropagation();
            const actionType = action.dataset.action;
            const itemId = item.dataset.id;
            
            if (actionType === 'pin') {
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
                await showMetadataModal(itemId);
            } else if (actionType === 'menu') {
                showContextMenu(e, itemId);
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
    document.addEventListener('keydown', (e) => {
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

// Initialize when DOM is ready
// Add a small delay to ensure preload script is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    // Wait a moment for preload to be ready
    setTimeout(init, 100);
}); 