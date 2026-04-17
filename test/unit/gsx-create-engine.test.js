/**
 * Unit tests for lib/gsx-create-engine.js
 *
 * Verifies the AiderBridgeClient-compatible surface that GSX Create
 * depends on. Uses vitest mocks for the underlying claude-code-runner so
 * tests stay fast and don't spawn actual Claude Code processes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Log queue mock so the engine doesn't touch real log infra
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { GSXCreateEngine, extractStreamText, _setTestRunner } from '../../lib/gsx-create-engine.js';

// Fresh runner mock for each test, injected via _setTestRunner
const runnerMock = {
  runClaudeCode: vi.fn(),
  cancelSession: vi.fn(),
  isClaudeCodeAvailable: vi.fn(),
};

_setTestRunner(() => runnerMock);

describe('GSXCreateEngine', () => {
  let engine;

  beforeEach(async () => {
    runnerMock.runClaudeCode.mockReset();
    runnerMock.cancelSession.mockReset();
    runnerMock.isClaudeCodeAvailable.mockReset();

    runnerMock.isClaudeCodeAvailable.mockResolvedValue({
      available: true,
      version: '2.1.112',
      type: 'bundled',
      path: '/fake/claude',
    });

    runnerMock.runClaudeCode.mockImplementation(async (prompt, opts = {}) => {
      if (typeof opts.onStream === 'function') {
        opts.onStream({
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Hello ' },
        });
        opts.onStream({
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'world' },
        });
        opts.onStream({ type: 'result', result: 'Hello world' });
      }
      return {
        success: true,
        result: 'mock result',
        output: 'mock result',
        sessionId: 'mock-session-123',
        usage: { input_tokens: 42, output_tokens: 7 },
        requestId: 'req-abc',
      };
    });

    engine = new GSXCreateEngine({ sessionKey: 'test-session' });
    await engine.start();
    await engine.initialize('/tmp/repo', 'claude-opus-4-7');
  });

  it('start() succeeds when Claude Code is available', async () => {
    const fresh = new GSXCreateEngine();
    const result = await fresh.start();
    expect(result.success).toBe(true);
    expect(result.version).toBe('2.1.112');
    expect(fresh.isRunning()).toBe(true);
  });

  it('start() throws if Claude Code is unavailable', async () => {
    runnerMock.isClaudeCodeAvailable.mockResolvedValueOnce({
      available: false,
      error: 'not installed',
    });
    const fresh = new GSXCreateEngine();
    await expect(fresh.start()).rejects.toThrow(/not available/i);
  });

  it('initialize() resets model, session, context', async () => {
    await engine.addFiles(['a.js', 'b.js']);
    engine.sessionId = 'old-session';
    await engine.initialize('/tmp/new-repo', 'claude-sonnet-4-5-20250929');
    expect(engine.cwd).toBe('/tmp/new-repo');
    expect(engine.model).toBe('claude-sonnet-4-5-20250929');
    expect(engine.sessionId).toBe(null);
    expect(engine.contextFiles.size).toBe(0);
  });

  it('initialize() requires repoPath', async () => {
    await expect(engine.initialize()).rejects.toThrow(/repoPath is required/);
  });

  it('addFiles / removeFiles track context', async () => {
    await engine.addFiles(['src/a.js', 'src/b.js']);
    await engine.addFiles(['src/c.js']);
    expect(engine.contextFiles.size).toBe(3);

    await engine.removeFiles(['src/b.js']);
    expect(engine.contextFiles.has('src/b.js')).toBe(false);
    expect(engine.contextFiles.size).toBe(2);
  });

  it('addFiles rejects non-arrays', async () => {
    await expect(engine.addFiles('not-an-array')).rejects.toThrow(/must be an array/);
  });

  it('runPrompt forwards cwd, model, systemPrompt, and captures session', async () => {
    const result = await engine.runPrompt('do a thing');

    expect(runnerMock.runClaudeCode).toHaveBeenCalledTimes(1);
    const [prompt, opts] = runnerMock.runClaudeCode.mock.calls[0];
    expect(prompt).toBe('do a thing');
    expect(opts.cwd).toBe('/tmp/repo');
    expect(opts.model).toBe('claude-opus-4-7');
    expect(opts.feature).toBe('gsx-create');
    expect(opts.enableTools).toBe(true);
    expect(opts.allowedTools).toContain('Read');
    expect(opts.allowedTools).toContain('Write');
    expect(opts.allowedTools).toContain('Bash');
    expect(opts.systemPrompt).toContain('GSX Create');
    expect(opts.systemPrompt).toContain('/tmp/repo');

    // New session: first call should use newSessionId, not sessionId
    expect(opts.newSessionId).toBe('test-session');
    expect(opts.sessionId).toBeUndefined();

    expect(result.success).toBe(true);
    expect(result.sessionId).toBe('mock-session-123');
    expect(result.usage).toEqual({ input_tokens: 42, output_tokens: 7 });
  });

  it('runPrompt resumes the same Claude Code session on subsequent calls', async () => {
    await engine.runPrompt('first');
    expect(engine.sessionId).toBe('mock-session-123');

    await engine.runPrompt('second');
    expect(runnerMock.runClaudeCode).toHaveBeenCalledTimes(2);
    const secondOpts = runnerMock.runClaudeCode.mock.calls[1][1];
    expect(secondOpts.sessionId).toBe('mock-session-123');
    expect(secondOpts.newSessionId).toBeUndefined();
  });

  it('runPromptStreaming forwards token deltas to the callback', async () => {
    const tokens = [];
    const onToken = (t) => tokens.push(t);
    const result = await engine.runPromptStreaming('stream this', onToken);

    expect(tokens).toEqual(['Hello ', 'world']);
    expect(result.success).toBe(true);

    const opts = runnerMock.runClaudeCode.mock.calls[0][1];
    expect(typeof opts.onStream).toBe('function');
  });

  it('system prompt includes context files, read-only files, test cmd, lint cmd', async () => {
    await engine.addFiles(['src/main.js']);
    await engine.sendRequest('set_sandbox', {
      sandbox_root: '/tmp/repo',
      read_only_files: ['lockfile.json'],
      branch_id: 'branch-1',
    });
    engine.setTestCmd('npm test');
    engine.setLintCmd('eslint .');

    await engine.runPrompt('go');
    const opts = runnerMock.runClaudeCode.mock.calls[0][1];
    expect(opts.systemPrompt).toContain('src/main.js');
    expect(opts.systemPrompt).toContain('lockfile.json');
    expect(opts.systemPrompt).toContain('npm test');
    expect(opts.systemPrompt).toContain('eslint .');
    expect(opts.systemPrompt).toMatch(/DO NOT modify/i);
  });

  it('sendRequest routes legacy RPC method names correctly', async () => {
    // add_files
    const add = await engine.sendRequest('add_files', { file_paths: ['x.js'] });
    expect(add.success).toBe(true);
    expect(engine.contextFiles.has('x.js')).toBe(true);

    // set_sandbox
    const sb = await engine.sendRequest('set_sandbox', {
      sandbox_root: '/tmp/repo',
      read_only_files: ['readme.md'],
      branch_id: 'b1',
    });
    expect(sb.success).toBe(true);
    expect(engine.readOnlyFiles.has('readme.md')).toBe(true);

    // initialize
    const init = await engine.sendRequest('initialize', {
      repo_path: '/tmp/other',
      model_name: 'claude-sonnet-4-5-20250929',
    });
    expect(init.success).toBe(true);
    expect(engine.cwd).toBe('/tmp/other');

    // run_prompt
    const rp = await engine.sendRequest('run_prompt', { message: 'hi' });
    expect(rp.success).toBe(true);

    // unknown method throws
    await expect(engine.sendRequest('unknown_method')).rejects.toThrow(/unsupported/);
  });

  it('shutdown cancels any in-flight request and marks engine inactive', async () => {
    engine.activeRequestId = 'live-req-1';
    await engine.shutdown();
    expect(runnerMock.cancelSession).toHaveBeenCalledWith('live-req-1');
    expect(engine.isRunning()).toBe(false);
  });

  it('runPrompt requires started + initialized', async () => {
    const fresh = new GSXCreateEngine();
    await expect(fresh.runPrompt('anything')).rejects.toThrow(/start\(\)/);

    await fresh.start();
    await expect(fresh.runPrompt('anything')).rejects.toThrow(/initialize/);
  });

  it('runPrompt requires a non-empty string', async () => {
    await expect(engine.runPrompt('')).rejects.toThrow(/non-empty string/);
    await expect(engine.runPrompt('   ')).rejects.toThrow(/non-empty string/);
    await expect(engine.runPrompt(42)).rejects.toThrow(/non-empty string/);
  });

  it('getRepoMap returns an object with a files array', async () => {
    const map = await engine.getRepoMap();
    expect(map).toHaveProperty('success');
    expect(Array.isArray(map.files)).toBe(true);
    expect(typeof map.count).toBe('number');
  });
});

describe('extractStreamText', () => {
  it('extracts text from content_block_delta events', () => {
    expect(
      extractStreamText({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hello' },
      })
    ).toBe('hello');
  });

  it('extracts text from plain text events', () => {
    expect(extractStreamText({ type: 'text', text: 'hello' })).toBe('hello');
  });

  it('returns null for tool_use and result events', () => {
    expect(extractStreamText({ type: 'result', result: 'final' })).toBe(null);
    expect(extractStreamText({ type: 'tool_use', name: 'Read' })).toBe(null);
  });

  it('returns null for nonsense input', () => {
    expect(extractStreamText(null)).toBe(null);
    expect(extractStreamText(undefined)).toBe(null);
    expect(extractStreamText('string')).toBe(null);
    expect(extractStreamText({ type: 'content_block_delta' })).toBe(null);
  });
});
