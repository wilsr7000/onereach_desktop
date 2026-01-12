/**
 * Base Node Interface
 * 
 * All GSX nodes implement this interface, providing a consistent
 * execution model across all node types.
 * 
 * Layering Rules:
 * - Logic nodes: Produce structured decisions + drafts + state changes
 * - Render nodes: Convert StructuredContentDraft → channel-specific StructuredContent
 * - Transport nodes: Deliver only; they do not decide or format
 * - SendMessage (orchestrator): Only node that applies delivery policy
 */

import { SessionPacket } from '../session/session-packet';
import { ChannelEnvelope } from '../common/channel-envelope';
import { TelemetryEvent, nodeStartEvent, nodeEndEvent } from '../common/telemetry-event';
import { AuthLevel } from '../common/types';

// ============ Node Configuration ============

export interface NodeConfig {
  /** Unique instance ID for this node execution */
  node_id: string;
  
  /** Node type identifier */
  node_type: string;
  
  /** Maximum execution time in milliseconds */
  timeout_ms?: number;
  
  /** Whether to emit telemetry */
  emit_telemetry?: boolean;
  
  /** Node-specific configuration */
  params: Record<string, unknown>;
}

// ============ Node Input/Output ============

export interface NodeInput<TParams = Record<string, unknown>> {
  /** Current session state */
  session: SessionPacket;
  
  /** Node configuration */
  config: NodeConfig & { params: TParams };
  
  /** Context from previous node (if chained) */
  context?: Record<string, unknown>;
}

export interface NodeOutput {
  /** Updated session state */
  session: SessionPacket;
  
  /** Envelopes to be delivered */
  envelopes: ChannelEnvelope[];
  
  /** Telemetry event for this execution */
  telemetry: TelemetryEvent;
  
  /** Next step ID to execute (for branching) */
  next_step?: string;
  
  /** Context to pass to next node */
  context?: Record<string, unknown>;
  
  /** Error if execution failed */
  error?: NodeError;
}

export interface NodeError {
  /** Error code */
  code: string;
  
  /** Human-readable message */
  message: string;
  
  /** Whether the error is recoverable */
  recoverable: boolean;
  
  /** Additional error details */
  details?: Record<string, unknown>;
}

// ============ Node Interface ============

export interface GSXNode<TParams = Record<string, unknown>> {
  /** Node type identifier */
  readonly nodeType: string;
  
  /** Human-readable node name */
  readonly nodeName: string;
  
  /** Node category */
  readonly category: NodeCategory;
  
  /** Required auth level to execute this node (0 = none) */
  readonly requiredAuthLevel: AuthLevel;
  
  /** Execute the node */
  execute(input: NodeInput<TParams>): Promise<NodeOutput>;
  
  /** Validate node configuration */
  validateConfig?(config: NodeConfig & { params: TParams }): ValidationResult;
}

export type NodeCategory = 
  | 'plan-control'
  | 'logic'
  | 'identity-security'
  | 'routing'
  | 'messaging'
  | 'render'
  | 'transport';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ============ Base Node Implementation ============

/**
 * Abstract base class for all GSX nodes
 * Provides common functionality and enforces the contract
 */
export abstract class BaseNode<TParams = Record<string, unknown>> implements GSXNode<TParams> {
  abstract readonly nodeType: string;
  abstract readonly nodeName: string;
  abstract readonly category: NodeCategory;
  readonly requiredAuthLevel: AuthLevel = 0;
  
  /**
   * Main entry point - wraps executeImpl with telemetry and error handling
   */
  async execute(input: NodeInput<TParams>): Promise<NodeOutput> {
    const startTime = Date.now();
    const { session, config } = input;
    
    // Emit start telemetry
    const startTelemetry = nodeStartEvent(
      config.node_id,
      this.nodeType,
      session.session_id,
      session.plan_state?.current_step || undefined
    );
    
    try {
      // Check auth level if required
      if (this.requiredAuthLevel > 0) {
        const authCheck = this.checkAuthLevel(session);
        if (!authCheck.authorized) {
          return this.createErrorOutput(
            session,
            {
              code: 'AUTH_INSUFFICIENT',
              message: `Node requires auth level ${this.requiredAuthLevel}, current level is ${session.clipboard.auth.auth_level}`,
              recoverable: true,
              details: { required: this.requiredAuthLevel, current: session.clipboard.auth.auth_level }
            },
            startTime
          );
        }
      }
      
      // Execute the node implementation
      const result = await this.executeImpl(input);
      
      // Update telemetry with success
      const latency = Date.now() - startTime;
      result.telemetry = nodeEndEvent(
        config.node_id,
        this.nodeType,
        session.session_id,
        latency,
        true
      );
      
      return result;
      
    } catch (error) {
      const latency = Date.now() - startTime;
      const nodeError: NodeError = {
        code: 'NODE_EXECUTION_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
        recoverable: false,
        details: error instanceof Error ? { stack: error.stack } : undefined
      };
      
      return this.createErrorOutput(session, nodeError, startTime);
    }
  }
  
  /**
   * Node-specific implementation - override this in subclasses
   */
  protected abstract executeImpl(input: NodeInput<TParams>): Promise<NodeOutput>;
  
  /**
   * Check if session meets auth requirements
   */
  protected checkAuthLevel(session: SessionPacket): { authorized: boolean; reason?: string } {
    const { auth } = session.clipboard;
    
    // Check level
    if (auth.auth_level < this.requiredAuthLevel) {
      return { authorized: false, reason: 'Insufficient auth level' };
    }
    
    // Check expiration
    const now = new Date();
    const expires = new Date(auth.expires_at);
    if (now >= expires) {
      return { authorized: false, reason: 'Auth expired' };
    }
    
    return { authorized: true };
  }
  
  /**
   * Create an error output
   */
  protected createErrorOutput(
    session: SessionPacket,
    error: NodeError,
    startTime: number
  ): NodeOutput {
    const latency = Date.now() - startTime;
    return {
      session,
      envelopes: [],
      telemetry: {
        event_type: 'node_error',
        node_id: 'unknown',
        node_type: this.nodeType,
        session_id: session.session_id,
        timestamp: new Date().toISOString(),
        latency_ms: latency,
        success: false,
        error: { code: error.code, message: error.message }
      },
      error
    };
  }
  
  /**
   * Create a success output
   */
  protected createSuccessOutput(
    session: SessionPacket,
    envelopes: ChannelEnvelope[] = [],
    options?: {
      next_step?: string;
      context?: Record<string, unknown>;
    }
  ): NodeOutput {
    return {
      session,
      envelopes,
      telemetry: {
        event_type: 'node_end',
        node_id: 'unknown', // Will be set by execute()
        node_type: this.nodeType,
        session_id: session.session_id,
        timestamp: new Date().toISOString(),
        success: true
      },
      next_step: options?.next_step,
      context: options?.context
    };
  }
  
  /**
   * Optional config validation
   */
  validateConfig?(config: NodeConfig & { params: TParams }): ValidationResult {
    return { valid: true, errors: [] };
  }
}

// ============ Node Registry ============

export type NodeConstructor<TParams = Record<string, unknown>> = new () => GSXNode<TParams>;

const nodeRegistry = new Map<string, NodeConstructor>();

/**
 * Register a node type
 */
export function registerNode(nodeType: string, constructor: NodeConstructor): void {
  nodeRegistry.set(nodeType, constructor);
}

/**
 * Get a node constructor by type
 */
export function getNodeConstructor(nodeType: string): NodeConstructor | undefined {
  return nodeRegistry.get(nodeType);
}

/**
 * Create a node instance by type
 */
export function createNode(nodeType: string): GSXNode | undefined {
  const Constructor = nodeRegistry.get(nodeType);
  if (!Constructor) return undefined;
  return new Constructor();
}

/**
 * List all registered node types
 */
export function listNodeTypes(): string[] {
  return Array.from(nodeRegistry.keys());
}



