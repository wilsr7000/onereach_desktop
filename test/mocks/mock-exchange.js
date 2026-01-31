/**
 * MockExchange - Simulates the Exchange for deterministic testing
 * 
 * This mock implements the Exchange interface without real WebSockets,
 * allowing tests to run fast and deterministically without LLM calls.
 */

class MockExchange {
  constructor(options = {}) {
    this.options = {
      auctionDelayMs: options.auctionDelayMs || 10,
      executionDelayMs: options.executionDelayMs || 10,
      ...options
    };
    
    this.submittedTasks = [];
    this.registeredAgents = new Map();
    this.eventHandlers = {};
    this.isRunning = false;
    this.taskIdCounter = 0;
    this.auctionResults = new Map(); // taskId -> { winner, bids }
  }
  
  /**
   * Start the mock exchange
   */
  async start() {
    this.isRunning = true;
    this.emit('exchange:started', { port: 0 });
    return Promise.resolve();
  }
  
  /**
   * Stop the mock exchange
   */
  async shutdown() {
    this.isRunning = false;
    this.emit('exchange:shutdown_complete', {});
    return Promise.resolve();
  }
  
  /**
   * Submit a task - triggers auction
   */
  async submit(params) {
    if (!this.isRunning) {
      throw new Error('Exchange is not running');
    }
    
    const taskId = `task-${++this.taskIdCounter}`;
    const task = {
      id: taskId,
      content: params.content,
      priority: params.priority || 2,
      metadata: params.metadata || {},
      status: 'PENDING',
      createdAt: Date.now(),
    };
    
    this.submittedTasks.push(task);
    this.emit('task:queued', { task });
    
    // Run auction asynchronously
    setTimeout(() => this.runAuction(task), this.options.auctionDelayMs);
    
    return { taskId, task };
  }
  
  /**
   * Run auction - collect bids from all registered agents
   */
  async runAuction(task) {
    task.status = 'OPEN';
    this.emit('auction:started', { task, auctionId: `auction-${task.id}` });
    
    // Collect bids from all agents
    const bids = [];
    for (const [agentId, agent] of this.registeredAgents) {
      if (agent.bidFn) {
        try {
          const bid = await agent.bidFn(task);
          if (bid && bid.confidence > 0.1) {
            bids.push({
              agentId,
              confidence: bid.confidence,
              reasoning: bid.reasoning || bid.plan || 'Mock bid',
              tier: bid.tier || 'mock',
            });
          }
        } catch (e) {
          console.warn(`[MockExchange] Agent ${agentId} bid error:`, e.message);
        }
      }
    }
    
    this.emit('auction:closed', { task, bids });
    
    // No bids - halt
    if (bids.length === 0) {
      task.status = 'HALTED';
      this.emit('exchange:halt', { task, reason: 'No bids received' });
      return;
    }
    
    // Pick winner (highest confidence)
    bids.sort((a, b) => b.confidence - a.confidence);
    const winner = bids[0];
    const backups = bids.slice(1);
    
    this.auctionResults.set(task.id, { winner, bids });
    
    task.status = 'ASSIGNED';
    task.assignedAgent = winner.agentId;
    this.emit('task:assigned', { task, winner, backups });
    
    // Execute
    await this.executeTask(task, winner);
  }
  
  /**
   * Execute task with winning agent
   */
  async executeTask(task, winner) {
    const agent = this.registeredAgents.get(winner.agentId);
    if (!agent) {
      task.status = 'DEAD_LETTER';
      this.emit('task:dead_letter', { task, reason: 'Winner agent not found' });
      return;
    }
    
    this.emit('task:executing', { task, agentId: winner.agentId });
    
    try {
      // Add small delay to simulate execution
      await new Promise(r => setTimeout(r, this.options.executionDelayMs));
      
      let execResult;
      if (agent.executeFn) {
        execResult = await agent.executeFn(task);
      } else {
        execResult = { success: true, message: `Mock execution by ${winner.agentId}` };
      }
      
      // Normalize result format (agents return message, exchange expects output)
      const result = {
        success: execResult.success,
        output: execResult.message || execResult.output,
        data: execResult.data,
        error: execResult.error,
      };
      
      task.status = 'SETTLED';
      task.result = result;
      this.emit('task:settled', { task, result, agentId: winner.agentId });
    } catch (error) {
      task.status = 'BUSTED';
      task.error = error.message;
      this.emit('task:busted', { 
        task, 
        agentId: winner.agentId, 
        error: error.message,
        backupsRemaining: 0 
      });
      
      // For simplicity, go straight to dead letter
      task.status = 'DEAD_LETTER';
      this.emit('task:dead_letter', { task, reason: error.message });
    }
  }
  
  /**
   * Register an agent
   */
  registerAgent(id, config) {
    this.registeredAgents.set(id, {
      id,
      bidFn: config.bidFn,
      executeFn: config.executeFn,
      keywords: config.keywords || [],
      capabilities: config.capabilities || [],
    });
    
    this.emit('agent:connected', { agent: { id, name: config.name || id } });
  }
  
  /**
   * Unregister an agent
   */
  unregisterAgent(id) {
    if (this.registeredAgents.has(id)) {
      this.registeredAgents.delete(id);
      this.emit('agent:disconnected', { agentId: id, reason: 'unregistered' });
    }
  }
  
  /**
   * Cancel a task
   */
  cancelTask(taskId) {
    const task = this.submittedTasks.find(t => t.id === taskId);
    if (task && task.status !== 'SETTLED' && task.status !== 'DEAD_LETTER') {
      task.status = 'CANCELLED';
      this.emit('task:cancelled', { task, reason: 'user_request' });
      return true;
    }
    return false;
  }
  
  /**
   * Get task by ID
   */
  getTask(taskId) {
    return this.submittedTasks.find(t => t.id === taskId) || null;
  }
  
  /**
   * Get queue stats
   */
  getQueueStats() {
    return {
      depth: { total: this.submittedTasks.filter(t => t.status === 'PENDING').length },
      activeAuctions: 0,
    };
  }
  
  /**
   * Event handling
   */
  on(event, handler) {
    if (!this.eventHandlers[event]) {
      this.eventHandlers[event] = [];
    }
    this.eventHandlers[event].push(handler);
    return this;
  }
  
  off(event, handler) {
    if (this.eventHandlers[event]) {
      this.eventHandlers[event] = this.eventHandlers[event].filter(h => h !== handler);
    }
    return this;
  }
  
  emit(event, data) {
    const handlers = this.eventHandlers[event] || [];
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (e) {
        console.error(`[MockExchange] Event handler error for ${event}:`, e);
      }
    }
  }
  
  /**
   * Get registered agents (for assertions)
   */
  get agents() {
    return {
      getAll: () => Array.from(this.registeredAgents.values()),
      getCount: () => this.registeredAgents.size,
    };
  }
  
  /**
   * Clear all state (for test isolation)
   */
  reset() {
    this.submittedTasks = [];
    this.registeredAgents.clear();
    this.auctionResults.clear();
    this.taskIdCounter = 0;
  }
}

module.exports = { MockExchange };
