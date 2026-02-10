/**
 * IDW & GSX Menu Builder
 * 
 * Builds the dynamic IDW environment and GSX link menu items.
 * This is the most complex part of menu construction, handling:
 * - IDW environment items with keyboard shortcuts
 * - GSX link filtering per environment (custom vs standard matching)
 * - External bots, image/video/audio creators, UI design tools
 * - GSX API documentation submenus
 * - GSX File Sync submenu
 * 
 * Extracted from menu.js for maintainability.
 */

const { app, shell, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { openGSXLargeWindow } = require('../gsx-autologin');
const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

/**
 * Build IDW and GSX menu items from cached data
 * @param {Array} idwEnvironments - IDW environment configurations
 * @param {Object} cachedData - Cached menu data (gsxLinks, externalBots, etc.)
 * @returns {{ idwMenuItems: Array, gsxMenuItems: Array }}
 */
function buildIDWAndGSXMenuItems(idwEnvironments, cachedData) {
  const idwMenuItems = [];
  const gsxMenuItems = [];
  
  const allGsxLinks = cachedData.gsxLinks || [];
  const externalBots = cachedData.externalBots || [];
  const imageCreators = cachedData.imageCreators || [];
  const videoCreators = cachedData.videoCreators || [];
  const audioGenerators = cachedData.audioGenerators || [];
  const uiDesignTools = cachedData.uiDesignTools || [];

  log.info('menu', 'Processing IDW environments to create menu items...');
  if (idwEnvironments && idwEnvironments.length > 0) {
    idwEnvironments.forEach((env, index) => {
      log.info('menu', 'Processing IDW Env : Label=\'\', URL=\'\', Environment', { index1: index + 1, env: env.label, env: env.chatUrl, env: env.environment });
      if (!env.label || !env.chatUrl || !env.environment) {
        log.warn('menu', 'Skipping IDW Env due to missing properties.', { index1: index + 1 });
        return;
      }

      // --- IDW Menu Item ---
      const accelerator = index < 9 ? `CmdOrCtrl+${index + 1}` : undefined;
      
      idwMenuItems.push({
        label: env.label,
        accelerator: accelerator,
        click: (menuItem, browserWindow) => {
          log.info('menu', 'IDW menu item clicked', { env: env.label });
          
          if (browserWindow) {
            log.info('menu', 'Opening IDW environment chat in main window', { env: env.chatUrl });
            ipcMain.emit('menu-action', null, {
              action: 'open-idw-url',
              url: env.chatUrl,
              label: env.label
            });
          } else {
            log.info('menu', 'Opening IDW environment chat in external browser', { env: env.chatUrl });
            let urlToOpen = env.chatUrl;
            if (urlToOpen && typeof urlToOpen === 'string') {
              urlToOpen = urlToOpen.trim();
              if (!urlToOpen.startsWith('http://') && !urlToOpen.startsWith('https://')) {
                const httpsIndex = urlToOpen.indexOf('https://');
                const httpIndex = urlToOpen.indexOf('http://');
                if (httpsIndex > 0) {
                  urlToOpen = urlToOpen.substring(httpsIndex);
                } else if (httpIndex > 0) {
                  urlToOpen = urlToOpen.substring(httpIndex);
                }
              }
              log.info('menu', 'Cleaned URL', { urlToOpen: urlToOpen });
              shell.openExternal(urlToOpen);
            } else {
              log.error('menu', 'Invalid URL', { env: env.chatUrl });
            }
          }
        }
      });

      // --- GSX Submenu Item ---
      const gsxSubmenu = [];
      log.info('menu', 'Filtering GSX links for environment:', { env: env.environment });
      
      const gsxLinks = filterGSXLinksForEnvironment(allGsxLinks, env);
      log.info('menu', 'Found matching GSX links for', { gsxLinks: gsxLinks.length, env: env.label });

      if (gsxLinks && gsxLinks.length > 0) {
        gsxLinks.forEach((link, linkIndex) => {
          log.info('menu', 'Adding GSX submenu item : Label=\'\', URL', { linkIndex1: linkIndex + 1, link: link.label, link: link.url });
          gsxSubmenu.push({
            label: link.label,
            click: async () => {
              log.info('menu', 'GSX menu item clicked: (URL: , Env: )', { link: link.label, link: link.url, env: env.environment });
              try {
                openGSXLargeWindow(
                  link.url,
                  link.label,
                  `${link.label} - ${env.label}`,
                  `Loading ${link.label}...`,
                  env.environment
                );
                log.info('menu', 'GSX window created successfully.');
              } catch (error) {
                log.error('menu', 'Failed to open GSX URL', { error: error });
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
        log.info('menu', 'No matching GSX links found for \'\', adding \'No links\' item.', { env: env.label });
        gsxSubmenu.push({
          label: 'No GSX links available',
          enabled: false
        });
      }

      gsxMenuItems.push({
        label: env.label,
        submenu: gsxSubmenu
      });
    });
    
    if (idwMenuItems.length > 0) {
      idwMenuItems.push({ type: 'separator' });
    }
  } else {
    log.info('menu', 'No valid IDW environments found or loaded.');
  }
  
  // Add Explore IDW Store menu item
  idwMenuItems.push({
    label: 'Explore IDW Store',
    click: () => {
      log.info('menu', 'Opening IDW Store...');
      const storeWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          preload: path.join(__dirname, '..', '..', 'preload.js'),
          webSecurity: true,
          sandbox: false
        },
        title: 'Explore IDW Store',
        backgroundColor: '#000000',
        show: false
      });
      storeWindow.loadFile('idw-store.html');
      storeWindow.once('ready-to-show', () => {
        storeWindow.show();
      });
      log.info('menu', 'IDW Store window created');
    }
  });
  
  idwMenuItems.push({ type: 'separator' });
  
  // Add/Remove
  idwMenuItems.push({
    label: 'Add/Remove',
    accelerator: 'CmdOrCtrl+A',
    click: () => {
      log.info('menu', 'Add/Remove clicked, calling global.openSetupWizardGlobal');
      if (typeof global.openSetupWizardGlobal === 'function') {
        global.openSetupWizardGlobal();
      } else {
        log.error('menu', 'openSetupWizardGlobal function not found in global scope');
      }
    }
  });

  // Add external bots
  _addExternalBots(idwMenuItems, externalBots);
  
  // Add image creators
  _addImageCreators(idwMenuItems, imageCreators);
  
  // Add video creators
  _addVideoCreators(idwMenuItems, videoCreators);
  
  // Add audio generators
  _addAudioGenerators(idwMenuItems, audioGenerators);
  
  // Add UI design tools
  _addUIDesignTools(idwMenuItems, uiDesignTools);

  // Build GSX API docs submenus
  _addGSXAPIDocs(gsxMenuItems, { externalBots, imageCreators, videoCreators, audioGenerators, uiDesignTools });
  
  // Add GSX File Sync
  _addGSXFileSync(gsxMenuItems);

  return { idwMenuItems, gsxMenuItems };
}

// ============================================
// GSX Link Filtering
// ============================================

function filterGSXLinksForEnvironment(allGsxLinks, env) {
  return allGsxLinks.filter(link => {
    if (!link.url || !link.label) {
      log.warn('menu', 'Skipping GSX link due to missing properties', { link: link });
      return false;
    }
    
    // Custom links - MUST match exactly the IDW ID
    if (link.custom === true) {
      log.info('menu', 'Evaluating custom link: ID=, Label', { link: link.id, link: link.label });
      log.info('menu', 'Custom link properties: idwId=, env.id', { link: link.idwId || 'none', env: env.id || 'none' });
      
      if (!link.idwId) {
        log.info('menu', 'Custom link has no idwId, excluding from all menus', { link: link.id });
        return false;
      }
      
      if (!env.id) {
        log.info('menu', 'Environment has no id, cannot match custom links', { env: env.label });
        return false;
      }
      
      const linkIdwId = String(link.idwId).trim();
      const envId = String(env.id).trim();
      const idMatch = linkIdwId === envId;
      log.info('menu', 'Custom link IDW match check: \'\' === \'\'', { linkIdwId: linkIdwId, envId: envId, idMatch: idMatch });
      
      if (!idMatch && link.environment && env.environment && 
          link.environment.toLowerCase() === env.environment.toLowerCase()) {
        log.info('menu', 'Custom link matches environment name as fallback', { link: link.id, link: link.environment });
        return true;
      }
      
      return idMatch;
    }
    
    // Standard links - environment + idwId matching
    if (link.environment && env.environment &&
        link.environment.toLowerCase() === env.environment.toLowerCase()) {
      if (link.idwId) {
        if (env.id && link.idwId === env.id) {
          log.info('menu', 'Standard link matches by idwId: (env=, idwId=)', { link: link.label, link: link.environment, link: link.idwId });
          return true;
        } else {
          return false;
        }
      } else {
        log.info('menu', 'Legacy link matches by environment only: (env=)', { link: link.label, link: link.environment });
        return true;
      }
    }
    
    // URL-based matching only for legacy links without idwId
    if (link.idwId) {
      return false;
    }
    
    try {
      const url = new URL(link.url);
      let match = false;
      
      if (env.environment && url.hostname.includes(env.environment)) {
        log.info('menu', 'GSX link URL hostname includes environment: hostname=\'\', env', { url: url.hostname, env: env.environment });
        match = true;
      }
      
      if (!match && !url.hostname.includes('staging.') && 
          !url.hostname.includes('edison.') && 
          !url.hostname.includes('production.')) {
        log.info('menu', 'GSX URL \'\' has no environment prefix, including it for all environments', { url: url.hostname });
        match = true;
      }
      
      log.info('menu', 'Checking GSX link: URL=\'\', Host=\'\', Matches Env=\'\'?', { link: link.url, url: url.hostname, env: env.environment, match: match });
      return match;
    } catch (e) {
      log.warn('menu', 'Skipping GSX link due to invalid URL', { link: link.url, e: e });
      return false;
    }
  });
}

// ============================================
// IDW Menu Section Builders
// ============================================

function _addExternalBots(idwMenuItems, externalBots) {
  if (!externalBots || externalBots.length === 0) return;
  
  log.info('menu', 'Adding external bots to IDW menu', { externalBots: externalBots.length });
  idwMenuItems.push({ type: 'separator' });
  idwMenuItems.push({ label: 'External Bots', enabled: false });
  
  externalBots.forEach((bot, botIndex) => {
    log.info('menu', 'Adding external bot to IDW menu: ()', { bot: bot.name, bot: bot.chatUrl });
    const botAccelerator = botIndex < 4 ? `Alt+${botIndex + 1}` : undefined;
    
    idwMenuItems.push({
      label: bot.name,
      accelerator: botAccelerator,
      click: async () => {
        log.info('menu', 'Opening external bot in tab: at', { bot: bot.name, bot: bot.chatUrl });
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

function _addImageCreators(idwMenuItems, imageCreators) {
  if (!imageCreators || imageCreators.length === 0) return;
  
  log.info('menu', 'Adding image creators to IDW menu', { imageCreators: imageCreators.length });
  idwMenuItems.push({ type: 'separator' });
  idwMenuItems.push({ label: 'Image Creators', enabled: false });
  
  imageCreators.forEach((creator, creatorIndex) => {
    log.info('menu', 'Adding image creator to IDW menu: ()', { creator: creator.name, creator: creator.url });
    const creatorAccelerator = creatorIndex < 4 ? `Shift+CmdOrCtrl+${creatorIndex + 1}` : undefined;
    
    idwMenuItems.push({
      label: creator.name,
      accelerator: creatorAccelerator,
      click: async () => {
        log.info('menu', 'Opening image creator in tab: at', { creator: creator.name, creator: creator.url });
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

function _addVideoCreators(idwMenuItems, videoCreators) {
  if (!videoCreators || videoCreators.length === 0) return;
  
  log.info('menu', 'Adding video creators to IDW menu', { videoCreators: videoCreators.length });
  idwMenuItems.push({ type: 'separator' });
  idwMenuItems.push({ label: 'Video Creators', enabled: false });
  
  videoCreators.forEach(creator => {
    log.info('menu', 'Adding video creator to IDW menu: ()', { creator: creator.name, creator: creator.url });
    idwMenuItems.push({
      label: creator.name,
      click: async () => {
        log.info('menu', 'Opening video creator in tab: at', { creator: creator.name, creator: creator.url });
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

function _addAudioGenerators(idwMenuItems, audioGenerators) {
  if (!audioGenerators || audioGenerators.length === 0) return;
  
  log.info('menu', 'Adding audio generators to IDW menu', { audioGenerators: audioGenerators.length });
  idwMenuItems.push({ type: 'separator' });
  idwMenuItems.push({ label: 'Audio Generators', enabled: false });
  
  const audioByCategory = { music: [], effects: [], narration: [], custom: [] };
  
  audioGenerators.forEach(generator => {
    const category = generator.category || 'custom';
    if (audioByCategory[category]) {
      audioByCategory[category].push(generator);
    } else {
      audioByCategory.custom.push(generator);
    }
  });
  
  const categoryConfig = [
    { key: 'music', label: 'Music' },
    { key: 'effects', label: 'Sound Effects' },
    { key: 'narration', label: 'Narration & Voice' },
    { key: 'custom', label: 'Custom' }
  ];
  
  categoryConfig.forEach(({ key, label }) => {
    if (audioByCategory[key].length > 0) {
      idwMenuItems.push({
        label: label,
        submenu: audioByCategory[key].map(generator => ({
          label: generator.name,
          click: async () => {
            log.info('menu', 'Opening audio generator in tab: at', { generator: generator.name, generator: generator.url });
            ipcMain.emit('menu-action', null, {
              action: 'open-audio-generator',
              url: generator.url,
              label: generator.name,
              isAudioGenerator: true,
              category: key
            });
          }
        }))
      });
    }
  });
}

function _addUIDesignTools(idwMenuItems, uiDesignTools) {
  if (!uiDesignTools || uiDesignTools.length === 0) return;
  
  log.info('menu', 'Adding UI design tools to IDW menu', { uiDesignTools: uiDesignTools.length });
  idwMenuItems.push({ type: 'separator' });
  idwMenuItems.push({ label: 'UI Design Tools', enabled: false });

  uiDesignTools.forEach(tool => {
    idwMenuItems.push({
      label: tool.name,
      click: () => {
        log.info('menu', 'Opening UI design tool: ->', { tool: tool.name, tool: tool.url });
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

// ============================================
// GSX API Documentation Submenus
// ============================================

function _addGSXAPIDocs(gsxMenuItems, data) {
  const { externalBots, imageCreators, videoCreators, audioGenerators, uiDesignTools } = data;
  
  // No IDW environments message
  if (gsxMenuItems.length === 0) {
    log.info('menu', 'No IDW environments configured, adding disabled item to GSX menu.');
    gsxMenuItems.push({ label: 'No IDW environments available', enabled: false });
  }
  
  const hasIDWItems = gsxMenuItems.length > 0 && gsxMenuItems[0].label !== 'No IDW environments available';
  let hasPreviousAPISection = false;
  
  // Helper to add API doc section
  function addAPISection(items, filterFn, label) {
    const withAPIs = items.filter(filterFn);
    if (withAPIs.length === 0) return;
    
    log.info('menu', 'Processing for GSX menu', { withAPIs: withAPIs.length, label: label });
    
    if (hasIDWItems && !hasPreviousAPISection) {
      gsxMenuItems.push({ type: 'separator' });
    }
    hasPreviousAPISection = true;
    
    gsxMenuItems.push({
      label: label,
      submenu: withAPIs.map(item => ({
        label: `${item.name} API`,
        click: async () => {
          log.info('menu', 'Opening API docs for at', { item: item.name, item: item.apiUrl });
          openGSXLargeWindow(
            item.apiUrl,
            `${item.name} API`,
            `${item.name} API Documentation`,
            `Loading ${item.name} API documentation...`
          );
        }
      }))
    });
  }
  
  addAPISection(externalBots || [], b => b.apiUrl, 'External Bot APIs');
  addAPISection(imageCreators || [], c => c.apiUrl, 'Image Creator APIs');
  addAPISection(videoCreators || [], c => c.apiUrl, 'Video Creator APIs');
  addAPISection(audioGenerators || [], g => g.apiUrl, 'Audio Generator APIs');
  
  // UI Design tool APIs (these open externally)
  if (uiDesignTools && uiDesignTools.length > 0) {
    const toolsWithAPIs = uiDesignTools.filter(t => t.apiUrl);
    if (toolsWithAPIs.length) {
      log.info('menu', 'Adding UI design tool API docs to GSX menu', { toolsWithAPIs: toolsWithAPIs.length });
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
}

// ============================================
// GSX File Sync Submenu
// ============================================

function _addGSXFileSync(gsxMenuItems) {
  if (gsxMenuItems.length > 0 && gsxMenuItems[0].label !== 'No IDW environments available') {
    gsxMenuItems.push({ type: 'separator' });
  }
  
  gsxMenuItems.push({
    label: 'File Sync',
    submenu: [
      {
        label: 'Complete Backup (Recommended)',
        click: async () => {
          log.info('menu', 'Complete Backup clicked');
          const { getGSXFileSync } = require('../../gsx-file-sync');
          const gsxFileSync = getGSXFileSync();
          const { dialog, Notification } = require('electron');
          
          const notification = new Notification({
            title: 'GSX Backup',
            body: 'Starting complete backup...'
          });
          notification.show();
          
          try {
            log.info('menu', 'Calling syncCompleteBackup...');
            const result = await gsxFileSync.syncCompleteBackup();
            log.info('menu', 'Backup result', { data: JSON.stringify(result, null, 2) });
            
            if (!result || !result.summary) {
              log.error('menu', 'Result missing summary', { result: result });
              throw new Error('Backup completed but result format is unexpected');
            }
            
            let reportDetails = `Backup completed in ${result.summary.durationFormatted || '0s'}\n\n`;
            reportDetails += `Summary:\n`;
            reportDetails += `Total Files: ${result.summary.totalFiles || 0}\n`;
            reportDetails += `Total Size: ${result.summary.totalSizeFormatted || '0 Bytes'}\n`;
            reportDetails += `Environment: ${result.summary.environment || 'unknown'}\n`;
            reportDetails += `Timestamp: ${result.timestamp || new Date().toISOString()}\n\n`;
            reportDetails += `What was backed up:\n\n`;
            
            if (result.results && result.results.length > 0) {
              result.results.forEach(r => {
                reportDetails += `${r.name || 'Unknown'}:\n`;
                reportDetails += `  Files: ${r.fileCount || 0}\n`;
                reportDetails += `  Size: ${r.totalSizeFormatted || '0 Bytes'}\n`;
                reportDetails += `  Duration: ${r.durationFormatted || '0s'}\n`;
                reportDetails += `  Location: GSX Files/${r.remotePath || 'unknown'}\n\n`;
              });
            } else {
              reportDetails += `(Details not available)\n\n`;
            }
            
            reportDetails += `Access your files at:\n`;
            const envPrefix = result.summary.environment && result.summary.environment !== 'production' 
              ? result.summary.environment + '.' 
              : '';
            reportDetails += `https://studio.${envPrefix}onereach.ai/files`;
            
            log.info('menu', 'Showing success dialog...');
            
            dialog.showMessageBox({
              type: 'info',
              title: 'Complete Backup Successful',
              message: 'All your data has been backed up to GSX Files',
              detail: reportDetails,
              buttons: ['OK']
            });
            
            const successNotification = new Notification({
              title: 'Backup Complete',
              body: `Backed up ${result.summary.totalFiles || 0} files (${result.summary.totalSizeFormatted || '0 Bytes'})`
            });
            successNotification.show();
          } catch (error) {
            log.error('menu', 'Backup error', { error: error });
            
            dialog.showMessageBox({
              type: 'error',
              title: 'Backup Error',
              message: 'Complete backup failed',
              detail: error.message || 'Unknown error occurred',
              buttons: ['OK']
            });
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Sync Options',
        submenu: [
          {
            label: 'Sync Spaces',
            click: async () => {
              log.info('menu', 'Sync Spaces clicked');
              const { getGSXFileSync } = require('../../gsx-file-sync');
              const gsxFileSync = getGSXFileSync();
              const { Notification } = require('electron');
              
              const notification = new Notification({
                title: 'GSX File Sync',
                body: 'Syncing clipboard spaces...'
              });
              notification.show();
              
              try {
                const result = await gsxFileSync.syncClipboardData();
                const successNotification = new Notification({
                  title: 'Sync Complete',
                  body: `Synced ${result.fileCount || 0} files (${result.totalSizeFormatted || '0 Bytes'})`
                });
                successNotification.show();
              } catch (error) {
                log.error('menu', 'Sync error', { error: error });
                const errorNotification = new Notification({
                  title: 'Sync Error',
                  body: error.message || 'Failed to sync'
                });
                errorNotification.show();
              }
            }
          },
          {
            label: 'Sync Settings',
            click: async () => {
              log.info('menu', 'Sync Settings clicked');
              const { getGSXFileSync } = require('../../gsx-file-sync');
              const gsxFileSync = getGSXFileSync();
              const { Notification } = require('electron');
              
              const notification = new Notification({
                title: 'GSX File Sync',
                body: 'Syncing app settings...'
              });
              notification.show();
              
              try {
                const result = await gsxFileSync.syncAppSettings();
                const successNotification = new Notification({
                  title: 'Settings Synced',
                  body: `Synced ${result.fileCount || 0} setting files`
                });
                successNotification.show();
              } catch (error) {
                log.error('menu', 'Settings sync error', { error: error });
              }
            }
          }
        ]
      },
      { type: 'separator' },
      {
        label: 'View Sync History',
        click: async () => {
          log.info('menu', 'View Sync History clicked');
          const { getGSXFileSync } = require('../../gsx-file-sync');
          const gsxFileSync = getGSXFileSync();
          const { dialog } = require('electron');
          
          const history = await gsxFileSync.getHistory();
          
          if (!history || history.length === 0) {
            dialog.showMessageBox({
              type: 'info',
              title: 'Sync History',
              message: 'No sync history available',
              detail: 'Run a sync operation first to see history.',
              buttons: ['OK']
            });
            return;
          }
          
          let detail = '';
          history.slice(0, 10).forEach(entry => {
            detail += `${new Date(entry.timestamp).toLocaleString()}\n`;
            detail += `  Type: ${entry.type}\n`;
            detail += `  Files: ${entry.fileCount || 0}\n`;
            detail += `  Size: ${entry.totalSizeFormatted || 'unknown'}\n\n`;
          });
          
          dialog.showMessageBox({
            type: 'info',
            title: 'Sync History',
            message: `Last ${Math.min(history.length, 10)} sync operations`,
            detail: detail,
            buttons: ['OK']
          });
        }
      },
      {
        label: 'Clear Sync History',
        click: async () => {
          log.info('menu', 'Clear Sync History clicked');
          const { getGSXFileSync } = require('../../gsx-file-sync');
          const gsxFileSync = getGSXFileSync();
          const { dialog } = require('electron');
          
          await gsxFileSync.clearHistory();
          
          dialog.showMessageBox({
            type: 'info',
            title: 'History Cleared',
            message: 'Sync history has been cleared.'
          });
        }
      }
    ]
  });
}

module.exports = {
  buildIDWAndGSXMenuItems,
  filterGSXLinksForEnvironment
};
