/**
 * OpenAI provider resolution (ADR-094): keychain > env > file for the
 * key; explicit AI_PROVIDER > the Settings "Use" preference > Claude,
 * then OpenAI, then the flow. Pure `resolveAiConfig`.
 */
import { describe, it, expect } from 'vitest';
import { resolveAiConfig, DEFAULT_OPENAI_MODEL, DEFAULT_OPENAI_BASE_URL } from '../../ai/config.js';

describe('resolveAiConfig — OpenAI', () => {
  it('OPENAI_API_KEY alone configures OpenAI with the default model + base URL', () => {
    const cfg = resolveAiConfig({ OPENAI_API_KEY: 'sk-env' }, null);
    expect(cfg).toEqual({
      provider: 'openai',
      apiKey: 'sk-env',
      model: DEFAULT_OPENAI_MODEL,
      baseUrl: DEFAULT_OPENAI_BASE_URL,
    });
    expect(DEFAULT_OPENAI_MODEL).toBe('gpt-5.2');
  });

  it('the keychain key wins over env, env over the file; model/baseUrl come from env then file', () => {
    const file = JSON.stringify({ openai: { apiKey: 'sk-file', model: 'gpt-file', baseUrl: 'https://file.example' } });
    expect(resolveAiConfig({ OPENAI_API_KEY: 'sk-env' }, file, null, { openAiKeychainKey: 'sk-keychain' })).toMatchObject({
      apiKey: 'sk-keychain',
      model: 'gpt-file',
      baseUrl: 'https://file.example',
    });
    expect(resolveAiConfig({ OPENAI_API_KEY: 'sk-env', OPENAI_MODEL: 'gpt-env' }, file)).toMatchObject({
      apiKey: 'sk-env',
      model: 'gpt-env',
    });
  });

  it('with both keys, Claude wins by default and the "Use" preference flips it', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-oai' };
    expect(resolveAiConfig(env, null)?.provider).toBe('claude');
    expect(resolveAiConfig(env, null, null, { preferredProvider: 'auto' })?.provider).toBe('claude');
    expect(resolveAiConfig(env, null, null, { preferredProvider: 'openai' })?.provider).toBe('openai');
    expect(resolveAiConfig(env, null, null, { preferredProvider: 'claude' })?.provider).toBe('claude');
  });

  it('a preference for a provider with no key falls back to auto order', () => {
    expect(
      resolveAiConfig({ ANTHROPIC_API_KEY: 'sk-ant' }, null, null, { preferredProvider: 'openai' })?.provider
    ).toBe('claude');
    expect(
      resolveAiConfig({ OPENAI_API_KEY: 'sk-oai' }, null, null, { preferredProvider: 'claude' })?.provider
    ).toBe('openai');
  });

  it('an explicit AI_PROVIDER beats the preference', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-oai', AI_PROVIDER: 'openai' };
    expect(resolveAiConfig(env, null, null, { preferredProvider: 'claude' })?.provider).toBe('openai');
  });

  it('OpenAI ranks above the OneReach flow in auto order', () => {
    expect(
      resolveAiConfig({ OPENAI_API_KEY: 'sk-oai', ONEREACH_FLOW_URL: 'https://flow.example/run' }, null)?.provider
    ).toBe('openai');
  });

  it('a blank OpenAI key is not configured', () => {
    expect(resolveAiConfig({ OPENAI_API_KEY: '   ' }, null)).toBeNull();
  });
});
