/**
 * Disambiguator - DEPRECATED
 * 
 * Disambiguation is now handled centrally in exchange-bridge.js using LLM-based
 * clarification options via the exchange:halt event handler.
 * 
 * These exports are preserved as no-ops to avoid breaking existing imports.
 */

export interface DisambiguationState {
  id: string
  originalTranscript: string
  classifiedResult: any
  question: string
  options: any[]
  createdAt: number
  expiresAt: number
  resolved: boolean
}

export interface DisambiguatorConfig {
  timeoutMs?: number
  maxPendingStates?: number
}

export interface DisambiguationResult {
  success: boolean
  selectedOption?: any
  mergedTranscript?: string
  error?: string
}

export interface Disambiguator {
  needsDisambiguation: (result: any) => boolean
  startDisambiguation: (result: any) => DisambiguationState
  getPendingState: (id: string) => DisambiguationState | undefined
  getActivePending: () => DisambiguationState | undefined
  resolveWithOption: (stateId: string, optionIndex: number) => DisambiguationResult
  resolveWithVoice: (stateId: string, voiceResponse: string) => DisambiguationResult
  cancel: (stateId: string) => void
  cleanup: () => void
  listPending: () => DisambiguationState[]
  clearAll: () => void
}

/**
 * @deprecated Use exchange-bridge.js exchange:halt handler instead
 */
export function createDisambiguator(_config: DisambiguatorConfig = {}): Disambiguator {
  console.warn('[Disambiguator] DEPRECATED - disambiguation is now handled in exchange-bridge.js')
  return {
    needsDisambiguation: () => false,
    startDisambiguation: (result: any) => ({
      id: 'deprecated', originalTranscript: result?.content || '', classifiedResult: result,
      question: '', options: [], createdAt: Date.now(), expiresAt: Date.now(), resolved: true,
    }),
    getPendingState: () => undefined,
    getActivePending: () => undefined,
    resolveWithOption: () => ({ success: false, error: 'Disambiguator deprecated' }),
    resolveWithVoice: () => ({ success: false, error: 'Disambiguator deprecated' }),
    cancel: () => {},
    cleanup: () => {},
    listPending: () => [],
    clearAll: () => {},
  }
}

let defaultDisambiguator: Disambiguator | null = null

/**
 * @deprecated Use exchange-bridge.js exchange:halt handler instead
 */
export function getDisambiguator(config?: DisambiguatorConfig): Disambiguator {
  if (!defaultDisambiguator) {
    defaultDisambiguator = createDisambiguator(config)
  }
  return defaultDisambiguator
}
