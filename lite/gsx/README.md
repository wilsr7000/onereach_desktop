# GSX Automation (`lite/gsx/`)

Open GSX studio windows (Designer, Flows, Files — any
`studio.<env>.onereach.ai` surface) and drive their UI with
**deterministic scripts** wrapped in an **evaluation feedback loop**.

## The model

- A **script** is versioned JSON: a list of steps
  (`navigate` / `waitFor` / `click` / `fill` / `assertVisible` /
  `assertUrl` / `assertText` / `wait`). Selector steps can carry a
  `textFallback` so one selector drift doesn't kill the script.
  `{accountId}`, `{env}`, and custom `{param}`s substitute at run time.
- Every script carries its own **assertions** — they ARE the evaluation
  criteria. Every run is graded: `pass`, `fail`, `error`,
  `repaired-pass`, `repaired-fail`, and recorded as a `GsxRunRecord`.
- **Hybrid repair**: when a run fails, the module snapshots the live
  page (interactive elements + attributes), asks the AI module
  (`lite/ai/`, Claude, main-process key) to correct the steps, and
  re-runs. The LLM **edits scripts — it never free-drives the page.**
- A repaired script that passes is saved as a **`learned` variant**
  that shadows the seed: the next run replays deterministically with
  no model call. A learned variant that fails
  `GSX_INVALIDATE_AFTER_CONSECUTIVE_FAILURES` (3) runs in a row is
  demoted back to the seed.

```
run ──▶ grade (script's own assertions)
         ├─ pass ────────────────────────────▶ record + stats
         └─ fail/error
              └─▶ snapshot page ─▶ AI repairs steps ─▶ re-run
                    ├─ pass ─▶ save `learned` vN+1 (shadows seed)
                    └─ fail ─▶ record `repaired-fail`
   learned fails 3× in a row ─▶ demoted back to seed
```

## Windows

- Standalone `BrowserWindow`, partition `persist:lite-gsx-<env>`
  (stable per env — the GSX session sticks across restarts).
- Auth cookies are injected **before** `loadURL` (ADR-042), so a
  signed-in user lands authenticated.
- **No preload** (ADR-038): automated pages never see `window.lite.*`.
  All driving happens from the main process via `executeJavaScript`.
- Navigation is contained to `https://*.onereach.ai`.

## Usage (main process)

```typescript
import { getGsxApi } from '../gsx/api.js';

const gsx = getGsxApi();
const win = await gsx.openWindow({ env: 'edison' });          // Designer shell
const run = await gsx.runScript({ scriptId: 'flows.open-by-name',
                                  params: { flowName: 'My Flow' } });
if (run.verdict !== 'pass') console.warn(run.failure, run.repair);
```

Renderer: same surface on `window.lite.gsx.*`.

## Seed scripts

| id | what it does |
|---|---|
| `designer.open` | Studio root for the signed-in account; asserts app shell + nav chrome |
| `flows.list` | Flows view; asserts a flow collection rendered |
| `flows.open-by-name` | Clicks the flow named `{flowName}`; asserts a designer canvas |
| `files.open` | Files view |

Seeds are read-only. `saveScript` with `source: "learned"` shadows a
seed (or registers a new custom id); `deleteScript` on a learned id
reverts to the seed.

## Teach mode (record → template)

Don't write scripts — demonstrate them. Start a recording on an open
GSX window, click through the task yourself, then stop and name it:

```typescript
const win = await gsx.openWindow({});
await gsx.startRecording(win.windowId);
// ... user clicks through GSX: opens Flows, clicks "Billing Bot" ...
const template = await gsx.stopRecording(win.windowId, {
  scriptId: 'flows.open-taught',
  title: 'Open a flow',
  description: 'Opens the flow the user names from the Flows list',
});
// Replay against a DIFFERENT element:
await gsx.runScript({ scriptId: 'flows.open-taught',
                      params: { flowName: 'Support Bot' } });
```

How it works:

- A page-side recorder (injected — GSX windows have no preload)
  captures every click and final input value with **ranked selector
  candidates** (data-testid > id > aria-label > name > class) plus the
  element's **human label** (aria-label / `<label>` / placeholder).
  The buffer write-throughs to sessionStorage so the click that causes
  a navigation survives the page teardown. Passwords are never
  recorded.
- Main polls to drain the buffer, tracks navigations, and re-installs
  the recorder after each page change.
- `stopRecording` converts the recording to deterministic steps
  (literal `accountId`/env are back-substituted to `{accountId}`/
  `{env}`, and a final `assertUrl` pins the destination), then asks
  the AI module to **generalize**: content-specific literals (the flow
  you clicked, the text you typed) become named `{params}` derived
  from the element labels, and assertions are kept/strengthened. If
  the model is unavailable or returns garbage, the deterministic
  recording is saved as-is — a walkthrough is never lost.
- The result is an ordinary `learned` script: validated by the same
  gate, run by the same runner, graded and repaired by the same eval
  loop.

Recording errors: `GSX_NOT_RECORDING` (stop without start),
`GSX_EMPTY_RECORDING` (no actions captured).

## UI-automation agents (record → agent → invoke by name)

The teach-mode UX, packaged: record a walkthrough and save it as a
**named agent**. The system — not you — writes the agent's title,
description, and per-param documentation from the recording, then
publishes it as an agent asset into the core **"GSX Build" Space**
(created on first use; soft-fails when signed out).

```typescript
const win = await gsx.openWindow({});
await gsx.startRecording(win.windowId);
// ...you click through GSX: Flows → click "Billing Bot"...
const agent = await gsx.stopRecordingAsAgent(win.windowId, {
  name: 'open-flow',                       // the callable name
  hint: 'opens a flow by name',            // optional intent hint
});
agent.title;        // "Open a Flow"            (AI-written)
agent.description;  // "Opens the named flow…"  (AI-written)
agent.params;       // [{ name: 'flowName', description: 'Display name…' }]

// Anyone who knows the name can now invoke it with free-form details —
// the param descriptions drive extraction:
const result = await gsx.invokeAgent('open-flow', {
  details: 'open the support bot flow',
});
result.params;      // { flowName: 'Support Bot' }   (extracted)
result.run.verdict; // graded like any other run

// Structured params always work too (and win over extraction):
await gsx.invokeAgent('open-flow', { params: { flowName: 'Billing Bot' } });
```

Management: `listAgents()`, `getAgent(name)`, `deleteAgent(name)`
(also removes the agent's learned script). Renderer surface:
`window.lite.gsx.*` same names.

Design guarantees:

- **One model call at creation** describes + generalizes + documents
  params. No AI available → the agent still exists (slug-derived
  title, params scanned from `{placeholders}`) and is invokable with
  structured params.
- **Missing params fail loudly** (`GSX_MISSING_PARAMS` names them) —
  extraction never guesses; values must appear in the details or be
  passed explicitly.
- The agent's template is an ordinary `learned` script (`agent.<name>`)
  in the standard eval loop: graded runs, AI repair on UI drift,
  versioned history.
- The Space publication is an OKF document (title, description,
  params, invocation snippet) — reviewable and shareable like any
  other agent asset; `spaceItemId` links the two worlds.

## The eval trail

Every transition is a typed event (ADR-032): `gsx.run.verdict`,
`gsx.step.result`, `gsx.script.learned`, `gsx.script.invalidated`,
plus spans for `gsx.open-window` / `gsx.run-script` / `gsx.repair`.
`getStats()` returns per-script health (runs / passes / failures /
consecutive failures); `listRuns()` is the run corpus, capped at 200
records, persisted in `gsx-automation.json` under userData.

## Error catalog

| Code | Meaning |
|---|---|
| `GSX_UNSUPPORTED_ENV` | Env not in `SUPPORTED_ENVIRONMENTS` |
| `GSX_WINDOW_NOT_FOUND` | Unknown/closed windowId (or initGsx never ran) |
| `GSX_SCRIPT_NOT_FOUND` | No script under that id |
| `GSX_INVALID_SCRIPT` | Script (saved or AI-repaired) failed validation |
| `GSX_RUN_NOT_FOUND` | Run record aged out of the ring buffer |
| `GSX_URL_NOT_ALLOWED` | Non-`*.onereach.ai` URL refused |
| `GSX_NAVIGATION_FAILED` | loadURL failed (network, auth) |
| `GSX_AI_UNAVAILABLE` | Repair requested but AI module unusable |
| `GSX_REPAIR_FAILED` | Model output didn't parse into a valid script |
| `GSX_PERSIST_FAILED` | gsx-automation.json write failed (soft, logged) |
| `GSX_SEED_READ_ONLY` | Attempted to overwrite/delete a seed |

Repair-path failures never throw out of `runScript` — they land in the
run record's `repair.skippedReason`.
