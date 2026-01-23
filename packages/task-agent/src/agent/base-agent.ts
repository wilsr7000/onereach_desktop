/**
 * Base Agent - Core agent functionality
 */
import WebSocket from 'ws';
import type {
  AgentConfig,
  AgentHandlers,
  ExecutionContext,
  BidDecision,
} from '../types.js';
import type {
  Task,
  TaskResult,
  BidRequest,
  BidResponse,
  TaskAssignment,
  TaskResultMessage,
  RegisterMessage,
  RegisteredMessage,
  PingMessage,
  PongMessage,
  ProtocolMessage,
  BiddingContext,
  AgentCapabilities,
} from '@onereach/task-exchange/types';
import { PROTOCOL_VERSION } from '@onereach/task-exchange/types';

type EventCallback<T> = (data: T) => void;

interface AgentEvents {
  'connected': { exchangeUrl: string };
  'disconnected': { reason: string };
  'reconnecting': { attempt: number };
  'registered': { agentId: string };
  'bid:requested': { auctionId: string; task: Task };
  'bid:submitted': { auctionId: string; confidence: number };
  'bid:skipped': { auctionId: string; reason: string };
  'task:assigned': { task: Task; isBackup: boolean };
  'task:executing': { taskId: string };
  'task:completed': { taskId: string; success: boolean };
  'task:failed': { taskId: string; error: string };
  'error': { error: Error };
}

const DEFAULT_CAPABILITIES: AgentCapabilities = {
  quickMatch: true,
  llmEvaluate: false,
  maxConcurrent: 5,
};

interface InternalAgentConfig extends Omit<AgentConfig, 'capabilities'> {
  capabilities: AgentCapabilities;
}

export class BaseAgent {
  private config: InternalAgentConfig;
  private handlers: AgentHandlers;
  private ws: WebSocket | null = null;
  private isRunning = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatIntervalMs = 30000;
  
  private listeners: Map<keyof AgentEvents, Set<EventCallback<unknown>>> = new Map();
  private activeTasks: Map<string, AbortController> = new Map();

  constructor(config: AgentConfig, handlers: AgentHandlers) {
    this.config = {
      name: config.name,
      version: config.version,
      categories: config.categories,
      exchange: {
        reconnect: true,
        reconnectIntervalMs: 5000,
        maxReconnectAttempts: 10,
        ...config.exchange,
      },
      capabilities: {
        ...DEFAULT_CAPABILITIES,
        ...config.capabilities,
        quickMatch: !!handlers.quickMatch,
        llmEvaluate: !!handlers.evaluate,
      },
    };
    this.handlers = handlers;
  }

  // === Event Emitter ===

  on<K extends keyof AgentEvents>(event: K, callback: EventCallback<AgentEvents[K]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback as EventCallback<unknown>);
    return () => this.off(event, callback);
  }

  off<K extends keyof AgentEvents>(event: K, callback: EventCallback<AgentEvents[K]>): void {
    this.listeners.get(event)?.delete(callback as EventCallback<unknown>);
  }

  private emit<K extends keyof AgentEvents>(event: K, data: AgentEvents[K]): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      for (const cb of callbacks) {
        try {
          cb(data);
        } catch (error) {
          console.error(`[Agent] Error in ${event} handler:`, error);
        }
      }
    }
  }

  // === Lifecycle ===

  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('[Agent] Already running');
      return;
    }

    this.isRunning = true;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.isRunning = false;

    // Cancel all active tasks
    for (const [taskId, controller] of this.activeTasks) {
      controller.abort();
      console.log(`[Agent] Cancelled task ${taskId} due to shutdown`);
    }
    this.activeTasks.clear();

    // Stop timers
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Close connection
    if (this.ws) {
      this.ws.close(1000, 'Agent stopping');
      this.ws = null;
    }

    console.log('[Agent] Stopped');
  }

  // === Connection ===

  private async connect(): Promise<void> {
    const url = this.config.exchange.url;
    console.log(`[Agent] Connecting to ${url}...`);

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
          console.log('[Agent] Connected');
          this.reconnectAttempts = 0;
          this.emit('connected', { exchangeUrl: url });
          this.register();
          this.startHeartbeat();
          resolve();
        });

        this.ws.on('message', (data) => {
          this.handleMessage(data.toString());
        });

        this.ws.on('close', (code, reason) => {
          const reasonStr = reason?.toString() || 'unknown';
          console.log(`[Agent] Disconnected: ${code} - ${reasonStr}`);
          this.emit('disconnected', { reason: reasonStr });
          this.stopHeartbeat();
          this.handleDisconnect();
        });

        this.ws.on('error', (error) => {
          console.error('[Agent] WebSocket error:', error);
          this.emit('error', { error });
          reject(error);
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  private register(): void {
    if (!this.ws) return;

    const msg: RegisterMessage = {
      type: 'register',
      protocolVersion: PROTOCOL_VERSION,
      agentId: this.config.name,
      agentVersion: this.config.version,
      categories: this.config.categories,
      capabilities: this.config.capabilities,
      apiKey: this.config.exchange.apiKey,
    };

    this.ws.send(JSON.stringify(msg));
    console.log(`[Agent] Registered as ${this.config.name} v${this.config.version}`);
  }

  private handleDisconnect(): void {
    this.ws = null;

    if (!this.isRunning || !this.config.exchange.reconnect) {
      return;
    }

    const maxAttempts = this.config.exchange.maxReconnectAttempts ?? 10;
    if (this.reconnectAttempts >= maxAttempts) {
      console.error(`[Agent] Max reconnect attempts (${maxAttempts}) reached`);
      return;
    }

    this.reconnectAttempts++;
    const delay = this.config.exchange.reconnectIntervalMs ?? 5000;

    console.log(`[Agent] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.emit('reconnecting', { attempt: this.reconnectAttempts });

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        console.error('[Agent] Reconnect failed:', error);
      });
    }, delay);
  }

  // === Heartbeat ===

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        const ping: PingMessage = { type: 'ping', timestamp: Date.now() };
        this.ws.send(JSON.stringify(ping));
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // === Message Handling ===

  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data) as ProtocolMessage;

      switch (msg.type) {
        case 'registered':
          this.handleRegistered(msg as RegisteredMessage);
          break;
        case 'bid_request':
          this.handleBidRequest(msg as BidRequest);
          break;
        case 'task_assignment':
          this.handleTaskAssignment(msg as TaskAssignment);
          break;
        case 'ping':
          this.handlePing(msg as PingMessage);
          break;
        case 'pong':
          // Heartbeat response, ignore
          break;
        case 'error':
          console.error('[Agent] Exchange error:', msg);
          break;
        default:
          console.warn('[Agent] Unknown message type:', (msg as { type: string }).type);
      }
    } catch (error) {
      console.error('[Agent] Failed to parse message:', error);
    }
  }

  private handleRegistered(msg: RegisteredMessage): void {
    console.log(`[Agent] Registered with exchange (protocol ${msg.protocolVersion})`);
    this.heartbeatIntervalMs = msg.config.heartbeatIntervalMs;
    this.emit('registered', { agentId: msg.agentId });
  }

  private async handleBidRequest(msg: BidRequest): Promise<void> {
    this.emit('bid:requested', { auctionId: msg.auctionId, task: msg.task });

    // Check if deadline passed
    if (Date.now() > msg.deadline) {
      console.log(`[Agent] Bid deadline passed for auction ${msg.auctionId}`);
      this.emit('bid:skipped', { auctionId: msg.auctionId, reason: 'deadline_passed' });
      return;
    }

    try {
      const decision = await this.generateBid(msg.task, msg.context);

      const response: BidResponse = {
        type: 'bid_response',
        auctionId: msg.auctionId,
        agentId: this.config.name,
        agentVersion: this.config.version,
        bid: decision ? {
          confidence: decision.confidence,
          reasoning: decision.reasoning,
          estimatedTimeMs: decision.estimatedTimeMs,
          tier: decision.tier,
        } : null,
      };

      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(response));

        if (decision) {
          console.log(`[Agent] Bid submitted: ${decision.confidence} (${decision.tier})`);
          this.emit('bid:submitted', { auctionId: msg.auctionId, confidence: decision.confidence });
        } else {
          console.log(`[Agent] No bid for auction ${msg.auctionId}`);
          this.emit('bid:skipped', { auctionId: msg.auctionId, reason: 'no_match' });
        }
      }
    } catch (error) {
      console.error(`[Agent] Error generating bid:`, error);
      this.emit('bid:skipped', { auctionId: msg.auctionId, reason: 'error' });
    }
  }

  private async generateBid(task: Task, context: BiddingContext): Promise<BidDecision | null> {
    // Tier 1: Quick match
    if (this.handlers.quickMatch) {
      const quickScore = this.handlers.quickMatch(task);

      if (quickScore === 0) {
        return null; // Definitely can't handle
      }

      if (quickScore >= 0.9) {
        // High confidence - skip LLM
        return {
          shouldBid: true,
          confidence: quickScore,
          reasoning: 'Exact match for specialty',
          estimatedTimeMs: 500,
          tier: 'keyword',
        };
      }

      // Medium confidence - try LLM if available
      if (this.handlers.evaluate) {
        return this.handlers.evaluate(task, context);
      }

      // No LLM, use quick score
      return {
        shouldBid: true,
        confidence: quickScore,
        reasoning: 'Partial keyword match',
        estimatedTimeMs: 1000,
        tier: 'keyword',
      };
    }

    // No quick match, try LLM
    if (this.handlers.evaluate) {
      return this.handlers.evaluate(task, context);
    }

    // No handlers - shouldn't happen
    return null;
  }

  private async handleTaskAssignment(msg: TaskAssignment): Promise<void> {
    console.log(`[Agent] Task assigned: ${msg.taskId} (backup: ${msg.isBackup})`);
    this.emit('task:assigned', { task: msg.task, isBackup: msg.isBackup });

    // Create abort controller
    const abortController = new AbortController();
    this.activeTasks.set(msg.taskId, abortController);

    // Set up timeout
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, msg.timeout);

    const context: ExecutionContext = {
      signal: abortController.signal,
      timeout: msg.timeout,
      attempt: msg.backupIndex + 1,
      isBackup: msg.isBackup,
      previousErrors: msg.previousErrors,
    };

    try {
      this.emit('task:executing', { taskId: msg.taskId });

      const startTime = Date.now();
      const result = await this.handlers.execute(msg.task, context);
      const durationMs = Date.now() - startTime;

      clearTimeout(timeoutId);
      this.activeTasks.delete(msg.taskId);

      // Send result
      const resultMsg: TaskResultMessage = {
        type: 'task_result',
        taskId: msg.taskId,
        agentId: this.config.name,
        result: {
          ...result,
          durationMs,
        },
      };

      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(resultMsg));
      }

      if (result.success) {
        console.log(`[Agent] Task completed: ${msg.taskId} (${durationMs}ms)`);
        this.emit('task:completed', { taskId: msg.taskId, success: true });
      } else {
        console.log(`[Agent] Task failed: ${msg.taskId} - ${result.error}`);
        this.emit('task:failed', { taskId: msg.taskId, error: result.error ?? 'Unknown error' });
      }

    } catch (error) {
      clearTimeout(timeoutId);
      this.activeTasks.delete(msg.taskId);

      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Agent] Task execution error:`, error);

      // Send failure result
      const resultMsg: TaskResultMessage = {
        type: 'task_result',
        taskId: msg.taskId,
        agentId: this.config.name,
        result: {
          success: false,
          error: errorMsg,
        },
      };

      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(resultMsg));
      }

      this.emit('task:failed', { taskId: msg.taskId, error: errorMsg });
    }
  }

  private handlePing(msg: PingMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const pong: PongMessage = { type: 'pong', timestamp: msg.timestamp };
      this.ws.send(JSON.stringify(pong));
    }
  }

  // === Getters ===

  get name(): string {
    return this.config.name;
  }

  get version(): string {
    return this.config.version;
  }

  get categories(): string[] {
    return this.config.categories;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get activeTaskCount(): number {
    return this.activeTasks.size;
  }
}
