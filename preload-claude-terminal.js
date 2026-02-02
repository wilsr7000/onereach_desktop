/**
 * Preload script for Claude Code Terminal window
 * 
 * Provides IPC bridge for PTY communication
 */

const { contextBridge, ipcRenderer } = require('electron');

// Callbacks for output and exit
let onDataCallback = null;
let onExitCallback = null;

// Listen for PTY output
ipcRenderer.on('claude-terminal:output', (event, data) => {
  if (onDataCallback) {
    onDataCallback(data);
  }
});

// Listen for PTY exit
ipcRenderer.on('claude-terminal:exit', (event, code) => {
  if (onExitCallback) {
    onExitCallback(code);
  }
});

contextBridge.exposeInMainWorld('claudeTerminal', {
  /**
   * Start Claude Code PTY
   * @param {number} cols - Terminal columns
   * @param {number} rows - Terminal rows
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  start: (cols, rows) => ipcRenderer.invoke('claude-terminal:start', cols, rows),
  
  /**
   * Write data to PTY
   * @param {string} data - Data to write
   */
  write: (data) => ipcRenderer.send('claude-terminal:write', data),
  
  /**
   * Resize PTY
   * @param {number} cols - New columns
   * @param {number} rows - New rows
   */
  resize: (cols, rows) => ipcRenderer.send('claude-terminal:resize', cols, rows),
  
  /**
   * Kill the PTY process
   */
  kill: () => ipcRenderer.send('claude-terminal:kill'),
  
  /**
   * Register callback for PTY output
   * @param {Function} callback - Callback receiving data string
   */
  onData: (callback) => {
    onDataCallback = callback;
  },
  
  /**
   * Register callback for PTY exit
   * @param {Function} callback - Callback receiving exit code
   */
  onExit: (callback) => {
    onExitCallback = callback;
  },
  
  /**
   * Check Claude Code authentication status
   * @returns {Promise<{ authenticated: boolean, error?: string }>}
   */
  checkAuth: () => ipcRenderer.invoke('claude-code:check-auth'),
});

console.log('[preload-claude-terminal] Exposed claudeTerminal API');
