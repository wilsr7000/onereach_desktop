import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/ai-service', () => ({ default: null }));

// The conversion service auto-discovers agents, so we need to mock fs
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readdirSync: vi.fn().mockReturnValue([]),
  };
});

describe('ConversionService', () => {
  let service;
  
  beforeEach(async () => {
    // Fresh require each time
    vi.resetModules();
    vi.mock('../../lib/ai-service', () => ({ default: null }));
    const mod = require('../../lib/conversion-service');
    service = typeof mod === 'function' ? new mod() : mod;
  });

  it('exports a service object or class', () => {
    expect(service).toBeDefined();
  });

  it('has convert method', () => {
    expect(typeof service.convert === 'function' || typeof service.constructor.prototype.convert === 'function').toBe(true);
  });

  it('has capabilities method', () => {
    expect(typeof service.capabilities === 'function' || typeof service.constructor.prototype.capabilities === 'function').toBe(true);
  });

  it('has graph method', () => {
    expect(typeof service.graph === 'function' || typeof service.constructor.prototype.graph === 'function').toBe(true);
  });

  it('has jobStatus method', () => {
    expect(typeof service.jobStatus === 'function' || typeof service.constructor.prototype.jobStatus === 'function').toBe(true);
  });
});
