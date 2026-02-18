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
    this.spaceList = document.getElementById('spaceList');
    this.confirmBtn = document.getElementById('confirmBtn');
    this.cancelBtn = document.getElementById('cancelBtn');
    this.modalCloseBtn = document.getElementById('modalCloseBtn');
    this.contentPreview = document.getElementById('contentPreview');
    this.contentPreviewType = document.getElementById('contentPreviewType');
    this.contentPreviewText = document.getElementById('contentPreviewText');
    this.savingIndicator = document.getElementById('savingIndicator');
    this.modalActions = document.getElementById('modalActions');
    this.spaceSearchInput = document.getElementById('spaceSearchInput');
    this.spaceCountBadge = document.getElementById('spaceCountBadge');
    this.recentSpacesList = document.getElementById('recentSpacesList');

    // State
    this.spaces = [];
    this.recentSpaceIds = [];
    this.selectedSpaceId = null;
    this.pendingItem = null;
    this.isReady = false;
    this.startExpanded = false;
    this.isClosing = false;
    this.searchQuery = '';
    this.searchDebounceTimer = null;

    // Load recent spaces from localStorage
    this.loadRecentSpaces();

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
              textPreview: clipboardData?.text?.substring(0, 50),
            });

            if (clipboardData && (clipboardData.hasText || clipboardData.hasImage || clipboardData.hasHtml)) {
              await this.processClipboardData(clipboardData);
              console.log(
                '[BlackHole] pendingItem after processing:',
                this.pendingItem ? this.pendingItem.type : 'null'
              );
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

  loadRecentSpaces() {
    try {
      const stored = localStorage.getItem('blackhole-recent-spaces');
      this.recentSpaceIds = stored ? JSON.parse(stored) : [];
      console.log('[BlackHole] Loaded recent spaces:', this.recentSpaceIds.length);
    } catch (e) {
      console.error('[BlackHole] Failed to load recent spaces:', e);
      this.recentSpaceIds = [];
    }
  }

  saveRecentSpaces() {
    try {
      localStorage.setItem('blackhole-recent-spaces', JSON.stringify(this.recentSpaceIds));
    } catch (e) {
      console.error('[BlackHole] Failed to save recent spaces:', e);
    }
  }

  addToRecentSpaces(spaceId) {
    // Remove if already exists
    this.recentSpaceIds = this.recentSpaceIds.filter((id) => id !== spaceId);
    // Add to front
    this.recentSpaceIds.unshift(spaceId);
    // Keep only last 5
    this.recentSpaceIds = this.recentSpaceIds.slice(0, 5);
    this.saveRecentSpaces();
  }

  setupEventHandlers() {
    console.log('[BlackHole] Setting up event handlers...');

    // Debug: check which elements were found
    const foundElements = {
      confirmBtn: !!this.confirmBtn,
      cancelBtn: !!this.cancelBtn,
      modalCloseBtn: !!this.modalCloseBtn,
      modal: !!this.modal,
      spaceGrid: !!this.spaceGrid,
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

    // Space search input
    if (this.spaceSearchInput) {
      this.spaceSearchInput.addEventListener('input', (e) => {
        this.handleSpaceSearch(e.target.value);
      });
      // Clear search on focus if empty
      this.spaceSearchInput.addEventListener('focus', () => {
        if (this.spaceSearchInput.value === '') {
          this.searchQuery = '';
        }
      });
    }

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
        this.sendIPC('black-hole:debug', {
          event: 'RECEIVED_INIT',
          startExpanded: data?.startExpanded,
          hasClipboardData: !!data?.clipboardData,
        });

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

      // Handler for external file drop from downloads (H1 - was MISSING)
      // Note: receive() strips the event, so we just get data directly
      window.api.receive('external-file-drop', async (data) => {
        console.log('[BlackHole] Received external-file-drop:', data);
        this.sendIPC('black-hole:debug', { event: 'EXTERNAL_FILE_DROP', fileName: data?.fileName });

        if (data && data.fileData) {
          this.pendingItem = {
            type: 'file',
            data: {
              fileName: data.fileName,
              fileSize: data.fileSize,
              fileType: data.mimeType,
              mimeType: data.mimeType, // Pass mimeType separately for thumbnail generation
              fileData: data.fileData, // Pass raw base64, NOT data URL
            },
            preview: data.fileName,
            previewType: 'Downloaded File',
          };
          this.showModal();
        }
      });

      // Handler for prepare-for-download (H2 - was MISSING)
      // Note: receive() strips the event, so we just get data directly
      window.api.receive('prepare-for-download', async (data) => {
        console.log('[BlackHole] Preparing for download:', data?.fileName);
        this.sendIPC('black-hole:debug', { event: 'PREPARE_FOR_DOWNLOAD', fileName: data?.fileName });
        // Ensure spaces are loaded
        if (this.spaces.length === 0) {
          await this.loadSpaces();
        }
      });

      // Handler for check-widget-ready (H3 - was MISSING)
      // Note: receive() strips the event, so we get no arguments
      window.api.receive('check-widget-ready', async () => {
        console.log('[BlackHole] Check-widget-ready, isReady:', this.isReady);
        if (this.isReady) {
          this.sendIPC('black-hole:widget-ready');
        }
      });

      console.log('[BlackHole] IPC handlers registered successfully (including external-file-drop)');
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
        previewType: 'Image',
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
        previewType: 'Rich Text',
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
        youtubeUrl: isYouTube ? text : null,
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
        youtubeUrl: isYouTube ? text : null,
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
              previewType: 'Image',
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
        youtubeUrl: isYouTube ? text.trim() : null,
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
        // Extract raw base64 from data URL (strip the "data:mime/type;base64," prefix)
        const dataUrl = evt.target.result;
        const base64Data = dataUrl.split(',')[1] || dataUrl;

        this.pendingItem = {
          type: 'file',
          data: {
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type,
            mimeType: file.type, // Pass mimeType separately for thumbnail generation
            fileData: base64Data, // Pass raw base64, NOT data URL
          },
          preview: file.name,
          previewType: 'File',
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
        youtubeUrl: isYouTube ? text.trim() : null,
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

    // Expand window - increase height for search and more spaces
    this.sendIPC('black-hole:resize-window', { width: 500, height: 720 });
    this.sendIPC('black-hole:active');

    // Reset search
    this.searchQuery = '';
    if (this.spaceSearchInput) {
      this.spaceSearchInput.value = '';
    }

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

  renderRecentSpaces() {
    if (!this.recentSpacesList) return;

    // Get recent spaces that still exist
    const recentSpaces = this.recentSpaceIds
      .map((id) => this.spaces.find((s) => s.id === id))
      .filter(Boolean)
      .slice(0, 4);

    if (recentSpaces.length === 0) {
      this.recentSpacesList.innerHTML = '<span class="no-recent">No recent spaces</span>';
      return;
    }

    this.recentSpacesList.innerHTML = recentSpaces
      .map(
        (space) => `
            <div class="recent-space-chip ${this.selectedSpaceId === space.id ? 'selected' : ''}" data-space-id="${space.id}">
                <span class="chip-icon">${space.icon || '📁'}</span>
                <span class="chip-name">${this.escapeHtml(space.name)}</span>
            </div>
        `
      )
      .join('');

    // Add click handlers
    const chips = this.recentSpacesList.querySelectorAll('.recent-space-chip');
    chips.forEach((chip) => {
      chip.addEventListener('click', () => {
        const spaceId = chip.getAttribute('data-space-id');
        console.log('[BlackHole] Recent space clicked:', spaceId);
        this.selectSpace(spaceId);
      });
    });
  }

  renderSpaces() {
    if (!this.spaceList) {
      console.error('[BlackHole] spaceList element not found');
      return;
    }

    // Render recent spaces first
    this.renderRecentSpaces();

    // Filter spaces based on search query
    let filteredSpaces = this.spaces;
    if (this.searchQuery) {
      const query = this.searchQuery.toLowerCase();
      filteredSpaces = this.spaces.filter((space) => space.name.toLowerCase().includes(query));
    }

    console.log('[BlackHole] Rendering', filteredSpaces.length, 'of', this.spaces.length, 'spaces');

    // Update count badge
    if (this.spaceCountBadge) {
      if (this.searchQuery) {
        this.spaceCountBadge.textContent = `${filteredSpaces.length} of ${this.spaces.length}`;
      } else {
        this.spaceCountBadge.textContent = `${this.spaces.length}`;
      }
    }

    // Show empty state or list
    if (filteredSpaces.length === 0) {
      this.spaceList.innerHTML = `
                <div class="space-empty-state">
                    <div class="icon">🔍</div>
                    <div class="message">No spaces found</div>
                </div>
            `;
      return;
    }

    // Sort alphabetically
    filteredSpaces.sort((a, b) => a.name.localeCompare(b.name));

    this.spaceList.innerHTML =
      filteredSpaces
        .map(
          (space) => `
            <div class="space-list-item ${this.selectedSpaceId === space.id ? 'selected' : ''}" data-space-id="${space.id}">
                <span class="item-icon">${space.icon || '📁'}</span>
                <div class="item-info">
                    <div class="item-name" title="${this.escapeHtml(space.name)}">${this.escapeHtml(space.name)}</div>
                    <div class="item-count">${space.count || 0} items</div>
                </div>
                <span class="item-check">✓</span>
            </div>
        `
        )
        .join('') +
      `
            <!-- Create New Space Accordion -->
            <div id="createNewSpaceAccordionBlackHole" style="margin-top: 8px;">
                <div class="space-list-item create-space-header-bh" data-action="toggle-create" style="
                    border: 2px dashed rgba(99, 102, 241, 0.3);
                    background: rgba(99, 102, 241, 0.1);
                    cursor: pointer;
                    transition: all 0.2s;
                ">
                    <span class="item-icon" style="transition: transform 0.2s;">▶</span>
                    <div class="item-info">
                        <div class="item-name" style="color: rgba(99, 102, 241, 1);">Create New Space</div>
                        <div class="item-count" style="color: rgba(99, 102, 241, 0.7);">Add a new space</div>
                    </div>
                </div>
                <div class="create-space-form-bh" style="
                    display: none;
                    padding: 16px;
                    background: rgba(0, 0, 0, 0.3);
                    border-radius: 8px;
                    margin-top: 8px;
                    border: 1px solid rgba(99, 102, 241, 0.2);
                ">
                    <div style="margin-bottom: 12px;">
                        <input type="text" id="newSpaceNameBlackHole" placeholder="Enter space name..." style="
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
                        <div id="iconPickerBlackHole" style="display: flex; gap: 8px; flex-wrap: wrap;">
                            <div class="icon-option-inline-bh selected" data-icon="◆" style="
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
                            <div class="icon-option-inline-bh" data-icon="●" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">●</div>
                            <div class="icon-option-inline-bh" data-icon="■" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">■</div>
                            <div class="icon-option-inline-bh" data-icon="▲" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">▲</div>
                            <div class="icon-option-inline-bh" data-icon="◉" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">◉</div>
                            <div class="icon-option-inline-bh" data-icon="◎" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">◎</div>
                            <div class="icon-option-inline-bh" data-icon="◇" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">◇</div>
                            <div class="icon-option-inline-bh" data-icon="○" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">○</div>
                            <div class="icon-option-inline-bh" data-icon="□" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">□</div>
                            <div class="icon-option-inline-bh" data-icon="△" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(255, 255, 255, 0.1); cursor: pointer; transition: all 0.2s; border: 2px solid transparent;">△</div>
                        </div>
                    </div>
                    <div style="display: flex; gap: 8px;">
                        <button id="cancelCreateBlackHole" style="
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
                        <button id="confirmCreateBlackHole" style="
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
                        ">Create & Select</button>
                    </div>
                </div>
            </div>
        `;

    // Add click handlers
    const items = this.spaceList.querySelectorAll('.space-list-item');
    console.log('[BlackHole] Found', items.length, 'space items to attach handlers');

    // Setup accordion for "Create New Space"
    const createHeaderBH = this.spaceList.querySelector('.create-space-header-bh');
    const createFormBH = this.spaceList.querySelector('.create-space-form-bh');
    const chevronBH = createHeaderBH ? createHeaderBH.querySelector('.item-icon') : null;
    const newSpaceInputBH = document.getElementById('newSpaceNameBlackHole');
    const iconPickerBH = document.getElementById('iconPickerBlackHole');
    const cancelBtnBH = document.getElementById('cancelCreateBlackHole');
    const confirmBtnBH = document.getElementById('confirmCreateBlackHole');

    if (createHeaderBH && createFormBH) {
      // Hover effects
      createHeaderBH.addEventListener('mouseenter', () => {
        createHeaderBH.style.background = 'rgba(99, 102, 241, 0.2)';
        createHeaderBH.style.borderColor = 'rgba(99, 102, 241, 0.5)';
      });
      createHeaderBH.addEventListener('mouseleave', () => {
        createHeaderBH.style.background = 'rgba(99, 102, 241, 0.1)';
        createHeaderBH.style.borderColor = 'rgba(99, 102, 241, 0.3)';
      });

      // Toggle accordion
      createHeaderBH.addEventListener('click', () => {
        const isExpanded = createFormBH.style.display !== 'none';
        if (isExpanded) {
          createFormBH.style.display = 'none';
          if (chevronBH) chevronBH.style.transform = 'rotate(0deg)';
        } else {
          createFormBH.style.display = 'block';
          if (chevronBH) chevronBH.style.transform = 'rotate(90deg)';
          setTimeout(() => newSpaceInputBH.focus(), 100);
        }
      });

      // Icon picker selection
      if (iconPickerBH) {
        iconPickerBH.querySelectorAll('.icon-option-inline-bh').forEach((option) => {
          option.addEventListener('click', () => {
            iconPickerBH.querySelectorAll('.icon-option-inline-bh').forEach((opt) => {
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
      }

      // Cancel button
      if (cancelBtnBH) {
        cancelBtnBH.addEventListener('click', () => {
          createFormBH.style.display = 'none';
          if (chevronBH) chevronBH.style.transform = 'rotate(0deg)';
          newSpaceInputBH.value = '';
        });
      }

      // Create button - inline create
      if (confirmBtnBH) {
        confirmBtnBH.addEventListener('click', async () => {
          const name = newSpaceInputBH.value.trim();
          if (!name) {
            this.showStatus('Please enter a space name', true);
            return;
          }

          const selectedIcon = iconPickerBH.querySelector('.icon-option-inline-bh.selected');
          const icon = selectedIcon ? selectedIcon.dataset.icon : '◆';

          try {
            // Create the space inline
            const result = await window.clipboard.createSpace({ name, icon, notebook: {} });
            const newSpaceId = result?.space?.id;

            if (newSpaceId) {
              // Reload spaces
              await this.loadSpaces();

              // Select the newly created space
              this.selectSpace(newSpaceId);

              // Close the accordion
              createFormBH.style.display = 'none';
              if (chevronBH) chevronBH.style.transform = 'rotate(0deg)';
              newSpaceInputBH.value = '';

              // Re-render to show the new space
              this.renderSpaces();

              this.showStatus(`✓ Created and selected "${name}"`);
            } else {
              throw new Error('Failed to create space');
            }
          } catch (error) {
            console.error('[BlackHole] Error creating space:', error);
            this.showStatus('Failed to create space: ' + error.message, true);
          }
        });
      }

      // Enter key to submit
      if (newSpaceInputBH) {
        newSpaceInputBH.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            confirmBtnBH.click();
          } else if (e.key === 'Escape') {
            cancelBtnBH.click();
          }
        });
      }
    }

    // Regular space items
    items.forEach((item) => {
      const action = item.getAttribute('data-action');
      if (action === 'toggle-create') {
        // Already handled above
        return;
      } else {
        item.addEventListener('click', () => {
          const spaceId = item.getAttribute('data-space-id');
          console.log('[BlackHole] Space clicked:', spaceId);
          this.selectSpace(spaceId);
        });
      }
    });
    console.log('[BlackHole] Create button found:', !!createHeaderBH);

    // If current selection is not in filtered results, select first
    if (this.selectedSpaceId && !filteredSpaces.find((s) => s.id === this.selectedSpaceId)) {
      if (filteredSpaces.length > 0) {
        this.selectSpace(filteredSpaces[0].id);
      } else {
        this.selectedSpaceId = null;
        if (this.confirmBtn) this.confirmBtn.disabled = true;
      }
    }
  }

  handleSpaceSearch(query) {
    // Debounce search
    clearTimeout(this.searchDebounceTimer);
    this.searchDebounceTimer = setTimeout(() => {
      this.searchQuery = query.trim().toLowerCase();
      this.renderSpaces();
    }, 150);
  }

  selectSpace(spaceId) {
    console.log('[BlackHole] Selecting space:', spaceId);
    this.selectedSpaceId = spaceId;

    // Update list items
    if (this.spaceList) {
      const items = this.spaceList.querySelectorAll('.space-list-item');
      items.forEach((item) => {
        const isSelected = item.getAttribute('data-space-id') === spaceId;
        item.classList.toggle('selected', isSelected);
      });
    }

    // Update recent chips
    if (this.recentSpacesList) {
      const chips = this.recentSpacesList.querySelectorAll('.recent-space-chip');
      chips.forEach((chip) => {
        const isSelected = chip.getAttribute('data-space-id') === spaceId;
        chip.classList.toggle('selected', isSelected);
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
      hasYoutubeAPI: !!window.youtube,
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
        console.log(
          '[BlackHole] startBackgroundDownload:',
          window.youtube ? window.youtube.startBackgroundDownload : 'N/A'
        );

        if (window.youtube && window.youtube.startBackgroundDownload) {
          console.log('[BlackHole] Calling startBackgroundDownload...');
          const result = await window.youtube.startBackgroundDownload(item.youtubeUrl, this.selectedSpaceId);
          console.log('[BlackHole] startBackgroundDownload result:', JSON.stringify(result));

          if (result && result.success) {
            console.log('[BlackHole] YouTube download started successfully');
            this.addToRecentSpaces(this.selectedSpaceId);
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
          if (
            result &&
            result.success &&
            result.isYouTube &&
            window.youtube &&
            window.youtube.startBackgroundDownload
          ) {
            console.log('[BlackHole] Backend detected YouTube URL, starting download');
            this.addToRecentSpaces(this.selectedSpaceId);
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
        console.log('[BlackHole] SUCCESS! ItemId:', result.itemId, 'Closing modal...');
        this.addToRecentSpaces(this.selectedSpaceId);
        const space = this.spaces.find((s) => s.id === this.selectedSpaceId);
        const spaceName = space ? `${space.icon} ${space.name}` : 'Space';
        this.showStatus(`✓ Saved to ${spaceName}`);
        this.showSuccessEffect();
        this.animateAndClose(true);
      } else {
        console.error('[BlackHole] FAILED! Result:', result);

        // Show user-friendly error with error code for debugging
        const errorMessage = result?.error || 'Save failed';
        const errorCode = result?.code || null;
        this.showStatus(errorMessage, true, errorCode);
        this.resetSavingState();
      }
    } catch (err) {
      console.error('[BlackHole] EXCEPTION during save:', err);
      console.error('[BlackHole] Error stack:', err.stack);

      // Show user-friendly error message
      const errorMessage = err.message || 'An unexpected error occurred';
      this.showStatus(errorMessage, true, 'EXCEPTION');
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

      // Show success effect briefly, then close directly
      // Skip the shrink-to-bubble step to avoid position jump
      if (success) {
        this.showSuccessEffect();
      }

      // Close window after brief display of success
      // Close directly without shrinking to bubble (which caused position jump)
      setTimeout(() => {
        this.sendIPC('black-hole:inactive', { closeWindow: true });
      }, 800); // Reduced from 1200ms since we're not showing bubble

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

  showStatus(message, isError = false, errorCode = null) {
    console.log('[BlackHole] Status:', message, isError ? '(error)' : '', errorCode ? `[${errorCode}]` : '');

    if (!this.statusText) return;

    // For errors, add icon and keep visible longer
    if (isError) {
      this.statusText.textContent = `❌ ${message}`;
      this.statusText.classList.add('error');

      // Log error for debugging
      console.error('[BlackHole] Error displayed to user:', { message, errorCode });
    } else {
      this.statusText.textContent = message;
      this.statusText.classList.remove('error');
    }

    this.statusText.classList.add('visible');

    // Errors stay visible longer (5s), success messages shorter (3s)
    const duration = isError ? 5000 : 3000;

    setTimeout(() => {
      if (this.statusText) {
        this.statusText.classList.remove('visible');
      }
    }, duration);
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
