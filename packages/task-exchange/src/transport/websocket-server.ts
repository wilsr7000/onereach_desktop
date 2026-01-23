/**
 * WebSocket Server Transport
 */
import { WebSocketServer, WebSocket } from 'ws';
import type {
  ProtocolMessage,
  RegisterMessage,
  RegisteredMessage,
  BidResponse,
  TaskResultMessage,
  PongMessage,
  ErrorMessage,
} from '../types/index.js';
import { PROTOCOL_VERSION } from '../types/index.js';
import { Exchange } from '../exchange/exchange.js';

export interface WebSocketTransportConfig {
  port: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
}

export class WebSocketTransport {
  private wss: WebSocketServer | null = null;
  private exchange: Exchange;
  private config: WebSocketTransportConfig;
  private socketToAgent: Map<WebSocket, string> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(exchange: Exchange, config: WebSocketTransportConfig) {
    this.exchange = exchange;
    this.config = config;
  }

  async start(): Promise<void> {
    this.wss = new WebSocketServer({ port: this.config.port });

    this.wss.on('connection', (ws) => {
      console.log('[WebSocket] New connection');
      this.handleConnection(ws);
    });

    this.wss.on('error', (error) => {
      console.error('[WebSocket] Server error:', error);
    });

    // Start heartbeat checking
    this.heartbeatInterval = setInterval(() => {
      this.exchange.agents.checkHealth();
    }, this.config.heartbeatIntervalMs);

    console.log(`[WebSocket] Server listening on port ${this.config.port}`);
  }

  async stop(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.wss) {
      // Close all connections
      for (const ws of this.wss.clients) {
        ws.close(1001, 'Server shutting down');
      }

      await new Promise<void>((resolve) => {
        this.wss!.close(() => {
          console.log('[WebSocket] Server stopped');
          resolve();
        });
      });

      this.wss = null;
    }
  }

  private handleConnection(ws: WebSocket): void {
    let registeredAgentId: string | null = null;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ProtocolMessage;
        
        switch (msg.type) {
          case 'register':
            registeredAgentId = this.handleRegister(ws, msg as RegisterMessage);
            break;

          case 'bid_response':
            this.handleBidResponse(msg as BidResponse);
            break;

          case 'task_result':
            this.handleTaskResult(msg as TaskResultMessage);
            break;

          case 'pong':
            this.handlePong(registeredAgentId, msg as PongMessage);
            break;

          default:
            console.warn('[WebSocket] Unknown message type:', (msg as { type: string }).type);
        }
      } catch (error) {
        console.error('[WebSocket] Failed to parse message:', error);
        this.sendError(ws, 'PARSE_ERROR', 'Failed to parse message');
      }
    });

    ws.on('close', (code, reason) => {
      const reasonStr = reason?.toString() || 'unknown';
      console.log(`[WebSocket] Connection closed: ${code} - ${reasonStr}`);

      if (registeredAgentId) {
        this.socketToAgent.delete(ws);
        this.exchange.agents.unregister(registeredAgentId, reasonStr);
      }
    });

    ws.on('error', (error) => {
      console.error('[WebSocket] Connection error:', error);
    });

    // Send a ping to verify connection
    ws.ping();
  }

  private handleRegister(ws: WebSocket, msg: RegisterMessage): string {
    // Check protocol version
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      console.warn(`[WebSocket] Protocol mismatch: ${msg.protocolVersion} vs ${PROTOCOL_VERSION}`);
      // For now, allow minor version differences
    }

    // Register agent
    const agent = this.exchange.agents.register(ws, msg);
    this.socketToAgent.set(ws, agent.id);

    // Send confirmation
    const response: RegisteredMessage = {
      type: 'registered',
      protocolVersion: PROTOCOL_VERSION,
      agentId: agent.id,
      config: {
        heartbeatIntervalMs: this.config.heartbeatIntervalMs,
        defaultTimeoutMs: 30000,
      },
    };

    ws.send(JSON.stringify(response));

    return agent.id;
  }

  private handleBidResponse(msg: BidResponse): void {
    this.exchange.handleBidResponse(msg);
  }

  private handleTaskResult(msg: TaskResultMessage): void {
    this.exchange.handleTaskResult(msg);
  }

  private handlePong(agentId: string | null, _msg: PongMessage): void {
    if (agentId) {
      this.exchange.agents.heartbeat(agentId);
    }
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    const error: ErrorMessage = {
      type: 'error',
      code,
      message,
    };
    ws.send(JSON.stringify(error));
  }

  /**
   * Broadcast a message to all connected agents
   */
  broadcast(msg: ProtocolMessage): void {
    if (!this.wss) return;

    const data = JSON.stringify(msg);
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  /**
   * Send a message to a specific agent
   */
  sendToAgent(agentId: string, msg: ProtocolMessage): boolean {
    const ws = this.exchange.agents.getSocket(agentId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /**
   * Get connection count
   */
  getConnectionCount(): number {
    return this.wss?.clients.size ?? 0;
  }
}
