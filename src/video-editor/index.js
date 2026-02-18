/**
 * Video Editor Modules
 *
 * Modular architecture for the video editor application.
 * Each module is self-contained and receives the app context for state access.
 *
 * Usage:
 * ```javascript
 * import { initVideoEditorModules } from './src/video-editor/index.js';
 *
 * const app = {
 *   // ... existing app state and methods ...
 * };
 *
 * // Initialize all modules
 * const modules = initVideoEditorModules(app);
 *
 * // Modules are attached to app:
 * // app.teleprompter - TeleprompterUI
 * // app.transcriptSync - TranscriptSync
 * // app.teleprompterMarkers - TeleprompterMarkers
 * // app.waveform - WaveformRenderer
 * // app.markerManager - MarkerManager
 * // app.markerRenderer - MarkerRenderer
 * // app.markerModal - MarkerModal
 * ```
 */

// Teleprompter module
import { TeleprompterUI, TranscriptSync, TeleprompterMarkers, initTeleprompterModules } from './teleprompter/index.js';

export { TeleprompterUI, TranscriptSync, TeleprompterMarkers, initTeleprompterModules };

// Waveform module
import { WaveformRenderer, WaveformCache, WaveformTypes, initWaveformModule } from './waveform/index.js';

export { WaveformRenderer, WaveformCache, WaveformTypes, initWaveformModule };

// Markers module
import { MarkerManager, MarkerRenderer, MarkerModal, initMarkerModules } from './markers/index.js';

export { MarkerManager, MarkerRenderer, MarkerModal, initMarkerModules };

// Utilities
import {
  formatTime,
  formatTimecodeWithFrames,
  formatTimeCompact,
  formatDuration,
  parseTime,
  formatBytes,
  formatBitrate,
  TimeFormatter,
  positionContextMenu,
  hideContextMenu,
  buildContextMenuHTML,
  ContextMenu,
  SpaceAssetPicker,
} from './utils/index.js';

export {
  formatTime,
  formatTimecodeWithFrames,
  formatTimeCompact,
  formatDuration,
  parseTime,
  formatBytes,
  formatBitrate,
  TimeFormatter,
  positionContextMenu,
  hideContextMenu,
  buildContextMenuHTML,
  ContextMenu,
  SpaceAssetPicker,
};

/**
 * Initialize all video editor modules for an app context
 * @param {object} appContext - The main app object
 * @returns {object} Object with all initialized modules
 */
export function initVideoEditorModules(appContext) {
  // Initialize teleprompter modules
  const { teleprompter, transcriptSync, teleprompterMarkers } = initTeleprompterModules(appContext);

  // Initialize waveform module
  const waveform = initWaveformModule(appContext);

  // Initialize marker modules
  const { markerManager, markerRenderer, markerModal } = initMarkerModules(appContext);

  // Initialize Space Asset Picker
  const spaceAssetPicker = new SpaceAssetPicker(appContext);

  // Attach to app context for easy access
  appContext.teleprompter = teleprompter;
  appContext.transcriptSync = transcriptSync;
  appContext.teleprompterMarkers = teleprompterMarkers;
  appContext.waveform = waveform;
  appContext.markerManager = markerManager;
  appContext.markerRenderer = markerRenderer;
  appContext.markerModal = markerModal;
  appContext.spaceAssetPicker = spaceAssetPicker;

  // Add convenience methods for Space Asset Picker
  appContext.showSpaceAssetPicker = (options) => {
    spaceAssetPicker.show(options);
  };

  // Add clip to track helper method
  appContext.addClipToTrack = (trackId, asset) => {
    addClipToTrack(appContext, trackId, asset);
  };

  // Note: ADR module uses Global Class pattern (adr-track-manager.js)
  // and is initialized separately via <script> tag

  return {
    teleprompter,
    transcriptSync,
    teleprompterMarkers,
    waveform,
    markerManager,
    markerRenderer,
    markerModal,
    spaceAssetPicker,
  };
}

/**
 * Add a clip (audio/video) to a track
 * @param {object} appContext - The app context
 * @param {string} trackId - Target track ID
 * @param {object} asset - Asset to add (path, name, startTime, etc.)
 */
function addClipToTrack(appContext, trackId, asset) {
  if (!trackId || !asset) {
    window.logging.error('video', 'VideoEditor addClipToTrack: Missing trackId or asset');
    return;
  }

  window.logging.info('video', 'VideoEditor Adding clip to track', { data: trackId, asset });

  // Get track from ADR manager or audioTracks
  const track = appContext.adrManager?.findTrack(trackId) || appContext.audioTracks?.find((t) => t.id === trackId);

  if (!track) {
    window.logging.error('video', 'VideoEditor Track not found', { error: trackId });
    appContext.showToast?.('error', 'Track not found');
    return;
  }

  // Initialize clips array if needed
  if (!track.clips) {
    track.clips = [];
  }

  // Create clip object
  const clip = {
    id: `clip_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    name: asset.name || 'Imported Clip',
    path: asset.path,
    source: asset.source || 'space',
    spaceId: asset.spaceId,
    sourceItemId: asset.id,
    // Timing
    startTime: asset.startTime ?? (appContext.video?.currentTime || 0),
    duration: asset.duration || null, // Will be calculated when loaded
    offset: 0, // Offset within the source file
    // Display
    color: asset.color || track.color || '#4a9eff',
    // State
    muted: false,
    volume: 1.0,
    createdAt: new Date().toISOString(),
  };

  // Add to track
  track.clips.push(clip);

  // Sort clips by start time
  track.clips.sort((a, b) => a.startTime - b.startTime);

  // Render track clips if render function exists
  if (appContext.renderTrackClips) {
    appContext.renderTrackClips(trackId);
  } else if (appContext.renderAudioTrack) {
    appContext.renderAudioTrack(track);
  }

  // Emit event for other components
  if (appContext.emit) {
    appContext.emit('clipAdded', { trackId, clip });
  }

  // Show success toast
  appContext.showToast?.('success', `Added "${clip.name}" to ${track.name}`);

  return clip;
}

/**
 * Module version
 */
export const VERSION = '1.0.0';
