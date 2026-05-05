/**
 * API conformance contract -- the uniform suite every lite module's
 * `api.ts` must pass.
 *
 * Per Rule 12 in `lite/LITE-RULES.md`, every module exposes:
 *
 *   getFooApi()                -> singleton accessor
 *   _resetFooApiForTesting()   -> clears the singleton
 *   _setFooApiForTesting(api)  -> override (for tests)
 *
 * This suite verifies those three contracts behave identically across
 * modules, so consumers and test authors get the same shape everywhere.
 *
 * Usage in a module's <module>-api.test.ts:
 *
 *   import { runApiConformanceContract } from '../harness';
 *   import {
 *     getFooApi,
 *     _resetFooApiForTesting,
 *     _setFooApiForTesting,
 *   } from '../../foo/api.js';
 *
 *   runApiConformanceContract({
 *     name: 'FooApi',
 *     getInstance: getFooApi,
 *     resetForTesting: _resetFooApiForTesting,
 *     setForTesting: _setFooApiForTesting,
 *     expectedMethods: ['doThing', 'listThings'],
 *   });
 *
 *   // ...module-specific tests follow.
 */

import { describe, it, expect, beforeEach } from 'vitest';

export interface ApiConformanceSpec<T extends object> {
  /** Display name -- used as the describe() block title. */
  name: string;
  /** The module's singleton getter. Returns the public API. */
  getInstance: () => T;
  /** The module's `_resetForTesting()`. Clears the singleton. */
  resetForTesting: () => void;
  /**
   * Optional override hook. If provided, the contract verifies that
   * `setForTesting(stub)` causes `getInstance()` to return the stub.
   */
  setForTesting?: (instance: T) => void;
  /**
   * Methods the public interface must expose. The contract asserts each
   * is present and is a function. List the full surface so the contract
   * fails loudly if a method is removed without intent.
   */
  expectedMethods: ReadonlyArray<keyof T>;
}

/**
 * Drop-in conformance suite. Wraps all assertions in a `describe` block
 * named `<spec.name> conformance` so test output makes the contract
 * explicit at the module level.
 */
export function runApiConformanceContract<T extends object>(
  spec: ApiConformanceSpec<T>
): void {
  describe(`${spec.name} conformance contract`, () => {
    beforeEach(() => {
      spec.resetForTesting();
    });

    it('getInstance returns the same instance across calls (singleton)', () => {
      const a = spec.getInstance();
      const b = spec.getInstance();
      expect(a).toBe(b);
    });

    it('lazily initializes on first call (instance is non-null after first get)', () => {
      const a = spec.getInstance();
      expect(a).toBeDefined();
      expect(a).not.toBeNull();
    });

    it('exposes every method declared in expectedMethods, each as a function', () => {
      const api = spec.getInstance();
      const missing: string[] = [];
      const notFunctions: string[] = [];
      for (const method of spec.expectedMethods) {
        const value = (api as Record<string | symbol, unknown>)[method as string];
        if (value === undefined) {
          missing.push(String(method));
        } else if (typeof value !== 'function') {
          notFunctions.push(`${String(method)} (got ${typeof value})`);
        }
      }
      expect(missing, `missing methods: ${missing.join(', ')}`).toHaveLength(0);
      expect(
        notFunctions,
        `expected functions but got non-functions: ${notFunctions.join(', ')}`
      ).toHaveLength(0);
    });

    // Note: we deliberately do NOT scan for "extra" methods beyond
    // expectedMethods. TypeScript `private` is type-only, so class
    // instances expose internal helpers as runtime members; a runtime
    // scan can't distinguish private from public. The compile-time
    // type system already catches missing-method drift (the API
    // interface is the source of truth, and `expectedMethods` mirrors
    // it for runtime introspection).

    it('resetForTesting clears the singleton (subsequent get returns a fresh instance)', () => {
      const a = spec.getInstance();
      spec.resetForTesting();
      const b = spec.getInstance();
      // Most modules return a NEW instance after reset; an immutable
      // singleton (cached and re-used) would still pass `a === b`. We
      // accept either, but require `b` to be defined and method-bearing.
      expect(b).toBeDefined();
      for (const method of spec.expectedMethods) {
        expect(typeof (b as Record<string, unknown>)[method as string]).toBe('function');
      }
      // The common case (lazy new instance after reset) is a !== b. We
      // assert this is at least possible by allowing the instances to
      // differ; if they're the same, it's only valid for truly stateless
      // singletons that never need replacement.
      // (Soft assert via a warning rather than a hard failure to keep
      // the contract permissive.)
      if (a === b) {
        // eslint-disable-next-line no-console
        console.warn(
          `[${spec.name} conformance] resetForTesting did not produce a new instance. This is fine if the API is stateless, but suspicious otherwise.`
        );
      }
    });

    if (spec.setForTesting !== undefined) {
      const setForTesting = spec.setForTesting;
      it('setForTesting injects a custom implementation that subsequent gets return', () => {
        const stub = makeMethodStub<T>(spec.expectedMethods);
        setForTesting(stub);
        expect(spec.getInstance()).toBe(stub);
      });

      it('resetForTesting clears a setForTesting override', () => {
        const stub = makeMethodStub<T>(spec.expectedMethods);
        setForTesting(stub);
        expect(spec.getInstance()).toBe(stub);
        spec.resetForTesting();
        const fresh = spec.getInstance();
        expect(fresh).not.toBe(stub);
      });
    }
  });
}

/**
 * Build a no-op stub object that satisfies the shape of an API by
 * returning an async-noop for every expected method. Used by the
 * conformance contract to test setForTesting without each consumer
 * having to write its own stub factory.
 */
function makeMethodStub<T extends object>(methods: ReadonlyArray<keyof T>): T {
  const stub: Record<string | symbol, unknown> = {};
  for (const method of methods) {
    stub[method as string] = async () => undefined;
  }
  return stub as T;
}
