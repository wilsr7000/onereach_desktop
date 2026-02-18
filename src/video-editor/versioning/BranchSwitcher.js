/**
 * BranchSwitcher - UI component for switching between edit branches
 *
 * Features:
 * - Dropdown showing all branches
 * - Branch type icons (Main, Director's, Social, etc.)
 * - "New Branch" button
 * - Branch comparison view
 */

const { getLogQueue } = require('../../../lib/log-event-queue');
const log = getLogQueue();
export class BranchSwitcher {
  constructor(appContext) {
    this.app = appContext;
    this.containerElement = null;
    this.isOpen = false;

    // Branch types with icons and colors
    this.branchTypes = {
      main: { icon: '🎬', label: 'Main', color: '#3b82f6' },
      directors: { icon: '🎥', label: "Director's Cut", color: '#8b5cf6' },
      social: { icon: '📱', label: 'Social', color: '#ec4899' },
      broadcast: { icon: '📺', label: 'Broadcast', color: '#f59e0b' },
      archive: { icon: '📦', label: 'Archive', color: '#6b7280' },
      custom: { icon: '✨', label: 'Custom', color: '#10b981' },
    };

    // State
    this.branches = [];
    this.currentBranch = null;
  }

  /**
   * Initialize the branch switcher
   */
  init(containerId = 'branchSwitcherContainer') {
    this.containerElement = document.getElementById(containerId);

    if (!this.containerElement) {
      // Create container if it doesn't exist
      this.containerElement = document.createElement('div');
      this.containerElement.id = containerId;
      this.containerElement.className = 'branch-switcher-container';

      // Insert into editor header if available
      const editorHeader =
        document.querySelector('.video-editor-header') || document.querySelector('.editor-toolbar') || document.body;
      editorHeader.appendChild(this.containerElement);
    }

    this._addStyles();
    this._loadBranches();
    this.render();

    // Close on click outside
    document.addEventListener('click', (e) => {
      if (!this.containerElement?.contains(e.target)) {
        this.close();
      }
    });
  }

  /**
   * Add component styles
   */
  _addStyles() {
    if (document.getElementById('branchSwitcherStyles')) return;

    const styles = document.createElement('style');
    styles.id = 'branchSwitcherStyles';
    styles.textContent = `
      .branch-switcher-container {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }
      
      .branch-switcher-btn {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        background: var(--bg-secondary, #252540);
        border: 1px solid var(--border-color, #333);
        border-radius: 6px;
        color: var(--text-primary, #fff);
        font-size: 13px;
        cursor: pointer;
        transition: background 0.2s, border-color 0.2s;
      }
      
      .branch-switcher-btn:hover {
        background: var(--bg-hover, #333);
        border-color: #444;
      }
      
      .branch-switcher-btn.open {
        background: var(--bg-hover, #333);
        border-color: var(--accent-color, #4a9eff);
      }
      
      .branch-icon {
        font-size: 16px;
      }
      
      .branch-name {
        font-weight: 500;
      }
      
      .branch-type-badge {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 4px;
        background: rgba(59, 130, 246, 0.2);
        color: #3b82f6;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      
      .branch-dropdown-arrow {
        font-size: 10px;
        color: var(--text-secondary, #888);
        transition: transform 0.2s;
      }
      
      .branch-switcher-btn.open .branch-dropdown-arrow {
        transform: rotate(180deg);
      }
      
      .branch-dropdown {
        position: absolute;
        top: 100%;
        left: 0;
        margin-top: 4px;
        min-width: 280px;
        background: var(--bg-primary, #1a1a2e);
        border: 1px solid var(--border-color, #333);
        border-radius: 8px;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
        z-index: 1000;
        opacity: 0;
        visibility: hidden;
        transform: translateY(-8px);
        transition: opacity 0.2s, transform 0.2s, visibility 0.2s;
      }
      
      .branch-dropdown.open {
        opacity: 1;
        visibility: visible;
        transform: translateY(0);
      }
      
      .branch-dropdown-header {
        padding: 12px 16px;
        border-bottom: 1px solid var(--border-color, #333);
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      
      .branch-dropdown-title {
        font-size: 12px;
        color: var(--text-secondary, #888);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      
      .new-branch-btn {
        padding: 4px 10px;
        font-size: 11px;
        background: var(--bg-secondary, #252540);
        border: 1px solid var(--border-color, #333);
        border-radius: 4px;
        color: var(--text-primary, #fff);
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      
      .new-branch-btn:hover {
        background: var(--bg-hover, #333);
        border-color: var(--accent-color, #4a9eff);
      }
      
      .branch-list {
        max-height: 300px;
        overflow-y: auto;
      }
      
      .branch-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 16px;
        cursor: pointer;
        transition: background 0.15s;
        border-bottom: 1px solid var(--border-color, #333)22;
      }
      
      .branch-item:hover {
        background: var(--bg-hover, #333);
      }
      
      .branch-item.active {
        background: rgba(74, 158, 255, 0.1);
        border-left: 3px solid var(--accent-color, #4a9eff);
        padding-left: 13px;
      }
      
      .branch-item-icon {
        font-size: 20px;
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--bg-secondary, #252540);
        border-radius: 6px;
      }
      
      .branch-item-info {
        flex: 1;
      }
      
      .branch-item-name {
        font-weight: 500;
        color: var(--text-primary, #fff);
        margin-bottom: 2px;
      }
      
      .branch-item-meta {
        font-size: 11px;
        color: var(--text-secondary, #888);
        display: flex;
        gap: 8px;
      }
      
      .branch-item-actions {
        display: flex;
        gap: 4px;
        opacity: 0;
        transition: opacity 0.15s;
      }
      
      .branch-item:hover .branch-item-actions {
        opacity: 1;
      }
      
      .branch-action-btn {
        width: 24px;
        height: 24px;
        border-radius: 4px;
        background: var(--bg-secondary, #252540);
        border: 1px solid var(--border-color, #333);
        color: var(--text-secondary, #888);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
      }
      
      .branch-action-btn:hover {
        background: var(--bg-hover, #333);
        color: var(--text-primary, #fff);
      }
      
      .branch-dropdown-footer {
        padding: 8px 16px;
        border-top: 1px solid var(--border-color, #333);
        display: flex;
        gap: 8px;
      }
      
      .branch-footer-btn {
        flex: 1;
        padding: 8px;
        font-size: 12px;
        background: var(--bg-secondary, #252540);
        border: 1px solid var(--border-color, #333);
        border-radius: 4px;
        color: var(--text-primary, #fff);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
      }
      
      .branch-footer-btn:hover {
        background: var(--bg-hover, #333);
      }
      
      .branch-empty {
        padding: 24px;
        text-align: center;
        color: var(--text-secondary, #888);
      }
    `;
    document.head.appendChild(styles);
  }

  /**
   * Load branches from version manager
   */
  async _loadBranches() {
    // Try to load from version manager
    const versionManager = this.app.versionManager;

    if (versionManager) {
      this.branches = versionManager.getBranches?.() || [];
      this.currentBranch = versionManager.getCurrentBranch?.() || null;
    } else {
      // Default branches if no version manager
      this.branches = [
        { id: 'main', name: 'Main', type: 'main', isDefault: true, editCount: 0, createdAt: new Date().toISOString() },
      ];
      this.currentBranch = this.branches[0];
    }
  }

  /**
   * Render the branch switcher
   */
  render() {
    if (!this.containerElement) return;

    const current = this.currentBranch || { name: 'No Branch', type: 'main' };
    const branchType = this.branchTypes[current.type] || this.branchTypes.custom;

    this.containerElement.innerHTML = `
      <button class="branch-switcher-btn ${this.isOpen ? 'open' : ''}" id="branchSwitcherBtn">
        <span class="branch-icon">${branchType.icon}</span>
        <span class="branch-name">${this._escapeHtml(current.name)}</span>
        <span class="branch-type-badge" style="background: ${branchType.color}20; color: ${branchType.color};">
          ${branchType.label}
        </span>
        <span class="branch-dropdown-arrow">▼</span>
      </button>
      
      <div class="branch-dropdown ${this.isOpen ? 'open' : ''}" id="branchDropdown">
        <div class="branch-dropdown-header">
          <span class="branch-dropdown-title">Branches</span>
          <button class="new-branch-btn" id="newBranchBtn">
            <span>+</span> New Branch
          </button>
        </div>
        
        <div class="branch-list" id="branchList">
          ${
            this.branches.length === 0
              ? `
            <div class="branch-empty">No branches yet</div>
          `
              : this.branches.map((branch) => this._renderBranchItem(branch)).join('')
          }
        </div>
        
        <div class="branch-dropdown-footer">
          <button class="branch-footer-btn" id="compareBranchesBtn">
            📊 Compare
          </button>
          <button class="branch-footer-btn" id="branchHistoryBtn">
            📜 History
          </button>
        </div>
      </div>
    `;

    this._setupEventListeners();
  }

  /**
   * Render a single branch item
   */
  _renderBranchItem(branch) {
    const branchType = this.branchTypes[branch.type] || this.branchTypes.custom;
    const isActive = this.currentBranch?.id === branch.id;
    const editCount = branch.editCount || 0;
    const date = branch.createdAt ? new Date(branch.createdAt).toLocaleDateString() : '';

    return `
      <div class="branch-item ${isActive ? 'active' : ''}" data-branch-id="${branch.id}">
        <div class="branch-item-icon" style="background: ${branchType.color}20;">
          ${branchType.icon}
        </div>
        <div class="branch-item-info">
          <div class="branch-item-name">${this._escapeHtml(branch.name)}</div>
          <div class="branch-item-meta">
            <span>${branchType.label}</span>
            ${editCount > 0 ? `<span>${editCount} edits</span>` : ''}
            ${date ? `<span>${date}</span>` : ''}
          </div>
        </div>
        <div class="branch-item-actions">
          ${
            !branch.isDefault
              ? `
            <button class="branch-action-btn" data-action="rename" data-branch-id="${branch.id}" title="Rename">✏️</button>
            <button class="branch-action-btn" data-action="delete" data-branch-id="${branch.id}" title="Delete">🗑️</button>
          `
              : ''
          }
        </div>
      </div>
    `;
  }

  /**
   * Setup event listeners
   */
  _setupEventListeners() {
    // Toggle dropdown
    const btn = this.containerElement.querySelector('#branchSwitcherBtn');
    btn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });

    // New branch button
    const newBtn = this.containerElement.querySelector('#newBranchBtn');
    newBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.createNewBranch();
    });

    // Branch selection
    const branchItems = this.containerElement.querySelectorAll('.branch-item');
    branchItems.forEach((item) => {
      item.addEventListener('click', (e) => {
        const action = e.target.closest('[data-action]');
        if (action) {
          e.stopPropagation();
          this._handleBranchAction(action.dataset.action, action.dataset.branchId);
          return;
        }

        const branchId = item.dataset.branchId;
        this.switchToBranch(branchId);
      });
    });

    // Compare button
    const compareBtn = this.containerElement.querySelector('#compareBranchesBtn');
    compareBtn?.addEventListener('click', () => this.showBranchComparison());

    // History button
    const historyBtn = this.containerElement.querySelector('#branchHistoryBtn');
    historyBtn?.addEventListener('click', () => this.showBranchHistory());
  }

  /**
   * Toggle dropdown
   */
  toggle() {
    this.isOpen = !this.isOpen;
    this.render();
  }

  /**
   * Open dropdown
   */
  open() {
    this.isOpen = true;
    this.render();
  }

  /**
   * Close dropdown
   */
  close() {
    if (this.isOpen) {
      this.isOpen = false;
      this.render();
    }
  }

  /**
   * Switch to a different branch
   */
  async switchToBranch(branchId) {
    const branch = this.branches.find((b) => b.id === branchId);
    if (!branch) return;

    // Confirm if there are unsaved changes
    if (this.app.hasUnsavedChanges?.()) {
      const confirmed = confirm('You have unsaved changes. Switch branches anyway?');
      if (!confirmed) return;
    }

    log.info('video', '[BranchSwitcher] Switching to branch', { data: branchId });

    // Switch via version manager if available
    if (this.app.versionManager?.switchBranch) {
      await this.app.versionManager.switchBranch(branchId);
    }

    this.currentBranch = branch;
    this.close();

    this.app.showToast?.('success', `Switched to "${branch.name}"`);
  }

  /**
   * Create a new branch
   */
  async createNewBranch() {
    const name = prompt('Enter branch name:');
    if (!name?.trim()) return;

    // Select branch type
    const typeOptions = Object.entries(this.branchTypes)
      .map(([key, val]) => `${val.icon} ${key}`)
      .join('\n');

    const typeInput = prompt(`Select branch type:\n${typeOptions}\n\nEnter type name:`, 'custom');
    const type = Object.keys(this.branchTypes).includes(typeInput) ? typeInput : 'custom';

    const newBranch = {
      id: `branch_${Date.now()}`,
      name: name.trim(),
      type,
      isDefault: false,
      editCount: 0,
      createdAt: new Date().toISOString(),
      parentBranch: this.currentBranch?.id,
    };

    // Add via version manager if available
    if (this.app.versionManager?.createBranch) {
      await this.app.versionManager.createBranch(newBranch);
    } else {
      this.branches.push(newBranch);
    }

    // Auto-switch to new branch
    await this.switchToBranch(newBranch.id);

    this.app.showToast?.('success', `Created branch "${newBranch.name}"`);
    this._loadBranches();
    this.render();
  }

  /**
   * Handle branch action (rename, delete)
   */
  _handleBranchAction(action, branchId) {
    const branch = this.branches.find((b) => b.id === branchId);
    if (!branch) return;

    switch (action) {
      case 'rename':
        const newName = prompt('Enter new branch name:', branch.name);
        if (newName?.trim() && newName !== branch.name) {
          branch.name = newName.trim();
          this.app.versionManager?.renameBranch?.(branchId, newName);
          this.render();
          this.app.showToast?.('success', 'Branch renamed');
        }
        break;

      case 'delete':
        if (confirm(`Delete branch "${branch.name}"? This cannot be undone.`)) {
          this.branches = this.branches.filter((b) => b.id !== branchId);
          this.app.versionManager?.deleteBranch?.(branchId);

          // Switch to main if current branch was deleted
          if (this.currentBranch?.id === branchId) {
            const mainBranch = this.branches.find((b) => b.isDefault);
            if (mainBranch) this.switchToBranch(mainBranch.id);
          }

          this.render();
          this.app.showToast?.('success', 'Branch deleted');
        }
        break;
    }
  }

  /**
   * Show branch comparison view
   */
  showBranchComparison() {
    this.close();

    // Open version history panel in compare mode
    if (this.app.versionHistoryPanel) {
      this.app.versionHistoryPanel.show({ mode: 'compare' });
    } else {
      this.app.showToast?.('info', 'Branch comparison coming soon');
    }
  }

  /**
   * Show branch history
   */
  showBranchHistory() {
    this.close();

    // Open version history panel
    if (this.app.versionHistoryPanel) {
      this.app.versionHistoryPanel.show();
    } else {
      this.app.showToast?.('info', 'Version history coming soon');
    }
  }

  /**
   * Get current branch
   */
  getCurrentBranch() {
    return this.currentBranch;
  }

  /**
   * Get all branches
   */
  getBranches() {
    return this.branches;
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

export default BranchSwitcher;
