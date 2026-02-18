/**
 * Tab Picker - Client-side script
 *
 * Handles tab selection and communication with the main process
 */

document.addEventListener('DOMContentLoaded', () => {
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const tabList = document.getElementById('tabList');
  const loadingState = document.getElementById('loadingState');
  const emptyState = document.getElementById('emptyState');
  const closeBtn = document.getElementById('closeBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const attachBtn = document.getElementById('attachBtn');
  const urlInput = document.getElementById('urlInput');
  const fetchUrlBtn = document.getElementById('fetchUrlBtn');
  const setupLink = document.getElementById('setupLink');

  let selectedTabId = null;
  let tabs = [];

  // Initialize
  checkConnectionAndLoadTabs();

  // Event listeners
  closeBtn.addEventListener('click', () => window.tabPicker.close());
  cancelBtn.addEventListener('click', () => window.tabPicker.close());

  attachBtn.addEventListener('click', () => {
    if (selectedTabId) {
      attachSelectedTab();
    }
  });

  fetchUrlBtn.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (url) {
      fetchUrl(url);
    }
  });

  urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      const url = urlInput.value.trim();
      if (url) {
        fetchUrl(url);
      }
    }
  });

  setupLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.tabPicker.openSetupGuide();
  });

  /**
   * Check connection and load tabs
   */
  async function checkConnectionAndLoadTabs() {
    try {
      const status = await window.tabPicker.getStatus();

      if (status.extensionConnected) {
        showConnected();
        loadTabs();
      } else {
        showDisconnected();
      }
    } catch (error) {
      console.error('Error checking status:', error);
      showDisconnected();
    }
  }

  /**
   * Show connected state
   */
  function showConnected() {
    statusDot.classList.add('connected');
    statusText.textContent = 'Extension connected';
  }

  /**
   * Show disconnected state
   */
  function showDisconnected() {
    statusDot.classList.remove('connected');
    statusText.textContent = 'Extension not connected';
    loadingState.classList.add('hidden');
    emptyState.classList.remove('hidden');
  }

  /**
   * Load tabs from extension
   */
  async function loadTabs() {
    try {
      loadingState.classList.remove('hidden');
      emptyState.classList.add('hidden');

      tabs = await window.tabPicker.getTabs();

      loadingState.classList.add('hidden');

      if (tabs && tabs.length > 0) {
        renderTabs(tabs);
      } else {
        emptyState.classList.remove('hidden');
        emptyState.querySelector('h3').textContent = 'No Tabs Found';
        emptyState.querySelector('p').textContent = 'Open some tabs in your browser first.';
      }
    } catch (error) {
      console.error('Error loading tabs:', error);
      loadingState.classList.add('hidden');
      emptyState.classList.remove('hidden');
    }
  }

  /**
   * Render tab list
   */
  function renderTabs(tabs) {
    // Remove loading and empty states
    loadingState.classList.add('hidden');
    emptyState.classList.add('hidden');

    // Clear existing tab items
    const existingItems = tabList.querySelectorAll('.tab-item');
    existingItems.forEach((item) => item.remove());

    // Sort: active tab first, then by title
    const sortedTabs = [...tabs].sort((a, b) => {
      if (a.active && !b.active) return -1;
      if (!a.active && b.active) return 1;
      return (a.title || '').localeCompare(b.title || '');
    });

    // Render each tab
    sortedTabs.forEach((tab) => {
      const item = createTabItem(tab);
      tabList.appendChild(item);
    });
  }

  /**
   * Create a tab item element
   */
  function createTabItem(tab) {
    const item = document.createElement('div');
    item.className = 'tab-item';
    item.dataset.tabId = tab.id;

    // Extract domain from URL
    let domain = '';
    try {
      domain = new URL(tab.url).hostname;
    } catch (_e) {
      domain = tab.url;
    }

    // Favicon
    const faviconDiv = document.createElement('div');
    faviconDiv.className = 'tab-favicon';
    if (tab.favIconUrl) {
      const img = document.createElement('img');
      img.src = tab.favIconUrl;
      img.onerror = () => {
        img.style.display = 'none';
        faviconDiv.textContent = '🌐';
        faviconDiv.style.display = 'flex';
        faviconDiv.style.alignItems = 'center';
        faviconDiv.style.justifyContent = 'center';
        faviconDiv.style.fontSize = '12px';
      };
      faviconDiv.appendChild(img);
    } else {
      faviconDiv.textContent = '🌐';
      faviconDiv.style.display = 'flex';
      faviconDiv.style.alignItems = 'center';
      faviconDiv.style.justifyContent = 'center';
      faviconDiv.style.fontSize = '12px';
    }

    // Info section
    const infoDiv = document.createElement('div');
    infoDiv.className = 'tab-info';

    const titleDiv = document.createElement('div');
    titleDiv.className = 'tab-title';
    titleDiv.textContent = tab.title || 'Untitled';

    const urlDiv = document.createElement('div');
    urlDiv.className = 'tab-url';
    urlDiv.textContent = domain;

    infoDiv.appendChild(titleDiv);
    infoDiv.appendChild(urlDiv);

    // Assemble
    item.appendChild(faviconDiv);
    item.appendChild(infoDiv);

    // Active badge
    if (tab.active) {
      const badge = document.createElement('span');
      badge.className = 'tab-active-badge';
      badge.textContent = 'Active';
      item.appendChild(badge);
    }

    // Click handler
    item.addEventListener('click', () => {
      selectTab(tab.id);
    });

    // Double-click to select and attach
    item.addEventListener('dblclick', () => {
      selectTab(tab.id);
      attachSelectedTab();
    });

    return item;
  }

  /**
   * Select a tab
   */
  function selectTab(tabId) {
    // Deselect previous
    const prevSelected = tabList.querySelector('.tab-item.selected');
    if (prevSelected) {
      prevSelected.classList.remove('selected');
    }

    // Select new
    const item = tabList.querySelector(`.tab-item[data-tab-id="${tabId}"]`);
    if (item) {
      item.classList.add('selected');
      selectedTabId = tabId;
      attachBtn.disabled = false;
    }
  }

  /**
   * Attach the selected tab
   */
  async function attachSelectedTab() {
    if (!selectedTabId) return;

    attachBtn.disabled = true;
    attachBtn.textContent = 'Capturing...';

    try {
      const capture = await window.tabPicker.captureTab(selectedTabId);

      // Send result back to main window
      window.tabPicker.sendResult({
        type: 'tab-capture',
        data: capture,
      });

      window.tabPicker.close();
    } catch (error) {
      console.error('Error capturing tab:', error);
      attachBtn.disabled = false;
      attachBtn.textContent = 'Attach Selected';
      alert('Failed to capture tab: ' + error.message);
    }
  }

  /**
   * Fetch URL as fallback
   */
  async function fetchUrl(url) {
    // Validate URL
    try {
      new URL(url);
    } catch (_e) {
      alert('Please enter a valid URL');
      return;
    }

    fetchUrlBtn.disabled = true;
    fetchUrlBtn.textContent = 'Fetching...';

    try {
      const capture = await window.tabPicker.fetchUrl(url);

      // Send result back to main window
      window.tabPicker.sendResult({
        type: 'url-capture',
        data: capture,
      });

      window.tabPicker.close();
    } catch (error) {
      console.error('Error fetching URL:', error);
      fetchUrlBtn.disabled = false;
      fetchUrlBtn.textContent = 'Fetch';
      alert('Failed to fetch URL: ' + error.message);
    }
  }

  // Listen for tab updates from main process
  window.tabPicker.onTabsUpdate((newTabs) => {
    tabs = newTabs;
    renderTabs(tabs);
  });

  // Listen for status updates
  window.tabPicker.onStatusUpdate((status) => {
    if (status.extensionConnected) {
      showConnected();
      if (!tabs.length) {
        loadTabs();
      }
    } else {
      showDisconnected();
    }
  });
});
