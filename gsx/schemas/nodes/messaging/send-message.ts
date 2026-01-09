/**
 * SendMessage Node (Orchestrator)
 * 
 * The one true dispatcher for all channel messages.
 * Accepts ChannelEnvelope[], applies delivery policy, and dispatches to
 * channel-specific transport adapters.
 * 
 * Responsibilities:
 * - Apply quiet hours policy (defer, alternate, drop)
 * - Execute fallback channel ladder
 * - Enforce consent requirements
 * - Validate minimum auth level
 * - Handle retries with backoff
 * - Deduplicate via idempotency keys
 */

import { BaseNode, NodeInput, NodeOutput, NodeCategory } from '../base-node';
import { SessionPacket } from '../../session/session-packet';
import { ChannelEnvelope, createEnvelope } from '../../common/channel-envelope';
import { AuthLevel, Channel, DeliveryPolicy, ChannelConnectionState } from '../../common/types';

// ============ Node Parameters ============

export interface SendMessageParams {
  /** Envelopes to send (or use from context) */
  envelopes?: ChannelEnvelope[];
  
  /** Override delivery policy for all envelopes */
  delivery_policy_override?: Partial<DeliveryPolicy>;
  
  /** Whether to wait for delivery confirmation */
  await_delivery?: boolean;
  
  /** Global timeout for all deliveries */
  timeout_ms?: number;
}

// ============ Delivery Result ============

export interface DeliveryResult {
  envelope_id: string;
  channel: Channel;
  status: 'sent' | 'deferred' | 'dropped' | 'failed';
  timestamp: string;
  error?: string;
  fallback_used?: Channel;
}

// ============ Node Implementation ============

export class SendMessageNode extends BaseNode<SendMessageParams> {
  readonly nodeType = 'send-message';
  readonly nodeName = 'Send Message';
  readonly category: NodeCategory = 'messaging';
  readonly requiredAuthLevel: AuthLevel = 0;
  
  // Track processed idempotency keys to prevent duplicates
  private processedKeys = new Set<string>();
  
  protected async executeImpl(input: NodeInput<SendMessageParams>): Promise<NodeOutput> {
    const { session, config, context } = input;
    const params = config.params;
    
    // Get envelopes from params or context
    const envelopes = params.envelopes || (context?.envelopes as ChannelEnvelope[]) || [];
    
    if (envelopes.length === 0) {
      return this.createSuccessOutput(session, [], {
        context: { deliveries: [], message: 'No envelopes to send' }
      });
    }
    
    const results: DeliveryResult[] = [];
    const outputEnvelopes: ChannelEnvelope[] = [];
    
    for (const envelope of envelopes) {
      const result = await this.processEnvelope(session, envelope, params);
      results.push(result);
      
      if (result.status === 'sent' || result.status === 'deferred') {
        // Keep track of what was sent/queued
        outputEnvelopes.push(envelope);
      }
    }
    
    // Summarize results
    const sent = results.filter(r => r.status === 'sent').length;
    const deferred = results.filter(r => r.status === 'deferred').length;
    const dropped = results.filter(r => r.status === 'dropped').length;
    const failed = results.filter(r => r.status === 'failed').length;
    
    return {
      session,
      envelopes: outputEnvelopes,
      telemetry: {
        event_type: 'node_end',
        node_id: config.node_id,
        node_type: this.nodeType,
        session_id: session.session_id,
        timestamp: new Date().toISOString(),
        success: failed === 0,
        metrics: { sent, deferred, dropped, failed },
        context: { results }
      },
      context: {
        delivery_results: results,
        summary: { sent, deferred, dropped, failed }
      }
    };
  }
  
  /**
   * Process a single envelope through the delivery pipeline
   */
  private async processEnvelope(
    session: SessionPacket,
    envelope: ChannelEnvelope,
    params: SendMessageParams
  ): Promise<DeliveryResult> {
    const now = new Date();
    
    // 1. Check idempotency
    if (this.processedKeys.has(envelope.idempotency_key)) {
      return {
        envelope_id: envelope.envelope_id,
        channel: envelope.channel,
        status: 'dropped',
        timestamp: now.toISOString(),
        error: 'Duplicate idempotency key'
      };
    }
    this.processedKeys.add(envelope.idempotency_key);
    
    // 2. Apply policy override
    const policy = {
      ...envelope.delivery_policy,
      ...params.delivery_policy_override
    };
    
    // 3. Check TTL
    const createdAt = new Date(envelope.created_at);
    const expiresAt = new Date(createdAt.getTime() + envelope.ttl_seconds * 1000);
    if (now >= expiresAt) {
      return {
        envelope_id: envelope.envelope_id,
        channel: envelope.channel,
        status: 'dropped',
        timestamp: now.toISOString(),
        error: 'Message TTL expired'
      };
    }
    
    // 4. Check auth level
    if (policy.min_auth_level > session.clipboard.auth.auth_level) {
      return {
        envelope_id: envelope.envelope_id,
        channel: envelope.channel,
        status: 'dropped',
        timestamp: now.toISOString(),
        error: `Insufficient auth level: required ${policy.min_auth_level}, have ${session.clipboard.auth.auth_level}`
      };
    }
    
    // 5. Check consent
    for (const consent of policy.consent_required) {
      if (!this.hasConsent(session, consent)) {
        return {
          envelope_id: envelope.envelope_id,
          channel: envelope.channel,
          status: 'dropped',
          timestamp: now.toISOString(),
          error: `Missing required consent: ${consent}`
        };
      }
    }
    
    // 6. Check channel availability and quiet hours
    const channelState = session.channel_state[envelope.channel];
    const isQuietHours = channelState?.state === 'quiet_hours';
    
    if (isQuietHours) {
      switch (policy.quiet_hours) {
        case 'drop':
          return {
            envelope_id: envelope.envelope_id,
            channel: envelope.channel,
            status: 'dropped',
            timestamp: now.toISOString(),
            error: 'Dropped due to quiet hours'
          };
          
        case 'defer':
          return {
            envelope_id: envelope.envelope_id,
            channel: envelope.channel,
            status: 'deferred',
            timestamp: now.toISOString()
          };
          
        case 'alternate':
          // Try fallback channels
          return this.tryFallbackChannels(session, envelope, policy);
      }
    }
    
    // 7. Check channel reachability
    if (channelState?.state === 'unreachable') {
      return this.tryFallbackChannels(session, envelope, policy);
    }
    
    // 8. Dispatch to transport
    const deliveryResult = await this.dispatchToTransport(envelope);
    
    if (!deliveryResult.success && policy.retries.max > 0) {
      // Attempt retries
      return this.retryDelivery(envelope, policy, 1);
    }
    
    return {
      envelope_id: envelope.envelope_id,
      channel: envelope.channel,
      status: deliveryResult.success ? 'sent' : 'failed',
      timestamp: now.toISOString(),
      error: deliveryResult.error
    };
  }
  
  /**
   * Try fallback channels in order
   */
  private async tryFallbackChannels(
    session: SessionPacket,
    envelope: ChannelEnvelope,
    policy: DeliveryPolicy
  ): Promise<DeliveryResult> {
    for (const fallbackChannel of policy.fallback_channels) {
      const channelState = session.channel_state[fallbackChannel];
      
      // Skip if channel is also unavailable
      if (channelState?.state === 'unreachable' || channelState?.state === 'quiet_hours') {
        continue;
      }
      
      // Create envelope for fallback channel
      const fallbackEnvelope: ChannelEnvelope = {
        ...envelope,
        channel: fallbackChannel,
        envelope_id: `${envelope.envelope_id}_fb_${fallbackChannel}`
      };
      
      const result = await this.dispatchToTransport(fallbackEnvelope);
      
      if (result.success) {
        return {
          envelope_id: envelope.envelope_id,
          channel: fallbackChannel,
          status: 'sent',
          timestamp: new Date().toISOString(),
          fallback_used: fallbackChannel
        };
      }
    }
    
    // All fallbacks failed
    return {
      envelope_id: envelope.envelope_id,
      channel: envelope.channel,
      status: 'failed',
      timestamp: new Date().toISOString(),
      error: 'All channels exhausted'
    };
  }
  
  /**
   * Retry delivery with backoff
   */
  private async retryDelivery(
    envelope: ChannelEnvelope,
    policy: DeliveryPolicy,
    attempt: number
  ): Promise<DeliveryResult> {
    if (attempt > policy.retries.max) {
      return {
        envelope_id: envelope.envelope_id,
        channel: envelope.channel,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: 'Max retries exceeded'
      };
    }
    
    // Calculate backoff
    const backoffMs = policy.retries.backoff_ms * 
      Math.pow(policy.retries.backoff_multiplier || 2, attempt - 1);
    
    // Wait for backoff
    await new Promise(resolve => setTimeout(resolve, backoffMs));
    
    // Retry
    const result = await this.dispatchToTransport(envelope);
    
    if (result.success) {
      return {
        envelope_id: envelope.envelope_id,
        channel: envelope.channel,
        status: 'sent',
        timestamp: new Date().toISOString()
      };
    }
    
    // Recurse
    return this.retryDelivery(envelope, policy, attempt + 1);
  }
  
  /**
   * Check if session has required consent
   */
  private hasConsent(session: SessionPacket, consentType: string): boolean {
    const consent = session.clipboard.consent;
    
    switch (consentType) {
      case 'recording':
        return consent.recording_consent === 'granted';
      case 'sms':
        return consent.sms_opt_in === 'granted';
      case 'email_marketing':
        return consent.email_marketing === 'granted';
      case 'data_processing':
        return consent.data_processing === 'granted';
      default:
        return consent.custom_consents[consentType]?.status === 'granted';
    }
  }
  
  /**
   * Dispatch envelope to channel transport
   * In real implementation, this calls the appropriate transport node
   */
  private async dispatchToTransport(envelope: ChannelEnvelope): Promise<{ success: boolean; error?: string }> {
    // This is where we'd call the actual transport adapters:
    // - DeliverSMS
    // - DeliverEmail
    // - DeliverVoice
    // - etc.
    
    // For now, simulate successful delivery
    console.log(`[SendMessage] Dispatching to ${envelope.channel}:`, envelope.content);
    
    // Simulate occasional failure for testing
    // const shouldFail = Math.random() < 0.1;
    // if (shouldFail) {
    //   return { success: false, error: 'Transport error' };
    // }
    
    return { success: true };
  }
}

// Register the node
import { registerNode } from '../base-node';
registerNode('send-message', SendMessageNode as any);

export default SendMessageNode;


