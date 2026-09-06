/**
 * GSX agent flows in the Spaces detail pane (2026-09-05).
 *
 * A flow synced from GSX Designer is labelled "GSX agent flow" and opens
 * in two places — the flow in Designer and, when it has one, its View in
 * Action Desk — through the signed-in GSX window bridge, never a bare
 * link. Ordinary agents are untouched.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

interface Item {
  id: string;
  title: string;
  kind: string;
  sourceUrl?: string;
  createdAt: string;
  updatedAt: string;
  otherSpaces: Array<{ id: string; name: string }>;
  producedBy: null;
  metadata?: Record<string, unknown>;
}

interface RendererTestApi {
  buildDetailPane(item: Item, onClose: () => void): HTMLElement;
}

let renderer: RendererTestApi;
let gsxAgentFlowLinks: (item: { kind: string; sourceUrl?: string; metadata?: Record<string, unknown> | null }) => {
  designerUrl: string | null;
  viewUrl: string | null;
  viewLabel: string | null;
  botLabel: string | null;
} | null;

beforeAll(async () => {
  const mod = await import('../../spaces/spaces.js');
  gsxAgentFlowLinks = mod.gsxAgentFlowLinks;
  renderer = (window as unknown as { __spacesRendererForTesting: RendererTestApi }).__spacesRendererForTesting;
  expect(renderer).toBeDefined();
});

const DESIGNER = 'https://studio.edison.onereach.ai/flows/b1/f1';
const VIEW = 'https://actiondesk.edison.onereach.ai/views/v1?accountId=acct';

function agent(over: Partial<Item> = {}): Item {
  return {
    id: 'asset-gsxflow-f1',
    title: 'Create a Ticket',
    kind: 'agent',
    sourceUrl: DESIGNER,
    createdAt: '2026-09-05T00:00:00Z',
    updatedAt: '2026-09-05T00:00:00Z',
    otherSpaces: [],
    producedBy: null,
    metadata: {
      source: 'gsx-designer',
      gsxBotLabel: 'Tickets',
      gsxDesignerUrl: DESIGNER,
      gsxViewId: 'v1',
      gsxViewUrl: VIEW,
      gsxViewLabel: 'Create a Ticket v2',
    },
    ...over,
  };
}

const openWindow = vi.fn(async () => ({}));
beforeEach(() => {
  openWindow.mockClear();
  (window as unknown as { lite?: unknown }).lite = { gsx: { openWindow } };
});

describe('gsxAgentFlowLinks', () => {
  it('answers only for agents synced from Designer', () => {
    expect(gsxAgentFlowLinks({ kind: 'document', metadata: { source: 'gsx-designer' } })).toBeNull();
    expect(gsxAgentFlowLinks({ kind: 'agent', metadata: { source: 'wiser' } })).toBeNull();
    expect(gsxAgentFlowLinks({ kind: 'agent' })).toBeNull();
    expect(gsxAgentFlowLinks(agent())).toEqual({
      designerUrl: DESIGNER,
      viewUrl: VIEW,
      viewLabel: 'Create a Ticket v2',
      botLabel: 'Tickets',
    });
  });

  it('an agent synced before the links existed still opens in Designer through sourceUrl', () => {
    const legacy = agent({ metadata: { source: 'gsx-designer', gsxBotLabel: 'Tickets' } });
    expect(gsxAgentFlowLinks(legacy)).toEqual({ designerUrl: DESIGNER, viewUrl: null, viewLabel: null, botLabel: 'Tickets' });
  });
});

describe('the detail pane for a GSX agent flow', () => {
  it('is labelled "GSX agent flow" and offers Open in Designer + Open view, both through the GSX window', async () => {
    const el = renderer.buildDetailPane(agent(), () => undefined);
    expect(el.querySelector('.spaces-card-kind')?.textContent).toBe('GSX agent flow');
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('.spaces-detail-gsx-flow button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Open in Designer', 'Open view']);
    expect(buttons[1]?.title).toContain('Create a Ticket v2');

    buttons[0]?.click();
    buttons[1]?.click();
    await Promise.resolve();
    expect(openWindow).toHaveBeenCalledTimes(2);
    expect(openWindow).toHaveBeenNthCalledWith(1, { env: 'edison', url: DESIGNER, title: 'Open in Designer — Create a Ticket' });
    expect(openWindow).toHaveBeenNthCalledWith(2, { env: 'edison', url: VIEW, title: 'Open view — Create a Ticket' });
  });

  it('a flow without a view offers Designer only', () => {
    const el = renderer.buildDetailPane(
      agent({ metadata: { source: 'gsx-designer', gsxBotLabel: 'Tickets', gsxDesignerUrl: DESIGNER } }),
      () => undefined
    );
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('.spaces-detail-gsx-flow button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Open in Designer']);
  });

  it('an ordinary agent keeps its label and gets no GSX row', () => {
    const el = renderer.buildDetailPane(
      agent({ sourceUrl: undefined, metadata: { source: 'lite' } }),
      () => undefined
    );
    expect(el.querySelector('.spaces-card-kind')?.textContent).not.toBe('GSX agent flow');
    expect(el.querySelector('.spaces-detail-gsx-flow')).toBeNull();
  });

  it('without the GSX window bridge the links still open, in a new window', () => {
    (window as unknown as { lite?: unknown }).lite = undefined;
    const opened = vi.fn();
    window.open = opened as unknown as typeof window.open;
    const el = renderer.buildDetailPane(agent(), () => undefined);
    el.querySelector<HTMLButtonElement>('.spaces-detail-gsx-flow button')?.click();
    expect(opened).toHaveBeenCalledWith(DESIGNER, '_blank', 'noopener');
    expect(openWindow).not.toHaveBeenCalled();
  });
});
