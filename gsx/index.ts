/**
 * GSX Mixed-Channel Node Catalog
 * 
 * A channel-agnostic runtime for multi-channel communication
 * supporting voice, SMS, email, chat, push, and agent desktop.
 * 
 * Core concepts:
 * - One session, many endpoints
 * - Nodes are channel-agnostic by default
 * - MemoryClipboard carries verified facts + auth state across channels
 * - ChannelEnvelope provides universal output wrapper
 * 
 * @module gsx
 */

// ============ Common Types ============
export * from './schemas/common/types';
export * from './schemas/common/channel-envelope';
export * from './schemas/common/telemetry-event';

// ============ Session Schemas ============
export * from './schemas/session/session-packet';
export * from './schemas/session/memory-clipboard';

// ============ Base Node ============
export * from './schemas/nodes/base-node';

// ============ Identity & Security Nodes ============
export { VerifyIdentityNode, VerifyIdentityParams } from './schemas/nodes/identity-security/verify-identity';
export { StepUpAuthNode, StepUpAuthParams } from './schemas/nodes/identity-security/step-up-auth';

// ============ Messaging Nodes ============
export { SendMessageNode, SendMessageParams, DeliveryResult } from './schemas/nodes/messaging/send-message';

// ============ Re-export key types for convenience ============
export type {
  SessionPacket,
  MemoryLayers,
  ConstitutionalRef,
  ContextualMemory,
  ActiveMemory
} from './schemas/session/session-packet';

export type {
  MemoryClipboard,
  AuthState,
  CustomerContext,
  ConsentState,
  VerifiedEntities
} from './schemas/session/memory-clipboard';

export type {
  ChannelEnvelope,
} from './schemas/common/channel-envelope';

export type {
  Channel,
  AuthLevel,
  AuthMethod,
  DeliveryPolicy,
  StructuredContent
} from './schemas/common/types';


