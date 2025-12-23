/**
 * Preload script for Budget Estimator
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
  
  // Estimate cost
  estimateCost: (provider, params) => ipcRenderer.invoke('budget:estimateCost', provider, params),
  
  // Check budget
  checkBudget: (provider, estimatedCost) => ipcRenderer.invoke('budget:checkBudget', provider, estimatedCost),
  
  // Register project
  registerProject: (projectId, name) => ipcRenderer.invoke('budget:registerProject', projectId, name),
  
  // Get project costs
  getProjectCosts: (projectId) => ipcRenderer.invoke('budget:getProjectCosts', projectId),
  
  // Get all projects
  getAllProjects: () => ipcRenderer.invoke('budget:getAllProjects'),
  
  // Get pricing
  getPricing: () => ipcRenderer.invoke('budget:getPricing'),
  
  // Open budget dashboard
  openDashboard: () => ipcRenderer.send('open-budget-dashboard')
});

// Log initialization
console.log('[preload-budget-estimator] Budget API exposed to renderer');


