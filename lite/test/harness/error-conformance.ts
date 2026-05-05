/**
 * Error conformance contract -- the uniform suite every lite module's
 * error class must pass.
 *
 * Per Rule 12 in `lite/LITE-RULES.md`, every module that throws errors
 * defines:
 *
 *   FOO_ERROR_CODES = { ... } as const   // stable, namespaced codes
 *   class FooError extends LiteError     // subclass for instanceof checks
 *
 * This suite verifies:
 *   - Every code value follows the `<MODULE_PREFIX>_<WHAT>` convention.
 *   - Instances of the class are also `LiteError` instances.
 *   - The class populates standard fields (`code`, `message`, `context`,
 *     `remediation`, `cause`) correctly.
 *   - Formatters (`formatForLog`, `formatForUser`, `toJSON`) emit the
 *     expected shape and contain the code.
 *
 * Usage:
 *
 *   import { runErrorConformanceContract } from '../harness';
 *   import { KVError, KV_ERROR_CODES } from '../../kv/api.js';
 *
 *   runErrorConformanceContract({
 *     name: 'KVError',
 *     ErrorClass: KVError,
 *     codeEnum: KV_ERROR_CODES,
 *     modulePrefix: 'KV_',
 *     constructErrorWithCode: (code) => new KVError({
 *       code: code as never,
 *       message: 'sample',
 *       context: { op: 'sample' },
 *     }),
 *   });
 */

import { describe, it, expect } from 'vitest';
import { LiteError } from '../../errors.js';

export interface ErrorConformanceSpec<T extends LiteError> {
  /** Display name -- used as the describe() block title. */
  name: string;
  /**
   * The constructor of the module's error subclass. Used only for
   * `instanceof` checks; instances are produced via
   * `constructErrorWithCode` because each module's error has its own
   * options shape.
   */
  ErrorClass: new (...args: never[]) => T;
  /**
   * The exported code enum / record. Every value is a string and every
   * value must start with `modulePrefix`.
   */
  codeEnum: Readonly<Record<string, string>>;
  /**
   * Required namespace prefix for every code. E.g. `KV_` for KV-module
   * errors. Verifies `<MODULE>_<WHAT>` convention.
   */
  modulePrefix: string;
  /**
   * Factory that constructs a sample error given a code. Each module's
   * error class has a different options shape, so the harness asks the
   * caller to make one. The returned instance is used to verify the
   * standard `LiteError` fields populate correctly.
   */
  constructErrorWithCode: (code: string) => T;
}

export function runErrorConformanceContract<T extends LiteError>(
  spec: ErrorConformanceSpec<T>
): void {
  describe(`${spec.name} conformance contract`, () => {
    it('every code in the enum starts with the module prefix', () => {
      const violations: Array<{ name: string; value: string }> = [];
      for (const [enumName, value] of Object.entries(spec.codeEnum)) {
        if (typeof value !== 'string') {
          violations.push({ name: enumName, value: String(value) });
          continue;
        }
        if (!value.startsWith(spec.modulePrefix)) {
          violations.push({ name: enumName, value });
        }
      }
      expect(
        violations,
        `codes missing prefix "${spec.modulePrefix}": ${JSON.stringify(violations)}`
      ).toHaveLength(0);
    });

    it('codes use SCREAMING_SNAKE_CASE after the prefix', () => {
      const pattern = new RegExp(`^${spec.modulePrefix}[A-Z][A-Z0-9_]*$`);
      const violations: string[] = [];
      for (const value of Object.values(spec.codeEnum)) {
        if (typeof value === 'string' && !pattern.test(value)) {
          violations.push(value);
        }
      }
      expect(
        violations,
        `codes don't match SCREAMING_SNAKE convention: ${violations.join(', ')}`
      ).toHaveLength(0);
    });

    it('the enum is non-empty (a module without codes is suspicious)', () => {
      expect(Object.keys(spec.codeEnum).length).toBeGreaterThan(0);
    });

    it('an instance is both ErrorClass and LiteError', () => {
      const sampleCode = firstCode(spec.codeEnum);
      const err = spec.constructErrorWithCode(sampleCode);
      expect(err).toBeInstanceOf(spec.ErrorClass);
      expect(err).toBeInstanceOf(LiteError);
      expect(err).toBeInstanceOf(Error);
    });

    it('populates the standard LiteError fields', () => {
      const sampleCode = firstCode(spec.codeEnum);
      const err = spec.constructErrorWithCode(sampleCode);
      expect(err.code).toBe(sampleCode);
      expect(typeof err.message).toBe('string');
      expect(err.message.length).toBeGreaterThan(0);
      expect(typeof err.context).toBe('object');
      expect(typeof err.remediation).toBe('string');
      expect(err.remediation.length).toBeGreaterThan(0);
    });

    it('freezes the context object so callers cannot mutate after construction', () => {
      const sampleCode = firstCode(spec.codeEnum);
      const err = spec.constructErrorWithCode(sampleCode);
      expect(() => {
        (err.context as Record<string, unknown>)['__test'] = 'x';
      }).toThrow();
    });

    it('formatForLog includes the code in brackets and the message', () => {
      const sampleCode = firstCode(spec.codeEnum);
      const err = spec.constructErrorWithCode(sampleCode);
      const log = err.formatForLog();
      expect(log).toContain(`[${sampleCode}]`);
      expect(log).toContain(err.message);
    });

    it('formatForUser returns a non-empty string', () => {
      const sampleCode = firstCode(spec.codeEnum);
      const err = spec.constructErrorWithCode(sampleCode);
      const user = err.formatForUser();
      expect(typeof user).toBe('string');
      expect(user.length).toBeGreaterThan(0);
    });

    it('toJSON serializes the code and message and a context object', () => {
      const sampleCode = firstCode(spec.codeEnum);
      const err = spec.constructErrorWithCode(sampleCode);
      const json = err.toJSON();
      expect(json.code).toBe(sampleCode);
      expect(json.message).toBe(err.message);
      expect(typeof json.context).toBe('object');
      expect(typeof json.remediation).toBe('string');
    });

    it('every code in the enum can be used to construct a valid instance', () => {
      const failures: Array<{ code: string; error: string }> = [];
      for (const code of Object.values(spec.codeEnum)) {
        if (typeof code !== 'string') continue;
        try {
          const err = spec.constructErrorWithCode(code);
          if (err.code !== code) {
            failures.push({ code, error: `code mismatch: got ${err.code}` });
          }
        } catch (e) {
          failures.push({ code, error: (e as Error).message });
        }
      }
      expect(
        failures,
        `failed to construct error from codes: ${JSON.stringify(failures)}`
      ).toHaveLength(0);
    });
  });
}

function firstCode(codeEnum: Readonly<Record<string, string>>): string {
  const value = Object.values(codeEnum).find((v): v is string => typeof v === 'string');
  if (value === undefined) {
    throw new Error('error conformance contract: codeEnum has no string values');
  }
  return value;
}
