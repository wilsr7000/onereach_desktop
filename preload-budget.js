/**
 * Preload script for Budget Dashboard
 * Exposes budget management APIs to the renderer process securely
 */

const { contextBridge, ipcRenderer } = require('electron');

// Expose budget API to renderer
contextBridge.exposeInMainWorld('budgetAPI', {
  // Get cost summary for a period
  getCostSummary: (period) => ipcRenderer.invoke('budget:getCostSummary', period),

  // Get all budget limits
  getAllBudgetLimits: () => ipcRenderer.invoke('budget:getAllBudgetLimits'),

  // Set budget limit
  setBudgetLimit: (scope, limit, alertAt) => ipcRenderer.invoke('budget:setBudgetLimit', scope, limit, alertAt),

  // Get usage history
  getUsageHistory: (options) => ipcRenderer.invoke('budget:getUsageHistory', options),

  // Get project costs
  getProjectCosts: (projectId) => ipcRenderer.invoke('budget:getProjectCosts', projectId),

  // Get all projects
  getAllProjects: () => ipcRenderer.invoke('budget:getAllProjects'),

  // Clear usage history
  clearUsageHistory: (options) => ipcRenderer.invoke('budget:clearUsageHistory', options),

  // Export data
  exportData: () => ipcRenderer.invoke('budget:exportData'),

  // Import data
  importData: (jsonData) => ipcRenderer.invoke('budget:importData', jsonData),

  // Estimate cost
  estimateCost: (provider, params) => ipcRenderer.invoke('budget:estimateCost', provider, params),

  // Check budget
  checkBudget: (provider, estimatedCost) => ipcRenderer.invoke('budget:checkBudget', provider, estimatedCost),

  // Get pricing
  getPricing: () => ipcRenderer.invoke('budget:getPricing'),

  // Update pricing
  updatePricing: (provider, pricing) => ipcRenderer.invoke('budget:updatePricing', provider, pricing),

  // Reset to defaults (requires confirmation token)
  resetToDefaults: (confirmToken) => ipcRenderer.invoke('budget:resetToDefaults', confirmToken),

  // ==================== BUDGET CONFIGURATION ====================

  // Check if budget has been configured
  isBudgetConfigured: () => ipcRenderer.invoke('budget:isBudgetConfigured'),

  // Mark budget as configured
  markBudgetConfigured: () => ipcRenderer.invoke('budget:markBudgetConfigured'),

  // ==================== ESTIMATES ====================

  // Get estimates for a project
  getEstimates: (projectId) => ipcRenderer.invoke('budget:getEstimates', projectId),

  // Save estimates for a project
  saveEstimates: (projectId, estimates) => ipcRenderer.invoke('budget:saveEstimates', projectId, estimates),

  // Update a single estimate
  updateEstimate: (projectId, category, update) =>
    ipcRenderer.invoke('budget:updateEstimate', projectId, category, update),

  // Get total estimated amount
  getTotalEstimated: (projectId) => ipcRenderer.invoke('budget:getTotalEstimated', projectId),

  // Get estimate categories
  getEstimateCategories: () => ipcRenderer.invoke('budget:getEstimateCategories'),

  // ==================== BACKUP & RESTORE ====================

  // Create a backup
  createBackup: () => ipcRenderer.invoke('budget:createBackup'),

  // List available backups
  listBackups: () => ipcRenderer.invoke('budget:listBackups'),

  // Restore from a backup
  restoreFromBackup: (backupPath) => ipcRenderer.invoke('budget:restoreFromBackup', backupPath),

  // ==================== EVENTS ====================

  // Listen for budget updates (from other windows)
  onBudgetUpdate: (callback) => {
    ipcRenderer.on('budget:updated', (event, data) => callback(data));
  },

  // Listen for budget warnings
  onBudgetWarning: (callback) => {
    ipcRenderer.on('budget:warning', (event, data) => callback(data));
  },

  // Remove budget update listener
  offBudgetUpdate: () => {
    ipcRenderer.removeAllListeners('budget:updated');
  },

  // Remove budget warning listener
  offBudgetWarning: () => {
    ipcRenderer.removeAllListeners('budget:warning');
  },

  // Open budget estimator window
  openEstimator: () => ipcRenderer.send('open-budget-estimator'),

  // Open budget setup wizard
  openBudgetSetup: () => ipcRenderer.send('open-budget-setup'),
});

// Log initialization
console.log('[preload-budget] Budget API exposed to renderer');
