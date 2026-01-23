/**
 * Disambiguator - Handles clarification flow when classifier confidence is low
 * 
 * Features:
 * - State tracking for pending disambiguations
 * - Merges user clarification with original transcript
 * - Supports both voice and HUD button responses
 * - Times out after configurable duration
 */

import type { ClassifiedTask, ClarificationOption } from '../core/types'

export interface DisambiguationState {
  id: string
  originalTranscript: string
  classifiedResult: ClassifiedTask
  question: string
  options: ClarificationOption[]
  createdAt: number
  expiresAt: number
  resolved: boolean
}

export interface DisambiguatorConfig {
  timeoutMs?: number        // How long to wait for clarification (default: 30s)
  maxPendingStates?: number // Max concurrent disambiguations (default: 3)
}

export interface DisambiguationResult {
  success: boolean
  selectedOption?: ClarificationOption
  mergedTranscript?: string
  error?: string
}

export interface Disambiguator {
  // Check if a classification needs disambiguation
  needsDisambiguation: (result: ClassifiedTask | null) => boolean
  
  // Start a disambiguation flow
  startDisambiguation: (result: ClassifiedTask) => DisambiguationState
  
  // Get pending disambiguation by ID
  getPendingState: (id: string) => DisambiguationState | undefined
  
  // Get the most recent pending disambiguation
  getActivePending: () => DisambiguationState | undefined
  
  // Resolve disambiguation with user's choice (from HUD button click)
  resolveWithOption: (stateId: string, optionIndex: number) => DisambiguationResult
  
  // Resolve disambiguation with voice response
  resolveWithVoice: (stateId: string, voiceResponse: string) => DisambiguationResult
  
  // Cancel/timeout a pending disambiguation
  cancel: (stateId: string) => void
  
  // Clean up expired states
  cleanup: () => void
  
  // Get all pending states
  listPending: () => DisambiguationState[]
  
  // Clear all states
  clearAll: () => void
}

export function createDisambiguator(config: DisambiguatorConfig = {}): Disambiguator {
  const { timeoutMs = 30000, maxPendingStates = 3 } = config
  
  const pendingStates = new Map<string, DisambiguationState>()
  
  function generateId(): string {
    return `disamb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  }
  
  function needsDisambiguation(result: ClassifiedTask | null): boolean {
    if (!result) return false
    return result.clarificationNeeded === true && 
           Array.isArray(result.clarificationOptions) && 
           result.clarificationOptions.length > 0
  }
  
  function startDisambiguation(result: ClassifiedTask): DisambiguationState {
    // Clean up expired states first
    cleanup()
    
    // Enforce max pending states limit
    if (pendingStates.size >= maxPendingStates) {
      // Remove oldest state
      const oldest = Array.from(pendingStates.values())
        .sort((a, b) => a.createdAt - b.createdAt)[0]
      if (oldest) {
        pendingStates.delete(oldest.id)
      }
    }
    
    const state: DisambiguationState = {
      id: generateId(),
      originalTranscript: result.content,
      classifiedResult: result,
      question: result.clarificationQuestion || 'Could you clarify what you meant?',
      options: result.clarificationOptions || [],
      createdAt: Date.now(),
      expiresAt: Date.now() + timeoutMs,
      resolved: false,
    }
    
    pendingStates.set(state.id, state)
    
    return state
  }
  
  function getPendingState(id: string): DisambiguationState | undefined {
    const state = pendingStates.get(id)
    if (state && !state.resolved && state.expiresAt > Date.now()) {
      return state
    }
    return undefined
  }
  
  function getActivePending(): DisambiguationState | undefined {
    const now = Date.now()
    // Get the most recent non-expired, non-resolved state
    const active = Array.from(pendingStates.values())
      .filter(s => !s.resolved && s.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    return active
  }
  
  function resolveWithOption(stateId: string, optionIndex: number): DisambiguationResult {
    const state = pendingStates.get(stateId)
    
    if (!state) {
      return { success: false, error: 'Disambiguation state not found' }
    }
    
    if (state.resolved) {
      return { success: false, error: 'Disambiguation already resolved' }
    }
    
    if (state.expiresAt < Date.now()) {
      pendingStates.delete(stateId)
      return { success: false, error: 'Disambiguation timed out' }
    }
    
    const option = state.options[optionIndex]
    if (!option) {
      return { success: false, error: 'Invalid option index' }
    }
    
    // Mark as resolved
    state.resolved = true
    
    // Create merged transcript that includes the clarification
    const mergedTranscript = `${state.originalTranscript} (clarification: ${option.label})`
    
    return {
      success: true,
      selectedOption: option,
      mergedTranscript,
    }
  }
  
  function resolveWithVoice(stateId: string, voiceResponse: string): DisambiguationResult {
    const state = pendingStates.get(stateId)
    
    if (!state) {
      return { success: false, error: 'Disambiguation state not found' }
    }
    
    if (state.resolved) {
      return { success: false, error: 'Disambiguation already resolved' }
    }
    
    if (state.expiresAt < Date.now()) {
      pendingStates.delete(stateId)
      return { success: false, error: 'Disambiguation timed out' }
    }
    
    // Try to match voice response to an option
    const normalizedResponse = voiceResponse.toLowerCase().trim()
    
    // First, try exact match on label
    let matchedIndex = state.options.findIndex(opt => 
      opt.label.toLowerCase().trim() === normalizedResponse
    )
    
    // Try partial match
    if (matchedIndex === -1) {
      matchedIndex = state.options.findIndex(opt =>
        normalizedResponse.includes(opt.label.toLowerCase()) ||
        opt.label.toLowerCase().includes(normalizedResponse)
      )
    }
    
    // Try number response ("1", "2", "first", "second", etc.)
    if (matchedIndex === -1) {
      const numberWords: Record<string, number> = {
        'one': 0, 'first': 0, '1': 0,
        'two': 0, 'second': 1, '2': 1,
        'three': 2, 'third': 2, '3': 2,
        'four': 3, 'fourth': 3, '4': 3,
        'five': 4, 'fifth': 4, '5': 4,
      }
      
      for (const [word, index] of Object.entries(numberWords)) {
        if (normalizedResponse.includes(word) && index < state.options.length) {
          matchedIndex = index
          break
        }
      }
    }
    
    // Mark as resolved regardless of match
    state.resolved = true
    
    if (matchedIndex >= 0) {
      const option = state.options[matchedIndex]
      return {
        success: true,
        selectedOption: option,
        mergedTranscript: `${state.originalTranscript} (clarification: ${option.label})`,
      }
    }
    
    // No match found - use the voice response as additional context
    return {
      success: true,
      mergedTranscript: `${state.originalTranscript} (user clarified: ${voiceResponse})`,
    }
  }
  
  function cancel(stateId: string): void {
    const state = pendingStates.get(stateId)
    if (state) {
      state.resolved = true
    }
  }
  
  function cleanup(): void {
    const now = Date.now()
    for (const [id, state] of pendingStates.entries()) {
      if (state.resolved || state.expiresAt < now) {
        pendingStates.delete(id)
      }
    }
  }
  
  function listPending(): DisambiguationState[] {
    cleanup()
    return Array.from(pendingStates.values())
      .filter(s => !s.resolved)
      .sort((a, b) => b.createdAt - a.createdAt)
  }
  
  function clearAll(): void {
    pendingStates.clear()
  }
  
  return {
    needsDisambiguation,
    startDisambiguation,
    getPendingState,
    getActivePending,
    resolveWithOption,
    resolveWithVoice,
    cancel,
    cleanup,
    listPending,
    clearAll,
  }
}

// Export singleton instance for convenience
let defaultDisambiguator: Disambiguator | null = null

export function getDisambiguator(config?: DisambiguatorConfig): Disambiguator {
  if (!defaultDisambiguator) {
    defaultDisambiguator = createDisambiguator(config)
  }
  return defaultDisambiguator
}
