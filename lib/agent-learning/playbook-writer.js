/**
 * Playbook Writer
 *
 * Writes improvement and creation playbooks to the Agent Product Manager
 * space as an audit trail. Every change (whether auto-applied or
 * LLM-generated) gets a playbook entry.
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

const PM_SPACE_ID = 'agent-product-manager';
const PM_SPACE_NAME = 'Agent Product Manager';

let _spacesAPI = null;
function _getSpacesAPI() {
  if (!_spacesAPI) {
    const { getSpacesAPI } = require('../../spaces-api');
    _spacesAPI = getSpacesAPI();
  }
  return _spacesAPI;
}

/**
 * Ensure the Agent Product Manager space exists.
 */
async function ensurePMSpace() {
  try {
    const api = _getSpacesAPI();
    const storage = api.storage || api._storage;
    if (!storage) return false;

    const spaces = storage.index?.spaces || [];
    const exists = spaces.find((s) => s.id === PM_SPACE_ID);
    if (exists) return true;

    storage.createSpace({
      id: PM_SPACE_ID,
      name: PM_SPACE_NAME,
      icon: '●',
      color: '#6366f1',
      isSystem: true,
    });
    log.info('agent-learning', 'Created Agent Product Manager space');
    return true;
  } catch (err) {
    log.warn('agent-learning', 'Could not ensure PM space', { error: err.message });
    return false;
  }
}

/**
 * Write an improvement playbook to the PM space.
 *
 * @param {object} params
 * @param {object} params.agent - Agent that was improved
 * @param {object} params.improvement - The improvement that was applied
 * @param {object} params.verification - Verification results
 * @param {string} params.trigger - What triggered this ('frustration'|'capability-gap'|'proactive')
 * @param {string} params.verdict - 'deployed'|'rejected'|'rolled-back'
 * @param {string} [params.versionNumber] - Agent store version for rollback
 */
async function writeImprovementPlaybook(params) {
  const { agent, improvement, verification, trigger, verdict, versionNumber } = params;
  await ensurePMSpace();

  const beforePrompt = (agent.prompt || '').slice(0, 200);
  const changeDescription = improvement?.description || 'No description';

  const verificationSummary = verification
    ? `- Test cases run: ${verification.results?.length || 0}
- Improved: ${verification.improved || 0}, Degraded: ${verification.degraded || 0}
- Quality score: ${((verification.score || 0) * 100).toFixed(0)}%
- Verdict: ${verdict}`
    : `- Verdict: ${verdict} (no verification)`;

  const patchDiff = improvement?.patch
    ? Object.entries(improvement.patch)
        .map(([k, v]) => `  ${k}: ${JSON.stringify(v).slice(0, 200)}`)
        .join('\n')
    : '  (none)';

  const content = `# Improvement: ${agent.name || agent.id} -- ${improvement?.type || 'unknown'}

## Trigger
${improvement?.description || 'Automated improvement'}
Detected at: ${new Date().toISOString()}
Triggered by: ${trigger || 'unknown'}

## Before
- Prompt: ${beforePrompt}${beforePrompt.length >= 200 ? '...' : ''}
- Agent ID: ${agent.id}

## Changes Applied
${patchDiff}

## Verification
${verificationSummary}

## Rollback
agent-store version: ${versionNumber || 'N/A'}
`;

  try {
    const api = _getSpacesAPI();
    const storage = api.storage || api._storage;
    if (!storage) return null;

    const item = storage.addItem({
      type: 'text',
      content,
      spaceId: PM_SPACE_ID,
      timestamp: Date.now(),
      metadata: {
        title: `${verdict === 'deployed' ? 'Improvement' : 'Rejected'}: ${agent.name} -- ${improvement?.type || 'unknown'}`,
        itemType: 'agent-playbook',
        playbookType: 'improvement',
        targetAgentId: agent.id,
        status: verdict,
        triggeredBy: trigger,
        improvementType: improvement?.type,
      },
      tags: ['agent-playbook', 'auto-generated'],
    });

    log.info('agent-learning', 'Wrote improvement playbook', {
      agentId: agent.id,
      verdict,
      type: improvement?.type,
    });
    return item;
  } catch (err) {
    log.warn('agent-learning', 'Failed to write playbook', { error: err.message });
    return null;
  }
}

/**
 * Write a new-agent creation playbook.
 */
async function writeCreationPlaybook(params) {
  const { description, feasibility, agentDefinition, verdict } = params;
  await ensurePMSpace();

  const content = `# New Agent: ${agentDefinition?.name || 'Unnamed'}

## Request
${description || 'Capability gap detected'}

## Feasibility
- Effort: ${feasibility?.effort || 'unknown'}
- Reasoning: ${feasibility?.reasoning || 'N/A'}
- Estimated cost: ${feasibility?.estimatedCostPerUse || 'N/A'}

## Agent Definition
${JSON.stringify(agentDefinition || {}, null, 2)}

## Status
${verdict || 'pending'}
`;

  try {
    const api = _getSpacesAPI();
    const storage = api.storage || api._storage;
    if (!storage) return null;

    const item = storage.addItem({
      type: 'text',
      content,
      spaceId: PM_SPACE_ID,
      timestamp: Date.now(),
      metadata: {
        title: `New Agent: ${agentDefinition?.name || 'Unnamed'}`,
        itemType: 'agent-playbook',
        playbookType: 'creation',
        status: verdict || 'pending',
        triggeredBy: 'capability-gap',
      },
      tags: ['agent-playbook', 'auto-generated', 'new-agent'],
    });

    return item;
  } catch (err) {
    log.warn('agent-learning', 'Failed to write creation playbook', { error: err.message });
    return null;
  }
}

/** Override spaces API for testing */
function _setTestDeps(deps) {
  if (deps.spacesAPI) _spacesAPI = deps.spacesAPI;
}

module.exports = {
  ensurePMSpace,
  writeImprovementPlaybook,
  writeCreationPlaybook,
  PM_SPACE_ID,
  PM_SPACE_NAME,
  _setTestDeps,
};
