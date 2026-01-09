/**
 * TelemetryEvent - Required interface for all nodes
 * 
 * All nodes must emit telemetry events for observability,
 * debugging, and compliance tracking.
 */

export type TelemetryEventType = 
  | 'node_start'
  | 'node_end'
  | 'node_error'
  | 'channel_switch'
  | 'auth_stepup'
  | 'policy_violation'
  | 'handoff'
  | 'fallback'
  | 'custom';

export interface TelemetryEvent {
  /** Type of telemetry event */
  event_type: TelemetryEventType;
  
  /** Node that emitted this event */
  node_id: string;
  
  /** Node type (e.g., 'verify-identity', 'send-message') */
  node_type: string;
  
  /** Session ID for correlation */
  session_id: string;
  
  /** Plan step ID if applicable */
  step_id?: string;
  
  /** ISO timestamp of event */
  timestamp: string;
  
  /** Execution latency in milliseconds */
  latency_ms?: number;
  
  /** Confidence score (0-1) for AI/ML decisions */
  confidence?: number;
  
  /** Reason for fallback if applicable */
  fallback_reason?: string;
  
  /** Reason for handoff if applicable */
  handoff_reason?: string;
  
  /** Whether auth step-up was triggered */
  auth_stepup_triggered?: boolean;
  
  /** From/to auth levels if step-up occurred */
  auth_stepup_from?: number;
  auth_stepup_to?: number;
  
  /** Policy violation details if any */
  policy_violation?: {
    policy_id: string;
    rule_id: string;
    action_taken: 'blocked' | 'warned' | 'logged';
    message: string;
  };
  
  /** Channel involved */
  channel?: string;
  
  /** Success/failure status */
  success: boolean;
  
  /** Error details if failed */
  error?: {
    code: string;
    message: string;
    stack?: string;
  };
  
  /** Custom metrics */
  metrics?: Record<string, number>;
  
  /** Custom tags for filtering */
  tags?: Record<string, string>;
  
  /** Additional context */
  context?: Record<string, unknown>;
}

/**
 * Factory function to create a telemetry event
 */
export function createTelemetryEvent(
  params: Partial<TelemetryEvent> & Pick<TelemetryEvent, 'event_type' | 'node_id' | 'node_type' | 'session_id' | 'success'>
): TelemetryEvent {
  return {
    timestamp: new Date().toISOString(),
    ...params
  };
}

/**
 * Create a node_start event
 */
export function nodeStartEvent(
  node_id: string,
  node_type: string,
  session_id: string,
  step_id?: string
): TelemetryEvent {
  return createTelemetryEvent({
    event_type: 'node_start',
    node_id,
    node_type,
    session_id,
    step_id,
    success: true
  });
}

/**
 * Create a node_end event
 */
export function nodeEndEvent(
  node_id: string,
  node_type: string,
  session_id: string,
  latency_ms: number,
  success: boolean,
  error?: { code: string; message: string }
): TelemetryEvent {
  return createTelemetryEvent({
    event_type: 'node_end',
    node_id,
    node_type,
    session_id,
    latency_ms,
    success,
    error
  });
}


