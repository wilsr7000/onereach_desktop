/**
 * Task Builder (live-path, JS)
 *
 * Constructs the canonical Task shape used by the exchange pipeline.
 * Mirrors the TypeScript `Task` interface in
 * src/voice-task-sdk/core/types.ts but stays plain JS so main-process
 * code (exchange-bridge, hud-api) can depend on it without a TS build.
 *
 * Use this instead of ad-hoc object literals when submitting to the
 * exchange. It fills in missing required fields, normalizes metadata,
 * and gives every downstream consumer a predictable shape.
 *
 * Extra fields introduced in the agent-system upgrade (criteria, rubric,
 * variant, toolId, spaceId, etc.) are OPTIONAL; existing tasks without
 * them continue to route through the single-winner auction unchanged.
 */

'use strict';

const { v4: uuidv4 } = require('uuid');

const VALID_STATUSES = new Set([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'deadletter',
]);

const VALID_VARIANTS = new Set(['winner', 'council', 'lead_plus_probers']);

/**
 * Build a canonical Task object. Missing fields get safe defaults.
 *
 * @param {Object}   input
 * @param {string}   input.content             - The raw user input / utterance (REQUIRED)
 * @param {string}   [input.id]                - Task id; generated if omitted
 * @param {string}   [input.action]            - Action name, defaults to '' (legacy shape)
 * @param {Object}   [input.params]            - Action params; defaults to {}
 * @param {1|2|3}    [input.priority]          - 1=low, 2=normal (default), 3=high
 * @param {string}   [input.status]            - Defaults to 'pending'
 * @param {string}   [input.queue]             - Defaults to 'default'
 * @param {number}   [input.maxAttempts]       - Defaults to 3
 * @param {string}   [input.description]       - Task description distinct from content
 * @param {Array}    [input.criteria]          - Per-criterion rubric (Phase 4)
 * @param {string}   [input.rubric]            - Named rubric id in lib/task-rubrics
 * @param {string}   [input.variant]           - 'winner' | 'council' | 'lead_plus_probers'
 * @param {string}   [input.toolId]            - Originating tool id
 * @param {string}   [input.spaceId]           - Agent-space scope
 * @param {string}   [input.targetAgentId]     - Direct-dispatch agent id
 * @param {string}   [input.parentTaskId]      - Parent task when this is a subtask
 * @param {Object}   [input.metadata]          - Free-form metadata bag
 * @returns {Object} Canonical task object
 */
function buildTask(input = {}) {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('buildTask: input must be an object');
  }

  const content = typeof input.content === 'string' ? input.content : '';
  if (!content.trim()) {
    throw new Error('buildTask: content is required and cannot be empty');
  }

  const task = {
    id: input.id || uuidv4(),
    action: typeof input.action === 'string' ? input.action : '',
    content: content.trim(),
    params: input.params && typeof input.params === 'object' ? input.params : {},
    priority: _normalizePriority(input.priority),
    status: VALID_STATUSES.has(input.status) ? input.status : 'pending',
    queue: typeof input.queue === 'string' ? input.queue : 'default',
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : Date.now(),
    attempt: typeof input.attempt === 'number' ? input.attempt : 0,
    maxAttempts: typeof input.maxAttempts === 'number' ? input.maxAttempts : 3,
  };

  // Optional pass-through fields
  if (typeof input.assignedAgent === 'string') task.assignedAgent = input.assignedAgent;
  if (typeof input.startedAt === 'number') task.startedAt = input.startedAt;
  if (typeof input.completedAt === 'number') task.completedAt = input.completedAt;
  if (typeof input.lastError === 'string') task.lastError = input.lastError;
  if (input.result !== undefined) task.result = input.result;
  if (typeof input.error === 'string') task.error = input.error;

  // ── Agent-system upgrade additions (all optional) ────────────────────────
  if (typeof input.description === 'string') task.description = input.description;
  if (Array.isArray(input.criteria)) task.criteria = input.criteria.map(_normalizeCriterion);
  if (typeof input.rubric === 'string') task.rubric = input.rubric;
  // Auto-expand a named rubric into criteria when the caller didn't
  // supply their own. Keeps the explicit criteria path winning so
  // callers can override individual criteria when needed.
  if (task.rubric && !task.criteria) {
    try {
      const { rubricToCriteria } = require('./task-rubrics');
      const expanded = rubricToCriteria(task.rubric);
      if (Array.isArray(expanded) && expanded.length > 0) task.criteria = expanded;
    } catch (_err) { /* task-rubrics is optional; fall through */ }
  }
  if (VALID_VARIANTS.has(input.variant)) task.variant = input.variant;
  if (typeof input.toolId === 'string') task.toolId = input.toolId;
  if (typeof input.spaceId === 'string') task.spaceId = input.spaceId;
  if (typeof input.targetAgentId === 'string') task.targetAgentId = input.targetAgentId;
  if (typeof input.parentTaskId === 'string') task.parentTaskId = input.parentTaskId;

  // Metadata bag -- if caller supplied one, carry it; otherwise seed empty.
  // Also merge well-known fields into metadata for back-compat with code
  // paths (exchange bridge, learning loop) that read task.metadata.*.
  const baseMeta = input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : {};
  if (task.toolId && baseMeta.source === undefined) baseMeta.source = task.toolId;
  if (task.spaceId && baseMeta.agentSpaceId === undefined) baseMeta.agentSpaceId = task.spaceId;
  if (task.targetAgentId) {
    if (baseMeta.targetAgentId === undefined) baseMeta.targetAgentId = task.targetAgentId;
    if (baseMeta.agentFilter === undefined) baseMeta.agentFilter = [task.targetAgentId];
  }
  if (baseMeta.timestamp === undefined) baseMeta.timestamp = task.createdAt;
  task.metadata = baseMeta;

  return task;
}

/**
 * Normalize an existing task-shaped object: fills in defaults without
 * discarding present fields. Safe to call on objects produced elsewhere
 * (legacy ad-hoc task literals) to bring them up to canonical shape.
 *
 * @param {Object} task
 * @returns {Object}
 */
function normalizeTask(task) {
  if (!task || typeof task !== 'object') {
    throw new TypeError('normalizeTask: task must be an object');
  }
  return buildTask(task);
}

/**
 * Produce an exchange-submit payload from a canonical Task.
 * Mirrors the legacy `exchange.submit({ content, priority, metadata })`
 * call shape used by exchange-bridge today, so Phase 0 can swap callers
 * over without touching exchange.ts.
 *
 * @param {Object} task - Canonical task (from buildTask)
 * @returns {{ content: string, priority: number, metadata: Object }}
 */
function toSubmitPayload(task) {
  return {
    content: task.content,
    priority: task.priority,
    metadata: task.metadata || {},
  };
}

function _normalizePriority(p) {
  if (p === 1 || p === 2 || p === 3) return p;
  const n = Number(p);
  if (n === 1 || n === 2 || n === 3) return n;
  return 2;
}

function _normalizeCriterion(c) {
  if (!c || typeof c !== 'object') return null;
  const out = { id: String(c.id || '').trim(), label: String(c.label || c.id || '').trim() };
  if (!out.id) return null;
  if (typeof c.description === 'string') out.description = c.description;
  if (typeof c.weight === 'number' && isFinite(c.weight)) out.weight = c.weight;
  return out;
}

module.exports = {
  buildTask,
  normalizeTask,
  toSubmitPayload,
  VALID_STATUSES,
  VALID_VARIANTS,
};
