import { describe, it, expect, beforeEach } from 'vitest';
import { MenuRegistry, type MenuEntry } from '../../menu/registry.js';

describe('MenuRegistry', () => {
  let registry: MenuRegistry;

  beforeEach(() => {
    registry = new MenuRegistry();
  });

  describe('register', () => {
    it('adds an entry retrievable by id', () => {
      const entry: MenuEntry = { id: 'top:app', type: 'top-level', role: 'appMenu', order: 0 };
      registry.register(entry);
      expect(registry.get('top:app')).toEqual(entry);
      expect(registry.has('top:app')).toBe(true);
      expect(registry.size()).toBe(1);
    });

    it('throws on duplicate id', () => {
      registry.register({ id: 'top:app', type: 'top-level', order: 0 });
      expect(() => registry.register({ id: 'top:app', type: 'top-level', order: 1 })).toThrow(/already registered/);
    });

    it('emits change event', () => {
      let changeCount = 0;
      registry.onChange(() => changeCount++);
      registry.register({ id: 'a', type: 'item', parentId: 'top:app', label: 'A' });
      expect(changeCount).toBe(1);
    });
  });

  describe('upsert', () => {
    it('adds an entry if not present', () => {
      registry.upsert({ id: 'top:app', type: 'top-level', order: 0 });
      expect(registry.has('top:app')).toBe(true);
    });

    it('replaces an entry if present', () => {
      registry.register({ id: 'top:app', type: 'top-level', label: 'Old', order: 0 });
      registry.upsert({ id: 'top:app', type: 'top-level', label: 'New', order: 0 });
      expect(registry.get('top:app')?.label).toBe('New');
    });

    it('does not re-emit change just for replacement insertion order', () => {
      let count = 0;
      registry.onChange(() => count++);
      registry.upsert({ id: 'a', type: 'item', label: 'A' });
      registry.upsert({ id: 'a', type: 'item', label: 'A2' });
      expect(count).toBe(2); // one per upsert call
    });
  });

  describe('unregister', () => {
    it('removes an entry by id', () => {
      registry.register({ id: 'a', type: 'item', label: 'A' });
      registry.unregister('a');
      expect(registry.has('a')).toBe(false);
    });

    it('is a no-op for unknown id (no event)', () => {
      let count = 0;
      registry.onChange(() => count++);
      registry.unregister('nope');
      expect(count).toBe(0);
    });
  });

  describe('getChildren', () => {
    it('returns top-level entries when parentId is undefined', () => {
      registry.register({ id: 'top:app', type: 'top-level', order: 0 });
      registry.register({ id: 'top:help', type: 'top-level', order: 100 });
      registry.register({ id: 'app:about', type: 'item', parentId: 'top:app' });
      const tops = registry.getChildren();
      expect(tops.map((e) => e.id)).toEqual(['top:app', 'top:help']);
    });

    it('returns children of a specific parent', () => {
      registry.register({ id: 'top:app', type: 'top-level', order: 0 });
      registry.register({ id: 'app:about', type: 'item', parentId: 'top:app', order: 0 });
      registry.register({ id: 'app:quit', type: 'item', parentId: 'top:app', order: 100 });
      const children = registry.getChildren('top:app');
      expect(children.map((e) => e.id)).toEqual(['app:about', 'app:quit']);
    });

    it('sorts by order ascending', () => {
      registry.register({ id: 'a', type: 'item', parentId: 'p', order: 100 });
      registry.register({ id: 'b', type: 'item', parentId: 'p', order: 50 });
      registry.register({ id: 'c', type: 'item', parentId: 'p', order: 75 });
      const children = registry.getChildren('p');
      expect(children.map((e) => e.id)).toEqual(['b', 'c', 'a']);
    });

    it('breaks ties by registration order', () => {
      registry.register({ id: 'first', type: 'item', parentId: 'p', order: 0 });
      registry.register({ id: 'second', type: 'item', parentId: 'p', order: 0 });
      registry.register({ id: 'third', type: 'item', parentId: 'p', order: 0 });
      const children = registry.getChildren('p');
      expect(children.map((e) => e.id)).toEqual(['first', 'second', 'third']);
    });

    it('treats missing order as 0', () => {
      registry.register({ id: 'a', type: 'item', parentId: 'p' });
      registry.register({ id: 'b', type: 'item', parentId: 'p', order: -1 });
      const children = registry.getChildren('p');
      expect(children.map((e) => e.id)).toEqual(['b', 'a']);
    });
  });

  describe('onChange', () => {
    it('returns an unsubscribe function', () => {
      let count = 0;
      const unsubscribe = registry.onChange(() => count++);
      registry.register({ id: 'a', type: 'item', label: 'A' });
      expect(count).toBe(1);
      unsubscribe();
      registry.register({ id: 'b', type: 'item', label: 'B' });
      expect(count).toBe(1);
    });
  });
});
