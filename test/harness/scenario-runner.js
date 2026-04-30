/**
 * Scenario Runner - loads JSON voice scenarios and executes their
 * timed step sequence against the TTSMock + MicInjector harness,
 * evaluating assertions as they run.
 *
 * Scenario fixture format is documented in
 * test/fixtures/voice-scenarios/README.md.
 *
 * Typical usage (vitest):
 *   import { loadScenario, runScenario } from '../harness/scenario-runner';
 *
 *   const scenario = loadScenario('baseline/01-tts-capture');
 *   const result = await runScenario(scenario);
 *   expect(result.pass).toBe(true);
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { TTSMock } = require('./tts-mock');
const { MicInjector } = require('./mic-injector');
const flagsModule = require('../../lib/naturalness-flags');

const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'voice-scenarios');

/**
 * Load a scenario JSON by relative path (with or without the .json
 * suffix). Throws if the fixture does not exist or is malformed.
 *
 * @param {string} relativePath - e.g. 'baseline/01-tts-capture'
 * @returns {object} parsed scenario
 */
function loadScenario(relativePath) {
  let p = relativePath;
  if (!p.endsWith('.json')) p += '.json';
  const full = path.join(FIXTURE_ROOT, p);
  if (!fs.existsSync(full)) {
    throw new Error(`Scenario fixture not found: ${full}`);
  }
  const raw = fs.readFileSync(full, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed JSON in ${p}: ${err.message}`);
  }
  validateScenario(parsed, p);
  return parsed;
}

/**
 * List every .json fixture under a subdirectory. Returns objects that
 * include `path` so you can feed one back into loadScenario.
 *
 * @param {string} subdir - e.g. 'baseline'
 * @returns {Array<{path: string, scenario: object}>}
 */
function listScenarios(subdir) {
  const dir = path.join(FIXTURE_ROOT, subdir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const rel = path.join(subdir, f);
      return {
        path: rel.replace(/\.json$/, ''),
        scenario: loadScenario(rel),
      };
    });
}

function validateScenario(s, filePath) {
  const required = ['name', 'description', 'phase', 'steps'];
  for (const k of required) {
    if (s[k] === undefined) {
      throw new Error(`Scenario ${filePath}: missing required field "${k}"`);
    }
  }
  if (!Array.isArray(s.steps)) {
    throw new Error(`Scenario ${filePath}: "steps" must be an array`);
  }
}

/**
 * Execute a loaded scenario. Returns a detailed result object with
 * per-step outcomes so tests can assert at the step level when useful.
 *
 * Flag overrides specified in scenario.flags are applied via env vars
 * for the duration of the run, and restored on exit.
 *
 * @param {object} scenario - parsed fixture
 * @param {object} [options]
 * @param {Record<string, (args?: object, ctx?: object) => any>} [options.hooks]
 *        Named hooks that can be invoked via { type: 'hook', name: ... }
 *        steps. Receives the hook args and a ctx object with { tts, mic }.
 * @returns {Promise<{pass:boolean, scenario:string, results:Array}>}
 */
async function runScenario(scenario, options = {}) {
  const hooks = options.hooks || {};
  const tts = new TTSMock({ wpm: scenario.ttsWpm || 170 });
  const mic = new MicInjector();

  const originalEnv = applyFlagOverrides(scenario.flags || {});

  // `meta` is a shared scratch map hooks can write to so fixtures can
  // later assert against non-TTS/non-mic state (policy decisions,
  // stakes labels, etc.) via `metaEquals`. See README.md.
  const meta = {};
  const ctx = { tts, mic, meta, hooks };
  const results = [];
  let overallPass = true;

  try {
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      const outcome = await executeStep(step, ctx);
      outcome.index = i;
      outcome.step = step;
      results.push(outcome);
      if (!outcome.pass) overallPass = false;
    }
  } finally {
    restoreFlagOverrides(originalEnv);
  }

  return {
    pass: overallPass,
    scenario: scenario.name,
    phase: scenario.phase,
    description: scenario.description,
    results,
    ttsEvents: tts.events,
    micEvents: mic.events,
    meta,
  };
}

async function executeStep(step, ctx) {
  const { tts, mic, hooks } = ctx;

  try {
    switch (step.type) {
      case 'userSays':
        mic.say(step.text, { confidence: step.confidence });
        return { pass: true };

      case 'userSaysPartial':
        mic.sayPartial(step.text, { confidence: step.confidence });
        return { pass: true };

      case 'userStreams':
        mic.sayWithPartials(step.partials || [], {
          partialIntervalMs: step.partialIntervalMs,
          confidence: step.confidence,
        });
        return { pass: true };

      case 'systemSpeaks':
        await tts.speak(step.text, { voice: step.voice, priority: step.priority });
        return { pass: true };

      case 'systemCancels':
        await tts.cancel();
        return { pass: true };

      case 'systemPlaythrough':
        tts.playthrough();
        return { pass: true };

      case 'wait':
        tts.advance(step.ms || 0);
        mic.advance(step.ms || 0);
        return { pass: true };

      case 'hook': {
        const fn = hooks[step.name];
        if (typeof fn !== 'function') {
          return { pass: false, reason: `No hook registered for "${step.name}"` };
        }
        await fn(step.args || {}, ctx);
        return { pass: true };
      }

      case 'assert':
        return evaluateAssertion(step, ctx);

      default:
        return { pass: false, reason: `Unknown step type: ${step.type}` };
    }
  } catch (err) {
    return { pass: false, reason: `Step threw: ${err.message}` };
  }
}

function evaluateAssertion(step, ctx) {
  const { tts, mic, meta } = ctx;
  const failures = [];
  const checks = [];

  if (step.ttsContains !== undefined) {
    const found = tts.hasSpokenContaining(step.ttsContains);
    checks.push(`ttsContains "${step.ttsContains}"`);
    if (!found) failures.push(`expected TTS to contain "${step.ttsContains}"`);
  }

  if (step.ttsNotContains !== undefined) {
    const found = tts.hasSpokenContaining(step.ttsNotContains);
    checks.push(`ttsNotContains "${step.ttsNotContains}"`);
    if (found) failures.push(`expected TTS to NOT contain "${step.ttsNotContains}"`);
  }

  if (step.ttsSpokenCount !== undefined) {
    checks.push(`ttsSpokenCount = ${step.ttsSpokenCount}`);
    if (tts.events.length !== step.ttsSpokenCount) {
      failures.push(
        `expected ${step.ttsSpokenCount} TTS events, got ${tts.events.length}`
      );
    }
  }

  if (step.ttsIsSpeaking !== undefined) {
    checks.push(`ttsIsSpeaking = ${step.ttsIsSpeaking}`);
    if (tts.isSpeaking !== step.ttsIsSpeaking) {
      failures.push(
        `expected isSpeaking=${step.ttsIsSpeaking}, got ${tts.isSpeaking}`
      );
    }
  }

  if (step.lastTtsCancelled !== undefined) {
    const last = tts.events[tts.events.length - 1];
    checks.push(`lastTtsCancelled = ${step.lastTtsCancelled}`);
    if (!last || last.cancelled !== step.lastTtsCancelled) {
      failures.push(
        `expected last TTS cancelled=${step.lastTtsCancelled}, got ${last && last.cancelled}`
      );
    }
  }

  if (step.lastTtsPreempted !== undefined) {
    const last = tts.events[tts.events.length - 1];
    checks.push(`lastTtsPreempted = ${step.lastTtsPreempted}`);
    if (!last || last.preempted !== step.lastTtsPreempted) {
      failures.push(
        `expected last TTS preempted=${step.lastTtsPreempted}, got ${last && last.preempted}`
      );
    }
  }

  if (step.lastTtsPlayedMsLt !== undefined) {
    const last = tts.events[tts.events.length - 1];
    checks.push(`lastTtsPlayedMsLt = ${step.lastTtsPlayedMsLt}`);
    if (!last || typeof last.playedMs !== 'number' || !(last.playedMs < step.lastTtsPlayedMsLt)) {
      failures.push(
        `expected lastTtsPlayedMs < ${step.lastTtsPlayedMsLt}, got ${last && last.playedMs}`
      );
    }
  }

  if (step.lastTtsPlayedMsGt !== undefined) {
    const last = tts.events[tts.events.length - 1];
    checks.push(`lastTtsPlayedMsGt = ${step.lastTtsPlayedMsGt}`);
    if (!last || typeof last.playedMs !== 'number' || !(last.playedMs > step.lastTtsPlayedMsGt)) {
      failures.push(
        `expected lastTtsPlayedMs > ${step.lastTtsPlayedMsGt}, got ${last && last.playedMs}`
      );
    }
  }

  if (step.micEventCount !== undefined) {
    checks.push(`micEventCount = ${step.micEventCount}`);
    if (mic.events.length !== step.micEventCount) {
      failures.push(
        `expected ${step.micEventCount} mic events, got ${mic.events.length}`
      );
    }
  }

  if (step.flagEnabled !== undefined) {
    checks.push(`flagEnabled = ${step.flagEnabled}`);
    if (!flagsModule.isFlagEnabled(step.flagEnabled)) {
      failures.push(`expected flag "${step.flagEnabled}" to be enabled`);
    }
  }

  if (step.flagDisabled !== undefined) {
    checks.push(`flagDisabled = ${step.flagDisabled}`);
    if (flagsModule.isFlagEnabled(step.flagDisabled)) {
      failures.push(`expected flag "${step.flagDisabled}" to be disabled`);
    }
  }

  if (step.metaEquals !== undefined) {
    for (const [key, expected] of Object.entries(step.metaEquals)) {
      checks.push(`meta.${key} = ${JSON.stringify(expected)}`);
      const actual = meta && meta[key];
      if (actual !== expected) {
        failures.push(
          `expected meta.${key} to be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
        );
      }
    }
  }

  if (checks.length === 0) {
    return { pass: false, reason: 'assert step had no recognized assertion keys' };
  }

  return {
    pass: failures.length === 0,
    checks,
    reason: failures.length ? failures.join('; ') : null,
  };
}

function applyFlagOverrides(flags) {
  const saved = {};
  for (const [name, value] of Object.entries(flags)) {
    const envKey = flagNameToEnv(name);
    saved[envKey] = process.env[envKey];
    process.env[envKey] = value ? '1' : '0';
  }
  return saved;
}

function restoreFlagOverrides(saved) {
  for (const [envKey, prior] of Object.entries(saved)) {
    if (prior === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = prior;
    }
  }
}

function flagNameToEnv(name) {
  return `NATURAL_${name.replace(/([A-Z])/g, '_$1').toUpperCase()}`;
}

module.exports = {
  FIXTURE_ROOT,
  loadScenario,
  listScenarios,
  runScenario,
  // Exposed for introspection / direct tests
  _evaluateAssertion: evaluateAssertion,
};
