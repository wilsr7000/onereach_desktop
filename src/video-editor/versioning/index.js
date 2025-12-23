/**
 * Versioning Module - Branch and version management
 * 
 * Components:
 * - BranchSwitcher: UI for switching between edit branches
 * - VersionHistoryPanel: Timeline view of version history
 */

import { BranchSwitcher } from './BranchSwitcher.js';
import { VersionHistoryPanel } from './VersionHistoryPanel.js';

export { BranchSwitcher, VersionHistoryPanel };

/**
 * Initialize versioning components
 */
export function initVersioning(appContext) {
  const branchSwitcher = new BranchSwitcher(appContext);
  const versionHistoryPanel = new VersionHistoryPanel(appContext);
  
  // Attach to app context
  appContext.branchSwitcher = branchSwitcher;
  appContext.versionHistoryPanel = versionHistoryPanel;
  
  // Initialize if container exists
  if (document.getElementById('branchSwitcherContainer')) {
    branchSwitcher.init();
  }
  
  versionHistoryPanel.init();
  
  console.log('[Versioning] Module initialized');
  
  return { branchSwitcher, versionHistoryPanel };
}


