/**
 * UniversityApi tests.
 *
 * Structured per Rule 12 / HARNESS.md:
 *   1. `runApiConformanceContract` -- the uniform contract every
 *      module passes (singleton, reset, set-for-testing, expected
 *      methods).
 *   2. `runErrorConformanceContract` -- the UniversityError class
 *      threads code/message/context/remediation/cause through
 *      `LiteError` correctly and codes are namespaced `UNIV_`.
 *   3. Module-specific behavior tests using injected stubs.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getUniversityApi,
  _resetUniversityApiForTesting,
  _setUniversityApiForTesting,
  resolveEntryStrict,
  UniversityError,
  UNIVERSITY_ERROR_CODES,
  UNIVERSITY_EVENTS,
  isUniversityEvent,
  type UniversityApi,
  type UniversityErrorCode,
} from '../../university/api.js';
import { runApiConformanceContract } from '../harness/api-conformance.js';
import { runErrorConformanceContract } from '../harness/error-conformance.js';

// 1. Public-surface conformance contract.
runApiConformanceContract<UniversityApi>({
  name: 'UniversityApi',
  getInstance: getUniversityApi,
  resetForTesting: _resetUniversityApiForTesting,
  setForTesting: _setUniversityApiForTesting,
  expectedMethods: ['list', 'listByKind', 'get', 'onEvent'],
});

// 2. Error class conformance contract.
runErrorConformanceContract<UniversityError>({
  name: 'UniversityError',
  ErrorClass: UniversityError,
  codeEnum: UNIVERSITY_ERROR_CODES,
  modulePrefix: 'UNIV_',
  constructErrorWithCode: (code) =>
    new UniversityError({
      code: code as UniversityErrorCode,
      message: 'sample',
      context: { op: 'sample' },
    }),
});

// 3. Module-specific behavior tests.

describe('UniversityApi default implementation', () => {
  beforeEach(() => {
    _resetUniversityApiForTesting();
  });

  it('list() returns the curated catalog', async () => {
    const entries = await getUniversityApi().list();
    expect(entries.length).toBeGreaterThan(0);
    const ids = entries.map((e) => e.id).sort();
    // Must include all the menu-bound items.
    expect(ids).toContain('lms');
    expect(ids).toContain('getting-started');
    expect(ids).toContain('first-agent');
    expect(ids).toContain('workflow-basics');
    expect(ids).toContain('api-integration');
    expect(ids).toContain('ai-run-times');
    expect(ids).toContain('wiser-method');
  });

  it('listByKind returns only matching entries', async () => {
    const courses = await getUniversityApi().listByKind('course');
    expect(courses.length).toBeGreaterThan(0);
    expect(courses.every((e) => e.kind === 'course')).toBe(true);
    const lms = await getUniversityApi().listByKind('lms');
    expect(lms.map((e) => e.id)).toContain('lms');
  });

  it('get returns null for unknown ids', async () => {
    expect(await getUniversityApi().get('does-not-exist')).toBeNull();
  });

  it('get returns the entry for a known id', async () => {
    const entry = await getUniversityApi().get('first-agent');
    expect(entry?.title).toBe('Building Your First Agent');
    expect(entry?.kind).toBe('course');
  });

  it('every curated entry has http(s) URL, non-empty title + description', async () => {
    const entries = await getUniversityApi().list();
    for (const entry of entries) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.url).toMatch(/^https?:\/\//);
    }
  });

  it('isUniversityEvent narrows arbitrary EventRecord by name', () => {
    for (const name of Object.values(UNIVERSITY_EVENTS)) {
      expect(
        isUniversityEvent({
          id: '1',
          timestamp: 't',
          name,
          level: 'info',
          category: 'university',
        })
      ).toBe(true);
    }
    expect(
      isUniversityEvent({
        id: '1',
        timestamp: 't',
        name: 'kv.set.start',
        level: 'info',
        category: 'kv',
      })
    ).toBe(false);
  });
});

describe('resolveEntryStrict', () => {
  it('returns the entry for a known id', () => {
    const entry = resolveEntryStrict('lms');
    expect(entry.title).toBe('Open LMS');
  });

  it('throws UNIV_NOT_FOUND for unknown ids', () => {
    expect(() => resolveEntryStrict('nope')).toThrow(UniversityError);
    try {
      resolveEntryStrict('nope');
    } catch (err) {
      expect(err).toBeInstanceOf(UniversityError);
      const e = err as UniversityError;
      expect(e.code).toBe(UNIVERSITY_ERROR_CODES.NOT_FOUND);
    }
  });
});

describe('_setUniversityApiForTesting overrides the singleton', () => {
  beforeEach(() => {
    _resetUniversityApiForTesting();
  });

  it('returned instance is returned by subsequent getUniversityApi calls', () => {
    const stub: UniversityApi = {
      list: vi.fn().mockResolvedValue([]),
      listByKind: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      onEvent: vi.fn().mockReturnValue(() => undefined),
    };
    _setUniversityApiForTesting(stub);
    expect(getUniversityApi()).toBe(stub);
  });
});
