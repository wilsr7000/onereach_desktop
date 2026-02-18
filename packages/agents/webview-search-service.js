/**
 * Webview Search Service
 *
 * Uses a hidden BrowserWindow to perform web searches by loading
 * actual search pages and extracting results via JavaScript injection.
 *
 * This is more reliable than API-based approaches which can be blocked
 * or return empty results.
 */

const { BrowserWindow } = require('electron');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

// Search window instance (reused across searches)
let searchWindow = null;

// Cache for recent searches (avoids duplicate requests)
const searchCache = new Map();
const CACHE_TTL = 60000; // 1 minute cache

// Timeout for search operations
const SEARCH_TIMEOUT = 12000; // 12 seconds

/**
 * Create or get the hidden search window
 */
function getSearchWindow() {
  if (searchWindow && !searchWindow.isDestroyed()) {
    return searchWindow;
  }

  searchWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false, // Hidden window
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Allow loading external pages
      webSecurity: true,
    },
  });

  // Set a realistic user agent
  searchWindow.webContents.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  // Handle window errors
  searchWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    log.error('agent', 'Load failed', { errorCode, errorDescription });
  });

  return searchWindow;
}

/**
 * Extract search results from Google search page
 * This script runs in the context of the loaded page
 */
const GOOGLE_EXTRACTION_SCRIPT = `
  (function() {
    const results = [];
    
    // Google search results are in divs with class 'g'
    const items = document.querySelectorAll('div.g');
    
    items.forEach((item, index) => {
      if (index >= 10) return; // Limit to 10 results
      
      const linkEl = item.querySelector('a[href^="http"]');
      const titleEl = item.querySelector('h3');
      const snippetEl = item.querySelector('[data-sncf], [data-content-feature], .VwiC3b, [data-lyxz="g"]');
      
      if (linkEl && titleEl) {
        const url = linkEl.href;
        const title = titleEl.textContent || '';
        const snippet = snippetEl ? snippetEl.textContent : '';
        
        // Skip Google's own results and empty entries
        if (url && !url.includes('google.com/search') && title) {
          results.push({
            title: title.trim(),
            url: url,
            snippet: snippet.trim()
          });
        }
      }
    });
    
    // Also try to find featured snippet / answer box
    const featuredSnippet = document.querySelector('[data-attrid="wa:/description"], .hgKElc, .kno-rdesc');
    if (featuredSnippet) {
      const text = featuredSnippet.textContent;
      if (text && text.length > 20) {
        results.unshift({
          title: 'Featured Answer',
          url: '',
          snippet: text.trim(),
          featured: true
        });
      }
    }
    
    return results;
  })();
`;

/**
 * Extract search results from DuckDuckGo search page (fallback)
 */
const _DDG_EXTRACTION_SCRIPT = `
  (function() {
    const results = [];
    
    // DuckDuckGo results
    const items = document.querySelectorAll('.result, [data-testid="result"]');
    
    items.forEach((item, index) => {
      if (index >= 10) return;
      
      const linkEl = item.querySelector('a[href^="http"]');
      const titleEl = item.querySelector('h2, .result__title');
      const snippetEl = item.querySelector('.result__snippet, [data-testid="result-snippet"]');
      
      if (linkEl && titleEl) {
        results.push({
          title: titleEl.textContent.trim(),
          url: linkEl.href,
          snippet: snippetEl ? snippetEl.textContent.trim() : ''
        });
      }
    });
    
    return results;
  })();
`;

/**
 * Perform a web search using the hidden webview
 * @param {string} query - Search query
 * @returns {Promise<Array<{title, url, snippet}>>}
 */
async function search(query) {
  if (!query || typeof query !== 'string') {
    return [];
  }

  // Check cache first
  const cacheKey = query.toLowerCase().trim();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    log.info('agent', 'Returning cached results for', { query });
    return cached.results;
  }

  log.info('agent', 'Searching for', { query });

  const win = getSearchWindow();
  const encodedQuery = encodeURIComponent(query);

  // Try Google first
  const searchUrl = `https://www.google.com/search?q=${encodedQuery}&hl=en`;

  return new Promise((resolve) => {
    let resolved = false;

    // Timeout handler
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        log.info('agent', 'Search timed out');
        resolve([]);
      }
    }, SEARCH_TIMEOUT);

    // Load the search page
    win
      .loadURL(searchUrl)
      .then(() => {
        // Wait for page to fully render
        setTimeout(async () => {
          if (resolved) return;

          try {
            // Execute extraction script
            const results = await win.webContents.executeJavaScript(GOOGLE_EXTRACTION_SCRIPT);

            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);

              log.info('agent', 'Found', { length: results.length, detail: 'results' });

              // Cache results
              searchCache.set(cacheKey, {
                results,
                timestamp: Date.now(),
              });

              resolve(results);
            }
          } catch (error) {
            log.error('agent', 'Extraction error', { error: error.message });
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              resolve([]);
            }
          }
        }, 2000); // Wait 2s for page to render
      })
      .catch((error) => {
        log.error('agent', 'Load error', { error: error.message });
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve([]);
        }
      });
  });
}

/**
 * Clear the search cache
 */
function clearCache() {
  searchCache.clear();
  log.info('agent', 'Cache cleared');
}

/**
 * Destroy the search window (call on app quit)
 */
function destroy() {
  if (searchWindow && !searchWindow.isDestroyed()) {
    searchWindow.destroy();
    searchWindow = null;
  }
  clearCache();
}

module.exports = {
  search,
  clearCache,
  destroy,
};
