/**
 * TrackContextMenu - Right-click context menu for audio tracks
 *
 * Provides track operations like Duplicate, Delete, Rename, etc.
 */

import { positionContextMenu, hideContextMenu, buildContextMenuHTML } from '../utils/ContextMenu.js';

export class TrackContextMenu {
  constructor(appContext, adrManager) {
    this.app = appContext;
    this.adrManager = adrManager;
    this.menuElement = null;
    this.currentTrackId = null;

    this._createMenuElement();
    this._setupEventListeners();
  }

  /**
   * Create the context menu DOM element
   */
  _createMenuElement() {
    // Check if menu already exists
    this.menuElement = document.getElementById('trackContextMenu');

    if (!this.menuElement) {
      this.menuElement = document.createElement('div');
      this.menuElement.id = 'trackContextMenu';
      this.menuElement.className = 'context-menu track-context-menu';
      this.menuElement.innerHTML = '<div class="context-menu-items" id="trackContextMenuItems"></div>';
      document.body.appendChild(this.menuElement);
    }

    this.itemsContainer =
      this.menuElement.querySelector('#trackContextMenuItems') || this.menuElement.querySelector('.context-menu-items');
  }

  /**
   * Setup event listeners
   */
  _setupEventListeners() {
    // Close menu on click outside
    document.addEventListener('click', (e) => {
      if (this.menuElement && !this.menuElement.contains(e.target)) {
        this.hide();
      }
    });

    // Close on escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.hide();
      }
    });

    // Handle menu item clicks
    if (this.itemsContainer) {
      this.itemsContainer.addEventListener('click', (e) => {
        const item = e.target.closest('.context-menu-item');
        if (item && !item.classList.contains('disabled')) {
          const action = item.dataset.action;
          this._handleAction(action);
        }
      });
    }
  }

  /**
   * Show context menu for a track
   * @param {string} trackId - The track ID
   * @param {number} x - X position
   * @param {number} y - Y position
   */
  show(trackId, x, y) {
    this.currentTrackId = trackId;
    const track = this.adrManager.findTrack(trackId);

    if (!track) {
      window.logging.error('video', 'TrackContextMenu Track not found', { error: trackId });
      return;
    }

    const items = this._buildMenuItems(track);

    if (this.itemsContainer) {
      this.itemsContainer.innerHTML = buildContextMenuHTML(items);
    }

    positionContextMenu(this.menuElement, x, y);
  }

  /**
   * Hide the context menu
   */
  hide() {
    hideContextMenu(this.menuElement);
    this.currentTrackId = null;
  }

  /**
   * Build menu items based on track type
   */
  _buildMenuItems(track) {
    const items = [];
    const isOriginal = track.type === 'original';
    const displayInfo = this.adrManager.getTrackDisplayInfo(track);

    // Header
    items.push({
      type: 'header',
      label: `${track.name} (${displayInfo.label})`,
    });

    items.push({ type: 'divider' });

    // Import options - not for original track
    if (!isOriginal) {
      items.push({
        icon: '📥',
        label: 'Import from Space...',
        action: 'import-from-space',
      });

      items.push({
        icon: '📁',
        label: 'Import from File...',
        action: 'import-from-file',
      });

      items.push({ type: 'divider' });
    }

    // Duplicate - always available
    items.push({
      icon: '📋',
      label: 'Duplicate Track',
      action: 'duplicate',
      shortcut: '⌘D',
    });

    // Rename - available for non-original tracks
    items.push({
      icon: '✏️',
      label: 'Rename Track',
      action: 'rename',
      disabled: isOriginal,
    });

    items.push({ type: 'divider' });

    // Solo/Mute options
    items.push({
      icon: track.solo ? '🔊' : '🎯',
      label: track.solo ? 'Unsolo Track' : 'Solo Track',
      action: 'toggle-solo',
    });

    items.push({
      icon: track.muted ? '🔊' : '🔇',
      label: track.muted ? 'Unmute Track' : 'Mute Track',
      action: 'toggle-mute',
    });

    items.push({ type: 'divider' });

    // Track-specific actions
    if (isOriginal) {
      items.push({
        icon: '📝',
        label: 'Create Working Track',
        action: 'create-working',
      });
    }

    // Delete - not for original track
    if (!isOriginal) {
      items.push({ type: 'divider' });
      items.push({
        icon: '🗑️',
        label: 'Delete Track',
        action: 'delete',
        danger: true,
      });
    }

    return items;
  }

  /**
   * Handle menu action
   */
  _handleAction(action) {
    const trackId = this.currentTrackId;

    if (!trackId) {
      window.logging.error('video', 'TrackContextMenu No track selected');
      this.hide();
      return;
    }

    window.logging.info('video', 'TrackContextMenu Action', { action, trackId });
    const track = this.adrManager.findTrack(trackId);

    switch (action) {
      case 'import-from-space':
        this._importFromSpace(trackId, track);
        break;

      case 'import-from-file':
        this._importFromFile(trackId, track);
        break;

      case 'duplicate':
        this.adrManager.duplicateTrack(trackId);
        break;

      case 'rename':
        this._promptRename(trackId);
        break;

      case 'toggle-solo':
        this.app.toggleTrackSolo?.(trackId);
        break;

      case 'toggle-mute':
        this.app.toggleTrackMute?.(trackId);
        break;

      case 'create-working':
        this.adrManager.ensureWorkingTrack();
        break;

      case 'delete':
        this._confirmDelete(trackId);
        break;

      default:
        window.logging.warn('video', 'TrackContextMenu Unknown action', { data: action });
    }

    this.hide();
  }

  /**
   * Import audio/video from Space
   */
  _importFromSpace(trackId, track) {
    // Determine media type filter based on track type
    const mediaType = track?.type === 'sfx' || track?.type === 'music' || track?.type === 'voice' ? 'audio' : 'all';

    // Show Space Asset Picker
    if (this.app.showSpaceAssetPicker) {
      this.app.showSpaceAssetPicker({
        mediaType,
        trackId,
        onSelect: (asset) => {
          this.app.addClipToTrack?.(trackId, asset);
        },
      });
    } else if (this.app.spaceAssetPicker) {
      this.app.spaceAssetPicker.show({
        mediaType,
        trackId,
        onSelect: (asset) => {
          this.app.addClipToTrack?.(trackId, asset);
        },
      });
    } else {
      window.logging.warn('video', 'TrackContextMenu Space Asset Picker not available');
      this.app.showToast?.('error', 'Space Asset Picker not available');
    }
  }

  /**
   * Import audio/video from file system
   */
  async _importFromFile(trackId, track) {
    try {
      // Determine file type filters based on track type
      const isAudioTrack =
        track?.type === 'sfx' || track?.type === 'music' || track?.type === 'voice' || track?.type === 'adr';

      let result;
      if (isAudioTrack) {
        // Use audio file picker
        result = await window.videoEditor?.selectAudioFile?.();
      } else {
        // Use general media picker (audio + video)
        result = await window.videoEditor?.selectMediaFile?.();
      }

      if (result && !result.canceled && result.filePath) {
        // Add clip to track at current playhead position
        const currentTime = this.app.video?.currentTime || 0;
        this.app.addClipToTrack?.(trackId, {
          path: result.filePath,
          startTime: currentTime,
          source: 'file',
        });
        this.app.showToast?.('success', 'File imported to track');
      }
    } catch (error) {
      window.logging.error('video', 'TrackContextMenu Import from file error', { error: error.message || error });
      this.app.showToast?.('error', 'Failed to import file');
    }
  }

  /**
   * Prompt for track rename
   */
  _promptRename(trackId) {
    const track = this.adrManager.findTrack(trackId);
    if (!track) return;

    const newName = prompt('Enter new track name:', track.name);
    if (newName && newName.trim()) {
      track.name = newName.trim();

      // Update UI
      const nameEl = document.querySelector(`#track-${trackId} .track-name`);
      if (nameEl) {
        nameEl.textContent = track.name;
      }

      this.app.showToast?.('success', `Renamed to "${track.name}"`);
    }
  }

  /**
   * Confirm track deletion
   */
  _confirmDelete(trackId) {
    const track = this.adrManager.findTrack(trackId);
    if (!track) return;

    if (confirm(`Delete "${track.name}" track? This cannot be undone.`)) {
      this.app.removeTrack?.(trackId);
    }
  }

  /**
   * Attach context menu handler to a track label element
   * @param {HTMLElement} labelElement - The track label element
   * @param {string} trackId - The track ID
   */
  attachToLabel(labelElement, trackId) {
    if (!labelElement) return;

    labelElement.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.show(trackId, e.clientX, e.clientY);
    });
  }
}
