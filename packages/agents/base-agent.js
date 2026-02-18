/**
 * BaseAgent -- optional base class for built-in agents.
 *
 * Provides:
 * - Consistent `{ success, message }` return format (never `error`)
 * - Automatic try/catch with structured logging around execute()
 * - Memory loading/saving lifecycle (when `memory` config is provided)
 * - Standard initialize() / cleanup() hooks
 *
 * Existing agents remain plain objects and are fully backward-compatible.
 * New agents can use `BaseAgent.create(config)` to get the defaults
 * without changing the registry contract.
 *
 * Usage:
 *   const BaseAgent = require('./base-agent');
 *
 *   module.exports = BaseAgent.create({
 *     id: 'my-agent',
 *     name: 'My Agent',
 *     description: 'Does things',
 *     categories: ['general'],
 *     keywords: ['thing'],
 *     executionType: 'informational',
 *
 *     // Optional: auto-managed memory
 *     memoryConfig: { displayName: 'My Agent' },
 *
 *     // Your implementation -- throw freely, BaseAgent catches
 *     async onExecute(task, { memory, log }) {
 *       const answer = await someWork(task.input);
 *       return { success: true, message: answer };
 *     },
 *
 *     // Optional lifecycle hooks
 *     async onInitialize({ memory, log }) { },
 *     onCleanup() { },
 *   });
 */

const { getLogQueue } = require('../../lib/log-event-queue');

/**
 * Create an agent with BaseAgent defaults baked in.
 *
 * @param {object} config
 * @param {string} config.id
 * @param {string} config.name
 * @param {string} config.description
 * @param {string[]} config.categories
 * @param {string[]} config.keywords
 * @param {Function} config.onExecute - `(task, ctx) => { success, message }`
 * @param {object}  [config.memoryConfig] - If set, auto-initializes agent memory
 * @param {Function} [config.onInitialize] - `(ctx) => void`
 * @param {Function} [config.onCleanup] - `() => void`
 * @returns {object} A plain agent object compatible with agent-registry
 */
function create(config) {
  const { id, name, description, categories, keywords, onExecute, memoryConfig, onInitialize, onCleanup, ...rest } =
    config;

  if (!id) throw new Error('BaseAgent.create: id is required');
  if (!onExecute) throw new Error('BaseAgent.create: onExecute is required');

  const log = getLogQueue();
  let memory = null;

  const agent = {
    id,
    name,
    description,
    categories,
    keywords,
    ...rest,

    /**
     * Initialize -- loads memory (if configured) then calls onInitialize.
     */
    async initialize() {
      try {
        if (memoryConfig && !memory) {
          const { getAgentMemory } = require('../../lib/agent-memory-store');
          memory = getAgentMemory(id, memoryConfig);
          await memory.load();
        }
        if (onInitialize) {
          await onInitialize({ memory, log });
        }
      } catch (err) {
        log.warn('agent', `${name} initialize failed`, { error: err.message });
      }
    },

    /**
     * Cleanup -- calls onCleanup.
     */
    cleanup() {
      try {
        if (onCleanup) onCleanup();
      } catch (err) {
        log.warn('agent', `${name} cleanup failed`, { error: err.message });
      }
    },

    /**
     * Execute with guaranteed error handling and response normalization.
     * - Never throws (catches and returns `{ success: false, message }`)
     * - Normalizes `error` key to `message` if the implementation returns one
     * - Logs failures with structured context
     *
     * @param {object} task
     * @returns {Promise<{ success: boolean, message: string, [key: string]: any }>}
     */
    async execute(task) {
      try {
        const result = await onExecute(task, { memory, log });

        // Normalize: ensure `message` is always present
        if (result && typeof result === 'object') {
          if (!result.message && result.error) {
            result.message = result.error;
            delete result.error;
          }
          if (result.message === undefined) {
            result.message = result.success ? 'Done' : 'Something went wrong';
          }
          return result;
        }

        // If onExecute returned a bare string, wrap it
        if (typeof result === 'string') {
          return { success: true, message: result };
        }

        return { success: true, message: 'Done' };
      } catch (err) {
        log.error('agent', `${name} execute failed`, {
          error: err.message,
          taskInput: task?.input?.substring?.(0, 100),
        });
        return {
          success: false,
          message: `I ran into a problem: ${err.message}`,
        };
      }
    },
  };

  // Expose memory getter for tests / advanced usage
  Object.defineProperty(agent, 'memory', {
    get() {
      return memory;
    },
    set(v) {
      memory = v;
    },
    enumerable: true,
    configurable: true,
  });

  return agent;
}

module.exports = { create };
