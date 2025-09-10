// Module API Client - Client-side helper for modules to access app services
// This file should be included in modules that need to access Claude API or other services

const { ipcRenderer } = require('electron');

class ModuleAPIClient {
  constructor() {
    this.claude = {
      /**
       * Generate metadata for content using Claude
       * @param {string} content - The content to analyze
       * @param {string} contentType - Type of content (text, code, html, image, etc.)
       * @param {string} customPrompt - Optional custom prompt
       * @param {string} imageData - Optional base64 image data for vision analysis
       * @returns {Promise<Object>} Generated metadata
       */
      generateMetadata: async (content, contentType, customPrompt = '', imageData = null) => {
        return ipcRenderer.invoke('module:claude:generateMetadata', content, contentType, customPrompt, imageData);
      },

      /**
       * Analyze content with Claude
       * @param {string} prompt - The analysis prompt
       * @param {Object} options - Options including maxTokens and temperature
       * @returns {Promise<Object>} Analysis results
       */
      analyze: async (prompt, options = {}) => {
        return ipcRenderer.invoke('module:claude:analyze', prompt, options);
      },

      /**
       * Test Claude API connection
       * @returns {Promise<boolean>} True if connection successful
       */
      testConnection: async () => {
        return ipcRenderer.invoke('module:claude:testConnection');
      },

      /**
       * Make a generic Claude API request
       * @param {Array} messages - Array of message objects with role and content
       * @param {Object} options - Request options (model, maxTokens, temperature, system)
       * @returns {Promise<Object>} Claude API response
       */
      request: async (messages, options = {}) => {
        return ipcRenderer.invoke('module:claude:request', messages, options);
      },

      /**
       * Simple text completion helper
       * @param {string} prompt - The prompt text
       * @param {Object} options - Request options
       * @returns {Promise<string>} The completion text
       */
      complete: async (prompt, options = {}) => {
        const response = await ipcRenderer.invoke('module:claude:request', [
          { role: 'user', content: prompt }
        ], options);
        
        if (response.content && response.content.length > 0) {
          return response.content[0].text;
        }
        throw new Error('No content in response');
      },

      /**
       * Chat conversation helper
       * @param {Array} messages - Conversation history
       * @param {Object} options - Request options
       * @returns {Promise<string>} The assistant's response
       */
      chat: async (messages, options = {}) => {
        const response = await ipcRenderer.invoke('module:claude:request', messages, options);
        
        if (response.content && response.content.length > 0) {
          return response.content[0].text;
        }
        throw new Error('No content in response');
      }
    };

    this.settings = {
      /**
       * Get a setting value (API keys are not accessible)
       * @param {string} key - Setting key
       * @returns {Promise<any>} Setting value
       */
      get: async (key) => {
        return ipcRenderer.invoke('module:settings:get', key);
      },

      /**
       * Check if an API key is configured for a provider
       * @param {string} provider - Provider name (e.g., 'anthropic')
       * @returns {Promise<boolean>} True if API key is configured
       */
      hasApiKey: async (provider) => {
        return ipcRenderer.invoke('module:settings:hasApiKey', provider);
      }
    };

    this.app = {
      /**
       * Get app version
       * @returns {Promise<string>} App version
       */
      getVersion: async () => {
        return ipcRenderer.invoke('module:app:getVersion');
      },

      /**
       * Get app name
       * @returns {Promise<string>} App name
       */
      getName: async () => {
        return ipcRenderer.invoke('module:app:getName');
      },

      /**
       * Get app path (only safe paths allowed)
       * @param {string} name - Path name (userData, temp, downloads, documents)
       * @returns {Promise<string>} Path
       */
      getPath: async (name) => {
        return ipcRenderer.invoke('module:app:getPath', name);
      }
    };
  }

  /**
   * Helper to ensure API is available
   * @returns {Promise<boolean>} True if Claude API is configured
   */
  async isClaudeAvailable() {
    try {
      return await this.settings.hasApiKey('anthropic');
    } catch (error) {
      console.error('Error checking Claude availability:', error);
      return false;
    }
  }

  /**
   * Helper to show error if API not configured
   */
  async requireClaude() {
    const available = await this.isClaudeAvailable();
    if (!available) {
      throw new Error('Claude API is not configured. Please configure it in the main application settings.');
    }
    return true;
  }
}

// Export singleton instance
const moduleAPI = new ModuleAPIClient();

// Also export for use in module windows
if (typeof window !== 'undefined') {
  window.moduleAPI = moduleAPI;
}

module.exports = moduleAPI; 