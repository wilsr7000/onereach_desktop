/**
 * Audio module exports for Video Editor
 * 
 * Guide + Master Audio Architecture:
 * - MultiTrackAudioManager: Main audio playback manager
 * - UndoManager: Undo/redo history for audio operations
 * - AudioScrubber: Real-time audio scrubbing while dragging
 * - SnapManager: Snap-to-grid for clip editing
 * - WaveformRenderer: Render waveforms on clips
 */

export { MultiTrackAudioManager } from './MultiTrackAudioManager.js';
export { UndoManager } from './UndoManager.js';
export { AudioScrubber } from './AudioScrubber.js';
export { SnapManager } from './SnapManager.js';
export { WaveformRenderer } from './WaveformRenderer.js';








