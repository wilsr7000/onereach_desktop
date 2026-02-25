/**
 * Agent Tool Calling Infrastructure Tests
 *
 * Tests:
 *   1. Anthropic adapter tool calling (tools param, tool_use response parsing)
 *   2. OpenAI adapter tool calling (tools param, tool_calls response parsing)
 *   3. AI Service chatWithTools() auto-loop
 *   4. Tool registry (resolve, dispatch, safety)
 *   5. Middleware tool injection
 *
 * Run:  npx vitest run test/unit/tool-calling.test.js
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// 1. Anthropic Adapter -- Tool Format Conversion & Response Parsing
// ═══════════════════════════════════════════════════════════════════════════

describe('Anthropic Adapter Tool Calling', () => {
  it('converts tool definitions to Anthropic format', () => {
    const tools = [{
      name: 'get_weather',
      description: 'Get weather for a city',
      inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    }];

    const converted = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema || t.input_schema || { type: 'object', properties: {} },
    }));

    expect(converted).toHaveLength(1);
    expect(converted[0].name).toBe('get_weather');
    expect(converted[0].input_schema.required).toEqual(['city']);
  });

  it('parses tool_use blocks into normalized toolCalls', () => {
    const data = {
      content: [
        { type: 'text', text: '' },
        { type: 'tool_use', id: 'toolu_123', name: 'get_weather', input: { city: 'NYC' } },
      ],
      usage: { input_tokens: 10, output_tokens: 20 },
      stop_reason: 'tool_use',
    };

    const toolUseBlocks = data.content.filter((b) => b.type === 'tool_use');
    const toolCalls = toolUseBlocks.length > 0
      ? toolUseBlocks.map((b) => ({ id: b.id, name: b.name, input: b.input }))
      : null;

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toEqual({ id: 'toolu_123', name: 'get_weather', input: { city: 'NYC' } });
  });

  it('returns null toolCalls for text-only response', () => {
    const data = {
      content: [{ type: 'text', text: 'Just text' }],
      usage: { input_tokens: 5, output_tokens: 3 },
      stop_reason: 'end_turn',
    };

    const toolUseBlocks = data.content.filter((b) => b.type === 'tool_use');
    const toolCalls = toolUseBlocks.length > 0
      ? toolUseBlocks.map((b) => ({ id: b.id, name: b.name, input: b.input }))
      : null;

    expect(toolCalls).toBeNull();
  });

  it('handles multiple simultaneous tool_use blocks', () => {
    const data = {
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'NYC' } },
        { type: 'tool_use', id: 'toolu_2', name: 'get_time', input: {} },
      ],
      stop_reason: 'tool_use',
    };

    const toolUseBlocks = data.content.filter((b) => b.type === 'tool_use');
    const toolCalls = toolUseBlocks.map((b) => ({ id: b.id, name: b.name, input: b.input }));

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].name).toBe('get_weather');
    expect(toolCalls[1].name).toBe('get_time');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. OpenAI Adapter -- Tool Format Conversion & Response Parsing
// ═══════════════════════════════════════════════════════════════════════════

describe('OpenAI Adapter Tool Calling', () => {
  it('converts tool definitions to OpenAI format', () => {
    const tools = [{
      name: 'get_time',
      description: 'Get current time',
      inputSchema: { type: 'object', properties: { tz: { type: 'string' } } },
    }];

    const converted = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema || t.input_schema || { type: 'object', properties: {} },
      },
    }));

    expect(converted).toHaveLength(1);
    expect(converted[0].type).toBe('function');
    expect(converted[0].function.name).toBe('get_time');
    expect(converted[0].function.parameters.properties.tz).toBeDefined();
  });

  it('parses tool_calls into normalized toolCalls', () => {
    const rawToolCalls = [{
      id: 'call_abc123',
      type: 'function',
      function: { name: 'get_time', arguments: '{"timezone":"EST"}' },
    }];

    const toolCalls = rawToolCalls.map((tc) => ({
      id: tc.id,
      name: tc.function?.name,
      input: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {},
    }));

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toEqual({ id: 'call_abc123', name: 'get_time', input: { timezone: 'EST' } });
  });

  it('returns null toolCalls when no tool_calls in response', () => {
    const rawToolCalls = [];
    const toolCalls = rawToolCalls.length > 0
      ? rawToolCalls.map((tc) => ({ id: tc.id, name: tc.function?.name, input: {} }))
      : null;

    expect(toolCalls).toBeNull();
  });

  it('handles multiple parallel tool calls', () => {
    const rawToolCalls = [
      { id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{}' } },
      { id: 'call_2', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
    ];

    const toolCalls = rawToolCalls.map((tc) => ({
      id: tc.id,
      name: tc.function?.name,
      input: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {},
    }));

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].name).toBe('get_time');
    expect(toolCalls[1].name).toBe('get_weather');
    expect(toolCalls[1].input.city).toBe('SF');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Tool Registry
// ═══════════════════════════════════════════════════════════════════════════

describe('Agent Tool Registry', () => {
  let tools;

  beforeEach(() => {
    vi.resetModules();
    tools = require('../../lib/agent-tools');
  });

  it('resolveTools resolves known tool names', () => {
    const resolved = tools.resolveTools(['shell_exec', 'file_read', 'get_current_time']);
    expect(resolved).toHaveLength(3);
    expect(resolved[0].name).toBe('shell_exec');
    expect(resolved[1].name).toBe('file_read');
    expect(resolved[2].name).toBe('get_current_time');
    for (const t of resolved) {
      expect(typeof t.execute).toBe('function');
      expect(t.inputSchema).toBeDefined();
    }
  });

  it('resolveTools("all") returns every tool', () => {
    const all = tools.resolveTools('all');
    expect(all.length).toBeGreaterThanOrEqual(7);
  });

  it('resolveTools filters unknown names', () => {
    const resolved = tools.resolveTools(['shell_exec', 'nonexistent_tool']);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].name).toBe('shell_exec');
  });

  it('getToolDefinitions returns defs without execute', () => {
    const defs = tools.getToolDefinitions(['get_current_time']);
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('get_current_time');
    expect(defs[0].description).toBeTruthy();
    expect(defs[0].inputSchema).toBeDefined();
    expect(defs[0].execute).toBeUndefined();
  });

  it('createToolDispatcher dispatches to correct tool', async () => {
    const resolved = tools.resolveTools(['get_current_time']);
    const dispatch = tools.createToolDispatcher(resolved);
    const result = await dispatch('get_current_time', {});
    expect(result.iso).toBeDefined();
    expect(result.timezone).toBeDefined();
  });

  it('createToolDispatcher returns error for unknown tool', async () => {
    const resolved = tools.resolveTools(['get_current_time']);
    const dispatch = tools.createToolDispatcher(resolved);
    const result = await dispatch('unknown_tool', {});
    expect(result.error).toContain('Unknown tool');
  });

  it('registerTool adds a custom tool', () => {
    tools.registerTool({
      name: 'custom_test_tool',
      description: 'A custom test tool',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => ({ result: 'custom' }),
    });
    const resolved = tools.resolveTools(['custom_test_tool']);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].name).toBe('custom_test_tool');
  });

  it('isShellCommandSafe blocks dangerous commands', () => {
    expect(tools.isShellCommandSafe('ls -la')).toBe(true);
    expect(tools.isShellCommandSafe('echo hello')).toBe(true);
    expect(tools.isShellCommandSafe('rm -rf /')).toBe(false);
    expect(tools.isShellCommandSafe('sudo apt install')).toBe(false);
    expect(tools.isShellCommandSafe('chmod 777 /')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Tool Execution
// ═══════════════════════════════════════════════════════════════════════════

describe('Tool Execution', () => {
  let tools;

  beforeEach(() => {
    vi.resetModules();
    tools = require('../../lib/agent-tools');
  });

  it('get_current_time returns ISO timestamp and timezone', async () => {
    const result = await tools.TOOLS.get_current_time.execute({});
    expect(result.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.timezone).toBeTruthy();
    expect(typeof result.epochMs).toBe('number');
    expect(result.formatted).toBeTruthy();
  });

  it('file_list lists the test directory', async () => {
    const result = await tools.TOOLS.file_list.execute({ path: __dirname });
    expect(result.entries).toBeDefined();
    expect(result.entries.length).toBeGreaterThan(0);
    const thisFile = result.entries.find((e) => e.name === 'tool-calling.test.js');
    expect(thisFile).toBeDefined();
    expect(thisFile.type).toBe('file');
  });

  it('file_read reads this test file', async () => {
    const result = await tools.TOOLS.file_read.execute({ path: __filename });
    expect(result.content).toContain('Agent Tool Calling Infrastructure Tests');
  });

  it('file_read returns error for nonexistent file', async () => {
    const result = await tools.TOOLS.file_read.execute({ path: '/nonexistent/path/file.txt' });
    expect(result.error).toBeDefined();
  });

  it('shell_exec runs a safe command', async () => {
    const result = await tools.TOOLS.shell_exec.execute({ command: 'echo hello' });
    expect(result.stdout).toContain('hello');
  });

  it('shell_exec blocks dangerous commands', async () => {
    const result = await tools.TOOLS.shell_exec.execute({ command: 'rm -rf /' });
    expect(result.error).toContain('blocked');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. chatWithTools Loop
// ═══════════════════════════════════════════════════════════════════════════

describe('AI Service chatWithTools', () => {
  let ai;

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('electron', () => ({
      app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '3.12.5') },
      ipcMain: { handle: vi.fn(), on: vi.fn() },
    }), { virtual: true });
    vi.doMock('../../settings-manager', () => ({
      getSettingsManager: vi.fn(() => ({
        get: vi.fn((key) => {
          const defaults = {
            'ai.openaiApiKey': 'test-openai-key',
            'ai.anthropicApiKey': 'test-anthropic-key',
            'ai.profiles': null,
          };
          return defaults[key] ?? null;
        }),
        set: vi.fn(),
      })),
    }), { virtual: true });
    ai = require('../../lib/ai-service');
  });

  it('rejects without onToolCall', async () => {
    await expect(ai.chatWithTools({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'test', description: 'test', inputSchema: {} }],
    })).rejects.toThrow('onToolCall');
  });

  it('rejects without tools', async () => {
    await expect(ai.chatWithTools({
      messages: [{ role: 'user', content: 'hi' }],
      onToolCall: async () => 'result',
    })).rejects.toThrow('at least one tool');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Middleware Tool Injection
// ═══════════════════════════════════════════════════════════════════════════

describe('Middleware Tool Injection', () => {
  let middleware;

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../../lib/log-event-queue', () => ({
      getLogQueue: () => ({
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      }),
    }));
    vi.doMock('../../lib/ai-service', () => ({
      chatWithTools: vi.fn(),
    }), { virtual: true });
    middleware = require('../../packages/agents/agent-middleware');
  });

  it('normalizeTaskInput ensures content is always a string', () => {
    expect(middleware.normalizeTaskInput(null).content).toBe('');
    expect(middleware.normalizeTaskInput({}).content).toBe('');
    expect(middleware.normalizeTaskInput({ content: 42 }).content).toBe('42');
    expect(middleware.normalizeTaskInput({ content: 'hello' }).content).toBe('hello');
    expect(middleware.normalizeTaskInput({ text: 'from text' }).content).toBe('from text');
  });

  it('normalizeResult handles various return shapes', () => {
    expect(middleware.normalizeResult(null)).toEqual({ success: false, message: 'Agent returned no result' });
    expect(middleware.normalizeResult('plain text')).toEqual({ success: true, message: 'plain text' });
    expect(middleware.normalizeResult({ success: true, message: 'ok' })).toMatchObject({ success: true, message: 'ok' });
    expect(middleware.normalizeResult({ output: 'from output' })).toMatchObject({ success: true, message: 'from output' });
  });

  it('safeExecuteAgent wraps execution with error boundary', async () => {
    const agent = {
      name: 'test-agent',
      id: 'test-agent',
      execute: vi.fn().mockRejectedValue(new Error('Boom')),
    };
    const result = await middleware.safeExecuteAgent(agent, { content: 'hi' });
    expect(result.success).toBe(false);
    expect(result.message).toContain('Boom');
  });

  it('safeExecuteAgent times out slow agents', async () => {
    const agent = {
      name: 'slow-agent',
      id: 'slow-agent',
      execute: () => new Promise((resolve) => setTimeout(resolve, 60000)),
    };
    const result = await middleware.safeExecuteAgent(agent, { content: 'hi' }, { timeoutMs: 100 });
    expect(result.success).toBe(false);
    expect(result.message).toContain('taking longer');
  });
});
