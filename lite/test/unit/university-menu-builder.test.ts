/**
 * Agentic University menu-builder tests.
 *
 * Drives initMenuBuilder against the real menu registry. Verifies:
 *   - top:university is registered with order 80 on init.
 *   - Open LMS, Quick Starts (parent), 4 course items under Quick
 *     Starts, and AI Run Times are all registered.
 *   - Click handlers route to the right callback.
 *   - Teardown removes everything.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registry } from '../../menu/registry.js';
import {
  initMenuBuilder,
  teardownMenuBuilder,
  TOP_LEVEL_ID,
  QUICK_STARTS_ID,
  OPEN_LMS_ID,
  VIEW_ALL_TUTORIALS_ID,
  AI_RUN_TIMES_ID,
  _getDynamicIdsForTesting,
} from '../../university/menu-builder.js';

const handlers = {
  onOpenEntry: vi.fn(),
  onOpenTutorials: vi.fn(),
};

beforeEach(() => {
  registry._resetForTesting();
  teardownMenuBuilder();
  for (const fn of Object.values(handlers)) (fn as ReturnType<typeof vi.fn>).mockReset();
});

describe('initMenuBuilder', () => {
  it('registers top:university with order 80', () => {
    initMenuBuilder(handlers);
    const top = registry.get(TOP_LEVEL_ID);
    expect(top).toBeDefined();
    expect(top?.type).toBe('top-level');
    expect(top?.label).toBe('Agentic University');
    expect(top?.order).toBe(80);
  });

  it('registers Open LMS and AI Run Times as direct children', () => {
    initMenuBuilder(handlers);
    expect(registry.has(OPEN_LMS_ID)).toBe(true);
    expect(registry.get(OPEN_LMS_ID)?.parentId).toBe(TOP_LEVEL_ID);
    expect(registry.has(AI_RUN_TIMES_ID)).toBe(true);
    expect(registry.get(AI_RUN_TIMES_ID)?.parentId).toBe(TOP_LEVEL_ID);
  });

  it('registers Quick Starts as a parent item with View All Tutorials + 4 courses', () => {
    initMenuBuilder(handlers);
    const qs = registry.get(QUICK_STARTS_ID);
    expect(qs).toBeDefined();
    expect(qs?.parentId).toBe(TOP_LEVEL_ID);

    expect(registry.has(VIEW_ALL_TUTORIALS_ID)).toBe(true);
    expect(registry.get(VIEW_ALL_TUTORIALS_ID)?.parentId).toBe(QUICK_STARTS_ID);

    for (const id of [
      'university:quick-starts:getting-started',
      'university:quick-starts:first-agent',
      'university:quick-starts:workflow-basics',
      'university:quick-starts:api-integration',
    ]) {
      const item = registry.get(id);
      expect(item, `expected ${id} registered`).toBeDefined();
      expect(item?.parentId).toBe(QUICK_STARTS_ID);
    }
  });
});

describe('click routing', () => {
  it('Open LMS click routes to onOpenEntry with the lms entry', () => {
    initMenuBuilder(handlers);
    registry.get(OPEN_LMS_ID)?.click?.();
    expect(handlers.onOpenEntry).toHaveBeenCalledTimes(1);
    const arg = handlers.onOpenEntry.mock.calls[0]?.[0];
    expect((arg as { id: string } | undefined)?.id).toBe('lms');
  });

  it('AI Run Times click routes to onOpenEntry with the ai-run-times entry', () => {
    initMenuBuilder(handlers);
    registry.get(AI_RUN_TIMES_ID)?.click?.();
    expect(handlers.onOpenEntry).toHaveBeenCalledTimes(1);
    const arg = handlers.onOpenEntry.mock.calls[0]?.[0];
    expect((arg as { id: string } | undefined)?.id).toBe('ai-run-times');
  });

  it('View All Tutorials click routes to onOpenTutorials', () => {
    initMenuBuilder(handlers);
    registry.get(VIEW_ALL_TUTORIALS_ID)?.click?.();
    expect(handlers.onOpenTutorials).toHaveBeenCalledTimes(1);
  });

  it('Quick Starts course click routes to onOpenEntry with that course', () => {
    initMenuBuilder(handlers);
    registry.get('university:quick-starts:first-agent')?.click?.();
    expect(handlers.onOpenEntry).toHaveBeenCalledTimes(1);
    const arg = handlers.onOpenEntry.mock.calls[0]?.[0];
    expect((arg as { id: string } | undefined)?.id).toBe('first-agent');
  });
});

describe('teardown', () => {
  it('unregisters every entry the menu installed', () => {
    initMenuBuilder(handlers);
    const before = _getDynamicIdsForTesting().size;
    expect(before).toBeGreaterThan(0);
    teardownMenuBuilder();
    expect(registry.has(TOP_LEVEL_ID)).toBe(false);
    expect(registry.has(OPEN_LMS_ID)).toBe(false);
    expect(registry.has(QUICK_STARTS_ID)).toBe(false);
    expect(registry.has(VIEW_ALL_TUTORIALS_ID)).toBe(false);
    expect(registry.has(AI_RUN_TIMES_ID)).toBe(false);
    expect(_getDynamicIdsForTesting().size).toBe(0);
  });
});
