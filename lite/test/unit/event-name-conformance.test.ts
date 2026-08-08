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
import { TOOLS_EVENTS } from '../../tools/events.js';
import { UNIVERSITY_EVENTS } from '../../university/events.js';
import { AI_RUN_TIMES_EVENTS } from '../../ai-run-times/events.js';
import { FILES_EVENTS } from '../../files/events.js';
import { DISCOVERY_EVENTS } from '../../discovery/events.js';
import { SPACES_EVENTS } from '../../spaces/events.js';
import { MAIN_WINDOW_EVENTS } from '../../main-window/events.js';
import { EVENT_BUS_EVENTS } from '../../event-bus/events.js';
import { DOWNLOADS_EVENTS } from '../../downloads/events.js';
import { ONBOARDING_EVENTS } from '../../onboarding/events.js';
import { TOTP_EVENTS } from '../../totp/events.js';
import { AI_EVENTS } from '../../ai/events.js';
import { GSX_EVENTS } from '../../gsx/events.js';

const liteRoot = path.resolve(__dirname, '..', '..');

interface ModuleSpec {
  name: string;
  /** Files to scan for `getLoggingApi().event()` / `.start()` calls. */
  sourceFiles: string[];
  /** The typed event-name catalog. */
  events: Readonly<Record<string, string>>;
  /**
   * Catalog entries that are emitted DYNAMICALLY (template literals
   * like `kv.${op}` or `spaces.ipc.${verb}`) and therefore can't be
   * matched by the static literal scan. The declared->emitted check
   * treats any declared name starting with one of these prefixes as
   * covered. The static prefix is extracted automatically from
   * backtick template literals in the source, so this is usually
   * empty -- it's an escape hatch for prefixes the scanner can't see
   * (e.g. a prefix built up across multiple statements).
   */
  dynamicPrefixAllowlist?: string[];
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
    sourceFiles: [
      'auth/store.ts',
      'auth/main.ts',
      'auth/oauth-popup.ts',
      'auth/totp-autofill.ts',
      'auth/sso-skip.ts',
      'auth/re-signin-prompt.ts',
      'auth/window.ts',
      'auth/login-verifier.ts',
    ],
    events: AUTH_EVENTS,
    // The login-verifier emits its `auth.idw-login.*` events through an
    // injected `emit` seam (so the watcher is unit-testable with fake
    // timers), so they never appear as a literal `getLoggingApi().event(...)`
    // call the static scan can match. They ARE emitted at runtime.
    dynamicPrefixAllowlist: ['auth.idw-login.'],
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
    name: 'tools',
    sourceFiles: ['tools/store.ts', 'tools/main.ts', 'tools/menu-builder.ts'],
    events: TOOLS_EVENTS,
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
    name: 'ai-run-times',
    sourceFiles: [
      'ai-run-times/api.ts',
      'ai-run-times/store.ts',
      'ai-run-times/main.ts',
    ],
    events: AI_RUN_TIMES_EVENTS,
  },
  {
    name: 'files',
    // Files emits every op span dynamically via `files.${op}`.
    sourceFiles: ['files/sdk-client.ts', 'files/api.ts'],
    events: FILES_EVENTS,
  },
  {
    name: 'discovery',
    sourceFiles: ['discovery/store.ts', 'discovery/main.ts', 'discovery/api.ts'],
    events: DISCOVERY_EVENTS,
  },
  {
    name: 'spaces',
    // Spans live in sdk-client.ts (via `withSpan('spaces.<op>')`); IPC
    // entry events are emitted dynamically as `spaces.ipc.<verb>` by
    // the wrapper in ipc.ts.
    sourceFiles: ['spaces/sdk-client.ts', 'spaces/ipc.ts', 'spaces/main.ts', 'spaces/gsx-migration.ts'],
    events: SPACES_EVENTS,
  },
  {
    name: 'main-window',
    sourceFiles: [
      'main-window/window.ts',
      'main-window/store.ts',
      'main-window/main.ts',
    ],
    events: MAIN_WINDOW_EVENTS,
  },
  {
    name: 'event-bus',
    sourceFiles: ['event-bus/main.ts', 'event-bus/store.ts'],
    events: EVENT_BUS_EVENTS,
  },
  {
    name: 'downloads',
    sourceFiles: ['downloads/handler.ts', 'downloads/ipc.ts'],
    events: DOWNLOADS_EVENTS,
  },
  {
    name: 'onboarding',
    sourceFiles: ['onboarding/main.ts', 'onboarding/store.ts'],
    events: ONBOARDING_EVENTS,
  },
  {
    name: 'totp',
    sourceFiles: ['totp/main.ts', 'totp/api.ts', 'totp/store.ts'],
    events: TOTP_EVENTS,
  },
  {
    name: 'ai',
    // IPC entry events live in main.ts (via `AI_EVENTS.*` constant refs);
    // the enrichment span (`ai.enrich-asset`) + `ai.enrich.modality` are
    // emitted from enrich.ts.
    sourceFiles: ['ai/main.ts', 'ai/enrich.ts'],
    events: AI_EVENTS,
  },
  {
    name: 'gsx',
    // Spans + verdict/learned/invalidated events are emitted through
    // the store's injected spanEmitter/eventEmitter seams using
    // GSX_EVENTS constants; events.ts is included so the quoted
    // catalog literals count as emit sites for the static scan.
    sourceFiles: ['gsx/store.ts', 'gsx/main.ts', 'gsx/window.ts', 'gsx/events.ts'],
    events: GSX_EVENTS,
  },
];

/**
 * Extract names passed to `event()` / `start()` / `spanEmitter()` /
 * `withSpan()` calls from a source file.
 *
 * Returns three sets:
 *   - `instantNames`: literal `.event('foo.bar')` names.
 *   - `spanBaseNames`: literal span bases (`.start('foo')`,
 *     `spanEmitter('foo')`, `withSpan('foo', ...)`) -- each emits
 *     `foo.start` / `foo.finish` / `foo.fail`.
 *   - `dynamicPrefixes`: for template-literal calls like
 *     `` `spaces.ipc.${verb}` `` or `` `kv.${op}` ``, the STATIC prefix
 *     before the first `${`. Used by the declared->emitted check to
 *     cover catalog entries that are emitted dynamically.
 */
function extractEmittedNames(source: string): {
  spanBaseNames: Set<string>;
  instantNames: Set<string>;
  dynamicPrefixes: Set<string>;
  /** Every quoted string literal in the source -- catches names
   *  emitted via a local mirror-constant (e.g. sso-skip's
   *  `SSO_SKIP_EVENTS.ATTEMPT = 'auth.sso-skip.attempt'`). */
  quotedLiterals: Set<string>;
} {
  const spanBaseNames = new Set<string>();
  const instantNames = new Set<string>();
  const dynamicPrefixes = new Set<string>();
  const quotedLiterals = new Set<string>();

  // Instant-event literal call forms. Includes the callback-style
  // emitters auth uses: `emitEvent('auth.window.opened')` (window.ts)
  // and `this.eventEmitter?.('auth.session.read')` (store.ts).
  const eventRe = /\.event\s*\(\s*'([^']+)'/g;
  const emitEventRe = /\bemitEvent\??\.?\s*\(\s*'([^']+)'/g;
  const eventEmitterRe = /\beventEmitter\??\.?\s*\(\s*'([^']+)'/g;
  const startRe = /\.start\s*\(\s*'([^']+)'/g;
  const spanEmitterRe = /spanEmitter\??\.\s*\(?\s*['"]([^'"]+)['"]/g;
  // withSpan('spaces.listSpaces', ...) -- the Spaces SDK span helper.
  const withSpanRe = /withSpan\s*\(\s*'([^']+)'/g;
  // Template-literal call forms (dynamic). Capture the backtick body so
  // we can pull the static prefix before `${`.
  const eventTplRe = /\.event\s*\(\s*`([^`]+)`/g;
  const startTplRe = /\.start\s*\(\s*`([^`]+)`/g;
  const spanEmitterTplRe = /spanEmitter\??\.\s*\(?\s*`([^`]+)`/g;
  const withSpanTplRe = /withSpan\s*\(\s*`([^`]+)`/g;
  // All single-quoted string literals (for the mirror-constant case).
  const anyQuotedRe = /'([^'\n]+)'/g;

  let m: RegExpExecArray | null;
  const isStatic = (name: string): boolean => !name.includes('${');
  /** Static text before the first `${` (e.g. `kv.${op}` -> `kv.`). */
  const staticPrefixOf = (tpl: string): string => {
    const idx = tpl.indexOf('${');
    return idx < 0 ? tpl : tpl.slice(0, idx);
  };

  for (const re of [eventRe, emitEventRe, eventEmitterRe]) {
    while ((m = re.exec(source)) !== null) {
      if (m[1] !== undefined && isStatic(m[1])) instantNames.add(m[1]);
    }
  }
  for (const re of [startRe, spanEmitterRe, withSpanRe]) {
    while ((m = re.exec(source)) !== null) {
      if (m[1] !== undefined && isStatic(m[1])) spanBaseNames.add(m[1]);
    }
  }
  for (const re of [eventTplRe, startTplRe, spanEmitterTplRe, withSpanTplRe]) {
    while ((m = re.exec(source)) !== null) {
      if (m[1] === undefined) continue;
      const prefix = staticPrefixOf(m[1]);
      // Trim a trailing '.' so `kv.` and `kv` both match `kv.set...`.
      if (prefix.length > 0) dynamicPrefixes.add(prefix.replace(/\.$/, ''));
    }
  }
  while ((m = anyQuotedRe.exec(source)) !== null) {
    if (m[1] !== undefined && isStatic(m[1])) quotedLiterals.add(m[1]);
  }
  return { spanBaseNames, instantNames, dynamicPrefixes, quotedLiterals };
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

      it('every typed constant is actually emitted somewhere (no dead catalog entries)', () => {
        // Aggregate all emission coverage across the module's source.
        const instant = new Set<string>();
        const spanBases = new Set<string>();
        const quoted = new Set<string>();
        const dynamicPrefixes = new Set<string>(mod.dynamicPrefixAllowlist ?? []);
        // The catalog constant name (e.g. IDW_EVENTS) -- emit sites
        // very often reference `IDW_EVENTS.CHANGED` rather than the
        // literal `'idw.changed'`, so we also treat a constant-key
        // reference as proof of emission.
        const constName = `${mod.name.toUpperCase().replace(/-/g, '_')}_EVENTS`;
        const referencedKeys = new Set<string>();
        const catalogKeys = Object.keys(mod.events);
        let combinedSource = '';
        for (const relPath of mod.sourceFiles) {
          const filePath = path.join(liteRoot, relPath);
          if (!fs.existsSync(filePath)) continue;
          const source = fs.readFileSync(filePath, 'utf-8');
          combinedSource += source + '\n';
          const extracted = extractEmittedNames(source);
          extracted.instantNames.forEach((n) => instant.add(n));
          extracted.spanBaseNames.forEach((n) => spanBases.add(n));
          extracted.dynamicPrefixes.forEach((p) => dynamicPrefixes.add(p));
          extracted.quotedLiterals.forEach((n) => quoted.add(n));
        }

        // Span-triple inference: a span always emits `.start` AND one
        // of `.finish`/`.fail`. So if a catalog's `<base>.start` is
        // covered by any means, treat `<base>.finish` / `<base>.fail`
        // as covered too. Handles the discovery pattern
        // `spanEmitter(DISCOVERY_EVENTS.RESOLVE_START.replace(/\.start$/,''))`
        // where only the START constant is referenced literally.
        const coveredStartBases = new Set<string>();
        for (const key of catalogKeys) {
          // Word-boundary match so KEY doesn't match KEY_LONGER.
          const re = new RegExp(`${constName}\\.${key}\\b`);
          if (re.test(combinedSource)) referencedKeys.add(key);
        }

        // A declared name is "directly emitted" if ANY of:
        //   - its constant key is referenced (`IDW_EVENTS.CHANGED`), OR
        //   - it's a literal instant emission, OR
        //   - it's a span suffix whose base was passed to
        //     start/spanEmitter/withSpan, OR
        //   - it falls under a dynamically-emitted prefix (`kv.${op}`), OR
        //   - it appears as a quoted literal anywhere in the scanned
        //     source (covers local mirror-constants like sso-skip's
        //     SSO_SKIP_EVENTS).
        const isDirect = (key: string, value: string): boolean => {
          if (referencedKeys.has(key)) return true;
          if (instant.has(value)) return true;
          if (quoted.has(value)) return true;
          const spanMatch = value.match(/^(.*)\.(start|finish|fail)$/);
          if (spanMatch !== null && spanMatch[1] !== undefined && spanBases.has(spanMatch[1])) {
            return true;
          }
          for (const prefix of dynamicPrefixes) {
            if (value === prefix || value.startsWith(`${prefix}.`)) return true;
          }
          return false;
        };

        // First pass: record which span bases have a covered `.start`.
        for (const value of Object.values(mod.events)) {
          const startMatch = value.match(/^(.*)\.start$/);
          if (startMatch !== null && startMatch[1] !== undefined) {
            // Find the catalog key for this start value to check direct coverage.
            const startKey = catalogKeys.find((k) => mod.events[k] === value);
            if (startKey !== undefined && isDirect(startKey, value)) {
              coveredStartBases.add(startMatch[1]);
            }
          }
        }

        const isCovered = (key: string, value: string): boolean => {
          if (isDirect(key, value)) return true;
          // Span-triple inference for `.finish` / `.fail`.
          const tail = value.match(/^(.*)\.(finish|fail)$/);
          if (tail !== null && tail[1] !== undefined && coveredStartBases.has(tail[1])) {
            return true;
          }
          return false;
        };

        const dead: string[] = [];
        for (const [key, value] of Object.entries(mod.events)) {
          if (!isCovered(key, value)) dead.push(value);
        }
        expect(
          dead,
          `module "${mod.name}" declares event names in its catalog that are NEVER emitted ` +
            `(dead entries -- either wire up the emission or remove the constant):\n` +
            dead.map((d) => `  - ${d}`).join('\n')
        ).toHaveLength(0);
      });
    });
  }
});
