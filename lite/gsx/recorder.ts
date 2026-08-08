/**
 * Teach mode -- record the user's own navigation in a GSX window and
 * turn it into a reusable, PARAMETERIZED template script.
 *
 * The flow:
 *
 *   startRecording(windowId)
 *     -> inject {@link RECORDER_INSTALL_SCRIPT} (capture-phase click +
 *        change listeners buffering into `window.__gsxRecBuffer`)
 *     -> main polls {@link RECORDER_DRAIN_SCRIPT} every few hundred ms
 *        (GSX windows have NO preload by design -- ADR-038/052 -- so
 *        the page cannot push events to main; main pulls instead).
 *        Navigations wipe the page world, so the poll re-installs the
 *        recorder (idempotent) and synthesizes `navigate` events from
 *        URL changes it observes between drains.
 *   stopRecording(windowId, { scriptId, title, description })
 *     -> {@link buildStepsFromRecording}: recorded actions become
 *        deterministic steps (best selector + text fallback), literal
 *        account ids / env hosts are back-substituted to
 *        `{accountId}` / `{env}`, and a final `assertUrl` pins the
 *        destination so the recording self-evaluates.
 *     -> {@link generalizeRecording} (when the AI module is available):
 *        the LLM promotes content-specific literals (the flow name you
 *        clicked, the text you typed) to NAMED `{params}` using the
 *        elements' labels, and adds meaningful assertions -- turning
 *        "what I did once" into "a template that can click DIFFERENT
 *        elements". Falls back to the deterministic steps when AI is
 *        unavailable; the result is a normal `learned` script either
 *        way, subject to the same validation + eval loop as everything
 *        else.
 *
 * Electron-free: page scripts are string constants; execution and the
 * chat seam are injected. Everything here unit-tests offline.
 *
 * @internal -- orchestrated by `store.ts`; surfaced via `api.ts`.
 */

import type { AiChatInput } from '../ai/chat.js';
import type { Environment } from '../auth/types.js';
import type { GsxScript, GsxScriptStep } from './types.js';
import { validateScript } from './runner.js';
import { GsxError, GSX_ERROR_CODES } from './errors.js';
import type { GsxChatFn } from './repair.js';

/** One user action drained from the page (plus main-side navigations). */
export interface GsxRecordedEvent {
  type: 'click' | 'fill' | 'navigate';
  /** Ranked selector candidates (best first). Empty for navigate. */
  candidates?: string[];
  /** Visible text / accessible label of the element, when present. */
  text?: string;
  /** Nearby label: <label> text, aria-label, placeholder -- the human
   *  name of the control, used by the LLM to name params. */
  label?: string;
  tag?: string;
  /** Fill events only: the final value the user entered. */
  value?: string;
  /** Navigate events only: the URL observed after the change. */
  url?: string;
}

/** Hard cap on buffered + accumulated events per recording. */
export const GSX_MAX_RECORDED_EVENTS = 200;

/**
 * In-page recorder. Idempotent (a flag guards double-install; the poll
 * loop re-runs it after every navigation). Capture-phase listeners see
 * the click even when the app stops propagation. `change` (not
 * `input`) records the FINAL value of a field once the user leaves it.
 *
 * Selector candidate ranking mirrors what the runner resolves best:
 * data-testid > id > aria-label > name > data-* > tag.class. A short
 * nth-of-type path is the last resort.
 *
 * The buffer lives in sessionStorage (write-through on every event),
 * not a window variable: a click that triggers a navigation is written
 * synchronously in the capture handler and SURVIVES the page world
 * being torn down -- the next drain (after the poll re-installs the
 * recorder on the new page) still sees it. Cross-origin navigations
 * drop the buffer; studio flows stay same-origin.
 */
export const RECORDER_INSTALL_SCRIPT = `(function () {
  if (window.__gsxRecInstalled) return { installed: true, already: true };
  window.__gsxRecInstalled = true;
  var KEY = '__gsxRecBuffer';
  var MAX = ${GSX_MAX_RECORDED_EVENTS};

  function cssEscape(v) {
    return String(v).replace(/["\\\\]/g, '\\\\$&');
  }

  function candidatesFor(el) {
    var out = [];
    var testid = el.getAttribute('data-testid');
    if (testid) out.push('[data-testid="' + cssEscape(testid) + '"]');
    if (el.id) out.push('#' + el.id.replace(/([^a-zA-Z0-9_-])/g, '\\\\$1'));
    var aria = el.getAttribute('aria-label');
    if (aria) out.push(el.tagName.toLowerCase() + '[aria-label="' + cssEscape(aria) + '"]');
    var name = el.getAttribute('name');
    if (name) out.push(el.tagName.toLowerCase() + '[name="' + cssEscape(name) + '"]');
    for (var i = 0; i < el.attributes.length && out.length < 5; i++) {
      var a = el.attributes[i];
      if (a.name.indexOf('data-') === 0 && a.name !== 'data-testid' && a.value && a.value.length < 60) {
        out.push('[' + a.name + '="' + cssEscape(a.value) + '"]');
      }
    }
    if (out.length === 0 && el.classList.length > 0) {
      out.push(el.tagName.toLowerCase() + '.' + Array.prototype.join.call(el.classList, '.'));
    }
    if (out.length === 0) {
      // nth-of-type path, at most 4 hops -- brittle, but only a last resort.
      var path = [];
      var node = el;
      while (node && node.tagName && path.length < 4 && node !== document.body) {
        var tag = node.tagName.toLowerCase();
        var idx = 1;
        var sib = node;
        while ((sib = sib.previousElementSibling)) { if (sib.tagName === node.tagName) idx++; }
        path.unshift(tag + ':nth-of-type(' + idx + ')');
        node = node.parentElement;
      }
      if (path.length > 0) out.push(path.join(' > '));
    }
    return out.slice(0, 3);
  }

  function labelFor(el) {
    var aria = el.getAttribute('aria-label');
    if (aria) return aria;
    if (el.labels && el.labels.length > 0) {
      var t = (el.labels[0].textContent || '').trim();
      if (t) return t;
    }
    var placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder;
    var title = el.getAttribute('title');
    if (title) return title;
    return '';
  }

  function interactiveAncestor(el) {
    var node = el;
    while (node && node !== document.body) {
      var tag = node.tagName ? node.tagName.toLowerCase() : '';
      if (tag === 'a' || tag === 'button' || tag === 'input' || tag === 'select' ||
          tag === 'textarea' || tag === 'li' || node.getAttribute && (
            node.getAttribute('role') === 'button' || node.getAttribute('role') === 'tab' ||
            node.getAttribute('role') === 'menuitem' || node.getAttribute('role') === 'link' ||
            node.getAttribute('data-testid'))) {
        return node;
      }
      node = node.parentElement;
    }
    return el;
  }

  function push(entry) {
    try {
      var buf = [];
      try { buf = JSON.parse(sessionStorage.getItem(KEY) || '[]'); } catch (e) { buf = []; }
      if (!Array.isArray(buf)) buf = [];
      if (buf.length >= MAX) return;
      buf.push(entry);
      sessionStorage.setItem(KEY, JSON.stringify(buf));
    } catch (e) { /* storage unavailable -- drop rather than break the page */ }
  }

  document.addEventListener('click', function (ev) {
    try {
      var el = interactiveAncestor(ev.target);
      if (!el || !el.tagName) return;
      push({
        type: 'click',
        candidates: candidatesFor(el),
        text: (el.textContent || '').trim().slice(0, 80),
        label: labelFor(el).slice(0, 80),
        tag: el.tagName.toLowerCase()
      });
    } catch (e) { /* recording must never break the page */ }
  }, true);

  document.addEventListener('change', function (ev) {
    try {
      var el = ev.target;
      if (!el || !el.tagName) return;
      var tag = el.tagName.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;
      if (el.type === 'password') return; // never record secrets
      push({
        type: 'fill',
        candidates: candidatesFor(el),
        label: labelFor(el).slice(0, 80),
        tag: tag,
        value: String(el.value).slice(0, 200)
      });
    } catch (e) { /* recording must never break the page */ }
  }, true);

  return { installed: true };
})()`;

/** Drain-and-clear the page buffer. Resolves the pending events. */
export const RECORDER_DRAIN_SCRIPT = `(function () {
  var KEY = '__gsxRecBuffer';
  try {
    var buf = JSON.parse(sessionStorage.getItem(KEY) || '[]');
    sessionStorage.removeItem(KEY);
    return Array.isArray(buf) ? buf : [];
  } catch (e) {
    return [];
  }
})()`;

/**
 * Back-substitute run-time values into template placeholders so a
 * recording made against one account/env replays against any other:
 * the signed-in accountId becomes `{accountId}`, the studio host's env
 * segment becomes `{env}`.
 */
export function templatizeUrl(
  url: string,
  env: Environment,
  accountId: string | null
): string {
  let out = url;
  if (accountId !== null && accountId.length > 0) {
    out = out.split(accountId).join('{accountId}');
  }
  out = out.replace(
    new RegExp(`(https://[a-z0-9-]+\\.)${env}(\\.onereach\\.ai)`, 'g'),
    '$1{env}$2'
  );
  return out;
}

/** Escape a string for literal use inside a RegExp pattern. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert drained events into deterministic steps. Pure. The final
 * observed URL becomes a trailing `assertUrl` (on the templatized
 * pathname) so even an un-generalized recording self-evaluates.
 */
export function buildStepsFromRecording(
  events: GsxRecordedEvent[],
  opts: { env: Environment; accountId: string | null }
): GsxScriptStep[] {
  const steps: GsxScriptStep[] = [];
  let lastUrl: string | null = null;
  for (const event of events) {
    if (event.type === 'navigate') {
      if (event.url === undefined || event.url.length === 0) continue;
      lastUrl = event.url;
      steps.push({
        kind: 'navigate',
        url: templatizeUrl(event.url, opts.env, opts.accountId),
      });
      continue;
    }
    const selector = event.candidates?.[0];
    if (selector === undefined) continue;
    if (event.type === 'click') {
      const textFallback =
        event.text !== undefined && event.text.length > 0 && event.text.length <= 80
          ? [event.text]
          : undefined;
      steps.push({
        kind: 'click',
        selector,
        ...(textFallback !== undefined ? { textFallback } : {}),
      });
    } else {
      steps.push({ kind: 'fill', selector, value: event.value ?? '' });
    }
  }
  if (lastUrl !== null) {
    try {
      const parsed = new URL(lastUrl);
      const pattern = escapeRegExp(parsed.pathname === '/' ? parsed.hostname : parsed.pathname);
      if (pattern.length > 0) {
        steps.push({
          kind: 'assertUrl',
          pattern,
          description: 'Recording ended on this page',
        });
      }
    } catch {
      /* unparseable final URL -- skip the assertion */
    }
  }
  return steps;
}

const GENERALIZE_SYSTEM_PROMPT = `You convert a RECORDED UI navigation (one concrete walkthrough of the OneReach GSX studio web app) into a REUSABLE TEMPLATE script.

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
1. GENERALIZE: find the content-specific literals -- the particular item the user clicked (a flow name, a file name) and the text they typed -- and replace them with named {param} placeholders. Derive each param's name from the element's label or role (e.g. a click on the flow named "Billing Bot" becomes selector '[data-flow-name="{flowName}"]' with textFallback ["{flowName}"]). Structural clicks (menus, tabs, buttons like "Create" or "Save") stay literal.
2. Keep {accountId} and {env} placeholders exactly as they appear.
3. HARDEN: prefer stable selectors (data-testid, id, aria-label) from the recording's candidates; add a waitFor before interactions that follow a navigation.
4. EVALUATE: keep or improve the final assertion(s) so the script verifies it reached the intended end state. Every template must end with at least one assert step.
5. Maximum 50 steps.

Respond with ONLY a JSON object:
{"steps": [...], "params": ["flowName", ...], "note": "<one line: what was parameterized>"}`;

/** Build the generalization chat input. Exported for tests. */
export function buildGeneralizeInput(
  steps: GsxScriptStep[],
  events: GsxRecordedEvent[],
  meta: { scriptId: string; title: string; description: string }
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
    `Template id: "${meta.scriptId}" -- "${meta.title}"`,
    `What the user says this walkthrough does: ${meta.description}`,
    '',
    'Recorded steps (deterministic, one concrete walkthrough):',
    JSON.stringify(steps, null, 2),
    '',
    'Element context for each recorded action (labels are your best source for param names):',
    labels.length > 0 ? labels : '- (no element context captured)',
    '',
    'Return the generalized template.',
  ].join('\n');
  return {
    system: GENERALIZE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: user }],
    jsonMode: true,
    maxTokens: 4096,
    feature: 'gsx-teach',
  };
}

/**
 * Parse + validate the model's template. Throws `GSX_REPAIR_FAILED` /
 * `GSX_INVALID_SCRIPT` (callers fall back to the deterministic steps).
 */
export function parseGeneralizeResponse(
  content: string,
  base: GsxScript
): { script: GsxScript; note: string } {
  const fail = (why: string): never => {
    throw new GsxError({
      code: GSX_ERROR_CODES.REPAIR_FAILED,
      message: `AI generalization response rejected: ${why}`,
      remediation:
        'The deterministic recording was kept instead; edit the script by hand or re-record.',
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
  const obj = parsed as { steps?: unknown; params?: unknown; note?: unknown };
  if (!Array.isArray(obj.steps)) fail('missing steps array');
  const params = Array.isArray(obj.params)
    ? (obj.params as unknown[]).filter((p): p is string => typeof p === 'string').slice(0, 10)
    : [];
  const candidate: GsxScript = {
    ...base,
    ...(params.length > 0 ? { params } : {}),
    steps: obj.steps as GsxScriptStep[],
  };
  validateScript(candidate);
  return {
    script: candidate,
    note: typeof obj.note === 'string' ? obj.note.slice(0, 300) : '',
  };
}

/**
 * Full generalization round-trip: recorded steps -> LLM -> validated
 * parameterized template. Throws on model/parse failure -- the store
 * catches and keeps the deterministic recording.
 */
export async function generalizeRecording(
  chat: GsxChatFn,
  base: GsxScript,
  events: GsxRecordedEvent[]
): Promise<{ script: GsxScript; note: string }> {
  const result = await chat(
    buildGeneralizeInput(base.steps, events, {
      scriptId: base.id,
      title: base.title,
      description: base.description,
    })
  );
  return parseGeneralizeResponse(result.content, base);
}
