/**
 * IPC Handlers Module
 * Part of the Governed Self-Improving Agent Runtime
 * 
 * Central registration point for all IPC handlers
 */

const { setupEvaluationIPC, initEvaluationSystem, getMetaLearning, getEvaluationComponents } = require('./evaluation-handlers');

module.exports = {
  setupEvaluationIPC,
  initEvaluationSystem,
  getMetaLearning,
  getEvaluationComponents
};


