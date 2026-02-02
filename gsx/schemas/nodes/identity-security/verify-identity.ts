/**
 * VerifyIdentity Node
 * 
 * Checks the clipboard for existing auth state and validates auth level.
 * If auth is sufficient and not expired, passes through without re-auth.
 * If auth is insufficient, triggers step-up authentication.
 * 
 * This is the gateway node for any action requiring identity verification.
 */

import { BaseNode, NodeInput, NodeOutput, NodeCategory } from '../base-node';
import { SessionPacket } from '../../session/session-packet';
import { ChannelEnvelope, textEnvelope } from '../../common/channel-envelope';
import { AuthLevel, AuthMethod } from '../../common/types';
import { meetsAuthRequirement, updateAuthState } from '../../session/memory-clipboard';

// ============ Node Parameters ============

export interface VerifyIdentityParams {
  /** Required authentication level (0-3) */
  required_level: AuthLevel;
  
  /** Allowed authentication methods for this verification */
  allowed_methods?: AuthMethod[];
  
  /** Custom prompt for authentication request */
  auth_prompt?: string;
  
  /** Whether to allow cached/clipboard auth */
  allow_cached: boolean;
  
  /** Step to jump to if auth fails */
  on_failure_step?: string;
  
  /** Step to jump to for step-up auth */
  on_stepup_step?: string;
  
  /** Maximum retries before failure */
  max_retries?: number;
}

// ============ Node Implementation ============

export class VerifyIdentityNode extends BaseNode<VerifyIdentityParams> {
  readonly nodeType = 'verify-identity';
  readonly nodeName = 'Verify Identity';
  readonly category: NodeCategory = 'identity-security';
  readonly requiredAuthLevel: AuthLevel = 0; // This node doesn't require auth itself
  
  protected async executeImpl(input: NodeInput<VerifyIdentityParams>): Promise<NodeOutput> {
    const { session, config } = input;
    const params = config.params;
    
    // Check if current auth meets requirements
    if (params.allow_cached && meetsAuthRequirement(session.clipboard, params.required_level)) {
      // Auth is sufficient - pass through without re-auth
      return this.createSuccessOutput(session, [], {
        context: {
          auth_verified: true,
          auth_level: session.clipboard.auth.auth_level,
          method: 'cached'
        }
      });
    }
    
    // Check if auth level is sufficient but expired
    const isExpired = new Date() >= new Date(session.clipboard.auth.expires_at);
    const levelSufficient = session.clipboard.auth.auth_level >= params.required_level;
    
    if (levelSufficient && isExpired) {
      // Level is good but expired - need refresh
      return this.createStepUpRequired(session, params, 'auth_expired');
    }
    
    if (!levelSufficient) {
      // Level is insufficient - need step-up
      return this.createStepUpRequired(session, params, 'level_insufficient');
    }
    
    // Shouldn't reach here, but handle gracefully
    return this.createSuccessOutput(session, [], {
      context: {
        auth_verified: true,
        auth_level: session.clipboard.auth.auth_level
      }
    });
  }
  
  /**
   * Create output indicating step-up is required
   */
  private createStepUpRequired(
    session: SessionPacket,
    params: VerifyIdentityParams,
    reason: string
  ): NodeOutput {
    const envelopes: ChannelEnvelope[] = [];
    
    // Add prompt envelope if we're initiating step-up
    if (params.auth_prompt) {
      envelopes.push(
        textEnvelope(
          session.metadata.primary_channel as any || 'chat',
          params.auth_prompt,
          {
            correlation_id: session.telemetry.correlation_id,
            delivery_policy: {
              quiet_hours: 'defer',
              fallback_channels: [],
              retries: { max: 1, backoff_ms: 1000 },
              consent_required: [],
              min_auth_level: 0
            }
          }
        )
      );
    }
    
    return {
      session,
      envelopes,
      telemetry: {
        event_type: 'auth_stepup',
        node_id: 'verify-identity',
        node_type: this.nodeType,
        session_id: session.session_id,
        timestamp: new Date().toISOString(),
        success: true, // Node succeeded - it correctly identified need for step-up
        auth_stepup_triggered: true,
        auth_stepup_from: session.clipboard.auth.auth_level,
        auth_stepup_to: params.required_level,
        context: { reason }
      },
      next_step: params.on_stepup_step,
      context: {
        auth_verified: false,
        stepup_required: true,
        required_level: params.required_level,
        current_level: session.clipboard.auth.auth_level,
        reason,
        allowed_methods: params.allowed_methods
      }
    };
  }
  
  validateConfig(config: { params: VerifyIdentityParams }): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const { params } = config;
    
    if (params.required_level < 0 || params.required_level > 3) {
      errors.push('required_level must be between 0 and 3');
    }
    
    return { valid: errors.length === 0, errors };
  }
}

// Register the node
import { registerNode } from '../base-node';
registerNode('verify-identity', VerifyIdentityNode as any);

export default VerifyIdentityNode;



