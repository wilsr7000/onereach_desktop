/**
 * @onereach/task-exchange
 * 
 * Auction-based task exchange with reputation scoring and HUD
 */

// Types
export * from './types/index.js';

// Core classes
export { Exchange } from './exchange/exchange.js';
export { OrderBook } from './exchange/order-book.js';
export { CategoryIndex } from './exchange/categories.js';
export { AgentRegistry } from './exchange/agent-registry.js';

// Reputation
export { ReputationStore } from './reputation/store.js';

// Queue
export { PriorityQueue } from './queue/priority-queue.js';
export { RateLimiter } from './queue/rate-limiter.js';

// Storage
export type { StorageAdapter } from './storage/adapter.js';
export { MemoryStorage } from './storage/memory.js';
export { FileStorage } from './storage/file.js';

// Transport
export { WebSocketTransport } from './transport/websocket-server.js';

// Utils
export { Mutex } from './utils/mutex.js';
export { TypedEventEmitter } from './utils/events.js';

// === Factory Function ===

import type { ExchangeConfig } from './types/index.js';
import { Exchange } from './exchange/exchange.js';
import { MemoryStorage } from './storage/memory.js';
import { FileStorage } from './storage/file.js';
import { WebSocketTransport } from './transport/websocket-server.js';

export interface CreateExchangeOptions extends Partial<ExchangeConfig> {
  categories: ExchangeConfig['categories'];
  /** Auto-start the exchange (default: true) */
  autoStart?: boolean;
}

const DEFAULT_CONFIG: Omit<ExchangeConfig, 'categories'> = {
  port: 3000,
  transport: 'websocket',
  storage: 'memory',
  auction: {
    defaultWindowMs: 1000,
    minWindowMs: 100,
    maxWindowMs: 5000,
    instantWinThreshold: 0.85,
    dominanceMargin: 0.3,
    maxAuctionAttempts: 3,
    executionTimeoutMs: 30000,
  },
  reputation: {
    initialScore: 1.0,
    successIncrement: 0.05,
    failureDecrement: 0.15,
    timeoutDecrement: 0.20,
    maxScore: 1.0,
    minScore: 0.1,
    flagThreshold: 0.3,
    decayRate: 0.01,
    neutralScore: 0.7,
    versionResetCooldown: 86400000,
    conservativeBidPenalty: 0.02,
    conservativeBidThreshold: 0.3,
  },
  rateLimit: {
    maxTasksPerMinute: 100,
    maxTasksPerAgent: 20,
    maxConcurrentAuctions: 10,
    burstAllowance: 2,
  },
  heartbeatIntervalMs: 30000,
  heartbeatTimeoutMs: 60000,
};

/**
 * Create and configure an Exchange instance
 */
export async function createExchange(options: CreateExchangeOptions): Promise<{
  exchange: Exchange;
  transport: WebSocketTransport | null;
  start: () => Promise<void>;
  shutdown: (timeoutMs?: number) => Promise<void>;
}> {
  const config: ExchangeConfig = {
    ...DEFAULT_CONFIG,
    ...options,
    auction: { ...DEFAULT_CONFIG.auction, ...options.auction },
    reputation: { ...DEFAULT_CONFIG.reputation, ...options.reputation },
    rateLimit: { ...DEFAULT_CONFIG.rateLimit, ...options.rateLimit },
  };

  // Create storage adapter
  let storage;
  if (config.storage === 'file') {
    storage = new FileStorage(config.storagePath ?? './data');
    await storage.init();
  } else {
    storage = new MemoryStorage();
  }

  // Create exchange
  const exchange = new Exchange(config, storage);

  // Create transport if using websocket
  let transport: WebSocketTransport | null = null;
  if (config.transport === 'websocket') {
    transport = new WebSocketTransport(exchange, {
      port: config.port,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    });
  }

  // Start function
  const start = async () => {
    if (transport) {
      await transport.start();
    }
    await exchange.start();
  };

  // Shutdown function
  const shutdown = async (timeoutMs?: number) => {
    await exchange.shutdown(timeoutMs);
    if (transport) {
      await transport.stop();
    }
  };

  // Auto-start if not disabled
  if (options.autoStart !== false) {
    await start();
  }

  return { exchange, transport, start, shutdown };
}
