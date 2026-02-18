/**
 * Agent Registry - CRUD Lifecycle Tests
 *
 * Lifecycle: Load agents -> Read all -> Read by ID -> Validate -> Build categories -> Clear -> Verify
 *
 * Tests the registry API itself using mock agents (does not load real agent files).
 *
 * Run:  npx vitest run test/unit/agent-registry-crud.test.js
 */

import { describe, it, expect, vi } from 'vitest';

// Mock log-event-queue
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const {
  validateAgent,
  REQUIRED_PROPERTIES,
  OPTIONAL_PROPERTIES,
  BUILT_IN_AGENT_IDS,
  getAgentIds,
  isRegistered,
} = require('../../packages/agents/agent-registry');

// ═══════════════════════════════════════════════════════════════════
// VALIDATION: Create -> Validate -> Read errors
// ═══════════════════════════════════════════════════════════════════

describe('Agent Registry - Agent Validation', () => {
  function makeValidAgent(overrides = {}) {
    return {
      id: 'test-agent',
      name: 'Test Agent',
      description: 'A test agent for unit testing',
      categories: ['test'],
      keywords: ['test', 'unit'],
      execute: async () => ({ success: true, message: 'done' }),
      ...overrides,
    };
  }

  it('Step 1: Create a valid agent and validate', () => {
    const agent = makeValidAgent();
    const result = validateAgent(agent, 'test-agent.js');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('Step 2: Read validation result for incomplete agent', () => {
    const agent = { id: 'broken' };
    const result = validateAgent(agent, 'broken.js');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('Step 3: Validate rejects agent with bid() method', () => {
    const agent = makeValidAgent({ bid: () => 0.5 });
    const result = validateAgent(agent, 'bidding-agent.js');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('FORBIDDEN'))).toBe(true);
  });

  it('Step 4: Validate checks type of categories', () => {
    const agent = makeValidAgent({ categories: [123] });
    const result = validateAgent(agent, 'bad-cats.js');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('must be a string'))).toBe(true);
  });

  it('Step 5: Validate checks type of keywords', () => {
    const agent = makeValidAgent({ keywords: [null] });
    const result = validateAgent(agent, 'bad-kw.js');
    expect(result.valid).toBe(false);
  });

  it('Step 6: Validate checks execute is a function', () => {
    const agent = makeValidAgent({ execute: 'not-a-function' });
    const result = validateAgent(agent, 'bad-exec.js');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('execute must be a function'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// REGISTRY CONSTANTS
// ═══════════════════════════════════════════════════════════════════

describe('Agent Registry - Constants & Helpers', () => {
  it('BUILT_IN_AGENT_IDS is a non-empty array', () => {
    expect(Array.isArray(BUILT_IN_AGENT_IDS)).toBe(true);
    expect(BUILT_IN_AGENT_IDS.length).toBeGreaterThan(0);
  });

  it('REQUIRED_PROPERTIES includes id, name, execute', () => {
    expect(REQUIRED_PROPERTIES).toContain('id');
    expect(REQUIRED_PROPERTIES).toContain('name');
    expect(REQUIRED_PROPERTIES).toContain('execute');
    expect(REQUIRED_PROPERTIES).toContain('description');
    expect(REQUIRED_PROPERTIES).toContain('categories');
    expect(REQUIRED_PROPERTIES).toContain('keywords');
  });

  it('OPTIONAL_PROPERTIES includes prompt, capabilities, initialize', () => {
    expect(OPTIONAL_PROPERTIES).toContain('prompt');
    expect(OPTIONAL_PROPERTIES).toContain('capabilities');
    expect(OPTIONAL_PROPERTIES).toContain('initialize');
    expect(OPTIONAL_PROPERTIES).toContain('cleanup');
  });

  it('getAgentIds returns a copy of BUILT_IN_AGENT_IDS', () => {
    const ids = getAgentIds();
    expect(ids).toEqual(BUILT_IN_AGENT_IDS);
    // Must be a copy, not the same reference
    ids.push('fake');
    expect(BUILT_IN_AGENT_IDS).not.toContain('fake');
  });

  it('isRegistered returns true for known agents', () => {
    expect(isRegistered('time-agent')).toBe(true);
    expect(isRegistered('weather-agent')).toBe(true);
  });

  it('isRegistered returns false for unknown agents', () => {
    expect(isRegistered('unicorn-agent')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// FULL AGENT LIFECYCLE (validate -> verify -> re-validate)
// ═══════════════════════════════════════════════════════════════════

describe('Agent Registry - Full Validation Lifecycle', () => {
  it('Create -> Validate -> Modify -> Re-validate -> Break -> Verify failure', () => {
    const agent = {
      id: 'lifecycle-agent',
      name: 'Lifecycle Agent',
      description: 'Tests the full validation lifecycle',
      categories: ['test'],
      keywords: ['lifecycle'],
      execute: async () => ({ success: true, message: 'ok' }),
    };

    // Step 1: Create and validate
    let result = validateAgent(agent, 'lifecycle-agent.js');
    expect(result.valid).toBe(true);

    // Step 2: Modify - add optional properties
    agent.prompt = 'You are a lifecycle tester';
    agent.capabilities = ['testing'];
    agent.version = '1.0.0';
    result = validateAgent(agent, 'lifecycle-agent.js');
    expect(result.valid).toBe(true);

    // Step 3: Break - remove required property
    delete agent.execute;
    result = validateAgent(agent, 'lifecycle-agent.js');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('execute'))).toBe(true);

    // Step 4: Fix - restore and add forbidden bid()
    agent.execute = async () => ({ success: true });
    agent.bid = () => 1.0;
    result = validateAgent(agent, 'lifecycle-agent.js');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('FORBIDDEN'))).toBe(true);

    // Step 5: Fix - remove bid
    delete agent.bid;
    result = validateAgent(agent, 'lifecycle-agent.js');
    expect(result.valid).toBe(true);
  });
});
