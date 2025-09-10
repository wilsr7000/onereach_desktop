const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

class SettingsManager {
  constructor() {
    this.settingsPath = path.join(app.getPath('userData'), 'app-settings.json');
    this.encryptedSettingsPath = path.join(app.getPath('userData'), 'app-settings-encrypted.json');
    this.settings = this.loadSettings();
  }

  loadSettings() {
    try {
      // Try to load encrypted settings first
      if (fs.existsSync(this.encryptedSettingsPath)) {
        const encryptedData = JSON.parse(fs.readFileSync(this.encryptedSettingsPath, 'utf8'));
        const settings = {};
        
        // Decrypt sensitive fields
        for (const [key, value] of Object.entries(encryptedData)) {
          if (key.includes('apiKey') || key.includes('secret')) {
            // Decrypt sensitive data
            if (safeStorage.isEncryptionAvailable() && value.encrypted) {
              try {
                const decrypted = safeStorage.decryptString(Buffer.from(value.data, 'base64'));
                settings[key] = decrypted;
              } catch (error) {
                console.error(`Error decrypting ${key}:`, error);
                settings[key] = '';
              }
            } else {
              settings[key] = value;
            }
          } else {
            settings[key] = value;
          }
        }
        
        return settings;
      } else if (fs.existsSync(this.settingsPath)) {
        // Fallback to plain settings file
        return JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
      }
    } catch (error) {
      console.error('Error loading settings:', error);
    }
    
    // Return default settings
    return {
      llmApiKey: '',
      llmProvider: 'anthropic',
      llmModel: 'claude-opus-4-20250514',
      theme: 'dark',
      autoSave: true,
      claude4ThinkingMode: 'enabled',
      claude4ThinkingLevel: 'default'
    };
  }

  saveSettings() {
    try {
      const dataToSave = {};
      
      // Encrypt sensitive fields
      for (const [key, value] of Object.entries(this.settings)) {
        if ((key.includes('apiKey') || key.includes('secret')) && value) {
          // Encrypt sensitive data
          if (safeStorage.isEncryptionAvailable()) {
            const encrypted = safeStorage.encryptString(value);
            dataToSave[key] = {
              encrypted: true,
              data: encrypted.toString('base64')
            };
          } else {
            // If encryption not available, store as plain text (not recommended)
            console.warn('Encryption not available, storing API key in plain text');
            dataToSave[key] = value;
          }
        } else {
          dataToSave[key] = value;
        }
      }
      
      // Save encrypted settings
      fs.writeFileSync(this.encryptedSettingsPath, JSON.stringify(dataToSave, null, 2));
      
      // Remove old plain settings file if it exists
      if (fs.existsSync(this.settingsPath)) {
        fs.unlinkSync(this.settingsPath);
      }
      
      return true;
    } catch (error) {
      console.error('Error saving settings:', error);
      return false;
    }
  }

  get(key) {
    return this.settings[key];
  }

  set(key, value) {
    this.settings[key] = value;
    return this.saveSettings();
  }

  getAll() {
    // Return a copy to prevent direct modification
    return { ...this.settings };
  }

  update(updates) {
    this.settings = { ...this.settings, ...updates };
    return this.saveSettings();
  }

  // LLM-specific methods
  getLLMApiKey() {
    return this.get('llmApiKey') || '';
  }

  setLLMApiKey(apiKey) {
    return this.set('llmApiKey', apiKey);
  }

  getLLMProvider() {
    return this.get('llmProvider') || 'openai';
  }

  setLLMProvider(provider) {
    return this.set('llmProvider', provider);
  }

  getLLMModel() {
    return this.get('llmModel') || 'claude-opus-4-20250514';
  }

  setLLMModel(model) {
    return this.set('llmModel', model);
  }

  // Claude 4 thinking mode methods
  getClaude4ThinkingMode() {
    return this.get('claude4ThinkingMode') || 'enabled';
  }

  setClaude4ThinkingMode(mode) {
    return this.set('claude4ThinkingMode', mode);
  }

  getClaude4ThinkingLevel() {
    return this.get('claude4ThinkingLevel') || 'default';
  }

  setClaude4ThinkingLevel(level) {
    return this.set('claude4ThinkingLevel', level);
  }

  // Get Claude 4 API headers for thinking mode
  getClaude4Headers() {
    const headers = {};
    
    if (this.getLLMModel() === 'claude-opus-4-20250514' && 
        this.getClaude4ThinkingMode() === 'enabled') {
      headers['interleaved-thinking-2025-05-14'] = 'true';
    }
    
    return headers;
  }
}

// Create singleton instance
let settingsManager;

function getSettingsManager() {
  if (!settingsManager) {
    settingsManager = new SettingsManager();
  }
  return settingsManager;
}

module.exports = {
  getSettingsManager,
  SettingsManager
}; 