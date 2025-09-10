const { app, BrowserWindow, net, ipcMain, shell } = require('electron');
const path = require('path');
const logger = require('electron-log/main');

const log = logger.scope('main:feed');

// Global listener to log every new BrowserWindow created
app.on('browser-window-created', (event, window) => {
  log.info("[DEBUG] New BrowserWindow created. Window ID:", window.id);
  window.webContents.once('did-finish-load', () => {
    log.info("[DEBUG] BrowserWindow (ID:", window.id, ") finished loading. URL:", window.webContents.getURL());
  });
});

function createWindow() {
  log.info("[DEBUG] createWindow() called");
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true // Keep web security enabled
    }
  });
  log.info("[DEBUG] BrowserWindow created in createWindow with id:", mainWindow.id);

  // Log when the browser page has finished loading
  mainWindow.webContents.on('did-finish-load', () => {
    log.info("[LOG] Browser page launched: " + mainWindow.webContents.getURL());
  });

  // Load the initial page (index.html)
      // Fix for Windows path compatibility
    const { pathToFileURL } = require('url');
    mainWindow.loadURL(pathToFileURL(path.join(__dirname, 'index.html')).href);

  // Set up IPC handlers
  setupIpcHandlers(mainWindow);
}

function setupIpcHandlers(mainWindow) {
  // Enhanced RSS/Article fetching with better error handling and redirect support
  ipcMain.handle('fetch-rss', async (event, url, redirectCount = 0) => {
    const MAX_REDIRECTS = 5;
    const REQUEST_TIMEOUT = 15000; // 15 seconds
    
    log.info('Fetching RSS/Article from:', url, `(redirect count: ${redirectCount})`);
    
    // Prevent infinite redirects
    if (redirectCount > MAX_REDIRECTS) {
      throw new Error(`Too many redirects (${MAX_REDIRECTS})`);
    }
    
    try {
      // Determine if this is an RSS feed or article URL
      const isRSSFeed = url.includes('/feed') || url.includes('.xml') || url.includes('.rss') || url.includes('rss');
      
      const request = net.request({
        method: 'GET',
        url: url,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': isRSSFeed 
            ? 'application/rss+xml, application/xml, text/xml, */*'
            : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none'
        }
      });
      
      return new Promise((resolve, reject) => {
        let data = '';
        let timeout;
        
        // Set timeout
        timeout = setTimeout(() => {
          log.error('Request timeout for:', url);
          request.abort();
          reject(new Error(`Request timeout after ${REQUEST_TIMEOUT}ms`));
        }, REQUEST_TIMEOUT);
        
        request.on('response', (response) => {
          log.info('Response status:', response.statusCode, 'for:', url);
          log.info('Response headers:', response.headers);
          
          // Handle redirects
          if (response.statusCode >= 300 && response.statusCode < 400) {
            const location = response.headers.location || response.headers.Location;
            if (location) {
              clearTimeout(timeout);
              log.info('Following redirect to:', location);
              
              // Resolve relative URLs
              let redirectUrl = location;
              if (location.startsWith('/')) {
                const urlObj = new URL(url);
                redirectUrl = `${urlObj.protocol}//${urlObj.host}${location}`;
              } else if (!location.startsWith('http')) {
                const urlObj = new URL(url);
                redirectUrl = `${urlObj.protocol}//${urlObj.host}/${location}`;
              }
              
              // Recursively follow redirect
              return resolve(ipcMain.invoke('fetch-rss', event, redirectUrl, redirectCount + 1));
            }
          }
          
          // Handle successful responses
          if (response.statusCode >= 200 && response.statusCode < 300) {
            response.on('data', (chunk) => {
              data += chunk;
            });
            
            response.on('end', () => {
              clearTimeout(timeout);
              log.info('Successfully fetched content, length:', data.length);
              resolve(data);
            });
          } else {
            clearTimeout(timeout);
            const error = new Error(`HTTP ${response.statusCode}: ${response.statusMessage || 'Unknown error'}`);
            log.error('HTTP error:', error.message);
            reject(error);
          }
        });
        
        request.on('error', (error) => {
          clearTimeout(timeout);
          log.error('Request error for:', url, error);
          reject(new Error(`Network error: ${error.message}`));
        });
        
        request.on('abort', () => {
          clearTimeout(timeout);
          log.error('Request aborted for:', url);
          reject(new Error('Request was aborted'));
        });
        
        // Start the request
        request.end();
      });
    } catch (error) {
      log.error('Error in fetch-rss for:', url, error);
      throw new Error(`Failed to fetch RSS: ${error.message}`);
    }
  });

  // Handle external link opening
  ipcMain.on('open-external-link', (event, url) => {
    log.info('Opening external link:', url);
    shell.openExternal(url);
  });

  // Handle reading log operations with file system storage
  ipcMain.on('save-reading-log', (event, logData) => {
    try {
      const fs = require('fs');
      const os = require('os');
      const logPath = path.join(os.homedir(), '.flipboard-reader-log.json');
      
      fs.writeFileSync(logPath, JSON.stringify(logData, null, 2));
      log.info('Reading log saved successfully');
    } catch (error) {
      log.error('Error saving reading log:', error);
    }
  });

  ipcMain.on('save-reading-log-sync', (event, logData) => {
    try {
      const fs = require('fs');
      const os = require('os');
      const logPath = path.join(os.homedir(), '.flipboard-reader-log.json');
      
      fs.writeFileSync(logPath, JSON.stringify(logData, null, 2));
      log.info('Reading log saved synchronously');
      event.returnValue = true;
    } catch (error) {
      log.error('Error saving reading log sync:', error);
      event.returnValue = false;
    }
  });

  ipcMain.handle('load-reading-log', async () => {
    try {
      const fs = require('fs');
      const os = require('os');
      const logPath = path.join(os.homedir(), '.flipboard-reader-log.json');
      
      if (fs.existsSync(logPath)) {
        const data = fs.readFileSync(logPath, 'utf8');
        const logData = JSON.parse(data);
        log.info('Reading log loaded successfully');
        return logData;
      } else {
        log.info('No existing reading log found, returning empty object');
        return {};
      }
    } catch (error) {
      log.error('Error loading reading log:', error);
      return {};
    }
  });
}

app.whenReady().then(() => {
  log.info("[LOG] App is ready. Creating main window...");
  createWindow();

  app.on('activate', function() {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
}); 