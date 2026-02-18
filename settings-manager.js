const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { getLogQueue } = require('./lib/log-event-queue');
const log = getLogQueue();

// Skip Keychain encryption in dev mode to avoid password prompts
// Use function to defer check until app is ready
function isDev() {
  try {
    return !app.isPackaged;
  } catch (_e) {
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
        let encryptedData;
        try {
          encryptedData = JSON.parse(fs.readFileSync(this.encryptedSettingsPath, 'utf8'));
        } catch (_parseError) {
          log.error('settings', 'Settings file corrupted, trying backup...');
          // Try to restore from backup
          const backupPath = this.encryptedSettingsPath + '.backup';
          if (fs.existsSync(backupPath)) {
            try {
              encryptedData = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
              // Restore the backup
              fs.copyFileSync(backupPath, this.encryptedSettingsPath);
              log.info('settings', 'Restored settings from backup');
            } catch (backupError) {
              log.error('settings', 'Backup also corrupted', { error: backupError.message });
              return {};
            }
          } else {
            log.error('settings', 'No backup available');
            return {};
          }
        }
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
                log.info('settings', 'Successfully decrypted ... (... chars)', {
                  key,
                  decryptedCount: decrypted.length,
                });
              } catch (_error) {
                log.error('settings', 'Error decrypting ...', { key });
                // Fallback: check if there's a plain value in the regular settings file
                try {
                  if (fs.existsSync(this.settingsPath)) {
                    const plainSettings = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
                    if (plainSettings[key]) {
                      settings[key] = plainSettings[key];
                      log.info('settings', 'Using fallback plain value for ...', { key });
                    } else {
                      settings[key] = '';
                    }
                  } else {
                    settings[key] = '';
                  }
                } catch (_e) {
                  settings[key] = '';
                }
              }
            } else if (value && value.encrypted) {
              // Encryption not available but value is encrypted - try plain fallback
              log.warn('settings', 'Encryption not available for ..., trying fallback', { key });
              try {
                if (fs.existsSync(this.settingsPath)) {
                  const plainSettings = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
                  if (plainSettings[key]) {
                    settings[key] = plainSettings[key];
                    log.info('settings', 'Using fallback plain value for ...', { key });
                  } else {
                    settings[key] = '';
                  }
                } else {
                  settings[key] = '';
                }
              } catch (_e) {
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
      log.error('settings', 'Error loading settings', { error: error.message || error });
    }

    // Return default settings
    return {
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
      gsxRefreshUrl: '', // URL to call to get/refresh GSX token automatically
      gsxEnvironment: 'edison',
      gsxAccountId: '',
      gsxAutoSync: false,
      gsxSyncInterval: 'daily',
      gsxSyncPaths: null,
      // Budget settings
      budgetEnabled: true, // Enable budget tracking and warnings
      budgetShowEstimates: true, // Show cost estimates before AI operations
      budgetConfirmThreshold: 0.05, // Ask confirmation for costs above this amount ($)
      // Spaces upload integration
      spacesUploadIntegration: true, // Show "Choose from Spaces" option in file pickers
      // AI Conversation Capture settings
      aiConversationCapture: {
        enabled: true,
        captureImages: true,
        captureFiles: true,
        captureCode: true,
        autoCreateSpaces: true,
        conversationTimeoutMinutes: 30,
        showRecordingIndicator: true,
        enableUndoWindow: true,
        undoWindowMinutes: 5,
        clearPauseOnRestart: true,
        privateModeByDefault: false,
      },
      // Unified Claude Service settings (headless-first, API-fallback)
      claudePreferHeadless: true, // Try headless Claude first (uses web login, free)
      claudeHeadlessTimeout: 60000, // Timeout for headless method (60s default)
      claudeApiFallback: true, // Fall back to API if headless fails
    };
  }

  saveSettings() {
    try {
      const dataToSave = {};

      // Encrypt sensitive fields (skip in dev mode to avoid Keychain prompts)
      for (const [key, value] of Object.entries(this.settings)) {
        if (
          (key.includes('apiKey') || key.includes('secret') || key.includes('Token')) &&
          value &&
          typeof value === 'string'
        ) {
          // Encrypt sensitive data (only in production)
          if (!isDev() && safeStorage.isEncryptionAvailable()) {
            const encrypted = safeStorage.encryptString(value);
            dataToSave[key] = {
              encrypted: true,
              data: encrypted.toString('base64'),
            };
          } else {
            // In dev mode or if encryption not available, store as plain text
            if (isDev()) {
              log.info('settings', 'Dev mode: storing API key without encryption');
            } else {
              log.warn('settings', 'Encryption not available, storing API key in plain text');
            }
            dataToSave[key] = value;
          }
        } else {
          dataToSave[key] = value;
        }
      }

      // Create backup before saving (in case of corruption)
      const backupPath = this.encryptedSettingsPath + '.backup';
      if (fs.existsSync(this.encryptedSettingsPath)) {
        try {
          fs.copyFileSync(this.encryptedSettingsPath, backupPath);
        } catch (backupError) {
          log.warn('settings', 'Could not create backup', { error: backupError.message });
        }
      }

      // Use atomic write: write to temp file, then rename
      const tempPath = this.encryptedSettingsPath + '.tmp';
      const jsonData = JSON.stringify(dataToSave, null, 2);
      fs.writeFileSync(tempPath, jsonData);

      // Verify the temp file is valid JSON before renaming
      try {
        JSON.parse(fs.readFileSync(tempPath, 'utf8'));
        fs.renameSync(tempPath, this.encryptedSettingsPath);
      } catch (verifyError) {
        log.error('settings', 'Verification failed, keeping original file', { error: verifyError.message });
        fs.unlinkSync(tempPath);
        return false;
      }

      // Remove old plain settings file if it exists
      if (fs.existsSync(this.settingsPath)) {
        fs.unlinkSync(this.settingsPath);
      }

      return true;
    } catch (error) {
      log.error('settings', 'Error saving settings', { error: error.message || error });
      return false;
    }
  }

  get(key) {
    // llmApiKey is now computed from dedicated provider keys for backwards compatibility
    if (key === 'llmApiKey') {
      return this._getComputedLLMApiKey();
    }

    // If the setting exists, return it
    if (this.settings[key] !== undefined) {
      return this.settings[key];
    }

    // Otherwise, return the default value
    const defaults = {
      llmProvider: 'anthropic',
      llmModel: 'claude-opus-4-5-20251101',
      theme: 'dark',
      autoSave: true,
      claude4ThinkingMode: 'enabled',
      claude4ThinkingLevel: 'default',
      autoAIMetadata: true,
      autoAIMetadataTypes: ['all'],
      gsxToken: '',
      gsxRefreshUrl: '',
      gsxEnvironment: 'edison',
      gsxAccountId: '',
      gsxAutoSync: false,
      gsxSyncInterval: 'daily',
      gsxSyncPaths: null,
      openaiApiKey: '',
      anthropicApiKey: '',
      elevenLabsApiKey: '',
      // Budget settings
      budgetEnabled: true,
      budgetShowEstimates: true,
      budgetConfirmThreshold: 0.05,
      // AI Conversation Capture settings
      aiConversationCapture: {
        enabled: true,
        captureImages: true,
        captureFiles: true,
        captureCode: true,
        autoCreateSpaces: true,
        conversationTimeoutMinutes: 30,
        showRecordingIndicator: true,
        enableUndoWindow: true,
        undoWindowMinutes: 5,
        clearPauseOnRestart: true,
        privateModeByDefault: false,
      },
      // Unified Claude Service settings
      claudePreferHeadless: true,
      claudeHeadlessTimeout: 60000,
      claudeApiFallback: true,
      // AI Service Model Profiles
      // Each profile maps a capability tier to a provider/model pair.
      // Change these to swap models across the entire app in one place.
      aiModelProfiles: null, // null = use defaults from ai-service.js
      // Diagnostic logging level: 'off', 'error', 'warn', 'info', 'debug'
      // Controls log queue min level, log server, and renderer console capture
      diagnosticLogging: 'info',
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

  // Compute the LLM API key based on the selected provider
  _getComputedLLMApiKey() {
    const provider = this.settings.llmProvider || 'anthropic';

    // Return the appropriate dedicated key based on provider
    if (provider === 'anthropic') {
      return this.settings.anthropicApiKey || '';
    } else if (provider === 'openai') {
      return this.settings.openaiApiKey || '';
    }

    // For other providers, check if we have a matching key or fall back to anthropic
    return this.settings.anthropicApiKey || this.settings.openaiApiKey || '';
  }

  // LLM-specific methods
  getLLMApiKey() {
    return this._getComputedLLMApiKey();
  }

  setLLMApiKey(apiKey) {
    // Route to the appropriate dedicated key based on provider
    const provider = this.settings.llmProvider || 'anthropic';
    if (provider === 'anthropic' || apiKey.startsWith('sk-ant-')) {
      return this.set('anthropicApiKey', apiKey);
    } else {
      return this.set('openaiApiKey', apiKey);
    }
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

    if (this.getLLMModel() === 'claude-opus-4-5-20251101' && this.getClaude4ThinkingMode() === 'enabled') {
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

  // AI Service Model Profiles
  getAIModelProfiles() {
    return this.get('aiModelProfiles') || null;
  }

  setAIModelProfiles(profiles) {
    return this.set('aiModelProfiles', profiles);
  }

  /**
   * Update a single AI model profile.
   * @param {string} profileName - e.g. 'fast', 'standard', 'powerful'
   * @param {Object} config - { provider, model, fallback? }
   */
  setAIModelProfile(profileName, config) {
    const profiles = this.get('aiModelProfiles') || {};
    profiles[profileName] = config;
    return this.set('aiModelProfiles', profiles);
  }

  // Spaces upload integration methods
  getSpacesUploadEnabled() {
    return this.get('spacesUploadIntegration') !== false; // Default true
  }

  setSpacesUploadEnabled(enabled) {
    return this.set('spacesUploadIntegration', enabled);
  }

  // Intro wizard / version tracking methods
  getLastSeenVersion() {
    return this.get('lastSeenVersion') || null;
  }

  setLastSeenVersion(version) {
    return this.set('lastSeenVersion', version);
  }

  isFirstRun() {
    return !this.getLastSeenVersion();
  }

  /**
   * Check if intro wizard should be shown
   * @param {string} currentVersion - Current app version from package.json
   * @returns {boolean} True if wizard should be shown
   */
  shouldShowIntroWizard(currentVersion) {
    const lastSeen = this.getLastSeenVersion();

    // First run - show intro
    if (!lastSeen) {
      return true;
    }

    // Compare versions - show updates if current version is newer
    return this.compareVersions(currentVersion, lastSeen) > 0;
  }

  /**
   * Compare semantic versions
   * @returns 1 if a > b, -1 if a < b, 0 if equal
   */
  compareVersions(a, b) {
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const numA = partsA[i] || 0;
      const numB = partsB[i] || 0;
      if (numA > numB) return 1;
      if (numA < numB) return -1;
    }
    return 0;
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
  SettingsManager,
};
