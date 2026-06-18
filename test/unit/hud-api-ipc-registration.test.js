/**
 * Regression test for the "voice orb dispatches tasks into a dead pipe" bug.
 *
 * Root cause: window.agentHUD.submitTask() invokes IPC `hud-api:submit-task`,
 * whose handler is registered by hudApi.initialize() (-> _registerIPC). That
 * used to run ONLY from inside exchange-bridge init, AFTER the WebSocket
 * transport already started listening -- so any throw between transport start
 * and that call left the handler unregistered and every voice request died
 * silently (the orb window runs with devTools off, so nothing surfaced).
 *
 * The fix has two halves, each pinned below:
 *   A. Behavioral (the exported submitTask the IPC handler calls):
 *      - returns a clean error instead of hanging when the bridge isn't ready
 *      - threads the caller's traceId into the auction metadata for tracing
 *   B. Source-level wiring invariants (boot ordering can't be unit-booted
 *      without Electron, so we assert the source the same way the codebase's
 *      other IPC-wiring tests do, e.g. mcp-settings-ipc.test.js):
 *      - main.js registers the HUD API IPC before/independent of the exchange
 *      - exchange-bridge wraps agent-connect so it can't skip registration
 *      - the submit-task handler threads traceId for end-to-end tracing
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

// ── Part A: behavioral tests of the exported submitTask ────────────────────

const h = vi.hoisted(() => ({
  bus: {
    _processSubmit: null,
    getExchange: () => null,
    on: () => {},
    emit: () => {},
    registerProcessSubmit(fn) { this._processSubmit = fn; },
    processSubmit: vi.fn(async () => ({ taskId: 'task-from-auction', queued: true, handled: true })),
  },
}));

vi.mock('../../lib/exchange/event-bus', () => h.bus);
vi.mock('../../lib/agent-space-registry', () => ({
  getAgentSpaceRegistry: vi.fn().mockReturnValue({
    initialize: vi.fn().mockResolvedValue(undefined),
    getDefaultSpaceForTool: vi.fn().mockResolvedValue(null),
    getSpaces: vi.fn().mockReturnValue([]),
    getAgentsInSpace: vi.fn().mockReturnValue([]),
  }),
}));
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../lib/ai-service', () => ({
  default: { json: vi.fn().mockResolvedValue({ genuine: true }) },
  json: vi.fn().mockResolvedValue({ genuine: true }),
}));
vi.mock('uuid', () => ({ v4: vi.fn().mockReturnValue('test-task-id-1234') }));

describe('HUD API submitTask (orb dead-pipe regression - behavior)', () => {
  let hudApi;

  beforeEach(() => {
    vi.resetModules();
    h.bus._processSubmit = null;
    h.bus.processSubmit.mockClear();
    hudApi = require('../../lib/hud-api');
  });

  it('returns a clean error (does not hang) when the exchange bridge is not ready', async () => {
    const result = await hudApi.submitTask('play some monday afternoon music', {
      toolId: 'orb',
      skipFilter: true,
    });
    expect(result).toBeDefined();
    expect(result.queued).toBe(false);
    expect(result.error).toContain('Exchange bridge not initialized');
  });

  it('does not throw and always returns a structured result for an orb submit', async () => {
    const result = await hudApi.submitTask('play some monday afternoon music', {
      toolId: 'orb',
      skipFilter: true,
      traceId: 'orb-test-trace',
    });
    // Whatever the bridge state, the orb must get a structured object back
    // (never a hang, never undefined) so it can ack the function call.
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
    expect('queued' in result).toBe(true);
  });
});

// ── Part B: source-level wiring invariants ─────────────────────────────────

describe('Orb task pipeline wiring (source invariants)', () => {
  const mainSrc = readFileSync(resolve(REPO_ROOT, 'main.js'), 'utf8');
  const bridgeSrc = readFileSync(
    resolve(REPO_ROOT, 'src/voice-task-sdk/exchange-bridge.js'),
    'utf8'
  );
  const hudSrc = readFileSync(resolve(REPO_ROOT, 'lib/hud-api.js'), 'utf8');

  it('main.js registers the HUD API IPC at boot (independent of the exchange bridge)', () => {
    // The load-bearing fix: hud-api.initialize() is called directly in main.js
    // boot, so the submit-task handler exists even if exchange init throws.
    expect(mainSrc).toMatch(/require\(['"]\.\/lib\/hud-api['"]\)\.initialize\(\)/);
  });

  it("main.js registers the HUD API before initializing the exchange bridge", () => {
    const hudInit = mainSrc.indexOf("require('./lib/hud-api').initialize()");
    const exchangeInit = mainSrc.indexOf('initializeExchangeBridge()');
    expect(hudInit).toBeGreaterThan(-1);
    expect(exchangeInit).toBeGreaterThan(-1);
    expect(hudInit).toBeLessThan(exchangeInit);
  });

  it('exchange-bridge wraps agent connection so a failure cannot skip earlier init', () => {
    // connectBuiltInAgents/connectCustomAgents must be inside their own
    // try/catch so a bad agent cannot abort init after the exchange is up.
    expect(bridgeSrc).toMatch(/connectBuiltInAgents\(mergedConfig\.port\)/);
    expect(bridgeSrc).toMatch(/Agent connection failed during init/);
  });

  it('submit-task IPC handler threads the traceId for end-to-end tracing', () => {
    expect(hudSrc).toMatch(/hud-api:submit-task/);
    expect(hudSrc).toMatch(/const traceId = options\?\.traceId/);
  });

  it('submitTask threads the traceId into the auction (processSubmit) metadata', () => {
    // Correlation across function_call_transcript -> submit-task -> auction.
    expect(hudSrc).toMatch(/metadata:\s*\{\s*\.\.\.metadata,\s*traceId\s*\}/);
  });

  it('orb.html surfaces a clear error when the agentHUD bridge is unavailable', () => {
    const orbSrc = readFileSync(resolve(REPO_ROOT, 'orb.html'), 'utf8');
    expect(orbSrc).toMatch(/agentHUD bridge unavailable/);
    expect(orbSrc).toMatch(/HUD bridge failed to load/);
  });
});
