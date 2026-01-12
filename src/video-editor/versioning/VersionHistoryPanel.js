/**
 * VersionHistoryPanel - Timeline view of version history
 * 
 * Features:
 * - Timeline view of versions
 * - Version diff viewer
 * - Restore to version
 * - Version notes/comments
 */

export class VersionHistoryPanel {
  constructor(appContext) {
    this.app = appContext;
    this.panelElement = null;
    this.isVisible = false;
    
    // State
    this.versions = [];
    this.selectedVersion = null;
    this.compareVersions = null; // { from: version, to: version }
    this.mode = 'history'; // 'history' or 'compare'
  }

  /**
   * Initialize the panel
   */
  init() {
    this._createPanel();
    this._loadVersions();
  }

  /**
   * Create the panel DOM structure
   */
  _createPanel() {
    // Check if panel already exists
    this.panelElement = document.getElementById('versionHistoryPanel');
    
    if (!this.panelElement) {
      this.panelElement = document.createElement('div');
      this.panelElement.id = 'versionHistoryPanel';
      this.panelElement.className = 'version-history-panel-overlay';
      document.body.appendChild(this.panelElement);
      
      this._addStyles();
    }
    
    this._setupEventListeners();
  }

  /**
   * Add component styles
   */
  _addStyles() {
    if (document.getElementById('versionHistoryPanelStyles')) return;
    
    const styles = document.createElement('style');
    styles.id = 'versionHistoryPanelStyles';
    styles.textContent = `
      .version-history-panel-overlay {
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
        visibility: hidden;
        transition: opacity 0.2s, visibility 0.2s;
      }
      
      .version-history-panel-overlay.visible {
        opacity: 1;
        visibility: visible;
      }
      
      .version-history-panel {
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
      
      .version-history-header {
        padding: 16px 20px;
        border-bottom: 1px solid var(--border-color, #333);
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      
      .version-history-title {
        font-size: 18px;
        font-weight: 600;
        color: var(--text-primary, #fff);
        display: flex;
        align-items: center;
        gap: 8px;
      }
      
      .version-history-tabs {
        display: flex;
        gap: 4px;
      }
      
      .version-tab {
        padding: 6px 12px;
        font-size: 13px;
        background: var(--bg-secondary, #252540);
        border: 1px solid var(--border-color, #333);
        border-radius: 4px;
        color: var(--text-secondary, #888);
        cursor: pointer;
        transition: background 0.2s, color 0.2s;
      }
      
      .version-tab:hover {
        background: var(--bg-hover, #333);
        color: var(--text-primary, #fff);
      }
      
      .version-tab.active {
        background: var(--accent-color, #4a9eff);
        color: white;
        border-color: transparent;
      }
      
      .version-history-close {
        background: none;
        border: none;
        font-size: 24px;
        color: var(--text-secondary, #888);
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
      }
      
      .version-history-close:hover {
        background: var(--bg-hover, #333);
        color: var(--text-primary, #fff);
      }
      
      .version-history-content {
        flex: 1;
        overflow-y: auto;
        padding: 20px;
      }
      
      /* Timeline View */
      .version-timeline {
        position: relative;
        padding-left: 40px;
      }
      
      .version-timeline::before {
        content: '';
        position: absolute;
        left: 12px;
        top: 0;
        bottom: 0;
        width: 2px;
        background: var(--border-color, #333);
      }
      
      .version-item {
        position: relative;
        padding-bottom: 24px;
        cursor: pointer;
      }
      
      .version-item:last-child {
        padding-bottom: 0;
      }
      
      .version-item::before {
        content: '';
        position: absolute;
        left: -33px;
        top: 8px;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: var(--bg-secondary, #252540);
        border: 2px solid var(--border-color, #333);
        transition: background 0.2s, border-color 0.2s;
      }
      
      .version-item:hover::before {
        border-color: var(--accent-color, #4a9eff);
      }
      
      .version-item.selected::before {
        background: var(--accent-color, #4a9eff);
        border-color: var(--accent-color, #4a9eff);
      }
      
      .version-item.current::before {
        background: #10b981;
        border-color: #10b981;
      }
      
      .version-card {
        background: var(--bg-secondary, #252540);
        border: 1px solid var(--border-color, #333);
        border-radius: 8px;
        padding: 12px 16px;
        transition: border-color 0.2s, box-shadow 0.2s;
      }
      
      .version-item:hover .version-card {
        border-color: #444;
      }
      
      .version-item.selected .version-card {
        border-color: var(--accent-color, #4a9eff);
        box-shadow: 0 0 0 1px var(--accent-color, #4a9eff);
      }
      
      .version-card-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 8px;
      }
      
      .version-name {
        font-weight: 600;
        color: var(--text-primary, #fff);
      }
      
      .version-badge {
        font-size: 10px;
        padding: 2px 8px;
        border-radius: 4px;
        background: var(--bg-primary, #1a1a2e);
        color: var(--text-secondary, #888);
        text-transform: uppercase;
      }
      
      .version-badge.current {
        background: #10b98120;
        color: #10b981;
      }
      
      .version-card-meta {
        display: flex;
        gap: 12px;
        font-size: 12px;
        color: var(--text-secondary, #888);
        margin-bottom: 8px;
      }
      
      .version-card-notes {
        font-size: 13px;
        color: var(--text-secondary, #888);
        line-height: 1.4;
      }
      
      .version-card-actions {
        display: flex;
        gap: 8px;
        margin-top: 12px;
        padding-top: 12px;
        border-top: 1px solid var(--border-color, #333);
      }
      
      .version-action-btn {
        padding: 6px 12px;
        font-size: 12px;
        background: var(--bg-primary, #1a1a2e);
        border: 1px solid var(--border-color, #333);
        border-radius: 4px;
        color: var(--text-primary, #fff);
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 4px;
        transition: background 0.2s;
      }
      
      .version-action-btn:hover {
        background: var(--bg-hover, #333);
      }
      
      .version-action-btn.primary {
        background: var(--accent-color, #4a9eff);
        border-color: transparent;
        color: white;
      }
      
      .version-action-btn.primary:hover {
        background: #3a8eef;
      }
      
      /* Compare View */
      .version-compare {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 20px;
      }
      
      .compare-column {
        background: var(--bg-secondary, #252540);
        border-radius: 8px;
        overflow: hidden;
      }
      
      .compare-column-header {
        padding: 12px 16px;
        background: var(--bg-primary, #1a1a2e);
        border-bottom: 1px solid var(--border-color, #333);
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      
      .compare-column-title {
        font-weight: 500;
        color: var(--text-primary, #fff);
      }
      
      .compare-column-select {
        padding: 4px 8px;
        font-size: 12px;
        background: var(--bg-secondary, #252540);
        border: 1px solid var(--border-color, #333);
        border-radius: 4px;
        color: var(--text-primary, #fff);
      }
      
      .compare-diff-list {
        padding: 16px;
        max-height: 400px;
        overflow-y: auto;
      }
      
      .compare-diff-item {
        padding: 8px 12px;
        margin-bottom: 8px;
        border-radius: 4px;
        font-size: 13px;
      }
      
      .compare-diff-item.added {
        background: rgba(16, 185, 129, 0.1);
        border-left: 3px solid #10b981;
      }
      
      .compare-diff-item.removed {
        background: rgba(239, 68, 68, 0.1);
        border-left: 3px solid #ef4444;
      }
      
      .compare-diff-item.modified {
        background: rgba(245, 158, 11, 0.1);
        border-left: 3px solid #f59e0b;
      }
      
      .compare-summary {
        grid-column: 1 / -1;
        padding: 16px;
        background: var(--bg-secondary, #252540);
        border-radius: 8px;
        display: flex;
        justify-content: center;
        gap: 32px;
      }
      
      .compare-stat {
        text-align: center;
      }
      
      .compare-stat-value {
        font-size: 24px;
        font-weight: bold;
        color: var(--text-primary, #fff);
      }
      
      .compare-stat-label {
        font-size: 12px;
        color: var(--text-secondary, #888);
      }
      
      .compare-stat-value.added {
        color: #10b981;
      }
      
      .compare-stat-value.removed {
        color: #ef4444;
      }
      
      /* Version Footer */
      .version-history-footer {
        padding: 16px 20px;
        border-top: 1px solid var(--border-color, #333);
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      
      .version-footer-info {
        font-size: 12px;
        color: var(--text-secondary, #888);
      }
      
      .version-footer-actions {
        display: flex;
        gap: 12px;
      }
      
      .version-empty {
        text-align: center;
        padding: 48px;
        color: var(--text-secondary, #888);
      }
      
      .version-empty-icon {
        font-size: 48px;
        margin-bottom: 16px;
        opacity: 0.5;
      }
    `;
    document.head.appendChild(styles);
  }

  /**
   * Setup event listeners
   */
  _setupEventListeners() {
    // Close on backdrop click
    this.panelElement?.addEventListener('click', (e) => {
      if (e.target === this.panelElement) {
        this.hide();
      }
    });
    
    // Escape to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isVisible) {
        this.hide();
      }
    });
  }

  /**
   * Load version history
   */
  async _loadVersions() {
    const versionManager = this.app.versionManager;
    
    if (versionManager?.getVersionHistory) {
      this.versions = await versionManager.getVersionHistory();
    } else {
      // Mock data for demonstration
      this.versions = [
        {
          id: 'v_current',
          name: 'Current State',
          timestamp: new Date().toISOString(),
          isCurrent: true,
          branch: 'main',
          editCount: 0,
          notes: 'Auto-saved current state'
        },
        {
          id: 'v_initial',
          name: 'Initial Version',
          timestamp: new Date(Date.now() - 3600000).toISOString(),
          isCurrent: false,
          branch: 'main',
          editCount: 0,
          notes: 'Project created'
        }
      ];
    }
  }

  /**
   * Show the panel
   */
  show(options = {}) {
    this.mode = options.mode || 'history';
    this._loadVersions();
    this.render();
    
    this.panelElement.classList.add('visible');
    this.isVisible = true;
  }

  /**
   * Hide the panel
   */
  hide() {
    this.panelElement.classList.remove('visible');
    this.isVisible = false;
    this.selectedVersion = null;
  }

  /**
   * Render the panel
   */
  render() {
    if (!this.panelElement) return;
    
    this.panelElement.innerHTML = `
      <div class="version-history-panel">
        <div class="version-history-header">
          <div class="version-history-title">
            📜 Version History
          </div>
          <div class="version-history-tabs">
            <button class="version-tab ${this.mode === 'history' ? 'active' : ''}" data-mode="history">
              Timeline
            </button>
            <button class="version-tab ${this.mode === 'compare' ? 'active' : ''}" data-mode="compare">
              Compare
            </button>
          </div>
          <button class="version-history-close" data-action="close">&times;</button>
        </div>
        
        <div class="version-history-content">
          ${this.mode === 'history' ? this._renderTimeline() : this._renderCompare()}
        </div>
        
        <div class="version-history-footer">
          <div class="version-footer-info">
            ${this.versions.length} version${this.versions.length !== 1 ? 's' : ''} in history
          </div>
          <div class="version-footer-actions">
            <button class="version-action-btn" data-action="create-snapshot">
              📸 Create Snapshot
            </button>
            <button class="version-action-btn" data-action="close">
              Close
            </button>
          </div>
        </div>
      </div>
    `;
    
    this._bindRenderEvents();
  }

  /**
   * Render timeline view
   */
  _renderTimeline() {
    if (this.versions.length === 0) {
      return `
        <div class="version-empty">
          <div class="version-empty-icon">📜</div>
          <div>No version history yet</div>
          <div style="margin-top: 8px;">Create a snapshot to start tracking changes</div>
        </div>
      `;
    }
    
    return `
      <div class="version-timeline">
        ${this.versions.map(version => this._renderVersionItem(version)).join('')}
      </div>
    `;
  }

  /**
   * Render a single version item
   */
  _renderVersionItem(version) {
    const isSelected = this.selectedVersion?.id === version.id;
    const isCurrent = version.isCurrent;
    const date = new Date(version.timestamp);
    const timeAgo = this._formatTimeAgo(date);
    
    return `
      <div class="version-item ${isSelected ? 'selected' : ''} ${isCurrent ? 'current' : ''}" 
           data-version-id="${version.id}">
        <div class="version-card">
          <div class="version-card-header">
            <span class="version-name">${this._escapeHtml(version.name)}</span>
            ${isCurrent ? '<span class="version-badge current">Current</span>' : ''}
          </div>
          <div class="version-card-meta">
            <span>📅 ${timeAgo}</span>
            <span>🌿 ${version.branch || 'main'}</span>
            ${version.editCount > 0 ? `<span>✂️ ${version.editCount} edits</span>` : ''}
          </div>
          ${version.notes ? `
            <div class="version-card-notes">${this._escapeHtml(version.notes)}</div>
          ` : ''}
          ${isSelected ? `
            <div class="version-card-actions">
              ${!isCurrent ? `
                <button class="version-action-btn primary" data-action="restore" data-version-id="${version.id}">
                  ↩️ Restore
                </button>
              ` : ''}
              <button class="version-action-btn" data-action="preview" data-version-id="${version.id}">
                👁️ Preview
              </button>
              <button class="version-action-btn" data-action="export" data-version-id="${version.id}">
                📤 Export
              </button>
              <button class="version-action-btn" data-action="note" data-version-id="${version.id}">
                📝 Add Note
              </button>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  /**
   * Render compare view
   */
  _renderCompare() {
    return `
      <div class="version-compare">
        <div class="compare-column">
          <div class="compare-column-header">
            <span class="compare-column-title">From Version</span>
            <select class="compare-column-select" id="compareFromSelect">
              ${this.versions.map(v => `
                <option value="${v.id}" ${v.id === this.compareVersions?.from?.id ? 'selected' : ''}>
                  ${this._escapeHtml(v.name)}
                </option>
              `).join('')}
            </select>
          </div>
          <div class="compare-diff-list" id="compareFromDiff">
            ${this._renderDiffItems('from')}
          </div>
        </div>
        
        <div class="compare-column">
          <div class="compare-column-header">
            <span class="compare-column-title">To Version</span>
            <select class="compare-column-select" id="compareToSelect">
              ${this.versions.map(v => `
                <option value="${v.id}" ${v.id === this.compareVersions?.to?.id ? 'selected' : ''}>
                  ${this._escapeHtml(v.name)}
                </option>
              `).join('')}
            </select>
          </div>
          <div class="compare-diff-list" id="compareToDiff">
            ${this._renderDiffItems('to')}
          </div>
        </div>
        
        <div class="compare-summary">
          <div class="compare-stat">
            <div class="compare-stat-value added">+${this._getComparisonStats().added}</div>
            <div class="compare-stat-label">Added</div>
          </div>
          <div class="compare-stat">
            <div class="compare-stat-value removed">-${this._getComparisonStats().removed}</div>
            <div class="compare-stat-label">Removed</div>
          </div>
          <div class="compare-stat">
            <div class="compare-stat-value">${this._getComparisonStats().modified}</div>
            <div class="compare-stat-label">Modified</div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render diff items for compare view
   */
  _renderDiffItems(side) {
    // Mock diff data - would come from version manager
    const diffs = [
      { type: 'removed', text: 'Removed segment at 0:45' },
      { type: 'added', text: 'Added transition at 1:30' },
      { type: 'modified', text: 'Changed audio level at 2:15' }
    ];
    
    return diffs.map(diff => `
      <div class="compare-diff-item ${diff.type}">${diff.text}</div>
    `).join('');
  }

  /**
   * Get comparison statistics
   */
  _getComparisonStats() {
    // Would be calculated from actual version comparison
    return { added: 3, removed: 1, modified: 2 };
  }

  /**
   * Bind events after render
   */
  _bindRenderEvents() {
    // Close button
    this.panelElement.querySelectorAll('[data-action="close"]').forEach(btn => {
      btn.addEventListener('click', () => this.hide());
    });
    
    // Tab switching
    this.panelElement.querySelectorAll('.version-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this.mode = tab.dataset.mode;
        this.render();
      });
    });
    
    // Version item click
    this.panelElement.querySelectorAll('.version-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const action = e.target.closest('[data-action]');
        if (action) {
          this._handleAction(action.dataset.action, action.dataset.versionId);
          return;
        }
        
        const versionId = item.dataset.versionId;
        this.selectedVersion = this.versions.find(v => v.id === versionId);
        this.render();
      });
    });
    
    // Create snapshot
    this.panelElement.querySelector('[data-action="create-snapshot"]')?.addEventListener('click', () => {
      this._createSnapshot();
    });
    
    // Compare selects
    this.panelElement.querySelector('#compareFromSelect')?.addEventListener('change', (e) => {
      this.compareVersions = this.compareVersions || {};
      this.compareVersions.from = this.versions.find(v => v.id === e.target.value);
      this.render();
    });
    
    this.panelElement.querySelector('#compareToSelect')?.addEventListener('change', (e) => {
      this.compareVersions = this.compareVersions || {};
      this.compareVersions.to = this.versions.find(v => v.id === e.target.value);
      this.render();
    });
  }

  /**
   * Handle version action
   */
  async _handleAction(action, versionId) {
    const version = this.versions.find(v => v.id === versionId);
    if (!version) return;
    
    switch (action) {
      case 'restore':
        if (confirm(`Restore to "${version.name}"? Current changes will be saved as a new version.`)) {
          await this._restoreVersion(versionId);
          this.hide();
        }
        break;
        
      case 'preview':
        this.app.showToast?.('info', 'Preview coming soon');
        break;
        
      case 'export':
        this.app.showToast?.('info', 'Export coming soon');
        break;
        
      case 'note':
        const note = prompt('Add a note to this version:', version.notes || '');
        if (note !== null) {
          version.notes = note;
          this.app.versionManager?.updateVersionNote?.(versionId, note);
          this.render();
        }
        break;
    }
  }

  /**
   * Restore to a specific version
   */
  async _restoreVersion(versionId) {
    if (this.app.versionManager?.restoreVersion) {
      await this.app.versionManager.restoreVersion(versionId);
    }
    
    this.app.showToast?.('success', 'Version restored');
    await this._loadVersions();
  }

  /**
   * Create a new snapshot
   */
  async _createSnapshot() {
    const name = prompt('Enter snapshot name:', `Snapshot ${new Date().toLocaleString()}`);
    if (!name?.trim()) return;
    
    const notes = prompt('Add notes (optional):');
    
    const snapshot = {
      id: `v_${Date.now()}`,
      name: name.trim(),
      timestamp: new Date().toISOString(),
      isCurrent: false,
      branch: this.app.branchSwitcher?.getCurrentBranch()?.name || 'main',
      editCount: this.app.videoSyncEngine?.edits?.length || 0,
      notes: notes?.trim() || ''
    };
    
    if (this.app.versionManager?.createSnapshot) {
      await this.app.versionManager.createSnapshot(snapshot);
    } else {
      this.versions.unshift(snapshot);
    }
    
    this.app.showToast?.('success', 'Snapshot created');
    this.render();
  }

  /**
   * Format time ago string
   */
  _formatTimeAgo(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    
    if (diffSecs < 60) return 'Just now';
    if (diffMins < 60) return `${diffMins} min${diffMins > 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    return date.toLocaleDateString();
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

export default VersionHistoryPanel;











