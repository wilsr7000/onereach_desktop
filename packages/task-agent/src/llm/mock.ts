/**
 * Mock LLM Provider - For testing
 */
import type { LLMProvider, LLMOptions, LLMResponse } from './provider.js';

export interface MockResponse {
  content?: string;
  json?: unknown;
}

export class MockLLMProvider implements LLMProvider {
  private responses: MockResponse[] = [];
  private callCount = 0;
  private lastPrompt: string = '';

  /**
   * Set responses to return (in order)
   */
  setResponses(responses: MockResponse[]): void {
    this.responses = responses;
    this.callCount = 0;
  }

  /**
   * Add a response
   */
  addResponse(response: MockResponse): void {
    this.responses.push(response);
  }

  async complete(prompt: string, _options?: LLMOptions): Promise<LLMResponse> {
    this.lastPrompt = prompt;
    const response = this.responses[this.callCount] ?? { content: 'Mock response' };
    this.callCount++;

    // Simulate latency
    await new Promise(resolve => setTimeout(resolve, 10));

    return {
      content: response.content ?? 'Mock response',
      usage: {
        promptTokens: prompt.length / 4,
        completionTokens: 50,
        totalTokens: prompt.length / 4 + 50,
      },
    };
  }

  async completeJson<T>(prompt: string, _options?: LLMOptions): Promise<T> {
    this.lastPrompt = prompt;
    const response = this.responses[this.callCount] ?? { json: {} };
    this.callCount++;

    // Simulate latency
    await new Promise(resolve => setTimeout(resolve, 10));

    return (response.json ?? {}) as T;
  }

  /**
   * Get the last prompt that was sent
   */
  getLastPrompt(): string {
    return this.lastPrompt;
  }

  /**
   * Get how many times complete/completeJson was called
   */
  getCallCount(): number {
    return this.callCount;
  }

  /**
   * Reset the mock
   */
  reset(): void {
    this.responses = [];
    this.callCount = 0;
    this.lastPrompt = '';
  }
}
