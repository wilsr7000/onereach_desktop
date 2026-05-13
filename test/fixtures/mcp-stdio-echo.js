#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * MCP stdio fixture server -- used by test/unit/mcp-client-stdio.test.js to
 * exercise the real subprocess code path of lib/mcp-client.js. Implements
 * just enough of the protocol to answer initialize / tools/list /
 * tools/call. Reads newline-delimited JSON-RPC requests from stdin and
 * writes responses to stdout (one line per response).
 *
 * Tools exposed:
 *   - echo: returns the args.text it was called with
 *   - error: always responds with a JSON-RPC error (for negative tests)
 */

const TOOLS = [
  { name: 'echo', description: 'Echo back the text arg', inputSchema: { type: 'object' } },
  { name: 'error', description: 'Always fails', inputSchema: { type: 'object' } },
];

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl = buffer.indexOf('\n');
  while (nl >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    nl = buffer.indexOf('\n');
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_err) {
      continue;
    }
    handle(msg);
  }
});

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: {} } });
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    if (name === 'echo') {
      const text = (params.arguments && params.arguments.text) || '';
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: 'echo:' + text }] },
      });
      return;
    }
    if (name === 'error') {
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'intentional failure' } });
      return;
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown tool' } });
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
}

// Stay alive; the test harness will kill us via client.close().
process.stdin.resume();
