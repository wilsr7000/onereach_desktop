const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { getLogQueue } = require('./lib/log-event-queue');
const log = getLogQueue();

// Skip Keychain encryption in dev mode to avoid password prompts
// Use function to defer check until app is ready
// eslint-disable-next-line no-unused-vars
function isDev() {
  try {
    return !app.isPackaged;
  } catch (_e) {
    return true; // Assume dev mode if can't determine
  }
}

// Single source of truth for "does this settings key hold a secret?"
// Used by both save and load paths so encryption policy stays consistent.
function _isSecretKey(key) {
  if (typeof key !== 'string') return false;
  return (
    key.includes('apiKey') ||
    key.includes('secret') ||
    key.includes('Token') ||
    key === 'credentials' ||
    key === 'privateKey' ||
    key.includes('password') ||
    key.includes('Password')
  );
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
          if (_isSecretKey(key)) {
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

      // Encrypt sensitive fields.
      //
      // As of v4.8.0, we ALWAYS encrypt secrets when Electron's safeStorage
      // is available -- including in dev mode. Previously dev builds skipped
      // encryption "to avoid Keychain prompts"; the actual effect was that
      // app-settings-encrypted.json contained plaintext `sk-ant-...` keys,
      // which leaks to anyone reading the user's Application Support dir
      // (or a dev `.dotfile` backup).
      //
      // safeStorage is keyed to the user's login keychain on macOS and to
      // the OS credential store on Windows/Linux, so encryption is
      // transparent across runs for the same user and does not prompt on
      // normal access after first grant.
      const encryptionAvailable = safeStorage.isEncryptionAvailable();
      for (const [key, value] of Object.entries(this.settings)) {
        if (_isSecretKey(key) && value && typeof value === 'string') {
          if (encryptionAvailable) {
            const encrypted = safeStorage.encryptString(value);
            dataToSave[key] = {
              encrypted: true,
              data: encrypted.toString('base64'),
            };
          } else {
            // safeStorage truly unavailable (e.g. headless Linux without a
            // keyring). Fall back to plaintext with a loud warning so the
            // user notices in the log server.
            log.warn('settings', 'safeStorage unavailable; storing secret in plaintext', { key });
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

      // ── Neo4j / OmniGraph credentials ────────────────────────────────
      // The Neo4j Aura instance is the canonical source of truth for
      // Spaces (cross-device, cross-app). Without these, the OmniGraph
      // client can't authenticate, push/pull silently fail, and local
      // FIFO eviction has no graph backstop. The endpoint is auto-derived
      // from `gsxRefreshUrl` at boot; the password must be set explicitly.
      neo4jPassword: '',
      neo4jUri: '', // optional override; default follows endpoint
      neo4jUser: 'neo4j',
      neo4jDatabase: 'neo4j',

      // ── Sync v5 (parallel-mode scaffold) ──────────────────────────────
      // The Phase 4 compactor runs once per day at 2-4am local time,
      // walking all spaces and trimming :Snapshot + :OperationLog rows
      // per the sliding-window retention policy (v5 4.3). Disable here
      // if a tenant needs to keep raw native cadence indefinitely (e.g.
      // a regulated tenant with bespoke retention requirements). On by
      // default; the operator can flip it off without code changes.
      'syncV5.compactorEnabled': true,

      // ── Sync v5 -- materialised SQLite replica (commit A scaffold) ────
      // Per docs/sync-v5/replica-shape.md §5 / §6. The replica is built
      // in parallel; flags ladder is enabled -> shadowReadEnabled ->
      // cutoverEnabled -> fallbackToOldPath=false. Each step requires
      // the validation gate (§6.6) to pass before the next flips.
      //
      // tenantId is locked at first replica init; changing it later
      // requires the Phase 5 migration tooling because every existing
      // row carries the old value (§6B.2).
      //
      // noShadowPaths: filesystem-relative globs that the replica will
      // NOT answer; reads fall through to disk. gsx-agent/*.md is the
      // canonical example (unified-bidder + omni-data-agent read these
      // directly; the replica must not cache stale copies).
      //
      // tombstoneRetentionDays: null = keep tombstoned rows forever
      // (default; mirrors graph :Tombstone semantics). Set an integer
      // for storage-conscious tenants; the daily compactor purges
      // active=0 rows older than the retention plus their content-cache
      // blobs if no live :Asset references the same content_hash.
      'syncV5.replica.enabled': false,
      'syncV5.replica.shadowReadEnabled': false,
      'syncV5.replica.cutoverEnabled': false,
      'syncV5.replica.fallbackToOldPath': true,
      'syncV5.replica.tenantId': 'default',
      'syncV5.replica.noShadowPaths': ['gsx-agent/*.md', 'gsx-agent/**/*.md'],
      'syncV5.replica.tombstoneRetentionDays': null,

      // Desktop Autopilot — off by default; users must opt in
      desktopAutopilotEnabled: false,
      desktopAutopilotBrowser: true,
      desktopAutopilotAppControl: true,
      desktopAutopilotSystem: false,
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

  // Mode card rotation (welcome experience)
  getModeCardIndex() {
    return this.get('modeCardIndex') || 0;
  }

  advanceModeCardIndex() {
    const current = this.getModeCardIndex();
    const next = (current + 1) % 9;
    this.set('modeCardIndex', next);
    return next;
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
