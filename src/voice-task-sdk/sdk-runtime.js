/**
 * Voice Task SDK - JavaScript Runtime
 * 
 * Complete task queuing system with:
 * - Named queues with concurrency control
 * - Priority-based task ordering
 * - Agent registry for task execution
 * - Dispatcher for queue processing
 * - Event system for task lifecycle
 */

const crypto = require('crypto');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

// ============================================================================
// QUEUE MANAGER
// ============================================================================

function createQueueManager() {
  const queues = new Map();
  const nameToId = new Map();

  function generateId() {
    return crypto.randomUUID();
  }

  function create(input) {
    if (!input.name || typeof input.name !== 'string') {
      throw new Error('Queue name is required and must be a string');
    }
    if (typeof input.concurrency !== 'number' || input.concurrency < 1) {
      throw new Error('Queue concurrency must be a positive integer');
    }

    if (nameToId.has(input.name)) {
      throw new Error(`Queue with name "${input.name}" already exists`);
    }

    const queue = {
      id: generateId(),
      name: input.name.trim(),
      concurrency: Math.floor(input.concurrency),
      maxSize: input.maxSize ? Math.floor(input.maxSize) : undefined,
      overflow: input.overflow || 'error',
      paused: false,
      runningCount: 0,
      createdAt: Date.now(),
    };

    queues.set(queue.id, {
      queue,
      tasks: [],
      completedCount: 0,
      failedCount: 0,
    });
    nameToId.set(input.name, queue.id);

    return queue;
  }

  function read(name) {
    const id = nameToId.get(name);
    if (!id) return undefined;
    return queues.get(id)?.queue;
  }

  function deleteQueue(name) {
    const id = nameToId.get(name);
    if (!id) return false;

    const state = queues.get(id);
    if (state && state.queue.runningCount > 0) {
      throw new Error(`Cannot delete queue "${name}" with running tasks`);
    }

    nameToId.delete(name);
    return queues.delete(id);
  }

  function list() {
    return Array.from(queues.values()).map(s => s.queue);
  }

  function pause(name) {
    const id = nameToId.get(name);
    if (!id) return false;
    const state = queues.get(id);
    if (!state) return false;
    state.queue = { ...state.queue, paused: true };
    return true;
  }

  function resume(name) {
    const id = nameToId.get(name);
    if (!id) return false;
    const state = queues.get(id);
    if (!state) return false;
    state.queue = { ...state.queue, paused: false };
    return true;
  }

  function clear(name) {
    const id = nameToId.get(name);
    if (!id) return false;
    const state = queues.get(id);
    if (!state) return false;
    state.tasks = [];
    return true;
  }

  function getStats(name) {
    const id = nameToId.get(name);
    if (!id) return undefined;
    const state = queues.get(id);
    if (!state) return undefined;

    return {
      pending: state.tasks.length,
      running: state.queue.runningCount,
      completed: state.completedCount,
      failed: state.failedCount,
    };
  }

  function enqueue(queueName, task) {
    const id = nameToId.get(queueName);
    if (!id) {
      return { success: false, reason: `Queue "${queueName}" does not exist` };
    }

    const state = queues.get(id);
    if (!state) {
      return { success: false, reason: `Queue "${queueName}" not found` };
    }

    // Check if queue is at max capacity
    if (state.queue.maxSize !== undefined && state.tasks.length >= state.queue.maxSize) {
      switch (state.queue.overflow) {
        case 'drop':
          return { success: false, reason: 'dropped' };
        case 'deadletter':
          return { success: false, reason: 'deadletter' };
        case 'error':
        default:
          return { success: false, reason: `Queue "${queueName}" is full` };
      }
    }

    // Insert by priority (higher priority = earlier in queue)
    const insertIndex = state.tasks.findIndex(t => t.priority < task.priority);
    if (insertIndex === -1) {
      state.tasks.push(task);
    } else {
      state.tasks.splice(insertIndex, 0, task);
    }

    return { success: true };
  }

  function dequeue(queueName) {
    const id = nameToId.get(queueName);
    if (!id) return undefined;
    const state = queues.get(id);
    if (!state) return undefined;
    if (state.queue.paused) return undefined;
    if (state.queue.runningCount >= state.queue.concurrency) return undefined;
    return state.tasks.shift();
  }

  function peek(queueName) {
    const id = nameToId.get(queueName);
    if (!id) return undefined;
    const state = queues.get(id);
    if (!state) return undefined;
    return state.tasks[0];
  }

  function getTasks(queueName) {
    const id = nameToId.get(queueName);
    if (!id) return [];
    const state = queues.get(id);
    if (!state) return [];
    return [...state.tasks];
  }

  function incrementRunning(queueName) {
    const id = nameToId.get(queueName);
    if (!id) return;
    const state = queues.get(id);
    if (!state) return;
    state.queue = { ...state.queue, runningCount: state.queue.runningCount + 1 };
  }

  function decrementRunning(queueName) {
    const id = nameToId.get(queueName);
    if (!id) return;
    const state = queues.get(id);
    if (!state) return;
    state.queue = { ...state.queue, runningCount: Math.max(0, state.queue.runningCount - 1) };
  }

  function incrementCompleted(queueName) {
    const id = nameToId.get(queueName);
    if (!id) return;
    const state = queues.get(id);
    if (state) state.completedCount++;
  }

  function incrementFailed(queueName) {
    const id = nameToId.get(queueName);
    if (!id) return;
    const state = queues.get(id);
    if (state) state.failedCount++;
  }

  return {
    create,
    read,
    delete: deleteQueue,
    list,
    pause,
    resume,
    clear,
    getStats,
    enqueue,
    dequeue,
    peek,
    getTasks,
    incrementRunning,
    decrementRunning,
    incrementCompleted,
    incrementFailed,
  };
}

// ============================================================================
// TASK STORE
// ============================================================================

function createTaskStore() {
  const tasks = new Map();

  function generateId() {
    return crypto.randomUUID();
  }

  function create(classified, queue) {
    const task = {
      id: generateId(),
      action: classified.action,
      content: classified.content,
      params: classified.params || {},
      priority: classified.priority || 2,
      status: 'pending',
      queue,
      createdAt: Date.now(),
      attempt: 0,
      maxAttempts: 1,
    };

    tasks.set(task.id, task);
    return task;
  }

  function read(id) {
    return tasks.get(id);
  }

  function update(id, updates) {
    const existing = tasks.get(id);
    if (!existing) return undefined;

    const updated = {
      ...existing,
      ...updates,
      id: existing.id,
    };

    tasks.set(id, updated);
    return updated;
  }

  function deleteTask(id) {
    return tasks.delete(id);
  }

  function list(filter) {
    let result = Array.from(tasks.values());

    if (filter) {
      if (filter.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
        result = result.filter(t => statuses.includes(t.status));
      }
      if (filter.queue) {
        result = result.filter(t => t.queue === filter.queue);
      }
      if (filter.action) {
        result = result.filter(t => t.action === filter.action);
      }
      if (filter.limit) {
        result = result.slice(0, filter.limit);
      }
    }

    result.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return a.createdAt - b.createdAt;
    });

    return result;
  }

  function start(id, agentId) {
    const task = tasks.get(id);
    if (!task) return undefined;
    if (task.status !== 'pending') return undefined;

    const updated = {
      ...task,
      status: 'running',
      assignedAgent: agentId,
      startedAt: Date.now(),
      attempt: task.attempt + 1,
    };

    tasks.set(id, updated);
    return updated;
  }

  function complete(id, result) {
    const task = tasks.get(id);
    if (!task) return undefined;
    if (task.status !== 'running') return undefined;

    const updated = {
      ...task,
      status: 'completed',
      completedAt: Date.now(),
      result,
    };

    tasks.set(id, updated);
    return updated;
  }

  function fail(id, error) {
    const task = tasks.get(id);
    if (!task) return undefined;
    if (task.status !== 'running') return undefined;

    const updated = {
      ...task,
      status: 'failed',
      completedAt: Date.now(),
      lastError: error,
      error,
    };

    tasks.set(id, updated);
    return updated;
  }

  function cancel(id) {
    const task = tasks.get(id);
    if (!task) return undefined;
    if (task.status !== 'pending' && task.status !== 'running') {
      return undefined;
    }

    const updated = {
      ...task,
      status: 'cancelled',
      completedAt: Date.now(),
    };

    tasks.set(id, updated);
    return updated;
  }

  function markDeadletter(id, reason) {
    const task = tasks.get(id);
    if (!task) return undefined;

    const updated = {
      ...task,
      status: 'deadletter',
      completedAt: Date.now(),
      lastError: reason,
    };

    tasks.set(id, updated);
    return updated;
  }

  function prepareRetry(id) {
    const task = tasks.get(id);
    if (!task) return undefined;
    if (task.status !== 'failed') return undefined;
    if (task.attempt >= task.maxAttempts) return undefined;

    const updated = {
      ...task,
      status: 'pending',
      assignedAgent: undefined,
      startedAt: undefined,
      completedAt: undefined,
      error: undefined,
      result: undefined,
    };

    tasks.set(id, updated);
    return updated;
  }

  function clearCompleted() {
    let count = 0;
    for (const [id, task] of tasks) {
      if (task.status === 'completed' || task.status === 'cancelled') {
        tasks.delete(id);
        count++;
      }
    }
    return count;
  }

  return {
    create,
    read,
    update,
    delete: deleteTask,
    list,
    start,
    complete,
    fail,
    cancel,
    markDeadletter,
    prepareRetry,
    clearCompleted,
  };
}

// ============================================================================
// AGENT REGISTRY
// ============================================================================

function createAgentRegistry() {
  const agents = new Map();
  const nameToId = new Map();

  function generateId() {
    return crypto.randomUUID();
  }

  function create(input) {
    if (!input.name || typeof input.name !== 'string') {
      throw new Error('Agent name is required');
    }
    if (typeof input.resolve !== 'function') {
      throw new Error('Agent resolve function is required');
    }
    if (!input.queues?.length && !input.actions?.length) {
      throw new Error('Agent must subscribe to at least one queue or action');
    }

    if (nameToId.has(input.name)) {
      throw new Error(`Agent with name "${input.name}" already exists`);
    }

    const now = Date.now();
    const agent = {
      id: generateId(),
      name: input.name.trim(),
      queues: input.queues || [],
      actions: input.actions || [],
      resolve: input.resolve,
      canHandle: input.canHandle,
      priority: input.priority || 0,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    agents.set(agent.id, agent);
    nameToId.set(agent.name, agent.id);

    return agent;
  }

  function read(id) {
    return agents.get(id);
  }

  function readByName(name) {
    const id = nameToId.get(name);
    if (!id) return undefined;
    return agents.get(id);
  }

  function deleteAgent(id) {
    const agent = agents.get(id);
    if (!agent) return false;
    nameToId.delete(agent.name);
    return agents.delete(id);
  }

  function list(enabledOnly = false) {
    const all = Array.from(agents.values());
    if (enabledOnly) {
      return all.filter(a => a.enabled);
    }
    return all;
  }

  function enable(id) {
    const agent = agents.get(id);
    if (!agent) return false;
    agents.set(id, { ...agent, enabled: true, updatedAt: Date.now() });
    return true;
  }

  function disable(id) {
    const agent = agents.get(id);
    if (!agent) return false;
    agents.set(id, { ...agent, enabled: false, updatedAt: Date.now() });
    return true;
  }

  function findForTask(task) {
    return Array.from(agents.values())
      .filter(agent => {
        if (!agent.enabled) return false;
        const matchesQueue = agent.queues?.includes(task.queue);
        const matchesAction = agent.actions?.includes(task.action);
        if (!matchesQueue && !matchesAction) return false;
        if (agent.canHandle && !agent.canHandle(task)) return false;
        return true;
      })
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  return {
    create,
    read,
    readByName,
    delete: deleteAgent,
    list,
    enable,
    disable,
    findForTask,
  };
}

// ============================================================================
// ROUTER
// ============================================================================

function createRouter() {
  const rules = new Map();
  let defaultQueue = null;

  function generateId() {
    return crypto.randomUUID();
  }

  function addRule(input) {
    if (!input.target || typeof input.target !== 'string') {
      throw new Error('Routing rule target queue is required');
    }
    if (!input.match || typeof input.match !== 'object') {
      throw new Error('Routing rule match criteria is required');
    }

    const id = input.id || generateId();
    if (rules.has(id)) {
      throw new Error(`Rule with id "${id}" already exists`);
    }

    const rule = {
      id,
      match: input.match,
      target: input.target.trim(),
      priority: input.priority || 0,
    };

    rules.set(id, rule);
    return rule;
  }

  function removeRule(id) {
    return rules.delete(id);
  }

  function listRules() {
    return Array.from(rules.values())
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  function route(task) {
    const sortedRules = listRules();

    for (const rule of sortedRules) {
      const { match } = rule;

      // Check exact action match
      if (match.action) {
        const actions = Array.isArray(match.action) ? match.action : [match.action];
        if (actions.includes(task.action)) {
          return rule.target;
        }
      }

      // Check pattern match
      if (match.pattern && match.pattern.test(task.action)) {
        return rule.target;
      }

      // Check custom condition
      if (match.condition && match.condition(task)) {
        return rule.target;
      }
    }

    return defaultQueue;
  }

  function setDefaultQueue(queueName) {
    defaultQueue = queueName;
  }

  function getDefaultQueue() {
    return defaultQueue;
  }

  return {
    addRule,
    removeRule,
    listRules,
    route,
    setDefaultQueue,
    getDefaultQueue,
  };
}

// ============================================================================
// DISPATCHER
// ============================================================================

function createDispatcher(deps, config = {}) {
  const {
    queueManager,
    agentRegistry,
    taskStore,
    router,
    getContext,
  } = deps;

  const {
    pollIntervalMs = 100,
    defaultTimeoutMs = 30000,
  } = config;

  let running = false;
  let pollTimer = null;
  const runningTasks = new Map();
  const eventHandlers = new Map();

  function emit(event, task, data) {
    const handlers = eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(task, data);
        } catch (error) {
          log.error('voice', '[Dispatcher] Event handler error for :', { v0: event, arg0: error });
        }
      }
    }
  }

  function on(event, handler) {
    if (!eventHandlers.has(event)) {
      eventHandlers.set(event, new Set());
    }
    eventHandlers.get(event).add(handler);
    return () => off(event, handler);
  }

  function off(event, handler) {
    eventHandlers.get(event)?.delete(handler);
  }

  async function dispatch(classified, ctx) {
    // Route to queue
    const queueName = router.route(classified);
    if (!queueName) {
      log.warn('voice', '[Dispatcher] No route found for task', { data: classified.action });
      return null;
    }

    // Create task
    const task = taskStore.create(classified, queueName);

    // Enqueue
    const enqueueResult = queueManager.enqueue(queueName, task);
    if (!enqueueResult.success) {
      if (enqueueResult.reason === 'deadletter') {
        taskStore.markDeadletter(task.id, 'Queue overflow');
        emit('task:deadletter', taskStore.read(task.id), 'Queue overflow');
      } else {
        taskStore.markDeadletter(task.id, enqueueResult.reason || 'Enqueue failed');
        emit('task:deadletter', taskStore.read(task.id), enqueueResult.reason);
      }
      return taskStore.read(task.id);
    }

    emit('task:queued', task);
    log.info('voice', '[Dispatcher] Task queued: ->', { v0: task.id, v1: queueName });

    // Trigger immediate processing if running
    if (running) {
      setImmediate(() => processQueues());
    }

    return taskStore.read(task.id);
  }

  async function processQueues() {
    const queues = queueManager.list();

    for (const queue of queues) {
      if (queue.paused) continue;

      // Process tasks up to concurrency
      while (true) {
        const task = queueManager.dequeue(queue.name);
        if (!task) break;

        queueManager.incrementRunning(queue.name);
        processTask(task).catch(error => {
          log.error('voice', '[Dispatcher] Error processing task', { error: error });
        });
      }
    }
  }

  async function processTask(task) {
    const ctx = getContext();

    // Find agent
    const agents = agentRegistry.findForTask(task);
    if (agents.length === 0) {
      emit('task:no-agent', task);
      taskStore.markDeadletter(task.id, 'No agent available');
      emit('task:deadletter', taskStore.read(task.id), 'No agent available');
      queueManager.decrementRunning(task.queue);
      queueManager.incrementFailed(task.queue);
      return;
    }

    const agent = agents[0];

    // Start execution
    const startedTask = taskStore.start(task.id, agent.id);
    if (!startedTask) {
      log.error('voice', '[Dispatcher] Failed to start task', { error: task.id });
      queueManager.decrementRunning(task.queue);
      return;
    }

    emit('task:started', startedTask);
    log.info('voice', '[Dispatcher] Task started: by agent', { v0: task.id, v1: agent.name });

    // Setup abort controller and timeout
    const abortController = new AbortController();
    let timeoutId;

    if (defaultTimeoutMs > 0) {
      timeoutId = setTimeout(() => {
        abortController.abort(new Error('Task timeout'));
      }, defaultTimeoutMs);
    }

    runningTasks.set(task.id, { task: startedTask, abortController, timeoutId });

    try {
      const execCtx = {
        signal: abortController.signal,
        appContext: ctx,
        attempt: startedTask.attempt,
      };

      const result = await agent.resolve(startedTask, execCtx);

      if (timeoutId) clearTimeout(timeoutId);
      runningTasks.delete(task.id);

      const completedTask = taskStore.complete(task.id, result);
      if (completedTask) {
        emit('task:completed', completedTask, result);
        queueManager.incrementCompleted(task.queue);
        log.info('voice', '[Dispatcher] Task completed:', { v0: task.id });
      }

    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId);
      runningTasks.delete(task.id);

      const errorMessage = error instanceof Error ? error.message : String(error);
      const failedTask = taskStore.fail(task.id, errorMessage);
      
      if (failedTask) {
        emit('task:failed', failedTask, error);
        queueManager.incrementFailed(task.queue);
        log.info('voice', '[Dispatcher] Task failed: -', { v0: task.id, v1: errorMessage });

        // Check for retry
        if (failedTask.attempt < failedTask.maxAttempts) {
          setTimeout(() => {
            const retriedTask = taskStore.prepareRetry(task.id);
            if (retriedTask) {
              emit('task:retry', retriedTask, { attempt: retriedTask.attempt + 1 });
              queueManager.enqueue(task.queue, retriedTask);
            }
          }, 1000);
        } else {
          taskStore.markDeadletter(task.id, `Max retries exceeded: ${errorMessage}`);
          emit('task:deadletter', taskStore.read(task.id), errorMessage);
        }
      }
    } finally {
      queueManager.decrementRunning(task.queue);
    }
  }

  function cancelTask(taskId) {
    const runningTask = runningTasks.get(taskId);
    if (runningTask) {
      if (runningTask.timeoutId) clearTimeout(runningTask.timeoutId);
      runningTask.abortController.abort(new Error('Task cancelled'));
      runningTasks.delete(taskId);
    }

    const task = taskStore.cancel(taskId);
    if (task) {
      emit('task:cancelled', task);
      return true;
    }
    return false;
  }

  function start() {
    if (running) return;
    running = true;

    processQueues();
    pollTimer = setInterval(() => processQueues(), pollIntervalMs);
    log.info('voice', '[Dispatcher] Started');
  }

  function stop() {
    if (!running) return;
    running = false;

    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    // Cancel all running tasks
    for (const [taskId, { abortController, timeoutId }] of runningTasks) {
      if (timeoutId) clearTimeout(timeoutId);
      abortController.abort(new Error('Dispatcher stopped'));
      taskStore.cancel(taskId);
    }
    runningTasks.clear();
    log.info('voice', '[Dispatcher] Stopped');
  }

  function isRunning() {
    return running;
  }

  return {
    start,
    stop,
    isRunning,
    dispatch,
    cancelTask,
    on,
    off,
  };
}

// ============================================================================
// SDK FACTORY
// ============================================================================

function createVoiceTaskSDK(config = {}) {
  const queueManager = createQueueManager();
  const taskStore = createTaskStore();
  const agentRegistry = createAgentRegistry();
  const router = createRouter();

  let appContext = {
    metadata: {},
  };

  const dispatcher = createDispatcher({
    queueManager,
    agentRegistry,
    taskStore,
    router,
    getContext: () => appContext,
  }, {
    pollIntervalMs: config.pollIntervalMs || 100,
    defaultTimeoutMs: config.defaultTimeoutMs || 30000,
  });

  // Event handling
  const eventHandlers = new Map();

  function emit(event, data) {
    const handlers = eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (error) {
          log.error('voice', '[SDK] Event handler error for :', { v0: event, arg0: error });
        }
      }
    }
  }

  // Wire up dispatcher events
  dispatcher.on('task:queued', (task) => emit('queued', task));
  dispatcher.on('task:started', (task) => emit('started', task));
  dispatcher.on('task:completed', (task, result) => {
    emit('completed', { task, result });
    appContext = { ...appContext, lastTask: task };
  });
  dispatcher.on('task:failed', (task, error) => emit('failed', { task, error }));
  dispatcher.on('task:retry', (task, data) => emit('retry', { task, ...data }));
  dispatcher.on('task:deadletter', (task, reason) => emit('deadletter', { task, reason }));
  dispatcher.on('task:cancelled', (task) => emit('cancelled', task));

  // Create default queue if specified
  if (config.defaultQueue) {
    try {
      queueManager.create({
        name: config.defaultQueue,
        concurrency: config.defaultConcurrency || 3,
        maxSize: config.maxQueueSize,
        overflow: config.overflow || 'error',
      });
      router.setDefaultQueue(config.defaultQueue);
      log.info('voice', '[SDK] Created default queue:', { v0: config.defaultQueue });
    } catch (e) {
      // Queue might already exist
    }
  }

  const sdk = {
    // Queue management
    queues: {
      create: (input) => {
        const queue = queueManager.create(input);
        emit('queue:created', queue);
        return queue;
      },
      read: (name) => queueManager.read(name),
      delete: (name) => queueManager.delete(name),
      list: () => queueManager.list(),
      pause: (name) => {
        queueManager.pause(name);
        emit('queue:paused', { name });
      },
      resume: (name) => {
        queueManager.resume(name);
        emit('queue:resumed', { name });
      },
      clear: (name) => queueManager.clear(name),
      getStats: (name) => queueManager.getStats(name),
      getTasks: (name) => queueManager.getTasks(name),
    },

    // Agent management
    agents: {
      create: (input) => {
        const agent = agentRegistry.create(input);
        emit('agent:registered', agent);
        return agent;
      },
      read: (id) => agentRegistry.read(id),
      readByName: (name) => agentRegistry.readByName(name),
      delete: (id) => {
        const result = agentRegistry.delete(id);
        if (result) emit('agent:removed', { id });
        return result;
      },
      list: (enabledOnly) => agentRegistry.list(enabledOnly),
      enable: (id) => agentRegistry.enable(id),
      disable: (id) => agentRegistry.disable(id),
    },

    // Router
    router: {
      addRule: (rule) => router.addRule(rule),
      removeRule: (id) => router.removeRule(id),
      listRules: () => router.listRules(),
      route: (task) => router.route(task),
      setDefaultQueue: (name) => router.setDefaultQueue(name),
      getDefaultQueue: () => router.getDefaultQueue(),
    },

    // Task operations
    tasks: {
      list: (filter) => taskStore.list(filter),
      get: (id) => taskStore.read(id),
      cancel: (id) => dispatcher.cancelTask(id),
      clearCompleted: () => taskStore.clearCompleted(),
    },

    // Context
    setContext: (ctx) => { appContext = { ...ctx }; },
    updateContext: (ctx) => { appContext = { ...appContext, ...ctx }; },
    getContext: () => ({ ...appContext }),

    // Events
    on: (event, handler) => {
      if (!eventHandlers.has(event)) {
        eventHandlers.set(event, new Set());
      }
      eventHandlers.get(event).add(handler);
      return () => sdk.off(event, handler);
    },
    off: (event, handler) => {
      eventHandlers.get(event)?.delete(handler);
    },

    // Control
    start: () => dispatcher.start(),
    stop: () => dispatcher.stop(),
    isRunning: () => dispatcher.isRunning(),

    // Submit a task
    submit: async (classified) => {
      return dispatcher.dispatch(classified, appContext);
    },

    // Cancel a task
    cancelTask: (id) => dispatcher.cancelTask(id),
  };

  return sdk;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  createVoiceTaskSDK,
  createQueueManager,
  createTaskStore,
  createAgentRegistry,
  createRouter,
  createDispatcher,
};
