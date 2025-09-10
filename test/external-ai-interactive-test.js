const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Interactive test runner for external AI services
class InteractiveAITest {
  constructor() {
    this.mainWindow = null;
    this.testWindow = null;
    this.currentTest = null;
  }

  async start() {
    await app.whenReady();
    this.createMainWindow();
    this.setupIPC();
  }

  createMainWindow() {
    this.mainWindow = new BrowserWindow({
      width: 800,
      height: 900,
      show: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    this.mainWindow.loadFile(path.join(__dirname, 'external-ai-test-ui.html'));
    
    // Show window when ready
    this.mainWindow.once('ready-to-show', () => {
      this.mainWindow.show();
    });
    
    // Open DevTools
    this.mainWindow.webContents.openDevTools();
    
    // Handle window closed
    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
      app.quit();
    });
  }

  setupIPC() {
    // Test a specific service
    ipcMain.handle('test-service', async (event, category, service, config) => {
      return await this.testService(category, service, config);
    });

    // Open service in new window for manual testing
    ipcMain.handle('open-service', async (event, url, name) => {
      return await this.openServiceWindow(url, name);
    });

    // Save test results
    ipcMain.handle('save-results', async (event, results) => {
      return await this.saveResults(results);
    });
  }

  async testService(category, service, config) {
    console.log(`Testing ${config.name}...`);
    
    const result = {
      category,
      service,
      name: config.name,
      url: config.url,
      timestamp: new Date().toISOString(),
      tests: {
        urlLoads: false,
        loginVisible: false,
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
          contextIsolation: true
        }
      });

      // Test URL loading
      await testWindow.loadURL(config.url);
      result.tests.urlLoads = true;

      // Check HTTPS
      result.tests.httpsSecure = config.url.startsWith('https://');

      // Check page responsiveness
      const pageTitle = await testWindow.webContents.executeJavaScript('document.title');
      result.tests.pageResponsive = pageTitle && pageTitle.length > 0;

      // Check for login elements
      const loginCheck = await testWindow.webContents.executeJavaScript(`
        (function() {
          const loginKeywords = ['sign in', 'log in', 'login', 'sign up', 'get started'];
          const pageText = document.body.innerText.toLowerCase();
          const hasLoginText = loginKeywords.some(keyword => pageText.includes(keyword));
          
          const hasLoginButton = document.querySelector('button, a').innerText.toLowerCase().includes('sign') ||
                                document.querySelector('button, a').innerText.toLowerCase().includes('log');
          
          return hasLoginText || hasLoginButton;
        })();
      `);
      result.tests.loginVisible = loginCheck;

      testWindow.close();
    } catch (error) {
      result.error = error.message;
    }

    return result;
  }

  async openServiceWindow(url, name) {
    if (this.testWindow && !this.testWindow.isDestroyed()) {
      this.testWindow.close();
    }

    this.testWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      title: `Testing: ${name}`,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true
      }
    });

    this.testWindow.loadURL(url);
    this.testWindow.webContents.openDevTools();

    return true;
  }

  async saveResults(results) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `external-ai-test-results-${timestamp}.json`;
    const filepath = path.join(__dirname, filename);
    
    fs.writeFileSync(filepath, JSON.stringify(results, null, 2));
    
    return filepath;
  }
}

// Start the interactive test
if (require.main === module) {
  const test = new InteractiveAITest();
  test.start().catch(error => {
    console.error('Failed to start test:', error);
    app.quit();
  });
  
  // Handle app errors
  app.on('window-all-closed', () => {
    app.quit();
  });
}

module.exports = InteractiveAITest; 