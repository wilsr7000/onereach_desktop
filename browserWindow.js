const { BrowserWindow, shell, app, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const getLogger = require('./event-logger');
let logger;

// Main browser window reference - kept global to prevent garbage collection
let mainWindow = null;

// Add at the top with other global variables
let authWindow = null;
let authTokens = new Map();

/**
 * Creates the main application window
 * @param {Object} app - The Electron app instance
 * @returns {BrowserWindow} The created main window
 */
function createMainWindow(app) {
  // Initialize logger if not already
  if (!logger) {
    logger = getLogger();
  }
  
  // Use the PNG icon for all platforms for consistency
  const iconPath = path.join(__dirname, 'assets/tray-icon.png');
  
  logger.logWindowCreated('main-window', 'main', {
    action: 'creating',
    icon: iconPath
  });
  console.log(`Using icon path for main window: ${iconPath}`);

  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(app.getAppPath(), 'preload.js'),
      webSecurity: false,
      allowRunningInsecureContent: true,
      webviewTag: true,
      // Enable features needed for media/voice
      enableBlinkFeatures: 'MediaStreamAPI,WebRTC,AudioWorklet,WebAudio,MediaRecorder',
      experimentalFeatures: true
    },
    title: 'Onereach.ai',
    icon: iconPath
  });

  // Set Chrome-like user agent for the main window
  const chromeVersion = process.versions.chrome;
  const userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  mainWindow.webContents.setUserAgent(userAgent);
  
  // Enhanced: Configure session for better authentication
  const session = mainWindow.webContents.session;
  
  // Set persistent cookies for auth domains
  session.cookies.on('changed', (event, cookie, cause, removed) => {
    if (cookie.domain && (
      cookie.domain.includes('google.com') ||
      cookie.domain.includes('onereach.ai') ||
      cookie.domain.includes('microsoft.com')
    )) {
      console.log(`Auth cookie ${removed ? 'removed' : 'changed'}: ${cookie.name} for ${cookie.domain}`);
    }
  });
  
  // Enhanced browser fingerprinting to be more Chrome-like
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    
    // Set headers to match Chrome exactly
    headers['User-Agent'] = userAgent;
    headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
    headers['Accept-Language'] = 'en-US,en;q=0.9';
    headers['Accept-Encoding'] = 'gzip, deflate, br';
    headers['Sec-Ch-Ua'] = `"Chromium";v="${chromeVersion.split('.')[0]}", "Not(A:Brand";v="24"`;
    headers['Sec-Ch-Ua-Mobile'] = '?0';
    headers['Sec-Ch-Ua-Platform'] = '"macOS"';
    headers['Sec-Fetch-Dest'] = 'document';
    headers['Sec-Fetch-Mode'] = 'navigate';
    headers['Sec-Fetch-Site'] = 'none';
    headers['Sec-Fetch-User'] = '?1';
    headers['Upgrade-Insecure-Requests'] = '1';
    
    // Remove Electron-specific headers
    delete headers['X-DevTools-Request-Id'];
    delete headers['X-Electron'];
    
    callback({ requestHeaders: headers });
  });
  
  // Set up permission handlers for the main window
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    console.log(`Main window permission requested: ${permission}`);
    
    // Allow media and other necessary permissions
    if (permission === 'media' || 
        permission === 'audioCapture' || 
        permission === 'microphone' ||
        permission === 'camera' ||
        permission === 'notifications' ||
        permission === 'clipboard-read' ||
        permission === 'clipboard-write') {
      console.log(`Main window allowing ${permission} permission`);
      callback(true);
    } else {
      console.log(`Main window denying ${permission} permission`);
      callback(false);
    }
  });
  
  // Also set permission check handler
  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    console.log(`Main window permission check: ${permission}`);
    
    if (permission === 'media' || 
        permission === 'audioCapture' || 
        permission === 'microphone' ||
        permission === 'camera' ||
        permission === 'notifications' ||
        permission === 'clipboard-read' ||
        permission === 'clipboard-write') {
      return true;
    }
    
    return false;
  });
  
  // Special handler for new-window events in WebContents
  // This affects windows requested by the main HTML file, not webviews
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.log('Main window open handler, URL:', url);
    
    // For Google authentication, notify the renderer to handle in the current tab
    if (url.includes('accounts.google.com') || 
        url.includes('oauth2') || 
        url.includes('auth')) {
      console.log('Google auth URL detected, sending to renderer to handle in current tab:', url);
      
      // Send to renderer to handle in the current tab
      setTimeout(() => {
        mainWindow.webContents.send('handle-auth-url', url);
      }, 0);
      
      return { action: 'deny' };
    }
    
    // For chat URLs, notify the renderer to handle in the appropriate tab
    if (url.includes('/chat/') || 
        url.startsWith('https://flow-desc.chat.edison.onereach.ai/')) {
      console.log('Main process: Chat URL detected in window open handler, sending to renderer');
      
      // Send to renderer to handle in the current tab
      setTimeout(() => {
        mainWindow.webContents.send('handle-chat-url', url);
      }, 0);
      
      // Prevent default window creation
      return { action: 'deny' };
    }
    
    // For non-chat URLs, let the renderer handle it by opening in a new tab
    setTimeout(() => {
      mainWindow.webContents.send('open-in-new-tab', url);
    }, 0);
    
    // Prevent default window creation
    return { action: 'deny' };
  });

  // Add navigation handler for Google auth redirects
  mainWindow.webContents.on('will-navigate', (event, url) => {
    console.log('Main window navigation attempted to:', url);
    
    // Handle Google auth redirects
    if (url.includes('accounts.google.com') || 
        url.includes('oauth2') || 
        url.includes('auth')) {
      console.log('Auth navigation detected, allowing:', url);
      return;
    }
    
    // Allow navigation for onereach.ai domains
    if (url.includes('.onereach.ai/')) {
      console.log('Navigation to onereach.ai URL allowed:', url);
      return;
    }
    
    // Block navigation to other domains
    console.log('Blocking navigation to non-onereach.ai URL:', url);
    event.preventDefault();
    
    // Open external URLs in default browser
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url).catch(err => {
        console.error('Failed to open external URL:', err);
      });
    }
  });

  // Set Content Security Policy
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' * https://*.onereach.ai https://*.api.onereach.ai https://unpkg.com https://chatgpt.com https://*.chatgpt.com https://chat.openai.com https://*.openai.com; " +
          "style-src 'self' 'unsafe-inline' * https://*.onereach.ai https://fonts.googleapis.com; " + 
          "style-src-elem 'self' 'unsafe-inline' * https://*.onereach.ai https://fonts.googleapis.com; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' * https://*.onereach.ai https://unpkg.com https://cdn.jsdelivr.net; " +
          "connect-src 'self' * https://*.onereach.ai https://*.api.onereach.ai ws://localhost:3322 wss://*; " +
          "img-src 'self' data: blob: * https://*.onereach.ai; " +
          "font-src 'self' data: * https://*.onereach.ai https://fonts.gstatic.com; " +
          "media-src 'self' blob: mediastream: * https://*.onereach.ai https://*.chatgpt.com https://*.openai.com; " +
          "worker-src 'self' blob:; " +
          "object-src 'none'; " +
          "base-uri 'self'"
        ]
      }
    });
  });

  // Load the tabbed browser HTML file instead of directly loading a URL
  mainWindow.loadFile('tabbed-browser.html');

  // Handle downloads in the main window
  mainWindow.webContents.session.on('will-download', (event, item, webContents) => {
    // Use the new handler with space option
    handleDownloadWithSpaceOption(item, 'Main Window');
  });

  // Add custom scrollbar styling to main window
  mainWindow.webContents.on('did-finish-load', () => {
    // Inject Chrome-like behavior and remove Electron fingerprints
    mainWindow.webContents.executeJavaScript(`
      (function() {
        console.log('[Main Window] Injecting Chrome-like behavior and removing Electron fingerprints');
        
        // Remove Electron fingerprints
        delete window.navigator.__proto__.webdriver;
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined
        });
        
        // Override user agent to match Chrome
        const chromeVersion = '${chromeVersion}';
        const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + chromeVersion + ' Safari/537.36';
        Object.defineProperty(navigator, 'userAgent', {
          get: () => userAgent
        });
        
        // Hide Electron-specific properties
        if (window.process && window.process.versions) {
          delete window.process.versions.electron;
        }
        
        // Override platform if needed
        Object.defineProperty(navigator, 'platform', {
          get: () => 'MacIntel'
        });
        
        // Add Chrome-specific properties
        Object.defineProperty(navigator, 'vendor', {
          get: () => 'Google Inc.'
        });
        
        Object.defineProperty(navigator, 'hardwareConcurrency', {
          get: () => 8  // Common value for modern Macs
        });
        
        Object.defineProperty(navigator, 'deviceMemory', {
          get: () => 8  // 8GB RAM
        });
        
        // Mock Chrome app
        if (!window.chrome) {
          window.chrome = {};
        }
        
        // Add Chrome runtime API mock
        window.chrome.runtime = {
          id: undefined,
          connect: () => {},
          sendMessage: () => {},
          onMessage: { addListener: () => {} }
        };
        
        // Mock Web Audio API fingerprint to match Chrome
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
          const originalCreateOscillator = AudioContext.prototype.createOscillator;
          AudioContext.prototype.createOscillator = function() {
            const oscillator = originalCreateOscillator.apply(this, arguments);
            // Add slight noise to match Chrome's implementation
            const originalConnect = oscillator.connect;
            oscillator.connect = function() {
              return originalConnect.apply(this, arguments);
            };
            return oscillator;
          };
        }
        
        // Override WebGL fingerprinting
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(parameter) {
          if (parameter === 37445) {
            return 'Intel Inc.'; // UNMASKED_VENDOR_WEBGL
          }
          if (parameter === 37446) {
            return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
          }
          return getParameter.apply(this, arguments);
        };
        
        // Override canvas fingerprinting
        const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function() {
          const context = this.getContext('2d');
          if (context) {
            // Add imperceptible noise to match Chrome
            const imageData = context.getImageData(0, 0, this.width, this.height);
            for (let i = 0; i < imageData.data.length; i += 4) {
              imageData.data[i] = Math.min(255, imageData.data[i] + Math.random() * 0.1);
            }
            context.putImageData(imageData, 0, 0);
          }
          return originalToDataURL.apply(this, arguments);
        };
        
        console.log('[Main Window] Enhanced Chrome-like behavior applied');
      })();
    `).catch(err => console.error('Failed to inject Chrome-like behavior:', err));
    
    mainWindow.webContents.insertCSS(`
      ::-webkit-scrollbar {
        width: 6px;
        height: 6px;
      }
      
      ::-webkit-scrollbar-track {
        background: rgba(0, 0, 0, 0.2);
        border-radius: 3px;
      }
      
      ::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.1);
        border-radius: 3px;
      }
      
      ::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.2);
      }
    `).catch(err => console.error('Failed to inject scrollbar CSS:', err));

    // Check for Material Symbols font and preload if needed
    mainWindow.webContents.executeJavaScript(`
      (function() {
        // Check if page uses Material Symbols
        const hasSymbols = document.querySelector('.material-symbols-outlined, .material-icons');
        if (hasSymbols) {
          console.log('Material Symbols found on page, preloading font');
          
          // Add preload link for Material Icons font
          const preloadLink = document.createElement('link');
          preloadLink.rel = 'preload';
          preloadLink.href = 'https://fonts.googleapis.com/icon?family=Material+Icons';
          preloadLink.as = 'style';
          document.head.appendChild(preloadLink);
          
          return true;
        } else {
          console.log('No Material Symbols elements found on page, skipping preload');
          return false;
        }
      })();
    `).catch(err => console.error('Failed to check for Material Symbols:', err));
  });

  // Handle window closed event
  mainWindow.on('closed', () => {
    logger.logWindowClosed('main-window', 'main');
    mainWindow = null;
  });
  
  // Log window focus events
  mainWindow.on('focus', () => {
    logger.logWindowFocused('main-window', 'main');
  });

  // Add context menu handler for right-click "Paste to Black Hole"
  mainWindow.webContents.on('context-menu', (event, params) => {
    console.log('[BrowserWindow] Context menu requested at:', params.x, params.y);
    event.preventDefault();
    
    const { Menu, MenuItem } = require('electron');
    const contextMenu = new Menu();
    
    contextMenu.append(new MenuItem({
      label: 'Paste to Black Hole',
      click: () => {
        console.log('[BrowserWindow] Paste to Black Hole clicked');
        
        // Send message to main process to show black hole
        const { ipcMain } = require('electron');
        
        // Get clipboard manager from global
        if (global.clipboardManager) {
          const bounds = mainWindow.getBounds();
          const position = {
            x: bounds.x + bounds.width - 100,
            y: bounds.y + 100
          };
          // Pass true as second parameter to show in expanded mode with space chooser
          global.clipboardManager.createBlackHoleWindow(position, true);
          
          // Send clipboard content after a delay
          setTimeout(() => {
            const { clipboard } = require('electron');
            const text = clipboard.readText();
            if (text && global.clipboardManager && global.clipboardManager.blackHoleWindow) {
              global.clipboardManager.blackHoleWindow.webContents.send('paste-content', {
                type: 'text',
                content: text
              });
            }
          }, 300);
        }
      }
    }));
    
    // Use setImmediate to ensure the menu shows after all other handlers
    setImmediate(() => {
      contextMenu.popup({
        window: mainWindow,
        x: params.x,
        y: params.y
      });
    });
  });

  return mainWindow;
}

/**
 * Creates a secure window for external content with proper security
 * @param {BrowserWindow} parentWindow - The parent window
 * @returns {BrowserWindow} The secure content window
 */
function createSecureContentWindow(parentWindow) {
  // Create a window with more restrictive security settings for external content
  const contentWindow = new BrowserWindow({
    width: parentWindow.getSize()[0],
    height: parentWindow.getSize()[1],
    parent: parentWindow,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      allowRunningInsecureContent: true,
      sandbox: false,
      enableRemoteModule: false, // Disable remote module
      preload: path.join(__dirname, 'preload-minimal.js') // Use a minimal preload script
    }
  });

  // Set Content Security Policy for the content window
  contentWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' * https://*.onereach.ai https://*.api.onereach.ai https://unpkg.com; " +
          "style-src 'self' 'unsafe-inline' * https://*.onereach.ai https://fonts.googleapis.com; " + 
          "style-src-elem 'self' 'unsafe-inline' * https://*.onereach.ai https://fonts.googleapis.com; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' * https://*.onereach.ai https://unpkg.com https://cdn.jsdelivr.net; " +
          "connect-src 'self' * https://*.onereach.ai https://*.api.onereach.ai ws://localhost:3322; " +
          "img-src 'self' data: blob: * https://*.onereach.ai; " +
          "font-src 'self' data: * https://*.onereach.ai https://fonts.gstatic.com; " +
          "media-src 'self' blob: * https://*.onereach.ai; " +
          "worker-src 'self' blob:; " +
          "object-src 'none'; " +
          "base-uri 'self'"
        ]
      }
    });
  });

  // Setup security monitoring for external content
  contentWindow.webContents.on('will-navigate', (event, url) => {
    // Log navigation attempts
    console.log('Content window navigation attempted to:', url);
    
    // Allow navigation within the same window for IDW and chat URLs
    if (url.startsWith('https://idw.edison.onereach.ai/') || 
        url.startsWith('https://flow-desc.chat.edison.onereach.ai/') || 
        url.includes('/chat/')) {
      console.log('Navigation to IDW/chat URL allowed in same window:', url);
      return;
    }
    
    // Allow navigation for GSX domains
    if (url.includes('.onereach.ai/') &&
        (url.includes('actiondesk.') || 
         url.includes('studio.') || 
         url.includes('hitl.') || 
         url.includes('tickets.') || 
         url.includes('calendar.') || 
         url.includes('docs.'))) {
      console.log('Navigation to GSX URL allowed in same window:', url);
      return;
    }
    
    // Block navigation to unexpected URLs
    console.log('Blocking navigation to non-IDW/GSX URL:', url);
    event.preventDefault();
    
    // Open external URLs in default browser instead
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url).catch(err => {
        console.error('Failed to open external URL:', err);
      });
    }
  });

  // Handle redirect events
  contentWindow.webContents.on('will-redirect', (event, url) => {
    console.log('Content window redirect attempted to:', url);
    
    // Allow redirects to IDW and chat URLs in the same window
    if (url.startsWith('https://idw.edison.onereach.ai/') || 
        url.startsWith('https://flow-desc.chat.edison.onereach.ai/') || 
        url.includes('/chat/')) {
      console.log('Redirect to IDW/chat URL allowed in same window:', url);
      return;
    }
    
    // Allow redirects for GSX domains
    if (url.includes('.onereach.ai/') &&
        (url.includes('actiondesk.') || 
         url.includes('studio.') || 
         url.includes('hitl.') || 
         url.includes('tickets.') || 
         url.includes('calendar.') || 
         url.includes('docs.'))) {
      console.log('Redirect to GSX URL allowed in same window:', url);
      return;
    }
    
    // Block redirects to unexpected URLs
    console.log('Blocking redirect to non-IDW/GSX URL:', url);
    event.preventDefault();
    
    // Open external URLs in default browser instead
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url).catch(err => {
        console.error('Failed to open external URL on redirect:', err);
      });
    }
  });

  // Add scripts and styling on page load
  contentWindow.webContents.on('did-finish-load', () => {
    // Check for Material Symbols font and preload if needed
    contentWindow.webContents.executeJavaScript(`
      (function() {
        // Check if page uses Material Symbols
        const hasSymbols = document.querySelector('.material-symbols-outlined, .material-icons');
        if (hasSymbols) {
          console.log('Material Symbols found on page, preloading font');
          
          // Add preload link for Material Icons font
          const preloadLink = document.createElement('link');
          preloadLink.rel = 'preload';
          preloadLink.href = 'https://fonts.googleapis.com/icon?family=Material+Icons';
          preloadLink.as = 'style';
          document.head.appendChild(preloadLink);
          
          return true;
        } else {
          console.log('No Material Symbols elements found on page, skipping preload');
          return false;
        }
      })();
    `).catch(err => console.error('Failed to check for Material Symbols:', err));
    
    // Inject script to intercept link clicks
    contentWindow.webContents.executeJavaScript(`
      (function() {
        // If we've already installed the interceptor, don't do it again
        if (window.__linkInterceptorInstalled) return false;
        
        // Mark as installed
        window.__linkInterceptorInstalled = true;
        
        // Add click event listener to the document
        document.addEventListener('click', (event) => {
          // Check if the clicked element is a link
          let target = event.target;
          while (target && target.tagName !== 'A') {
            target = target.parentElement;
          }
          
          // If we found a link
          if (target && target.tagName === 'A') {
            const url = target.href;
            
            // Log chat URLs (will be handled by will-navigate)
            if (url && (url.includes('/chat/') || 
                         url.startsWith('https://flow-desc.chat.edison.onereach.ai/'))) {
              console.log('Chat link clicked:', url);
              // We don't need to do anything here - just log
            }
          }
        }, true);
        
        console.log('Link click interceptor installed');
        return true;
      })();
    `).catch(err => console.error('Failed to inject link handler script:', err));
    
    // Add custom scrollbar styling
    contentWindow.webContents.insertCSS(`
      ::-webkit-scrollbar {
        width: 6px;
        height: 6px;
      }
      
      ::-webkit-scrollbar-track {
        background: rgba(0, 0, 0, 0.2);
        border-radius: 3px;
      }
      
      ::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.1);
        border-radius: 3px;
      }
      
      ::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.2);
      }
    `).catch(err => console.error('Failed to inject scrollbar CSS:', err));
  });

  // Handle downloads in secure content windows
  contentWindow.webContents.session.on('will-download', (event, item, webContents) => {
    // Use the new handler with space option
    handleDownloadWithSpaceOption(item, 'Secure Window');
  });

  // Monitor for unexpected new windows
  contentWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.log('External content attempted to open new window:', url);
    
    // For chat URLs, navigate the current window instead of opening a new one
    if (url.includes('/chat/') || 
        url.startsWith('https://flow-desc.chat.edison.onereach.ai/')) {
      console.log('Chat URL detected, navigating current window to:', url);
      
      // Handle this URL manually by loading it in the current window
      setTimeout(() => {
        contentWindow.loadURL(url).catch(err => {
          console.error('Failed to load chat URL in current window:', err);
        });
      }, 0);
      
      // Prevent default window creation
      return { action: 'deny' };
    }
    
    // For GSX URLs, navigate the current window
    if (url.includes('.onereach.ai/') &&
        (url.includes('actiondesk.') || 
         url.includes('studio.') || 
         url.includes('hitl.') || 
         url.includes('tickets.') || 
         url.includes('calendar.') || 
         url.includes('docs.'))) {
      console.log('GSX URL detected, navigating current window to:', url);
      
      // Handle this URL manually by loading it in the current window
      setTimeout(() => {
        contentWindow.loadURL(url).catch(err => {
          console.error('Failed to load GSX URL in current window:', err);
        });
      }, 0);
      
      // Prevent default window creation
      return { action: 'deny' };
    }
    
    // Only allow URLs that match our expected domains for external browser
    if (url.startsWith('https://idw.edison.onereach.ai/')) {
      // Open non-chat IDW URLs in the default browser
      shell.openExternal(url).catch(err => {
        console.error('Failed to open external URL:', err);
      });
    }
    
    // Prevent the app from opening the window directly
    return { action: 'deny' };
  });

  return contentWindow;
}

/**
 * Opens a URL in a secure content window
 * @param {string} url - The URL to open
 */
function openURLInMainWindow(url) {
  console.log('Opening URL in main window:', url);
  
  if (!mainWindow) {
    console.error('Main window not available');
    return;
  }
  
  // Make sure the URL is valid
  try {
    const urlObj = new URL(url);
    
    // Make sure it's using http or https protocol
    if (!urlObj.protocol.match(/^https?:$/)) {
      console.error('Invalid URL protocol:', urlObj.protocol);
      throw new Error(`Invalid URL protocol: ${urlObj.protocol}`);
    }
    
    console.log('Loading URL in main window:', urlObj.href);
    
    // Create a secure window for external content to avoid security issues
    // with Node.js integration in the main window
    const contentWindow = createSecureContentWindow(mainWindow);
    
    // Show loading indicator in the main window before loading URL
    mainWindow.webContents.executeJavaScript(`
      document.body.innerHTML += '<div id="loading-overlay" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); display: flex; justify-content: center; align-items: center; z-index: 9999;"><div style="color: white; font-size: 20px;">Loading IDW environment...</div></div>';
    `).catch(err => console.error('Error showing loading indicator:', err));

    // Close the main window when loading is complete
    contentWindow.webContents.on('did-finish-load', () => {
      mainWindow.hide(); // Hide instead of close to keep the app running
      contentWindow.show();
    });
    
    // When content window is closed, show main window again
    contentWindow.on('closed', () => {
      mainWindow.show();
      mainWindow.focus();
    });

    // Load the URL in the content window
    contentWindow.loadURL(urlObj.href).catch(error => {
      console.error('Error loading URL:', error);
      contentWindow.close(); // Close the content window on error
      
      // Show error notification
      mainWindow.webContents.send('show-notification', {
        title: 'Error',
        body: `Failed to load IDW environment: ${error.message}`
      });
    });
  } catch (error) {
    console.error('Error parsing URL:', error);
    
    // Show error notification
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('show-notification', {
        title: 'Error',
        body: `Invalid URL format: ${error.message}`
      });
    }
  }
}

/**
 * Creates a setup wizard window
 * @param {Object} options - Options for the wizard window
 * @returns {BrowserWindow} The wizard window
 */
function createSetupWizardWindow(options = {}) {
  const wizardWindow = new BrowserWindow({
    width: 900,
    height: 650,
    parent: mainWindow, // Make it a child of the main window
    modal: true, // Make it a modal
    resizable: true,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
      enableRemoteModule: false,
      sandbox: false // Disable sandbox to allow IPC access
    },
    ...options
  });

  // Set CSP for wizard window
  wizardWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' * https://*.onereach.ai https://*.api.onereach.ai https://unpkg.com; " +
          "style-src 'self' 'unsafe-inline' * https://*.onereach.ai; " +
          "style-src-elem 'self' 'unsafe-inline' * https://*.onereach.ai; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' * https://*.onereach.ai https://unpkg.com https://cdn.jsdelivr.net; " +
          "connect-src 'self' * https://*.onereach.ai https://*.api.onereach.ai ws://localhost:3322; " +
          "img-src 'self' data: blob: * https://*.onereach.ai; " +
          "font-src 'self' data: * https://*.onereach.ai; " +
          "media-src 'self' * https://*.onereach.ai; " +
          "object-src 'none'; " +
          "base-uri 'self'"
        ]
      }
    });
  });

  return wizardWindow;
}

/**
 * Creates a test window for development
 * @returns {BrowserWindow} The test window
 */
function createTestWindow() {
  const testWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true
    }
  });

  // Set CSP for test window
  testWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' * https://*.onereach.ai https://*.api.onereach.ai https://unpkg.com; " +
          "style-src 'self' 'unsafe-inline' * https://*.onereach.ai https://fonts.googleapis.com; " + 
          "style-src-elem 'self' 'unsafe-inline' * https://*.onereach.ai https://fonts.googleapis.com; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' * https://*.onereach.ai https://unpkg.com https://cdn.jsdelivr.net; " +
          "connect-src 'self' * https://*.onereach.ai https://*.api.onereach.ai ws://localhost:3322; " +
          "img-src 'self' data: blob: * https://*.onereach.ai; " +
          "font-src 'self' data: * https://*.onereach.ai https://fonts.gstatic.com; " +
          "media-src 'self' * https://*.onereach.ai; " +
          "object-src 'none'; " +
          "base-uri 'self'"
        ]
      }
    });
  });

  return testWindow;
}

/**
 * Gets the main window reference
 * @returns {BrowserWindow|null} The main window or null if not created
 */
function getMainWindow() {
  return mainWindow;
}

/**
 * Creates a window specifically for GSX content
 * @param {string} url - The GSX URL to open
 * @param {string} title - Title for the window
 * @param {string} idwEnvironment - Optional environment name to create environment-specific sessions
 * @returns {BrowserWindow} The created GSX window
 */
function openGSXWindow(url, title, idwEnvironment) {
  console.log(`Opening GSX window for ${title}: ${url}`);
  
  if (!logger) {
    logger = getLogger();
  }
  
  logger.logWindowCreated('gsx-window', title, {
    url,
    environment: idwEnvironment
  });
  
  // Extract environment from URL if not provided
  if (!idwEnvironment) {
    try {
      const urlObj = new URL(url);
      // Extract from hostname - e.g., studio.edison.onereach.ai -> edison
      const hostParts = urlObj.hostname.split('.');
      idwEnvironment = hostParts.find(part => 
        ['staging', 'edison', 'production', 'store'].includes(part)
      ) || 'unknown';
    } catch (err) {
      console.error('Error parsing GSX URL to extract environment:', err);
      idwEnvironment = 'unknown';
    }
  }
  
  // Create session partition name based ONLY on the IDW environment
  // This allows all GSX windows in the same IDW group to share cookies
  // while keeping different IDW groups sandboxed from each other
  const partitionName = `gsx-${idwEnvironment}`;
  
  console.log(`Using shared session partition for IDW group: ${partitionName}`);
  
  // Create a window with proper security settings for GSX content
  const gsxWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: `GSX - ${title} (${idwEnvironment})`,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      webviewTag: true,
      // Screen-sharing removed – use standard preload
      preload: path.join(__dirname, 'preload.js'),
      // Use a persistent partition specific to this GSX service and environment
      partition: `persist:${partitionName}`,
      // Enable media access for screen sharing
      enableRemoteModule: false,
      allowRunningInsecureContent: false
    }
  });
  
  // Set Content Security Policy for the GSX window
  gsxWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' * https://*.onereach.ai https://*.api.onereach.ai https://unpkg.com https://cdn.jsdelivr.net; " +
          "style-src 'self' 'unsafe-inline' * https://*.onereach.ai https://fonts.googleapis.com; " + 
          "style-src-elem 'self' 'unsafe-inline' * https://*.onereach.ai https://fonts.googleapis.com; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' * https://*.onereach.ai https://unpkg.com https://cdn.jsdelivr.net; " +
          "connect-src 'self' * https://*.onereach.ai https://*.api.onereach.ai ws://localhost:3322; " +
          "img-src 'self' data: blob: * https://*.onereach.ai; " +
          "font-src 'self' data: * https://*.onereach.ai https://fonts.gstatic.com; " +
          "media-src 'self' blob: * https://*.onereach.ai; " +
          "worker-src 'self' blob:; " +
          "object-src 'none'; " +
          "base-uri 'self'"
        ]
      }
    });
  });
  
  // Enable screen capture permissions
  gsxWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    console.log(`GSX Window - Permission requested: ${permission}`);
    
    // Allow screen capture and media permissions
    if (permission === 'media' || permission === 'display-capture' || permission === 'screen') {
      console.log(`GSX Window - Granting ${permission} permission`);
      callback(true);
    } else {
      console.log(`GSX Window - Denying ${permission} permission`);
      callback(false);
    }
  });

  // Handle media access requests
  gsxWindow.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    console.log(`GSX Window - Permission check: ${permission} from ${requestingOrigin}`);
    
    // Allow media permissions for onereach.ai domains
    if ((permission === 'media' || permission === 'display-capture' || permission === 'screen') && 
        requestingOrigin.includes('onereach.ai')) {
      console.log(`GSX Window - Allowing ${permission} for ${requestingOrigin}`);
      return true;
    }
    
    return false;
  });

  // Add debugging for window events
  gsxWindow.on('close', () => {
    console.log(`GSX Window closing: ${title}`);
  });
  
  gsxWindow.on('closed', () => {
    console.log(`GSX Window closed: ${title}`);
  });
  
  gsxWindow.on('hide', () => {
    console.log(`GSX Window hidden: ${title}`);
  });
  
  gsxWindow.webContents.on('crashed', () => {
    console.error(`GSX Window crashed: ${title}`);
  });
  
  gsxWindow.webContents.on('unresponsive', () => {
    console.error(`GSX Window unresponsive: ${title}`);
  });
  
  gsxWindow.webContents.on('responsive', () => {
    console.log(`GSX Window responsive again: ${title}`);
  });

  // Load the URL
  console.log(`Loading GSX URL: ${url}`);
  gsxWindow.loadURL(url);
  
  // Handle downloads in GSX windows
  gsxWindow.webContents.session.on('will-download', (event, item, webContents) => {
    // Use the new handler with space option
    handleDownloadWithSpaceOption(item, 'GSX Window');
  });
  
  // Add event handlers for will-navigate and will-redirect
  gsxWindow.webContents.on('will-navigate', (event, navUrl) => {
    console.log('GSX window navigation attempted to:', navUrl);
    
    // Allow navigation for GSX and IDW domains
    if (navUrl.includes('.onereach.ai/')) {
      console.log('Navigation to onereach.ai URL allowed in GSX window:', navUrl);
      return;
    }
    
    // Block navigation to other domains
    console.log('Blocking navigation to non-onereach.ai URL in GSX window:', navUrl);
    event.preventDefault();
    
    // Open external URLs in default browser
    shell.openExternal(navUrl).catch(err => {
      console.error('Failed to open external URL from GSX window:', err);
    });
  });
  
  // Handle window open events (like authentication popups)
  gsxWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.log('GSX window attempted to open URL:', url);
    
    // For authentication URLs, use the centralized auth window
    if (url.includes('auth.edison.onereach.ai') || 
        url.includes('sso.global.api.onereach.ai') ||
        url.includes('accounts.google.com')) {
      
      // Determine the service type
      let service = 'onereach';
      if (url.includes('accounts.google.com')) {
        service = 'google';
      }
      
      // Handle auth request
      handleAuthRequest(url, service)
        .then(token => {
          // Inject token into the GSX window
          gsxWindow.webContents.send('auth-token', {
            service,
            token
          });
        })
        .catch(error => {
          console.error('Authentication failed:', error);
          gsxWindow.webContents.send('auth-error', {
            service,
            error: error.message
          });
        });
      
      return { action: 'deny' };
    }
    
    // For onereach.ai URLs, allow to open in the same window
    if (url.includes('.onereach.ai/')) {
      return { action: 'allow' };
    }
    
    // Deny other URLs and open in default browser
    shell.openExternal(url).catch(err => {
      console.error('Failed to open external URL:', err);
    });
    
    return { action: 'deny' };
  });
  
  // Add custom scrollbar CSS when content loads
  gsxWindow.webContents.on('did-finish-load', () => {
    gsxWindow.webContents.insertCSS(`
      ::-webkit-scrollbar {
        width: 6px;
        height: 6px;
      }
      
      ::-webkit-scrollbar-track {
        background: rgba(0, 0, 0, 0.2);
        border-radius: 3px;
      }
      
      ::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.1);
        border-radius: 3px;
      }
      
      ::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.2);
      }
    `).catch(err => console.error('Failed to inject scrollbar CSS in GSX window:', err));
  });
  
  return gsxWindow;
}

/**
 * Creates or returns the centralized authentication window
 * @returns {BrowserWindow} The authentication window
 */
function getAuthWindow() {
  if (authWindow) {
    return authWindow;
  }

  // Create a new authentication window
  authWindow = new BrowserWindow({
    width: 800,
    height: 700,
    show: false, // Hide by default
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      webviewTag: true,
      preload: path.join(__dirname, 'preload.js'),
      // Use a dedicated partition for auth
      partition: 'persist:auth'
    }
  });

  // Handle auth window events
  authWindow.on('closed', () => {
    authWindow = null;
  });

  // Set up token sharing via IPC
  authWindow.webContents.on('did-finish-load', () => {
    // Listen for successful authentication
    authWindow.webContents.on('ipc-message', (event, channel, ...args) => {
      if (channel === 'auth-success') {
        const [token, service] = args;
        authTokens.set(service, token);
        
        // Broadcast token to all windows
        BrowserWindow.getAllWindows().forEach(window => {
          if (window !== authWindow) {
            window.webContents.send('auth-token-update', {
              service,
              token
            });
          }
        });
      }
    });
  });

  return authWindow;
}

/**
 * Handles authentication requests from any window
 * @param {string} url - The authentication URL
 * @param {string} service - The service requesting auth (e.g., 'google', 'onereach')
 * @returns {Promise<string>} The authentication token
 */
async function handleAuthRequest(url, service) {
  const window = getAuthWindow();
  
  // Check if we already have a valid token
  if (authTokens.has(service)) {
    return authTokens.get(service);
  }

  // Show the auth window
  window.show();
  
  // Load the auth URL
  await window.loadURL(url);

  // Return a promise that resolves when auth is complete
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Authentication timeout'));
    }, 300000); // 5 minute timeout

    // Listen for auth success
    const handler = (event, data) => {
      if (data.service === service) {
        clearTimeout(timeout);
        window.webContents.removeListener('ipc-message', handler);
        window.hide();
        resolve(data.token);
      }
    };

    window.webContents.on('ipc-message', handler);
  });
}

// Function to handle downloads with space option
function handleDownloadWithSpaceOption(item, windowName = 'Main Window') {
  const fileName = item.getFilename();
  
  console.log(`[DOWNLOAD] Download detected in ${windowName}: ${fileName}`);
  console.log(`[DOWNLOAD] URL: ${item.getURL()}`);
  console.log(`[DOWNLOAD] Size: ${item.getTotalBytes()} bytes`);
  
  // Create dialog options
  const options = {
    type: 'question',
    buttons: ['Save to Downloads', 'Save to Space', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Save Download',
    message: `How would you like to save "${fileName}"?`,
    detail: 'You can save it to your Downloads folder or add it to a Space in your clipboard manager.',
    icon: path.join(__dirname, 'assets/tray-icon.png')
  };
  
  // Show dialog
  dialog.showMessageBox(options).then(async (result) => {
    console.log(`[DOWNLOAD] User selected option: ${result.response} (0=Downloads, 1=Space, 2=Cancel)`);
    
    if (result.response === 0) {
      // Save to Downloads - normal behavior
      const downloadsPath = app.getPath('downloads');
      const filePath = path.join(downloadsPath, fileName);
      item.setSavePath(filePath);
      
      console.log(`${windowName} - Download started (Downloads): ${fileName}`);
      
      // Resume the download (it's paused when dialog is shown)
      item.resume();
      
      // Set up download progress tracking
      item.on('updated', (event, state) => {
        if (state === 'interrupted') {
          console.log(`${windowName} - Download is interrupted but can be resumed`);
        } else if (state === 'progressing') {
          if (item.isPaused()) {
            console.log(`${windowName} - Download is paused`);
          } else {
            const progress = item.getReceivedBytes() / item.getTotalBytes();
            console.log(`${windowName} - Download progress: ${Math.round(progress * 100)}%`);
          }
        }
      });
      
      item.once('done', (event, state) => {
        if (state === 'completed') {
          console.log(`${windowName} - Download completed: ${fileName}`);
          
          // Show notification
          if (Notification.isSupported()) {
            const notification = new Notification({
              title: 'Download Complete',
              body: `${fileName} has been downloaded successfully`,
              icon: path.join(__dirname, 'assets/tray-icon.png')
            });
            
            notification.on('click', () => {
              shell.showItemInFolder(filePath);
            });
            
            notification.show();
          }
        } else {
          console.log(`${windowName} - Download failed: ${state}`);
        }
      });
    } else if (result.response === 1) {
      // Save to Space
      console.log(`[DOWNLOAD] User chose to save to Space`);
      
      const tempPath = app.getPath('temp');
      const tempFilePath = path.join(tempPath, fileName);
      item.setSavePath(tempFilePath);
      
      console.log(`${windowName} - Download started (Space): ${fileName}`);
      console.log(`[DOWNLOAD] Temp file path: ${tempFilePath}`);
      
      // Resume the download (it's paused when dialog is shown)
      item.resume();
      
      item.once('done', async (event, state) => {
        if (state === 'completed') {
          console.log(`${windowName} - Download completed for Space: ${fileName}`);
          
          // Read the file and add to clipboard manager
          try {
            console.log(`[DOWNLOAD] Reading file from: ${tempFilePath}`);
            const fileData = fs.readFileSync(tempFilePath);
            const base64Data = fileData.toString('base64');
            console.log(`[DOWNLOAD] File read successfully, size: ${fileData.length} bytes`);
            
            // Get clipboard manager
            const clipboardManager = global.clipboardManager;
            console.log(`[DOWNLOAD] Clipboard manager available: ${!!clipboardManager}`);
            console.log(`[DOWNLOAD] Black hole window available: ${!!(clipboardManager && clipboardManager.blackHoleWindow)}`);
            
            if (clipboardManager && clipboardManager.blackHoleWindow) {
              console.log(`[DOWNLOAD] Sending file to black hole widget`);
              
              // Send a pre-notification to prepare the modal
              clipboardManager.blackHoleWindow.webContents.send('prepare-for-download', {
                fileName: fileName
              });
              
              // Wait for widget to be ready
              const { ipcMain } = require('electron');
              
              // Set up one-time listener for widget ready signal FIRST
              const onWidgetReady = () => {
                console.log(`[DOWNLOAD] Black hole widget reported ready, sending external-file-drop event...`);
                
                // Give a small delay to ensure everything is initialized
                setTimeout(() => {
                  if (clipboardManager.blackHoleWindow && !clipboardManager.blackHoleWindow.isDestroyed()) {
                    console.log(`[DOWNLOAD] Sending external-file-drop event now`);
                    
                    // First ensure window is visible
                    if (!clipboardManager.blackHoleWindow.isVisible()) {
                      console.log(`[DOWNLOAD] Black hole window was hidden, showing it now`);
                      clipboardManager.blackHoleWindow.show();
                    }
                    
                    // Send the file data
                    clipboardManager.blackHoleWindow.webContents.send('external-file-drop', {
                      fileName: fileName,
                      fileData: base64Data,
                      fileSize: fileData.length,
                      mimeType: item.getMimeType() || 'application/octet-stream'
                    });
                    
                    console.log(`[DOWNLOAD] external-file-drop event sent to black hole widget`);
                  } else {
                    console.error(`[DOWNLOAD] Black hole window was destroyed before we could send the file`);
                  }
                }, 200); // Small delay after widget reports ready
              };
              
              // Listen for widget ready signal BEFORE sending any events
              ipcMain.once('black-hole:widget-ready', onWidgetReady);
              
              // Function to handle when DOM is ready
              const handleDomReady = () => {
                console.log(`[DOWNLOAD] Black hole window DOM ready, sending prepare event`);
                // Send a pre-notification to prepare the modal
                clipboardManager.blackHoleWindow.webContents.send('prepare-for-download', {
                  fileName: fileName
                });
                
                // Also send a check-ready request in case widget is already initialized
                setTimeout(() => {
                  console.log(`[DOWNLOAD] Sending check-widget-ready request`);
                  clipboardManager.blackHoleWindow.webContents.send('check-widget-ready');
                }, 100);
              };
              
              // Check if DOM is already ready
              if (clipboardManager.blackHoleWindow.webContents.getURL() && 
                  !clipboardManager.blackHoleWindow.webContents.isLoading()) {
                console.log(`[DOWNLOAD] DOM appears to be already ready`);
                handleDomReady();
              } else {
                console.log(`[DOWNLOAD] Waiting for DOM ready event`);
                clipboardManager.blackHoleWindow.webContents.once('dom-ready', handleDomReady);
              }
                
              // Clean up temp file after a delay
              setTimeout(() => {
                fs.unlink(tempFilePath, (err) => {
                  if (err) console.error('Error deleting temp file:', err);
                  else console.log(`[DOWNLOAD] Temp file deleted: ${tempFilePath}`);
                });
              }, 5000);
            } else {
              console.log(`[DOWNLOAD] Black hole window not available, creating it now`);
              
              // Create black hole window if it doesn't exist
              if (clipboardManager && !clipboardManager.blackHoleWindow) {
                console.log(`[DOWNLOAD] ClipboardManager available, creating black hole window...`);
                // Create it in expanded state for downloads - pass true for startExpanded
                clipboardManager.createBlackHoleWindow(null, true);
                
                // Wait for window to be ready before sending data
                setTimeout(() => {
                  if (clipboardManager.blackHoleWindow && !clipboardManager.blackHoleWindow.isDestroyed()) {
                    console.log(`[DOWNLOAD] Black hole window created, waiting for DOM ready...`);
                    
                    // Wait for widget to be ready
                    const { ipcMain } = require('electron');
                    
                    // Set up one-time listener for widget ready signal FIRST
                    const onWidgetReady = () => {
                      console.log(`[DOWNLOAD] Black hole widget reported ready, sending external-file-drop event...`);
                      
                      // Give a small delay to ensure everything is initialized
                      setTimeout(() => {
                        if (clipboardManager.blackHoleWindow && !clipboardManager.blackHoleWindow.isDestroyed()) {
                          console.log(`[DOWNLOAD] Sending external-file-drop event now`);
                          
                          // First ensure window is visible
                          if (!clipboardManager.blackHoleWindow.isVisible()) {
                            console.log(`[DOWNLOAD] Black hole window was hidden, showing it now`);
                            clipboardManager.blackHoleWindow.show();
                          }
                          
                          // Send the file data
                          clipboardManager.blackHoleWindow.webContents.send('external-file-drop', {
                            fileName: fileName,
                            fileData: base64Data,
                            fileSize: fileData.length,
                            mimeType: item.getMimeType() || 'application/octet-stream'
                          });
                          
                          console.log(`[DOWNLOAD] external-file-drop event sent to black hole widget`);
                        } else {
                          console.error(`[DOWNLOAD] Black hole window was destroyed before we could send the file`);
                        }
                      }, 200); // Small delay after widget reports ready
                    };
                    
                    // Listen for widget ready signal BEFORE sending any events
                    ipcMain.once('black-hole:widget-ready', onWidgetReady);
                    
                    // Function to handle when DOM is ready
                    const handleDomReady = () => {
                      console.log(`[DOWNLOAD] Black hole window DOM ready, sending prepare event`);
                      // Send a pre-notification to prepare the modal
                      clipboardManager.blackHoleWindow.webContents.send('prepare-for-download', {
                        fileName: fileName
                      });
                      
                      // Also send a check-ready request in case widget is already initialized
                      setTimeout(() => {
                        console.log(`[DOWNLOAD] Sending check-widget-ready request`);
                        clipboardManager.blackHoleWindow.webContents.send('check-widget-ready');
                      }, 100);
                    };
                    
                    // Check if DOM is already ready
                    if (clipboardManager.blackHoleWindow.webContents.getURL() && 
                        !clipboardManager.blackHoleWindow.webContents.isLoading()) {
                      console.log(`[DOWNLOAD] DOM appears to be already ready`);
                      handleDomReady();
                    } else {
                      console.log(`[DOWNLOAD] Waiting for DOM ready event`);
                      clipboardManager.blackHoleWindow.webContents.once('dom-ready', handleDomReady);
                    }
                      
                      
                      // Clean up temp file after a delay
                      setTimeout(() => {
                        fs.unlink(tempFilePath, (err) => {
                          if (err) console.error('Error deleting temp file:', err);
                          else console.log(`[DOWNLOAD] Temp file deleted: ${tempFilePath}`);
                        });
                      }, 5000);
                  } else {
                    console.error(`[DOWNLOAD] Black hole window creation failed or was destroyed`);
                  }
                }, 1500); // 1.5 second fallback
              }
            }
          } catch (error) {
            console.error('[DOWNLOAD] Error processing file for space:', error);
          }
        } else {
          console.log(`${windowName} - Download failed: ${state}`);
        }
      });
    } else {
      // Cancel
      item.cancel();
      console.log(`${windowName} - Download cancelled by user`);
    }
  }).catch(err => {
    console.error('Error showing download dialog:', err);
    // Fallback to normal download
    const downloadsPath = app.getPath('downloads');
    const filePath = path.join(downloadsPath, fileName);
    item.setSavePath(filePath);
    // Resume the download for fallback case
    item.resume();
  });
}

module.exports = {
  createMainWindow,
  createSecureContentWindow,
  openURLInMainWindow,
  createSetupWizardWindow,
  createTestWindow,
  getMainWindow,
  openGSXWindow,
  getAuthWindow,
  handleAuthRequest,
  handleDownloadWithSpaceOption
}; 