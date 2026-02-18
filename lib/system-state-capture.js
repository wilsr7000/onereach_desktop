/**
 * System State Capture
 *
 * Captures comprehensive macOS system state for before/after comparison
 * during agent testing. Provides detailed diffs to show exactly what
 * changed (or didn't change) when an action was executed.
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

class SystemStateCapture {
  constructor() {
    // Apps that have special state we can capture
    this.mediaApps = ['music', 'spotify', 'vlc', 'quicktime player'];
    this.browserApps = ['safari', 'google chrome', 'firefox', 'arc', 'brave browser'];
  }

  /**
   * Capture full system state
   * @param {Object} context - Optional context for what to capture
   * @returns {Object} Complete state snapshot
   */
  async captureFullState(context = {}) {
    const startTime = Date.now();

    const state = {
      timestamp: startTime,
      captureTime: null,

      // Process information
      processes: await this.getRunningProcesses(),
      frontmostApp: await this.getFrontmostApp(),

      // Window information
      windows: await this.getWindowList(),

      // App-specific states
      appStates: {},

      // File system (if watching specific files)
      files: null,

      // Clipboard
      clipboard: await this.getClipboard(),

      // System settings
      system: await this.getSystemSettings(),
    };

    // Get app-specific states for relevant apps
    const relevantApps = context.relevantApps || this.detectRelevantApps(state.processes);
    state.appStates = await this.getAppSpecificStates(relevantApps);

    // Check specific files if requested
    if (context.watchFiles && context.watchFiles.length > 0) {
      state.files = await this.checkFiles(context.watchFiles);
    }

    state.captureTime = Date.now() - startTime;

    return state;
  }

  /**
   * Get list of running processes
   */
  async getRunningProcesses() {
    try {
      const { stdout } = await execAsync(
        `osascript -e 'tell application "System Events" to get name of every process whose background only is false'`
      );
      const processes = stdout
        .trim()
        .split(', ')
        .map((p) => p.trim().toLowerCase());
      return processes;
    } catch (_error) {
      return [];
    }
  }

  /**
   * Get the frontmost application
   */
  async getFrontmostApp() {
    try {
      const { stdout } = await execAsync(
        `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`
      );
      return {
        name: stdout.trim(),
        nameLower: stdout.trim().toLowerCase(),
      };
    } catch (_error) {
      return { name: 'Unknown', nameLower: 'unknown' };
    }
  }

  /**
   * Get list of visible windows
   */
  async getWindowList() {
    try {
      const script = `
        tell application "System Events"
          set windowList to {}
          repeat with proc in (every process whose visible is true)
            try
              repeat with win in (every window of proc)
                set winInfo to {appName:(name of proc), winTitle:(name of win), winPosition:(position of win), winSize:(size of win)}
                set end of windowList to winInfo
              end repeat
            end try
          end repeat
          return windowList
        end tell
      `;
      const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`);

      // Parse the AppleScript output
      const windows = [];
      const matches = stdout.matchAll(
        /appName:([^,]+), winTitle:([^,]+), winPosition:\{([^}]+)\}, winSize:\{([^}]+)\}/g
      );
      for (const match of matches) {
        windows.push({
          app: match[1].trim(),
          title: match[2].trim(),
          position: match[3].trim(),
          size: match[4].trim(),
        });
      }
      return windows;
    } catch (_error) {
      return [];
    }
  }

  /**
   * Detect which apps are relevant based on running processes
   */
  detectRelevantApps(processes) {
    const relevant = [];

    for (const proc of processes) {
      if (this.mediaApps.includes(proc)) {
        relevant.push({ name: proc, type: 'media' });
      } else if (this.browserApps.includes(proc)) {
        relevant.push({ name: proc, type: 'browser' });
      } else if (proc === 'finder') {
        relevant.push({ name: proc, type: 'finder' });
      }
    }

    return relevant;
  }

  /**
   * Get app-specific states for relevant apps
   */
  async getAppSpecificStates(relevantApps) {
    const states = {};

    for (const app of relevantApps) {
      try {
        if (app.type === 'media' || this.mediaApps.includes(app.name?.toLowerCase())) {
          states[app.name] = await this.getMediaAppState(app.name);
        } else if (app.type === 'browser' || this.browserApps.includes(app.name?.toLowerCase())) {
          states[app.name] = await this.getBrowserState(app.name);
        } else if (app.type === 'finder' || app.name?.toLowerCase() === 'finder') {
          states[app.name] = await this.getFinderState();
        }
      } catch (error) {
        states[app.name] = { error: error.message };
      }
    }

    return states;
  }

  /**
   * Get state of a media app (Music, Spotify, etc.)
   */
  async getMediaAppState(appName) {
    const appNameProper = this.toProperCase(appName);

    try {
      // Get player state
      const { stdout: playerState } = await execAsync(
        `osascript -e 'tell application "${appNameProper}" to get player state'`
      ).catch(() => ({ stdout: 'unknown' }));

      // Get current track info
      let trackInfo = { name: '', artist: '', album: '', position: 0, duration: 0 };

      if (playerState.trim() !== 'stopped') {
        try {
          const { stdout: trackName } = await execAsync(
            `osascript -e 'tell application "${appNameProper}" to get name of current track'`
          ).catch(() => ({ stdout: '' }));

          const { stdout: artist } = await execAsync(
            `osascript -e 'tell application "${appNameProper}" to get artist of current track'`
          ).catch(() => ({ stdout: '' }));

          const { stdout: album } = await execAsync(
            `osascript -e 'tell application "${appNameProper}" to get album of current track'`
          ).catch(() => ({ stdout: '' }));

          const { stdout: position } = await execAsync(
            `osascript -e 'tell application "${appNameProper}" to get player position'`
          ).catch(() => ({ stdout: '0' }));

          const { stdout: duration } = await execAsync(
            `osascript -e 'tell application "${appNameProper}" to get duration of current track'`
          ).catch(() => ({ stdout: '0' }));

          trackInfo = {
            name: trackName.trim(),
            artist: artist.trim(),
            album: album.trim(),
            position: parseFloat(position) || 0,
            duration: parseFloat(duration) || 0,
          };
        } catch (_e) {
          // Track info not available
        }
      }

      // Get volume
      const { stdout: volume } = await execAsync(
        `osascript -e 'tell application "${appNameProper}" to get sound volume'`
      ).catch(() => ({ stdout: '0' }));

      // Get shuffle/repeat state
      const { stdout: shuffle } = await execAsync(
        `osascript -e 'tell application "${appNameProper}" to get shuffle enabled'`
      ).catch(() => ({ stdout: 'false' }));

      return {
        type: 'media',
        playerState: playerState.trim(),
        track: trackInfo,
        volume: parseInt(volume) || 0,
        shuffle: shuffle.trim() === 'true',
        isPlaying: playerState.trim() === 'playing',
        isPaused: playerState.trim() === 'paused',
        isStopped: playerState.trim() === 'stopped',
      };
    } catch (error) {
      return { type: 'media', error: error.message };
    }
  }

  /**
   * Get state of a browser app
   */
  async getBrowserState(appName) {
    const appNameProper = this.toProperCase(appName);

    try {
      let url = '';
      let title = '';
      let tabCount = 0;

      if (appNameProper.toLowerCase().includes('safari')) {
        const { stdout: urlOut } = await execAsync(
          `osascript -e 'tell application "Safari" to get URL of current tab of front window'`
        ).catch(() => ({ stdout: '' }));
        url = urlOut.trim();

        const { stdout: titleOut } = await execAsync(
          `osascript -e 'tell application "Safari" to get name of current tab of front window'`
        ).catch(() => ({ stdout: '' }));
        title = titleOut.trim();

        const { stdout: countOut } = await execAsync(
          `osascript -e 'tell application "Safari" to get count of tabs of front window'`
        ).catch(() => ({ stdout: '0' }));
        tabCount = parseInt(countOut) || 0;
      } else if (appNameProper.toLowerCase().includes('chrome')) {
        const { stdout: urlOut } = await execAsync(
          `osascript -e 'tell application "Google Chrome" to get URL of active tab of front window'`
        ).catch(() => ({ stdout: '' }));
        url = urlOut.trim();

        const { stdout: titleOut } = await execAsync(
          `osascript -e 'tell application "Google Chrome" to get title of active tab of front window'`
        ).catch(() => ({ stdout: '' }));
        title = titleOut.trim();

        const { stdout: countOut } = await execAsync(
          `osascript -e 'tell application "Google Chrome" to get count of tabs of front window'`
        ).catch(() => ({ stdout: '0' }));
        tabCount = parseInt(countOut) || 0;
      }

      return {
        type: 'browser',
        url,
        title,
        tabCount,
        domain: url ? new URL(url).hostname : '',
      };
    } catch (error) {
      return { type: 'browser', error: error.message };
    }
  }

  /**
   * Get Finder state
   */
  async getFinderState() {
    try {
      const { stdout: folder } = await execAsync(
        `osascript -e 'tell application "Finder" to get POSIX path of (target of front window as alias)'`
      ).catch(() => ({ stdout: '' }));

      const { stdout: selection } = await execAsync(
        `osascript -e 'tell application "Finder" to get name of selection'`
      ).catch(() => ({ stdout: '' }));

      const { stdout: windowCount } = await execAsync(
        `osascript -e 'tell application "Finder" to get count of windows'`
      ).catch(() => ({ stdout: '0' }));

      return {
        type: 'finder',
        currentFolder: folder.trim(),
        selection: selection
          .trim()
          .split(', ')
          .filter((s) => s),
        windowCount: parseInt(windowCount) || 0,
      };
    } catch (error) {
      return { type: 'finder', error: error.message };
    }
  }

  /**
   * Get clipboard contents
   */
  async getClipboard() {
    try {
      const { stdout } = await execAsync(`pbpaste`);
      return {
        text: stdout.substring(0, 500), // Limit to 500 chars
        length: stdout.length,
        hasContent: stdout.length > 0,
      };
    } catch (_error) {
      return { text: '', length: 0, hasContent: false };
    }
  }

  /**
   * Get system settings (volume, etc.)
   */
  async getSystemSettings() {
    try {
      const { stdout: volume } = await execAsync(`osascript -e 'output volume of (get volume settings)'`).catch(() => ({
        stdout: '0',
      }));

      const { stdout: muted } = await execAsync(`osascript -e 'output muted of (get volume settings)'`).catch(() => ({
        stdout: 'false',
      }));

      return {
        volume: parseInt(volume) || 0,
        muted: muted.trim() === 'true',
      };
    } catch (_error) {
      return { volume: 0, muted: false };
    }
  }

  /**
   * Check specific files
   */
  async checkFiles(filePaths) {
    const results = {};

    for (const filePath of filePaths) {
      try {
        const { stdout: exists } = await execAsync(`test -e "${filePath}" && echo "exists" || echo "missing"`);

        if (exists.trim() === 'exists') {
          const { stdout: stat } = await execAsync(`stat -f "%z %m" "${filePath}"`);
          const [size, mtime] = stat.trim().split(' ');

          results[filePath] = {
            exists: true,
            size: parseInt(size),
            modified: new Date(parseInt(mtime) * 1000).toISOString(),
          };
        } else {
          results[filePath] = { exists: false };
        }
      } catch (error) {
        results[filePath] = { exists: false, error: error.message };
      }
    }

    return results;
  }

  /**
   * Generate diff between two states
   */
  diff(before, after) {
    const changes = [];
    const unchanged = [];

    // Compare frontmost app
    if (before.frontmostApp?.nameLower !== after.frontmostApp?.nameLower) {
      changes.push({
        category: 'frontmostApp',
        field: 'name',
        before: before.frontmostApp?.name,
        after: after.frontmostApp?.name,
        description: `Frontmost app changed from "${before.frontmostApp?.name}" to "${after.frontmostApp?.name}"`,
      });
    } else {
      unchanged.push({ category: 'frontmostApp', description: 'Frontmost app unchanged' });
    }

    // Compare processes
    const beforeProcs = new Set(before.processes || []);
    const afterProcs = new Set(after.processes || []);

    const newProcesses = [...afterProcs].filter((p) => !beforeProcs.has(p));
    const closedProcesses = [...beforeProcs].filter((p) => !afterProcs.has(p));

    if (newProcesses.length > 0) {
      changes.push({
        category: 'processes',
        field: 'new',
        before: null,
        after: newProcesses,
        description: `New processes: ${newProcesses.join(', ')}`,
      });
    }

    if (closedProcesses.length > 0) {
      changes.push({
        category: 'processes',
        field: 'closed',
        before: closedProcesses,
        after: null,
        description: `Closed processes: ${closedProcesses.join(', ')}`,
      });
    }

    // Compare app-specific states
    for (const [appName, afterState] of Object.entries(after.appStates || {})) {
      const beforeState = before.appStates?.[appName];

      if (!beforeState) {
        changes.push({
          category: 'appState',
          app: appName,
          field: 'new',
          before: null,
          after: afterState,
          description: `New app state captured for ${appName}`,
        });
        continue;
      }

      // Media app comparison
      if (afterState.type === 'media') {
        if (beforeState.playerState !== afterState.playerState) {
          changes.push({
            category: 'appState',
            app: appName,
            field: 'playerState',
            before: beforeState.playerState,
            after: afterState.playerState,
            description: `${appName} player state: ${beforeState.playerState} → ${afterState.playerState}`,
          });
        } else {
          unchanged.push({
            category: 'appState',
            app: appName,
            field: 'playerState',
            value: afterState.playerState,
            description: `${appName} player state unchanged: ${afterState.playerState}`,
          });
        }

        if (beforeState.track?.name !== afterState.track?.name) {
          changes.push({
            category: 'appState',
            app: appName,
            field: 'track',
            before: beforeState.track?.name,
            after: afterState.track?.name,
            description: `${appName} track changed: "${beforeState.track?.name}" → "${afterState.track?.name}"`,
          });
        }

        if (beforeState.volume !== afterState.volume) {
          changes.push({
            category: 'appState',
            app: appName,
            field: 'volume',
            before: beforeState.volume,
            after: afterState.volume,
            description: `${appName} volume: ${beforeState.volume} → ${afterState.volume}`,
          });
        }
      }

      // Browser comparison
      if (afterState.type === 'browser') {
        if (beforeState.url !== afterState.url) {
          changes.push({
            category: 'appState',
            app: appName,
            field: 'url',
            before: beforeState.url,
            after: afterState.url,
            description: `${appName} URL changed`,
          });
        }

        if (beforeState.tabCount !== afterState.tabCount) {
          changes.push({
            category: 'appState',
            app: appName,
            field: 'tabCount',
            before: beforeState.tabCount,
            after: afterState.tabCount,
            description: `${appName} tab count: ${beforeState.tabCount} → ${afterState.tabCount}`,
          });
        }
      }

      // Finder comparison
      if (afterState.type === 'finder') {
        if (beforeState.currentFolder !== afterState.currentFolder) {
          changes.push({
            category: 'appState',
            app: appName,
            field: 'currentFolder',
            before: beforeState.currentFolder,
            after: afterState.currentFolder,
            description: `Finder folder: ${beforeState.currentFolder} → ${afterState.currentFolder}`,
          });
        }
      }
    }

    // Compare clipboard
    if (before.clipboard?.text !== after.clipboard?.text) {
      changes.push({
        category: 'clipboard',
        field: 'text',
        before: before.clipboard?.text?.substring(0, 50),
        after: after.clipboard?.text?.substring(0, 50),
        description: 'Clipboard contents changed',
      });
    }

    // Compare system settings
    if (before.system?.volume !== after.system?.volume) {
      changes.push({
        category: 'system',
        field: 'volume',
        before: before.system?.volume,
        after: after.system?.volume,
        description: `System volume: ${before.system?.volume} → ${after.system?.volume}`,
      });
    }

    // Compare files
    if (before.files && after.files) {
      for (const [filePath, afterFile] of Object.entries(after.files)) {
        const beforeFile = before.files[filePath];

        if (!beforeFile?.exists && afterFile.exists) {
          changes.push({
            category: 'files',
            field: 'created',
            path: filePath,
            description: `File created: ${filePath}`,
          });
        } else if (beforeFile?.exists && !afterFile.exists) {
          changes.push({
            category: 'files',
            field: 'deleted',
            path: filePath,
            description: `File deleted: ${filePath}`,
          });
        } else if (beforeFile?.modified !== afterFile.modified) {
          changes.push({
            category: 'files',
            field: 'modified',
            path: filePath,
            before: beforeFile?.modified,
            after: afterFile.modified,
            description: `File modified: ${filePath}`,
          });
        }
      }
    }

    return {
      hasChanges: changes.length > 0,
      changeCount: changes.length,
      changes,
      unchanged,
      summary: this.generateDiffSummary(changes, unchanged),
    };
  }

  /**
   * Generate human-readable diff summary
   */
  generateDiffSummary(changes, _unchanged) {
    if (changes.length === 0) {
      return 'No changes detected in system state';
    }

    const lines = [`${changes.length} change(s) detected:`];
    for (const change of changes) {
      lines.push(`  - ${change.description}`);
    }

    return lines.join('\n');
  }

  /**
   * Format state for display
   */
  formatStateForDisplay(state, appName = null) {
    const lines = [];

    // Frontmost app
    lines.push(`Frontmost: ${state.frontmostApp?.name || 'Unknown'}`);

    // App-specific state
    if (appName && state.appStates?.[appName.toLowerCase()]) {
      const appState = state.appStates[appName.toLowerCase()];

      if (appState.type === 'media') {
        lines.push(`${appName}: ${appState.playerState}`);
        if (appState.track?.name) {
          lines.push(`  Track: "${appState.track.name}" by ${appState.track.artist}`);
          if (appState.track.position && appState.track.duration) {
            const pos = this.formatTime(appState.track.position);
            const dur = this.formatTime(appState.track.duration);
            lines.push(`  Position: ${pos} / ${dur}`);
          }
        }
        lines.push(`  Volume: ${appState.volume}%`);
      } else if (appState.type === 'browser') {
        lines.push(`${appName}: ${appState.title || 'No title'}`);
        lines.push(`  URL: ${appState.url || 'None'}`);
        lines.push(`  Tabs: ${appState.tabCount}`);
      } else if (appState.type === 'finder') {
        lines.push(`Finder: ${appState.currentFolder}`);
        lines.push(`  Windows: ${appState.windowCount}`);
      }
    } else {
      // Show all app states
      for (const [name, appState] of Object.entries(state.appStates || {})) {
        if (appState.type === 'media') {
          lines.push(`${name}: ${appState.playerState}${appState.track?.name ? ` - "${appState.track.name}"` : ''}`);
        } else if (appState.type === 'browser') {
          lines.push(`${name}: ${appState.tabCount} tabs`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Helper to format time in seconds to mm:ss
   */
  formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Helper to convert app name to proper case
   */
  toProperCase(str) {
    return str
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }
}

// Singleton instance
let instance = null;

function getSystemStateCapture() {
  if (!instance) {
    instance = new SystemStateCapture();
  }
  return instance;
}

module.exports = {
  SystemStateCapture,
  getSystemStateCapture,
};
