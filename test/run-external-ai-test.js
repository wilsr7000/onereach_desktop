const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

console.log('🚀 Starting External AI Test Runner...');
console.log('📁 Working directory:', __dirname);

let mainWindow = null;
let testWindows = [];

// Prevent app from quitting when all windows are closed
app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('ready', () => {
  console.log('✅ Electron app ready');
  createMainWindow();
});

function createMainWindow() {
  console.log('🪟 Creating main window...');
  
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false
    }
  });

  const htmlPath = path.join(__dirname, 'external-ai-test-ui.html');
  console.log('📄 Loading HTML from:', htmlPath);
  
  // Check if file exists
  if (!fs.existsSync(htmlPath)) {
    console.error('❌ HTML file not found:', htmlPath);
    app.quit();
    return;
  }
  
  mainWindow.loadFile(htmlPath);
  
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('✅ HTML loaded successfully');
    mainWindow.show();
  });
  
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('❌ Failed to load HTML:', errorCode, errorDescription);
  });
  
  // Open DevTools
  mainWindow.webContents.openDevTools();
  
  mainWindow.on('closed', () => {
    console.log('🚪 Main window closed');
    mainWindow = null;
    // Close all test windows
    testWindows.forEach(w => {
      if (w && !w.isDestroyed()) w.close();
    });
    app.quit();
  });
  
  // Setup IPC handlers
  setupIPC();
}

function setupIPC() {
  console.log('📡 Setting up IPC handlers...');
  
  // Test a specific service
  ipcMain.handle('test-service', async (event, category, service, config) => {
    console.log(`🧪 Testing ${config.name}...`);
    
    const result = {
      category,
      service,
      name: config.name,
      url: config.url,
      timestamp: new Date().toISOString(),
      tests: {
        urlLoads: false,
        loginVisible: false,
        googleLoginAvailable: false,
        pageResponsive: false,
        httpsSecure: false
      }
    };

    try {
      // Create hidden test window
      const testWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: false
        }
      });

      console.log(`  📍 Loading ${config.url}...`);
      
      // Test URL loading with timeout
      const loadPromise = testWindow.loadURL(config.url);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), 10000)
      );
      
      await Promise.race([loadPromise, timeoutPromise]);
      result.tests.urlLoads = true;
      console.log(`  ✅ URL loaded`);

      // Check HTTPS
      result.tests.httpsSecure = config.url.startsWith('https://');
      console.log(`  ${result.tests.httpsSecure ? '✅' : '❌'} HTTPS: ${result.tests.httpsSecure}`);

      // Check page responsiveness
      try {
        const pageTitle = await testWindow.webContents.executeJavaScript('document.title');
        result.tests.pageResponsive = pageTitle && pageTitle.length > 0;
        console.log(`  ${result.tests.pageResponsive ? '✅' : '❌'} Page responsive`);
      } catch (e) {
        console.log(`  ❌ Page not responsive:`, e.message);
      }

      // Check for login elements
      try {
        const loginCheck = await testWindow.webContents.executeJavaScript(`
          (function() {
            const loginKeywords = ['sign in', 'log in', 'login', 'sign up', 'get started'];
            const pageText = document.body ? document.body.innerText.toLowerCase() : '';
            const hasLoginText = loginKeywords.some(keyword => pageText.includes(keyword));
            
            const buttons = document.querySelectorAll('button, a');
            let hasLoginButton = false;
            buttons.forEach(btn => {
              const text = btn.innerText ? btn.innerText.toLowerCase() : '';
              if (text.includes('sign') || text.includes('log')) {
                hasLoginButton = true;
              }
            });
            
            return hasLoginText || hasLoginButton;
          })();
        `);
        result.tests.loginVisible = loginCheck;
        console.log(`  ${result.tests.loginVisible ? '✅' : '❌'} Login elements: ${result.tests.loginVisible}`);
      } catch (e) {
        console.log(`  ❌ Could not check login elements:`, e.message);
      }

      // Check for Google login specifically
      try {
        const googleLoginCheck = await testWindow.webContents.executeJavaScript(`
          (function() {
            // Check for Google login text
            const googleKeywords = ['google', 'continue with google', 'sign in with google', 'google sign in'];
            const pageText = document.body ? document.body.innerText.toLowerCase() : '';
            const hasGoogleText = googleKeywords.some(keyword => pageText.includes(keyword));
            
            // Check for Google login buttons/links
            const elements = document.querySelectorAll('button, a, div[role="button"]');
            let hasGoogleButton = false;
            elements.forEach(elem => {
              const text = elem.innerText ? elem.innerText.toLowerCase() : '';
              const ariaLabel = elem.getAttribute('aria-label') ? elem.getAttribute('aria-label').toLowerCase() : '';
              if (text.includes('google') || ariaLabel.includes('google')) {
                hasGoogleButton = true;
              }
            });
            
            // Check for Google OAuth URLs
            const links = document.querySelectorAll('a[href*="accounts.google.com"], a[href*="oauth2/auth"]');
            const hasGoogleOAuth = links.length > 0;
            
            // Check for Google logo/images
            const images = document.querySelectorAll('img[src*="google"], img[alt*="Google"]');
            const hasGoogleImages = images.length > 0;
            
            return {
              hasGoogleLogin: hasGoogleText || hasGoogleButton || hasGoogleOAuth || hasGoogleImages,
              details: {
                text: hasGoogleText,
                button: hasGoogleButton,
                oauth: hasGoogleOAuth,
                images: hasGoogleImages
              }
            };
          })();
        `);
        result.tests.googleLoginAvailable = googleLoginCheck.hasGoogleLogin;
        console.log(`  ${googleLoginCheck.hasGoogleLogin ? '✅' : '❌'} Google login: ${googleLoginCheck.hasGoogleLogin}`);
        if (googleLoginCheck.hasGoogleLogin) {
          console.log(`    Details: Text:${googleLoginCheck.details.text} Button:${googleLoginCheck.details.button} OAuth:${googleLoginCheck.details.oauth} Images:${googleLoginCheck.details.images}`);
        }
      } catch (e) {
        console.log(`  ❌ Could not check Google login:`, e.message);
      }

      testWindow.close();
    } catch (error) {
      console.error(`  ❌ Error testing ${config.name}:`, error.message);
      result.error = error.message;
    }

    return result;
  });

  // Open service in new window for manual testing
  ipcMain.handle('open-service', async (event, url, name) => {
    console.log(`🪟 Opening ${name} at ${url}`);
    
    const testWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      title: `Testing: ${name}`,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: false
      }
    });

    testWindow.loadURL(url);
    testWindow.webContents.openDevTools();
    
    testWindows.push(testWindow);
    
    testWindow.on('closed', () => {
      const index = testWindows.indexOf(testWindow);
      if (index > -1) testWindows.splice(index, 1);
    });

    return true;
  });

  // Save test results
  ipcMain.handle('save-results', async (event, results) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `external-ai-test-results-${timestamp}.json`;
    const filepath = path.join(__dirname, filename);
    
    fs.writeFileSync(filepath, JSON.stringify(results, null, 2));
    console.log(`💾 Results saved to: ${filepath}`);
    
    return filepath;
  });
  
  console.log('✅ IPC handlers ready');
}

// Error handling
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled rejection at:', promise, 'reason:', reason);
}); 