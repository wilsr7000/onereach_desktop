/**
 * SpaceAssetPicker - Modal for browsing and selecting assets from Spaces
 * 
 * Features:
 * - Space dropdown selector
 * - Filter by media type (audio/video/all)
 * - Thumbnail/waveform preview
 * - Search within space
 * - Recent items shortcut
 */

export class SpaceAssetPicker {
  constructor(appContext) {
    this.app = appContext;
    this.modalElement = null;
    this.isVisible = false;
    
    // State
    this.spaces = [];
    this.selectedSpaceId = null;
    this.items = [];
    this.filteredItems = [];
    this.mediaType = 'all'; // 'audio', 'video', 'all'
    this.searchQuery = '';
    this.selectedItem = null;
    this.onSelectCallback = null;
    this.targetTrackId = null;
    
    // Create modal on construction
    this._createModal();
  }

  /**
   * Create the modal DOM structure
   */
  _createModal() {
    // Check if modal already exists
    this.modalElement = document.getElementById('spaceAssetPickerModal');
    
    if (!this.modalElement) {
      this.modalElement = document.createElement('div');
      this.modalElement.id = 'spaceAssetPickerModal';
      this.modalElement.className = 'modal-overlay space-asset-picker-overlay';
      this.modalElement.innerHTML = this._getModalHTML();
      document.body.appendChild(this.modalElement);
      
      // Add styles if not already present
      this._addStyles();
    }
    
    this._setupEventListeners();
  }

  /**
   * Get modal HTML template
   */
  _getModalHTML() {
    return `
      <div class="modal-content space-asset-picker-modal">
        <div class="modal-header">
          <h3 class="modal-title">
            <span class="modal-icon">📥</span>
            Import from Space
          </h3>
          <button class="modal-close-btn" data-action="close">&times;</button>
        </div>
        
        <div class="modal-body">
          <!-- Controls Row -->
          <div class="picker-controls">
            <div class="picker-control-group">
              <label for="spaceSelector">Space:</label>
              <select id="spaceSelector" class="picker-select">
                <option value="">Select a Space...</option>
              </select>
            </div>
            
            <div class="picker-control-group">
              <label for="mediaTypeFilter">Type:</label>
              <select id="mediaTypeFilter" class="picker-select">
                <option value="all">All Media</option>
                <option value="audio">Audio Only</option>
                <option value="video">Video Only</option>
              </select>
            </div>
            
            <div class="picker-control-group picker-search">
              <input type="text" id="assetSearchInput" class="picker-input" placeholder="Search assets...">
            </div>
          </div>
          
          <!-- Items Grid -->
          <div class="picker-items-container">
            <div id="pickerItemsGrid" class="picker-items-grid">
              <div class="picker-empty-state">
                <span class="picker-empty-icon">📂</span>
                <span class="picker-empty-text">Select a Space to browse assets</span>
              </div>
            </div>
          </div>
          
          <!-- Selected Item Preview -->
          <div id="pickerPreview" class="picker-preview hidden">
            <div class="preview-thumbnail" id="previewThumbnail"></div>
            <div class="preview-info">
              <div class="preview-name" id="previewName">-</div>
              <div class="preview-meta" id="previewMeta">-</div>
            </div>
          </div>
        </div>
        
        <div class="modal-footer">
          <button class="btn btn-secondary" data-action="cancel">Cancel</button>
          <button class="btn btn-primary" data-action="import" id="importBtn" disabled>
            <span class="btn-icon">📥</span>
            Import Selected
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Add component styles
   */
  _addStyles() {
    if (document.getElementById('spaceAssetPickerStyles')) return;
    
    const styleSheet = document.createElement('style');
    styleSheet.id = 'spaceAssetPickerStyles';
    styleSheet.textContent = `
      .space-asset-picker-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
        opacity: 0;
        visibility: hidden;
        transition: opacity 0.2s, visibility 0.2s;
      }
      
      .space-asset-picker-overlay.visible {
        opacity: 1;
        visibility: visible;
      }
      
      .space-asset-picker-modal {
        background: var(--bg-primary, #1a1a2e);
        border-radius: 12px;
        width: 90%;
        max-width: 800px;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
        border: 1px solid var(--border-color, #333);
      }
      
      .space-asset-picker-modal .modal-header {
        padding: 16px 20px;
        border-bottom: 1px solid var(--border-color, #333);
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      
      .space-asset-picker-modal .modal-title {
        margin: 0;
        font-size: 18px;
        color: var(--text-primary, #fff);
        display: flex;
        align-items: center;
        gap: 8px;
      }
      
      .space-asset-picker-modal .modal-icon {
        font-size: 20px;
      }
      
      .space-asset-picker-modal .modal-close-btn {
        background: none;
        border: none;
        color: var(--text-secondary, #888);
        font-size: 24px;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
        transition: background 0.2s, color 0.2s;
      }
      
      .space-asset-picker-modal .modal-close-btn:hover {
        background: var(--bg-hover, #333);
        color: var(--text-primary, #fff);
      }
      
      .space-asset-picker-modal .modal-body {
        padding: 16px 20px;
        flex: 1;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      
      .picker-controls {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
      }
      
      .picker-control-group {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      
      .picker-control-group label {
        font-size: 12px;
        color: var(--text-secondary, #888);
        font-weight: 500;
      }
      
      .picker-select, .picker-input {
        padding: 8px 12px;
        border-radius: 6px;
        border: 1px solid var(--border-color, #333);
        background: var(--bg-secondary, #252540);
        color: var(--text-primary, #fff);
        font-size: 14px;
        min-width: 150px;
      }
      
      .picker-select:focus, .picker-input:focus {
        outline: none;
        border-color: var(--accent-color, #4a9eff);
      }
      
      .picker-search {
        flex: 1;
        min-width: 200px;
      }
      
      .picker-search .picker-input {
        width: 100%;
      }
      
      .picker-items-container {
        flex: 1;
        overflow-y: auto;
        border: 1px solid var(--border-color, #333);
        border-radius: 8px;
        background: var(--bg-secondary, #252540);
        min-height: 200px;
      }
      
      .picker-items-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
        gap: 12px;
        padding: 12px;
      }
      
      .picker-item {
        background: var(--bg-primary, #1a1a2e);
        border: 2px solid transparent;
        border-radius: 8px;
        padding: 8px;
        cursor: pointer;
        transition: border-color 0.2s, background 0.2s;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
      }
      
      .picker-item:hover {
        background: var(--bg-hover, #333);
        border-color: var(--border-color, #444);
      }
      
      .picker-item.selected {
        border-color: var(--accent-color, #4a9eff);
        background: rgba(74, 158, 255, 0.1);
      }
      
      .picker-item-thumbnail {
        width: 100%;
        aspect-ratio: 16/9;
        background: var(--bg-secondary, #252540);
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 32px;
        overflow: hidden;
      }
      
      .picker-item-thumbnail img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      
      .picker-item-name {
        font-size: 12px;
        color: var(--text-primary, #fff);
        text-align: center;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        width: 100%;
      }
      
      .picker-item-meta {
        font-size: 10px;
        color: var(--text-secondary, #888);
        display: flex;
        gap: 8px;
      }
      
      .picker-empty-state {
        grid-column: 1 / -1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 40px;
        color: var(--text-secondary, #888);
        gap: 8px;
      }
      
      .picker-empty-icon {
        font-size: 48px;
        opacity: 0.5;
      }
      
      .picker-empty-text {
        font-size: 14px;
      }
      
      .picker-preview {
        display: flex;
        gap: 12px;
        padding: 12px;
        background: var(--bg-secondary, #252540);
        border-radius: 8px;
        align-items: center;
      }
      
      .picker-preview.hidden {
        display: none;
      }
      
      .preview-thumbnail {
        width: 80px;
        height: 45px;
        background: var(--bg-primary, #1a1a2e);
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 24px;
        overflow: hidden;
      }
      
      .preview-thumbnail img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      
      .preview-info {
        flex: 1;
      }
      
      .preview-name {
        font-weight: 500;
        color: var(--text-primary, #fff);
      }
      
      .preview-meta {
        font-size: 12px;
        color: var(--text-secondary, #888);
        margin-top: 4px;
      }
      
      .space-asset-picker-modal .modal-footer {
        padding: 16px 20px;
        border-top: 1px solid var(--border-color, #333);
        display: flex;
        justify-content: flex-end;
        gap: 12px;
      }
      
      .space-asset-picker-modal .btn {
        padding: 10px 20px;
        border-radius: 6px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.2s, opacity 0.2s;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      
      .space-asset-picker-modal .btn-secondary {
        background: var(--bg-secondary, #252540);
        border: 1px solid var(--border-color, #333);
        color: var(--text-primary, #fff);
      }
      
      .space-asset-picker-modal .btn-secondary:hover {
        background: var(--bg-hover, #333);
      }
      
      .space-asset-picker-modal .btn-primary {
        background: var(--accent-color, #4a9eff);
        border: none;
        color: white;
      }
      
      .space-asset-picker-modal .btn-primary:hover {
        background: var(--accent-hover, #3a8eef);
      }
      
      .space-asset-picker-modal .btn-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      
      .picker-loading {
        grid-column: 1 / -1;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 40px;
        color: var(--text-secondary, #888);
      }
      
      .picker-loading::after {
        content: '';
        width: 24px;
        height: 24px;
        border: 2px solid var(--border-color, #333);
        border-top-color: var(--accent-color, #4a9eff);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
        margin-left: 12px;
      }
      
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(styleSheet);
  }

  /**
   * Setup event listeners
   */
  _setupEventListeners() {
    if (!this.modalElement) return;
    
    // Close button and cancel
    this.modalElement.addEventListener('click', (e) => {
      const action = e.target.dataset?.action || e.target.closest('[data-action]')?.dataset?.action;
      
      if (action === 'close' || action === 'cancel') {
        this.hide();
      } else if (action === 'import') {
        this._handleImport();
      }
      
      // Close on backdrop click
      if (e.target === this.modalElement) {
        this.hide();
      }
    });
    
    // Space selector
    const spaceSelector = this.modalElement.querySelector('#spaceSelector');
    if (spaceSelector) {
      spaceSelector.addEventListener('change', (e) => {
        this.selectedSpaceId = e.target.value;
        this._loadSpaceItems();
      });
    }
    
    // Media type filter
    const mediaTypeFilter = this.modalElement.querySelector('#mediaTypeFilter');
    if (mediaTypeFilter) {
      mediaTypeFilter.addEventListener('change', (e) => {
        this.mediaType = e.target.value;
        this._filterItems();
      });
    }
    
    // Search input
    const searchInput = this.modalElement.querySelector('#assetSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value.toLowerCase();
        this._filterItems();
      });
    }
    
    // Escape key to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isVisible) {
        this.hide();
      }
    });
  }

  /**
   * Show the picker modal
   * @param {Object} options - Configuration options
   */
  async show(options = {}) {
    const { mediaType = 'all', trackId = null, onSelect = null } = options;
    
    this.mediaType = mediaType;
    this.targetTrackId = trackId;
    this.onSelectCallback = onSelect;
    this.selectedItem = null;
    
    // Update media type filter
    const mediaTypeFilter = this.modalElement.querySelector('#mediaTypeFilter');
    if (mediaTypeFilter) {
      mediaTypeFilter.value = mediaType;
    }
    
    // Update import button state
    this._updateImportButton();
    
    // Load spaces
    await this._loadSpaces();
    
    // Show modal
    this.modalElement.classList.add('visible');
    this.isVisible = true;
    
    // Focus search input
    setTimeout(() => {
      const searchInput = this.modalElement.querySelector('#assetSearchInput');
      searchInput?.focus();
    }, 100);
  }

  /**
   * Hide the picker modal
   */
  hide() {
    this.modalElement.classList.remove('visible');
    this.isVisible = false;
    this.selectedItem = null;
    this.onSelectCallback = null;
    
    // Clear search
    const searchInput = this.modalElement.querySelector('#assetSearchInput');
    if (searchInput) searchInput.value = '';
    this.searchQuery = '';
  }

  /**
   * Load available spaces
   */
  async _loadSpaces() {
    try {
      this.spaces = await window.spaces?.getAll() || [];
      
      const spaceSelector = this.modalElement.querySelector('#spaceSelector');
      if (spaceSelector) {
        spaceSelector.innerHTML = '<option value="">Select a Space...</option>' +
          this.spaces.map(space => 
            `<option value="${space.id}">${this._escapeHtml(space.name)}</option>`
          ).join('');
        
        // Auto-select if only one space
        if (this.spaces.length === 1) {
          spaceSelector.value = this.spaces[0].id;
          this.selectedSpaceId = this.spaces[0].id;
          this._loadSpaceItems();
        }
      }
    } catch (error) {
      console.error('[SpaceAssetPicker] Error loading spaces:', error);
      this.app.showToast?.('error', 'Failed to load Spaces');
    }
  }

  /**
   * Load items from selected space
   */
  async _loadSpaceItems() {
    if (!this.selectedSpaceId) {
      this._renderEmptyState('Select a Space to browse assets');
      return;
    }
    
    // Show loading
    const grid = this.modalElement.querySelector('#pickerItemsGrid');
    if (grid) {
      grid.innerHTML = '<div class="picker-loading">Loading assets</div>';
    }
    
    try {
      // Get items based on media type filter
      if (this.mediaType === 'audio') {
        this.items = await window.spaces?.getAudio(this.selectedSpaceId) || [];
      } else if (this.mediaType === 'video') {
        this.items = await window.spaces?.getVideos(this.selectedSpaceId) || [];
      } else {
        const result = await window.spaces?.getItems(this.selectedSpaceId);
        // Handle both { success, items } format and raw array format
        this.items = (result && result.items) ? result.items : (Array.isArray(result) ? result : []);
        // Filter to only media files
        this.items = this.items.filter(item => 
          item.fileType === 'audio' || 
          item.fileType === 'video' ||
          /\.(mp3|wav|m4a|aac|ogg|flac|mp4|mov|avi|mkv|webm)$/i.test(item.content || '')
        );
      }
      
      this._filterItems();
    } catch (error) {
      console.error('[SpaceAssetPicker] Error loading items:', error);
      this._renderEmptyState('Failed to load assets');
    }
  }

  /**
   * Filter items based on search query
   */
  _filterItems() {
    if (!this.searchQuery) {
      this.filteredItems = [...this.items];
    } else {
      this.filteredItems = this.items.filter(item => {
        const name = (item.name || item.content || '').toLowerCase();
        const description = (item.description || '').toLowerCase();
        return name.includes(this.searchQuery) || description.includes(this.searchQuery);
      });
    }
    
    this._renderItems();
  }

  /**
   * Render items grid
   */
  _renderItems() {
    const grid = this.modalElement.querySelector('#pickerItemsGrid');
    if (!grid) return;
    
    if (this.filteredItems.length === 0) {
      this._renderEmptyState(
        this.searchQuery 
          ? 'No assets match your search' 
          : 'No media assets in this Space'
      );
      return;
    }
    
    grid.innerHTML = this.filteredItems.map(item => this._renderItem(item)).join('');
    
    // Add click handlers
    grid.querySelectorAll('.picker-item').forEach(el => {
      el.addEventListener('click', () => {
        const itemId = el.dataset.itemId;
        this._selectItem(itemId);
      });
      
      // Double-click to import
      el.addEventListener('dblclick', () => {
        const itemId = el.dataset.itemId;
        this._selectItem(itemId);
        this._handleImport();
      });
    });
  }

  /**
   * Render a single item
   */
  _renderItem(item) {
    const isAudio = item.fileType === 'audio' || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(item.content || '');
    const isVideo = item.fileType === 'video' || /\.(mp4|mov|avi|mkv|webm)$/i.test(item.content || '');
    const icon = isAudio ? '🎵' : isVideo ? '🎬' : '📄';
    const name = item.name || item.content?.split('/').pop() || 'Unnamed';
    const fileSize = item.fileSize ? this._formatFileSize(item.fileSize) : '';
    const isSelected = this.selectedItem?.id === item.id;
    
    return `
      <div class="picker-item ${isSelected ? 'selected' : ''}" data-item-id="${item.id}">
        <div class="picker-item-thumbnail">
          ${item.thumbnail 
            ? `<img src="${item.thumbnail}" alt="${this._escapeHtml(name)}">`
            : icon
          }
        </div>
        <div class="picker-item-name" title="${this._escapeHtml(name)}">${this._escapeHtml(name)}</div>
        <div class="picker-item-meta">
          <span>${isAudio ? 'Audio' : isVideo ? 'Video' : 'Media'}</span>
          ${fileSize ? `<span>${fileSize}</span>` : ''}
        </div>
      </div>
    `;
  }

  /**
   * Render empty state
   */
  _renderEmptyState(message) {
    const grid = this.modalElement.querySelector('#pickerItemsGrid');
    if (grid) {
      grid.innerHTML = `
        <div class="picker-empty-state">
          <span class="picker-empty-icon">📂</span>
          <span class="picker-empty-text">${this._escapeHtml(message)}</span>
        </div>
      `;
    }
    
    // Hide preview
    const preview = this.modalElement.querySelector('#pickerPreview');
    if (preview) preview.classList.add('hidden');
  }

  /**
   * Select an item
   */
  _selectItem(itemId) {
    // Update selection
    this.selectedItem = this.filteredItems.find(item => item.id === itemId);
    
    // Update UI
    this.modalElement.querySelectorAll('.picker-item').forEach(el => {
      el.classList.toggle('selected', el.dataset.itemId === itemId);
    });
    
    // Update preview
    this._updatePreview();
    
    // Update import button
    this._updateImportButton();
  }

  /**
   * Update preview panel
   */
  _updatePreview() {
    const preview = this.modalElement.querySelector('#pickerPreview');
    const thumbnailEl = this.modalElement.querySelector('#previewThumbnail');
    const nameEl = this.modalElement.querySelector('#previewName');
    const metaEl = this.modalElement.querySelector('#previewMeta');
    
    if (!preview) return;
    
    if (!this.selectedItem) {
      preview.classList.add('hidden');
      return;
    }
    
    preview.classList.remove('hidden');
    
    const item = this.selectedItem;
    const isAudio = item.fileType === 'audio' || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(item.content || '');
    const isVideo = item.fileType === 'video' || /\.(mp4|mov|avi|mkv|webm)$/i.test(item.content || '');
    const icon = isAudio ? '🎵' : isVideo ? '🎬' : '📄';
    const name = item.name || item.content?.split('/').pop() || 'Unnamed';
    
    if (thumbnailEl) {
      thumbnailEl.innerHTML = item.thumbnail 
        ? `<img src="${item.thumbnail}" alt="${this._escapeHtml(name)}">`
        : icon;
    }
    
    if (nameEl) {
      nameEl.textContent = name;
    }
    
    if (metaEl) {
      const parts = [];
      if (isAudio) parts.push('Audio');
      else if (isVideo) parts.push('Video');
      if (item.fileSize) parts.push(this._formatFileSize(item.fileSize));
      if (item.duration) parts.push(this._formatDuration(item.duration));
      metaEl.textContent = parts.join(' • ');
    }
  }

  /**
   * Update import button state
   */
  _updateImportButton() {
    const importBtn = this.modalElement.querySelector('#importBtn');
    if (importBtn) {
      importBtn.disabled = !this.selectedItem;
    }
  }

  /**
   * Handle import action
   */
  async _handleImport() {
    if (!this.selectedItem) return;
    
    try {
      // Get the file path for the selected item
      const filePath = await window.spaces?.getItemPath(this.selectedItem.id);
      
      if (!filePath) {
        throw new Error('Could not get file path');
      }
      
      // Create asset object
      const asset = {
        id: this.selectedItem.id,
        name: this.selectedItem.name || this.selectedItem.content?.split('/').pop() || 'Unnamed',
        path: filePath,
        type: this.selectedItem.fileType,
        source: 'space',
        spaceId: this.selectedSpaceId,
        startTime: this.app.video?.currentTime || 0
      };
      
      // Call the callback
      if (this.onSelectCallback) {
        this.onSelectCallback(asset);
      }
      
      this.app.showToast?.('success', `Imported "${asset.name}"`);
      this.hide();
      
    } catch (error) {
      console.error('[SpaceAssetPicker] Import error:', error);
      this.app.showToast?.('error', 'Failed to import asset');
    }
  }

  /**
   * Format file size
   */
  _formatFileSize(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }

  /**
   * Format duration in seconds to MM:SS
   */
  _formatDuration(seconds) {
    if (!seconds) return '';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Escape HTML entities
   */
  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }
}

// Export for module usage
export default SpaceAssetPicker;












