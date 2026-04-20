/**
 * Build Proposal UI -- renderer + agent emission + click wiring contract
 *
 * When no existing agent can handle a request, the exchange hands off
 * to agent-builder-agent, which assesses feasibility via LLM and returns
 * a rich HUD card with Build / Playbook / Not now buttons plus a voice
 * prompt. The card's buttons carry `data-value` attributes that the
 * command-HUD routes back through submitTask with targetAgentId set,
 * reaching the agent's pending-input handler.
 *
 * This test locks the renderer output shape and the agent response
 * shape so that click wiring keeps working.
 */

import { describe, it, expect } from 'vitest';

const { renderAgentUI } = require('../../lib/agent-ui-renderer');

// ══════════════════════════════════════════════════════════════════════
// Renderer tests
// ══════════════════════════════════════════════════════════════════════

describe('buildProposal renderer -- shape', () => {
  it('returns empty string on falsy spec', () => {
    expect(renderAgentUI({ type: 'buildProposal' })).toBeTruthy();
    // Unknown type returns ''
    expect(renderAgentUI({ type: 'nonsense' })).toBe('');
  });

  it('shows the original request prominently', () => {
    const html = renderAgentUI({
      type: 'buildProposal',
      request: 'order me a pizza',
      effort: 'medium',
      reasoning: 'Needs a food delivery API integration.',
      estimatedCostPerUse: '$0.004',
      buildMethod: 'claude-code',
    });
    expect(html).toContain('order me a pizza');
    expect(html).toContain('Build a new agent');
  });

  it('shows the effort badge + cost', () => {
    const html = renderAgentUI({
      type: 'buildProposal',
      request: 'x',
      effort: 'easy',
      reasoning: 'Single LLM call',
      estimatedCostPerUse: '$0.0008',
      buildMethod: 'claude-code',
    });
    expect(html).toContain('Easy build');
    expect(html).toContain('$0.0008');
  });

  it('shows required integrations as tag pills', () => {
    const html = renderAgentUI({
      type: 'buildProposal',
      request: 'check my Tesla battery',
      effort: 'medium',
      reasoning: 'Uses Tesla API',
      estimatedCostPerUse: '$0.003',
      requiredIntegrations: ['Tesla API', 'HTTP client'],
      buildMethod: 'claude-code',
    });
    expect(html).toContain('Tesla API');
    expect(html).toContain('HTTP client');
    expect(html).toContain('Uses:');
  });

  it('shows missing-access warning when requested access is not available', () => {
    const html = renderAgentUI({
      type: 'buildProposal',
      request: 'turn off my lights',
      effort: 'hard',
      reasoning: 'Needs home automation bridge',
      estimatedCostPerUse: '$0.004',
      missingAccess: ['HomeKit bridge', 'Apple Home entitlement'],
      buildMethod: 'playbook',
    });
    expect(html).toContain('Needs access to');
    expect(html).toContain('HomeKit bridge');
  });
});

describe('buildProposal renderer -- button wiring (data-value)', () => {
  it('claude-code build method shows Build now + playbook + Not now', () => {
    const html = renderAgentUI({
      type: 'buildProposal',
      request: 'x',
      effort: 'easy',
      reasoning: 'r',
      estimatedCostPerUse: '$0.001',
      buildMethod: 'claude-code',
    });
    expect(html).toMatch(/data-value="yes"[^>]*>\s*Build now\s*</);
    expect(html).toMatch(/data-value="playbook"[^>]*>\s*Create playbook\s*</);
    expect(html).toMatch(/data-value="no"[^>]*>\s*Not now\s*</);
  });

  it('playbook build method omits Build now', () => {
    const html = renderAgentUI({
      type: 'buildProposal',
      request: 'x',
      effort: 'hard',
      reasoning: 'r',
      estimatedCostPerUse: '$0.01',
      buildMethod: 'playbook',
    });
    expect(html).not.toMatch(/data-value="yes"/);
    expect(html).toMatch(/data-value="playbook"[^>]*>\s*Create playbook\s*</);
    expect(html).toMatch(/data-value="no"/);
  });

  it('not_feasible shows only OK button + alternative', () => {
    const html = renderAgentUI({
      type: 'buildProposal',
      request: 'turn my microwave into a telescope',
      effort: 'not_feasible',
      reasoning: 'Impossible with current tools',
      buildMethod: 'none',
      alternativeSuggestion: 'Try a stargazing app agent instead.',
    });
    expect(html).toContain('Alternative');
    expect(html).toContain('stargazing app agent');
    expect(html).not.toMatch(/data-value="yes"/);
    expect(html).not.toMatch(/data-value="playbook"/);
    expect(html).toMatch(/data-value="no"[^>]*>\s*OK\s*</);
    expect(html).toContain('Not feasible today');
  });
});

describe('buildProposal renderer -- escaping', () => {
  it('escapes HTML in request, reasoning, and integrations', () => {
    const html = renderAgentUI({
      type: 'buildProposal',
      request: '<script>alert(1)</script>',
      effort: 'easy',
      reasoning: '<b>bold</b>',
      estimatedCostPerUse: '$0.001',
      requiredIntegrations: ['<img onerror=x>'],
      buildMethod: 'claude-code',
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>bold</b>');
    expect(html).not.toContain('<img onerror=x>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ══════════════════════════════════════════════════════════════════════
// agent-builder-agent emission contract
// ══════════════════════════════════════════════════════════════════════

describe('agent-builder-agent -- returns ui: buildProposal alongside needsInput', () => {
  it('includes a well-formed buildProposal spec in the result', async () => {
    // BaseAgent spreads ...rest onto the exported agent, so the method
    // shorthand `_assessFeasibility` on the config is reachable as a
    // property. Monkey-patch it to avoid hitting the real LLM.
    const agent = require('../../packages/agents/agent-builder-agent');
    const originalAssess = agent._assessFeasibility;
    agent._assessFeasibility = async () => ({
      effort: 'medium',
      reasoning: 'Uses the weather API and a fast LLM call.',
      requiredIntegrations: ['Weather API'],
      missingAccess: [],
      estimatedCostPerUse: '$0.003',
      similarAgent: null,
      alternativeSuggestion: null,
      spokenResponse: null,
    });

    try {
      const result = await agent.execute({ content: 'check the weather in Paris' });
      expect(result.success).toBe(true);
      expect(result.ui).toBeTruthy();
      expect(result.ui.type).toBe('buildProposal');
      expect(result.ui.request).toBe('check the weather in Paris');
      expect(result.ui.effort).toBe('medium');
      expect(result.ui.buildMethod).toBe('claude-code');
      expect(result.ui.requiredIntegrations).toEqual(['Weather API']);
      // Voice path preserved
      expect(result.needsInput).toBeTruthy();
      expect(result.needsInput.agentId).toBe('agent-builder-agent');
      expect(result.needsInput.context.pendingBuild).toBeTruthy();
    } finally {
      agent._assessFeasibility = originalAssess;
    }
  });

  it('not_feasible assessment produces a buildProposal with buildMethod=none', async () => {
    const agent = require('../../packages/agents/agent-builder-agent');
    const originalAssess = agent._assessFeasibility;
    agent._assessFeasibility = async () => ({
      effort: 'not_feasible',
      reasoning: 'Hardware access not available from the app.',
      requiredIntegrations: [],
      missingAccess: ['USB serial port'],
      estimatedCostPerUse: '~$0.00',
      similarAgent: null,
      alternativeSuggestion: 'Use a web-based interface instead.',
      spokenResponse: null,
    });

    try {
      const result = await agent.execute({ content: 'control my 3D printer' });
      expect(result.ui.buildMethod).toBe('none');
      expect(result.ui.alternativeSuggestion).toContain('web-based interface');
    } finally {
      agent._assessFeasibility = originalAssess;
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// End-to-end: agent-middleware converts ui -> html via renderAgentUI
// ══════════════════════════════════════════════════════════════════════

describe('agent-middleware renders the buildProposal ui to html', () => {
  it('normalizeResult turns ui.type=buildProposal into rich HTML', () => {
    const { normalizeResult } = require('../../packages/agents/agent-middleware');
    const ui = {
      type: 'buildProposal',
      request: 'send me a daily haiku',
      effort: 'easy',
      reasoning: 'Single fast-profile call.',
      estimatedCostPerUse: '$0.0002',
      requiredIntegrations: [],
      buildMethod: 'claude-code',
    };
    const processed = normalizeResult({
      success: true,
      message: 'Easy build...',
      ui,
    });
    expect(typeof processed.html).toBe('string');
    expect(processed.html).toContain('Build a new agent');
    expect(processed.html).toContain('send me a daily haiku');
    expect(processed.html).toMatch(/data-value="yes"/);
  });
});
