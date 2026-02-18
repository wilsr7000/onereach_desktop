const { ipcMain } = require('electron');
const ai = require('./lib/ai-service');
const { getSettingsManager } = require('./settings-manager');

class ModuleAPIBridge {
  constructor() {
    this.settingsManager = getSettingsManager();
    this.setupIpcHandlers();
  }

  setupIpcHandlers() {
    // Claude API handlers
    ipcMain.handle('module:claude:generateMetadata', async (event, content, contentType, customPrompt, imageData) => {
      const apiKey = this.getClaudeApiKey();
      if (!apiKey) {
        throw new Error('Claude API key not configured. Please configure it in the main app settings.');
      }
      return this.claudeAPI.generateMetadata(content, contentType, apiKey, customPrompt, imageData);
    });

    ipcMain.handle('module:claude:analyze', async (event, prompt, options) => {
      return this.claudeAPI.analyze(prompt, options);
    });

    ipcMain.handle('module:claude:testConnection', async (_event) => {
      const apiKey = this.getClaudeApiKey();
      if (!apiKey) {
        return false;
      }
      return this.claudeAPI.testConnection(apiKey);
    });

    // Generic Claude API request handler
    ipcMain.handle('module:claude:request', async (event, messages, options = {}) => {
      const { maxTokens = 1000, temperature = 0.7, system = null, profile = 'standard' } = options;

      const result = await ai.chat({
        profile,
        messages,
        maxTokens,
        temperature,
        system,
        feature: 'api-bridge',
      });

      return result;
    });

    // Settings access (read-only for security)
    ipcMain.handle('module:settings:get', async (event, key) => {
      // Don't allow direct access to API keys
      if (key && (key.includes('apiKey') || key.includes('secret'))) {
        throw new Error('Direct access to API keys is not allowed');
      }
      return this.settingsManager.get(key);
    });

    ipcMain.handle('module:settings:hasApiKey', async (event, provider) => {
      const key = this.getApiKeyForProvider(provider);
      return !!key;
    });

    // App info
    ipcMain.handle('module:app:getVersion', async () => {
      return require('electron').app.getVersion();
    });

    ipcMain.handle('module:app:getName', async () => {
      return require('electron').app.getName();
    });

    ipcMain.handle('module:app:getPath', async (event, name) => {
      // Only allow safe paths
      const allowedPaths = ['userData', 'temp', 'downloads', 'documents'];
      if (!allowedPaths.includes(name)) {
        throw new Error(`Access to path '${name}' is not allowed`);
      }
      return require('electron').app.getPath(name);
    });
  }

  getClaudeApiKey() {
    // Check for new llmConfig structure first
    const llmConfig = this.settingsManager.get('llmConfig');
    if (llmConfig && llmConfig.anthropic && llmConfig.anthropic.apiKey) {
      return llmConfig.anthropic.apiKey;
    }

    // Fallback to legacy structure
    return this.settingsManager.get('llmApiKey') || '';
  }

  getApiKeyForProvider(provider) {
    const llmConfig = this.settingsManager.get('llmConfig');
    if (llmConfig && llmConfig[provider] && llmConfig[provider].apiKey) {
      return llmConfig[provider].apiKey;
    }

    // Legacy fallback
    if (provider === 'anthropic') {
      return this.settingsManager.get('llmApiKey') || '';
    }

    return '';
  }
}

// Create singleton instance
let moduleAPIBridge;

function getModuleAPIBridge() {
  if (!moduleAPIBridge) {
    moduleAPIBridge = new ModuleAPIBridge();
  }
  return moduleAPIBridge;
}

module.exports = {
  getModuleAPIBridge,
  ModuleAPIBridge,
};
