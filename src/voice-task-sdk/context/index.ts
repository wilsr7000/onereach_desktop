/**
 * Context Provider System - Exports
 */

// Types
export type {
  ContextProvider,
  ContextProviderCategory,
  ContextData,
  ProviderSettings,
  SettingsSchema,
  SettingsField,
  AggregatedContext,
  ProviderInfo,
  ContextProviderFactory,
  RegistryConfig,
  CacheEntry,
} from './types'

// Registry
export {
  createContextRegistry,
  getContextRegistry,
  resetContextRegistry,
  type ContextRegistry,
} from './registry'

// Built-in providers
export { createTemporalProvider } from './providers/temporal'
export { createActiveAppProvider } from './providers/activeApp'
export { createCalendarProvider } from './providers/calendar'
export { createLocationProvider } from './providers/location'
export { createCustomFactsProvider } from './providers/customFacts'
export { createExternalApiProvider } from './providers/externalApi'
