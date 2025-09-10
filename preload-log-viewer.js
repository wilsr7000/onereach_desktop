const { contextBridge, ipcRenderer } = require('electron');

// Set up console interceptor for log viewer
(function() {
  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };

  ['log', 'warn', 'error'].forEach(method => {
    const level = method === 'log' ? 'info' : method;
    console[method] = function(...args) {
      originalConsole[method](...args);
      const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
      try {
        ipcRenderer.send(`logger:${level}`, {
          message: `[Console.${method}] ${message}`,
          data: { window: 'Event Log Viewer', consoleMethod: method }
        });
      } catch (err) {}
    };
  });
})();

contextBridge.exposeInMainWorld('logViewer', {
    // Get recent logs
    getRecentLogs: async (count) => {
        return await ipcRenderer.invoke('logger:get-recent-logs', count);
    },
    
    // Get log statistics
    getLogStats: async () => {
        return await ipcRenderer.invoke('logger:get-stats');
    },
    
    // Export logs
    exportLogs: async (options) => {
        return await ipcRenderer.invoke('logger:export', options);
    },
    
    // Get log files
    getLogFiles: async () => {
        return await ipcRenderer.invoke('logger:get-files');
    },
    
    // Clear logs (if needed)
    clearLogs: async () => {
        return await ipcRenderer.invoke('logger:clear');
    },
    
    // AI Analysis functions
    analyzeLogsWithAI: async (options) => {
        return await ipcRenderer.invoke('ai:analyze-logs', options);
    },
    
    // Generate Cursor prompt from analysis
    generateCursorPrompt: async (analysis) => {
        return await ipcRenderer.invoke('ai:generate-cursor-prompt', analysis);
    }
}); 