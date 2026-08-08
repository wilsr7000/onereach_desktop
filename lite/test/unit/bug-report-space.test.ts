/**
 * The default "Onereach.ai Lite Feedback" Space, and mirroring filed
 * reports into it as tickets (bugs AND feature requests).
 *
 * The load-bearing assertion in this file is the SOFT-FAIL contract: a
 * graph that is down, a Space that can't be created, an items.create
 * that rejects -- none of it may turn a successfully-filed bug into a
 * failed one. A bug reporter that breaks when the backend is unhealthy
 * is broken exactly when it matters.
 */

import { describe, it, expect } from 'vitest';
import {
  ensureLiteFeedbackSpace,
  fileFeedbackToGraph,
  buildFeedbackItemTitle,
  buildFeedbackItemContent,
  LITE_FEEDBACK_SPACE_NAME,
  LITE_FEEDBACK_SPACE_DESCRIPTION,
} from '../../bug-report/space.js';
import type { BugReportPayload } from '../../bug-report/capture.js';
import type { SpacesApi, Space } from '../../spaces/api.js';

function space(id: string, name: string): Space {
  return { id, name } as unknown as Space;
}

/** Minimal SpacesApi stub -- only the members `space.ts` touches. */
function stubApi(over: {
  listSpaces?: () => Promise<Space[]>;
  createSpace?: (input: unknown) => Promise<Space>;
  create?: (input: unknown) => Promise<unknown>;
  setSpaceKind?: (id: string, kind: string) => Promise<string>;
}): SpacesApi {
  return {
    listSpaces: over.listSpaces ?? (async (): Promise<Space[]> => []),
    createSpace: over.createSpace ?? (async (): Promise<Space> => space('new', LITE_FEEDBACK_SPACE_NAME)),
    setSpaceKind: over.setSpaceKind ?? (async (): Promise<string> => 'shared'),
    items: {
      create: over.create ?? (async (): Promise<unknown> => ({ id: 'item-1' })),
    },
  } as unknown as SpacesApi;
}

function payload(over: Partial<BugReportPayload> = {}): BugReportPayload {
  return {
    schemaVersion: 1,
    timestamp: '2026-08-06T12:00:00.000Z',
    appTag: 'lite',
    source: 'user-bug-report',
    feedbackType: 'bug',
    version: '0.0.31',
    os: { platform: 'darwin', release: '25.5.0', arch: 'arm64' },
    description: 'Spaces window renders blank after login',
    recentLogs: 'line one\nline two',
    redactionTelemetry: { bucket: 'none', countsByKind: {} },
    status: 'open',
    notes: '',
    lastModified: '2026-08-06T12:00:00.000Z',
    ...over,
  } as BugReportPayload;
}

describe('ensureLiteFeedbackSpace', () => {
  it('reuses an existing Space rather than creating a duplicate', async () => {
    let created = 0;
    const api = stubApi({
      listSpaces: async () => [space('s1', 'Other'), space('s2', LITE_FEEDBACK_SPACE_NAME)],
      createSpace: async () => {
        created += 1;
        return space('nope', LITE_FEEDBACK_SPACE_NAME);
      },
    });
    const result = await ensureLiteFeedbackSpace(api);
    expect(result.outcome).toBe('found');
    expect(result.space?.id).toBe('s2');
    expect(created, 'must not create when one already exists').toBe(0);
  });

  it('matches the name case-insensitively and ignores stray whitespace', async () => {
    const api = stubApi({
      listSpaces: async () => [space('s9', '  onereach.ai lite FEEDBACK ')],
    });
    const result = await ensureLiteFeedbackSpace(api);
    expect(result.outcome).toBe('found');
    expect(result.space?.id).toBe('s9');
  });

  it('creates the Space on first use, with a description the suggester can read', async () => {
    let input: { name?: string; description?: string } = {};
    const api = stubApi({
      listSpaces: async () => [],
      createSpace: async (i) => {
        input = i as typeof input;
        return space('fresh', LITE_FEEDBACK_SPACE_NAME);
      },
    });
    const result = await ensureLiteFeedbackSpace(api);
    expect(result.outcome).toBe('created');
    expect(result.space?.id).toBe('fresh');
    expect(input.name).toBe(LITE_FEEDBACK_SPACE_NAME);
    expect(input.description).toBe(LITE_FEEDBACK_SPACE_DESCRIPTION);
  });

  it('treats a lost create race as success and adopts the winner', async () => {
    let listCalls = 0;
    const api = stubApi({
      listSpaces: async () => {
        listCalls += 1;
        // First list: empty (so we try to create). Second: the winner.
        return listCalls === 1 ? [] : [space('winner', LITE_FEEDBACK_SPACE_NAME)];
      },
      createSpace: async () => {
        throw Object.assign(new Error('name taken'), { code: 'SPACES_DUPLICATE_NAME' });
      },
    });
    const result = await ensureLiteFeedbackSpace(api);
    expect(result.outcome).toBe('raced');
    expect(result.space?.id).toBe('winner');
  });

  it('reports failure (never throws) when the graph is unreachable', async () => {
    const api = stubApi({
      listSpaces: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const result = await ensureLiteFeedbackSpace(api);
    expect(result.outcome).toBe('failed');
    expect(result.space).toBeNull();
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('does not attempt a create when listing failed', async () => {
    let created = 0;
    const api = stubApi({
      listSpaces: async () => {
        throw new Error('down');
      },
      createSpace: async () => {
        created += 1;
        return space('x', LITE_FEEDBACK_SPACE_NAME);
      },
    });
    await ensureLiteFeedbackSpace(api);
    expect(created, 'a blind create on a failed list risks a duplicate').toBe(0);
  });

  it('fails clearly when the name is taken by a Space this account cannot see', async () => {
    const api = stubApi({
      listSpaces: async () => [],
      createSpace: async () => {
        throw Object.assign(new Error('duplicate'), { code: 'SPACES_DUPLICATE_NAME' });
      },
    });
    const result = await ensureLiteFeedbackSpace(api);
    expect(result.outcome).toBe('failed');
    expect(result.error).toContain('not visible');
  });
});

describe('bug item rendering', () => {
  it('titles with the version and the first line of the description', () => {
    expect(buildFeedbackItemTitle(payload())).toBe('[0.0.31] [bug] Spaces window renders blank after login');
  });

  it('falls back to a generic title when no description was given', () => {
    expect(buildFeedbackItemTitle(payload({ description: '   ' }))).toBe('[0.0.31] [bug] Bug report');
  });

  it('tags feature requests distinctly and falls back to a feature title', () => {
    expect(
      buildFeedbackItemTitle(payload({ feedbackType: 'feature', description: 'Add dark exports' }))
    ).toBe('[0.0.31] [idea] Add dark exports');
    expect(
      buildFeedbackItemTitle(payload({ feedbackType: 'feature', description: '  ' }))
    ).toBe('[0.0.31] [idea] Feature request');
  });

  it('truncates a very long first line', () => {
    const title = buildFeedbackItemTitle(payload({ description: 'x'.repeat(400) }));
    expect(title.length).toBeLessThanOrEqual(136);
    expect(title.endsWith('…')).toBe(true);
  });

  it('renders description, metadata and logs into the body', () => {
    const body = buildFeedbackItemContent(payload());
    expect(body).toContain('**Type:** Bug report');
    expect(body).toContain('Spaces window renders blank after login');
    expect(body).toContain('**App version:** 0.0.31');
    expect(body).toContain('darwin 25.5.0 arm64');
    expect(body).toContain('line one\nline two');
  });

  it('omits the log section entirely when there are no logs', () => {
    expect(buildFeedbackItemContent(payload({ recentLogs: '' }))).not.toContain('Recent logs');
  });
});

describe('fileFeedbackToGraph — soft-fail contract', () => {
  it('files the report into the ensured Space', async () => {
    let input: { spaceId?: string; kind?: string; metadata?: Record<string, unknown> } = {};
    const api = stubApi({
      listSpaces: async () => [space('bugs', LITE_FEEDBACK_SPACE_NAME)],
      create: async (i) => {
        input = i as typeof input;
        return { id: 'item-9' };
      },
    });
    const result = await fileFeedbackToGraph(payload(), api);
    expect(result.filed).toBe(true);
    expect(input.spaceId).toBe('bugs');
    // Tickets, not notes — filings land on the triage board.
    expect(input.kind).toBe('ticket');
    // The join back to the KV system of record.
    expect(input.metadata?.['bugReportTimestamp']).toBe('2026-08-06T12:00:00.000Z');
    expect(input.metadata?.['source']).toBe('lite-feedback');
    expect(input.metadata?.['feedbackType']).toBe('bug');
  });

  it('returns filed:false instead of throwing when the Space cannot be resolved', async () => {
    const api = stubApi({
      listSpaces: async () => {
        throw new Error('graph down');
      },
    });
    const result = await fileFeedbackToGraph(payload(), api);
    expect(result.filed).toBe(false);
    expect(result.error).toContain('graph down');
  });

  it('returns filed:false instead of throwing when the item write is rejected', async () => {
    const api = stubApi({
      listSpaces: async () => [space('bugs', LITE_FEEDBACK_SPACE_NAME)],
      create: async () => {
        throw new Error('write rejected');
      },
    });
    const result = await fileFeedbackToGraph(payload(), api);
    expect(result.filed).toBe(false);
    expect(result.spaceId).toBe('bugs');
    expect(result.error).toContain('write rejected');
  });
});
