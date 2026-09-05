/**
 * ADR-088 — an agent asset's registry standing in its Space detail pane:
 * admission status, Share publicly (share → listed/submitted, unshare →
 * unlisted, refusals explained), and the door to the registry on that agent.
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { buildAgentRegistryBlock } from '../../spaces/spaces.js';

const ok = <T,>(value: T) => ({ ok: true as const, value });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};
const item = { id: 'asset-1', kind: 'agent', title: 'Procurement agent', representsAgentId: 'ag-1' } as unknown as Parameters<typeof buildAgentRegistryBlock>[0];
const view = (over: Partial<{ admit: string; why: string; canWrite: boolean }> = {}) => ({
  key: 'procurement-agent', entry: null, canWrite: over.canWrite ?? true, pageUrl: 'https://files.edison.api.onereach.ai/x.html',
  status: { progress: { met: 5, total: 27 }, rung: 'l1', rungLabel: 'L1 · Registered', ceiling: 'l4', ceilingLabel: 'L4 · Managed', platform: 'gsx', platformName: 'GSX native or migrated', grade: 'h', gradeLabel: 'High', signed: false, admit: over.admit ?? 'pending sign-off (F1, F2)', why: over.why ?? 'Set by B1, D1.', meanwhile: '', lines: [] },
});
function bridge(listing = 'unlisted', isAdmin = false, setListing = vi.fn(async () => ok({ ok: true }))) {
  const reg = {
    checklist: vi.fn(async () => ok({ agent: { id: 'ag-1', listing }, checks: [], ready: false, progress: { passed: 0, total: 0 } })),
    admissionGet: vi.fn(async () => ok(view())),
    whoAmI: vi.fn(async () => ok({ viewerId: 'robb@onereach.com', isAdmin, noAdminYet: false, admins: [] })),
    setListing,
    openWindow: vi.fn(async () => ok({ ok: true })),
  };
  (window as unknown as { lite: unknown }).lite = { registry: reg };
  return reg;
}

describe('buildAgentRegistryBlock (ADR-088)', () => {
  it('is absent for assets that represent no agent', () => {
    bridge();
    expect(buildAgentRegistryBlock({ ...item, representsAgentId: undefined } as never)).toBeNull();
  });

  it('shows the admission standing and opens the registry on this agent', async () => {
    const reg = bridge();
    const block = buildAgentRegistryBlock(item)!;
    document.body.replaceChildren(block);
    await flush();
    expect(block.querySelector('.spaces-agent-registry-status')?.textContent).toBe('L1 · Registered · grade High · pending sign-off (F1, F2) · GSX native or migrated');
    expect(block.querySelector('.spaces-agent-registry-why')?.textContent).toBe('Set by B1, D1.');
    (block.querySelector('.spaces-agent-registry-open') as HTMLButtonElement).click();
    expect(reg.openWindow).toHaveBeenCalledWith({ agentId: 'ag-1' });
  });

  it('share → submitted for a creator, listed for an admin; unshare → unlisted', async () => {
    const creator = bridge('unlisted', false);
    const block = buildAgentRegistryBlock(item)!;
    document.body.replaceChildren(block);
    await flush();
    const toggle = block.querySelector<HTMLInputElement>('.spaces-agent-registry-toggle')!;
    expect(toggle.disabled).toBe(false);
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(creator.setListing).toHaveBeenCalledWith('ag-1', 'submitted');

    const admin = bridge('listed', true);
    const block2 = buildAgentRegistryBlock(item)!;
    document.body.replaceChildren(block2);
    await flush();
    const t2 = block2.querySelector<HTMLInputElement>('.spaces-agent-registry-toggle')!;
    expect(t2.checked).toBe(true);
    expect(block2.querySelector('.spaces-agent-registry-share span')?.textContent).toContain('Shared publicly');
    t2.checked = false;
    t2.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(admin.setListing).toHaveBeenCalledWith('ag-1', 'unlisted');
  });

  it('a refusal (not admitted) is explained and the toggle springs back', async () => {
    const refuse = vi.fn(async () => ({ ok: false as const, error: { code: 'REGISTRY_NOT_READY', message: 'Not admitted to act: Set by A1.', remediation: 'Open the admission checklist.' } }));
    bridge('unlisted', true, refuse as never);
    const block = buildAgentRegistryBlock(item)!;
    document.body.replaceChildren(block);
    await flush();
    const toggle = block.querySelector<HTMLInputElement>('.spaces-agent-registry-toggle')!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    await flush();
    expect(refuse).toHaveBeenCalledWith('ag-1', 'listed');
    expect(toggle.checked).toBe(false);
    expect(document.body.textContent).toContain('Not admitted to act');
  });

  it('a viewer who may not write sees the standing but cannot toggle', async () => {
    const reg = bridge('unlisted', false);
    reg.admissionGet.mockResolvedValue(ok(view({ canWrite: false })) as never);
    const block = buildAgentRegistryBlock(item)!;
    document.body.replaceChildren(block);
    await flush();
    expect(block.querySelector<HTMLInputElement>('.spaces-agent-registry-toggle')?.disabled).toBe(true);
  });
});
