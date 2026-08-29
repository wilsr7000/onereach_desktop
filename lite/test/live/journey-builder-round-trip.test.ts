/**
 * @vitest-environment jsdom
 *
 * The Journey Map Builder ⇄ Lite round-trip, driven headlessly.
 *
 * The Builder is a separate codebase, deployed separately, that talks to
 * Lite through `window.journeySpaces`. Nothing in either repo tests the
 * seam: Lite's unit tests stub the bridge, the Builder's stub Lite, and
 * the only thing that has ever exercised both is a person clicking Save
 * and hoping. The two can drift apart with every deploy on either side.
 *
 * This test removes the person. It loads the REAL deployed Builder
 * modules, hands them a bridge wired to Lite's REAL journey pipeline
 * (`sanitizeJourneyDraft` → `journeyToMarkdown`), and runs the Builder's
 * own `saveJourneyToSpace()` — the actual create-then-update dance, not
 * an imitation of it. No Electron, no window to drive, no clicking.
 *
 * What it is really pinning: a journey map is a rich project here
 * (personas, stages, sections, tickets) and a markdown asset there.
 * Lite REGENERATES that markdown from a sanitized draft, so everything
 * the draft doesn't carry is lost unless the Builder's second write puts
 * the project back. That is the whole fidelity story, and it is one
 * refactor on either side away from silently breaking.
 *
 * Network, but free and fast — it fetches two static files and makes no
 * model call. Offline (or a dead deploy) skips with the reason.
 *
 * Point it at a local Builder checkout instead of the deployment with:
 *   JMB_DIR="$HOME/Capablity Projects/journey Map Builder" npm run lite:test:live
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  sanitizeJourneyDraft,
  journeyToMarkdown,
  journeyDescription,
} from '../../spaces/journey.js';
import { JOURNEY_MAP_BUILDER_URL } from '../../journey-map-window.js';

/** The two Builder modules that make up its half of the contract. */
const MODULES = ['utils/journey-spaces-format.js', 'utils/spaces-client.js'] as const;

const builderBase = JOURNEY_MAP_BUILDER_URL.replace(/index\.html$/, '');
const localDir = process.env['JMB_DIR'];

let sources: string[] | null = null;
let loadError = '';
let origin = '';

async function fetchModules(): Promise<string[] | null> {
  if (typeof localDir === 'string' && localDir.length > 0) {
    origin = `local checkout ${localDir}`;
    const out: string[] = [];
    for (const m of MODULES) {
      const path = join(localDir, m);
      if (!existsSync(path)) {
        loadError = `JMB_DIR is set but ${path} does not exist`;
        return null;
      }
      out.push(readFileSync(path, 'utf8'));
    }
    return out;
  }
  origin = `deployed build ${builderBase}`;
  const out: string[] = [];
  for (const m of MODULES) {
    try {
      const res = await fetch(`${builderBase}${m}`);
      if (!res.ok) {
        loadError = `${m} returned HTTP ${res.status} — the Builder deploy may be broken`;
        return null;
      }
      out.push(await res.text());
    } catch (err) {
      loadError = `could not reach the Builder (${(err as Error).message})`;
      return null;
    }
  }
  return out;
}

// Top-level await: the skip decision has to be made at collection time.
sources = await fetchModules();

// ---------------------------------------------------------------------------
// A Space, backed by Lite's real journey pipeline.
//
// `save` does exactly what `journeys.create` does in spaces/main.ts, and
// `update` what `items:update` does — so anything this store loses is
// something Lite genuinely loses.
// ---------------------------------------------------------------------------

interface StoredAsset {
  id: string;
  title: string;
  kind: string;
  content: string;
  description: string;
}

interface FakeSpace {
  assets: Map<string, StoredAsset>;
  bridge: Record<string, unknown>;
  failNextUpdate: boolean;
}

function makeSpace(): FakeSpace {
  const assets = new Map<string, StoredAsset>();
  let seq = 0;
  const space: FakeSpace = { assets, bridge: {}, failNextUpdate: false };

  space.bridge = {
    available: true,
    listSpaces: async () => [{ id: 's1', name: 'Design' }],
    listJourneys: async () =>
      [...assets.values()]
        .filter((a) => a.kind === 'journey')
        .map((a) => ({ id: a.id, title: a.title, spaceId: 's1' })),
    load: async (id: string) => {
      const a = assets.get(id);
      return a === undefined ? null : { ...a };
    },
    save: async (_spaceId: string, draft: unknown) => {
      // journeys.create: sanitize, refuse the empty, regenerate markdown.
      const safe = sanitizeJourneyDraft(draft);
      if (safe.phases.length === 0) {
        return { ok: false, error: 'A journey map needs at least one phase with a touchpoint' };
      }
      const id = `journey-${++seq}`;
      assets.set(id, {
        id,
        title: safe.title,
        kind: 'journey',
        content: journeyToMarkdown(safe),
        description: journeyDescription(safe),
      });
      return { ok: true, id };
    },
    update: async (id: string, patch: Record<string, string | undefined>) => {
      if (space.failNextUpdate) {
        space.failNextUpdate = false;
        return { ok: false, error: 'read-only member' };
      }
      const a = assets.get(id);
      if (a === undefined) return { ok: false, error: 'not found' };
      assets.set(id, {
        ...a,
        ...(patch['title'] !== undefined ? { title: patch['title'] } : {}),
        ...(patch['content'] !== undefined ? { content: patch['content'] } : {}),
        ...(patch['description'] !== undefined ? { description: patch['description'] } : {}),
      });
      return { ok: true };
    },
    openTarget: async () => null,
    onOpenTarget: () => undefined,
  };
  return space;
}

// ---------------------------------------------------------------------------
// A realistic Builder project — the shape `projectToJourneyDraft` reads,
// carrying the things markdown alone cannot express: stable ids, emoji
// emotion levels, research, and tickets.
// ---------------------------------------------------------------------------

const PROJECT = {
  metadata: { projectName: 'Enterprise onboarding', projectId: 'proj-42', version: 'v3.1' },
  journeyData: {
    subtitle: 'A new enterprise admin standing up their first workspace',
    personas: [
      {
        id: 'persona-1',
        name: 'Dana, IT admin',
        journeys: [
          {
            id: 'journey-a',
            name: 'First workspace',
            stages: [
              {
                id: 'stage-1',
                name: 'Evaluate',
                phaseOverview: 'Deciding whether this is worth the migration',
                sections: {
                  touchpoints: { items: ['Reads the security whitepaper', 'Books a demo'] },
                  thinking: { items: ['Will this pass our review?', 'Who else uses it?'] },
                  agentObjective: { items: ['Pre-fill the security questionnaire'] },
                  emotion: { notes: 'Skeptical', emoji: { emoji: '🤔', level: 2 } },
                },
                tickets: [{ id: 'TICK-1', title: 'Draft security questionnaire', status: 'open' }],
              },
              {
                id: 'stage-2',
                name: 'Configure',
                phaseOverview: 'Wiring SSO and provisioning',
                sections: {
                  touchpoints: { items: ['Configures SAML', 'Imports 400 users'] },
                  thinking: { items: ['If SSO breaks, I own the pager'] },
                  agentObjective: { items: ['Validate the SAML metadata before submit'] },
                  emotion: { notes: 'Tense', emoji: { emoji: '😬', level: 4 } },
                },
                tickets: [{ id: 'TICK-2', title: 'SAML validator', status: 'in-progress' }],
              },
              {
                id: 'stage-3',
                name: 'Roll out',
                phaseOverview: 'Getting the first team live',
                sections: {
                  touchpoints: { items: ['Runs a pilot with support'] },
                  thinking: { items: ['I need a win to show leadership'] },
                  agentObjective: { items: ['Summarise pilot adoption weekly'] },
                  emotion: { notes: 'Hopeful', emoji: { emoji: '🙂', level: 1 } },
                },
                tickets: [],
              },
            ],
          },
        ],
      },
    ],
  },
  research: [{ id: 'res-1', kind: 'interview', note: 'Dana: "SSO is the whole decision."' }],
};

interface BuilderWindow {
  JourneySpacesFormat: {
    projectToJourneyDraft(p: unknown): { title: string; journey: string; phases: unknown[] };
    projectToMarkdown(p: unknown): string;
    embedProjectData(md: string, p: unknown): { content: string; embedded: boolean };
    extractProjectData(content: string): unknown;
    MAX_CONTENT: number;
  };
  SpacesClient: {
    isBridged(): boolean;
    saveJourneyToSpace(
      spaceId: string,
      project: unknown,
      existingItemId?: string | null
    ): Promise<{ id: string; embedded: boolean; type: string }>;
    search(q: string, opts?: { limit?: number }): Promise<Array<{ id: string; title: string }>>;
    savePlaybookToSpace(spaceId: string, playbook: unknown): Promise<unknown>;
  };
  journeySpaces?: unknown;
}

const w = (): BuilderWindow => globalThis.window as unknown as BuilderWindow;

describe.skipIf(sources === null)('the Builder ⇄ Lite journey round-trip', () => {
  let space: FakeSpace;

  beforeAll(() => {
    // Evaluate the Builder's own modules into this window, exactly as
    // its index.html does with <script> tags.
    for (const src of sources ?? []) new Function(src)();
    console.log(`  ↳ Builder modules from ${origin}`);
  });

  const attach = (): void => {
    space = makeSpace();
    w().journeySpaces = space.bridge;
    globalThis.localStorage?.clear();
  };

  it('the deployed Builder detects the bridge Lite hands it', () => {
    attach();
    expect(w().SpacesClient.isBridged(), 'the Builder did not recognise window.journeySpaces').toBe(
      true
    );
  });

  it('translates its project into a draft Lite will accept', () => {
    const draft = w().JourneySpacesFormat.projectToJourneyDraft(PROJECT);
    // Lite refuses a draft with no usable phase, so this is the exact
    // interop contract between the two codebases.
    const safe = sanitizeJourneyDraft(draft);
    expect(safe.phases.length).toBe(3);
    expect(safe.phases.map((p) => p.name)).toEqual(['Evaluate', 'Configure', 'Roll out']);
    expect(safe.phases[0]?.touchpoints[0]?.action).toBe('Reads the security whitepaper');
    expect(safe.phases[0]?.touchpoints[0]?.thought).toBe('Will this pass our review?');
    expect(safe.phases[1]?.touchpoints[0]?.agentOpportunity).toContain('SAML metadata');
    expect(safe.phases[0]?.touchpoints[0]?.emotion).toContain('Skeptical');
  });

  it('saves, and what lands in the Space is a real journey asset', async () => {
    attach();
    const saved = await w().SpacesClient.saveJourneyToSpace('s1', PROJECT);
    expect(saved.type).toBe('journey');

    const asset = space.assets.get(saved.id);
    expect(asset?.kind).toBe('journey');
    expect(asset?.title).toBe('Enterprise onboarding');
    expect((asset?.description ?? '').length).toBeGreaterThan(0);
  });

  it("the BUILDER writes Lite's stage grammar — the tile is its responsibility, not ours", () => {
    // The coupling nobody guards. The Builder's second write replaces
    // the body Lite generated, so for a Builder-authored journey Lite's
    // own `journeyToMarkdown` never survives to be rendered: the
    // headings the Spaces tile parses are the BUILDER's. Change
    // `projectToMarkdown` over there and every journey tile in Lite
    // goes flat, with nothing in this repo to catch it.
    const md = w().JourneySpacesFormat.projectToMarkdown(PROJECT);
    expect(md).toContain('## 1. Evaluate');
    expect(md).toContain('## 2. Configure');
    expect(md).toContain('## 3. Roll out');
  });

  it("LITE's own rendering still holds at the moment of create", async () => {
    // ...and the create step is where Lite's pipeline does show, both
    // for the brief window before the Builder's update and for every
    // journey the quick composer files. Asserted against what the
    // bridge actually stored, so a change to Lite's grammar fails here.
    attach();
    const draft = w().JourneySpacesFormat.projectToJourneyDraft(PROJECT);
    const created = (await (
      space.bridge as { save(s: string, d: unknown): Promise<{ ok: boolean; id: string }> }
    ).save('s1', draft)) as { ok: boolean; id: string };
    expect(created.ok).toBe(true);

    const asLiteWroteIt = space.assets.get(created.id);
    expect(asLiteWroteIt?.content).toContain('## 1. Evaluate');
    expect(asLiteWroteIt?.content).toContain('## 3. Roll out');
    expect(asLiteWroteIt?.description).toContain('phases');
  });

  it('the tile blurb comes from the BUILDER, and speaks a different dialect', async () => {
    attach();
    // Worth stating plainly, because it surprised this test: the second
    // write overwrites the description Lite generated. So for any
    // Builder-authored journey, `journeyDescription()` in Lite is dead
    // text — and the two halves name the same structure differently
    // ("stages"/"personas" there, "phases"/"touchpoints"/"agent
    // hand-offs" here). Not a bug; a vocabulary split a reader will
    // notice when a quick-composer journey sits next to a Builder one.
    const draft = w().JourneySpacesFormat.projectToJourneyDraft(PROJECT);
    expect(journeyDescription(sanitizeJourneyDraft(draft))).toContain('phases');

    const saved = await w().SpacesClient.saveJourneyToSpace('s1', PROJECT);
    const description = space.assets.get(saved.id)?.description ?? '';
    expect(description).toContain('stages');
    expect(description).toContain('persona');
    expect(description).not.toContain('phases');
  });

  it('the round-trip is LOSSLESS — ids, emoji levels, research and tickets all survive', async () => {
    attach();
    const saved = await w().SpacesClient.saveJourneyToSpace('s1', PROJECT);
    expect(saved.embedded, 'the project was not embedded — the round-trip is lossy').toBe(true);

    const asset = space.assets.get(saved.id);
    const recovered = w().JourneySpacesFormat.extractProjectData(asset?.content ?? '') as
      | typeof PROJECT
      | null;
    expect(recovered, 'nothing recoverable from the saved asset').not.toBeNull();

    // The things markdown alone cannot carry — the reason the embed exists.
    expect(recovered).toEqual(PROJECT);
    const stages = recovered?.journeyData.personas[0]?.journeys[0]?.stages ?? [];
    expect(stages.map((s) => s.id)).toEqual(['stage-1', 'stage-2', 'stage-3']);
    expect(stages[1]?.sections.emotion.emoji).toEqual({ emoji: '😬', level: 4 });
    expect(stages[1]?.tickets[0]?.id).toBe('TICK-2');
    expect(recovered?.research[0]?.note).toContain('SSO is the whole decision');
  });

  it('a second save EDITS the asset instead of littering the Space with copies', async () => {
    attach();
    const first = await w().SpacesClient.saveJourneyToSpace('s1', PROJECT);
    const second = await w().SpacesClient.saveJourneyToSpace('s1', PROJECT);
    expect(second.id).toBe(first.id);
    expect(space.assets.size, 'a re-save created a duplicate journey').toBe(1);
  });

  it('an edit made in the Builder reaches the asset Lite reads', async () => {
    attach();
    const saved = await w().SpacesClient.saveJourneyToSpace('s1', PROJECT);
    const edited = structuredClone(PROJECT);
    const stage = edited.journeyData.personas[0]?.journeys[0]?.stages[2];
    if (stage === undefined) throw new Error('fixture shape changed');
    stage.name = 'Expand';
    stage.sections.touchpoints.items = ['Rolls out to a second business unit'];

    await w().SpacesClient.saveJourneyToSpace('s1', edited, saved.id);
    const asset = space.assets.get(saved.id);
    expect(asset?.content).toContain('## 3. Expand');
    expect(asset?.content).not.toContain('## 3. Roll out');
    const recovered = w().JourneySpacesFormat.extractProjectData(asset?.content ?? '') as
      | typeof PROJECT
      | null;
    expect(
      recovered?.journeyData.personas[0]?.journeys[0]?.stages[2]?.sections.touchpoints.items
    ).toEqual(['Rolls out to a second business unit']);
  });

  it('a rejected body write recovers instead of leaving a stripped journey behind', async () => {
    attach();
    space.failNextUpdate = true;
    const saved = await w().SpacesClient.saveJourneyToSpace('s1', PROJECT);
    // The fallback re-creates rather than reporting failure. The cost is
    // a second asset in the Space — worth knowing, and better than a
    // journey that silently lost its project.
    const asset = space.assets.get(saved.id);
    expect(w().JourneySpacesFormat.extractProjectData(asset?.content ?? '')).not.toBeNull();
    expect(space.assets.size, 'the recovery path left an orphan copy').toBeLessThanOrEqual(2);
  });

  it('refuses a project with no named stage rather than filing an empty map', async () => {
    attach();
    const empty = { metadata: { projectName: 'Nothing yet' }, journeyData: { personas: [] } };
    await expect(w().SpacesClient.saveJourneyToSpace('s1', empty)).rejects.toThrow(/stage/i);
    expect(space.assets.size).toBe(0);
  });

  it('says so, rather than lying, when a project is too big to embed', async () => {
    attach();
    const huge = structuredClone(PROJECT);
    // Past the module's own content budget, the embed is dropped whole —
    // never truncated into unparseable JSON.
    huge.research = Array.from({ length: 4000 }, (_, i) => ({
      id: `res-${i}`,
      kind: 'interview',
      note: 'x'.repeat(60),
    }));
    const md = w().JourneySpacesFormat.projectToMarkdown(huge);
    const embed = w().JourneySpacesFormat.embedProjectData(md, huge);
    expect(embed.embedded).toBe(false);
    expect(w().JourneySpacesFormat.extractProjectData(embed.content)).toBeNull();
    // And the caller is TOLD, so the Builder can warn instead of
    // pretending the save was faithful.
    const saved = await w().SpacesClient.saveJourneyToSpace('s1', huge);
    expect(saved.embedded).toBe(false);
  });

  it('still cannot write anything but journeys through the bridge', async () => {
    attach();
    // The blast radius, asserted from the Builder's side: even its own
    // playbook companion is refused in-app.
    await expect(
      w().SpacesClient.savePlaybookToSpace('s1', { title: 'P', version: 'v1', content: '# P' })
    ).rejects.toThrow(/not written from here/i);
    expect(space.assets.size).toBe(0);
  });

  it('finds the journeys it saved, through the bridge', async () => {
    attach();
    await w().SpacesClient.saveJourneyToSpace('s1', PROJECT);
    const hits = await w().SpacesClient.search('enterprise');
    expect(hits.map((h) => h.title)).toEqual(['Enterprise onboarding']);
  });
});

describe.skipIf(sources !== null)('the Journey Map Builder', () => {
  it('could not be loaded — the round-trip was not verified', () => {
    console.log(`  ↳ skipped: ${loadError}`);
    expect(sources).toBeNull();
  });
});
