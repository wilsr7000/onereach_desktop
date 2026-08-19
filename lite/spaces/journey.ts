/**
 * ADR-072 — agent-enabled journey maps (Planning).
 *
 * Ported from the main app's WISER discovery template
 * (`templates/export/01-agent-journey-map.json`), where the feature was
 * a pair of placeholder IPC handlers holding journeys in an in-memory
 * `Map` — nothing persisted, nothing survived a relaunch. In Lite a
 * journey map is a first-class `journey` ASSET: the graph stores it,
 * the existing journey tile renders its stages as a flow, and version
 * history / "Viewed by" / download all apply with no extra work.
 *
 * This module is the pure half — the AI draft contract and the
 * markdown serializer. No Electron, no IPC: `spaces/main.ts` wires the
 * model call and the asset write around these functions, and the tests
 * exercise them directly.
 *
 * @internal
 */

import type {
  JourneyDraft,
  JourneyPhase,
  JourneyTouchpoint,
  JourneyConfidence,
  JourneySuggestions,
} from './types.js';

/**
 * The system prompt, carried over from the template's `systemPrompt` +
 * `prompt` so Lite's journeys read like the main app's. The JSON
 * contract is ours: the template rendered HTML from a loose example,
 * which is unparseable; Lite asks for structure and does its own
 * rendering (see {@link journeyToMarkdown}).
 */
export const JOURNEY_SYSTEM_PROMPT = [
  'You are an AI experience designer specializing in agent-human collaboration.',
  'Map the user journey and identify where AI agents can take work over —',
  'task delegation, automation, intelligent assistance — paying attention to',
  'trust-building moments and natural handoff points.',
  'Return ONLY a JSON object:',
  '{"title": string (<=120), "journey": string (<=200, whose journey and toward what),',
  '"phases": [{"name": string (<=60), "touchpoints": [{"action": string (<=200),',
  '"emotion": string (<=40, one word or short phrase), "thought": string (<=200,',
  "the person's inner monologue, first person), \"agentOpportunity\": string (<=240,",
  'what an agent could do here), "delegationConfidence": "High"|"Medium"|"Low"}]}]}.',
  'HARD RULES: 3–6 phases, 1–4 touchpoints each. Every touchpoint MUST carry a',
  'real agentOpportunity — if an agent genuinely cannot help at a step, say what',
  'it could prepare or verify instead. Confidence is High only when the step is',
  'reversible and low-stakes. Be concrete about this journey, never generic.',
].join(' ');

const CONFIDENCES: readonly JourneyConfidence[] = ['High', 'Medium', 'Low'];

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function toConfidence(value: unknown): JourneyConfidence {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const hit = CONFIDENCES.find((c) => c.toLowerCase() === raw);
  // Unknown / missing reads as Medium: claiming High without evidence
  // would invite an unsafe hand-off, and Low would hide a real chance.
  return hit ?? 'Medium';
}

function sanitizeTouchpoint(raw: unknown): JourneyTouchpoint | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const action = str(r.action, 200);
  if (action.length === 0) return null; // a touchpoint IS its action
  return {
    action,
    emotion: str(r.emotion, 40),
    thought: str(r.thought, 200),
    agentOpportunity: str(r.agentOpportunity, 240),
    delegationConfidence: toConfidence(r.delegationConfidence),
  };
}

/** Caps mirroring the prompt's hard rules — the model is not trusted. */
const MAX_PHASES = 8;
const MAX_TOUCHPOINTS = 6;

/**
 * Coerce a model reply into a valid draft. Never throws: unusable
 * pieces are dropped, and the caller decides whether what remains is
 * worth showing (an empty `phases` means the reply was junk).
 */
export function sanitizeJourneyDraft(parsed: unknown): JourneyDraft {
  const record = (parsed ?? {}) as Record<string, unknown>;
  const phasesRaw = Array.isArray(record.phases) ? record.phases : [];
  const phases: JourneyPhase[] = [];
  for (const p of phasesRaw.slice(0, MAX_PHASES)) {
    const pr = (p ?? {}) as Record<string, unknown>;
    const name = str(pr.name, 60);
    if (name.length === 0) continue;
    const tps = Array.isArray(pr.touchpoints) ? pr.touchpoints : [];
    const touchpoints: JourneyTouchpoint[] = [];
    for (const t of tps.slice(0, MAX_TOUCHPOINTS)) {
      const tp = sanitizeTouchpoint(t);
      if (tp !== null) touchpoints.push(tp);
    }
    if (touchpoints.length === 0) continue; // a phase with no moments is noise
    phases.push({ name, touchpoints });
  }
  return {
    title: str(record.title, 120) || 'Journey map',
    journey: str(record.journey, 200),
    phases,
  };
}

/**
 * Serialize a journey to the markdown that becomes the asset's content.
 *
 * The phase headings are deliberately `## N. Name` — the SAME grammar
 * `parsePlaybookSteps` already understands, so the existing journey
 * tile picks the phases up as its left-to-right stage flow with no
 * renderer change. Touchpoints render as readable prose blocks rather
 * than a table: they carry quotes and long opportunity text, and tables
 * of that shape are unreadable in the detail pane.
 */
export function journeyToMarkdown(draft: JourneyDraft): string {
  const out: string[] = [];
  if (draft.journey.length > 0) out.push(`_${draft.journey}_`, '');
  draft.phases.forEach((phase, i) => {
    out.push(`## ${i + 1}. ${phase.name}`, '');
    for (const tp of phase.touchpoints) {
      out.push(`**${tp.action}**`);
      const feels: string[] = [];
      if (tp.emotion.length > 0) feels.push(`feels *${tp.emotion}*`);
      if (tp.thought.length > 0) feels.push(`thinks “${tp.thought}”`);
      if (feels.length > 0) out.push(`- ${feels.join(' · ')}`);
      if (tp.agentOpportunity.length > 0) {
        out.push(`- 🤖 **Agent:** ${tp.agentOpportunity} _(${tp.delegationConfidence} confidence)_`);
      }
      out.push('');
    }
  });
  // Delegation summary: the template's "delegation points" panel, as
  // the one place a reader can see every hand-off ranked by how safe
  // it is — the actual product of the exercise.
  const ranked = draft.phases
    .flatMap((p) => p.touchpoints.map((t) => ({ phase: p.name, t })))
    .filter((x) => x.t.agentOpportunity.length > 0)
    .sort(
      (a, b) =>
        CONFIDENCES.indexOf(a.t.delegationConfidence) -
        CONFIDENCES.indexOf(b.t.delegationConfidence)
    );
  if (ranked.length > 0) {
    out.push('## Delegation points', '');
    for (const { phase, t } of ranked) {
      out.push(`- **${t.delegationConfidence}** — ${t.agentOpportunity} _(${phase})_`);
    }
    out.push('');
  }
  return out.join('\n').trim();
}

/**
 * The one-line description stored on the asset: whose journey it is,
 * plus the shape, so the tile and search results read usefully without
 * opening the map.
 */
export function journeyDescription(draft: JourneyDraft): string {
  const moments = draft.phases.reduce((n, p) => n + p.touchpoints.length, 0);
  const delegations = draft.phases.reduce(
    (n, p) => n + p.touchpoints.filter((t) => t.agentOpportunity.length > 0).length,
    0
  );
  const shape = `${draft.phases.length} phases · ${moments} touchpoints · ${delegations} agent hand-offs`;
  return draft.journey.length > 0 ? `${draft.journey} — ${shape}` : shape;
}

// ─── Asset-grounded suggestions (2026-08-18) ────────────────────────────
// "Can it offer the user choices of objectives and journey ideas based
// on the space assets" — the composer opens with picks instead of a
// blank prompt. The digest is deliberately compact and the output is
// sanitized with hard caps: the model is not trusted.

export const JOURNEY_SUGGEST_SYSTEM_PROMPT = [
  'You are an AI experience designer. You will receive a digest of the',
  'assets inside a project Space (one line per asset: title, kind, gist).',
  'Propose journey-mapping work GROUNDED in those assets — never generic.',
  'Return ONLY a JSON object:',
  '{"objectives": [string (<=120), 3-4 items — outcomes this Space seems to',
  'be driving toward], "ideas": [{"title": string (<=80, a name for the map),',
  '"subject": string (<=160, phrased as WHOSE journey doing WHAT, e.g.',
  '"a new admin setting up their first agent"), "why": string (<=140,',
  'which assets in the digest ground this idea)}, 3-4 items]}.',
  'Every idea must trace to something in the digest. If the digest is too',
  'thin to ground anything, return {"objectives": [], "ideas": []}.',
].join(' ');

/** One asset line for the digest; every field defensively trimmed. */
export interface DigestibleAsset {
  title: string;
  kind: string;
  gist: string;
}

const DIGEST_MAX_ASSETS = 24;
const DIGEST_MAX_LINE = 160;
const DIGEST_MAX_TOTAL = 4000;

/** Compact, capped digest of a Space's assets for the suggest prompt. */
export function buildSpaceAssetDigest(assets: ReadonlyArray<DigestibleAsset>): string {
  const lines: string[] = [];
  let total = 0;
  for (const a of assets.slice(0, DIGEST_MAX_ASSETS)) {
    const title = str(a.title, 60);
    if (title.length === 0) continue;
    const line = `- ${title} (${str(a.kind, 16) || 'other'})${
      a.gist.trim().length > 0 ? `: ${str(a.gist, DIGEST_MAX_LINE - 24 - title.length)}` : ''
    }`.slice(0, DIGEST_MAX_LINE);
    if (total + line.length > DIGEST_MAX_TOTAL) break;
    total += line.length + 1;
    lines.push(line);
  }
  return lines.join('\n');
}

const MAX_SUGGESTIONS = 4;

/** Strict caps on the model's suggestions; empty results are valid. */
export function sanitizeJourneySuggestions(parsed: unknown): JourneySuggestions {
  const r = (parsed ?? {}) as Record<string, unknown>;
  const objectives: string[] = [];
  if (Array.isArray(r.objectives)) {
    for (const o of r.objectives) {
      const v = str(o, 120);
      if (v.length > 0 && !objectives.includes(v)) objectives.push(v);
      if (objectives.length >= MAX_SUGGESTIONS) break;
    }
  }
  const ideas: JourneySuggestions['ideas'] = [];
  if (Array.isArray(r.ideas)) {
    for (const raw of r.ideas) {
      const i = (raw ?? {}) as Record<string, unknown>;
      const subject = str(i.subject, 160);
      if (subject.length === 0) continue; // an idea IS its subject
      ideas.push({
        title: str(i.title, 80) || subject.slice(0, 80),
        subject,
        why: str(i.why, 140),
      });
      if (ideas.length >= MAX_SUGGESTIONS) break;
    }
  }
  return { objectives, ideas };
}

/**
 * Salvage a JSON object from a model reply (2026-08-18: "it just
 * errored and did not retry. Poorly formatted JSON. Should have fixed
 * itself"). Models occasionally wrap JSON in code fences or prose even
 * in json mode. Tries: direct parse → fence-stripped parse → first-{
 * to last-} slice parse. Returns null only when nothing parses; the
 * caller then retries the model once with a corrective nudge before
 * surfacing any error to the user.
 */
export function extractJsonObject(text: string): unknown | null {
  const attempts: string[] = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1] !== undefined) attempts.push(fenced[1]);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1));
  for (const candidate of attempts) {
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch {
      /* next attempt */
    }
  }
  return null;
}
