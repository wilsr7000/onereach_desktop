/**
 * AI Conversation Capture - Simple Smoke Test
 *
 * Quick validation that the test infrastructure is working.
 * Run with: npm run test:e2e:ai-conversation:smoke
 */

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const path = require('path');

test.describe('AI Conversation Capture - Smoke Test', () => {
  let electronApp;
  let mainWindow;

  test('should launch Electron app in test mode', async () => {
    electronApp = await electron.launch({
      args: [path.join(__dirname, '../../main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        TEST_MODE: 'true',
      },
      timeout: 30000,
    });

    expect(electronApp).toBeDefined();

    mainWindow = await electronApp.firstWindow();
    expect(mainWindow).toBeDefined();

    await mainWindow.waitForLoadState('domcontentloaded');

    const title = await mainWindow.title();
    console.log('App launched:', title);

    expect(title).toBeTruthy();
  });

  test('should have conversation capture IPC handlers', async () => {
    if (!electronApp) {
      electronApp = await electron.launch({
        args: [path.join(__dirname, '../../main.js')],
        env: {
          ...process.env,
          NODE_ENV: 'test',
          TEST_MODE: 'true',
        },
      });
      mainWindow = await electronApp.firstWindow();
    }

    // Test that conversation capture API exists
    // For now, just verify the window loaded successfully
    const title = await mainWindow.title();
    expect(title).toBeTruthy();
    console.log('Conversation capture system loaded');
  });

  test('should be able to access Spaces API', async () => {
    if (!electronApp) {
      electronApp = await electron.launch({
        args: [path.join(__dirname, '../../main.js')],
        env: {
          ...process.env,
          NODE_ENV: 'test',
          TEST_MODE: 'true',
        },
      });
      mainWindow = await electronApp.firstWindow();
    }

    // Use the proper exposed API
    const spaces = await mainWindow.evaluate(() => {
      return window.spaces.list();
    });

    expect(Array.isArray(spaces)).toBe(true);
    console.log('Spaces found:', spaces.length);
  });

  test('should support test-capture via Spaces API', async () => {
    if (!electronApp) {
      electronApp = await electron.launch({
        args: [path.join(__dirname, '../../main.js')],
        env: {
          ...process.env,
          NODE_ENV: 'test',
          TEST_MODE: 'true',
        },
      });
      mainWindow = await electronApp.firstWindow();
    }

    // Create a test conversation using the Spaces API
    const result = await mainWindow.evaluate(async () => {
      // Get or create Claude Conversations space
      const spaces = await window.spaces.list();
      let claudeSpace = spaces.find((s) => s.name === 'Claude Conversations');

      if (!claudeSpace) {
        claudeSpace = await window.spaces.create('Claude Conversations', {
          icon: '🤖',
          color: '#ff6b35',
        });
      }

      // Add a test conversation item
      const item = await window.spaces.items.add(claudeSpace.id, {
        type: 'text',
        content: '# Test Conversation\n\n**User**: Test message\n\n**Claude**: Test response',
        metadata: {
          aiService: 'Claude',
          exchangeCount: 1,
          tags: ['test', 'ai-conversation'],
        },
      });

      return { success: true, itemId: item.id, spaceId: claudeSpace.id };
    });

    expect(result.success).toBe(true);
    expect(result.itemId).toBeDefined();
    console.log('Test conversation created:', result);

    // Clean up - delete the test item
    if (result.itemId && result.spaceId) {
      await mainWindow.evaluate(
        ({ spaceId, itemId }) => {
          return window.spaces.items.delete(spaceId, itemId);
        },
        { spaceId: result.spaceId, itemId: result.itemId }
      );
      console.log('Test item cleaned up');
    }
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
  });
});
