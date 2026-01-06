/**
 * ProjectManager - CRUD operations for projects, assets, and versions
 * @module src/project-manager/ProjectManager
 */

const ProjectStorage = require('./ProjectStorage');
const path = require('path');
const fs = require('fs');

class ProjectManager {
  constructor() {
    this.storage = new ProjectStorage();
    this.currentProject = null;
    this.currentVersion = null;
  }

  // ==================== PROJECT OPERATIONS ====================

  /**
   * Create a new project
   * @param {Object} options - Project options
   * @param {string} options.name - Project name
   * @param {string} options.spaceId - Space ID
   * @param {string} [options.initialVideoPath] - Optional initial video to add
   * @returns {Object} Created project with initial version
   */
  async createProject({ name, spaceId, initialVideoPath = null }) {
    // Create the project
    const project = this.storage.createProject({
      name,
      spaceId
    });

    // Add initial video as asset if provided
    let primaryAssetId = null;
    if (initialVideoPath) {
      const asset = await this.addAssetToProject(project.id, initialVideoPath, 'video');
      primaryAssetId = asset.id;
    }

    // Create the initial "Main" version
    const version = this.storage.createVersion(project.id, {
      name: 'Main',
      primaryVideoAssetId: primaryAssetId
    });

    console.log('[ProjectManager] Created project:', project.id, 'with version:', version.id);
    
    return {
      project: this.storage.getProject(project.id),
      version
    };
  }

  /**
   * Get a project by ID
   * @param {string} projectId - Project ID
   * @returns {Object|null} Project
   */
  getProject(projectId) {
    return this.storage.getProject(projectId);
  }

  /**
   * Get all projects
   * @returns {Array} All projects
   */
  getAllProjects() {
    return this.storage.getAllProjects();
  }

  /**
   * Get projects for a specific space
   * @param {string} spaceId - Space ID
   * @returns {Array} Projects in the space
   */
  getProjectsForSpace(spaceId) {
    return this.storage.getProjectsBySpace(spaceId);
  }

  /**
   * Rename a project
   * @param {string} projectId - Project ID
   * @param {string} newName - New name
   * @returns {Object} Updated project
   */
  renameProject(projectId, newName) {
    return this.storage.updateProject(projectId, { name: newName });
  }

  /**
   * Delete a project
   * @param {string} projectId - Project ID
   * @returns {boolean} Success
   */
  deleteProject(projectId) {
    return this.storage.deleteProject(projectId);
  }

  // ==================== ASSET OPERATIONS ====================

  /**
   * Add an asset to a project
   * @param {string} projectId - Project ID
   * @param {string} filePath - Path to the asset file
   * @param {string} type - Asset type (video, audio, image)
   * @returns {Object} Created asset
   */
  async addAssetToProject(projectId, filePath, type = 'video') {
    // Get file info
    let size = 0;
    let duration = null;

    try {
      const stats = fs.statSync(filePath);
      size = stats.size;
    } catch (error) {
      console.warn('[ProjectManager] Could not get file stats:', error.message);
    }

    const asset = this.storage.addAsset(projectId, {
      type,
      path: filePath,
      name: path.basename(filePath),
      size,
      duration
    });

    return asset;
  }

  /**
   * Get all assets for a project
   * @param {string} projectId - Project ID
   * @returns {Array} Assets
   */
  getProjectAssets(projectId) {
    const project = this.storage.getProject(projectId);
    return project ? project.assets : [];
  }

  /**
   * Remove an asset from a project
   * @param {string} projectId - Project ID
   * @param {string} assetId - Asset ID
   * @returns {boolean} Success
   */
  removeAssetFromProject(projectId, assetId) {
    return this.storage.removeAsset(projectId, assetId);
  }

  /**
   * Get the primary video asset for a version
   * @param {string} versionId - Version ID
   * @returns {Object|null} Asset
   */
  getPrimaryVideoAsset(versionId) {
    const version = this.storage.getVersion(versionId);
    if (!version || !version.primaryVideoAssetId) {
      return null;
    }

    const project = this.storage.getProject(version.projectId);
    if (!project) {
      return null;
    }

    return project.assets.find(a => a.id === version.primaryVideoAssetId) || null;
  }

  // ==================== VERSION OPERATIONS ====================

  /**
   * Create a new version for a project
   * @param {string} projectId - Project ID
   * @param {Object} options - Version options
   * @returns {Object} Created version
   */
  createVersion(projectId, options = {}) {
    return this.storage.createVersion(projectId, {
      name: options.name || `Version ${Date.now()}`,
      primaryVideoAssetId: options.primaryVideoAssetId || null,
      markers: options.markers || [],
      audioTracks: options.audioTracks || [],
      beats: options.beats || [],
      playlist: options.playlist || [],
      timeline: options.timeline || { zoom: 1, scrollOffset: 0 },
      transcriptSegments: options.transcriptSegments || [],
      transcriptSource: options.transcriptSource || null,  // Preserve transcript source
      planning: options.planning || null  // Planning data for Line Script
    });
  }

  /**
   * Get a version by ID
   * @param {string} versionId - Version ID
   * @returns {Object|null} Version
   */
  getVersion(versionId) {
    return this.storage.getVersion(versionId);
  }

  /**
   * Get all versions for a project
   * @param {string} projectId - Project ID
   * @returns {Array} Versions
   */
  getProjectVersions(projectId) {
    return this.storage.getProjectVersions(projectId);
  }

  /**
   * Update a version
   * @param {string} versionId - Version ID
   * @param {Object} updates - Updates to apply
   * @returns {Object} Updated version
   */
  updateVersion(versionId, updates) {
    return this.storage.updateVersion(versionId, updates);
  }

  /**
   * Save the current edit state to a version
   * @param {string} versionId - Version ID
   * @param {Object} state - Edit state to save
   * @returns {Object} Updated version
   */
  saveVersionState(versionId, state) {
    return this.storage.updateVersion(versionId, {
      markers: state.markers || [],
      audioTracks: state.audioTracks || [],
      beats: state.beats || [],
      playlist: state.playlist || [],
      timeline: state.timeline || { zoom: 1, scrollOffset: 0 },
      transcriptSegments: state.transcriptSegments || [],
      transcriptSource: state.transcriptSource || null,  // Save transcript source to avoid regeneration
      fades: state.fades || { fadeIn: 0, fadeOut: 0 },
      trimStart: state.trimStart || 0,
      trimEnd: state.trimEnd || 0,
      planning: state.planning || null  // Planning data for Line Script
    });
  }

  /**
   * Rename a version
   * @param {string} versionId - Version ID
   * @param {string} newName - New name
   * @returns {Object} Updated version
   */
  renameVersion(versionId, newName) {
    return this.storage.updateVersion(versionId, { name: newName });
  }

  /**
   * Delete a version
   * @param {string} versionId - Version ID
   * @returns {boolean} Success
   */
  deleteVersion(versionId) {
    return this.storage.deleteVersion(versionId);
  }

  /**
   * Branch (fork) a version
   * @param {string} sourceVersionId - Source version ID
   * @param {string} newName - Name for the new version
   * @returns {Object} New version
   */
  branchVersion(sourceVersionId, newName) {
    return this.storage.branchVersion(sourceVersionId, newName);
  }

  /**
   * Set the default version for a project
   * @param {string} projectId - Project ID
   * @param {string} versionId - Version ID
   * @returns {Object} Updated project
   */
  setDefaultVersion(projectId, versionId) {
    const project = this.storage.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    if (!project.versions.includes(versionId)) {
      throw new Error(`Version ${versionId} not in project ${projectId}`);
    }

    return this.storage.updateProject(projectId, { defaultVersion: versionId });
  }

  /**
   * Get the version tree for a project
   * @param {string} projectId - Project ID
   * @returns {Object} Version tree
   */
  getVersionTree(projectId) {
    return this.storage.getVersionTree(projectId);
  }

  // ==================== SESSION MANAGEMENT ====================

  /**
   * Load a project and version into the current session
   * @param {string} projectId - Project ID
   * @param {string} [versionId] - Version ID (defaults to default version)
   * @returns {Object} Loaded project and version
   */
  loadSession(projectId, versionId = null) {
    const project = this.storage.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    // Use specified version or default
    const targetVersionId = versionId || project.defaultVersion;
    if (!targetVersionId) {
      throw new Error(`No version available for project: ${projectId}`);
    }

    const version = this.storage.getVersion(targetVersionId);
    if (!version) {
      throw new Error(`Version not found: ${targetVersionId}`);
    }

    this.currentProject = project;
    this.currentVersion = version;

    console.log('[ProjectManager] Loaded session:', project.id, '/', version.id);

    return {
      project,
      version,
      primaryAsset: this.getPrimaryVideoAsset(version.id)
    };
  }

  /**
   * Save the current session state
   * @param {Object} state - Current edit state
   * @returns {Object} Updated version
   */
  saveSession(state) {
    if (!this.currentVersion) {
      throw new Error('No active session');
    }

    return this.saveVersionState(this.currentVersion.id, state);
  }

  /**
   * Switch to a different version in the current project
   * @param {string} versionId - Version ID to switch to
   * @param {Object} [currentState] - Current state to save before switching
   * @returns {Object} New version data
   */
  switchVersion(versionId, currentState = null) {
    if (!this.currentProject) {
      throw new Error('No active project');
    }

    // Save current state if provided
    if (currentState && this.currentVersion) {
      this.saveVersionState(this.currentVersion.id, currentState);
    }

    // Load new version
    const version = this.storage.getVersion(versionId);
    if (!version) {
      throw new Error(`Version not found: ${versionId}`);
    }

    if (version.projectId !== this.currentProject.id) {
      throw new Error(`Version ${versionId} does not belong to current project`);
    }

    this.currentVersion = version;

    console.log('[ProjectManager] Switched to version:', version.id);

    return {
      version,
      primaryAsset: this.getPrimaryVideoAsset(version.id)
    };
  }

  /**
   * Get the current session info
   * @returns {Object|null} Current session
   */
  getCurrentSession() {
    if (!this.currentProject || !this.currentVersion) {
      return null;
    }

    return {
      project: this.currentProject,
      version: this.currentVersion,
      primaryAsset: this.getPrimaryVideoAsset(this.currentVersion.id)
    };
  }

  /**
   * Close the current session
   * @param {Object} [state] - Final state to save
   */
  closeSession(state = null) {
    if (state && this.currentVersion) {
      this.saveVersionState(this.currentVersion.id, state);
    }

    this.currentProject = null;
    this.currentVersion = null;

    console.log('[ProjectManager] Session closed');
  }

  // ==================== EXPORT/IMPORT ====================

  /**
   * Export a project
   * @param {string} projectId - Project ID
   * @returns {Object} Exported project data
   */
  exportProject(projectId) {
    return this.storage.exportProject(projectId);
  }

  /**
   * Import a project
   * @param {Object} data - Project data to import
   * @returns {Object} Imported project
   */
  importProject(data) {
    return this.storage.importProject(data);
  }

  /**
   * Get storage statistics
   * @returns {Object} Stats
   */
  getStats() {
    return this.storage.getStats();
  }
}

module.exports = ProjectManager;







