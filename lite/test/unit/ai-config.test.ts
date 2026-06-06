import { describe, it, expect } from 'vitest';
import {
  resolveAiConfig,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_ANTHROPIC_BASE_URL,
} from '../../ai/config.js';

describe('resolveAiConfig', () => {
  it('returns null when nothing is configured', () => {
    expect(resolveAiConfig({}, null)).toBeNull();
  });

  it('uses Claude when only ANTHROPIC_API_KEY is set, with defaults', () => {
    const cfg = resolveAiConfig({ ANTHROPIC_API_KEY: 'sk-ant-test' }, null);
    expect(cfg).toEqual({
      provider: 'claude',
      apiKey: 'sk-ant-test',
      model: DEFAULT_CLAUDE_MODEL,
      baseUrl: DEFAULT_ANTHROPIC_BASE_URL,
    });
  });

  it('honors ANTHROPIC_MODEL + ANTHROPIC_BASE_URL overrides', () => {
    const cfg = resolveAiConfig(
      {
        ANTHROPIC_API_KEY: 'sk',
        ANTHROPIC_MODEL: 'claude-haiku-4-5',
        ANTHROPIC_BASE_URL: 'https://proxy.example.com',
      },
      null
    );
    expect(cfg).toMatchObject({
      provider: 'claude',
      model: 'claude-haiku-4-5',
      baseUrl: 'https://proxy.example.com',
    });
  });

  it('uses the OneReach flow when a flow url is set (token minted from login)', () => {
    const cfg = resolveAiConfig({ ONEREACH_FLOW_URL: 'https://flow.example/run' }, null);
    expect(cfg).toEqual({ provider: 'onereach-flow', url: 'https://flow.example/run' });
  });

  it('includes a token override only when ONEREACH_FLOW_TOKEN is set', () => {
    const cfg = resolveAiConfig(
      { ONEREACH_FLOW_URL: 'https://flow.example/run', ONEREACH_FLOW_TOKEN: 'tok' },
      null
    );
    expect(cfg).toEqual({ provider: 'onereach-flow', url: 'https://flow.example/run', token: 'tok' });
  });

  it('prefers Claude when both providers are ready and no AI_PROVIDER is set', () => {
    const cfg = resolveAiConfig(
      { ANTHROPIC_API_KEY: 'sk', ONEREACH_FLOW_URL: 'https://flow.example/run' },
      null
    );
    expect(cfg?.provider).toBe('claude');
  });

  it('honors an explicit AI_PROVIDER when that provider is ready', () => {
    const cfg = resolveAiConfig(
      {
        AI_PROVIDER: 'onereach-flow',
        ANTHROPIC_API_KEY: 'sk',
        ONEREACH_FLOW_URL: 'https://flow.example/run',
      },
      null
    );
    expect(cfg?.provider).toBe('onereach-flow');
  });

  it('falls back to the ready provider when AI_PROVIDER names an unconfigured one', () => {
    // Asks for the flow, but only Claude is actually configured.
    const cfg = resolveAiConfig({ AI_PROVIDER: 'onereach-flow', ANTHROPIC_API_KEY: 'sk' }, null);
    expect(cfg?.provider).toBe('claude');
  });

  it('reads config from the file when env is empty', () => {
    const file = JSON.stringify({
      provider: 'claude',
      claude: { apiKey: 'sk-from-file', model: 'claude-opus-4-8' },
    });
    const cfg = resolveAiConfig({}, file);
    expect(cfg).toMatchObject({ provider: 'claude', apiKey: 'sk-from-file' });
  });

  it('lets env override the file per field (env key wins)', () => {
    const file = JSON.stringify({ claude: { apiKey: 'sk-from-file' } });
    const cfg = resolveAiConfig({ ANTHROPIC_API_KEY: 'sk-from-env' }, file);
    expect(cfg).toMatchObject({ provider: 'claude', apiKey: 'sk-from-env' });
  });

  it('ignores whitespace-only values', () => {
    expect(resolveAiConfig({ ANTHROPIC_API_KEY: '   ' }, null)).toBeNull();
  });

  it('ignores a malformed config file and falls back to env', () => {
    const cfg = resolveAiConfig({ ANTHROPIC_API_KEY: 'sk' }, '{ not valid json');
    expect(cfg).toMatchObject({ provider: 'claude', apiKey: 'sk' });
  });

  it('reads a OneReach flow from the file (url alone)', () => {
    const file = JSON.stringify({ provider: 'onereach-flow', onereachFlow: { url: 'https://flow/run' } });
    expect(resolveAiConfig({}, file)).toEqual({ provider: 'onereach-flow', url: 'https://flow/run' });
  });

  // ── keychain key precedence (Settings -> AI) ──────────────────────────────

  it('uses the keychain key when env + file have none', () => {
    const cfg = resolveAiConfig({}, null, 'sk-ant-keychain');
    expect(cfg).toMatchObject({ provider: 'claude', apiKey: 'sk-ant-keychain' });
  });

  it('prefers the keychain key over both the env key and the file key', () => {
    const file = JSON.stringify({ claude: { apiKey: 'sk-from-file' } });
    const cfg = resolveAiConfig({ ANTHROPIC_API_KEY: 'sk-from-env' }, file, 'sk-from-keychain');
    expect(cfg).toMatchObject({ provider: 'claude', apiKey: 'sk-from-keychain' });
  });

  it('still honors ANTHROPIC_MODEL when the key comes from the keychain', () => {
    const cfg = resolveAiConfig({ ANTHROPIC_MODEL: 'claude-haiku-4-5' }, null, 'sk-ant-keychain');
    expect(cfg).toMatchObject({ apiKey: 'sk-ant-keychain', model: 'claude-haiku-4-5' });
  });

  it('ignores a whitespace-only / null keychain key and falls back to env', () => {
    expect(resolveAiConfig({ ANTHROPIC_API_KEY: 'sk-env' }, null, '   ')).toMatchObject({
      apiKey: 'sk-env',
    });
    expect(resolveAiConfig({ ANTHROPIC_API_KEY: 'sk-env' }, null, null)).toMatchObject({
      apiKey: 'sk-env',
    });
  });
});
