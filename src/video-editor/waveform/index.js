/**
 * Waveform Module
 * Exports all waveform-related functionality
 */

// Import first to make classes available locally
import { WaveformRenderer } from './WaveformRenderer.js';
import { WaveformCache } from './WaveformCache.js';
import { WaveformTypes } from './WaveformTypes.js';

// Re-export for external use
export { WaveformRenderer, WaveformCache, WaveformTypes };

/**
 * Initialize waveform module for an app context
 * @param {object} appContext - The main app object
 * @returns {WaveformRenderer} Initialized waveform renderer
 */
export function initWaveformModule(appContext) {
  return new WaveformRenderer(appContext);
}


















