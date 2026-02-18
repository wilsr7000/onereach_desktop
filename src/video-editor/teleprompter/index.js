/**
 * Teleprompter Module
 * Exports all teleprompter-related functionality
 */

import { TeleprompterUI } from './TeleprompterUI.js';
import { TranscriptSync } from './TranscriptSync.js';
import { TeleprompterMarkers } from './TeleprompterMarkers.js';

export { TeleprompterUI, TranscriptSync, TeleprompterMarkers };

/**
 * Initialize all teleprompter modules for an app context
 * @param {object} appContext - The main app object
 * @returns {object} Object with initialized modules
 */
export function initTeleprompterModules(appContext) {
  const teleprompter = new TeleprompterUI(appContext);
  const transcriptSync = new TranscriptSync(appContext);
  const teleprompterMarkers = new TeleprompterMarkers(appContext);

  // Setup ESC key handler for markers
  teleprompterMarkers.setupKeyHandler();

  return {
    teleprompter,
    transcriptSync,
    teleprompterMarkers,
  };
}
