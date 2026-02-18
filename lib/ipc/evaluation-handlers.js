/**
 * Evaluation IPC Handlers
 * Part of the Governed Self-Improving Agent Runtime
 *
 * IPC handlers for multi-agent evaluation and meta-learning
 */

const { ipcMain } = require('electron');

// Import core modules
const { AgentGenerator } = require('../../src/services/agentGenerator');
const { EvalAgent } = require('../../src/services/evalAgent');
const { EvaluationConsolidator } = require('../evaluation/consolidator');
const { ProfileManager } = require('../evaluation/profiles');
const { DocumentTypeDetector } = require('../document-detection');
const { createMetaLearningSystem } = require('../meta-learning');
const { getLogQueue } = require('./../log-event-queue');
const log = getLogQueue();

// Singleton instances
let agentGenerator = null;
let consolidator = null;
let profileManager = null;
let documentDetector = null;
let metaLearning = null;

/**
 * Initialize the evaluation system
 * @param {Object} options - Initialization options
 */
function initEvaluationSystem(options = {}) {
  // Initialize meta-learning system
  metaLearning = createMetaLearningSystem(options.metaLearning);

  // Initialize core components
  profileManager = new ProfileManager(options.profileManager);
  documentDetector = new DocumentTypeDetector({ ...options.documentDetector });

  // Initialize agent generator with meta-learning integration
  agentGenerator = new AgentGenerator({
    documentDetector,
    profileManager,
    agentMemory: metaLearning.agentMemory,
    ...options.agentGenerator,
  });

  // Initialize consolidator with meta-learning integration
  consolidator = new EvaluationConsolidator({
    conflictLearner: metaLearning.conflictLearner,
    ...options.consolidator,
  });

  log.info('app', 'Evaluation system initialized');
}

/**
 * Set up evaluation IPC handlers
 */
function setupEvaluationIPC() {
  // Initialize system with defaults
  initEvaluationSystem();

  // ============================================
  // EVALUATION HANDLERS
  // ============================================

  /**
   * Generate evaluation agents for content
   */
  ipcMain.handle('eval:generate-agents', async (event, { content, options = {} }) => {
    try {
      const result = await agentGenerator.generateAgents(content, options);
      return { success: true, ...result };
    } catch (error) {
      log.error('app', 'Error', { error: error });
      return { success: false, error: error.message };
    }
  });

  /**
   * Run evaluation with specific agents
   */
  ipcMain.handle('eval:run-evaluation', async (event, { agents, content, context = {} }) => {
    try {
      const evaluations = await Promise.all(
        agents.map(async (agentConfig) => {
          const agent = new EvalAgent(agentConfig, { llmClient: context.llmClient });
          return agent.evaluate(content, context);
        })
      );
      return { success: true, evaluations };
    } catch (error) {
      log.error('app', 'Error', { error: error });
      return { success: false, error: error.message };
    }
  });

  /**
   * Get consolidated evaluation result
   */
  ipcMain.handle('eval:get-consolidated', async (event, { evaluations, context = {}, weightingStrategy }) => {
    try {
      // Pass weighting mode if specified
      const consolidateContext = {
        ...context,
        weightingMode: weightingStrategy || context.weightingMode || 'contextual',
      };

      const result = await consolidator.consolidate(evaluations, consolidateContext);
      return { success: true, ...result };
    } catch (error) {
      log.error('app', 'Error', { error: error });
      return { success: false, error: error.message };
    }
  });

  /**
   * Run full evaluation pipeline
   */
  ipcMain.handle('eval:run-full', async (event, { content, options = {} }) => {
    try {
      // Generate agents
      const { agents, documentType, criteria } = await agentGenerator.generateAgents(content, options);

      // Run evaluations
      const evaluations = await Promise.all(
        agents.map(async (agentConfig) => {
          const agent = new EvalAgent(agentConfig, { llmClient: options.llmClient });
          return agent.evaluate(content, { documentType, criteria, ...options.context });
        })
      );

      // Consolidate results
      const consolidated = await consolidator.consolidate(evaluations, { documentType });

      return {
        success: true,
        documentType,
        agents: agents.map((a) => ({ id: a.id, type: a.type, icon: a.icon })),
        evaluations,
        consolidated,
      };
    } catch (error) {
      log.error('app', 'Error', { error: error });
      return { success: false, error: error.message };
    }
  });

  /**
   * Get evaluation profiles
   */
  ipcMain.handle('eval:get-profiles', async () => {
    try {
      return { success: true, profiles: profileManager.getAllProfiles() };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  /**
   * Detect document type
   */
  ipcMain.handle('eval:detect-type', async (event, { content, options = {} }) => {
    try {
      const result = await documentDetector.detect(content, options);
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  /**
   * Set document type override
   */
  ipcMain.handle('eval:set-type-override', async (event, { filePath, type }) => {
    try {
      documentDetector.setOverride(filePath, type);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // ============================================
  // META-LEARNING HANDLERS
  // ============================================

  /**
   * Record outcome for an evaluation
   */
  ipcMain.handle('meta:record-outcome', async (event, { evaluationId, outcome }) => {
    try {
      const result = await metaLearning.recordOutcome(evaluationId, outcome);
      return { success: true, ...result };
    } catch (error) {
      log.error('app', 'Error', { error: error });
      return { success: false, error: error.message };
    }
  });

  /**
   * Get agent performance memory
   */
  ipcMain.handle('meta:get-agent-memory', async (event, { agentType }) => {
    try {
      if (agentType) {
        return { success: true, memory: metaLearning.agentMemory.getMemory(agentType) };
      }
      return { success: true, memories: metaLearning.agentMemory.getAllMemories() };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  /**
   * Get conflict resolution prediction
   */
  ipcMain.handle('meta:get-conflict-prediction', async (event, { conflict }) => {
    try {
      const prediction = await metaLearning.getConflictPrediction(conflict);
      return { success: true, prediction };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  /**
   * Get optimal agents based on learned performance
   */
  ipcMain.handle('meta:get-optimal-agents', async (event, { documentType, content, options = {} }) => {
    try {
      const result = await metaLearning.getOptimalAgents(documentType, content, options);
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  /**
   * Get meta-learning statistics
   */
  ipcMain.handle('meta:get-stats', async () => {
    try {
      return { success: true, stats: metaLearning.getStats() };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  /**
   * Get governance audit log
   */
  ipcMain.handle('meta:get-audit-log', async (event, { options = {} }) => {
    try {
      const auditLog = metaLearning.governance.getAuditLog(options);
      return { success: true, auditLog };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  /**
   * Get pending governance approvals
   */
  ipcMain.handle('meta:get-pending-approvals', async () => {
    try {
      const pending = metaLearning.governance.getPendingApprovals();
      return { success: true, pending };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  /**
   * Process governance approval
   */
  ipcMain.handle('meta:process-approval', async (event, { approvalId, approved, approver }) => {
    try {
      const result = metaLearning.governance.processApproval(approvalId, approved, approver);
      return { success: true, result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  /**
   * Export all meta-learning data
   */
  ipcMain.handle('meta:export-all', async () => {
    try {
      const data = metaLearning.exportAll();
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  /**
   * Get comprehensive learning summary for UI display
   */
  ipcMain.handle('meta:get-learning-summary', async () => {
    try {
      const stats = metaLearning.getStats();
      const comparison = metaLearning.agentMemory.getAgentComparison();

      // Calculate weight differences vs default (1.0)
      const weightComparison = {};
      for (const [agentType, data] of Object.entries(comparison)) {
        const learnedWeight = metaLearning.agentMemory.getRecommendedWeight(agentType);
        weightComparison[agentType] = {
          defaultWeight: 1.0,
          learnedWeight,
          difference: ((learnedWeight - 1.0) * 100).toFixed(1) + '%',
          accuracy: data.accuracy,
          trend: data.trend,
        };
      }

      // Determine trend icon
      const trendIcon = (trend) => {
        switch (trend) {
          case 'improving':
            return '▲';
          case 'declining':
            return '▼';
          default:
            return '●';
        }
      };

      return {
        success: true,
        isLearningActive: stats.outcomes.totalOutcomes >= 10,
        totalSamples: stats.outcomes.totalOutcomes,
        minSamplesRequired: 10,
        agentPerformance: Object.entries(comparison).map(([type, data]) => ({
          type,
          accuracy: Math.round(data.accuracy * 100),
          trend: data.trend,
          trendIcon: trendIcon(data.trend),
          totalEvaluations: data.totalEvaluations || 0,
        })),
        weightComparison,
        predictedScoreDifference: calculatePredictedDifference(comparison),
      };
    } catch (error) {
      log.error('app', 'Error', { error: error });
      return { success: false, error: error.message };
    }
  });

  log.info('app', 'IPC handlers registered');
}

/**
 * Calculate predicted score difference with learned vs uniform weights
 */
function calculatePredictedDifference(comparison) {
  let totalDiff = 0;
  let count = 0;
  for (const data of Object.values(comparison)) {
    if (data.accuracy !== undefined) {
      // Higher accuracy agents will be weighted more, potentially raising or lowering score
      totalDiff += (data.accuracy - 0.5) * 10; // Rough estimate
      count++;
    }
  }
  return count > 0 ? Math.round(totalDiff / count) : 0;
}

/**
 * Get the meta-learning system instance
 */
function getMetaLearning() {
  return metaLearning;
}

/**
 * Get the evaluation components
 */
function getEvaluationComponents() {
  return {
    agentGenerator,
    consolidator,
    profileManager,
    documentDetector,
    metaLearning,
  };
}

module.exports = {
  setupEvaluationIPC,
  initEvaluationSystem,
  getMetaLearning,
  getEvaluationComponents,
};
