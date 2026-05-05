/**
 * Translator rule-table tests.
 *
 * Each rule has a deterministic input -> output projection. We
 * exhaustively walk every rule with a synthetic raw EventRecord and
 * assert the projected name + key fields. Catches:
 *   - dropped translation when raw event shape changes
 *   - orphan rules (no matching raw name)
 *   - orphan domain events (no rule produces them)
 */

import { describe, it, expect } from 'vitest';
import { translate, TRANSLATOR_RULES } from '../../event-bus/translator.js';
import { DOMAIN_EVENT_NAMES } from '../../event-bus/types.js';
import type { EventRecord } from '../../logging/events.js';

function makeRaw(name: string, data?: unknown): EventRecord {
  return {
    id: 'raw-1',
    timestamp: '2026-05-05T00:00:00.000Z',
    name,
    category: name.split('.')[0] ?? '',
    level: 'info',
    ...(data !== undefined ? { data } : {}),
  };
}

describe('translator: known projections', () => {
  it('auth.signIn.finish -> user.signed-in', () => {
    const out = translate(
      makeRaw('auth.signIn.finish', {
        env: 'edison',
        accountId: '05bd3c92-5d3c-4dc5-a95d-0c584695cea4',
        email: 'alice@example.com',
      })
    );
    expect(out).not.toBeNull();
    expect(out?.event.name).toBe('user.signed-in');
    expect(out?.event.data).toMatchObject({
      env: 'edison',
      accountId: '05bd3c92-5d3c-4dc5-a95d-0c584695cea4',
      email: 'alice@example.com',
    });
  });

  it('auth.signIn.finish without accountId returns null', () => {
    const out = translate(makeRaw('auth.signIn.finish', { env: 'edison' }));
    expect(out).toBeNull();
  });

  it('auth.signOut.finish -> user.signed-out', () => {
    const out = translate(
      makeRaw('auth.signOut.finish', { env: 'edison', hadSession: true })
    );
    expect(out?.event.name).toBe('user.signed-out');
    expect(out?.event.data).toEqual({ env: 'edison' });
  });

  it('main-window.open-tab.finish wasFocus=false -> agent.tab.opened', () => {
    const out = translate(
      makeRaw('main-window.open-tab.finish', { id: 'tab-abc', wasFocus: false })
    );
    expect(out?.event.name).toBe('agent.tab.opened');
    expect(out?.event.data).toMatchObject({ tabId: 'tab-abc' });
  });

  it('main-window.open-tab.finish wasFocus=true -> agent.tab.focused', () => {
    const out = translate(
      makeRaw('main-window.open-tab.finish', { id: 'tab-abc', wasFocus: true })
    );
    expect(out?.event.name).toBe('agent.tab.focused');
    expect(out?.event.data).toMatchObject({ tabId: 'tab-abc' });
  });

  it('main-window.close-tab.finish -> agent.tab.closed', () => {
    const out = translate(makeRaw('main-window.close-tab.finish', { id: 'tab-x' }));
    expect(out?.event.name).toBe('agent.tab.closed');
  });

  it('main-window.activate-tab.finish -> agent.tab.activated', () => {
    const out = translate(
      makeRaw('main-window.activate-tab.finish', { id: 'tab-x' })
    );
    expect(out?.event.name).toBe('agent.tab.activated');
  });

  it('auth.inject-token.finish injected=true -> token.injected', () => {
    const out = translate(
      makeRaw('auth.inject-token.finish', {
        injected: true,
        env: 'edison',
        partitionPrefix: 'persist:tab-abc',
      })
    );
    expect(out?.event.name).toBe('token.injected');
    expect(out?.event.data).toMatchObject({ env: 'edison' });
  });

  it('auth.inject-token.finish injected=false returns null', () => {
    const out = translate(
      makeRaw('auth.inject-token.finish', { injected: false, env: 'edison', reason: 'expired' })
    );
    expect(out).toBeNull();
  });

  it('updater.update-available -> update.available', () => {
    const out = translate(makeRaw('updater.update-available', { version: '1.2.3' }));
    expect(out?.event.name).toBe('update.available');
    expect(out?.event.data).toEqual({ version: '1.2.3' });
  });

  it('updater.update-downloaded -> update.downloaded', () => {
    const out = translate(makeRaw('updater.update-downloaded', { version: '1.2.3' }));
    expect(out?.event.name).toBe('update.downloaded');
  });

  it('idw.store.installed -> idw.installed', () => {
    const out = translate(
      makeRaw('idw.store.installed', {
        id: 'agent-marvin',
        kind: 'idw',
        catalogId: 'idw:marvin-2',
      })
    );
    expect(out?.event.name).toBe('idw.installed');
    expect(out?.event.data).toMatchObject({ id: 'agent-marvin', kind: 'idw' });
  });

  it('bug-report.save.finish -> bug-report.submitted', () => {
    const out = translate(
      makeRaw('bug-report.save.finish', {
        filePath: '/tmp/bug.json',
        redactionBucket: 'low',
      })
    );
    expect(out?.event.name).toBe('bug-report.submitted');
  });
});

describe('translator: invariants', () => {
  it('every domain event name has at least one rule', () => {
    const ruleTargetNames = new Set<string>();
    for (const rule of TRANSLATOR_RULES) {
      const target = rule.id.split('->')[1] ?? '';
      ruleTargetNames.add(target);
    }
    for (const domainName of DOMAIN_EVENT_NAMES) {
      expect(
        ruleTargetNames.has(domainName),
        `domain event ${domainName} has no translator rule`
      ).toBe(true);
    }
  });

  it('every rule id is unique', () => {
    const ids = TRANSLATOR_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('translate() returns null for unrelated events', () => {
    expect(translate(makeRaw('kv.set.start', {}))).toBeNull();
    expect(translate(makeRaw('logging.recent', {}))).toBeNull();
  });
});
