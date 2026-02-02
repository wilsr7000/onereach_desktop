/**
 * Prompt Builder - Dynamically builds AI classification prompts from actions
 * 
 * Creates a structured prompt that helps the AI model understand:
 * - Available actions and their descriptions
 * - Expected parameters for each action
 * - Example trigger phrases
 * - Context about the current app state
 */

import type { Action, AppContext, ConversationEntry } from '../core/types'

export interface PromptBuilderConfig {
  systemPromptPrefix?: string
  systemPromptSuffix?: string
  includeExamples?: boolean
  includeParams?: boolean
  maxHistoryLength?: number
}

export interface BuiltPrompt {
  systemPrompt: string
  userPrompt: string
  actionNames: string[]
}

export interface PromptBuilder {
  build: (transcript: string, actions: Action[], ctx: AppContext) => BuiltPrompt
  setConfig: (config: Partial<PromptBuilderConfig>) => void
  getConfig: () => PromptBuilderConfig
}

const DEFAULT_SYSTEM_PREFIX = `You are a voice command classifier. Your job is to understand user voice commands and classify them into specific actions.

IMPORTANT RULES:
1. Only classify commands that match available actions
2. Extract parameters mentioned in the command
3. If the command doesn't match any action, respond with action: "unknown"
4. Be case-insensitive when matching
5. Consider the conversation history for context`

const DEFAULT_SYSTEM_SUFFIX = `
Respond ONLY with valid JSON in this exact format:
{
  "action": "action_name",
  "params": { "param_name": "value" },
  "confidence": 0.0 to 1.0,
  "priority": 1, 2, or 3 (1=low, 2=normal, 3=high)
}

If no action matches, respond with:
{
  "action": "unknown",
  "params": {},
  "confidence": 0,
  "priority": 2
}`

export function createPromptBuilder(initialConfig: PromptBuilderConfig = {}): PromptBuilder {
  let config: PromptBuilderConfig = {
    systemPromptPrefix: DEFAULT_SYSTEM_PREFIX,
    systemPromptSuffix: DEFAULT_SYSTEM_SUFFIX,
    includeExamples: true,
    includeParams: true,
    maxHistoryLength: 10,
    ...initialConfig,
  }

  function buildActionList(actions: Action[]): string {
    if (actions.length === 0) {
      return 'No actions available.'
    }

    const lines: string[] = ['AVAILABLE ACTIONS:']

    for (const action of actions) {
      lines.push('')
      lines.push(`## ${action.name}`)
      lines.push(`Description: ${action.description}`)

      if (config.includeParams && action.params.length > 0) {
        lines.push('Parameters:')
        for (const param of action.params) {
          const required = param.required ? '(required)' : '(optional)'
          const defaultVal = param.default !== undefined ? `, default: ${JSON.stringify(param.default)}` : ''
          lines.push(`  - ${param.name}: ${param.type} ${required}${defaultVal}`)
          if (param.description) {
            lines.push(`    ${param.description}`)
          }
        }
      }

      if (config.includeExamples && action.examples && action.examples.length > 0) {
        lines.push('Example phrases:')
        for (const example of action.examples) {
          lines.push(`  - "${example}"`)
        }
      }
    }

    return lines.join('\n')
  }

  function buildContextInfo(ctx: AppContext): string {
    const parts: string[] = []

    if (ctx.activeDocument) {
      parts.push(`Active document: ${ctx.activeDocument}`)
    }

    if (ctx.selectedText) {
      parts.push(`Selected text: "${ctx.selectedText.slice(0, 100)}${ctx.selectedText.length > 100 ? '...' : ''}"`)
    }

    if (ctx.currentUser) {
      parts.push(`Current user: ${ctx.currentUser.id} (role: ${ctx.currentUser.role})`)
    }

    if (ctx.metadata && Object.keys(ctx.metadata).length > 0) {
      parts.push(`Additional context: ${JSON.stringify(ctx.metadata)}`)
    }

    if (parts.length === 0) {
      return ''
    }

    return '\nCURRENT CONTEXT:\n' + parts.join('\n')
  }

  function buildConversationHistory(history: ConversationEntry[] | undefined): string {
    if (!history || history.length === 0) {
      return ''
    }

    const maxLength = config.maxHistoryLength ?? 10
    const recentHistory = history.slice(-maxLength)

    const lines: string[] = ['\nRECENT CONVERSATION:']
    for (const entry of recentHistory) {
      const role = entry.role === 'user' ? 'User' : 'Assistant'
      lines.push(`${role}: ${entry.content}`)
    }

    return lines.join('\n')
  }

  function build(transcript: string, actions: Action[], ctx: AppContext): BuiltPrompt {
    // Filter to only enabled actions
    const enabledActions = actions.filter(a => a.enabled)

    const systemParts = [
      config.systemPromptPrefix ?? DEFAULT_SYSTEM_PREFIX,
      '',
      buildActionList(enabledActions),
      buildContextInfo(ctx),
      buildConversationHistory(ctx.conversationHistory),
      '',
      config.systemPromptSuffix ?? DEFAULT_SYSTEM_SUFFIX,
    ]

    return {
      systemPrompt: systemParts.filter(Boolean).join('\n'),
      userPrompt: transcript,
      actionNames: enabledActions.map(a => a.name),
    }
  }

  function setConfig(newConfig: Partial<PromptBuilderConfig>): void {
    config = { ...config, ...newConfig }
  }

  function getConfig(): PromptBuilderConfig {
    return { ...config }
  }

  return {
    build,
    setConfig,
    getConfig,
  }
}
