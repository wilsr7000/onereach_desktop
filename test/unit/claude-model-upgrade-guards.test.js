/**
 * Fable 5.1 upgrade guards (2026-09-02). Three pure decisions that keep
 * the model upgrade from stranding anyone:
 *  - settings: a stale ANTHROPIC pin migrates forward; another provider's
 *    choice is never touched.
 *  - runner: the "Claude Code too old for this model" 400 is recognized so
 *    the call retries on a universally-accepted model instead of failing.
 *  - bundler: version compare + the minimum the default model requires.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false }, safeStorage: { isEncryptionAvailable: () => false } }));
vi.mock('../../lib/log-event-queue', () => ({ getLogQueue: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }));

const { migrateClaudeModel, CURRENT_CLAUDE_MODEL } = require('../../settings-manager');
const { isModelVersionGateError, VERSION_GATE_FALLBACK_MODEL } = require('../../lib/claude-code-runner');
const { compareVersions, MIN_CLAUDE_CODE_VERSION } = require('../../scripts/download-claude-code');

describe('settings: stale Claude pin migration', () => {
  it('moves stale anthropic pins forward to the current model', () => {
    for (const stale of ['claude-opus-4-5-20251101', 'claude-opus-4-7', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5', 'claude-3-haiku-20240307', 'claude-fable-5']) {
      expect(migrateClaudeModel('anthropic', stale)).toBe(CURRENT_CLAUDE_MODEL);
    }
    expect(CURRENT_CLAUDE_MODEL).toBe('claude-fable-5-1');
  });
  it('never touches another provider, an already-current pin, or newer models', () => {
    expect(migrateClaudeModel('openai', 'gpt-5.2')).toBeNull();
    expect(migrateClaudeModel('openai', 'claude-opus-4-7')).toBeNull();
    expect(migrateClaudeModel('anthropic', 'claude-fable-5-1')).toBeNull();
    expect(migrateClaudeModel('anthropic', 'claude-opus-5')).toBeNull();
    expect(migrateClaudeModel('anthropic', 'claude-sonnet-5')).toBeNull();
    expect(migrateClaudeModel('anthropic', undefined)).toBeNull();
  });
});

describe('runner: model version-gate detection', () => {
  it('recognizes the live 400 text and nothing else', () => {
    const live = "API Error: 400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"Claude Code 2.1.112 does not support this model; version 2.1.251 or newer is required. Run 'claude update'\"}}";
    expect(isModelVersionGateError(live)).toBe(true);
    expect(isModelVersionGateError('Invalid or missing Anthropic API key.')).toBe(false);
    expect(isModelVersionGateError('overloaded_error')).toBe(false);
    expect(isModelVersionGateError('')).toBe(false);
    expect(VERSION_GATE_FALLBACK_MODEL).toBe('claude-opus-4-8');
  });
});

describe('bundler: minimum Claude Code version', () => {
  it('orders dotted versions and pins the minimum the default model needs', () => {
    expect(MIN_CLAUDE_CODE_VERSION).toBe('2.1.251');
    expect(compareVersions('2.1.112', MIN_CLAUDE_CODE_VERSION)).toBeLessThan(0);
    expect(compareVersions('2.1.251', MIN_CLAUDE_CODE_VERSION)).toBe(0);
    expect(compareVersions('2.1.258', MIN_CLAUDE_CODE_VERSION)).toBeGreaterThan(0);
    expect(compareVersions('2.2.0', '2.1.999')).toBeGreaterThan(0);
    expect(compareVersions('3.0', '2.9.9')).toBeGreaterThan(0);
  });
});
