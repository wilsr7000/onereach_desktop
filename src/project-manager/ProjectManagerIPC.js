/**
 * ProjectManagerIPC - IPC handler registration for project management
 * @module src/project-manager/ProjectManagerIPC
 */

const { ipcMain } = require('electron');
const ProjectManager = require('./ProjectManager');

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
  
  console.log('[ProjectManagerIPC] Registering IPC handlers...');

  // ==================== PROJECT OPERATIONS ====================

  ipcMain.handle('project:create', async (event, options) => {
    try {
      const result = await pm.createProject(options);
      return result;
    } catch (error) {
      console.error('[ProjectManagerIPC] Create project error:', error);
      return { error: error.message };
    }
  });

  ipcMain.handle('project:get', async (event, projectId) => {
    try {
      return pm.getProject(projectId);
    } catch (error) {
      console.error('[ProjectManagerIPC] Get project error:', error);
      return null;
    }
  });

  ipcMain.handle('project:getAll', async (event) => {
    try {
      return pm.getAllProjects();
    } catch (error) {
      console.error('[ProjectManagerIPC] Get all projects error:', error);
      return [];
    }
  });

  ipcMain.handle('project:getBySpace', async (event, spaceId) => {
    try {
      return pm.getProjectsForSpace(spaceId);
    } catch (error) {
      console.error('[ProjectManagerIPC] Get projects by space error:', error);
      return [];
    }
  });

  ipcMain.handle('project:update', async (event, projectId, updates) => {
    try {
      return pm.storage.updateProject(projectId, updates);
    } catch (error) {
      console.error('[ProjectManagerIPC] Update project error:', error);
      return { error: error.message };
    }
  });

  ipcMain.handle('project:rename', async (event, projectId, newName) => {
    try {
      return pm.renameProject(projectId, newName);
    } catch (error) {
      console.error('[ProjectManagerIPC] Rename project error:', error);
      return { error: error.message };
    }
  });

  ipcMain.handle('project:delete', async (event, projectId) => {
    try {
      return pm.deleteProject(projectId);
    } catch (error) {
      console.error('[ProjectManagerIPC] Delete project error:', error);
      return false;
    }
  });

  // ==================== ASSET OPERATIONS ====================

  ipcMain.handle('project:addAsset', async (event, projectId, filePath, type) => {
    try {
      return await pm.addAssetToProject(projectId, filePath, type);
    } catch (error) {
      console.error('[ProjectManagerIPC] Add asset error:', error);
      return { error: error.message };
    }
  });

  ipcMain.handle('project:removeAsset', async (event, projectId, assetId) => {
    try {
      return pm.removeAssetFromProject(projectId, assetId);
    } catch (error) {
      console.error('[ProjectManagerIPC] Remove asset error:', error);
      return false;
    }
  });

  ipcMain.handle('project:getAssets', async (event, projectId) => {
    try {
      return pm.getProjectAssets(projectId);
    } catch (error) {
      console.error('[ProjectManagerIPC] Get assets error:', error);
      return [];
    }
  });

  // ==================== VERSION OPERATIONS ====================

  ipcMain.handle('project:createVersion', async (event, projectId, options) => {
    try {
      return pm.createVersion(projectId, options);
    } catch (error) {
      console.error('[ProjectManagerIPC] Create version error:', error);
      return { error: error.message };
    }
  });

  ipcMain.handle('project:getVersion', async (event, versionId) => {
    try {
      return pm.getVersion(versionId);
    } catch (error) {
      console.error('[ProjectManagerIPC] Get version error:', error);
      return null;
    }
  });

  ipcMain.handle('project:getVersions', async (event, projectId) => {
    try {
      return pm.getProjectVersions(projectId);
    } catch (error) {
      console.error('[ProjectManagerIPC] Get versions error:', error);
      return [];
    }
  });

  ipcMain.handle('project:updateVersion', async (event, versionId, updates) => {
    try {
      return pm.updateVersion(versionId, updates);
    } catch (error) {
      console.error('[ProjectManagerIPC] Update version error:', error);
      return { error: error.message };
    }
  });

  ipcMain.handle('project:renameVersion', async (event, versionId, newName) => {
    try {
      return pm.renameVersion(versionId, newName);
    } catch (error) {
      console.error('[ProjectManagerIPC] Rename version error:', error);
      return { error: error.message };
    }
  });

  ipcMain.handle('project:deleteVersion', async (event, versionId) => {
    try {
      return pm.deleteVersion(versionId);
    } catch (error) {
      console.error('[ProjectManagerIPC] Delete version error:', error);
      return false;
    }
  });

  ipcMain.handle('project:branchVersion', async (event, sourceVersionId, newName) => {
    try {
      return pm.branchVersion(sourceVersionId, newName);
    } catch (error) {
      console.error('[ProjectManagerIPC] Branch version error:', error);
      return { error: error.message };
    }
  });

  ipcMain.handle('project:setDefaultVersion', async (event, projectId, versionId) => {
    try {
      return pm.setDefaultVersion(projectId, versionId);
    } catch (error) {
      console.error('[ProjectManagerIPC] Set default version error:', error);
      return { error: error.message };
    }
  });

  ipcMain.handle('project:getVersionTree', async (event, projectId) => {
    try {
      return pm.getVersionTree(projectId);
    } catch (error) {
      console.error('[ProjectManagerIPC] Get version tree error:', error);
      return { root: null, nodes: {}, children: {} };
    }
  });

  // ==================== SESSION OPERATIONS ====================

  ipcMain.handle('project:loadSession', async (event, projectId, versionId) => {
    try {
      return pm.loadSession(projectId, versionId);
    } catch (error) {
      console.error('[ProjectManagerIPC] Load session error:', error);
      return { error: error.message };
    }
  });

  ipcMain.handle('project:saveSession', async (event, state) => {
    try {
      return pm.saveSession(state);
    } catch (error) {
      console.error('[ProjectManagerIPC] Save session error:', error);
      return { error: error.message };
    }
  });

  ipcMain.handle('project:closeSession', async (event, state) => {
    try {
      pm.closeSession(state);
      return { success: true };
    } catch (error) {
      console.error('[ProjectManagerIPC] Close session error:', error);
      return { error: error.message };
    }
  });

  ipcMain.handle('project:getCurrentSession', async (event) => {
    try {
      return pm.getCurrentSession();
    } catch (error) {
      console.error('[ProjectManagerIPC] Get current session error:', error);
      return null;
    }
  });

  // ==================== EXPORT/IMPORT ====================

  ipcMain.handle('project:export', async (event, projectId) => {
    try {
      return pm.exportProject(projectId);
    } catch (error) {
      console.error('[ProjectManagerIPC] Export project error:', error);
      return null;
    }
  });

  ipcMain.handle('project:import', async (event, data) => {
    try {
      return pm.importProject(data);
    } catch (error) {
      console.error('[ProjectManagerIPC] Import project error:', error);
      return { error: error.message };
    }
  });

  ipcMain.handle('project:getStats', async (event) => {
    try {
      return pm.getStats();
    } catch (error) {
      console.error('[ProjectManagerIPC] Get stats error:', error);
      return { projectCount: 0, versionCount: 0, assetCount: 0 };
    }
  });

  console.log('[ProjectManagerIPC] All IPC handlers registered successfully');
}

module.exports = {
  setupProjectManagerIPC,
  getProjectManager
};







