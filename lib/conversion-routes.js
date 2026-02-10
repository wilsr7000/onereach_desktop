/**
 * Conversion API Routes
 *
 * @description Express-compatible route handler module for the conversion
 *   service. Mounts RESTful endpoints for converting content between formats,
 *   querying capabilities, running pipelines, and validating/diagnosing
 *   playbooks.
 *
 * @usage
 *   const express = require('express');
 *   const conversionService = require('./lib/conversion-service');
 *   const mountConversionRoutes = require('./lib/conversion-routes');
 *
 *   const app = express();
 *   app.use(express.json({ limit: '50mb' }));
 *   mountConversionRoutes(app, conversionService);
 *
 * @routes
 *   POST   /api/convert                  - Convert content between formats
 *   GET    /api/convert/capabilities      - List all converter capabilities
 *   GET    /api/convert/graph             - Get the format conversion graph
 *   POST   /api/convert/pipeline          - Run a multi-step conversion pipeline
 *   GET    /api/convert/status/:jobId     - Check async conversion job status
 *   POST   /api/convert/validate/playbook - Validate a playbook
 *   POST   /api/convert/diagnose/playbook - Diagnose playbook issues
 *
 * @see lib/conversion-service.js
 * @see lib/converters/base-converter-agent.js
 */

'use strict';

const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

/**
 * Mount conversion API routes on an Express application.
 *
 * @param {import('express').Application} app - Express application instance
 * @param {import('./conversion-service')} conversionService - Initialized conversion service
 */
function mountConversionRoutes(app, conversionService) {
  if (!app || typeof app.post !== 'function') {
    throw new Error('[ConversionAPI] Invalid Express app instance');
  }
  if (!conversionService || typeof conversionService.convert !== 'function') {
    throw new Error('[ConversionAPI] Invalid conversion service instance');
  }

  // ==========================================================================
  // POST /api/convert -- Convert content between formats
  // ==========================================================================

  app.post('/api/convert', async (req, res) => {
    const startTime = Date.now();

    try {
      const { input, from, to, mode, options, async: isAsync } = req.body;

      // Validate required fields
      if (!input) {
        log.info('app', 'POST /api/convert -- missing input');
        return res.status(400).json({
          error: 'Missing required field: input',
          message: 'The "input" field is required. Provide a base64 string or plain text.',
        });
      }
      if (!from) {
        log.info('app', 'POST /api/convert -- missing from');
        return res.status(400).json({
          error: 'Missing required field: from',
          message: 'The "from" field is required. Specify the source format (e.g. "text", "pdf").',
        });
      }
      if (!to) {
        log.info('app', 'POST /api/convert -- missing to');
        return res.status(400).json({
          error: 'Missing required field: to',
          message: 'The "to" field is required. Specify the target format (e.g. "md", "html").',
        });
      }

      // Decode base64 input to Buffer if it looks like base64
      let decodedInput = input;
      if (typeof input === 'string' && _isLikelyBase64(input)) {
        try {
          decodedInput = Buffer.from(input, 'base64');
          log.info('app', 'POST /api/convert -- decoded base64 input', { bytes: decodedInput.length });
        } catch {
          // Not valid base64; use as-is
          decodedInput = input;
        }
      }

      log.info('app', 'POST /api/convert', { from, to, mode: mode || 'auto', async: !!isAsync });

      // Async conversion: return job ID immediately
      if (isAsync) {
        const result = await conversionService.convert({
          input: decodedInput,
          from,
          to,
          mode: mode || 'auto',
          options: options || {},
          async: true,
        });

        log.info('app', 'POST /api/convert -- async job created', { jobId: result.jobId });
        return res.status(202).json({
          jobId: result.jobId,
          status: 'queued',
          message: 'Conversion job queued. Poll GET /api/convert/status/:jobId for progress.',
        });
      }

      // Synchronous conversion
      const result = await conversionService.convert({
        input: decodedInput,
        from,
        to,
        mode: mode || 'auto',
        options: options || {},
      });

      const elapsed = Date.now() - startTime;
      log.info('app', 'POST /api/convert -- completed', { elapsed, success: result.success });

      // If output is a Buffer, encode as base64 in the response
      if (result.output && Buffer.isBuffer(result.output)) {
        result.output = result.output.toString('base64');
        result.outputEncoding = 'base64';
      }

      return res.status(200).json(result);
    } catch (err) {
      const elapsed = Date.now() - startTime;
      log.error('app', 'POST /api/convert -- error', { elapsed, error: err.message });
      return res.status(500).json({
        error: 'Conversion failed',
        message: err.message,
        duration: elapsed,
      });
    }
  });

  // ==========================================================================
  // GET /api/convert/capabilities -- List all converter capabilities
  // ==========================================================================

  app.get('/api/convert/capabilities', async (req, res) => {
    try {
      log.info('app', 'GET /api/convert/capabilities');
      const capabilities = await conversionService.capabilities();
      return res.status(200).json({
        converters: capabilities,
        count: capabilities.length,
      });
    } catch (err) {
      log.error('app', 'GET /api/convert/capabilities -- error', { error: err.message });
      return res.status(500).json({
        error: 'Failed to retrieve capabilities',
        message: err.message,
      });
    }
  });

  // ==========================================================================
  // GET /api/convert/graph -- Get the format conversion graph
  // ==========================================================================

  app.get('/api/convert/graph', async (req, res) => {
    try {
      log.info('app', 'GET /api/convert/graph');
      const graph = await conversionService.graph();
      return res.status(200).json(graph);
    } catch (err) {
      log.error('app', 'GET /api/convert/graph -- error', { error: err.message });
      return res.status(500).json({
        error: 'Failed to retrieve conversion graph',
        message: err.message,
      });
    }
  });

  // ==========================================================================
  // POST /api/convert/pipeline -- Run a multi-step conversion pipeline
  // ==========================================================================

  app.post('/api/convert/pipeline', async (req, res) => {
    const startTime = Date.now();

    try {
      const { input, steps } = req.body;

      if (!input) {
        log.info('app', 'POST /api/convert/pipeline -- missing input');
        return res.status(400).json({
          error: 'Missing required field: input',
          message: 'The "input" field is required.',
        });
      }
      if (!steps || !Array.isArray(steps) || steps.length === 0) {
        log.info('app', 'POST /api/convert/pipeline -- missing or empty steps');
        return res.status(400).json({
          error: 'Missing required field: steps',
          message: 'The "steps" field must be a non-empty array of conversion steps. Each step needs at least a "to" field.',
        });
      }

      // Decode base64 input if applicable
      let decodedInput = input;
      if (typeof input === 'string' && _isLikelyBase64(input)) {
        try {
          decodedInput = Buffer.from(input, 'base64');
        } catch {
          decodedInput = input;
        }
      }

      log.info('app', 'POST /api/convert/pipeline', { stepCount: steps.length, pipeline: steps.map(s => s.to).join(' -> ') });

      const result = await conversionService.pipeline({
        input: decodedInput,
        steps,
      });

      const elapsed = Date.now() - startTime;
      log.info('app', 'POST /api/convert/pipeline -- completed', { elapsed, success: result.success });

      // Encode Buffer output as base64
      if (result.output && Buffer.isBuffer(result.output)) {
        result.output = result.output.toString('base64');
        result.outputEncoding = 'base64';
      }

      return res.status(200).json(result);
    } catch (err) {
      const elapsed = Date.now() - startTime;
      log.error('app', 'POST /api/convert/pipeline -- error', { elapsed, error: err.message });
      return res.status(500).json({
        error: 'Pipeline failed',
        message: err.message,
        duration: elapsed,
      });
    }
  });

  // ==========================================================================
  // GET /api/convert/status/:jobId -- Check async conversion job status
  // ==========================================================================

  app.get('/api/convert/status/:jobId', (req, res) => {
    try {
      const { jobId } = req.params;
      log.info('app', 'GET /api/convert/status', { jobId });

      const job = conversionService.jobStatus(jobId);
      if (!job) {
        return res.status(404).json({
          error: 'Job not found',
          message: `No conversion job found with ID: ${jobId}`,
        });
      }

      // Encode Buffer output in completed jobs
      const response = { ...job };
      if (response.result && response.result.output && Buffer.isBuffer(response.result.output)) {
        response.result.output = response.result.output.toString('base64');
        response.result.outputEncoding = 'base64';
      }

      return res.status(200).json(response);
    } catch (err) {
      log.error('app', 'GET /api/convert/status -- error', { jobId: req.params.jobId, error: err.message });
      return res.status(500).json({
        error: 'Failed to retrieve job status',
        message: err.message,
      });
    }
  });

  // ==========================================================================
  // POST /api/convert/validate/playbook -- Validate a playbook
  // ==========================================================================

  app.post('/api/convert/validate/playbook', async (req, res) => {
    try {
      const { playbook, framework, graphNode } = req.body;

      if (!playbook) {
        log.info('app', 'POST /api/convert/validate/playbook -- missing playbook');
        return res.status(400).json({
          error: 'Missing required field: playbook',
          message: 'The "playbook" field is required for validation.',
        });
      }

      log.info('app', 'POST /api/convert/validate/playbook');

      let validator;
      try {
        validator = require('./converters/playbook-validator');
      } catch (loadErr) {
        log.error('app', 'POST /api/convert/validate/playbook -- validator not found', { error: loadErr.message });
        return res.status(500).json({
          error: 'Playbook validator not available',
          message: `Could not load playbook-validator module: ${loadErr.message}`,
        });
      }

      const result = await validator.validate({ playbook, framework, graphNode });
      return res.status(200).json(result);
    } catch (err) {
      log.error('app', 'POST /api/convert/validate/playbook -- error', { error: err.message });
      return res.status(500).json({
        error: 'Playbook validation failed',
        message: err.message,
      });
    }
  });

  // ==========================================================================
  // POST /api/convert/diagnose/playbook -- Diagnose playbook issues
  // ==========================================================================

  app.post('/api/convert/diagnose/playbook', async (req, res) => {
    try {
      const { playbook, framework, graphNode, sourceContent, validationResult } = req.body;

      if (!playbook) {
        log.info('app', 'POST /api/convert/diagnose/playbook -- missing playbook');
        return res.status(400).json({
          error: 'Missing required field: playbook',
          message: 'The "playbook" field is required for diagnosis.',
        });
      }

      log.info('app', 'POST /api/convert/diagnose/playbook');

      let diagnostics;
      try {
        diagnostics = require('./converters/playbook-diagnostics');
      } catch (loadErr) {
        log.error('app', 'POST /api/convert/diagnose/playbook -- diagnostics not found', { error: loadErr.message });
        return res.status(500).json({
          error: 'Playbook diagnostics not available',
          message: `Could not load playbook-diagnostics module: ${loadErr.message}`,
        });
      }

      const result = await diagnostics.diagnose({ playbook, framework, graphNode, sourceContent, validationResult });
      return res.status(200).json(result);
    } catch (err) {
      log.error('app', 'POST /api/convert/diagnose/playbook -- error', { error: err.message });
      return res.status(500).json({
        error: 'Playbook diagnosis failed',
        message: err.message,
      });
    }
  });

  log.info('app', 'ConversionAPI routes mounted', { routes: ['/api/convert', '/api/convert/capabilities', '/api/convert/graph', '/api/convert/pipeline', '/api/convert/status/:jobId', '/api/convert/validate/playbook', '/api/convert/diagnose/playbook'] });
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Heuristic check for whether a string looks like base64-encoded data.
 * Returns true if the string is long, contains only base64 characters,
 * and has a length that's roughly a multiple of 4.
 *
 * @private
 * @param {string} str
 * @returns {boolean}
 */
function _isLikelyBase64(str) {
  if (!str || str.length < 100) return false;
  // Check that it's mostly base64 characters
  if (!/^[A-Za-z0-9+/\n\r]+=*$/.test(str.substring(0, 500))) return false;
  // Natural language text almost always has spaces; base64 does not
  if (str.includes(' ')) return false;
  return true;
}

module.exports = mountConversionRoutes;
