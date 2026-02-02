/**
 * Context Provider System - Type Definitions
 * 
 * Defines the interfaces for context providers that enrich voice commands
 * with contextual information like time, location, active app, etc.
 */

/**
 * Category of context provider
 */
export type ContextProviderCategory = 
  | 'temporal'      // Time, date, timezone
  | 'spatial'       // Location, geofence
  | 'application'   // Active app, document
  | 'user'          // Custom facts, preferences
  | 'external'      // External APIs, integrations

/**
 * Data returned by a context provider
 */
export interface ContextData {
  /** One-line summary for inclusion in prompts */
  summary: string
  
  /** Structured data for agents to use */
  details?: Record<string, unknown>
  
  /** When this context was gathered */
  timestamp: number
  
  /** How long this context is valid (milliseconds) */
  ttlMs?: number
  
  /** Provider-specific metadata */
  metadata?: Record<string, unknown>
}

/**
 * Provider configuration passed to configure()
 */
export interface ProviderSettings {
  enabled?: boolean
  [key: string]: unknown
}

/**
 * Context provider interface - implemented by all context providers
 */
export interface ContextProvider {
  /** Unique identifier for this provider */
  id: string
  
  /** Human-readable name */
  name: string
  
  /** Category of context this provider supplies */
  category: ContextProviderCategory
  
  /** Higher priority providers appear first in aggregated context */
  priority: number
  
  /**
   * Gather current context
   * @returns Context data or null if unavailable
   */
  getContext(): Promise<ContextData | null>
  
  /**
   * Configure the provider with settings
   * @param settings Provider-specific settings
   */
  configure?(settings: ProviderSettings): void
  
  /**
   * Check if provider is currently enabled
   */
  isEnabled(): boolean
  
  /**
   * Enable the provider
   */
  enable?(): void
  
  /**
   * Disable the provider
   */
  disable?(): void
  
  /**
   * Clean up resources when provider is removed
   */
  dispose?(): void
  
  /**
   * Get provider-specific settings schema for UI generation
   */
  getSettingsSchema?(): SettingsSchema
}

/**
 * Settings schema for UI generation
 */
export interface SettingsSchema {
  fields: SettingsField[]
}

/**
 * Individual settings field
 */
export interface SettingsField {
  key: string
  label: string
  type: 'text' | 'number' | 'boolean' | 'select' | 'textarea' | 'password'
  description?: string
  required?: boolean
  default?: unknown
  options?: Array<{ label: string; value: string | number }>
  validation?: {
    min?: number
    max?: number
    pattern?: string
    message?: string
  }
}

/**
 * Aggregated context from all providers
 */
export interface AggregatedContext {
  /** Combined summary from all providers */
  summary: string
  
  /** Individual provider results */
  providers: {
    [providerId: string]: ContextData
  }
  
  /** When aggregation was performed */
  timestamp: number
  
  /** Number of providers that contributed */
  providerCount: number
}

/**
 * Provider registration info
 */
export interface ProviderInfo {
  id: string
  name: string
  category: ContextProviderCategory
  priority: number
  enabled: boolean
  lastUpdate?: number
  error?: string
}

/**
 * Factory function type for creating providers
 */
export type ContextProviderFactory = (settings?: ProviderSettings) => ContextProvider

/**
 * Provider registry configuration
 */
export interface RegistryConfig {
  /** Default TTL for cached context (milliseconds) */
  defaultTtlMs?: number
  
  /** Maximum number of providers */
  maxProviders?: number
  
  /** Auto-enable built-in providers */
  autoEnableBuiltins?: boolean
}

/**
 * Cache entry for provider context
 */
export interface CacheEntry {
  data: ContextData
  expiresAt: number
  providerId: string
}
