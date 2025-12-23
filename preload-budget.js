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
  
  // Estimate cost
  estimateCost: (provider, params) => ipcRenderer.invoke('budget:estimateCost', provider, params),
  
  // Check budget
  checkBudget: (provider, estimatedCost) => ipcRenderer.invoke('budget:checkBudget', provider, estimatedCost),
  
  // Get pricing
  getPricing: () => ipcRenderer.invoke('budget:getPricing'),
  
  // Update pricing
  updatePricing: (provider, pricing) => ipcRenderer.invoke('budget:updatePricing', provider, pricing),
  
  // Reset to defaults
  resetToDefaults: () => ipcRenderer.invoke('budget:resetToDefaults'),
  
  // Listen for budget updates (from other windows)
  onBudgetUpdate: (callback) => {
    ipcRenderer.on('budget:updated', (event, data) => callback(data));
  },
  
  // Remove budget update listener
  offBudgetUpdate: () => {
    ipcRenderer.removeAllListeners('budget:updated');
  },
  
  // Open budget estimator window
  openEstimator: () => ipcRenderer.send('open-budget-estimator')
});

// Log initialization
console.log('[preload-budget] Budget API exposed to renderer');


