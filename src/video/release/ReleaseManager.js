/**
 * ReleaseManager - Core release orchestration
 * Coordinates releases to different destinations (Space, YouTube, Vimeo)
 * @module src/video/release/ReleaseManager
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app, shell } = require('electron');

import { VersionManager } from '../versioning/VersionManager.js';
import { BranchRenderer } from '../versioning/BranchRenderer.js';
import { ProjectStateDetector, RELEASE_STATE } from './ProjectStateDetector.js';

/**
 * Release destinations
 */
export const RELEASE_DESTINATION = {
  SPACE: 'space',
  YOUTUBE: 'youtube',
  VIMEO: 'vimeo',
  LOCAL: 'local'
};

/**
 * Release status
 */
export const RELEASE_STATUS = {
  PENDING: 'pending',
  RENDERING: 'rendering',
  UPLOADING: 'uploading',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

/**
 * Service for managing video releases
 */
export class ReleaseManager {
  constructor() {
    this.versionManager = new VersionManager();
    this.branchRenderer = new BranchRenderer();
    this.stateDetector = new ProjectStateDetector();
    
    this.releasesDir = path.join(app.getPath('userData'), 'releases');
    this.releaseHistory = [];
    this.activeRelease = null;
    
    this.ensureDirectories();
    this.loadReleaseHistory();
  }

  /**
   * Ensure required directories exist
   */
  ensureDirectories() {
    if (!fs.existsSync(this.releasesDir)) {
      fs.mkdirSync(this.releasesDir, { recursive: true });
    }
  }

  /**
   * Load release history from disk
   */
  loadReleaseHistory() {
    const historyPath = path.join(this.releasesDir, 'history.json');
    if (fs.existsSync(historyPath)) {
      try {
        this.releaseHistory = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      } catch (e) {
        console.warn('[ReleaseManager] Failed to load history:', e);
        this.releaseHistory = [];
      }
    }
  }

  /**
   * Save release history to disk
   */
  saveReleaseHistory() {
    const historyPath = path.join(this.releasesDir, 'history.json');
    fs.writeFileSync(historyPath, JSON.stringify(this.releaseHistory, null, 2));
  }

  /**
   * Get release options for a project (which branches can be released)
   * @param {string} projectPath - Path to project
   * @returns {Object} Release options
   */
  async getReleaseOptions(projectPath) {
    const project = this.versionManager.loadProject(projectPath);
    const branches = this.stateDetector.getReleasableBranches(projectPath, project);
    const summary = this.stateDetector.getReleaseSummary(projectPath, project);
    
    return {
      projectId: project.id,
      projectName: project.name,
      branches: branches.map(b => ({
        id: b.branchId,
        name: b.branchName,
        type: b.branchType,
        state: b.state,
        stateLabel: this._getStateLabel(b.state),
        version: b.latestVersion?.version || null,
        hasRenderedFile: b.hasRenderedRelease,
        canRelease: b.finalized,
        needsRender: b.needsRender
      })),
      summary: summary,
      destinations: [
        { id: RELEASE_DESTINATION.SPACE, name: 'Space', icon: '📁', available: true },
        { id: RELEASE_DESTINATION.YOUTUBE, name: 'YouTube', icon: '▶️', available: true },
        { id: RELEASE_DESTINATION.VIMEO, name: 'Vimeo', icon: '🎬', available: true },
        { id: RELEASE_DESTINATION.LOCAL, name: 'Local File', icon: '💾', available: true }
      ]
    };
  }

  /**
   * Get human-readable state label
   * @private
   */
  _getStateLabel(state) {
    const labels = {
      [RELEASE_STATE.READY]: 'Ready to Release',
      [RELEASE_STATE.NEEDS_RENDER]: 'Needs Rendering',
      [RELEASE_STATE.HAS_UNSAVED_CHANGES]: 'Has Unsaved Changes',
      [RELEASE_STATE.NO_VERSIONS]: 'No Versions',
      [RELEASE_STATE.ERROR]: 'Error'
    };
    return labels[state] || state;
  }

  /**
   * Start a release process
   * @param {string} projectPath - Path to project
   * @param {string} branchId - Branch to release
   * @param {string} destination - Release destination
   * @param {Object} metadata - Release metadata (title, description, etc.)
   * @param {Function} progressCallback - Progress callback
   * @returns {Promise<Object>} Release result
   */
  async startRelease(projectPath, branchId, destination, metadata = {}, progressCallback = null) {
    const releaseId = `release_${Date.now()}`;
    
    try {
      const project = this.versionManager.loadProject(projectPath);
      const branchStatus = this.stateDetector.isBranchFinalized(projectPath, project, branchId);
      
      if (!branchStatus.finalized) {
        throw new Error(`Branch not ready for release: ${branchStatus.error}`);
      }

      // Create release record
      const release = {
        id: releaseId,
        projectId: project.id,
        projectName: project.name,
        branchId: branchId,
        branchName: branchStatus.branch.name,
        version: branchStatus.latestVersion.version,
        destination: destination,
        metadata: metadata,
        status: RELEASE_STATUS.PENDING,
        startedAt: new Date().toISOString(),
        completedAt: null,
        error: null,
        result: null
      };

      this.activeRelease = release;
      this.releaseHistory.unshift(release);

      if (progressCallback) {
        progressCallback({ status: 'Preparing release...', percent: 0 });
      }

      // Check if we need to render first
      let videoPath = branchStatus.fullReleasePath;
      
      if (branchStatus.needsRender || !fs.existsSync(videoPath)) {
        release.status = RELEASE_STATUS.RENDERING;
        
        if (progressCallback) {
          progressCallback({ status: 'Rendering video...', percent: 5 });
        }

        // Load EDL and render
        const edl = this.versionManager.loadEDL(projectPath, branchId);
        const renderResult = await this.branchRenderer.renderBranch(
          projectPath,
          edl,
          { quality: 'high' },
          (progress) => {
            if (progressCallback) {
              progressCallback({
                status: `Rendering: ${progress.status}`,
                percent: 5 + (progress.percent * 0.4)
              });
            }
          }
        );

        if (!renderResult.success) {
          throw new Error('Render failed: ' + (renderResult.error || 'Unknown error'));
        }

        videoPath = renderResult.outputPath;

        // Move to releases folder and update version
        const releasePath = path.join(
          projectPath,
          'branches',
          branchId,
          'releases',
          `v${branchStatus.latestVersion.version}.mp4`
        );
        
        // Ensure releases directory exists
        fs.mkdirSync(path.dirname(releasePath), { recursive: true });
        
        // Copy rendered file to releases folder
        fs.copyFileSync(videoPath, releasePath);
        
        // Update version with release path
        this.versionManager.markVersionReleased(
          projectPath,
          branchId,
          branchStatus.latestVersion.version,
          releasePath
        );

        videoPath = releasePath;
      }

      // Now handle the destination
      release.status = RELEASE_STATUS.UPLOADING;
      
      if (progressCallback) {
        progressCallback({ status: `Releasing to ${destination}...`, percent: 50 });
      }

      let result;
      
      switch (destination) {
        case RELEASE_DESTINATION.SPACE:
          result = await this._releaseToSpace(projectPath, project, branchId, videoPath, metadata, progressCallback);
          break;
        case RELEASE_DESTINATION.YOUTUBE:
          result = await this._releaseToYouTube(videoPath, metadata, progressCallback);
          break;
        case RELEASE_DESTINATION.VIMEO:
          result = await this._releaseToVimeo(videoPath, metadata, progressCallback);
          break;
        case RELEASE_DESTINATION.LOCAL:
          result = await this._releaseToLocal(videoPath, metadata, progressCallback);
          break;
        default:
          throw new Error(`Unknown destination: ${destination}`);
      }

      // Update release record
      release.status = RELEASE_STATUS.COMPLETED;
      release.completedAt = new Date().toISOString();
      release.result = result;

      this.saveReleaseHistory();
      this.activeRelease = null;

      if (progressCallback) {
        progressCallback({ status: 'Release complete!', percent: 100 });
      }

      return {
        success: true,
        releaseId: releaseId,
        destination: destination,
        result: result
      };

    } catch (error) {
      console.error('[ReleaseManager] Release failed:', error);
      
      if (this.activeRelease) {
        this.activeRelease.status = RELEASE_STATUS.FAILED;
        this.activeRelease.error = error.message;
        this.activeRelease.completedAt = new Date().toISOString();
        this.saveReleaseHistory();
      }
      
      this.activeRelease = null;
      throw error;
    }
  }

  /**
   * Release to Space (internal storage)
   * @private
   */
  async _releaseToSpace(projectPath, project, branchId, videoPath, metadata, progressCallback) {
    // This would integrate with the existing Spaces system
    // For now, we'll copy to a "releases" space
    
    const spacesReleasesDir = path.join(app.getPath('userData'), 'clipboard-storage', 'releases');
    fs.mkdirSync(spacesReleasesDir, { recursive: true });

    const fileName = metadata.title 
      ? `${metadata.title.replace(/[^a-zA-Z0-9-_]/g, '_')}.mp4`
      : path.basename(videoPath);
    
    const destPath = path.join(spacesReleasesDir, fileName);
    
    if (progressCallback) {
      progressCallback({ status: 'Copying to Space...', percent: 70 });
    }

    fs.copyFileSync(videoPath, destPath);

    // Create metadata file
    const metadataPath = destPath.replace('.mp4', '.json');
    fs.writeFileSync(metadataPath, JSON.stringify({
      ...metadata,
      projectId: project.id,
      projectName: project.name,
      branchId: branchId,
      releasedAt: new Date().toISOString(),
      sourcePath: videoPath
    }, null, 2));

    if (progressCallback) {
      progressCallback({ status: 'Saved to Space!', percent: 100 });
    }

    return {
      destination: 'space',
      path: destPath,
      metadataPath: metadataPath
    };
  }

  /**
   * Release to YouTube
   * @private
   */
  async _releaseToYouTube(videoPath, metadata, progressCallback) {
    // Check if YouTube uploader is available and authenticated
    // If not, fall back to browser upload
    
    try {
      // Try to use YouTubeUploader if available
      const { YouTubeUploader } = await import('./YouTubeUploader.js');
      const uploader = new YouTubeUploader();
      
      if (await uploader.isAuthenticated()) {
        if (progressCallback) {
          progressCallback({ status: 'Uploading to YouTube...', percent: 55 });
        }
        
        return await uploader.upload(videoPath, metadata, (progress) => {
          if (progressCallback) {
            progressCallback({
              status: `Uploading: ${progress.percent}%`,
              percent: 55 + (progress.percent * 0.4)
            });
          }
        });
      }
    } catch (e) {
      console.log('[ReleaseManager] YouTube API not available, using browser fallback');
    }

    // Browser fallback
    return this._openYouTubeBrowserUpload(videoPath, metadata, progressCallback);
  }

  /**
   * Open YouTube in browser for manual upload
   * @private
   */
  async _openYouTubeBrowserUpload(videoPath, metadata, progressCallback) {
    const { clipboard } = require('electron');
    
    if (progressCallback) {
      progressCallback({ status: 'Opening YouTube Studio...', percent: 80 });
    }

    // Copy video path to clipboard
    clipboard.writeText(videoPath);

    // Open YouTube Studio upload page
    await shell.openExternal('https://studio.youtube.com/channel/UC/videos/upload');

    if (progressCallback) {
      progressCallback({ status: 'YouTube Studio opened - video path copied to clipboard', percent: 100 });
    }

    return {
      destination: 'youtube',
      method: 'browser',
      videoPath: videoPath,
      message: 'Video path copied to clipboard. Upload manually in YouTube Studio.',
      metadata: metadata
    };
  }

  /**
   * Release to Vimeo
   * @private
   */
  async _releaseToVimeo(videoPath, metadata, progressCallback) {
    // Check if Vimeo uploader is available and authenticated
    // If not, fall back to browser upload
    
    try {
      // Try to use VimeoUploader if available
      const { VimeoUploader } = await import('./VimeoUploader.js');
      const uploader = new VimeoUploader();
      
      if (await uploader.isAuthenticated()) {
        if (progressCallback) {
          progressCallback({ status: 'Uploading to Vimeo...', percent: 55 });
        }
        
        return await uploader.upload(videoPath, metadata, (progress) => {
          if (progressCallback) {
            progressCallback({
              status: `Uploading: ${progress.percent}%`,
              percent: 55 + (progress.percent * 0.4)
            });
          }
        });
      }
    } catch (e) {
      console.log('[ReleaseManager] Vimeo API not available, using browser fallback');
    }

    // Browser fallback
    return this._openVimeoBrowserUpload(videoPath, metadata, progressCallback);
  }

  /**
   * Open Vimeo in browser for manual upload
   * @private
   */
  async _openVimeoBrowserUpload(videoPath, metadata, progressCallback) {
    const { clipboard } = require('electron');
    
    if (progressCallback) {
      progressCallback({ status: 'Opening Vimeo...', percent: 80 });
    }

    // Copy video path to clipboard
    clipboard.writeText(videoPath);

    // Open Vimeo upload page
    await shell.openExternal('https://vimeo.com/upload');

    if (progressCallback) {
      progressCallback({ status: 'Vimeo opened - video path copied to clipboard', percent: 100 });
    }

    return {
      destination: 'vimeo',
      method: 'browser',
      videoPath: videoPath,
      message: 'Video path copied to clipboard. Upload manually on Vimeo.',
      metadata: metadata
    };
  }

  /**
   * Release to local file
   * @private
   */
  async _releaseToLocal(videoPath, metadata, progressCallback) {
    const { dialog } = require('electron');
    
    if (progressCallback) {
      progressCallback({ status: 'Selecting save location...', percent: 60 });
    }

    const defaultName = metadata.title 
      ? `${metadata.title.replace(/[^a-zA-Z0-9-_]/g, '_')}.mp4`
      : path.basename(videoPath);

    // Show save dialog
    const result = await dialog.showSaveDialog({
      title: 'Save Released Video',
      defaultPath: path.join(app.getPath('videos'), defaultName),
      filters: [
        { name: 'Video Files', extensions: ['mp4', 'mov', 'webm'] }
      ]
    });

    if (result.canceled || !result.filePath) {
      return {
        destination: 'local',
        cancelled: true
      };
    }

    if (progressCallback) {
      progressCallback({ status: 'Saving file...', percent: 80 });
    }

    // Copy file to selected location
    fs.copyFileSync(videoPath, result.filePath);

    if (progressCallback) {
      progressCallback({ status: 'File saved!', percent: 100 });
    }

    return {
      destination: 'local',
      path: result.filePath,
      fileName: path.basename(result.filePath)
    };
  }

  /**
   * Get release history
   * @param {number} limit - Maximum number of records to return
   * @returns {Array<Object>} Release history
   */
  getReleaseHistory(limit = 50) {
    return this.releaseHistory.slice(0, limit);
  }

  /**
   * Get release history for a specific project
   * @param {string} projectId - Project ID
   * @returns {Array<Object>} Release history for project
   */
  getProjectReleaseHistory(projectId) {
    return this.releaseHistory.filter(r => r.projectId === projectId);
  }

  /**
   * Get current active release (if any)
   * @returns {Object|null} Active release
   */
  getActiveRelease() {
    return this.activeRelease;
  }

  /**
   * Cancel active release
   * @returns {boolean} Whether cancellation was successful
   */
  cancelActiveRelease() {
    if (!this.activeRelease) return false;

    // Cancel any active render job
    if (this.activeRelease.status === RELEASE_STATUS.RENDERING) {
      // BranchRenderer doesn't track jobs by release ID, but we could add that
      console.log('[ReleaseManager] Cancelling render...');
    }

    this.activeRelease.status = RELEASE_STATUS.CANCELLED;
    this.activeRelease.completedAt = new Date().toISOString();
    this.saveReleaseHistory();
    this.activeRelease = null;

    return true;
  }

  /**
   * Clear release history
   * @param {string} projectId - Optional project ID to clear only that project's history
   */
  clearReleaseHistory(projectId = null) {
    if (projectId) {
      this.releaseHistory = this.releaseHistory.filter(r => r.projectId !== projectId);
    } else {
      this.releaseHistory = [];
    }
    this.saveReleaseHistory();
  }

  /**
   * Reveal released file in Finder/Explorer
   * @param {string} filePath - Path to file
   */
  async revealInFolder(filePath) {
    if (fs.existsSync(filePath)) {
      await shell.showItemInFolder(filePath);
      return true;
    }
    return false;
  }

  /**
   * Release a video directly (without project/branch system)
   * Used when user wants to release a video that's not part of a project
   * @param {string} videoPath - Path to video file
   * @param {string} destination - Release destination
   * @param {Object} metadata - Release metadata
   * @param {Function} progressCallback - Progress callback
   * @returns {Promise<Object>} Release result
   */
  async _releaseVideoDirectly(videoPath, destination, metadata = {}, progressCallback = null) {
    const releaseId = `release_${Date.now()}`;
    
    try {
      if (!fs.existsSync(videoPath)) {
        throw new Error(`Video file not found: ${videoPath}`);
      }

      // Create release record
      const release = {
        id: releaseId,
        projectId: null,
        projectName: path.basename(videoPath),
        branchId: null,
        branchName: 'Direct',
        version: '1.0',
        destination: destination,
        metadata: metadata,
        status: RELEASE_STATUS.UPLOADING,
        startedAt: new Date().toISOString(),
        completedAt: null,
        error: null,
        result: null
      };

      this.activeRelease = release;
      this.releaseHistory.unshift(release);

      if (progressCallback) {
        progressCallback({ status: 'Starting release...', percent: 10 });
      }

      let result;
      
      switch (destination) {
        case RELEASE_DESTINATION.SPACE:
          result = await this._releaseToSpace(null, { name: path.basename(videoPath) }, null, videoPath, metadata, progressCallback);
          break;
        case RELEASE_DESTINATION.YOUTUBE:
          result = await this._releaseToYouTube(videoPath, metadata, progressCallback);
          break;
        case RELEASE_DESTINATION.VIMEO:
          result = await this._releaseToVimeo(videoPath, metadata, progressCallback);
          break;
        case RELEASE_DESTINATION.LOCAL:
          result = await this._releaseToLocal(videoPath, metadata, progressCallback);
          break;
        default:
          throw new Error(`Unknown destination: ${destination}`);
      }

      // Update release record
      release.status = RELEASE_STATUS.COMPLETED;
      release.completedAt = new Date().toISOString();
      release.result = result;

      this.saveReleaseHistory();
      this.activeRelease = null;

      if (progressCallback) {
        progressCallback({ status: 'Release complete!', percent: 100 });
      }

      return {
        success: true,
        releaseId: releaseId,
        destination: destination,
        result: result
      };

    } catch (error) {
      console.error('[ReleaseManager] Direct release failed:', error);
      
      if (this.activeRelease) {
        this.activeRelease.status = RELEASE_STATUS.FAILED;
        this.activeRelease.error = error.message;
        this.activeRelease.completedAt = new Date().toISOString();
        this.saveReleaseHistory();
      }
      
      this.activeRelease = null;
      throw error;
    }
  }
}


