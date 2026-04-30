/**
 * Task Queue Agent
 *
 * Voice-triggered agent that adds a task or alarm to the user's TaskQueue
 * in the OmniGraph (Neo4j). Pure "write" agent -- does not list, complete,
 * or delete. Reads are handled elsewhere (e.g. critical-meeting-alarm-agent
 * can be extended to also poll this queue for upcoming fire_at items).
 *
 * Flow:
 *   1. LLM extracts { name, due_at_iso?, priority, is_alarm, notes } from
 *      the user's utterance.
 *   2. If name is missing -> needsInput multi-turn.
 *   3. Otherwise upsert the queue + create a TaskItem and return a concise
 *      confirmation the orb can speak.
 *
 * See lib/task-graph-store.js for the Cypher layer and
 * scripts/omnigraph-schemas-export.json for the schema.
 */

'use strict';

const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();
const {
  addTaskItem,
  DEFAULT_QUEUE_ID,
} = require('../../lib/task-graph-store');

// Allow tests to inject fake implementations without mocking require().
// vi.mock with vi.fn() is flaky across the CJS module boundary here, so we
// prefer explicit dependency injection via these setters.
let _addTaskItem = addTaskItem;
function _setAddTaskItemForTests(fn) {
  _addTaskItem = typeof fn === 'function' ? fn : addTaskItem;
}

let _extractor = null; // set after extractTaskDetails is defined, below
function _setExtractorForTests(fn) {
  _extractor = typeof fn === 'function' ? fn : extractTaskDetails;
}

// Label -> integer priority. Higher integer = higher priority, matching the
// ordering used by the existing unified-task-queue and the graph's
// "ORDER BY t.priority DESC" runnable query.
const PRIORITY_MAP = {
  urgent: 10,
  high: 8,
  normal: 5,
  low: 2,
};

/**
 * Parse the user's utterance into structured fields via the centralized
 * AI service. Returns an object shaped like:
 *   { name, due_at_iso?, priority, is_alarm, notes? }
 * Never throws -- returns {} and logs on failure so we can still recover
 * with a needsInput prompt.
 */
async function extractTaskDetails(query, now) {
  const system = [
    'You extract structured task data from short voice commands.',
    '',
    'Output JSON with these keys:',
    '- name (string, required): short title of the task (max 80 chars)',
    '- due_at_iso (string|null): ISO 8601 datetime if a specific time/date is',
    '  mentioned. Interpret relative times ("in 5 minutes", "tomorrow at 3pm")',
    '  against the provided "now". If no time, return null.',
    '- priority (string): one of "urgent", "high", "normal", "low".',
    '  Default "normal". Map clues like "important"->high, "asap"->urgent,',
    '  "whenever"->low.',
    '- is_alarm (boolean): true when the user used words like "alarm",',
    '  "remind me", "wake me", "notify me at", or otherwise implied a',
    '  point-in-time notification.',
    '- notes (string|null): any extra detail the user provided.',
    '',
    'Do not invent fields that were not spoken. Do not include markdown.',
  ].join('\n');

  const userMsg = `now: ${now.toISOString()}\nuser said: ${query}`;

  try {
    const obj = await ai.json(userMsg, {
      profile: 'standard',
      system,
      feature: 'task-queue-agent:extract',
    });
    return obj && typeof obj === 'object' ? obj : {};
  } catch (err) {
    log.warn('task-queue-agent', 'extract failed -- falling back to raw text', {
      error: err.message,
    });
    return { name: String(query).trim().slice(0, 80) };
  }
}

function _priorityToInt(label) {
  const key = String(label || 'normal').toLowerCase();
  return PRIORITY_MAP[key] ?? PRIORITY_MAP.normal;
}

function _parseFireAtMs(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function _formatRelativeWhen(fireAtMs, now = Date.now()) {
  if (!Number.isFinite(fireAtMs)) return '';
  const deltaMs = fireAtMs - now;
  if (deltaMs <= 0) return ' (in the past)';
  const mins = Math.round(deltaMs / 60000);
  if (mins < 60) return ` in ${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return ` in about ${hours} hour${hours === 1 ? '' : 's'}`;
  const date = new Date(fireAtMs);
  const when = date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return ` on ${when}`;
}

const taskQueueAgent = {
  id: 'task-queue-agent',
  name: 'Task Queue',
  description:
    'Adds a task or alarm to the user\'s task queue in the graph. Extracts title, optional time, priority, and notes from natural language and creates a TaskItem (ENQUEUED_IN the default user queue).',
  voice: 'alloy',
  acks: ["Got it, adding that.", 'Adding to your queue now.', 'On it.'],
  categories: ['productivity', 'tasks'],
  keywords: [
    'add task',
    'add a task',
    'new task',
    'create task',
    'queue task',
    'enqueue',
    'add to queue',
    'put on my list',
    'add to list',
    'remind me',
    'remind me to',
    'set alarm',
    'set an alarm',
    'alarm for',
  ],
  executionType: 'action',
  estimatedExecutionMs: 3000,
  dataSources: ['omnigraph'],

  prompt: `Task Queue Agent adds a new item (a task or a time-bound alarm)
to the user's TaskQueue in the graph. It is a pure "write" agent -- it does
not read, list, complete, or delete. Other agents handle those.

HIGH confidence examples (this agent should win):
- "Add a task to call Jenny tomorrow at 2pm"
- "Remind me in 10 minutes to check the oven"
- "Set an alarm for 6am"
- "Put 'file taxes' on my list with high priority"
- "Enqueue a task to review the PR"

LOW confidence examples (this agent should NOT win):
- "What's on my list?"            (read, calendar-query-agent or future task-list-agent)
- "Remove the oven reminder"      (delete)
- "When is my next meeting?"      (calendar-query-agent)
- "Mark the PR task done"         (update, not add)

The agent uses the 'standard' AI profile to extract structured fields
(name, due_at_iso, priority, is_alarm, notes) from the utterance. If the
name can't be inferred it emits needsInput for a multi-turn follow-up.`,

  async execute(task) {
    const query = String(task?.content || task?.text || task?.query || '').trim();
    const context = task?.context || {};

    // Multi-turn continuation: the previous turn asked for a name.
    if (context.taskState === 'awaiting_name') {
      const name = query || '';
      if (!name) {
        return { success: false, message: 'No task name provided, cancelled.' };
      }
      const pending = context.pendingTask || {};
      return await this._createFrom({ ...pending, name }, new Date());
    }

    if (!query) {
      return { success: false, message: 'What task or alarm would you like to add?' };
    }

    const now = new Date();
    const extract = _extractor || extractTaskDetails;
    const details = await extract(query, now);

    if (!details.name || !String(details.name).trim()) {
      return {
        success: true,
        needsInput: {
          prompt: 'What should I call this task?',
          agentId: this.id,
          context: { taskState: 'awaiting_name', pendingTask: details },
        },
      };
    }

    return await this._createFrom(details, now);
  },

  /**
   * Internal: given fully-resolved details, create the TaskItem and format
   * a spoken confirmation. Extracted so the needsInput continuation path
   * and the one-shot path share the same write logic.
   * @private
   */
  async _createFrom(details, now) {
    const priority = _priorityToInt(details.priority);
    const fireAtMs = _parseFireAtMs(details.due_at_iso);
    const isAlarm = !!(details.is_alarm || fireAtMs);

    try {
      const created = await _addTaskItem({
        queueId: DEFAULT_QUEUE_ID,
        name: String(details.name).trim(),
        priority,
        fireAtMs: Number.isFinite(fireAtMs) ? fireAtMs : undefined,
        notes: details.notes || undefined,
      });

      if (!created) {
        return {
          success: false,
          message: 'I could not add that to the queue right now.',
        };
      }

      const kind = isAlarm ? 'alarm' : 'task';
      const when = _formatRelativeWhen(fireAtMs, now.getTime());
      const prioritySuffix = priority >= PRIORITY_MAP.high ? `, priority ${details.priority || 'high'}` : '';
      return {
        success: true,
        message: `Added ${kind}: ${created.name}${when}${prioritySuffix}.`,
        data: { task: created },
      };
    } catch (err) {
      log.warn('task-queue-agent', 'addTaskItem failed', { error: err.message });
      return { success: false, message: `I could not add that: ${err.message}` };
    }
  },

  // Test hooks
  _setAddTaskItemForTests,
  _setExtractorForTests,
  _priorityToInt,
  _parseFireAtMs,
  _extractTaskDetails: extractTaskDetails,
};

module.exports = taskQueueAgent;
