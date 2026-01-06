/**
 * ProjectStorage - File-based persistence for projects and versions
 * @module src/project-manager/ProjectStorage
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

class ProjectStorage {
  constructor() {
    // Store projects in user's app data directory
    this.baseDir = path.join(os.homedir(), '.onereach', 'projects');
    this.indexFile = path.join(this.baseDir, 'projects-index.json');
    this.ensureDirectories();
  }

  /**
   * Ensure required directories exist
   */
  ensureDirectories() {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
    
    // Create versions subdirectory
    const versionsDir = path.join(this.baseDir, 'versions');
    if (!fs.existsSync(versionsDir)) {
      fs.mkdirSync(versionsDir, { recursive: true });
    }
  }

  /**
   * Load the projects index
   * @returns {Object} Index containing all projects
   */
  loadIndex() {
    try {
      if (fs.existsSync(this.indexFile)) {
        const data = fs.readFileSync(this.indexFile, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('[ProjectStorage] Error loading index:', error);
    }
    return { projects: {}, lastModified: null };
  }

  /**
   * Save the projects index
   * @param {Object} index - Index to save
   */
  saveIndex(index) {
    try {
      index.lastModified = new Date().toISOString();
      fs.writeFileSync(this.indexFile, JSON.stringify(index, null, 2));
    } catch (error) {
      console.error('[ProjectStorage] Error saving index:', error);
      throw error;
    }
  }

  // ==================== PROJECT OPERATIONS ====================

  /**
   * Create a new project
   * @param {Object} projectData - Project data
   * @returns {Object} Created project
   */
  createProject(projectData) {
    const index = this.loadIndex();
    const projectId = projectData.id || `proj-${Date.now()}`;
    
    const project = {
      id: projectId,
      name: projectData.name || 'Untitled Project',
      spaceId: projectData.spaceId || 'default',
      assets: projectData.assets || [],
      versions: [],
      defaultVersion: null,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString()
    };
    
    index.projects[projectId] = project;
    this.saveIndex(index);
    
    // Create project directory for assets
    const projectDir = path.join(this.baseDir, projectId);
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }
    
    console.log('[ProjectStorage] Created project:', projectId);
    return project;
  }

  /**
   * Get a project by ID
   * @param {string} projectId - Project ID
   * @returns {Object|null} Project or null if not found
   */
  getProject(projectId) {
    const index = this.loadIndex();
    return index.projects[projectId] || null;
  }

  /**
   * Get all projects
   * @returns {Array} Array of all projects
   */
  getAllProjects() {
    const index = this.loadIndex();
    return Object.values(index.projects);
  }

  /**
   * Get projects by space ID
   * @param {string} spaceId - Space ID
   * @returns {Array} Array of projects in the space
   */
  getProjectsBySpace(spaceId) {
    const projects = this.getAllProjects();
    return projects.filter(p => p.spaceId === spaceId);
  }

  /**
   * Update a project
   * @param {string} projectId - Project ID
   * @param {Object} updates - Updates to apply
   * @returns {Object} Updated project
   */
  updateProject(projectId, updates) {
    const index = this.loadIndex();
    const project = index.projects[projectId];
    
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    
    // Apply updates (except id and createdAt)
    const { id, createdAt, ...allowedUpdates } = updates;
    Object.assign(project, allowedUpdates, {
      modifiedAt: new Date().toISOString()
    });
    
    this.saveIndex(index);
    console.log('[ProjectStorage] Updated project:', projectId);
    return project;
  }

  /**
   * Delete a project and all its versions
   * @param {string} projectId - Project ID
   * @returns {boolean} Success
   */
  deleteProject(projectId) {
    const index = this.loadIndex();
    const project = index.projects[projectId];
    
    if (!project) {
      return false;
    }
    
    // Delete all versions
    for (const versionId of project.versions) {
      this.deleteVersion(versionId, false); // Don't update project
    }
    
    // Delete project directory
    const projectDir = path.join(this.baseDir, projectId);
    if (fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
    
    // Remove from index
    delete index.projects[projectId];
    this.saveIndex(index);
    
    console.log('[ProjectStorage] Deleted project:', projectId);
    return true;
  }

  // ==================== ASSET OPERATIONS ====================

  /**
   * Add an asset to a project
   * @param {string} projectId - Project ID
   * @param {Object} assetData - Asset data
   * @returns {Object} Created asset
   */
  addAsset(projectId, assetData) {
    const index = this.loadIndex();
    const project = index.projects[projectId];
    
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    
    const assetId = assetData.id || `asset-${Date.now()}`;
    const asset = {
      id: assetId,
      type: assetData.type || 'video', // video, audio, image
      path: assetData.path,
      name: assetData.name || path.basename(assetData.path),
      size: assetData.size || 0,
      duration: assetData.duration || null,
      addedAt: new Date().toISOString()
    };
    
    project.assets.push(asset);
    project.modifiedAt = new Date().toISOString();
    this.saveIndex(index);
    
    console.log('[ProjectStorage] Added asset to project:', projectId, assetId);
    return asset;
  }

  /**
   * Remove an asset from a project
   * @param {string} projectId - Project ID
   * @param {string} assetId - Asset ID
   * @returns {boolean} Success
   */
  removeAsset(projectId, assetId) {
    const index = this.loadIndex();
    const project = index.projects[projectId];
    
    if (!project) {
      return false;
    }
    
    const assetIndex = project.assets.findIndex(a => a.id === assetId);
    if (assetIndex === -1) {
      return false;
    }
    
    project.assets.splice(assetIndex, 1);
    project.modifiedAt = new Date().toISOString();
    this.saveIndex(index);
    
    console.log('[ProjectStorage] Removed asset from project:', projectId, assetId);
    return true;
  }

  // ==================== VERSION OPERATIONS ====================

  /**
   * Get version file path
   * @param {string} versionId - Version ID
   * @returns {string} File path
   */
  getVersionPath(versionId) {
    return path.join(this.baseDir, 'versions', `${versionId}.json`);
  }

  /**
   * Create a new version
   * @param {string} projectId - Project ID
   * @param {Object} versionData - Version data
   * @returns {Object} Created version
   */
  createVersion(projectId, versionData) {
    const index = this.loadIndex();
    const project = index.projects[projectId];
    
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    
    const versionId = versionData.id || `ver-${Date.now()}`;
    
    const version = {
      id: versionId,
      name: versionData.name || 'Main',
      projectId: projectId,
      parentVersionId: versionData.parentVersionId || null,
      primaryVideoAssetId: versionData.primaryVideoAssetId || null,
      markers: versionData.markers || [],
      audioTracks: versionData.audioTracks || [],
      beats: versionData.beats || [],
      playlist: versionData.playlist || [],
      timeline: versionData.timeline || { zoom: 1, scrollOffset: 0 },
      transcriptSegments: versionData.transcriptSegments || [],
      transcriptSource: versionData.transcriptSource || null,  // Track transcript source to avoid regeneration
      fades: versionData.fades || { fadeIn: 0, fadeOut: 0 },
      trimStart: versionData.trimStart || 0,
      trimEnd: versionData.trimEnd || 0,
      // Planning data for Line Script
      planning: versionData.planning || {
        characters: [],    // { id, name, role, color, speakerIds: [] }
        scenes: [],        // { id, title, description, intExt, location, timeOfDay, order }
        locations: [],     // { id, name, intExt, description }
        storyBeats: []     // { id, title, description, sceneId, order }
      },
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString()
    };
    
    // Save version to file
    const versionPath = this.getVersionPath(versionId);
    fs.writeFileSync(versionPath, JSON.stringify(version, null, 2));
    
    // Update project
    project.versions.push(versionId);
    if (!project.defaultVersion) {
      project.defaultVersion = versionId;
    }
    project.modifiedAt = new Date().toISOString();
    this.saveIndex(index);
    
    console.log('[ProjectStorage] Created version:', versionId, 'for project:', projectId);
    return version;
  }

  /**
   * Get a version by ID
   * @param {string} versionId - Version ID
   * @returns {Object|null} Version or null if not found
   */
  getVersion(versionId) {
    try {
      const versionPath = this.getVersionPath(versionId);
      if (fs.existsSync(versionPath)) {
        const data = fs.readFileSync(versionPath, 'utf8');
        const version = JSON.parse(data);
        // #region agent log
        const http = require('http');
        const logData = JSON.stringify({location:'ProjectStorage.js:getVersion',message:'Loading version from disk',data:{versionId,transcriptInFile:version?.transcriptSegments?.length||0,markersInFile:version?.markers?.length||0,path:versionPath},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H4-backend'});
        const req = http.request({hostname:'127.0.0.1',port:7242,path:'/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(logData)}},()=>{});
        req.on('error',()=>{});
        req.write(logData);
        req.end();
        // #endregion
        return version;
      }
    } catch (error) {
      console.error('[ProjectStorage] Error loading version:', error);
    }
    return null;
  }

  /**
   * Get all versions for a project
   * @param {string} projectId - Project ID
   * @returns {Array} Array of versions
   */
  getProjectVersions(projectId) {
    const project = this.getProject(projectId);
    if (!project) {
      return [];
    }
    
    return project.versions
      .map(versionId => this.getVersion(versionId))
      .filter(v => v !== null);
  }

  /**
   * Update a version
   * @param {string} versionId - Version ID
   * @param {Object} updates - Updates to apply
   * @returns {Object} Updated version
   */
  updateVersion(versionId, updates) {
    const version = this.getVersion(versionId);
    
    if (!version) {
      throw new Error(`Version not found: ${versionId}`);
    }
    
    // #region agent log
    const http = require('http');
    const logData = JSON.stringify({location:'ProjectStorage.js:updateVersion',message:'Saving version to disk',data:{versionId,transcriptInUpdates:updates?.transcriptSegments?.length||0,markersInUpdates:updates?.markers?.length||0},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H3-backend'});
    const req = http.request({hostname:'127.0.0.1',port:7242,path:'/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(logData)}},()=>{});
    req.on('error',()=>{});
    req.write(logData);
    req.end();
    // #endregion
    
    // Apply updates (except id, projectId, and createdAt)
    const { id, projectId, createdAt, ...allowedUpdates } = updates;
    Object.assign(version, allowedUpdates, {
      modifiedAt: new Date().toISOString()
    });
    
    // Save version
    const versionPath = this.getVersionPath(versionId);
    fs.writeFileSync(versionPath, JSON.stringify(version, null, 2));
    
    // #region agent log
    const logData2 = JSON.stringify({location:'ProjectStorage.js:updateVersion:saved',message:'Version file written',data:{versionId,path:versionPath,transcriptInVersion:version?.transcriptSegments?.length||0},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H3-backend'});
    const req2 = http.request({hostname:'127.0.0.1',port:7242,path:'/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(logData2)}},()=>{});
    req2.on('error',()=>{});
    req2.write(logData2);
    req2.end();
    // #endregion
    
    console.log('[ProjectStorage] Updated version:', versionId);
    return version;
  }

  /**
   * Delete a version
   * @param {string} versionId - Version ID
   * @param {boolean} updateProject - Whether to update the project
   * @returns {boolean} Success
   */
  deleteVersion(versionId, updateProject = true) {
    const version = this.getVersion(versionId);
    
    if (!version) {
      return false;
    }
    
    // Delete version file
    const versionPath = this.getVersionPath(versionId);
    if (fs.existsSync(versionPath)) {
      fs.unlinkSync(versionPath);
    }
    
    // Update project if requested
    if (updateProject) {
      const index = this.loadIndex();
      const project = index.projects[version.projectId];
      
      if (project) {
        const versionIndex = project.versions.indexOf(versionId);
        if (versionIndex !== -1) {
          project.versions.splice(versionIndex, 1);
        }
        
        // Update default version if necessary
        if (project.defaultVersion === versionId) {
          project.defaultVersion = project.versions[0] || null;
        }
        
        project.modifiedAt = new Date().toISOString();
        this.saveIndex(index);
      }
    }
    
    console.log('[ProjectStorage] Deleted version:', versionId);
    return true;
  }

  /**
   * Branch (copy) a version
   * @param {string} sourceVersionId - Source version ID
   * @param {string} newName - Name for the new version
   * @returns {Object} New version
   */
  branchVersion(sourceVersionId, newName) {
    const sourceVersion = this.getVersion(sourceVersionId);
    
    if (!sourceVersion) {
      throw new Error(`Source version not found: ${sourceVersionId}`);
    }
    
    // Create new version with copied data
    const newVersion = this.createVersion(sourceVersion.projectId, {
      name: newName,
      parentVersionId: sourceVersionId,
      primaryVideoAssetId: sourceVersion.primaryVideoAssetId,
      markers: JSON.parse(JSON.stringify(sourceVersion.markers)),
      audioTracks: JSON.parse(JSON.stringify(sourceVersion.audioTracks)),
      beats: JSON.parse(JSON.stringify(sourceVersion.beats)),
      playlist: JSON.parse(JSON.stringify(sourceVersion.playlist)),
      timeline: JSON.parse(JSON.stringify(sourceVersion.timeline)),
      transcriptSegments: JSON.parse(JSON.stringify(sourceVersion.transcriptSegments)),
      transcriptSource: sourceVersion.transcriptSource || null,  // Preserve transcript source when branching
      fades: JSON.parse(JSON.stringify(sourceVersion.fades || { fadeIn: 0, fadeOut: 0 })),
      trimStart: sourceVersion.trimStart || 0,
      trimEnd: sourceVersion.trimEnd || 0,
      planning: JSON.parse(JSON.stringify(sourceVersion.planning || { characters: [], scenes: [], locations: [], storyBeats: [] }))
    });
    
    console.log('[ProjectStorage] Branched version:', sourceVersionId, '->', newVersion.id);
    return newVersion;
  }

  /**
   * Get the version tree for a project
   * @param {string} projectId - Project ID
   * @returns {Object} Tree structure with versions
   */
  getVersionTree(projectId) {
    const versions = this.getProjectVersions(projectId);
    
    // Build tree structure
    const tree = {
      root: null,
      nodes: {},
      children: {}
    };
    
    // Initialize all nodes
    for (const version of versions) {
      tree.nodes[version.id] = version;
      tree.children[version.id] = [];
    }
    
    // Build parent-child relationships
    for (const version of versions) {
      if (version.parentVersionId && tree.nodes[version.parentVersionId]) {
        tree.children[version.parentVersionId].push(version.id);
      } else if (!version.parentVersionId) {
        // This is a root version
        if (!tree.root) {
          tree.root = version.id;
        }
      }
    }
    
    // If no explicit root, use the first version
    if (!tree.root && versions.length > 0) {
      tree.root = versions[0].id;
    }
    
    return tree;
  }

  // ==================== UTILITY METHODS ====================

  /**
   * Get storage statistics
   * @returns {Object} Statistics
   */
  getStats() {
    const index = this.loadIndex();
    const projects = Object.values(index.projects);
    const totalVersions = projects.reduce((sum, p) => sum + p.versions.length, 0);
    const totalAssets = projects.reduce((sum, p) => sum + p.assets.length, 0);
    
    return {
      projectCount: projects.length,
      versionCount: totalVersions,
      assetCount: totalAssets,
      lastModified: index.lastModified
    };
  }

  /**
   * Export a project to JSON
   * @param {string} projectId - Project ID
   * @returns {Object} Full project data with all versions
   */
  exportProject(projectId) {
    const project = this.getProject(projectId);
    if (!project) {
      return null;
    }
    
    const versions = this.getProjectVersions(projectId);
    
    return {
      ...project,
      versionsData: versions,
      exportedAt: new Date().toISOString()
    };
  }

  /**
   * Import a project from JSON
   * @param {Object} data - Exported project data
   * @returns {Object} Imported project
   */
  importProject(data) {
    // Create project with new ID to avoid conflicts
    const newProjectId = `proj-${Date.now()}`;
    const versionIdMap = {};
    
    // Create the project
    const project = this.createProject({
      ...data,
      id: newProjectId,
      versions: []
    });
    
    // Import versions with new IDs
    if (data.versionsData) {
      for (const versionData of data.versionsData) {
        const oldId = versionData.id;
        const newVersionId = `ver-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        versionIdMap[oldId] = newVersionId;
        
        this.createVersion(newProjectId, {
          ...versionData,
          id: newVersionId,
          parentVersionId: versionData.parentVersionId ? versionIdMap[versionData.parentVersionId] : null
        });
      }
    }
    
    return this.getProject(newProjectId);
  }
}

module.exports = ProjectStorage;








