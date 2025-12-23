/**
 * Recorder - Main Entry Point
 * @module src/recorder
 */

import { MediaCapture } from './core/MediaCapture.js';
import { RecordingController } from './core/RecordingController.js';
import { RecorderUI } from './ui/RecorderUI.js';
import { SpaceSaver } from './services/SpaceSaver.js';

/**
 * Create recorder instance
 * @returns {Object} Recorder API
 */
export function createRecorder() {
  const capture = new MediaCapture();
  const recording = new RecordingController();
  const ui = new RecorderUI();
  const saver = new SpaceSaver();

  let currentBlob = null;

  // Recording controller callbacks
  recording.onDurationUpdate = (duration) => {
    ui.updateDuration(duration);
  };

  recording.onStop = (blob) => {
    currentBlob = blob;
    ui.showSaveDialog(blob);
    ui.updateRecordingState(false);
  };

  /**
   * Initialize recorder
   */
  const init = async () => {
    console.log('[Recorder] Initializing...');
    
    // Request permissions
    try {
      const devices = await capture.getDevices();
      console.log('[Recorder] Available devices:', devices);
    } catch (e) {
      console.warn('[Recorder] Could not enumerate devices:', e);
    }
  };

  /**
   * Start camera preview
   */
  const startCamera = async () => {
    try {
      const stream = await capture.requestCamera();
      ui.showPreview(stream, 'camera');
      return stream;
    } catch (error) {
      console.error('[Recorder] Camera error:', error);
      throw error;
    }
  };

  /**
   * Start screen capture
   */
  const startScreen = async () => {
    try {
      const stream = await capture.requestScreen();
      ui.showPreview(stream, 'screen');
      return stream;
    } catch (error) {
      console.error('[Recorder] Screen error:', error);
      throw error;
    }
  };

  /**
   * Start recording
   */
  const startRecording = async () => {
    const mode = ui.mode;
    let stream;

    if (mode === 'camera') {
      stream = await startCamera();
    } else if (mode === 'screen') {
      stream = await startScreen();
    } else if (mode === 'both') {
      await startCamera();
      await startScreen();
      stream = capture.combineStreams();
    }

    if (!stream) {
      throw new Error('No stream available');
    }

    recording.start(stream);
    ui.updateRecordingState(true, false);
  };

  /**
   * Stop recording
   */
  const stopRecording = async () => {
    await recording.stop();
    capture.stopAll();
    ui.hidePreview('camera');
    ui.hidePreview('screen');
  };

  /**
   * Pause/resume recording
   */
  const togglePause = () => {
    if (recording.state.isPaused) {
      recording.resume();
      ui.updateRecordingState(true, false);
    } else {
      recording.pause();
      ui.updateRecordingState(true, true);
    }
  };

  /**
   * Save recording
   */
  const save = async (options = {}) => {
    if (!currentBlob) {
      throw new Error('No recording to save');
    }

    const { toSpace = false, spaceId = null, filename = null } = options;

    if (toSpace) {
      await saver.save(currentBlob, { spaceId, filename });
    } else {
      await saver.saveLocal(currentBlob, filename);
    }

    ui.hideSaveDialog();
    currentBlob = null;
  };

  /**
   * Discard recording
   */
  const discard = () => {
    currentBlob = null;
    ui.hideSaveDialog();
  };

  // Initialize
  init();

  // Return public API
  return {
    startCamera,
    startScreen,
    startRecording,
    stopRecording,
    togglePause,
    save,
    discard,
    
    // Expose for debugging
    capture,
    recording,
    ui,
    saver
  };
}

// Initialize on load
let recorder;

document.addEventListener('DOMContentLoaded', () => {
  recorder = createRecorder();
  window.recorder = recorder;
  console.log('[Recorder] Ready');
});

export default createRecorder;
















