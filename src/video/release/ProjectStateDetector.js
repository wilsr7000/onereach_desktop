/**
 * ProjectStateDetector - Detect finalized project state per branch
 * Checks if a branch is ready for release
 * @module src/video/release/ProjectStateDetector
 */

import fs from 'fs';
import path from 'path';

/**
 * Release readiness states
 */
export const RELEASE_STATE = {
  READY: 'ready',
  NEEDS_RENDER: 'needs_render',
  HAS_UNSAVED_CHANGES: 'has_unsaved_changes',
  NO_VERSIONS: 'no_versions',
  ERROR: 'error'
};

/**
 * Service for detecting project/branch release readiness
 */
export class ProjectStateDetector {
  constructor() {}

  /**
   * Check if a branch is finalized and ready for release
   * @param {string} projectPath - Path to project
   * @param {Object} project - Project data
   * @param {string} branchId - Branch ID to check
   * @param {Object} currentEditorState - Current unsaved state from editor (optional)
   * @returns {Object} Finalization status
   */
  isBranchFinalized(projectPath, project, branchId, currentEditorState = null) {
    const branch = project.branches.find(b => b.id === branchId);
    
    if (!branch) {
      return {
        finalized: false,
        state: RELEASE_STATE.ERROR,
        error: `Branch not found: ${branchId}`,
        latestVersion: null,
        hasRenderedRelease: false,
        needsRender: true
      };
    }

    // Check if branch has any versions
    if (!branch.versions || branch.versions.length === 0) {
      return {
        finalized: false,
        state: RELEASE_STATE.NO_VERSIONS,
        error: 'Branch has no versions',
        latestVersion: null,
        hasRenderedRelease: false,
        needsRender: true
      };
    }

    const latestVersion = branch.versions[branch.versions.length - 1];
    
    // Check if there are unsaved changes
    const hasUnsavedChanges = currentEditorState 
      ? this._hasUnsavedChanges(projectPath, branch, latestVersion, currentEditorState)
      : false;

    if (hasUnsavedChanges) {
      return {
        finalized: false,
        state: RELEASE_STATE.HAS_UNSAVED_CHANGES,
        error: 'Branch has unsaved changes - save a new version first',
        latestVersion: latestVersion,
        hasRenderedRelease: false,
        needsRender: true,
        unsavedChanges: true
      };
    }

    // Check if latest version has a rendered release file
    let hasRenderedRelease = false;
    let fullReleasePath = null;
    
    if (latestVersion.releasePath) {
      fullReleasePath = path.join(projectPath, latestVersion.releasePath);
      hasRenderedRelease = fs.existsSync(fullReleasePath);
    }

    // Determine state
    const state = hasRenderedRelease 
      ? RELEASE_STATE.READY 
      : RELEASE_STATE.NEEDS_RENDER;

    return {
      finalized: true,
      state: state,
      error: null,
      latestVersion: latestVersion,
      hasRenderedRelease: hasRenderedRelease,
      needsRender: !hasRenderedRelease,
      fullReleasePath: fullReleasePath,
      branch: {
        id: branch.id,
        name: branch.name,
        type: branch.type,
        currentVersion: branch.currentVersion
      }
    };
  }

  /**
   * Get all branches that are ready or nearly ready for release
   * @param {string} projectPath - Path to project
   * @param {Object} project - Project data
   * @param {Object} currentEditorState - Current unsaved state from editor (optional)
   * @returns {Array<Object>} List of releasable branches with their status
   */
  getReleasableBranches(projectPath, project, currentEditorState = null) {
    const results = [];

    for (const branch of project.branches) {
      const status = this.isBranchFinalized(
        projectPath, 
        project, 
        branch.id, 
        currentEditorState
      );

      results.push({
        ...status,
        branchId: branch.id,
        branchName: branch.name,
        branchType: branch.type,
        versionCount: branch.versions?.length || 0
      });
    }

    // Sort: ready first, then needs_render, then others
    const stateOrder = {
      [RELEASE_STATE.READY]: 0,
      [RELEASE_STATE.NEEDS_RENDER]: 1,
      [RELEASE_STATE.HAS_UNSAVED_CHANGES]: 2,
      [RELEASE_STATE.NO_VERSIONS]: 3,
      [RELEASE_STATE.ERROR]: 4
    };

    return results.sort((a, b) => {
      const orderA = stateOrder[a.state] ?? 5;
      const orderB = stateOrder[b.state] ?? 5;
      return orderA - orderB;
    });
  }

  /**
   * Check if editor state differs from saved version
   * @private
   */
  _hasUnsavedChanges(projectPath, branch, latestVersion, editorState) {
    if (!latestVersion.edlPath) return true;

    const edlPath = path.join(projectPath, latestVersion.edlPath);
    if (!fs.existsSync(edlPath)) return true;

    try {
      const savedEDL = JSON.parse(fs.readFileSync(edlPath, 'utf8'));
      
      // Compare key aspects of the state
      // Markers
      if (this._markersChanged(savedEDL.markers, editorState.markers)) {
        return true;
      }

      // Segments/playlist
      if (this._segmentsChanged(savedEDL.segments, editorState.playlist)) {
        return true;
      }

      // Audio tracks
      if (this._audioTracksChanged(savedEDL.audioTracks, editorState.audioTracks)) {
        return true;
      }

      return false;
    } catch (e) {
      console.warn('[ProjectStateDetector] Error comparing states:', e);
      return true; // Assume unsaved changes on error
    }
  }

  /**
   * Check if markers have changed
   * @private
   */
  _markersChanged(savedMarkers = [], currentMarkers = []) {
    if (savedMarkers.length !== currentMarkers.length) return true;

    for (let i = 0; i < savedMarkers.length; i++) {
      const saved = savedMarkers[i];
      const current = currentMarkers.find(m => m.id === saved.id);
      
      if (!current) return true;
      
      // Compare key properties
      if (saved.name !== current.name) return true;
      if (saved.time !== current.time) return true;
      if (saved.timeIn !== current.timeIn && saved.timeIn !== current.inTime) return true;
      if (saved.timeOut !== current.timeOut && saved.timeOut !== current.outTime) return true;
      if (saved.description !== current.description) return true;
    }

    return false;
  }

  /**
   * Check if segments/playlist have changed
   * @private
   */
  _segmentsChanged(savedSegments = [], currentPlaylist = []) {
    // Filter to include segments only
    const savedIncludes = savedSegments.filter(s => s.type === 'include');
    
    if (savedIncludes.length !== currentPlaylist.length) return true;

    for (let i = 0; i < savedIncludes.length; i++) {
      const saved = savedIncludes[i];
      const current = currentPlaylist[i];
      
      if (!current) return true;
      
      const savedStart = saved.startTime;
      const savedEnd = saved.endTime;
      const currentStart = current.inTime || current.startTime;
      const currentEnd = current.outTime || current.endTime;
      
      if (Math.abs(savedStart - currentStart) > 0.01) return true;
      if (savedEnd && currentEnd && Math.abs(savedEnd - currentEnd) > 0.01) return true;
    }

    return false;
  }

  /**
   * Check if audio tracks have changed
   * @private
   */
  _audioTracksChanged(savedTracks = [], currentTracks = []) {
    // Simple length check - could be more sophisticated
    if (savedTracks.length !== currentTracks.length) return true;

    for (let i = 0; i < savedTracks.length; i++) {
      const saved = savedTracks[i];
      const current = currentTracks.find(t => t.id === saved.id);
      
      if (!current) return true;
      
      // Check clip counts
      const savedClips = saved.clips?.length || 0;
      const currentClips = current.clips?.length || 0;
      if (savedClips !== currentClips) return true;
    }

    return false;
  }

  /**
   * Get release summary for a project
   * @param {string} projectPath - Path to project
   * @param {Object} project - Project data
   * @returns {Object} Summary of release state
   */
  getReleaseSummary(projectPath, project) {
    const branches = this.getReleasableBranches(projectPath, project);
    
    const summary = {
      totalBranches: branches.length,
      readyToRelease: 0,
      needsRender: 0,
      hasUnsavedChanges: 0,
      noVersions: 0,
      errors: 0,
      branches: []
    };

    for (const branch of branches) {
      switch (branch.state) {
        case RELEASE_STATE.READY:
          summary.readyToRelease++;
          break;
        case RELEASE_STATE.NEEDS_RENDER:
          summary.needsRender++;
          break;
        case RELEASE_STATE.HAS_UNSAVED_CHANGES:
          summary.hasUnsavedChanges++;
          break;
        case RELEASE_STATE.NO_VERSIONS:
          summary.noVersions++;
          break;
        case RELEASE_STATE.ERROR:
          summary.errors++;
          break;
      }

      summary.branches.push({
        id: branch.branchId,
        name: branch.branchName,
        type: branch.branchType,
        state: branch.state,
        version: branch.latestVersion?.version || null,
        hasRenderedFile: branch.hasRenderedRelease
      });
    }

    return summary;
  }

  /**
   * Check if any branch in the project is release-ready
   * @param {string} projectPath - Path to project
   * @param {Object} project - Project data
   * @returns {boolean} Whether any branch is ready
   */
  hasReleasableBranch(projectPath, project) {
    const branches = this.getReleasableBranches(projectPath, project);
    return branches.some(b => 
      b.state === RELEASE_STATE.READY || 
      b.state === RELEASE_STATE.NEEDS_RENDER
    );
  }

  /**
   * Get the best branch for release (ready > needs_render, prefer main/default)
   * @param {string} projectPath - Path to project
   * @param {Object} project - Project data
   * @returns {Object|null} Best branch for release
   */
  getBestReleaseCandidate(projectPath, project) {
    const branches = this.getReleasableBranches(projectPath, project);
    
    // Filter to finalized branches
    const candidates = branches.filter(b => b.finalized);
    
    if (candidates.length === 0) return null;

    // Prefer ready over needs_render
    const ready = candidates.filter(b => b.state === RELEASE_STATE.READY);
    if (ready.length > 0) {
      // Prefer default/main branch
      const defaultBranch = ready.find(b => b.branch?.isDefault || b.branchType === 'main');
      return defaultBranch || ready[0];
    }

    // Fall back to needs_render
    const needsRender = candidates.filter(b => b.state === RELEASE_STATE.NEEDS_RENDER);
    if (needsRender.length > 0) {
      const defaultBranch = needsRender.find(b => b.branch?.isDefault || b.branchType === 'main');
      return defaultBranch || needsRender[0];
    }

    return null;
  }
}










