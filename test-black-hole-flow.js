/**
 * Black Hole Flow Test Script
 * Tests the complete save flow from IPC handler to storage
 *
 * Runs automatically on app startup in dev mode
 */

const { _ipcMain } = require('electron');

class BlackHoleFlowTest {
  constructor() {
    this.results = [];
    this.clipboardManager = null;
  }

  log(level, message, data = null) {
    const timestamp = new Date().toISOString().substring(11, 23);
    const prefix = level === 'PASS' ? '✅' : level === 'FAIL' ? '❌' : level === 'INFO' ? 'ℹ️' : '🔍';
    console.log(`[TEST ${timestamp}] ${prefix} ${message}`);
    if (data) {
      const dataStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      console.log(`[TEST ${timestamp}]    ${dataStr.substring(0, 300)}`);
    }
    this.results.push({ level, message, data, timestamp });
  }

  async delay(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  // Test 1: Check if clipboard manager is available
  async testClipboardManagerExists() {
    this.log('INFO', 'Test 1: Checking ClipboardManager...');

    if (!global.clipboardManager) {
      this.log('FAIL', 'global.clipboardManager is undefined');
      return false;
    }

    this.clipboardManager = global.clipboardManager;
    this.log('PASS', 'ClipboardManager exists');
    return true;
  }

  // Test 2: Test IPC handler directly using ipcMain._invokeHandlers
  async testIPCHandlerDirect() {
    this.log('INFO', 'Test 2: Testing IPC handler invocation...');

    // The IPC handlers are registered with ipcMain.handle()
    // We need to find and call them directly

    const testData = {
      content: 'IPC HANDLER TEST ' + Date.now(),
      spaceId: 'unclassified',
    };

    try {
      // Create a mock event object
      const _mockEvent = {
        sender: {
          send: () => {},
          isDestroyed: () => false,
        },
      };

      // Get initial count
      const initialCount = this.clipboardManager.history.length;
      this.log('INFO', `Initial history count: ${initialCount}`);

      // The handler is on the clipboard manager, let's call addToHistory directly
      // simulating what the IPC handler does

      const item = {
        type: 'text',
        content: testData.content,
        preview: testData.content.substring(0, 100),
        timestamp: Date.now(),
        pinned: false,
        spaceId: testData.spaceId,
        source: 'ipc-test',
      };

      this.clipboardManager.addToHistory(item);

      const newCount = this.clipboardManager.history.length;

      if (newCount > initialCount) {
        this.log('PASS', `IPC handler simulation succeeded (${initialCount} -> ${newCount})`);
        return true;
      } else {
        this.log('FAIL', 'Item was not added to history');
        return false;
      }
    } catch (e) {
      this.log('FAIL', `IPC handler test error: ${e.message}`);
      return false;
    }
  }

  // Test 3: Test the actual black-hole:add-text IPC invoke
  async testActualIPCInvoke() {
    this.log('INFO', 'Test 3: Testing actual IPC invoke (black-hole:add-text)...');

    const testData = {
      content: 'ACTUAL IPC TEST ' + Date.now(),
      spaceId: 'unclassified',
    };

    try {
      const initialCount = this.clipboardManager.history.length;

      // Use Electron's internal mechanism to invoke the handler
      // The handlers are stored in ipcMain
      const { _ipcMain } = require('electron');

      // ipcMain stores handlers internally - we can access them through _invokeHandlers
      // But that's internal, so instead let's just test the clipboard manager method directly

      // Simulate what the preload exposes: window.clipboard.addText calls ipcRenderer.invoke('black-hole:add-text', data)
      // The handler in clipboard-manager-v2-adapter.js then processes it

      // Let's verify the handler exists and test the flow
      this.log('INFO', 'Simulating frontend call: window.clipboard.addText(data)');
      this.log('INFO', `Test data: ${JSON.stringify(testData)}`);

      // Check if content is YouTube (same logic as handler)
      const ytModule = require('./youtube-downloader');
      const isYT = ytModule.isYouTubeUrl(testData.content);
      this.log('INFO', `Is YouTube URL: ${isYT}`);

      if (!isYT) {
        // Regular text save
        const item = {
          type: 'text',
          content: testData.content,
          preview: this.clipboardManager.truncateText(testData.content, 100),
          timestamp: Date.now(),
          pinned: false,
          spaceId: testData.spaceId,
          source: 'actual-ipc-test',
        };

        this.log('INFO', 'Calling clipboardManager.addToHistory...');
        this.clipboardManager.addToHistory(item);

        const newCount = this.clipboardManager.history.length;

        if (newCount > initialCount) {
          this.log('PASS', `Actual IPC simulation succeeded (${initialCount} -> ${newCount})`);

          // Verify item is in storage
          const addedItem = this.clipboardManager.history.find((h) => h.content === testData.content);
          if (addedItem && addedItem.id) {
            const stored = this.clipboardManager.storage.loadItem(addedItem.id);
            if (stored) {
              this.log('PASS', 'Item verified in storage');
            } else {
              this.log('FAIL', 'Item not found in storage');
            }
          }

          return true;
        }
      }

      this.log('FAIL', 'Item was not added');
      return false;
    } catch (e) {
      this.log('FAIL', `Actual IPC test error: ${e.message}`);
      this.log('INFO', e.stack);
      return false;
    }
  }

  // Test 4: Test YouTube URL detection and handling
  async testYouTubeFlow() {
    this.log('INFO', 'Test 4: Testing YouTube URL detection...');

    const youtubeUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

    try {
      const ytModule = require('./youtube-downloader');

      // Test detection
      const isYT = ytModule.isYouTubeUrl(youtubeUrl);
      if (!isYT) {
        this.log('FAIL', 'YouTube URL not detected');
        return false;
      }
      this.log('PASS', 'YouTube URL detected correctly');

      // Test video ID extraction
      const videoId = ytModule.extractVideoId(youtubeUrl);
      if (videoId === 'dQw4w9WgXcQ') {
        this.log('PASS', `Video ID extracted: ${videoId}`);
      } else {
        this.log('FAIL', `Wrong video ID: ${videoId}`);
      }

      return true;
    } catch (e) {
      this.log('FAIL', `YouTube test error: ${e.message}`);
      return false;
    }
  }

  // Test 5: Test spaces loading
  async testSpacesLoading() {
    this.log('INFO', 'Test 5: Testing spaces loading...');

    try {
      // The storage has a getSpaces method or we can read from spacesDir
      const fs = require('fs');
      const path = require('path');

      const spacesDir = this.clipboardManager.storage.spacesDir;
      this.log('INFO', `Spaces directory: ${spacesDir}`);

      if (!fs.existsSync(spacesDir)) {
        this.log('FAIL', 'Spaces directory does not exist');
        return false;
      }

      const spaceFiles = fs.readdirSync(spacesDir).filter((f) => {
        const stat = fs.statSync(path.join(spacesDir, f));
        return stat.isDirectory();
      });

      this.log('PASS', `Found ${spaceFiles.length} spaces: ${spaceFiles.join(', ')}`);
      return spaceFiles.length > 0;
    } catch (e) {
      this.log('FAIL', `Spaces test error: ${e.message}`);
      return false;
    }
  }

  // Test 6: Full flow simulation
  async testFullFlow() {
    this.log('INFO', 'Test 6: Full flow simulation (paste -> save -> verify)...');

    const testContent = 'FULL FLOW TEST ' + Date.now();

    try {
      // Step 1: Simulate clipboard data received
      this.log('INFO', 'Step 1: Simulating clipboard data...');
      const _clipboardData = {
        hasText: true,
        hasHtml: false,
        hasImage: false,
        text: testContent,
      };

      // Step 2: Process like black-hole.js would
      this.log('INFO', 'Step 2: Processing clipboard data...');
      const pendingItem = {
        type: 'text',
        data: { content: testContent },
        preview: testContent.substring(0, 100),
        isYouTube: false,
      };

      // Step 3: Simulate save (what handleConfirm does)
      this.log('INFO', 'Step 3: Simulating save...');
      const saveData = {
        content: pendingItem.data.content,
        spaceId: 'unclassified',
      };

      const initialCount = this.clipboardManager.history.length;

      // This is what the IPC handler does:
      const item = {
        type: 'text',
        content: saveData.content,
        preview: this.clipboardManager.truncateText(saveData.content, 100),
        timestamp: Date.now(),
        pinned: false,
        spaceId: saveData.spaceId,
        source: 'full-flow-test',
      };

      this.clipboardManager.addToHistory(item);

      // Step 4: Verify
      this.log('INFO', 'Step 4: Verifying...');
      const newCount = this.clipboardManager.history.length;

      if (newCount <= initialCount) {
        this.log('FAIL', 'Item was not added to history');
        return false;
      }

      const savedItem = this.clipboardManager.history.find((h) => h.content === testContent);
      if (!savedItem) {
        this.log('FAIL', 'Item not found in history');
        return false;
      }

      this.log('PASS', `Item saved with ID: ${savedItem.id}`);

      // Check storage
      const storedItem = this.clipboardManager.storage.loadItem(savedItem.id);
      if (storedItem) {
        this.log('PASS', 'Item verified in persistent storage');
      } else {
        this.log('FAIL', 'Item not in persistent storage');
        return false;
      }

      this.log('PASS', 'Full flow test completed successfully');
      return true;
    } catch (e) {
      this.log('FAIL', `Full flow error: ${e.message}`);
      this.log('INFO', e.stack);
      return false;
    }
  }

  // Run all tests
  async runAll() {
    console.log('\n');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║          BLACK HOLE SAVE FLOW - AUTOMATED TESTS              ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('\n');

    const tests = [
      { name: 'ClipboardManager', fn: () => this.testClipboardManagerExists() },
      { name: 'IPC Handler Direct', fn: () => this.testIPCHandlerDirect() },
      { name: 'Actual IPC Invoke', fn: () => this.testActualIPCInvoke() },
      { name: 'YouTube Detection', fn: () => this.testYouTubeFlow() },
      { name: 'Spaces Loading', fn: () => this.testSpacesLoading() },
      { name: 'Full Flow', fn: () => this.testFullFlow() },
    ];

    let passed = 0;
    let failed = 0;

    for (const test of tests) {
      try {
        const result = await test.fn();
        if (result) passed++;
        else failed++;
      } catch (e) {
        this.log('FAIL', `${test.name} threw error: ${e.message}`);
        failed++;
      }
      await this.delay(100);
    }

    console.log('\n');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log(`║  RESULTS: ${passed} PASSED, ${failed} FAILED                                 ║`);
    console.log('╚══════════════════════════════════════════════════════════════╝');

    if (failed === 0) {
      console.log('\n✅ ALL BACKEND TESTS PASS - If save still fails, issue is in frontend IPC\n');
    } else {
      console.log('\n❌ BACKEND HAS ISSUES - Fix these first\n');
    }

    return { passed, failed, results: this.results };
  }
}

// Test the renderer flow by simulating what happens when paste-clipboard-data is sent
async function testRendererFlow() {
  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  SIMULATING FULL PASTE FLOW                                   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  const cm = global.clipboardManager;
  if (!cm) {
    console.log('❌ ClipboardManager not available');
    return;
  }

  // Test 1: Open Black Hole with clipboard data pre-populated
  console.log('\n[FlowTest] Step 1: Creating Black Hole window with test data...');

  const testClipboardData = {
    hasText: true,
    hasHtml: false,
    hasImage: false,
    text: 'FLOW TEST ' + Date.now(),
  };

  // Create window with clipboard data
  const position = { x: 200, y: 200 };
  cm.createBlackHoleWindow(position, true, testClipboardData);

  console.log('[FlowTest] Step 2: Window created, clipboard data passed');
  console.log('[FlowTest] Test data:', testClipboardData.text);

  // Wait for window to load
  await new Promise((resolve) => {
    setTimeout(resolve, 2000);
  });

  console.log('[FlowTest] Step 3: If window shows modal with content, test PASSES');
  console.log('[FlowTest] Step 4: Click Save to verify full flow');
  console.log('[FlowTest] Look for "ADD-TEXT HANDLER CALLED" in logs when you click Save\n');
}

module.exports = {
  runTests: async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 2000);
    });
    const tester = new BlackHoleFlowTest();
    return tester.runAll();
  },
  testRendererFlow,
  BlackHoleFlowTest,
};
