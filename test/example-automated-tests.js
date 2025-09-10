/**
 * Example Automated Tests for Onereach.ai Desktop App
 * 
 * This demonstrates how to set up automated testing using:
 * - Spectron for Electron app testing
 * - Mocha as test runner
 * - Chai for assertions
 * 
 * To run: npm test
 */

const Application = require('spectron').Application;
const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Path to your Electron app
const electronPath = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
const appPath = path.join(__dirname, '..');

describe('Onereach.ai Desktop App', function() {
  this.timeout(10000);
  
  let app;
  
  // Start app before tests
  beforeEach(async function() {
    app = new Application({
      path: electronPath,
      args: [appPath],
      env: {
        NODE_ENV: 'test'
      }
    });
    
    await app.start();
  });
  
  // Stop app after tests
  afterEach(async function() {
    if (app && app.isRunning()) {
      await app.stop();
    }
  });
  
  describe('Application Launch', function() {
    it('should launch the application', async function() {
      const isVisible = await app.browserWindow.isVisible();
      assert.strictEqual(isVisible, true);
    });
    
    it('should have correct window title', async function() {
      const title = await app.client.getTitle();
      assert.strictEqual(title, 'Onereach.ai');
    });
    
    it('should create tray icon', async function() {
      // Check if tray was created in main process
      const hasTray = await app.electron.remote.getGlobal('tray');
      assert.ok(hasTray);
    });
  });
  
  describe('Clipboard Monitoring', function() {
    it('should detect copied text', async function() {
      // Copy text to clipboard
      await app.electron.clipboard.writeText('Test clipboard content');
      
      // Wait for clipboard to be processed
      await app.client.pause(1000);
      
      // Check if item appears in history
      const history = await app.electron.ipcRenderer.invoke('clipboard:get-history');
      const hasTestContent = history.some(item => 
        item.content.includes('Test clipboard content')
      );
      
      assert.strictEqual(hasTestContent, true);
    });
    
    it('should detect source type correctly', async function() {
      // Test URL detection
      await app.electron.clipboard.writeText('https://example.com');
      await app.client.pause(1000);
      
      const history = await app.electron.ipcRenderer.invoke('clipboard:get-history');
      const urlItem = history.find(item => item.content === 'https://example.com');
      
      assert.strictEqual(urlItem.source, 'url');
    });
  });
  
  describe('Spaces Management', function() {
    it('should create a new space', async function() {
      const newSpace = {
        name: 'Test Space',
        icon: '🧪',
        color: '#ff0000'
      };
      
      await app.electron.ipcRenderer.invoke('clipboard:create-space', newSpace);
      
      const spaces = await app.electron.ipcRenderer.invoke('clipboard:get-spaces');
      const createdSpace = spaces.find(s => s.name === 'Test Space');
      
      assert.ok(createdSpace);
      assert.strictEqual(createdSpace.icon, '🧪');
    });
    
    it('should move item between spaces', async function() {
      // Get first item from history
      const history = await app.electron.ipcRenderer.invoke('clipboard:get-history');
      const item = history[0];
      
      if (item) {
        // Move to a different space
        await app.electron.ipcRenderer.invoke(
          'clipboard:move-to-space', 
          item.id, 
          'work'
        );
        
        // Verify move
        const updatedHistory = await app.electron.ipcRenderer.invoke('clipboard:get-history');
        const movedItem = updatedHistory.find(i => i.id === item.id);
        
        assert.strictEqual(movedItem.spaceId, 'work');
      }
    });
  });
  
  describe('Black Hole Widget', function() {
    it('should create black hole window', async function() {
      await app.electron.ipcRenderer.send('toggle-black-hole');
      
      // Wait for window to be created
      await app.client.pause(500);
      
      // Check if black hole window exists
      const windows = await app.client.getWindowHandles();
      assert.ok(windows.length > 1, 'Black hole window should be created');
    });
  });
  
  describe('Settings', function() {
    it('should save and load settings', async function() {
      const testSettings = {
        openaiApiKey: 'test-key-123',
        claudeApiKey: 'test-claude-key'
      };
      
      // Save settings
      await app.electron.ipcRenderer.invoke('save-settings', testSettings);
      
      // Load settings
      const loadedSettings = await app.electron.ipcRenderer.invoke('get-settings');
      
      assert.strictEqual(loadedSettings.openaiApiKey, 'test-key-123');
      assert.strictEqual(loadedSettings.claudeApiKey, 'test-claude-key');
    });
  });
  
  describe('Export Features', function() {
    it('should generate smart export', async function() {
      // Select some items
      const itemIds = ['item1', 'item2'];
      
      const exportData = await app.electron.ipcRenderer.invoke(
        'smart-export:generate',
        {
          itemIds,
          format: 'article',
          style: 'default'
        }
      );
      
      assert.ok(exportData);
      assert.ok(exportData.content);
      assert.ok(exportData.metadata);
    });
  });
});

/**
 * Performance Tests
 */
describe('Performance Tests', function() {
  this.timeout(30000);
  
  let app;
  
  before(async function() {
    app = new Application({
      path: electronPath,
      args: [appPath]
    });
    await app.start();
  });
  
  after(async function() {
    if (app && app.isRunning()) {
      await app.stop();
    }
  });
  
  it('should handle 1000 clipboard items efficiently', async function() {
    const startTime = Date.now();
    
    // Add 1000 items
    for (let i = 0; i < 1000; i++) {
      await app.electron.clipboard.writeText(`Test item ${i}`);
      // Small delay to simulate real usage
      if (i % 100 === 0) {
        await app.client.pause(10);
      }
    }
    
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    // Should complete in under 30 seconds
    assert.ok(duration < 30000, `Took ${duration}ms to process 1000 items`);
    
    // Check memory usage
    const memoryInfo = await app.electron.process.getProcessMemoryInfo();
    const memoryMB = memoryInfo.private / 1024 / 1024;
    
    // Should use less than 500MB
    assert.ok(memoryMB < 500, `Memory usage: ${memoryMB}MB`);
  });
  
  it('should search quickly through large dataset', async function() {
    const startTime = Date.now();
    
    const results = await app.electron.ipcRenderer.invoke(
      'clipboard:search',
      'test'
    );
    
    const searchTime = Date.now() - startTime;
    
    // Search should complete in under 500ms
    assert.ok(searchTime < 500, `Search took ${searchTime}ms`);
  });
});

/**
 * Integration Tests
 */
describe('Integration Tests', function() {
  this.timeout(15000);
  
  let app;
  
  before(async function() {
    app = new Application({
      path: electronPath,
      args: [appPath]
    });
    await app.start();
  });
  
  after(async function() {
    if (app && app.isRunning()) {
      await app.stop();
    }
  });
  
  it('should complete full workflow: copy → organize → export', async function() {
    // Step 1: Copy some content
    await app.electron.clipboard.writeText('Important project notes');
    await app.client.pause(500);
    
    // Step 2: Create a space
    await app.electron.ipcRenderer.invoke('clipboard:create-space', {
      name: 'Project X',
      icon: '📁',
      color: '#0099ff'
    });
    
    // Step 3: Move item to space
    const history = await app.electron.ipcRenderer.invoke('clipboard:get-history');
    const item = history[0];
    
    await app.electron.ipcRenderer.invoke(
      'clipboard:move-to-space',
      item.id,
      'project-x'
    );
    
    // Step 4: Export as document
    const exportResult = await app.electron.ipcRenderer.invoke(
      'smart-export:generate',
      {
        itemIds: [item.id],
        format: 'article',
        style: 'default'
      }
    );
    
    // Verify workflow completed
    assert.ok(exportResult.content.includes('Important project notes'));
  });
});

// Add to package.json:
/*
{
  "scripts": {
    "test": "mocha test/example-automated-tests.js",
    "test:unit": "mocha test/unit/**/*.js",
    "test:integration": "mocha test/integration/**/*.js",
    "test:e2e": "mocha test/e2e/**/*.js"
  },
  "devDependencies": {
    "spectron": "^19.0.0",
    "mocha": "^10.0.0",
    "chai": "^4.3.0"
  }
}
*/ 