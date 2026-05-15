/**
 * agent SDK-unavailable boot is quiet -- source-level invariants
 *
 * The workspace symlink for `@onereach/task-exchange` doesn't always
 * materialize inside `app.asar` for packaged builds. When that happens,
 * `require('../task-agent/dist/index.js')` throws inside both
 * `spelling-agent.createSpellingAgent()` and
 * `dynamic-agent.createDynamicAgent()` -- a graceful degradation, NOT a
 * crash, since the callers in `main.js` wrap it in try/catch.
 *
 * Originally the boot log carried red `error`-level entries for both
 * sites (with full requireStack), which made real failures harder to
 * spot. The v4.9.1 entry tried to fix this for dynamic-agent only and
 * shipped half the patch (inner catch warned, outer catch still
 * errored). spelling-agent never got the treatment.
 *
 * These are SOURCE-level invariant tests on the three files involved:
 * we don't try to actually trigger the require failure (vitest's CJS
 * mock semantics + module-cache reset don't compose well across describe
 * blocks). We pin the SHAPE of the error-handling code instead, which
 * is what the punch-list claim is really about.
 */

import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');

const SPELLING_AGENT_SOURCE = fs.readFileSync(
  path.join(__dirname, '../../packages/agents/spelling-agent.js'),
  'utf8'
);

const DYNAMIC_AGENT_SOURCE = fs.readFileSync(
  path.join(__dirname, '../../packages/agents/dynamic-agent.js'),
  'utf8'
);

const MAIN_SOURCE = fs.readFileSync(
  path.join(__dirname, '../../main.js'),
  'utf8'
);

function extractCreateSpellingAgentSdkBlock() {
  // Slice out just the inner try/catch around the task-agent require
  // inside createSpellingAgent, so we don't accidentally match other
  // log statements elsewhere in the file.
  const start = SPELLING_AGENT_SOURCE.indexOf('function createSpellingAgent');
  expect(start, 'createSpellingAgent must exist').toBeGreaterThan(-1);
  const end = SPELLING_AGENT_SOURCE.indexOf('return createAgent({', start);
  expect(end, 'createAgent({ block must follow the SDK-load try/catch').toBeGreaterThan(start);
  return SPELLING_AGENT_SOURCE.slice(start, end);
}

function extractCreateDynamicAgentSdkBlock() {
  const start = DYNAMIC_AGENT_SOURCE.indexOf('function createDynamicAgent');
  expect(start, 'createDynamicAgent must exist').toBeGreaterThan(-1);
  const end = DYNAMIC_AGENT_SOURCE.indexOf('// Collect all unique categories', start);
  expect(end, 'category-collection block must follow the SDK-load try/catch').toBeGreaterThan(start);
  return DYNAMIC_AGENT_SOURCE.slice(start, end);
}

function extractStartDynamicAgentOuterCatch() {
  const start = DYNAMIC_AGENT_SOURCE.indexOf('async function startDynamicAgent');
  expect(start, 'startDynamicAgent must exist').toBeGreaterThan(-1);
  return DYNAMIC_AGENT_SOURCE.slice(start);
}

function extractMainSpellingAgentCatch() {
  // The main.js spelling-agent caller is in startBuiltInAgents.
  const start = MAIN_SOURCE.indexOf('// Try to load and start the spelling agent');
  expect(start, 'spelling-agent caller marker must exist in main.js').toBeGreaterThan(-1);
  // Slice up to the dynamic-agent caller marker that follows.
  const end = MAIN_SOURCE.indexOf('// Start user-defined dynamic agents', start);
  expect(end, 'dynamic-agent caller marker must follow').toBeGreaterThan(start);
  return MAIN_SOURCE.slice(start, end);
}

describe('spelling-agent.js -- SDK-load failure logs at warn (not error)', () => {
  const body = extractCreateSpellingAgentSdkBlock();

  it('uses log.warn (not log.error) for the SDK-unavailable condition', () => {
    expect(body).toMatch(/log\.warn\(\s*['"]agent['"]\s*,\s*['"]task-agent SDK unavailable[^'"]*['"]/);
  });

  it('does NOT use log.error inside the SDK-load catch', () => {
    // The block is just createSpellingAgent through to the createAgent({
    // call -- any log.error in there would be the boot-noise regression.
    expect(body).not.toMatch(/log\.error\(/);
  });

  it('does NOT emit the legacy "Make sure to run: cd packages/task-agent && npm run build" info advice', () => {
    // That info line was useful in dev but pollutes the boot log in
    // production where the user can't act on it (packaging issue).
    expect(body).not.toMatch(/Make sure to run: cd packages\/task-agent/);
  });

  it('tags the thrown error with sdkUnavailable=true so callers can short-circuit', () => {
    expect(body).toMatch(/error\.sdkUnavailable\s*=\s*true/);
  });

  it('still throws so the caller in main.js skips agent.start()', () => {
    expect(body).toMatch(/throw\s+error/);
  });
});

describe('dynamic-agent.js -- SDK-load failure logs at warn (not error)', () => {
  const body = extractCreateDynamicAgentSdkBlock();

  it('uses log.warn (not log.error) for the SDK-unavailable condition', () => {
    expect(body).toMatch(/log\.warn\(\s*['"]agent['"]\s*,\s*['"]task-agent SDK unavailable[^'"]*['"]/);
  });

  it('does NOT use log.error inside the SDK-load catch', () => {
    expect(body).not.toMatch(/log\.error\(/);
  });

  it('tags the thrown error with sdkUnavailable=true so the outer catch can short-circuit', () => {
    expect(body).toMatch(/error\.sdkUnavailable\s*=\s*true/);
  });

  it('still throws so the caller short-circuits cleanly', () => {
    expect(body).toMatch(/throw\s+error/);
  });
});

describe('dynamic-agent.js -- startDynamicAgent outer catch swallows tagged sdkUnavailable errors', () => {
  const body = extractStartDynamicAgentOuterCatch();

  it('checks error.sdkUnavailable BEFORE calling log.error', () => {
    // The early-return guard must precede the log.error('Failed to
    // start') call -- otherwise the inner-warn + outer-error duplication
    // returns. We assert order via substring index.
    const guardIdx = body.indexOf('sdkUnavailable');
    const errorLogIdx = body.search(/log\.error\(\s*['"]agent['"]\s*,\s*['"]Failed to start['"]/);
    expect(guardIdx, 'sdkUnavailable guard must be present').toBeGreaterThan(-1);
    expect(errorLogIdx, 'Failed to start log.error must still exist for real errors').toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(errorLogIdx);
  });

  it('returns null on tagged-error short-circuit (graceful degradation)', () => {
    // The guard block returns null so the caller treats it the same as
    // "no agent definitions found" (which also returns null).
    expect(body).toMatch(/error\.sdkUnavailable[\s\S]*?return null/);
  });
});

describe('main.js -- spelling-agent caller is quiet on SDK-unavailable', () => {
  const body = extractMainSpellingAgentCatch();

  it('checks error.sdkUnavailable BEFORE the noisy console.warn path', () => {
    const guardIdx = body.indexOf('sdkUnavailable');
    const noisyIdx = body.search(/console\.warn\(\s*['"]\[VoiceOrb\] Could not start spelling agent/);
    expect(guardIdx, 'sdkUnavailable guard must be present').toBeGreaterThan(-1);
    expect(noisyIdx, 'noisy fallback path must still exist for real errors').toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(noisyIdx);
  });

  it('does NOT print the full error.stack to console (was: doubling the boot noise)', () => {
    expect(body).not.toMatch(/console\.error\(['"][^'"]*Full error/);
    expect(body).not.toMatch(/error\.stack/);
  });

  it('does NOT print the production-useless "Make sure packages are compiled" advice', () => {
    expect(body).not.toMatch(/Make sure packages are compiled/);
  });
});
