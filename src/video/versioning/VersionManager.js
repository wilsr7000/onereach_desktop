/**
 * VersionManager - Branch & version management for video projects
 * Handles variant cuts (Director's Cut, Social Media Cut, etc.) and version tracking
 * @module src/video/versioning/VersionManager
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app } = require('electron');

/**
 * Branch types for variant cuts
 */
export const BRANCH_TYPES = {
  MAIN: 'main',
  DIRECTORS: 'directors',
  SOCIAL: 'social',
  EXTENDED: 'extended',
  TRAILER: 'trailer',
  CUSTOM: 'custom'
};

/**
 * Branch type metadata
 */
export const BRANCH_TYPE_INFO = {
  main: { name: 'Main Cut', description: 'Primary edit, default branch', icon: '🎬' },
  directors: { name: "Director's Cut", description: 'Extended/alternate version', icon: '🎥' },
  social: { name: 'Social Media Cut', description: 'Short-form for platforms', icon: '📱' },
  extended: { name: 'Extended Cut', description: 'Behind-the-scenes, bonus content', icon: '➕' },
  trailer: { name: 'Trailer', description: 'Promotional cut', icon: '🎞️' },
  custom: { name: 'Custom', description: 'User-defined purpose', icon: '✨' }
};

/**
 * Service for managing video project versions and branches
 */
export class VersionManager {
  constructor() {
    this.projectsDir = path.join(app.getPath('userData'), 'video-projects');
    this.ensureDirectories();
  }

  /**
   * Ensure required directories exist
   */
  ensureDirectories() {
    if (!fs.existsSync(this.projectsDir)) {
      fs.mkdirSync(this.projectsDir, { recursive: true });
    }
  }

  /**
   * Create a new project from a source video
   * @param {string} sourceVideoPath - Path to source video
   * @param {string} projectName - Name for the project
   * @returns {Promise<Object>} Created project
   */
  async createProject(sourceVideoPath, projectName) {
    const projectId = this.generateProjectId(projectName);
    const projectPath = path.join(this.projectsDir, projectId);
    
    // Create project directory structure
    fs.mkdirSync(projectPath, { recursive: true });
    fs.mkdirSync(path.join(projectPath, 'source'), { recursive: true });
    fs.mkdirSync(path.join(projectPath, 'branches'), { recursive: true });
    fs.mkdirSync(path.join(projectPath, 'thumbnails'), { recursive: true });
    
    // Copy source video
    const sourceFileName = path.basename(sourceVideoPath);
    const destSourcePath = path.join(projectPath, 'source', sourceFileName);
    fs.copyFileSync(sourceVideoPath, destSourcePath);
    
    // Create project.json
    const project = {
      id: projectId,
      name: projectName,
      sourceVideo: `source/${sourceFileName}`,
      originalSourcePath: sourceVideoPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      branches: []
    };
    
    // Create default main branch
    const mainBranch = await this._createBranchInternal(projectPath, project, {
      name: 'Main Cut',
      type: BRANCH_TYPES.MAIN,
      isDefault: true
    });
    
    project.branches.push(mainBranch);
    project.currentBranch = mainBranch.id;
    
    // Save project file
    this.saveProject(projectPath, project);
    
    console.log(`[VersionManager] Created project: ${projectId}`);
    return { projectPath, project };
  }

  /**
   * Load a project from disk
   * @param {string} projectPath - Path to project directory
   * @returns {Object} Project data
   */
  loadProject(projectPath) {
    const projectFile = path.join(projectPath, 'project.json');
    if (!fs.existsSync(projectFile)) {
      throw new Error(`Project not found at: ${projectPath}`);
    }
    return JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  }

  /**
   * Save project data to disk
   * @param {string} projectPath - Path to project directory
   * @param {Object} project - Project data
   */
  saveProject(projectPath, project) {
    project.updatedAt = new Date().toISOString();
    const projectFile = path.join(projectPath, 'project.json');
    fs.writeFileSync(projectFile, JSON.stringify(project, null, 2));
  }

  /**
   * Get all projects
   * @returns {Array<Object>} List of projects
   */
  getAllProjects() {
    const projects = [];
    
    if (!fs.existsSync(this.projectsDir)) {
      return projects;
    }
    
    const dirs = fs.readdirSync(this.projectsDir);
    for (const dir of dirs) {
      const projectPath = path.join(this.projectsDir, dir);
      const projectFile = path.join(projectPath, 'project.json');
      
      if (fs.existsSync(projectFile)) {
        try {
          const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
          projects.push({ projectPath, project });
        } catch (e) {
          console.warn(`[VersionManager] Failed to load project: ${dir}`, e);
        }
      }
    }
    
    return projects.sort((a, b) => 
      new Date(b.project.updatedAt) - new Date(a.project.updatedAt)
    );
  }

  /**
   * Create a new branch (variant cut)
   * @param {string} projectPath - Path to project
   * @param {Object} options - Branch options
   * @returns {Promise<Object>} Created branch
   */
  async createBranch(projectPath, options) {
    const project = this.loadProject(projectPath);
    const branch = await this._createBranchInternal(projectPath, project, options);
    
    project.branches.push(branch);
    this.saveProject(projectPath, project);
    
    console.log(`[VersionManager] Created branch: ${branch.id}`);
    return branch;
  }

  /**
   * Internal branch creation
   * @private
   */
  async _createBranchInternal(projectPath, project, options) {
    const {
      name,
      type = BRANCH_TYPES.CUSTOM,
      forkFromBranch = null,
      forkFromVersion = null,
      isDefault = false
    } = options;
    
    const branchId = this.generateBranchId(name);
    const branchPath = path.join(projectPath, 'branches', branchId);
    
    // Create branch directories
    fs.mkdirSync(branchPath, { recursive: true });
    fs.mkdirSync(path.join(branchPath, 'edits'), { recursive: true });
    fs.mkdirSync(path.join(branchPath, 'releases'), { recursive: true });
    
    // Determine source EDL if forking
    let sourceEdlPath = null;
    let sourceVersion = null;
    
    if (forkFromBranch) {
      const sourceBranch = project.branches.find(b => b.id === forkFromBranch);
      if (sourceBranch) {
        sourceVersion = forkFromVersion || sourceBranch.currentVersion;
        const sourceVersionData = sourceBranch.versions.find(v => v.version === sourceVersion);
        if (sourceVersionData) {
          sourceEdlPath = path.join(projectPath, sourceVersionData.edlPath);
        }
      }
    }
    
    // Create initial version
    const initialEdlPath = `branches/${branchId}/edits/v1.0.edl`;
    const fullEdlPath = path.join(projectPath, initialEdlPath);
    
    // Create EDL content (copy from source or create new)
    let edlContent;
    if (sourceEdlPath && fs.existsSync(sourceEdlPath)) {
      edlContent = JSON.parse(fs.readFileSync(sourceEdlPath, 'utf8'));
      edlContent.forkedFrom = { branch: forkFromBranch, version: sourceVersion };
    } else {
      // Create default EDL that includes entire source video
      edlContent = this._createDefaultEDL(project);
    }
    
    edlContent.createdAt = new Date().toISOString();
    edlContent.version = '1.0';
    fs.writeFileSync(fullEdlPath, JSON.stringify(edlContent, null, 2));
    
    const branch = {
      id: branchId,
      name: name,
      type: type,
      isDefault: isDefault,
      parentBranch: forkFromBranch,
      forkedFromVersion: sourceVersion,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: '1.0',
      versions: [{
        version: '1.0',
        createdAt: new Date().toISOString(),
        edlPath: initialEdlPath,
        message: forkFromBranch 
          ? `Forked from ${forkFromBranch} v${sourceVersion}`
          : 'Initial version',
        releasePath: null,
        released: false
      }]
    };
    
    // Save branch metadata
    const branchMetaPath = path.join(branchPath, 'branch.json');
    fs.writeFileSync(branchMetaPath, JSON.stringify(branch, null, 2));
    
    return branch;
  }

  /**
   * Create a default EDL for a new project
   * @private
   */
  _createDefaultEDL(project) {
    return {
      version: '1.0',
      sourceVideo: project.sourceVideo,
      createdAt: new Date().toISOString(),
      segments: [
        {
          id: 'seg_001',
          startTime: 0,
          endTime: null, // null means end of video
          type: 'include'
        }
      ],
      markers: [],
      audioTracks: [],
      effects: []
    };
  }

  /**
   * Save a new version of a branch
   * @param {string} projectPath - Path to project
   * @param {string} branchId - Branch ID
   * @param {Object} edlData - Edit Decision List data
   * @param {string} message - Version message
   * @returns {Object} Created version
   */
  async saveVersion(projectPath, branchId, edlData, message = '') {
    const project = this.loadProject(projectPath);
    const branch = project.branches.find(b => b.id === branchId);
    
    if (!branch) {
      throw new Error(`Branch not found: ${branchId}`);
    }
    
    // Increment version
    const newVersion = this.incrementVersion(branch.currentVersion);
    const edlPath = `branches/${branchId}/edits/v${newVersion}.edl`;
    const fullEdlPath = path.join(projectPath, edlPath);
    
    // Save EDL
    edlData.version = newVersion;
    edlData.createdAt = new Date().toISOString();
    fs.writeFileSync(fullEdlPath, JSON.stringify(edlData, null, 2));
    
    // Create version entry
    const versionEntry = {
      version: newVersion,
      createdAt: new Date().toISOString(),
      edlPath: edlPath,
      message: message || `Version ${newVersion}`,
      releasePath: null,
      released: false
    };
    
    branch.versions.push(versionEntry);
    branch.currentVersion = newVersion;
    branch.updatedAt = new Date().toISOString();
    
    this.saveProject(projectPath, project);
    
    console.log(`[VersionManager] Saved version ${newVersion} for branch ${branchId}`);
    return versionEntry;
  }

  /**
   * Mark a version as released and set its release path
   * @param {string} projectPath - Path to project
   * @param {string} branchId - Branch ID
   * @param {string} version - Version string
   * @param {string} releasePath - Path to released video file
   */
  markVersionReleased(projectPath, branchId, version, releasePath) {
    const project = this.loadProject(projectPath);
    const branch = project.branches.find(b => b.id === branchId);
    
    if (!branch) {
      throw new Error(`Branch not found: ${branchId}`);
    }
    
    const versionData = branch.versions.find(v => v.version === version);
    if (!versionData) {
      throw new Error(`Version not found: ${version}`);
    }
    
    // Store relative path
    const relativePath = path.relative(projectPath, releasePath);
    versionData.releasePath = relativePath;
    versionData.released = true;
    versionData.releasedAt = new Date().toISOString();
    
    branch.updatedAt = new Date().toISOString();
    this.saveProject(projectPath, project);
    
    console.log(`[VersionManager] Marked ${branchId} v${version} as released`);
  }

  /**
   * Get the latest version of a branch
   * @param {string} projectPath - Path to project
   * @param {string} branchId - Branch ID
   * @returns {Object} Latest version info
   */
  getLatestVersion(projectPath, branchId) {
    const project = this.loadProject(projectPath);
    const branch = project.branches.find(b => b.id === branchId);
    
    if (!branch) {
      throw new Error(`Branch not found: ${branchId}`);
    }
    
    const latestVersion = branch.versions[branch.versions.length - 1];
    const releasePath = latestVersion.releasePath 
      ? path.join(projectPath, latestVersion.releasePath)
      : null;
    
    return {
      branch: branch,
      version: latestVersion,
      hasRenderedFile: releasePath && fs.existsSync(releasePath),
      fullReleasePath: releasePath
    };
  }

  /**
   * Get all branches for a project
   * @param {string} projectPath - Path to project
   * @returns {Array<Object>} List of branches
   */
  getBranches(projectPath) {
    const project = this.loadProject(projectPath);
    return project.branches.map(branch => ({
      ...branch,
      typeInfo: BRANCH_TYPE_INFO[branch.type] || BRANCH_TYPE_INFO.custom
    }));
  }

  /**
   * Get a specific branch
   * @param {string} projectPath - Path to project
   * @param {string} branchId - Branch ID
   * @returns {Object} Branch data
   */
  getBranch(projectPath, branchId) {
    const project = this.loadProject(projectPath);
    const branch = project.branches.find(b => b.id === branchId);
    
    if (!branch) {
      throw new Error(`Branch not found: ${branchId}`);
    }
    
    return {
      ...branch,
      typeInfo: BRANCH_TYPE_INFO[branch.type] || BRANCH_TYPE_INFO.custom
    };
  }

  /**
   * Delete a branch
   * @param {string} projectPath - Path to project
   * @param {string} branchId - Branch ID
   */
  deleteBranch(projectPath, branchId) {
    const project = this.loadProject(projectPath);
    const branchIndex = project.branches.findIndex(b => b.id === branchId);
    
    if (branchIndex === -1) {
      throw new Error(`Branch not found: ${branchId}`);
    }
    
    const branch = project.branches[branchIndex];
    
    // Prevent deleting default branch
    if (branch.isDefault) {
      throw new Error('Cannot delete the default branch');
    }
    
    // Prevent deleting if other branches depend on it
    const dependentBranches = project.branches.filter(b => b.parentBranch === branchId);
    if (dependentBranches.length > 0) {
      throw new Error(`Cannot delete branch: ${dependentBranches.length} other branches depend on it`);
    }
    
    // Delete branch directory
    const branchPath = path.join(projectPath, 'branches', branchId);
    if (fs.existsSync(branchPath)) {
      fs.rmSync(branchPath, { recursive: true, force: true });
    }
    
    // Remove from project
    project.branches.splice(branchIndex, 1);
    
    // Update current branch if needed
    if (project.currentBranch === branchId) {
      const defaultBranch = project.branches.find(b => b.isDefault);
      project.currentBranch = defaultBranch?.id || project.branches[0]?.id;
    }
    
    this.saveProject(projectPath, project);
    
    console.log(`[VersionManager] Deleted branch: ${branchId}`);
  }

  /**
   * Load EDL for a specific version
   * @param {string} projectPath - Path to project
   * @param {string} branchId - Branch ID
   * @param {string} version - Version string (optional, defaults to current)
   * @returns {Object} EDL data
   */
  loadEDL(projectPath, branchId, version = null) {
    const project = this.loadProject(projectPath);
    const branch = project.branches.find(b => b.id === branchId);
    
    if (!branch) {
      throw new Error(`Branch not found: ${branchId}`);
    }
    
    const targetVersion = version || branch.currentVersion;
    const versionData = branch.versions.find(v => v.version === targetVersion);
    
    if (!versionData) {
      throw new Error(`Version not found: ${targetVersion}`);
    }
    
    const edlPath = path.join(projectPath, versionData.edlPath);
    if (!fs.existsSync(edlPath)) {
      throw new Error(`EDL file not found: ${edlPath}`);
    }
    
    return JSON.parse(fs.readFileSync(edlPath, 'utf8'));
  }

  /**
   * Generate a unique project ID
   * @private
   */
  generateProjectId(name) {
    const slug = name.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .substring(0, 30);
    return `proj_${slug}_${Date.now().toString(36)}`;
  }

  /**
   * Generate a unique branch ID
   * @private
   */
  generateBranchId(name) {
    const slug = name.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .substring(0, 20);
    return `${slug}_${Date.now().toString(36)}`;
  }

  /**
   * Increment a version string (e.g., "1.0" -> "1.1", "1.9" -> "2.0")
   * @private
   */
  incrementVersion(version) {
    const parts = version.split('.').map(Number);
    parts[parts.length - 1]++;
    
    // Roll over if minor version reaches 10
    if (parts.length > 1 && parts[parts.length - 1] >= 10) {
      parts[parts.length - 1] = 0;
      parts[parts.length - 2]++;
    }
    
    return parts.join('.');
  }
}







