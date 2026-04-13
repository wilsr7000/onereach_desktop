/**
 * Agent Self-Learning System -- Orchestrator
 *
 * Wires the interaction collector, opportunity evaluator, known-issues
 * registry, improvement engine, UI improver, quality verifier, and
 * playbook writer into a fully automatic improvement loop.
 *
 * Usage:
 *   const { initAgentLearning } = require('./lib/agent-learning');
 *   await initAgentLearning();   // call after exchange bridge is live
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

const { InteractionCollector } = require('./interaction-collector');
const { evaluateAgent } = require('./opportunity-evaluator');
const { runKnownIssueChecks, learnIssuePattern } = require('./known-agent-issues');
const { generateImprovement } = require('./improvement-engine');
const { generateUIImprovement } = require('./ui-improver');
const { verifyImprovement } = require('./quality-verifier');
const { writeImprovementPlaybook, ensurePMSpace } = require('./playbook-writer');
const { FeedbackLoop } = require('./feedback-loop');
const { CrossAgentLearning } = require('./cross-agent-learning');
const depResolver = require('./dependency-resolver');
const userQueue = require('./user-action-queue');

const LEARNING_FEATURE_PREFIX = 'agent-learning';

const DEFAULT_CONFIG = {
  enabled: true,
  evaluationIntervalMs: 60000,
  minInteractionsBeforeEval: 5,
  maxImprovementsPerDay: 10,
  maxCreationsPerDay: 3,
  maxRetriesPerImprovement: 3,
  dailyBudget: 0.50,
  improvementPriority: ['reliability', 'prompt', 'ui', 'routing', 'memory', 'multi-turn'],
};

let _collector = null;
let _feedbackLoop = null;
let _crossAgentLearning = null;
let _evalInterval = null;
let _dailyCounters = { improvements: 0, creations: 0, date: null };
let _running = false;
let _pendingEvals = new Set();

function _getConfig() {
  try {
    const settings = global.settingsManager?.get('agentLearning');
    return { ...DEFAULT_CONFIG, ...(settings || {}) };
  } catch (_) {
    return DEFAULT_CONFIG;
  }
}

function _resetDailyCounters() {
  const today = new Date().toDateString();
  if (_dailyCounters.date !== today) {
    _dailyCounters = { improvements: 0, creations: 0, date: today };
  }
}

async function _checkLearningBudget() {
  try {
    const { getBudgetManager } = require('../../budget-manager');
    const bm = getBudgetManager();
    if (!bm) return { allowed: true, spent: 0, remaining: Infinity };

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayStr = todayStart.toISOString();

    const learningUsage = (bm.data.usage || []).filter(
      (u) => u.timestamp >= todayStr && u.feature?.startsWith(LEARNING_FEATURE_PREFIX)
    );

    const spent = learningUsage.reduce((sum, u) => sum + (u.cost || 0), 0);
    const config = _getConfig();
    const limit = config.dailyBudget;

    if (spent >= limit) {
      return { allowed: false, reason: 'daily_budget', spent, limit };
    }
    return { allowed: true, spent, remaining: limit - spent };
  } catch (_) {
    return { allowed: true, spent: 0, remaining: Infinity };
  }
}

let _registryOverride = null;

function _isModifiable(agent) {
  if (!agent || agent.type !== 'local') return false;
  try {
    const registry = _registryOverride || require('../../packages/agents/agent-registry');
    return !registry.isRegistered(agent.id);
  } catch (_) {
    return true;
  }
}

function _getAgentFromStore(agentId) {
  try {
    const { getAgentStore } = require('../../src/voice-task-sdk/agent-store');
    const store = getAgentStore();
    return store.getAgent(agentId);
  } catch (_) {
    return null;
  }
}

async function _updateAgent(agentId, patch, description) {
  try {
    const { getAgentStore } = require('../../src/voice-task-sdk/agent-store');
    const store = getAgentStore();
    await store.updateAgent(agentId, patch, 'auto-fix', description);
    return true;
  } catch (err) {
    log.error('agent-learning', 'Failed to update agent', { agentId, error: err.message });
    return false;
  }
}

/**
 * Run the improvement pipeline for a single agent.
 */
async function _processAgent(agentId, windowData) {
  const config = _getConfig();
  _resetDailyCounters();

  if (_dailyCounters.improvements >= config.maxImprovementsPerDay) {
    log.info('agent-learning', 'Daily improvement limit reached');
    return;
  }

  const budget = await _checkLearningBudget();
  if (!budget.allowed) {
    log.info('agent-learning', 'Learning budget exhausted', budget);
    return;
  }

  const agent = _getAgentFromStore(agentId);
  if (!agent || !_isModifiable(agent)) return;

  // 1. Check known issues first (free -- no LLM)
  const knownResults = runKnownIssueChecks({
    agent,
    interactions: windowData.interactions,
    failureRate: windowData.failureRate,
    rephraseRate: windowData.rephraseRate,
    uiSpecRate: windowData.uiSpecRate,
    routingAccuracy: windowData.routingAccuracy || 1.0,
    avgResponseTimeMs: windowData.avgResponseTimeMs,
    memoryWrites: 0,
  });

  for (const issue of knownResults) {
    if (issue.fix && issue.fix.patch) {
      const updated = await _updateAgent(agentId, issue.fix.patch, issue.fix.description);
      if (updated) {
        _dailyCounters.improvements++;
        await writeImprovementPlaybook({
          agent,
          improvement: { type: 'known-fix', patch: issue.fix.patch, description: issue.fix.description },
          verification: null,
          trigger: 'known-issue',
          verdict: 'deployed',
        });
        log.info('agent-learning', `Applied known fix ${issue.id} to ${agent.name}`);
      }
      return;
    }
  }

  // 2. LLM evaluation
  const evaluation = await evaluateAgent(agent, windowData);
  if (!evaluation.improvements || evaluation.improvements.length === 0) return;

  // 3. Process top improvement by priority
  const priorityOrder = config.improvementPriority;
  const sorted = evaluation.improvements.sort((a, b) => {
    const aIdx = priorityOrder.indexOf(a.type);
    const bIdx = priorityOrder.indexOf(b.type);
    return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
  });

  for (const issue of sorted.slice(0, 1)) {
    const budgetCheck = await _checkLearningBudget();
    if (!budgetCheck.allowed) break;

    let improvement = null;
    if (issue.type === 'ui') {
      improvement = await generateUIImprovement(agent, windowData);
    } else {
      improvement = await generateImprovement(agent, issue, windowData);
    }

    if (!improvement || !improvement.patch) continue;

    // 3b. Check for dependencies that require user input
    try {
      const depCheck = await depResolver.detectDependencies(agent, improvement, issue);
      if (depCheck.hasDependencies) {
        const blockingDeps = depCheck.dependencies.filter((d) => d.blocking);
        if (blockingDeps.length > 0 && !depCheck.canProceedPartially) {
          const actionId = depResolver.registerPendingAction({
            agentId,
            agentName: agent.name,
            improvement,
            dependencies: depCheck.dependencies,
          });

          const notification = depResolver.buildUserNotification(agent.name, depCheck.dependencies);

          // Add to user action queue so it persists and is trackable
          for (const dep of blockingDeps) {
            userQueue.addActionNeeded({
              text: dep.actionForUser,
              agentId,
              agentName: agent.name,
              actionId,
              metadata: { dependencyType: dep.type, settingsKey: dep.settingsKey },
              tags: [dep.type],
            });
          }

          _notifyUserCustom(notification);

          await writeImprovementPlaybook({
            agent,
            improvement,
            verification: null,
            trigger: 'automated',
            verdict: 'blocked-on-user',
          });

          log.info('agent-learning', `Improvement blocked on user for ${agent.name}`, {
            actionId,
            deps: blockingDeps.map((d) => d.type),
          });
          continue;
        }
      }
    } catch (depErr) {
      log.warn('agent-learning', 'Dependency check failed, proceeding anyway', { error: depErr.message });
    }

    // 4. Verify improvement (silent -- no TTS, no HUD)
    const testCases = windowData.interactions
      .filter((i) => !i.success && i.userInput)
      .slice(-3)
      .map((i) => ({ userInput: i.userInput, expectedBehavior: 'helpful response' }));

    if (testCases.length === 0) {
      testCases.push(
        ...windowData.interactions
          .filter((i) => i.userInput)
          .slice(-2)
          .map((i) => ({ userInput: i.userInput, expectedBehavior: 'helpful response' }))
      );
    }

    let verification = { shouldDeploy: true, score: 1, improved: 0, degraded: 0, results: [] };
    if (testCases.length > 0 && improvement.patch.prompt) {
      try {
        verification = await verifyImprovement(agent, improvement.patch, testCases);
      } catch (err) {
        log.warn('agent-learning', 'Verification failed, skipping deployment', { error: err.message });
        verification = { shouldDeploy: false, score: 0, improved: 0, degraded: 0, results: [] };
      }
    }

    if (verification.shouldDeploy) {
      const updated = await _updateAgent(agentId, improvement.patch, improvement.description);
      if (updated) {
        _dailyCounters.improvements++;
        await writeImprovementPlaybook({
          agent,
          improvement,
          verification,
          trigger: 'automated',
          verdict: 'deployed',
        });

        // Record deployment for feedback tracking
        if (_feedbackLoop) {
          _feedbackLoop.recordDeployment({
            agentId,
            improvementType: improvement.type,
            specificIssue: issue.specificIssue,
            preMetrics: {
              failureRate: windowData.failureRate,
              rephraseRate: windowData.rephraseRate,
              uiSpecRate: windowData.uiSpecRate,
              avgResponseTimeMs: windowData.avgResponseTimeMs,
            },
          });
        }

        _notifyUser(agent, improvement);
        log.info('agent-learning', `Deployed improvement to ${agent.name}`, {
          type: improvement.type,
          score: verification.score,
        });
      }
    } else {
      await writeImprovementPlaybook({
        agent,
        improvement,
        verification,
        trigger: 'automated',
        verdict: 'rejected',
      });
      log.info('agent-learning', `Rejected improvement for ${agent.name}`, {
        type: improvement.type,
        degraded: verification.degraded,
      });
    }
  }
}

function _notifyUserCustom(message) {
  try {
    const hudApi = require('../hud-api');
    hudApi.emitResult({
      taskId: `learning-notify-${Date.now()}`,
      success: true,
      message,
      agentId: 'agent-learning',
    });
  } catch (_) {
    // notification is best-effort
  }
}

function _notifyUser(agent, improvement) {
  const typeDescriptions = {
    prompt: 'responds more accurately',
    ui: 'shows interactive cards',
    routing: 'matches requests more precisely',
    reliability: 'handles errors more gracefully',
    memory: 'remembers your preferences',
    'multi-turn': 'asks clarifying questions',
    'known-fix': 'runs more reliably',
  };
  const desc = typeDescriptions[improvement.type] || 'works better';
  const message = `I improved the ${agent.name} agent -- it now ${desc}. You can review or undo in Agent Manager.`;

  userQueue.addReviewItem({
    text: message,
    agentId: agent.id,
    agentName: agent.name,
    metadata: { improvementType: improvement.type, description: improvement.description },
  });

  _notifyUserCustom(message);
}

async function _runEvaluationCycle() {
  if (!_running || !_collector) return;
  const config = _getConfig();
  if (!config.enabled) return;

  // 1. Evaluate pending deployments from the feedback loop
  if (_feedbackLoop) {
    try {
      const evaluated = _feedbackLoop.evaluatePendingDeployments(
        (agentId) => _collector.getWindow(agentId)
      );

      if (evaluated > 0) {
        // Learn from effective fixes: grow the known-issues registry
        const degraded = _feedbackLoop.getDegradedDeployments();
        for (const record of _feedbackLoop.getAllRecords()) {
          if (record.outcome === 'effective' && record.specificIssue) {
            // Extract error pattern and add to dynamic registry
            const errorSample = _collector.getWindow(record.agentId)?.interactions
              .filter((i) => !i.success && i.error)
              .map((i) => i.error)[0];

            if (errorSample) {
              const words = errorSample.split(/\s+/).filter((w) => w.length > 4).slice(0, 3);
              if (words.length >= 2) {
                learnIssuePattern({
                  title: `Learned: ${record.specificIssue.slice(0, 60)}`,
                  errorPattern: words.join('.*'),
                  improvementType: record.improvementType,
                });
              }
            }

            // Feed cross-agent learning
            if (_crossAgentLearning) {
              const agent = _getAgentFromStore(record.agentId);
              if (agent) {
                _crossAgentLearning.recordEffectiveFix(record, agent, {
                  type: record.improvementType,
                  patch: {},
                });
              }
            }
          }
        }

        // Log degraded deployments (potential rollback candidates)
        if (degraded.length > 0) {
          log.warn('agent-learning', 'Degraded deployments detected', {
            count: degraded.length,
            agents: degraded.map((d) => d.agentId),
          });
        }
      }
    } catch (err) {
      log.warn('agent-learning', 'Feedback evaluation error', { error: err.message });
    }
  }

  // 1b. Check for actions that were blocked on user and are now ready
  try {
    const readyActions = depResolver.getReadyActions();
    for (const action of readyActions) {
      log.info('agent-learning', 'Resuming previously blocked improvement', {
        agentId: action.agentId,
        actionId: action.id,
      });
      const windowData = _collector.getWindow(action.agentId);
      if (windowData) {
        await _processAgent(action.agentId, windowData);
      }
      depResolver.removeAction(action.id);
    }
  } catch (err) {
    log.warn('agent-learning', 'Ready action check failed', { error: err.message });
  }

  // 2. Process agents needing improvement
  const windows = _collector.getAgentsNeedingEvaluation(config.minInteractionsBeforeEval);

  for (const windowData of windows) {
    if (_pendingEvals.has(windowData.agentId)) continue;
    _pendingEvals.add(windowData.agentId);

    try {
      // Check cross-agent suggestions before running full evaluation
      if (_crossAgentLearning) {
        const suggestions = _crossAgentLearning.getSuggestedFixes(windowData.agentId, windowData);
        if (suggestions.length > 0) {
          log.info('agent-learning', 'Cross-agent suggestion available', {
            agentId: windowData.agentId,
            suggestion: suggestions[0].fixType,
            confidence: suggestions[0].confidence,
          });
        }
      }

      await _processAgent(windowData.agentId, windowData);
    } catch (err) {
      log.error('agent-learning', 'Process agent failed', {
        agentId: windowData.agentId,
        error: err.message,
      });
    } finally {
      _pendingEvals.delete(windowData.agentId);
    }
  }
}

/**
 * Initialize the agent self-learning system.
 * Call after exchange bridge and agent store are live.
 */
async function initAgentLearning() {
  const config = _getConfig();
  if (!config.enabled) {
    log.info('agent-learning', 'Agent learning is disabled');
    return;
  }

  await ensurePMSpace();

  const exchangeBus = require('../exchange/event-bus');

  _collector = new InteractionCollector({
    windowSize: 30,
    minInteractionsForEval: config.minInteractionsBeforeEval,
  });
  _collector.start(exchangeBus);

  _feedbackLoop = new FeedbackLoop();
  _crossAgentLearning = new CrossAgentLearning();

  _evalInterval = setInterval(() => {
    _runEvaluationCycle().catch((err) => {
      log.error('agent-learning', 'Evaluation cycle error', { error: err.message });
    });
  }, config.evaluationIntervalMs);

  _running = true;
  log.info('agent-learning', 'Agent self-learning system initialized', {
    evaluationIntervalMs: config.evaluationIntervalMs,
    maxImprovementsPerDay: config.maxImprovementsPerDay,
    dailyBudget: config.dailyBudget,
    selfImproving: true,
  });
}

/**
 * Shut down the learning system.
 */
function shutdownAgentLearning() {
  _running = false;
  if (_evalInterval) {
    clearInterval(_evalInterval);
    _evalInterval = null;
  }
  if (_collector) {
    _collector.stop();
    _collector = null;
  }
  _feedbackLoop = null;
  _crossAgentLearning = null;
  _pendingEvals.clear();
  log.info('agent-learning', 'Agent self-learning system shut down');
}

/** For testing */
function _getState() {
  return {
    running: _running,
    collector: _collector,
    feedbackLoop: _feedbackLoop,
    crossAgentLearning: _crossAgentLearning,
    dailyCounters: { ..._dailyCounters },
    pendingEvals: _pendingEvals.size,
  };
}

function _setTestDeps(deps) {
  if (deps.registry) _registryOverride = deps.registry;
  if (deps.feedbackLoop) _feedbackLoop = deps.feedbackLoop;
  if (deps.crossAgentLearning) _crossAgentLearning = deps.crossAgentLearning;
}

module.exports = {
  initAgentLearning,
  shutdownAgentLearning,
  _checkLearningBudget,
  _isModifiable,
  _getState,
  _setTestDeps,
  DEFAULT_CONFIG,
  LEARNING_FEATURE_PREFIX,
};
