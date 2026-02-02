/**
 * OpenAI LLM Provider
 */
import type { LLMProvider, LLMOptions, LLMResponse } from './provider.js';

export interface OpenAIProviderConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export class OpenAIProvider implements LLMProvider {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;
  private model: string;
  private config: OpenAIProviderConfig;
  private initialized = false;

  constructor(config: OpenAIProviderConfig) {
    this.config = config;
    this.model = config.model ?? 'gpt-4o-mini';
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    try {
      const OpenAI = (await import('openai')).default;
      this.client = new OpenAI({
        apiKey: this.config.apiKey,
        baseURL: this.config.baseUrl,
      });
      this.initialized = true;
    } catch {
      throw new Error('OpenAI package not installed. Run: npm install openai');
    }
  }

  async complete(prompt: string, options: LLMOptions = {}): Promise<LLMResponse> {
    await this.ensureInitialized();

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: options.maxTokens ?? 500,
      temperature: options.temperature ?? 0.1,
    });

    return {
      content: response.choices[0]?.message?.content ?? '',
      usage: response.usage ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      } : undefined,
    };
  }

  async completeJson<T>(prompt: string, options: LLMOptions = {}): Promise<T> {
    await this.ensureInitialized();

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: options.maxTokens ?? 500,
      temperature: options.temperature ?? 0.1,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content ?? '{}';
    return JSON.parse(content) as T;
  }
}
