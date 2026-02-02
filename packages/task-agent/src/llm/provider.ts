/**
 * LLM Provider - Abstract interface for LLM integration
 */

export interface LLMOptions {
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}

export interface LLMResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface LLMProvider {
  /**
   * Generate a completion
   */
  complete(prompt: string, options?: LLMOptions): Promise<LLMResponse>;

  /**
   * Generate a JSON response
   */
  completeJson<T>(prompt: string, options?: LLMOptions): Promise<T>;
}
