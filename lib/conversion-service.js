/**
 * Conversion Service
 *
 * @description Central orchestrator for all file conversion agents.
 *   Manages the converter registry, pipeline resolver (graph-based shortest path),
 *   and async job tracking for long-running conversions.
 *
 * @usage
 *   const converter = require('./lib/conversion-service');
 *   const result = await converter.convert({ input, from: 'pdf', to: 'text' });
 *   const result = await converter.pipeline({ input, steps: [{ to: 'text' }, { to: 'playbook' }] });
 *
 * @see lib/converters/README.md
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

// ============================================================================
// CONVERTER REGISTRY
// ============================================================================

class ConverterRegistry {
  constructor() {
    /** @type {Map<string, import('./converters/base-converter-agent').BaseConverterAgent>} */
    this._agents = new Map();
    /** @type {Map<string, Set<string>>} format -> set of format edges (for graph) */
    this._graph = new Map();
  }

  /**
   * Register a converter agent.
   * @param {import('./converters/base-converter-agent').BaseConverterAgent} agent
   */
  register(agent) {
    if (!agent.id || !agent.from || !agent.to) {
      throw new Error(`Invalid agent: missing id, from, or to. Got id=${agent.id}`);
    }
    this._agents.set(agent.id, agent);

    // Build graph edges
    for (const fromFmt of agent.from) {
      for (const toFmt of agent.to) {
        if (!this._graph.has(fromFmt)) this._graph.set(fromFmt, new Map());
        this._graph.get(fromFmt).set(toFmt, agent.id);
      }
    }
  }

  /**
   * Get a specific agent by ID.
   * @param {string} id
   * @returns {import('./converters/base-converter-agent').BaseConverterAgent|undefined}
   */
  get(id) {
    return this._agents.get(id);
  }

  /**
   * Find agents that convert from one format to another.
   * @param {string} from
   * @param {string} to
   * @returns {import('./converters/base-converter-agent').BaseConverterAgent[]}
   */
  find(from, to) {
    const results = [];
    for (const agent of this._agents.values()) {
      if (agent.from.includes(from) && agent.to.includes(to)) {
        results.push(agent);
      }
    }
    return results;
  }

  /**
   * Get all registered agents.
   * @returns {import('./converters/base-converter-agent').BaseConverterAgent[]}
   */
  all() {
    return Array.from(this._agents.values());
  }

  /**
   * Get the format graph for pipeline resolution.
   */
  getGraph() {
    return this._graph;
  }

  /**
   * Get capabilities summary.
   */
  capabilities() {
    return this.all().map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      from: a.from,
      to: a.to,
      modes: a.modes,
      strategies: (a.strategies || []).map((s) => ({ id: s.id, description: s.description })),
    }));
  }
}

// ============================================================================
// PIPELINE RESOLVER
// ============================================================================

class PipelineResolver {
  /**
   * @param {ConverterRegistry} registry
   */
  constructor(registry) {
    this._registry = registry;
  }

  /**
   * Find the shortest conversion path between two formats.
   * Uses BFS on the format graph.
   *
   * @param {string} from - Source format
   * @param {string} to - Target format
   * @returns {{ path: string[], agents: string[] } | null}
   */
  resolve(from, to) {
    if (from === to) return { path: [from], agents: [] };

    const graph = this._registry.getGraph();

    // BFS
    const queue = [[from]];
    const visited = new Set([from]);

    while (queue.length > 0) {
      const currentPath = queue.shift();
      const current = currentPath[currentPath.length - 1];

      const neighbors = graph.get(current);
      if (!neighbors) continue;

      for (const [nextFmt, _agentId] of neighbors.entries()) {
        if (nextFmt === to) {
          // Found path
          const fullPath = [...currentPath, to];
          const agents = [];
          for (let i = 0; i < fullPath.length - 1; i++) {
            const edge = graph.get(fullPath[i])?.get(fullPath[i + 1]);
            if (edge) agents.push(edge);
          }
          return { path: fullPath, agents };
        }

        if (!visited.has(nextFmt)) {
          visited.add(nextFmt);
          queue.push([...currentPath, nextFmt]);
        }
      }
    }

    return null; // No path found
  }

  /**
   * Get the full format graph for visualization.
   */
  getFullGraph() {
    const graph = this._registry.getGraph();
    const nodes = new Set();
    const edges = [];

    for (const [from, neighbors] of graph.entries()) {
      nodes.add(from);
      for (const [to, agentId] of neighbors.entries()) {
        nodes.add(to);
        edges.push({ from, to, agent: agentId });
      }
    }

    return { nodes: Array.from(nodes), edges };
  }
}

// ============================================================================
// JOB MANAGER (for async long-running conversions)
// ============================================================================

class JobManager {
  constructor() {
    /** @type {Map<string, Object>} */
    this._jobs = new Map();
    this._maxConcurrent = 5;
    this._activeCount = 0;
  }

  /**
   * Create a new async conversion job.
   * @param {Function} convertFn - Async function that performs the conversion
   * @returns {string} Job ID
   */
  create(convertFn) {
    const jobId = uuidv4();
    const job = {
      id: jobId,
      status: 'queued',
      progress: 0,
      progressStage: '',
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
    };
    this._jobs.set(jobId, job);
    this._runJob(jobId, convertFn);
    return jobId;
  }

  /**
   * Get job status.
   * @param {string} jobId
   */
  get(jobId) {
    return this._jobs.get(jobId) || null;
  }

  /**
   * Internal: run the job.
   */
  async _runJob(jobId, convertFn) {
    const job = this._jobs.get(jobId);
    if (!job) return;

    // Wait for capacity
    while (this._activeCount >= this._maxConcurrent) {
      await new Promise((r) => {
        setTimeout(r, 500);
      });
    }

    this._activeCount++;
    job.status = 'running';
    job.startedAt = new Date().toISOString();

    try {
      const result = await convertFn((stage, current, total) => {
        job.progressStage = stage;
        job.progress = Math.round((current / total) * 100);
      });
      job.status = 'completed';
      job.result = result;
    } catch (err) {
      job.status = 'failed';
      job.error = err.message;
    } finally {
      job.completedAt = new Date().toISOString();
      this._activeCount--;
      // Clean up old jobs after 1 hour
      setTimeout(() => this._jobs.delete(jobId), 3600000);
    }
  }
}

// ============================================================================
// CONVERSION SERVICE (main export)
// ============================================================================

class ConversionService {
  constructor() {
    this.registry = new ConverterRegistry();
    this.resolver = new PipelineResolver(this.registry);
    this.jobs = new JobManager();
    this._initialized = false;
  }

  /**
   * Initialize: auto-discover and register all converter agents.
   */
  async initialize() {
    if (this._initialized) return;

    const convertersDir = path.join(__dirname, 'converters');
    if (!fs.existsSync(convertersDir)) {
      log.warn('app', 'Converters directory not found', { convertersDir: convertersDir });
      this._initialized = true;
      return;
    }

    const files = fs
      .readdirSync(convertersDir)
      .filter(
        (f) =>
          f.endsWith('.js') &&
          f !== 'base-converter-agent.js' &&
          f !== 'playbook-validator.js' &&
          f !== 'playbook-diagnostics.js'
      );

    for (const file of files) {
      try {
        const mod = require(path.join(convertersDir, file));
        // Each module exports a class or an instance
        const AgentClass = mod.default || mod[Object.keys(mod).find((k) => k !== 'BaseConverterAgent')];
        if (AgentClass && typeof AgentClass === 'function') {
          const agent = new AgentClass();
          this.registry.register(agent);
        } else if (AgentClass && AgentClass.id) {
          // Exported an instance
          this.registry.register(AgentClass);
        }
      } catch (err) {
        log.warn('app', 'Failed to load converter', { file: file, error: err.message });
      }
    }

    log.info('app', 'Loaded converter agents', { this: this.registry.all().length });
    this._initialized = true;
  }

  /**
   * Convert content from one format to another.
   *
   * @param {Object} params
   * @param {*} params.input - Input content (Buffer, string, file path, etc.)
   * @param {string} params.from - Source format
   * @param {string} params.to - Target format
   * @param {string} [params.mode] - 'symbolic' | 'generative' | 'auto'
   * @param {Object} [params.options] - Converter-specific options
   * @param {boolean} [params.async] - Return a job ID for long-running conversions
   * @returns {Promise<Object>}
   */
  async convert(params) {
    await this.initialize();

    const { input, from, to, mode, options = {}, async: isAsync } = params;

    // Find direct agent
    const agents = this.registry.find(from, to);

    if (agents.length > 0) {
      // Filter by mode if specified
      let agent = agents[0];
      if (mode && mode !== 'auto') {
        const modeAgent = agents.find((a) => a.modes.includes(mode));
        if (modeAgent) agent = modeAgent;
      }

      if (isAsync) {
        const jobId = this.jobs.create((onProgress) => agent.convert(input, { ...options, onProgress }));
        return { jobId, status: 'queued' };
      }

      return agent.convert(input, options);
    }

    // No direct agent; try pipeline
    const pipeline = this.resolver.resolve(from, to);
    if (!pipeline) {
      return {
        success: false,
        output: null,
        report: {
          agentId: 'conversion-service',
          agentName: 'Conversion Service',
          success: false,
          finalScore: 0,
          totalDuration: 0,
          attempts: [],
          decision: {
            strategyUsed: 'none',
            whyThisStrategy: `No conversion path found from "${from}" to "${to}"`,
            alternativesConsidered: [],
            retryCount: 0,
          },
        },
      };
    }

    // Execute pipeline
    if (isAsync) {
      const jobId = this.jobs.create((onProgress) => this._executePipeline(input, pipeline, options, onProgress));
      return { jobId, status: 'queued' };
    }

    return this._executePipeline(input, pipeline, options);
  }

  /**
   * Execute a multi-step pipeline.
   */
  async _executePipeline(input, pipeline, options = {}, onProgress) {
    const steps = [];
    let currentInput = input;

    for (let i = 0; i < pipeline.agents.length; i++) {
      const agentId = pipeline.agents[i];
      const agent = this.registry.get(agentId);
      if (!agent) {
        return {
          success: false,
          output: null,
          report: { error: `Pipeline agent not found: ${agentId}` },
        };
      }

      if (onProgress) onProgress('pipeline', i + 1, pipeline.agents.length);

      const stepStart = Date.now();
      const result = await agent.convert(currentInput, options);

      steps.push({
        agent: agentId,
        from: pipeline.path[i],
        to: pipeline.path[i + 1],
        success: result.success,
        score: result.report?.finalScore || 0,
        duration: Date.now() - stepStart,
      });

      if (!result.success) {
        return {
          success: false,
          output: result.output,
          pipelineSteps: steps,
          failedAt: agentId,
          report: result.report,
        };
      }

      currentInput = result.output;
    }

    return {
      success: true,
      output: currentInput,
      pipelineSteps: steps,
      report: {
        agentId: 'pipeline',
        agentName: `Pipeline: ${pipeline.path.join(' -> ')}`,
        success: true,
        finalScore: Math.min(...steps.map((s) => s.score)),
        totalDuration: steps.reduce((sum, s) => sum + s.duration, 0),
        attempts: steps,
        decision: {
          strategyUsed: 'pipeline',
          whyThisStrategy: `Multi-step conversion: ${pipeline.path.join(' -> ')}`,
          alternativesConsidered: [],
          retryCount: 0,
        },
      },
    };
  }

  /**
   * Execute an explicit multi-step pipeline.
   */
  async pipeline(params) {
    await this.initialize();
    const { input, steps, options = {} } = params;

    let currentInput = input;
    const records = [];

    for (const step of steps) {
      const result = await this.convert({
        input: currentInput,
        from: step.from || 'auto',
        to: step.to,
        mode: step.mode,
        options: { ...options, ...step.options },
      });

      records.push({
        to: step.to,
        success: result.success,
        report: result.report,
      });

      if (!result.success) {
        return { success: false, output: null, steps: records };
      }

      currentInput = result.output;
    }

    return { success: true, output: currentInput, steps: records };
  }

  /**
   * Get all capabilities.
   */
  async capabilities() {
    await this.initialize();
    return this.registry.capabilities();
  }

  /**
   * Get the format conversion graph.
   */
  async graph() {
    await this.initialize();
    return this.resolver.getFullGraph();
  }

  /**
   * Get job status.
   */
  jobStatus(jobId) {
    return this.jobs.get(jobId);
  }
}

// Singleton
const service = new ConversionService();
module.exports = service;
module.exports.ConversionService = ConversionService;
module.exports.ConverterRegistry = ConverterRegistry;
module.exports.PipelineResolver = PipelineResolver;
module.exports.JobManager = JobManager;
