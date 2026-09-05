/**
 * Agent Registry renderer — pure builders (ADR-086).
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { buildAdmissionPanel, buildAgentRow, buildChecklistPanel, formatAgo, listingBadge } from '../../registry/renderer.js';
import { vi } from 'vitest';
import { ADMISSION_LINE_IDS, computeAdmission, type AdmissionEntry } from '../../registry/admission.js';

const summary = (over: Partial<LiteRegistryAgentSummary> = {}): LiteRegistryAgentSummary => ({
  id: 'agent-1', name: 'Slack Share', description: 'Post to Slack channel', type: 'gsx', category: 'social', enabled: true, deleted: false,
  source: 'Playbooks', owner: 'robb@onereach.com', updatedMs: Date.now() - 3600_000, listing: 'listed', builtin: false, isSystem: false,
  reach: ['api', 'mcp'], idwCount: 1, knowledgeCount: 0, hosting: 'hosted', account: 'onereach.com', isSkill: false, spaces: [], ...over,
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

// ── ADR-088: the admission checklist panel ──────────────────────────
describe('buildAdmissionPanel (ADR-088)', () => {
  const agent: LiteRegistryAgentDetail = {
    ...summary({ listing: 'unlisted' }), status: 'active', version: '', keywords: [], capabilities: [], executionType: '', gsxEndpoint: '', createdMs: 0,
    endpoints: [], idws: [], knowledgeModels: [], capabilityNodes: [], usedInSpaces: [], representedBy: [], contributedPlaybooks: 0, enabledBy: 0, library: '', manualChecks: {}, listedAt: null,
  };
  const view = (entry: AdmissionEntry | null) => ({ key: 'slack-share', entry, status: computeAdmission(entry), pageUrl: 'https://files.edison.api.onereach.ai/x.html', canWrite: true });
  const handlers = () => ({ isAdmin: true, canWrite: true, onToggle: vi.fn(), onPlatform: vi.fn(), onOwnerEmail: vi.fn(), onAnalyze: vi.fn(), onOpenPage: vi.fn(), onListing: vi.fn() });
  const all = ADMISSION_LINE_IDS.filter((l) => l[0] !== 'f');
  const tick = (ids: readonly string[]) => Object.fromEntries(ids.map((i) => [i, true]));

  it('renders the 27 lines with the page words, the status strip, and greys platform-blocked lines with the reason', () => {
    const panel = buildAdmissionPanel(agent, view({ name: 'Slack Share', platform: 'copilot', items: { a1: true, a2: true } }), handlers());
    document.body.replaceChildren(panel);
    expect(panel.querySelectorAll('.reg-adm-check').length).toBe(ADMISSION_LINE_IDS.length);
    expect(panel.textContent).toContain('A1 · The card');
    expect(panel.textContent).toContain('We test:');
    expect(panel.textContent).toContain('L3 · Governed'); // the Copilot ceiling
    expect(panel.textContent).toContain('Critical'); // A5 unmet grades High, A1 met… the incomplete A still leaves a critical line? no: A3/A5 are High — see below
    expect(panel.querySelector<HTMLInputElement>('#reg-adm-d1')?.disabled).toBe(true);
    expect(panel.querySelector('[data-line="d1"]')?.textContent).toContain('Not possible on this platform');
    expect(panel.querySelector('[data-line="a3"]')?.textContent).toContain('Federated: Entra Agent ID');
    expect(panel.querySelector('[data-line="c1"] .reg-adm-mq')?.textContent).toBe('Q16');
    expect((panel.querySelector('#reg-adm-platform') as HTMLSelectElement).value).toBe('copilot');
  });

  it('ticking a line, changing the platform, the owner contact, Analyze and the page link all reach their handlers', () => {
    const h = handlers();
    const panel = buildAdmissionPanel(agent, view({ name: 'Slack Share', platform: 'gsx', items: {} }), h);
    document.body.replaceChildren(panel);
    const a1 = panel.querySelector<HTMLInputElement>('#reg-adm-a1')!;
    a1.checked = true;
    a1.dispatchEvent(new Event('change', { bubbles: true }));
    expect(h.onToggle).toHaveBeenCalledWith('a1', true);
    const plat = panel.querySelector<HTMLSelectElement>('#reg-adm-platform')!;
    plat.value = 'a2a';
    plat.dispatchEvent(new Event('change', { bubbles: true }));
    expect(h.onPlatform).toHaveBeenCalledWith('a2a');
    const owner = panel.querySelector<HTMLInputElement>('#reg-adm-owner')!;
    owner.value = ' owner@x.com ';
    owner.dispatchEvent(new Event('change', { bubbles: true }));
    expect(h.onOwnerEmail).toHaveBeenCalledWith('owner@x.com');
    (panel.querySelector('#reg-adm-analyze') as HTMLButtonElement).click();
    expect(h.onAnalyze).toHaveBeenCalledTimes(1);
    (panel.querySelector('.reg-adm-head button') as HTMLButtonElement).click();
    expect(h.onOpenPage).toHaveBeenCalledTimes(1);
  });

  it('listing is gated by admission: Submit needs a non-Critical grade, List needs the sign-offs', () => {
    const critical = buildAdmissionPanel(agent, view({ name: 'x', platform: 'gsx', items: tick(all.filter((l) => l !== 'a1')) }), handlers());
    expect(critical.querySelector<HTMLButtonElement>('[data-listing="submitted"]')?.disabled).toBe(true);
    expect(critical.querySelector<HTMLButtonElement>('[data-listing="listed"]')?.disabled).toBe(true);
    const graded = buildAdmissionPanel(agent, view({ name: 'x', platform: 'gsx', items: tick(all) }), handlers());
    expect(graded.querySelector<HTMLButtonElement>('[data-listing="submitted"]')?.disabled).toBe(false);
    expect(graded.querySelector<HTMLButtonElement>('[data-listing="listed"]')?.disabled).toBe(true);
    const signed = buildAdmissionPanel(agent, view({ name: 'x', platform: 'gsx', items: tick([...all, 'f1', 'f2']) }), handlers());
    expect(signed.querySelector<HTMLButtonElement>('[data-listing="listed"]')?.disabled).toBe(false);
    expect(signed.textContent).toContain('admitted, signed off');
  });

  it('a read-only viewer sees the checklist but cannot tick; a missing document shows the reason', () => {
    const ro = buildAdmissionPanel(agent, { ...view({ name: 'x', platform: 'gsx', items: {} }), canWrite: false }, { ...handlers(), canWrite: false, isAdmin: false });
    expect(ro.querySelector<HTMLInputElement>('#reg-adm-a1')?.disabled).toBe(true);
    expect(ro.querySelector('#reg-adm-analyze')).toBeNull();
    const missing = buildAdmissionPanel(agent, null, { ...handlers(), loadError: 'KV unreachable' });
    expect(missing.textContent).toContain('KV unreachable');
  });

  it('shows the last analysis: proven lines carry evidence, the model verdicts carry notes', () => {
    const entry: AdmissionEntry = {
      name: 'x', platform: 'gsx', items: { a1: true },
      lite: { analysis: { at: new Date().toISOString(), by: 'robb@onereach.com', auto: [{ line: 'a1', passed: true, evidence: 'card: name, owner robb@onereach.com, purpose (61 chars)' }], ai: { summary: 'Registered; no observability shown.', lines: [{ id: 'c2', verdict: 'unmet', note: 'no heartbeat in the record' }] } } },
    };
    const panel = buildAdmissionPanel(agent, view(entry), handlers());
    expect(panel.textContent).toContain('Registered; no observability shown.');
    expect(panel.querySelector('[data-line="a1"] .reg-adm-badge')?.textContent).toBe('proven');
    expect(panel.querySelector('[data-line="a1"] .reg-adm-evidence')?.textContent).toContain('purpose (61 chars)');
    expect(panel.querySelector('[data-line="c2"] .reg-adm-badge')?.textContent).toBe('model: unmet');
    expect(panel.querySelector('[data-line="c2"] .reg-adm-ai')?.textContent).toBe('no heartbeat in the record');
  });
});

// ── ADR-089: Skill, hosting + account, Spaces on the row ──────────────
describe('buildAgentRow — where the agent lives (ADR-089)', () => {
  it('shows Hosted · account, a Skill badge for agents with a UI, and the Spaces the viewer may see', () => {
    const row = buildAgentRow(summary({ isSkill: true, spaces: [{ id: 's1', name: 'Procurement', via: 'asset' }, { id: 's2', name: 'Ops', via: 'usage' }, { id: 's3', name: 'Legal', via: 'asset' }] }), false);
    expect(row.querySelector('.reg-chip.skill')?.textContent).toBe('Skill · HiTL');
    expect(row.querySelector('.reg-chip.hosting')?.textContent).toBe('Hosted · onereach.com');
    expect(Array.from(row.querySelectorAll('.reg-chip.space')).map((c) => c.textContent)).toEqual(['Procurement', 'Ops', '+1']);
    expect(row.querySelector('.reg-chip.space')?.getAttribute('title')).toBe('In Procurement');
  });
  it('library and catalog agents read as such', () => {
    expect(buildAgentRow(summary({ hosting: 'library', account: 'onereach.com' }), false).querySelector('.reg-chip.hosting')?.textContent).toBe('Library · onereach.com');
    expect(buildAgentRow(summary({ hosting: 'catalog', account: '' }), false).querySelector('.reg-chip.hosting')?.textContent).toBe('Catalog');
    expect(buildAgentRow(summary(), false).querySelector('.reg-chip.skill')).toBeNull();
  });
});
