/**
 * Settings → AI "Use" preference store (ADR-094): auto by default,
 * persisted atomically, corrupt-tolerant, closed to unknown values.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  readProviderPreference,
  writeProviderPreference,
  validateProviderPreference,
  AI_PROVIDER_PREFERENCE_FILENAME,
} from '../../ai/provider-store.js';

describe('provider preference store', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ai-provider-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('auto when unset, when there is no dir, and when the file is corrupt', () => {
    expect(readProviderPreference(dir)).toBe('auto');
    expect(readProviderPreference(null)).toBe('auto');
    writeFileSync(path.join(dir, AI_PROVIDER_PREFERENCE_FILENAME), '{nope');
    expect(readProviderPreference(dir)).toBe('auto');
    writeFileSync(path.join(dir, AI_PROVIDER_PREFERENCE_FILENAME), JSON.stringify({ provider: 'neon' }));
    expect(readProviderPreference(dir)).toBe('auto');
  });

  it('persists openai / claude and auto removes the file', () => {
    expect(writeProviderPreference(dir, 'openai')).toBe('openai');
    expect(readProviderPreference(dir)).toBe('openai');
    expect(writeProviderPreference(dir, 'claude')).toBe('claude');
    expect(readProviderPreference(dir)).toBe('claude');
    expect(writeProviderPreference(dir, 'auto')).toBe('auto');
    expect(existsSync(path.join(dir, AI_PROVIDER_PREFERENCE_FILENAME))).toBe(false);
  });

  it('rejects unknown values and a missing dir', () => {
    expect(validateProviderPreference('gemini')).toBeNull();
    expect(() => writeProviderPreference(dir, 'gemini')).toThrow(/auto, claude, openai/);
    expect(() => writeProviderPreference(null, 'openai')).toThrow(/settings directory/);
  });
});
