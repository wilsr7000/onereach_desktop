const { chromium } = require('playwright');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

class WebsiteMonitor {
  constructor(storageDir) {
    this.browser = null;
    // Cross-platform storage directory
    const homeDir = require('os').homedir();
    this.storageDir = storageDir || path.join(homeDir, 'Library', 'Application Support', 'onereach-ai', 'website-monitors');
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
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
    }
  }

  async loadMonitors() {
    try {
      const data = await fs.readFile(this.monitorsFile, 'utf8');
      const monitors = JSON.parse(data);
      monitors.forEach(monitor => {
        this.monitors.set(monitor.id, monitor);
      });
    } catch (error) {
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
      status: 'active'
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
      await page.goto(monitor.url, { 
        waitUntil: 'networkidle',
        timeout: 30000 
      });

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
          type: 'png'
        });
        screenshot = `data:image/png;base64,${screenshotBuffer.toString('base64')}`;
      }

      // Load previous snapshot
      const snapshotFile = path.join(this.snapshotsDir, `${monitorId}.json`);
      let previousSnapshot = null;
      try {
        const data = await fs.readFile(snapshotFile, 'utf8');
        previousSnapshot = JSON.parse(data);
      } catch (error) {
        // No previous snapshot
      }

      // Save current snapshot
      const currentSnapshot = {
        timestamp: new Date().toISOString(),
        contentHash,
        content: content.substring(0, 5000), // Store first 5000 chars for preview
        screenshot
      };
      await fs.writeFile(snapshotFile, JSON.stringify(currentSnapshot, null, 2));

      // Update monitor status
      monitor.lastChecked = new Date().toISOString();
      
      // Check if content changed
      const hasChanged = previousSnapshot && previousSnapshot.contentHash !== contentHash;
      
      if (hasChanged) {
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
          differences: this.calculateDifferences(previousSnapshot.content, content)
        };
        
        // Save change history
        const changesFile = path.join(this.snapshotsDir, `${monitorId}-changes.json`);
        let changes = [];
        try {
          const data = await fs.readFile(changesFile, 'utf8');
          changes = JSON.parse(data);
        } catch (error) {
          // No changes file yet
        }
        changes.unshift(change);
        changes = changes.slice(0, 100); // Keep last 100 changes
        await fs.writeFile(changesFile, JSON.stringify(changes, null, 2));
      }

      await this.saveMonitors();

      return {
        success: true,
        changed: hasChanged,
        monitor,
        snapshot: currentSnapshot,
        previousSnapshot
      };

    } catch (error) {
      console.error('Error checking website:', error);
      monitor.lastError = error.message;
      monitor.status = 'error';
      await this.saveMonitors();
      
      return {
        success: false,
        error: error.message,
        monitor
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
          new: newLines[i] || ''
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
        await new Promise(resolve => setTimeout(resolve, 2000));
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
    } catch (error) {
      // Files might not exist
    }
    
    return { success: true };
  }

  async getMonitorHistory(monitorId) {
    const changesFile = path.join(this.snapshotsDir, `${monitorId}-changes.json`);
    try {
      const data = await fs.readFile(changesFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
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
}

module.exports = WebsiteMonitor; 