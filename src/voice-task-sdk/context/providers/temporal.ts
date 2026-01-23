/**
 * Temporal Context Provider
 * 
 * Provides time and date context:
 * - Current time with timezone
 * - Day of week
 * - Date
 * - Part of day (morning, afternoon, evening, night)
 */

import type { ContextProvider, ContextData, ProviderSettings, SettingsSchema } from '../types'

export interface TemporalProviderSettings extends ProviderSettings {
  timezone?: string
  locale?: string
  use24Hour?: boolean
}

export function createTemporalProvider(initialSettings?: TemporalProviderSettings): ContextProvider {
  let enabled = true
  let settings: TemporalProviderSettings = {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: 'en-US',
    use24Hour: false,
    ...initialSettings,
  }
  
  function getPartOfDay(hour: number): string {
    if (hour >= 5 && hour < 12) return 'morning'
    if (hour >= 12 && hour < 17) return 'afternoon'
    if (hour >= 17 && hour < 21) return 'evening'
    return 'night'
  }
  
  function formatTime(date: Date): string {
    const options: Intl.DateTimeFormatOptions = {
      hour: 'numeric',
      minute: '2-digit',
      hour12: !settings.use24Hour,
      timeZone: settings.timezone,
    }
    return date.toLocaleTimeString(settings.locale, options)
  }
  
  function formatDate(date: Date): string {
    const options: Intl.DateTimeFormatOptions = {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: settings.timezone,
    }
    return date.toLocaleDateString(settings.locale, options)
  }
  
  const provider: ContextProvider = {
    id: 'temporal',
    name: 'Time & Date',
    category: 'temporal',
    priority: 100, // High priority - always useful
    
    async getContext(): Promise<ContextData> {
      const now = new Date()
      const hour = now.getHours()
      const partOfDay = getPartOfDay(hour)
      
      const timeStr = formatTime(now)
      const dateStr = formatDate(now)
      
      return {
        summary: `Time: ${timeStr}, ${dateStr} (${partOfDay})`,
        details: {
          time: timeStr,
          date: dateStr,
          dayOfWeek: now.toLocaleDateString(settings.locale, { weekday: 'long', timeZone: settings.timezone }),
          partOfDay,
          hour,
          minute: now.getMinutes(),
          timestamp: now.getTime(),
          timezone: settings.timezone,
          iso: now.toISOString(),
        },
        timestamp: now.getTime(),
        ttlMs: 60000, // Update every minute
      }
    },
    
    configure(newSettings: ProviderSettings): void {
      settings = { ...settings, ...newSettings as TemporalProviderSettings }
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
            key: 'timezone',
            label: 'Timezone',
            type: 'text',
            description: 'IANA timezone (e.g., America/New_York)',
            default: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
          {
            key: 'locale',
            label: 'Locale',
            type: 'text',
            description: 'Locale for formatting (e.g., en-US)',
            default: 'en-US',
          },
          {
            key: 'use24Hour',
            label: 'Use 24-hour time',
            type: 'boolean',
            default: false,
          },
        ],
      }
    },
  }
  
  return provider
}
