'use strict';

let _browsingAPI, _fastPath, _taskRunner, _ai;
function getBrowsingAPI() { if (!_browsingAPI) _browsingAPI = require('./browsing-api'); return _browsingAPI; }
function getFastPath() { if (!_fastPath) _fastPath = require('./browse-fast-path'); return _fastPath; }
function getTaskRunner() { if (!_taskRunner) _taskRunner = require('./browsing-task-runner'); return _taskRunner; }
function getAI() { if (!_ai) _ai = require('./ai-service'); return _ai; }

async function research(query, opts = {}) {
  const maxSources = opts.maxSources || 5;
  const maxLengthPerSource = opts.maxLengthPerSource || 4000;
  const synthesize = opts.synthesize !== false;
  const timeout = opts.timeout || 30000;
  const startTime = Date.now();

  const fp = getFastPath();

  const searchResult = await fp.query(query, {
    deepExtract: true,
    maxSources,
    maxLength: maxLengthPerSource,
  });

  const sources = (searchResult.sources || []).filter((s) => s.extractedText || s.snippet);

  const needsBrowser = sources.filter((s) => s.needsBrowser);
  if (needsBrowser.length > 0 && Date.now() - startTime < timeout - 10000) {
    const api = getBrowsingAPI();
    const browserResults = await api.parallel(
      needsBrowser.slice(0, 3).map((s) => ({
        url: s.url,
        extract: { mode: 'readability', maxLength: maxLengthPerSource },
      })),
      { timeout: timeout - (Date.now() - startTime) - 2000 }
    );

    for (let i = 0; i < browserResults.length; i++) {
      if (browserResults[i] && browserResults[i].text) {
        const idx = sources.findIndex((s) => s.url === needsBrowser[i].url);
        if (idx >= 0) {
          sources[idx].extractedText = browserResults[i].text;
          sources[idx].needsBrowser = false;
          sources[idx].extractionMethod = 'browser';
        }
      }
    }
  }

  if (!synthesize) {
    return {
      query,
      sources,
      latencyMs: Date.now() - startTime,
    };
  }

  const context = sources
    .map((s, i) => `[Source ${i + 1}: ${s.title || s.url || 'unknown'}]\n${s.extractedText || s.snippet || '(no content)'}`)
    .join('\n\n---\n\n');

  try {
    const ai = getAI();
    const response = await ai.chat({
      profile: opts.profile || 'fast',
      system: 'You are a research assistant. Synthesize information from multiple web sources into a clear, concise answer. Cite sources by number [1], [2], etc. If sources conflict, note the disagreement.',
      messages: [{ role: 'user', content: `Question: ${query}\n\nSources:\n${context}` }],
      maxTokens: opts.maxTokens || 1000,
      temperature: 0.3,
      feature: 'browse-orchestrator',
    });

    return {
      answer: response.content,
      query,
      sources: sources.map((s) => ({ title: s.title, url: s.url })),
      latencyMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      answer: null,
      rawSources: context,
      query,
      sources: sources.map((s) => ({ title: s.title, url: s.url })),
      error: err.message,
      latencyMs: Date.now() - startTime,
    };
  }
}

async function workflow(steps, opts = {}) {
  const timeout = opts.timeout || 120000;
  const startTime = Date.now();
  const results = [];
  const context = {};

  for (const step of steps) {
    if (Date.now() - startTime > timeout) {
      results.push({ step: step.name, error: 'Workflow timeout', skipped: true });
      break;
    }

    try {
      const resolvedStep = resolveStepVariables(step, context, results);
      let result;

      switch (resolvedStep.type) {
        case 'navigate':
          result = await executeNavigateStep(resolvedStep);
          break;

        case 'extract':
          result = await executeExtractStep(resolvedStep);
          break;

        case 'search':
          result = await executeSearchStep(resolvedStep);
          break;

        case 'interact':
          result = await executeInteractStep(resolvedStep);
          break;

        case 'llm':
          result = await executeLlmStep(resolvedStep, context);
          break;

        default:
          result = { error: `Unknown step type: ${resolvedStep.type}` };
      }

      results.push({ step: resolvedStep.name || `step-${results.length}`, ...result });

      if (resolvedStep.saveAs) {
        context[resolvedStep.saveAs] = result.data || result.text || result.answer || result;
      }

      if (result.error && !resolvedStep.continueOnError) break;
    } catch (err) {
      results.push({ step: step.name || `step-${results.length}`, error: err.message });
      if (!step.continueOnError) break;
    }
  }

  return {
    results,
    context,
    latencyMs: Date.now() - startTime,
    completedSteps: results.filter((r) => !r.error && !r.skipped).length,
    totalSteps: steps.length,
  };
}

function resolveStepVariables(step, context, previousResults) {
  const resolved = { ...step };
  const regex = /\$\{(\w+)(?:\.(\w+))?\}/g;

  function resolve(str) {
    if (typeof str !== 'string') return str;
    return str.replace(regex, (_, varName, prop) => {
      if (context[varName]) {
        if (prop && typeof context[varName] === 'object') return context[varName][prop] || '';
        return typeof context[varName] === 'string' ? context[varName] : JSON.stringify(context[varName]);
      }
      if (varName === 'prev' && previousResults.length > 0) {
        const last = previousResults[previousResults.length - 1];
        if (prop) return last[prop] || '';
        return last.data || last.text || '';
      }
      return '';
    });
  }

  for (const key of Object.keys(resolved)) {
    if (typeof resolved[key] === 'string') resolved[key] = resolve(resolved[key]);
  }

  return resolved;
}

async function executeNavigateStep(step) {
  const api = getBrowsingAPI();
  const sess = await api.createSession(step.session || { mode: 'auto-promote', timeout: 30000 });
  try {
    const nav = await api.navigate(sess.sessionId, step.url);
    const content = await api.extract(sess.sessionId, step.extract || { mode: 'readability' });
    return { url: nav.url, title: nav.title, text: content.text, data: content };
  } finally {
    await api.destroySession(sess.sessionId);
  }
}

async function executeExtractStep(step) {
  const fp = getFastPath();
  return await fp.extractUrl(step.url, { maxLength: step.maxLength || 8000, fallbackToBrowser: true });
}

async function executeSearchStep(step) {
  const fp = getFastPath();
  return await fp.query(step.query, { deepExtract: step.deepExtract !== false, maxSources: step.maxSources || 3 });
}

async function executeInteractStep(step) {
  const runner = getTaskRunner();
  return await runner.run({
    task: step.task,
    startUrl: step.url,
    maxActions: step.maxActions || 15,
    profile: step.profile || 'fast',
    timeout: step.timeout || 30000,
  });
}

async function executeLlmStep(step, context) {
  const ai = getAI();
  const contextStr = Object.entries(context)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v.slice(0, 2000) : JSON.stringify(v).slice(0, 2000)}`)
    .join('\n\n');

  const response = await ai.chat({
    profile: step.profile || 'fast',
    system: step.system || 'You are a helpful assistant processing web research data.',
    messages: [{ role: 'user', content: `${step.prompt}\n\nContext:\n${contextStr}` }],
    maxTokens: step.maxTokens || 500,
    temperature: step.temperature || 0.3,
    feature: 'browse-orchestrator',
  });

  return { answer: response.content, data: response.content };
}

async function comparePages(urls, opts = {}) {
  const api = getBrowsingAPI();
  const maxLength = opts.maxLength || 4000;

  const results = await api.parallel(
    urls.map((url) => ({ url, extract: { mode: 'readability', maxLength } })),
    { timeout: opts.timeout || 30000 }
  );

  const pages = results.map((r, i) => ({
    url: urls[i],
    text: r.text || r.error || 'Failed to extract',
    metadata: r.metadata || {},
  }));

  if (opts.synthesize !== false) {
    try {
      const ai = getAI();
      const prompt = pages
        .map((p, i) => `[Page ${i + 1}: ${p.url}]\n${p.text}`)
        .join('\n\n---\n\n');

      const response = await ai.chat({
        profile: opts.profile || 'fast',
        system: 'Compare and contrast the following web pages. Note similarities, differences, and key insights from each.',
        messages: [{ role: 'user', content: `${opts.question || 'Compare these pages'}:\n\n${prompt}` }],
        maxTokens: opts.maxTokens || 800,
        temperature: 0.3,
        feature: 'browse-orchestrator',
      });

      return { comparison: response.content, pages };
    } catch (err) {
      return { comparison: null, pages, error: err.message };
    }
  }

  return { pages };
}

module.exports = { research, workflow, comparePages, resolveStepVariables };
