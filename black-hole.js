/**
 * Black Hole Widget - Robust & Reliable
 * Handles paste, drag-drop, and space selection for clipboard items
 */

class BlackHoleWidget {
    constructor() {
        console.log('[BlackHole] Constructing...');
        
        // Get elements
        this.dropZone = document.getElementById('dropZone');
        this.statusText = document.getElementById('statusText');
        this.successRipple = document.getElementById('successRipple');
        this.modal = document.getElementById('spaceModal');
        this.spaceGrid = document.getElementById('spaceGrid');
        this.confirmBtn = document.getElementById('confirmBtn');
        this.cancelBtn = document.getElementById('cancelBtn');
        this.modalCloseBtn = document.getElementById('modalCloseBtn');
        this.contentPreview = document.getElementById('contentPreview');
        this.contentPreviewType = document.getElementById('contentPreviewType');
        this.contentPreviewText = document.getElementById('contentPreviewText');
        this.savingIndicator = document.getElementById('savingIndicator');
        this.modalActions = document.getElementById('modalActions');
        
        // State
        this.spaces = [];
        this.selectedSpaceId = null;
        this.pendingItem = null;
        this.isReady = false;
        this.startExpanded = false;
        this.isClosing = false;
        
        // Initialize
        this.init();
    }
    
    // IPC helper - uses window.api.send which is exposed by preload.js
    sendIPC(channel, data) {
        try {
            if (window.api && window.api.send) {
                window.api.send(channel, data);
                return true;
            } else {
                console.error('[BlackHole] IPC ERROR: window.api.send not available');
                return false;
            }
        } catch (e) {
            console.error('[BlackHole] IPC send error:', e);
            return false;
        }
    }
    
    
    async init() {
        console.log('[BlackHole] Initializing...');
        
        // Check URL params
        try {
            const urlParams = new URLSearchParams(window.location.search);
            this.startExpanded = urlParams.get('startExpanded') === 'true';
            console.log('[BlackHole] startExpanded:', this.startExpanded);
        } catch (e) {
            console.error('[BlackHole] URL params error:', e);
        }
        
        // Load spaces
        await this.loadSpaces();
        
        // Setup handlers
        this.setupEventHandlers();
        this.setupIPCHandlers();
        
        // Mark ready and request clipboard data
        setTimeout(async () => {
            this.isReady = true;
            console.log('[BlackHole] Ready, startExpanded:', this.startExpanded);
            
            // Notify main process
            this.sendIPC('black-hole:widget-ready');
            
            // If we should start expanded but don't have pending item, request clipboard data
            if (this.startExpanded && !this.pendingItem) {
                console.log('[BlackHole] Requesting clipboard data...');
                this.sendIPC('black-hole:debug', { event: 'REQUESTING_CLIPBOARD_DATA' });
                
                try {
                    if (window.api && window.api.invoke) {
                        const clipboardData = await window.api.invoke('black-hole:get-pending-data');
                        console.log('[BlackHole] Got clipboard data:', !!clipboardData);
                        this.sendIPC('black-hole:debug', { 
                            event: 'GOT_CLIPBOARD_DATA', 
                            hasText: clipboardData?.hasText,
                            textPreview: clipboardData?.text?.substring(0, 50)
                        });
                        
                        if (clipboardData && (clipboardData.hasText || clipboardData.hasImage || clipboardData.hasHtml)) {
                            await this.processClipboardData(clipboardData);
                            console.log('[BlackHole] pendingItem after processing:', this.pendingItem ? this.pendingItem.type : 'null');
                        }
                    }
                } catch (e) {
                    console.error('[BlackHole] Error getting clipboard:', e);
                    this.sendIPC('black-hole:debug', { event: 'CLIPBOARD_ERROR', error: e.message });
                }
            }
            
            // Handle initial state
            if (this.startExpanded) {
                console.log('[BlackHole] Opening modal on start');
                this.showModal();
                } else {
                console.log('[BlackHole] Resizing to bubble');
                this.sendIPC('black-hole:resize-window', { width: 150, height: 150 });
            }
        }, 400);
    }
    
    async loadSpaces() {
        console.log('[BlackHole] Loading spaces...');
        try {
            if (window.clipboard && window.clipboard.getSpaces) {
                this.spaces = await window.clipboard.getSpaces();
                console.log('[BlackHole] Loaded', this.spaces.length, 'spaces');
            } else {
                console.warn('[BlackHole] window.clipboard.getSpaces not available');
                this.spaces = [];
            }
        } catch (e) {
            console.error('[BlackHole] Failed to load spaces:', e);
            this.spaces = [];
        }
    }
    
    setupEventHandlers() {
        console.log('[BlackHole] Setting up event handlers...');
        
        // Debug: check which elements were found
        const foundElements = {
            confirmBtn: !!this.confirmBtn,
            cancelBtn: !!this.cancelBtn,
            modalCloseBtn: !!this.modalCloseBtn,
            modal: !!this.modal,
            spaceGrid: !!this.spaceGrid
        };
        console.log('[BlackHole] Found elements:', JSON.stringify(foundElements));
        
        // Send to main process for terminal visibility
        this.sendIPC('black-hole:debug', { event: 'SETUP_HANDLERS', elements: foundElements });
        
        // Modal buttons
        if (this.confirmBtn) {
            console.log('[BlackHole] Attaching click handler to confirmBtn');
            this.confirmBtn.addEventListener('click', () => {
                console.log('[BlackHole] Confirm clicked!');
                this.sendIPC('black-hole:debug', { event: 'CONFIRM_BTN_CLICKED' });
                this.handleConfirm();
            });
        } else {
            console.error('[BlackHole] ERROR: confirmBtn not found!');
            this.sendIPC('black-hole:debug', { event: 'ERROR_CONFIRM_BTN_NOT_FOUND' });
        }
        
        if (this.cancelBtn) {
            this.cancelBtn.addEventListener('click', () => {
                console.log('[BlackHole] Cancel clicked');
                this.closeModal();
            });
        }
        
        if (this.modalCloseBtn) {
            this.modalCloseBtn.addEventListener('click', () => {
                console.log('[BlackHole] Close clicked');
                this.closeModal();
            });
        }
        
        // Click outside modal
        if (this.modal) {
            this.modal.addEventListener('click', (e) => {
                if (e.target === this.modal) {
                    console.log('[BlackHole] Click outside modal');
                    this.closeModal();
                }
            });
        }
        
        // Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.modal && this.modal.classList.contains('show')) {
                console.log('[BlackHole] Escape pressed');
                this.closeModal();
            }
        });
        
        // Drop zone
        if (this.dropZone) {
        this.dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            this.dropZone.classList.add('dragging-over');
        });
        
        this.dropZone.addEventListener('dragleave', (e) => {
            if (!this.dropZone.contains(e.relatedTarget)) {
                this.dropZone.classList.remove('dragging-over');
            }
        });
        
            this.dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            this.dropZone.classList.remove('dragging-over');
                this.handleDrop(e);
            });
        }
        
        // Paste
        document.addEventListener('paste', (e) => {
            console.log('[BlackHole] Paste event');
            this.handlePaste(e);
        });
        
        console.log('[BlackHole] Event handlers ready');
    }
    
    setupIPCHandlers() {
        console.log('[BlackHole] Setting up IPC handlers...');
        
        // Use window.api.receive for IPC events from main process
        if (window.api && window.api.receive) {
            console.log('[BlackHole] Setting up IPC handlers via window.api.receive');
            this.sendIPC('black-hole:debug', { event: 'SETUP_IPC_HANDLERS' });
            
            // Clipboard data from paste trigger
            window.api.receive('paste-clipboard-data', async (data) => {
                console.log('[BlackHole] Received paste-clipboard-data');
                this.sendIPC('black-hole:debug', { event: 'RECEIVED_PASTE_DATA', hasData: !!data });
                
                // Send confirmation back to main process
            this.sendIPC('black-hole:active');
            
                if (data) {
                    console.log('[BlackHole] Data: hasText=' + data.hasText);
                    await this.processClipboardData(data);
                } else {
                    console.log('[BlackHole] WARNING: No data received!');
                }
                
                // Show modal if we have content
                if (this.pendingItem) {
                    console.log('[BlackHole] pendingItem set, showing modal');
                    this.showModal();
                    } else {
                    console.log('[BlackHole] WARNING: pendingItem is null after processing');
                }
            });
            
            // Init event
            window.api.receive('black-hole:init', async (data) => {
                console.log('[BlackHole] Received init:', data);
                this.sendIPC('black-hole:debug', { event: 'RECEIVED_INIT', startExpanded: data?.startExpanded, hasClipboardData: !!data?.clipboardData });
                
                if (data) {
                    this.startExpanded = data.startExpanded;
                    
                    if (data.clipboardData) {
                        await this.processClipboardData(data.clipboardData);
                    }
                    
                    if (this.startExpanded && this.pendingItem) {
                        this.showModal();
                    }
                }
            });
            
            // Position response
            window.api.receive('black-hole:position-response', (pos) => {
                this.originalPosition = pos;
            });
            
            console.log('[BlackHole] IPC handlers registered successfully');
        } else {
            console.error('[BlackHole] ERROR: window.api.receive not available!');
        }
    }
    
    async processClipboardData(data) {
        console.log('[BlackHole] Processing clipboard data...');
        
        if (!data) {
            console.warn('[BlackHole] No data to process');
            this.pendingItem = null;
            return;
        }
        
        // Image
        if (data.hasImage && data.imageDataUrl) {
            console.log('[BlackHole] Processing as image');
        this.pendingItem = {
                type: 'image',
                data: { content: data.imageDataUrl },
                preview: 'Image from clipboard',
                previewType: 'Image'
            };
            return;
        }
        
        // HTML
        if (data.hasHtml && data.html) {
            console.log('[BlackHole] Processing as HTML');
        this.pendingItem = {
                type: 'html',
                data: { html: data.html, plainText: data.text || '' },
                preview: (data.text || 'HTML content').substring(0, 100),
                previewType: 'Rich Text'
            };
            return;
        }
        
        // Text
        if (data.hasText && data.text) {
            const text = data.text.trim();
            console.log('[BlackHole] Processing as text, length:', text.length);
            
            // Check for YouTube URL
            const isYouTube = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)/i.test(text);
            
            this.pendingItem = {
                type: 'text',
                data: { content: text },
                preview: text.substring(0, 100),
                previewType: isYouTube ? 'YouTube Video' : 'Text',
                isYouTube: isYouTube,
                youtubeUrl: isYouTube ? text : null
            };
            return;
        }
        
        // Plain text fallback
        if (data.text) {
            const text = data.text.trim();
            const isYouTube = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)/i.test(text);
            
            this.pendingItem = {
                type: 'text',
                data: { content: text },
                preview: text.substring(0, 100),
                previewType: isYouTube ? 'YouTube Video' : 'Text',
                isYouTube: isYouTube,
                youtubeUrl: isYouTube ? text : null
            };
                        return;
        }
        
        console.log('[BlackHole] No valid content found');
            this.pendingItem = null;
    }
    
    handlePaste(e) {
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        
        // Check for image
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                const blob = item.getAsFile();
                if (blob) {
                    const reader = new FileReader();
                    reader.onload = (evt) => {
                        this.pendingItem = {
                            type: 'image',
                            data: { content: evt.target.result },
                            preview: 'Image from clipboard',
                            previewType: 'Image'
                        };
                        this.showModal();
                    };
                    reader.readAsDataURL(blob);
                    return;
                }
            }
        }
        
        // Check for text
        const text = e.clipboardData.getData('text/plain');
        if (text) {
            const isYouTube = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)/i.test(text);
            this.pendingItem = {
                type: 'text',
                data: { content: text.trim() },
                preview: text.substring(0, 100),
                previewType: isYouTube ? 'YouTube Video' : 'Text',
                isYouTube: isYouTube,
                youtubeUrl: isYouTube ? text.trim() : null
            };
            this.showModal();
        }
    }
    
    handleDrop(e) {
        console.log('[BlackHole] Handling drop');
        
        const files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length > 0) {
            const file = files[0];
            console.log('[BlackHole] Dropped file:', file.name);
            
            const reader = new FileReader();
            reader.onload = (evt) => {
                this.pendingItem = {
                    type: 'file',
                    data: {
                        fileName: file.name,
                        fileSize: file.size,
                        fileType: file.type,
                        fileData: evt.target.result
                    },
                    preview: file.name,
                    previewType: 'File'
                };
                this.showModal();
            };
            reader.readAsDataURL(file);
            return;
        }
        
        // Text drop
        const text = e.dataTransfer && e.dataTransfer.getData('text/plain');
                if (text) {
            const isYouTube = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)/i.test(text);
            this.pendingItem = {
                type: 'text',
                data: { content: text.trim() },
                preview: text.substring(0, 100),
                previewType: isYouTube ? 'YouTube Video' : 'Text',
                isYouTube: isYouTube,
                youtubeUrl: isYouTube ? text.trim() : null
            };
            this.showModal();
        }
    }
    
    showModal() {
        console.log('[BlackHole] showModal called');
        
        // Don't show if we're in the process of closing
        if (this.isClosing) {
            console.log('[BlackHole] Ignoring showModal - widget is closing');
            return;
        }
        
        if (!this.modal) {
            console.error('[BlackHole] Modal element not found!');
            return;
        }
        
            if (this.spaces.length === 0) {
            console.warn('[BlackHole] No spaces available, reloading...');
                this.loadSpaces().then(() => {
                if (this.spaces.length > 0) {
                    this.showModal();
                } else {
                    this.showStatus('No spaces available', true);
                }
            });
            return;
        }
        
        console.log('[BlackHole] Showing modal with', this.spaces.length, 'spaces');
        
        // Expand window
        this.sendIPC('black-hole:resize-window', { width: 500, height: 650 });
        this.sendIPC('black-hole:active');
        
        // Render spaces
        this.renderSpaces();
        
        // Update preview
        this.updateContentPreview();
        
        // Reset state
        this.selectedSpaceId = this.spaces[0] ? this.spaces[0].id : null;
        if (this.confirmBtn) this.confirmBtn.disabled = !this.selectedSpaceId;
        if (this.savingIndicator) this.savingIndicator.classList.remove('active');
        if (this.modalActions) this.modalActions.style.display = 'flex';
        
        // Show modal
        document.body.classList.add('modal-open');
        this.modal.classList.add('show');
        
        // Select first space
        if (this.selectedSpaceId) {
            this.selectSpace(this.selectedSpaceId);
        }
        
        console.log('[BlackHole] Modal shown');
    }
    
    renderSpaces() {
        if (!this.spaceGrid) {
            console.error('[BlackHole] spaceGrid element not found');
            return;
        }
        
        console.log('[BlackHole] Rendering', this.spaces.length, 'spaces');
        
        this.spaceGrid.innerHTML = this.spaces.map(space => `
            <div class="space-item" data-space-id="${space.id}">
                <span class="space-icon">${space.icon || '📁'}</span>
                <span class="space-name">${this.escapeHtml(space.name)}</span>
                <span class="space-count">${space.count || 0} items</span>
            </div>
        `).join('');
        
        // Add click handlers
        const items = this.spaceGrid.querySelectorAll('.space-item');
        items.forEach(item => {
            item.addEventListener('click', () => {
                const spaceId = item.getAttribute('data-space-id');
                console.log('[BlackHole] Space clicked:', spaceId);
                this.selectSpace(spaceId);
            });
        });
    }
    
    selectSpace(spaceId) {
        console.log('[BlackHole] Selecting space:', spaceId);
        this.selectedSpaceId = spaceId;
        
        if (this.spaceGrid) {
            const items = this.spaceGrid.querySelectorAll('.space-item');
            items.forEach(item => {
                const isSelected = item.getAttribute('data-space-id') === spaceId;
                item.classList.toggle('selected', isSelected);
            });
        }
        
        if (this.confirmBtn) {
            this.confirmBtn.disabled = !spaceId;
        }
    }
    
    updateContentPreview() {
        if (!this.pendingItem) {
            if (this.contentPreview) this.contentPreview.style.display = 'none';
            return;
        }
        
        if (this.contentPreview) this.contentPreview.style.display = 'block';
        if (this.contentPreviewType) this.contentPreviewType.textContent = this.pendingItem.previewType || '📝 Content';
        if (this.contentPreviewText) {
            const preview = this.pendingItem.preview || 'Content to save';
            this.contentPreviewText.textContent = preview.length > 100 ? preview.substring(0, 100) + '...' : preview;
        }
    }
    
    async handleConfirm() {
        console.log('[BlackHole] ========== HANDLE CONFIRM START ==========');
        
        // Send debug info to main process so it shows in terminal
        this.sendIPC('black-hole:debug', {
            event: 'CONFIRM_CLICKED',
            selectedSpaceId: this.selectedSpaceId,
            hasPendingItem: !!this.pendingItem,
            pendingItemType: this.pendingItem ? this.pendingItem.type : null,
            hasClipboardAPI: !!window.clipboard,
            hasYoutubeAPI: !!window.youtube
        });
        
        console.log('[BlackHole] selectedSpaceId:', this.selectedSpaceId);
        console.log('[BlackHole] pendingItem:', this.pendingItem ? this.pendingItem.type : 'NULL');
        console.log('[BlackHole] window.clipboard available:', !!window.clipboard);
        
        if (!this.selectedSpaceId) {
            console.error('[BlackHole] ERROR: No space selected');
            this.sendIPC('black-hole:debug', { event: 'ERROR_NO_SPACE' });
            this.showStatus('Please select a space', true);
                return;
        }
        
        if (!this.pendingItem) {
            console.error('[BlackHole] ERROR: No pending item');
            this.sendIPC('black-hole:debug', { event: 'ERROR_NO_PENDING_ITEM' });
            this.showStatus('No content to save', true);
            return;
        }
        
        console.log('[BlackHole] Saving to space:', this.selectedSpaceId, 'type:', this.pendingItem.type);
        
        // Show saving state
        if (this.confirmBtn) this.confirmBtn.disabled = true;
        if (this.savingIndicator) this.savingIndicator.classList.add('active');
        
        const item = this.pendingItem;
        item.data.spaceId = this.selectedSpaceId;
        console.log('[BlackHole] Item data prepared:', JSON.stringify(item.data, null, 2).substring(0, 500));
        
        try {
            // YouTube URL
            if (item.isYouTube && item.youtubeUrl) {
                console.log('[BlackHole] >>> YOUTUBE PATH <<<');
                console.log('[BlackHole] YouTube URL:', item.youtubeUrl);
                console.log('[BlackHole] window.youtube:', window.youtube);
                console.log('[BlackHole] startBackgroundDownload:', window.youtube ? window.youtube.startBackgroundDownload : 'N/A');
                
                if (window.youtube && window.youtube.startBackgroundDownload) {
                    console.log('[BlackHole] Calling startBackgroundDownload...');
                    const result = await window.youtube.startBackgroundDownload(item.youtubeUrl, this.selectedSpaceId);
                    console.log('[BlackHole] startBackgroundDownload result:', JSON.stringify(result));
                    
                    if (result && result.success) {
                        console.log('[BlackHole] YouTube download started successfully');
                        this.showStatus('Download started');
                        this.animateAndClose(true);
                        return;
                    } else {
                        console.error('[BlackHole] YouTube download failed:', result);
                        this.showStatus(result && result.error ? result.error : 'Download failed', true);
                    }
            } else {
                    console.warn('[BlackHole] YouTube API not available, will save as text instead');
                }
            }
            
            // Regular save
            console.log('[BlackHole] >>> REGULAR SAVE PATH <<<');
            console.log('[BlackHole] Item type:', item.type);
            
            let result = null;
            
            if (!window.clipboard) {
                console.error('[BlackHole] ERROR: window.clipboard is not available!');
                throw new Error('Clipboard API not available');
            }
            
            console.log('[BlackHole] window.clipboard methods:', Object.keys(window.clipboard));
            
        switch (item.type) {
            case 'text':
                    console.log('[BlackHole] Calling window.clipboard.addText...');
                    console.log('[BlackHole] addText data:', JSON.stringify(item.data).substring(0, 200));
                result = await window.clipboard.addText(item.data);
                    console.log('[BlackHole] addText returned:', JSON.stringify(result));
                    
                    // Check if backend detected YouTube
                    if (result && result.success && result.isYouTube && window.youtube && window.youtube.startBackgroundDownload) {
                        console.log('[BlackHole] Backend detected YouTube URL, starting download');
                        await window.youtube.startBackgroundDownload(result.youtubeUrl, this.selectedSpaceId);
                        this.showStatus('Download started');
                        this.animateAndClose(true);
                        return;
                    }
                break;
                    
            case 'html':
                    console.log('[BlackHole] Calling window.clipboard.addHtml...');
                result = await window.clipboard.addHtml(item.data);
                    console.log('[BlackHole] addHtml returned:', JSON.stringify(result));
                break;
                    
            case 'image':
                    console.log('[BlackHole] Calling window.clipboard.addImage...');
                result = await window.clipboard.addImage(item.data);
                    console.log('[BlackHole] addImage returned:', JSON.stringify(result));
                break;
                    
            case 'file':
                    console.log('[BlackHole] Calling window.clipboard.addFile...');
                result = await window.clipboard.addFile(item.data);
                    console.log('[BlackHole] addFile returned:', JSON.stringify(result));
                break;
                    
                default:
                    console.error('[BlackHole] Unknown item type:', item.type);
                    throw new Error('Unknown item type: ' + item.type);
            }
            
            console.log('[BlackHole] Final result:', JSON.stringify(result));
            
            if (result && result.success) {
                console.log('[BlackHole] SUCCESS! Closing modal...');
                const space = this.spaces.find(s => s.id === this.selectedSpaceId);
                const spaceName = space ? `${space.icon} ${space.name}` : 'Space';
                this.showStatus(`Saved to ${spaceName}`);
                this.showSuccessEffect();
                this.animateAndClose(true);
        } else {
                console.error('[BlackHole] FAILED! Result:', result);
                this.showStatus(result && result.error ? result.error : 'Save failed', true);
                this.resetSavingState();
            }
            
        } catch (err) {
            console.error('[BlackHole] EXCEPTION during save:', err);
            console.error('[BlackHole] Error stack:', err.stack);
            this.showStatus(err.message, true);
            this.resetSavingState();
        }
        
        console.log('[BlackHole] ========== HANDLE CONFIRM END ==========');
    }
    
    resetSavingState() {
        if (this.confirmBtn) this.confirmBtn.disabled = false;
        if (this.savingIndicator) this.savingIndicator.classList.remove('active');
        if (this.modalActions) this.modalActions.style.display = 'flex';
    }
    
    animateAndClose(success) {
        console.log('[BlackHole] Animating and closing, success:', success);
        
        // Prevent modal from being shown again
        this.isClosing = true;
        
        // Add shrink animation
        if (this.modal) {
            this.modal.classList.add('shrinking');
        }
        
        // After animation
        setTimeout(() => {
            // Hide modal
            if (this.modal) {
                this.modal.classList.remove('show', 'shrinking');
            }
            document.body.classList.remove('modal-open');
            
            // Resize to bubble
            this.sendIPC('black-hole:resize-window', { width: 150, height: 150 });
            
            // Show success on bubble
            if (success) {
                this.showSuccessEffect();
            }
            
            // Close window after brief display of success
            setTimeout(() => {
                this.sendIPC('black-hole:inactive', { closeWindow: true });
            }, 1200);
            
            // Clear pending item
            this.pendingItem = null;
            
        }, 400);
    }
    
    closeModal() {
        console.log('[BlackHole] closeModal called');
        
        // Prevent modal from being shown again
        this.isClosing = true;
        
        if (this.modal) {
            this.modal.classList.remove('show', 'shrinking');
        }
        document.body.classList.remove('modal-open');
        this.pendingItem = null;
        
        // Close the window
        setTimeout(() => {
            this.sendIPC('black-hole:inactive', { closeWindow: true });
        }, 300);
    }
    
    showStatus(message, isError = false) {
        console.log('[BlackHole] Status:', message, isError ? '(error)' : '');
        
        if (!this.statusText) return;
        
        this.statusText.textContent = message;
        this.statusText.classList.toggle('error', isError);
        this.statusText.classList.add('visible');
                
                setTimeout(() => {
            if (this.statusText) {
                this.statusText.classList.remove('visible');
                    }
                }, 3000);
    }
    
    showSuccessEffect() {
        if (this.successRipple) {
            this.successRipple.classList.add('active');
            setTimeout(() => {
                if (this.successRipple) {
                this.successRipple.classList.remove('active');
                }
            }, 600);
        }
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize when DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        console.log('[BlackHole] DOM ready, creating widget');
        window.blackHoleWidget = new BlackHoleWidget();
    });
} else {
    console.log('[BlackHole] DOM already ready, creating widget');
    window.blackHoleWidget = new BlackHoleWidget();
}
