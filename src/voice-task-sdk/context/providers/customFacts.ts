/**
 * Custom Facts Context Provider
 * 
 * Allows users to define custom facts and preferences:
 * - Personal info (name, preferences)
 * - Project info (current project, team)
 * - Preferences (units, language)
 * - Custom key-value pairs
 */

import type { ContextProvider, ContextData, ProviderSettings, SettingsSchema } from '../types'

export interface Fact {
  key: string
  value: string
  category?: string
  description?: string
}

export interface CustomFactsProviderSettings extends ProviderSettings {
  facts?: Fact[]
  maxFactsInSummary?: number
}

export function createCustomFactsProvider(initialSettings?: CustomFactsProviderSettings): ContextProvider {
  let enabled = true // Enabled by default
  let settings: CustomFactsProviderSettings = {
    facts: [],
    maxFactsInSummary: 5,
    ...initialSettings,
  }
  
  // Load facts from settings storage if available
  function loadFacts(): void {
    if (typeof window !== 'undefined' && (window as any).contextAPI?.getCustomFacts) {
      try {
        const stored = (window as any).contextAPI.getCustomFacts()
        if (Array.isArray(stored)) {
          settings.facts = stored
        }
      } catch (e) {
        // Use initial settings
      }
    }
  }
  
  // Save facts to settings storage
  function saveFacts(): void {
    if (typeof window !== 'undefined' && (window as any).contextAPI?.setCustomFacts) {
      try {
        (window as any).contextAPI.setCustomFacts(settings.facts)
      } catch (e) {
        console.warn('[CustomFactsProvider] Failed to save facts:', e)
      }
    }
  }
  
  const provider: ContextProvider = {
    id: 'custom-facts',
    name: 'Custom Facts',
    category: 'user',
    priority: 85, // High priority - user-defined context is important
    
    async getContext(): Promise<ContextData | null> {
      loadFacts()
      
      const facts = settings.facts || []
      
      if (facts.length === 0) {
        return null // No context if no facts defined
      }
      
      // Group facts by category
      const byCategory: Record<string, Fact[]> = {}
      for (const fact of facts) {
        const cat = fact.category || 'general'
        if (!byCategory[cat]) {
          byCategory[cat] = []
        }
        byCategory[cat].push(fact)
      }
      
      // Build summary (top N facts)
      const topFacts = facts.slice(0, settings.maxFactsInSummary || 5)
      const summaryParts = topFacts.map(f => `${f.key}: ${f.value}`)
      
      return {
        summary: `User facts: ${summaryParts.join(', ')}`,
        details: {
          facts: facts.map(f => ({
            key: f.key,
            value: f.value,
            category: f.category,
          })),
          byCategory,
          totalCount: facts.length,
        },
        timestamp: Date.now(),
        ttlMs: 5 * 60 * 1000, // 5 minute cache
      }
    },
    
    configure(newSettings: ProviderSettings): void {
      settings = { ...settings, ...newSettings as CustomFactsProviderSettings }
      saveFacts()
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
            key: 'facts',
            label: 'Custom Facts',
            type: 'textarea',
            description: 'Enter facts in format: key=value (one per line)',
          },
          {
            key: 'maxFactsInSummary',
            label: 'Max facts in summary',
            type: 'number',
            default: 5,
            validation: { min: 1, max: 20 },
          },
        ],
      }
    },
  }
  
  // Additional methods for programmatic fact management
  const extended = provider as ContextProvider & {
    addFact: (fact: Fact) => void
    removeFact: (key: string) => boolean
    updateFact: (key: string, value: string) => boolean
    getFacts: () => Fact[]
    setFacts: (facts: Fact[]) => void
    clearFacts: () => void
  }
  
  extended.addFact = (fact: Fact) => {
    if (!settings.facts) settings.facts = []
    // Remove existing fact with same key
    settings.facts = settings.facts.filter(f => f.key !== fact.key)
    settings.facts.push(fact)
    saveFacts()
  }
  
  extended.removeFact = (key: string): boolean => {
    if (!settings.facts) return false
    const before = settings.facts.length
    settings.facts = settings.facts.filter(f => f.key !== key)
    saveFacts()
    return settings.facts.length < before
  }
  
  extended.updateFact = (key: string, value: string): boolean => {
    if (!settings.facts) return false
    const fact = settings.facts.find(f => f.key === key)
    if (fact) {
      fact.value = value
      saveFacts()
      return true
    }
    return false
  }
  
  extended.getFacts = () => [...(settings.facts || [])]
  
  extended.setFacts = (facts: Fact[]) => {
    settings.facts = [...facts]
    saveFacts()
  }
  
  extended.clearFacts = () => {
    settings.facts = []
    saveFacts()
  }
  
  return extended
}
