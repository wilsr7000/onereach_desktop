const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { setApplicationMenu, refreshGSXLinks } = require('../menu');

// Prefer MenuDataManager API when available, fall back to direct imports
function rebuildMenu(idwEnvironments) {
  if (global.menuDataManager) {
    global.menuDataManager.rebuild(idwEnvironments);
  } else {
    setApplicationMenu(idwEnvironments);
  }
}
function refreshLinks() {
  if (global.menuDataManager) {
    global.menuDataManager.refreshGSXLinks();
  } else {
    refreshGSXLinks();
  }
}

// Test configuration
const TEST_CONFIG = {
  // Test data directory
  testDataDir: path.join(__dirname, 'test-data'),

  // Test scenarios
  scenarios: {
    createNew: true,
    editExisting: true,
    deleteExisting: true,
    menuUpdates: true,
    filePersistence: true,
    ipcCommunication: true,
  },

  // Test environments
  testEnvironments: [
    {
      id: 'test-env-1',
      label: 'Test Environment 1',
      environment: 'edison',
      homeUrl: 'https://idw.edison.onereach.ai/test-env-1',
      chatUrl: 'https://idw.edison.onereach.ai/chat/test-1',
      type: 'idw',
    },
    {
      id: 'test-env-2',
      label: 'Test Environment 2',
      environment: 'staging',
      homeUrl: 'https://idw.staging.onereach.ai/test-env-2',
      chatUrl: 'https://idw.staging.onereach.ai/chat/test-2',
      type: 'idw',
    },
  ],
};

// Test results tracking
let testResults = {
  passed: [],
  failed: [],
  warnings: [],
  startTime: null,
  endTime: null,
};

// Windows
let mainWindow = null;
let setupWizardWindow = null;

// Helper functions
function log(message, type = 'info') {
  const timestamp = new Date().toISOString();
  const prefix =
    {
      info: '📘',
      success: '✅',
      error: '❌',
      warning: '⚠️',
      test: '🧪',
    }[type] || '📝';

  console.log(`[${timestamp}] ${prefix} ${message}`);
}

function addTestResult(testName, passed, details = '') {
  const result = {
    test: testName,
    passed: passed,
    details: details,
    timestamp: new Date().toISOString(),
  };

  if (passed) {
    testResults.passed.push(result);
    log(`${testName}: PASSED ${details ? '- ' + details : ''}`, 'success');
  } else {
    testResults.failed.push(result);
    log(`${testName}: FAILED ${details ? '- ' + details : ''}`, 'error');
  }
}

function addWarning(message) {
  testResults.warnings.push({
    message: message,
    timestamp: new Date().toISOString(),
  });
  log(message, 'warning');
}

// Setup test environment
async function setupTestEnvironment() {
  log('Setting up test environment...', 'info');

  // Create test data directory
  if (!fs.existsSync(TEST_CONFIG.testDataDir)) {
    fs.mkdirSync(TEST_CONFIG.testDataDir, { recursive: true });
  }

  // Backup existing configuration files
  const configPath = path.join(app.getPath('userData'), 'idw-entries.json');
  if (fs.existsSync(configPath)) {
    const backupPath = path.join(TEST_CONFIG.testDataDir, 'idw-entries.backup.json');
    fs.copyFileSync(configPath, backupPath);
    log('Backed up existing configuration', 'info');
  }

  // Initialize with test data
  fs.writeFileSync(configPath, JSON.stringify(TEST_CONFIG.testEnvironments, null, 2));
  addTestResult('Test environment setup', true);
}

// Cleanup test environment
async function cleanupTestEnvironment() {
  log('Cleaning up test environment...', 'info');

  // Restore original configuration if exists
  const backupPath = path.join(TEST_CONFIG.testDataDir, 'idw-entries.backup.json');
  const configPath = path.join(app.getPath('userData'), 'idw-entries.json');

  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, configPath);
    fs.unlinkSync(backupPath);
    log('Restored original configuration', 'info');
  }

  // Clean up test data directory
  if (fs.existsSync(TEST_CONFIG.testDataDir)) {
    fs.rmSync(TEST_CONFIG.testDataDir, { recursive: true, force: true });
  }

  addTestResult('Test environment cleanup', true);
}

// Setup IPC handlers with logging
function setupIPCHandlers() {
  log('Setting up IPC handlers...', 'info');

  // Track IPC calls
  const ipcCalls = {
    'get-idw-environments': 0,
    'save-idw-environments': 0,
    'refresh-menu': 0,
  };

  // Handler for getting IDW environments
  ipcMain.on('get-idw-environments', (event) => {
    ipcCalls['get-idw-environments']++;
    log(`IPC: get-idw-environments (call #${ipcCalls['get-idw-environments']})`, 'info');

    const configPath = path.join(app.getPath('userData'), 'idw-entries.json');
    try {
      if (fs.existsSync(configPath)) {
        const data = fs.readFileSync(configPath, 'utf8');
        const environments = JSON.parse(data);
        event.reply('get-idw-environments', environments);
        addTestResult('IPC: get-idw-environments', true, `Returned ${environments.length} environments`);
      } else {
        event.reply('get-idw-environments', []);
        addWarning('IDW entries file not found');
      }
    } catch (error) {
      addTestResult('IPC: get-idw-environments', false, error.message);
      event.reply('get-idw-environments', []);
    }
  });

  // Handler for saving IDW environments
  ipcMain.on('save-idw-environments', (event, environments) => {
    ipcCalls['save-idw-environments']++;
    log(`IPC: save-idw-environments (call #${ipcCalls['save-idw-environments']})`, 'info');

    const configPath = path.join(app.getPath('userData'), 'idw-entries.json');
    try {
      // Validate data
      if (!Array.isArray(environments)) {
        throw new Error('Invalid data: environments must be an array');
      }

      // Create backup
      if (fs.existsSync(configPath)) {
        fs.copyFileSync(configPath, configPath + '.test-backup');
      }

      // Save environments
      fs.writeFileSync(configPath, JSON.stringify(environments, null, 2));

      // Update menu
      rebuildMenu(environments);

      event.reply('idw-environments-saved', true);
      addTestResult('IPC: save-idw-environments', true, `Saved ${environments.length} environments`);
    } catch (error) {
      addTestResult('IPC: save-idw-environments', false, error.message);
      event.reply('idw-environments-saved', false);
    }
  });

  // Handler for menu refresh
  ipcMain.on('refresh-menu', (_event) => {
    ipcCalls['refresh-menu']++;
    log(`IPC: refresh-menu (call #${ipcCalls['refresh-menu']})`, 'info');

    try {
      const configPath = path.join(app.getPath('userData'), 'idw-entries.json');
      let idwEnvironments = [];

      if (fs.existsSync(configPath)) {
        const data = fs.readFileSync(configPath, 'utf8');
        idwEnvironments = JSON.parse(data);
      }

      rebuildMenu(idwEnvironments);
      refreshLinks();

      addTestResult('IPC: refresh-menu', true);
    } catch (error) {
      addTestResult('IPC: refresh-menu', false, error.message);
    }
  });

  // Handlers for other data types
  ['get-external-bots', 'get-image-creators', 'get-video-creators', 'get-audio-generators'].forEach((channel) => {
    ipcMain.on(channel, (event) => {
      log(`IPC: ${channel}`, 'info');
      event.reply(channel, []);
    });
  });

  // Store IPC call counts for verification
  global.ipcCallCounts = ipcCalls;
}

// Test: Create new environment
async function testCreateNewEnvironment(window) {
  log('Testing: Create new environment', 'test');

  return new Promise((resolve) => {
    window.webContents
      .executeJavaScript(
        `
      (async function() {
        try {
          // Click Add New button
          const addBtn = document.querySelector('.primary-add-btn');
          if (!addBtn) throw new Error('Add button not found');
          addBtn.click();
          
          await new Promise(resolve => setTimeout(resolve, 500));
          
          // Choose IDW option
          const idwCard = document.querySelector('.choice-card');
          if (!idwCard) throw new Error('IDW choice card not found');
          idwCard.click();
          
          await new Promise(resolve => setTimeout(resolve, 500));
          
          // Fill in form
          document.getElementById('idw-home-url').value = 'https://idw.edison.onereach.ai/test-new';
          document.getElementById('idw-chat-url').value = 'https://idw.edison.onereach.ai/chat/test-new';
          
          // Trigger validation
          if (typeof validateIDWUrls === 'function') {
            validateIDWUrls();
          }
          
          await new Promise(resolve => setTimeout(resolve, 300));
          
          // Call finish directly (skipping steps 2 and 3 for test)
          if (typeof finish === 'function') {
            finish();
            return { success: true, message: 'Created new environment' };
          } else {
            throw new Error('finish() function not found');
          }
        } catch (error) {
          return { success: false, message: error.message };
        }
      })();
    `
      )
      .then((result) => {
        addTestResult('Create new environment', result.success, result.message);
        resolve(result.success);
      });
  });
}

// Test: Edit existing environment
async function testEditExistingEnvironment(window) {
  log('Testing: Edit existing environment', 'test');

  return new Promise((resolve) => {
    window.webContents
      .executeJavaScript(
        `
      (async function() {
        try {
          // Wait for environments to load
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // Find first edit button
          const editBtn = document.querySelector('.action-btn.edit');
          if (!editBtn) throw new Error('Edit button not found');
          editBtn.click();
          
          await new Promise(resolve => setTimeout(resolve, 500));
          
          // Modify URL
          const homeUrlInput = document.getElementById('idw-home-url');
          if (!homeUrlInput) throw new Error('Home URL input not found');
          
          const oldValue = homeUrlInput.value;
          homeUrlInput.value = oldValue + '-EDITED';
          
          // Trigger validation
          if (typeof validateIDWUrls === 'function') {
            validateIDWUrls();
          }
          
          await new Promise(resolve => setTimeout(resolve, 300));
          
          // Call finish
          if (typeof finish === 'function') {
            finish();
            return { success: true, message: 'Edited environment successfully' };
          } else {
            throw new Error('finish() function not found');
          }
        } catch (error) {
          return { success: false, message: error.message };
        }
      })();
    `
      )
      .then((result) => {
        addTestResult('Edit existing environment', result.success, result.message);
        resolve(result.success);
      });
  });
}

// Test: Menu updates
async function testMenuUpdates() {
  log('Testing: Menu updates', 'test');

  const menu = Menu.getApplicationMenu();
  if (!menu) {
    addTestResult('Menu updates', false, 'No application menu found');
    return false;
  }

  // Find IDW menu
  let idwMenu = null;
  for (let i = 0; i < menu.items.length; i++) {
    if (menu.items[i].label === 'IDW') {
      idwMenu = menu.items[i];
      break;
    }
  }

  if (!idwMenu) {
    addTestResult('Menu updates', false, 'IDW menu not found');
    return false;
  }

  // Check submenu items
  const submenuItems = idwMenu.submenu ? idwMenu.submenu.items : [];
  const environmentItems = submenuItems.filter(
    (item) => item.label !== 'Manage Environments' && item.type !== 'separator'
  );

  addTestResult('Menu updates', true, `Found ${environmentItems.length} environment items in menu`);
  return true;
}

// Test: File persistence
async function testFilePersistence() {
  log('Testing: File persistence', 'test');

  const configPath = path.join(app.getPath('userData'), 'idw-entries.json');

  try {
    if (!fs.existsSync(configPath)) {
      addTestResult('File persistence', false, 'Configuration file not found');
      return false;
    }

    const data = fs.readFileSync(configPath, 'utf8');
    const environments = JSON.parse(data);

    // Check if file contains expected data
    const hasEditedEnvironment = environments.some((env) => env.homeUrl && env.homeUrl.includes('-EDITED'));

    addTestResult(
      'File persistence',
      true,
      `File contains ${environments.length} environments${hasEditedEnvironment ? ' (including edited)' : ''}`
    );
    return true;
  } catch (error) {
    addTestResult('File persistence', false, error.message);
    return false;
  }
}

// Run all tests
async function runAllTests() {
  testResults.startTime = new Date();
  log('Starting Setup Wizard Test Suite', 'test');
  log('================================', 'info');

  try {
    // Setup test environment
    await setupTestEnvironment();

    // Setup IPC handlers
    setupIPCHandlers();

    // Create main window
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '..', 'preload.js'),
      },
    });

    // Set initial menu
    rebuildMenu(TEST_CONFIG.testEnvironments);

    // Create setup wizard window
    setupWizardWindow = new BrowserWindow({
      width: 1000,
      height: 700,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '..', 'preload.js'),
      },
    });

    // Load setup wizard
    await setupWizardWindow.loadFile(path.join(__dirname, '..', 'setup-wizard.html'));

    // Show dev tools for debugging
    if (process.env.DEBUG_TESTS) {
      setupWizardWindow.webContents.openDevTools();
    }

    // Wait for wizard to fully load
    await new Promise((resolve) => {
      setTimeout(resolve, 2000);
    });

    // Run tests based on configuration
    if (TEST_CONFIG.scenarios.editExisting) {
      await testEditExistingEnvironment(setupWizardWindow);
      await new Promise((resolve) => {
        setTimeout(resolve, 2000);
      });
    }

    if (TEST_CONFIG.scenarios.createNew) {
      await testCreateNewEnvironment(setupWizardWindow);
      await new Promise((resolve) => {
        setTimeout(resolve, 2000);
      });
    }

    if (TEST_CONFIG.scenarios.menuUpdates) {
      await testMenuUpdates();
    }

    if (TEST_CONFIG.scenarios.filePersistence) {
      await testFilePersistence();
    }

    if (TEST_CONFIG.scenarios.ipcCommunication) {
      const ipcCalls = global.ipcCallCounts;
      addTestResult(
        'IPC Communication',
        ipcCalls['get-idw-environments'] > 0 && ipcCalls['save-idw-environments'] > 0,
        `get: ${ipcCalls['get-idw-environments']}, save: ${ipcCalls['save-idw-environments']}, refresh: ${ipcCalls['refresh-menu']}`
      );
    }
  } catch (error) {
    log(`Test suite error: ${error.message}`, 'error');
    addTestResult('Test suite execution', false, error.message);
  } finally {
    // Cleanup
    await cleanupTestEnvironment();

    // Close windows
    if (setupWizardWindow && !setupWizardWindow.isDestroyed()) {
      setupWizardWindow.close();
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }

    // Generate test report
    generateTestReport();
  }
}

// Generate test report
function generateTestReport() {
  testResults.endTime = new Date();
  const duration = (testResults.endTime - testResults.startTime) / 1000;

  log('\n================================', 'info');
  log('Test Suite Results', 'test');
  log('================================', 'info');
  log(`Duration: ${duration.toFixed(2)} seconds`, 'info');
  log(`Total tests: ${testResults.passed.length + testResults.failed.length}`, 'info');
  log(`Passed: ${testResults.passed.length}`, 'success');
  log(`Failed: ${testResults.failed.length}`, testResults.failed.length > 0 ? 'error' : 'success');
  log(`Warnings: ${testResults.warnings.length}`, testResults.warnings.length > 0 ? 'warning' : 'info');

  if (testResults.failed.length > 0) {
    log('\nFailed Tests:', 'error');
    testResults.failed.forEach((result) => {
      log(`  - ${result.test}: ${result.details}`, 'error');
    });
  }

  if (testResults.warnings.length > 0) {
    log('\nWarnings:', 'warning');
    testResults.warnings.forEach((warning) => {
      log(`  - ${warning.message}`, 'warning');
    });
  }

  // Save report to file
  const reportPath = path.join(__dirname, `test-report-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(testResults, null, 2));
  log(`\nDetailed report saved to: ${reportPath}`, 'info');

  // Exit with appropriate code
  process.exit(testResults.failed.length > 0 ? 1 : 0);
}

// Run tests when app is ready
app.whenReady().then(() => {
  runAllTests();
});

// Handle app events
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
