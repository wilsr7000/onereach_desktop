const { chromium } = require('playwright');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

class WebsiteMonitor {
  constructor(storageDir) {
    this.browser = null;
    // Cross-platform storage directory
    const homeDir = require('os').homedir();
    this.storageDir =
      storageDir || path.join(homeDir, 'Library', 'Application Support', 'onereach-ai', 'website-monitors');
    this.monitorsFile = path.join(this.storageDir, 'monitors.json');
    this.snapshotsDir = path.join(this.storageDir, 'snapshots');
    this.monitors = new Map();
  }

  async initialize() {
    // Ensure directories exist
    await fs.mkdir(this.storageDir, { recursive: true });
    await fs.mkdir(this.snapshotsDir, { recursive: true });

    // Load existing monitors
    await this.loadMonitors();

    // Initialize browser
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    }
  }

  async loadMonitors() {
    try {
      const data = await fs.readFile(this.monitorsFile, 'utf8');
      const monitors = JSON.parse(data);
      monitors.forEach((monitor) => {
        this.monitors.set(monitor.id, monitor);
      });
    } catch (_error) {
      // File doesn't exist yet
      this.monitors = new Map();
    }
  }

  async saveMonitors() {
    const monitors = Array.from(this.monitors.values());
    await fs.writeFile(this.monitorsFile, JSON.stringify(monitors, null, 2));
  }

  async addMonitor(config) {
    const monitor = {
      id: crypto.randomBytes(16).toString('hex'),
      url: config.url,
      name: config.name || new URL(config.url).hostname,
      spaceId: config.spaceId,
      selector: config.selector || 'body', // CSS selector to monitor
      checkInterval: config.checkInterval || 3600000, // 1 hour default
      notifyOnChange: config.notifyOnChange !== false,
      includeScreenshot: config.includeScreenshot !== false,
      created: new Date().toISOString(),
      lastChecked: null,
      lastChanged: null,
      status: 'active',
    };

    this.monitors.set(monitor.id, monitor);
    await this.saveMonitors();

    // Take initial snapshot
    await this.checkWebsite(monitor.id);

    return monitor;
  }

  async checkWebsite(monitorId) {
    const monitor = this.monitors.get(monitorId);
    if (!monitor) throw new Error('Monitor not found');

    await this.initialize();
    const page = await this.browser.newPage();

    try {
      // Navigate to the URL
      // Use 'load' instead of 'networkidle' to avoid timeout on sites with constant network activity
      await page.goto(monitor.url, {
        waitUntil: 'load',
        timeout: 60000,
      });

      // Give the page a moment to settle
      await page.waitForTimeout(2000);

      // Get content of the monitored element
      const content = await page.evaluate((selector) => {
        const element = document.querySelector(selector);
        return element ? element.innerHTML : null;
      }, monitor.selector);

      if (!content) {
        throw new Error(`Selector "${monitor.selector}" not found on page`);
      }

      // Calculate content hash
      const contentHash = crypto.createHash('sha256').update(content).digest('hex');

      // Take screenshot if enabled
      let screenshot = null;
      if (monitor.includeScreenshot) {
        const screenshotBuffer = await page.screenshot({
          fullPage: true,
          type: 'png',
        });
        screenshot = `data:image/png;base64,${screenshotBuffer.toString('base64')}`;
      }

      // Load previous snapshot
      const snapshotFile = path.join(this.snapshotsDir, `${monitorId}.json`);
      let previousSnapshot = null;
      try {
        const data = await fs.readFile(snapshotFile, 'utf8');
        previousSnapshot = JSON.parse(data);
      } catch (_error) {
        // No previous snapshot
      }

      // Save current snapshot
      const currentSnapshot = {
        timestamp: new Date().toISOString(),
        contentHash,
        content: content.substring(0, 5000), // Store first 5000 chars for preview
        screenshot,
      };
      await fs.writeFile(snapshotFile, JSON.stringify(currentSnapshot, null, 2));

      // Update monitor status
      monitor.lastChecked = new Date().toISOString();

      // Check if content changed (hash comparison)
      const hashChanged = previousSnapshot && previousSnapshot.contentHash !== contentHash;

      // Initialize change tracking
      let meaningfulChange = false;
      let filterReason = null;

      if (hashChanged) {
        // Apply noise filtering to avoid false positives
        const filterResult = this.shouldAlertForChange({
          previousContent: previousSnapshot.content,
          currentContent: content.substring(0, 5000),
          diffPercentage: undefined, // TODO: Calculate visual diff percentage
        });

        meaningfulChange = filterResult.shouldAlert;
        filterReason = filterResult.reason;

        if (meaningfulChange) {
          monitor.lastChanged = new Date().toISOString();

          // Create change record
          const change = {
            id: crypto.randomBytes(16).toString('hex'),
            monitorId: monitor.id,
            timestamp: new Date().toISOString(),
            url: monitor.url,
            previousContent: previousSnapshot.content,
            currentContent: content.substring(0, 5000),
            previousScreenshot: previousSnapshot.screenshot,
            currentScreenshot: screenshot,
            differences: this.calculateDifferences(previousSnapshot.content, content),
            filterPassed: true,
          };

          // Save change history
          const changesFile = path.join(this.snapshotsDir, `${monitorId}-changes.json`);
          let changes = [];
          try {
            const data = await fs.readFile(changesFile, 'utf8');
            changes = JSON.parse(data);
          } catch (_error) {
            // No changes file yet
          }
          changes.unshift(change);
          changes = changes.slice(0, 100); // Keep last 100 changes
          await fs.writeFile(changesFile, JSON.stringify(changes, null, 2));
        } else {
          // Track filtered (ignored) changes for stats
          monitor.ignoredChangeCount = (monitor.ignoredChangeCount || 0) + 1;
          console.log(`[WebsiteMonitor] Change filtered for ${monitor.name}: ${filterReason}`);
        }
      }

      // Reset error state on successful check
      monitor.lastError = null;
      monitor.lastErrorType = null;
      monitor.consecutiveErrors = 0;
      if (monitor.status === 'error') {
        monitor.status = 'active';
      }

      await this.saveMonitors();

      return {
        success: true,
        changed: meaningfulChange, // Only true for meaningful changes
        hashChanged: hashChanged, // Raw hash comparison result
        filtered: hashChanged && !meaningfulChange,
        filterReason: filterReason,
        monitor,
        snapshot: currentSnapshot,
        previousSnapshot,
      };
    } catch (error) {
      console.error('Error checking website:', error);

      // Categorize the error for better user feedback
      let errorType = 'unknown';
      let errorMessage = error.message;

      if (error.message.includes('timeout') || error.message.includes('Timeout')) {
        errorType = 'timeout';
        errorMessage = 'Website took too long to load';
      } else if (error.message.includes('net::ERR_') || error.message.includes('ECONNREFUSED')) {
        errorType = 'network';
        errorMessage = 'Could not connect to website';
      } else if (error.message.includes('404') || error.message.includes('Not Found')) {
        errorType = 'not_found';
        errorMessage = 'Page not found (404)';
      } else if (error.message.includes('403') || error.message.includes('Forbidden')) {
        errorType = 'forbidden';
        errorMessage = 'Access denied (403)';
      } else if (error.message.includes('500') || error.message.includes('Internal Server')) {
        errorType = 'server_error';
        errorMessage = 'Website server error (500)';
      } else if (error.message.includes('SSL') || error.message.includes('certificate')) {
        errorType = 'ssl';
        errorMessage = 'SSL certificate error';
      }

      monitor.lastError = errorMessage;
      monitor.lastErrorType = errorType;
      monitor.lastErrorTime = new Date().toISOString();
      monitor.status = 'error';
      monitor.consecutiveErrors = (monitor.consecutiveErrors || 0) + 1;

      // Auto-pause after 3 consecutive errors
      if (monitor.consecutiveErrors >= 3) {
        monitor.status = 'paused';
        monitor.pauseReason = 'consecutive_errors';
        console.log(
          `[WebsiteMonitor] Auto-paused ${monitor.name} after ${monitor.consecutiveErrors} consecutive errors`
        );
      }

      await this.saveMonitors();

      return {
        success: false,
        error: errorMessage,
        errorType,
        consecutiveErrors: monitor.consecutiveErrors,
        monitor,
      };
    } finally {
      await page.close();
    }
  }

  calculateDifferences(oldContent, newContent) {
    // Simple difference detection - you could use a more sophisticated diff library
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    const differences = [];
    const maxLines = Math.max(oldLines.length, newLines.length);

    for (let i = 0; i < maxLines; i++) {
      if (oldLines[i] !== newLines[i]) {
        differences.push({
          line: i + 1,
          old: oldLines[i] || '',
          new: newLines[i] || '',
        });
      }
    }

    return differences.slice(0, 20); // Return first 20 differences
  }

  async checkAllMonitors() {
    const results = [];

    for (const [id, monitor] of this.monitors) {
      if (monitor.status === 'active') {
        const result = await this.checkWebsite(id);
        results.push(result);

        // Add delay between checks to be respectful
        await new Promise((resolve) => {
          setTimeout(resolve, 2000);
        });
      }
    }

    return results;
  }

  async removeMonitor(monitorId) {
    this.monitors.delete(monitorId);
    await this.saveMonitors();

    // Clean up snapshots
    try {
      await fs.unlink(path.join(this.snapshotsDir, `${monitorId}.json`));
      await fs.unlink(path.join(this.snapshotsDir, `${monitorId}-changes.json`));
    } catch (_error) {
      // Files might not exist
    }

    return { success: true };
  }

  async getMonitorHistory(monitorId) {
    const changesFile = path.join(this.snapshotsDir, `${monitorId}-changes.json`);
    try {
      const data = await fs.readFile(changesFile, 'utf8');
      return JSON.parse(data);
    } catch (_error) {
      return [];
    }
  }

  async pauseMonitor(monitorId) {
    const monitor = this.monitors.get(monitorId);
    if (monitor) {
      monitor.status = 'paused';
      await this.saveMonitors();
    }
  }

  async resumeMonitor(monitorId) {
    const monitor = this.monitors.get(monitorId);
    if (monitor) {
      monitor.status = 'active';
      await this.saveMonitors();
    }
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  // ========================================
  // NOISE FILTERING (Cost-saving, no AI)
  // ========================================

  /**
   * Noise patterns that indicate non-meaningful changes
   * These are filtered out WITHOUT using AI
   */
  static NOISE_PATTERNS = [
    /^\d+\s*(min|minute|hour|day|sec|second)s?\s*ago$/i, // "5 min ago"
    /^(just now|moments ago|now)$/i, // "just now"
    /^\d+(\.\d+)?[kmb]?\s*(views?|likes?|comments?|shares?)$/i, // "1.2k views"
    /^\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?$/i, // "10:30 AM"
    /^(today|yesterday|tomorrow)\s*(at\s*\d)?/i, // "today at 3:00"
    /^©\s*\d{4}/, // copyright year
    /^updated?\s*:?\s*\d/i, // "Updated: Jan 19"
    /^\d+\s*(new|unread)/i, // "5 new"
    /^(online|offline|away|busy)$/i, // status indicators
    /^\$?\d+([,\.]\d+)*\s*(usd|eur|gbp)?$/i, // prices (might be noise)
  ];

  /**
   * Check if changed text is likely noise (not meaningful)
   * @param {string} changedText - The text that changed
   * @returns {boolean} true if likely noise
   */
  isLikelyNoise(changedText) {
    if (!changedText || typeof changedText !== 'string') return true;

    const trimmed = changedText.trim();
    if (trimmed.length === 0) return true;

    // First, check if the whole text matches any noise pattern
    if (WebsiteMonitor.NOISE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      return true;
    }

    // If text is short (< 20 chars), also check by splitting into phrases
    // and testing each phrase against patterns
    if (trimmed.length < 20) {
      const phrases = trimmed
        .split(/[,;|]/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      return phrases.every((phrase) => WebsiteMonitor.NOISE_PATTERNS.some((pattern) => pattern.test(phrase)));
    }

    // Longer text with real content - not noise
    return false;
  }

  /**
   * Get text diff between old and new content
   * @returns {object} { totalChanged, changedText, addedCount, removedCount }
   */
  getTextDiff(oldContent, newContent) {
    if (!oldContent || !newContent) {
      return { totalChanged: 0, changedText: '', addedCount: 0, removedCount: 0 };
    }

    // Extract text only (strip HTML tags)
    const stripHtml = (html) =>
      html
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const oldText = stripHtml(oldContent);
    const newText = stripHtml(newContent);

    // Simple word-based diff
    const oldWords = new Set(oldText.toLowerCase().split(/\s+/));
    const newWords = new Set(newText.toLowerCase().split(/\s+/));

    const added = [...newWords].filter((w) => !oldWords.has(w));
    const removed = [...oldWords].filter((w) => !newWords.has(w));

    const changedText = [...added, ...removed].join(' ');
    const totalChanged = changedText.length;

    return {
      totalChanged,
      changedText,
      addedCount: added.length,
      removedCount: removed.length,
    };
  }

  /**
   * Determine if a change should trigger an alert
   * Uses heuristics only (no AI) to filter out noise
   * @param {object} changeData - Data about the detected change
   * @returns {object} { shouldAlert: boolean, reason: string }
   */
  shouldAlertForChange(changeData) {
    const { previousContent, currentContent, diffPercentage } = changeData;

    // Filter 1: Visual significance threshold (5%)
    if (diffPercentage !== undefined && diffPercentage < 5) {
      console.log('[WebsiteMonitor] Change filtered: visual diff too small', diffPercentage);
      return { shouldAlert: false, reason: 'visual_threshold' };
    }

    // Filter 2: Text diff size (50 char minimum)
    const textDiff = this.getTextDiff(previousContent, currentContent);
    if (textDiff.totalChanged < 50) {
      console.log('[WebsiteMonitor] Change filtered: text diff too small', textDiff.totalChanged);
      return { shouldAlert: false, reason: 'text_threshold' };
    }

    // Filter 3: Heuristic noise patterns
    if (this.isLikelyNoise(textDiff.changedText)) {
      console.log('[WebsiteMonitor] Change filtered: matches noise patterns');
      return { shouldAlert: false, reason: 'noise_pattern' };
    }

    return { shouldAlert: true, reason: null };
  }
}

module.exports = WebsiteMonitor;
