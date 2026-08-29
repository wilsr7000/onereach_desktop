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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AiService } from '../../ai/service.js';
import {
  JOURNEY_SYSTEM_PROMPT,
  sanitizeJourneyDraft,
  journeyToMarkdown,
  journeyDescription,
  extractJsonObject,
} from '../../spaces/journey.js';
import type { JourneyDraft } from '../../spaces/types.js';
import {
  resolveAppClaudeConfig,
  readAppSettingsAiKey,
  describeAiCredentials,
} from '../harness/ai-key.js';

const credentials = await resolveAppClaudeConfig();

/**
 * The output cap `journeys.draft` really sends, READ FROM THE APP rather
 * than copied. This mattered twice: at 2000 the model's answer is cut
 * off mid-JSON (the bug this file first caught), and a copied constant
 * silently drifts back to the wrong value the moment someone edits one
 * side — which is exactly what happened to an earlier version of this
 * test.
 */
const APP_MAX_TOKENS = ((): number => {
  const src = readFileSync(resolve(__dirname, '..', '..', 'spaces', 'main.ts'), 'utf8');
  const m = /maxTokens:\s*(\d+),\s*\n\s*feature: 'spaces-journey-draft'/.exec(src);
  if (m?.[1] === undefined) throw new Error('could not read the journey draft maxTokens');
  return Number(m[1]);
})();

/** The corrective nudge `journeys.draft` sends on a second attempt. */
const CORRECTIVE =
  'Your previous reply was not parseable JSON. Return ONLY the JSON object — no prose, no code fences.';

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
  /** How many model calls the app would have spent to get a usable draft. */
  attempts: number;
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

    // Mirror `journeys.draft` exactly: ask, SALVAGE the reply with the
    // app's own `extractJsonObject` (which pulls JSON out of fences and
    // prose), and on failure retry ONCE with the corrective nudge. A
    // bare JSON.parse here would fail the build on replies the app
    // recovers from perfectly — testing a stricter contract than ships.
    const ask = async (corrective: boolean): Promise<{ raw: string; model: string }> => {
      const result = await service.chat({
        system: JOURNEY_SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: SUBJECT },
          ...(corrective ? [{ role: 'user' as const, content: CORRECTIVE }] : []),
        ],
        jsonMode: true,
        maxTokens: APP_MAX_TOKENS,
        feature: 'spaces-journey-draft',
      });
      return { raw: result.content, model: result.model };
    };

    let attempts = 1;
    let reply = await ask(false);
    let parsed = extractJsonObject(reply.raw);
    if (parsed === null) {
      attempts = 2;
      reply = await ask(true);
      parsed = extractJsonObject(reply.raw);
    }

    const draft = sanitizeJourneyDraft(parsed);
    run = {
      raw: reply.raw,
      parsed,
      draft,
      markdown: journeyToMarkdown(draft),
      model: reply.model,
      attempts,
    };
  }, 240_000);

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

  it('is given room to finish — the answer is not cut off mid-JSON', () => {
    // The failure this file first caught, and then lost: at maxTokens
    // 2000 a realistic subject came back truncated mid-string, salvage
    // found nothing, the retry truncated identically, and the user was
    // told to rephrase a subject that was never the problem. The cap is
    // read from the app so the two cannot drift apart again.
    expect(
      APP_MAX_TOKENS,
      'journeys.draft cannot fit the journey its own prompt asks for'
    ).toBeGreaterThanOrEqual(4000);
    expect(
      run.raw.trimEnd().endsWith('}'),
      `reply ends: ${JSON.stringify(run.raw.slice(-80))}`
    ).toBe(true);
  });

  it('yields JSON the composer can use — the entire contract', () => {
    // Asserted through the app's own salvage, because that is what the
    // user's draft actually depends on.
    expect(run.parsed, `nothing salvageable from:\n${run.raw.slice(0, 400)}`).not.toBeNull();
    expect(typeof run.parsed).toBe('object');
  });

  it('gets there first time, without needing the corrective retry', () => {
    // Not fatal — the app recovers — but a retry means a doubled wait
    // and doubled spend on every draft. If this starts failing, the
    // prompt has drifted even though the feature still "works".
    expect(run.attempts, 'the model needed a corrective nudge to return JSON').toBe(1);
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
