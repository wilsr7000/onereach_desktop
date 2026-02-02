/**
 * Markers Module
 * Exports all marker-related functionality
 */

// Import first to make classes available locally
import { MarkerManager } from './MarkerManager.js';
import { MarkerRenderer } from './MarkerRenderer.js';
import { MarkerModal } from './MarkerModal.js';

// Re-export for external use
export { MarkerManager, MarkerRenderer, MarkerModal };

/**
 * Initialize all marker modules for an app context
 * @param {object} appContext - The main app object
 * @returns {object} Object with initialized modules
 */
export function initMarkerModules(appContext) {
  const markerManager = new MarkerManager(appContext);
  const markerRenderer = new MarkerRenderer(appContext);
  const markerModal = new MarkerModal(appContext);
  
  return {
    markerManager,
    markerRenderer,
    markerModal
  };
}


















