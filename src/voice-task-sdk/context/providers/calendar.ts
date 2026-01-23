/**
 * Calendar Context Provider
 * 
 * Provides calendar context:
 * - Current/upcoming meetings
 * - Today's events
 * - Free/busy status
 * 
 * Supports integration with:
 * - macOS Calendar (via AppleScript)
 * - Google Calendar API
 * - iCal URL feeds
 */

import type { ContextProvider, ContextData, ProviderSettings, SettingsSchema } from '../types'

export interface CalendarEvent {
  title: string
  startTime: Date
  endTime: Date
  location?: string
  isAllDay?: boolean
  organizer?: string
}

export interface CalendarProviderSettings extends ProviderSettings {
  source?: 'system' | 'google' | 'ical'
  googleCalendarId?: string
  googleApiKey?: string
  icalUrl?: string
  lookaheadHours?: number
  maxEvents?: number
}

export function createCalendarProvider(initialSettings?: CalendarProviderSettings): ContextProvider {
  let enabled = false // Disabled by default - requires configuration
  let settings: CalendarProviderSettings = {
    source: 'system',
    lookaheadHours: 24,
    maxEvents: 5,
    ...initialSettings,
  }
  
  // Cached events
  let cachedEvents: CalendarEvent[] = []
  let lastFetch = 0
  
  async function fetchSystemCalendar(): Promise<CalendarEvent[]> {
    // In Electron main process, this would use AppleScript on macOS
    // For now, return empty or use IPC
    if (typeof window !== 'undefined' && (window as any).contextAPI?.getCalendarEvents) {
      try {
        return await (window as any).contextAPI.getCalendarEvents(settings.lookaheadHours)
      } catch (e) {
        console.warn('[CalendarProvider] Failed to fetch system calendar:', e)
      }
    }
    return []
  }
  
  async function fetchGoogleCalendar(): Promise<CalendarEvent[]> {
    if (!settings.googleCalendarId || !settings.googleApiKey) {
      return []
    }
    
    try {
      const now = new Date()
      const later = new Date(now.getTime() + (settings.lookaheadHours || 24) * 60 * 60 * 1000)
      
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(settings.googleCalendarId)}/events?` +
        `key=${settings.googleApiKey}&` +
        `timeMin=${now.toISOString()}&` +
        `timeMax=${later.toISOString()}&` +
        `maxResults=${settings.maxEvents || 5}&` +
        `singleEvents=true&` +
        `orderBy=startTime`
      
      const response = await fetch(url)
      const data = await response.json()
      
      if (data.items) {
        return data.items.map((item: any) => ({
          title: item.summary || 'Untitled',
          startTime: new Date(item.start.dateTime || item.start.date),
          endTime: new Date(item.end.dateTime || item.end.date),
          location: item.location,
          isAllDay: !item.start.dateTime,
          organizer: item.organizer?.displayName,
        }))
      }
    } catch (e) {
      console.warn('[CalendarProvider] Failed to fetch Google Calendar:', e)
    }
    
    return []
  }
  
  async function fetchIcalFeed(): Promise<CalendarEvent[]> {
    // iCal parsing would be implemented here
    // For now, return empty
    return []
  }
  
  async function fetchEvents(): Promise<CalendarEvent[]> {
    switch (settings.source) {
      case 'google':
        return fetchGoogleCalendar()
      case 'ical':
        return fetchIcalFeed()
      case 'system':
      default:
        return fetchSystemCalendar()
    }
  }
  
  function getCurrentMeeting(events: CalendarEvent[]): CalendarEvent | undefined {
    const now = new Date()
    return events.find(e => 
      !e.isAllDay &&
      e.startTime <= now && 
      e.endTime > now
    )
  }
  
  function getNextMeeting(events: CalendarEvent[]): CalendarEvent | undefined {
    const now = new Date()
    return events.find(e => 
      !e.isAllDay &&
      e.startTime > now
    )
  }
  
  function formatTimeUntil(event: CalendarEvent): string {
    const now = new Date()
    const diffMs = event.startTime.getTime() - now.getTime()
    const diffMins = Math.round(diffMs / 60000)
    
    if (diffMins < 1) return 'now'
    if (diffMins < 60) return `in ${diffMins} minute${diffMins === 1 ? '' : 's'}`
    
    const diffHours = Math.round(diffMins / 60)
    return `in ${diffHours} hour${diffHours === 1 ? '' : 's'}`
  }
  
  const provider: ContextProvider = {
    id: 'calendar',
    name: 'Calendar',
    category: 'temporal',
    priority: 80,
    
    async getContext(): Promise<ContextData | null> {
      const now = Date.now()
      
      // Refresh events every 5 minutes
      if (now - lastFetch > 5 * 60 * 1000) {
        try {
          cachedEvents = await fetchEvents()
          lastFetch = now
        } catch (e) {
          // Use cached events
        }
      }
      
      if (cachedEvents.length === 0) {
        return {
          summary: 'Calendar: No upcoming events',
          details: {
            events: [],
            currentMeeting: null,
            nextMeeting: null,
            status: 'free',
          },
          timestamp: now,
          ttlMs: 5 * 60 * 1000,
        }
      }
      
      const current = getCurrentMeeting(cachedEvents)
      const next = getNextMeeting(cachedEvents)
      
      // Build summary
      const parts: string[] = ['Calendar:']
      
      if (current) {
        parts.push(`In meeting "${current.title}"`)
      } else if (next) {
        parts.push(`Next: "${next.title}" ${formatTimeUntil(next)}`)
      } else {
        parts.push('Free for the day')
      }
      
      return {
        summary: parts.join(' '),
        details: {
          events: cachedEvents.slice(0, settings.maxEvents).map(e => ({
            title: e.title,
            startTime: e.startTime.toISOString(),
            endTime: e.endTime.toISOString(),
            location: e.location,
            isAllDay: e.isAllDay,
          })),
          currentMeeting: current ? {
            title: current.title,
            endsAt: current.endTime.toISOString(),
          } : null,
          nextMeeting: next ? {
            title: next.title,
            startsAt: next.startTime.toISOString(),
            timeUntil: formatTimeUntil(next),
          } : null,
          status: current ? 'busy' : 'free',
        },
        timestamp: now,
        ttlMs: 60000, // Update every minute
      }
    },
    
    configure(newSettings: ProviderSettings): void {
      settings = { ...settings, ...newSettings as CalendarProviderSettings }
      lastFetch = 0 // Force refresh on config change
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
            key: 'source',
            label: 'Calendar Source',
            type: 'select',
            options: [
              { label: 'System Calendar (macOS)', value: 'system' },
              { label: 'Google Calendar', value: 'google' },
              { label: 'iCal URL', value: 'ical' },
            ],
            default: 'system',
          },
          {
            key: 'googleCalendarId',
            label: 'Google Calendar ID',
            type: 'text',
            description: 'Your Google Calendar ID (primary or email)',
          },
          {
            key: 'googleApiKey',
            label: 'Google API Key',
            type: 'password',
            description: 'Google Calendar API key',
          },
          {
            key: 'icalUrl',
            label: 'iCal URL',
            type: 'text',
            description: 'URL to iCal feed',
          },
          {
            key: 'lookaheadHours',
            label: 'Look-ahead hours',
            type: 'number',
            default: 24,
            validation: { min: 1, max: 168 },
          },
          {
            key: 'maxEvents',
            label: 'Max events to show',
            type: 'number',
            default: 5,
            validation: { min: 1, max: 20 },
          },
        ],
      }
    },
  }
  
  return provider
}
