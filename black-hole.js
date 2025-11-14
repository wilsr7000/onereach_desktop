const { ipcRenderer } = window.electron || {};

class BlackHoleWidget {
    constructor() {
        this.dropZone = document.getElementById('dropZone');
        this.statusText = document.getElementById('statusText');
        this.menuBtn = document.getElementById('menuBtn');
        this.particlesContainer = document.getElementById('particles');
        this.successRipple = document.getElementById('successRipple');
        
        this.currentSpace = null;
        this.spaceName = 'Unclassified';
        this.alwaysAskForSpace = localStorage.getItem('blackHoleAlwaysAsk') !== 'false';
        this.spaces = [];
        this.pendingItem = null;
        this.originalWindowPosition = null; // Store original position
        this.isReady = false; // Track initialization state
        this.pendingExternalDrops = []; // Queue for external drops received before ready
        this.isFromDownload = false; // Track if current operation is from a download
        
        this.init();
    }
    
    // Helper method to send IPC messages
    sendIPC(channel, data) {
        if (window.electron) {
            if (window.electron.send) {
                window.electron.send(channel, data);
            } else if (window.electron.ipcRenderer && window.electron.ipcRenderer.send) {
                window.electron.ipcRenderer.send(channel, data);
            }
        }
    }
    
    async init() {
        console.log('Black Hole: Initializing...');
        console.log('Black Hole: window.clipboard available?', !!window.clipboard);
        console.log('Black Hole: window.electron available?', !!window.electron);
        console.log('Black Hole: window.api available?', !!window.api);
        
        // Check if we're in production
        console.log('Black Hole: isDevMode?', window.api && window.api.isDevMode);
        
        // Load spaces first
        await this.loadSpaces();
        
        // Get current space
        await this.updateCurrentSpace();
        
        console.log('Black Hole: Initialization complete');
        console.log('Black Hole: Loaded spaces:', this.spaces);
        console.log('Black Hole: Current space:', this.currentSpace);
        console.log('Black Hole: Always ask for space:', this.alwaysAskForSpace);
        
        // Set up drag and drop
        this.setupDragAndDrop();
        
        // Set up paste handling
        this.setupPasteHandling();
        
        // Set up menu button
        this.setupMenu();
        
        // Set up modal - ensure it's done early and verify it worked
        this.setupModal();
        
        // Double-check modal was set up correctly
        if (!this.modal) {
            console.error('Black Hole: Modal setup failed during init! Retrying...');
            console.error('Black Hole: Current document state:', document.readyState);
            console.error('Black Hole: Body children:', document.body.children.length);
            
            // Force DOM to be ready
            const ensureModalSetup = () => {
                console.log('Black Hole: Ensuring modal setup...');
                this.setupModal();
                
                if (this.modal) {
                    console.log('Black Hole: Modal setup successful!');
                    // Make sure modal is closed on startup
                    this.modal.classList.remove('show', 'visible');
                    document.body.classList.remove('modal-open');
                    
                                // Reset window size to normal
            this.sendIPC('black-hole:resize-window', { width: 150, height: 150 });
                } else {
                    console.error('Black Hole: Modal still not found after retry');
                }
            };
            
            if (document.readyState !== 'complete') {
                window.addEventListener('load', ensureModalSetup);
            } else {
                // Try one more time with a delay
                setTimeout(ensureModalSetup, 100);
            }
        } else {
            // Make sure modal is closed on startup
            console.log('Black Hole: Ensuring modal is closed on startup');
            this.modal.classList.remove('show', 'visible');
            document.body.classList.remove('modal-open');
            
            // Reset window size to normal
            this.sendIPC('black-hole:resize-window', { width: 150, height: 150 });
        }
        
        // Set up focus handling
        this.setupFocusHandling();
        
        // Set up right-click context menu
        this.setupContextMenu();
        
        // Create ambient particles
        this.createAmbientParticles();
        
        // Mark widget as ready after basic initialization
        setTimeout(() => {
            this.isReady = true;
            console.log('Black Hole: Widget is now ready');
            
            // Notify main process that widget is ready
            if (window.electron) {
                if (window.electron.send) {
                    window.electron.send('black-hole:widget-ready');
                    console.log('Black Hole: Notified main process that widget is ready (via send)');
                } else if (window.electron.ipcRenderer && window.electron.ipcRenderer.send) {
                    window.electron.ipcRenderer.send('black-hole:widget-ready');
                    console.log('Black Hole: Notified main process that widget is ready (via ipcRenderer)');
                }
            }
            
            // Process any pending external drops
            if (this.pendingExternalDrops.length > 0) {
                console.log(`Black Hole: Processing ${this.pendingExternalDrops.length} pending external drops`);
                this.pendingExternalDrops.forEach(data => {
                    this.handleExternalFileDrop(data);
                });
                this.pendingExternalDrops = [];
            }
        }, 500);
        
        // Also ensure modal is set up properly
        const ensureModalReady = () => {
            if (!this.modal) {
                console.log('Black Hole: Modal not ready yet, trying to set up again...');
                this.setupModal();
                if (!this.modal) {
                    setTimeout(ensureModalReady, 200);
                } else {
                    console.log('Black Hole: Modal is now ready!');
                }
            }
        };
        setTimeout(ensureModalReady, 600);
        
        // Listen for window position response and other IPC events
        if (window.electron) {
            console.log('Black Hole: Setting up IPC handlers...');
            
            // Use window.electron.on for receiving events
            if (window.electron.on) {
                console.log('Black Hole: Using window.electron.on for event listeners');
                
                window.electron.on('black-hole:position-response', (event, position) => {
                    this.originalWindowPosition = position;
                });
                
                // Listen for prepare-for-download event to pre-setup modal
                window.electron.on('prepare-for-download', (event, data) => {
                    console.log('Black Hole: Preparing for download:', data.fileName);
                    // Pre-load spaces if not already loaded
                    if (this.spaces.length === 0) {
                        this.loadSpaces();
                    }
                    // Pre-setup modal elements
                    if (!this.modal) {
                        this.setupModal();
                    }
                    // Show "preparing" status
                    this.showStatus('Preparing to receive file...', false);
                    
                    // If we're already ready, send the ready signal again
                    if (this.isReady) {
                        console.log('Black Hole: Widget already ready, sending ready signal again');
                        window.electron.send('black-hole:widget-ready');
                    }
                });
                
                // Handle ready check requests
                window.electron.on('check-widget-ready', (event) => {
                    console.log('Black Hole: Received ready check, isReady:', this.isReady);
                    if (this.isReady) {
                        window.electron.send('black-hole:widget-ready');
                    }
                });
                
                // Listen for external file drops (from download dialog)
                console.log('Black Hole: Setting up external-file-drop listener');
                window.electron.on('external-file-drop', async (event, data) => {
                    console.log('Black Hole: RECEIVED external-file-drop event!', data);
                    if (!this.isReady) {
                        console.log('Black Hole: Widget not ready, queuing external drop');
                        this.pendingExternalDrops.push(data);
                        
                        // Wait for widget to be ready
                        const waitForReady = setInterval(() => {
                            if (this.isReady) {
                                clearInterval(waitForReady);
                                console.log('Black Hole: Widget now ready, processing queued drop');
                                const pendingData = this.pendingExternalDrops.shift();
                                if (pendingData) {
                                    this.handleExternalFileDrop(pendingData);
                                }
                            }
                        }, 100);
                        
                        return;
                    }
                    this.handleExternalFileDrop(data);
                });

                // Listen for paste-content event (from right-click menu)
                console.log('Black Hole: Setting up paste-content listener');
                window.electron.on('paste-content', async (event, data) => {
                    console.log('Black Hole: Received paste-content event:', data);
                    if (data.type === 'text' && data.content) {
                        // For right-click paste, always show space chooser
                        const textData = {
                            content: data.content,
                            spaceId: this.currentSpace
                        };
                        this.pendingItem = { type: 'text', data: textData };
                        this.showSpaceSelectionModal();
                    }
                });
            }
            // Fallback to window.electron.ipcRenderer if available
            else if (window.electron.ipcRenderer) {
                console.log('Black Hole: Using window.electron.ipcRenderer for event listeners');
                
                window.electron.ipcRenderer.on('black-hole:position-response', (event, position) => {
                    this.originalWindowPosition = position;
                });
                
                // Listen for prepare-for-download event to pre-setup modal
                window.electron.ipcRenderer.on('prepare-for-download', (event, data) => {
                    console.log('Black Hole: Preparing for download:', data.fileName);
                    // Pre-load spaces if not already loaded
                    if (this.spaces.length === 0) {
                        this.loadSpaces();
                    }
                    // Pre-setup modal elements
                    if (!this.modal) {
                        this.setupModal();
                    }
                    // Show "preparing" status
                    this.showStatus('Preparing to receive file...', false);
                    
                    // If we're already ready, send the ready signal again
                    if (this.isReady) {
                        console.log('Black Hole: Widget already ready, sending ready signal again');
                        window.electron.ipcRenderer.send('black-hole:widget-ready');
                    }
                });
                
                // Handle trigger-paste from main process
                window.electron.ipcRenderer.on('trigger-paste', () => {
                    console.log('Black Hole: Received trigger-paste message');
                    // Programmatically trigger paste by simulating Cmd+V / Ctrl+V
                    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
                    const pasteEvent = new KeyboardEvent('keydown', {
                        key: 'v',
                        code: 'KeyV',
                        ctrlKey: !isMac,
                        metaKey: isMac,
                        bubbles: true
                    });
                    document.dispatchEvent(pasteEvent);
                    
                    // Also try to directly execute paste command
                    try {
                        document.execCommand('paste');
                    } catch (e) {
                        console.log('Black Hole: execCommand paste not supported, relying on clipboard API');
                    }
                });
                
                // Handle ready check requests
                window.electron.ipcRenderer.on('check-widget-ready', () => {
                    console.log('Black Hole: Received ready check, isReady:', this.isReady);
                    if (this.isReady) {
                        window.electron.ipcRenderer.send('black-hole:widget-ready');
                    }
                });
                
                // Listen for external file drops (from download dialog)
                console.log('Black Hole: Setting up external-file-drop listener');
                window.electron.ipcRenderer.on('external-file-drop', async (event, data) => {
                    console.log('Black Hole: RECEIVED external-file-drop event!', data);
                    if (!this.isReady) {
                        console.log('Black Hole: Widget not ready, queuing external drop');
                        this.pendingExternalDrops.push(data);
                        
                        // Wait for widget to be ready
                        const waitForReady = setInterval(() => {
                            if (this.isReady) {
                                clearInterval(waitForReady);
                                console.log('Black Hole: Widget now ready, processing queued drop');
                                const pendingData = this.pendingExternalDrops.shift();
                                if (pendingData) {
                                    this.handleExternalFileDrop(pendingData);
                                }
                            }
                        }, 100);
                        
                        return;
                    }
                    this.handleExternalFileDrop(data);
                });

                // Listen for paste-content event (from right-click menu)
                console.log('Black Hole: Setting up paste-content listener');
                window.electron.ipcRenderer.on('paste-content', async (event, data) => {
                    console.log('Black Hole: Received paste-content event:', data);
                    if (data.type === 'text' && data.content) {
                        // For right-click paste, always show space chooser
                        const textData = {
                            content: data.content,
                            spaceId: this.currentSpace
                        };
                        this.pendingItem = { type: 'text', data: textData };
                        this.showSpaceSelectionModal();
                    }
                });
            }
        } else {
            console.error('Black Hole: window.electron not available!');
        }
        
        // Listen for space changes
        if (window.clipboard) {
            window.clipboard.onActiveSpaceChanged((data) => {
                console.log('Black Hole: Space changed to:', data);
                this.currentSpace = data.spaceId;
                this.spaceName = data.spaceName || 'Unclassified';
                this.showStatus(`Default space: ${this.spaceName}`);
            });
        }
        
        // Update paste hint for platform
        const pasteHint = document.querySelector('.paste-hint');
        if (pasteHint) {
            const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
            pasteHint.innerHTML = isMac 
                ? 'Press ⌘V to paste' 
                : 'Press Ctrl+V to paste';
        }
        
        // Clear status when window loses focus or visibility changes
        window.addEventListener('blur', () => {
            this.hideStatus();
        });
        
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.hideStatus();
            }
        });
        
        // Clear status when window is being closed
        window.addEventListener('beforeunload', () => {
            this.hideStatus();
        });
    }
    
    async handleExternalFileDrop(data) {
        console.log('=== BLACK HOLE: EXTERNAL FILE DROP EVENT TRIGGERED ===');
        console.log('Black Hole: Received external file drop:', data.fileName);
        console.log('Black Hole: File size:', data.fileSize);
        console.log('Black Hole: MIME type:', data.mimeType);
        console.log('Black Hole: Current space:', this.currentSpace);
        console.log('Black Hole: Always ask for space:', this.alwaysAskForSpace);
        console.log('Black Hole: Modal exists?', !!this.modal);
        console.log('Black Hole: Spaces loaded?', this.spaces.length);
        
        // Mark this as a download operation
        this.isFromDownload = true;
        
        // Hide the status message
        this.hideStatus();
        
        // Create a pending item immediately with basic info
        const mimeType = data.mimeType || 'application/octet-stream';
        const isImage = mimeType.startsWith('image/');
        
        this.pendingItem = {
            type: isImage ? 'image' : 'file',
            data: {
                fileName: data.fileName,
                fileSize: data.fileSize,
                fileType: mimeType,
                spaceId: this.currentSpace,
                // We'll add the actual data later
                processing: true
            }
        };
        
        // Ensure spaces are loaded before showing modal
        if (this.spaces.length === 0) {
            console.log('Black Hole: Loading spaces before showing modal...');
            await this.loadSpaces();
        }
        
        // Show modal immediately, but ensure it's ready
        console.log('Black Hole: Showing space selection modal immediately...');
        
        // Wait for modal to be ready (with timeout)
        let modalWaitCount = 0;
        const maxWaitTime = 3000; // 3 seconds max
        const waitInterval = 100;
        
        while (!this.modal && modalWaitCount < (maxWaitTime / waitInterval)) {
            console.log('Black Hole: Waiting for modal to be ready...');
            this.setupModal();
            
            if (!this.modal) {
                await new Promise(resolve => setTimeout(resolve, waitInterval));
                modalWaitCount++;
            }
        }
        
        if (!this.modal) {
            console.error('Black Hole: Modal setup failed after waiting! Using fallback approach');
            // Force DOM ready and try one more time
            if (document.readyState !== 'complete') {
                await new Promise(resolve => window.addEventListener('load', resolve));
            }
            
            // Try once more with DOM ready
            this.setupModal();
            
            if (!this.modal) {
                console.error('Black Hole: Modal setup failed completely! Using direct approach');
                // Always ask for downloads, so show a basic prompt
                const spaceNames = this.spaces.map((s, i) => `${i + 1}. ${s.icon} ${s.name}`).join('\n');
                const choice = prompt(`Choose a space for "${data.fileName}":\n\n${spaceNames}\n\nEnter number (1-${this.spaces.length}):`);
                if (choice && !isNaN(choice)) {
                    const index = parseInt(choice) - 1;
                    if (index >= 0 && index < this.spaces.length) {
                        const space = this.spaces[index];
                        this.showStatus(`Adding to ${space.icon} ${space.name}`);
                        // Continue processing with file data below
                        this.pendingItem.data.spaceId = space.id;
                    } else {
                        this.showStatus('Invalid selection', true);
                        return;
                    }
                } else {
                    this.showStatus('Cancelled', true);
                    return;
                }
            }
        }
        
        // Only show modal if we have one
        if (this.modal) {
            console.log('Black Hole: Modal is ready, showing space selection...');
            this.showSpaceSelectionModal();
        }
        
        // Process file data in parallel
        try {
            // Convert base64 data to blob
            console.log('Black Hole: Converting base64 to blob in background...');
            const byteCharacters = atob(data.fileData);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray], { type: mimeType });
            
            // Update pending item with processed data
            if (this.pendingItem && this.pendingItem.data.processing) {
                if (isImage) {
                    // For images, create data URL
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        if (this.pendingItem) {
                            this.pendingItem.data.dataUrl = e.target.result;
                            this.pendingItem.data.processing = false;
                            console.log('Black Hole: Image data ready');
                            
                            // If modal wasn't shown, process immediately with selected space
                            if (!this.modal && this.pendingItem.data.spaceId) {
                                this.processPendingItem(this.pendingItem.data.spaceId);
                            }
                        }
                    };
                    reader.readAsDataURL(blob);
                } else {
                    // For other files, store the base64 data
                    this.pendingItem.data.fileData = data.fileData;
                    this.pendingItem.data.processing = false;
                    console.log('Black Hole: File data ready');
                    
                    // If modal wasn't shown, process immediately with selected space
                    if (!this.modal && this.pendingItem.data.spaceId) {
                        this.processPendingItem(this.pendingItem.data.spaceId);
                    }
                }
            }
        } catch (error) {
            console.error('Black Hole: Error processing external file drop:', error);
            this.showStatus('Error processing file', true);
            // Still allow the user to select a space
            if (this.pendingItem) {
                this.pendingItem.data.processing = false;
                this.pendingItem.data.error = true;
            }
        }
    }
    
    async loadSpaces() {
        console.log('Black Hole: Loading spaces...');
        if (window.clipboard) {
            this.spaces = await window.clipboard.getSpaces();
            console.log('Black Hole: Loaded spaces:', this.spaces);
            console.log('Black Hole: Number of spaces:', this.spaces.length);
        } else {
            console.error('Black Hole: window.clipboard not available');
        }
    }
    
    setupDragAndDrop() {
        // Prevent default drag behaviors
        document.addEventListener('dragover', (e) => {
            console.log('Document dragover event');
            e.preventDefault();
            e.stopPropagation();
        });
        
        document.addEventListener('drop', (e) => {
            console.log('Document drop event - files:', e.dataTransfer.files.length);
            e.preventDefault();
            e.stopPropagation();
        });
        
        // Make the window draggable
        let isDraggingWindow = false;
        let dragStartX = 0;
        let dragStartY = 0;
        
        this.dropZone.addEventListener('mousedown', (e) => {
            // Only start window drag if left mouse button and not dragging from inside elements
            if (e.button === 0 && (e.target === this.dropZone || e.target.closest('.ghost-zone'))) {
                isDraggingWindow = true;
                dragStartX = e.screenX;
                dragStartY = e.screenY;
                this.dropZone.style.cursor = 'grabbing';
            }
        });
        
        document.addEventListener('mousemove', (e) => {
            if (isDraggingWindow) {
                const deltaX = e.screenX - dragStartX;
                const deltaY = e.screenY - dragStartY;
                
                // Move the window
                this.sendIPC('black-hole:move-window', { deltaX, deltaY });
                
                dragStartX = e.screenX;
                dragStartY = e.screenY;
            }
        });
        
        document.addEventListener('mouseup', () => {
            if (isDraggingWindow) {
                isDraggingWindow = false;
                this.dropZone.style.cursor = 'grab';
            }
        });
        
        // Drop zone drag events for file/text drops
        this.dropZone.addEventListener('dragover', (e) => {
            console.log('Drop Zone: Dragover event, types:', Array.from(e.dataTransfer.types));
            e.preventDefault();
            e.stopPropagation();
            
            // Close modal if it's open to allow drag and drop
            if (this.modal && this.modal.classList.contains('show')) {
                console.log('Drop Zone: Closing modal to allow drag and drop');
                this.closeModal();
            }
            
            this.dropZone.classList.add('dragging-over');
            
            // Check if it's files or text
            if (e.dataTransfer.types.includes('Files')) {
                this.showStatus('Drop files here');
            } else if (e.dataTransfer.types.includes('text/plain')) {
                this.showStatus('Drop text here');
            }
        });
        
        this.dropZone.addEventListener('dragleave', (e) => {
            if (!this.dropZone.contains(e.relatedTarget)) {
                this.dropZone.classList.remove('dragging-over');
                this.hideStatus();
            }
        });
        
        this.dropZone.addEventListener('drop', async (e) => {
            console.log('Drop Zone: Drop event fired');
            e.preventDefault();
            e.stopPropagation();
            
            this.dropZone.classList.remove('dragging-over');
            
            // Check if modal is open
            if (this.modal && this.modal.classList.contains('show')) {
                console.log('Black Hole: Modal is open, closing it first');
                this.closeModal();
                // Wait a bit for modal to close
                await new Promise(resolve => setTimeout(resolve, 350));
            }
            
            // Notify main process that black hole is active (processing items)
            if (window.electron && window.electron.ipcRenderer) {
                window.electron.ipcRenderer.send('black-hole:active');
            }
            
            // Create particle effect
            this.createSuckInEffect(e.clientX, e.clientY);
            
            // Handle files
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                console.log('Black Hole: Files detected:', e.dataTransfer.files.length);
                for (let file of e.dataTransfer.files) {
                    console.log('Black Hole: Processing file:', file.name, 'Type:', file.type);
                    await this.handleFile(file);
                }
            } 
            // Handle text
            else if (e.dataTransfer.types.includes('text/plain')) {
                const text = e.dataTransfer.getData('text/plain');
                if (text) {
                    await this.handleText(text);
                }
            }
            // Handle URLs
            else if (e.dataTransfer.types.includes('text/uri-list')) {
                const urls = e.dataTransfer.getData('text/uri-list');
                if (urls) {
                    await this.handleText(urls);
                }
            }
        });
    }
    
    setupFocusHandling() {
        // Add focus class when window gains focus
        window.addEventListener('focus', () => {
            document.body.classList.add('focused');
            
            // Show paste ready indicator briefly
            document.body.classList.add('paste-ready');
            setTimeout(() => {
                document.body.classList.remove('paste-ready');
            }, 2000);
        });
        
        // Remove focus class when window loses focus
        window.addEventListener('blur', () => {
            document.body.classList.remove('focused');
            document.body.classList.remove('paste-ready');
        });
        
        // Click on the widget to focus it
        this.dropZone.addEventListener('click', () => {
            // Open the Spaces Knowledge Manager (clipboard history)
            if (window.api) {
                console.log('Drop Zone: Click detected, opening Spaces Knowledge Manager');
                window.api.send('open-clipboard-viewer');
                
                // Close the drop zone widget after opening the clipboard viewer
                setTimeout(() => {
                    window.close();
                }, 100); // Small delay to ensure the IPC message is sent
            }
        });
    }
    
    setupPasteHandling() {
        document.addEventListener('paste', async (e) => {
            console.log('Black Hole: Paste event triggered');
            e.preventDefault();
            
            // Notify main process that black hole is active (processing items)
            this.sendIPC('black-hole:active');
            
            // Show visual feedback immediately
            document.body.classList.add('paste-ready');
            
            // Create particle effect at center
            const rect = this.dropZone.getBoundingClientRect();
            this.createSuckInEffect(rect.left + rect.width / 2, rect.top + rect.height / 2);
            
            // Handle clipboard data
            const clipboardData = e.clipboardData;
            console.log('Black Hole: Clipboard data available:', !!clipboardData);
            console.log('Black Hole: Clipboard types:', clipboardData ? Array.from(clipboardData.types) : 'none');
            
            // Check for files (images)
            if (clipboardData.files && clipboardData.files.length > 0) {
                console.log('Black Hole: Processing files, count:', clipboardData.files.length);
                for (let file of clipboardData.files) {
                    await this.handleFile(file);
                }
            }
            // Check for HTML (check this before plain text since HTML often includes both)
            else if (clipboardData.types.includes('text/html')) {
                const html = clipboardData.getData('text/html');
                const text = clipboardData.getData('text/plain');
                console.log('Black Hole: Processing HTML, has text:', !!text);
                if (html) {
                    await this.handleHtml(html, text);
                }
            }
            // Check for plain text
            else if (clipboardData.types.includes('text/plain')) {
                const text = clipboardData.getData('text/plain');
                console.log('Black Hole: Processing plain text, length:', text ? text.length : 0);
                if (text) {
                    await this.handleText(text);
                }
            }
            else {
                console.log('Black Hole: No recognized clipboard data types found');
            }
            
            // Remove paste ready indicator after a delay
            setTimeout(() => {
                document.body.classList.remove('paste-ready');
            }, 1000);
        });
        
        // Also handle keyboard shortcut for paste
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
                // Show paste ready indicator when shortcut is pressed
                document.body.classList.add('paste-ready');
                setTimeout(() => {
                    document.body.classList.remove('paste-ready');
                }, 1500);
            }
        });
    }
    
    setupMenu() {
        this.menuBtn.addEventListener('click', async () => {
            const spaces = await window.clipboard.getSpaces();
            const currentSpace = await window.clipboard.getActiveSpace();
            
            const menu = [
                {
                    label: 'Current Space',
                    enabled: false
                },
                { type: 'separator' }
            ];
            
            // Add space options
            spaces.forEach(space => {
                menu.push({
                    label: `${space.icon} ${space.name}`,
                    type: 'radio',
                    checked: space.id === currentSpace.spaceId,
                    click: () => {
                        window.clipboard.setCurrentSpace(space.id);
                    }
                });
            });
            
            menu.push(
                { type: 'separator' },
                {
                    label: 'Open Clipboard Manager',
                    click: () => {
                        window.api.send('open-clipboard-viewer');
                    }
                },
                { type: 'separator' },
                {
                    label: 'Settings',
                    submenu: [
                        {
                            label: 'Always on Top',
                            type: 'checkbox',
                            checked: true,
                            click: (item) => {
                                window.api.send('black-hole:toggle-always-on-top', item.checked);
                            }
                        },
                        {
                            label: 'Opacity',
                            submenu: [
                                { label: '100%', click: () => this.setOpacity(1) },
                                { label: '75%', click: () => this.setOpacity(0.75) },
                                { label: '50%', click: () => this.setOpacity(0.5) },
                                { label: '25%', click: () => this.setOpacity(0.25) }
                            ]
                        }
                    ]
                },
                { type: 'separator' },
                {
                    label: 'Close',
                    click: () => {
                        window.close();
                    }
                }
            );
            
            window.api.send('show-context-menu', menu);
        });
    }
    
    setupModal() {
        console.log('Black Hole: Setting up modal...');
        
        // First check if DOM is ready
        if (document.readyState === 'loading') {
            console.log('Black Hole: DOM not ready, deferring modal setup');
            document.addEventListener('DOMContentLoaded', () => this.setupModal());
            return;
        }
        
        // Try multiple ways to find the modal
        this.modal = document.getElementById('spaceModal');
        if (!this.modal) {
            // Try querySelector as backup
            this.modal = document.querySelector('#spaceModal');
        }
        if (!this.modal) {
            // Try finding by class
            this.modal = document.querySelector('.modal');
        }
        
        // If still not found, force a DOM refresh and try again
        if (!this.modal) {
            console.log('Black Hole: Modal not found, forcing DOM refresh...');
            // Force browser to recalculate styles
            document.body.offsetHeight;
            
            // Try again
            this.modal = document.getElementById('spaceModal');
            if (!this.modal) {
                this.modal = document.querySelector('#spaceModal');
            }
            if (!this.modal) {
                this.modal = document.querySelector('.modal');
            }
        }
        
        this.spaceGrid = document.getElementById('spaceGrid');
        this.cancelBtn = document.getElementById('cancelBtn');
        this.confirmBtn = document.getElementById('confirmBtn');
        this.alwaysAskCheckbox = document.getElementById('alwaysAskCheckbox');
        this.modalDescription = document.getElementById('modalDescription');
        this.modalCloseBtn = document.getElementById('modalCloseBtn');
        
        console.log('Black Hole: Modal elements found:', {
            modal: !!this.modal,
            spaceGrid: !!this.spaceGrid,
            cancelBtn: !!this.cancelBtn,
            confirmBtn: !!this.confirmBtn,
            alwaysAskCheckbox: !!this.alwaysAskCheckbox,
            modalDescription: !!this.modalDescription,
            modalCloseBtn: !!this.modalCloseBtn
        });
        
        // Log the actual modal element for debugging
        if (!this.modal) {
            console.error('Black Hole: Modal element not found! Available elements with id:', 
                Array.from(document.querySelectorAll('[id]')).map(el => el.id));
            console.error('Black Hole: Document body innerHTML length:', document.body.innerHTML.length);
            console.error('Black Hole: Looking for modal class:', document.querySelectorAll('.modal').length);
            console.error('Black Hole: HTML snippet around modal area:', 
                document.body.innerHTML.indexOf('spaceModal') > -1 ? 'Modal HTML exists in DOM' : 'Modal HTML NOT in DOM');
            return;
        }
        
        // Set checkbox state from localStorage
        this.alwaysAskCheckbox.checked = this.alwaysAskForSpace;
        
        // Handle checkbox change
        this.alwaysAskCheckbox.addEventListener('change', (e) => {
            this.alwaysAskForSpace = e.target.checked;
            localStorage.setItem('blackHoleAlwaysAsk', this.alwaysAskForSpace ? 'true' : 'false');
        });
        
        // Handle cancel button
        this.cancelBtn.addEventListener('click', () => {
            this.closeModal();
            this.pendingItem = null;
        });
        
        // Handle close button (X)
        if (this.modalCloseBtn) {
            this.modalCloseBtn.addEventListener('click', () => {
                console.log('Black Hole: Close button clicked');
                this.closeModal();
                this.pendingItem = null;
            });
        }
        
        // Handle confirm button
        this.confirmBtn.addEventListener('click', () => {
            const selectedSpace = this.spaceGrid.querySelector('.space-item.selected');
            if (selectedSpace && this.pendingItem) {
                const spaceId = selectedSpace.dataset.spaceId;
                this.processPendingItem(spaceId);
            }
        });
        
        // Close modal on background click
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) {
                this.closeModal();
                this.pendingItem = null;
            }
        });
        
        // Add escape key handler to close modal
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.modal && this.modal.classList.contains('show')) {
                console.log('Black Hole: Escape key pressed, closing modal');
                this.closeModal();
                this.pendingItem = null;
            }
        });
        
        // Add fail-safe timer to auto-close stuck modal after 30 seconds
        this.modalTimeout = null;
    }
    
    showSpaceSelectionModal() {
        console.log('Black Hole: showSpaceSelectionModal called');
        
        // Clear any existing timeout
        if (this.modalTimeout) {
            clearTimeout(this.modalTimeout);
            this.modalTimeout = null;
        }
        
        // Retry modal setup if it wasn't initialized properly
        if (!this.modal && document.getElementById('spaceModal')) {
            console.log('Black Hole: Modal not initialized, retrying setup...');
            this.setupModal();
        }
        
        console.log('Black Hole: Modal element:', this.modal);
        console.log('Black Hole: Spaces available:', this.spaces.length);
        console.log('Black Hole: Pending item:', this.pendingItem);
        
        if (!this.modal) {
            console.error('Black Hole: Cannot show modal - element not found');
            // Try to load spaces anyway
            if (this.spaces.length === 0) {
                console.log('Black Hole: No spaces loaded, loading now...');
                this.loadSpaces().then(() => {
                    console.log('Black Hole: Spaces loaded, retrying modal...');
                    this.showSpaceSelectionModal();
                });
                return;
            }
            // Fallback: use the first space if modal can't be shown
            if (this.spaces.length > 0 && this.pendingItem) {
                console.warn('Black Hole: Using fallback - adding to first space');
                const firstSpace = this.spaces[0];
                this.showStatus(`Modal unavailable. Adding to ${firstSpace.icon} ${firstSpace.name}`);
                this.processPendingItem(firstSpace.id);
            }
            return;
        }
        
        // Set a fail-safe timeout to auto-close the modal after 30 seconds
        this.modalTimeout = setTimeout(() => {
            console.warn('Black Hole: Modal timeout - auto-closing after 30 seconds');
            this.showStatus('Modal timed out - closing automatically', true);
            this.closeModal();
            this.pendingItem = null;
        }, 30000);
        
        // Add class to body to hide black hole
        document.body.classList.add('modal-open');
        
        // Notify main process that black hole is active (modal open)
        this.sendIPC('black-hole:active');
        
        // Store current window position before resizing
        // Request current position from main process
        this.sendIPC('black-hole:get-position');
        
        // Expand window to show modal - reduced delay
        setTimeout(() => {
            this.sendIPC('black-hole:resize-window', { width: 600, height: 800 });
        }, 10); // Reduced from 50ms to 10ms
        
        // Update modal description based on pending item
        if (this.modalDescription && this.pendingItem) {
            let description = 'Select where to save this item';
            
            switch (this.pendingItem.type) {
                case 'text':
                    description = 'Text: ' + this.truncateText(this.pendingItem.data.content, 50);
                    break;
                case 'html':
                    description = 'HTML: ' + this.truncateText(this.pendingItem.data.plainText || 'HTML content', 50);
                    break;
                case 'image':
                    description = `Image: ${this.pendingItem.data.fileName} (${this.formatFileSize(this.pendingItem.data.fileSize)})`;
                    break;
                case 'file':
                    description = `File: ${this.pendingItem.data.fileName} (${this.formatFileSize(this.pendingItem.data.fileSize)})`;
                    break;
            }
            
            this.modalDescription.textContent = description;
        }
        
        // Preview information is now shown in the modal description
        
        // Populate spaces
        this.spaceGrid.innerHTML = '';
        
        this.spaces.forEach(space => {
            const spaceEl = document.createElement('div');
            spaceEl.className = 'space-item';
            spaceEl.dataset.spaceId = space.id;
            
            // Pre-select current space
            if (space.id === this.currentSpace) {
                spaceEl.classList.add('selected');
            }
            
            spaceEl.innerHTML = `
                <div class="space-icon">${space.icon}</div>
                <div class="space-name">${space.name}</div>
                <div class="space-count">${space.itemCount || 0} items</div>
            `;
            
            spaceEl.addEventListener('click', () => {
                // Remove previous selection
                this.spaceGrid.querySelectorAll('.space-item').forEach(el => {
                    el.classList.remove('selected');
                });
                // Select this space
                spaceEl.classList.add('selected');
            });
            
            this.spaceGrid.appendChild(spaceEl);
        });
        
        // Show modal with animation
        this.modal.classList.add('show');
        // Reduced animation delay
        setTimeout(() => {
            this.modal.classList.add('visible');
        }, 5); // Reduced from 10ms to 5ms
    }
    
    closeModal() {
        // Clear any existing timeout when closing modal
        if (this.modalTimeout) {
            clearTimeout(this.modalTimeout);
            this.modalTimeout = null;
        }
        
        this.modal.classList.remove('visible');
        setTimeout(() => {
            this.modal.classList.remove('show');
            document.body.classList.remove('modal-open');
            
            // Notify main process that black hole is inactive (modal closed)
            // If this was from a download, tell the main process to close the window
            this.sendIPC('black-hole:inactive', { fromDownload: this.isFromDownload });
            
            // Reset the download flag after closing
            if (this.isFromDownload) {
                this.isFromDownload = false;
            }
            
            // Restore original window size and position
            this.sendIPC('black-hole:resize-window', { width: 150, height: 150 });
            
            // Restore position if we have it
            if (this.originalWindowPosition) {
                setTimeout(() => {
                    this.sendIPC('black-hole:restore-position', this.originalWindowPosition);
                    this.originalWindowPosition = null; // Clear after use
                }, 100);
            }
        }, 300);
    }
    
    async processPendingItem(spaceId) {
        if (!this.pendingItem) return;
        
        // Wait for processing to complete if still in progress
        if (this.pendingItem.data.processing) {
            console.log('Black Hole: Waiting for file processing to complete...');
            // Show a quick status
            this.showStatus('Processing file...', false);
            
            // Wait up to 3 seconds for processing
            let waitCount = 0;
            while (this.pendingItem && this.pendingItem.data.processing && waitCount < 30) {
                await new Promise(resolve => setTimeout(resolve, 100));
                waitCount++;
            }
            
            // Hide status
            this.hideStatus();
            
            if (this.pendingItem && this.pendingItem.data.processing) {
                console.error('Black Hole: File processing timed out');
                this.showStatus('File processing error', true);
                this.closeModal();
                return;
            }
        }
        
        const item = this.pendingItem;
        this.pendingItem = null;
        
        // Add spaceId to the item data
        item.data.spaceId = spaceId;
        
        // Process based on type
        let result;
        switch (item.type) {
            case 'text':
                result = await window.clipboard.addText(item.data);
                break;
            case 'html':
                result = await window.clipboard.addHtml(item.data);
                break;
            case 'image':
                result = await window.clipboard.addImage(item.data);
                break;
            case 'file':
                result = await window.clipboard.addFile(item.data);
                break;
        }
        
        if (result && result.success) {
            this.showSuccess();
            const space = this.spaces.find(s => s.id === spaceId);
            const spaceName = space ? `${space.icon} ${space.name}` : 'Unknown';
            this.showStatus(`Added to ${spaceName}`);
            
            // Close the modal after a brief delay to show success, but keep the black hole open
            setTimeout(() => {
                this.closeModal();
                // Status will auto-hide after 3 seconds (handled by showStatus)
            }, 800);
        } else {
            this.closeModal();
        }
    }
    
    async handleFile(file) {
        try {
            console.log('Black Hole: Handling file:', file.name, 'type:', file.type, 'size:', file.size, 'isDownload:', file.isDownload);
            console.log('Black Hole: File type starts with image/:', file.type ? file.type.startsWith('image/') : false);
            console.log('Black Hole: File extension:', file.name.split('.').pop().toLowerCase());
            console.log('Black Hole: Current space:', this.currentSpace, 'Space name:', this.spaceName);
            
            // For images, read as data URL
            if (file.type && file.type.startsWith('image/')) {
                console.log('Black Hole: Processing as image...');
                const reader = new FileReader();
                reader.onload = async (e) => {
                    const dataUrl = e.target.result;
                    const data = {
                        dataUrl: dataUrl,
                        fileName: file.name,
                        fileSize: file.size,
                        spaceId: this.currentSpace
                    };
                    
                    console.log('Black Hole: Image data prepared, spaceId:', this.currentSpace);
                    console.log('Black Hole: Checking conditions - isDownload:', file.isDownload, 'alwaysAskForSpace:', this.alwaysAskForSpace);
                    
                    // Always ask for space if it's a download, or if alwaysAskForSpace is true
                    if (file.isDownload || this.alwaysAskForSpace) {
                        console.log('Black Hole: Conditions met, showing space selection modal...');
                        this.pendingItem = { type: 'image', data };
                        this.showSpaceSelectionModal();
                    } else {
                        console.log('Black Hole: Adding image directly to space:', this.currentSpace);
                        const result = await window.clipboard.addImage(data);
                        console.log('Black Hole: addImage result:', result);
                        if (result.success) {
                            this.showSuccess();
                            this.showStatus(`Image added to ${this.spaceName}`);
                            // Status will auto-hide after 3 seconds (handled by showStatus)
                        }
                        
                        // Notify main process that processing is complete
                        if (window.electron && window.electron.ipcRenderer) {
                            window.electron.ipcRenderer.send('black-hole:inactive', { fromDownload: this.isFromDownload });
                            if (this.isFromDownload) {
                                this.isFromDownload = false;
                            }
                        }
                    }
                };
                reader.readAsDataURL(file);
            } else {
                console.log('Black Hole: Processing as non-image file...');
                
                // For PDF files, read the content as ArrayBuffer
                const isPDF = (file.type === 'application/pdf' || 
                              file.type === 'application/x-pdf' || 
                              file.name.toLowerCase().endsWith('.pdf'));
                
                console.log('Black Hole: Is PDF check:', isPDF, 'Type:', file.type, 'Name:', file.name);
                
                if (isPDF) {
                    console.log('Black Hole: Detected PDF file:', file.name, 'Size:', file.size);
                    
                    // Check file size limit (e.g., 50MB)
                    const maxSize = 50 * 1024 * 1024; // 50MB
                    if (file.size > maxSize) {
                        console.error('Black Hole: PDF file too large:', file.size, 'bytes');
                        this.showStatus('PDF file too large (max 50MB)', true);
                        
                        // Notify main process that processing is complete
                        if (window.electron && window.electron.ipcRenderer) {
                            window.electron.ipcRenderer.send('black-hole:inactive', { fromDownload: this.isFromDownload });
                            if (this.isFromDownload) {
                                this.isFromDownload = false;
                            }
                        }
                        return;
                    }
                    
                    console.log('Black Hole: Reading PDF file content...');
                    const reader = new FileReader();
                    
                    reader.onload = async (e) => {
                        try {
                        const arrayBuffer = e.target.result;
                        
                        // Convert ArrayBuffer to base64 in chunks to handle large files
                        const uint8Array = new Uint8Array(arrayBuffer);
                        let binary = '';
                        const chunkSize = 8192; // Process in 8KB chunks
                        
                        for (let i = 0; i < uint8Array.length; i += chunkSize) {
                            const chunk = uint8Array.slice(i, i + chunkSize);
                            binary += String.fromCharCode.apply(null, chunk);
                        }
                        
                        const base64 = btoa(binary);
                        console.log('Black Hole: Base64 conversion complete, length:', base64.length);
                        
                        const data = {
                            fileName: file.name,
                            fileSize: file.size,
                            fileType: 'application/pdf',
                            fileData: base64, // Send the actual PDF data
                            spaceId: this.currentSpace
                        };
                        
                        console.log('Black Hole: PDF data prepared with content, spaceId:', this.currentSpace);
                        
                        // Always ask for space if it's a download, or if alwaysAskForSpace is true
                        if (file.isDownload || this.alwaysAskForSpace) {
                            console.log('Black Hole: Conditions met, showing space selection modal...');
                            this.pendingItem = { type: 'file', data };
                            this.showSpaceSelectionModal();
                        } else {
                            console.log('Black Hole: Adding PDF directly to space:', this.currentSpace);
                            const result = await window.clipboard.addFile(data);
                            console.log('Black Hole: addFile result:', result);
                            if (result.success) {
                                this.showSuccess();
                                this.showStatus(`PDF added to ${this.spaceName}`);
                                // Status will auto-hide after 3 seconds (handled by showStatus)
                            } else {
                                console.error('Black Hole: Failed to add PDF:', result);
                                this.showStatus('Failed to add PDF', true);
                            }
                            
                            // Notify main process that processing is complete
                            if (window.electron && window.electron.ipcRenderer) {
                                window.electron.ipcRenderer.send('black-hole:inactive', { fromDownload: this.isFromDownload });
                                if (this.isFromDownload) {
                                    this.isFromDownload = false;
                                }
                            }
                        }
                        } catch (error) {
                            console.error('Black Hole: Error processing PDF:', error);
                            this.showStatus('Error processing PDF', true);
                            
                            // Notify main process that processing is complete
                            if (window.electron && window.electron.ipcRenderer) {
                                window.electron.ipcRenderer.send('black-hole:inactive', { fromDownload: this.isFromDownload });
                                if (this.isFromDownload) {
                                    this.isFromDownload = false;
                                }
                            }
                        }
                    };
                    
                    reader.onerror = (error) => {
                        console.error('Black Hole: Error reading PDF file:', error);
                        this.showStatus('Error reading PDF file', true);
                    };
                    
                    reader.readAsArrayBuffer(file);
                } else {
                    // For other files, just send the metadata
                    const data = {
                        fileName: file.name,
                        fileSize: file.size,
                        fileType: file.type,
                        spaceId: this.currentSpace
                    };
                    
                    console.log('Black Hole: File data prepared, spaceId:', this.currentSpace);
                    
                    // Always ask for space if it's a download, or if alwaysAskForSpace is true
                    if (file.isDownload || this.alwaysAskForSpace) {
                        console.log('Black Hole: Conditions met, showing space selection modal...');
                        this.pendingItem = { type: 'file', data };
                        this.showSpaceSelectionModal();
                    } else {
                        console.log('Black Hole: Adding file directly to space:', this.currentSpace);
                        const result = await window.clipboard.addFile(data);
                        console.log('Black Hole: addFile result:', result);
                        if (result.success) {
                            this.showSuccess();
                            this.showStatus(`File added to ${this.spaceName}`);
                            // Status will auto-hide after 3 seconds (handled by showStatus)
                        }
                        
                        // Notify main process that processing is complete
                        if (window.electron && window.electron.ipcRenderer) {
                            window.electron.ipcRenderer.send('black-hole:inactive', { fromDownload: this.isFromDownload });
                            if (this.isFromDownload) {
                                this.isFromDownload = false;
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Black Hole: Error handling file:', error);
            console.error('Black Hole: Error stack:', error.stack);
            this.showStatus('Error adding file', true);
        }
    }
    
    async handleText(text) {
        try {
            console.log('Black Hole: handleText called, length:', text.length);
            console.log('Black Hole: Current space:', this.currentSpace);
            console.log('Black Hole: Space name:', this.spaceName);
            console.log('Black Hole: alwaysAskForSpace:', this.alwaysAskForSpace);
            console.log('Black Hole: window.clipboard available:', !!window.clipboard);
            console.log('Black Hole: window.clipboard.addText available:', !!(window.clipboard && window.clipboard.addText));
            
            const data = {
                content: text,
                spaceId: this.currentSpace
            };
            
            console.log('Black Hole: Text data prepared:', data);
            
            if (this.alwaysAskForSpace) {
                this.pendingItem = { type: 'text', data };
                this.showSpaceSelectionModal();
            } else {
                console.log('Black Hole: Adding text directly to space:', this.currentSpace);
                const result = await window.clipboard.addText(data);
                console.log('Black Hole: addText result:', result);
                if (result.success) {
                    this.showSuccess();
                    this.showStatus(`Text added to ${this.spaceName}`);
                    // Status will auto-hide after 3 seconds (handled by showStatus)
                }
                
                // Notify main process that processing is complete
                if (window.electron && window.electron.ipcRenderer) {
                    window.electron.ipcRenderer.send('black-hole:inactive', { fromDownload: this.isFromDownload });
                    if (this.isFromDownload) {
                        this.isFromDownload = false;
                    }
                }
            }
        } catch (error) {
            console.error('Black Hole: Error handling text:', error);
            this.showStatus('Error adding text', true);
        }
    }
    
    async handleHtml(html, plainText) {
        try {
            const data = {
                content: html,
                plainText: plainText,
                spaceId: this.currentSpace
            };
            
            if (this.alwaysAskForSpace) {
                this.pendingItem = { type: 'html', data };
                this.showSpaceSelectionModal();
            } else {
                const result = await window.clipboard.addHtml(data);
                if (result.success) {
                    this.showSuccess();
                    this.showStatus(`HTML added to ${this.spaceName}`);
                    // Status will auto-hide after 3 seconds (handled by showStatus)
                }
                
                // Notify main process that processing is complete
                if (window.electron && window.electron.ipcRenderer) {
                    window.electron.ipcRenderer.send('black-hole:inactive', { fromDownload: this.isFromDownload });
                    if (this.isFromDownload) {
                        this.isFromDownload = false;
                    }
                }
            }
        } catch (error) {
            console.error('Error handling HTML:', error);
            this.showStatus('Error adding HTML', true);
        }
    }
    
    async updateCurrentSpace() {
        console.log('Black Hole: Updating current space...');
        if (window.clipboard) {
            const space = await window.clipboard.getActiveSpace();
            console.log('Black Hole: Active space response:', space);
            this.currentSpace = space.spaceId || 'unclassified';  // Default to unclassified if null
            this.spaceName = space.spaceName || 'Unclassified';
            console.log('Black Hole: Set currentSpace to:', this.currentSpace, 'spaceName:', this.spaceName);
        }
    }
    
    createSuckInEffect(x, y) {
        // Calculate angle from drop point to drop zone center
        const rect = this.dropZone.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        
        // Create multiple particles
        for (let i = 0; i < 10; i++) {
            setTimeout(() => {
                const particle = document.createElement('div');
                particle.className = 'particle';
                
                // Random offset from drop point
                const offsetX = (Math.random() - 0.5) * 50;
                const offsetY = (Math.random() - 0.5) * 50;
                
                // Position at drop point with offset
                particle.style.left = `${x - rect.left + offsetX}px`;
                particle.style.top = `${y - rect.top + offsetY}px`;
                
                // Set CSS variables for end position
                const endX = centerX - x;
                const endY = centerY - y;
                particle.style.setProperty('--end-x', `${endX}px`);
                particle.style.setProperty('--end-y', `${endY}px`);
                
                this.particlesContainer.appendChild(particle);
                
                // Trigger animation
                setTimeout(() => {
                    particle.classList.add('active');
                }, 10);
                
                // Remove after animation
                setTimeout(() => {
                    particle.remove();
                }, 2000);
            }, i * 50);
        }
    }
    
    createAmbientParticles() {
        // Create occasional ambient particles that get sucked in
        setInterval(() => {
            if (Math.random() > 0.7) { // 30% chance
                const particle = document.createElement('div');
                particle.className = 'particle';
                
                // Random position around the edge
                const angle = Math.random() * Math.PI * 2;
                const distance = 80;
                const x = Math.cos(angle) * distance + 40; // 40 is half of 80px ghost zone width
                const y = Math.sin(angle) * distance + 40;
                
                particle.style.left = `${x}px`;
                particle.style.top = `${y}px`;
                
                this.particlesContainer.appendChild(particle);
                
                setTimeout(() => {
                    particle.classList.add('active');
                }, 10);
                
                setTimeout(() => {
                    particle.remove();
                }, 2000);
            }
        }, 5000); // Increased to 5000ms to reduce CPU usage
    }
    
    showSuccess() {
        if (!this.successRipple) {
            this.successRipple = document.getElementById('successRipple');
        }
        
        if (this.successRipple) {
            this.successRipple.classList.remove('active');
            
            // Force reflow
            void this.successRipple.offsetWidth;
            
            this.successRipple.classList.add('active');
            
            setTimeout(() => {
                this.successRipple.classList.remove('active');
            }, 600);
        }
    }
    
    showStatus(text, isError = false) {
        // Clear any existing timeout first
        if (this.statusTimeout) {
            clearTimeout(this.statusTimeout);
            this.statusTimeout = null;
        }
        
        this.statusText.textContent = text;
        this.statusText.classList.add('visible');
        
        if (isError) {
            this.statusText.classList.add('error');
        } else {
            this.statusText.classList.remove('error');
        }
        
        // Auto hide after 3 seconds
        this.statusTimeout = setTimeout(() => {
            this.hideStatus();
        }, 3000);
    }
    
    hideStatus() {
        // Clear any pending timeout
        if (this.statusTimeout) {
            clearTimeout(this.statusTimeout);
            this.statusTimeout = null;
        }
        
        // Remove the visible class
        if (this.statusText) {
            this.statusText.classList.remove('visible');
            this.statusText.classList.remove('error');
            // Clear the text after animation completes
            setTimeout(() => {
                if (this.statusText) {
                    this.statusText.textContent = '';
                }
            }, 300);
        }
    }
    
    setOpacity(value) {
        document.body.style.opacity = value;
    }
    
    setupContextMenu() {
        // Context menu removed in the redesign for cleaner UX
        console.log('Context menu setup skipped - removed in redesign');
        
        // Just prevent default context menu
        document.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });
    }
    
    // Helper methods
    truncateText(text, maxLength) {
        if (!text || text.length <= maxLength) return text;
        return text.substring(0, maxLength) + '...';
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
    
    getFileIcon(fileName) {
        const ext = fileName.split('.').pop().toLowerCase();
        const iconMap = {
            // Documents
            'pdf': '📄', 'doc': '📄', 'docx': '📄', 'txt': '📝', 'rtf': '📄',
            // Images
            'jpg': '🖼️', 'jpeg': '🖼️', 'png': '🖼️', 'gif': '🖼️', 'svg': '🖼️', 'webp': '🖼️',
            // Videos
            'mp4': '🎬', 'avi': '🎬', 'mov': '🎬', 'wmv': '🎬', 'mkv': '🎬',
            // Audio
            'mp3': '🎵', 'wav': '🎵', 'flac': '🎵', 'aac': '🎵', 'ogg': '🎵',
            // Code
            'js': '💻', 'ts': '💻', 'py': '💻', 'java': '💻', 'cpp': '💻', 'html': '🌐', 'css': '🎨',
            // Archives
            'zip': '📦', 'rar': '📦', '7z': '📦', 'tar': '📦', 'gz': '📦'
        };
        return iconMap[ext] || '📎';
    }
}

// Initialize widget with better error handling
let widget = null;

function initializeWidget() {
    try {
        console.log('=== BLACK HOLE INITIALIZATION START ===');
        console.log('DOM State:', document.readyState);
        console.log('Body exists:', !!document.body);
        console.log('Modal element exists:', !!document.getElementById('spaceModal'));
        
        // Check IPC availability
        console.log('Black Hole: window.electron available:', !!window.electron);
        console.log('Black Hole: window.electron.ipcRenderer available:', !!(window.electron && window.electron.ipcRenderer));
        console.log('Black Hole: window.electron.ipcRenderer.send available:', !!(window.electron && window.electron.ipcRenderer && window.electron.ipcRenderer.send));
        console.log('Black Hole: window.electron.ipcRenderer.on available:', !!(window.electron && window.electron.ipcRenderer && window.electron.ipcRenderer.on));
        console.log('Black Hole: window.electron.on available:', !!(window.electron && window.electron.on));
        
        widget = new BlackHoleWidget();
        
        // Make widget available globally for debugging
        window.blackHoleWidget = widget;
        
        // Force modal setup after a small delay to ensure DOM is settled
        setTimeout(() => {
            if (!widget.modal) {
                console.log('Black Hole: Modal not ready after init, forcing setup...');
                widget.setupModal();
            }
            console.log('Black Hole: Final modal state:', !!widget.modal);
        }, 100);
        
        console.log('=== BLACK HOLE INITIALIZATION COMPLETE ===');
    } catch (error) {
        console.error('Black Hole: Failed to initialize widget:', error);
        console.error('Stack:', error.stack);
        
        // Retry after a delay
        setTimeout(() => {
            console.log('Black Hole: Retrying initialization...');
            initializeWidget();
        }, 500);
    }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeWidget);
} else {
    // DOM is already ready
    initializeWidget();
}

// Also try on window load as backup
window.addEventListener('load', () => {
    if (!widget) {
        console.log('Black Hole: Widget not initialized on window load, initializing now...');
        initializeWidget();
    }
}); 