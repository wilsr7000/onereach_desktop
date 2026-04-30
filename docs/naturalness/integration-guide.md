# Naturalness - Integration Guide

This guide walks a NEW product (WISER Playbooks, a GSX flow, a CLI
tool, anything non-Electron) through adding the naturalness layer to
its voice / chat loop. It assumes:

- You already have a working STT -> task-routing -> TTS pipeline.
- You can provide at least a Spaces-like KV store and a conversation
  history accessor. All other ports are optional; you can bring them
  online incrementally.

If you're in the Onereach desktop app, skip this doc -- the
integration is already wired. See `docs/naturalness/README.md` instead.

## Step 0 - Import

```js
const { createNaturalness } = require('@onereach/naturalness');
// or, for now, relative-path inside this monorepo:
// const { createNaturalness } = require('./lib/naturalness');
```

All phase primitives are also exported from the same module for
direct use (see `lib/naturalness/index.js`). The facade
`createNaturalness` wraps them into the five hook methods that most
integrators actually need.

## Step 1 - Construct with minimum ports

```js
const nat = createNaturalness({
  ports: {
    spaces: mySpacesAdapter,         // see ports.md for shape
    getHistory: () => myHistoryArr,  // () => Array<{role, content}>
    log: myLogger,                   // optional; defaults to silent
  },
});
```

At construction time, the facade:

- Configures the Phase 6 affect tracker with your clock (defaults to
  `Date.now`).
- Configures the Phase 5 repair-memory singleton with your Spaces
  adapter so autosave works.
- Does NOT yet load the stored fixes -- that happens on `onConnect()`.

## Step 2 - Boot the session

```js
await nat.onConnect();
```

Called once when your session opens (WebSocket connect, CLI start,
request handler init). It kicks off the Spaces load so your first
transcript already has the user's learned phonetic fixes applied.

The returned promise resolves to `true` if fixes loaded, `false` if
there were none or Spaces failed (non-blocking either way).

## Step 3 - Apply fixes on STT transcripts

Every time your STT pipeline emits a final transcript:

```js
function onSTTFinal(rawTranscript) {
  const { text: fixedTranscript, appliedCount } = nat.onTranscriptFinal(rawTranscript);
  // Use `fixedTranscript` downstream. Log appliedCount if you care.
  routeToTaskAgent(fixedTranscript);
}
```

On the very first session after install there are no fixes, so this
is a pass-through. Once the user teaches the app ("I meant jazz"),
subsequent transcripts get rewritten silently.

## Step 4 - Hook task submission

Every time the user submits a task (voice or typed), pass it to
`onUserTask` BEFORE your normal routing:

```js
async function onUserSubmit(text) {
  const outcome = await nat.onUserTask(text, { history: myHistory });

  if (outcome.handled) {
    // One of the shortcuts fired (currently: 'undo' for repair-memory
    // undo). The facade already spoke the ack via your speaker port.
    // Don't route this turn.
    return;
  }

  // outcome.correction is set when a learn pattern matched ("I meant X").
  // outcome.affect is set when a non-neutral affect was detected.
  // Normal routing continues.
  await normalRouting(text);
}
```

The `history` option is optional; if omitted, the facade falls back
to your `getHistory` port. Pass it explicitly only if you have a
context-local history that differs from the global one (e.g.,
per-playbook in WISER).

## Step 5 - Adjust outgoing speech

Wrap every TTS `speak` with `onBeforeSpeak`:

```js
async function speakToUser(text) {
  const { text: adjusted, modified } = nat.onBeforeSpeak(text);
  if (modified) log.info('adjusted for affect', { before: text, after: adjusted });
  await mySpeaker.speak(adjusted);
}
```

For fixed safety / system phrases that must be spoken verbatim, pass
`{ skipAffectMatching: true }`:

```js
async function speakSafetyPrompt(text) {
  const { text: adjusted } = nat.onBeforeSpeak(text, { skipAffectMatching: true });
  // adjusted === text in this path
  await mySpeaker.speak(adjusted);
}
```

## Step 6 (optional) - Wire barge-in

Barge-in needs two additional ports: `speaker` and `submitTask`.
Pass them at construction:

```js
const nat = createNaturalness({
  ports: {
    spaces: mySpacesAdapter,
    getHistory: () => myHistory,
    speaker: {
      speak: (text, opts) => mySpeaker.speak(text, opts),
      cancel: () => mySpeaker.cancel(),
    },
    submitTask: (text, opts) => myRouter.submit(text, opts),
  },
});
```

Then feed TTS lifecycle events to the facade:

```js
mySpeaker.on('tts-start', (text) => nat.onTtsLifecycle('start', text));
mySpeaker.on('tts-end', () => nat.onTtsLifecycle('end'));
```

And feed incremental STT partials WHILE TTS is playing:

```js
mySTT.on('partial', (text) => {
  if (mySpeaker.isPlaying()) nat.onUserPartial(text);
});
```

The barge detector handles the rest: echo filtering, stop-vs-command
classification, cancellation, and re-submission of the interrupt as
a new task via your `submitTask` port.

## Step 7 (optional) - Wire pause detection's LLM fallback

Phase 3 has a heuristic-first turn-taking policy; when the heuristic
returns `'ambiguous'`, it calls your `ai` port for a final verdict.
To enable:

```js
const nat = createNaturalness({
  ports: {
    // ... other ports ...
    ai: {
      call: (prompt, opts) => myLLM.complete(prompt, { ...opts, model: 'gpt-5.2' }),
    },
  },
});
```

Without `ai`, the pause detector only uses heuristics (still useful,
just less accurate on borderline utterances).

## Full example: headless Node consumer

```js
// examples/headless-naturalness.js
const { createNaturalness } = require('@onereach/naturalness');
const fs = require('fs/promises');

// Simplest possible Spaces adapter: a single JSON file.
const spaces = {
  files: {
    async read(scope, name) {
      try { return await fs.readFile(`.state/${scope}/${name}`, 'utf8'); }
      catch { return null; }
    },
    async write(scope, name, body) {
      await fs.mkdir(`.state/${scope}`, { recursive: true });
      await fs.writeFile(`.state/${scope}/${name}`, body);
      return true;
    },
    async delete(scope, name) {
      try { await fs.unlink(`.state/${scope}/${name}`); return true; }
      catch { return false; }
    },
  },
};

const history = [];

const nat = createNaturalness({
  ports: {
    spaces,
    getHistory: () => history,
    log: { info: console.log, warn: console.warn, error: console.error },
  },
});

(async () => {
  await nat.onConnect();

  // Simulate a session.
  const userTurns = [
    'play jess',
    'I meant jazz',
    'ugh this is still broken',
    'play jess again',   // now auto-rewritten to "play jazz again"
  ];

  for (const raw of userTurns) {
    const { text } = nat.onTranscriptFinal(raw);
    console.log('-> user:', text);
    history.push({ role: 'user', content: text });

    const outcome = await nat.onUserTask(text);
    if (outcome.handled) continue;

    const reply = "OK, so let me check that";
    const { text: adjusted } = nat.onBeforeSpeak(reply);
    console.log('<- assistant:', adjusted);
    history.push({ role: 'assistant', content: adjusted });
  }
})();
```

Running this produces:

```
-> user: play jess
<- assistant: OK, so let me check that
-> user: I meant jazz
<- assistant: OK, so let me check that
-> user: ugh this is still broken
<- assistant: Got it - let me check that        # affect-adjusted
-> user: play jazz again                         # repair-memory fixed
<- assistant: Got it - let me check that        # affect persists
```

Note the transparent "jess" -> "jazz" rewrite on turn 4, and the
sustained frustrated-affect empathy prefix across turns 3 and 4
(TTL-bounded, not per-turn reset).

## Rollback / disabling

Every phase still honors a feature flag. If a single phase misbehaves
in production, disable it via env var without redeploying:

```bash
NATURAL_REPAIR_MEMORY=0 NATURAL_AFFECT_MATCHING=0 npm start
```

Or via your settings manager port:

```js
mySettingsManager.set('naturalnessFlags', {
  repairMemory: false,
  affectMatching: false,
});
```

The facade re-checks flags on every hook call, so changes take
effect immediately without restart.

## What's missing / out of scope

- **Agent routing / task decomposition / voting** -- that's the HUD
  layer, a separate extraction target.
- **Voice pitch / speed control** -- not exposed by current OpenAI
  Realtime API; a local prosody shim would be a follow-up.
- **Localised lexicons** -- Phase 6 English-only today.
- **In-app UI for learned fixes** -- see `lib/naturalness/repair-memory.js`
  for the API; build your own panel if you want.

## Checking your integration

Run the barrel consumer test (`test/unit/naturalness-barrel.test.js`)
as a reference. Every integration scenario you might need -- minimum
ports, full wiring, barge flow, flag gating, defensive inputs --
has a passing test that mocks out all external dependencies. Copy
the patterns you need.
