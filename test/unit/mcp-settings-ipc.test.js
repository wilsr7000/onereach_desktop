/**
 * MCP settings IPC -- source-level invariants
 *
 * The actual IPC handlers (`mcp:save-servers`, `mcp:test-connection`) are
 * inline in main.js and can't easily be exercised in unit tests without
 * booting Electron. This test pins the source-level invariants we care
 * about: the handlers exist, talk to settings-manager + mcp-client +
 * mcp-bridge-agent, and the preload allowlist exposes the channels.
 *
 * Bigger behavioral test for the reload itself lives in
 * mcp-bridge-agent.test.js (the `reload()` describe block).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const mainSrc = readFileSync(resolve(REPO_ROOT, 'main.js'), 'utf8');
const preloadSrc = readFileSync(resolve(REPO_ROOT, 'preload.js'), 'utf8');
const settingsSrc = readFileSync(resolve(REPO_ROOT, 'settings.html'), 'utf8');

describe('mcp:save-servers IPC handler', () => {
  it('is registered in main.js', () => {
    expect(mainSrc).toMatch(/ipcMain\.handle\(\s*['"]mcp:save-servers['"]/);
  });

  it('persists the list to settings.mcp.servers', () => {
    const block = extractHandler(mainSrc, 'mcp:save-servers');
    expect(block).toMatch(/set\(['"]mcp\.servers['"],\s*list/);
  });

  it('reloads the mcp-bridge-agent after persisting', () => {
    const block = extractHandler(mainSrc, 'mcp:save-servers');
    expect(block).toMatch(/mcp-bridge-agent/);
    expect(block).toMatch(/agent\.reload\(\)/);
  });
});

describe('mcp:test-connection IPC handler', () => {
  it('is registered in main.js', () => {
    expect(mainSrc).toMatch(/ipcMain\.handle\(\s*['"]mcp:test-connection['"]/);
  });

  it('uses lib/mcp-client createClient + health()', () => {
    const block = extractHandler(mainSrc, 'mcp:test-connection');
    expect(block).toMatch(/lib\/mcp-client/);
    expect(block).toMatch(/createClient/);
    expect(block).toMatch(/\.health\(\)/);
  });

  it('returns { ok, toolCount, latencyMs } on success', () => {
    const block = extractHandler(mainSrc, 'mcp:test-connection');
    expect(block).toMatch(/toolCount/);
    expect(block).toMatch(/latencyMs/);
  });

  it('returns { ok: false, error } on transport failure', () => {
    const block = extractHandler(mainSrc, 'mcp:test-connection');
    expect(block).toMatch(/ok:\s*false/);
    expect(block).toMatch(/error/);
  });

  it('branches on transport http vs stdio', () => {
    const block = extractHandler(mainSrc, 'mcp:test-connection');
    expect(block).toMatch(/transport\s*===\s*['"]stdio['"]/);
    expect(block).toMatch(/payload\.command/);
    expect(block).toMatch(/payload\.url/);
  });

  it('calls client.close() in a finally so stdio subprocesses are killed', () => {
    const block = extractHandler(mainSrc, 'mcp:test-connection');
    expect(block).toMatch(/finally/);
    expect(block).toMatch(/client\.close\(\)/);
  });
});

describe('preload allowlist exposes the new channels', () => {
  it('includes mcp:save-servers in the invoke allowlist', () => {
    expect(preloadSrc).toMatch(/['"]mcp:save-servers['"]/);
  });

  it('includes mcp:test-connection in the invoke allowlist', () => {
    expect(preloadSrc).toMatch(/['"]mcp:test-connection['"]/);
  });
});

describe('settings.html UI wiring', () => {
  it('exposes an MCP Servers sidebar tab', () => {
    expect(settingsSrc).toMatch(/data-tab=['"]mcp-servers['"]/);
    expect(settingsSrc).toMatch(/MCP Servers/);
  });

  it('has a pane with id pane-mcp-servers', () => {
    expect(settingsSrc).toMatch(/id=['"]pane-mcp-servers['"]/);
  });

  it('the JS layer references the new IPC channels', () => {
    expect(settingsSrc).toMatch(/mcp:save-servers/);
    expect(settingsSrc).toMatch(/mcp:test-connection/);
  });

  it('the switchTab wrapper loads the MCP server list when the tab opens', () => {
    expect(settingsSrc).toMatch(/mcp-servers'\)\s+mcpLoadServers/);
  });

  it('exposes the transport selector with http + stdio options', () => {
    expect(settingsSrc).toMatch(/id=['"]mcpTransport['"]/);
    expect(settingsSrc).toMatch(/<option\s+value=['"]http['"]>HTTP/);
    expect(settingsSrc).toMatch(/<option\s+value=['"]stdio['"]>stdio/);
  });

  it('exposes stdio-specific fields (command, args, env, cwd)', () => {
    expect(settingsSrc).toMatch(/id=['"]mcpCommand['"]/);
    expect(settingsSrc).toMatch(/id=['"]mcpArgs['"]/);
    expect(settingsSrc).toMatch(/id=['"]mcpEnv['"]/);
    expect(settingsSrc).toMatch(/id=['"]mcpCwd['"]/);
  });

  it('toggles http vs stdio field visibility via mcpUpdateTransportFields()', () => {
    expect(settingsSrc).toMatch(/function mcpUpdateTransportFields/);
    expect(settingsSrc).toMatch(/mcpHttpFields/);
    expect(settingsSrc).toMatch(/mcpStdioFields/);
  });

  it('mcpSaveServer branches on transport when building the persisted shape', () => {
    expect(settingsSrc).toMatch(/transport === ['"]stdio['"]/);
    expect(settingsSrc).toMatch(/_mcpParseArgs/);
  });
});

// Helper -- extract the body of an ipcMain.handle('CHANNEL', ...) block by
// brace-matching from the opening `(` past the channel name. Returns the
// slice from the start of the call through the matching closing `});`.
function extractHandler(src, channel) {
  const anchor = new RegExp(`ipcMain\\.handle\\(\\s*['"]${channel}['"]`);
  const start = src.search(anchor);
  if (start < 0) {
    throw new Error(`Could not locate ipcMain.handle('${channel}') in main.js source`);
  }
  // Find the opening '(' of the ipcMain.handle call.
  const openParen = src.indexOf('(', start);
  let depth = 0;
  for (let i = openParen; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        // Include the trailing ');'
        return src.slice(start, i + 2);
      }
    }
  }
  throw new Error(`Unbalanced parens for ipcMain.handle('${channel}')`);
}
