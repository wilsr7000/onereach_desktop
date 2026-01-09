/**
 * ChannelEnvelope - Universal Output Wrapper
 * 
 * Every node emits ChannelEnvelope[] rather than raw strings.
 * This provides channel-agnostic output that can be rendered
 * and delivered appropriately for each channel.
 */

import {
  Channel,
  Audience,
  Priority,
  StructuredContent,
  RenderHints,
  DeliveryPolicy,
  AuthLevel
} from './types';

export interface ChannelEnvelope {
  /** Unique identifier for this envelope */
  envelope_id: string;
  
  /** Correlation ID tying message to plan step / event */
  correlation_id: string;
  
  /** Prevents double sends during retries */
  idempotency_key: string;
  
  /** Target channel for delivery */
  channel: Channel;
  
  /** Who should receive this message */
  audience: Audience;
  
  /** Delivery urgency */
  priority: Priority;
  
  /** Time-to-live in seconds (message expires after this) */
  ttl_seconds: number;
  
  /** The actual content to deliver */
  content: StructuredContent;
  
  /** Hints for channel-specific rendering */
  render_hints: RenderHints;
  
  /** Policy for delivery handling */
  delivery_policy: DeliveryPolicy;
  
  /** Minimum authentication level required to receive this */
  min_auth_level?: AuthLevel;
  
  /** Timestamp when envelope was created */
  created_at: string;
  
  /** Optional metadata for tracking */
  metadata?: Record<string, unknown>;
}

/**
 * Factory function to create a new ChannelEnvelope with defaults
 */
export function createEnvelope(
  params: Partial<ChannelEnvelope> & Pick<ChannelEnvelope, 'channel' | 'content'>
): ChannelEnvelope {
  const now = new Date().toISOString();
  return {
    envelope_id: `env_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    correlation_id: params.correlation_id || '',
    idempotency_key: params.idempotency_key || `idem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    audience: 'user',
    priority: 'now',
    ttl_seconds: 3600, // 1 hour default
    render_hints: {},
    delivery_policy: {
      quiet_hours: 'defer',
      fallback_channels: [],
      retries: { max: 3, backoff_ms: 1000 },
      consent_required: [],
      min_auth_level: 0
    },
    created_at: now,
    ...params
  };
}

/**
 * Helper to create a simple text envelope
 */
export function textEnvelope(
  channel: Channel,
  text: string,
  options?: Partial<Omit<ChannelEnvelope, 'channel' | 'content'>>
): ChannelEnvelope {
  return createEnvelope({
    channel,
    content: { type: 'text', text },
    ...options
  });
}


