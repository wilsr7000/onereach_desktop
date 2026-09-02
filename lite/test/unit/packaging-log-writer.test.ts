/**
 * The packaged app must ship its log-file writer (2026-09-01).
 *
 * What was found: every installed Lite from 0.0.64 through 0.0.78 had
 * NEVER written a log file. `lib/log-event-queue.js` (the queue every
 * Lite log line goes through) lazily `require('../event-logger')`s the
 * repo-root writer inside a try/catch that marks the writer failed
 * forever on the first miss — and `lite/electron-builder.json` packaged
 * `lib/**` but not the root `event-logger.js`, so in the asar the
 * require threw and the queue went silent. Nobody noticed because dev
 * runs (which resolve `../event-logger` from the repo) used the same
 * userData directory until mid-August and left log files there; once
 * dev moved to side-by-side profiles, the installed app's logs
 * directory simply stopped changing.
 *
 * These pins keep the three parts agreeing: the queue's lazy require,
 * the packaging list, and the release script's presence gate.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../..');
const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf-8');

describe('the log-file writer ships with the packaged app', () => {
  it('the lib log queue still reaches the root writer lazily (the coupling that makes the rest necessary)', () => {
    const queue = read('lib/log-event-queue.js');
    expect(queue).toContain("require('../event-logger')");
    // ...and swallows a miss forever — which is why a packaging gap is silent.
    expect(queue).toContain('this._fileWriterFailed = true;');
  });

  it('electron-builder packages the root event-logger.js alongside lib/**', () => {
    const cfg = JSON.parse(read('lite/electron-builder.json')) as { files: string[] };
    expect(cfg.files).toContain('lib/**/*');
    expect(cfg.files).toContain('event-logger.js');
    // No negative pattern may take it back out (root JS excludes are
    // enumerated by name — keep this one off that list).
    const excludes = cfg.files.filter((p) => p.startsWith('!'));
    expect(excludes).not.toContain('!event-logger.js');
    expect(excludes).not.toContain('!*.js');
  });

  it('the writer needs nothing the kernel does not ship (fs, path, electron only)', () => {
    const writer = read('event-logger.js');
    const requires = Array.from(writer.matchAll(/require\(['"]([^'"]+)['"]\)/g), (m) => m[1]);
    expect(new Set(requires)).toEqual(new Set(['fs', 'path', 'electron']));
  });

  it('the release script refuses an asar without it', () => {
    const script = read('lite/scripts/release-lite.sh');
    expect(script).toContain('event-logger.js');
  });
});
