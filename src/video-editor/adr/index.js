/**
 * ADR (Automated Dialogue Replacement) Module
 *
 * Provides multi-track audio workflow for professional ADR editing:
 * - Track duplication
 * - Working track with dead space regions
 * - ADR clip management
 * - Fill track for room tone
 *
 * Usage:
 * ```javascript
 * import { initADRModule } from './src/video-editor/adr/index.js';
 *
 * const { adrManager, trackContextMenu } = initADRModule(app);
 *
 * // Duplicate a track
 * adrManager.duplicateTrack('A1');
 *
 * // Ensure working track exists
 * adrManager.ensureWorkingTrack();
 * ```
 */

export { ADRTrackManager } from './ADRTrackManager.js';
export { TrackContextMenu } from './TrackContextMenu.js';

/**
 * Initialize the ADR module for an app context
 * @param {object} appContext - The main app object
 * @returns {object} Object with initialized ADR modules
 */
export function initADRModule(appContext) {
  // Create ADR Track Manager
  const adrManager = new ADRTrackManager(appContext);

  // Create Track Context Menu
  const trackContextMenu = new TrackContextMenu(appContext, adrManager);

  // Attach to app context
  appContext.adrManager = adrManager;
  appContext.trackContextMenu = trackContextMenu;

  // Setup context menu on existing tracks
  _attachContextMenuToExistingTracks(trackContextMenu, appContext);

  // Patch renderAudioTrack to auto-attach context menu to new tracks
  _patchRenderAudioTrack(appContext, trackContextMenu);

  window.logging.info('video', 'ADR Module Initialized');

  return {
    adrManager,
    trackContextMenu,
  };
}

/**
 * Attach context menu to all existing track labels
 */
function _attachContextMenuToExistingTracks(contextMenu, appContext) {
  // Wait for DOM to be ready
  setTimeout(() => {
    const tracks = appContext.audioTracks || [];

    tracks.forEach((track) => {
      const trackEl =
        document.getElementById(`track-${track.id}`) || document.querySelector(`[data-track-id="${track.id}"]`);

      if (trackEl) {
        const label = trackEl.querySelector('.track-label');
        if (label) {
          contextMenu.attachToLabel(label, track.id);
        }
      }
    });

    // Also attach to the original audio track (which has id="audioTrackContainer")
    const originalTrack = document.getElementById('audioTrackContainer');
    if (originalTrack) {
      const label = originalTrack.querySelector('.track-label');
      if (label) {
        contextMenu.attachToLabel(label, 'A1');
      }
    }
  }, 100);
}

/**
 * Patch the app's renderAudioTrack to auto-attach context menu
 */
function _patchRenderAudioTrack(appContext, contextMenu) {
  const originalRender = appContext.renderAudioTrack?.bind(appContext);

  if (originalRender) {
    appContext.renderAudioTrack = function (track) {
      // Call original render
      originalRender(track);

      // Attach context menu to the new track
      setTimeout(() => {
        const trackEl = document.getElementById(`track-${track.id}`);
        if (trackEl) {
          const label = trackEl.querySelector('.track-label');
          if (label) {
            contextMenu.attachToLabel(label, track.id);
          }
        }
      }, 0);
    };
  }
}

/**
 * Module version
 */
export const VERSION = '1.0.0';
