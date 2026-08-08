/**
 * The Checklist Manifesto — the principles this app's checklists live
 * by, and the coach that holds drafts to them.
 *
 * The tradition here is aviation and surgical safety practice (as
 * popularized by Atul Gawande's writing): experts fail not because
 * they don't know, but because they skip. A good checklist is the
 * cheapest defense ever invented — IF it stays short, precise, and
 * anchored to a moment. The text below is original; the debt to that
 * tradition is acknowledged, not copied.
 *
 * Two consumers:
 *   - the editor's HELP drawer renders `CHECKLIST_MANIFESTO` verbatim
 *     (title / rule / why / good / bad per principle);
 *   - the live coach runs `lintChecklistDraft` on every edit and
 *     surfaces the top findings as gentle guidance — never blockers.
 *     The human always outranks the lint.
 *
 * Pure data + pure functions: no DOM, no Electron, no I/O.
 */

import type { ChecklistItemSpec } from './types.js';

// ─── The manifesto ──────────────────────────────────────────────────────

export interface ManifestoPrinciple {
  id: string;
  title: string;
  /** The rule, one line, imperative. */
  rule: string;
  /** Why it matters — the failure the rule prevents. */
  why: string;
  /** An item (or fragment) that follows the rule. */
  good: string;
  /** The same intent, written the way it usually goes wrong. */
  bad: string;
}

export const CHECKLIST_MANIFESTO: ReadonlyArray<ManifestoPrinciple> = [
  {
    id: 'short',
    title: 'Keep it lethal-short',
    rule: 'Five to nine items. A checklist is not a procedure manual.',
    why: 'Past nine items, people stop reading and start skimming — and a skimmed checklist protects nobody. Everything that is not a killer belongs in training, documentation, or a second checklist at its own pause point.',
    good: 'Verify the update feed serves the new version.',
    bad: 'A 23-item list covering the whole release process end to end.',
  },
  {
    id: 'killer',
    title: 'Mark the killer items',
    rule: 'Flag the steps that are most dangerous to skip and most often skipped.',
    why: 'Checklists exist because experts skip exactly these — the steps so routine they feel safe to blur past. Marking them tells the runner where blind trust in memory has burned people before.',
    good: '☠ Confirm the asar contains every boot-critical module.',
    bad: 'Treating "update the changelog" and "verify the build boots" as equals.',
  },
  {
    id: 'one-breath',
    title: 'One breath per item',
    rule: 'Verb first, one action, sayable in a single breath.',
    why: 'An item you must re-read is an item that gets half-done. If it needs a second sentence, the second sentence is context — put it behind "more", not in the line.',
    good: 'Run the full test gate.',
    bad: 'Handle the various pre-release quality considerations and make sure everything is generally in order before proceeding.',
  },
  {
    id: 'pause-point',
    title: 'Anchor it to a pause point',
    rule: 'Name the moment the world stops to run this — in words.',
    why: 'A checklist without a WHEN runs never or always. "Before merge", "before publish", "before the incision" — the pause point is what turns a list into a ritual.',
    good: 'Before publishing a release.',
    bad: 'Leaving the pause point blank because "people will know".',
  },
  {
    id: 'mode',
    title: 'Choose the mode deliberately',
    rule: 'DO-CONFIRM for experts working from memory; READ-DO for unfamiliar or high-stakes sequences.',
    why: 'DO-CONFIRM respects skill: work flows, then pause and confirm. READ-DO scripts the hands when order matters more than flow. Picking the wrong mode makes the checklist feel like bureaucracy — and ignored.',
    good: 'READ-DO for a data migration you run twice a year.',
    bad: 'READ-DO for the deploy you run nine times a day.',
  },
  {
    id: 'honest-optional',
    title: 'Optional means optional',
    rule: 'Nice-to-haves never gate. If skipping it is fine, say so in the structure.',
    why: 'The fastest way to teach a team to ignore a checklist is to block them on things that do not matter. Every dishonest "required" spends trust the killer items need.',
    good: 'Marking "attach screenshots" optional on a bug-triage list.',
    bad: 'Requiring items nobody actually treats as required.',
  },
  {
    id: 'living',
    title: 'Field-test, then revise',
    rule: 'A checklist is a living document — version it, and let real runs rewrite it.',
    why: 'First drafts encode how you imagine the work; runs reveal how it goes. An item everyone always skips is either a killer nobody respects yet, or dead weight. Both demand a revision.',
    good: 'v3 after two release cycles trimmed four items and added one killer.',
    bad: 'The laminated list nobody has touched since it was written.',
  },
  {
    id: 'serves',
    title: 'The checklist serves the expert',
    rule: 'It is an aid to judgment, never a replacement for it.',
    why: 'The point is to free attention for the hard parts by making the routine parts unskippable. The moment a checklist reads as compliance theater, it stops being read at all.',
    good: 'A pilot who still flies the plane.',
    bad: 'A form that exists so someone can say a form exists.',
  },
];

// ─── The coach ──────────────────────────────────────────────────────────

export type CoachSeverity = 'note' | 'warn';

export interface CoachFinding {
  /** Which principle this finding enforces. */
  principleId: string;
  severity: CoachSeverity;
  /** One gentle sentence — coaching, not scolding. */
  message: string;
}

/** The draft shape the coach inspects (a superset-tolerant view). */
export interface CoachableDraft {
  name?: string;
  pausePoint?: string;
  items: ReadonlyArray<Pick<ChecklistItemSpec, 'text' | 'killer' | 'optional'>>;
}

const VAGUE_OPENERS =
  /^(handle|manage|consider|think about|deal with|look into|review everything|check everything|make sure everything)\b/i;

/**
 * Hold a draft to the manifesto. Ordered most-important-first; the
 * editor shows the top few. Findings are guidance — saving is never
 * blocked, because the human outranks the lint (principle: 'serves').
 */
export function lintChecklistDraft(draft: CoachableDraft): CoachFinding[] {
  const findings: CoachFinding[] = [];
  const items = draft.items.filter((i) => (i.text ?? '').trim().length > 0);

  // pause-point — the anchor comes before everything else.
  if ((draft.pausePoint ?? '').trim().length === 0) {
    findings.push({
      principleId: 'pause-point',
      severity: 'warn',
      message: 'Name the pause point — WHEN does the world stop to run this?',
    });
  }

  // short — the count rules.
  if (items.length > 12) {
    findings.push({
      principleId: 'short',
      severity: 'warn',
      message: `${items.length} items is a procedure, not a checklist — split it, or cut everything that isn't a killer.`,
    });
  } else if (items.length > 9) {
    findings.push({
      principleId: 'short',
      severity: 'note',
      message: `${items.length} items — past nine, runners start skimming. Could any move behind "more" or into a second checklist?`,
    });
  }

  // killer — real lists deserve at least one.
  if (items.length >= 4 && !items.some((i) => i.killer === true)) {
    findings.push({
      principleId: 'killer',
      severity: 'note',
      message: 'No killer item marked — which of these is most dangerous to skip?',
    });
  }

  // one-breath — length and vague openers, first offender each.
  const long = items.find((i) => (i.text ?? '').trim().length > 90);
  if (long !== undefined) {
    findings.push({
      principleId: 'one-breath',
      severity: 'note',
      message: `"${(long.text ?? '').trim().slice(0, 40)}…" is longer than one breath — move the context behind "more".`,
    });
  }
  const vague = items.find((i) => VAGUE_OPENERS.test((i.text ?? '').trim()));
  if (vague !== undefined) {
    findings.push({
      principleId: 'one-breath',
      severity: 'warn',
      message: `"${(vague.text ?? '').trim().slice(0, 40)}" starts vague — what is the ONE action, verb first?`,
    });
  }

  // honest-optional — an all-optional list gates nothing.
  if (items.length > 0 && items.every((i) => i.optional === true)) {
    findings.push({
      principleId: 'honest-optional',
      severity: 'warn',
      message: 'Every item is optional — this list gates nothing. What must actually be true before proceeding?',
    });
  }

  // duplicates — one item, one line.
  const seen = new Set<string>();
  for (const item of items) {
    const key = (item.text ?? '').trim().toLowerCase();
    if (seen.has(key)) {
      findings.push({
        principleId: 'one-breath',
        severity: 'note',
        message: `"${key.slice(0, 40)}" appears twice — merge or differentiate.`,
      });
      break;
    }
    seen.add(key);
  }

  return findings;
}

/** The quiet all-clear line when a draft passes every check. */
export const COACH_ALL_CLEAR = 'Reads like a solid checklist — short, anchored, and honest.';
