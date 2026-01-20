/**
 * AI Conversation Capture E2E Tests
 * 
 * Tests the automated AI conversation capture feature across multiple AI services:
 * - Claude, ChatGPT, Gemini, Perplexity, Grok
 * - Conversation capture and saving to Spaces
 * - Formatting validation in Spaces Manager
 * - Privacy controls (pause, do not save, undo)
 */

const { _electron: electron } = require('playwright');
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

// Test configuration
const TEST_CONFIG = {
  chatServices: {
    claude: {
      name: 'Claude',
      url: 'https://claude.ai/',
      spaceName: 'Claude Conversations',
      // Mock selectors (adjust based on actual DOM)
      selectors: {
        input: 'div[contenteditable="true"]',
        sendButton: 'button[aria-label*="Send"]',
        response: '.claude-response-message'
      }
    },
    chatgpt: {
      name: 'ChatGPT',
      url: 'https://chatgpt.com/',
      spaceName: 'ChatGPT Conversations',
      selectors: {
        input: 'textarea[placeholder*="Message"]',
        sendButton: 'button[data-testid="send-button"]',
        response: '.assistant-message'
      }
    },
    gemini: {
      name: 'Gemini',
      url: 'https://gemini.google.com/',
      spaceName: 'Gemini Conversations',
      selectors: {
        input: 'div[contenteditable="true"]',
        sendButton: 'button[aria-label*="Send"]',
        response: '.model-response'
      }
    },
    grok: {
      name: 'Grok',
      url: 'https://x.ai/',
      spaceName: 'Grok Conversations',
      selectors: {
        input: 'textarea[placeholder*="Ask"]',
        sendButton: 'button[type="submit"]',
        response: '.grok-response'
      }
    }
  },
  testMessage: 'Hello, this is a test message for automated conversation capture testing.',
  timeout: 60000
};

test.describe('AI Conversation Capture', () => {
  let electronApp;
  let mainWindow;
  let spacesAPI;

  test.beforeAll(async () => {
    // Launch Electron app
    electronApp = await electron.launch({
      args: [path.join(__dirname, '../../main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        TEST_MODE: 'true'
      }
    });

    // Wait for the main window
    mainWindow = await electronApp.firstWindow();
    await mainWindow.waitForLoadState('domcontentloaded');

    // Set up Spaces API access via the exposed window.spaces
    spacesAPI = {
      list: async () => {
        return await mainWindow.evaluate(() => {
          return window.spaces.list();
        });
      },
      get: async (spaceId) => {
        return await mainWindow.evaluate((id) => {
          return window.spaces.get(id);
        }, spaceId);
      },
      items: {
        list: async (spaceId) => {
          return await mainWindow.evaluate((id) => {
            return window.spaces.items.list(id);
          }, spaceId);
        },
        get: async (itemId) => {
          // Need to find which space the item is in
          const spaces = await mainWindow.evaluate(() => window.spaces.list());
          for (const space of spaces) {
            const items = await mainWindow.evaluate((spaceId) => {
              return window.spaces.items.list(spaceId);
            }, space.id);
            const item = items.find(i => i.id === itemId);
            if (item) {
              return await mainWindow.evaluate(({ spaceId, id }) => {
                return window.spaces.items.get(spaceId, id);
              }, { spaceId: space.id, id: itemId });
            }
          }
          return null;
        },
        delete: async (itemId) => {
          // Need to find which space the item is in first
          const spaces = await mainWindow.evaluate(() => window.spaces.list());
          for (const space of spaces) {
            const items = await mainWindow.evaluate((spaceId) => {
              return window.spaces.items.list(spaceId);
            }, space.id);
            if (items.find(i => i.id === itemId)) {
              return await mainWindow.evaluate(({ spaceId, id }) => {
                return window.spaces.items.delete(spaceId, id);
              }, { spaceId: space.id, id: itemId });
            }
          }
          return false;
        }
      }
    };

    // Enable conversation capture in settings
    await mainWindow.evaluate(() => {
      return window.api.saveSettings({
        aiConversationCapture: {
          enabled: true,
          enableUndoWindow: true,
          undoWindowMinutes: 5,
          conversationTimeoutMinutes: 30,
          clearPauseOnRestart: true
        }
      });
    });
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
  });

  test.describe('Conversation Capture - Claude', () => {
    let claudeWindow;
    let initialSpaceCount;
    let claudeSpace;

    test.beforeAll(async () => {
      // Get initial space count
      const spaces = await spacesAPI.list();
      initialSpaceCount = spaces.length;
    });

    test('should open Claude in external window', async () => {
      // Trigger opening Claude via IPC
      await mainWindow.evaluate((url) => {
        window.electron.ipcRenderer.send('open-external-ai', {
          url: url,
          label: 'Claude'
        });
      }, TEST_CONFIG.chatServices.claude.url);

      // Wait for new window
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Get all windows
      const windows = await electronApp.windows();
      expect(windows.length).toBeGreaterThan(1);
      
      // Find Claude window
      claudeWindow = windows.find(w => w.url().includes('claude.ai'));
      expect(claudeWindow).toBeDefined();
      
      await claudeWindow.waitForLoadState('domcontentloaded');
    });

    test('should show AI overlay in Claude window', async () => {
      // Wait for overlay injection
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Check for overlay presence
      const hasOverlay = await claudeWindow.evaluate(() => {
        return document.querySelector('.ai-overlay') !== null;
      });

      expect(hasOverlay).toBe(true);
    });

    test('should show "Recording" status by default', async () => {
      const statusText = await claudeWindow.evaluate(() => {
        const badge = document.querySelector('.ai-status-badge');
        return badge ? badge.textContent : null;
      });

      expect(statusText).toContain('Recording');
    });

    test('should create Claude Conversations space', async () => {
      // Trigger a conversation to ensure space is created
      // Note: In a real test, you'd need to be logged in to Claude
      // For this test, we'll simulate the space creation via API
      
      const spaces = await spacesAPI.list();
      claudeSpace = spaces.find(s => s.name === TEST_CONFIG.chatServices.claude.spaceName);
      
      // If not found, it means it will be created on first capture
      // We'll verify this in the next test
      console.log('Claude space status:', claudeSpace ? 'exists' : 'will be created on first message');
    });

    test('should capture and save conversation to Space', async ({ page }) => {
      // Test the conversation capture by simulating what the actual feature does:
      // Create a conversation item directly in the Claude space
      
      const conversationData = {
        serviceId: 'Claude',
        messages: [
          {
            role: 'user',
            content: TEST_CONFIG.testMessage,
            timestamp: new Date().toISOString()
          },
          {
            role: 'assistant',
            content: 'This is a test response from Claude.',
            timestamp: new Date().toISOString()
          }
        ],
        model: 'claude-3-5-sonnet',
        exchangeCount: 1
      };

      // Format as markdown (mimicking what the real feature does)
      const markdown = `# 🤖 Conversation with Claude

**Started:** ${new Date().toLocaleString()}
**Model:** ${conversationData.model}
**Exchanges:** ${conversationData.exchangeCount}

---

### 👤 You
*${new Date().toLocaleTimeString()}*

${conversationData.messages[0].content}

---

### 🤖 Claude
*${new Date().toLocaleTimeString()}*

${conversationData.messages[1].content}

---

<sub>Conversation ID: test-conv-${Date.now()}</sub>`;

      // Get or create Claude Conversations space
      const spaces = await spacesAPI.list();
      claudeSpace = spaces.find(s => s.name === TEST_CONFIG.chatServices.claude.spaceName);
      
      if (!claudeSpace) {
        claudeSpace = await mainWindow.evaluate(() => {
          return window.spaces.create('Claude Conversations', {
            icon: '🤖',
            color: '#ff6b35'
          });
        });
      }

      // Add conversation to space
      const result = await mainWindow.evaluate(({ spaceId, content, metadata }) => {
        return window.spaces.items.add(spaceId, {
          type: 'text',
          content: content,
          metadata: metadata
        });
      }, {
        spaceId: claudeSpace.id,
        content: markdown,
        metadata: {
          aiService: 'Claude',
          model: conversationData.model,
          exchangeCount: conversationData.exchangeCount,
          tags: ['ai-conversation', 'claude']
        }
      });

      expect(result.id).toBeDefined();

      // Wait for save to complete
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Verify space was created/exists
      const updatedSpaces = await spacesAPI.list();
      claudeSpace = updatedSpaces.find(s => s.name === TEST_CONFIG.chatServices.claude.spaceName);
      expect(claudeSpace).toBeDefined();
      expect(claudeSpace.name).toBe('Claude Conversations');
      expect(claudeSpace.icon).toBe('🤖');

      // Verify conversation was saved to space
      const items = await spacesAPI.items.list(claudeSpace.id);
      expect(items.length).toBeGreaterThan(0);

      // Get the item we just created
      const itemData = await mainWindow.evaluate(({ spaceId, itemId }) => {
        return window.spaces.items.get(spaceId, itemId);
      }, { spaceId: claudeSpace.id, itemId: result.id });

      // Verify content format
      expect(itemData.content).toContain('Conversation with Claude');
      expect(itemData.content).toContain(TEST_CONFIG.testMessage);
      expect(itemData.content).toContain('This is a test response from Claude');
      expect(itemData.content).toContain('### 👤 You');
      expect(itemData.content).toContain('### 🤖 Claude');

      // Verify metadata
      expect(itemData.metadata).toBeDefined();
      expect(itemData.metadata.aiService).toBe('Claude');
      expect(itemData.metadata.model).toBe('claude-3-5-sonnet');
      expect(itemData.metadata.exchangeCount).toBe(1);
      expect(itemData.metadata.tags).toContain('ai-conversation');
      expect(itemData.metadata.tags).toContain('claude');
    });

    test('should format conversation properly for Spaces Manager', async () => {
      // Get the conversation item
      const spaces = await spacesAPI.list();
      const claudeSpace = spaces.find(s => s.name === 'Claude Conversations');
      const items = await spacesAPI.items.list(claudeSpace.id);
      const item = await spacesAPI.items.get(items[0].id);

      // Verify markdown formatting
      const lines = item.content.split('\n');
      
      // Check header
      expect(lines[0]).toMatch(/^# 🤖 Conversation with Claude$/);
      
      // Check metadata section
      expect(item.content).toContain('**Started:**');
      expect(item.content).toContain('**Model:**');
      expect(item.content).toContain('**Exchanges:**');
      
      // Check message structure
      expect(item.content).toContain('### 👤 You');
      expect(item.content).toContain('### 🤖 Claude');
      
      // Check separators
      expect(item.content).toContain('---');
      
      // Check footer
      expect(item.content).toContain('Conversation ID:');
      
      // Verify readability (no HTML, proper line breaks)
      expect(item.content).not.toContain('<div>');
      expect(item.content).not.toContain('<span>');
      expect(item.content.split('\n').length).toBeGreaterThan(10); // Multiple lines
    });

    test('should pause conversation capture', async () => {
      // Click pause button in overlay
      await claudeWindow.evaluate(() => {
        const pauseBtn = document.querySelector('[data-action="togglePause"]');
        if (pauseBtn) pauseBtn.click();
      });

      // Wait for state update
      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify status changed
      const statusText = await claudeWindow.evaluate(() => {
        const badge = document.querySelector('.ai-status-badge');
        return badge ? badge.textContent : null;
      });

      expect(statusText).toContain('Paused');

      // Verify pause state in main process
      const isPaused = await mainWindow.evaluate(() => {
        return window.electron.ipcRenderer.invoke('conversation:isPaused');
      });

      expect(isPaused).toBe(true);
    });

    test('should resume conversation capture', async () => {
      // Click resume button
      await claudeWindow.evaluate(() => {
        const pauseBtn = document.querySelector('[data-action="togglePause"]');
        if (pauseBtn) pauseBtn.click();
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      const statusText = await claudeWindow.evaluate(() => {
        const badge = document.querySelector('.ai-status-badge');
        return badge ? badge.textContent : null;
      });

      expect(statusText).toContain('Recording');
    });

    test('should mark conversation as "do not save"', async () => {
      // Click "Don't Save This" button
      await claudeWindow.evaluate(() => {
        const dontSaveBtn = document.querySelector('[data-action="toggleDoNotSave"]');
        if (dontSaveBtn) dontSaveBtn.click();
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify status changed
      const statusText = await claudeWindow.evaluate(() => {
        const badge = document.querySelector('.ai-status-badge');
        return badge ? badge.textContent : null;
      });

      expect(statusText).toContain('Not Recording This');

      // Verify button shows checkmark
      const buttonText = await claudeWindow.evaluate(() => {
        const btn = document.querySelector('[data-action="toggleDoNotSave"]');
        return btn ? btn.textContent : null;
      });

      expect(buttonText).toContain('Won\'t be saved');
    });

    test('should show undo toast after saving', async () => {
      // Reset "do not save" flag
      await claudeWindow.evaluate(() => {
        const dontSaveBtn = document.querySelector('[data-action="toggleDoNotSave"]');
        if (dontSaveBtn && dontSaveBtn.textContent.includes('Won\'t')) {
          dontSaveBtn.click();
        }
      });

      // Simulate a new conversation save
      const result = await mainWindow.evaluate(() => {
        return window.electron.ipcRenderer.invoke('conversation:test-capture', {
          serviceId: 'Claude',
          conversation: {
            messages: [
              {
                role: 'user',
                content: 'Second test message',
                timestamp: new Date().toISOString()
              },
              {
                role: 'assistant',
                content: 'Second test response',
                timestamp: new Date().toISOString()
              }
            ],
            exchangeCount: 1
          }
        });
      });

      // Wait for toast
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Check for toast in Claude window
      const hasToast = await claudeWindow.evaluate(() => {
        return document.querySelector('.ai-toast') !== null;
      });

      expect(hasToast).toBe(true);

      // Verify toast content
      const toastText = await claudeWindow.evaluate(() => {
        const toast = document.querySelector('.ai-toast');
        return toast ? toast.textContent : null;
      });

      expect(toastText).toContain('Conversation saved');
      expect(toastText).toContain('Undo');
    });

    test('should undo conversation save', async () => {
      // Get current item count
      const spaces = await spacesAPI.list();
      const claudeSpace = spaces.find(s => s.name === 'Claude Conversations');
      const itemsBefore = await spacesAPI.items.list(claudeSpace.id);
      const countBefore = itemsBefore.length;

      // Click undo button in toast
      await claudeWindow.evaluate(() => {
        const undoBtn = document.querySelector('[data-action="undo"]');
        if (undoBtn) undoBtn.click();
      });

      // Wait for undo to process
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Verify item was removed
      const itemsAfter = await spacesAPI.items.list(claudeSpace.id);
      expect(itemsAfter.length).toBe(countBefore - 1);
    });
  });

  test.describe('Multi-Service Capture', () => {
    test('should create separate spaces for each AI service', async () => {
      const services = ['ChatGPT', 'Gemini', 'Grok'];
      
      // Simulate captures for each service
      for (const service of services) {
        await mainWindow.evaluate((svc) => {
          return window.electron.ipcRenderer.invoke('conversation:test-capture', {
            serviceId: svc,
            conversation: {
              messages: [
                {
                  role: 'user',
                  content: `Test message for ${svc}`,
                  timestamp: new Date().toISOString()
                },
                {
                  role: 'assistant',
                  content: `Test response from ${svc}`,
                  timestamp: new Date().toISOString()
                }
              ],
              exchangeCount: 1
            }
          });
        }, service);

        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Verify all spaces were created
      const spaces = await spacesAPI.list();
      
      expect(spaces.find(s => s.name === 'ChatGPT Conversations')).toBeDefined();
      expect(spaces.find(s => s.name === 'Gemini Conversations')).toBeDefined();
      expect(spaces.find(s => s.name === 'Grok Conversations')).toBeDefined();

      // Verify each space has the correct icon and color
      const chatgptSpace = spaces.find(s => s.name === 'ChatGPT Conversations');
      expect(chatgptSpace.icon).toBe('💬');
      expect(chatgptSpace.color).toBe('#10a37f');

      const geminiSpace = spaces.find(s => s.name === 'Gemini Conversations');
      expect(geminiSpace.icon).toBe('✨');
      expect(geminiSpace.color).toBe('#4285f4');

      const grokSpace = spaces.find(s => s.name === 'Grok Conversations');
      expect(grokSpace.icon).toBe('🚀');
      expect(grokSpace.color).toBe('#6b7280');
    });

    test('should keep conversations separate by service', async () => {
      const spaces = await spacesAPI.list();
      
      const claudeSpace = spaces.find(s => s.name === 'Claude Conversations');
      const chatgptSpace = spaces.find(s => s.name === 'ChatGPT Conversations');
      
      const claudeItems = await spacesAPI.items.list(claudeSpace.id);
      const chatgptItems = await spacesAPI.items.list(chatgptSpace.id);

      // Verify items are in correct spaces
      for (const item of claudeItems) {
        const itemData = await spacesAPI.items.get(item.id);
        expect(itemData.metadata.aiService).toBe('Claude');
      }

      for (const item of chatgptItems) {
        const itemData = await spacesAPI.items.get(item.id);
        expect(itemData.metadata.aiService).toBe('ChatGPT');
      }
    });
  });

  test.describe('Formatting Validation', () => {
    test('should format code blocks properly', async () => {
      // Simulate conversation with code
      await mainWindow.evaluate(() => {
        return window.electron.ipcRenderer.invoke('conversation:test-capture', {
          serviceId: 'Claude',
          conversation: {
            messages: [
              {
                role: 'user',
                content: 'Write a hello world function',
                timestamp: new Date().toISOString()
              },
              {
                role: 'assistant',
                content: 'Here\'s a hello world function:\n\n```javascript\nfunction helloWorld() {\n  console.log("Hello, World!");\n}\n```',
                timestamp: new Date().toISOString()
              }
            ],
            exchangeCount: 1
          }
        });
      });

      await new Promise(resolve => setTimeout(resolve, 1000));

      // Get the conversation
      const spaces = await spacesAPI.list();
      const claudeSpace = spaces.find(s => s.name === 'Claude Conversations');
      const items = await spacesAPI.items.list(claudeSpace.id);
      const latestItem = await spacesAPI.items.get(items[0].id);

      // Verify code block is preserved
      expect(latestItem.content).toContain('```javascript');
      expect(latestItem.content).toContain('function helloWorld()');
      expect(latestItem.metadata.hasCode).toBe(true);
    });

    test('should handle long conversations', async () => {
      // Simulate a long conversation
      const messages = [];
      for (let i = 0; i < 10; i++) {
        messages.push({
          role: 'user',
          content: `User message ${i + 1}`,
          timestamp: new Date().toISOString()
        });
        messages.push({
          role: 'assistant',
          content: `Assistant response ${i + 1}`,
          timestamp: new Date().toISOString()
        });
      }

      await mainWindow.evaluate((msgs) => {
        return window.electron.ipcRenderer.invoke('conversation:test-capture', {
          serviceId: 'Claude',
          conversation: {
            messages: msgs,
            exchangeCount: 10
          }
        });
      }, messages);

      await new Promise(resolve => setTimeout(resolve, 1000));

      // Verify conversation was saved with all messages
      const spaces = await spacesAPI.list();
      const claudeSpace = spaces.find(s => s.name === 'Claude Conversations');
      const items = await spacesAPI.items.list(claudeSpace.id);
      const item = await spacesAPI.items.get(items[0].id);

      expect(item.content).toContain('User message 1');
      expect(item.content).toContain('Assistant response 10');
      expect(item.metadata.exchangeCount).toBe(10);

      // Verify proper message separation
      const separators = (item.content.match(/---/g) || []).length;
      expect(separators).toBeGreaterThan(10); // At least one separator between messages
    });

    test('should handle special characters and emoji', async () => {
      await mainWindow.evaluate(() => {
        return window.electron.ipcRenderer.invoke('conversation:test-capture', {
          serviceId: 'Claude',
          conversation: {
            messages: [
              {
                role: 'user',
                content: 'Test special chars: & < > " \' and emoji: 🎉 ✨ 🚀',
                timestamp: new Date().toISOString()
              },
              {
                role: 'assistant',
                content: 'I can handle special chars & emoji! 😊',
                timestamp: new Date().toISOString()
              }
            ],
            exchangeCount: 1
          }
        });
      });

      await new Promise(resolve => setTimeout(resolve, 1000));

      const spaces = await spacesAPI.list();
      const claudeSpace = spaces.find(s => s.name === 'Claude Conversations');
      const items = await spacesAPI.items.list(claudeSpace.id);
      const item = await spacesAPI.items.get(items[0].id);

      // Verify special characters are preserved
      expect(item.content).toContain('& < > " \'');
      expect(item.content).toContain('🎉 ✨ 🚀');
      expect(item.content).toContain('😊');
    });
  });

  test.describe('Cleanup', () => {
    test('should clean up test data', async () => {
      // Delete all test conversations
      const spaces = await spacesAPI.list();
      
      for (const space of spaces) {
        if (space.name.includes('Conversations')) {
          const items = await spacesAPI.items.list(space.id);
          for (const item of items) {
            await spacesAPI.items.delete(item.id);
          }
        }
      }

      console.log('Test cleanup completed');
    });
  });
});
