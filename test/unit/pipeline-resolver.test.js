import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/ai-service', () => ({ default: null }));
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { ConverterRegistry, PipelineResolver } = require('../../lib/conversion-service');

describe('PipelineResolver', () => {
  let registry;
  let resolver;

  beforeEach(() => {
    registry = new ConverterRegistry();

    // Register mock converters: a->b, b->c, c->d
    registry.register({
      id: 'converter:a-to-b',
      name: 'A to B',
      from: ['a'],
      to: ['b'],
      modes: ['symbolic'],
    });

    registry.register({
      id: 'converter:b-to-c',
      name: 'B to C',
      from: ['b'],
      to: ['c'],
      modes: ['symbolic'],
    });

    registry.register({
      id: 'converter:c-to-d',
      name: 'C to D',
      from: ['c'],
      to: ['d'],
      modes: ['symbolic'],
    });

    resolver = new PipelineResolver(registry);
  });

  describe('resolve()', () => {
    it('finds direct single-step path (a -> b)', () => {
      const result = resolver.resolve('a', 'b');
      expect(result).not.toBeNull();
      expect(result.path).toEqual(['a', 'b']);
      expect(result.agents).toEqual(['converter:a-to-b']);
    });

    it('finds multi-step path (a -> d) through three converters', () => {
      const result = resolver.resolve('a', 'd');
      expect(result).not.toBeNull();
      expect(result.path).toEqual(['a', 'b', 'c', 'd']);
      expect(result.agents).toEqual([
        'converter:a-to-b',
        'converter:b-to-c',
        'converter:c-to-d',
      ]);
    });

    it('finds two-step path (a -> c)', () => {
      const result = resolver.resolve('a', 'c');
      expect(result).not.toBeNull();
      expect(result.path).toEqual(['a', 'b', 'c']);
      expect(result.agents).toEqual(['converter:a-to-b', 'converter:b-to-c']);
    });

    it('returns null when no path exists (a -> z)', () => {
      const result = resolver.resolve('a', 'z');
      expect(result).toBeNull();
    });

    it('returns null when source format is unknown', () => {
      const result = resolver.resolve('unknown', 'b');
      expect(result).toBeNull();
    });

    it('returns identity path when source equals target', () => {
      const result = resolver.resolve('a', 'a');
      expect(result).not.toBeNull();
      expect(result.path).toEqual(['a']);
      expect(result.agents).toEqual([]);
    });

    it('handles reverse direction correctly (no d -> a path)', () => {
      const result = resolver.resolve('d', 'a');
      expect(result).toBeNull();
    });
  });

  describe('getFullGraph()', () => {
    it('returns all nodes in the graph', () => {
      const graph = resolver.getFullGraph();
      expect(graph.nodes).toContain('a');
      expect(graph.nodes).toContain('b');
      expect(graph.nodes).toContain('c');
      expect(graph.nodes).toContain('d');
    });

    it('returns all edges in the graph', () => {
      const graph = resolver.getFullGraph();
      expect(graph.edges.length).toBe(3);
      expect(graph.edges).toContainEqual({ from: 'a', to: 'b', agent: 'converter:a-to-b' });
      expect(graph.edges).toContainEqual({ from: 'b', to: 'c', agent: 'converter:b-to-c' });
      expect(graph.edges).toContainEqual({ from: 'c', to: 'd', agent: 'converter:c-to-d' });
    });
  });
});

describe('ConverterRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new ConverterRegistry();
  });

  it('registers and retrieves agents by id', () => {
    registry.register({ id: 'test', name: 'Test', from: ['x'], to: ['y'], modes: [] });
    const agent = registry.get('test');
    expect(agent).toBeDefined();
    expect(agent.id).toBe('test');
  });

  it('finds agents by from/to format', () => {
    registry.register({ id: 'test', name: 'Test', from: ['x'], to: ['y'], modes: [] });
    const found = registry.find('x', 'y');
    expect(found.length).toBe(1);
    expect(found[0].id).toBe('test');
  });

  it('returns empty array when no agents match', () => {
    const found = registry.find('x', 'y');
    expect(found).toEqual([]);
  });

  it('throws on agent missing id', () => {
    expect(() => registry.register({ from: ['a'], to: ['b'] })).toThrow('Invalid agent');
  });

  it('throws on agent missing from', () => {
    expect(() => registry.register({ id: 'x', to: ['b'] })).toThrow('Invalid agent');
  });

  it('throws on agent missing to', () => {
    expect(() => registry.register({ id: 'x', from: ['a'] })).toThrow('Invalid agent');
  });

  it('lists all registered agents', () => {
    registry.register({ id: 'one', name: 'One', from: ['a'], to: ['b'], modes: [] });
    registry.register({ id: 'two', name: 'Two', from: ['c'], to: ['d'], modes: [] });
    expect(registry.all().length).toBe(2);
  });

  it('builds graph for multi-format agents', () => {
    registry.register({ id: 'multi', name: 'Multi', from: ['x', 'y'], to: ['z', 'w'], modes: [] });
    const found1 = registry.find('x', 'z');
    const found2 = registry.find('y', 'w');
    expect(found1.length).toBe(1);
    expect(found2.length).toBe(1);
  });

  it('returns capabilities summary', () => {
    registry.register({
      id: 'cap-test',
      name: 'Cap Test',
      description: 'A test agent',
      from: ['a'],
      to: ['b'],
      modes: ['symbolic'],
      strategies: [{ id: 's1', description: 'Strategy 1' }],
    });
    const caps = registry.capabilities();
    expect(caps.length).toBe(1);
    expect(caps[0].id).toBe('cap-test');
    expect(caps[0].strategies[0].id).toBe('s1');
  });
});
