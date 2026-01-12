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
}

// Export singleton instance
module.exports = new CredentialManager();




