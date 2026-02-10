/**
 * ProjectManagerIPC - IPC handler registration for project management
 * @module src/project-manager/ProjectManagerIPC
 */

const { ipcMain } = require('electron');
const ProjectManager = require('./ProjectManager');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

let projectManager = null;

/**
 * Get or create the ProjectManager instance
 * @returns {ProjectManager}
 */
function getProjectManager() {
  if (!projectManager) {
    projectManager = new ProjectManager();
  }
  return projectManager;
}

/**
 * Register all project management IPC handlers
 */
function setupProjectManagerIPC() {
  const pm = getProjectManager();
  
  log.info('app', '[ProjectManagerIPC] Registering IPC handlers...');

  // ==================== PROJECT OPERATIONS ====================

  ipcMain.handle('project:create', async (event, options) => {
    try {
      const result = await pm.createProject(options);
      return result;
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Create project error', { error: error });
      return { error: error.message };
    }
  });

  ipcMain.handle('project:get', async (event, projectId) => {
    try {
      return pm.getProject(projectId);
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Get project error', { error: error });
      return null;
    }
  });

  ipcMain.handle('project:getAll', async (event) => {
    try {
      return pm.getAllProjects();
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Get all projects error', { error: error });
      return [];
    }
  });

  ipcMain.handle('project:getBySpace', async (event, spaceId) => {
    try {
      return pm.getProjectsForSpace(spaceId);
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Get projects by space error', { error: error });
      return [];
    }
  });

  ipcMain.handle('project:update', async (event, projectId, updates) => {
    try {
      return pm.storage.updateProject(projectId, updates);
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Update project error', { error: error });
      return { error: error.message };
    }
  });

  ipcMain.handle('project:rename', async (event, projectId, newName) => {
    try {
      return pm.renameProject(projectId, newName);
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Rename project error', { error: error });
      return { error: error.message };
    }
  });

  ipcMain.handle('project:delete', async (event, projectId) => {
    try {
      return pm.deleteProject(projectId);
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Delete project error', { error: error });
      return false;
    }
  });

  // ==================== ASSET OPERATIONS ====================

  ipcMain.handle('project:addAsset', async (event, projectId, filePath, type) => {
    try {
      return await pm.addAssetToProject(projectId, filePath, type);
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Add asset error', { error: error });
      return { error: error.message };
    }
  });

  ipcMain.handle('project:removeAsset', async (event, projectId, assetId) => {
    try {
      return pm.removeAssetFromProject(projectId, assetId);
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Remove asset error', { error: error });
      return false;
    }
  });

  ipcMain.handle('project:getAssets', async (event, projectId) => {
    try {
      return pm.getProjectAssets(projectId);
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Get assets error', { error: error });
      return [];
    }
  });

  // ==================== VERSION OPERATIONS ====================

  ipcMain.handle('project:createVersion', async (event, projectId, options) => {
    try {
      return pm.createVersion(projectId, options);
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Create version error', { error: error });
      return { error: error.message };
    }
  });

  ipcMain.handle('project:getVersion', async (event, versionId) => {
    try {
      return pm.getVersion(versionId);
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Get version error', { error: error });
      return null;
    }
  });

  ipcMain.handle('project:getVersions', async (event, projectId) => {
    try {
      return pm.getProjectVersions(projectId);
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Get versions error', { error: error });
      return [];
    }
  });

  ipcMain.handle('project:updateVersion', async (event, versionId, updates) => {
    try {
      return pm.updateVersion(versionId, updates);
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Update version error', { error: error });
      return { error: error.message };
    }
  });

  ipcMain.handle('project:renameVersion', async (event, versionId, newName) => {
    try {
      return pm.renameVersion(versionId, newName);
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Rename version error', { error: error });
      return { error: error.message };
    }
  });

  ipcMain.handle('project:deleteVersion', async (event, versionId) => {
    try {
      return pm.deleteVersion(versionId);
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Delete version error', { error: error });
      return false;
    }
  });

  ipcMain.handle('project:branchVersion', async (event, sourceVersionId, newName) => {
    try {
      return pm.branchVersion(sourceVersionId, newName);
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Branch version error', { error: error });
      return { error: error.message };
    }
  });

  ipcMain.handle('project:setDefaultVersion', async (event, projectId, versionId) => {
    try {
      return pm.setDefaultVersion(projectId, versionId);
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Set default version error', { error: error });
      return { error: error.message };
    }
  });

  ipcMain.handle('project:getVersionTree', async (event, projectId) => {
    try {
      return pm.getVersionTree(projectId);
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Get version tree error', { error: error });
      return { root: null, nodes: {}, children: {} };
    }
  });

  // ==================== SESSION OPERATIONS ====================

  ipcMain.handle('project:loadSession', async (event, projectId, versionId) => {
    try {
      return pm.loadSession(projectId, versionId);
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Load session error', { error: error });
      return { error: error.message };
    }
  });

  ipcMain.handle('project:saveSession', async (event, state) => {
    try {
      return pm.saveSession(state);
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Save session error', { error: error });
      return { error: error.message };
    }
  });

  ipcMain.handle('project:closeSession', async (event, state) => {
    try {
      pm.closeSession(state);
      return { success: true };
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Close session error', { error: error });
      return { error: error.message };
    }
  });

  ipcMain.handle('project:getCurrentSession', async (event) => {
    try {
      return pm.getCurrentSession();
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Get current session error', { error: error });
      return null;
    }
  });

  // ==================== EXPORT/IMPORT ====================

  ipcMain.handle('project:export', async (event, projectId) => {
    try {
      return pm.exportProject(projectId);
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Export project error', { error: error });
      return null;
    }
  });

  ipcMain.handle('project:import', async (event, data) => {
    try {
      return pm.importProject(data);
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Import project error', { error: error });
      return { error: error.message };
    }
  });

  ipcMain.handle('project:getStats', async (event) => {
    try {
      return pm.getStats();
    } catch (error) {
      log.error('app', '[ProjectManagerIPC] Get stats error', { error: error });
      return { projectCount: 0, versionCount: 0, assetCount: 0 };
    }
  });

  log.info('app', '[ProjectManagerIPC] All IPC handlers registered successfully');
}

module.exports = {
  setupProjectManagerIPC,
  getProjectManager
};











