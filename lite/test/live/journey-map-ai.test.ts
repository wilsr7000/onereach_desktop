/**
 * The journey-map prompt, against the real model, on the app's own key.
 *
 * Everything else about journeys is tested against a stub: the sanitizer
 * assumes the model returns junk, the serializer assumes the sanitizer
 * did its job. What no stub can tell us is whether
 * `JOURNEY_SYSTEM_PROMPT` still gets a usable answer out of the model the
 * app is actually configured with — a prompt is a contract with a system
 * nobody in this repo controls, and it can rot without a line of our
 * code changing.
 *
 * The key comes from Settings → AI (see `harness/ai-key.ts`), so this
 * runs against the same credentials the user's app runs on. No key
 * configured anywhere → the suite skips with an explanation rather than
 * failing; a live model call is not something to fake.
 *
 * Deliberately OUT of `lite:test` (the PR gate): it costs money, needs
 * the network, and a model is not deterministic. Run it with
 * `npm run lite:test:live`.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { AiService } from '../../ai/service.js';
import {
  JOURNEY_SYSTEM_PROMPT,
  sanitizeJourneyDraft,
  journeyToMarkdown,
  journeyDescription,
} from '../../spaces/journey.js';
import type { JourneyDraft } from '../../spaces/types.js';
import {
  resolveAppClaudeConfig,
  readAppSettingsAiKey,
  describeAiCredentials,
} from '../harness/ai-key.js';

const credentials = await resolveAppClaudeConfig();

/** The subject under test — concrete, so "be specific" is checkable. */
const SUBJECT =
  'A support engineer at a mid-size SaaS company handling an escalated ' +
  'outage ticket, from the first alert through to the customer follow-up.';

interface LiveRun {
  raw: string;
  parsed: unknown;
  draft: JourneyDraft;
  markdown: string;
  model: string;
}

let run: LiveRun;

describe.skipIf(credentials === null)('the journey prompt against the live model', () => {
  beforeAll(async () => {
    if (credentials === null) return;
    // Built exactly the way `ai/api.ts` builds it for the app — same
    // service, same resolved config, minus the Electron logger.
    const service = new AiService({
      loadConfig: () => credentials.config,
      fetchImpl: globalThis.fetch.bind(globalThis),
      accountId: () => null,
    });

    const result = await service.chat({
      system: JOURNEY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: SUBJECT }],
      jsonMode: true,
      maxTokens: 2000,
      feature: 'spaces-journey-draft',
    });

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(result.content);
    } catch {
      parsed = null;
    }
    run = {
      raw: result.content,
      parsed,
      draft: sanitizeJourneyDraft(parsed),
      markdown: journeyToMarkdown(sanitizeJourneyDraft(parsed)),
      model: result.model,
    };
  }, 120_000);

  it('runs on the key the app is configured with, not one invented by the suite', async () => {
    // The assertion that gives this whole file its meaning. Written so
    // it holds on any machine: wherever a key sits in Settings → AI,
    // that is the key that must have been used — an env var in the
    // developer's shell must not quietly win.
    const inAppSettings = await readAppSettingsAiKey();
    if (inAppSettings !== null) {
      expect(credentials?.source).toBe('app-settings-keychain');
    } else {
      expect(['env', 'ai-config.json']).toContain(credentials?.source);
    }
    console.log(`  ↳ ${describeAiCredentials(credentials)} · replied as ${run.model}`);
  });

  it('replies with JSON, which is the entire contract with the composer', () => {
    // `journeys.draft` does a bare JSON.parse and turns a failure into
    // "The AI reply was not valid JSON". If the model starts wrapping
    // its answer in prose or a fence, every journey draft breaks.
    expect(run.parsed, `model reply was not JSON:\n${run.raw.slice(0, 400)}`).not.toBeNull();
    expect(typeof run.parsed).toBe('object');
  });

  it('produces a journey the composer would accept', () => {
    // Zero phases is the other failure `journeys.draft` rejects outright.
    expect(run.draft.phases.length).toBeGreaterThan(0);
    expect(run.draft.title.length).toBeGreaterThan(0);
    expect(run.draft.journey.length).toBeGreaterThan(0);
  });

  it('honours the shape the prompt asks for: 3–6 phases, 1–4 touchpoints', () => {
    expect(run.draft.phases.length).toBeGreaterThanOrEqual(3);
    expect(run.draft.phases.length).toBeLessThanOrEqual(6);
    for (const phase of run.draft.phases) {
      expect(phase.name.length).toBeGreaterThan(0);
      expect(phase.touchpoints.length).toBeGreaterThanOrEqual(1);
      expect(phase.touchpoints.length).toBeLessThanOrEqual(4);
    }
  });

  it('gives every touchpoint a real agent opportunity — the product of the exercise', () => {
    const touchpoints = run.draft.phases.flatMap((p) => p.touchpoints);
    expect(touchpoints.length).toBeGreaterThan(0);
    const barren = touchpoints.filter((t) => t.agentOpportunity.trim().length === 0);
    expect(
      barren.map((t) => t.action),
      'the prompt says every touchpoint MUST carry an agentOpportunity'
    ).toEqual([]);
    // And the emotional read, which is what makes it a journey map
    // rather than a task list.
    expect(touchpoints.filter((t) => t.emotion.length > 0).length).toBeGreaterThan(0);
    expect(touchpoints.filter((t) => t.thought.length > 0).length).toBeGreaterThan(0);
  });

  it('rates delegation confidence inside the enum, without defaulting everything', () => {
    const confidences = run.draft.phases.flatMap((p) =>
      p.touchpoints.map((t) => t.delegationConfidence)
    );
    for (const c of confidences) expect(['High', 'Medium', 'Low']).toContain(c);
    // The sanitizer turns anything unrecognised into 'Medium'. An answer
    // that is ALL Medium is the signature of a model that stopped
    // emitting the field — passing shape, useless content.
    expect(new Set(confidences).size).toBeGreaterThan(1);
  });

  it('is about the subject it was asked about, not a generic template', () => {
    const text = JSON.stringify(run.draft).toLowerCase();
    const hits = ['outage', 'ticket', 'customer', 'escalat', 'alert', 'incident'].filter((w) =>
      text.includes(w)
    );
    expect(hits.length, `nothing subject-specific in:\n${text.slice(0, 400)}`).toBeGreaterThan(1);
  });

  it('serializes to the markdown the journey tile parses into stages', () => {
    // `## N. Name` is the grammar parsePlaybookSteps understands. A live
    // draft has to survive the same round-trip a stubbed one does.
    expect(run.markdown).toContain('## 1. ');
    expect(run.markdown).toContain(`## ${run.draft.phases.length}. `);
    expect(run.markdown).toContain('## Delegation points');
    expect(run.markdown).toContain('🤖 **Agent:**');
  });

  it('summarises its own shape for the tile', () => {
    const description = journeyDescription(run.draft);
    expect(description).toContain(`${run.draft.phases.length} phases`);
    expect(description).toContain('agent hand-offs');
  });
});

describe.skipIf(credentials !== null)('AI credentials', () => {
  it('are not configured — this tier needs a key in Settings → AI', () => {
    // eslint-disable-next-line no-console
    console.log(`  ↳ skipped: ${describeAiCredentials(null)}`);
    expect(credentials).toBeNull();
  });
});
