/**
 * Event-name conformance meta-test (ADR-032).
 *
 * Scans each module's implementation files for `getLoggingApi().event(...)`
 * and `getLoggingApi().start(...)` calls and asserts every literal name
 * appears in the module's typed `<MODULE>_EVENTS` constant.
 *
 * Catches drift between the code that emits events and the typed
 * surface consumers subscribe to. Failure mode: if a developer adds
 * `getLoggingApi().event('kv.new-thing', ...)` without adding
 * `NEW_THING: 'kv.new-thing'` to KV_EVENTS, this test fails with the
 * specific name and file location.
 *
 * Limitations:
 *   - Only catches LITERAL string args (`event('kv.set')`). Dynamic
 *     names (`event(\`kv.${op}\`)`) are skipped here -- the next-best
 *     check is the integration coverage tests in
 *     `lite/test/integration/event-coverage.test.ts`.
 *   - Spans take a base name (`start('kv.set')`) and emit
 *     `kv.set.start` / `.finish` / `.fail` -- this test treats those
 *     as one base name and verifies all three suffixes appear in the
 *     constants.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { KV_EVENTS } from '../../kv/events.js';
import { BUG_REPORT_EVENTS } from '../../bug-report/events.js';
import { AUTH_EVENTS } from '../../auth/events.js';
import { UPDATER_EVENTS } from '../../updater/events.js';
import { NEON_EVENTS } from '../../neon/events.js';
import { IDW_EVENTS } from '../../idw/events.js';
import { UNIVERSITY_EVENTS } from '../../university/events.js';
import { AI_EVENTS } from '../../ai/events.js';
import { AI_RUN_TIMES_EVENTS } from '../../ai-run-times/events.js';

const liteRoot = path.resolve(__dirname, '..', '..');

interface ModuleSpec {
  name: string;
  /** Files to scan for `getLoggingApi().event()` / `.start()` calls. */
  sourceFiles: string[];
  /** The typed event-name catalog. */
  events: Readonly<Record<string, string>>;
}

const MODULES: ModuleSpec[] = [
  {
    name: 'kv',
    sourceFiles: ['kv/client.ts'],
    events: KV_EVENTS,
  },
  {
    name: 'bug-report',
    sourceFiles: ['bug-report/store.ts', 'bug-report/main.ts'],
    events: BUG_REPORT_EVENTS,
  },
  {
    name: 'auth',
    sourceFiles: ['auth/store.ts', 'auth/main.ts'],
    events: AUTH_EVENTS,
  },
  {
    name: 'updater',
    sourceFiles: ['updater/check.ts', 'updater/index.ts'],
    events: UPDATER_EVENTS,
  },
  {
    name: 'neon',
    sourceFiles: ['neon/client.ts', 'neon/main.ts', 'neon/api.ts'],
    events: NEON_EVENTS,
  },
  {
    name: 'idw',
    sourceFiles: ['idw/store.ts', 'idw/main.ts', 'idw/menu-builder.ts', 'idw/browser-window.ts'],
    events: IDW_EVENTS,
  },
  {
    name: 'university',
    sourceFiles: [
      'university/main.ts',
      'university/menu-builder.ts',
      'university/browser-window.ts',
    ],
    events: UNIVERSITY_EVENTS,
  },
  {
    name: 'ai',
    sourceFiles: ['ai/api.ts', 'ai/main.ts'],
    events: AI_EVENTS,
  },
  {
    name: 'ai-run-times',
    sourceFiles: [
      'ai-run-times/api.ts',
      'ai-run-times/store.ts',
      'ai-run-times/main.ts',
    ],
    events: AI_RUN_TIMES_EVENTS,
  },
];

/**
 * Extract literal names passed to `event()` / `start()` calls from a
 * source file. Returns the set of literal strings; dynamic names
 * (template literals, variable refs) are ignored.
 */
function extractEmittedNames(source: string): {
  spanBaseNames: Set<string>;
  instantNames: Set<string>;
} {
  const spanBaseNames = new Set<string>();
  const instantNames = new Set<string>();
  // Match: getLoggingApi().event('foo.bar', ...) or .start('foo.bar', ...)
  // Also: this.spanEmitter?.('foo.bar', ...) inside a module that
  // matches the spanEmitter pattern.
  const eventRe = /\.event\s*\(\s*'([^']+)'/g;
  const startRe = /\.start\s*\(\s*'([^']+)'/g;
  // spanEmitter callsites take the FULL span name (`kv.set` -> emits
  // .start/.finish/.fail). They look like: spanEmitter?.('kv.set', ...)
  const spanEmitterRe = /spanEmitter\??\.\s*\(?\s*['"`]([^'"`]+)['"`]/g;

  let m: RegExpExecArray | null;
  // Helper: skip dynamic names (template literal interpolations).
  // The regex matches the literal between quotes/backticks; if it
  // contains `${`, the name is computed at runtime and out-of-scope
  // for static analysis. Integration tests (event-coverage.test.ts)
  // assert the dynamic names produce expected runtime emissions.
  const isStatic = (name: string): boolean => !name.includes('${');
  while ((m = eventRe.exec(source)) !== null) {
    if (m[1] !== undefined && isStatic(m[1])) instantNames.add(m[1]);
  }
  while ((m = startRe.exec(source)) !== null) {
    if (m[1] !== undefined && isStatic(m[1])) spanBaseNames.add(m[1]);
  }
  while ((m = spanEmitterRe.exec(source)) !== null) {
    if (m[1] !== undefined && isStatic(m[1])) spanBaseNames.add(m[1]);
  }
  return { spanBaseNames, instantNames };
}

describe('Event-name conformance (Rule 12 / ADR-032)', () => {
  for (const mod of MODULES) {
    describe(`module: ${mod.name}`, () => {
      const eventValues = new Set(Object.values(mod.events));

      it('every literal event() name is in the typed constants', () => {
        const undeclared: Array<{ file: string; name: string }> = [];
        for (const relPath of mod.sourceFiles) {
          const filePath = path.join(liteRoot, relPath);
          if (!fs.existsSync(filePath)) continue;
          const source = fs.readFileSync(filePath, 'utf-8');
          const { instantNames } = extractEmittedNames(source);
          for (const name of instantNames) {
            // Filter to events that look like they belong to this module
            // (start with `${mod.name}.`). Other modules' events emitted
            // from this file (e.g. test fixtures) are out of scope.
            const prefix = `${mod.name}.`;
            if (!name.startsWith(prefix)) continue;
            if (!eventValues.has(name)) {
              undeclared.push({ file: relPath, name });
            }
          }
        }
        expect(
          undeclared,
          `module "${mod.name}" emits literal event() names not in ${mod.name.toUpperCase().replace(/-/g, '_')}_EVENTS:\n` +
            undeclared.map((u) => `  - ${u.name} (in ${u.file})`).join('\n')
        ).toHaveLength(0);
      });

      it('every literal span base name has its .start in the typed constants (and at least one of .finish/.fail)', () => {
        // .start is mandatory because Span ALWAYS emits it on construction.
        // .finish and .fail are EITHER-OR (Span is idempotent: exactly one
        // fires). A span op that's declared soft-fail (never throws) may
        // legitimately omit .fail from the catalog; an always-throws op
        // could omit .finish. Requiring both would force module authors
        // to declare events that never fire.
        const violations: Array<{ file: string; baseName: string; reason: string }> = [];
        for (const relPath of mod.sourceFiles) {
          const filePath = path.join(liteRoot, relPath);
          if (!fs.existsSync(filePath)) continue;
          const source = fs.readFileSync(filePath, 'utf-8');
          const { spanBaseNames } = extractEmittedNames(source);
          for (const baseName of spanBaseNames) {
            const prefix = `${mod.name}.`;
            if (!baseName.startsWith(prefix)) continue;
            if (!eventValues.has(`${baseName}.start`)) {
              violations.push({
                file: relPath,
                baseName,
                reason: `missing ${baseName}.start (mandatory)`,
              });
              continue;
            }
            const hasFinish = eventValues.has(`${baseName}.finish`);
            const hasFail = eventValues.has(`${baseName}.fail`);
            if (!hasFinish && !hasFail) {
              violations.push({
                file: relPath,
                baseName,
                reason: `missing both ${baseName}.finish and ${baseName}.fail (need at least one)`,
              });
            }
          }
        }
        expect(
          violations,
          `module "${mod.name}" has span base names with incomplete typed constants:\n` +
            violations.map((v) => `  - ${v.baseName} (in ${v.file}); ${v.reason}`).join('\n')
        ).toHaveLength(0);
      });

      it('all values in the typed constants follow the <module>.<segment>+ convention', () => {
        const pattern = new RegExp(`^${mod.name.replace('-', '\\-')}(\\.[a-zA-Z][a-zA-Z0-9-]*)+$`);
        const violations: string[] = [];
        for (const value of Object.values(mod.events)) {
          if (!pattern.test(value)) violations.push(value);
        }
        expect(
          violations,
          `module "${mod.name}" has typed event names that don't match the convention: ${violations.join(', ')}`
        ).toHaveLength(0);
      });

      it('all values in the typed constants are unique', () => {
        const values = Object.values(mod.events);
        expect(new Set(values).size).toBe(values.length);
      });
    });
  }
});
