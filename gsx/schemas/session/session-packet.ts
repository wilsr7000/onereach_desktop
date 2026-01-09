/**
 * SessionPacket - Single Source of Truth
 * 
 * One session, many endpoints. This is the core session state that flows
 * through all nodes, providing session continuity, multi-channel resumption,
 * and safe execution.
 */

import {
  EndpointRegistry,
  ChannelStateMap,
  PlanState,
  EventSubscription,
  TelemetryContext
} from '../common/types';
import { MemoryClipboard, createEmptyClipboard } from './memory-clipboard';

// ============ Memory Layers ============

/**
 * Constitutional Reference - Read-only policy bundle
 * Points to the policy version being used for this session
 */
export interface ConstitutionalRef {
  /** Policy bundle ID */
  bundle_id: string;
  
  /** Version of the policy bundle */
  version: string;
  
  /** When this policy was loaded */
  loaded_at: string;
  
  /** Checksum for integrity verification */
  checksum?: string;
}

/**
 * Contextual Memory - User/org context and KB cache
 */
export interface ContextualMemory {
  /** User profile information */
  user_profile?: {
    user_id?: string;
    display_name?: string;
    locale?: string;
    timezone?: string;
    preferences?: Record<string, unknown>;
  };
  
  /** Organization context */
  org_context?: {
    org_id?: string;
    org_name?: string;
    industry?: string;
    config?: Record<string, unknown>;
  };
  
  /** Knowledge base retrieval cache */
  kb_cache: KBCacheEntry[];
  
  /** Custom contextual data */
  custom: Record<string, unknown>;
}

export interface KBCacheEntry {
  /** Cache entry ID */
  entry_id: string;
  
  /** Query that produced this result */
  query: string;
  
  /** Retrieved content */
  content: string;
  
  /** Source reference */
  source: {
    kb_id: string;
    document_id?: string;
    chunk_id?: string;
    relevance_score?: number;
  };
  
  /** When this was retrieved */
  retrieved_at: string;
  
  /** When this cache entry expires */
  expires_at: string;
}

/**
 * Active Memory - Execution ledger
 */
export interface ActiveMemory {
  /** Collected slot values */
  slots: Record<string, SlotValue>;
  
  /** Questions waiting for answers */
  pending_questions: PendingQuestion[];
  
  /** Tool execution results */
  tool_results: ToolResult[];
  
  /** Commit log for undo support */
  commit_log: CommitEntry[];
  
  /** Temporary working memory (cleared between turns) */
  scratch: Record<string, unknown>;
}

export interface SlotValue {
  value: unknown;
  source: 'user' | 'system' | 'inferred' | 'default';
  confidence?: number;
  collected_at: string;
  validated: boolean;
}

export interface PendingQuestion {
  question_id: string;
  slot_name: string;
  prompt: string;
  asked_at: string;
  channel: string;
  timeout_at?: string;
  retries: number;
}

export interface ToolResult {
  tool_id: string;
  tool_name: string;
  input: Record<string, unknown>;
  output: unknown;
  success: boolean;
  error?: string;
  executed_at: string;
  latency_ms: number;
}

export interface CommitEntry {
  commit_id: string;
  action: string;
  data: Record<string, unknown>;
  committed_at: string;
  reversible: boolean;
  reversed?: boolean;
}

/**
 * Memory Layers - All memory in one place
 */
export interface MemoryLayers {
  /** Policy bundle reference (read-only) */
  constitutional_ref: ConstitutionalRef | null;
  
  /** User/org context and KB cache */
  contextual: ContextualMemory;
  
  /** Execution ledger */
  active: ActiveMemory;
}

// ============ Session Packet (Main Interface) ============

export interface SessionPacket {
  /** Unique session identifier */
  session_id: string;
  
  /** All registered endpoints for this session */
  endpoints: EndpointRegistry;
  
  /** Current state of each channel */
  channel_state: ChannelStateMap;
  
  /** Plan execution state */
  plan_state: PlanState | null;
  
  /** Event subscriptions (waiting for user reply, etc.) */
  event_subscriptions: EventSubscription[];
  
  /** Memory layers */
  memory: MemoryLayers;
  
  /** Memory clipboard - portable verified facts + auth state */
  clipboard: MemoryClipboard;
  
  /** Telemetry context */
  telemetry: TelemetryContext;
  
  /** Session metadata */
  metadata: SessionMetadata;
}

export interface SessionMetadata {
  /** When the session started */
  created_at: string;
  
  /** Last activity timestamp */
  last_activity_at: string;
  
  /** Session status */
  status: 'active' | 'paused' | 'completed' | 'expired' | 'error';
  
  /** Current primary channel */
  primary_channel?: string;
  
  /** Session tags for filtering/routing */
  tags: string[];
  
  /** Custom metadata */
  custom: Record<string, unknown>;
}

// ============ Session Factory ============

/**
 * Create a new session packet with defaults
 */
export function createSessionPacket(
  session_id: string,
  options?: Partial<{
    endpoints: EndpointRegistry;
    constitutional_bundle_id: string;
    constitutional_version: string;
    primary_channel: string;
    tags: string[];
  }>
): SessionPacket {
  const now = new Date().toISOString();
  
  return {
    session_id,
    endpoints: options?.endpoints || {},
    channel_state: {},
    plan_state: null,
    event_subscriptions: [],
    memory: {
      constitutional_ref: options?.constitutional_bundle_id ? {
        bundle_id: options.constitutional_bundle_id,
        version: options.constitutional_version || '1.0.0',
        loaded_at: now
      } : null,
      contextual: {
        kb_cache: [],
        custom: {}
      },
      active: {
        slots: {},
        pending_questions: [],
        tool_results: [],
        commit_log: [],
        scratch: {}
      }
    },
    clipboard: createEmptyClipboard(),
    telemetry: {
      correlation_id: `corr_${session_id}_${Date.now()}`,
      session_start: now,
      last_activity: now
    },
    metadata: {
      created_at: now,
      last_activity_at: now,
      status: 'active',
      primary_channel: options?.primary_channel,
      tags: options?.tags || [],
      custom: {}
    }
  };
}

/**
 * Update session activity timestamp
 */
export function touchSession(session: SessionPacket): SessionPacket {
  const now = new Date().toISOString();
  return {
    ...session,
    telemetry: {
      ...session.telemetry,
      last_activity: now
    },
    metadata: {
      ...session.metadata,
      last_activity_at: now
    }
  };
}

/**
 * Add an endpoint to the session
 */
export function addEndpoint(
  session: SessionPacket,
  key: keyof EndpointRegistry,
  value: string
): SessionPacket {
  return {
    ...session,
    endpoints: {
      ...session.endpoints,
      [key]: value
    }
  };
}

/**
 * Set a slot value
 */
export function setSlot(
  session: SessionPacket,
  name: string,
  value: unknown,
  source: SlotValue['source'] = 'user',
  confidence?: number
): SessionPacket {
  return {
    ...session,
    memory: {
      ...session.memory,
      active: {
        ...session.memory.active,
        slots: {
          ...session.memory.active.slots,
          [name]: {
            value,
            source,
            confidence,
            collected_at: new Date().toISOString(),
            validated: false
          }
        }
      }
    }
  };
}

/**
 * Get a slot value
 */
export function getSlot<T = unknown>(session: SessionPacket, name: string): T | undefined {
  return session.memory.active.slots[name]?.value as T | undefined;
}

/**
 * Add a tool result
 */
export function addToolResult(
  session: SessionPacket,
  result: Omit<ToolResult, 'executed_at'>
): SessionPacket {
  return {
    ...session,
    memory: {
      ...session.memory,
      active: {
        ...session.memory.active,
        tool_results: [
          ...session.memory.active.tool_results,
          { ...result, executed_at: new Date().toISOString() }
        ]
      }
    }
  };
}


