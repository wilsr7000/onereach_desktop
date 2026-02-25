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
  TaskAckMessage,
  TaskHeartbeatMessage,
  TaskResultMessage,
  AuctionConfig,
  BiddingContext,
  ConversationMessage,
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
  defaultWindowMs: 4000,
  minWindowMs: 1000,
  maxWindowMs: 8000,
  instantWinThreshold: 0.85,
  dominanceMargin: 0.3,
  maxAuctionAttempts: 3,
  executionTimeoutMs: 120000,     // Generous base timeout (agents manage their own via ack/heartbeat)
  ackTimeoutMs: 10000,            // Agent must ack within 10s or it's considered dead
  heartbeatExtensionMs: 30000,    // Each heartbeat grants 30s more
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
  private activeAuctions: Map<string, { task: Task; orderBook: OrderBook; expectedResponses?: number; responseCount?: number; resolveEarly?: (() => void) | null }> = new Map();
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
      lockedAt: null,
      lockedBy: null,
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
      this.emit('task:route_to_error_agent', { task, reason: 'Auction error' });
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
    // ==================== LOCKED SUBTASK HANDLING ====================
    // If this is a subtask with locked routing, skip auction and assign directly
    const isLockedSubtask = task.metadata?.source === 'subtask' && 
                           task.metadata?.routingMode === 'locked' &&
                           task.metadata?.lockedAgentId;
    
    if (isLockedSubtask) {
      const lockedAgentId = task.metadata.lockedAgentId as string;
      console.log(`[Exchange] Locked subtask detected, direct assign to: ${lockedAgentId}`);
      
      // Check if agent is connected
      const agent = (this.agentRegistry as any).getAgent?.(lockedAgentId) ?? this.agentRegistry.get(lockedAgentId);
      if (!agent) {
        console.error(`[Exchange] Locked agent ${lockedAgentId} not found, failing subtask`);
        task.status = Status.DEAD_LETTER;
        this.emit('task:route_to_error_agent', { task, reason: `Locked agent ${lockedAgentId} not available` });
        this.emit('task:dead_letter', {
          task,
          reason: `Locked agent ${lockedAgentId} not available`,
          totalAttempts: 1,
        });
        return;
      }
      
      // Direct assignment (no auction)
      task.status = Status.ASSIGNED;
      task.assignedAgent = lockedAgentId;
      task.backupQueue = [];
      task.currentBackupIndex = 0;
      task.assignedAt = Date.now();
      task.auctionAttempt = 1;
      
      // Create a synthetic winner bid
      const syntheticBid: EvaluatedBid = {
        agentId: lockedAgentId,
        agentVersion: agent.version || '1.0.0',
        confidence: 1.0,
        reasoning: 'Locked subtask - direct assignment',
        estimatedTimeMs: 5000,
        timestamp: Date.now(),
        score: 1.0,
        reputation: 1.0,
        rank: 1,
        tier: 'builtin',
      };
      
      this.emit('task:assigned', { 
        task, 
        winner: syntheticBid, 
        backups: [],
        masterEvaluation: null 
      });
      
      // Execute directly
      await this.executeWithCascade(task, syntheticBid);
      return;
    }
    
    // Circuit breaker check
    if (task.auctionAttempt >= this.auctionConfig.maxAuctionAttempts) {
      task.status = Status.DEAD_LETTER;
      this.emit('task:route_to_error_agent', { task, reason: 'Max auction attempts exceeded' });
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
    let agentIds = this.categoryIndex.getAgentsForTask(task);
    const matchedCategories = this.categoryIndex.findCategories(task);
    
    // Apply agent space filter if provided (HUD API scopes agents by space)
    const agentFilter = task.metadata?.agentFilter as string[] | undefined;
    if (agentFilter && Array.isArray(agentFilter) && agentFilter.length > 0) {
      const filterSet = new Set(agentFilter);
      const filteredIds = new Set(Array.from(agentIds).filter(id => filterSet.has(id)));
      console.log(`[Exchange] Agent space filter applied: ${agentIds.size} -> ${filteredIds.size} agents`);
      agentIds = filteredIds;
    }
    
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
      winners?: string[];
      executionMode?: 'single' | 'parallel' | 'series';
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

    // Store execution mode from master evaluator
    if (masterEvaluation) {
      task.executionMode = masterEvaluation.executionMode || 'single';
      task.selectedWinners = masterEvaluation.winners || [winner.agentId];
    } else {
      task.executionMode = 'single';
      task.selectedWinners = [winner.agentId];
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

    // Fast-path: if winning bid includes a direct result (informational agent),
    // settle immediately without execution. Saves an entire LLM round trip.
    if (winner.result) {
      console.log(`[Exchange] Fast-path settlement: ${winner.agentId} answered in bid`);
      task.status = Status.SETTLED;
      task.result = { 
        success: true, 
        message: winner.result,
        data: { output: winner.result, fastPath: true },
      };
      task.completedAt = Date.now();
      this.emit('task:settled', { 
        task, 
        result: task.result, 
        agentId: winner.agentId, 
        attempt: 0,
        fastPath: true,
      });
      return;
    }

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

    // Build context -- pass conversation history from task metadata through to bidders
    const taskHistory = Array.isArray(task.metadata?.conversationHistory)
      ? task.metadata.conversationHistory as ConversationMessage[]
      : [];
    const context: BiddingContext = {
      queueDepth: this.taskQueue.getDepth().total,
      conversationHistory: taskHistory,
      conversationText: (task.metadata?.conversationText as string) || '',
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

    // Track expected responses for early close
    const auction = this.activeAuctions.get(task.auctionId!);
    if (auction) {
      auction.expectedResponses = agentIds.size;
      auction.responseCount = 0;
    }

    // Wait for all bids or timeout (whichever comes first)
    await Promise.race([
      this.sleep(windowMs),
      new Promise<void>((resolve) => {
        if (auction) {
          auction.resolveEarly = resolve;
          // Check if all responses already arrived
          if ((auction.responseCount ?? 0) >= agentIds.size) {
            resolve();
          }
        }
      }),
    ]);

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
        result: response.bid.result || null,  // Fast-path result from informational agents
      });
    }

    // Track responses for early close
    auction.responseCount = (auction.responseCount ?? 0) + 1;
    if (auction.expectedResponses && auction.responseCount >= auction.expectedResponses && auction.resolveEarly) {
      auction.resolveEarly();
      auction.resolveEarly = null;
    }
  }

  private async executeWithCascade(task: Task, winner: EvaluatedBid): Promise<void> {
    // Multi-winner execution: if master evaluator selected multiple winners
    if (task.selectedWinners && task.selectedWinners.length > 1 && task.executionMode !== 'single') {
      if (task.executionMode === 'parallel') {
        await this.executeParallel(task, task.selectedWinners);
        return;
      } else if (task.executionMode === 'series') {
        await this.executeSeries(task, task.selectedWinners);
        return;
      }
    }

    // Single-winner cascade execution (original behavior)
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
      task.lockedAt = Date.now();
      task.lockedBy = agentId;

      this.agentRegistry.incrementTaskCount(agentId);
      this.emit('task:executing', { task, agentId, attempt: i + 1 });
      this.emit('task:locked', { task, agentId, timeoutMs: this.auctionConfig.executionTimeoutMs });

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

      // Settle if (a) success, or (b) agent returned a user-facing message
      // even with success=false. A message means the agent handled the request
      // (e.g. "no meetings found") vs a hard crash with no response.
      const isSoftDecline = result && !result.success && result.message;
      if (result && (result.success || isSoftDecline)) {
        task.lockedAt = null;
        task.lockedBy = null;
        this.emit('task:unlocked', { task, reason: 'completed' });

        task.status = Status.SETTLED;
        task.result = result;
        task.completedAt = Date.now();

        if (result.success) {
          await this.reputationStore.recordSuccess(agentId, agent.version);
        }
        this.emit('task:settled', { task, result, agentId, attempt: i + 1 });

        return;
      }

      // Hard failure (no result or no message) -- unlock so cascading can try next agent
      task.lockedAt = null;
      task.lockedBy = null;
      const error = result?.error ?? 'Execution timeout';
      const isTimeout = !result;
      this.emit('task:unlocked', { task, reason: isTimeout ? 'timeout' : 'failed' });

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

    // Circuit breaker -- route to error agent for graceful handling
    task.status = Status.DEAD_LETTER;
    task.completedAt = Date.now();
    this.emit('task:route_to_error_agent', {
      task,
      reason: 'All agents and auction attempts exhausted',
    });
    this.emit('task:dead_letter', {
      task,
      reason: 'All agents and auction attempts exhausted',
      totalAttempts: task.auctionAttempt,
    });
  }

  /**
   * Execute multiple agents in series -- each runs after the previous completes.
   * Results are aggregated. If any agent fails, it's skipped and the next runs.
   */
  private async executeSeries(task: Task, agentIds: string[]): Promise<void> {
    const results: Array<{ agentId: string; result: TaskResult }> = [];

    for (const agentId of agentIds) {
      if (!this.agentRegistry.isHealthy(agentId)) continue;
      const ws = this.agentRegistry.getSocket(agentId);
      if (!ws) continue;

      task.lockedAt = Date.now();
      task.lockedBy = agentId;
      this.emit('task:locked', { task, agentId, timeoutMs: this.auctionConfig.executionTimeoutMs });
      this.agentRegistry.incrementTaskCount(agentId);

      const assignment: TaskAssignment = {
        type: 'task_assignment',
        taskId: task.id,
        task,
        isBackup: false,
        backupIndex: 0,
        timeout: this.auctionConfig.executionTimeoutMs,
        previousErrors: [],
      };

      ws.send(JSON.stringify(assignment));
      const result = await this.waitForResult(task.id, this.auctionConfig.executionTimeoutMs);
      this.agentRegistry.decrementTaskCount(agentId);
      task.lockedAt = null;
      task.lockedBy = null;
      this.emit('task:unlocked', { task, reason: result?.success ? 'completed' : 'failed' });

      if (result?.success) {
        results.push({ agentId, result });
      } else {
        console.warn(`[Exchange] Series agent ${agentId} failed, continuing`);
      }
    }

    // Aggregate results
    if (results.length > 0) {
      task.status = Status.SETTLED;
      task.result = {
        success: true,
        data: { multiAgent: true, mode: 'series', results },
      };
      task.completedAt = Date.now();
      this.emit('task:settled', { task, result: task.result, agentId: results[0].agentId, attempt: 1 });
    } else {
      task.status = Status.DEAD_LETTER;
      this.emit('task:route_to_error_agent', { task, reason: 'All series agents failed' });
      this.emit('task:dead_letter', { task, reason: 'All series agents failed', totalAttempts: 1 });
    }
  }

  /**
   * Execute multiple agents in parallel -- all run concurrently.
   * Task settles once all agents complete (or timeout).
   */
  private async executeParallel(task: Task, agentIds: string[]): Promise<void> {
    // Each parallel agent gets a unique subtask ID so waitForResult entries
    // don't overwrite each other in the pendingResults map.
    const promises = agentIds.map(async (agentId, idx) => {
      if (!this.agentRegistry.isHealthy(agentId)) return { agentId, result: null };
      const ws = this.agentRegistry.getSocket(agentId);
      if (!ws) return { agentId, result: null };

      this.agentRegistry.incrementTaskCount(agentId);

      const subtaskId = `${task.id}__parallel_${idx}`;
      const assignment: TaskAssignment = {
        type: 'task_assignment',
        taskId: subtaskId,
        task: { ...task, id: subtaskId, _parentTaskId: task.id },
        isBackup: false,
        backupIndex: 0,
        timeout: this.auctionConfig.executionTimeoutMs,
        previousErrors: [],
      };

      ws.send(JSON.stringify(assignment));
      const result = await this.waitForResult(subtaskId, this.auctionConfig.executionTimeoutMs);
      this.agentRegistry.decrementTaskCount(agentId);
      return { agentId, result };
    });

    task.lockedAt = Date.now();
    task.lockedBy = 'parallel-execution';
    this.emit('task:locked', { task, agentId: 'parallel-execution', timeoutMs: this.auctionConfig.executionTimeoutMs });

    const outcomes = await Promise.all(promises);
    const successes = outcomes.filter(o => o.result?.success);

    task.lockedAt = null;
    task.lockedBy = null;
    this.emit('task:unlocked', { task, reason: successes.length > 0 ? 'completed' : 'failed' });

    if (successes.length > 0) {
      task.status = Status.SETTLED;
      // Combine messages from all successful agents into a single result
      const messages = successes
        .map(s => s.result?.message || (s.result?.data as any)?.message || '')
        .filter(Boolean);
      task.result = {
        success: true,
        message: messages.join('\n'),
        data: { multiAgent: true, mode: 'parallel', results: successes },
      };
      task.completedAt = Date.now();
      this.emit('task:settled', { task, result: task.result, agentId: successes[0].agentId, attempt: 1 });
    } else {
      task.status = Status.DEAD_LETTER;
      this.emit('task:route_to_error_agent', { task, reason: 'All parallel agents failed' });
      this.emit('task:dead_letter', { task, reason: 'All parallel agents failed', totalAttempts: 1 });
    }
  }

  // ---------------------------------------------------------------------------
  // Ack / Heartbeat / Result protocol
  //
  // Flow:  Exchange sends task_assignment
  //    →   Agent sends task_ack       (resets timer to executionTimeoutMs)
  //    →   Agent sends task_heartbeat (resets timer to heartbeatExtensionMs, repeatable)
  //    →   Agent sends task_result    (resolves the promise)
  //
  // If no ack arrives within ackTimeoutMs the agent is considered dead and
  // the exchange cascades to the next backup.
  // ---------------------------------------------------------------------------
  private pendingResults: Map<string, {
    resolve: (result: TaskResult | null) => void;
    ack: (estimatedMs?: number) => void;
    heartbeat: (progress?: string, extendMs?: number) => void;
    acked: boolean;
  }> = new Map();

  private waitForResult(taskId: string, _executionTimeoutMs: number): Promise<TaskResult | null> {
    const ackTimeoutMs = this.auctionConfig.ackTimeoutMs;
    const execTimeoutMs = this.auctionConfig.executionTimeoutMs;
    const heartbeatExtMs = this.auctionConfig.heartbeatExtensionMs;

    return new Promise((resolve) => {
      let currentTimer: ReturnType<typeof setTimeout>;

      const resetTimer = (ms: number) => {
        clearTimeout(currentTimer);
        currentTimer = setTimeout(() => {
          this.pendingResults.delete(taskId);
          resolve(null); // timeout → cascade
        }, ms);
      };

      // Phase 1: wait for ack (short)
      resetTimer(ackTimeoutMs);

      this.pendingResults.set(taskId, {
        acked: false,

        resolve: (result) => {
          clearTimeout(currentTimer);
          this.pendingResults.delete(taskId);
          resolve(result);
        },

        ack: (estimatedMs?: number) => {
          const entry = this.pendingResults.get(taskId);
          if (entry) entry.acked = true;
          // Phase 2: switch to generous execution timeout
          // If the agent provided an estimate, use that + buffer; otherwise default
          const timeout = estimatedMs ? Math.min(estimatedMs + 15000, execTimeoutMs) : execTimeoutMs;
          resetTimer(timeout);
          this.emit('task:acked' as any, { taskId, estimatedMs });
        },

        heartbeat: (progress?: string, extendMs?: number) => {
          const entry = this.pendingResults.get(taskId);
          if (!entry?.acked) return; // ignore heartbeats before ack
          resetTimer(extendMs || heartbeatExtMs);
          this.emit('task:heartbeat' as any, { taskId, progress });
        },
      });
    });
  }

  /**
   * Handle incoming task acknowledgment
   */
  handleTaskAck(msg: TaskAckMessage): void {
    const pending = this.pendingResults.get(msg.taskId);
    if (pending) {
      pending.ack(msg.estimatedMs);
    }
  }

  /**
   * Handle incoming task heartbeat (resets timeout)
   */
  handleTaskHeartbeat(msg: TaskHeartbeatMessage): void {
    const pending = this.pendingResults.get(msg.taskId);
    if (pending) {
      pending.heartbeat(msg.progress, msg.extendMs);
    }
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

    if (isSimple) return this.auctionConfig.minWindowMs;

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
