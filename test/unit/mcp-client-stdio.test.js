/**
 * lib/mcp-client -- stdio transport
 *
 * Two layers:
 *
 * 1. Stub-spawn unit tests: pass a fake spawn function via config.spawnFn
 *    that returns a fake process with stubbed stdin/stdout streams. Lets
 *    us drive newline framing, id routing, error paths, and lifecycle
 *    without spawning a real process. Fast and deterministic.
 *
 * 2. Real-subprocess integration test: spawns test/fixtures/mcp-stdio-echo.js
 *    via node, runs initialize -> listTools -> callTool -> close. Confirms
 *    the real EventEmitter wiring and stdin/stdout framing work end-to-end.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

const { createClient } = require('../../lib/mcp-client');

// ----------------------- Stub-spawn helpers -----------------------

/**
 * Build a fake child_process. The returned proc supports:
 *   - proc.stdin.write(json): consumed by writes[], unblocks waiting reads
 *   - proc.stdout.on('data', cb): cb called when fakeProcess.emitStdout(line)
 *   - proc.stderr.on('data', cb): cb called when fakeProcess.emitStderr(chunk)
 *   - proc.kill(): emits 'exit' with code=null, signal='SIGTERM'
 *   - proc.emit('exit', code, signal): triggers exit handler
 * The harness exposes scheduleResponse(requestPredicate, responseObj) so
 * the test can declare "when we receive a request matching X, emit Y."
 */
function makeFakeProcess() {
  const proc = new EventEmitter();
  proc.killed = false;
  const stdoutListeners = [];
  const stderrListeners = [];
  proc._writes = [];

  // Plain synchronous stdin so the test can inspect writes immediately
  // after the client returns from stdin.write. Node's real Writable is
  // async; we don't need that complexity here.
  proc.stdin = {
    write(chunk) {
      proc._writes.push(chunk.toString());
      return true;
    },
    end() {},
  };

  proc.stdout = {
    setEncoding() {},
    on(event, cb) {
      if (event === 'data') stdoutListeners.push(cb);
    },
  };
  proc.stderr = {
    setEncoding() {},
    on(event, cb) {
      if (event === 'data') stderrListeners.push(cb);
    },
  };

  proc.emitStdout = (text) => {
    for (const cb of stdoutListeners) cb(text);
  };
  proc.emitStderr = (text) => {
    for (const cb of stderrListeners) cb(text);
  };
  proc.kill = () => {
    if (proc.killed) return;
    proc.killed = true;
    proc.emit('exit', null, 'SIGTERM');
  };

  return proc;
}

function makeFakeSpawnFn() {
  const created = [];
  const fn = vi.fn((command, args, _opts) => {
    const p = makeFakeProcess();
    p.command = command;
    p.args = args;
    created.push(p);
    return p;
  });
  fn.created = created;
  return fn;
}

// _ensureProcess + stdin.write run via microtasks. Flush a few rounds so
// test assertions can inspect the stdin buffer after kicking off a
// request without needing to await the request promise (which may be
// pending a response).
function flushMicrotasks(rounds = 6) {
  let p = Promise.resolve();
  for (let i = 0; i < rounds; i++) p = p.then(() => undefined);
  return p;
}

// ----------------------- Construction -----------------------

describe('McpClient -- stdio construction', () => {
  it('requires a command for stdio transport', () => {
    expect(() => createClient({ transport: 'stdio' })).toThrow(/command/);
  });

  it('does NOT require a url for stdio transport', () => {
    const c = createClient({ transport: 'stdio', command: 'echo' });
    expect(c.transport).toBe('stdio');
    expect(c.command).toBe('echo');
  });

  it('defaults transport to http when omitted', () => {
    const c = createClient({ url: 'http://x' });
    expect(c.transport).toBe('http');
  });

  it('rejects http transport without url (existing behavior preserved)', () => {
    expect(() => createClient({ transport: 'http' })).toThrow(/url/);
  });

  it('defaults args to [] and env to {} for stdio', () => {
    const c = createClient({ transport: 'stdio', command: 'node' });
    expect(c.args).toEqual([]);
    expect(c.env).toEqual({});
  });
});

// ----------------------- Stub-spawn behavior -----------------------

describe('McpClient -- stdio with stub spawn', () => {
  let spawnFn;
  let client;

  beforeEach(() => {
    spawnFn = makeFakeSpawnFn();
  });

  it('spawns the subprocess on first request and writes newline-delimited JSON', async () => {
    client = createClient({ transport: 'stdio', command: 'fake-server', spawnFn });

    const initPromise = client.initialize();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn.mock.calls[0][0]).toBe('fake-server');

    await flushMicrotasks();
    const proc = spawnFn.created[0];
    expect(proc._writes).toHaveLength(1);
    expect(proc._writes[0].endsWith('\n')).toBe(true);
    const sentMsg = JSON.parse(proc._writes[0].trim());
    expect(sentMsg.method).toBe('initialize');
    expect(sentMsg.id).toBe(1);

    proc.emitStdout(JSON.stringify({ jsonrpc: '2.0', id: sentMsg.id, result: {} }) + '\n');
    await initPromise;
    expect(client._initialized).toBe(true);
  });

  it('handles split / batched stdout chunks (newline framing)', async () => {
    client = createClient({ transport: 'stdio', command: 'fake', spawnFn });
    const p = client.initialize();
    await flushMicrotasks();
    const proc = spawnFn.created[0];
    const sent = JSON.parse(proc._writes[0]);

    const reply = JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: {} });
    proc.emitStdout(reply.slice(0, 5));
    proc.emitStdout(reply.slice(5));
    proc.emitStdout('\n');
    await p;
  });

  it('handles two messages glued together in one chunk', async () => {
    client = createClient({ transport: 'stdio', command: 'fake', spawnFn });
    await prime(client, spawnFn); // initialize first

    // Two parallel callTool requests so both stdin writes happen before
    // any response. listTools serialises behind initialize and wouldn't
    // exercise the glued-chunk path.
    const p1 = client.callTool('a', {});
    const p2 = client.callTool('b', {});
    await flushMicrotasks();
    const proc = spawnFn.created[0];
    const m1 = JSON.parse(proc._writes[1]);
    const m2 = JSON.parse(proc._writes[2]);

    const r1 = JSON.stringify({
      jsonrpc: '2.0', id: m1.id, result: { content: [{ type: 'text', text: 'A' }] },
    });
    const r2 = JSON.stringify({
      jsonrpc: '2.0', id: m2.id, result: { content: [{ type: 'text', text: 'B' }] },
    });
    // Glue both responses into a single emit -- the framing splitter must
    // dispatch both.
    proc.emitStdout(r1 + '\n' + r2 + '\n');

    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe('A');
    expect(b).toBe('B');
  });

  it('routes responses to the right pending request by id (out of order)', async () => {
    client = createClient({ transport: 'stdio', command: 'fake', spawnFn });
    await prime(client, spawnFn); // initialize

    const p1 = client.callTool('a', {});
    const p2 = client.callTool('b', {});
    await flushMicrotasks();
    const proc = spawnFn.created[0];
    const msg1 = JSON.parse(proc._writes[1]);
    const msg2 = JSON.parse(proc._writes[2]);

    proc.emitStdout(JSON.stringify({
      jsonrpc: '2.0', id: msg2.id, result: { content: [{ type: 'text', text: 'B' }] },
    }) + '\n');
    proc.emitStdout(JSON.stringify({
      jsonrpc: '2.0', id: msg1.id, result: { content: [{ type: 'text', text: 'A' }] },
    }) + '\n');

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('A');
    expect(r2).toBe('B');
  });

  it('surfaces JSON-RPC errors with code + message', async () => {
    client = createClient({ transport: 'stdio', command: 'fake', spawnFn });
    await prime(client, spawnFn);

    const callP = client.callTool('boom', {});
    await flushMicrotasks();
    const proc = spawnFn.created[0];
    const sent = JSON.parse(proc._writes[1]);
    proc.emitStdout(JSON.stringify({
      jsonrpc: '2.0', id: sent.id,
      error: { code: -32001, message: 'tool refused' },
    }) + '\n');

    await expect(callP).rejects.toThrow(/tool refused/);
  });

  it('rejects pending requests when the subprocess exits', async () => {
    client = createClient({ transport: 'stdio', command: 'fake', spawnFn });
    await prime(client, spawnFn);

    const callP = client.callTool('echo', {});
    await flushMicrotasks();
    const proc = spawnFn.created[0];
    proc.emit('exit', 1, null);
    await expect(callP).rejects.toThrow(/subprocess exited/);
  });

  it('ignores non-JSON lines on stdout (defensive)', async () => {
    client = createClient({ transport: 'stdio', command: 'fake', spawnFn });
    const p = client.initialize();
    await flushMicrotasks();
    const proc = spawnFn.created[0];
    const sent = JSON.parse(proc._writes[0]);

    proc.emitStdout('Starting up...\n');
    proc.emitStdout(JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: {} }) + '\n');
    await p;
  });

  it('close() kills the subprocess and rejects pending requests', async () => {
    client = createClient({ transport: 'stdio', command: 'fake', spawnFn });
    await prime(client, spawnFn);

    const pending = client.callTool('echo', {});
    await flushMicrotasks();
    client.close();
    await expect(pending).rejects.toThrow(/closed|subprocess exited/);
    expect(spawnFn.created[0].killed).toBe(true);
  });

  it('close() is a no-op for http clients', () => {
    const c = createClient({ url: 'http://example' });
    expect(() => c.close()).not.toThrow();
  });

  it('captures stderr without breaking the client', async () => {
    client = createClient({ transport: 'stdio', command: 'fake', spawnFn });
    const p = client.initialize();
    await flushMicrotasks();
    const proc = spawnFn.created[0];
    proc.emitStderr('[server] debug log\n');
    const sent = JSON.parse(proc._writes[0]);
    proc.emitStdout(JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: {} }) + '\n');
    await p;
  });
});

// ----------------------- Real-subprocess integration -----------------------

describe('McpClient -- stdio against the fixture echo subprocess', () => {
  it('runs initialize -> listTools -> callTool end-to-end', async () => {
    const fixturePath = resolve(__dirname, '..', 'fixtures', 'mcp-stdio-echo.js');
    const client = createClient({
      transport: 'stdio',
      command: process.execPath, // node binary
      args: [fixturePath],
      label: 'echo-fixture',
      timeoutMs: 5000,
    });

    try {
      await client.initialize();
      const tools = await client.listTools();
      expect(tools.length).toBeGreaterThanOrEqual(2);
      const names = tools.map((t) => t.name);
      expect(names).toContain('echo');
      expect(names).toContain('error');

      const reply = await client.callTool('echo', { text: 'hello' });
      expect(reply).toBe('echo:hello');

      // Negative: an erroring tool surfaces the JSON-RPC error message.
      await expect(client.callTool('error', {})).rejects.toThrow(/intentional failure/);
    } finally {
      client.close();
    }
  });
});

// ----------------------- helpers -----------------------

async function prime(client, spawnFn) {
  const p = client.initialize();
  await flushMicrotasks();
  const proc = spawnFn.created[0];
  const initId = JSON.parse(proc._writes[0]).id;
  proc.emitStdout(JSON.stringify({ jsonrpc: '2.0', id: initId, result: {} }) + '\n');
  await p;
}

