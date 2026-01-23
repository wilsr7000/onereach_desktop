/**
 * Location Context Provider
 * 
 * Provides location context:
 * - Current city/region
 * - Timezone
 * - Geofence detection (home, work, etc.)
 * 
 * Uses:
 * - System location services (if permitted)
 * - IP-based geolocation as fallback
 */

import type { ContextProvider, ContextData, ProviderSettings, SettingsSchema } from '../types'

export interface Geofence {
  name: string
  latitude: number
  longitude: number
  radiusMeters: number
}

export interface LocationProviderSettings extends ProviderSettings {
  useSystemLocation?: boolean
  ipFallback?: boolean
  geofences?: Geofence[]
  defaultLocation?: {
    city?: string
    region?: string
    country?: string
    timezone?: string
  }
}

export function createLocationProvider(initialSettings?: LocationProviderSettings): ContextProvider {
  let enabled = false // Disabled by default - requires permission
  let settings: LocationProviderSettings = {
    useSystemLocation: false,
    ipFallback: true,
    geofences: [],
    ...initialSettings,
  }
  
  // Cached location
  let cachedLocation: {
    latitude?: number
    longitude?: number
    city?: string
    region?: string
    country?: string
    timezone?: string
    accuracy?: number
    source?: 'system' | 'ip' | 'default'
  } = {}
  let lastFetch = 0
  
  function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    // Haversine formula
    const R = 6371e3 // Earth radius in meters
    const phi1 = lat1 * Math.PI / 180
    const phi2 = lat2 * Math.PI / 180
    const deltaPhi = (lat2 - lat1) * Math.PI / 180
    const deltaLambda = (lon2 - lon1) * Math.PI / 180
    
    const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2)
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    
    return R * c
  }
  
  function checkGeofences(lat: number, lon: number): string[] {
    const matches: string[] = []
    
    for (const fence of settings.geofences || []) {
      const distance = calculateDistance(lat, lon, fence.latitude, fence.longitude)
      if (distance <= fence.radiusMeters) {
        matches.push(fence.name)
      }
    }
    
    return matches
  }
  
  async function fetchSystemLocation(): Promise<typeof cachedLocation> {
    // In Electron, this would use IPC to main process
    if (typeof window !== 'undefined' && (window as any).contextAPI?.getLocation) {
      try {
        const loc = await (window as any).contextAPI.getLocation()
        if (loc) {
          return { ...loc, source: 'system' as const }
        }
      } catch (e) {
        console.warn('[LocationProvider] System location failed:', e)
      }
    }
    
    // Browser geolocation fallback (if available)
    if (typeof navigator !== 'undefined' && navigator.geolocation && settings.useSystemLocation) {
      return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            resolve({
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
              accuracy: pos.coords.accuracy,
              source: 'system' as const,
            })
          },
          () => resolve({}),
          { timeout: 5000 }
        )
      })
    }
    
    return {}
  }
  
  async function fetchIpLocation(): Promise<typeof cachedLocation> {
    if (!settings.ipFallback) return {}
    
    try {
      // Using a free IP geolocation service
      const response = await fetch('https://ipapi.co/json/')
      const data = await response.json()
      
      return {
        latitude: data.latitude,
        longitude: data.longitude,
        city: data.city,
        region: data.region,
        country: data.country_name,
        timezone: data.timezone,
        source: 'ip' as const,
      }
    } catch (e) {
      console.warn('[LocationProvider] IP location failed:', e)
      return {}
    }
  }
  
  const provider: ContextProvider = {
    id: 'location',
    name: 'Location',
    category: 'spatial',
    priority: 70,
    
    async getContext(): Promise<ContextData | null> {
      const now = Date.now()
      
      // Refresh every 15 minutes
      if (now - lastFetch > 15 * 60 * 1000 || !cachedLocation.source) {
        // Try system location first
        let location = await fetchSystemLocation()
        
        // Fall back to IP location
        if (!location.latitude && settings.ipFallback) {
          location = await fetchIpLocation()
        }
        
        // Fall back to default
        if (!location.city && settings.defaultLocation) {
          location = { ...settings.defaultLocation, source: 'default' as const }
        }
        
        cachedLocation = location
        lastFetch = now
      }
      
      const { latitude, longitude, city, region, country, timezone, source } = cachedLocation
      
      // Check geofences
      const inGeofences = (latitude && longitude) 
        ? checkGeofences(latitude, longitude)
        : []
      
      // Build summary
      const parts: string[] = ['Location:']
      
      if (inGeofences.length > 0) {
        parts.push(`At ${inGeofences[0]}`)
      } else if (city) {
        parts.push(city)
        if (region) parts.push(region)
      } else {
        parts.push('Unknown')
      }
      
      if (timezone) {
        parts.push(`(${timezone})`)
      }
      
      return {
        summary: parts.join(' '),
        details: {
          city,
          region,
          country,
          timezone,
          coordinates: latitude && longitude ? { latitude, longitude } : undefined,
          geofences: inGeofences,
          source,
        },
        timestamp: now,
        ttlMs: 15 * 60 * 1000, // 15 minutes
      }
    },
    
    configure(newSettings: ProviderSettings): void {
      settings = { ...settings, ...newSettings as LocationProviderSettings }
      lastFetch = 0 // Force refresh
    },
    
    isEnabled(): boolean {
      return enabled
    },
    
    enable(): void {
      enabled = true
    },
    
    disable(): void {
      enabled = false
    },
    
    getSettingsSchema(): SettingsSchema {
      return {
        fields: [
          {
            key: 'useSystemLocation',
            label: 'Use system location',
            type: 'boolean',
            description: 'Request precise location from system',
            default: false,
          },
          {
            key: 'ipFallback',
            label: 'Use IP geolocation fallback',
            type: 'boolean',
            description: 'Use IP address for approximate location',
            default: true,
          },
          {
            key: 'defaultLocation.city',
            label: 'Default city',
            type: 'text',
            description: 'City to use when location unavailable',
          },
          {
            key: 'defaultLocation.timezone',
            label: 'Default timezone',
            type: 'text',
            description: 'Timezone to use when location unavailable',
          },
        ],
      }
    },
  }
  
  return provider
}
