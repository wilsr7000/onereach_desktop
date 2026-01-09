/**
 * StepUpAuth Node
 * 
 * Raises authentication level using channel-appropriate methods.
 * Updates the clipboard with new auth state after successful verification.
 * 
 * Supports multiple auth methods:
 * - voice_pin: Voice PIN verification
 * - sms_otp: SMS one-time password
 * - email_magic_link: Email magic link
 * - biometric: Biometric verification (app-based)
 * - knowledge_based: KBA questions
 */

import { BaseNode, NodeInput, NodeOutput, NodeCategory } from '../base-node';
import { SessionPacket } from '../../session/session-packet';
import { ChannelEnvelope, textEnvelope, createEnvelope } from '../../common/channel-envelope';
import { AuthLevel, AuthMethod, Channel } from '../../common/types';
import { updateAuthState, AssuranceTag } from '../../session/memory-clipboard';

// ============ Node Parameters ============

export interface StepUpAuthParams {
  /** Target authentication level to achieve */
  target_level: AuthLevel;
  
  /** Preferred authentication method */
  preferred_method: AuthMethod;
  
  /** Fallback methods if preferred is unavailable */
  fallback_methods?: AuthMethod[];
  
  /** How long the auth should be valid (minutes) */
  ttl_minutes?: number;
  
  /** Custom prompts for each method */
  prompts?: Partial<Record<AuthMethod, string>>;
  
  /** Maximum attempts before lockout */
  max_attempts?: number;
  
  /** Step to jump to on success */
  on_success_step?: string;
  
  /** Step to jump to on failure */
  on_failure_step?: string;
}

// ============ Default Prompts ============

const DEFAULT_PROMPTS: Record<AuthMethod, string> = {
  voice_pin: 'Please enter your 4-digit PIN using your keypad.',
  sms_otp: 'We\'ve sent a verification code to your phone. Please enter the 6-digit code.',
  email_magic_link: 'We\'ve sent a verification link to your email. Please click the link to continue.',
  biometric: 'Please verify your identity using Face ID or Touch ID.',
  knowledge_based: 'For security, please answer the following verification question.',
  device_trust: 'Please confirm this is your trusted device.',
  caller_id: 'Verifying your caller ID...',
  none: ''
};

// ============ Node Implementation ============

export class StepUpAuthNode extends BaseNode<StepUpAuthParams> {
  readonly nodeType = 'step-up-auth';
  readonly nodeName = 'Step Up Authentication';
  readonly category: NodeCategory = 'identity-security';
  readonly requiredAuthLevel: AuthLevel = 0;
  
  protected async executeImpl(input: NodeInput<StepUpAuthParams>): Promise<NodeOutput> {
    const { session, config, context } = input;
    const params = config.params;
    
    // Check if we're processing a response (user provided auth input)
    if (context?.auth_response) {
      return this.processAuthResponse(session, params, context);
    }
    
    // Determine best auth method for current channel
    const method = this.selectAuthMethod(session, params);
    if (!method) {
      return this.createErrorOutput(session, {
        code: 'NO_AUTH_METHOD',
        message: 'No suitable authentication method available for current channel',
        recoverable: true,
        details: { 
          channel: session.metadata.primary_channel,
          tried_methods: [params.preferred_method, ...(params.fallback_methods || [])]
        }
      }, Date.now());
    }
    
    // Generate auth challenge
    const challenge = this.generateChallenge(session, method, params);
    
    // Update session with pending auth state
    const updatedSession: SessionPacket = {
      ...session,
      memory: {
        ...session.memory,
        active: {
          ...session.memory.active,
          scratch: {
            ...session.memory.active.scratch,
            pending_auth: {
              method,
              target_level: params.target_level,
              challenge_id: challenge.challenge_id,
              attempts: 0,
              max_attempts: params.max_attempts || 3,
              started_at: new Date().toISOString()
            }
          }
        }
      }
    };
    
    return {
      session: updatedSession,
      envelopes: challenge.envelopes,
      telemetry: {
        event_type: 'auth_stepup',
        node_id: config.node_id,
        node_type: this.nodeType,
        session_id: session.session_id,
        timestamp: new Date().toISOString(),
        success: true,
        auth_stepup_triggered: true,
        auth_stepup_from: session.clipboard.auth.auth_level,
        auth_stepup_to: params.target_level,
        context: { method, challenge_type: challenge.type }
      },
      context: {
        awaiting_auth: true,
        method,
        challenge_id: challenge.challenge_id
      }
    };
  }
  
  /**
   * Select the best auth method for the current channel
   */
  private selectAuthMethod(session: SessionPacket, params: StepUpAuthParams): AuthMethod | null {
    const channel = session.metadata.primary_channel as Channel;
    const allMethods = [params.preferred_method, ...(params.fallback_methods || [])];
    
    // Method compatibility by channel
    const channelMethods: Record<Channel, AuthMethod[]> = {
      voice: ['voice_pin', 'knowledge_based', 'caller_id'],
      sms: ['sms_otp', 'knowledge_based'],
      email: ['email_magic_link', 'knowledge_based'],
      chat: ['sms_otp', 'email_magic_link', 'knowledge_based'],
      push: ['biometric', 'device_trust'],
      agent_desktop: ['knowledge_based', 'sms_otp']
    };
    
    const compatible = channelMethods[channel] || ['knowledge_based'];
    
    // Find first compatible method
    for (const method of allMethods) {
      if (compatible.includes(method)) {
        return method;
      }
    }
    
    return null;
  }
  
  /**
   * Generate authentication challenge
   */
  private generateChallenge(
    session: SessionPacket,
    method: AuthMethod,
    params: StepUpAuthParams
  ): { challenge_id: string; type: string; envelopes: ChannelEnvelope[] } {
    const challenge_id = `auth_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const channel = session.metadata.primary_channel as Channel || 'chat';
    const prompt = params.prompts?.[method] || DEFAULT_PROMPTS[method];
    
    const envelopes: ChannelEnvelope[] = [];
    
    switch (method) {
      case 'voice_pin':
        envelopes.push(createEnvelope({
          channel: 'voice',
          content: {
            type: 'ssml',
            ssml: `<speak>${prompt}</speak>`,
            fallback_text: prompt
          },
          render_hints: { barge_in: true },
          correlation_id: session.telemetry.correlation_id
        }));
        break;
        
      case 'sms_otp':
        // Generate and "send" OTP (in real impl, this would call SMS service)
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        envelopes.push(textEnvelope('sms', `Your verification code is: ${otp}`, {
          correlation_id: session.telemetry.correlation_id
        }));
        envelopes.push(textEnvelope(channel, prompt, {
          correlation_id: session.telemetry.correlation_id
        }));
        break;
        
      case 'email_magic_link':
        envelopes.push(textEnvelope(channel, prompt, {
          correlation_id: session.telemetry.correlation_id
        }));
        // Would also send email with magic link
        break;
        
      default:
        envelopes.push(textEnvelope(channel, prompt, {
          correlation_id: session.telemetry.correlation_id
        }));
    }
    
    return { challenge_id, type: method, envelopes };
  }
  
  /**
   * Process user's authentication response
   */
  private async processAuthResponse(
    session: SessionPacket,
    params: StepUpAuthParams,
    context: Record<string, unknown>
  ): Promise<NodeOutput> {
    const pendingAuth = session.memory.active.scratch.pending_auth as any;
    if (!pendingAuth) {
      return this.createErrorOutput(session, {
        code: 'NO_PENDING_AUTH',
        message: 'No pending authentication challenge',
        recoverable: true
      }, Date.now());
    }
    
    // Verify the response (simplified - real impl would validate against stored challenge)
    const isValid = this.verifyAuthResponse(context.auth_response, pendingAuth);
    
    if (isValid) {
      // Success - update clipboard with new auth level
      const assuranceTags: AssuranceTag[] = this.getAssuranceTags(pendingAuth.method);
      const updatedClipboard = updateAuthState(
        session.clipboard,
        params.target_level,
        pendingAuth.method,
        params.ttl_minutes || 60,
        assuranceTags
      );
      
      const updatedSession: SessionPacket = {
        ...session,
        clipboard: updatedClipboard,
        memory: {
          ...session.memory,
          active: {
            ...session.memory.active,
            scratch: {
              ...session.memory.active.scratch,
              pending_auth: undefined
            }
          }
        }
      };
      
      return {
        session: updatedSession,
        envelopes: [
          textEnvelope(
            session.metadata.primary_channel as Channel || 'chat',
            'Identity verified successfully.',
            { correlation_id: session.telemetry.correlation_id }
          )
        ],
        telemetry: {
          event_type: 'node_end',
          node_id: 'step-up-auth',
          node_type: this.nodeType,
          session_id: session.session_id,
          timestamp: new Date().toISOString(),
          success: true,
          auth_stepup_from: session.clipboard.auth.auth_level,
          auth_stepup_to: params.target_level
        },
        next_step: params.on_success_step,
        context: {
          auth_verified: true,
          auth_level: params.target_level,
          method: pendingAuth.method
        }
      };
    } else {
      // Failed - check attempts
      const attempts = (pendingAuth.attempts || 0) + 1;
      if (attempts >= (pendingAuth.max_attempts || 3)) {
        return {
          session,
          envelopes: [
            textEnvelope(
              session.metadata.primary_channel as Channel || 'chat',
              'Too many failed attempts. Please try again later or contact support.',
              { correlation_id: session.telemetry.correlation_id }
            )
          ],
          telemetry: {
            event_type: 'node_end',
            node_id: 'step-up-auth',
            node_type: this.nodeType,
            session_id: session.session_id,
            timestamp: new Date().toISOString(),
            success: false,
            error: { code: 'MAX_ATTEMPTS', message: 'Maximum authentication attempts exceeded' }
          },
          next_step: params.on_failure_step,
          context: { auth_verified: false, reason: 'max_attempts_exceeded' }
        };
      }
      
      // Allow retry
      const updatedSession: SessionPacket = {
        ...session,
        memory: {
          ...session.memory,
          active: {
            ...session.memory.active,
            scratch: {
              ...session.memory.active.scratch,
              pending_auth: { ...pendingAuth, attempts }
            }
          }
        }
      };
      
      return {
        session: updatedSession,
        envelopes: [
          textEnvelope(
            session.metadata.primary_channel as Channel || 'chat',
            `Verification failed. You have ${pendingAuth.max_attempts - attempts} attempts remaining. Please try again.`,
            { correlation_id: session.telemetry.correlation_id }
          )
        ],
        telemetry: {
          event_type: 'node_end',
          node_id: 'step-up-auth',
          node_type: this.nodeType,
          session_id: session.session_id,
          timestamp: new Date().toISOString(),
          success: true, // Node succeeded, auth failed
          context: { retry: true, attempts }
        },
        context: { awaiting_auth: true, retry: true, attempts }
      };
    }
  }
  
  /**
   * Verify auth response (simplified)
   */
  private verifyAuthResponse(response: unknown, pendingAuth: any): boolean {
    // In real implementation, this would validate:
    // - OTP codes against stored values
    // - PIN against account records
    // - Magic link tokens
    // - Biometric results from device
    // For now, simulate successful verification
    return !!response;
  }
  
  /**
   * Get assurance tags based on auth method
   */
  private getAssuranceTags(method: AuthMethod): AssuranceTag[] {
    const tags: Record<AuthMethod, AssuranceTag[]> = {
      voice_pin: ['recent_activity'],
      sms_otp: ['recent_activity'],
      email_magic_link: ['recent_activity'],
      biometric: ['biometric_verified', 'device_trusted'],
      knowledge_based: ['recent_activity'],
      device_trust: ['device_trusted'],
      caller_id: ['caller_id_match'],
      none: []
    };
    return tags[method] || [];
  }
  
  validateConfig(config: { params: StepUpAuthParams }): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const { params } = config;
    
    if (params.target_level < 1 || params.target_level > 3) {
      errors.push('target_level must be between 1 and 3');
    }
    
    return { valid: errors.length === 0, errors };
  }
}

// Register the node
import { registerNode } from '../base-node';
registerNode('step-up-auth', StepUpAuthNode as any);

export default StepUpAuthNode;


