const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

// Skip Keychain encryption in dev mode to avoid password prompts
// Use function to defer check until app is ready
function isDev() {
  try {
    return !app.isPackaged;
  } catch (e) {
    return true; // Assume dev mode if can't determine
  }
}

class SettingsManager {
  constructor() {
    // Lazy initialize paths - will be set on first access
    this._settingsPath = null;
    this._encryptedSettingsPath = null;
    this._settings = null;
  }

  get settingsPath() {
    if (!this._settingsPath) {
      this._settingsPath = path.join(app.getPath('userData'), 'app-settings.json');
    }
    return this._settingsPath;
  }

  get encryptedSettingsPath() {
    if (!this._encryptedSettingsPath) {
      this._encryptedSettingsPath = path.join(app.getPath('userData'), 'app-settings-encrypted.json');
    }
    return this._encryptedSettingsPath;
  }

  get settings() {
    if (!this._settings) {
      this._settings = this.loadSettings();
    }
    return this._settings;
  }

  set settings(value) {
    this._settings = value;
  }

  loadSettings() {
    try {
      // Try to load encrypted settings first
      if (fs.existsSync(this.encryptedSettingsPath)) {
        const encryptedData = JSON.parse(fs.readFileSync(this.encryptedSettingsPath, 'utf8'));
        const settings = {};
        
        // Decrypt sensitive fields
        for (const [key, value] of Object.entries(encryptedData)) {
          if (key.includes('apiKey') || key.includes('secret') || key.includes('Token')) {
            // Decrypt sensitive data
            // Try to decrypt if encryption is available (even in dev mode)
            if (safeStorage.isEncryptionAvailable() && value && value.encrypted) {
              try {
                const decrypted = safeStorage.decryptString(Buffer.from(value.data, 'base64'));
                settings[key] = decrypted;
                console.log(`[Settings] Successfully decrypted ${key} (${decrypted.length} chars)`);
              } catch (error) {
                console.error(`[Settings] Error decrypting ${key}:`, error);
                // Fallback: check if there's a plain value in the regular settings file
                try {
                  if (fs.existsSync(this.settingsPath)) {
                    const plainSettings = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
                    if (plainSettings[key]) {
                      settings[key] = plainSettings[key];
                      console.log(`[Settings] Using fallback plain value for ${key}`);
                    } else {
                      settings[key] = '';
                    }
                  } else {
                    settings[key] = '';
                  }
                } catch (e) {
                  settings[key] = '';
                }
              }
            } else if (value && value.encrypted) {
              // Encryption not available but value is encrypted - try plain fallback
              console.warn(`[Settings] Encryption not available for ${key}, trying fallback`);
              try {
                if (fs.existsSync(this.settingsPath)) {
                  const plainSettings = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
                  if (plainSettings[key]) {
                    settings[key] = plainSettings[key];
                    console.log(`[Settings] Using fallback plain value for ${key}`);
                  } else {
                    settings[key] = '';
                  }
                } else {
                  settings[key] = '';
                }
              } catch (e) {
                settings[key] = '';
              }
            } else {
              settings[key] = value || '';
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
      llmModel: 'claude-opus-4-5-20251101',
      theme: 'dark',
      autoSave: true,
      claude4ThinkingMode: 'enabled',
      claude4ThinkingLevel: 'default',
      autoAIMetadata: true, // Auto-generate AI metadata for all clipboard items
      autoAIMetadataTypes: ['all'], // Types to auto-generate metadata for (default: all)
      elevenLabsApiKey: '', // ElevenLabs API key for AI voice generation
      // Video release - YouTube integration
      youtubeClientId: '',
      youtubeClientSecret: '',
      // Video release - Vimeo integration
      vimeoClientId: '',
      vimeoClientSecret: '',
      gsxToken: '',
      gsxEnvironment: 'production',
      gsxAccountId: '',
      gsxAutoSync: false,
      gsxSyncInterval: 'daily',
      gsxSyncPaths: null,
      // Budget settings
      budgetEnabled: true, // Enable budget tracking and warnings
      budgetShowEstimates: true, // Show cost estimates before AI operations
      budgetConfirmThreshold: 0.05 // Ask confirmation for costs above this amount ($)
    };
  }

  saveSettings() {
    try {
      const dataToSave = {};
      
      // Encrypt sensitive fields (skip in dev mode to avoid Keychain prompts)
      for (const [key, value] of Object.entries(this.settings)) {
        if ((key.includes('apiKey') || key.includes('secret') || key.includes('Token')) && value && typeof value === 'string') {
          // Encrypt sensitive data (only in production)
          if (!isDev() && safeStorage.isEncryptionAvailable()) {
            const encrypted = safeStorage.encryptString(value);
            dataToSave[key] = {
              encrypted: true,
              data: encrypted.toString('base64')
            };
          } else {
            // In dev mode or if encryption not available, store as plain text
            if (isDev()) {
              console.log('[Settings] Dev mode: storing API key without encryption');
            } else {
              console.warn('Encryption not available, storing API key in plain text');
            }
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
    // If the setting exists, return it
    if (this.settings[key] !== undefined) {
      return this.settings[key];
    }
    
    // Otherwise, return the default value
    const defaults = {
      llmApiKey: '',
      llmProvider: 'anthropic',
      llmModel: 'claude-opus-4-5-20251101',
      theme: 'dark',
      autoSave: true,
      claude4ThinkingMode: 'enabled',
      claude4ThinkingLevel: 'default',
      autoAIMetadata: true,
      autoAIMetadataTypes: ['all'],
      gsxToken: '',
      gsxEnvironment: 'production',
      gsxAccountId: '',
      gsxAutoSync: false,
      gsxSyncInterval: 'daily',
      gsxSyncPaths: null,
      openaiApiKey: '',
      elevenLabsApiKey: '',
      // Budget settings
      budgetEnabled: true,
      budgetShowEstimates: true,
      budgetConfirmThreshold: 0.05
    };
    
    return defaults[key];
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
    return this.get('llmModel') || 'claude-opus-4-5-20251101';
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
    
    if (this.getLLMModel() === 'claude-opus-4-5-20251101' && 
        this.getClaude4ThinkingMode() === 'enabled') {
      headers['interleaved-thinking-2025-05-14'] = 'true';
    }
    
    return headers;
  }
  
  // GSX-specific methods
  getGSXToken() {
    return this.get('gsxToken') || '';
  }
  
  setGSXToken(token) {
    return this.set('gsxToken', token);
  }
  
  getGSXEnvironment() {
    return this.get('gsxEnvironment') || 'production';
  }
  
  setGSXEnvironment(env) {
    return this.set('gsxEnvironment', env);
  }
  
  getGSXAutoSync() {
    return this.get('gsxAutoSync') || false;
  }
  
  setGSXAutoSync(enabled) {
    return this.set('gsxAutoSync', enabled);
  }
  
  getGSXSyncInterval() {
    return this.get('gsxSyncInterval') || 'daily';
  }
  
  setGSXSyncInterval(interval) {
    return this.set('gsxSyncInterval', interval);
  }

  // Budget settings methods
  isBudgetEnabled() {
    return this.get('budgetEnabled') !== false;
  }
  
  setBudgetEnabled(enabled) {
    return this.set('budgetEnabled', enabled);
  }
  
  shouldShowBudgetEstimates() {
    return this.get('budgetShowEstimates') !== false;
  }
  
  setShowBudgetEstimates(show) {
    return this.set('budgetShowEstimates', show);
  }
  
  getBudgetConfirmThreshold() {
    return this.get('budgetConfirmThreshold') || 0.05;
  }
  
  setBudgetConfirmThreshold(threshold) {
    return this.set('budgetConfirmThreshold', threshold);
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