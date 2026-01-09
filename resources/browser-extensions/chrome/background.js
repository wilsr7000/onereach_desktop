/**
 * OneReach.ai Tab Share - Background Service Worker
 * 
 * Handles WebSocket connection to Electron app, tab queries, and captures.
 */

const API_HOST = '127.0.0.1';
const API_PORT = 47291;
const WS_URL = `ws://${API_HOST}:${API_PORT}`;
const HTTP_URL = `http://${API_HOST}:${API_PORT}`;

let ws = null;
let authToken = null;
let isConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 3000;

// Initialize on install/startup
chrome.runtime.onInstalled.addListener(() => {
  console.log('[OneReach] Extension installed');
  setupContextMenus();
  loadTokenAndConnect();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[OneReach] Browser started');
  loadTokenAndConnect();
});

// Also try to connect when service worker wakes up
loadTokenAndConnect();

/**
 * Setup context menus
 */
function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    // Context menu for selected text
    chrome.contextMenus.create({
      id: 'send-selection-to-space',
      title: 'Send to OneReach Space',
      contexts: ['selection']
    });

    // Context menu for images
    chrome.contextMenus.create({
      id: 'send-image-to-space',
      title: 'Send Image to OneReach Space',
      contexts: ['image']
    });

    // Context menu for page
    chrome.contextMenus.create({
      id: 'share-page',
      title: 'Share Page with OneReach.ai',
      contexts: ['page']
    });

    console.log('[OneReach] Context menus created');
  });
}

/**
 * Handle context menu clicks
 */
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  console.log('[OneReach] Context menu clicked:', info.menuItemId);

  switch (info.menuItemId) {
    case 'send-selection-to-space':
      await sendSelectionToSpace(info.selectionText, tab);
      break;
    case 'send-image-to-space':
      await sendImageToSpace(info.srcUrl, tab);
      break;
    case 'share-page':
      await shareCurrentTab(tab);
      break;
  }
});

/**
 * Handle keyboard shortcut
 */
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'share-tab') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      await shareCurrentTab(tab);
    }
  }
});

/**
 * Load auth token and connect to app
 */
async function loadTokenAndConnect() {
  try {
    // Try to get token from storage
    const result = await chrome.storage.local.get(['authToken']);
    
    if (result.authToken) {
      authToken = result.authToken;
      console.log('[OneReach] Token loaded from storage');
      connectWebSocket();
    } else {
      console.log('[OneReach] No token stored - user needs to set up');
      // Try to fetch token from app (if running)
      await tryFetchToken();
    }
  } catch (error) {
    console.error('[OneReach] Error loading token:', error);
  }
}

/**
 * Try to fetch token from running app
 */
async function tryFetchToken() {
  try {
    const response = await fetch(`${HTTP_URL}/api/token`);
    if (response.ok) {
      const data = await response.json();
      authToken = data.token;
      await chrome.storage.local.set({ authToken });
      console.log('[OneReach] Token fetched from app');
      connectWebSocket();
    }
  } catch (error) {
    console.log('[OneReach] App not running or token fetch failed');
  }
}

/**
 * Connect to Electron app via WebSocket
 */
function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    console.log('[OneReach] Already connected');
    return;
  }

  if (!authToken) {
    console.log('[OneReach] No auth token, cannot connect');
    return;
  }

  console.log('[OneReach] Connecting to WebSocket...');

  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('[OneReach] WebSocket connected');
      reconnectAttempts = 0;
      
      // Send auth message
      ws.send(JSON.stringify({
        type: 'auth',
        token: authToken
      }));
    };

    ws.onmessage = (event) => {
      handleWebSocketMessage(event.data);
    };

    ws.onclose = () => {
      console.log('[OneReach] WebSocket disconnected');
      isConnected = false;
      ws = null;
      updateBadge();
      scheduleReconnect();
    };

    ws.onerror = (error) => {
      console.error('[OneReach] WebSocket error:', error);
    };
  } catch (error) {
    console.error('[OneReach] Failed to create WebSocket:', error);
    scheduleReconnect();
  }
}

/**
 * Handle incoming WebSocket messages
 */
function handleWebSocketMessage(data) {
  try {
    const message = JSON.parse(data);
    console.log('[OneReach] Received message:', message.type);

    switch (message.type) {
      case 'auth-success':
        isConnected = true;
        updateBadge();
        console.log('[OneReach] Authentication successful');
        break;

      case 'auth-failed':
        console.error('[OneReach] Authentication failed:', message.error);
        isConnected = false;
        authToken = null;
        chrome.storage.local.remove(['authToken']);
        break;

      case 'get-tabs':
        handleGetTabsRequest(message.requestId);
        break;

      case 'capture-tab':
        handleCaptureTabRequest(message.requestId, message.tabId);
        break;

      case 'pong':
        // Keep-alive response
        break;

      default:
        console.log('[OneReach] Unknown message type:', message.type);
    }
  } catch (error) {
    console.error('[OneReach] Error parsing message:', error);
  }
}

/**
 * Handle get-tabs request from app
 */
async function handleGetTabsRequest(requestId) {
  try {
    const tabs = await chrome.tabs.query({});
    
    const tabList = tabs.map(tab => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      favIconUrl: tab.favIconUrl,
      active: tab.active,
      windowId: tab.windowId
    }));

    sendToApp({
      type: 'tabs',
      requestId,
      data: tabList
    });
  } catch (error) {
    console.error('[OneReach] Error getting tabs:', error);
    sendToApp({
      type: 'tabs',
      requestId,
      error: error.message
    });
  }
}

/**
 * Handle capture-tab request from app
 */
async function handleCaptureTabRequest(requestId, tabId) {
  try {
    // Get the tab info
    const tab = await chrome.tabs.get(tabId);
    
    // Activate the tab to capture it
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    
    // Wait a moment for the tab to be visible
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Capture screenshot
    const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'png'
    });
    
    // Extract text content
    let textContent = '';
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractPageText
      });
      
      if (results && results[0] && results[0].result) {
        textContent = results[0].result;
      }
    } catch (scriptError) {
      console.warn('[OneReach] Could not extract text:', scriptError);
    }

    sendToApp({
      type: 'capture-result',
      requestId,
      data: {
        tabId,
        url: tab.url,
        title: tab.title,
        screenshot,
        textContent,
        capturedAt: Date.now()
      }
    });
  } catch (error) {
    console.error('[OneReach] Error capturing tab:', error);
    sendToApp({
      type: 'capture-result',
      requestId,
      error: error.message
    });
  }
}

/**
 * Function injected into page to extract text
 */
function extractPageText() {
  // Try to get readable content
  const article = document.querySelector('article');
  const main = document.querySelector('main');
  const body = document.body;
  
  const container = article || main || body;
  
  // Clone and clean
  const clone = container.cloneNode(true);
  
  // Remove script, style, nav, footer, aside elements
  const removeSelectors = ['script', 'style', 'nav', 'footer', 'aside', 'header', '.ad', '.ads', '.advertisement', '[role="navigation"]', '[role="banner"]'];
  removeSelectors.forEach(selector => {
    clone.querySelectorAll(selector).forEach(el => el.remove());
  });
  
  // Get text content
  let text = clone.textContent || clone.innerText || '';
  
  // Clean up whitespace
  text = text.replace(/\s+/g, ' ').trim();
  
  // Limit length
  if (text.length > 50000) {
    text = text.substring(0, 50000) + '...';
  }
  
  return text;
}

/**
 * Send message to app via WebSocket
 */
function sendToApp(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  } else {
    console.error('[OneReach] Cannot send - not connected');
  }
}

/**
 * Schedule reconnection attempt
 */
function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.log('[OneReach] Max reconnect attempts reached');
    return;
  }

  reconnectAttempts++;
  const delay = RECONNECT_DELAY * Math.min(reconnectAttempts, 5);
  
  console.log(`[OneReach] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  
  setTimeout(() => {
    if (!isConnected) {
      connectWebSocket();
    }
  }, delay);
}

/**
 * Update extension badge to show connection status
 */
function updateBadge() {
  if (isConnected) {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
    chrome.action.setTitle({ title: 'OneReach.ai - Connected' });
  } else {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#F44336' });
    chrome.action.setTitle({ title: 'OneReach.ai - Not Connected' });
  }
}

/**
 * Send selected text to space via HTTP API
 */
async function sendSelectionToSpace(text, tab) {
  if (!text) return;

  try {
    // For now, just notify the app to open space picker
    // In future, could show popup to select space
    const response = await fetch(`${HTTP_URL}/api/send-to-space`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'text',
        content: text,
        title: text.substring(0, 50),
        sourceUrl: tab.url,
        spaceId: 'default' // Will be handled by app
      })
    });

    if (response.ok) {
      showNotification('Sent to Space', 'Text saved to OneReach.ai');
    } else {
      throw new Error('Failed to send');
    }
  } catch (error) {
    console.error('[OneReach] Error sending selection:', error);
    showNotification('Error', 'Could not send to space. Is the app running?');
  }
}

/**
 * Send image to space
 */
async function sendImageToSpace(srcUrl, tab) {
  if (!srcUrl) return;

  try {
    const response = await fetch(`${HTTP_URL}/api/send-to-space`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'image',
        content: srcUrl,
        title: 'Image from ' + new URL(tab.url).hostname,
        sourceUrl: tab.url,
        spaceId: 'default'
      })
    });

    if (response.ok) {
      showNotification('Sent to Space', 'Image saved to OneReach.ai');
    } else {
      throw new Error('Failed to send');
    }
  } catch (error) {
    console.error('[OneReach] Error sending image:', error);
    showNotification('Error', 'Could not send to space. Is the app running?');
  }
}

/**
 * Share current tab (screenshot + text)
 */
async function shareCurrentTab(tab) {
  try {
    // Capture screenshot
    const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'png'
    });

    // Extract text
    let textContent = '';
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractPageText
      });
      
      if (results && results[0] && results[0].result) {
        textContent = results[0].result;
      }
    } catch (scriptError) {
      console.warn('[OneReach] Could not extract text:', scriptError);
    }

    const response = await fetch(`${HTTP_URL}/api/send-to-space`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'page',
        content: JSON.stringify({
          screenshot,
          textContent,
          url: tab.url,
          title: tab.title
        }),
        title: tab.title,
        sourceUrl: tab.url,
        spaceId: 'default'
      })
    });

    if (response.ok) {
      showNotification('Page Shared', 'Page saved to OneReach.ai');
    } else {
      throw new Error('Failed to send');
    }
  } catch (error) {
    console.error('[OneReach] Error sharing tab:', error);
    showNotification('Error', 'Could not share page. Is the app running?');
  }
}

/**
 * Show notification (if supported)
 */
function showNotification(title, message) {
  // Use console for now - could add chrome.notifications if needed
  console.log(`[OneReach] ${title}: ${message}`);
}

/**
 * Handle messages from popup
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[OneReach] Message from popup:', message);

  switch (message.type) {
    case 'get-status':
      sendResponse({
        isConnected,
        hasToken: !!authToken
      });
      break;

    case 'set-token':
      authToken = message.token;
      chrome.storage.local.set({ authToken });
      connectWebSocket();
      sendResponse({ success: true });
      break;

    case 'reconnect':
      reconnectAttempts = 0;
      connectWebSocket();
      sendResponse({ success: true });
      break;

    case 'share-current-tab':
      chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (tab) shareCurrentTab(tab);
      });
      sendResponse({ success: true });
      break;
  }

  return true; // Keep channel open for async response
});

// Keep service worker alive with periodic pings
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  }
}, 25000);

// Initial badge update
updateBadge();



