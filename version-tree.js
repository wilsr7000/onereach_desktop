/**
 * VersionTree - Version branching and tree visualization (Browser version)
 * This is a browser-compatible version of src/project-manager/VersionTree.js
 */

class VersionTree {
  constructor(tree) {
    this.tree = tree || { root: null, nodes: {}, children: {} };
  }

  /**
   * Set the tree data
   * @param {Object} tree - Tree structure from ProjectStorage
   */
  setTree(tree) {
    this.tree = tree;
  }

  /**
   * Get the root version
   * @returns {Object|null} Root version
   */
  getRoot() {
    if (!this.tree.root) return null;
    return this.tree.nodes[this.tree.root] || null;
  }

  /**
   * Get children of a version
   * @param {string} versionId - Version ID
   * @returns {Array} Child versions
   */
  getChildren(versionId) {
    const childIds = this.tree.children[versionId] || [];
    return childIds.map(id => this.tree.nodes[id]).filter(v => v);
  }

  /**
   * Get the parent of a version
   * @param {string} versionId - Version ID
   * @returns {Object|null} Parent version
   */
  getParent(versionId) {
    const version = this.tree.nodes[versionId];
    if (!version || !version.parentVersionId) return null;
    return this.tree.nodes[version.parentVersionId] || null;
  }

  /**
   * Get the full lineage (path to root) of a version
   * @param {string} versionId - Version ID
   * @returns {Array} Array of versions from root to current
   */
  getLineage(versionId) {
    const lineage = [];
    let current = this.tree.nodes[versionId];
    
    while (current) {
      lineage.unshift(current);
      current = current.parentVersionId ? this.tree.nodes[current.parentVersionId] : null;
    }
    
    return lineage;
  }

  /**
   * Get all descendants of a version
   * @param {string} versionId - Version ID
   * @returns {Array} All descendant versions
   */
  getDescendants(versionId) {
    const descendants = [];
    const stack = [...(this.tree.children[versionId] || [])];
    
    while (stack.length > 0) {
      const id = stack.pop();
      const version = this.tree.nodes[id];
      if (version) {
        descendants.push(version);
        stack.push(...(this.tree.children[id] || []));
      }
    }
    
    return descendants;
  }

  /**
   * Get the depth of a version in the tree
   * @param {string} versionId - Version ID
   * @returns {number} Depth (0 for root)
   */
  getDepth(versionId) {
    return this.getLineage(versionId).length - 1;
  }

  /**
   * Check if a version is an ancestor of another
   * @param {string} ancestorId - Potential ancestor version ID
   * @param {string} descendantId - Potential descendant version ID
   * @returns {boolean} True if ancestor
   */
  isAncestorOf(ancestorId, descendantId) {
    const lineage = this.getLineage(descendantId);
    return lineage.some(v => v.id === ancestorId);
  }

  /**
   * Get all versions as a flat array
   * @returns {Array} All versions
   */
  getAllVersions() {
    return Object.values(this.tree.nodes);
  }

  /**
   * Convert tree to a flat structure suitable for rendering
   * Each node includes its depth and position information
   * @returns {Array} Flat array with rendering info
   */
  toFlatRenderList() {
    const result = [];
    
    const traverse = (versionId, depth = 0, branchIndex = 0) => {
      const version = this.tree.nodes[versionId];
      if (!version) return;
      
      result.push({
        ...version,
        depth,
        branchIndex,
        hasChildren: (this.tree.children[versionId] || []).length > 0,
        isRoot: versionId === this.tree.root
      });
      
      const children = this.tree.children[versionId] || [];
      children.forEach((childId, index) => {
        traverse(childId, depth + 1, index);
      });
    };
    
    if (this.tree.root) {
      traverse(this.tree.root);
    }
    
    return result;
  }

  /**
   * Generate SVG path data for tree connections
   * @param {number} nodeHeight - Height of each node
   * @param {number} levelIndent - Horizontal indent per level
   * @returns {Array} Array of path objects
   */
  generateConnectionPaths(nodeHeight = 40, levelIndent = 24) {
    const paths = [];
    const nodes = this.toFlatRenderList();
    const nodePositions = {};
    
    // Calculate positions
    nodes.forEach((node, index) => {
      nodePositions[node.id] = {
        x: node.depth * levelIndent + 12,
        y: index * nodeHeight + nodeHeight / 2
      };
    });
    
    // Generate paths
    nodes.forEach(node => {
      if (node.parentVersionId && nodePositions[node.parentVersionId]) {
        const parent = nodePositions[node.parentVersionId];
        const child = nodePositions[node.id];
        
        // Create an L-shaped path
        paths.push({
          from: node.parentVersionId,
          to: node.id,
          d: `M ${parent.x} ${parent.y} L ${parent.x} ${child.y} L ${child.x} ${child.y}`
        });
      }
    });
    
    return paths;
  }

  /**
   * Render the tree as HTML
   * @param {Object} options - Rendering options
   * @returns {string} HTML string
   */
  renderHTML(options = {}) {
    const {
      selectedVersionId = null,
      onVersionClick = 'app.selectVersion',
      onBranchClick = 'app.branchVersion',
      onDeleteClick = 'app.deleteVersion',
      showActions = true
    } = options;

    const nodes = this.toFlatRenderList();
    
    if (nodes.length === 0) {
      return '<div class="version-tree-empty">No versions yet</div>';
    }

    let html = '<div class="version-tree">';
    
    // Add SVG for connection lines
    const paths = this.generateConnectionPaths();
    if (paths.length > 0) {
      const maxY = nodes.length * 40;
      const maxX = Math.max(...nodes.map(n => n.depth)) * 24 + 50;
      html += `<svg class="version-tree-lines" width="${maxX}" height="${maxY}" style="position: absolute; top: 0; left: 0; pointer-events: none;">`;
      paths.forEach(path => {
        html += `<path d="${path.d}" stroke="var(--border-color)" fill="none" stroke-width="1"/>`;
      });
      html += '</svg>';
    }

    // Render nodes
    nodes.forEach(node => {
      const isSelected = node.id === selectedVersionId;
      const indent = node.depth * 24;
      
      html += `
        <div class="version-tree-node ${isSelected ? 'selected' : ''}" 
             style="padding-left: ${indent + 24}px"
             data-version-id="${node.id}">
          <div class="version-tree-node-content" onclick="${onVersionClick}('${node.id}')">
            <span class="version-tree-icon">${node.isRoot ? '📁' : '📄'}</span>
            <span class="version-tree-name">${this.escapeHtml(node.name)}</span>
            ${node.hasChildren ? '<span class="version-tree-badge">' + this.getChildren(node.id).length + '</span>' : ''}
          </div>
          ${showActions ? `
            <div class="version-tree-actions">
              <button class="btn btn-ghost btn-sm" onclick="${onBranchClick}('${node.id}')" title="Branch from this version">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="6" y1="3" x2="6" y2="15"></line>
                  <circle cx="18" cy="6" r="3"></circle>
                  <circle cx="6" cy="18" r="3"></circle>
                  <path d="M18 9a9 9 0 0 1-9 9"></path>
                </svg>
              </button>
              ${!node.isRoot ? `
                <button class="btn btn-ghost btn-sm" onclick="${onDeleteClick}('${node.id}')" title="Delete version">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  </svg>
                </button>
              ` : ''}
            </div>
          ` : ''}
        </div>
      `;
    });

    html += '</div>';
    return html;
  }

  /**
   * Render a compact dropdown-friendly list
   * @param {string} selectedVersionId - Currently selected version
   * @returns {string} HTML string
   */
  renderDropdownList(selectedVersionId = null) {
    const nodes = this.toFlatRenderList();
    
    let html = '';
    nodes.forEach(node => {
      const isSelected = node.id === selectedVersionId;
      const indent = '&nbsp;'.repeat(node.depth * 4);
      const prefix = node.depth > 0 ? '└─ ' : '';
      
      html += `
        <div class="version-dropdown-item ${isSelected ? 'selected' : ''}" 
             data-version-id="${node.id}"
             onclick="app.switchToVersion('${node.id}')">
          <span class="version-dropdown-indent">${indent}${prefix}</span>
          <span class="version-dropdown-name">${this.escapeHtml(node.name)}</span>
          ${isSelected ? '<span class="version-dropdown-check">✓</span>' : ''}
        </div>
      `;
    });
    
    return html;
  }

  /**
   * Escape HTML entities
   * @param {string} str - String to escape
   * @returns {string} Escaped string
   */
  escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Get a simple text representation of the tree (for debugging)
   * @returns {string} Text tree
   */
  toTextTree() {
    const lines = [];
    
    const traverse = (versionId, prefix = '', isLast = true) => {
      const version = this.tree.nodes[versionId];
      if (!version) return;
      
      const connector = isLast ? '└── ' : '├── ';
      lines.push(prefix + connector + version.name);
      
      const children = this.tree.children[versionId] || [];
      const newPrefix = prefix + (isLast ? '    ' : '│   ');
      
      children.forEach((childId, index) => {
        traverse(childId, newPrefix, index === children.length - 1);
      });
    };
    
    if (this.tree.root) {
      const root = this.tree.nodes[this.tree.root];
      lines.push(root ? root.name : 'Root');
      const children = this.tree.children[this.tree.root] || [];
      children.forEach((childId, index) => {
        traverse(childId, '', index === children.length - 1);
      });
    }
    
    return lines.join('\n');
  }
}

// Make available globally for the video editor
window.VersionTree = VersionTree;










