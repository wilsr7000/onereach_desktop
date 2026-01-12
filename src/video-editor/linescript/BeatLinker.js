/**
 * BeatLinker - Cross-video beat linking functionality
 * 
 * Features:
 * - Link beats from different videos in the same Space
 * - Link types: related, continues, references, compare
 * - Linked beat preview in mini-player
 * - Import/export beat links
 */

// Cross-platform helper to convert file path to file:// URL
function pathToFileUrl(filePath) {
  if (!filePath) return '';
  if (filePath.startsWith('file://') || filePath.startsWith('data:')) return filePath;
  let normalized = filePath.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(normalized)) normalized = '/' + normalized;
  const encoded = normalized.split('/').map(c => encodeURIComponent(c).replace(/%3A/g, ':')).join('/');
  return 'file://' + encoded;
}

// Link type definitions
export const LINK_TYPES = {
  RELATED: 'related',      // Same topic
  CONTINUES: 'continues',  // Story continuation
  REFERENCES: 'references', // Citation/callback
  COMPARE: 'compare'       // A/B comparison
};

export const LINK_TYPE_INFO = {
  [LINK_TYPES.RELATED]: { 
    label: 'Related', 
    icon: '🔗', 
    color: '#3b82f6',
    description: 'Related content on the same topic'
  },
  [LINK_TYPES.CONTINUES]: { 
    label: 'Continues', 
    icon: '➡️', 
    color: '#10b981',
    description: 'This beat continues from the linked beat'
  },
  [LINK_TYPES.REFERENCES]: { 
    label: 'References', 
    icon: '📚', 
    color: '#8b5cf6',
    description: 'This beat references/cites the linked beat'
  },
  [LINK_TYPES.COMPARE]: { 
    label: 'Compare', 
    icon: '⚖️', 
    color: '#f59e0b',
    description: 'A/B comparison with the linked beat'
  }
};

export class BeatLinker {
  constructor(appContext) {
    this.app = appContext;
    
    // Links storage - keyed by source beat ID
    this.links = new Map();
    
    // Preview state
    this.previewBeat = null;
    this.previewMiniPlayer = null;
  }

  /**
   * Initialize the linker
   */
  async init() {
    // Load existing links from project metadata
    await this._loadLinks();
    
    // Create mini player for previews
    this._createMiniPlayer();
  }

  /**
   * Load links from storage
   */
  async _loadLinks() {
    try {
      const projectLinks = await window.videoEditor?.getProjectLinks?.() || {};
      
      // Convert to Map
      Object.entries(projectLinks).forEach(([sourceId, linkData]) => {
        this.links.set(sourceId, linkData);
      });
      
      console.log('[BeatLinker] Loaded links:', this.links.size);
    } catch (error) {
      console.error('[BeatLinker] Failed to load links:', error);
    }
  }

  /**
   * Save links to storage
   */
  async _saveLinks() {
    try {
      const linksObj = Object.fromEntries(this.links);
      await window.videoEditor?.saveProjectLinks?.(linksObj);
    } catch (error) {
      console.error('[BeatLinker] Failed to save links:', error);
    }
  }

  /**
   * Create a link between two beats
   * @param {Object} source - Source beat { videoId, beatId, time }
   * @param {Object} target - Target beat { videoId, beatId, time, spaceId }
   * @param {string} linkType - One of LINK_TYPES
   * @param {Object} metadata - Additional metadata
   */
  createLink(source, target, linkType, metadata = {}) {
    if (!source?.beatId || !target?.beatId) {
      console.error('[BeatLinker] Invalid source or target');
      return null;
    }

    const link = {
      id: `link_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: linkType,
      source: {
        videoId: source.videoId || this.app.videoId,
        beatId: source.beatId,
        time: source.time || 0,
        name: source.name || ''
      },
      target: {
        videoId: target.videoId,
        beatId: target.beatId,
        time: target.time || 0,
        name: target.name || '',
        spaceId: target.spaceId
      },
      metadata: {
        ...metadata,
        createdAt: new Date().toISOString()
      }
    };

    // Store link by source beat ID
    if (!this.links.has(source.beatId)) {
      this.links.set(source.beatId, []);
    }
    this.links.get(source.beatId).push(link);

    // Save to storage
    this._saveLinks();

    console.log('[BeatLinker] Created link:', link);
    
    // Emit event
    this.app.emit?.('beatLinkCreated', link);

    return link;
  }

  /**
   * Remove a link
   */
  removeLink(linkId) {
    for (const [beatId, links] of this.links.entries()) {
      const index = links.findIndex(l => l.id === linkId);
      if (index !== -1) {
        links.splice(index, 1);
        if (links.length === 0) {
          this.links.delete(beatId);
        }
        this._saveLinks();
        this.app.emit?.('beatLinkRemoved', { linkId, beatId });
        return true;
      }
    }
    return false;
  }

  /**
   * Get all links for a beat
   */
  getLinksForBeat(beatId) {
    return this.links.get(beatId) || [];
  }

  /**
   * Get all links of a specific type
   */
  getLinksByType(linkType) {
    const result = [];
    for (const links of this.links.values()) {
      result.push(...links.filter(l => l.type === linkType));
    }
    return result;
  }

  /**
   * Check if a beat has links
   */
  hasLinks(beatId) {
    return this.links.has(beatId) && this.links.get(beatId).length > 0;
  }

  /**
   * Show beat browser for linking
   */
  async showBeatBrowser(sourceBeat, onSelect) {
    // Get videos from current space
    const currentSpaceId = this.app.currentSpaceId;
    const videos = currentSpaceId 
      ? await window.spaces?.getVideos(currentSpaceId) 
      : [];

    // Create browser modal
    this._showBrowserModal(sourceBeat, videos, onSelect);
  }

  /**
   * Show browser modal for selecting target beats
   */
  _showBrowserModal(sourceBeat, videos, onSelect) {
    // Remove existing modal
    const existing = document.getElementById('beatBrowserModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'beatBrowserModal';
    modal.className = 'modal-overlay beat-browser-overlay';
    
    modal.innerHTML = `
      <div class="modal-content beat-browser-modal">
        <div class="modal-header">
          <h3>🔗 Link to Beat</h3>
          <button class="modal-close-btn" onclick="this.closest('.modal-overlay').remove()">&times;</button>
        </div>
        
        <div class="modal-body">
          <div class="beat-browser-source">
            <span class="browser-label">From:</span>
            <span class="browser-beat-name">${this._escapeHtml(sourceBeat.name || 'Current Beat')}</span>
          </div>
          
          <div class="beat-browser-link-type">
            <label>Link Type:</label>
            <div class="link-type-options">
              ${Object.entries(LINK_TYPE_INFO).map(([type, info]) => `
                <label class="link-type-option" data-type="${type}">
                  <input type="radio" name="linkType" value="${type}" ${type === LINK_TYPES.RELATED ? 'checked' : ''}>
                  <span class="link-type-icon">${info.icon}</span>
                  <span class="link-type-label">${info.label}</span>
                </label>
              `).join('')}
            </div>
          </div>
          
          <div class="beat-browser-videos">
            <label>Select Video:</label>
            <select id="beatBrowserVideoSelect" class="browser-select">
              <option value="">Select a video...</option>
              ${videos.map(v => `
                <option value="${v.id}" data-path="${v.content}">${this._escapeHtml(v.name || 'Unnamed Video')}</option>
              `).join('')}
            </select>
          </div>
          
          <div class="beat-browser-beats" id="beatBrowserBeatsList">
            <div class="browser-empty">Select a video to see its beats</div>
          </div>
        </div>
        
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          <button class="btn btn-primary" id="beatBrowserLinkBtn" disabled>
            🔗 Create Link
          </button>
        </div>
      </div>
    `;

    // Add styles
    this._addBrowserStyles();
    
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('visible'));

    // Event handlers
    let selectedBeat = null;
    let selectedLinkType = LINK_TYPES.RELATED;

    // Video selection
    modal.querySelector('#beatBrowserVideoSelect')?.addEventListener('change', async (e) => {
      const videoId = e.target.value;
      const beatsList = modal.querySelector('#beatBrowserBeatsList');
      
      if (!videoId) {
        beatsList.innerHTML = '<div class="browser-empty">Select a video to see its beats</div>';
        return;
      }

      beatsList.innerHTML = '<div class="browser-loading">Loading beats...</div>';

      try {
        // Get beats for selected video
        const videoPath = e.target.selectedOptions[0]?.dataset.path;
        const beats = await this._loadBeatsForVideo(videoId, videoPath);
        
        if (beats.length === 0) {
          beatsList.innerHTML = '<div class="browser-empty">No beats found in this video</div>';
          return;
        }

        beatsList.innerHTML = beats.map(beat => `
          <div class="browser-beat-item" data-beat-id="${beat.id}" data-video-id="${videoId}">
            <div class="browser-beat-time">${this._formatTime(beat.time)}</div>
            <div class="browser-beat-name">${this._escapeHtml(beat.name || 'Unnamed Beat')}</div>
            <div class="browser-beat-type">${beat.type || 'beat'}</div>
          </div>
        `).join('');

        // Beat selection
        beatsList.querySelectorAll('.browser-beat-item').forEach(item => {
          item.addEventListener('click', () => {
            beatsList.querySelectorAll('.browser-beat-item').forEach(i => i.classList.remove('selected'));
            item.classList.add('selected');
            selectedBeat = beats.find(b => b.id === item.dataset.beatId);
            selectedBeat.videoId = item.dataset.videoId;
            modal.querySelector('#beatBrowserLinkBtn').disabled = false;
          });
        });

      } catch (error) {
        console.error('[BeatLinker] Failed to load beats:', error);
        beatsList.innerHTML = '<div class="browser-error">Failed to load beats</div>';
      }
    });

    // Link type selection
    modal.querySelectorAll('input[name="linkType"]').forEach(input => {
      input.addEventListener('change', (e) => {
        selectedLinkType = e.target.value;
      });
    });

    // Create link button
    modal.querySelector('#beatBrowserLinkBtn')?.addEventListener('click', () => {
      if (selectedBeat && onSelect) {
        const link = this.createLink(sourceBeat, selectedBeat, selectedLinkType);
        onSelect(link);
      }
      modal.remove();
    });
  }

  /**
   * Load beats/markers for a video
   */
  async _loadBeatsForVideo(videoId, videoPath) {
    try {
      // Try to get markers from the video's project file
      const markers = await window.videoEditor?.getVideoMarkers?.(videoPath) || [];
      return markers.map(m => ({
        id: m.id,
        name: m.name || m.label,
        time: m.time || m.inTime,
        type: m.type
      }));
    } catch (error) {
      console.error('[BeatLinker] Failed to load markers:', error);
      return [];
    }
  }

  /**
   * Create mini player for previews
   */
  _createMiniPlayer() {
    if (this.previewMiniPlayer) return;

    // Check if element exists
    let container = document.getElementById('beatPreviewMiniPlayer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'beatPreviewMiniPlayer';
      container.className = 'beat-preview-mini-player hidden';
      container.innerHTML = `
        <div class="mini-player-header">
          <span class="mini-player-title">Linked Beat Preview</span>
          <button class="mini-player-close" onclick="app.beatLinker?.hidePreview()">×</button>
        </div>
        <video class="mini-player-video" id="beatPreviewVideo"></video>
        <div class="mini-player-info">
          <span class="mini-player-beat-name" id="beatPreviewName">-</span>
          <span class="mini-player-beat-time" id="beatPreviewTime">-</span>
        </div>
      `;
      document.body.appendChild(container);
    }

    this.previewMiniPlayer = container;
  }

  /**
   * Preview a linked beat
   */
  async previewBeat(link) {
    if (!link?.target) return;

    this._createMiniPlayer();
    
    try {
      // Get video path
      const videoPath = link.target.videoPath || 
                       await window.spaces?.getVideoPath(link.target.videoId);
      
      if (!videoPath) {
        throw new Error('Could not find video file');
      }

      const video = this.previewMiniPlayer.querySelector('#beatPreviewVideo');
      const nameEl = this.previewMiniPlayer.querySelector('#beatPreviewName');
      const timeEl = this.previewMiniPlayer.querySelector('#beatPreviewTime');

      // Set video source (cross-platform)
      video.src = pathToFileUrl(videoPath);
      video.currentTime = link.target.time || 0;
      
      // Update info
      nameEl.textContent = link.target.name || 'Linked Beat';
      timeEl.textContent = this._formatTime(link.target.time);

      // Show player
      this.previewMiniPlayer.classList.remove('hidden');
      
      // Auto-play
      video.play().catch(() => {
        // Autoplay may be blocked, that's fine
      });

    } catch (error) {
      console.error('[BeatLinker] Preview error:', error);
      this.app.showToast?.('error', 'Could not preview linked beat');
    }
  }

  /**
   * Hide preview
   */
  hidePreview() {
    if (this.previewMiniPlayer) {
      this.previewMiniPlayer.classList.add('hidden');
      const video = this.previewMiniPlayer.querySelector('video');
      if (video) {
        video.pause();
        video.src = '';
      }
    }
  }

  /**
   * Render links indicator for a beat
   */
  renderLinksIndicator(beatId) {
    const links = this.getLinksForBeat(beatId);
    if (links.length === 0) return '';

    const typeIcons = links.map(l => LINK_TYPE_INFO[l.type]?.icon || '🔗').join('');
    
    return `
      <div class="beat-links-indicator" data-beat-id="${beatId}" title="${links.length} linked beat(s)">
        <span class="links-icons">${typeIcons}</span>
        <span class="links-count">${links.length}</span>
      </div>
    `;
  }

  /**
   * Add browser styles
   */
  _addBrowserStyles() {
    if (document.getElementById('beatBrowserStyles')) return;

    const styles = document.createElement('style');
    styles.id = 'beatBrowserStyles';
    styles.textContent = `
      .beat-browser-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10001;
        opacity: 0;
        transition: opacity 0.2s;
      }
      
      .beat-browser-overlay.visible {
        opacity: 1;
      }
      
      .beat-browser-modal {
        background: var(--bg-primary, #1a1a2e);
        border-radius: 12px;
        width: 90%;
        max-width: 600px;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
      }
      
      .beat-browser-source {
        padding: 12px;
        background: var(--bg-secondary, #252540);
        border-radius: 6px;
        margin-bottom: 16px;
      }
      
      .browser-label {
        color: var(--text-secondary, #888);
        font-size: 12px;
        margin-right: 8px;
      }
      
      .browser-beat-name {
        color: var(--text-primary, #fff);
        font-weight: 500;
      }
      
      .beat-browser-link-type {
        margin-bottom: 16px;
      }
      
      .beat-browser-link-type label {
        display: block;
        font-size: 12px;
        color: var(--text-secondary, #888);
        margin-bottom: 8px;
      }
      
      .link-type-options {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      
      .link-type-option {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 12px;
        background: var(--bg-secondary, #252540);
        border: 1px solid var(--border-color, #333);
        border-radius: 6px;
        cursor: pointer;
        transition: border-color 0.2s;
      }
      
      .link-type-option:has(input:checked) {
        border-color: var(--accent-color, #4a9eff);
        background: rgba(74, 158, 255, 0.1);
      }
      
      .link-type-option input {
        display: none;
      }
      
      .link-type-icon {
        font-size: 16px;
      }
      
      .link-type-label {
        font-size: 13px;
        color: var(--text-primary, #fff);
      }
      
      .browser-select {
        width: 100%;
        padding: 10px 12px;
        background: var(--bg-secondary, #252540);
        border: 1px solid var(--border-color, #333);
        border-radius: 6px;
        color: var(--text-primary, #fff);
        font-size: 14px;
      }
      
      .beat-browser-beats {
        flex: 1;
        overflow-y: auto;
        margin-top: 16px;
        border: 1px solid var(--border-color, #333);
        border-radius: 8px;
        min-height: 200px;
        max-height: 300px;
      }
      
      .browser-beat-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 12px;
        border-bottom: 1px solid var(--border-color, #333);
        cursor: pointer;
        transition: background 0.15s;
      }
      
      .browser-beat-item:hover {
        background: var(--bg-hover, #333);
      }
      
      .browser-beat-item.selected {
        background: rgba(74, 158, 255, 0.15);
        border-left: 3px solid var(--accent-color, #4a9eff);
      }
      
      .browser-beat-time {
        font-size: 12px;
        color: var(--text-secondary, #888);
        font-family: monospace;
        min-width: 60px;
      }
      
      .browser-beat-name {
        flex: 1;
        color: var(--text-primary, #fff);
      }
      
      .browser-beat-type {
        font-size: 11px;
        padding: 2px 8px;
        background: var(--bg-secondary, #252540);
        border-radius: 4px;
        color: var(--text-secondary, #888);
        text-transform: uppercase;
      }
      
      .browser-empty, .browser-loading, .browser-error {
        padding: 40px;
        text-align: center;
        color: var(--text-secondary, #888);
      }
      
      .browser-error {
        color: #ef4444;
      }
      
      /* Beat Links Indicator */
      .beat-links-indicator {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 6px;
        background: var(--bg-secondary, #252540);
        border-radius: 4px;
        font-size: 11px;
        cursor: pointer;
      }
      
      .beat-links-indicator:hover {
        background: var(--bg-hover, #333);
      }
      
      .links-count {
        color: var(--text-secondary, #888);
      }
      
      /* Mini Player */
      .beat-preview-mini-player {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 320px;
        background: var(--bg-primary, #1a1a2e);
        border: 1px solid var(--border-color, #333);
        border-radius: 8px;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
        z-index: 10000;
        overflow: hidden;
        transition: opacity 0.2s, transform 0.2s;
      }
      
      .beat-preview-mini-player.hidden {
        opacity: 0;
        transform: translateY(20px);
        pointer-events: none;
      }
      
      .mini-player-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 12px;
        background: var(--bg-secondary, #252540);
        border-bottom: 1px solid var(--border-color, #333);
      }
      
      .mini-player-title {
        font-size: 12px;
        color: var(--text-secondary, #888);
      }
      
      .mini-player-close {
        background: none;
        border: none;
        color: var(--text-secondary, #888);
        cursor: pointer;
        font-size: 18px;
      }
      
      .mini-player-video {
        width: 100%;
        aspect-ratio: 16/9;
        background: #000;
      }
      
      .mini-player-info {
        display: flex;
        justify-content: space-between;
        padding: 8px 12px;
      }
      
      .mini-player-beat-name {
        font-size: 13px;
        color: var(--text-primary, #fff);
      }
      
      .mini-player-beat-time {
        font-size: 12px;
        color: var(--text-secondary, #888);
        font-family: monospace;
      }
    `;
    document.head.appendChild(styles);
  }

  /**
   * Format time as MM:SS
   */
  _formatTime(seconds) {
    if (!seconds) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  /**
   * Escape HTML
   */
  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }
}

export default BeatLinker;











