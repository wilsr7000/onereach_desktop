/**
 * Context Provider Registry
 * 
 * Manages context providers with:
 * - Registration and lifecycle management
 * - Context aggregation from all enabled providers
 * - Caching with TTL support
 * - Priority-based ordering
 */

import type {
  ContextProvider,
  ContextData,
  AggregatedContext,
  ProviderInfo,
  RegistryConfig,
  CacheEntry,
  ProviderSettings,
} from './types'

export interface ContextRegistry {
  /**
   * Register a context provider
   * @param provider The provider to register
   * @returns true if registered successfully
   */
  register(provider: ContextProvider): boolean
  
  /**
   * Unregister a provider by ID
   * @param providerId Provider ID to remove
   * @returns true if found and removed
   */
  unregister(providerId: string): boolean
  
  /**
   * Get a provider by ID
   * @param providerId Provider ID
   */
  get(providerId: string): ContextProvider | undefined
  
  /**
   * List all registered providers
   */
  list(): ProviderInfo[]
  
  /**
   * Enable a provider
   * @param providerId Provider ID
   */
  enable(providerId: string): boolean
  
  /**
   * Disable a provider
   * @param providerId Provider ID
   */
  disable(providerId: string): boolean
  
  /**
   * Configure a provider
   * @param providerId Provider ID
   * @param settings Settings to apply
   */
  configure(providerId: string, settings: ProviderSettings): boolean
  
  /**
   * Aggregate context from all enabled providers
   * @param forceRefresh Skip cache and fetch fresh data
   * @returns Aggregated context from all providers
   */
  aggregate(forceRefresh?: boolean): Promise<AggregatedContext>
  
  /**
   * Get context from a specific provider
   * @param providerId Provider ID
   * @param forceRefresh Skip cache
   */
  getProviderContext(providerId: string, forceRefresh?: boolean): Promise<ContextData | null>
  
  /**
   * Clear all cached context
   */
  clearCache(): void
  
  /**
   * Dispose all providers and clean up
   */
  dispose(): void
}

export function createContextRegistry(config: RegistryConfig = {}): ContextRegistry {
  const {
    defaultTtlMs = 30000, // 30 seconds default cache
    maxProviders = 50,
    autoEnableBuiltins = true,
  } = config
  
  // Provider storage
  const providers = new Map<string, ContextProvider>()
  
  // Cache storage
  const cache = new Map<string, CacheEntry>()
  
  // Provider state (enabled/disabled, errors)
  const providerState = new Map<string, { enabled: boolean; lastUpdate?: number; error?: string }>()
  
  function register(provider: ContextProvider): boolean {
    if (providers.size >= maxProviders) {
      console.warn('[ContextRegistry] Max providers limit reached:', maxProviders)
      return false
    }
    
    if (providers.has(provider.id)) {
      console.warn('[ContextRegistry] Provider already registered:', provider.id)
      return false
    }
    
    providers.set(provider.id, provider)
    providerState.set(provider.id, { 
      enabled: autoEnableBuiltins || provider.isEnabled() 
    })
    
    console.log('[ContextRegistry] Registered provider:', provider.id, provider.name)
    return true
  }
  
  function unregister(providerId: string): boolean {
    const provider = providers.get(providerId)
    if (!provider) return false
    
    // Clean up
    if (provider.dispose) {
      try {
        provider.dispose()
      } catch (e) {
        console.error('[ContextRegistry] Error disposing provider:', providerId, e)
      }
    }
    
    providers.delete(providerId)
    providerState.delete(providerId)
    cache.delete(providerId)
    
    console.log('[ContextRegistry] Unregistered provider:', providerId)
    return true
  }
  
  function get(providerId: string): ContextProvider | undefined {
    return providers.get(providerId)
  }
  
  function list(): ProviderInfo[] {
    const infos: ProviderInfo[] = []
    
    for (const [id, provider] of providers) {
      const state = providerState.get(id) || { enabled: false }
      infos.push({
        id,
        name: provider.name,
        category: provider.category,
        priority: provider.priority,
        enabled: state.enabled,
        lastUpdate: state.lastUpdate,
        error: state.error,
      })
    }
    
    // Sort by priority (higher first)
    return infos.sort((a, b) => b.priority - a.priority)
  }
  
  function enable(providerId: string): boolean {
    const state = providerState.get(providerId)
    if (!state) return false
    
    state.enabled = true
    
    const provider = providers.get(providerId)
    if (provider?.enable) {
      provider.enable()
    }
    
    return true
  }
  
  function disable(providerId: string): boolean {
    const state = providerState.get(providerId)
    if (!state) return false
    
    state.enabled = false
    cache.delete(providerId)
    
    const provider = providers.get(providerId)
    if (provider?.disable) {
      provider.disable()
    }
    
    return true
  }
  
  function configure(providerId: string, settings: ProviderSettings): boolean {
    const provider = providers.get(providerId)
    if (!provider || !provider.configure) return false
    
    try {
      provider.configure(settings)
      
      // Update enabled state if specified
      if (settings.enabled !== undefined) {
        const state = providerState.get(providerId)
        if (state) {
          state.enabled = settings.enabled
        }
      }
      
      // Invalidate cache
      cache.delete(providerId)
      
      return true
    } catch (e) {
      console.error('[ContextRegistry] Error configuring provider:', providerId, e)
      return false
    }
  }
  
  function isCacheValid(entry: CacheEntry): boolean {
    return entry.expiresAt > Date.now()
  }
  
  async function getProviderContext(
    providerId: string, 
    forceRefresh = false
  ): Promise<ContextData | null> {
    const provider = providers.get(providerId)
    const state = providerState.get(providerId)
    
    if (!provider || !state?.enabled) {
      return null
    }
    
    // Check cache
    if (!forceRefresh) {
      const cached = cache.get(providerId)
      if (cached && isCacheValid(cached)) {
        return cached.data
      }
    }
    
    // Fetch fresh context
    try {
      const data = await provider.getContext()
      
      if (data) {
        // Update cache
        const ttl = data.ttlMs ?? defaultTtlMs
        cache.set(providerId, {
          data,
          expiresAt: Date.now() + ttl,
          providerId,
        })
        
        // Update state
        state.lastUpdate = Date.now()
        state.error = undefined
      }
      
      return data
    } catch (error) {
      console.error('[ContextRegistry] Error getting context from:', providerId, error)
      state.error = String(error)
      return null
    }
  }
  
  async function aggregate(forceRefresh = false): Promise<AggregatedContext> {
    const timestamp = Date.now()
    const providerResults: { [id: string]: ContextData } = {}
    const summaries: string[] = []
    
    // Get sorted list of enabled providers
    const sortedProviders = Array.from(providers.entries())
      .filter(([id]) => providerState.get(id)?.enabled)
      .sort((a, b) => b[1].priority - a[1].priority)
    
    // Gather context from all providers in parallel
    const results = await Promise.allSettled(
      sortedProviders.map(async ([id]) => {
        const data = await getProviderContext(id, forceRefresh)
        return { id, data }
      })
    )
    
    // Process results
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.data) {
        const { id, data } = result.value
        providerResults[id] = data
        
        if (data.summary) {
          summaries.push(data.summary)
        }
      }
    }
    
    return {
      summary: summaries.join('\n'),
      providers: providerResults,
      timestamp,
      providerCount: Object.keys(providerResults).length,
    }
  }
  
  function clearCache(): void {
    cache.clear()
    console.log('[ContextRegistry] Cache cleared')
  }
  
  function dispose(): void {
    // Dispose all providers
    for (const [id, provider] of providers) {
      if (provider.dispose) {
        try {
          provider.dispose()
        } catch (e) {
          console.error('[ContextRegistry] Error disposing provider:', id, e)
        }
      }
    }
    
    providers.clear()
    providerState.clear()
    cache.clear()
    
    console.log('[ContextRegistry] Registry disposed')
  }
  
  return {
    register,
    unregister,
    get,
    list,
    enable,
    disable,
    configure,
    aggregate,
    getProviderContext,
    clearCache,
    dispose,
  }
}

// Singleton instance
let defaultRegistry: ContextRegistry | null = null

export function getContextRegistry(config?: RegistryConfig): ContextRegistry {
  if (!defaultRegistry) {
    defaultRegistry = createContextRegistry(config)
  }
  return defaultRegistry
}

export function resetContextRegistry(): void {
  if (defaultRegistry) {
    defaultRegistry.dispose()
    defaultRegistry = null
  }
}
