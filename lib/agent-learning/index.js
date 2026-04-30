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
const decisionRecorder = require('./decision-recorder');
const { getCounterfactualJudge } = require('./counterfactual-judge');
const { getTranscriptReviewer } = require('./transcript-reviewer');
const { getLearnedArbitrationRules } = require('./learned-arbitration-rules');
const { getOverlapTuner } = require('./overlap-tuner');
const { getBidCalibrator } = require('./bid-calibrator');

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
let _curatorInterval = null;
let _reviewInterval = null;
let _reviewTimer = null;
let _tunerInterval = null;
let _tunerTimer = null;
let _calibratorInterval = null;
let _calibratorTimer = null;
let _dailyCounters = { improvements: 0, creations: 0, date: null };
let _running = false;
let _pendingEvals = new Set();

/**
 * Run the memory curator across agents that have seen activity recently.
 * Lightweight -- respects per-agent cooldown in the curator itself, so
 * calling this every 6 hours keeps memory groomed without ever running
 * heavy work. Invalidates retriever cache for anyone actually modified.
 */
async function _runCuratorSweep() {
  if (!_collector) return;
  try {
    const { getMemoryCurator } = require('./memory-curator');
    const { getMemoryRetriever } = require('./memory-retriever');
    const curator = getMemoryCurator();
    const retriever = getMemoryRetriever();
    const windows = _collector.getAllWindows ? _collector.getAllWindows() : [];
    const agentIds = windows
      .map((w) => w.agentId)
      .filter(Boolean);
    if (agentIds.length === 0) return;
    const results = await curator.sweep(agentIds);
    for (const r of results) {
      if (r && r.removedLines > 0) {
        retriever.invalidate(r.agentId);
      }
    }
    const changed = results.filter((r) => r && r.removedLines > 0).length;
    log.info('agent-learning', '[Curator] Sweep complete', {
      agentsChecked: results.length,
      agentsChanged: changed,
    });
  } catch (err) {
    log.warn('agent-learning', '[Curator] Sweep failed', { error: err.message });
  }

  // Phase 1 self-learning arbitration retention: prune arbitration-
  // decision items past their retention window. Settings-configurable
  // via arbitrationDecisions.retentionDays (default 90).
  try {
    await decisionRecorder.pruneStaleDecisions();
  } catch (err) {
    log.warn('agent-learning', '[DecisionRecorder] Curator-driven prune failed', {
      error: err.message,
    });
  }
}

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

// Phase 2 self-learning arbitration: partition the daily learning
// budget across LLM-using features so the counterfactual judge can't
// monopolise the budget. Slices sum to <= 1.0 of dailyBudget; the
// improvement engine still falls back to the unsliced budget when it
// uses _checkLearningBudget() without a slice argument.
const BUDGET_SLICES = Object.freeze({
  improvement: 0.30,
  counterfactual: 0.30,
  transcriptReview: 0.20,
  reflection: 0.20,
});

// Test-injection seam: lets unit tests substitute a fake budget
// manager without going through the real budget-manager.js constructor
// (which depends on electron's app.getPath at import time).
let _budgetManagerOverride = null;
function _setBudgetManagerForTests(bm) { _budgetManagerOverride = bm; }

async function _checkLearningBudget(slice) {
  try {
    let bm = _budgetManagerOverride;
    if (!bm) {
      const { getBudgetManager } = require('../../budget-manager');
      bm = getBudgetManager();
    }
    if (!bm) return { allowed: true, spent: 0, remaining: Infinity };

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayStr = todayStart.toISOString();

    const config = _getConfig();
    const dailyBudget = config.dailyBudget;

    // Sliced check (Phase 2+): each feature gets a fraction of the
    // daily budget keyed by feature-tag. Slice key 'counterfactual'
    // matches feature 'agent-learning-counterfactual'; etc.
    if (typeof slice === 'string' && BUDGET_SLICES[slice] !== undefined) {
      const featureMatch = `agent-learning-${slice}`;
      const sliceUsage = (bm.data.usage || []).filter(
        (u) => u.timestamp >= todayStr && u.feature === featureMatch
      );
      const spent = sliceUsage.reduce((sum, u) => sum + (u.cost || 0), 0);
      const limit = dailyBudget * BUDGET_SLICES[slice];
      if (spent >= limit) {
        return { allowed: false, reason: 'daily_budget_slice', slice, spent, limit };
      }
      return { allowed: true, slice, spent, remaining: limit - spent };
    }

    const learningUsage = (bm.data.usage || []).filter(
      (u) => u.timestamp >= todayStr && u.feature?.startsWith(LEARNING_FEATURE_PREFIX)
    );

    const spent = learningUsage.reduce((sum, u) => sum + (u.cost || 0), 0);
    const limit = dailyBudget;

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

  // Phase 1 of self-learning arbitration: persist every settled task as
  // an item in the arbitration-decisions Space, joining later quality
  // signals (reflector, negative feedback, counterfactual judge) onto
  // the same item by taskId. Phases 4 + 5 (overlap tuner, bid
  // calibrator) read this Space offline to learn their constants.
  try {
    await decisionRecorder.ensureArbitrationSpace();
    decisionRecorder.startDecisionRecorder(exchangeBus);
  } catch (err) {
    log.warn('agent-learning', '[DecisionRecorder] Failed to start', { error: err.message });
  }

  // Phase 2: counterfactual judge. Wired here (not in exchange-bridge)
  // so the wiring layer can inject the budget-slice check; the
  // exchange-bridge calls getCounterfactualJudge().judge(...) at
  // task:settled time. Singleton so the same in-flight coalescing map
  // is shared across all callers.
  try {
    const judge = getCounterfactualJudge({
      checkBudget: () => _checkLearningBudget('counterfactual'),
    });
    // Re-bind the budget gate on the existing singleton in case of
    // re-init (e.g. settings reload).
    judge._checkBudget = () => _checkLearningBudget('counterfactual');
    log.info('agent-learning', '[CounterfactualJudge] initialised with budget slice');
  } catch (err) {
    log.warn('agent-learning', '[CounterfactualJudge] Init failed', { error: err.message });
  }

  // Phase 3: learned-arbitration-rules store + transcript-reviewer.
  // Rules persist to userData so accepted user decisions survive a
  // restart. Reviewer cron runs daily; cadence configurable via
  // settings.transcriptReview.cadenceHours (default 24).
  try {
    let userDataDir = null;
    try {
      const electron = require('electron');
      if (electron?.app?.getPath) userDataDir = electron.app.getPath('userData');
    } catch (_e) { /* not in main process; rules are read-only here */ }
    if (userDataDir) {
      getLearnedArbitrationRules().init(userDataDir);
    }
  } catch (err) {
    log.warn('agent-learning', '[Rules] Init failed', { error: err.message });
  }

  try {
    const reviewer = getTranscriptReviewer({
      checkBudget: () => _checkLearningBudget('transcriptReview'),
      userQueue,
    });
    reviewer._checkBudget = () => _checkLearningBudget('transcriptReview');
    reviewer._userQueue = userQueue;
    // Schedule daily cron. First run is delayed by REVIEW_CRON_FIRST_DELAY_MS
    // so we don't fire during app startup; subsequent runs every 24h.
    const reviewIntervalMs = 24 * 60 * 60 * 1000;
    const REVIEW_CRON_FIRST_DELAY_MS = 30 * 60 * 1000;
    if (!_reviewTimer && !_reviewInterval) {
      _reviewTimer = setTimeout(() => {
        reviewer.runOnce().catch((err) => {
          log.warn('agent-learning', '[TranscriptReviewer] First run failed', { error: err.message });
        });
        _reviewInterval = setInterval(() => {
          reviewer.runOnce().catch((err) => {
            log.warn('agent-learning', '[TranscriptReviewer] Periodic run failed', { error: err.message });
          });
        }, reviewIntervalMs);
      }, REVIEW_CRON_FIRST_DELAY_MS);
    }
    log.info('agent-learning', '[TranscriptReviewer] cron scheduled');
  } catch (err) {
    log.warn('agent-learning', '[TranscriptReviewer] Init failed', { error: err.message });
  }

  // Phase 4: weekly overlap-tuner cron. Reads arbitration-decisions
  // and regresses the overlap-penalty constants against weighted
  // outcome quality. Persists tuned constants to settings; the
  // master orchestrator reads them on every decision so a tune takes
  // effect immediately. First run delayed 1h after startup.
  try {
    const tuner = getOverlapTuner();
    const tunerIntervalMs = 7 * 24 * 60 * 60 * 1000;
    const TUNER_FIRST_DELAY_MS = 60 * 60 * 1000;
    if (!_tunerTimer && !_tunerInterval) {
      _tunerTimer = setTimeout(() => {
        tuner.runOnce().catch((err) => {
          log.warn('agent-learning', '[OverlapTuner] First run failed', { error: err.message });
        });
        _tunerInterval = setInterval(() => {
          tuner.runOnce().catch((err) => {
            log.warn('agent-learning', '[OverlapTuner] Periodic run failed', { error: err.message });
          });
        }, tunerIntervalMs);
      }, TUNER_FIRST_DELAY_MS);
    }
    log.info('agent-learning', '[OverlapTuner] cron scheduled');
  } catch (err) {
    log.warn('agent-learning', '[OverlapTuner] Init failed', { error: err.message });
  }

  // Phase 5: weekly bid-calibrator cron. Reads arbitration-decisions
  // and writes per-agent (per-taskClass) shrinkage tables to each
  // agent's memory file under the Calibration section. Calibration
  // table is consulted on every decision; the memory store caches
  // each file in-memory so reads are cheap. First run delayed 90min
  // after startup (after the overlap-tuner has had a chance to run)
  // so a single agent's memory file isn't being modified by both
  // jobs at once.
  try {
    const calibrator = getBidCalibrator();
    const calibratorIntervalMs = 7 * 24 * 60 * 60 * 1000;
    const CALIBRATOR_FIRST_DELAY_MS = 90 * 60 * 1000;
    if (!_calibratorTimer && !_calibratorInterval) {
      _calibratorTimer = setTimeout(() => {
        calibrator.runOnce().catch((err) => {
          log.warn('agent-learning', '[BidCalibrator] First run failed', { error: err.message });
        });
        _calibratorInterval = setInterval(() => {
          calibrator.runOnce().catch((err) => {
            log.warn('agent-learning', '[BidCalibrator] Periodic run failed', { error: err.message });
          });
        }, calibratorIntervalMs);
      }, CALIBRATOR_FIRST_DELAY_MS);
    }
    log.info('agent-learning', '[BidCalibrator] cron scheduled');
  } catch (err) {
    log.warn('agent-learning', '[BidCalibrator] Init failed', { error: err.message });
  }

  _collector = new InteractionCollector({
    windowSize: 30,
    minInteractionsForEval: config.minInteractionsBeforeEval,
  });
  _collector.start(exchangeBus);

  _feedbackLoop = new FeedbackLoop();
  _crossAgentLearning = new CrossAgentLearning();

  // ── Reflection -> memory feedback loop ──
  // When the LLM-as-judge flags a low-quality answer, write a dated
  // note to the agent's "Learning Notes" section. Next time the Master
  // Orchestrator evaluates bids, `_getAgentStatsSnapshot` + the memory
  // itself both carry the negative signal. Without this, low-quality
  // reflections evaporated into the ether.
  const lowQualityHandler = async (data) => {
    if (!data || !data.agentId || !data.userInput) return;
    try {
      const { getAgentMemory } = require('../agent-memory-store');
      const memory = getAgentMemory(data.agentId);
      await memory.load();
      const date = new Date().toISOString().split('T')[0];
      const score = typeof data.overall === 'number' ? data.overall.toFixed(2) : '?';
      const issues = Array.isArray(data.issues) && data.issues.length
        ? ` Issues: ${data.issues.slice(0, 2).join('; ')}.`
        : '';
      const entry = `- ${date}: Low-quality answer (reflector ${score}) on "${data.userInput.slice(0, 60)}...".${issues}`;
      memory.appendToSection('Learning Notes', entry, 30);
      await memory.save();
      log.info('agent-learning', '[Reflection->Memory] Low-quality note written', {
        agent: data.agentId,
        score: data.overall,
      });
    } catch (err) {
      log.warn('agent-learning', '[Reflection->Memory] Failed to persist low-quality note', {
        error: err.message,
      });
    }
  };
  exchangeBus.on('learning:low-quality-answer', lowQualityHandler);

  // Negative user feedback is even stronger -- promote it to a first-
  // class Learning Notes entry so the orchestrator sees it next time.
  const negFeedbackHandler = async (data) => {
    if (!data || !data.targetedAgentId) return;
    try {
      const { getAgentMemory } = require('../agent-memory-store');
      const memory = getAgentMemory(data.targetedAgentId);
      await memory.load();
      const date = new Date().toISOString().split('T')[0];
      const last = (data.targetedMessage || '').slice(0, 80);
      const entry = `- ${date}: User flagged answer as wrong. Prior response: "${last}". Input was: "${(data.userInput || '').slice(0, 60)}".`;
      memory.appendToSection('Learning Notes', entry, 30);
      await memory.save();
      log.info('agent-learning', '[NegativeFeedback->Memory] Note written', {
        agent: data.targetedAgentId,
      });
    } catch (err) {
      log.warn('agent-learning', '[NegativeFeedback->Memory] Failed', {
        error: err.message,
      });
    }
  };
  exchangeBus.on('learning:negative-feedback', negFeedbackHandler);

  _evalInterval = setInterval(() => {
    _runEvaluationCycle().catch((err) => {
      log.error('agent-learning', 'Evaluation cycle error', { error: err.message });
    });
  }, config.evaluationIntervalMs);

  // Memory curator: run a lightweight pass every 6 hours across agents
  // that have been evaluated recently. Keeps Learning Notes from
  // ballooning with stale reflection entries.
  const curatorIntervalMs = 6 * 60 * 60 * 1000;
  _curatorInterval = setInterval(() => {
    _runCuratorSweep().catch((err) => {
      log.warn('agent-learning', '[Curator] Sweep error', { error: err.message });
    });
  }, curatorIntervalMs);

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
  if (_curatorInterval) {
    clearInterval(_curatorInterval);
    _curatorInterval = null;
  }
  if (_reviewTimer) {
    clearTimeout(_reviewTimer);
    _reviewTimer = null;
  }
  if (_reviewInterval) {
    clearInterval(_reviewInterval);
    _reviewInterval = null;
  }
  if (_tunerTimer) {
    clearTimeout(_tunerTimer);
    _tunerTimer = null;
  }
  if (_tunerInterval) {
    clearInterval(_tunerInterval);
    _tunerInterval = null;
  }
  if (_calibratorTimer) {
    clearTimeout(_calibratorTimer);
    _calibratorTimer = null;
  }
  if (_calibratorInterval) {
    clearInterval(_calibratorInterval);
    _calibratorInterval = null;
  }
  if (_collector) {
    _collector.stop();
    _collector = null;
  }
  try { decisionRecorder.stopDecisionRecorder(); } catch (_) { /* shutdown best-effort */ }
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

/**
 * Accept a queued arbitration-rule proposal: pull the proposal off the
 * user-action queue, persist it to the learned-arbitration-rules
 * store, and resolve the queue item. Returns the inserted rule, or
 * null if the proposal was missing/invalid.
 *
 * Wired here (rather than in transcript-reviewer.js) because the
 * userQueue lives in this module's already-established lifecycle and
 * a UI/IPC layer typically needs one entry-point on the learning
 * system to drive accepts.
 *
 * @param {string} itemId   the user-action-queue item id
 * @returns {object|null}   the inserted rule, or null
 */
function acceptArbitrationRuleProposal(itemId) {
  if (!itemId) return null;
  const items = userQueue.getAllItems();
  const item = items.find((i) => i && i.id === itemId);
  if (!item) {
    log.warn('agent-learning', '[Rules] accept: item not found', { itemId });
    return null;
  }
  if (item.metadata?.type !== 'arbitration-rule-proposal') {
    log.warn('agent-learning', '[Rules] accept: wrong item type', { itemId });
    return null;
  }
  const proposal = item.metadata.proposal;
  if (!proposal) return null;

  const store = getLearnedArbitrationRules();
  const rule = store.addRule({
    ...proposal,
    acceptedAt: Date.now(),
    acceptedBy: 'user',
    sourceFindingId: proposal.id,
  });
  if (rule) {
    userQueue.resolveItem(itemId);
    log.info('agent-learning', '[Rules] Accepted proposal', {
      itemId,
      ruleId: rule.id,
      type: rule.type,
      target: rule.target,
    });
  }
  return rule;
}

/**
 * Reject a queued arbitration-rule proposal: drop it from the queue
 * without touching the rule store. The transcript-reviewer can
 * re-propose if the underlying pattern still holds.
 */
function rejectArbitrationRuleProposal(itemId, reason) {
  if (!itemId) return false;
  const items = userQueue.getAllItems();
  const item = items.find((i) => i && i.id === itemId);
  if (!item) return false;
  if (item.metadata?.type !== 'arbitration-rule-proposal') return false;
  userQueue.removeItem(itemId);
  log.info('agent-learning', '[Rules] Rejected proposal', {
    itemId,
    reason: reason || 'user-rejected',
  });
  return true;
}

module.exports = {
  initAgentLearning,
  shutdownAgentLearning,
  acceptArbitrationRuleProposal,
  rejectArbitrationRuleProposal,
  _checkLearningBudget,
  _setBudgetManagerForTests,
  _isModifiable,
  _getState,
  _setTestDeps,
  DEFAULT_CONFIG,
  LEARNING_FEATURE_PREFIX,
  BUDGET_SLICES,
};
