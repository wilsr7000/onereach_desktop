/**
 * MemoryClipboard - Portable Verified Facts + Auth State
 * 
 * A secure "clipboard" of verified facts that can be reused across nodes
 * and channels without re-asking, while still supporting step-up authentication.
 * 
 * Key Rule: If auth_level >= required_level AND not expired, DO NOT re-auth.
 * If a step requires higher assurance, trigger StepUpAuth automatically.
 * 
 * All clipboard items have TTL + provenance; they decay and can be invalidated.
 */

import { AuthLevel, AuthMethod, ConsentStatus, VerifiedEntity } from '../common/types';

// ============ Authentication State ============

export interface AuthState {
  /** Current authentication level (0=none, 1=basic, 2=verified, 3=high assurance) */
  auth_level: AuthLevel;
  
  /** Method used to achieve this auth level */
  method: AuthMethod;
  
  /** When authentication was verified */
  verified_at: string;
  
  /** When this auth state expires (requires re-auth after) */
  expires_at: string;
  
  /** Additional assurance indicators */
  assurance_tags: AssuranceTag[];
  
  /** Chain of auth methods used (for step-up tracking) */
  auth_chain?: AuthChainEntry[];
}

export type AssuranceTag = 
  | 'device_trusted'
  | 'caller_id_match'
  | 'biometric_verified'
  | 'recent_activity'
  | 'known_location'
  | 'mfa_complete';

export interface AuthChainEntry {
  method: AuthMethod;
  level_achieved: AuthLevel;
  verified_at: string;
  channel: string;
}

// ============ Customer Context ============

export interface CustomerContext {
  /** Whether the user has been identified as a customer */
  is_customer: boolean;
  
  /** Customer ID if identified */
  customer_id?: string;
  
  /** Associated account IDs */
  account_ids: string[];
  
  /** Customer entitlements/features */
  entitlements: string[];
  
  /** Risk flags for fraud/security */
  risk_flags: RiskFlag[];
  
  /** Customer tier/segment */
  segment?: string;
  
  /** When customer context was established */
  established_at: string;
  
  /** When this context expires */
  expires_at: string;
}

export type RiskFlag = 
  | 'fraud_alert'
  | 'account_takeover_risk'
  | 'suspicious_activity'
  | 'high_value_target'
  | 'recent_breach_victim'
  | 'velocity_exceeded';

// ============ Consent State ============

export interface ConsentState {
  /** Recording consent status */
  recording_consent: ConsentStatus;
  recording_consent_at?: string;
  
  /** SMS opt-in status */
  sms_opt_in: ConsentStatus;
  sms_opt_in_at?: string;
  
  /** Email marketing consent */
  email_marketing: ConsentStatus;
  email_marketing_at?: string;
  
  /** Data processing consent (GDPR) */
  data_processing: ConsentStatus;
  data_processing_at?: string;
  
  /** Additional consent flags */
  custom_consents: Record<string, {
    status: ConsentStatus;
    granted_at?: string;
    expires_at?: string;
  }>;
}

// ============ Verified Entities (Slot Provenance) ============

export interface VerifiedEntities {
  /** Verified phone number */
  phone_number?: VerifiedEntity<string>;
  
  /** Verified email address */
  email?: VerifiedEntity<string>;
  
  /** Verified mailing address */
  address?: VerifiedEntity<AddressEntity>;
  
  /** Verified date of birth */
  date_of_birth?: VerifiedEntity<string>;
  
  /** Verified SSN (last 4 or full, depending on context) */
  ssn_last4?: VerifiedEntity<string>;
  
  /** Verified account number */
  account_number?: VerifiedEntity<string>;
  
  /** Verified name */
  full_name?: VerifiedEntity<string>;
  
  /** Custom verified entities */
  custom: Record<string, VerifiedEntity<unknown>>;
}

export interface AddressEntity {
  street1: string;
  street2?: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
}

// ============ Memory Clipboard (Main Interface) ============

export interface MemoryClipboard {
  /** Authentication state - portable across channels */
  auth: AuthState;
  
  /** Customer context - identified once, reused */
  customer_context: CustomerContext | null;
  
  /** Consent state - tracks all consent decisions */
  consent: ConsentState;
  
  /** Verified entities with provenance */
  verified_entities: VerifiedEntities;
  
  /** Last modified timestamp */
  updated_at: string;
  
  /** Clipboard version for optimistic locking */
  version: number;
}

// ============ Clipboard Operations ============

/**
 * Check if current auth level meets requirement
 */
export function meetsAuthRequirement(
  clipboard: MemoryClipboard,
  required_level: AuthLevel
): boolean {
  if (clipboard.auth.auth_level < required_level) {
    return false;
  }
  
  // Check expiration
  const now = new Date();
  const expires = new Date(clipboard.auth.expires_at);
  if (now >= expires) {
    return false;
  }
  
  return true;
}

/**
 * Check if a verified entity is still valid
 */
export function isEntityValid<T>(entity: VerifiedEntity<T> | undefined): boolean {
  if (!entity) return false;
  
  if (entity.expires_at) {
    const now = new Date();
    const expires = new Date(entity.expires_at);
    if (now >= expires) {
      return false;
    }
  }
  
  return true;
}

/**
 * Get a verified entity value if valid, otherwise undefined
 */
export function getVerifiedValue<T>(entity: VerifiedEntity<T> | undefined): T | undefined {
  if (!isEntityValid(entity)) return undefined;
  return entity!.value;
}

/**
 * Create a default empty clipboard
 */
export function createEmptyClipboard(): MemoryClipboard {
  const now = new Date().toISOString();
  const oneHourFromNow = new Date(Date.now() + 3600000).toISOString();
  
  return {
    auth: {
      auth_level: 0,
      method: 'none',
      verified_at: now,
      expires_at: oneHourFromNow,
      assurance_tags: []
    },
    customer_context: null,
    consent: {
      recording_consent: 'unknown',
      sms_opt_in: 'unknown',
      email_marketing: 'unknown',
      data_processing: 'unknown',
      custom_consents: {}
    },
    verified_entities: {
      custom: {}
    },
    updated_at: now,
    version: 1
  };
}

/**
 * Update auth state after successful authentication
 */
export function updateAuthState(
  clipboard: MemoryClipboard,
  newLevel: AuthLevel,
  method: AuthMethod,
  ttlMinutes: number = 60,
  assuranceTags: AssuranceTag[] = []
): MemoryClipboard {
  const now = new Date();
  const expires = new Date(now.getTime() + ttlMinutes * 60000);
  
  const authChainEntry: AuthChainEntry = {
    method,
    level_achieved: newLevel,
    verified_at: now.toISOString(),
    channel: 'unknown' // Should be set by caller
  };
  
  return {
    ...clipboard,
    auth: {
      auth_level: newLevel,
      method,
      verified_at: now.toISOString(),
      expires_at: expires.toISOString(),
      assurance_tags: [...new Set([...clipboard.auth.assurance_tags, ...assuranceTags])],
      auth_chain: [...(clipboard.auth.auth_chain || []), authChainEntry]
    },
    updated_at: now.toISOString(),
    version: clipboard.version + 1
  };
}

/**
 * Set a verified entity
 */
export function setVerifiedEntity<T>(
  clipboard: MemoryClipboard,
  key: keyof Omit<VerifiedEntities, 'custom'> | string,
  value: T,
  method: AuthMethod,
  ttlMinutes?: number
): MemoryClipboard {
  const now = new Date();
  const entity: VerifiedEntity<T> = {
    value,
    verified_by: method,
    verified_at: now.toISOString(),
    expires_at: ttlMinutes 
      ? new Date(now.getTime() + ttlMinutes * 60000).toISOString()
      : undefined
  };
  
  const isStandardKey = ['phone_number', 'email', 'address', 'date_of_birth', 'ssn_last4', 'account_number', 'full_name'].includes(key);
  
  return {
    ...clipboard,
    verified_entities: isStandardKey
      ? { ...clipboard.verified_entities, [key]: entity }
      : { 
          ...clipboard.verified_entities, 
          custom: { ...clipboard.verified_entities.custom, [key]: entity }
        },
    updated_at: now.toISOString(),
    version: clipboard.version + 1
  };
}



