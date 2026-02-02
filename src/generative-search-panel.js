/**
 * Generative Search Panel - Renderer Script
 * 
 * UI component for the generative search feature.
 * Provides slider-based filter controls and displays results.
 */

// Filter definitions (must match backend)
const FILTER_DEFINITIONS = {
  // Context-Aware
  related_to_project: {
    id: 'related_to_project',
    name: 'Related to Project',
    description: 'How relevant to the current space/project',
    category: 'context',
    icon: '●'
  },
  similar_to_item: {
    id: 'similar_to_item',
    name: 'Similar to Selected',
    description: 'Semantic similarity to a reference item',
    category: 'context',
    icon: '◆',
    requiresReference: true
  },
  useful_for: {
    id: 'useful_for',
    name: 'Useful For',
    description: 'Match against a specific goal/task',
    category: 'context',
    icon: '◈',
    requiresInput: true,
    inputPlaceholder: 'Describe what you need...'
  },

  // Quality
  quality_score: {
    id: 'quality_score',
    name: 'Quality Score',
    description: 'Polish, completeness, craftsmanship',
    category: 'quality',
    icon: '★'
  },
  interesting_novel: {
    id: 'interesting_novel',
    name: 'Interesting/Novel',
    description: 'How unique or creative',
    category: 'quality',
    icon: '◇'
  },
  recent_favorites: {
    id: 'recent_favorites',
    name: 'Recent Favorites',
    description: 'Quality + recency signals',
    category: 'quality',
    icon: '♦'
  },

  // Purpose
  good_visual_for: {
    id: 'good_visual_for',
    name: 'Good Visual For',
    description: 'Find images/videos for a specific use',
    category: 'purpose',
    icon: '▣',
    requiresInput: true,
    inputPlaceholder: 'What do you need a visual for?'
  },
  reference_material: {
    id: 'reference_material',
    name: 'Reference Material',
    description: 'Items that teach or explain concepts',
    category: 'purpose',
    icon: '▤'
  },
  working_example: {
    id: 'working_example',
    name: 'Working Example Of',
    description: 'Code/patterns that demonstrate something',
    category: 'purpose',
    icon: '▧',
    requiresInput: true,
    inputPlaceholder: 'What pattern or technique?'
  },
  inspiration_for: {
    id: 'inspiration_for',
    name: 'Inspiration For',
    description: 'Creative starting points',
    category: 'purpose',
    icon: '◐',
    requiresInput: true,
    inputPlaceholder: 'What are you creating?'
  },

  // Content Analysis
  actionable_insights: {
    id: 'actionable_insights',
    name: 'Has Actionable Insights',
    description: 'Contains things you can act on',
    category: 'content',
    icon: '✓'
  },
  contains_data_about: {
    id: 'contains_data_about',
    name: 'Contains Data About',
    description: 'Items with relevant data/statistics',
    category: 'content',
    icon: '▥',
    requiresInput: true,
    inputPlaceholder: 'What topic?'
  },
  explains_concept: {
    id: 'explains_concept',
    name: 'Explains Concept',
    description: 'Educational content about a topic',
    category: 'content',
    icon: '▦',
    requiresInput: true,
    inputPlaceholder: 'What concept?'
  },

  // Organizational
  needs_attention: {
    id: 'needs_attention',
    name: 'Needs Attention',
    description: 'Incomplete, outdated, or needs metadata',
    category: 'organizational',
    icon: '!'
  },
  duplicates_variations: {
    id: 'duplicates_variations',
    name: 'Duplicates/Variations',
    description: 'Similar items to consolidate',
    category: 'organizational',
    icon: '≡'
  }
};

const CATEGORIES = {
  context: { name: 'Context-Aware', icon: '●' },
  quality: { name: 'Quality & Time', icon: '★' },
  purpose: { name: 'Purpose-Based', icon: '◐' },
  content: { name: 'Content Analysis', icon: '▥' },
  organizational: { name: 'Organizational', icon: '≡' }
};

class GenerativeSearchPanel {
  constructor(container, options = {}) {
    this.container = typeof container === 'string' 
      ? document.querySelector(container) 
      : container;
    
    this.options = options;
    this.activeFilters = [];
    this.isSearching = false;
    this.results = [];
    this.referenceItem = null;
    this.currentSpace = options.currentSpace || null;
    
    // Callbacks
    this.onSearch = options.onSearch || null;
    this.onResults = options.onResults || null;
    this.onCancel = options.onCancel || null;
    
    // Search history and saved searches
    this.searchHistory = this.loadSearchHistory();
    this.savedSearches = this.loadSavedSearches();
    this.lastSearchOptions = null;
    
    this.init();
  }
  
  // ============ Search History & Saved Searches ============
  
  loadSearchHistory() {
    try {
      return JSON.parse(localStorage.getItem('gs_search_history') || '[]');
    } catch (e) {
      return [];
    }
  }
  
  saveSearchHistory() {
    try {
      localStorage.setItem('gs_search_history', JSON.stringify(this.searchHistory.slice(0, 20)));
    } catch (e) {
      console.warn('Could not save search history');
    }
  }
  
  addToHistory(searchOptions, resultCount) {
    const entry = {
      id: Date.now(),
      query: searchOptions.userQuery || '',
      filters: searchOptions.filters || [],
      mode: searchOptions.mode || 'quick',
      resultCount,
      timestamp: Date.now()
    };
    
    // Remove duplicate queries
    this.searchHistory = this.searchHistory.filter(h => 
      h.query !== entry.query || JSON.stringify(h.filters) !== JSON.stringify(entry.filters)
    );
    
    // Add to front
    this.searchHistory.unshift(entry);
    
    // Keep last 20
    this.searchHistory = this.searchHistory.slice(0, 20);
    
    this.saveSearchHistory();
    this.lastSearchOptions = searchOptions;
  }
  
  loadSavedSearches() {
    try {
      return JSON.parse(localStorage.getItem('gs_saved_searches') || '[]');
    } catch (e) {
      return [];
    }
  }
  
  saveSavedSearches() {
    try {
      localStorage.setItem('gs_saved_searches', JSON.stringify(this.savedSearches));
    } catch (e) {
      console.warn('Could not save searches');
    }
  }
  
  saveCurrentSearch(name) {
    if (!this.lastSearchOptions) return;
    
    const saved = {
      id: Date.now(),
      name: name || `Search ${this.savedSearches.length + 1}`,
      query: this.lastSearchOptions.userQuery || '',
      filters: this.lastSearchOptions.filters || [],
      mode: this.lastSearchOptions.mode || 'quick',
      createdAt: Date.now()
    };
    
    this.savedSearches.push(saved);
    this.saveSavedSearches();
    this.renderHistorySection();
  }
  
  deleteSavedSearch(id) {
    this.savedSearches = this.savedSearches.filter(s => s.id !== id);
    this.saveSavedSearches();
    this.renderHistorySection();
  }
  
  loadSearch(entry) {
    // Set query
    const queryInput = this.container.querySelector('.gs-query-input');
    if (queryInput) queryInput.value = entry.query || '';
    
    // Set filters
    this.activeFilters = JSON.parse(JSON.stringify(entry.filters || []));
    this.renderActiveFilters();
    this.updateCostEstimate();
  }
  
  formatTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  init() {
    this.render();
    this.bindEvents();
  }

  render() {
    this.container.innerHTML = `
      <div class="generative-search-panel">
        <div class="gs-header">
          <h3>Generative Search</h3>
          <button class="gs-close-btn" title="Close">&times;</button>
        </div>
        
        <div class="gs-query-section">
          <label>Describe what you're looking for:</label>
          <textarea class="gs-query-input" placeholder="E.g., 'Find images that would work well for a tech presentation' or 'Show me my best code examples from this project'"></textarea>
        </div>
        
        <div class="gs-filters-section">
          <div class="gs-filters-header">
            <span>Active Filters</span>
            <button class="gs-add-filter-btn">+ Add Filter</button>
          </div>
          <div class="gs-active-filters"></div>
        </div>
        
        <div class="gs-filter-picker" style="display: none;">
          <div class="gs-filter-picker-header">
            <span>Select a Filter</span>
            <button class="gs-filter-picker-close">&times;</button>
          </div>
          <div class="gs-filter-categories"></div>
        </div>
        
        <div class="gs-actions">
          <div class="gs-cost-estimate">
            <span class="gs-cost-text">Ready to search</span>
          </div>
          <div class="gs-action-buttons">
            <button class="gs-quick-scan-btn" title="Fast search using metadata only">Quick Scan</button>
            <button class="gs-deep-scan-btn" title="Thorough search including content">Deep Scan</button>
          </div>
        </div>
        
        <div class="gs-progress" style="display: none;">
          <div class="gs-progress-bar">
            <div class="gs-progress-fill"></div>
          </div>
          <div class="gs-progress-text">Processing...</div>
          <button class="gs-cancel-btn">Cancel</button>
        </div>
        
        <div class="gs-results-summary" style="display: none;">
          <span class="gs-results-count"></span>
          <button class="gs-save-search-btn" title="Save this search">Save</button>
          <button class="gs-clear-results">Clear</button>
        </div>
        
        <div class="gs-history-section">
          <div class="gs-history-header" style="display: flex; justify-content: space-between; align-items: center; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-color, #333);">
            <span style="color: var(--text-secondary, #888); font-size: 12px;">Recent & Saved</span>
            <button class="gs-toggle-history-btn" style="background: none; border: none; color: var(--text-secondary, #888); font-size: 11px; cursor: pointer;">▼ Show</button>
          </div>
          <div class="gs-history-content" style="display: none;"></div>
        </div>
      </div>
    `;

    this.renderFilterPicker();
    this.renderHistorySection();
    this.applyStyles();
  }

  renderFilterPicker() {
    const pickerCategories = this.container.querySelector('.gs-filter-categories');
    
    let html = '';
    for (const [catId, category] of Object.entries(CATEGORIES)) {
      const filters = Object.values(FILTER_DEFINITIONS).filter(f => f.category === catId);
      
      html += `
        <div class="gs-filter-category">
          <div class="gs-category-header">${category.icon} ${category.name}</div>
          <div class="gs-category-filters">
            ${filters.map(filter => `
              <div class="gs-filter-option" data-filter-id="${filter.id}">
                <span class="gs-filter-icon">${filter.icon}</span>
                <div class="gs-filter-info">
                  <span class="gs-filter-name">${filter.name}</span>
                  <span class="gs-filter-desc">${filter.description}</span>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }
    
    pickerCategories.innerHTML = html;
  }
  
  renderHistorySection() {
    const content = this.container.querySelector('.gs-history-content');
    if (!content) return;
    
    let html = '';
    
    // Saved searches first
    if (this.savedSearches.length > 0) {
      html += `<div class="gs-saved-searches">
        <div style="font-size: 11px; color: var(--text-secondary, #666); margin-bottom: 6px;">Saved Searches</div>
        ${this.savedSearches.map(s => `
          <div class="gs-history-item gs-saved-item" data-type="saved" data-id="${s.id}">
            <div class="gs-history-item-main">
              <span class="gs-history-name">${this.escapeHtml(s.name)}</span>
              <span class="gs-history-query">${this.escapeHtml(s.query || 'Filter-based search')}</span>
            </div>
            <button class="gs-delete-saved" data-id="${s.id}" title="Delete">×</button>
          </div>
        `).join('')}
      </div>`;
    }
    
    // Recent searches
    if (this.searchHistory.length > 0) {
      html += `<div class="gs-recent-searches" style="margin-top: ${this.savedSearches.length > 0 ? '12px' : '0'};">
        <div style="font-size: 11px; color: var(--text-secondary, #666); margin-bottom: 6px;">Recent Searches</div>
        ${this.searchHistory.slice(0, 10).map(h => `
          <div class="gs-history-item" data-type="history" data-id="${h.id}">
            <div class="gs-history-item-main">
              <span class="gs-history-query">${this.escapeHtml(h.query || 'Filter-based search')}</span>
              <span class="gs-history-meta">${h.resultCount} results • ${this.formatTimeAgo(h.timestamp)}</span>
            </div>
          </div>
        `).join('')}
      </div>`;
    }
    
    if (!html) {
      html = '<div style="color: var(--text-secondary, #666); font-size: 12px; padding: 8px; text-align: center;">No search history yet</div>';
    }
    
    content.innerHTML = html;
  }
  
  escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  renderActiveFilters() {
    const container = this.container.querySelector('.gs-active-filters');
    
    if (this.activeFilters.length === 0) {
      container.innerHTML = '<div class="gs-no-filters">No filters active. Add a filter or type a query above.</div>';
      return;
    }
    
    container.innerHTML = this.activeFilters.map((filter, index) => {
      const def = FILTER_DEFINITIONS[filter.id];
      
      return `
        <div class="gs-active-filter" data-index="${index}">
          <div class="gs-filter-top-row">
            <span class="gs-filter-icon">${def.icon}</span>
            <span class="gs-filter-name">${def.name}</span>
            <button class="gs-remove-filter" data-index="${index}">&times;</button>
          </div>
          
          ${def.requiresInput ? `
            <input type="text" class="gs-filter-input" 
                   data-index="${index}" 
                   placeholder="${def.inputPlaceholder || 'Enter value...'}"
                   value="${filter.input || ''}">
          ` : ''}
          
          <div class="gs-slider-row">
            <label>Threshold:</label>
            <input type="range" class="gs-threshold-slider" 
                   data-index="${index}" 
                   min="0" max="100" value="${filter.threshold || 50}">
            <span class="gs-threshold-value">${filter.threshold || 50}%</span>
          </div>
          
          <div class="gs-slider-row">
            <label>Weight:</label>
            <input type="range" class="gs-weight-slider" 
                   data-index="${index}" 
                   min="0" max="2" step="0.1" value="${filter.weight || 1}">
            <span class="gs-weight-value">${filter.weight || 1}x</span>
          </div>
        </div>
      `;
    }).join('');
  }

  bindEvents() {
    // Close button
    this.container.querySelector('.gs-close-btn')?.addEventListener('click', () => {
      this.hide();
    });
    
    // Add filter button
    this.container.querySelector('.gs-add-filter-btn')?.addEventListener('click', () => {
      this.toggleFilterPicker();
    });
    
    // Filter picker close
    this.container.querySelector('.gs-filter-picker-close')?.addEventListener('click', () => {
      this.hideFilterPicker();
    });
    
    // Filter options
    this.container.querySelector('.gs-filter-categories')?.addEventListener('click', (e) => {
      const option = e.target.closest('.gs-filter-option');
      if (option) {
        const filterId = option.dataset.filterId;
        this.addFilter(filterId);
        this.hideFilterPicker();
      }
    });
    
    // Active filters events (delegated)
    this.container.querySelector('.gs-active-filters')?.addEventListener('click', (e) => {
      if (e.target.classList.contains('gs-remove-filter')) {
        const index = parseInt(e.target.dataset.index);
        this.removeFilter(index);
      }
    });
    
    this.container.querySelector('.gs-active-filters')?.addEventListener('input', (e) => {
      const index = parseInt(e.target.dataset.index);
      
      if (e.target.classList.contains('gs-threshold-slider')) {
        this.activeFilters[index].threshold = parseInt(e.target.value);
        e.target.nextElementSibling.textContent = `${e.target.value}%`;
        this.updateCostEstimate();
      }
      
      if (e.target.classList.contains('gs-weight-slider')) {
        this.activeFilters[index].weight = parseFloat(e.target.value);
        e.target.nextElementSibling.textContent = `${e.target.value}x`;
      }
      
      if (e.target.classList.contains('gs-filter-input')) {
        this.activeFilters[index].input = e.target.value;
      }
    });
    
    // Search buttons
    this.container.querySelector('.gs-quick-scan-btn')?.addEventListener('click', () => {
      this.runSearch('quick');
    });
    
    this.container.querySelector('.gs-deep-scan-btn')?.addEventListener('click', () => {
      this.runSearch('deep');
    });
    
    // Cancel button
    this.container.querySelector('.gs-cancel-btn')?.addEventListener('click', () => {
      this.cancelSearch();
    });
    
    // Clear results
    this.container.querySelector('.gs-clear-results')?.addEventListener('click', () => {
      this.clearResults();
    });
    
    // Query input
    this.container.querySelector('.gs-query-input')?.addEventListener('input', () => {
      this.updateCostEstimate();
    });
    
    // Toggle history section
    this.container.querySelector('.gs-toggle-history-btn')?.addEventListener('click', (e) => {
      const content = this.container.querySelector('.gs-history-content');
      const btn = e.target;
      if (content.style.display === 'none') {
        content.style.display = 'block';
        btn.textContent = '▲ Hide';
      } else {
        content.style.display = 'none';
        btn.textContent = '▼ Show';
      }
    });
    
    // History item clicks (delegated)
    this.container.querySelector('.gs-history-content')?.addEventListener('click', (e) => {
      // Delete saved search
      if (e.target.classList.contains('gs-delete-saved')) {
        e.stopPropagation();
        const id = parseInt(e.target.dataset.id);
        this.deleteSavedSearch(id);
        return;
      }
      
      // Load a search
      const item = e.target.closest('.gs-history-item');
      if (item) {
        const type = item.dataset.type;
        const id = parseInt(item.dataset.id);
        
        let entry;
        if (type === 'saved') {
          entry = this.savedSearches.find(s => s.id === id);
        } else {
          entry = this.searchHistory.find(h => h.id === id);
        }
        
        if (entry) {
          this.loadSearch(entry);
        }
      }
    });
    
    // Save search button
    this.container.querySelector('.gs-save-search-btn')?.addEventListener('click', () => {
      const name = prompt('Name this search pattern:', this.lastSearchOptions?.userQuery || 'My Search');
      if (name) {
        this.saveCurrentSearch(name);
        alert('Search saved! Find it in Recent & Saved section.');
      }
    });
  }

  addFilter(filterId) {
    // Don't add duplicates
    if (this.activeFilters.some(f => f.id === filterId)) {
      return;
    }
    
    this.activeFilters.push({
      id: filterId,
      threshold: 50,
      weight: 1.0,
      input: ''
    });
    
    this.renderActiveFilters();
    this.updateCostEstimate();
  }

  removeFilter(index) {
    this.activeFilters.splice(index, 1);
    this.renderActiveFilters();
    this.updateCostEstimate();
  }

  toggleFilterPicker() {
    const picker = this.container.querySelector('.gs-filter-picker');
    picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
  }

  hideFilterPicker() {
    this.container.querySelector('.gs-filter-picker').style.display = 'none';
  }

  async updateCostEstimate() {
    const query = this.container.querySelector('.gs-query-input')?.value || '';
    const costText = this.container.querySelector('.gs-cost-text');
    
    if (this.activeFilters.length === 0 && !query.trim()) {
      costText.textContent = 'Add filters or type a query to search';
      return;
    }
    
    // Get item count from API
    try {
      const estimate = await window.clipboard?.generativeSearch?.estimateCost({
        spaceId: this.currentSpace,
        filters: this.activeFilters,
        mode: 'quick'
      });
      
      if (estimate) {
        costText.textContent = estimate.formatted;
      } else {
        costText.textContent = 'Ready to search';
      }
    } catch (e) {
      costText.textContent = 'Ready to search';
    }
  }

  async runSearch(mode) {
    const query = this.container.querySelector('.gs-query-input')?.value || '';
    
    if (this.activeFilters.length === 0 && !query.trim()) {
      alert('Please add at least one filter or enter a search query.');
      return;
    }
    
    this.isSearching = true;
    this.showProgress();
    
    const searchOptions = {
      filters: this.activeFilters,
      spaceId: this.currentSpace,
      mode: mode,
      userQuery: query,
      referenceItem: this.referenceItem
    };
    
    try {
      if (this.onSearch) {
        this.results = await this.onSearch(searchOptions);
      } else if (window.clipboard?.generativeSearch?.search) {
        this.results = await window.clipboard.generativeSearch.search(searchOptions);
      }
      
      this.hideProgress();
      this.showResultsSummary();
      
      // Save to history
      this.addToHistory(searchOptions, this.results.length);
      this.renderHistorySection();
      
      if (this.onResults) {
        this.onResults(this.results);
      }
    } catch (error) {
      this.hideProgress();
      console.error('[GenerativeSearch] Search error:', error);
      alert('Search failed: ' + error.message);
    }
    
    this.isSearching = false;
  }

  cancelSearch() {
    if (this.onCancel) {
      this.onCancel();
    }
    this.isSearching = false;
    this.hideProgress();
  }

  showProgress() {
    this.container.querySelector('.gs-progress').style.display = 'block';
    this.container.querySelector('.gs-actions').style.display = 'none';
  }

  hideProgress() {
    this.container.querySelector('.gs-progress').style.display = 'none';
    this.container.querySelector('.gs-actions').style.display = 'flex';
  }

  updateProgress(percent, text) {
    const fill = this.container.querySelector('.gs-progress-fill');
    const textEl = this.container.querySelector('.gs-progress-text');
    
    if (fill) fill.style.width = `${percent}%`;
    if (textEl) textEl.textContent = text || `Processing... ${percent}%`;
  }

  showResultsSummary() {
    const summary = this.container.querySelector('.gs-results-summary');
    const count = this.container.querySelector('.gs-results-count');
    
    summary.style.display = 'flex';
    count.textContent = `Found ${this.results.length} matching items`;
  }

  clearResults() {
    this.results = [];
    this.container.querySelector('.gs-results-summary').style.display = 'none';
    
    if (this.onResults) {
      this.onResults([]);
    }
  }

  setReferenceItem(item) {
    this.referenceItem = item;
  }

  setCurrentSpace(spaceId) {
    this.currentSpace = spaceId;
    this.updateCostEstimate();
  }

  show() {
    this.container.style.display = 'block';
    this.renderActiveFilters();
    this.updateCostEstimate();
  }

  hide() {
    this.container.style.display = 'none';
  }

  applyStyles() {
    // Check if styles already exist
    if (document.getElementById('generative-search-styles')) return;
    
    const styles = document.createElement('style');
    styles.id = 'generative-search-styles';
    styles.textContent = `
      .generative-search-panel {
        background: var(--bg-secondary, #1e1e1e);
        border: 1px solid var(--border-color, #333);
        border-radius: 8px;
        padding: 16px;
        max-height: 80vh;
        overflow-y: auto;
      }
      
      .gs-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 16px;
      }
      
      .gs-header h3 {
        margin: 0;
        font-size: 16px;
        color: var(--text-primary, #fff);
      }
      
      .gs-close-btn {
        background: none;
        border: none;
        color: var(--text-secondary, #888);
        font-size: 20px;
        cursor: pointer;
        padding: 0 4px;
      }
      
      .gs-close-btn:hover {
        color: var(--text-primary, #fff);
      }
      
      .gs-query-section {
        margin-bottom: 16px;
      }
      
      .gs-query-section label {
        display: block;
        margin-bottom: 6px;
        color: var(--text-secondary, #888);
        font-size: 13px;
      }
      
      .gs-query-input {
        width: 100%;
        min-height: 60px;
        padding: 8px;
        border: 1px solid var(--border-color, #333);
        border-radius: 4px;
        background: var(--bg-primary, #121212);
        color: var(--text-primary, #fff);
        font-size: 13px;
        resize: vertical;
      }
      
      .gs-filters-section {
        margin-bottom: 16px;
      }
      
      .gs-filters-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
      }
      
      .gs-filters-header span {
        color: var(--text-secondary, #888);
        font-size: 13px;
      }
      
      .gs-add-filter-btn {
        background: var(--accent-color, #4a9eff);
        color: white;
        border: none;
        padding: 4px 12px;
        border-radius: 4px;
        font-size: 12px;
        cursor: pointer;
      }
      
      .gs-add-filter-btn:hover {
        background: var(--accent-hover, #3a8eef);
      }
      
      .gs-no-filters {
        color: var(--text-secondary, #666);
        font-size: 13px;
        padding: 12px;
        text-align: center;
        background: var(--bg-primary, #121212);
        border-radius: 4px;
      }
      
      .gs-active-filter {
        background: var(--bg-primary, #121212);
        border: 1px solid var(--border-color, #333);
        border-radius: 6px;
        padding: 12px;
        margin-bottom: 8px;
      }
      
      .gs-filter-top-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }
      
      .gs-filter-icon {
        font-size: 16px;
      }
      
      .gs-filter-name {
        flex: 1;
        font-weight: 500;
        color: var(--text-primary, #fff);
      }
      
      .gs-remove-filter {
        background: none;
        border: none;
        color: var(--text-secondary, #666);
        font-size: 18px;
        cursor: pointer;
        padding: 0;
      }
      
      .gs-remove-filter:hover {
        color: #ff4444;
      }
      
      .gs-filter-input {
        width: 100%;
        padding: 6px 8px;
        margin-bottom: 8px;
        border: 1px solid var(--border-color, #333);
        border-radius: 4px;
        background: var(--bg-secondary, #1e1e1e);
        color: var(--text-primary, #fff);
        font-size: 12px;
      }
      
      .gs-slider-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 4px;
      }
      
      .gs-slider-row label {
        color: var(--text-secondary, #888);
        font-size: 11px;
        min-width: 60px;
      }
      
      .gs-slider-row input[type="range"] {
        flex: 1;
        height: 4px;
        -webkit-appearance: none;
        background: var(--border-color, #333);
        border-radius: 2px;
      }
      
      .gs-slider-row input[type="range"]::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 14px;
        height: 14px;
        background: var(--accent-color, #4a9eff);
        border-radius: 50%;
        cursor: pointer;
      }
      
      .gs-threshold-value, .gs-weight-value {
        color: var(--text-secondary, #888);
        font-size: 11px;
        min-width: 35px;
        text-align: right;
      }
      
      .gs-filter-picker {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        background: var(--bg-secondary, #1e1e1e);
        border: 1px solid var(--border-color, #333);
        border-radius: 8px;
        padding: 12px;
        z-index: 100;
        max-height: 400px;
        overflow-y: auto;
      }
      
      .gs-filter-picker-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
        padding-bottom: 8px;
        border-bottom: 1px solid var(--border-color, #333);
      }
      
      .gs-filter-picker-close {
        background: none;
        border: none;
        color: var(--text-secondary, #888);
        font-size: 18px;
        cursor: pointer;
      }
      
      .gs-filter-category {
        margin-bottom: 12px;
      }
      
      .gs-category-header {
        font-size: 12px;
        color: var(--text-secondary, #888);
        margin-bottom: 6px;
      }
      
      .gs-filter-option {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px;
        margin-bottom: 4px;
        border-radius: 4px;
        cursor: pointer;
        transition: background 0.15s;
      }
      
      .gs-filter-option:hover {
        background: var(--bg-hover, #2a2a2a);
      }
      
      .gs-filter-info {
        display: flex;
        flex-direction: column;
      }
      
      .gs-filter-info .gs-filter-name {
        font-size: 13px;
        color: var(--text-primary, #fff);
      }
      
      .gs-filter-info .gs-filter-desc {
        font-size: 11px;
        color: var(--text-secondary, #666);
      }
      
      .gs-actions {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding-top: 12px;
        border-top: 1px solid var(--border-color, #333);
      }
      
      .gs-cost-estimate {
        color: var(--text-secondary, #888);
        font-size: 12px;
      }
      
      .gs-action-buttons {
        display: flex;
        gap: 8px;
      }
      
      .gs-quick-scan-btn, .gs-deep-scan-btn {
        padding: 8px 16px;
        border: none;
        border-radius: 4px;
        font-size: 13px;
        cursor: pointer;
      }
      
      .gs-quick-scan-btn {
        background: var(--bg-primary, #121212);
        color: var(--text-primary, #fff);
        border: 1px solid var(--border-color, #333);
      }
      
      .gs-deep-scan-btn {
        background: var(--accent-color, #4a9eff);
        color: white;
      }
      
      .gs-quick-scan-btn:hover {
        background: var(--bg-hover, #2a2a2a);
      }
      
      .gs-deep-scan-btn:hover {
        background: var(--accent-hover, #3a8eef);
      }
      
      .gs-progress {
        padding: 16px 0;
        text-align: center;
      }
      
      .gs-progress-bar {
        height: 4px;
        background: var(--border-color, #333);
        border-radius: 2px;
        margin-bottom: 8px;
        overflow: hidden;
      }
      
      .gs-progress-fill {
        height: 100%;
        background: var(--accent-color, #4a9eff);
        width: 0%;
        transition: width 0.3s;
      }
      
      .gs-progress-text {
        color: var(--text-secondary, #888);
        font-size: 12px;
        margin-bottom: 8px;
      }
      
      .gs-cancel-btn {
        background: none;
        border: 1px solid var(--border-color, #333);
        color: var(--text-secondary, #888);
        padding: 4px 12px;
        border-radius: 4px;
        font-size: 12px;
        cursor: pointer;
      }
      
      .gs-cancel-btn:hover {
        color: var(--text-primary, #fff);
        border-color: var(--text-secondary, #888);
      }
      
      .gs-results-summary {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px;
        background: var(--bg-primary, #121212);
        border-radius: 4px;
        margin-top: 12px;
      }
      
      .gs-results-count {
        color: var(--text-primary, #fff);
        font-size: 13px;
      }
      
      .gs-clear-results {
        background: none;
        border: none;
        color: var(--text-secondary, #888);
        font-size: 12px;
        cursor: pointer;
        text-decoration: underline;
      }
      
      .gs-clear-results:hover {
        color: var(--text-primary, #fff);
      }
      
      /* Save button in results */
      .gs-save-search-btn {
        background: none;
        border: none;
        color: var(--text-secondary, #888);
        font-size: 12px;
        cursor: pointer;
        margin-right: 12px;
      }
      
      .gs-save-search-btn:hover {
        color: #4CAF50;
      }
      
      /* History section */
      .gs-history-content {
        margin-top: 8px;
        max-height: 200px;
        overflow-y: auto;
      }
      
      .gs-history-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 10px;
        margin-bottom: 4px;
        background: var(--bg-primary, #121212);
        border-radius: 4px;
        cursor: pointer;
        transition: background 0.15s;
      }
      
      .gs-history-item:hover {
        background: var(--bg-hover, #2a2a2a);
      }
      
      .gs-saved-item {
        border-left: 3px solid #4CAF50;
      }
      
      .gs-history-item-main {
        display: flex;
        flex-direction: column;
        gap: 2px;
        overflow: hidden;
      }
      
      .gs-history-name {
        font-size: 12px;
        font-weight: 500;
        color: #4CAF50;
      }
      
      .gs-history-query {
        font-size: 12px;
        color: var(--text-primary, #fff);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 250px;
      }
      
      .gs-history-meta {
        font-size: 10px;
        color: var(--text-secondary, #666);
      }
      
      .gs-delete-saved {
        background: none;
        border: none;
        color: var(--text-secondary, #666);
        font-size: 16px;
        cursor: pointer;
        padding: 0 4px;
        opacity: 0;
        transition: opacity 0.15s;
      }
      
      .gs-history-item:hover .gs-delete-saved {
        opacity: 1;
      }
      
      .gs-delete-saved:hover {
        color: #ff4444;
      }
    `;
    
    document.head.appendChild(styles);
  }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GenerativeSearchPanel, FILTER_DEFINITIONS, CATEGORIES };
} else {
  window.GenerativeSearchPanel = GenerativeSearchPanel;
  window.GS_FILTER_DEFINITIONS = FILTER_DEFINITIONS;
  window.GS_CATEGORIES = CATEGORIES;
}
