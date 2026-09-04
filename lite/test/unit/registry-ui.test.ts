/**
 * Agent Registry renderer — pure builders (ADR-086).
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { buildAgentRow, buildChecklistPanel, formatAgo, listingBadge } from '../../registry/renderer.js';

const summary = (over: Partial<LiteRegistryAgentSummary> = {}): LiteRegistryAgentSummary => ({
  id: 'agent-1', name: 'Slack Share', description: 'Post to Slack channel', type: 'gsx', category: 'social', enabled: true, deleted: false,
  source: 'Playbooks', owner: 'robb@onereach.com', updatedMs: Date.now() - 3600_000, listing: 'listed', builtin: false, isSystem: false,
  reach: ['api', 'mcp'], idwCount: 1, knowledgeCount: 0, ...over,
});

describe('buildAgentRow', () => {
  it('shows name, description, type, reach chips, listing badge and recency', () => {
    const row = buildAgentRow(summary(), true);
    expect(row.getAttribute('aria-selected')).toBe('true');
    expect(row.querySelector('.reg-row-name')?.textContent).toBe('Slack Share');
    expect(Array.from(row.querySelectorAll('.reg-chip.kind')).map((c) => c.textContent)).toEqual(['RESTful', 'MCP']);
    expect(row.querySelector('.reg-badge.is-listed')?.textContent).toBe('listed');
    expect(row.querySelector('.reg-row-when')?.textContent).toBe('1h ago');
  });
  it('a disabled or deleted agent reads as such', () => {
    const row = buildAgentRow(summary({ enabled: false, deleted: true, listing: 'unlisted' }), false);
    expect(row.querySelector('.reg-row-dot')?.classList.contains('is-off')).toBe(true);
    expect(row.querySelector('.reg-badge.is-deleted')).not.toBeNull();
    expect(row.querySelector('.reg-badge.is-unlisted')).toBeNull();
  });
});

describe('buildChecklistPanel', () => {
  const checklist = (ready: boolean, listing: LiteRegistryAgentSummary['listing']): LiteRegistryChecklist => ({
    agent: { ...summary({ listing }), status: 'active', version: '', keywords: [], capabilities: [], executionType: '', gsxEndpoint: '', createdMs: 0, endpoints: [], idws: [], knowledgeModels: [], capabilityNodes: [], usedInSpaces: [], representedBy: [], contributedPlaybooks: 0, enabledBy: 0, library: '', manualChecks: {}, listedAt: null },
    checks: [
      { id: 'name', label: 'Has a display name', kind: 'auto', required: true, passed: true, detail: 'Slack Share' },
      { id: 'reviewed', label: 'Reviewed', kind: 'manual', required: true, passed: ready, detail: ready ? 'ticked' : 'not yet' },
    ],
    ready,
    progress: { passed: ready ? 2 : 1, total: 2 },
  });
  it('an admin with a complete checklist can list; an incomplete one cannot', () => {
    const calls: string[] = [];
    const panel = buildChecklistPanel(checklist(true, 'submitted'), { isAdmin: true, canWrite: true, onToggle: (id, v) => calls.push(`${id}=${String(v)}`), onListing: (l) => calls.push(`listing:${l}`) });
    document.body.appendChild(panel);
    const buttons = Array.from(panel.querySelectorAll('button')).map((b) => [b.textContent, b.disabled] as const);
    expect(buttons).toEqual(expect.arrayContaining([['List on the platform', false], ['Reject', false], ['Unlist', false]]));
    (Array.from(panel.querySelectorAll('button')).find((b) => b.textContent === 'List on the platform') as HTMLButtonElement).click();
    (panel.querySelector('input[data-check="reviewed"]') as HTMLInputElement).click();
    expect(calls).toEqual(['listing:listed', 'reviewed=false']);
    const blocked = buildChecklistPanel(checklist(false, 'unlisted'), { isAdmin: true, canWrite: true, onToggle: () => undefined, onListing: () => undefined });
    expect((Array.from(blocked.querySelectorAll('button')).find((b) => b.textContent === 'List on the platform') as HTMLButtonElement).disabled).toBe(true);
    expect(blocked.textContent).toContain('Complete every required check');
  });
  it('a read-only viewer gets no actions and disabled manual checks', () => {
    const panel = buildChecklistPanel(checklist(true, 'unlisted'), { isAdmin: false, canWrite: false, onToggle: () => undefined, onListing: () => undefined });
    expect(panel.querySelectorAll('button')).toHaveLength(0);
    expect((panel.querySelector('input[data-check="reviewed"]') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('helpers', () => {
  it('formatAgo + listingBadge', () => {
    const now = Date.now();
    expect(formatAgo(now - 30_000, now)).toBe('just now');
    expect(formatAgo(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatAgo(now - 3 * 86_400_000, now)).toBe('3d ago');
    expect(formatAgo(0, now)).toBe('');
    expect(listingBadge('rejected').className).toContain('is-rejected');
  });
});
