/**
 * Exchange - Main auction orchestrator
 */
import { randomUUID } from 'crypto';
import type {
  Task,
  TaskStatus,
  TaskResult,
  ExchangeConfig,
  ExchangeEvents,
  EvaluatedBid,
  BidRequest,
  BidResponse,
  TaskAssignment,
  TaskResultMessage,
  AuctionConfig,
} from '../types/index.js';
import { TaskStatus as Status, TaskPriority, PROTOCOL_VERSION } from '../types/index.js';
import { TypedEventEmitter } from '../utils/events.js';
import { OrderBook } from './order-book.js';
import { CategoryIndex } from './categories.js';
import { AgentRegistry } from './agent-registry.js';
import { ReputationStore } from '../reputation/store.js';
import { PriorityQueue } from '../queue/priority-queue.js';
import { RateLimiter } from '../queue/rate-limiter.js';
import type { StorageAdapter } from '../storage/adapter.js';

const DEFAULT_AUCTION_CONFIG: AuctionConfig = {
  defaultWindowMs: 1000,
  minWindowMs: 100,
  maxWindowMs: 5000,
  instantWinThreshold: 0.85,
  dominanceMargin: 0.3,
  maxAuctionAttempts: 3,
  executionTimeoutMs: 30000,
};

/**
 * Master Evaluator callback type
 * Called after bids are collected to intelligently select winner(s)
 */
export type MasterEvaluator = (
  task: Task,
  bids: EvaluatedBid[]
) => Promise<{
  winners: string[];
  executionMode: 'single' | 'parallel' | 'series';
  reasoning: string;
  rejectedBids?: { agentId: string; reason: string }[];
  agentFeedback?: { agentId: string; feedback: string }[];
}>;

export class Exchange extends TypedEventEmitter<ExchangeEvents> {
  private config: ExchangeConfig;
  private auctionConfig: AuctionConfig;
  
  private categoryIndex: CategoryIndex;
  private agentRegistry: AgentRegistry;
  private reputationStore: ReputationStore;
  private taskQueue: PriorityQueue;
  private rateLimiter: RateLimiter;
  private storage: StorageAdapter;

  private tasks: Map<string, Task> = new Map();
  private activeAuctions: Map<string, { task: Task; orderBook: OrderBook }> = new Map();
  private isShuttingDown = false;
  private isProcessing = false;  // Guard against concurrent processQueue calls
  private processingLoop: NodeJS.Timeout | null = null;
  private healthCheckLoop: NodeJS.Timeout | null = null;
  
  // Master Orchestrator evaluator - set externally to enable intelligent winner selection
  private masterEvaluator: MasterEvaluator | null = null;

  constructor(
    config: ExchangeConfig,
    storage: StorageAdapter,
  ) {
    super();
    this.config = config;
    this.auctionConfig = { ...DEFAULT_AUCTION_CONFIG, ...config.auction };
    this.storage = storage;

    // Initialize components
    this.categoryIndex = new CategoryIndex(config.categories);
    this.agentRegistry = new AgentRegistry(this.categoryIndex, config.heartbeatTimeoutMs);
    this.reputationStore = new ReputationStore(storage, config.reputation);
    this.taskQueue = new PriorityQueue();
    this.rateLimiter = new RateLimiter(config.rateLimit);

    // Wire up reputation events
    this.reputationStore.on('agent:flagged', (data) => {
      this.emit('agent:flagged', data);
    });

    // Wire up agent registry events
    this.agentRegistry.on('agent:connected', (data) => {
      this.emit('agent:connected', data);
    });

    this.agentRegistry.on('agent:disconnected', (data) => {
      this.emit('agent:disconnected', data);
      this.handleAgentDisconnect(data.agentId);
    });

    this.agentRegistry.on('agent:unhealthy', (data) => {
      this.emit('agent:unhealthy', data);
    });

    // Set up market maker if configured
    if (config.marketMaker?.enabled) {
      this.categoryIndex.setMarketMaker(config.marketMaker.agentId);
    }
  }

  /**
   * Start the exchange
   */
  async start(): Promise<void> {
    // Guard against multiple starts
    if (this.processingLoop) {
      console.warn('[Exchange] Already started, ignoring duplicate start call');
      return;
    }
    
    // Start processing loop
    this.processingLoop = setInterval(() => this.processQueue(), 100);

    // Start health check loop
    this.healthCheckLoop = setInterval(
      () => this.agentRegistry.checkHealth(),
      this.config.heartbeatIntervalMs
    );

    // Recover any pending tasks from storage
    await this.recoverPendingTasks();

    this.emit('exchange:started', { port: this.config.port });
    console.log(`[Exchange] Started`);
  }

  /**
   * Stop the exchange gracefully
   */
  async shutdown(timeoutMs = 30000): Promise<void> {
    console.log('[Exchange] Initiating graceful shutdown...');
    this.isShuttingDown = true;
    this.emit('exchange:shutdown_started', {});

    // Stop processing loop
    if (this.processingLoop) {
      clearInterval(this.processingLoop);
      this.processingLoop = null;
    }

    if (this.healthCheckLoop) {
      clearInterval(this.healthCheckLoop);
      this.healthCheckLoop = null;
    }

    // Wait for active auctions to complete
    const deadline = Date.now() + timeoutMs;
    while (this.activeAuctions.size > 0 && Date.now() < deadline) {
      console.log(`[Exchange] Waiting for ${this.activeAuctions.size} active auctions...`);
      await this.sleep(1000);
    }

    // Persist remaining tasks
    for (const task of this.tasks.values()) {
      if (task.status !== Status.SETTLED && task.status !== Status.CANCELLED) {
        await this.persistPendingTask(task);
      }
    }

    // Close storage
    await this.storage.close();

    console.log('[Exchange] Shutdown complete');
    this.emit('exchange:shutdown_complete', {});
  }

  /**
   * Submit a new task
   */
  async submit(params: {
    content: string;
    priority?: TaskPriority;
    metadata?: Record<string, unknown>;
  }): Promise<{ taskId: string; task: Task }> {
    if (this.isShuttingDown) {
      throw new Error('Exchange is shutting down');
    }

    // Check rate limit
    const rateCheck = this.rateLimiter.canSubmit();
    if (!rateCheck.allowed) {
      throw new Error(`Rate limited: ${rateCheck.reason}. Retry after ${rateCheck.retryAfterMs}ms`);
    }

    // Create task
    const task: Task = {
      id: randomUUID(),
      content: params.content,
      metadata: params.metadata ?? {},
      status: Status.PENDING,
      priority: params.priority ?? TaskPriority.NORMAL,
      auctionId: null,
      auctionAttempt: 0,
      maxAuctionAttempts: this.auctionConfig.maxAuctionAttempts,
      assignedAgent: null,
      backupQueue: [],
      currentBackupIndex: 0,
      createdAt: Date.now(),
      auctionOpenedAt: null,
      auctionClosedAt: null,
      assignedAt: null,
      timeoutAt: null,
      completedAt: null,
      result: null,
      error: null,
    };

    this.tasks.set(task.id, task);
    this.taskQueue.enqueue(task);
    this.rateLimiter.recordSubmission();

    this.emit('task:queued', { task });
    console.log(`[Exchange] Task queued: ${task.id}`);

    return { taskId: task.id, task };
  }

  /**
   * Cancel a task
   */
  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    if (task.status === Status.SETTLED ||
        task.status === Status.CANCELLED ||
        task.status === Status.DEAD_LETTER) {
      return false;
    }

    // Remove from queue if pending
    this.taskQueue.remove(taskId);

    task.status = Status.CANCELLED;
    task.completedAt = Date.now();

    this.emit('task:cancelled', { task, reason: 'user_request' });
    console.log(`[Exchange] Task cancelled: ${taskId}`);

    return true;
  }

  /**
   * Get task by ID
   */
  getTask(taskId: string): Task | null {
    return this.tasks.get(taskId) ?? null;
  }

  /**
   * Get queue stats
   */
  getQueueStats(): { depth: ReturnType<PriorityQueue['getDepth']>; activeAuctions: number } {
    return {
      depth: this.taskQueue.getDepth(),
      activeAuctions: this.activeAuctions.size,
    };
  }

  // === Agent Management ===

  get agents(): AgentRegistry {
    return this.agentRegistry;
  }

  get reputation(): ReputationStore {
    return this.reputationStore;
  }

  get categories(): CategoryIndex {
    return this.categoryIndex;
  }

  /**
   * Set the Master Orchestrator evaluator
   * When set, this function will be called to select winners instead of simple score ranking
   */
  setMasterEvaluator(evaluator: MasterEvaluator): void {
    this.masterEvaluator = evaluator;
    console.log('[Exchange] Master Orchestrator evaluator set');
  }

  /**
   * Check if Master Orchestrator is enabled
   */
  hasMasterEvaluator(): boolean {
    return this.masterEvaluator !== null;
  }

  // === Internal Methods ===

  private async processQueue(): Promise<void> {
    // Guard against concurrent processing (setInterval doesn't wait for async)
    if (this.isProcessing) return;
    if (this.isShuttingDown) return;
    if (this.taskQueue.isEmpty()) return;

    // Check if we can start a new auction
    const rateCheck = this.rateLimiter.canSubmit();
    if (!rateCheck.allowed) return;

    const task = this.taskQueue.dequeue();
    if (!task) return;

    // Mark as processing to prevent re-entry
    this.isProcessing = true;

    // Run auction
    try {
      await this.runAuction(task);
    } catch (error) {
      console.error(`[Exchange] Auction error for task ${task.id}:`, error);
      task.status = Status.DEAD_LETTER;
      task.error = error instanceof Error ? error.message : String(error);
      this.emit('task:dead_letter', {
        task,
        reason: 'Auction error',
        totalAttempts: task.auctionAttempt,
      });
    } finally {
      this.isProcessing = false;
    }
  }

  private async runAuction(task: Task): Promise<void> {
    // Circuit breaker check
    if (task.auctionAttempt >= this.auctionConfig.maxAuctionAttempts) {
      task.status = Status.DEAD_LETTER;
      this.emit('task:dead_letter', {
        task,
        reason: 'Max auction attempts exceeded',
        totalAttempts: task.auctionAttempt,
      });
      return;
    }

    task.auctionAttempt++;
    task.status = Status.OPEN;
    task.auctionId = randomUUID();
    task.auctionOpenedAt = Date.now();

    this.rateLimiter.auctionStarted();

    // Get candidate agents
    const agentIds = this.categoryIndex.getAgentsForTask(task);
    const matchedCategories = this.categoryIndex.findCategories(task);
    
    console.log(`[Exchange] Task "${task.content?.slice(0, 40)}..." matched categories:`, matchedCategories);
    console.log(`[Exchange] Candidate agents (${agentIds.size}):`, Array.from(agentIds));

    task.metadata.matchedCategories = matchedCategories;
    task.metadata.candidateAgents = Array.from(agentIds);

    this.emit('auction:started', { task, auctionId: task.auctionId });
    this.emit('auction:candidates', {
      task,
      categories: matchedCategories,
      agents: Array.from(agentIds),
    });

    // Create order book
    const orderBook = new OrderBook(task.auctionId);
    this.activeAuctions.set(task.auctionId, { task, orderBook });

    // Select bidding window
    const windowMs = this.selectBiddingWindow(task, agentIds.size);

    // Collect bids
    await this.collectBids(task, orderBook, agentIds, windowMs);

    // Close and evaluate
    task.status = Status.MATCHING;
    await orderBook.close();
    const rankedBids = await orderBook.evaluateAndRank(this.reputationStore);

    this.emit('auction:closed', { task, auctionId: task.auctionId, bids: rankedBids });

    // Cleanup
    this.activeAuctions.delete(task.auctionId);
    this.rateLimiter.auctionEnded();

    // Check for bids
    if (rankedBids.length === 0) {
      console.error(`[Exchange] No bids received for task ${task.id}`);
      task.status = Status.HALTED;
      this.emit('exchange:halt', { task, reason: 'No bids received' });
      return;
    }

    // Use Master Orchestrator if available, otherwise fall back to top scorer
    let winner: EvaluatedBid;
    let backups: EvaluatedBid[];
    let masterEvaluation: {
      executionMode?: string;
      reasoning?: string;
      rejectedBids?: { agentId: string; reason: string }[];
      agentFeedback?: { agentId: string; feedback: string }[];
    } | null = null;

    if (this.masterEvaluator) {
      try {
        console.log('[Exchange] Using Master Orchestrator to select winner');
        const evaluation = await this.masterEvaluator(task, rankedBids);
        masterEvaluation = evaluation;
        
        // Find the selected winners in the ranked bids
        const selectedWinners = evaluation.winners
          .map(winnerId => rankedBids.find(b => b.agentId === winnerId))
          .filter((b): b is EvaluatedBid => b !== undefined);
        
        if (selectedWinners.length > 0) {
          // Primary winner is first selected
          winner = selectedWinners[0];
          // Backups are remaining selected + other high scorers
          backups = [
            ...selectedWinners.slice(1),
            ...rankedBids.filter(b => !evaluation.winners.includes(b.agentId))
          ];
          
          console.log(`[Exchange] Master selected: ${winner.agentId} (mode: ${evaluation.executionMode})`);
          console.log(`[Exchange] Master reasoning: ${evaluation.reasoning}`);
          
          // Emit master evaluation event for logging/HUD
          this.emit('master:evaluated', {
            task,
            evaluation,
            selectedWinner: winner,
            allBids: rankedBids
          });
        } else {
          console.warn('[Exchange] Master Orchestrator selected no valid winners, falling back');
          [winner, ...backups] = rankedBids;
        }
      } catch (error) {
        console.error('[Exchange] Master Orchestrator error, falling back:', error);
        [winner, ...backups] = rankedBids;
      }
    } else {
      // No master evaluator - use traditional top scorer
      [winner, ...backups] = rankedBids;
    }

    // Assign winner
    task.status = Status.ASSIGNED;
    task.assignedAgent = winner.agentId;
    task.backupQueue = backups.map(b => b.agentId);
    task.currentBackupIndex = 0;
    task.assignedAt = Date.now();
    task.auctionClosedAt = Date.now();

    // Include master evaluation in the event if available
    this.emit('task:assigned', { 
      task, 
      winner, 
      backups,
      masterEvaluation 
    });

    // Execute
    await this.executeWithCascade(task, winner);
  }

  private async collectBids(
    task: Task,
    orderBook: OrderBook,
    agentIds: Set<string>,
    windowMs: number
  ): Promise<void> {
    const abortController = new AbortController();
    const deadline = Date.now() + windowMs;

    // Build context
    const context = {
      queueDepth: this.taskQueue.getDepth().total,
      conversationHistory: [], // TODO: integrate with conversation history
      participatingAgents: Array.from(agentIds),
    };

    // Request bids from all agents in parallel
    console.log(`[Exchange] Requesting bids from ${agentIds.size} agents:`, Array.from(agentIds));
    
    const bidPromises = Array.from(agentIds).map(async (agentId) => {
      try {
        if (abortController.signal.aborted) {
          console.log(`[Exchange] Skipping ${agentId}: auction aborted`);
          return;
        }
        if (!this.agentRegistry.isHealthy(agentId)) {
          console.log(`[Exchange] Skipping ${agentId}: marked unhealthy`);
          return;
        }

        const ws = this.agentRegistry.getSocket(agentId);
        if (!ws) {
          console.log(`[Exchange] Skipping ${agentId}: no WebSocket connection`);
          return;
        }

        // Send bid request
        const request: BidRequest = {
          type: 'bid_request',
          auctionId: task.auctionId!,
          task,
          context,
          deadline,
        };

        console.log(`[Exchange] Sending bid_request to ${agentId}`);
        ws.send(JSON.stringify(request));
      } catch (error) {
        console.warn(`[Exchange] Failed to request bid from ${agentId}:`, error);
      }
    });

    await Promise.allSettled(bidPromises);

    // Wait for bids or timeout
    await this.sleep(windowMs);

    // Abort any remaining operations
    abortController.abort();
  }

  /**
   * Handle incoming bid response
   */
  handleBidResponse(response: BidResponse): void {
    const auction = this.activeAuctions.get(response.auctionId);
    if (!auction) {
      console.warn(`[Exchange] Bid received for unknown auction: ${response.auctionId}`);
      return;
    }

    if (response.bid) {
      auction.orderBook.submitBid({
        agentId: response.agentId,
        agentVersion: response.agentVersion,
        confidence: response.bid.confidence,
        reasoning: response.bid.reasoning,
        estimatedTimeMs: response.bid.estimatedTimeMs,
        timestamp: Date.now(),
        tier: response.bid.tier,
      });
    }
  }

  private async executeWithCascade(task: Task, winner: EvaluatedBid): Promise<void> {
    const agents = [task.assignedAgent!, ...task.backupQueue];

    for (let i = 0; i < agents.length; i++) {
      const agentId = agents[i];
      
      if (!this.agentRegistry.isHealthy(agentId)) {
        console.log(`[Exchange] Skipping unhealthy agent ${agentId}`);
        continue;
      }

      const ws = this.agentRegistry.getSocket(agentId);
      if (!ws) {
        console.log(`[Exchange] No socket for agent ${agentId}`);
        continue;
      }

      const agent = this.agentRegistry.get(agentId);
      if (!agent) continue;

      task.status = Status.ASSIGNED;
      task.currentBackupIndex = i;
      task.timeoutAt = Date.now() + this.auctionConfig.executionTimeoutMs;

      this.agentRegistry.incrementTaskCount(agentId);
      this.emit('task:executing', { task, agentId, attempt: i + 1 });

      // Send assignment
      const assignment: TaskAssignment = {
        type: 'task_assignment',
        taskId: task.id,
        task,
        isBackup: i > 0,
        backupIndex: i,
        timeout: this.auctionConfig.executionTimeoutMs,
        previousErrors: task.error ? [task.error] : [],
      };

      ws.send(JSON.stringify(assignment));

      // Wait for result or timeout
      const result = await this.waitForResult(task.id, this.auctionConfig.executionTimeoutMs);

      this.agentRegistry.decrementTaskCount(agentId);

      if (result && result.success) {
        // Success!
        task.status = Status.SETTLED;
        task.result = result;
        task.completedAt = Date.now();

        await this.reputationStore.recordSuccess(agentId, agent.version);
        this.emit('task:settled', { task, result, agentId, attempt: i + 1 });

        return;
      }

      // Failure
      const error = result?.error ?? 'Execution timeout';
      const isTimeout = !result;
      task.status = Status.BUSTED;
      task.error = error;

      await this.reputationStore.recordFailure(agentId, agent.version, { isTimeout, error });
      this.emit('task:busted', {
        task,
        agentId,
        error,
        isTimeout,
        backupsRemaining: agents.length - i - 1,
      });

      console.log(`[Exchange] Agent ${agentId} failed, trying backup ${i + 1}/${agents.length}`);
    }

    // All agents failed - re-auction if under limit
    if (task.auctionAttempt < this.auctionConfig.maxAuctionAttempts) {
      console.log(`[Exchange] All agents failed, re-auctioning (attempt ${task.auctionAttempt + 1})`);
      task.backupQueue = [];
      task.assignedAgent = null;
      this.taskQueue.enqueue(task);
      return;
    }

    // Circuit breaker
    task.status = Status.DEAD_LETTER;
    task.completedAt = Date.now();
    this.emit('task:dead_letter', {
      task,
      reason: 'All agents and auction attempts exhausted',
      totalAttempts: task.auctionAttempt,
    });
  }

  // Pending result handlers
  private pendingResults: Map<string, { resolve: (result: TaskResult | null) => void }> = new Map();

  private waitForResult(taskId: string, timeoutMs: number): Promise<TaskResult | null> {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingResults.delete(taskId);
        resolve(null);
      }, timeoutMs);

      this.pendingResults.set(taskId, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          this.pendingResults.delete(taskId);
          resolve(result);
        },
      });
    });
  }

  /**
   * Handle incoming task result
   */
  handleTaskResult(msg: TaskResultMessage): void {
    const pending = this.pendingResults.get(msg.taskId);
    if (pending) {
      pending.resolve(msg.result);
    }
  }

  private handleAgentDisconnect(agentId: string): void {
    // Find any tasks assigned to this agent and cascade
    for (const task of this.tasks.values()) {
      if (task.assignedAgent === agentId && task.status === Status.ASSIGNED) {
        this.emit('task:agent_disconnected', { task, agentId });
        
        // Trigger cascade by marking as failed
        const pending = this.pendingResults.get(task.id);
        if (pending) {
          pending.resolve({ success: false, error: 'Agent disconnected' });
        }
      }
    }
  }

  private selectBiddingWindow(task: Task, agentCount: number): number {
    // Fast path: single agent or very few
    if (agentCount <= 2) return this.auctionConfig.minWindowMs;

    // Simple task detection
    const simpleActions = ['open', 'close', 'play', 'pause', 'stop', 'save', 'undo', 'redo'];
    const words = task.content.toLowerCase().split(/\s+/);
    const isSimple = words.some(w => simpleActions.includes(w)) && words.length < 5;

    if (isSimple) return 200;

    // Complex task detection
    const isComplex = task.content.length > 100 ||
      task.content.includes(' and ') ||
      task.content.includes(' then ');

    if (isComplex) return this.auctionConfig.maxWindowMs;

    return this.auctionConfig.defaultWindowMs;
  }

  private async persistPendingTask(task: Task): Promise<void> {
    await this.storage.set(`pending:${task.id}`, {
      task,
      savedAt: Date.now(),
      reason: 'shutdown',
    });
  }

  private async recoverPendingTasks(): Promise<number> {
    const pendingKeys = await this.storage.list('pending:');
    let recovered = 0;

    for (const key of pendingKeys) {
      const saved = await this.storage.get<{ task: Task; savedAt: number }>(key);
      if (saved) {
        saved.task.status = Status.PENDING;
        saved.task.auctionAttempt = Math.max(0, saved.task.auctionAttempt - 1);
        this.tasks.set(saved.task.id, saved.task);
        this.taskQueue.enqueue(saved.task);
        await this.storage.delete(key);
        recovered++;
      }
    }

    if (recovered > 0) {
      console.log(`[Exchange] Recovered ${recovered} pending tasks`);
    }

    return recovered;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
