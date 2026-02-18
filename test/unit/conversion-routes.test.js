import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock log-event-queue before importing routes
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ═══════════════════════════════════════════════════════════════════
// Helpers: fake Express app and response
// ═══════════════════════════════════════════════════════════════════

function createFakeApp() {
  const routes = { get: {}, post: {} };
  return {
    routes,
    get(path, handler) {
      routes.get[path] = handler;
    },
    post(path, handler) {
      routes.post[path] = handler;
    },
    call(method, path, req) {
      const handler = routes[method.toLowerCase()][path];
      if (!handler) throw new Error(`No route: ${method} ${path}`);
      const res = createFakeRes();
      handler(req, res);
      return res;
    },
    callAsync(method, path, req) {
      const handler = routes[method.toLowerCase()][path];
      if (!handler) throw new Error(`No route: ${method} ${path}`);
      const res = createFakeRes();
      return handler(req, res).then(() => res);
    },
  };
}

function createFakeRes() {
  const res = {
    _status: 200,
    _body: null,
    status(code) {
      res._status = code;
      return res;
    },
    json(body) {
      res._body = body;
      return res;
    },
  };
  return res;
}

function createFakeService() {
  return {
    convert: vi.fn().mockResolvedValue({ success: true, output: 'converted-output' }),
    capabilities: vi
      .fn()
      .mockResolvedValue([
        { id: 'md-html', name: 'Markdown to HTML', from: ['md'], to: ['html'], modes: ['symbolic'] },
      ]),
    graph: vi.fn().mockResolvedValue({
      nodes: ['md', 'html', 'text'],
      edges: [{ from: 'md', to: 'html', agent: 'md-html' }],
    }),
    pipeline: vi.fn().mockResolvedValue({ success: true, output: 'pipeline-output', steps: [] }),
    jobStatus: vi.fn().mockReturnValue(null),
  };
}

// ═══════════════════════════════════════════════════════════════════
// ROUTE MOUNTING
// ═══════════════════════════════════════════════════════════════════

describe('mountConversionRoutes', () => {
  let mountConversionRoutes;

  beforeEach(async () => {
    vi.resetModules();
    vi.mock('../../lib/log-event-queue', () => ({
      getLogQueue: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    }));
    mountConversionRoutes = require('../../lib/conversion-routes');
  });

  it('throws on invalid app', () => {
    expect(() => mountConversionRoutes(null, createFakeService())).toThrow('Invalid Express app');
  });

  it('throws on invalid service', () => {
    expect(() => mountConversionRoutes(createFakeApp(), null)).toThrow('Invalid conversion service');
  });

  it('throws on service without convert method', () => {
    expect(() => mountConversionRoutes(createFakeApp(), { capabilities: vi.fn() })).toThrow(
      'Invalid conversion service'
    );
  });

  it('mounts all 7 routes', () => {
    const app = createFakeApp();
    mountConversionRoutes(app, createFakeService());
    expect(app.routes.post['/api/convert']).toBeDefined();
    expect(app.routes.get['/api/convert/capabilities']).toBeDefined();
    expect(app.routes.get['/api/convert/graph']).toBeDefined();
    expect(app.routes.post['/api/convert/pipeline']).toBeDefined();
    expect(app.routes.get['/api/convert/status/:jobId']).toBeDefined();
    expect(app.routes.post['/api/convert/validate/playbook']).toBeDefined();
    expect(app.routes.post['/api/convert/diagnose/playbook']).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/convert
// ═══════════════════════════════════════════════════════════════════

describe('POST /api/convert', () => {
  let app, svc;

  beforeEach(async () => {
    vi.resetModules();
    vi.mock('../../lib/log-event-queue', () => ({
      getLogQueue: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    }));
    const mount = require('../../lib/conversion-routes');
    app = createFakeApp();
    svc = createFakeService();
    mount(app, svc);
  });

  it('400 when input is missing', async () => {
    const res = await app.callAsync('POST', '/api/convert', { body: { from: 'md', to: 'html' } });
    expect(res._status).toBe(400);
    expect(res._body.error).toContain('input');
  });

  it('400 when from is missing', async () => {
    const res = await app.callAsync('POST', '/api/convert', { body: { input: 'hi', to: 'html' } });
    expect(res._status).toBe(400);
    expect(res._body.error).toContain('from');
  });

  it('400 when to is missing', async () => {
    const res = await app.callAsync('POST', '/api/convert', { body: { input: 'hi', from: 'md' } });
    expect(res._status).toBe(400);
    expect(res._body.error).toContain('to');
  });

  it('200 for valid sync conversion', async () => {
    svc.convert.mockResolvedValue({ success: true, output: '<h1>Hi</h1>' });
    const res = await app.callAsync('POST', '/api/convert', {
      body: { input: '# Hi', from: 'md', to: 'html' },
    });
    expect(res._status).toBe(200);
    expect(res._body.success).toBe(true);
    expect(res._body.output).toBe('<h1>Hi</h1>');
    expect(svc.convert).toHaveBeenCalledWith(
      expect.objectContaining({
        input: '# Hi',
        from: 'md',
        to: 'html',
      })
    );
  });

  it('202 for async conversion', async () => {
    svc.convert.mockResolvedValue({ jobId: 'job-123', status: 'queued' });
    const res = await app.callAsync('POST', '/api/convert', {
      body: { input: '# Hi', from: 'md', to: 'html', async: true },
    });
    expect(res._status).toBe(202);
    expect(res._body.jobId).toBe('job-123');
    expect(res._body.status).toBe('queued');
  });

  it('encodes Buffer output as base64', async () => {
    svc.convert.mockResolvedValue({ success: true, output: Buffer.from('binary data') });
    const res = await app.callAsync('POST', '/api/convert', {
      body: { input: 'x', from: 'html', to: 'pdf' },
    });
    expect(res._status).toBe(200);
    expect(res._body.output).toBe(Buffer.from('binary data').toString('base64'));
    expect(res._body.outputEncoding).toBe('base64');
  });

  it('500 when service throws', async () => {
    svc.convert.mockRejectedValue(new Error('boom'));
    const res = await app.callAsync('POST', '/api/convert', {
      body: { input: 'x', from: 'md', to: 'html' },
    });
    expect(res._status).toBe(500);
    expect(res._body.error).toBe('Conversion failed');
    expect(res._body.message).toBe('boom');
  });

  it('decodes base64 input for long base64-like strings', async () => {
    // Create a string that looks like base64 (>100 chars, no spaces, valid chars)
    const longB64 = Buffer.from('A'.repeat(200)).toString('base64');
    svc.convert.mockResolvedValue({ success: true, output: 'decoded' });
    const res = await app.callAsync('POST', '/api/convert', {
      body: { input: longB64, from: 'pdf', to: 'text' },
    });
    expect(res._status).toBe(200);
    // Service should have been called with a Buffer (decoded from base64)
    const calledInput = svc.convert.mock.calls[0][0].input;
    expect(Buffer.isBuffer(calledInput)).toBe(true);
  });

  it('does NOT decode short strings as base64', async () => {
    svc.convert.mockResolvedValue({ success: true, output: 'ok' });
    const res = await app.callAsync('POST', '/api/convert', {
      body: { input: 'hello world', from: 'text', to: 'md' },
    });
    expect(res._status).toBe(200);
    const calledInput = svc.convert.mock.calls[0][0].input;
    expect(calledInput).toBe('hello world');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/convert/capabilities
// ═══════════════════════════════════════════════════════════════════

describe('GET /api/convert/capabilities', () => {
  let app, svc;

  beforeEach(async () => {
    vi.resetModules();
    vi.mock('../../lib/log-event-queue', () => ({
      getLogQueue: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    }));
    const mount = require('../../lib/conversion-routes');
    app = createFakeApp();
    svc = createFakeService();
    mount(app, svc);
  });

  it('200 with converters list and count', async () => {
    const res = await app.callAsync('GET', '/api/convert/capabilities', {});
    expect(res._status).toBe(200);
    expect(res._body.converters).toHaveLength(1);
    expect(res._body.count).toBe(1);
  });

  it('500 when capabilities throws', async () => {
    svc.capabilities.mockRejectedValue(new Error('fail'));
    const res = await app.callAsync('GET', '/api/convert/capabilities', {});
    expect(res._status).toBe(500);
    expect(res._body.error).toContain('capabilities');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/convert/graph
// ═══════════════════════════════════════════════════════════════════

describe('GET /api/convert/graph', () => {
  let app, svc;

  beforeEach(async () => {
    vi.resetModules();
    vi.mock('../../lib/log-event-queue', () => ({
      getLogQueue: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    }));
    const mount = require('../../lib/conversion-routes');
    app = createFakeApp();
    svc = createFakeService();
    mount(app, svc);
  });

  it('200 with graph data', async () => {
    const res = await app.callAsync('GET', '/api/convert/graph', {});
    expect(res._status).toBe(200);
    expect(res._body.nodes).toContain('md');
    expect(res._body.edges).toHaveLength(1);
  });

  it('500 when graph throws', async () => {
    svc.graph.mockRejectedValue(new Error('graph fail'));
    const res = await app.callAsync('GET', '/api/convert/graph', {});
    expect(res._status).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/convert/pipeline
// ═══════════════════════════════════════════════════════════════════

describe('POST /api/convert/pipeline', () => {
  let app, svc;

  beforeEach(async () => {
    vi.resetModules();
    vi.mock('../../lib/log-event-queue', () => ({
      getLogQueue: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    }));
    const mount = require('../../lib/conversion-routes');
    app = createFakeApp();
    svc = createFakeService();
    mount(app, svc);
  });

  it('400 when input missing', async () => {
    const res = await app.callAsync('POST', '/api/convert/pipeline', {
      body: { steps: [{ to: 'html' }] },
    });
    expect(res._status).toBe(400);
    expect(res._body.error).toContain('input');
  });

  it('400 when steps missing', async () => {
    const res = await app.callAsync('POST', '/api/convert/pipeline', {
      body: { input: 'hello' },
    });
    expect(res._status).toBe(400);
    expect(res._body.error).toContain('steps');
  });

  it('400 when steps is empty', async () => {
    const res = await app.callAsync('POST', '/api/convert/pipeline', {
      body: { input: 'hello', steps: [] },
    });
    expect(res._status).toBe(400);
  });

  it('400 when steps is not an array', async () => {
    const res = await app.callAsync('POST', '/api/convert/pipeline', {
      body: { input: 'hello', steps: 'not-array' },
    });
    expect(res._status).toBe(400);
  });

  it('200 for valid pipeline', async () => {
    const res = await app.callAsync('POST', '/api/convert/pipeline', {
      body: { input: '# Hello', steps: [{ from: 'md', to: 'html' }] },
    });
    expect(res._status).toBe(200);
    expect(res._body.success).toBe(true);
    expect(svc.pipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        input: '# Hello',
        steps: [{ from: 'md', to: 'html' }],
      })
    );
  });

  it('encodes Buffer output as base64', async () => {
    svc.pipeline.mockResolvedValue({ success: true, output: Buffer.from('binary') });
    const res = await app.callAsync('POST', '/api/convert/pipeline', {
      body: { input: 'x', steps: [{ to: 'pdf' }] },
    });
    expect(res._status).toBe(200);
    expect(res._body.outputEncoding).toBe('base64');
  });

  it('500 when pipeline throws', async () => {
    svc.pipeline.mockRejectedValue(new Error('pipeline exploded'));
    const res = await app.callAsync('POST', '/api/convert/pipeline', {
      body: { input: 'x', steps: [{ to: 'html' }] },
    });
    expect(res._status).toBe(500);
    expect(res._body.message).toBe('pipeline exploded');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/convert/status/:jobId
// ═══════════════════════════════════════════════════════════════════

describe('GET /api/convert/status/:jobId', () => {
  let app, svc;

  beforeEach(async () => {
    vi.resetModules();
    vi.mock('../../lib/log-event-queue', () => ({
      getLogQueue: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    }));
    const mount = require('../../lib/conversion-routes');
    app = createFakeApp();
    svc = createFakeService();
    mount(app, svc);
  });

  it('404 when job not found', () => {
    svc.jobStatus.mockReturnValue(null);
    const res = app.call('GET', '/api/convert/status/:jobId', { params: { jobId: 'nonexistent' } });
    expect(res._status).toBe(404);
    expect(res._body.error).toContain('not found');
  });

  it('200 with job data when found', () => {
    svc.jobStatus.mockReturnValue({
      id: 'job-1',
      status: 'completed',
      progress: 100,
      result: { success: true, output: 'done' },
    });
    const res = app.call('GET', '/api/convert/status/:jobId', { params: { jobId: 'job-1' } });
    expect(res._status).toBe(200);
    expect(res._body.id).toBe('job-1');
    expect(res._body.status).toBe('completed');
  });

  it('encodes Buffer in completed job result', () => {
    svc.jobStatus.mockReturnValue({
      id: 'job-2',
      status: 'completed',
      progress: 100,
      result: { success: true, output: Buffer.from('binary-result') },
    });
    const res = app.call('GET', '/api/convert/status/:jobId', { params: { jobId: 'job-2' } });
    expect(res._status).toBe(200);
    expect(res._body.result.output).toBe(Buffer.from('binary-result').toString('base64'));
    expect(res._body.result.outputEncoding).toBe('base64');
  });
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/convert/validate/playbook
// ═══════════════════════════════════════════════════════════════════

describe('POST /api/convert/validate/playbook', () => {
  let app, svc;

  beforeEach(async () => {
    vi.resetModules();
    vi.mock('../../lib/log-event-queue', () => ({
      getLogQueue: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    }));
    const mount = require('../../lib/conversion-routes');
    app = createFakeApp();
    svc = createFakeService();
    mount(app, svc);
  });

  it('400 when playbook missing', async () => {
    const res = await app.callAsync('POST', '/api/convert/validate/playbook', {
      body: { framework: 'react' },
    });
    expect(res._status).toBe(400);
    expect(res._body.error).toContain('playbook');
  });

  it('500 when validator module not found', async () => {
    const res = await app.callAsync('POST', '/api/convert/validate/playbook', {
      body: { playbook: '## Step 1\nDo thing' },
    });
    expect(res._status).toBe(500);
    // Could hit either the inner require catch or the outer catch
    expect(res._body.error).toBeDefined();
    expect(typeof res._body.message).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/convert/diagnose/playbook
// ═══════════════════════════════════════════════════════════════════

describe('POST /api/convert/diagnose/playbook', () => {
  let app, svc;

  beforeEach(async () => {
    vi.resetModules();
    vi.mock('../../lib/log-event-queue', () => ({
      getLogQueue: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    }));
    const mount = require('../../lib/conversion-routes');
    app = createFakeApp();
    svc = createFakeService();
    mount(app, svc);
  });

  it('400 when playbook missing', async () => {
    const res = await app.callAsync('POST', '/api/convert/diagnose/playbook', {
      body: { framework: 'vue' },
    });
    expect(res._status).toBe(400);
    expect(res._body.error).toContain('playbook');
  });

  it('500 when diagnostics module not found', async () => {
    const res = await app.callAsync('POST', '/api/convert/diagnose/playbook', {
      body: { playbook: '## Step 1\nBroken', sourceContent: '<html>' },
    });
    expect(res._status).toBe(500);
    // Could hit either the inner require catch or the outer catch
    expect(res._body.error).toBeDefined();
    expect(typeof res._body.message).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════
// _isLikelyBase64 (tested indirectly via POST /api/convert)
// ═══════════════════════════════════════════════════════════════════

describe('Base64 detection (via /api/convert)', () => {
  let app, svc;

  beforeEach(async () => {
    vi.resetModules();
    vi.mock('../../lib/log-event-queue', () => ({
      getLogQueue: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    }));
    const mount = require('../../lib/conversion-routes');
    app = createFakeApp();
    svc = createFakeService();
    mount(app, svc);
  });

  it('does not decode short strings', async () => {
    svc.convert.mockResolvedValue({ success: true, output: 'ok' });
    await app.callAsync('POST', '/api/convert', {
      body: { input: 'short', from: 'text', to: 'md' },
    });
    expect(svc.convert.mock.calls[0][0].input).toBe('short');
  });

  it('does not decode strings with spaces', async () => {
    svc.convert.mockResolvedValue({ success: true, output: 'ok' });
    const withSpaces = 'A'.repeat(200) + ' ' + 'B'.repeat(200);
    await app.callAsync('POST', '/api/convert', {
      body: { input: withSpaces, from: 'text', to: 'md' },
    });
    expect(svc.convert.mock.calls[0][0].input).toBe(withSpaces);
  });

  it('decodes valid base64 over 100 chars', async () => {
    svc.convert.mockResolvedValue({ success: true, output: 'ok' });
    const b64 = Buffer.from('X'.repeat(200)).toString('base64');
    await app.callAsync('POST', '/api/convert', {
      body: { input: b64, from: 'pdf', to: 'text' },
    });
    const calledInput = svc.convert.mock.calls[0][0].input;
    expect(Buffer.isBuffer(calledInput)).toBe(true);
  });
});
