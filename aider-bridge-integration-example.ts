/**
 * Example: Integrating Aider Bridge into main.js
 */

// In main.js, add at the top:
const { AiderBridgeClient } = require('./aider-bridge-client');

// Global instance
let aiderBridge: AiderBridgeClient | null = null;

// Setup IPC handlers
function setupAiderIPC() {
  const { ipcMain } = require('electron');
  
  // Start Aider
  ipcMain.handle('aider:start', async () => {
    try {
      if (!aiderBridge) {
        aiderBridge = new AiderBridgeClient();
        await aiderBridge.start();
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  
  // Initialize with repo
  ipcMain.handle('aider:initialize', async (event, repoPath, modelName) => {
    try {
      if (!aiderBridge) {
        throw new Error('Aider not started');
      }
      const result = await aiderBridge.initialize(repoPath, modelName);
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  
  // Run prompt
  ipcMain.handle('aider:run-prompt', async (event, message) => {
    try {
      if (!aiderBridge) {
        throw new Error('Aider not started');
      }
      const result = await aiderBridge.runPrompt(message);
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  
  // Add files
  ipcMain.handle('aider:add-files', async (event, filePaths) => {
    try {
      if (!aiderBridge) {
        throw new Error('Aider not started');
      }
      const result = await aiderBridge.addFiles(filePaths);
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  
  // Remove files
  ipcMain.handle('aider:remove-files', async (event, filePaths) => {
    try {
      if (!aiderBridge) {
        throw new Error('Aider not started');
      }
      const result = await aiderBridge.removeFiles(filePaths);
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  
  // Get repo map
  ipcMain.handle('aider:get-repo-map', async () => {
    try {
      if (!aiderBridge) {
        throw new Error('Aider not started');
      }
      const result = await aiderBridge.getRepoMap();
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  
  // Shutdown
  ipcMain.handle('aider:shutdown', async () => {
    try {
      if (aiderBridge) {
        await aiderBridge.shutdown();
        aiderBridge = null;
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}

// Call in app ready:
app.on('ready', () => {
  // ... existing code ...
  setupAiderIPC();
});

// Cleanup on quit:
app.on('before-quit', async () => {
  if (aiderBridge) {
    await aiderBridge.shutdown();
  }
});

/**
 * Example: Using in renderer/preload
 */

// In preload.js, expose to renderer:
contextBridge.exposeInMainWorld('aider', {
  start: () => ipcRenderer.invoke('aider:start'),
  initialize: (repoPath: string, modelName?: string) => 
    ipcRenderer.invoke('aider:initialize', repoPath, modelName),
  runPrompt: (message: string) => 
    ipcRenderer.invoke('aider:run-prompt', message),
  addFiles: (filePaths: string[]) => 
    ipcRenderer.invoke('aider:add-files', filePaths),
  removeFiles: (filePaths: string[]) => 
    ipcRenderer.invoke('aider:remove-files', filePaths),
  getRepoMap: () => 
    ipcRenderer.invoke('aider:get-repo-map'),
  shutdown: () => 
    ipcRenderer.invoke('aider:shutdown')
});

/**
 * Example: Using in renderer HTML/JS
 */

// <script>
async function initAider() {
  // Start Aider
  await window.aider.start();
  
  // Initialize with current project
  const result = await window.aider.initialize('/path/to/project', 'gpt-4');
  console.log('Aider initialized:', result);
  
  // Add files to context
  await window.aider.addFiles([
    'src/main.ts',
    'src/utils.ts'
  ]);
  
  // Send prompt
  const response = await window.aider.runPrompt(
    'Add TypeScript types to all functions in utils.ts'
  );
  
  if (response.success) {
    console.log('AI Response:', response.response);
    console.log('Modified:', response.modified_files);
  }
}
// </script>

