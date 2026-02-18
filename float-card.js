/**
 * Float Card - A minimal floating window for dragging items to external apps
 *
 * This card is spawned when a user clicks "Float" on a clipboard item.
 * It stays always-on-top and allows native file drag to web pages, Finder, etc.
 */

class FloatCard {
  constructor() {
    this.itemData = null;
    this.floatCard = document.getElementById('floatCard');
    this.previewArea = document.getElementById('previewArea');
    this.closeBtn = document.getElementById('closeBtn');

    this.setupEventListeners();
    this.listenForInit();
  }

  /**
   * Listen for initialization data from main process
   */
  listenForInit() {
    // Listen for item data from main process
    if (window.electron && window.electron.ipcRenderer) {
      window.electron.ipcRenderer.on('float-card:init', (event, data) => {
        console.log('[FloatCard] Received init data:', data);
        this.itemData = data;
        this.renderPreview();
      });

      // Let main process know we're ready
      window.electron.ipcRenderer.send('float-card:ready');
    } else if (window.api) {
      window.api.receive('float-card:init', (data) => {
        console.log('[FloatCard] Received init data:', data);
        this.itemData = data;
        this.renderPreview();
      });
    }
  }

  /**
   * Render the item preview based on type
   */
  renderPreview() {
    if (!this.itemData) return;

    const { type, fileType, thumbnail, fileName, _preview } = this.itemData;

    // Determine what to show
    if (thumbnail && (type === 'image' || type === 'screenshot' || fileType === 'image-file')) {
      // Show image thumbnail
      this.previewArea.innerHTML = `<img class="preview-image" src="${thumbnail}" alt="Preview">`;
    } else if (type === 'file' || fileType) {
      // Show file icon with name
      const icon = this.getFileIcon(fileType || type, fileName);
      const displayName = fileName || 'File';
      this.previewArea.innerHTML = `
                <div class="preview-file">
                    <span class="icon">${icon}</span>
                    <span class="name" title="${displayName}">${displayName}</span>
                </div>
            `;
    } else {
      // Default text/other
      const icon = this.getTypeIcon(type);
      this.previewArea.innerHTML = `<span class="preview-icon">${icon}</span>`;
    }
  }

  /**
   * Get icon for file type
   */
  getFileIcon(fileType, fileName) {
    const ext = fileName ? fileName.split('.').pop().toLowerCase() : '';

    // Video
    if (fileType === 'video' || fileType === 'video-file' || ['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) {
      return '🎬';
    }
    // Image
    if (fileType === 'image-file' || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) {
      return '🖼️';
    }
    // Audio
    if (fileType === 'audio' || ['mp3', 'wav', 'aac', 'm4a', 'ogg'].includes(ext)) {
      return '🎵';
    }
    // Document
    if (['pdf'].includes(ext)) {
      return '📕';
    }
    if (['doc', 'docx'].includes(ext)) {
      return '📝';
    }
    if (['xls', 'xlsx', 'csv'].includes(ext)) {
      return '📊';
    }
    if (['ppt', 'pptx'].includes(ext)) {
      return '📽️';
    }
    // Code
    if (['js', 'ts', 'py', 'java', 'cpp', 'c', 'go', 'rs', 'html', 'css', 'json'].includes(ext)) {
      return '💻';
    }
    // Archive
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
      return '📦';
    }

    return '📄';
  }

  /**
   * Get icon for content type
   */
  getTypeIcon(type) {
    const icons = {
      text: '📝',
      url: '🔗',
      image: '🖼️',
      screenshot: '📸',
      file: '📄',
      html: '🌐',
      code: '💻',
    };
    return icons[type] || '📋';
  }

  /**
   * Setup all event listeners
   */
  setupEventListeners() {
    // Close button
    this.closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.close();
    });

    // Native drag start
    this.floatCard.addEventListener('dragstart', async (_e) => {
      console.log('[FloatCard] Drag started');
      this.floatCard.classList.add('dragging');

      // Trigger native drag via IPC
      if (this.itemData && this.itemData.id) {
        try {
          const result = await window.electron.ipcRenderer.invoke('clipboard:start-native-drag', this.itemData.id);
          if (result && result.success) {
            console.log('[FloatCard] Native drag initiated');
          }
        } catch (err) {
          console.error('[FloatCard] Native drag error:', err);
        }
      }
    });

    // Drag end - check if successful drop happened
    this.floatCard.addEventListener('dragend', (e) => {
      console.log('[FloatCard] Drag ended, dropEffect:', e.dataTransfer.dropEffect);
      this.floatCard.classList.remove('dragging');

      // If dropped successfully (not cancelled), show success and close
      if (e.dataTransfer.dropEffect !== 'none') {
        this.showSuccess();
      }
    });

    // Window movement (hold and drag the card itself)
    let isDraggingWindow = false;
    let dragStartX, dragStartY;

    this.floatCard.addEventListener('mousedown', (e) => {
      // Don't start window drag if clicking close button
      if (e.target === this.closeBtn) return;

      // Right-click or middle-click for window movement
      if (e.button === 2 || e.button === 1) {
        isDraggingWindow = true;
        dragStartX = e.screenX;
        dragStartY = e.screenY;
        this.floatCard.classList.add('moving');
        e.preventDefault();
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (isDraggingWindow) {
        const deltaX = e.screenX - dragStartX;
        const deltaY = e.screenY - dragStartY;

        if (window.electron && window.electron.ipcRenderer) {
          window.electron.ipcRenderer.send('float-card:move', { deltaX, deltaY });
        }

        dragStartX = e.screenX;
        dragStartY = e.screenY;
      }
    });

    document.addEventListener('mouseup', () => {
      if (isDraggingWindow) {
        isDraggingWindow = false;
        this.floatCard.classList.remove('moving');
      }
    });

    // ESC to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.close();
      }
    });

    // Prevent context menu
    this.floatCard.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });
  }

  /**
   * Show success animation before closing
   */
  showSuccess() {
    this.floatCard.classList.add('success');
    setTimeout(() => {
      this.close();
    }, 400);
  }

  /**
   * Close the float card window
   */
  close() {
    console.log('[FloatCard] Attempting to close...');
    try {
      // Try direct close method first
      if (window.electron && window.electron.closeWindow) {
        console.log('[FloatCard] Using electron.closeWindow()');
        window.electron.closeWindow();
        return;
      }

      // Try IPC send methods
      if (window.electron && window.electron.ipcRenderer) {
        console.log('[FloatCard] Using electron.ipcRenderer.send');
        window.electron.ipcRenderer.send('float-card:close');
      } else if (window.electron && window.electron.send) {
        console.log('[FloatCard] Using electron.send');
        window.electron.send('float-card:close');
      } else if (window.api) {
        console.log('[FloatCard] Using api.send');
        window.api.send('float-card:close');
      } else {
        console.error('[FloatCard] No close method available!');
      }
    } catch (err) {
      console.error('[FloatCard] Error closing:', err);
    }
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.floatCard = new FloatCard();
});
