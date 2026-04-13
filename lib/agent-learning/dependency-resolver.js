/**
 * Dependency Resolver
 *
 * Detects when an agent improvement or creation requires something the
 * system can't provide autonomously -- API keys, system access, user
 * credentials, external service setup, etc.
 *
 * When a dependency is detected:
 *   1. The improvement is paused (not rejected)
 *   2. A playbook entry is created with status 'blocked-on-user'
 *   3. The user is notified with a specific, actionable request
 *   4. The dependency is tracked so the system can resume when resolved
 *
 * Uses ai-service for semantic analysis (not regex) per project rules.
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

let _ai = null;
function _getAI() {
  if (!_ai) _ai = require('../ai-service');
  return _ai;
}

// In-memory registry of pending user actions
const _pendingActions = new Map();

const DEPENDENCY_TYPES = {
  API_KEY: 'api-key',
  SYSTEM_ACCESS: 'system-access',
  CREDENTIALS: 'credentials',
  EXTERNAL_SERVICE: 'external-service',
  PERMISSION: 'permission',
  CONFIGURATION: 'configuration',
  DATA_SOURCE: 'data-source',
};

/**
 * Analyze an improvement to detect if it requires user-provided resources.
 *
 * @param {object} agent - Agent being improved
 * @param {object} improvement - Generated improvement { type, patch, description }
 * @param {object} issue - Evaluator issue { specificIssue, reasoning }
 * @returns {{ hasDependencies, dependencies: Array, canProceedPartially }}
 */
async function detectDependencies(agent, improvement, issue) {
  const ai = _getAI();

  const context = `
Agent: "${agent.name}" -- ${(agent.description || '').slice(0, 150)}
Improvement type: ${improvement?.type || 'unknown'}
Improvement description: ${improvement?.description || 'none'}
Issue: ${issue?.specificIssue || 'none'}
Issue reasoning: ${issue?.reasoning || 'none'}
Agent data sources: ${JSON.stringify(agent.dataSources || [])}
Agent has API keys configured: ${!!(agent.apiKey || agent.settings?.apiKey)}`;

  try {
    const result = await ai.json(
      `Analyze this agent improvement and determine if it requires anything from the user that the system cannot provide autonomously.

${context}

The system CAN do autonomously:
- Rewrite prompts
- Change keywords, categories, description
- Enable memory or multi-turn
- Add UI spec instructions
- Adjust timeouts and execution settings

The system CANNOT do autonomously (requires user):
- Obtain API keys for external services
- Get login credentials for websites/services
- Enable system permissions (screen recording, accessibility, etc.)
- Set up external accounts (Gmail, Slack, etc.)
- Configure webhooks or server endpoints
- Provide personal data (home address, preferences not yet learned)

Return JSON:
{
  "hasDependencies": true/false,
  "dependencies": [
    {
      "type": "api-key" | "system-access" | "credentials" | "external-service" | "permission" | "configuration" | "data-source",
      "description": "what specifically is needed",
      "actionForUser": "clear 1-sentence instruction for the user",
      "blocking": true/false,
      "settingsKey": "where to configure this in app settings, or null"
    }
  ],
  "canProceedPartially": true/false,
  "partialDescription": "what can be done now without the dependency, or null"
}`,
      {
        profile: 'fast',
        feature: 'agent-learning-deps',
        maxTokens: 400,
        temperature: 0.2,
      }
    );

    return {
      hasDependencies: !!result.hasDependencies,
      dependencies: (result.dependencies || []).map((d) => ({
        type: d.type || 'configuration',
        description: d.description || '',
        actionForUser: d.actionForUser || '',
        blocking: d.blocking !== false,
        settingsKey: d.settingsKey || null,
      })),
      canProceedPartially: !!result.canProceedPartially,
      partialDescription: result.partialDescription || null,
    };
  } catch (err) {
    log.warn('agent-learning', 'Dependency detection failed, assuming no dependencies', {
      error: err.message,
    });
    return { hasDependencies: false, dependencies: [], canProceedPartially: true };
  }
}

/**
 * Register a pending user action. The user is notified and the system
 * tracks that this improvement is waiting on them.
 *
 * @param {object} params
 * @param {string} params.agentId
 * @param {string} params.agentName
 * @param {object} params.improvement
 * @param {Array} params.dependencies
 * @returns {string} actionId
 */
function registerPendingAction(params) {
  const { agentId, agentName, improvement, dependencies } = params;
  const actionId = `action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  _pendingActions.set(actionId, {
    id: actionId,
    agentId,
    agentName: agentName || agentId,
    improvement,
    dependencies,
    createdAt: Date.now(),
    status: 'pending',
    resolvedDependencies: [],
  });

  log.info('agent-learning', 'Registered pending user action', {
    actionId,
    agentId,
    dependencyCount: dependencies.length,
    types: dependencies.map((d) => d.type),
  });

  return actionId;
}

/**
 * Mark a dependency as resolved by the user.
 * If all dependencies for an action are resolved, returns the action for resumption.
 */
function resolveDependency(actionId, dependencyIndex) {
  const action = _pendingActions.get(actionId);
  if (!action) return null;

  if (!action.resolvedDependencies.includes(dependencyIndex)) {
    action.resolvedDependencies.push(dependencyIndex);
  }

  const allResolved = action.dependencies.every(
    (_, idx) => action.resolvedDependencies.includes(idx) || !action.dependencies[idx].blocking
  );

  if (allResolved) {
    action.status = 'ready';
    return action;
  }

  return null;
}

/**
 * Build a user-facing notification message for pending dependencies.
 */
function buildUserNotification(agentName, dependencies) {
  const blocking = dependencies.filter((d) => d.blocking);
  const nonBlocking = dependencies.filter((d) => !d.blocking);

  const parts = [];

  if (blocking.length === 1) {
    parts.push(
      `I'd like to improve the ${agentName} agent, but I need your help first: ${blocking[0].actionForUser}`
    );
  } else if (blocking.length > 1) {
    parts.push(
      `I'd like to improve the ${agentName} agent, but I need a few things from you:`
    );
    for (const dep of blocking) {
      parts.push(`  -- ${dep.actionForUser}`);
    }
  }

  if (nonBlocking.length > 0 && blocking.length === 0) {
    parts.push(
      `I improved the ${agentName} agent. For even better results, you could: ${nonBlocking.map((d) => d.actionForUser).join('; ')}`
    );
  }

  if (blocking.length > 0) {
    parts.push('You can set these up in Settings, then I\'ll continue the improvement automatically.');
  }

  return parts.join('\n');
}

/**
 * Get all pending actions (for UI display or resumption check).
 */
function getPendingActions() {
  return Array.from(_pendingActions.values()).filter((a) => a.status === 'pending');
}

/**
 * Get actions that are ready to resume (all blocking deps resolved).
 */
function getReadyActions() {
  return Array.from(_pendingActions.values()).filter((a) => a.status === 'ready');
}

/**
 * Remove a completed or abandoned action.
 */
function removeAction(actionId) {
  return _pendingActions.delete(actionId);
}

function clearAll() {
  _pendingActions.clear();
}

/** Override ai-service for testing */
function _setTestDeps(deps) {
  if (deps.ai) _ai = deps.ai;
}

module.exports = {
  detectDependencies,
  registerPendingAction,
  resolveDependency,
  buildUserNotification,
  getPendingActions,
  getReadyActions,
  removeAction,
  clearAll,
  DEPENDENCY_TYPES,
  _setTestDeps,
};
