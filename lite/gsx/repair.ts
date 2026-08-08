/**
 * LLM script repair -- the "hybrid" half of the automation story.
 *
 * When a deterministic script fails against the live GSX UI, this
 * module builds a repair prompt from three evidence streams:
 *
 *   1. The failed script (steps as JSON)
 *   2. The graded run record (which step failed, with what detail)
 *   3. A live page snapshot (interactive elements + attrs)
 *
 * ...asks the AI module (Claude, main-process key -- see `lite/ai/`)
 * for a corrected steps array, and validates the response through the
 * same `validateScript` gate a human-authored script passes. The
 * OUTPUT is still a deterministic script: the LLM edits scripts, it
 * never free-drives the page. That keeps replay cheap (no model call
 * on the happy path) and every action auditable.
 *
 * Borrows the invalidation philosophy of `lib/autopilot-script-cache.js`
 * (script + assertions; failing assertions invalidate and regenerate).
 *
 * Electron-free and dependency-injected (the `chat` seam) so the
 * prompt/parse logic unit-tests offline.
 *
 * @internal -- orchestrated by `store.ts`; not part of the public API.
 */

import type { AiChatInput, AiChatResult } from '../ai/chat.js';
import type {
  GsxPageSnapshot,
  GsxRunRecord,
  GsxScript,
  GsxScriptStep,
} from './types.js';
import { validateScript } from './runner.js';
import { GsxError, GSX_ERROR_CODES } from './errors.js';

/** The one AI-module capability repair needs. */
export type GsxChatFn = (input: AiChatInput) => Promise<AiChatResult>;

const REPAIR_SYSTEM_PROMPT = `You repair UI automation scripts for the OneReach GSX studio web app.

A script is a JSON array of steps. The ONLY legal step shapes are:
  {"kind":"navigate","url":string}
  {"kind":"waitFor","selector":string,"timeoutMs"?:number}
  {"kind":"click","selector":string,"textFallback"?:string[],"timeoutMs"?:number}
  {"kind":"fill","selector":string,"value":string,"timeoutMs"?:number}
  {"kind":"assertVisible","selector":string,"description"?:string,"timeoutMs"?:number}
  {"kind":"assertUrl","pattern":string,"description"?:string}
  {"kind":"assertText","selector":string,"text":string,"description"?:string,"timeoutMs"?:number}
  {"kind":"wait","ms":number}

Rules:
- Keep the script's INTENT identical; change only what is needed to make it pass.
- Prefer selectors visible in the provided page snapshot (ids, data-* attributes, aria-label) over class-name guesses.
- Keep {param} placeholders (e.g. {accountId}, {env}, {flowName}) intact -- they are substituted at run time.
- Keep the assertions meaningful: they are the evaluation criteria for this script. Never delete an assertion just to make the script pass; adjust its selector/pattern to correctly detect success.
- Maximum 50 steps.

Respond with ONLY a JSON object: {"steps": [...], "note": "<one line on what you changed and why>"}`;

/** Trim a snapshot for prompt inclusion (defense-in-depth on size). */
function snapshotForPrompt(snapshot: GsxPageSnapshot): string {
  const elements = snapshot.elements.slice(0, 120);
  return JSON.stringify({ url: snapshot.url, title: snapshot.title, elements });
}

/**
 * Build the repair chat input. Exported for tests -- asserting on the
 * prompt content is how we pin the contract with the model.
 */
export function buildRepairInput(
  script: GsxScript,
  run: GsxRunRecord,
  snapshot: GsxPageSnapshot
): AiChatInput {
  const failedSteps = run.steps
    .filter((s) => !s.ok)
    .map((s) => `- step ${s.index} (${s.kind}): ${s.detail ?? 'failed'}`)
    .join('\n');
  const user = [
    `Script "${script.id}" v${script.version} ("${script.title}") failed.`,
    `Goal: ${script.description}`,
    '',
    'Current steps:',
    JSON.stringify(script.steps, null, 2),
    '',
    'Failed steps from the last run:',
    failedSteps.length > 0 ? failedSteps : '- (run aborted before any step failed cleanly)',
    run.failure !== undefined ? `First failure: ${run.failure}` : '',
    '',
    'Live page snapshot (interactive elements) at time of failure:',
    snapshotForPrompt(snapshot),
    '',
    'Return the corrected steps.',
  ]
    .filter((line) => line !== '')
    .join('\n');
  return {
    system: REPAIR_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: user }],
    jsonMode: true,
    maxTokens: 4096,
    feature: 'gsx-repair',
  };
}

/**
 * Parse + validate the model's response into a learned script variant.
 * Throws `GSX_REPAIR_FAILED` when the response doesn't contain a valid
 * steps array (the store records this and leaves the verdict as plain
 * `fail`).
 */
export function parseRepairResponse(
  content: string,
  original: GsxScript
): { script: GsxScript; note: string } {
  const fail = (why: string): never => {
    throw new GsxError({
      code: GSX_ERROR_CODES.REPAIR_FAILED,
      message: `AI repair response rejected: ${why}`,
      remediation:
        'The model returned an unusable script. Re-run to retry, or fix the seed script by hand.',
      context: { scriptId: original.id, version: original.version },
    });
  };
  // Tolerate fenced or prefixed output: parse from the first `{`.
  const start = content.indexOf('{');
  if (start === -1) fail('no JSON object in response');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, content.lastIndexOf('}') + 1));
  } catch {
    fail('response is not valid JSON');
  }
  const obj = parsed as { steps?: unknown; note?: unknown };
  if (!Array.isArray(obj.steps)) fail('missing steps array');
  const candidate: GsxScript = {
    ...original,
    version: original.version + 1,
    source: 'learned',
    steps: obj.steps as GsxScriptStep[],
  };
  validateScript(candidate); // throws GSX_INVALID_SCRIPT on bad steps
  return {
    script: candidate,
    note: typeof obj.note === 'string' ? obj.note.slice(0, 300) : '',
  };
}

/**
 * Full repair round-trip: prompt → model → validated learned variant.
 * Throws `GSX_AI_UNAVAILABLE` (propagated from the chat seam) or
 * `GSX_REPAIR_FAILED` / `GSX_INVALID_SCRIPT`.
 */
export async function repairScript(
  chat: GsxChatFn,
  script: GsxScript,
  run: GsxRunRecord,
  snapshot: GsxPageSnapshot
): Promise<{ script: GsxScript; note: string }> {
  const result = await chat(buildRepairInput(script, run, snapshot));
  return parseRepairResponse(result.content, script);
}
