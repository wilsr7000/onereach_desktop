/**
 * GSX Common Types
 * Base types used across all GSX schemas and nodes
 */

// ============ Channel Types ============

export type Channel = 
  | 'voice' 
  | 'sms' 
  | 'email' 
  | 'chat' 
  | 'push' 
  | 'agent_desktop';

export type Audience = 'user' | 'agent' | 'supervisor';

export type Priority = 'now' | 'soon' | 'async';

// ============ Authentication Types ============

export type AuthLevel = 0 | 1 | 2 | 3;

export type AuthMethod = 
  | 'voice_pin'
  | 'sms_otp'
  | 'email_magic_link'
  | 'biometric'
  | 'knowledge_based'
  | 'device_trust'
  | 'caller_id'
  | 'none';

export type ConsentStatus = 'granted' | 'denied' | 'unknown';

// ============ Channel State Types ============

export type ChannelConnectionState = 
  | 'connected'
  | 'reachable'
  | 'unreachable'
  | 'quiet_hours'
  | 'unknown';

export interface ChannelState {
  state: ChannelConnectionState;
  last_seen?: string; // ISO timestamp
  quiet_hours_until?: string; // ISO timestamp
  capabilities?: string[];
}

export type ChannelStateMap = Partial<Record<Channel, ChannelState>>;

// ============ Endpoint Registry ============

export interface EndpointRegistry {
  voice_call_id?: string;
  sms_number?: string;
  email?: string;
  app_user_id?: string;
  chat_session_id?: string;
  push_device_tokens?: string[];
  agent_desktop_id?: string;
  [key: string]: string | string[] | undefined;
}

// ============ Plan State ============

export interface PlanStep {
  step_id: string;
  node_type: string;
  config: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  result?: unknown;
  error?: string;
  started_at?: string;
  completed_at?: string;
}

export interface PlanState {
  plan_id: string;
  current_step: string | null;
  pending_steps: PlanStep[];
  completed_steps: PlanStep[];
  failed_steps: PlanStep[];
  retries: number;
  max_retries: number;
  created_at: string;
  updated_at: string;
}

// ============ Event Subscriptions ============

export interface EventSubscription {
  subscription_id: string;
  event_type: 'user_reply' | 'external_event' | 'timeout' | 'webhook';
  channel?: Channel;
  timeout_ms?: number;
  expires_at?: string;
  callback_step?: string;
  metadata?: Record<string, unknown>;
}

// ============ Delivery Policy ============

export type QuietHoursPolicy = 'defer' | 'alternate' | 'drop';

export interface RetryConfig {
  max: number;
  backoff_ms: number;
  backoff_multiplier?: number;
}

export interface DeliveryPolicy {
  quiet_hours: QuietHoursPolicy;
  fallback_channels: Channel[];
  retries: RetryConfig;
  consent_required: string[];
  min_auth_level: AuthLevel;
}

// ============ Structured Content ============

export interface TextContent {
  type: 'text';
  text: string;
  markdown?: boolean;
}

export interface SSMLContent {
  type: 'ssml';
  ssml: string;
  fallback_text?: string;
}

export interface CardContent {
  type: 'card';
  title: string;
  subtitle?: string;
  image_url?: string;
  actions?: ActionButton[];
}

export interface ActionButton {
  label: string;
  action_type: 'link' | 'postback' | 'call' | 'quick_reply';
  value: string;
}

export interface AttachmentContent {
  type: 'attachment';
  url: string;
  mime_type: string;
  filename?: string;
  size_bytes?: number;
}

export interface FieldsContent {
  type: 'fields';
  fields: Array<{ label: string; value: string }>;
}

export type StructuredContent = 
  | TextContent 
  | SSMLContent 
  | CardContent 
  | AttachmentContent 
  | FieldsContent;

export interface StructuredContentDraft {
  primary: StructuredContent;
  alternatives?: Partial<Record<Channel, StructuredContent>>;
}

// ============ Render Hints ============

export interface RenderHints {
  barge_in?: boolean;
  typing_indicator?: boolean;
  read_receipt?: boolean;
  chunk_long_messages?: boolean;
  max_chunk_length?: number;
  link_preview?: boolean;
}

// ============ Telemetry ============

export interface TelemetryContext {
  correlation_id: string;
  trace_id?: string;
  span_id?: string;
  experiment_flags?: Record<string, string | boolean>;
  session_start: string;
  last_activity: string;
}

// ============ Verified Entity ============

export interface VerifiedEntity<T = string> {
  value: T;
  verified_by: AuthMethod;
  verified_at: string;
  expires_at?: string;
  confidence?: number;
}

// ============ Node Base Types ============

export interface NodeInput {
  session: import('../session/session-packet').SessionPacket;
  config: Record<string, unknown>;
}

export interface NodeOutput {
  session: import('../session/session-packet').SessionPacket;
  envelopes: import('./channel-envelope').ChannelEnvelope[];
  telemetry: import('./telemetry-event').TelemetryEvent;
  next_step?: string;
  error?: NodeError;
}

export interface NodeError {
  code: string;
  message: string;
  recoverable: boolean;
  details?: Record<string, unknown>;
}



