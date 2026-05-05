/**
 * EventBusApi tests.
 *
 * Mirrors the structure of every other module's `<module>-api.test.ts`:
 *   1. `runApiConformanceContract` -- the uniform contract every module
 *      passes (singleton, reset, set-for-testing, expected methods).
 *   2. `runErrorConformanceContract` -- EventBusError threads
 *      code/message/context/remediation through `LiteError` and codes
 *      are namespaced `EB_`.
 *   3. Module-specific behavior tests using injected stubs.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getEventBusApi,
  _resetEventBusApiForTesting,
  _setEventBusApiForTesting,
  EventBusError,
  EVENT_BUS_ERROR_CODES,
  EVENT_BUS_EVENTS,
  isEventBusEvent,
  DOMAIN_EVENT_NAMES,
  type EventBusApi,
  type EventBusErrorCode,
  type DomainEvent,
} from '../../event-bus/api.js';
import { runApiConformanceContract } from '../harness/api-conformance.js';
import { runErrorConformanceContract } from '../harness/error-conformance.js';

// 1. Public-surface conformance contract.
runApiConformanceContract<EventBusApi>({
  name: 'EventBusApi',
  getInstance: getEventBusApi,
  resetForTesting: _resetEventBusApiForTesting,
  setForTesting: _setEventBusApiForTesting,
  expectedMethods: ['on', 'onPattern', 'recent', 'size', 'emit', 'onEvent'],
});

// 2. Error class conformance contract.
runErrorConformanceContract<EventBusError>({
  name: 'EventBusError',
  ErrorClass: EventBusError,
  codeEnum: EVENT_BUS_ERROR_CODES,
  modulePrefix: 'EB_',
  constructErrorWithCode: (code) =>
    new EventBusError({
      code: code as EventBusErrorCode,
      message: 'sample',
      context: { op: 'sample' },
    }),
});

// 3. Module-specific behavior tests.

describe('EventBusApi event surface', () => {
  beforeEach(() => {
    _resetEventBusApiForTesting();
  });

  it('isEventBusEvent narrows arbitrary EventRecord by name', () => {
    const goodNames = Object.values(EVENT_BUS_EVENTS);
    for (const name of goodNames) {
      expect(
        isEventBusEvent({
          id: '1',
          timestamp: 't',
          name,
          level: 'info',
          category: 'event-bus',
        })
      ).toBe(true);
    }
    expect(
      isEventBusEvent({
        id: '1',
        timestamp: 't',
        name: 'kv.set.start',
        level: 'info',
        category: 'kv',
      })
    ).toBe(false);
  });

  it('EVENT_BUS_EVENTS contains the expected operational events', () => {
    const names = Object.values(EVENT_BUS_EVENTS);
    expect(names).toContain('event-bus.translated');
    expect(names).toContain('event-bus.persist.ok');
    expect(names).toContain('event-bus.persist.fail');
    expect(names).toContain('event-bus.hydrate.start');
    expect(names).toContain('event-bus.hydrate.finish');
    expect(names).toContain('event-bus.hydrate.fail');
  });

  it('DOMAIN_EVENT_NAMES exposes every union member', () => {
    expect(DOMAIN_EVENT_NAMES).toContain('user.signed-in');
    expect(DOMAIN_EVENT_NAMES).toContain('user.signed-out');
    expect(DOMAIN_EVENT_NAMES).toContain('agent.tab.opened');
    expect(DOMAIN_EVENT_NAMES).toContain('agent.tab.closed');
    expect(DOMAIN_EVENT_NAMES).toContain('agent.tab.activated');
    expect(DOMAIN_EVENT_NAMES).toContain('agent.tab.focused');
    expect(DOMAIN_EVENT_NAMES).toContain('token.injected');
    expect(DOMAIN_EVENT_NAMES).toContain('update.available');
    expect(DOMAIN_EVENT_NAMES).toContain('update.downloaded');
    expect(DOMAIN_EVENT_NAMES).toContain('idw.installed');
    expect(DOMAIN_EVENT_NAMES).toContain('bug-report.submitted');
  });

  it('every translator rule emits a name in DOMAIN_EVENT_NAMES', async () => {
    const { TRANSLATOR_RULES } = await import('../../event-bus/translator.js');
    // Each rule's id is `<rawName>-><domainName>`; we parse the target
    // and assert it's in the catalogue.
    const knownNames = new Set(DOMAIN_EVENT_NAMES);
    for (const rule of TRANSLATOR_RULES) {
      const target = rule.id.split('->')[1] ?? '';
      expect(knownNames.has(target as DomainEvent['name']), `rule ${rule.id} target not in catalogue`).toBe(true);
    }
  });
});

describe('_setEventBusApiForTesting overrides the singleton', () => {
  beforeEach(() => {
    _resetEventBusApiForTesting();
  });

  it('returned instance is returned by subsequent getEventBusApi calls', () => {
    const stub: EventBusApi = {
      on: vi.fn().mockReturnValue(() => undefined),
      onPattern: vi.fn().mockReturnValue(() => undefined),
      recent: vi.fn().mockReturnValue([]),
      size: vi.fn().mockReturnValue(0),
      emit: vi.fn().mockImplementation((event) => ({
        ...event,
        id: 'stub-id',
        ts: '2026-01-01T00:00:00.000Z',
      })),
      onEvent: vi.fn().mockReturnValue(() => undefined),
    };
    _setEventBusApiForTesting(stub);
    expect(getEventBusApi()).toBe(stub);
  });
});
