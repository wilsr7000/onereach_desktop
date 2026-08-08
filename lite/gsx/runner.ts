/**
 * GSX script runner -- compiles deterministic steps to self-contained
 * in-page scripts and grades the outcome.
 *
 * Deliberately electron-free: the executor (a thin wrapper over a
 * `WebContentsView`/`BrowserWindow`'s webContents, built in
 * `window.ts`) is INJECTED, so every branch here unit-tests under
 * plain Node with a fake executor.
 *
 * Design lineage:
 *   - Selector-list + text-fallback click: `lite/auth/sso-skip.ts`.
 *   - Poll-until-timeout waits (Electron's `executeJavaScript`
 *     resolves returned Promises): `lite/auth/totp-autofill.ts`.
 *   - Ref-stamped interactive-element snapshot: `lib/browsing-api.js`
 *     (`_buildSnapshotScript`), simplified for repair prompts.
 *
 * @internal -- consumers go through `api.ts` (`runScript`).
 */

import {
  GSX_DEFAULT_STEP_TIMEOUT_MS,
  GSX_ASSERTION_KINDS,
  type GsxPageSnapshot,
  type GsxRunVerdict,
  type GsxScript,
  type GsxScriptStep,
  type GsxStepResult,
} from './types.js';
import { GsxError, GSX_ERROR_CODES } from './errors.js';

/**
 * What the runner needs from a live window. `exec` must resolve the
 * value the page script returns (Promises included).
 */
export interface GsxExecutor {
  exec(script: string, userGesture?: boolean): Promise<unknown>;
  navigate(url: string): Promise<void>;
  currentUrl(): string;
}

/** In-page result envelope every compiled step script resolves to. */
interface StepScriptResult {
  ok: boolean;
  detail?: string;
}

/**
 * Substitute `{param}` placeholders in every string field of a script's
 * steps. Unknown placeholders are left intact (they'll surface as
 * selector misses -- visible in the run record rather than silently
 * eaten). Returns a deep copy; never mutates the registered script.
 */
export function substituteParams(
  script: GsxScript,
  params: Record<string, string>
): GsxScript {
  const sub = (value: string): string =>
    value.replace(/\{([a-zA-Z0-9_-]+)\}/g, (whole, key: string) => {
      const replacement = params[key];
      return replacement !== undefined ? replacement : whole;
    });
  const steps = script.steps.map((step): GsxScriptStep => {
    switch (step.kind) {
      case 'navigate':
        return { ...step, url: sub(step.url) };
      case 'waitFor':
        return { ...step, selector: sub(step.selector) };
      case 'click':
        return {
          ...step,
          selector: sub(step.selector),
          ...(step.textFallback !== undefined
            ? { textFallback: step.textFallback.map(sub) }
            : {}),
        };
      case 'fill':
        return { ...step, selector: sub(step.selector), value: sub(step.value) };
      case 'assertVisible':
        return { ...step, selector: sub(step.selector) };
      case 'assertUrl':
        return { ...step, pattern: sub(step.pattern) };
      case 'assertText':
        return { ...step, selector: sub(step.selector), text: sub(step.text) };
      case 'wait':
        return { ...step };
    }
  });
  return { ...script, steps };
}

/**
 * Structural validation for scripts arriving from the bridge or from
 * the AI repair path. Throws `GSX_INVALID_SCRIPT` with the first
 * problem found; returns the (typed) script otherwise.
 */
export function validateScript(candidate: unknown): GsxScript {
  const fail = (why: string): never => {
    throw new GsxError({
      code: GSX_ERROR_CODES.INVALID_SCRIPT,
      message: `Invalid GSX script: ${why}`,
      remediation: 'Fix the script structure and try again.',
    });
  };
  if (typeof candidate !== 'object' || candidate === null) fail('not an object');
  const s = candidate as Record<string, unknown>;
  if (typeof s.id !== 'string' || s.id.trim().length === 0) fail('missing id');
  if (typeof s.title !== 'string' || s.title.trim().length === 0) fail('missing title');
  if (typeof s.description !== 'string') fail('missing description');
  if (typeof s.version !== 'number' || !Number.isInteger(s.version) || s.version < 1) {
    fail('version must be a positive integer');
  }
  if (s.source !== 'seed' && s.source !== 'learned') fail('source must be seed|learned');
  const steps: unknown = s.steps;
  if (!Array.isArray(steps) || steps.length === 0) fail('steps must be non-empty');
  if ((steps as unknown[]).length > 50) fail('steps exceeds the 50-step cap');
  const requireString = (v: unknown, field: string, index: number): void => {
    if (typeof v !== 'string' || v.length === 0) {
      fail(`step ${index}: ${field} must be a non-empty string`);
    }
  };
  (s.steps as unknown[]).forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null) fail(`step ${index}: not an object`);
    const step = raw as Record<string, unknown>;
    switch (step.kind) {
      case 'navigate':
        requireString(step.url, 'url', index);
        break;
      case 'waitFor':
      case 'assertVisible':
        requireString(step.selector, 'selector', index);
        break;
      case 'click':
        requireString(step.selector, 'selector', index);
        if (
          step.textFallback !== undefined &&
          (!Array.isArray(step.textFallback) ||
            step.textFallback.some((t) => typeof t !== 'string'))
        ) {
          fail(`step ${index}: textFallback must be a string array`);
        }
        break;
      case 'fill':
        requireString(step.selector, 'selector', index);
        if (typeof step.value !== 'string') fail(`step ${index}: value must be a string`);
        break;
      case 'assertUrl':
        requireString(step.pattern, 'pattern', index);
        try {
          new RegExp(step.pattern as string);
        } catch {
          fail(`step ${index}: pattern is not a valid regex`);
        }
        break;
      case 'assertText':
        requireString(step.selector, 'selector', index);
        requireString(step.text, 'text', index);
        break;
      case 'wait':
        if (typeof step.ms !== 'number' || step.ms < 0 || step.ms > 60_000) {
          fail(`step ${index}: ms must be 0..60000`);
        }
        break;
      default:
        fail(`step ${index}: unknown kind '${String(step.kind)}'`);
    }
  });
  return candidate as GsxScript;
}

/** JSON-embed a value inside a generated page script. */
function embed(value: unknown): string {
  // `<` escaping guards against `</script>`-style injection if a
  // selector ever contains it; harmless otherwise.
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Shared in-page helper: resolve a selector (with optional text
 * fallback over clickable elements), polling until found or timeout.
 * Compiled into each step script so every script stays self-contained
 * (no page-side state between steps).
 */
function findWithTimeoutJs(
  selector: string,
  textFallback: string[] | undefined,
  timeoutMs: number
): string {
  return `
  var SELECTOR = ${embed(selector)};
  var TEXTS = ${embed(textFallback ?? [])};
  var DEADLINE = Date.now() + ${Math.max(0, timeoutMs)};
  function findOnce() {
    try {
      var el = document.querySelector(SELECTOR);
      if (el) return { el: el, by: 'selector', match: SELECTOR };
    } catch (e) { return { bad: 'selector-invalid' }; }
    if (TEXTS.length > 0) {
      var candidates = document.querySelectorAll('button, a, [role="button"], [role="tab"], [role="menuitem"], li, span, div');
      for (var i = 0; i < candidates.length; i++) {
        var text = (candidates[i].textContent || '').trim();
        if (text.length === 0 || text.length > 80) continue;
        for (var j = 0; j < TEXTS.length; j++) {
          if (text === TEXTS[j] || text.toLowerCase() === TEXTS[j].toLowerCase()) {
            return { el: candidates[i], by: 'text', match: text };
          }
        }
      }
    }
    return null;
  }
  function waitFor(cb) {
    var first = findOnce();
    if (first && first.bad) { cb({ ok: false, detail: first.bad }); return; }
    if (first) { cb({ ok: true, hit: first }); return; }
    var timer = setInterval(function () {
      var hit = findOnce();
      if (hit && hit.bad) { clearInterval(timer); cb({ ok: false, detail: hit.bad }); return; }
      if (hit) { clearInterval(timer); cb({ ok: true, hit: hit }); return; }
      if (Date.now() > DEADLINE) { clearInterval(timer); cb({ ok: false, detail: 'timeout waiting for ' + SELECTOR }); }
    }, 100);
  }`;
}

/**
 * Compile one step into a self-contained page script resolving a
 * {@link StepScriptResult}. Exported for tests (the compiled strings
 * are asserted structurally, never eval'd in unit tests).
 */
export function compileStep(step: GsxScriptStep): string {
  const timeout =
    'timeoutMs' in step && typeof step.timeoutMs === 'number'
      ? step.timeoutMs
      : GSX_DEFAULT_STEP_TIMEOUT_MS;
  switch (step.kind) {
    case 'navigate':
      // Handled by the executor (main-side loadURL), never in-page.
      throw new GsxError({
        code: GSX_ERROR_CODES.INVALID_SCRIPT,
        message: 'navigate steps are executed by the runner, not compiled',
      });
    case 'wait':
      return `(function(){ return new Promise(function(resolve){ setTimeout(function(){ resolve({ ok: true }); }, ${Math.max(0, step.ms)}); }); })()`;
    case 'waitFor':
    case 'assertVisible':
      return `(function(){
  ${findWithTimeoutJs(step.selector, undefined, timeout)}
  return new Promise(function(resolve){
    waitFor(function(res){
      if (!res.ok) { resolve({ ok: false, detail: res.detail }); return; }
      var el = res.hit.el;
      var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 1, height: 1 };
      var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
      var visible = rect.width > 0 && rect.height > 0 && (!style || (style.display !== 'none' && style.visibility !== 'hidden'));
      resolve(visible ? { ok: true, detail: res.hit.match } : { ok: false, detail: 'found but not visible: ' + res.hit.match });
    });
  });
})()`;
    case 'click':
      return `(function(){
  ${findWithTimeoutJs(step.selector, step.textFallback, timeout)}
  return new Promise(function(resolve){
    waitFor(function(res){
      if (!res.ok) { resolve({ ok: false, detail: res.detail }); return; }
      try {
        res.hit.el.scrollIntoView({ block: 'center', inline: 'center' });
        res.hit.el.click();
        resolve({ ok: true, detail: res.hit.by + ':' + res.hit.match });
      } catch (e) {
        resolve({ ok: false, detail: 'click threw: ' + (e && e.message ? e.message : String(e)) });
      }
    });
  });
})()`;
    case 'fill':
      return `(function(){
  ${findWithTimeoutJs(step.selector, undefined, timeout)}
  var VALUE = ${embed(step.value)};
  return new Promise(function(resolve){
    waitFor(function(res){
      if (!res.ok) { resolve({ ok: false, detail: res.detail }); return; }
      var el = res.hit.el;
      try {
        el.focus();
        // React-controlled inputs ignore plain .value writes; go through
        // the native setter then dispatch input+change so the framework
        // sees the edit (same trick as lib/auth-scripts.js fill).
        var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        var setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) { setter.set.call(el, VALUE); } else { el.value = VALUE; }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        resolve({ ok: true, detail: res.hit.match });
      } catch (e) {
        resolve({ ok: false, detail: 'fill threw: ' + (e && e.message ? e.message : String(e)) });
      }
    });
  });
})()`;
    case 'assertText':
      return `(function(){
  ${findWithTimeoutJs(step.selector, undefined, timeout)}
  var EXPECT = ${embed(step.text)};
  return new Promise(function(resolve){
    waitFor(function(res){
      if (!res.ok) { resolve({ ok: false, detail: res.detail }); return; }
      var text = (res.hit.el.textContent || '').trim();
      if (text.toLowerCase().indexOf(EXPECT.toLowerCase()) !== -1) {
        resolve({ ok: true, detail: res.hit.match });
      } else {
        resolve({ ok: false, detail: 'text mismatch: expected "' + EXPECT + '", saw "' + text.slice(0, 120) + '"' });
      }
    });
  });
})()`;
    case 'assertUrl':
      // Evaluated main-side against executor.currentUrl(); compiling it
      // keeps the switch exhaustive but this branch is never exec'd.
      throw new GsxError({
        code: GSX_ERROR_CODES.INVALID_SCRIPT,
        message: 'assertUrl steps are evaluated by the runner, not compiled',
      });
  }
}

/**
 * In-page census of interactive elements, for repair prompts and the
 * `snapshot` API. Capped at 150 elements / 80 chars of text each so a
 * prompt never balloons.
 */
export const SNAPSHOT_SCRIPT = `(function () {
  var SELECTOR = 'a, button, input, textarea, select, [role="button"], [role="tab"], [role="menuitem"], [role="link"], [contenteditable="true"]';
  var KEEP_ATTRS = ['id', 'class', 'name', 'role', 'type', 'placeholder', 'href', 'title', 'aria-label'];
  var nodes = document.querySelectorAll(SELECTOR);
  var out = [];
  for (var i = 0; i < nodes.length && out.length < 150; i++) {
    var el = nodes[i];
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    var attrs = {};
    for (var j = 0; j < KEEP_ATTRS.length; j++) {
      var v = el.getAttribute(KEEP_ATTRS[j]);
      if (v !== null && v.length > 0) attrs[KEEP_ATTRS[j]] = v.slice(0, 120);
    }
    for (var k = 0; k < el.attributes.length; k++) {
      var a = el.attributes[k];
      if (a.name.indexOf('data-') === 0 && a.value.length < 120) attrs[a.name] = a.value;
    }
    out.push({
      ref: out.length,
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || el.value || '').trim().slice(0, 80),
      attrs: attrs
    });
  }
  return { url: String(location.href), title: String(document.title), elements: out };
})()`;

/** Outcome of `executeSteps` -- graded, per-step, first-failure hoisted. */
export interface GsxExecutionOutcome {
  verdict: Extract<GsxRunVerdict, 'pass' | 'fail' | 'error'>;
  steps: GsxStepResult[];
  failure?: string;
}

/**
 * Grade step results into a base verdict (repair escalation to
 * `repaired-*` happens in the store).
 *
 * Pure: `error` when a step aborted the run (executor threw), `fail`
 * when any step reported `ok: false`, `pass` otherwise.
 */
export function gradeSteps(
  steps: GsxStepResult[],
  aborted: boolean
): Extract<GsxRunVerdict, 'pass' | 'fail' | 'error'> {
  if (aborted) return 'error';
  return steps.every((s) => s.ok) ? 'pass' : 'fail';
}

/**
 * Run a (param-substituted) script's steps sequentially against an
 * executor. Never throws for in-page failures -- those grade the run.
 * Executor-level throws (window destroyed, navigation refused) abort
 * the run with verdict `error`.
 *
 * Action steps (navigate/waitFor/click/fill) STOP the run on failure
 * -- later steps would act on the wrong page. Assertion steps record
 * their failure and continue, so one broken assertion still yields a
 * complete evaluation picture for the repair prompt.
 */
export async function executeSteps(
  script: GsxScript,
  executor: GsxExecutor,
  opts?: { now?: () => number }
): Promise<GsxExecutionOutcome> {
  const now = opts?.now ?? Date.now;
  const results: GsxStepResult[] = [];
  let aborted = false;
  let failure: string | undefined;

  for (let index = 0; index < script.steps.length; index++) {
    const step = script.steps[index];
    if (step === undefined) break;
    const startedAt = now();
    let ok = false;
    let detail: string | undefined;
    try {
      if (step.kind === 'navigate') {
        await executor.navigate(step.url);
        ok = true;
        detail = step.url;
      } else if (step.kind === 'assertUrl') {
        const url = executor.currentUrl();
        ok = new RegExp(step.pattern).test(url);
        detail = ok ? url : `url "${url}" !~ /${step.pattern}/`;
      } else {
        const raw = (await executor.exec(compileStep(step), true)) as
          | StepScriptResult
          | undefined;
        ok = raw !== undefined && raw !== null && raw.ok === true;
        detail = raw?.detail;
        if (!ok && detail === undefined) detail = 'step script returned no result';
      }
    } catch (err) {
      aborted = true;
      detail = (err as Error).message;
    }
    results.push({
      index,
      kind: step.kind,
      ok,
      ...(detail !== undefined ? { detail } : {}),
      durationMs: Math.max(0, now() - startedAt),
    });
    if (!ok && failure === undefined) {
      failure = `step ${index} (${step.kind}): ${detail ?? 'failed'}`;
    }
    if (aborted) break;
    const isAssertion = (GSX_ASSERTION_KINDS as readonly string[]).includes(step.kind);
    if (!ok && !isAssertion) break;
  }

  const verdict = gradeSteps(results, aborted);
  return { verdict, steps: results, ...(failure !== undefined ? { failure } : {}) };
}

/** Take an interactive-element snapshot of the executor's page. */
export async function takeSnapshot(executor: GsxExecutor): Promise<GsxPageSnapshot> {
  const raw = (await executor.exec(SNAPSHOT_SCRIPT, false)) as GsxPageSnapshot;
  if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.elements)) {
    return { url: executor.currentUrl(), title: '', elements: [] };
  }
  return raw;
}
