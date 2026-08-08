/**
 * UI-automation agents -- named, describable, invokable wrappers
 * around taught templates.
 *
 * The UX (ADR-054): the user records a walkthrough and gives it a NAME
 * ("open-designer"). The system -- not the user -- writes the agent's
 * title, description, and per-param descriptions from the recording,
 * generalizing content-specific literals into `{params}` in the same
 * LLM call. The agent is then callable BY NAME with free-form
 * `details` text: a second, cheap LLM call maps the caller's details
 * onto the template's params using those descriptions
 * ("open the billing bot flow" -> { flowName: "Billing Bot" }).
 *
 * Deterministic floors everywhere (this module must work signed-out /
 * keyless):
 *   - No AI at creation -> title from the slug, generic description,
 *     params scanned from `{placeholders}` with empty descriptions.
 *   - No AI at invocation -> callers pass structured `params` and skip
 *     `details`; missing params fail loudly with the param list.
 *
 * Electron-free; the chat seam is injected. `store.ts` orchestrates;
 * Spaces publication (the "GSX Build" core Space) is a seam wired in
 * `main.ts` so this file never imports the spaces module.
 *
 * @internal -- surfaced via `api.ts`.
 */

import type { AiChatInput } from '../ai/chat.js';
import type { GsxAgent, GsxAgentParam, GsxScript } from './types.js';
import type { GsxRecordedEvent } from './recorder.js';
import { validateScript } from './runner.js';
import { GsxError, GSX_ERROR_CODES } from './errors.js';

/** Callable-name contract: lowercase slug, 2..64 chars. */
export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** Params substituted by the runtime, never asked of the caller. */
const BUILTIN_PARAMS = new Set(['accountId', 'env']);

/** Validate an agent name or throw `GSX_INVALID_AGENT_NAME`. */
export function requireValidAgentName(name: unknown): string {
  if (typeof name !== 'string' || !AGENT_NAME_PATTERN.test(name)) {
    throw new GsxError({
      code: GSX_ERROR_CODES.INVALID_AGENT_NAME,
      message: `Agent name must match ${AGENT_NAME_PATTERN} (got ${JSON.stringify(name).slice(0, 60)})`,
      remediation: 'Use a lowercase slug like "open-designer".',
    });
  }
  return name;
}

/** Collect the `{param}` names a script's steps reference (minus built-ins). */
export function scanScriptParams(script: GsxScript): string[] {
  const found = new Set<string>();
  const scan = (value: string): void => {
    for (const match of value.matchAll(/\{([a-zA-Z0-9_-]+)\}/g)) {
      const name = match[1];
      if (name !== undefined && !BUILTIN_PARAMS.has(name)) found.add(name);
    }
  };
  for (const step of script.steps) {
    switch (step.kind) {
      case 'navigate':
        scan(step.url);
        break;
      case 'waitFor':
      case 'assertVisible':
        scan(step.selector);
        break;
      case 'click':
        scan(step.selector);
        for (const t of step.textFallback ?? []) scan(t);
        break;
      case 'fill':
        scan(step.selector);
        scan(step.value);
        break;
      case 'assertUrl':
        scan(step.pattern);
        break;
      case 'assertText':
        scan(step.selector);
        scan(step.text);
        break;
      case 'wait':
        break;
    }
  }
  return [...found].sort();
}

/** "open-designer" -> "Open Designer" (deterministic title fallback). */
export function titleFromAgentName(name: string): string {
  return name
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Deterministic agent metadata when no AI is available: the agent
 * still exists and is invokable with structured params.
 */
export function fallbackAgentMeta(
  name: string,
  script: GsxScript
): { title: string; description: string; params: GsxAgentParam[] } {
  return {
    title: titleFromAgentName(name),
    description: `Recorded GSX walkthrough saved as agent "${name}". Replays ${script.steps.length} steps.`,
    params: scanScriptParams(script).map((p) => ({ name: p, description: '' })),
  };
}

// ─── creation: one LLM call describes AND generalizes ───────────────────

const AGENT_CREATE_SYSTEM_PROMPT = `You turn a RECORDED UI navigation (one concrete walkthrough of the OneReach GSX studio web app) into a named UI-AUTOMATION AGENT: a reusable template script plus the metadata that makes it callable by other software.

A script is a JSON array of steps. The ONLY legal step shapes are:
  {"kind":"navigate","url":string}
  {"kind":"waitFor","selector":string,"timeoutMs"?:number}
  {"kind":"click","selector":string,"textFallback"?:string[],"timeoutMs"?:number}
  {"kind":"fill","selector":string,"value":string,"timeoutMs"?:number}
  {"kind":"assertVisible","selector":string,"description"?:string,"timeoutMs"?:number}
  {"kind":"assertUrl","pattern":string,"description"?:string}
  {"kind":"assertText","selector":string,"text":string,"description"?:string,"timeoutMs"?:number}
  {"kind":"wait","ms":number}

Your job:
1. DESCRIBE: write a one-line title and a 1-3 sentence description of what this walkthrough accomplishes, from the user's stated intent and the recorded actions. Write for a caller deciding whether to invoke this agent.
2. GENERALIZE: replace content-specific literals (the particular item clicked, the text typed) with {param} placeholders named from the elements' labels. Structural clicks (menus, tabs, "Create"/"Save" buttons) stay literal. Keep {accountId} and {env} exactly as they appear.
3. DOCUMENT PARAMS: for every {param} you introduce, write a one-line description of what the caller should pass ("The display name of the flow to open, as shown in the Flows list"). These descriptions are later used to EXTRACT param values from a caller's free-form request -- write them so that mapping is unambiguous.
4. HARDEN + EVALUATE: prefer stable selectors from the recording's candidates; keep or strengthen the final assertion(s) so the script verifies its end state. Maximum 50 steps.

Respond with ONLY a JSON object:
{"title": string, "description": string, "steps": [...], "params": [{"name": string, "description": string}], "note": string}`;

/** Build the create-agent chat input. Exported for tests. */
export function buildAgentCreateInput(
  base: GsxScript,
  events: GsxRecordedEvent[],
  name: string,
  hint?: string
): AiChatInput {
  const labels = events
    .filter((e) => e.type !== 'navigate')
    .map((e, i) => {
      const what = e.type === 'fill' ? `typed "${e.value ?? ''}"` : 'clicked';
      const label = e.label !== undefined && e.label.length > 0 ? ` label="${e.label}"` : '';
      const text = e.text !== undefined && e.text.length > 0 ? ` text="${e.text}"` : '';
      const alts =
        e.candidates !== undefined && e.candidates.length > 1
          ? ` altSelectors=${JSON.stringify(e.candidates.slice(1))}`
          : '';
      return `- action ${i}: ${what} <${e.tag ?? '?'}>${label}${text}${alts}`;
    })
    .join('\n');
  const user = [
    `Agent name (callable slug): "${name}"`,
    hint !== undefined && hint.length > 0 ? `User's hint about intent: ${hint}` : '',
    '',
    'Recorded steps (deterministic, one concrete walkthrough):',
    JSON.stringify(base.steps, null, 2),
    '',
    'Element context for each recorded action (labels are your best source for param names and descriptions):',
    labels.length > 0 ? labels : '- (no element context captured)',
    '',
    'Return the agent definition.',
  ]
    .filter((line) => line !== '')
    .join('\n');
  return {
    system: AGENT_CREATE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: user }],
    jsonMode: true,
    maxTokens: 4096,
    feature: 'gsx-agent-create',
  };
}

/**
 * Parse + validate the model's agent definition. Throws
 * `GSX_REPAIR_FAILED` / `GSX_INVALID_SCRIPT` (callers fall back to
 * {@link fallbackAgentMeta} + the deterministic recording).
 */
export function parseAgentCreateResponse(
  content: string,
  base: GsxScript
): {
  script: GsxScript;
  title: string;
  description: string;
  params: GsxAgentParam[];
  note: string;
} {
  const fail = (why: string): never => {
    throw new GsxError({
      code: GSX_ERROR_CODES.REPAIR_FAILED,
      message: `AI agent-create response rejected: ${why}`,
      remediation: 'The deterministic recording was kept; the agent still works with structured params.',
      context: { scriptId: base.id },
    });
  };
  const start = content.indexOf('{');
  if (start === -1) fail('no JSON object in response');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, content.lastIndexOf('}') + 1));
  } catch {
    fail('response is not valid JSON');
  }
  const obj = parsed as {
    title?: unknown;
    description?: unknown;
    steps?: unknown;
    params?: unknown;
    note?: unknown;
  };
  if (!Array.isArray(obj.steps)) fail('missing steps array');
  const params: GsxAgentParam[] = Array.isArray(obj.params)
    ? (obj.params as unknown[])
        .map((p): GsxAgentParam | null => {
          if (typeof p !== 'object' || p === null) return null;
          const entry = p as Record<string, unknown>;
          if (typeof entry.name !== 'string' || entry.name.length === 0) return null;
          return {
            name: entry.name.slice(0, 60),
            description:
              typeof entry.description === 'string' ? entry.description.slice(0, 300) : '',
          };
        })
        .filter((p): p is GsxAgentParam => p !== null)
        .slice(0, 10)
    : [];
  const candidate: GsxScript = {
    ...base,
    ...(params.length > 0 ? { params: params.map((p) => p.name) } : {}),
    steps: obj.steps as GsxScript['steps'],
  };
  validateScript(candidate);
  return {
    script: candidate,
    title:
      typeof obj.title === 'string' && obj.title.trim().length > 0
        ? obj.title.trim().slice(0, 120)
        : titleFromAgentName(base.id.replace(/^agent\./, '')),
    description:
      typeof obj.description === 'string' && obj.description.trim().length > 0
        ? obj.description.trim().slice(0, 1000)
        : '',
    params,
    note: typeof obj.note === 'string' ? obj.note.slice(0, 300) : '',
  };
}

// ─── invocation: extract params from the caller's details ───────────────

const EXTRACT_SYSTEM_PROMPT = `You extract parameter values for a UI-automation agent from a caller's free-form request.

You are given the agent's description, its parameter list (each with a description of what the value means), and the caller's request text. Map the request onto the parameters.

Rules:
- Extract a value ONLY when the request actually contains or clearly implies it. Never invent values.
- Values are plain strings, exactly as they should appear in the UI (e.g. the flow's display name).
- A parameter with no confident value goes in "missing".

Respond with ONLY a JSON object: {"params": {"<name>": "<value>", ...}, "missing": ["<name>", ...]}`;

/** Build the param-extraction chat input. Exported for tests. */
export function buildParamExtractionInput(
  agent: GsxAgent,
  needed: string[],
  details: string
): AiChatInput {
  const paramDocs = needed
    .map((name) => {
      const doc = agent.params.find((p) => p.name === name)?.description ?? '';
      return `- ${name}: ${doc.length > 0 ? doc : '(no description)'}`;
    })
    .join('\n');
  const user = [
    `Agent: "${agent.title}" -- ${agent.description}`,
    '',
    'Parameters to fill:',
    paramDocs,
    '',
    `Caller's request: ${details.slice(0, 2000)}`,
  ].join('\n');
  return {
    system: EXTRACT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: user }],
    jsonMode: true,
    maxTokens: 1024,
    feature: 'gsx-agent-extract',
  };
}

/** Parse the extraction response (lenient: garbage -> everything missing). */
export function parseParamExtractionResponse(
  content: string,
  needed: string[]
): { params: Record<string, string>; missing: string[] } {
  const empty = { params: {}, missing: [...needed] };
  const start = content.indexOf('{');
  if (start === -1) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, content.lastIndexOf('}') + 1));
  } catch {
    return empty;
  }
  const obj = parsed as { params?: unknown };
  if (typeof obj.params !== 'object' || obj.params === null) return empty;
  const params: Record<string, string> = {};
  for (const name of needed) {
    const value = (obj.params as Record<string, unknown>)[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      params[name] = value.trim().slice(0, 500);
    }
  }
  const missing = needed.filter((name) => !(name in params));
  return { params, missing };
}

// ─── Spaces publication (OKF) ───────────────────────────────────────────

/**
 * Render the agent as OKF (structured YAML/MD) for the "GSX Build"
 * Space -- the shareable, human-reviewable definition of what this
 * agent does and how to call it.
 */
export function buildAgentOkf(agent: GsxAgent, script: GsxScript): string {
  const params =
    agent.params.length > 0
      ? agent.params
          .map((p) => `  - name: ${p.name}\n    description: ${p.description || '(undocumented)'}`)
          .join('\n')
      : '  []';
  return [
    '---',
    `name: ${agent.name}`,
    `title: ${agent.title}`,
    'kind: ui-automation-agent',
    'surface: gsx-studio',
    `scriptId: ${agent.scriptId}`,
    `scriptVersion: ${script.version}`,
    'params:',
    params,
    `createdAt: ${agent.createdAt}`,
    '---',
    '',
    `# ${agent.title}`,
    '',
    agent.description,
    '',
    '## Invocation',
    '',
    'Callable by name through the Onereach Lite GSX automation API:',
    '',
    '```js',
    `await window.lite.gsx.invokeAgent('${agent.name}', {`,
    "  details: '<free-form request -- params are extracted automatically>',",
    '  // or pass structured params directly:',
    `  // params: { ${agent.params.map((p) => `${p.name}: '...'`).join(', ')} },`,
    '});',
    '```',
    '',
    '## Behavior',
    '',
    `Replays a taught ${script.steps.length}-step GSX walkthrough (script \`${agent.scriptId}\` v${script.version}) inside an authenticated GSX window. Runs are graded against the script's own assertions; failing runs are AI-repaired and successful repairs become the new template version. Taught with the Lite teach-mode recorder.`,
    '',
  ].join('\n');
}
