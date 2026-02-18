/**
 * Spaces Picker Renderer
 *
 * UI logic for the Spaces file picker window
 * Tufte-inspired: minimal, data-dense, functional
 */

let allSpaces = [];
let allItems = [];
let selectedItems = [];
let _currentSpaceId = null;
let currentFilter = 'all';
let searchQuery = '';

/**
 * Generate SVG icons using simple geometric shapes
 * Following Tufte principles: minimal, clear, functional
 */
const SVG_ICONS = {
  // Content type icons - geometric primitives
  file: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
  </svg>`,

  image: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <rect x="3" y="3" width="18" height="18" rx="2"/>
    <circle cx="8.5" cy="8.5" r="1.5"/>
    <polyline points="21 15 16 10 5 21"/>
  </svg>`,

  text: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path d="M4 7h16M4 12h16M4 17h10"/>
  </svg>`,

  code: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <polyline points="16 18 22 12 16 6"/>
    <polyline points="8 6 2 12 8 18"/>
  </svg>`,

  html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <polyline points="16 18 22 12 16 6"/>
    <polyline points="8 6 2 12 8 18"/>
    <line x1="12" y1="2" x2="12" y2="22"/>
  </svg>`,

  video: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <rect x="2" y="5" width="20" height="14" rx="2"/>
    <polygon points="10 8 16 12 10 16"/>
  </svg>`,

  audio: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path d="M9 18V5l12-2v13"/>
    <circle cx="6" cy="18" r="3"/>
    <circle cx="18" cy="16" r="3"/>
  </svg>`,

  // Default fallback
  default: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <rect x="5" y="5" width="14" height="14" rx="2"/>
  </svg>`,

  // Space icon - simple circle
  space: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <circle cx="12" cy="12" r="8"/>
  </svg>`,

  // Empty state icons
  folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
  </svg>`,

  warning: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
    <line x1="12" y1="9" x2="12" y2="13"/>
    <line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>`,

  empty: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
    <rect x="3" y="3" width="18" height="18" rx="2"/>
    <line x1="9" y1="9" x2="15" y2="15"/>
    <line x1="15" y1="9" x2="9" y2="15"/>
  </svg>`,
};

/**
 * Get icon for content type
 */
function getTypeIcon(type) {
  return SVG_ICONS[type] || SVG_ICONS.default;
}

/**
 * Load all spaces from the API
 */
async function loadSpaces() {
  try {
    allSpaces = await window.spacesPicker.getSpaces();
    renderSpaces();

    // Select first space by default
    if (allSpaces.length > 0) {
      selectSpace(allSpaces[0].id);
    }
  } catch (err) {
    console.error('[Spaces Picker] Error loading spaces:', err);
    document.getElementById('spaces-list').innerHTML = `
      <div style="padding: 20px; text-align: center; color: #f44336;">
        Error loading spaces
      </div>
    `;
  }
}

/**
 * Render spaces list in sidebar
 */
function renderSpaces() {
  const sidebar = document.getElementById('spaces-list');

  if (allSpaces.length === 0) {
    sidebar.innerHTML = `
      <div style="padding: 20px; text-align: center; color: #999;">
        <div style="width: 24px; height: 24px; margin: 0 auto 8px;">${SVG_ICONS.folder}</div>
        <div style="font-size: 11px;">No spaces</div>
      </div>
    `;
    return;
  }

  sidebar.innerHTML = allSpaces
    .map(
      (space) => `
    <div class="space-item" data-space-id="${space.id}">
      <span class="space-icon">${SVG_ICONS.space}</span>
      <span class="space-name">${escapeHtml(space.name)}</span>
      <span class="space-count">${space.itemCount || 0}</span>
    </div>
  `
    )
    .join('');

  // Add click handlers
  sidebar.querySelectorAll('.space-item').forEach((item) => {
    item.onclick = () => selectSpace(item.dataset.spaceId);
  });
}

/**
 * Select a space and load its items
 */
async function selectSpace(spaceId) {
  currentSpaceId = spaceId;

  // Update active state in sidebar
  document.querySelectorAll('.space-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.spaceId === spaceId);
  });

  // Load items
  try {
    allItems = await window.spacesPicker.getItems(spaceId);
    renderItems();
  } catch (err) {
    console.error('[Spaces Picker] Error loading items:', err);
    document.getElementById('items-grid').innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">${SVG_ICONS.warning}</div>
        <div style="color: #d32f2f;">Error loading items</div>
      </div>
    `;
  }
}

/**
 * Render items grid with current filter and search
 */
function renderItems() {
  const grid = document.getElementById('items-grid');

  // Apply filters
  let filtered = allItems;

  // Filter by type
  if (currentFilter !== 'all') {
    filtered = filtered.filter((item) => item.type === currentFilter);
  }

  // Filter by search query
  if (searchQuery) {
    const query = searchQuery.toLowerCase();
    filtered = filtered.filter((item) => {
      const preview = (item.preview || '').toLowerCase();
      const fileName = (item.fileName || '').toLowerCase();
      return preview.includes(query) || fileName.includes(query);
    });
  }

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">${SVG_ICONS.empty}</div>
        <div>No items found</div>
      </div>
    `;
    return;
  }

  grid.innerHTML = filtered
    .map((item) => {
      const isSelected = selectedItems.some((s) => s.id === item.id);
      const icon = getTypeIcon(item.type);
      const displayName = item.fileName || item.preview || 'Item';

      return `
      <div class="item-card ${isSelected ? 'selected' : ''}" data-item-id="${item.id}">
        <div class="item-icon">${icon}</div>
        <div class="item-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</div>
      </div>
    `;
    })
    .join('');

  // Add click handlers
  grid.querySelectorAll('.item-card').forEach((card) => {
    card.onclick = () => {
      const itemId = card.dataset.itemId;
      const item = allItems.find((i) => i.id === itemId);
      if (item) {
        toggleItemSelection(item);
      }
    };
  });
}

/**
 * Toggle item selection
 */
function toggleItemSelection(item) {
  const index = selectedItems.findIndex((s) => s.id === item.id);

  if (index >= 0) {
    selectedItems.splice(index, 1);
  } else {
    selectedItems.push(item);
  }

  updateSelection();
}

/**
 * Update UI based on current selection
 */
function updateSelection() {
  // Update visual state
  document.querySelectorAll('.item-card').forEach((card) => {
    const isSelected = selectedItems.some((s) => s.id === card.dataset.itemId);
    card.classList.toggle('selected', isSelected);
  });

  // Update footer
  const count = selectedItems.length;
  document.getElementById('selection-info').textContent = `${count} item${count === 1 ? '' : 's'} selected`;
  document.getElementById('select-btn').disabled = count === 0;
}

/**
 * Handle filter button clicks
 */
function setupFilters() {
  document.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.onclick = () => {
      currentFilter = btn.dataset.filter;

      // Update active state
      document.querySelectorAll('.filter-btn').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });

      renderItems();
    };
  });
}

/**
 * Handle search input
 */
function setupSearch() {
  const searchInput = document.getElementById('search-input');

  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    renderItems();
  });
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Event handlers
document.getElementById('cancel-btn').onclick = () => {
  window.spacesPicker.cancel();
};

document.getElementById('select-btn').onclick = () => {
  console.log('[Spaces Picker] Selecting', selectedItems.length, 'items');
  window.spacesPicker.selectItems(selectedItems);
};

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    window.spacesPicker.cancel();
  } else if (e.key === 'Enter' && selectedItems.length > 0) {
    window.spacesPicker.selectItems(selectedItems);
  }
});

// Initialize
setupFilters();
setupSearch();
loadSpaces();
