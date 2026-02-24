'use strict';

const browsingAPI = require('./browsing-api');
const fastPath = require('./browse-fast-path');

class BrowsingAgentTemplate {
  constructor(definition) {
    this.id = definition.id;
    this.name = definition.name;
    this.description = definition.description || '';
    this.categories = definition.categories || ['browser', 'web'];
    this.bidding = definition.bidding || {};
    this.recipe = definition.recipe || null;
    this.fallback = definition.fallback || { strategy: 'llm', profile: 'fast', maxActions: 15 };
    this.errorHandlers = definition.errorHandlers || {};
    this.retry = definition.retry || { maxAttempts: 3, backoff: 'exponential', retryOn: ['timeout', 'network-error', 'empty-result'] };
    this.output = definition.output || null;
    this.sessionConfig = definition.session || { mode: 'auto-promote' };
    this.fastPath = definition.fastPath || null;

    this._definition = definition;
  }

  async execute(input, opts = {}) {
    const context = {
      input,
      startTime: Date.now(),
      attempt: 0,
      results: null,
      errors: [],
      sessionId: null,
      path: null,
    };

    for (let attempt = 0; attempt < this.retry.maxAttempts; attempt++) {
      context.attempt = attempt;

      try {
        const result = await this._executeOnce(context, opts);

        if (result && !result.error && !result.needsRetry) {
          context.results = result;
          context.path = result.path;
          return this._formatOutput(result, context);
        }

        if (result?.error) {
          context.errors.push({ attempt, error: result.error, timestamp: Date.now() });
        }

        if (attempt < this.retry.maxAttempts - 1) {
          const delay = this._getBackoffDelay(attempt);
          await new Promise((r) => setTimeout(r, delay));
        }
      } catch (err) {
        context.errors.push({ attempt, error: err.message, timestamp: Date.now() });
      } finally {
        if (context.sessionId) {
          try { await browsingAPI.destroySession(context.sessionId); } catch (_) {}
          context.sessionId = null;
        }
      }
    }

    return this._formatOutput(
      { error: `All ${this.retry.maxAttempts} attempts failed`, partial: context.results },
      context
    );
  }

  async _executeOnce(context, opts) {
    // Tier 1: Fast path (search API / HTTP fetch)
    if (this.fastPath && context.attempt === 0) {
      const fpResult = await this._tryFastPath(context.input);
      if (fpResult && !fpResult.needsBrowser) {
        return { ...fpResult, path: 'fast-path' };
      }
    }

    // Tier 2: Recipe (deterministic navigation)
    if (this.recipe && this.recipe.steps) {
      const recipeResult = await this._executeRecipe(context);
      if (recipeResult && !recipeResult.error) {
        return { ...recipeResult, path: 'recipe' };
      }
    }

    // Tier 3: LLM-driven fallback
    if (this.fallback && this.fallback.strategy === 'llm') {
      const llmResult = await this._executeLlmFallback(context, opts);
      return { ...llmResult, path: 'llm-fallback' };
    }

    return { error: 'No execution strategy available' };
  }

  async _tryFastPath(input) {
    try {
      if (this.fastPath.type === 'search') {
        return await fastPath.query(this._interpolate(this.fastPath.query, input), {
          maxSources: this.fastPath.maxSources || 3,
          deepExtract: this.fastPath.deepExtract !== false,
        });
      }

      if (this.fastPath.type === 'url') {
        const url = this._interpolate(this.fastPath.url, input);
        return await fastPath.extractUrl(url, { maxLength: this.fastPath.maxLength || 8000 });
      }

      return null;
    } catch {
      return null;
    }
  }

  async _executeRecipe(context) {
    const sess = await browsingAPI.createSession(this.sessionConfig);
    context.sessionId = sess.sessionId;

    const results = {};

    for (const step of this.recipe.steps) {
      try {
        const result = await this._executeRecipeStep(sess.sessionId, step, context.input);

        if (step.action === 'extract' && result) {
          Object.assign(results, result);
        }

        if (result && result.error) {
          const handled = await this._handleError(sess.sessionId, result.error, step);
          if (!handled) return { error: result.error, partial: results };
        }
      } catch (err) {
        const handled = await this._handleError(sess.sessionId, err.message, step);
        if (!handled) return { error: err.message, partial: results };
      }
    }

    return { data: results };
  }

  async _executeRecipeStep(sessionId, step, input) {
    const action = step.action;

    switch (action) {
      case 'navigate': {
        const url = this._interpolate(step.url, input);
        return await browsingAPI.navigate(sessionId, url, step.opts || {});
      }

      case 'waitFor': {
        const timeout = step.timeout || 10000;
        const selector = this._interpolate(step.selector, input);
        const script = `
          new Promise((resolve) => {
            const check = () => {
              if (document.querySelector(${JSON.stringify(selector)})) return resolve(true);
              setTimeout(check, 200);
            };
            check();
            setTimeout(() => resolve(false), ${timeout});
          });
        `;
        const found = await this._executeInSession(sessionId, script);
        if (!found) return { error: `Timeout waiting for ${selector}` };
        return { found: true };
      }

      case 'extract': {
        if (step.rules) {
          return await this._extractByRules(sessionId, step.rules, input);
        }
        return await browsingAPI.extract(sessionId, step.opts || {});
      }

      case 'click': {
        const snapshot = await browsingAPI.snapshot(sessionId);
        const target = this._findRefBySelector(snapshot, step.target || step.selector, input);
        if (!target) return { error: `Click target not found: ${step.selector}` };
        return await browsingAPI.act(sessionId, { action: 'click', ref: target });
      }

      case 'fill': {
        const snapshot = await browsingAPI.snapshot(sessionId);
        const target = this._findRefBySelector(snapshot, step.selector, input);
        if (!target) return { error: `Fill target not found: ${step.selector}` };
        const value = this._interpolate(step.value, input);
        return await browsingAPI.act(sessionId, { action: 'fill', ref: target, value });
      }

      case 'wait': {
        await new Promise((r) => setTimeout(r, step.ms || 1000));
        return { waited: step.ms || 1000 };
      }

      default:
        return { error: `Unknown recipe step action: ${action}` };
    }
  }

  async _extractByRules(sessionId, rules, input) {
    const ruleEntries = Object.entries(rules).map(([key, rule]) => {
      const selector = this._interpolate(rule.selector, input);
      return { key, selector, type: rule.type || 'text', attribute: rule.attribute };
    });

    const script = `
(function() {
  const rules = ${JSON.stringify(ruleEntries)};
  const results = {};
  for (const rule of rules) {
    try {
      if (rule.type === 'list') {
        const els = document.querySelectorAll(rule.selector);
        results[rule.key] = Array.from(els).map(el => el.innerText.trim()).filter(Boolean).slice(0, 20);
      } else if (rule.type === 'attribute') {
        const el = document.querySelector(rule.selector);
        results[rule.key] = el ? el.getAttribute(rule.attribute) : null;
      } else if (rule.type === 'html') {
        const el = document.querySelector(rule.selector);
        results[rule.key] = el ? el.innerHTML : null;
      } else {
        const el = document.querySelector(rule.selector);
        results[rule.key] = el ? el.innerText.trim() : null;
      }
    } catch(e) { results[rule.key] = null; }
  }
  return results;
})();
`;

    return this._executeInSession(sessionId, script);
  }

  async _executeLlmFallback(context, opts) {
    let taskRunner;
    try {
      taskRunner = require('./browsing-task-runner');
    } catch {
      return { error: 'Task runner not available' };
    }

    const prompt = this.fallback.prompt
      ? this._interpolate(this.fallback.prompt, context.input)
      : `${this.description}. Input: ${JSON.stringify(context.input)}`;

    return await taskRunner.run({
      task: prompt,
      profile: this.fallback.profile || 'fast',
      maxActions: this.fallback.maxActions || 15,
      sessionConfig: this.sessionConfig,
      ...opts,
    });
  }

  async _handleError(sessionId, error, step) {
    for (const [handlerName, handler] of Object.entries(this.errorHandlers)) {
      if (handler.detect) {
        let matches = false;

        if (handler.detect.textContains && error.toLowerCase().includes(handler.detect.textContains.toLowerCase())) {
          matches = true;
        }

        if (handler.detect.selector) {
          try {
            const snapshot = await browsingAPI.snapshot(sessionId);
            if (snapshot.refs.some(r => r.name && r.name.toLowerCase().includes(handler.detect.selector.toLowerCase()))) {
              matches = true;
            }
          } catch (_) {}
        }

        if (matches) {
          if (handler.action === 'click' && handler.target) {
            try {
              const snapshot = await browsingAPI.snapshot(sessionId);
              const ref = this._findRefByText(snapshot, handler.target.text || handler.target.selector);
              if (ref) {
                await browsingAPI.act(sessionId, { action: 'click', ref });
                await new Promise((r) => setTimeout(r, 1000));
                return true;
              }
            } catch (_) {}
          }

          if (handler.action === 'retry') return false; // signal to retry at outer level
          if (handler.action === 'skip') return true;
          if (handler.action === 'hitl') {
            await browsingAPI.promote(sessionId, { reason: handlerName, message: handler.message || error });
            return true;
          }
        }
      }
    }
    return false;
  }

  _findRefBySelector(snapshot, selectorOrText, input) {
    const text = this._interpolate(selectorOrText, input).toLowerCase();
    const match = snapshot.refs.find((r) =>
      (r.name && r.name.toLowerCase().includes(text)) ||
      (r.href && r.href.toLowerCase().includes(text))
    );
    return match ? match.ref : null;
  }

  _findRefByText(snapshot, text) {
    if (!text) return null;
    const lower = text.toLowerCase();
    const match = snapshot.refs.find((r) => r.name && r.name.toLowerCase().includes(lower));
    return match ? match.ref : null;
  }

  async _executeInSession(sessionId, script) {
    const sess = browsingAPI.sessions.get(sessionId);
    if (!sess || !sess.window || sess.window.isDestroyed()) {
      throw new Error('Session window not available');
    }
    return await sess.window.webContents.executeJavaScript(script);
  }

  _interpolate(template, input) {
    if (!template || typeof template !== 'string') return template;
    return template.replace(/\{(\w+)\}/g, (_, key) => {
      if (typeof input === 'object' && input !== null) return input[key] || '';
      if (typeof input === 'string' && key === 'query') return input;
      if (typeof input === 'string' && key === 'input') return input;
      return '';
    });
  }

  _formatOutput(result, context) {
    return {
      agentId: this.id,
      success: !result.error,
      data: result.data || result.sources || null,
      error: result.error || null,
      partial: result.partial || null,
      path: result.path || context.path || 'unknown',
      attempts: context.attempt + 1,
      errors: context.errors,
      latencyMs: Date.now() - context.startTime,
    };
  }

  _getBackoffDelay(attempt) {
    if (this.retry.backoff === 'exponential') {
      return Math.min(1000 * Math.pow(2, attempt), 15000);
    }
    return this.retry.backoffMs || 2000;
  }

  toAgentRegistration() {
    return {
      agentId: this.id,
      agentVersion: '1.0.0',
      categories: this.categories,
      capabilities: {
        executionType: 'browsing-agent',
        description: this.description,
        keywords: this.bidding.keywords || [],
        examples: this.bidding.examples || [],
      },
    };
  }
}

function createAgent(definition) {
  return new BrowsingAgentTemplate(definition);
}

function loadAgents(definitions) {
  return definitions.map((d) => createAgent(d));
}

module.exports = { BrowsingAgentTemplate, createAgent, loadAgents };
