/**
 * BaseConverterAgent
 *
 * @description Base class for all file converter agents. Implements the
 *   plan -> execute -> evaluate lifecycle with agentic retry.
 *   Every converter agent extends this class and overrides the core methods.
 *
 * @pattern Follows packages/agents/ patterns: LLM-driven strategy selection,
 *   self-evaluation, agentic retry (see packages/agents/agentic-retry.js).
 *
 * @lifecycle
 *   1. plan(input, options)    - Inspect input, choose strategy
 *   2. execute(input, strategy) - Run the conversion
 *   3. evaluate(input, output)  - Judge output quality
 *   4. convert(input, options)  - Full lifecycle with retry loop
 *
 * @see lib/converters/README.md for architecture documentation
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const { EventEmitter } = require('events');

// Try to load AI service; may not be available in test environments
let ai;
try {
  ai = require('../ai-service');
  const { getLogQueue } = require('./../log-event-queue');
  const _log = getLogQueue();
} catch (_e) {
  ai = null;
}

// ============================================================================
// EVENT LOGGER
// ============================================================================

/**
 * Structured event logger for converter agents.
 * Emits events for every lifecycle phase, making debugging transparent.
 *
 * Events emitted:
 *   converter:start        - Conversion begins
 *   converter:plan         - Strategy selected
 *   converter:plan:fallback - LLM plan failed, using fallback
 *   converter:execute      - Execution begins
 *   converter:execute:done - Execution completed
 *   converter:execute:error - Execution failed
 *   converter:evaluate     - Evaluation begins
 *   converter:evaluate:done - Evaluation completed
 *   converter:evaluate:issue - Issue detected during evaluation
 *   converter:retry        - Retrying with new strategy
 *   converter:success      - Conversion succeeded
 *   converter:fail         - Conversion failed after all attempts
 *   converter:llm:call     - LLM API call made
 *   converter:llm:error    - LLM API call failed
 */
class ConverterEventLogger extends EventEmitter {
  constructor(agentId, agentName) {
    super();
    this.agentId = agentId;
    this.agentName = agentName;
    // IMPORTANT: Must NOT use _events -- that is EventEmitter's internal listener storage
    this._eventLog = [];
    this._startTime = null;
  }

  /**
   * Log a structured event with timestamp and context.
   * Also emits the event for external listeners.
   */
  log(event, data = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      elapsed: this._startTime ? Date.now() - this._startTime : 0,
      agent: this.agentId,
      event,
      ...data,
    };
    this._eventLog.push(entry);

    // Console log with tag for grep-ability
    const level =
      event.includes('error') || event.includes('fail')
        ? 'error'
        : event.includes('warn') || event.includes('issue')
          ? 'warn'
          : 'log';
    const prefix = `[${this.agentId}][${entry.elapsed}ms]`;
    const summary = data.message || data.strategy || data.score !== undefined ? `score=${data.score}` : '';

    if (level === 'error') {
      console.error(`${prefix} ${event}: ${summary}`, data.error || '');
    } else if (level === 'warn') {
      console.warn(`${prefix} ${event}: ${summary}`);
    } else {
      console.log(`${prefix} ${event}: ${summary}`);
    }

    this.emit(event, entry);
    this.emit('converter:event', entry);
  }

  /**
   * Mark the start of a conversion (resets timer).
   */
  start(conversionId, inputDesc) {
    this._startTime = Date.now();
    this._eventLog = [];
    this.log('converter:start', { conversionId, input: inputDesc });
  }

  /**
   * Get all events for this conversion (for the report).
   */
  getEvents() {
    return [...this._eventLog];
  }
}

/**
 * @typedef {Object} Strategy
 * @property {string} id - Unique strategy identifier
 * @property {string} description - Human-readable description
 * @property {string} when - When this strategy is best
 * @property {string} engine - What engine/library it uses
 * @property {string} mode - 'symbolic' | 'generative' | 'hybrid'
 * @property {string} speed - 'fast' | 'medium' | 'slow'
 * @property {string} quality - Quality description
 */

/**
 * @typedef {Object} PlanResult
 * @property {string} strategy - Selected strategy ID
 * @property {string} reasoning - Why this strategy was chosen
 * @property {number} [estimatedQuality] - Expected quality 0-100
 * @property {number} [estimatedDuration] - Expected duration in ms
 */

/**
 * @typedef {Object} ExecuteResult
 * @property {*} output - The converted content
 * @property {Object} metadata - Conversion metadata
 * @property {number} duration - Execution time in ms
 * @property {string} strategy - Strategy that was used
 */

/**
 * @typedef {Object} EvaluationIssue
 * @property {string} code - Machine-readable error code
 * @property {string} severity - 'error' | 'warning' | 'info'
 * @property {string} message - Human-readable description
 * @property {boolean} fixable - Can this be auto-fixed by retrying?
 * @property {string} [suggestedStrategy] - Strategy to try instead
 */

/**
 * @typedef {Object} EvaluationResult
 * @property {boolean} pass - Did the output pass quality checks?
 * @property {number} score - Quality score 0-100
 * @property {EvaluationIssue[]} issues - Detected issues
 * @property {string} reasoning - LLM explanation of the evaluation
 */

/**
 * @typedef {Object} AttemptRecord
 * @property {number} attempt - Attempt number (1-based)
 * @property {string} strategy - Strategy used
 * @property {string} reasoning - Why this strategy was chosen
 * @property {number} score - Evaluation score
 * @property {EvaluationIssue[]} issues - Issues found
 * @property {string} evaluationReasoning - Evaluation explanation
 * @property {number} duration - Execution time in ms
 */

/**
 * @typedef {Object} ExecutionReport
 * @property {string} agentId - Converter agent ID
 * @property {string} agentName - Converter agent name
 * @property {boolean} success - Did any attempt pass?
 * @property {number} finalScore - Best score achieved
 * @property {number} totalDuration - Total time across all attempts
 * @property {AttemptRecord[]} attempts - All attempt records
 * @property {Object} decision - Final decision summary
 * @property {string} decision.strategyUsed - Winning strategy
 * @property {string} decision.whyThisStrategy - Explanation
 * @property {string[]} decision.alternativesConsidered - Other strategies tried
 * @property {number} decision.retryCount - Number of retries
 */

/**
 * @typedef {Object} ConvertResult
 * @property {boolean} success - Did conversion succeed?
 * @property {*} output - Converted content (best attempt)
 * @property {Object} [metadata] - Output metadata
 * @property {ExecutionReport} report - Full execution report
 * @property {Object} [diagnosis] - Diagnosis if failed
 */

class BaseConverterAgent {
  /**
   * @param {Object} config
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {boolean} [config.silent] - Suppress console logging (for tests)
   */
  constructor(config = {}) {
    // Identity - subclasses MUST override these
    this.id = 'converter:base';
    this.name = 'Base Converter';
    this.description = 'Base converter agent - do not use directly';
    this.from = [];
    this.to = [];
    this.modes = [];

    // Strategies - subclasses MUST override
    this.strategies = [];

    // Configuration
    this.maxAttempts = config.maxAttempts || 3;
    this.minPassScore = config.minPassScore || 60;

    // AI service (injectable for testing)
    this._ai = config.ai || ai;

    // Conversion ID for tracking
    this._conversionId = null;

    // Event logger -- initialized lazily after subclass sets id/name
    this._logger = null;
    this._silent = config.silent || false;
  }

  /**
   * Get the event logger (lazy init after subclass constructor runs).
   * @returns {ConverterEventLogger}
   */
  get logger() {
    if (!this._logger) {
      this._logger = new ConverterEventLogger(this.id, this.name);
      if (this._silent) {
        // Suppress console output but still collect events
        this._logger.log = function (event, data = {}) {
          const entry = {
            timestamp: new Date().toISOString(),
            elapsed: this._startTime ? Date.now() - this._startTime : 0,
            agent: this.agentId,
            event,
            ...data,
          };
          this._eventLog.push(entry);
          this.emit(event, entry);
          this.emit('converter:event', entry);
        };
      }
    }
    return this._logger;
  }

  // =========================================================================
  // LIFECYCLE METHODS - Override in subclasses
  // =========================================================================

  /**
   * 1. PLAN: Inspect input and choose a conversion strategy.
   *
   * The base implementation uses LLM to pick from available strategies
   * based on input characteristics. Override for custom planning logic.
   *
   * @param {*} input - Input content (Buffer, string, path, etc.)
   * @param {Object} [options] - Conversion options
   * @param {AttemptRecord[]} [options.previousAttempts] - Past attempts for retry context
   * @param {Object} [options.metadata] - Input metadata hints
   * @returns {Promise<PlanResult>}
   */
  async plan(input, options = {}) {
    const { previousAttempts = [], metadata = {} } = options;
    const inputDesc = this._describeInput(input, metadata);

    this.logger.log('converter:plan', {
      message: `Planning conversion`,
      inputDescription: inputDesc,
      availableStrategies: this.strategies.map((s) => s.id),
      previousAttemptCount: previousAttempts.length,
    });

    // If only one strategy, use it
    if (this.strategies.length === 1) {
      const result = {
        strategy: this.strategies[0].id,
        reasoning: `Only one strategy available: ${this.strategies[0].description}`,
        estimatedQuality: 80,
      };
      this.logger.log('converter:plan:selected', {
        message: `Selected strategy: ${result.strategy}`,
        strategy: result.strategy,
        reasoning: result.reasoning,
        method: 'single-strategy',
      });
      return result;
    }

    // If retrying, exclude strategies that already failed
    const failedStrategies = previousAttempts.filter((a) => a.score < this.minPassScore).map((a) => a.strategy);

    if (failedStrategies.length > 0) {
      this.logger.log('converter:plan:excluding', {
        message: `Excluding failed strategies: ${failedStrategies.join(', ')}`,
        failedStrategies,
      });
    }

    const availableStrategies = this.strategies.filter((s) => !failedStrategies.includes(s.id));

    if (availableStrategies.length === 0) {
      const bestPrevious = previousAttempts.reduce((best, a) => (a.score > (best?.score || 0) ? a : best), null);
      const result = {
        strategy: bestPrevious?.strategy || this.strategies[0].id,
        reasoning: 'All strategies exhausted. Retrying best previous attempt.',
      };
      this.logger.log('converter:plan:exhausted', {
        message: `All strategies exhausted, retrying best: ${result.strategy}`,
        strategy: result.strategy,
      });
      return result;
    }

    // Use LLM to pick strategy
    if (this._ai) {
      try {
        this.logger.log('converter:llm:call', {
          message: 'Calling LLM for strategy selection',
          purpose: 'plan',
          strategyCount: availableStrategies.length,
        });

        const strategyList = availableStrategies
          .map((s) => `- "${s.id}": ${s.description}. Best when: ${s.when}. Speed: ${s.speed}. Quality: ${s.quality}`)
          .join('\n');

        const previousContext =
          previousAttempts.length > 0
            ? `\nPrevious attempts:\n${previousAttempts
                .map(
                  (a, i) =>
                    `${i + 1}. Strategy "${a.strategy}" scored ${a.score}/100. Issues: ${a.issues?.map((i) => i.message).join('; ') || 'none'}`
                )
                .join('\n')}`
            : '';

        const result = await this._ai.json(
          `You are a conversion strategy selector for ${this.name}.
Choose the best strategy for this input.

Input: ${inputDesc}
${previousContext}

Available strategies:
${strategyList}

Return JSON: { "strategy": "strategy_id", "reasoning": "brief explanation" }`,
          { profile: 'fast', feature: 'converter-plan', temperature: 0 }
        );

        if (result && result.strategy && availableStrategies.find((s) => s.id === result.strategy)) {
          this.logger.log('converter:plan:selected', {
            message: `LLM selected strategy: ${result.strategy}`,
            strategy: result.strategy,
            reasoning: result.reasoning,
            method: 'llm',
          });
          return {
            strategy: result.strategy,
            reasoning: result.reasoning || 'LLM selected strategy',
          };
        }

        this.logger.log('converter:plan:fallback', {
          message: 'LLM returned invalid strategy, falling back to default',
          llmResponse: result,
        });
      } catch (err) {
        this.logger.log('converter:llm:error', {
          message: `LLM plan failed: ${err.message}`,
          error: err.message,
          purpose: 'plan',
        });
      }
    }

    // Fallback: use first available strategy
    const fallback = {
      strategy: availableStrategies[0].id,
      reasoning: `Default: using first available strategy "${availableStrategies[0].id}"`,
    };
    this.logger.log('converter:plan:selected', {
      message: `Using fallback strategy: ${fallback.strategy}`,
      strategy: fallback.strategy,
      reasoning: fallback.reasoning,
      method: 'fallback',
    });
    return fallback;
  }

  /**
   * 2. EXECUTE: Run the conversion with the chosen strategy.
   *
   * Subclasses MUST override this method.
   *
   * @param {*} input - Input content
   * @param {string} strategy - Strategy ID to use
   * @param {Object} [options] - Conversion options
   * @returns {Promise<ExecuteResult>}
   */
  async execute(input, strategy, _options = {}) {
    throw new Error(`${this.id}: execute() not implemented. Subclasses must override.`);
  }

  /**
   * 3. EVALUATE: Judge the quality of the conversion output.
   *
   * The base implementation does structural checks + optional LLM spot-check.
   * Override for domain-specific evaluation.
   *
   * @param {*} input - Original input
   * @param {*} output - Conversion output
   * @param {string} strategy - Strategy that was used
   * @returns {Promise<EvaluationResult>}
   */
  async evaluate(input, output, strategy) {
    const issues = [];
    const outputDesc =
      output === null
        ? 'null'
        : output === undefined
          ? 'undefined'
          : Buffer.isBuffer(output)
            ? `Buffer(${output.length} bytes)`
            : typeof output === 'string'
              ? `String(${output.length} chars)`
              : typeof output === 'object'
                ? `Object(${Object.keys(output).join(',')})`
                : typeof output;

    this.logger.log('converter:evaluate', {
      message: `Evaluating output from strategy "${strategy}"`,
      strategy,
      outputType: outputDesc,
    });

    // Basic structural check: output exists
    if (output === null || output === undefined) {
      issues.push({
        code: 'OUTPUT_NULL',
        severity: 'error',
        message: 'Conversion produced null/undefined output',
        fixable: true,
      });
      this.logger.log('converter:evaluate:issue', {
        code: 'OUTPUT_NULL',
        severity: 'error',
        message: 'Output is null/undefined',
      });
      return { pass: false, score: 0, issues, reasoning: 'No output produced' };
    }

    // Check for empty output
    if (typeof output === 'string' && output.trim().length === 0) {
      issues.push({
        code: 'OUTPUT_EMPTY',
        severity: 'error',
        message: 'Conversion produced empty string output',
        fixable: true,
      });
      this.logger.log('converter:evaluate:issue', {
        code: 'OUTPUT_EMPTY',
        severity: 'error',
        message: 'Empty string output',
      });
      return { pass: false, score: 10, issues, reasoning: 'Empty output' };
    }

    if (Buffer.isBuffer(output) && output.length === 0) {
      issues.push({
        code: 'OUTPUT_EMPTY_BUFFER',
        severity: 'error',
        message: 'Conversion produced empty buffer',
        fixable: true,
      });
      this.logger.log('converter:evaluate:issue', { code: 'OUTPUT_EMPTY_BUFFER', severity: 'error' });
      return { pass: false, score: 10, issues, reasoning: 'Empty buffer output' };
    }

    // If output is an object with a content field, check that
    if (output && typeof output === 'object' && 'content' in output) {
      if (!output.content || (typeof output.content === 'string' && output.content.trim().length === 0)) {
        issues.push({
          code: 'CONTENT_EMPTY',
          severity: 'error',
          message: 'Output content field is empty',
          fixable: true,
        });
        this.logger.log('converter:evaluate:issue', { code: 'CONTENT_EMPTY', severity: 'error' });
        return { pass: false, score: 15, issues, reasoning: 'Empty content field' };
      }
    }

    // Run subclass-specific structural checks
    this.logger.log('converter:evaluate:structural', { message: 'Running structural checks' });
    const structuralIssues = await this._structuralChecks(input, output, strategy);
    issues.push(...structuralIssues);

    for (const issue of structuralIssues) {
      this.logger.log('converter:evaluate:issue', {
        code: issue.code,
        severity: issue.severity,
        message: issue.message,
        fixable: issue.fixable,
      });
    }

    const hasErrors = issues.some((i) => i.severity === 'error');
    if (hasErrors) {
      const score = Math.max(0, 40 - issues.filter((i) => i.severity === 'error').length * 15);
      const result = {
        pass: false,
        score,
        issues,
        reasoning: `Structural checks failed: ${issues
          .filter((i) => i.severity === 'error')
          .map((i) => i.message)
          .join('; ')}`,
      };
      this.logger.log('converter:evaluate:done', {
        message: `Evaluation FAILED (structural): score=${score}`,
        pass: false,
        score,
        errorCount: issues.filter((i) => i.severity === 'error').length,
        warningCount: issues.filter((i) => i.severity === 'warning').length,
      });
      return result;
    }

    // LLM spot-check for quality (generative modes)
    if (this._ai && this.modes.includes('generative')) {
      try {
        this.logger.log('converter:llm:call', { message: 'Running LLM quality spot-check', purpose: 'evaluate' });
        const spotCheck = await this._llmSpotCheck(input, output, strategy);
        issues.push(...(spotCheck.issues || []));

        for (const issue of spotCheck.issues || []) {
          this.logger.log('converter:evaluate:issue', {
            code: issue.code,
            severity: issue.severity,
            message: issue.message,
            source: 'llm-spot-check',
          });
        }

        const finalScore = spotCheck.score || 80;
        const pass = finalScore >= this.minPassScore && !issues.some((i) => i.severity === 'error');

        this.logger.log('converter:evaluate:done', {
          message: `Evaluation ${pass ? 'PASSED' : 'FAILED'} (LLM): score=${finalScore}`,
          pass,
          score: finalScore,
          reasoning: spotCheck.reasoning,
          errorCount: issues.filter((i) => i.severity === 'error').length,
          warningCount: issues.filter((i) => i.severity === 'warning').length,
        });

        return { pass, score: finalScore, issues, reasoning: spotCheck.reasoning || 'LLM spot-check completed' };
      } catch (err) {
        this.logger.log('converter:llm:error', {
          message: `LLM spot-check failed: ${err.message}`,
          error: err.message,
          purpose: 'evaluate',
        });
      }
    }

    // No LLM check needed or available; pass if no errors
    const warningCount = issues.filter((i) => i.severity === 'warning').length;
    const score = Math.max(60, 90 - warningCount * 10);

    this.logger.log('converter:evaluate:done', {
      message: `Evaluation PASSED (symbolic): score=${score}`,
      pass: true,
      score,
      warningCount,
      issueCount: issues.length,
    });

    return {
      pass: true,
      score,
      issues,
      reasoning: issues.length === 0 ? 'All structural checks passed' : `Passed with ${issues.length} warning(s)`,
    };
  }

  // =========================================================================
  // MAIN CONVERSION METHOD
  // =========================================================================

  /**
   * 4. Full conversion with plan-execute-evaluate retry loop.
   *
   * This is the main entry point for consumers. It orchestrates the
   * full lifecycle and handles retries.
   *
   * @param {*} input - Input content
   * @param {Object} [options] - Conversion options
   * @param {number} [options.maxAttempts] - Override max attempts
   * @param {Function} [options.onProgress] - Progress callback
   * @returns {Promise<ConvertResult>}
   */
  async convert(input, options = {}) {
    this._conversionId = uuidv4();
    const maxAttempts = options.maxAttempts || this.maxAttempts;
    const attempts = [];
    let bestResult = null;
    let bestScore = 0;
    const startTime = Date.now();

    // Start logging
    this.logger.start(this._conversionId, this._describeInput(input, options.metadata));
    this.logger.log('converter:config', {
      message: `Max attempts: ${maxAttempts}, min pass score: ${this.minPassScore}`,
      maxAttempts,
      minPassScore: this.minPassScore,
      modes: this.modes,
      strategyCount: this.strategies.length,
    });

    for (let i = 0; i < maxAttempts; i++) {
      const attemptNum = i + 1;
      this.logger.log('converter:attempt', {
        message: `--- Attempt ${attemptNum}/${maxAttempts} ---`,
        attempt: attemptNum,
        maxAttempts,
      });

      try {
        // PLAN
        if (options.onProgress) options.onProgress('planning', attemptNum, maxAttempts);
        const plan = await this.plan(input, {
          previousAttempts: attempts,
          metadata: options.metadata || {},
          ...options,
        });

        // EXECUTE
        if (options.onProgress) options.onProgress('executing', attemptNum, maxAttempts);
        this.logger.log('converter:execute', {
          message: `Executing strategy "${plan.strategy}"`,
          strategy: plan.strategy,
          attempt: attemptNum,
        });
        const execStart = Date.now();
        let result;
        try {
          result = await this.execute(input, plan.strategy, options);
          const execDuration = Date.now() - execStart;
          this.logger.log('converter:execute:done', {
            message: `Execution completed in ${execDuration}ms`,
            strategy: plan.strategy,
            duration: execDuration,
            outputType: result?.output
              ? Buffer.isBuffer(result.output)
                ? `Buffer(${result.output.length})`
                : typeof result.output
              : 'null',
          });
        } catch (execError) {
          const execDuration = Date.now() - execStart;
          this.logger.log('converter:execute:error', {
            message: `Execution FAILED: ${execError.message}`,
            error: execError.message,
            stack: execError.stack?.split('\n').slice(0, 3).join(' | '),
            strategy: plan.strategy,
            duration: execDuration,
            attempt: attemptNum,
          });
          attempts.push({
            attempt: attemptNum,
            strategy: plan.strategy,
            reasoning: plan.reasoning,
            score: 0,
            issues: [{ code: 'EXECUTION_ERROR', severity: 'error', message: execError.message, fixable: true }],
            evaluationReasoning: `Execution threw: ${execError.message}`,
            duration: execDuration,
          });
          if (attemptNum < maxAttempts) {
            this.logger.log('converter:retry', {
              message: `Will retry (attempt ${attemptNum + 1}/${maxAttempts})`,
              reason: 'execution_error',
              nextAttempt: attemptNum + 1,
            });
          }
          continue;
        }

        // EVALUATE
        if (options.onProgress) options.onProgress('evaluating', attemptNum, maxAttempts);
        const evaluation = await this.evaluate(input, result.output, plan.strategy);

        const attemptRecord = {
          attempt: attemptNum,
          strategy: plan.strategy,
          reasoning: plan.reasoning,
          score: evaluation.score,
          issues: evaluation.issues,
          evaluationReasoning: evaluation.reasoning,
          duration: result.duration || Date.now() - execStart,
        };
        attempts.push(attemptRecord);

        // Track best result
        if (evaluation.score > bestScore) {
          bestScore = evaluation.score;
          bestResult = result;
          this.logger.log('converter:best-updated', {
            message: `New best score: ${evaluation.score} (strategy: ${plan.strategy})`,
            score: evaluation.score,
            strategy: plan.strategy,
          });
        }

        // Success
        if (evaluation.pass) {
          const totalDuration = Date.now() - startTime;
          this.logger.log('converter:success', {
            message: `Conversion SUCCEEDED: score=${evaluation.score}, strategy="${plan.strategy}", ${totalDuration}ms total, ${attempts.length} attempt(s)`,
            score: evaluation.score,
            strategy: plan.strategy,
            totalDuration,
            attemptCount: attempts.length,
          });
          const report = this._buildReport(attempts, totalDuration);
          report.events = this.logger.getEvents();
          return {
            success: true,
            output: result.output,
            metadata: result.metadata,
            report,
          };
        }

        // If no fixable issues remain, stop retrying
        const fixableIssues = evaluation.issues.filter((issue) => issue.fixable);
        if (fixableIssues.length === 0) {
          this.logger.log('converter:no-fixable', {
            message: 'No fixable issues remain, stopping retries',
            issues: evaluation.issues.map((i) => i.code),
          });
          break;
        }

        if (attemptNum < maxAttempts) {
          this.logger.log('converter:retry', {
            message: `Will retry (attempt ${attemptNum + 1}/${maxAttempts}): ${fixableIssues.map((i) => i.code).join(', ')}`,
            reason: 'evaluation_failed',
            fixableIssues: fixableIssues.map((i) => i.code),
            currentScore: evaluation.score,
            nextAttempt: attemptNum + 1,
          });
        }
      } catch (err) {
        this.logger.log('converter:lifecycle-error', {
          message: `Lifecycle error: ${err.message}`,
          error: err.message,
          stack: err.stack?.split('\n').slice(0, 3).join(' | '),
          attempt: attemptNum,
        });
        attempts.push({
          attempt: attemptNum,
          strategy: 'unknown',
          reasoning: 'Error during plan/evaluate phase',
          score: 0,
          issues: [{ code: 'LIFECYCLE_ERROR', severity: 'error', message: err.message, fixable: false }],
          evaluationReasoning: err.message,
          duration: 0,
        });
      }
    }

    // All attempts exhausted; return best result with diagnosis
    const totalDuration = Date.now() - startTime;
    this.logger.log('converter:fail', {
      message: `Conversion FAILED after ${attempts.length} attempt(s): best score=${bestScore}, ${totalDuration}ms total`,
      bestScore,
      totalDuration,
      attemptCount: attempts.length,
      strategies: [...new Set(attempts.map((a) => a.strategy))],
    });

    const report = this._buildReport(attempts, totalDuration);
    report.events = this.logger.getEvents();
    return {
      success: false,
      output: bestResult?.output || null,
      metadata: bestResult?.metadata || null,
      report,
      diagnosis: this._buildDiagnosis(attempts),
    };
  }

  // =========================================================================
  // EXTENSION POINTS - Override in subclasses for custom behavior
  // =========================================================================

  /**
   * Structural checks specific to this converter.
   * Override to add format-specific validation.
   * @returns {Promise<EvaluationIssue[]>}
   */
  async _structuralChecks(_input, _output, _strategy) {
    return [];
  }

  /**
   * LLM-based quality spot-check.
   * Override for domain-specific LLM evaluation.
   * @returns {Promise<{score: number, issues: EvaluationIssue[], reasoning: string}>}
   */
  async _llmSpotCheck(input, output, strategy) {
    if (!this._ai) return { score: 80, issues: [], reasoning: 'No AI service for spot-check' };

    const outputSample = this._sampleOutput(output);
    const inputDesc = this._describeInput(input);

    try {
      const result = await this._ai.json(
        `You are a quality evaluator for a ${this.name} conversion.
Evaluate the output quality.

Input description: ${inputDesc}
Strategy used: ${strategy}

Output sample:
${outputSample}

Evaluate on these criteria:
1. Is the output complete? (no missing content)
2. Is the output well-formed? (correct format, no artifacts)
3. Does the output accurately represent the input?

Return JSON: {
  "score": 0-100,
  "issues": [{"code": "ISSUE_CODE", "severity": "error|warning|info", "message": "description", "fixable": true|false}],
  "reasoning": "brief evaluation summary"
}`,
        { profile: 'fast', feature: 'converter-evaluate', temperature: 0 }
      );
      return result || { score: 80, issues: [], reasoning: 'LLM evaluation returned empty' };
    } catch (err) {
      return { score: 75, issues: [], reasoning: `LLM spot-check error: ${err.message}` };
    }
  }

  /**
   * Describe the input for LLM context. Override for better descriptions.
   */
  _describeInput(input, metadata = {}) {
    if (typeof input === 'string') {
      return `Text input, ${input.length} characters. Preview: "${input.substring(0, 200)}..."`;
    }
    if (Buffer.isBuffer(input)) {
      return `Binary buffer, ${input.length} bytes. ${metadata.mimeType || ''} ${metadata.fileName || ''}`;
    }
    if (input && typeof input === 'object') {
      const keys = Object.keys(input).join(', ');
      return `Object with keys: ${keys}`;
    }
    return `Input type: ${typeof input}`;
  }

  /**
   * Sample output for LLM evaluation. Override for format-specific sampling.
   */
  _sampleOutput(output) {
    if (typeof output === 'string') {
      return output.substring(0, 1000);
    }
    if (Buffer.isBuffer(output)) {
      return `[Binary buffer, ${output.length} bytes]`;
    }
    if (output && typeof output === 'object') {
      if (output.content && typeof output.content === 'string') {
        return output.content.substring(0, 1000);
      }
      return JSON.stringify(output, null, 2).substring(0, 1000);
    }
    return String(output).substring(0, 500);
  }

  // =========================================================================
  // REPORT BUILDING
  // =========================================================================

  /**
   * Build the execution report from attempt records.
   */
  _buildReport(attempts, totalDuration) {
    const successfulAttempt = attempts.find((a) => a.score >= this.minPassScore);
    const bestAttempt = attempts.reduce((best, a) => (a.score > (best?.score || 0) ? a : best), null);
    const winningAttempt = successfulAttempt || bestAttempt;

    const strategiesUsed = [...new Set(attempts.map((a) => a.strategy))];

    return {
      agentId: this.id,
      agentName: this.name,
      conversionId: this._conversionId,
      success: !!successfulAttempt,
      finalScore: winningAttempt?.score || 0,
      totalDuration,
      attempts,
      decision: {
        strategyUsed: winningAttempt?.strategy || 'none',
        whyThisStrategy: winningAttempt?.reasoning || 'No successful strategy found',
        alternativesConsidered: strategiesUsed.filter((s) => s !== winningAttempt?.strategy),
        retryCount: Math.max(0, attempts.length - 1),
      },
    };
  }

  /**
   * Build diagnosis from failed attempts.
   */
  _buildDiagnosis(attempts) {
    const allIssues = attempts.flatMap((a) => a.issues || []);
    const errorCodes = [...new Set(allIssues.filter((i) => i.severity === 'error').map((i) => i.code))];
    const strategies = [...new Set(attempts.map((a) => a.strategy))];

    return {
      agentId: this.id,
      attemptsExhausted: attempts.length,
      bestScore: Math.max(...attempts.map((a) => a.score), 0),
      errorCodes,
      strategiesTried: strategies,
      allIssues,
      summary:
        `${this.name} failed after ${attempts.length} attempt(s). ` +
        `Best score: ${Math.max(...attempts.map((a) => a.score), 0)}/100. ` +
        `Error codes: ${errorCodes.join(', ') || 'none'}`,
    };
  }
}

module.exports = { BaseConverterAgent, ConverterEventLogger };
