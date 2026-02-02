/**
 * Credential Manager for IDW Login Auto-Save
 * Securely stores and retrieves credentials using the OS Keychain
 * - macOS: Keychain
 * - Windows: Credential Vault
 * - Linux: Secret Service (libsecret)
 */

const keytar = require('keytar');

// Service name for keytar - all credentials stored under this service
const SERVICE_NAME = 'OneReach.ai-IDW';

// Separate service for TOTP secrets (2FA)
const TOTP_SERVICE_NAME = 'OneReach.ai-TOTP';

// Key for the unified OneReach login credentials
const ONEREACH_ACCOUNT_KEY = 'onereach-unified-login';

class CredentialManager {
  constructor() {
    // Temporary storage for credentials captured during login
    // Cleared after save prompt is dismissed or after timeout
    this.pendingCredentials = new Map();
    
    // Timeout for pending credentials (5 minutes)
    this.PENDING_TIMEOUT = 5 * 60 * 1000;
    
    console.log('[CredentialManager] Initialized');
  }

  /**
   * Extract domain from URL for use as account identifier
   * @param {string} url - Full URL
   * @returns {string} - Domain (e.g., "idw.onereach.ai")
   */
  extractDomain(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch (e) {
      console.error('[CredentialManager] Invalid URL:', url);
      return url;
    }
  }

  /**
   * Create a unique key for storing credentials
   * Combines domain and username for multiple account support
   * @param {string} domain - IDW domain
   * @param {string} username - Username/email
   * @returns {string} - Unique key
   */
  createAccountKey(domain, username) {
    return `${domain}::${username}`;
  }

  /**
   * Parse account key back to domain and username
   * @param {string} key - Account key
   * @returns {{domain: string, username: string}}
   */
  parseAccountKey(key) {
    const [domain, username] = key.split('::');
    return { domain, username };
  }

  /**
   * Temporarily store captured credentials until user confirms save
   * @param {string} url - Login page URL
   * @param {string} username - Captured username
   * @param {string} password - Captured password
   * @param {string} idwName - Optional IDW display name
   */
  storePendingCredentials(url, username, password, idwName = null) {
    const domain = this.extractDomain(url);
    const key = this.createAccountKey(domain, username);
    
    // Clear any existing timeout for this key
    const existing = this.pendingCredentials.get(key);
    if (existing && existing.timeout) {
      clearTimeout(existing.timeout);
    }
    
    // Store with auto-clear timeout
    const timeout = setTimeout(() => {
      this.clearPendingCredentials(key);
      console.log('[CredentialManager] Pending credentials expired for:', domain);
    }, this.PENDING_TIMEOUT);
    
    this.pendingCredentials.set(key, {
      domain,
      username,
      password,
      idwName: idwName || domain,
      url,
      capturedAt: Date.now(),
      timeout
    });
    
    console.log('[CredentialManager] Stored pending credentials for:', domain);
    return key;
  }

  /**
   * Get pending credentials for a domain
   * @param {string} url - URL to check
   * @returns {Object|null} - Pending credentials or null
   */
  getPendingCredentials(url) {
    const domain = this.extractDomain(url);
    
    // Find any pending credentials for this domain
    for (const [key, creds] of this.pendingCredentials) {
      if (creds.domain === domain) {
        return { key, ...creds };
      }
    }
    return null;
  }

  /**
   * Clear pending credentials
   * @param {string} key - Account key to clear
   */
  clearPendingCredentials(key) {
    const creds = this.pendingCredentials.get(key);
    if (creds && creds.timeout) {
      clearTimeout(creds.timeout);
    }
    this.pendingCredentials.delete(key);
  }

  /**
   * Save credentials to OS Keychain
   * @param {string} url - IDW URL
   * @param {string} username - Username
   * @param {string} password - Password
   * @param {string} idwName - Optional IDW display name
   * @returns {Promise<boolean>} - Success status
   */
  async saveCredential(url, username, password, idwName = null) {
    try {
      const domain = this.extractDomain(url);
      const accountKey = this.createAccountKey(domain, username);
      
      // Store password in keychain
      await keytar.setPassword(SERVICE_NAME, accountKey, password);
      
      // Store metadata (IDW name, URL) as a separate entry
      const metadata = JSON.stringify({
        idwName: idwName || domain,
        url,
        savedAt: Date.now()
      });
      await keytar.setPassword(`${SERVICE_NAME}-meta`, accountKey, metadata);
      
      console.log('[CredentialManager] Saved credentials for:', domain, 'user:', username);
      
      // Clear any pending credentials for this key
      this.clearPendingCredentials(accountKey);
      
      return true;
    } catch (error) {
      console.error('[CredentialManager] Failed to save credentials:', error);
      return false;
    }
  }

  /**
   * Get saved credential for a URL
   * Returns the first matching credential for the domain
   * @param {string} url - IDW URL
   * @returns {Promise<{username: string, password: string, idwName: string}|null>}
   */
  async getCredential(url) {
    try {
      const domain = this.extractDomain(url);
      const allCredentials = await this.listCredentials();
      
      // Find credentials for this domain
      const match = allCredentials.find(cred => cred.domain === domain);
      if (!match) {
        return null;
      }
      
      // Get the actual password
      const password = await keytar.getPassword(SERVICE_NAME, match.accountKey);
      if (!password) {
        return null;
      }
      
      return {
        username: match.username,
        password,
        idwName: match.idwName,
        domain: match.domain
      };
    } catch (error) {
      console.error('[CredentialManager] Failed to get credential:', error);
      return null;
    }
  }

  /**
   * Get all saved credentials for a specific domain
   * Useful when multiple accounts exist for the same IDW
   * @param {string} url - IDW URL
   * @returns {Promise<Array<{username: string, password: string, idwName: string}>>}
   */
  async getCredentialsForDomain(url) {
    try {
      const domain = this.extractDomain(url);
      const allCredentials = await this.listCredentials();
      
      // Filter for this domain
      const matches = allCredentials.filter(cred => cred.domain === domain);
      
      // Get passwords for each
      const results = await Promise.all(matches.map(async (match) => {
        const password = await keytar.getPassword(SERVICE_NAME, match.accountKey);
        return {
          username: match.username,
          password,
          idwName: match.idwName,
          domain: match.domain,
          accountKey: match.accountKey
        };
      }));
      
      return results.filter(r => r.password !== null);
    } catch (error) {
      console.error('[CredentialManager] Failed to get credentials for domain:', error);
      return [];
    }
  }

  /**
   * List all saved credentials (without passwords)
   * @returns {Promise<Array<{domain: string, username: string, idwName: string, accountKey: string}>>}
   */
  async listCredentials() {
    try {
      // Get all credentials from keytar
      const credentials = await keytar.findCredentials(SERVICE_NAME);
      
      const results = await Promise.all(credentials.map(async (cred) => {
        const { domain, username } = this.parseAccountKey(cred.account);
        
        // Try to get metadata
        let idwName = domain;
        try {
          const metaStr = await keytar.getPassword(`${SERVICE_NAME}-meta`, cred.account);
          if (metaStr) {
            const meta = JSON.parse(metaStr);
            idwName = meta.idwName || domain;
          }
        } catch (e) {
          // Metadata might not exist for older entries
        }
        
        return {
          domain,
          username,
          idwName,
          accountKey: cred.account
        };
      }));
      
      return results;
    } catch (error) {
      console.error('[CredentialManager] Failed to list credentials:', error);
      return [];
    }
  }

  /**
   * Delete a saved credential
   * @param {string} accountKey - Account key (domain::username)
   * @returns {Promise<boolean>} - Success status
   */
  async deleteCredential(accountKey) {
    try {
      // Delete password
      const deleted = await keytar.deletePassword(SERVICE_NAME, accountKey);
      
      // Also try to delete metadata
      try {
        await keytar.deletePassword(`${SERVICE_NAME}-meta`, accountKey);
      } catch (e) {
        // Metadata might not exist
      }
      
      console.log('[CredentialManager] Deleted credential:', accountKey);
      return deleted;
    } catch (error) {
      console.error('[CredentialManager] Failed to delete credential:', error);
      return false;
    }
  }

  /**
   * Delete all saved credentials
   * @returns {Promise<number>} - Number of credentials deleted
   */
  async deleteAllCredentials() {
    try {
      const credentials = await this.listCredentials();
      let deleted = 0;
      
      for (const cred of credentials) {
        if (await this.deleteCredential(cred.accountKey)) {
          deleted++;
        }
      }
      
      console.log('[CredentialManager] Deleted all credentials, count:', deleted);
      return deleted;
    } catch (error) {
      console.error('[CredentialManager] Failed to delete all credentials:', error);
      return 0;
    }
  }

  /**
   * Check if credentials exist for a URL
   * @param {string} url - IDW URL to check
   * @returns {Promise<boolean>}
   */
  async hasCredential(url) {
    const credential = await this.getCredential(url);
    return credential !== null;
  }

  /**
   * Update password for existing credential
   * @param {string} accountKey - Account key
   * @param {string} newPassword - New password
   * @returns {Promise<boolean>}
   */
  async updatePassword(accountKey, newPassword) {
    try {
      await keytar.setPassword(SERVICE_NAME, accountKey, newPassword);
      console.log('[CredentialManager] Updated password for:', accountKey);
      return true;
    } catch (error) {
      console.error('[CredentialManager] Failed to update password:', error);
      return false;
    }
  }

  // ============================================================
  // OneReach Unified Login Methods (for Auto-Login with 2FA)
  // ============================================================

  /**
   * Save unified OneReach login credentials
   * These are used for automatic login across all OneReach environments
   * @param {string} email - OneReach email/username
   * @param {string} password - OneReach password
   * @param {string} totpSecret - Optional TOTP secret for 2FA (Base32 encoded)
   * @returns {Promise<boolean>}
   */
  async saveOneReachCredentials(email, password, totpSecret = null) {
    try {
      // Save email as metadata
      const metadata = JSON.stringify({
        email,
        savedAt: Date.now(),
        has2FA: !!totpSecret
      });
      await keytar.setPassword(`${SERVICE_NAME}-onereach-meta`, ONEREACH_ACCOUNT_KEY, metadata);
      
      // Save password
      await keytar.setPassword(SERVICE_NAME, ONEREACH_ACCOUNT_KEY, password);
      
      // Save TOTP secret if provided
      if (totpSecret) {
        await keytar.setPassword(TOTP_SERVICE_NAME, ONEREACH_ACCOUNT_KEY, totpSecret);
        console.log('[CredentialManager] Saved OneReach credentials with 2FA for:', email);
      } else {
        console.log('[CredentialManager] Saved OneReach credentials (no 2FA) for:', email);
      }
      
      return true;
    } catch (error) {
      console.error('[CredentialManager] Failed to save OneReach credentials:', error);
      return false;
    }
  }

  /**
   * Get unified OneReach login credentials
   * @returns {Promise<{email: string, password: string, totpSecret: string|null}|null>}
   */
  async getOneReachCredentials() {
    try {
      // Get metadata (contains email)
      const metaStr = await keytar.getPassword(`${SERVICE_NAME}-onereach-meta`, ONEREACH_ACCOUNT_KEY);
      if (!metaStr) {
        return null;
      }
      
      const meta = JSON.parse(metaStr);
      
      // Get password
      const password = await keytar.getPassword(SERVICE_NAME, ONEREACH_ACCOUNT_KEY);
      if (!password) {
        return null;
      }
      
      // Try to get TOTP secret
      let totpSecret = null;
      try {
        totpSecret = await keytar.getPassword(TOTP_SERVICE_NAME, ONEREACH_ACCOUNT_KEY);
      } catch (e) {
        // TOTP might not be configured
      }
      
      return {
        email: meta.email,
        password,
        totpSecret,
        has2FA: !!totpSecret,
        savedAt: meta.savedAt
      };
    } catch (error) {
      console.error('[CredentialManager] Failed to get OneReach credentials:', error);
      return null;
    }
  }

  /**
   * Check if OneReach credentials are configured
   * @returns {Promise<{hasCredentials: boolean, has2FA: boolean}>}
   */
  async hasOneReachCredentials() {
    try {
      const creds = await this.getOneReachCredentials();
      return {
        hasCredentials: creds !== null,
        has2FA: creds?.has2FA || false
      };
    } catch (error) {
      return { hasCredentials: false, has2FA: false };
    }
  }

  /**
   * Save only the TOTP secret (when adding 2FA to existing credentials)
   * @param {string} totpSecret - Base32 encoded TOTP secret
   * @returns {Promise<boolean>}
   */
  async saveTOTPSecret(totpSecret) {
    try {
      await keytar.setPassword(TOTP_SERVICE_NAME, ONEREACH_ACCOUNT_KEY, totpSecret);
      
      // Update metadata to reflect 2FA is now enabled
      const metaStr = await keytar.getPassword(`${SERVICE_NAME}-onereach-meta`, ONEREACH_ACCOUNT_KEY);
      if (metaStr) {
        const meta = JSON.parse(metaStr);
        meta.has2FA = true;
        meta.totpAddedAt = Date.now();
        await keytar.setPassword(`${SERVICE_NAME}-onereach-meta`, ONEREACH_ACCOUNT_KEY, JSON.stringify(meta));
      }
      
      console.log('[CredentialManager] Saved TOTP secret');
      return true;
    } catch (error) {
      console.error('[CredentialManager] Failed to save TOTP secret:', error);
      return false;
    }
  }

  /**
   * Get only the TOTP secret
   * @returns {Promise<string|null>}
   */
  async getTOTPSecret() {
    try {
      return await keytar.getPassword(TOTP_SERVICE_NAME, ONEREACH_ACCOUNT_KEY);
    } catch (error) {
      console.error('[CredentialManager] Failed to get TOTP secret:', error);
      return null;
    }
  }

  /**
   * Delete TOTP secret (disable 2FA)
   * @returns {Promise<boolean>}
   */
  async deleteTOTPSecret() {
    try {
      await keytar.deletePassword(TOTP_SERVICE_NAME, ONEREACH_ACCOUNT_KEY);
      
      // Update metadata
      const metaStr = await keytar.getPassword(`${SERVICE_NAME}-onereach-meta`, ONEREACH_ACCOUNT_KEY);
      if (metaStr) {
        const meta = JSON.parse(metaStr);
        meta.has2FA = false;
        delete meta.totpAddedAt;
        await keytar.setPassword(`${SERVICE_NAME}-onereach-meta`, ONEREACH_ACCOUNT_KEY, JSON.stringify(meta));
      }
      
      console.log('[CredentialManager] Deleted TOTP secret');
      return true;
    } catch (error) {
      console.error('[CredentialManager] Failed to delete TOTP secret:', error);
      return false;
    }
  }

  /**
   * Delete all unified OneReach credentials
   * @returns {Promise<boolean>}
   */
  async deleteOneReachCredentials() {
    try {
      await keytar.deletePassword(SERVICE_NAME, ONEREACH_ACCOUNT_KEY);
      await keytar.deletePassword(`${SERVICE_NAME}-onereach-meta`, ONEREACH_ACCOUNT_KEY);
      
      try {
        await keytar.deletePassword(TOTP_SERVICE_NAME, ONEREACH_ACCOUNT_KEY);
      } catch (e) {
        // TOTP might not exist
      }
      
      console.log('[CredentialManager] Deleted OneReach credentials');
      return true;
    } catch (error) {
      console.error('[CredentialManager] Failed to delete OneReach credentials:', error);
      return false;
    }
  }

  /**
   * Update just the email (preserves password and TOTP)
   * @param {string} newEmail - New email address
   * @returns {Promise<boolean>}
   */
  async updateOneReachEmail(newEmail) {
    try {
      const metaStr = await keytar.getPassword(`${SERVICE_NAME}-onereach-meta`, ONEREACH_ACCOUNT_KEY);
      if (metaStr) {
        const meta = JSON.parse(metaStr);
        meta.email = newEmail;
        meta.updatedAt = Date.now();
        await keytar.setPassword(`${SERVICE_NAME}-onereach-meta`, ONEREACH_ACCOUNT_KEY, JSON.stringify(meta));
        console.log('[CredentialManager] Updated OneReach email');
        return true;
      }
      return false;
    } catch (error) {
      console.error('[CredentialManager] Failed to update OneReach email:', error);
      return false;
    }
  }

  /**
   * Update just the password (preserves email and TOTP)
   * @param {string} newPassword - New password
   * @returns {Promise<boolean>}
   */
  async updateOneReachPassword(newPassword) {
    try {
      await keytar.setPassword(SERVICE_NAME, ONEREACH_ACCOUNT_KEY, newPassword);
      console.log('[CredentialManager] Updated OneReach password');
      return true;
    } catch (error) {
      console.error('[CredentialManager] Failed to update OneReach password:', error);
      return false;
    }
  }
}

// Export singleton instance
module.exports = new CredentialManager();




