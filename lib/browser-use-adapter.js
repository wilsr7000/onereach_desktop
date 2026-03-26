'use strict';

/**
 * browser-use LLM Adapter
 *
 * Implements browser-use's BaseChatModel interface, routing all LLM calls
 * through our centralized lib/ai-service.js. This preserves cost tracking,
 * profile-based model selection, and provider failover.
 */

const { ChatInvokeCompletion } = require('browser-use/llm/views');
const {
  UserMessage,
  SystemMessage,
  AssistantMessage,
  ContentPartTextParam,
  ContentPartImageParam,
  ImageURL: _ImageURL,
} = require('browser-use/llm/messages');

class GSXChatModel {
  constructor(profile = 'standard') {
    this._profile = profile;
    this.model = `gsx-${profile}`;
    this._verified_api_keys = true;
  }

  get provider() {
    return 'gsx-ai-service';
  }

  get name() {
    return `GSXChatModel(${this._profile})`;
  }

  get model_name() {
    return this.model;
  }

  /**
   * Convert browser-use Message[] to ai-service message format.
   */
  _convertMessages(messages) {
    const converted = [];
    let systemPrompt = null;

    for (const msg of messages) {
      if (msg instanceof SystemMessage || msg.role === 'system') {
        systemPrompt = typeof msg.content === 'string' ? msg.content : msg.text;
        continue;
      }

      if (msg instanceof UserMessage || msg.role === 'user') {
        if (typeof msg.content === 'string') {
          converted.push({ role: 'user', content: msg.content });
        } else if (Array.isArray(msg.content)) {
          const parts = [];
          for (const part of msg.content) {
            if (part instanceof ContentPartTextParam || part.type === 'text') {
              parts.push({ type: 'text', text: part.text });
            } else if (part instanceof ContentPartImageParam || part.type === 'image_url') {
              const url = part.image_url?.url || part.image_url;
              parts.push({
                type: 'image_url',
                image_url: { url: typeof url === 'string' ? url : url.url },
              });
            }
          }
          converted.push({ role: 'user', content: parts });
        }
        continue;
      }

      if (msg instanceof AssistantMessage || msg.role === 'assistant') {
        const text = typeof msg.content === 'string' ? msg.content : msg.text || '';
        converted.push({ role: 'assistant', content: text });
        continue;
      }
    }

    return { systemPrompt, messages: converted };
  }

  /**
   * Main invoke method — implements BaseChatModel.ainvoke().
   */
  async ainvoke(messages, output_format, options) {
    const ai = require('./ai-service');
    const { systemPrompt, messages: converted } = this._convertMessages(messages);

    const hasImages = converted.some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')
    );
    const profile = hasImages ? 'vision' : this._profile;

    const wantsJson = output_format && typeof output_format.parse === 'function';

    const chatOpts = {
      profile,
      messages: converted,
      maxTokens: 8192,
      temperature: 0.1,
      feature: 'desktop-autopilot',
      jsonMode: !!wantsJson,
    };
    if (systemPrompt) chatOpts.system = systemPrompt;

    if (options?.signal) {
      chatOpts.timeout = 120000;
    }

    const result = await ai.chat(chatOpts);
    let text = result.content || '';

    const usage = result.usage
      ? {
          prompt_tokens: result.usage.prompt_tokens || 0,
          completion_tokens: result.usage.completion_tokens || 0,
          total_tokens: result.usage.total_tokens || 0,
        }
      : null;

    let completion = text;
    if (wantsJson) {
      try {
        const parsed = JSON.parse(text);
        completion = output_format.parse(parsed);
      } catch (firstErr) {
        const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[1].trim());
            completion = output_format.parse(parsed);
          } catch {
            throw firstErr;
          }
        } else {
          const braceMatch = text.match(/\{[\s\S]*\}/);
          if (braceMatch) {
            try {
              const parsed = JSON.parse(braceMatch[0]);
              completion = output_format.parse(parsed);
            } catch {
              throw firstErr;
            }
          } else {
            throw firstErr;
          }
        }
      }
    }

    return new ChatInvokeCompletion(completion, usage, null, null, 'stop');
  }
}

module.exports = { GSXChatModel };
