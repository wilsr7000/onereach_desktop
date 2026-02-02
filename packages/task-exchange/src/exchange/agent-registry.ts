/**
 * Agent Registry - Manages connected agents
 */
import type WebSocket from 'ws';
import type { 
  ConnectedAgent, 
  AgentInfo, 
  AgentCapabilities,
  RegisterMessage 
} from '../types/index.js';
import { TypedEventEmitter } from '../utils/events.js';
import { CategoryIndex } from './categories.js';

interface AgentRegistryEvents {
  'agent:connected': { agent: ConnectedAgent };
  'agent:disconnected': { agentId: string; reason: string };
  'agent:unhealthy': { agentId: string };
  'agent:healthy': { agentId: string };
}

interface InternalAgent extends ConnectedAgent {
  ws: WebSocket;
}

export class AgentRegistry extends TypedEventEmitter<AgentRegistryEvents> {
  private agents: Map<string, InternalAgent> = new Map();
  private categoryIndex: CategoryIndex;
  private heartbeatTimeoutMs: number;

  constructor(categoryIndex: CategoryIndex, heartbeatTimeoutMs = 60000) {
    super();
    this.categoryIndex = categoryIndex;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
  }

  /**
   * Register a new agent connection
   */
  register(ws: WebSocket, msg: RegisterMessage): ConnectedAgent {
    const now = Date.now();

    // Check if agent already exists (reconnection)
    const existing = this.agents.get(msg.agentId);
    if (existing) {
      console.log(`[AgentRegistry] Agent ${msg.agentId} reconnecting, closing old connection`);
      try {
        existing.ws.close(1000, 'Reconnection from same agent');
      } catch {
        // Ignore errors closing old connection
      }
    }

    const agent: InternalAgent = {
      id: msg.agentId,
      name: msg.agentId,
      version: msg.agentVersion,
      categories: msg.categories,
      capabilities: msg.capabilities,
      connectedAt: now,
      lastHeartbeat: now,
      healthy: true,
      currentTasks: 0,
      ws,
    };

    this.agents.set(msg.agentId, agent);
    this.categoryIndex.addAgent(msg.agentId, msg.categories);

    console.log(`[AgentRegistry] Agent registered: ${msg.agentId} v${msg.agentVersion} (categories: ${msg.categories.join(', ')})`);

    // Return public agent info (without ws)
    const publicAgent: ConnectedAgent = { ...agent };
    delete (publicAgent as Partial<InternalAgent>).ws;
    
    this.emit('agent:connected', { agent: publicAgent });
    return publicAgent;
  }

  /**
   * Unregister an agent
   */
  unregister(agentId: string, reason = 'unknown'): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      this.agents.delete(agentId);
      this.categoryIndex.removeAgent(agentId);
      this.emit('agent:disconnected', { agentId, reason });
      console.log(`[AgentRegistry] Agent unregistered: ${agentId} (${reason})`);
    }
  }

  /**
   * Get agent by ID
   */
  get(agentId: string): ConnectedAgent | null {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    
    const publicAgent: ConnectedAgent = { ...agent };
    delete (publicAgent as Partial<InternalAgent>).ws;
    return publicAgent;
  }

  /**
   * Get WebSocket for an agent (internal use)
   */
  getSocket(agentId: string): WebSocket | null {
    return this.agents.get(agentId)?.ws ?? null;
  }

  /**
   * Update agent heartbeat
   */
  heartbeat(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      const wasUnhealthy = !agent.healthy;
      agent.lastHeartbeat = Date.now();
      agent.healthy = true;
      
      if (wasUnhealthy) {
        this.emit('agent:healthy', { agentId });
      }
    }
  }

  /**
   * Check for unhealthy agents
   */
  checkHealth(): string[] {
    const now = Date.now();
    const unhealthy: string[] = [];

    for (const [agentId, agent] of this.agents) {
      const timeSinceHeartbeat = now - agent.lastHeartbeat;
      if (timeSinceHeartbeat > this.heartbeatTimeoutMs && agent.healthy) {
        agent.healthy = false;
        unhealthy.push(agentId);
        this.emit('agent:unhealthy', { agentId });
        console.warn(`[AgentRegistry] Agent ${agentId} marked unhealthy (no heartbeat for ${timeSinceHeartbeat}ms)`);
      }
    }

    return unhealthy;
  }

  /**
   * Increment task count for an agent
   */
  incrementTaskCount(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.currentTasks++;
    }
  }

  /**
   * Decrement task count for an agent
   */
  decrementTaskCount(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent && agent.currentTasks > 0) {
      agent.currentTasks--;
    }
  }

  /**
   * Check if agent can accept more tasks
   */
  canAcceptTask(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    if (!agent.healthy) return false;
    return agent.currentTasks < agent.capabilities.maxConcurrent;
  }

  /**
   * Get all connected agents
   */
  getAll(): ConnectedAgent[] {
    return Array.from(this.agents.values()).map(agent => {
      const publicAgent: ConnectedAgent = { ...agent };
      delete (publicAgent as Partial<InternalAgent>).ws;
      return publicAgent;
    });
  }

  /**
   * Get healthy agents
   */
  getHealthy(): ConnectedAgent[] {
    return this.getAll().filter(a => a.healthy);
  }

  /**
   * Get agent count
   */
  getCount(): number {
    return this.agents.size;
  }

  /**
   * Check if an agent is connected
   */
  has(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  /**
   * Check if agent is healthy
   */
  isHealthy(agentId: string): boolean {
    return this.agents.get(agentId)?.healthy ?? false;
  }

  /**
   * Get summary for debugging
   */
  getSummary(): { total: number; healthy: number; agents: string[] } {
    const agents = Array.from(this.agents.values());
    return {
      total: agents.length,
      healthy: agents.filter(a => a.healthy).length,
      agents: agents.map(a => `${a.id} (v${a.version}, ${a.healthy ? 'healthy' : 'unhealthy'})`),
    };
  }
}
