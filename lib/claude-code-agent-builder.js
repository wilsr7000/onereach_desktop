/**
 * Claude Code Agent Builder
 *
 * End-to-end orchestration: given a natural-language description of what the
 * user wants an agent to do, this module:
 *   1. Runs `planAgent` via the bundled Claude Code CLI to design the agent
 *   2. Generates a concrete agent config via `generateAgentFromDescription`
 *   3. Persists the agent via `getAgentStore().createAgent(...)`
 *   4. Returns a structured summary for spoken feedback
 *
 * Used by the Voice Orb's agent-builder-agent when the user says yes to
 * "Want me to build that agent now?" -- the entire flow happens in-app
 * without handing off to WISER Playbooks or opening the composer UI.
 *
 * SECURITY: The bundled `claude` CLI is invoked with
 * `--dangerously-skip-permissions` (standard for this app). The input we pass
 * is the user's own request, so trust is equivalent to any other voice
 * command the user issues.
 *
 * BUDGET: Each build costs roughly $0.02-0.05 (two Sonnet-level LLM calls).
 * The caller is expected to have done a budget precheck if needed.
 */

'use strict';

const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

// Rough cost estimate per build (plan + generate). Used for the pre-build
// budget check. Two Sonnet-level calls at ~2000 in / ~800 out each is
// approximately $0.05 total -- we round up to $0.08 so the precheck is
// conservative and avoids surprising the user at their daily cap.
const BUILD_COST_ESTIMATE_USD = 0.08;

// Lazy requires keep this module unit-testable without an Electron context.
let _runnerFactory = null;
let _generatorFactory = null;
let _storeFactory = null;
let _budgetFactory = null;
let _wrapperFactory = null;
let _playbookFactory = null;

function _getRunner() {
  if (_runnerFactory) return _runnerFactory();
  return require('./claude-code-runner');
}

function _getGenerator() {
  if (_generatorFactory) return _generatorFactory();
  return require('./ai-agent-generator');
}

function _getStore() {
  if (_storeFactory) return _storeFactory();
  return require('../src/voice-task-sdk/agent-store');
}

function _getBudget() {
  if (_budgetFactory) return _budgetFactory();
  try {
    return require('../budget-manager');
  } catch {
    return null;
  }
}

// Dynamic-runtime executor wrapper (packages/agents/dynamic-agent). Used by
// the verify stage to hot-wrap a config-only artifact and live-test it NOW
// instead of settling for config-pending-restart.
function _getWrapper() {
  if (_wrapperFactory) return _wrapperFactory();
  try {
    return require('../packages/agents/dynamic-agent');
  } catch {
    return null;
  }
}

// Playbook lifecycle (lib/agent-playbook): every build composes a playbook
// from the LOCAL AGENT TEMPLATE and generates the agent FROM it.
function _getPlaybookLib() {
  if (_playbookFactory) return _playbookFactory();
  return require('./agent-playbook');
}

/**
 * Test-only: inject mocks. Pass null to reset.
 * @param {{ runner?: () => object, generator?: () => object, store?: () => object, budget?: () => object, wrapper?: () => object, playbook?: () => object }} deps
 */
function _setTestDeps({ runner, generator, store, budget, wrapper, playbook } = {}) {
  _runnerFactory = runner || null;
  _generatorFactory = generator || null;
  _storeFactory = store || null;
  _budgetFactory = budget || null;
  _wrapperFactory = wrapper || null;
  _playbookFactory = playbook || null;
}

/**
 * Check whether starting a build would blow the user's budget cap.
 * Returns `{ blocked: boolean, reason: string|null }`.
 */
function _preflightBudgetCheck() {
  try {
    const budgetMod = _getBudget();
    if (!budgetMod) return { blocked: false, reason: null };
    const mgr = typeof budgetMod.getBudgetManager === 'function' ? budgetMod.getBudgetManager() : budgetMod;
    if (!mgr || typeof mgr.checkBudget !== 'function') return { blocked: false, reason: null };
    const check = mgr.checkBudget(BUILD_COST_ESTIMATE_USD);
    if (check && check.blocked) {
      // Prefer the first warning message for a user-friendly reason
      const reason =
        (check.warnings && check.warnings[0] && (check.warnings[0].message || check.warnings[0].reason)) ||
        'Daily budget cap would be exceeded';
      return { blocked: true, reason };
    }
    return { blocked: false, reason: null };
  } catch (e) {
    // Never block builds on budget-module errors
    log.warn('claude-code-agent-builder', 'Budget precheck failed, continuing', { error: e.message });
    return { blocked: false, reason: null };
  }
}

/**
 * Build a polished agent description to feed into the generator, using the
 * rich plan returned by Claude Code's planAgent step when available.
 * @private
 */
function _describeAgentFromPlan(originalRequest, plan) {
  if (!plan) return originalRequest;
  const parts = [`Build an agent that handles: ${originalRequest}`];
  if (plan.understanding) parts.push(`Understanding: ${plan.understanding}`);
  if (Array.isArray(plan.features) && plan.features.length) {
    parts.push(`Features: ${plan.features.join('; ')}`);
  }
  if (plan.approach) parts.push(`Approach: ${plan.approach}`);
  if (plan.suggestedName) parts.push(`Suggested name: ${plan.suggestedName}`);
  return parts.join('\n');
}

/**
 * Build a new agent via the bundled Claude Code CLI.
 *
 * Progress events emitted through `opts.onProgress` (when provided):
 *   - `{ stage: 'start',    message: 'Starting build...' }`
 *   - `{ stage: 'plan',     message: 'Designing the agent...' }`
 *   - `{ stage: 'generate', message: 'Writing the agent...' }`
 *   - `{ stage: 'save',     message: 'Saving and registering...' }`
 *   - `{ stage: 'done',     message: 'Done.' }`
 *   - `{ stage: 'failed',   message: '<error>' }`
 *
 * @param {string} userRequest
 * @param {Object} [opts]
 * @param {Object}   [opts.availableTemplates]
 * @param {Object}   [opts.generatorOptions]
 * @param {number}   [opts.timeoutMs=120000]
 * @param {boolean}  [opts.skipPlanning=false]
 * @param {boolean}  [opts.skipBudgetCheck=false]
 * @param {Function} [opts.onProgress]   - `(event: { stage, message }) => void`
 * @returns {Promise<BuildAgentResult>}
 *
 * @typedef {Object} BuildAgentResult
 * @property {boolean} success
 * @property {Object|null} agent
 * @property {Object|null} plan
 * @property {string|null} error
 * @property {string} stage   - 'validate' | 'budget' | 'plan' | 'generate' | 'save' | 'done'
 * @property {number} elapsedMs
 * @property {boolean} [budgetBlocked]  - True if refused due to budget cap
 */
async function buildAgentWithClaudeCode(userRequest, opts = {}) {
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs || 120000;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  function emit(stage, message) {
    if (!onProgress) return;
    try {
      onProgress({ stage, message });
    } catch (e) {
      // Progress is advisory -- never let a consumer bug break the build.
      log.warn('claude-code-agent-builder', 'onProgress callback threw', { error: e.message });
    }
  }

  if (typeof userRequest !== 'string' || !userRequest.trim()) {
    return {
      success: false,
      agent: null,
      plan: null,
      error: 'userRequest must be a non-empty string',
      stage: 'validate',
      elapsedMs: 0,
    };
  }

  /** @type {BuildAgentResult} */
  const result = {
    success: false,
    agent: null,
    plan: null,
    error: null,
    stage: 'start',
    elapsedMs: 0,
  };

  emit('start', 'Starting build');

  // ---- Budget precheck ----------------------------------------------------
  if (!opts.skipBudgetCheck) {
    result.stage = 'budget';
    const budgetCheck = _preflightBudgetCheck();
    if (budgetCheck.blocked) {
      result.success = false;
      result.error = budgetCheck.reason;
      result.budgetBlocked = true;
      result.elapsedMs = Date.now() - startedAt;
      emit('failed', budgetCheck.reason);
      log.warn('claude-code-agent-builder', 'Build blocked by budget precheck', {
        reason: budgetCheck.reason,
      });
      return result;
    }
  }

  // Overall timeout so a stuck Claude Code process doesn't pin the agent-builder
  // conversation forever. Clears if we complete first.
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    log.warn('claude-code-agent-builder', 'Build timed out', { timeoutMs, userRequest: userRequest.slice(0, 120) });
  }, timeoutMs);

  try {
    // ---- Stage 1: planAgent ------------------------------------------------
    if (!opts.skipPlanning) {
      result.stage = 'plan';
      emit('plan', 'Designing the agent');
      log.info('claude-code-agent-builder', 'Planning agent', { userRequest: userRequest.slice(0, 120) });

      const runner = _getRunner();
      let planResult;
      try {
        planResult = await runner.planAgent(userRequest, opts.availableTemplates || {});
      } catch (planErr) {
        if (timedOut) throw new Error('Build timed out during planning');
        log.warn('claude-code-agent-builder', 'planAgent threw; falling back to direct generation', {
          error: planErr.message,
        });
        planResult = null;
      }

      if (timedOut) throw new Error('Build timed out');
      if (planResult && planResult.success && planResult.plan) {
        result.plan = planResult.plan;
      }
      // Non-fatal: if planning failed, we still try the generator with just the request.
    }

    // ---- Stage 1.5: playbook (LOCAL AGENT TEMPLATE) -----------------------
    // The playbook is composed BEFORE generation and the agent is generated
    // FROM it: the playbook is the durable spec (saved to Spaces, opened in
    // WISER Playbooks by the builder agent), the agent is the artifact.
    // Composition is deterministic and never fails; the Spaces save is
    // best-effort -- the markdown always rides on the agent config.
    result.stage = 'playbook';
    emit('playbook', 'Writing the playbook');
    result.playbook = null;
    try {
      const playbookLib = _getPlaybookLib();
      const composed = playbookLib.composeLocalAgentPlaybook({
        request: userRequest,
        plan: result.plan,
        assessment: opts.assessment || null,
        config: opts.knownConfig || null,
      });
      const saveOutcome = playbookLib.saveAgentPlaybook(composed.markdown, {
        title: composed.title,
        agentName: composed.agentName,
        request: userRequest,
      });
      result.playbook = {
        markdown: composed.markdown,
        title: composed.title,
        saved: saveOutcome.saved,
        ref: saveOutcome.ref,
      };
    } catch (pbErr) {
      log.warn('claude-code-agent-builder', 'Playbook stage failed (build continues)', { error: pbErr.message });
    }

    if (timedOut) throw new Error('Build timed out');

    // ---- Stage 2: generateAgentFromDescription ---------------------------
    result.stage = 'generate';
    emit('generate', 'Writing the agent');
    // The local agent builds off the playbook, exactly like the pipeline
    // built off the plan: the full playbook markdown IS the generator spec.
    const description = result.playbook
      ? `${_describeAgentFromPlan(userRequest, result.plan)}\n\nBuild the agent to satisfy this playbook:\n\n${result.playbook.markdown}`
      : _describeAgentFromPlan(userRequest, result.plan);
    const generator = _getGenerator();

    let config;
    try {
      config = await generator.generateAgentFromDescription(description, opts.generatorOptions || {});
    } catch (genErr) {
      if (timedOut) throw new Error('Build timed out during generation');
      throw new Error(`Agent generation failed: ${genErr.message}`);
    }

    if (!config) {
      throw new Error('Agent generator returned empty config');
    }

    // The playbook travels WITH the agent: self-heal rebuilds and
    // feature-adds regenerate from the spec, not a lossy description.
    if (result.playbook) {
      config.playbook = {
        markdown: result.playbook.markdown,
        title: result.playbook.title,
        ref: result.playbook.ref || null,
      };
    }

    if (timedOut) throw new Error('Build timed out');

    // ---- Stage 3: persist --------------------------------------------------
    result.stage = 'save';
    emit('save', 'Saving and registering');
    const agentStore = _getStore();
    const store = typeof agentStore.getAgentStore === 'function' ? agentStore.getAgentStore() : agentStore;
    if (store && typeof store.init === 'function') await store.init();

    if (!store || typeof store.createAgent !== 'function') {
      throw new Error('Agent store is not available');
    }

    // Rebuild/feature-add flows update the EXISTING agent in place (same id,
    // version history preserved, agent-store re-emits hot-connect) instead of
    // minting a duplicate next to the broken original.
    let agent;
    if (opts.updateAgentId) {
      if (typeof store.updateAgent !== 'function') {
        throw new Error('Agent store cannot update agents');
      }
      agent = await store.updateAgent(opts.updateAgentId, config, 'update', 'Rebuilt/updated by agent-builder');
    } else {
      agent = await store.createAgent(config);
    }
    if (!agent) {
      throw new Error('Agent store did not return a persisted agent');
    }

    // ---- Stage 4: verify (test it before telling the user it works) --------
    // The 2026-08 live E2E caught the builder announcing "Done. I built
    // Alarm Manager" while the artifact failed contract validation at the
    // moment of creation (no runtime execute() — stored configs are only
    // wrapped by the dynamic runtime at boot). Never announce an untested
    // build as working. Verification outcomes:
    //   live-tested            — artifact executed the original request now
    //   config-pending-restart — valid config; activates via the dynamic
    //                            runtime on next app start
    //   failed                 — artifact is broken; the user must be told
    result.stage = 'verify';
    emit('verify', 'Testing the new agent');
    result.verified = { mode: 'failed', detail: '' };
    try {
      if (typeof agent.execute === 'function') {
        const testOut = await Promise.race([
          agent.execute({ content: userRequest, metadata: { source: 'post-build-self-test' } }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('self-test timeout (15s)')), 15000)),
        ]);
        if (testOut && testOut.success !== false) {
          result.verified = { mode: 'live-tested', detail: (testOut.message || '').slice(0, 120) };
        } else {
          result.verified = { mode: 'failed', detail: (testOut && testOut.error) || 'self-test returned failure' };
        }
      } else if (config && (config.executionType || config.type) && (config.code || config.prompt || config.systemPrompt)) {
        // Config-only artifact: try to hot-wrap it with the dynamic
        // runtime's executor and live-test it NOW. Only when the config
        // isn't LLM-wrappable (applescript/shell/script/api) do we fall
        // back to the honest config-pending-restart outcome.
        let wrapped = null;
        try {
          const dyn = _getWrapper();
          if (dyn && typeof dyn.wrapConfigAgent === 'function') {
            wrapped = dyn.wrapConfigAgent({ ...config, id: agent.id, name: agent.name || config.name });
          }
        } catch (_wrapErr) {
          wrapped = null;
        }
        if (wrapped && typeof wrapped.execute === 'function') {
          try {
            const testOut = await Promise.race([
              wrapped.execute({ content: userRequest, metadata: { source: 'post-build-self-test' } }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('self-test timeout (15s)')), 15000)),
            ]);
            if (testOut && testOut.success !== false) {
              result.verified = {
                mode: 'live-tested',
                detail: `hot-wrapped config; ${String(testOut.message || testOut.result || '').slice(0, 120)}`,
              };
            } else {
              result.verified = {
                mode: 'failed',
                detail: (testOut && testOut.error) || 'hot-wrapped self-test returned failure',
              };
            }
          } catch (wrapTestErr) {
            // A thrown self-test (timeout, transient LLM error) doesn't prove
            // the config is broken -- the dynamic runtime can still serve it.
            result.verified = {
              mode: 'config-pending-restart',
              detail: `hot-wrap self-test errored (${wrapTestErr.message}); config remains servable`,
            };
          }
        } else {
          result.verified = {
            mode: 'config-pending-restart',
            detail: `executionType=${config.executionType || config.type}`,
          };
        }
      } else {
        result.verified = { mode: 'failed', detail: 'artifact has neither an executor nor a servable config' };
      }
    } catch (testErr) {
      result.verified = { mode: 'failed', detail: testErr.message };
    }
    log.info('claude-code-agent-builder', 'Post-build verification', {
      agentId: agent.id || null,
      mode: result.verified.mode,
      detail: result.verified.detail,
    });
    if (result.verified.mode === 'failed') {
      // A broken build is a FAILED build, loudly — not a cheerful "Done".
      log.error('claude-code-agent-builder', 'Built agent FAILED verification', {
        event: 'agent-build:verification-failed',
        agentId: agent.id || null,
        agentName: agent.name || null,
        detail: result.verified.detail,
      });
    }

    // ---- Done --------------------------------------------------------------
    result.stage = 'done';
    result.success = result.verified.mode !== 'failed';
    if (!result.success) {
      result.error = `Built but failed verification: ${result.verified.detail}`;
    }
    result.agent = agent;
    result.elapsedMs = Date.now() - startedAt;

    emit('done', 'Done');
    log.info('claude-code-agent-builder', 'Built agent successfully', {
      agentId: agent.id || null,
      agentName: agent.name || null,
      elapsedMs: result.elapsedMs,
    });

    return result;
  } catch (err) {
    result.success = false;
    result.error = err && err.message ? err.message : String(err);
    result.elapsedMs = Date.now() - startedAt;
    emit('failed', result.error);
    log.warn('claude-code-agent-builder', 'Build failed', { stage: result.stage, error: result.error });
    return result;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

module.exports = {
  buildAgentWithClaudeCode,
  BUILD_COST_ESTIMATE_USD,
  _setTestDeps,
  _describeAgentFromPlan, // exported for testing
  _preflightBudgetCheck, // exported for testing
};
