const { app, Menu, shell, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

/**
 * Creates and returns the application menu
 * @param {boolean} showTestMenu Whether to show the test menu
 * @param {Array} idwEnvironments Array of IDW environments to create menu items for
 * @returns {Menu} The application menu
 */
function createMenu(showTestMenu = false, idwEnvironments = []) {
  console.log('[Menu] Creating application menu...');
  const isMac = process.platform === 'darwin';
  
  // --- IDW Environment Loading ---
  console.log('[Menu] Attempting to load IDW environments...');
  if (!idwEnvironments || !idwEnvironments.length) {
    console.log('[Menu] No IDW environments passed as argument, attempting to load from file.');
    try {
      // Explicitly require app here if not available globally
      const electronApp = require('electron').app; 
      const userDataPath = electronApp.getPath('userData');
      const idwConfigPath = path.join(userDataPath, 'idw-entries.json');
      console.log(`[Menu] Checking for IDW config at: ${idwConfigPath}`);
      
      if (fs.existsSync(idwConfigPath)) {
        console.log('[Menu] Found idw-entries.json.');
        try {
          const data = fs.readFileSync(idwConfigPath, 'utf8');
          idwEnvironments = JSON.parse(data);
          console.log('[Menu] Successfully parsed idw-entries.json:', JSON.stringify(idwEnvironments, null, 2));
        } catch (error) {
          console.error('[Menu] Error parsing idw-entries.json:', error);
          idwEnvironments = []; // Reset to empty if parsing fails
        }
      } else {
        console.log('[Menu] idw-entries.json not found.');
        idwEnvironments = [];
      }
    } catch (error) {
      console.error('[Menu] Error reading IDW environments from file:', error);
      idwEnvironments = [];
    }
  } else {
    console.log('[Menu] Using IDW environments passed as argument:', JSON.stringify(idwEnvironments, null, 2));
  }
  
  // --- GSX Link Loading ---
  let allGsxLinks = [];
  try {
    const electronApp = require('electron').app;
    const userDataPath = electronApp.getPath('userData');
    const gsxConfigPath = path.join(userDataPath, 'gsx-links.json');
    console.log(`[Menu] Checking for GSX config at: ${gsxConfigPath}`);
    if (fs.existsSync(gsxConfigPath)) {
      console.log('[Menu] Found gsx-links.json.');
      try {
        const data = fs.readFileSync(gsxConfigPath, 'utf8');
        allGsxLinks = JSON.parse(data);
        console.log('[Menu] Successfully parsed gsx-links.json:', JSON.stringify(allGsxLinks, null, 2));
        
        // DEBUG: Check if GSX link URLs contain the expected environment names
        console.log('[Menu] Checking if GSX URLs contain environment names from IDW environments:');
        if (idwEnvironments && idwEnvironments.length > 0) {
          idwEnvironments.forEach(env => {
            if (env.environment) {
              console.log(`[Menu] IDW environment '${env.label}' has environment name: '${env.environment}'`);
              
              // Check each GSX link against this environment
              allGsxLinks.forEach(link => {
                if (link.url) {
                  try {
                    const url = new URL(link.url);
                    const hostname = url.hostname;
                    const matches = hostname.includes(env.environment);
                    console.log(`[Menu] GSX URL '${hostname}' includes '${env.environment}'? ${matches}`);
                  } catch (e) {
                    console.warn(`[Menu] Invalid GSX URL: ${link.url}`);
                  }
                }
              });
            } else {
              console.warn(`[Menu] IDW environment '${env.label}' does not have an environment property`);
            }
          });
        }
      } catch (error) {
        console.error('[Menu] Error parsing gsx-links.json:', error);
        allGsxLinks = [];
      }
    } else {
      console.log('[Menu] gsx-links.json not found – generating default links');
      
      // Load user preferences to get GSX account ID
      let gsxAccountId = '';
      try {
        const prefsPath = path.join(userDataPath, 'user-preferences.json');
        if (fs.existsSync(prefsPath)) {
          const prefsData = fs.readFileSync(prefsPath, 'utf8');
          const userPrefs = JSON.parse(prefsData);
          if (userPrefs.gsxAccountId) {
            gsxAccountId = userPrefs.gsxAccountId;
            console.log('[Menu] Found GSX Account ID in user preferences:', gsxAccountId);
          }
        }
      } catch (error) {
        console.error('[Menu] Error loading user preferences for GSX account ID:', error);
      }
      
      allGsxLinks = generateDefaultGSXLinks(idwEnvironments, gsxAccountId);
      if (allGsxLinks.length) {
        try {
          fs.writeFileSync(gsxConfigPath, JSON.stringify(allGsxLinks, null, 2));
          console.log(`[Menu] Wrote ${allGsxLinks.length} default GSX links to`, gsxConfigPath);
        } catch (err) {
          console.error('[Menu] Failed to write default GSX links:', err);
        }
      }
    }
  } catch (error) {
    console.error('[Menu] Error reading GSX links from file:', error);
    allGsxLinks = [];
  }

  // --- Menu Item Creation ---
  const idwMenuItems = [];
  const gsxMenuItems = [];
  
  // Get userDataPath for loading external bots
  const electronApp = require('electron').app;
  const userDataPath = electronApp.getPath('userData');
  
  // Load external bots
  let externalBots = [];
  try {
    const botsPath = path.join(userDataPath, 'external-bots.json');
    if (fs.existsSync(botsPath)) {
      const botsData = fs.readFileSync(botsPath, 'utf8');
      externalBots = JSON.parse(botsData);
      console.log(`[Menu] Loaded ${externalBots.length} external bots`);
    }
  } catch (error) {
    console.error('[Menu] Error loading external bots:', error);
  }
  
  // Load image creators
  let imageCreators = [];
  try {
    const creatorsPath = path.join(userDataPath, 'image-creators.json');
    if (fs.existsSync(creatorsPath)) {
      const creatorsData = fs.readFileSync(creatorsPath, 'utf8');
      imageCreators = JSON.parse(creatorsData);
      console.log(`[Menu] Loaded ${imageCreators.length} image creators`);
    }
  } catch (error) {
    console.error('[Menu] Error loading image creators:', error);
  }
  
  // Load video creators
  let videoCreators = [];
  try {
    const videoCreatorsPath = path.join(userDataPath, 'video-creators.json');
    if (fs.existsSync(videoCreatorsPath)) {
      const videoCreatorsData = fs.readFileSync(videoCreatorsPath, 'utf8');
      videoCreators = JSON.parse(videoCreatorsData);
      console.log(`[Menu] Loaded ${videoCreators.length} video creators`);
    }
  } catch (error) {
    console.error('[Menu] Error loading video creators:', error);
  }
  
  // Load audio generators
  let audioGenerators = [];
  try {
    const audioGeneratorsPath = path.join(userDataPath, 'audio-generators.json');
    if (fs.existsSync(audioGeneratorsPath)) {
      const audioGeneratorsData = fs.readFileSync(audioGeneratorsPath, 'utf8');
      audioGenerators = JSON.parse(audioGeneratorsData);
      console.log(`[Menu] Loaded ${audioGenerators.length} audio generators`);
    }
  } catch (error) {
    console.error('[Menu] Error loading audio generators:', error);
  }
  
  // === NEW: Load UI Design tools ===
  let uiDesignTools = [];
  try {
    const uiDesignToolsPath = path.join(userDataPath, 'ui-design-tools.json');
    if (fs.existsSync(uiDesignToolsPath)) {
      const uiDesignToolsData = fs.readFileSync(uiDesignToolsPath, 'utf8');
      uiDesignTools = JSON.parse(uiDesignToolsData);
      console.log(`[Menu] Loaded ${uiDesignTools.length} UI design tools`);
    }
  } catch (error) {
    console.error('[Menu] Error loading UI design tools:', error);
  }
  
  console.log('[Menu] Processing IDW environments to create menu items...');
  if (idwEnvironments && idwEnvironments.length > 0) {
    idwEnvironments.forEach((env, index) => {
      console.log(`[Menu] Processing IDW Env ${index + 1}: Label='${env.label}', URL='${env.chatUrl}', Environment='${env.environment}'`);
      if (!env.label || !env.chatUrl || !env.environment) {
        console.warn(`[Menu] Skipping IDW Env ${index + 1} due to missing properties.`);
        return; // Skip this environment if essential properties are missing
      }

      // --- IDW Menu Item ---
      // Add keyboard shortcuts for the first 9 IDWs (Cmd+1 through Cmd+9)
      const accelerator = index < 9 ? `CmdOrCtrl+${index + 1}` : undefined;
      
      idwMenuItems.push({
        label: env.label,
        accelerator: accelerator,
        click: (menuItem, browserWindow) => {
          // Log that we're handling the IDW environment click
          console.log(`[Menu Click] IDW menu item clicked: ${env.label}`);
          
          if (browserWindow) {
            console.log(`[Menu Click] Opening IDW environment chat in main window: ${env.chatUrl}`);
            
            // Emit the action directly in the main process
            ipcMain.emit('menu-action', null, {
              action: 'open-idw-url',
              url: env.chatUrl,
              label: env.label
            });
          } else {
            // If no browser window, try using shell to open the URL
            console.log(`[Menu Click] Opening IDW environment chat in external browser: ${env.chatUrl}`);
            const { shell } = require('electron');
            shell.openExternal(env.chatUrl);
          }
        }
      });

      // --- GSX Submenu Item ---
      const gsxSubmenu = [];
      console.log(`[Menu] Filtering GSX links for environment: '${env.environment}'`);
      
      // Filter GSX links for this environment
      const gsxLinks = allGsxLinks.filter(link => {
        if (!link.url || !link.label) {
            console.warn(`[Menu] Skipping GSX link due to missing properties:`, link);
            return false;
        }
        
        // CRITICAL: Special handling for custom links - MUST match exactly the IDW ID
        if (link.custom === true) {
          // Debug detailed link information for custom links
          console.log(`[Menu] Evaluating custom link: ID=${link.id}, Label=${link.label}`);
          console.log(`[Menu] Custom link properties: idwId=${link.idwId || 'none'}, env.id=${env.id || 'none'}`);
          
          // This is the critical check - custom links MUST have a matching idwId
          // If link has no idwId, it cannot appear in ANY menu
          if (!link.idwId) {
            console.log(`[Menu] Custom link ${link.id} has no idwId, excluding from all menus`);
            return false;
          }
          
          // Make sure both env.id and link.idwId exist before comparison
          if (!env.id) {
            console.log(`[Menu] Environment ${env.label} has no id, cannot match custom links`);
            return false;
          }
          
          // Convert both to strings for comparison to ensure proper matching
          const linkIdwId = String(link.idwId).trim();
          const envId = String(env.id).trim();
          
          // Strict equality check between link's idwId and environment id
          const idMatch = linkIdwId === envId;
          console.log(`[Menu] Custom link IDW match check: '${linkIdwId}' === '${envId}' = ${idMatch}`);
          
          // Add fallback for legacy links before returning
          if (!idMatch && link.environment && env.environment && 
              link.environment.toLowerCase() === env.environment.toLowerCase()) {
            console.log(`[Menu] Custom link ${link.id} matches environment name as fallback: ${link.environment}`);
            return true;
          }
          
          return idMatch;
        }
        
        // For standard links, use environment + idwId matching to avoid duplicates
        if (link.environment && env.environment &&
            link.environment.toLowerCase() === env.environment.toLowerCase()) {
          // If link has idwId, it MUST match the env.id exactly
          // If link has no idwId, it's a legacy link that can match by environment only
          if (link.idwId) {
            // Link has idwId - strict matching required
            if (env.id && link.idwId === env.id) {
              console.log(`[Menu] Standard link matches by idwId: ${link.label} (env=${link.environment}, idwId=${link.idwId})`);
              return true;
            } else {
              // Link has idwId but it doesn't match this IDW - skip it
              return false;
            }
          } else {
            // Legacy link without idwId - allow environment-only match
            console.log(`[Menu] Legacy link matches by environment only: ${link.label} (env=${link.environment})`);
            return true;
          }
        }
        
        // URL-based matching should only apply to links WITHOUT idwId (legacy links)
        // If a link has idwId, it should have already matched above or been rejected
        if (link.idwId) {
          // Link has idwId but didn't match above - don't try URL matching
          return false;
        }
        
        try {
            const url = new URL(link.url);
            // More flexible matching to handle different environment naming patterns
            let match = false;
            
            // Direct environment name matching in hostname
            if (env.environment && url.hostname.includes(env.environment)) {
                console.log(`[Menu] GSX link URL hostname includes environment: hostname='${url.hostname}', env='${env.environment}'`);
                match = true;
            }
            
            // Also check if no specific environment in the URL (generic GSX links)
            // This helps with links like 'https://hitl.onereach.ai/' without environment
            if (!match && !url.hostname.includes('staging.') && 
                !url.hostname.includes('edison.') && 
                !url.hostname.includes('production.')) {
                console.log(`[Menu] GSX URL '${url.hostname}' has no environment prefix, including it for all environments`);
                match = true;
            }
            
            console.log(`[Menu] Checking GSX link: URL='${link.url}', Host='${url.hostname}', Matches Env='${env.environment}'? ${match}`);
            return match;
        } catch (e) {
            console.warn(`[Menu] Skipping GSX link due to invalid URL '${link.url}':`, e);
            return false;
        }
      });
      console.log(`[Menu] Found ${gsxLinks.length} matching GSX links for '${env.label}'`);

      // Add GSX links as submenu items
      if (gsxLinks && gsxLinks.length > 0) {
        gsxLinks.forEach((link, linkIndex) => {
           console.log(`[Menu] Adding GSX submenu item ${linkIndex + 1}: Label='${link.label}', URL='${link.url}'`);
          gsxSubmenu.push({
            label: link.label,
            click: async () => {
              console.log(`[Menu Click] GSX menu item clicked: ${link.label} (URL: ${link.url}, Env: ${env.environment})`);
              try {
                // Use the browserWindow.openGSXWindow method directly
                console.log('[Menu Click] Attempting to call openGSXWindow...');
                const { openGSXWindow } = require('./browserWindow');
                // Pass the environment name to create truly isolated sessions
                openGSXWindow(link.url, link.label, env.environment);
                 console.log('[Menu Click] openGSXWindow called successfully.');
              } catch (error) {
                console.error('[Menu Click] Failed to open GSX URL:', error);
                // Show error dialog
                const { dialog } = require('electron');
                dialog.showErrorBox(
                  'Error Opening GSX',
                  `Failed to open ${link.label}. Please ensure you are logged in to your IDW environment and try again.\n\nError: ${error.message}`
                );
              }
            }
          });
        });
      } else {
        console.log(`[Menu] No matching GSX links found for '${env.label}', adding 'No links' item.`);
        gsxSubmenu.push({
          label: 'No GSX links available',
          enabled: false
        });
      }

      // Add this IDW's GSX submenu to the main GSX menu
      gsxMenuItems.push({
        label: env.label,
        submenu: gsxSubmenu
      });
    });
    
    // Add a separator in IDW menu
    if (idwMenuItems.length > 0) {
      idwMenuItems.push({ type: 'separator' });
    }
  } else {
    console.log('[Menu] No valid IDW environments found or loaded.');
  }
  
  // Add the Add/Remove menu item to IDW menu
  idwMenuItems.push({
    label: 'Add/Remove',
    accelerator: 'CmdOrCtrl+A',
    click: () => {
      // Call openSetupWizard via the global function
      console.log('[Menu Click] Add/Remove clicked, calling global.openSetupWizardGlobal');
      if (typeof global.openSetupWizardGlobal === 'function') {
        global.openSetupWizardGlobal();
      } else {
        console.error('[Menu Click] openSetupWizardGlobal function not found in global scope');
      }
    }
  });

  // Add external bots to IDW menu if any exist
  if (externalBots && externalBots.length > 0) {
    console.log(`[Menu] Adding ${externalBots.length} external bots to IDW menu`);
    
    // Add separator before external bots
    idwMenuItems.push({ type: 'separator' });
    
    // Add a label for the external bots section
    idwMenuItems.push({
      label: 'External Bots',
      enabled: false
    });
    
    // Add each external bot to IDW menu
    externalBots.forEach((bot, botIndex) => {
      console.log(`[Menu] Adding external bot to IDW menu: ${bot.name} (${bot.chatUrl})`);
      
      // Add keyboard shortcuts for the first 4 external bots (Alt+1 through Alt+4)
      const botAccelerator = botIndex < 4 ? `Alt+${botIndex + 1}` : undefined;
      
      idwMenuItems.push({
        label: bot.name,
        accelerator: botAccelerator,
        click: async () => {
          console.log(`[Menu Click] Opening external bot in tab: ${bot.name} at ${bot.chatUrl}`);
          
          // Send message to main process to open in a new tab
          
          
          // Emit the action directly in the main process
          ipcMain.emit('menu-action', null, {
            action: 'open-external-bot',
            url: bot.chatUrl,
            label: bot.name,
            isExternal: true
          });
        }
      });
    });
  }

  // Add image creators to IDW menu if any exist
  if (imageCreators && imageCreators.length > 0) {
    console.log(`[Menu] Adding ${imageCreators.length} image creators to IDW menu`);
    
    // Add separator before image creators
    idwMenuItems.push({ type: 'separator' });
    
    // Add a label for the image creators section
    idwMenuItems.push({
      label: 'Image Creators',
      enabled: false
    });
    
    // Add each image creator to IDW menu
    imageCreators.forEach((creator, creatorIndex) => {
      console.log(`[Menu] Adding image creator to IDW menu: ${creator.name} (${creator.url})`);
      
      // Add keyboard shortcuts for the first 4 image creators (Shift+Cmd/Ctrl+1 through 4)
      const creatorAccelerator = creatorIndex < 4 ? `Shift+CmdOrCtrl+${creatorIndex + 1}` : undefined;
      
      idwMenuItems.push({
        label: creator.name,  // Removed emoji
        accelerator: creatorAccelerator,
        click: async () => {
          console.log(`[Menu Click] Opening image creator in tab: ${creator.name} at ${creator.url}`);
          
          // Send message to main process to open in a new tab
          
          
          // Emit the action directly in the main process
          ipcMain.emit('menu-action', null, {
            action: 'open-image-creator',
            url: creator.url,
            label: creator.name,
            isImageCreator: true
          });
        }
      });
    });
  }

  // Add video creators to IDW menu if any exist
  if (videoCreators && videoCreators.length > 0) {
    console.log(`[Menu] Adding ${videoCreators.length} video creators to IDW menu`);
    
    // Add separator before video creators
    idwMenuItems.push({ type: 'separator' });
    
    // Add a label for the video creators section
    idwMenuItems.push({
      label: 'Video Creators',
      enabled: false
    });
    
    // Add each video creator to IDW menu
    videoCreators.forEach(creator => {
      console.log(`[Menu] Adding video creator to IDW menu: ${creator.name} (${creator.url})`);
      
      idwMenuItems.push({
        label: creator.name,
        click: async () => {
          console.log(`[Menu Click] Opening video creator in tab: ${creator.name} at ${creator.url}`);
          
          // Send message to main process to open in a new tab
          
          
          // Emit the action directly in the main process
          ipcMain.emit('menu-action', null, {
            action: 'open-video-creator',
            url: creator.url,
            label: creator.name,
            isVideoCreator: true
          });
        }
      });
    });
  }

  // Add audio generators to IDW menu if any exist
  if (audioGenerators && audioGenerators.length > 0) {
    console.log(`[Menu] Adding ${audioGenerators.length} audio generators to IDW menu`);
    
    // Add separator before audio generators
    idwMenuItems.push({ type: 'separator' });
    
    // Add a label for the audio generators section
    idwMenuItems.push({
      label: 'Audio Generators',
      enabled: false
    });
    
    // Group audio generators by category
    const audioByCategory = {
      music: [],
      effects: [],
      narration: [],
      custom: []
    };
    
    audioGenerators.forEach(generator => {
      const category = generator.category || 'custom';
      if (audioByCategory[category]) {
        audioByCategory[category].push(generator);
      } else {
        audioByCategory.custom.push(generator);
      }
    });
    
    // Add music generators
    if (audioByCategory.music.length > 0) {
      idwMenuItems.push({
        label: '🎵 Music',
        submenu: audioByCategory.music.map(generator => ({
          label: generator.name,
          click: async () => {
            console.log(`[Menu Click] Opening audio generator in tab: ${generator.name} at ${generator.url}`);
            
            
            ipcMain.emit('menu-action', null, {
              action: 'open-audio-generator',
              url: generator.url,
              label: generator.name,
              isAudioGenerator: true,
              category: 'music'
            });
          }
        }))
      });
    }
    
    // Add sound effects generators
    if (audioByCategory.effects.length > 0) {
      idwMenuItems.push({
        label: '🔊 Sound Effects',
        submenu: audioByCategory.effects.map(generator => ({
          label: generator.name,
          click: async () => {
            console.log(`[Menu Click] Opening audio generator in tab: ${generator.name} at ${generator.url}`);
            
            
            ipcMain.emit('menu-action', null, {
              action: 'open-audio-generator',
              url: generator.url,
              label: generator.name,
              isAudioGenerator: true,
              category: 'effects'
            });
          }
        }))
      });
    }
    
    // Add narration generators
    if (audioByCategory.narration.length > 0) {
      idwMenuItems.push({
        label: '🎙️ Narration & Voice',
        submenu: audioByCategory.narration.map(generator => ({
          label: generator.name,
          click: async () => {
            console.log(`[Menu Click] Opening audio generator in tab: ${generator.name} at ${generator.url}`);
            
            
            ipcMain.emit('menu-action', null, {
              action: 'open-audio-generator',
              url: generator.url,
              label: generator.name,
              isAudioGenerator: true,
              category: 'narration'
            });
          }
        }))
      });
    }
    
    // Add custom generators
    if (audioByCategory.custom.length > 0) {
      idwMenuItems.push({
        label: '⚙️ Custom',
        submenu: audioByCategory.custom.map(generator => ({
          label: generator.name,
          click: async () => {
            console.log(`[Menu Click] Opening audio generator in tab: ${generator.name} at ${generator.url}`);
            
            
            ipcMain.emit('menu-action', null, {
              action: 'open-audio-generator',
              url: generator.url,
              label: generator.name,
              isAudioGenerator: true,
              category: 'custom'
            });
          }
        }))
      });
    }
  }

  // === NEW: Add UI Design tools to IDW menu ===
  if (uiDesignTools && uiDesignTools.length > 0) {
    console.log(`[Menu] Adding ${uiDesignTools.length} UI design tools to IDW menu`);

    // Separator before this section
    idwMenuItems.push({ type: 'separator' });
    idwMenuItems.push({ label: 'UI Design Tools', enabled: false });

    uiDesignTools.forEach(tool => {
      idwMenuItems.push({
        label: tool.name,
        click: () => {
          
          console.log(`[Menu Click] Opening UI design tool: ${tool.name} -> ${tool.url}`);
          ipcMain.emit('menu-action', null, {
            action: 'open-ui-design-tool',
            url: tool.url,
            label: tool.name,
            isUIDesignTool: true
          });
        }
      });
    });
  }

  // If no IDW environments, show a disabled message in GSX menu
  if (gsxMenuItems.length === 0) {
    console.log('[Menu] No IDW environments configured, adding disabled item to GSX menu.');
    gsxMenuItems.push({
      label: 'No IDW environments available',
      enabled: false
    });
  }
  
  // Add external bot API docs to GSX menu if any exist
  if (externalBots && externalBots.length > 0) {
    const externalBotsWithAPIs = externalBots.filter(bot => bot.apiUrl);
    
    if (externalBotsWithAPIs.length > 0) {
      console.log(`[Menu] Processing ${externalBotsWithAPIs.length} external bot API docs for GSX menu`);
      
      // Add separator if there are IDW items
      if (gsxMenuItems.length > 0 && gsxMenuItems[0].label !== 'No IDW environments available') {
        gsxMenuItems.push({ type: 'separator' });
        console.log('[Menu] Added separator before external bot APIs');
      }
      
      // Create external bot APIs submenu
      const externalBotAPIsMenu = [];
      
      externalBotsWithAPIs.forEach(bot => {
        console.log(`[Menu] Adding API docs for ${bot.name}: ${bot.apiUrl}`);
        
        externalBotAPIsMenu.push({
          label: `${bot.name} API`,
          click: async () => {
            console.log(`[Menu Click] Opening API docs for ${bot.name} at ${bot.apiUrl}`);
            await shell.openExternal(bot.apiUrl);
          }
        });
      });
      
      console.log(`[Menu] Created external bot APIs submenu with ${externalBotAPIsMenu.length} items`);
      
      // Add the external bot APIs submenu
      gsxMenuItems.push({
        label: 'External Bot APIs',
        submenu: externalBotAPIsMenu
      });
      
      console.log('[Menu] Added external bot APIs submenu to GSX menu');
    }
  }
  
  // Add image creator API docs to GSX menu if any exist
  if (imageCreators && imageCreators.length > 0) {
    const imageCreatorsWithAPIs = imageCreators.filter(creator => creator.apiUrl);
    
    if (imageCreatorsWithAPIs.length > 0) {
      console.log(`[Menu] Processing ${imageCreatorsWithAPIs.length} image creator API docs for GSX menu`);
      
      // Add separator if there are items and we haven't added one for external bots
      if (gsxMenuItems.length > 0 && gsxMenuItems[0].label !== 'No IDW environments available' &&
          !(externalBots && externalBots.filter(bot => bot.apiUrl).length > 0)) {
        gsxMenuItems.push({ type: 'separator' });
        console.log('[Menu] Added separator before image creator APIs');
      }
      
      // Create image creator APIs submenu
      const imageCreatorAPIsMenu = [];
      
      imageCreatorsWithAPIs.forEach(creator => {
        console.log(`[Menu] Adding API docs for ${creator.name}: ${creator.apiUrl}`);
        
        imageCreatorAPIsMenu.push({
          label: `${creator.name} API`,
          click: async () => {
            console.log(`[Menu Click] Opening API docs for ${creator.name} at ${creator.apiUrl}`);
            await shell.openExternal(creator.apiUrl);
          }
        });
      });
      
      console.log(`[Menu] Created image creator APIs submenu with ${imageCreatorAPIsMenu.length} items`);
      
      // Add the image creator APIs submenu
      gsxMenuItems.push({
        label: 'Image Creator APIs',
        submenu: imageCreatorAPIsMenu
      });
      
      console.log('[Menu] Added image creator APIs submenu to GSX menu');
    }
  }
  
  // Add video creator API docs to GSX menu if any exist
  if (videoCreators && videoCreators.length > 0) {
    const videoCreatorsWithAPIs = videoCreators.filter(creator => creator.apiUrl);
    
    if (videoCreatorsWithAPIs.length > 0) {
      console.log(`[Menu] Processing ${videoCreatorsWithAPIs.length} video creator API docs for GSX menu`);
      
      // Add separator if there are items and we haven't added one for external bots or image creators
      if (gsxMenuItems.length > 0 && gsxMenuItems[0].label !== 'No IDW environments available' &&
          !(externalBots && externalBots.filter(bot => bot.apiUrl).length > 0) &&
          !(imageCreators && imageCreators.filter(creator => creator.apiUrl).length > 0)) {
        gsxMenuItems.push({ type: 'separator' });
        console.log('[Menu] Added separator before video creator APIs');
      }
      
      // Create video creator APIs submenu
      const videoCreatorAPIsMenu = [];
      
      videoCreatorsWithAPIs.forEach(creator => {
        console.log(`[Menu] Adding API docs for ${creator.name}: ${creator.apiUrl}`);
        
        videoCreatorAPIsMenu.push({
          label: `${creator.name} API`,
          click: async () => {
            console.log(`[Menu Click] Opening API docs for ${creator.name} at ${creator.apiUrl}`);
            await shell.openExternal(creator.apiUrl);
          }
        });
      });
      
      console.log(`[Menu] Created video creator APIs submenu with ${videoCreatorAPIsMenu.length} items`);
      
      // Add the video creator APIs submenu
      gsxMenuItems.push({
        label: 'Video Creator APIs',
        submenu: videoCreatorAPIsMenu
      });
      
      console.log('[Menu] Added video creator APIs submenu to GSX menu');
    }
  }
  
  // Add audio generator API docs to GSX menu if any exist
  if (audioGenerators && audioGenerators.length > 0) {
    const audioGeneratorsWithAPIs = audioGenerators.filter(generator => generator.apiUrl);
    
    if (audioGeneratorsWithAPIs.length > 0) {
      console.log(`[Menu] Processing ${audioGeneratorsWithAPIs.length} audio generator API docs for GSX menu`);
      
      // Add separator if there are items and we haven't added one for other APIs
      if (gsxMenuItems.length > 0 && gsxMenuItems[0].label !== 'No IDW environments available' &&
          !(externalBots && externalBots.filter(bot => bot.apiUrl).length > 0) &&
          !(imageCreators && imageCreators.filter(creator => creator.apiUrl).length > 0) &&
          !(videoCreators && videoCreators.filter(creator => creator.apiUrl).length > 0)) {
        gsxMenuItems.push({ type: 'separator' });
        console.log('[Menu] Added separator before audio generator APIs');
      }
      
      // Create audio generator APIs submenu
      const audioGeneratorAPIsMenu = [];
      
      audioGeneratorsWithAPIs.forEach(generator => {
        console.log(`[Menu] Adding API docs for ${generator.name}: ${generator.apiUrl}`);
        
        audioGeneratorAPIsMenu.push({
          label: `${generator.name} API`,
          click: async () => {
            console.log(`[Menu Click] Opening API docs for ${generator.name} at ${generator.apiUrl}`);
            await shell.openExternal(generator.apiUrl);
          }
        });
      });
      
      console.log(`[Menu] Created audio generator APIs submenu with ${audioGeneratorAPIsMenu.length} items`);
      
      // Add the audio generator APIs submenu
      gsxMenuItems.push({
        label: 'Audio Generator APIs',
        submenu: audioGeneratorAPIsMenu
      });
      
      console.log('[Menu] Added audio generator APIs submenu to GSX menu');
    }
  }
  
  // === NEW: Add UI Design tool API docs ===
  if (uiDesignTools && uiDesignTools.length > 0) {
    const toolsWithAPIs = uiDesignTools.filter(t => t.apiUrl);
    if (toolsWithAPIs.length) {
      console.log(`[Menu] Adding ${toolsWithAPIs.length} UI design tool API docs to GSX menu`);
      if (gsxMenuItems.length && gsxMenuItems[gsxMenuItems.length - 1].type !== 'separator') {
        gsxMenuItems.push({ type: 'separator' });
      }
      gsxMenuItems.push({
        label: 'UI Design Tool APIs',
        submenu: toolsWithAPIs.map(t => ({
          label: `${t.name} API`,
          click: () => shell.openExternal(t.apiUrl)
        }))
      });
    }
  }
  
  const template = [
    // App menu (macOS only)
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { 
          label: 'Settings...',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            // Open the settings window
            console.log('[Menu Click] Settings clicked, opening settings window');
            if (typeof global.openSettingsWindowGlobal === 'function') {
              global.openSettingsWindowGlobal();
            } else {
              // Fallback: send to renderer if global function not available
              const focusedWindow = BrowserWindow.getFocusedWindow();
              if (focusedWindow) {
                focusedWindow.webContents.send('menu-action', { action: 'open-settings' });
              }
            }
          }
        },
        { type: 'separator' },
        { 
          label: 'Manage Environments...',
          click: () => {
            // Open the setup wizard to manage environments
            console.log('[Menu Click] Manage Environments clicked, opening setup wizard');
            if (typeof global.openSetupWizardGlobal === 'function') {
              global.openSetupWizardGlobal();
            } else {
              // Fallback: send to renderer if global function not available
              const focusedWindow = BrowserWindow.getFocusedWindow();
              if (focusedWindow) {
                focusedWindow.webContents.send('menu-action', { action: 'open-preferences' });
              }
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            ...(isMac ? [
              { role: 'pasteAndMatchStyle' },
              { role: 'delete' },
              { role: 'selectAll' },
              { type: 'separator' },
              {
                label: 'Speech',
                submenu: [
                  { role: 'startSpeaking' },
                  { role: 'stopSpeaking' }
                ]
              }
            ] : [
              { role: 'delete' },
              { type: 'separator' },
              { role: 'selectAll' }
            ])
          ]
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    
    // IDW menu (with dynamic IDW environment items)
    {
      label: 'IDW',
      submenu: idwMenuItems
    },
    
    // GSX menu (with dynamic GSX links)
    {
      label: 'GSX',
      submenu: gsxMenuItems
    },
    
    // Clipboard menu
    {
      label: 'Manage Spaces',
      submenu: [
        {
          label: 'Show Clipboard History',
          accelerator: process.platform === 'darwin' ? 'Cmd+Shift+V' : 'Ctrl+Shift+V',
          click: () => {
            // Get the clipboard manager from the global scope
            if (global.clipboardManager) {
              global.clipboardManager.createClipboardWindow();
            } else {
              console.error('[Menu] Clipboard manager not available');
            }
          }
        }
      ]
    },
    
        // Tools menu (formerly Modules)
    {
      label: 'Tools',
      submenu: [
        // Dynamic module/tool items will be inserted here
        ...(global.moduleManager ? global.moduleManager.getModuleMenuItems() : []),
        ...(global.moduleManager && global.moduleManager.getInstalledModules().length > 0 ? [{ type: 'separator' }] : []),
        {
          label: 'AI Insights',
          click: () => {
            const aiWindow = new BrowserWindow({
              width: 1200,
              height: 800,
              webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                webSecurity: true,
                preload: path.join(__dirname, 'Flipboard-IDW-Feed/preload.js')
              }
            });
            
            // Load the UXmag.html file
            aiWindow.loadFile('Flipboard-IDW-Feed/uxmag.html');
          }
        },
        { type: 'separator' },
        {
          label: 'Manage Tools...',
          click: () => {
            const { BrowserWindow } = require('electron');
            
            // Create module manager window
            const managerWindow = new BrowserWindow({
              width: 800,
              height: 600,
              webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                enableRemoteModule: true
              },
              title: 'Module Manager'
            });
            
            managerWindow.loadFile('module-manager-ui.html');
          }
        }
      ]
    },
    
    // Help menu
    {
      role: 'help',
      submenu: [
        {
          label: 'Keyboard Shortcuts',
          click: () => {
            const { dialog } = require('electron');
            const focusedWindow = BrowserWindow.getFocusedWindow();
            
            const shortcutsMessage = `IDW Environments:
Cmd/Ctrl+1 through 9: Open IDW environments 1-9

External AI Agents:
Alt+1: Google Gemini
Alt+2: Perplexity
Alt+3: ChatGPT
Alt+4: Claude

Image Creators:
Shift+Cmd/Ctrl+1: Midjourney
Shift+Cmd/Ctrl+2: Ideogram
Shift+Cmd/Ctrl+3: Adobe Firefly
Shift+Cmd/Ctrl+4: OpenAI Image (DALL-E 3)

Other Shortcuts:
Cmd/Ctrl+A: Add/Remove environments
Cmd/Ctrl+,: Settings
Cmd/Ctrl+Shift+V: Show Clipboard History
Cmd/Ctrl+Shift+T: Test Runner
Cmd/Ctrl+Shift+L: Event Log Viewer
Cmd/Ctrl+Shift+B: Report a Bug

Right-click anywhere: Paste to Black Hole`;
            
            dialog.showMessageBox(focusedWindow, {
              type: 'info',
              title: 'Keyboard Shortcuts',
              message: 'OneReach.ai Keyboard Shortcuts',
              detail: shortcutsMessage,
              buttons: ['OK']
            });
          }
        },
        { type: 'separator' },
        {
          label: 'Debug: Open Setup Wizard',
          click: async () => {
            console.log('Debug: Opening setup wizard directly');
            const { BrowserWindow } = require('electron');
            const path = require('path');
            const fs = require('fs');
            
            // Create the setup wizard window directly
            const wizardWindow = new BrowserWindow({
              width: 1000, 
              height: 700,
              webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js'),
                webSecurity: true,
                enableRemoteModule: false,
                sandbox: false
              }
            });
            
            // Load the setup wizard directly
            console.log('Loading setup-wizard.html directly');
            wizardWindow.loadFile('setup-wizard.html');
          }
        },
        {
          label: 'Learn More',
          click: async () => {
            await shell.openExternal('https://onereach.ai');
          }
        },
        {
          label: 'Documentation',
          submenu: [
            {
              label: 'Local Documentation (README)',
              click: () => {
                const { BrowserWindow } = require('electron');
                const path = require('path');
                
                // Create a documentation window
                const docWindow = new BrowserWindow({
                  width: 1000,
                  height: 800,
                  webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    preload: path.join(__dirname, 'preload.js'),
                    webSecurity: true
                  }
                });
                
                // Load the dedicated documentation HTML file
                try {
                  docWindow.loadFile('docs-readme.html');
                } catch (error) {
                  console.error('Error loading local documentation:', error);
                  // Fallback to external documentation
                  shell.openExternal('https://onereach.ai/docs');
                }
              }
            },
            {
              label: 'AI Insights Guide',
              click: () => {
                const { BrowserWindow } = require('electron');
                const path = require('path');
                
                // Create AI Insights help window
                const aiHelpWindow = new BrowserWindow({
                  width: 1000,
                  height: 800,
                  webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    preload: path.join(__dirname, 'preload.js'),
                    webSecurity: true
                  }
                });
                
                // Load the dedicated AI Insights guide HTML file
                try {
                  aiHelpWindow.loadFile('docs-ai-insights.html');
                } catch (error) {
                  console.error('Error loading AI Insights guide:', error);
                  // Fallback to external documentation
                  shell.openExternal('https://onereach.ai/docs');
                }
              }
            },
            { type: 'separator' },
            {
              label: 'Online Documentation',
              click: async () => {
                await shell.openExternal('https://onereach.ai/docs');
              }
            }
          ]
        },
        { type: 'separator' },
        {
          label: '🐛 Report a Bug',
          accelerator: process.platform === 'darwin' ? 'Cmd+Shift+B' : 'Ctrl+Shift+B',
          click: async () => {
            const { dialog, app, clipboard, shell } = require('electron');
            const os = require('os');
            const fs = require('fs');
            const path = require('path');
            const crypto = require('crypto');
            
            try {
              // Generate unique report ID
              const reportId = `BR-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
              
              // Get user info
              const userInfo = {
                username: os.userInfo().username,
                hostname: os.hostname(),
                homedir: os.homedir()
              };
              
              // Collect comprehensive system information
              const systemInfo = {
                app_version: app.getVersion(),
                app_name: app.getName(),
                electron_version: process.versions.electron,
                node_version: process.versions.node,
                chrome_version: process.versions.chrome,
                v8_version: process.versions.v8,
                platform: os.platform(),
                platform_version: os.release(),
                arch: os.arch(),
                cpus: os.cpus().length,
                memory_total: `${Math.round(os.totalmem() / 1073741824)}GB`,
                memory_free: `${Math.round(os.freemem() / 1073741824)}GB`,
                uptime: `${Math.round(os.uptime() / 3600)} hours`
              };
              
              // Get app paths
              const appPaths = {
                userData: app.getPath('userData'),
                logs: app.getPath('logs'),
                temp: app.getPath('temp')
              };
              
              // Collect recent logs automatically (last 200 lines)
              let recentLogs = '';
              let logError = null;
              try {
                const logPath = path.join(app.getPath('userData'), 'logs', 'app.log');
                if (fs.existsSync(logPath)) {
                  const logContent = fs.readFileSync(logPath, 'utf8');
                  const lines = logContent.split('\n').filter(line => line.trim());
                  // Get last 200 lines
                  recentLogs = lines.slice(-200).join('\n');
                } else {
                  // Try alternative log locations
                  const altLogPath = path.join(app.getPath('userData'), 'app.log');
                  if (fs.existsSync(altLogPath)) {
                    const logContent = fs.readFileSync(altLogPath, 'utf8');
                    const lines = logContent.split('\n').filter(line => line.trim());
                    recentLogs = lines.slice(-200).join('\n');
                  }
                }
              } catch (error) {
                logError = error.message;
                console.error('Failed to read logs:', error);
              }
              
              // Get settings (without sensitive data)
              let appSettings = {};
              try {
                const settingsPath = path.join(app.getPath('userData'), 'settings.json');
                if (fs.existsSync(settingsPath)) {
                  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                  // Remove sensitive data
                  delete settings.apiKeys;
                  delete settings.credentials;
                  delete settings.tokens;
                  delete settings.passwords;
                  appSettings = settings;
                }
              } catch (error) {
                appSettings = { error: 'Failed to load settings' };
              }
              
              // Create comprehensive bug report
              const bugReportData = {
                reportId,
                timestamp: new Date().toISOString(),
                user: {
                  username: userInfo.username,
                  hostname: userInfo.hostname
                },
                system: systemInfo,
                app: {
                  version: systemInfo.app_version,
                  paths: appPaths,
                  settings: appSettings
                },
                logs: recentLogs || 'No logs available',
                logError
              };
              
              // Create user-friendly email body
              const emailBody = `
===========================================
BUG REPORT ID: ${reportId}
===========================================

PLEASE DESCRIBE YOUR ISSUE HERE:
[Please describe what happened, what you expected to happen, and steps to reproduce the issue]




===========================================
AUTOMATED SYSTEM INFORMATION (DO NOT EDIT)
===========================================

Report ID: ${reportId}
Timestamp: ${new Date().toLocaleString()}
User: ${userInfo.username}@${userInfo.hostname}

APP INFORMATION:
- App Version: ${systemInfo.app_version}
- Electron: ${systemInfo.electron_version}
- Node: ${systemInfo.node_version}
- Chrome: ${systemInfo.chrome_version}

SYSTEM INFORMATION:
- Platform: ${systemInfo.platform} ${systemInfo.platform_version}
- Architecture: ${systemInfo.arch}
- CPUs: ${systemInfo.cpus}
- Memory: ${systemInfo.memory_total} total (${systemInfo.memory_free} free)
- System Uptime: ${systemInfo.uptime}

APP PATHS:
- User Data: ${appPaths.userData}
- Logs: ${appPaths.logs}
- Temp: ${appPaths.temp}

RECENT LOG ENTRIES (Last 200 lines):
----------------------------------------
${recentLogs || 'No logs available' + (logError ? `\nLog Error: ${logError}` : '')}
----------------------------------------

APP SETTINGS (Sensitive data removed):
${JSON.stringify(appSettings, null, 2)}

===========================================
END OF AUTOMATED REPORT
===========================================
`;

              // Show dialog to confirm sending
              const result = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
                type: 'info',
                title: 'Bug Report Ready',
                message: `Bug Report ${reportId} Prepared`,
                detail: 'Your bug report has been prepared with all system information and logs. Choose how you want to submit it:',
                buttons: ['Open GitHub Issues', 'Send Email', 'Copy to Clipboard', 'Save to File', 'Cancel'],
                defaultId: 0,
                cancelId: 4
              });
              
              if (result.response === 0) {
                // Open GitHub issues page with pre-filled title
                const issueTitle = `Bug Report ${reportId} - Onereach.ai v${systemInfo.app_version}`;
                const encodedTitle = encodeURIComponent(issueTitle);
                const encodedBody = encodeURIComponent(emailBody);
                
                // Open GitHub issues page with title and body pre-filled
                const githubUrl = `https://github.com/wilsr7000/onereach_desktop/issues/new?title=${encodedTitle}&body=${encodedBody}`;
                await shell.openExternal(githubUrl);
                
                // Show success message
                dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
                  type: 'info',
                  title: 'GitHub Issues Opened',
                  message: 'GitHub Issues page opened',
                  detail: `A new issue page has been opened on GitHub with Report ${reportId}. Please describe your issue at the top of the issue body and submit it.`,
                  buttons: ['OK']
                });
                
              } else if (result.response === 1) {
                // Open email client with everything pre-filled
                const subject = `Bug Report ${reportId} - Onereach.ai v${systemInfo.app_version}`;
                const encodedSubject = encodeURIComponent(subject);
                const encodedBody = encodeURIComponent(emailBody);
                
                // Create mailto link with subject and body
                const mailtoLink = `mailto:support@onereach.ai?subject=${encodedSubject}&body=${encodedBody}`;
                
                // Open default email client
                await shell.openExternal(mailtoLink);
                
                // Show success message
                dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
                  type: 'info',
                  title: 'Email Opened',
                  message: 'Bug report email opened',
                  detail: `Your email client should now be open with Report ${reportId}. Please describe your issue at the top of the email and send it to support.`,
                  buttons: ['OK']
                });
                
              } else if (result.response === 2) {
                // Copy to clipboard
                clipboard.writeText(emailBody);
                dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
                  type: 'info',
                  title: 'Copied to Clipboard',
                  message: `Bug Report ${reportId} copied to clipboard`,
                  detail: 'You can now paste this into any text editor or email client.',
                  buttons: ['OK']
                });
                
              } else if (result.response === 3) {
                // Save to file
                const savePath = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
                  defaultPath: `bug-report-${reportId}.txt`,
                  filters: [
                    { name: 'Text Files', extensions: ['txt'] },
                    { name: 'All Files', extensions: ['*'] }
                  ]
                });
                
                if (!savePath.canceled && savePath.filePath) {
                  // Also save JSON version
                  const jsonPath = savePath.filePath.replace('.txt', '.json');
                  fs.writeFileSync(savePath.filePath, emailBody);
                  fs.writeFileSync(jsonPath, JSON.stringify(bugReportData, null, 2));
                  
                  dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
                    type: 'info',
                    title: 'Saved Successfully',
                    message: `Bug Report ${reportId} saved`,
                    detail: `Report saved to:\n${savePath.filePath}\n\nJSON data also saved to:\n${jsonPath}`,
                    buttons: ['OK']
                  });
                }
              }
              // If response === 4, user cancelled
              
            } catch (error) {
              console.error('Error creating bug report:', error);
              dialog.showErrorBox('Error', `Failed to create bug report: ${error.message}\n\nPlease try again or contact support directly.`);
            }
          }
        },
        {
          label: '📋 Export Debug Info',
          click: async () => {
            const { dialog, app, clipboard } = require('electron');
            const os = require('os');
            const fs = require('fs');
            const path = require('path');
            
            try {
              // Collect comprehensive debug information
              const debugInfo = {
                timestamp: new Date().toISOString(),
                app: {
                  name: app.getName(),
                  version: app.getVersion(),
                  paths: {
                    userData: app.getPath('userData'),
                    temp: app.getPath('temp'),
                    exe: app.getPath('exe')
                  }
                },
                system: {
                  platform: os.platform(),
                  release: os.release(),
                  arch: os.arch(),
                  cpus: os.cpus().length,
                  memory: {
                    total: `${Math.round(os.totalmem() / 1073741824)}GB`,
                    free: `${Math.round(os.freemem() / 1073741824)}GB`
                  },
                  uptime: `${Math.round(os.uptime() / 3600)} hours`
                },
                electron: {
                  version: process.versions.electron,
                  node: process.versions.node,
                  chrome: process.versions.chrome,
                  v8: process.versions.v8
                },
                settings: {}
              };
              
              // Try to load app settings (without sensitive data)
              try {
                const settingsPath = path.join(app.getPath('userData'), 'settings.json');
                if (fs.existsSync(settingsPath)) {
                  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                  // Remove sensitive data
                  delete settings.apiKeys;
                  delete settings.credentials;
                  debugInfo.settings = settings;
                }
              } catch (error) {
                debugInfo.settings = { error: 'Failed to load settings' };
              }
              
              const debugText = JSON.stringify(debugInfo, null, 2);
              
              // Ask user what to do with debug info
              const result = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
                type: 'info',
                title: 'Debug Information',
                message: 'Debug information has been collected',
                detail: 'What would you like to do with it?',
                buttons: ['Copy to Clipboard', 'Save to File', 'Cancel'],
                defaultId: 0,
                cancelId: 2
              });
              
              if (result.response === 0) {
                clipboard.writeText(debugText);
                dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
                  type: 'info',
                  title: 'Success',
                  message: 'Debug information copied to clipboard!'
                });
              } else if (result.response === 1) {
                const savePath = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
                  defaultPath: `onereach-debug-${Date.now()}.json`,
                  filters: [
                    { name: 'JSON Files', extensions: ['json'] },
                    { name: 'All Files', extensions: ['*'] }
                  ]
                });
                
                if (!savePath.canceled && savePath.filePath) {
                  fs.writeFileSync(savePath.filePath, debugText);
                  dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
                    type: 'info',
                    title: 'Success',
                    message: 'Debug information saved successfully!'
                  });
                }
              }
            } catch (error) {
              console.error('Error exporting debug info:', error);
              dialog.showErrorBox('Error', 'Failed to export debug information.');
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Check for Updates',
          click: () => {
            console.log('[Menu Click] Check for Updates clicked');
            
            // Call the checkForUpdates function directly from main process
            const { checkForUpdates } = require('./main.js');
            if (typeof checkForUpdates === 'function') {
              checkForUpdates();
            } else {
              // Fallback: Try using the global function if available
              if (typeof global.checkForUpdatesGlobal === 'function') {
                global.checkForUpdatesGlobal();
              } else {
                const { dialog } = require('electron');
                const focusedWindow = BrowserWindow.getFocusedWindow();
                dialog.showMessageBox(focusedWindow, {
                  type: 'info',
                  title: 'Updates Not Available',
                  message: 'Auto-update repository not configured',
                  detail: 'The public releases repository needs to be created first:\n\n1. Go to github.com/new\n2. Create repository: onereach-desktop-releases\n3. Make it PUBLIC\n4. Run: npm run release',
                  buttons: ['OK']
                });
              }
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Manage Backups',
          submenu: [
            {
              label: 'View Available Backups',
              click: async () => {
                const { dialog, shell } = require('electron');
                const focusedWindow = BrowserWindow.getFocusedWindow();
                
                // Get available backups
                const { RollbackManager } = require('./rollback-manager');
                const rollbackManager = new RollbackManager();
                const result = await rollbackManager.getBackups();
                
                if (!result || result.length === 0) {
                  dialog.showMessageBox(focusedWindow, {
                    type: 'info',
                    title: 'No Backups Available',
                    message: 'No app backups found. Backups are created automatically before updates.',
                    buttons: ['OK']
                  });
                  return;
                }
                
                // Show backups in a dialog
                const buttons = result.map(backup => 
                  `v${backup.version} (${new Date(backup.createdAt).toLocaleDateString()})`
                );
                buttons.push('Cancel');
                
                const { response } = await dialog.showMessageBox(focusedWindow, {
                  type: 'question',
                  title: 'Available Backups',
                  message: 'Select a backup version to create a restore script:',
                  detail: 'The restore script will help you rollback to a previous version if needed.',
                  buttons: buttons,
                  cancelId: buttons.length - 1
                });
                
                if (response < result.length) {
                  // Create restore script for selected backup
                  const backup = result[response];
                  const scriptResult = await rollbackManager.createRestoreScript(backup.version);
                  
                  if (scriptResult.success) {
                    const { response: showFolder } = await dialog.showMessageBox(focusedWindow, {
                      type: 'info',
                      title: 'Restore Script Created',
                      message: `Restore script for v${backup.version} has been created.`,
                      detail: 'Would you like to open the backups folder?',
                      buttons: ['Open Folder', 'OK'],
                      defaultId: 0
                    });
                    
                    if (showFolder === 0) {
                      await rollbackManager.openBackupsFolder();
                    }
                  } else {
                    dialog.showErrorBox('Error', `Failed to create restore script: ${scriptResult.error}`);
                  }
                }
              }
            },
            {
              label: 'Open Backups Folder',
              click: async () => {
                const { RollbackManager } = require('./rollback-manager');
                const rollbackManager = new RollbackManager();
                await rollbackManager.openBackupsFolder();
              }
            }
          ]
        },
        // Conditionally add test menu items if showTestMenu is true
        ...(showTestMenu ? [
          { type: 'separator' },
          {
            label: '🧪 Data Validation Tests',
            click: () => {
              console.log("Test menu item clicked - sending open-data-tests action");
              // Send directly to main process for immediate handling
              
              ipcMain.emit('menu-action', null, { action: 'open-data-tests' });
              
              // Also send to focused window as backup
              const focusedWindow = BrowserWindow.getFocusedWindow();
              if (focusedWindow) {
                focusedWindow.webContents.send('menu-action', { action: 'open-data-tests' });
              }
            }
          },
          {
            label: '🛡️ CSP Test Page',
            click: () => {
              console.log("CSP Test menu item clicked - sending open-csp-test action");
              // Send directly to main process for immediate handling
              
              ipcMain.emit('menu-action', null, { action: 'open-csp-test' });
              
              // Also send to focused window as backup
              const focusedWindow = BrowserWindow.getFocusedWindow();
              if (focusedWindow) {
                focusedWindow.webContents.send('menu-action', { action: 'open-csp-test' });
              }
            }
          },
          {
            label: '🧬 Integrated Test Runner',
            accelerator: 'CmdOrCtrl+Shift+T',
            click: () => {
              console.log("Test Runner clicked - opening integrated test runner");
              
              // Create test runner window
              const { BrowserWindow } = require('electron');
              const path = require('path');
              
              const testWindow = new BrowserWindow({
                width: 1200,
                height: 900,
                webPreferences: {
                  nodeIntegration: false,
                  contextIsolation: true,
                  preload: path.join(__dirname, 'preload.js'),
                  webSecurity: true
                }
              });
              
              testWindow.loadFile('test-runner.html');
            }
          },
          {
            label: '📋 Event Log Viewer',
            accelerator: 'CmdOrCtrl+Shift+L',
            click: () => {
              console.log("Event Log Viewer clicked - opening log viewer");
              
              // Create log viewer window
              const { BrowserWindow } = require('electron');
              const path = require('path');
              
              const logWindow = new BrowserWindow({
                width: 1200,
                height: 800,
                webPreferences: {
                  nodeIntegration: false,
                  contextIsolation: true,
                  preload: path.join(__dirname, 'preload-log-viewer.js'),
                  webSecurity: true
                },
                title: 'Event Log Viewer'
              });
              
              logWindow.loadFile('log-viewer.html');
            }
          }
        ] : [])
      ]
    },
    
    // Share menu - top level, no submenu (positioned at far right)
    {
      label: 'Share',
      click: async () => {
        console.log('[Menu Click] Share clicked');
        const { dialog, clipboard } = require('electron');
        
        // Get app version
        const appVersion = app.getVersion();
        const appName = app.getName();
        
        // Create sharing text
        const shareTitle = `Check out ${appName}!`;
        const shareText = `I'm using ${appName} v${appVersion} - a powerful desktop app for AI productivity.

🚀 Features:
• Multiple AI assistants in tabs
• Smart clipboard management with Spaces
• Image and video creation tools
• Audio generation capabilities
• Auto-updates

📥 Download it here:
https://github.com/wilsr7000/Onereach_Desktop_App/releases/latest

Available for macOS (Intel & Apple Silicon)`;
        
        // Show dialog with share options
        const focusedWindow = BrowserWindow.getFocusedWindow();
        const result = await dialog.showMessageBox(focusedWindow, {
          type: 'info',
          title: 'Share Onereach.ai',
          message: shareTitle,
          detail: shareText,
          buttons: ['Copy Link', 'Copy Full Text', 'Open GitHub', 'Cancel'],
          defaultId: 0,
          cancelId: 3
        });
        
        switch (result.response) {
          case 0: // Copy Link
            clipboard.writeText('https://github.com/wilsr7000/Onereach_Desktop_App/releases/latest');
            dialog.showMessageBox(focusedWindow, {
              type: 'info',
              title: 'Link Copied',
              message: 'Download link copied to clipboard!',
              buttons: ['OK']
            });
            console.log('[Share] Download link copied to clipboard');
            break;
            
          case 1: // Copy Full Text
            clipboard.writeText(shareText);
            dialog.showMessageBox(focusedWindow, {
              type: 'info', 
              title: 'Text Copied',
              message: 'Share text copied to clipboard!',
              detail: 'You can now paste it in any messaging app, email, or social media.',
              buttons: ['OK']
            });
            console.log('[Share] Full share text copied to clipboard');
            break;
            
          case 2: // Open GitHub
            shell.openExternal('https://github.com/wilsr7000/Onereach_Desktop_App/releases/latest');
            console.log('[Share] Opened GitHub releases page');
            break;
            
          case 3: // Cancel
            console.log('[Share] Share cancelled');
            break;
        }
      }
    }
  ];

  try {
    const menu = Menu.buildFromTemplate(template);
    console.log('[Menu] Menu built successfully.');
    return menu;
  } catch (error) {
    console.error('[Menu] Error building menu from template:', error);
    console.error('[Menu] Template:', JSON.stringify(template, null, 2));
    throw error;
  }
}

// State for test menu visibility
let isTestMenuVisible = false;

/**
 * Sets the application menu
 */
function setApplicationMenu(idwEnvironments = []) {
  try {
    console.log('[Menu] setApplicationMenu called with', idwEnvironments.length, 'environments');
    const menu = createMenu(isTestMenuVisible, idwEnvironments);
    console.log('[Menu] Menu created successfully, setting application menu');
    Menu.setApplicationMenu(menu);
    console.log('[Menu] Application menu set successfully');
  } catch (error) {
    console.error('[Menu] Error setting application menu:', error);
    console.error('[Menu] Stack trace:', error.stack);
    
    // Try to set a minimal fallback menu
    try {
      const fallbackMenu = Menu.buildFromTemplate([
        {
          label: 'File',
          submenu: [
            { role: 'quit' }
          ]
        },
        {
          label: 'Help',
          submenu: [
            { 
              label: 'Debug Menu Error',
              click: () => {
                const { dialog } = require('electron');
                dialog.showErrorBox('Menu Error', `Failed to create menu: ${error.message}`);
              }
            }
          ]
        }
      ]);
      Menu.setApplicationMenu(fallbackMenu);
      console.log('[Menu] Fallback menu set');
    } catch (fallbackError) {
      console.error('[Menu] Failed to set fallback menu:', fallbackError);
    }
  }
}

/**
 * Toggles the visibility of the test menu
 */
function toggleTestMenu() {
  isTestMenuVisible = !isTestMenuVisible;
  setApplicationMenu();
  
  // Show notification to user
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (focusedWindow) {
    focusedWindow.webContents.send('show-notification', {
      title: 'Test Menu',
      body: isTestMenuVisible ? 'Test menu activated' : 'Test menu deactivated'
    });
  }
}

/**
 * Registers the keyboard shortcut for toggling the test menu
 */
function registerTestMenuShortcut() {
  // Unregister first to prevent duplicates
  globalShortcut.unregister('CommandOrControl+Alt+H');
  
  // Register the shortcut
  globalShortcut.register('CommandOrControl+Alt+H', () => {
    toggleTestMenu();
  });
}

/**
 * Updates the application menu by reloading GSX links from file system
 * This is used when GSX links are updated in the setup wizard
 */
function refreshGSXLinks() {
  console.log('[Menu] Refreshing GSX links from file system');
  try {
    // Get current IDW environments first
    let idwEnvironments = [];
    const electronApp = require('electron').app;
    const userDataPath = electronApp.getPath('userData');
    const idwConfigPath = path.join(userDataPath, 'idw-entries.json');
    
    console.log('[Menu] Checking for IDW environments file at:', idwConfigPath);
    if (fs.existsSync(idwConfigPath)) {
      try {
        const idwData = fs.readFileSync(idwConfigPath, 'utf8');
        idwEnvironments = JSON.parse(idwData);
        console.log(`[Menu] Loaded ${idwEnvironments.length} IDW environments for GSX refresh`);
        
        // Log IDW environments for debugging
        idwEnvironments.forEach(env => {
          console.log(`[Menu] IDW Environment: id=${env.id || 'undefined'}, label=${env.label}, environment=${env.environment}`);
          
          // Ensure environment has an ID (critical for custom links)
          if (!env.id) {
            // Generate an ID if missing
            env.id = `${env.label}-${env.environment}`.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
            console.log(`[Menu] Generated missing ID for environment: ${env.id}`);
          }
        });
      } catch (error) {
        console.error('[Menu] Error parsing IDW environments from file:', error);
        idwEnvironments = [];
      }
    } else {
      console.log('[Menu] IDW environments file not found');
    }
    
    // Load GSX links from file
    const gsxConfigPath = path.join(userDataPath, 'gsx-links.json');
    console.log('[Menu] Checking for GSX links file at:', gsxConfigPath);
    
    if (fs.existsSync(gsxConfigPath)) {
      try {
        console.log('[Menu] Found gsx-links.json, reading fresh data');
        const data = fs.readFileSync(gsxConfigPath, 'utf8');
        const allGsxLinks = JSON.parse(data);
        console.log(`[Menu] Loaded ${allGsxLinks.length} GSX links`);
        
        // Log all links for debugging
        console.log('[Menu] All links in GSX links file:');
        allGsxLinks.forEach(link => {
          console.log(`[Menu] Link: ID=${link.id}, Label=${link.label}, URL=${link.url && link.url.substring(0, 30)}..., IDW=${link.idwId || 'none'}, Custom=${link.custom || false}, Env=${link.environment || 'none'}`);
        });
        
        // Log custom links for deeper debugging
        const customLinks = allGsxLinks.filter(link => link.custom === true);
        console.log(`[Menu] Found ${customLinks.length} custom links in GSX links file:`);
        customLinks.forEach(link => {
          const linkIdwId = String(link.idwId || '').trim();
          console.log(`[Menu] Custom link: ID=${link.id}, Label=${link.label}, URL=${link.url && link.url.substring(0, 30)}..., IDW=${linkIdwId}, Env=${link.environment || 'none'}`);
          
          // Check if this link has an IDW ID that matches any IDW environment
          const matchingEnv = idwEnvironments.find(env => {
            const envId = String(env.id || '').trim();
            return envId === linkIdwId;
          });
          
          if (matchingEnv) {
            console.log(`[Menu] ✓ Custom link ${link.id} matches IDW ${matchingEnv.label} (${matchingEnv.id})`);
          } else {
            console.log(`[Menu] ✕ Custom link ${link.id} has no matching IDW environment for ID ${linkIdwId}`);
            
            // Try to find an environment match by environment name as fallback
            if (link.environment) {
              const envMatch = idwEnvironments.find(env => 
                env.environment && 
                env.environment.toLowerCase() === link.environment.toLowerCase()
              );
              
              if (envMatch) {
                console.log(`[Menu] ℹ️ Found fallback match by environment name: ${link.environment} -> ${envMatch.label}`);
              }
            }
          }
        });
        
        // Rebuild the menu completely with the fresh data
        console.log('[Menu] Building a fresh application menu');
        const newMenu = createMenu(isTestMenuVisible, idwEnvironments);
        console.log('[Menu] Setting the fresh application menu');
        Menu.setApplicationMenu(newMenu);
        
        console.log('[Menu] Menu refreshed with latest GSX links');
        return true;
      } catch (error) {
        console.error('[Menu] Error parsing GSX links from file:', error);
        return false;
      }
    } else {
      console.log('[Menu] GSX links file not found – generating default links');
      
      // Load user preferences to get GSX account ID
      let gsxAccountId = '';
      try {
        const prefsPath = path.join(userDataPath, 'user-preferences.json');
        if (fs.existsSync(prefsPath)) {
          const prefsData = fs.readFileSync(prefsPath, 'utf8');
          const userPrefs = JSON.parse(prefsData);
          if (userPrefs.gsxAccountId) {
            gsxAccountId = userPrefs.gsxAccountId;
            console.log('[Menu] Found GSX Account ID in user preferences:', gsxAccountId);
          }
        }
      } catch (error) {
        console.error('[Menu] Error loading user preferences for GSX account ID:', error);
      }
      
      const defaultLinks = generateDefaultGSXLinks(idwEnvironments, gsxAccountId);
      if (defaultLinks.length) {
        try {
          fs.writeFileSync(gsxConfigPath, JSON.stringify(defaultLinks, null, 2));
          console.log(`[Menu] Wrote ${defaultLinks.length} default GSX links to`, gsxConfigPath);
          // Recursively call refresh to build menu with fresh data
          return refreshGSXLinks();
        } catch (err) {
          console.error('[Menu] Failed to write default GSX links:', err);
        }
      } else {
        console.warn('[Menu] No IDWs available – skipping default GSX link generation');
      }
      return false;
    }
  } catch (error) {
    console.error('[Menu] Error refreshing GSX links:', error);
    return false;
  }
}

// Helper: generate default GSX links for all IDWs ----------------------------
function generateDefaultGSXLinks(idwEnvironments=[], accountId='') {
  if (!Array.isArray(idwEnvironments) || idwEnvironments.length === 0) return [];
  const links = [];
  const withAccount = url => accountId ? `${url}?accountId=${accountId}` : url;
  idwEnvironments.forEach(env => {
    const envName = env.environment;
    const idwId   = env.id;
    if (!envName || !idwId) return; // skip incomplete entries
    links.push(
      { id:`hitl-${envName}-${idwId}`,       label:'HITL',       url: withAccount(`https://hitl.${envName}.onereach.ai/`),              environment: envName, idwId },
      { id:`actiondesk-${envName}-${idwId}`, label:'Action Desk',url: withAccount(`https://actiondesk.${envName}.onereach.ai/dashboard/`), environment: envName, idwId },
      { id:`designer-${envName}-${idwId}`,   label:'Designer',   url: withAccount(`https://studio.${envName}.onereach.ai/bots`),         environment: envName, idwId },
      { id:`tickets-${envName}-${idwId}`,    label:'Tickets',    url: withAccount(`https://tickets.${envName}.onereach.ai/`),            environment: envName, idwId },
      { id:`calendar-${envName}-${idwId}`,   label:'Calendar',   url: withAccount(`https://calendar.${envName}.onereach.ai/`),           environment: envName, idwId },
      { id:`developer-${envName}-${idwId}`,  label:'Developer',  url: withAccount(`https://docs.${envName}.onereach.ai/`),               environment: envName, idwId }
    );
  });
  return links;
}

/**
 * Refreshes the application menu to update dynamic content
 */
function refreshApplicationMenu() {
  // Get current IDW environments
  let idwEnvironments = [];
  try {
    const electronApp = require('electron').app;
    const userDataPath = electronApp.getPath('userData');
    const idwConfigPath = path.join(userDataPath, 'idw-entries.json');
    
    if (fs.existsSync(idwConfigPath)) {
      const idwData = fs.readFileSync(idwConfigPath, 'utf8');
      idwEnvironments = JSON.parse(idwData);
    }
  } catch (error) {
    console.error('[Menu] Error loading IDW environments:', error);
  }
  
  setApplicationMenu(idwEnvironments);
}

module.exports = {
  createMenu,
  setApplicationMenu,
  registerTestMenuShortcut,
  refreshGSXLinks,
  refreshApplicationMenu
}; 