/**
 * External API Context Provider
 * 
 * Fetches context from external APIs/webhooks:
 * - Weather services
 * - Stock prices
 * - Custom webhooks
 * - REST APIs
 */

import type { ContextProvider, ContextData, ProviderSettings, SettingsSchema } from '../types'

export interface ApiEndpoint {
  id: string
  name: string
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  responsePath?: string // JSON path to extract value
  refreshIntervalMs?: number
}

export interface ExternalApiProviderSettings extends ProviderSettings {
  endpoints?: ApiEndpoint[]
  defaultRefreshMs?: number
  timeout?: number
}

export function createExternalApiProvider(initialSettings?: ExternalApiProviderSettings): ContextProvider {
  let enabled = false // Disabled by default - requires configuration
  let settings: ExternalApiProviderSettings = {
    endpoints: [],
    defaultRefreshMs: 5 * 60 * 1000, // 5 minutes
    timeout: 10000, // 10 seconds
    ...initialSettings,
  }
  
  // Cache for API responses
  const cache = new Map<string, {
    data: unknown
    timestamp: number
    expiresAt: number
  }>()
  
  /**
   * Extract value from JSON using dot notation path
   */
  function extractValue(obj: unknown, path: string): unknown {
    if (!path) return obj
    
    const parts = path.split('.')
    let current: unknown = obj
    
    for (const part of parts) {
      if (current === null || current === undefined) return undefined
      if (typeof current !== 'object') return undefined
      
      // Handle array index notation [0]
      const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/)
      if (arrayMatch) {
        const [, key, index] = arrayMatch
        current = (current as Record<string, unknown>)[key]
        if (Array.isArray(current)) {
          current = current[parseInt(index, 10)]
        }
      } else {
        current = (current as Record<string, unknown>)[part]
      }
    }
    
    return current
  }
  
  /**
   * Fetch data from an endpoint
   */
  async function fetchEndpoint(endpoint: ApiEndpoint): Promise<unknown> {
    // Check cache
    const cached = cache.get(endpoint.id)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data
    }
    
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), settings.timeout)
      
      const response = await fetch(endpoint.url, {
        method: endpoint.method || 'GET',
        headers: endpoint.headers,
        body: endpoint.body,
        signal: controller.signal,
      })
      
      clearTimeout(timeoutId)
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      
      const data = await response.json()
      const extracted = endpoint.responsePath 
        ? extractValue(data, endpoint.responsePath)
        : data
      
      // Cache the result
      const refreshMs = endpoint.refreshIntervalMs || settings.defaultRefreshMs || 300000
      cache.set(endpoint.id, {
        data: extracted,
        timestamp: Date.now(),
        expiresAt: Date.now() + refreshMs,
      })
      
      return extracted
    } catch (error) {
      console.warn(`[ExternalApiProvider] Failed to fetch ${endpoint.name}:`, error)
      
      // Return stale cache if available
      if (cached) {
        return cached.data
      }
      
      return null
    }
  }
  
  const provider: ContextProvider = {
    id: 'external-api',
    name: 'External APIs',
    category: 'external',
    priority: 50, // Lower priority - supplementary context
    
    async getContext(): Promise<ContextData | null> {
      const endpoints = settings.endpoints || []
      
      if (endpoints.length === 0) {
        return null
      }
      
      // Fetch all endpoints in parallel
      const results = await Promise.allSettled(
        endpoints.map(async (endpoint) => {
          const data = await fetchEndpoint(endpoint)
          return { endpoint, data }
        })
      )
      
      // Collect successful results
      const successful: { name: string; data: unknown }[] = []
      const details: Record<string, unknown> = {}
      
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.data !== null) {
          const { endpoint, data } = result.value
          successful.push({ name: endpoint.name, data })
          details[endpoint.id] = data
        }
      }
      
      if (successful.length === 0) {
        return null
      }
      
      // Build summary
      const summaryParts = successful.map(({ name, data }) => {
        // Try to create a meaningful summary
        if (typeof data === 'string' || typeof data === 'number') {
          return `${name}: ${data}`
        }
        if (typeof data === 'object' && data !== null) {
          // Try common fields
          const obj = data as Record<string, unknown>
          if (obj.summary) return `${name}: ${obj.summary}`
          if (obj.value) return `${name}: ${obj.value}`
          if (obj.message) return `${name}: ${obj.message}`
        }
        return `${name}: Available`
      })
      
      return {
        summary: `External: ${summaryParts.join(', ')}`,
        details,
        timestamp: Date.now(),
        ttlMs: Math.min(...endpoints.map(e => 
          e.refreshIntervalMs || settings.defaultRefreshMs || 300000
        )),
      }
    },
    
    configure(newSettings: ProviderSettings): void {
      settings = { ...settings, ...newSettings as ExternalApiProviderSettings }
      cache.clear() // Clear cache on config change
    },
    
    isEnabled(): boolean {
      return enabled
    },
    
    enable(): void {
      enabled = true
    },
    
    disable(): void {
      enabled = false
      cache.clear()
    },
    
    dispose(): void {
      cache.clear()
    },
    
    getSettingsSchema(): SettingsSchema {
      return {
        fields: [
          {
            key: 'endpoints',
            label: 'API Endpoints',
            type: 'textarea',
            description: 'JSON array of endpoint configurations',
          },
          {
            key: 'defaultRefreshMs',
            label: 'Default refresh interval (ms)',
            type: 'number',
            default: 300000,
            validation: { min: 10000, max: 3600000 },
          },
          {
            key: 'timeout',
            label: 'Request timeout (ms)',
            type: 'number',
            default: 10000,
            validation: { min: 1000, max: 60000 },
          },
        ],
      }
    },
  }
  
  // Additional methods for endpoint management
  const extended = provider as ContextProvider & {
    addEndpoint: (endpoint: ApiEndpoint) => void
    removeEndpoint: (id: string) => boolean
    getEndpoints: () => ApiEndpoint[]
    clearCache: () => void
  }
  
  extended.addEndpoint = (endpoint: ApiEndpoint) => {
    if (!settings.endpoints) settings.endpoints = []
    settings.endpoints = settings.endpoints.filter(e => e.id !== endpoint.id)
    settings.endpoints.push(endpoint)
  }
  
  extended.removeEndpoint = (id: string): boolean => {
    if (!settings.endpoints) return false
    const before = settings.endpoints.length
    settings.endpoints = settings.endpoints.filter(e => e.id !== id)
    cache.delete(id)
    return settings.endpoints.length < before
  }
  
  extended.getEndpoints = () => [...(settings.endpoints || [])]
  
  extended.clearCache = () => cache.clear()
  
  return extended
}
