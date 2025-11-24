const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, dialog } = require('electron');
const unzipper = require('unzipper');
const https = require('https');
const http = require('http');

class ModuleManager {
  constructor() {
    this.modulesPath = path.join(app.getPath('userData'), 'modules');
    this.modulesDataPath = path.join(app.getPath('userData'), 'modules-data');
    this.installedModules = new Map();
    this.moduleWindows = new Map();
    
    // Ensure directories exist
    this.ensureDirectories();
    
    // Load installed modules on startup
    this.loadInstalledModules();
  }
  
  ensureDirectories() {
    if (!fs.existsSync(this.modulesPath)) {
      fs.mkdirSync(this.modulesPath, { recursive: true });
    }
    if (!fs.existsSync(this.modulesDataPath)) {
      fs.mkdirSync(this.modulesDataPath, { recursive: true });
    }
  }
  
  async loadInstalledModules() {
    try {
      const modulesDirs = fs.readdirSync(this.modulesPath);
      
      for (const dir of modulesDirs) {
        const modulePath = path.join(this.modulesPath, dir);
        const manifestPath = path.join(modulePath, 'manifest.json');
        
        if (fs.existsSync(manifestPath)) {
          try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            manifest.path = modulePath;
            this.installedModules.set(manifest.id, manifest);
            console.log(`Loaded module: ${manifest.name} (${manifest.id})`);
            
            // Load main process script if exists
            if (manifest.mainProcess) {
              const mainScriptPath = path.join(modulePath, manifest.mainProcess);
              if (fs.existsSync(mainScriptPath)) {
                try {
                  require(mainScriptPath);
                  console.log(`Loaded main process script for ${manifest.id}`);
                } catch (error) {
                  console.error(`Error loading main process script for ${manifest.id}:`, error);
                }
              }
            }
          } catch (error) {
            console.error(`Error loading module from ${dir}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('Error loading installed modules:', error);
    }
  }
  
  async installModuleFromUrl(url) {
    return new Promise((resolve, reject) => {
      const tempPath = path.join(app.getPath('temp'), `module-${Date.now()}.zip`);
      const file = fs.createWriteStream(tempPath);
      
      const protocol = url.startsWith('https') ? https : http;
      
      console.log(`Downloading module from: ${url}`);
      
      const request = protocol.get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: ${response.statusCode}`));
          return;
        }
        
        response.pipe(file);
        
        file.on('finish', () => {
          file.close(async () => {
            try {
              const result = await this.installModuleFromZip(tempPath);
              // Clean up temp file
              fs.unlinkSync(tempPath);
              resolve(result);
            } catch (error) {
              // Clean up temp file on error
              if (fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
              }
              reject(error);
            }
          });
        });
      });
      
      request.on('error', (error) => {
        fs.unlinkSync(tempPath);
        reject(error);
      });
    });
  }
  
  async installModuleFromZip(zipPath) {
    console.log(`Installing module from: ${zipPath}`);
    
    // First, extract to temp directory to validate
    const tempExtractPath = path.join(app.getPath('temp'), `module-extract-${Date.now()}`);
    
    try {
      // Extract zip
      await fs.createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: tempExtractPath }))
        .promise();
      
      // Read and validate manifest
      const manifestPath = path.join(tempExtractPath, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        throw new Error('No manifest.json found in module');
      }
      
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      
      // Validate required fields
      if (!manifest.id || !manifest.name || !manifest.main) {
        throw new Error('Invalid manifest: missing required fields (id, name, main)');
      }
      
      // Check if module already exists
      const moduleInstallPath = path.join(this.modulesPath, manifest.id);
      if (fs.existsSync(moduleInstallPath)) {
        // Optional: Handle updates here
        const response = await dialog.showMessageBox({
          type: 'question',
          buttons: ['Update', 'Cancel'],
          defaultId: 0,
          message: `Module "${manifest.name}" is already installed. Update it?`
        });
        
        if (response.response !== 0) {
          throw new Error('Installation cancelled');
        }
        
        // Remove old version
        this.removeModule(manifest.id);
      }
      
      // Move to final location
      fs.renameSync(tempExtractPath, moduleInstallPath);
      
      // Create data directory for module
      const moduleDataPath = path.join(this.modulesDataPath, manifest.dataDirectory || manifest.id);
      if (!fs.existsSync(moduleDataPath)) {
        fs.mkdirSync(moduleDataPath, { recursive: true });
      }
      
      // Install npm dependencies if package.json exists
      const packageJsonPath = path.join(moduleInstallPath, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        console.log(`Installing npm dependencies for ${manifest.id}...`);
        const { exec } = require('child_process');
        await new Promise((resolve, reject) => {
          exec('npm install --production', { cwd: moduleInstallPath }, (error, stdout, stderr) => {
            if (error) {
              console.error(`Error installing dependencies: ${error}`);
              reject(error);
            } else {
              console.log(`Dependencies installed for ${manifest.id}`);
              resolve();
            }
          });
        });
      }
      
      // Add to installed modules
      manifest.path = moduleInstallPath;
      this.installedModules.set(manifest.id, manifest);
      
      // Load main process script if exists
      if (manifest.mainProcess) {
        const mainScriptPath = path.join(moduleInstallPath, manifest.mainProcess);
        if (fs.existsSync(mainScriptPath)) {
          try {
            require(mainScriptPath);
            console.log(`Loaded main process script for ${manifest.id}`);
          } catch (error) {
            console.error(`Error loading main process script for ${manifest.id}:`, error);
          }
        }
      }
      
      // Update menu
      this.updateApplicationMenu();
      
      console.log(`Successfully installed module: ${manifest.name}`);
      return manifest;
      
    } catch (error) {
      // Clean up on error
      if (fs.existsSync(tempExtractPath)) {
        fs.rmSync(tempExtractPath, { recursive: true, force: true });
      }
      throw error;
    }
  }
  
  removeModule(moduleId) {
    const module = this.installedModules.get(moduleId);
    if (!module) {
      throw new Error(`Module ${moduleId} not found`);
    }
    
    // Close any open windows for this module
    const window = this.moduleWindows.get(moduleId);
    if (window && !window.isDestroyed()) {
      window.close();
    }
    
    // Remove module directory
    if (fs.existsSync(module.path)) {
      fs.rmSync(module.path, { recursive: true, force: true });
    }
    
    // Remove from installed modules
    this.installedModules.delete(moduleId);
    
    // Update menu
    this.updateApplicationMenu();
    
    console.log(`Removed module: ${module.name}`);
  }
  
  openModule(moduleId) {
    const module = this.installedModules.get(moduleId);
    if (!module) {
      console.error(`Module ${moduleId} not found`);
      return;
    }
    
    // Check if window already exists
    let window = this.moduleWindows.get(moduleId);
    if (window && !window.isDestroyed()) {
      window.focus();
      return;
    }
    
    // Create new window
    const windowOptions = {
      width: 1200,
      height: 800,
      title: module.name,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        webSecurity: false
      },
      ...module.windowOptions
    };
    
    // Add preload script if specified
    if (module.preload) {
      windowOptions.webPreferences.preload = path.join(module.path, module.preload);
    }
    
    // Set icon if exists
    if (module.icon) {
      const iconPath = path.join(module.path, module.icon);
      if (fs.existsSync(iconPath)) {
        windowOptions.icon = iconPath;
      }
    }
    
    window = new BrowserWindow(windowOptions);
    
    // Store window reference
    this.moduleWindows.set(moduleId, window);
    
    // Clean up reference when window is closed
    window.on('closed', () => {
      this.moduleWindows.delete(moduleId);
    });
    
    // Make module data path available to the module
    window.moduleDataPath = path.join(this.modulesDataPath, module.dataDirectory || moduleId);
    window.moduleInfo = module;
    
    // Inject module API client when DOM is ready
    window.webContents.on('dom-ready', () => {
      // Read the module API client file
      const apiClientPath = path.join(__dirname, 'module-api-client.js');
      if (fs.existsSync(apiClientPath)) {
        const apiClientCode = fs.readFileSync(apiClientPath, 'utf8');
        
        // Inject the API client code
        window.webContents.executeJavaScript(`
          // Inject module data path
          window.moduleDataPath = ${JSON.stringify(window.moduleDataPath)};
          window.moduleInfo = ${JSON.stringify(module)};
          
          // Inject module API client
          ${apiClientCode}
          
          console.log('Module API client injected successfully');
        `).catch(error => {
          console.error('Error injecting module API client:', error);
        });
      }
    });
    
    // Load module HTML
    const htmlPath = path.join(module.path, module.main);
    window.loadFile(htmlPath);
    
    console.log(`Opened module: ${module.name}`);
  }
  
  getModuleMenuItems() {
    const items = [];
    
    for (const [id, module] of this.installedModules) {
      items.push({
        label: module.menuLabel || module.name,
        click: () => this.openModule(id)
      });
    }
    
    return items;
  }
  
  getWebToolMenuItems() {
    const items = [];
    const webTools = this.loadWebTools();
    
    for (const tool of webTools) {
      items.push({
        label: tool.name,
        click: () => this.openWebTool(tool.id)
      });
    }
    
    return items;
  }
  
  updateApplicationMenu() {
    // This will be called to refresh the app menu with module items
    // The main app will need to integrate this
    if (global.updateApplicationMenu) {
      global.updateApplicationMenu();
    }
  }
  
  // Get list of all installed modules
  getInstalledModules() {
    return Array.from(this.installedModules.values());
  }
  
  // Get module data directory path
  getModuleDataPath(moduleId) {
    const module = this.installedModules.get(moduleId);
    if (!module) {
      return null;
    }
    return path.join(this.modulesDataPath, module.dataDirectory || moduleId);
  }
  
  // Web Tools Management
  getWebToolsPath() {
    return path.join(app.getPath('userData'), 'web-tools.json');
  }
  
  loadWebTools() {
    try {
      const webToolsPath = this.getWebToolsPath();
      if (fs.existsSync(webToolsPath)) {
        return JSON.parse(fs.readFileSync(webToolsPath, 'utf8'));
      }
    } catch (error) {
      console.error('Error loading web tools:', error);
    }
    return [];
  }
  
  saveWebTools(tools) {
    try {
      const webToolsPath = this.getWebToolsPath();
      fs.writeFileSync(webToolsPath, JSON.stringify(tools, null, 2));
      return true;
    } catch (error) {
      console.error('Error saving web tools:', error);
      return false;
    }
  }
  
  getWebTools() {
    return this.loadWebTools();
  }
  
  addWebTool(tool) {
    const tools = this.loadWebTools();
    tools.push(tool);
    this.saveWebTools(tools);
    this.updateApplicationMenu();
    return tool;
  }
  
  openWebTool(toolId) {
    const tools = this.loadWebTools();
    const tool = tools.find(t => t.id === toolId);
    
    if (!tool) {
      throw new Error(`Web tool not found: ${toolId}`);
    }
    
    // Get screen dimensions
    const { screen } = require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
    
    // Define window sizes
    const windowSizes = {
      fullscreen: { width: screenWidth, height: screenHeight },
      large: { width: 1400, height: 900 },
      medium: { width: 1200, height: 800 },
      small: { width: 1000, height: 700 },
      mobile: { width: 375, height: 812 }
    };
    
    // Get the selected window size or default to medium
    const size = windowSizes[tool.windowSize] || windowSizes.medium;
    
    // Create new window for the web tool
    const window = new BrowserWindow({
      width: size.width,
      height: size.height,
      title: tool.name,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        preload: path.join(__dirname, 'preload.js')
      }
    });
    
    // Center the window for non-fullscreen sizes
    if (tool.windowSize !== 'fullscreen') {
      window.center();
    }
    
    // Inject the minimal toolbar after page loads
    window.webContents.on('did-finish-load', () => {
      window.webContents.executeJavaScript(`
        (function() {
          // Check if toolbar already exists
          if (document.getElementById('gsx-minimal-toolbar')) return;
          
          // Create toolbar
          const toolbar = document.createElement('div');
          toolbar.id = 'gsx-minimal-toolbar';
          toolbar.innerHTML = \`
            <button id="gsx-back" title="Back">◀</button>
            <button id="gsx-forward" title="Forward">▶</button>
            <button id="gsx-refresh" title="Refresh">↻</button>
            <button id="gsx-mission-control" title="Show All Windows">⊞</button>
          \`;
          
          // Add styles
          const style = document.createElement('style');
          style.textContent = \`
            #gsx-minimal-toolbar {
              position: fixed;
              bottom: 0;
              left: 50%;
              transform: translateX(-50%);
              z-index: 999999;
              background: rgba(0, 0, 0, 0.6);
              backdrop-filter: blur(8px);
              padding: 4px 8px;
              display: flex;
              gap: 4px;
              border-radius: 8px 8px 0 0;
              opacity: 0.4;
              transition: opacity 0.3s, padding 0.2s;
            }
            
            #gsx-minimal-toolbar:hover {
              opacity: 1;
              padding: 6px 10px;
            }
            
            #gsx-minimal-toolbar button {
              background: transparent;
              border: none;
              color: rgba(255, 255, 255, 0.7);
              width: 28px;
              height: 28px;
              border-radius: 4px;
              cursor: pointer;
              font-size: 14px;
              display: flex;
              align-items: center;
              justify-content: center;
              transition: all 0.2s;
            }
            
            #gsx-minimal-toolbar button:hover {
              background: rgba(255, 255, 255, 0.15);
              color: rgba(255, 255, 255, 1);
              transform: scale(1.1);
            }
            
            #gsx-minimal-toolbar button:active {
              transform: scale(0.95);
            }
            
            #gsx-minimal-toolbar button:disabled {
              opacity: 0.3;
              cursor: not-allowed;
            }
          \`;
          
          document.head.appendChild(style);
          document.body.appendChild(toolbar);
          
          // Add event listeners
          document.getElementById('gsx-back').addEventListener('click', () => {
            window.history.back();
          });
          
          document.getElementById('gsx-forward').addEventListener('click', () => {
            window.history.forward();
          });
          
          document.getElementById('gsx-refresh').addEventListener('click', () => {
            window.location.reload();
          });
          
          document.getElementById('gsx-mission-control').addEventListener('click', () => {
            // This will be handled by IPC
            if (window.electronAPI && window.electronAPI.triggerMissionControl) {
              window.electronAPI.triggerMissionControl();
            }
          });
          
          // Update button states based on history
          function updateNavigationButtons() {
            const backBtn = document.getElementById('gsx-back');
            const forwardBtn = document.getElementById('gsx-forward');
            
            if (backBtn) backBtn.disabled = !window.history.length || window.history.length <= 1;
            if (forwardBtn) forwardBtn.disabled = false;
          }
          
          updateNavigationButtons();
          window.addEventListener('popstate', updateNavigationButtons);
        })();
      `).catch(err => console.error('[Web Tool] Error injecting toolbar:', err));
    });
    
    window.loadURL(tool.url);
    console.log(`Opened web tool: ${tool.name} (${tool.url}) - Size: ${tool.windowSize || 'medium'}`);
  }
  
  deleteWebTool(toolId) {
    const tools = this.loadWebTools();
    const filteredTools = tools.filter(t => t.id !== toolId);
    
    if (tools.length === filteredTools.length) {
      throw new Error(`Web tool not found: ${toolId}`);
    }
    
    this.saveWebTools(filteredTools);
    this.updateApplicationMenu();
    return true;
  }
}

module.exports = ModuleManager; 