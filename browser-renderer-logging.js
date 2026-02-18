/**
 * Add this script to browser-renderer.js to enable automatic tab/window logging
 * This will log all tab creation, switching, and closing events
 */

// Override createNewTab to add logging
const originalCreateNewTab = window.createNewTab;
if (originalCreateNewTab) {
  window.createNewTab = function (url) {
    const result = originalCreateNewTab.call(this, url);

    // Log tab creation
    if (window.api && window.api.logTabCreated) {
      window.api.logTabCreated(result?.tabId || 'unknown', url, {
        source: 'user-action',
        timestamp: new Date().toISOString(),
      });
    }

    return result;
  };
}

// Log tab switches
document.addEventListener('tab-switched', (event) => {
  if (window.api && window.api.logTabSwitched) {
    window.api.logTabSwitched(event.detail.fromTab, event.detail.toTab);
  }
});

// Log tab closes
document.addEventListener('tab-closed', (event) => {
  if (window.api && window.api.logTabClosed) {
    window.api.logTabClosed(event.detail.tabId, event.detail.url);
  }
});

// Log navigation events
window.addEventListener('navigation', (event) => {
  if (window.api && window.api.logWindowNavigation) {
    window.api.logWindowNavigation('main', event.detail.url, event.detail.from);
  }
});

console.log('Browser renderer logging initialized');
