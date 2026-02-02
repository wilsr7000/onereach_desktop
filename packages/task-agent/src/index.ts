/**
 * @onereach/task-agent
 * 
 * SDK for building agents that participate in task auctions
 */

// Types
export * from './types.js';

// Core
export { BaseAgent } from './agent/base-agent.js';

// LLM Providers
export type { LLMProvider, LLMOptions, LLMResponse } from './llm/provider.js';
export { OpenAIProvider } from './llm/openai.js';
export { MockLLMProvider } from './llm/mock.js';

// === Factory Function ===

import { BaseAgent } from './agent/base-agent.js';
import type { AgentConfig, AgentHandlers, BidDecision, ExecutionContext } from './types.js';
import type { Task, TaskResult, BiddingContext } from '@onereach/task-exchange/types';
import type { LLMProvider } from './llm/provider.js';

export interface CreateAgentOptions {
  /** Unique agent name */
  name: string;
  
  /** Semantic version */
  version: string;
  
  /** Categories this agent handles */
  categories: string[];
  
  /** Exchange connection */
  exchange: {
    url: string;
    apiKey?: string;
    reconnect?: boolean;
    reconnectIntervalMs?: number;
    maxReconnectAttempts?: number;
  };
  
  /** Optional LLM for smart bidding */
  llm?: LLMProvider;
  
  /**
   * Fast keyword matching (Tier 1)
   * Return 0 to skip, 0.9+ for confident match
   */
  quickMatch?: (task: Task) => number;
  
  /**
   * LLM-based evaluation (Tier 2)
   * Called when quickMatch returns 0 < score < 0.9
   */
  evaluate?: (task: Task, context: BiddingContext) => Promise<BidDecision | null>;
  
  /**
   * Execute the task
   */
  execute: (task: Task, context: ExecutionContext) => Promise<TaskResult>;
  
  /** Max concurrent tasks */
  maxConcurrent?: number;
}

/**
 * Create an agent instance
 */
export function createAgent(options: CreateAgentOptions): BaseAgent {
  const config: AgentConfig = {
    name: options.name,
    version: options.version,
    categories: options.categories,
    exchange: options.exchange,
    capabilities: {
      quickMatch: !!options.quickMatch,
      llmEvaluate: !!options.evaluate || !!options.llm,
      maxConcurrent: options.maxConcurrent ?? 5,
    },
  };

  // Build evaluate function if LLM provided but no custom evaluate
  let evaluate = options.evaluate;
  if (!evaluate && options.llm) {
    evaluate = createDefaultEvaluate(options.llm, options.name, options.categories);
  }

  const handlers: AgentHandlers = {
    quickMatch: options.quickMatch,
    evaluate,
    execute: options.execute,
  };

  return new BaseAgent(config, handlers);
}

/**
 * Create a default LLM evaluate function
 */
function createDefaultEvaluate(
  llm: LLMProvider,
  agentName: string,
  categories: string[]
): (task: Task, context: BiddingContext) => Promise<BidDecision | null> {
  return async (task: Task, context: BiddingContext): Promise<BidDecision | null> => {
    const prompt = `You are ${agentName}, an agent specialized in: ${categories.join(', ')}.

TASK TO EVALUATE:
Content: ${task.content}
Metadata: ${JSON.stringify(task.metadata)}

CONTEXT:
- Queue depth: ${context.queueDepth} tasks
- Other participating agents: ${context.participatingAgents.join(', ')}

Should you handle this task? Consider:
1. Does this task match your specialization?
2. Can you complete it successfully?
3. How confident are you (0.0-1.0)?

Respond with JSON:
{
  "shouldBid": true/false,
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation",
  "estimatedTimeMs": number
}`;

    try {
      const result = await llm.completeJson<{
        shouldBid: boolean;
        confidence: number;
        reasoning: string;
        estimatedTimeMs: number;
      }>(prompt, { maxTokens: 150, temperature: 0.1 });

      if (!result.shouldBid) {
        return null;
      }

      return {
        shouldBid: true,
        confidence: Math.max(0.05, Math.min(1.0, result.confidence)),
        reasoning: result.reasoning,
        estimatedTimeMs: result.estimatedTimeMs,
        tier: 'llm',
      };
    } catch (error) {
      console.error('[Agent] LLM evaluation failed:', error);
      return null;
    }
  };
}

// === Utility Functions ===

/**
 * Create a keyword-based quickMatch function
 */
export function createKeywordMatcher(keywords: string[]): (task: Task) => number {
  const lowerKeywords = keywords.map(k => k.toLowerCase());

  return (task: Task): number => {
    const content = task.content.toLowerCase();
    const matches = lowerKeywords.filter(kw => content.includes(kw));

    if (matches.length === 0) return 0;
    
    // Score based on match ratio (at least 0.5 if any match)
    const ratio = matches.length / lowerKeywords.length;
    return Math.max(0.5, ratio);
  };
}

/**
 * Create a pattern-based quickMatch function
 */
export function createPatternMatcher(patterns: RegExp[]): (task: Task) => number {
  return (task: Task): number => {
    const content = task.content;
    const matches = patterns.filter(p => p.test(content));

    if (matches.length === 0) return 0;
    
    const ratio = matches.length / patterns.length;
    return Math.max(0.5, ratio);
  };
}
