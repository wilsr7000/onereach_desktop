/**
 * Application Context Capture Module
 * Captures context about the active application when clipboard events occur
 */

const { _app } = require('electron');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

class AppContextCapture {
  constructor() {
    this.lastActiveApp = null;
    this.appCache = new Map();
    this.backgroundTrackingInterval = null;
    this._cacheTTLMs = 5000;
  }

  /**
   * Start background tracking of the active application.
   * Kept for backward compatibility but no longer auto-started.
   * On-demand capture with TTL cache replaces the polling approach.
   */
  startBackgroundTracking() {
    // No-op: polling replaced by on-demand capture in getActiveApplication()
  }

  /**
   * Stop background tracking
   */
  stopBackgroundTracking() {
    if (this.backgroundTrackingInterval) {
      clearInterval(this.backgroundTrackingInterval);
      this.backgroundTrackingInterval = null;
    }
  }

  /**
   * Get the currently active (frontmost) application on macOS
   * @returns {Promise<Object>} Application info
   */
  async getActiveApplication() {
    // Return cached result if still fresh (avoids spawning osascript on every call)
    if (this.lastActiveApp && (Date.now() - this.lastActiveApp.timestamp) < this._cacheTTLMs) {
      return this.lastActiveApp;
    }

    // Windows compatibility: Return generic info for now
    if (process.platform !== 'darwin') {
      console.log('[AppContext] Non-macOS platform detected');
      return {
        name: 'Unknown',
        bundleId: 'unknown',
        timestamp: Date.now(),
      };
    }

    try {
      // Use AppleScript to get the frontmost application
      const script = `
        tell application "System Events"
          set frontApp to first application process whose frontmost is true
          set appName to name of frontApp
          set bundleId to bundle identifier of frontApp
          
          -- If the frontmost app is Electron (our app), try to get the second frontmost
          if appName is "Electron" then
            set allProcesses to every application process whose visible is true
            if (count of allProcesses) > 1 then
              set secondApp to item 2 of allProcesses
              set appName to name of secondApp
              try
                set bundleId to bundle identifier of secondApp
              on error
                set bundleId to "unknown"
              end try
            end if
          end if
          
          return appName & "|" & bundleId
        end tell
      `;

      const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`);
      const [appName, bundleId] = stdout.trim().split('|');

      const appInfo = {
        name: appName,
        bundleId: bundleId || 'unknown',
        timestamp: Date.now(),
      };

      // If we still got Electron, check our cache for the last non-Electron app
      if (appName === 'Electron' && this.lastActiveApp && this.lastActiveApp.name !== 'Electron') {
        // Use the cached app if it's recent (within 5 seconds)
        if (Date.now() - this.lastActiveApp.timestamp < 5000) {
          return this.lastActiveApp;
        }
      }

      // Cache the result only if it's not Electron
      if (appName !== 'Electron') {
        this.lastActiveApp = appInfo;
      }

      return appInfo;
    } catch (error) {
      console.error('Error getting active application:', error);

      // If we have a cached non-Electron app, use it
      if (this.lastActiveApp && this.lastActiveApp.name !== 'Electron') {
        return this.lastActiveApp;
      }

      return {
        name: 'Unknown',
        bundleId: 'unknown',
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Get additional context about the active window
   * @returns {Promise<Object>} Window context
   */
  async getWindowContext() {
    // Windows compatibility: Return empty context for now
    if (process.platform !== 'darwin') {
      return {
        windowTitle: '',
        url: '',
        domain: '',
      };
    }

    try {
      // Get window title and URL if available
      const script = `
        tell application "System Events"
          set frontApp to first application process whose frontmost is true
          set appName to name of frontApp
          
          try
            set windowTitle to name of front window of frontApp
          on error
            set windowTitle to ""
          end try
          
          -- Try to get URL for browsers
          set urlText to ""
          if appName is in {"Safari", "Google Chrome", "Microsoft Edge", "Firefox", "Arc", "Brave Browser"} then
            try
              if appName is "Safari" then
                tell application "Safari"
                  set urlText to URL of front document
                end tell
              else if appName is "Google Chrome" then
                tell application "Google Chrome"
                  set urlText to URL of active tab of front window
                end tell
              else if appName is "Arc" then
                tell application "Arc"
                  set urlText to URL of active tab of front window
                end tell
              else if appName is "Microsoft Edge" then
                tell application "Microsoft Edge"
                  set urlText to URL of active tab of front window
                end tell
              end if
            on error
              set urlText to ""
            end try
          end if
          
          return windowTitle & "|" & urlText
        end tell
      `;

      const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`);
      const [windowTitle, url] = stdout.trim().split('|');

      return {
        windowTitle: windowTitle || '',
        url: url || '',
        domain: url ? this.extractDomain(url) : '',
      };
    } catch (error) {
      // Silently handle - this often fails due to permissions or certain apps being in focus
      // Only log if it's an unexpected error (not permission-related)
      if (error.code !== 1 && !error.message?.includes('not allowed')) {
        console.debug('[AppContext] Window context unavailable:', error.message || error.code);
      }
      return {
        windowTitle: '',
        url: '',
        domain: '',
      };
    }
  }

  /**
   * Extract domain from URL
   * @param {string} url - The URL to parse
   * @returns {string} The domain
   */
  extractDomain(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch {
      return '';
    }
  }

  /**
   * Get full context for clipboard event
   * @returns {Promise<Object>} Full context object
   */
  async getFullContext() {
    const [appInfo, windowContext] = await Promise.all([this.getActiveApplication(), this.getWindowContext()]);

    return {
      app: appInfo,
      window: windowContext,
      timestamp: Date.now(),
    };
  }

  /**
   * Enhance detectSource with application context
   * @param {string} text - The clipboard text
   * @param {Object} context - The application context
   * @returns {string} Enhanced source detection
   */
  enhanceSourceDetection(text, context) {
    // If we have app context, use it
    if (context && context.app) {
      const appName = context.app.name.toLowerCase();

      // Map common applications to source types
      const appSourceMap = {
        'visual studio code': 'vscode',
        code: 'vscode',
        'sublime text': 'sublime',
        xcode: 'xcode',
        'intellij idea': 'intellij',
        webstorm: 'webstorm',
        terminal: 'terminal',
        iterm: 'terminal',
        safari: 'browser-safari',
        'google chrome': 'browser-chrome',
        chrome: 'browser-chrome',
        firefox: 'browser-firefox',
        arc: 'browser-arc',
        'microsoft edge': 'browser-edge',
        edge: 'browser-edge',
        slack: 'slack',
        discord: 'discord',
        messages: 'messages',
        mail: 'mail',
        notes: 'notes',
        notion: 'notion',
        obsidian: 'obsidian',
        figma: 'figma',
        sketch: 'sketch',
        'adobe photoshop': 'photoshop',
        'adobe illustrator': 'illustrator',
        'microsoft word': 'word',
        'microsoft excel': 'excel',
        pages: 'pages',
        numbers: 'numbers',
        keynote: 'keynote',
      };

      // Check if app name matches any known apps
      for (const [key, value] of Object.entries(appSourceMap)) {
        if (appName.includes(key)) {
          return value;
        }
      }

      // For browsers, include the domain if available
      if (
        appName.includes('safari') ||
        appName.includes('chrome') ||
        appName.includes('firefox') ||
        appName.includes('edge') ||
        appName.includes('arc')
      ) {
        if (context.window && context.window.domain) {
          return `web-${context.window.domain.replace(/\./g, '-')}`;
        }
      }
    }

    // Fall back to text-based detection
    if (text.includes('```') || /function|const|let|var|class/.test(text)) {
      return 'code';
    }
    if (/^https?:\/\//.test(text)) {
      return 'url';
    }
    if (text.includes('@') && text.includes('.')) {
      return 'email';
    }

    return context?.app?.name || 'unknown';
  }

  /**
   * Format context for display
   * @param {Object} context - The context object
   * @returns {string} Formatted context string
   */
  formatContextDisplay(context) {
    if (!context || !context.app) return 'Unknown Source';

    let display = context.app.name;

    if (context.window) {
      if (context.window.windowTitle) {
        display += ` - ${context.window.windowTitle}`;
      }
      if (context.window.domain) {
        display += ` (${context.window.domain})`;
      }
    }

    return display;
  }
}

module.exports = AppContextCapture;
