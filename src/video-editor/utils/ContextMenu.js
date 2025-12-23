/**
 * ContextMenu - Smart positioning and management for context menus
 * Ensures menus are never cut off by screen edges
 */

/**
 * Position a context menu with smart viewport clamping
 * @param {HTMLElement} menu - The menu element to position
 * @param {number} x - Desired X position (client coordinates)
 * @param {number} y - Desired Y position (client coordinates)
 * @param {object} options - Optional positioning options
 */
export function positionContextMenu(menu, x, y, options = {}) {
  const {
    minMargin = 12,      // Minimum distance from screen edges
    minWidth = 180,      // Minimum menu width
    showClass = 'visible' // CSS class to show menu
  } = options;

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Reset any previous inline constraints
  menu.style.maxHeight = '';
  menu.style.maxWidth = '';

  // Show off-screen to measure natural size
  menu.style.left = '-9999px';
  menu.style.top = '-9999px';
  menu.classList.add(showClass);

  // Force layout recalc and get menu dimensions
  const rect = menu.getBoundingClientRect();
  let mw = Math.max(rect.width, minWidth);
  let mh = rect.height;

  // Calculate usable viewport area (with margins)
  const usableWidth = vw - (minMargin * 2);
  const usableHeight = vh - (minMargin * 2);

  // Clamp menu size to usable viewport
  if (mw > usableWidth) {
    mw = usableWidth;
    menu.style.maxWidth = `${mw}px`;
  }
  if (mh > usableHeight) {
    mh = usableHeight;
    menu.style.maxHeight = `${mh}px`;
  }

  // Calculate final position
  let finalX = x;
  let finalY = y;

  // Horizontal positioning
  if (x + mw > vw - minMargin) {
    // Would overflow right - flip to left side of cursor
    finalX = Math.max(minMargin, x - mw);
  } else if (x < minMargin) {
    finalX = minMargin;
  }

  // Vertical positioning
  if (y + mh > vh - minMargin) {
    // Would overflow bottom - flip to above cursor or clamp
    if (y - mh >= minMargin) {
      finalY = y - mh;
    } else {
      // Can't flip up, clamp to bottom
      finalY = vh - mh - minMargin;
    }
  } else if (y < minMargin) {
    finalY = minMargin;
  }

  // Apply final position
  menu.style.left = `${finalX}px`;
  menu.style.top = `${finalY}px`;
}

/**
 * Hide a context menu
 * @param {HTMLElement|string} menu - Menu element or selector
 * @param {string} hideClass - CSS class to remove
 */
export function hideContextMenu(menu, hideClass = 'visible') {
  const el = typeof menu === 'string' ? document.querySelector(menu) : menu;
  if (el) {
    el.classList.remove(hideClass);
  }
}

/**
 * Build context menu HTML from items array
 * @param {Array} items - Menu items configuration
 * @returns {string} Menu HTML
 */
export function buildContextMenuHTML(items) {
  let html = '';
  
  for (const item of items) {
    if (item.type === 'header') {
      html += `<div class="context-menu-header">${item.label}</div>`;
    } else if (item.type === 'divider') {
      html += `<div class="context-menu-divider"></div>`;
    } else {
      const disabledClass = item.disabled ? 'disabled' : '';
      const dangerClass = item.danger ? 'danger' : '';
      const dataAction = item.action ? `data-action="${item.action}"` : '';
      
      html += `
        <div class="context-menu-item ${disabledClass} ${dangerClass}" ${dataAction}>
          ${item.icon ? `<span class="context-menu-item-icon">${item.icon}</span>` : ''}
          <span class="context-menu-item-label">${item.label}</span>
          ${item.shortcut ? `<span class="context-menu-item-shortcut">${item.shortcut}</span>` : ''}
        </div>
      `;
    }
  }
  
  return html;
}

/**
 * ContextMenu class - manages context menu state and behavior
 */
export class ContextMenu {
  constructor(menuElement) {
    this.menu = typeof menuElement === 'string' 
      ? document.querySelector(menuElement) 
      : menuElement;
    this.itemsContainer = null;
    
    // Find items container
    if (this.menu) {
      this.itemsContainer = this.menu.querySelector('#contextMenuItems') || 
                            this.menu.querySelector('.context-menu-items') ||
                            this.menu;
    }
    
    // Setup global click handler to close menu
    this._setupClickOutside();
  }

  /**
   * Show menu at position with items
   */
  show(x, y, items = null) {
    if (!this.menu) return;
    
    if (items && this.itemsContainer) {
      this.itemsContainer.innerHTML = buildContextMenuHTML(items);
    }
    
    positionContextMenu(this.menu, x, y);
  }

  /**
   * Hide the menu
   */
  hide() {
    hideContextMenu(this.menu);
  }

  /**
   * Set menu items
   */
  setItems(items) {
    if (this.itemsContainer) {
      this.itemsContainer.innerHTML = buildContextMenuHTML(items);
    }
  }

  /**
   * Add click handler for menu items
   */
  onAction(callback) {
    if (!this.itemsContainer) return;
    
    this.itemsContainer.addEventListener('click', (e) => {
      const item = e.target.closest('.context-menu-item');
      if (item && !item.classList.contains('disabled')) {
        const action = item.dataset.action;
        if (action) {
          callback(action, item);
          this.hide();
        }
      }
    });
  }

  /**
   * Setup click outside handler
   */
  _setupClickOutside() {
    document.addEventListener('click', (e) => {
      if (this.menu && !this.menu.contains(e.target)) {
        this.hide();
      }
    });
    
    document.addEventListener('contextmenu', (e) => {
      // Don't hide if clicking on something that will show a new context menu
      if (!e.target.closest('[oncontextmenu]')) {
        this.hide();
      }
    });
  }
}


















