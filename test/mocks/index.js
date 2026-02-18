/**
 * Mock Registry
 * Part of the Governed Self-Improving Agent Runtime Testing Infrastructure
 *
 * Pre-built mocks for fs, electron, clipboard, fetch, LLM clients
 */

export * from './electron.js';
export * from './llm-clients.js';
export * from './filesystem.js';

// Re-export defaults
import electron from './electron.js';
import llmClients from './llm-clients.js';
import filesystem from './filesystem.js';

export default {
  electron,
  llmClients,
  fs: filesystem,

  // Quick access to commonly used mocks
  app: electron.app,
  ipcMain: electron.ipcMain,
  ipcRenderer: electron.ipcRenderer,
  BrowserWindow: electron.BrowserWindow,
  clipboard: electron.clipboard,

  mockClaudeClient: llmClients.mockClaudeClient,
  mockOpenAIClient: llmClients.mockOpenAIClient,
  mockAiderBridge: llmClients.mockAiderBridge,
};
