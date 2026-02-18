import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing
vi.mock('../../lib/ai-service', () => ({ default: null }));
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readdirSync: vi.fn().mockReturnValue([]) };
});

// ═══════════════════════════════════════════════════════════════════
// CONVERTER REGISTRY
// ═══════════════════════════════════════════════════════════════════

describe('ConverterRegistry', () => {
  let ConverterRegistry;

  beforeEach(async () => {
    vi.resetModules();
    vi.mock('../../lib/ai-service', () => ({ default: null }));
    vi.mock('../../lib/log-event-queue', () => ({
      getLogQueue: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    }));
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal();
      return { ...actual, readdirSync: vi.fn().mockReturnValue([]) };
    });
    const mod = require('../../lib/conversion-service');
    ConverterRegistry = mod.ConverterRegistry;
  });

  function fakeAgent(id, from, to) {
    return {
      id,
      name: `Agent ${id}`,
      description: `Converts ${from} to ${to}`,
      from: Array.isArray(from) ? from : [from],
      to: Array.isArray(to) ? to : [to],
      modes: ['symbolic'],
      convert: vi.fn().mockResolvedValue({ success: true, output: `converted-by-${id}` }),
    };
  }

  it('starts empty', () => {
    const reg = new ConverterRegistry();
    expect(reg.all()).toHaveLength(0);
    expect(reg.capabilities()).toHaveLength(0);
  });

  it('registers an agent and retrieves it by ID', () => {
    const reg = new ConverterRegistry();
    const agent = fakeAgent('md-html', 'md', 'html');
    reg.register(agent);
    expect(reg.get('md-html')).toBe(agent);
    expect(reg.all()).toHaveLength(1);
  });

  it('rejects agent missing id', () => {
    const reg = new ConverterRegistry();
    expect(() => reg.register({ from: ['a'], to: ['b'] })).toThrow('Invalid agent');
  });

  it('rejects agent missing from', () => {
    const reg = new ConverterRegistry();
    expect(() => reg.register({ id: 'x', to: ['b'] })).toThrow('Invalid agent');
  });

  it('rejects agent missing to', () => {
    const reg = new ConverterRegistry();
    expect(() => reg.register({ id: 'x', from: ['a'] })).toThrow('Invalid agent');
  });

  it('finds agents by from/to', () => {
    const reg = new ConverterRegistry();
    reg.register(fakeAgent('md-html', 'md', 'html'));
    reg.register(fakeAgent('html-text', 'html', 'text'));
    expect(reg.find('md', 'html')).toHaveLength(1);
    expect(reg.find('html', 'text')).toHaveLength(1);
    expect(reg.find('md', 'text')).toHaveLength(0);
  });

  it('handles multi-format agents', () => {
    const reg = new ConverterRegistry();
    reg.register(fakeAgent('multi', ['md', 'html'], ['text', 'pdf']));
    expect(reg.find('md', 'text')).toHaveLength(1);
    expect(reg.find('md', 'pdf')).toHaveLength(1);
    expect(reg.find('html', 'text')).toHaveLength(1);
    expect(reg.find('html', 'pdf')).toHaveLength(1);
  });

  it('builds a format graph', () => {
    const reg = new ConverterRegistry();
    reg.register(fakeAgent('md-html', 'md', 'html'));
    const graph = reg.getGraph();
    expect(graph.has('md')).toBe(true);
    expect(graph.get('md').get('html')).toBe('md-html');
  });

  it('capabilities returns structured list', () => {
    const reg = new ConverterRegistry();
    reg.register(fakeAgent('md-html', 'md', 'html'));
    const caps = reg.capabilities();
    expect(caps).toHaveLength(1);
    expect(caps[0].id).toBe('md-html');
    expect(caps[0].from).toEqual(['md']);
    expect(caps[0].to).toEqual(['html']);
  });

  it('registers multiple agents and lists all', () => {
    const reg = new ConverterRegistry();
    reg.register(fakeAgent('a', 'x', 'y'));
    reg.register(fakeAgent('b', 'y', 'z'));
    reg.register(fakeAgent('c', 'z', 'w'));
    expect(reg.all()).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════════════
// PIPELINE RESOLVER
// ═══════════════════════════════════════════════════════════════════

describe('PipelineResolver', () => {
  let ConverterRegistry, PipelineResolver;

  beforeEach(async () => {
    vi.resetModules();
    vi.mock('../../lib/ai-service', () => ({ default: null }));
    vi.mock('../../lib/log-event-queue', () => ({
      getLogQueue: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    }));
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal();
      return { ...actual, readdirSync: vi.fn().mockReturnValue([]) };
    });
    const mod = require('../../lib/conversion-service');
    ConverterRegistry = mod.ConverterRegistry;
    PipelineResolver = mod.PipelineResolver;
  });

  function fakeAgent(id, from, to) {
    return {
      id,
      name: id,
      description: '',
      from: [from],
      to: [to],
      modes: ['symbolic'],
      convert: vi.fn().mockResolvedValue({ success: true, output: `out-${id}` }),
    };
  }

  it('resolves identity (same format)', () => {
    const reg = new ConverterRegistry();
    const resolver = new PipelineResolver(reg);
    const result = resolver.resolve('md', 'md');
    expect(result).toEqual({ path: ['md'], agents: [] });
  });

  it('resolves a direct single-hop path', () => {
    const reg = new ConverterRegistry();
    reg.register(fakeAgent('md-html', 'md', 'html'));
    const resolver = new PipelineResolver(reg);
    const result = resolver.resolve('md', 'html');
    expect(result).toEqual({ path: ['md', 'html'], agents: ['md-html'] });
  });

  it('resolves a multi-hop path via BFS', () => {
    const reg = new ConverterRegistry();
    reg.register(fakeAgent('md-html', 'md', 'html'));
    reg.register(fakeAgent('html-text', 'html', 'text'));
    const resolver = new PipelineResolver(reg);
    const result = resolver.resolve('md', 'text');
    expect(result.path).toEqual(['md', 'html', 'text']);
    expect(result.agents).toEqual(['md-html', 'html-text']);
  });

  it('returns null when no path exists', () => {
    const reg = new ConverterRegistry();
    reg.register(fakeAgent('md-html', 'md', 'html'));
    const resolver = new PipelineResolver(reg);
    expect(resolver.resolve('md', 'pdf')).toBeNull();
  });

  it('finds shortest path when multiple routes exist', () => {
    const reg = new ConverterRegistry();
    // Direct path: md -> text (1 hop)
    reg.register(fakeAgent('md-text', 'md', 'text'));
    // Longer path: md -> html -> text (2 hops)
    reg.register(fakeAgent('md-html', 'md', 'html'));
    reg.register(fakeAgent('html-text', 'html', 'text'));
    const resolver = new PipelineResolver(reg);
    const result = resolver.resolve('md', 'text');
    // BFS finds shortest first
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toBe('md-text');
  });

  it('getFullGraph returns all nodes and edges', () => {
    const reg = new ConverterRegistry();
    reg.register(fakeAgent('md-html', 'md', 'html'));
    reg.register(fakeAgent('html-text', 'html', 'text'));
    const resolver = new PipelineResolver(reg);
    const graph = resolver.getFullGraph();
    expect(graph.nodes).toContain('md');
    expect(graph.nodes).toContain('html');
    expect(graph.nodes).toContain('text');
    expect(graph.edges.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// JOB MANAGER
// ═══════════════════════════════════════════════════════════════════

describe('JobManager', () => {
  let JobManager;

  beforeEach(async () => {
    vi.resetModules();
    vi.mock('../../lib/ai-service', () => ({ default: null }));
    vi.mock('../../lib/log-event-queue', () => ({
      getLogQueue: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    }));
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal();
      return { ...actual, readdirSync: vi.fn().mockReturnValue([]) };
    });
    const mod = require('../../lib/conversion-service');
    JobManager = mod.JobManager;
  });

  it('creates a job and returns an ID', () => {
    const jm = new JobManager();
    const id = jm.create(async () => ({ success: true }));
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('tracks job status through lifecycle', async () => {
    const jm = new JobManager();
    let resolveJob;
    const jobPromise = new Promise((r) => {
      resolveJob = r;
    });
    const id = jm.create(async () => {
      await jobPromise;
      return { success: true, output: 'done' };
    });

    // Initially queued or running
    const initial = jm.get(id);
    expect(['queued', 'running']).toContain(initial.status);

    // Complete the job
    resolveJob();
    // Wait for job to finish
    await new Promise((r) => {
      setTimeout(r, 50);
    });

    const final = jm.get(id);
    expect(final.status).toBe('completed');
    expect(final.result).toEqual({ success: true, output: 'done' });
    expect(final.completedAt).toBeDefined();
  });

  it('marks failed jobs', async () => {
    const jm = new JobManager();
    const id = jm.create(async () => {
      throw new Error('conversion broke');
    });
    await new Promise((r) => {
      setTimeout(r, 50);
    });

    const job = jm.get(id);
    expect(job.status).toBe('failed');
    expect(job.error).toBe('conversion broke');
  });

  it('returns null for unknown job ID', () => {
    const jm = new JobManager();
    expect(jm.get('does-not-exist')).toBeNull();
  });

  it('tracks progress via callback', async () => {
    const jm = new JobManager();
    const id = jm.create(async (onProgress) => {
      onProgress('step1', 1, 2);
      onProgress('step2', 2, 2);
      return { success: true };
    });
    await new Promise((r) => {
      setTimeout(r, 50);
    });

    const job = jm.get(id);
    expect(job.status).toBe('completed');
    expect(job.progress).toBe(100);
    expect(job.progressStage).toBe('step2');
  });
});

// ═══════════════════════════════════════════════════════════════════
// CONVERSION SERVICE (full integration)
// ═══════════════════════════════════════════════════════════════════

describe('ConversionService', () => {
  let ConversionService;

  beforeEach(async () => {
    vi.resetModules();
    vi.mock('../../lib/ai-service', () => ({ default: null }));
    vi.mock('../../lib/log-event-queue', () => ({
      getLogQueue: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    }));
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        existsSync: vi.fn().mockReturnValue(false),
        readdirSync: vi.fn().mockReturnValue([]),
      };
    });
    const mod = require('../../lib/conversion-service');
    ConversionService = mod.ConversionService;
  });

  function fakeAgent(id, from, to, output = 'converted') {
    return {
      id,
      name: id,
      description: `${from}->${to}`,
      from: Array.isArray(from) ? from : [from],
      to: Array.isArray(to) ? to : [to],
      modes: ['symbolic', 'generative'],
      strategies: [{ id: 'default', description: 'Default strategy' }],
      convert: vi.fn().mockResolvedValue({
        success: true,
        output,
        report: { agentId: id, finalScore: 90, totalDuration: 10, attempts: [] },
      }),
    };
  }

  it('initializes without error when no converters dir', async () => {
    const svc = new ConversionService();
    await svc.initialize();
    expect(svc._initialized).toBe(true);
  });

  it('capabilities returns an array (may have auto-discovered converters)', async () => {
    const svc = new ConversionService();
    const caps = await svc.capabilities();
    expect(Array.isArray(caps)).toBe(true);
    // Each capability has expected shape
    for (const cap of caps) {
      expect(cap.id).toBeDefined();
      expect(Array.isArray(cap.from)).toBe(true);
      expect(Array.isArray(cap.to)).toBe(true);
    }
  });

  it('graph returns nodes and edges arrays', async () => {
    const svc = new ConversionService();
    const g = await svc.graph();
    expect(Array.isArray(g.nodes)).toBe(true);
    expect(Array.isArray(g.edges)).toBe(true);
    // Each edge has from, to, agent
    for (const edge of g.edges) {
      expect(edge.from).toBeDefined();
      expect(edge.to).toBeDefined();
      expect(edge.agent).toBeDefined();
    }
  });

  it('convert uses direct agent when available', async () => {
    const svc = new ConversionService();
    const agent = fakeAgent('md-html', 'md', 'html', '<h1>Hi</h1>');
    svc.registry.register(agent);
    svc._initialized = true;

    const result = await svc.convert({ input: '# Hi', from: 'md', to: 'html' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('<h1>Hi</h1>');
    expect(agent.convert).toHaveBeenCalledWith('# Hi', {});
  });

  it('convert respects mode selection', async () => {
    const svc = new ConversionService();
    const symbolic = fakeAgent('md-html-sym', 'md', 'html', '<h1>sym</h1>');
    symbolic.modes = ['symbolic'];
    const generative = fakeAgent('md-html-gen', 'md', 'html', '<h1>gen</h1>');
    generative.modes = ['generative'];
    svc.registry.register(symbolic);
    svc.registry.register(generative);
    svc._initialized = true;

    const _result = await svc.convert({ input: '# Hi', from: 'md', to: 'html', mode: 'generative' });
    expect(generative.convert).toHaveBeenCalled();
  });

  it('convert falls back to pipeline when no direct agent', async () => {
    const svc = new ConversionService();
    svc.registry.register(fakeAgent('md-html', 'md', 'html', '<p>step1</p>'));
    svc.registry.register(fakeAgent('html-text', 'html', 'text', 'step2'));
    svc._initialized = true;

    const result = await svc.convert({ input: '# Hi', from: 'md', to: 'text' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('step2');
    expect(result.pipelineSteps).toHaveLength(2);
  });

  it('convert returns failure report when no path found', async () => {
    const svc = new ConversionService();
    svc._initialized = true;

    const result = await svc.convert({ input: 'x', from: 'foo', to: 'bar' });
    expect(result.success).toBe(false);
    expect(result.report.decision.whyThisStrategy).toContain('No conversion path');
  });

  it('convert with async flag returns jobId', async () => {
    const svc = new ConversionService();
    svc.registry.register(fakeAgent('md-html', 'md', 'html'));
    svc._initialized = true;

    const result = await svc.convert({ input: '# Hi', from: 'md', to: 'html', async: true });
    expect(result.jobId).toBeDefined();
    expect(result.status).toBe('queued');
  });

  it('jobStatus returns null for unknown job', () => {
    const svc = new ConversionService();
    expect(svc.jobStatus('unknown')).toBeNull();
  });

  it('jobStatus tracks async job to completion', async () => {
    const svc = new ConversionService();
    svc.registry.register(fakeAgent('md-html', 'md', 'html', '<p>done</p>'));
    svc._initialized = true;

    const result = await svc.convert({ input: '# Hi', from: 'md', to: 'html', async: true });
    const jobId = result.jobId;

    // Wait for async job
    await new Promise((r) => {
      setTimeout(r, 100);
    });
    const status = svc.jobStatus(jobId);
    expect(status.status).toBe('completed');
  });

  it('pipeline runs explicit multi-step conversion', async () => {
    const svc = new ConversionService();
    const mdAgent = fakeAgent('md-html', 'md', 'html', '<p>html</p>');
    const htmlAgent = fakeAgent('html-text', 'html', 'text', 'plaintext');
    svc.registry.register(mdAgent);
    svc.registry.register(htmlAgent);
    svc._initialized = true;

    const result = await svc.pipeline({
      input: '# Hello',
      steps: [
        { from: 'md', to: 'html' },
        { from: 'html', to: 'text' },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.output).toBe('plaintext');
    expect(result.steps).toHaveLength(2);
  });

  it('pipeline stops at first failure', async () => {
    const svc = new ConversionService();
    const goodAgent = fakeAgent('md-html', 'md', 'html', '<p>ok</p>');
    const badAgent = {
      id: 'html-pdf',
      name: 'html-pdf',
      description: '',
      from: ['html'],
      to: ['pdf'],
      modes: ['symbolic'],
      convert: vi.fn().mockResolvedValue({
        success: false,
        output: null,
        report: { error: 'PDF generation failed' },
      }),
    };
    svc.registry.register(goodAgent);
    svc.registry.register(badAgent);
    svc._initialized = true;

    const result = await svc.pipeline({
      input: '# Hello',
      steps: [
        { from: 'md', to: 'html' },
        { from: 'html', to: 'pdf' },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.steps).toHaveLength(2);
  });

  it('only initializes once', async () => {
    const svc = new ConversionService();
    await svc.initialize();
    await svc.initialize();
    expect(svc._initialized).toBe(true);
  });
});
