'use strict';

/**
 * Autopilot Script Cache
 *
 * Converts browser-use action histories into reusable Playwright scripts.
 * On cache hit, runs the pure script (~3s) instead of the LLM loop (~3min).
 * If the script fails validation, it's invalidated and the LLM regenerates.
 *
 * Cache entries: { taskHash, task, script, assertions, variables, created, hits }
 * Stored as JSON + .js files in the app data directory.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

const CACHE_DIR = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'onereach-ai',
  'autopilot-scripts'
);

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function hashTask(task) {
  const normalized = task.toLowerCase().trim().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function getMetaPath(hash) {
  return path.join(CACHE_DIR, `${hash}.meta.json`);
}

function getScriptPath(hash) {
  return path.join(CACHE_DIR, `${hash}.script.js`);
}

// ==================== CACHE LOOKUP ====================

function lookup(task) {
  const hash = hashTask(task);
  const metaPath = getMetaPath(hash);
  if (!fs.existsSync(metaPath)) return null;

  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    const scriptPath = getScriptPath(hash);
    if (!fs.existsSync(scriptPath)) return null;

    meta.script = fs.readFileSync(scriptPath, 'utf-8');
    return meta;
  } catch {
    return null;
  }
}

// ==================== SCRIPT GENERATION ====================

/**
 * Convert browser-use AgentHistoryList into a Playwright script.
 * Uses stable selectors (URLs, text, CSS) instead of element indices.
 * Pairs each action with its state context to find the right elements.
 */
function generateScript(history, task) {
  const steps = [];

  if (!history || !history.history) return null;

  for (const item of history.history) {
    if (!item.model_output) continue;

    const rawActions = item.model_output.action || item.model_output.actions || [];
    const actionList = Array.isArray(rawActions) ? rawActions : [rawActions];
    const state = item.state || {};
    const elements = state.interacted_element || state.interacted_elements || [];

    for (let i = 0; i < actionList.length; i++) {
      let action = actionList[i];
      if (!action) continue;

      if (typeof action.model_dump === 'function') {
        action = action.model_dump();
      } else if (typeof action.toJSON === 'function') {
        action = action.toJSON();
      }

      const element = Array.isArray(elements) ? elements[i] || null : null;
      const step = _actionToPlaywright(action, element);
      if (step) steps.push(step);
    }
  }

  if (steps.length === 0) return null;

  const assertions = _generateAssertions(history);

  const script = `// Auto-generated Playwright script
// Task: ${task.replace(/\n/g, ' ').slice(0, 100)}
// Generated: ${new Date().toISOString()}
// Steps: ${steps.length}

async function run(page) {
  const results = [];

  const click = async (selectors) => {
    for (const s of selectors) {
      try {
        const el = page.locator(s).first();
        if (await el.isVisible({ timeout: 3000 })) { await el.click({ timeout: 5000 }); return true; }
      } catch {}
    }
    return false;
  };

  const fill = async (selectors, text) => {
    for (const s of selectors) {
      try {
        const el = page.locator(s).first();
        if (await el.isVisible({ timeout: 3000 })) { await el.fill(text, { timeout: 5000 }); return true; }
      } catch {}
    }
    return false;
  };

${steps.map((s, i) => `  // Step ${i + 1}\n  ${s}`).join('\n\n')}

  return { success: true, steps: ${steps.length}, results };
}

${assertions}

module.exports = { run, validate };
`;

  return script;
}

function _buildSelectors(params, element) {
  const selectors = [];

  if (element) {
    if (element.attributes?.id) selectors.push(`#${element.attributes.id}`);
    if (element.attributes?.name) selectors.push(`[name="${element.attributes.name}"]`);
    if (element.attributes?.href) selectors.push(`a[href="${element.attributes.href}"]`);
    if (element.attributes?.aria_label || element.attributes?.['aria-label']) {
      selectors.push(`[aria-label="${element.attributes.aria_label || element.attributes['aria-label']}"]`);
    }
    if (element.tag_name && element.text) {
      const text = (element.text || '').slice(0, 40).replace(/"/g, '\\"');
      selectors.push(`${element.tag_name}:has-text("${text}")`);
    } else if (element.text) {
      const text = (element.text || '').slice(0, 40).replace(/"/g, '\\"');
      selectors.push(`text="${text}"`);
    }
  }

  if (params.selector) selectors.push(params.selector);
  if (params.text || params.label) {
    const text = (params.text || params.label || '').replace(/"/g, '\\"');
    selectors.push(`text="${text}"`);
  }

  return selectors;
}

function _actionToPlaywright(action, element) {
  if (typeof action !== 'object') return null;

  const keys = Object.keys(action);
  if (keys.length === 0) return null;

  const actionType = keys[0];
  const params = action[actionType] || {};

  switch (actionType) {
    case 'go_to_url':
    case 'navigate':
      return params.url
        ? `await page.goto(${JSON.stringify(params.url)}, { waitUntil: 'domcontentloaded', timeout: 15000 });`
        : null;

    case 'click_element':
    case 'click': {
      const selectors = _buildSelectors(params, element);
      if (selectors.length > 0) {
        return `await click(${JSON.stringify(selectors)});`;
      }
      return null;
    }

    case 'input_text':
    case 'fill':
    case 'type': {
      const text = params.text ?? params.value ?? '';
      const selectors = _buildSelectors(params, element);
      if (selectors.length === 0) selectors.push('input:visible', 'textarea:visible');
      return `await fill(${JSON.stringify(selectors)}, ${JSON.stringify(text)});`;
    }

    case 'scroll_down':
    case 'scroll':
      return `await page.mouse.wheel(0, ${params.amount || 300});`;

    case 'scroll_up':
      return `await page.mouse.wheel(0, -${params.amount || 300});`;

    case 'wait':
      return `await page.waitForTimeout(${params.ms || params.seconds ? (params.seconds || 1) * 1000 : 1000});`;

    case 'go_back':
      return `await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });`;

    case 'select_dropdown_option':
    case 'select': {
      const value = params.value || params.text || '';
      const selectors = _buildSelectors(params, element);
      if (selectors.length === 0) selectors.push('select:visible');
      return `await click(${JSON.stringify(selectors)}); await page.selectOption(${JSON.stringify(selectors[0])}, ${JSON.stringify(value)});`;
    }

    case 'send_keys':
    case 'press_key': {
      const key = params.keys || params.key || 'Enter';
      return `await page.keyboard.press(${JSON.stringify(key)});`;
    }

    case 'extract_content':
    case 'extract_page_content':
      return `results.push(await page.evaluate(() => document.body.innerText.slice(0, 5000)));`;

    case 'done':
      if (params.text || params.extracted_content) {
        return `results.push(${JSON.stringify(params.text || params.extracted_content || 'Task completed')});`;
      }
      return `results.push('Task completed');`;

    default:
      return `// Unknown action: ${actionType}`;
  }
}

function _generateAssertions(history) {
  const lastItem = history.history[history.history.length - 1];
  const lastState = lastItem?.state;
  const url = lastState?.url || '';
  const _title = lastState?.title || '';

  let checks = [];
  if (url) {
    const domain = url.split('/').slice(0, 3).join('/');
    checks.push(`  const currentUrl = page.url();`);
    checks.push(`  if (!currentUrl.includes(${JSON.stringify(domain.replace(/^https?:\/\//, ''))})) return { valid: false, reason: 'Unexpected URL: ' + currentUrl };`);
  }
  checks.push(`  return { valid: true };`);

  return `async function validate(page) {\n${checks.join('\n')}\n}`;
}

// ==================== STORE ====================

function store(task, script, history) {
  ensureCacheDir();
  const hash = hashTask(task);

  const finalUrl = _getLastUrl(history);

  const meta = {
    hash,
    task: task.slice(0, 200),
    created: new Date().toISOString(),
    hits: 0,
    lastUsed: null,
    lastResult: null,
    finalUrl,
    stepCount: _countSteps(history),
  };

  fs.writeFileSync(getMetaPath(hash), JSON.stringify(meta, null, 2));
  fs.writeFileSync(getScriptPath(hash), script);

  log.info('desktop-autopilot', `Cached script for task: "${task.slice(0, 60)}"`, { hash, steps: meta.stepCount });
  return meta;
}

function _getLastUrl(history) {
  if (!history || !history.history) return '';
  for (let i = history.history.length - 1; i >= 0; i--) {
    const url = history.history[i]?.state?.url;
    if (url) return url;
  }
  return '';
}

function _countSteps(history) {
  if (!history || !history.history) return 0;
  let count = 0;
  for (const item of history.history) {
    const raw = item?.model_output?.action || item?.model_output?.actions || [];
    const actions = Array.isArray(raw) ? raw : [raw];
    for (const a of actions) {
      let dumped = a;
      if (typeof a?.model_dump === 'function') dumped = a.model_dump();
      else if (typeof a?.toJSON === 'function') dumped = a.toJSON();
      if (dumped && typeof dumped === 'object') {
        const keys = Object.keys(dumped).filter((k) => k !== 'data');
        count += keys.length > 0 ? 1 : 0;
      }
    }
  }
  return count || history.history.length;
}

// ==================== EXECUTE CACHED SCRIPT ====================

async function execute(cached) {
  const hash = cached.hash;
  const scriptPath = getScriptPath(hash);
  const metaPath = getMetaPath(hash);

  try {
    const { chromium } = require('playwright');

    const headless = cached._headless !== undefined ? cached._headless : true;
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();

    const scriptContent = cached.script || fs.readFileSync(scriptPath, 'utf-8');

    const scriptModule = _loadScript(scriptContent, scriptPath);

    const startTime = Date.now();
    const result = await scriptModule.run(page);
    const elapsed = Date.now() - startTime;

    let validation = { valid: true };
    if (scriptModule.validate) {
      validation = await scriptModule.validate(page);
    }

    await browser.close();

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    meta.hits += 1;
    meta.lastUsed = new Date().toISOString();
    meta.lastResult = validation.valid ? 'pass' : 'fail';
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    if (!validation.valid) {
      log.warn('desktop-autopilot', `Cached script validation failed: ${validation.reason}`, { hash });
      return { success: false, cached: true, validation, reason: validation.reason };
    }

    log.info('desktop-autopilot', `Cached script executed in ${elapsed}ms`, { hash, steps: result.steps });

    return {
      success: true,
      cached: true,
      elapsed,
      steps: result.steps,
      results: result.results || [],
      finalResult: result.results?.length ? result.results[result.results.length - 1] : null,
    };
  } catch (err) {
    log.warn('desktop-autopilot', `Cached script execution error: ${err.message}`, { hash });
    return { success: false, cached: true, error: err.message };
  }
}

function _loadScript(scriptContent, filePath) {
  const Module = require('module');
  const m = new Module(filePath);
  m.filename = filePath;
  m.paths = Module._nodeModulePaths(path.dirname(filePath));
  m._compile(scriptContent, filePath);
  return m.exports;
}

// ==================== INVALIDATE ====================

function invalidate(task) {
  const hash = hashTask(task);
  const metaPath = getMetaPath(hash);
  const scriptPath = getScriptPath(hash);

  try {
    if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    log.info('desktop-autopilot', `Invalidated cached script`, { hash });
    return true;
  } catch {
    return false;
  }
}

// ==================== MANAGEMENT ====================

function list() {
  ensureCacheDir();
  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.meta.json'));
  return files.map((f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf-8'));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function clearAll() {
  ensureCacheDir();
  const files = fs.readdirSync(CACHE_DIR);
  let count = 0;
  for (const f of files) {
    try {
      fs.unlinkSync(path.join(CACHE_DIR, f));
      count++;
    } catch { /* ignore */ }
  }
  return count;
}

function getScript(task) {
  const hash = hashTask(task);
  const scriptPath = getScriptPath(hash);
  if (!fs.existsSync(scriptPath)) return null;
  return fs.readFileSync(scriptPath, 'utf-8');
}

// ==================== CLAUDE SCRIPT GENERATION ====================

const DIRECT_SCRIPT_PROMPT = `You are a Playwright automation expert. Write a Node.js script that completes the user's task using Playwright.

REQUIREMENTS:
- Export an async function \`run(page)\` that receives a Playwright Page object (browser already launched)
- Export an async function \`validate(page)\` that checks the script succeeded (return { valid: true } or { valid: false, reason: "..." })
- Use resilient selectors: prefer getByRole, getByText, getByLabel over fragile CSS selectors
- Add reasonable timeouts (5-10s for navigation, 3s for element waits)
- Handle cookie consent banners and popups gracefully (dismiss if present)
- Return { success: true, steps: N, results: [...] } from run() where results contains extracted data
- If the task asks to extract information, use page.evaluate() to get text content and push it to results
- Use try/catch around element interactions so one failure doesn't crash the whole script
- Do NOT import or require playwright -- the page is already provided
- Keep it simple and robust

Respond with ONLY the JavaScript code, no markdown fences, no explanation.`;

const REFINE_SCRIPT_PROMPT = `You are a Playwright automation expert. A browser agent just completed a task by exploring a website. I'll give you the action history showing exactly what pages it visited, what it clicked, and what it extracted.

Write a clean, replayable Playwright script that accomplishes the same task WITHOUT needing an AI agent.

ACTION HISTORY:
{HISTORY}

REQUIREMENTS:
- Export async function \`run(page)\` receiving a Playwright Page object
- Export async function \`validate(page)\` that returns { valid: true/false, reason? }
- Use the exact URLs and selectors from the history when available
- Use resilient selectors: getByRole, getByText, aria-label, href attributes
- Add reasonable timeouts
- Handle cookie banners gracefully
- Return { success: true, steps: N, results: [...] }
- Push extracted data to the results array
- Do NOT import playwright
- Keep it simple and robust

Respond with ONLY the JavaScript code, no markdown fences, no explanation.`;

/**
 * Ask Claude to write a Playwright script directly from the task description.
 * Fast path -- no browser needed.
 */
async function generateScriptWithLLM(task) {
  try {
    const ai = require('./ai-service');
    const result = await ai.complete(
      `Task: ${task}`,
      {
        profile: 'fast',
        system: DIRECT_SCRIPT_PROMPT,
        maxTokens: 4096,
        temperature: 0.1,
        feature: 'desktop-autopilot-scriptgen',
      }
    );

    let script = result || '';
    script = script.replace(/^```(?:javascript|js)?\n?/m, '').replace(/\n?```$/m, '').trim();

    if (!script.includes('async function run') || !script.includes('module.exports')) {
      log.warn('desktop-autopilot', 'LLM script generation produced invalid output');
      return null;
    }

    return script;
  } catch (err) {
    log.warn('desktop-autopilot', 'LLM script generation failed', { error: err.message });
    return null;
  }
}

/**
 * Ask Claude to refine a Playwright script based on browser-use action history.
 * Used after browser-use explores a site -- produces a better script than mechanical conversion.
 */
async function refineScriptWithLLM(task, history) {
  try {
    const ai = require('./ai-service');

    let historyText = '';
    if (history && history.history) {
      for (let i = 0; i < history.history.length; i++) {
        const item = history.history[i];
        const state = item.state || {};
        const url = state.url || '';
        const title = state.title || '';

        historyText += `\nStep ${i + 1}: URL=${url} Title="${title}"\n`;

        if (item.model_output) {
          const rawActions = item.model_output.action || [];
          const actions = Array.isArray(rawActions) ? rawActions : [rawActions];
          for (const a of actions) {
            let dumped = a;
            if (typeof a?.model_dump === 'function') dumped = a.model_dump();
            else if (typeof a?.toJSON === 'function') dumped = a.toJSON();
            historyText += `  Action: ${JSON.stringify(dumped)}\n`;
          }
        }

        if (item.result) {
          for (const r of item.result) {
            if (r.extracted_content) {
              historyText += `  Extracted: ${r.extracted_content.slice(0, 300)}\n`;
            }
            if (r.error) {
              historyText += `  Error: ${r.error}\n`;
            }
          }
        }
      }
    }

    const prompt = REFINE_SCRIPT_PROMPT.replace('{HISTORY}', historyText);

    const result = await ai.complete(
      `Task: ${task}`,
      {
        profile: 'standard',
        system: prompt,
        maxTokens: 4096,
        temperature: 0.1,
        feature: 'desktop-autopilot-scriptgen',
      }
    );

    let script = result || '';
    script = script.replace(/^```(?:javascript|js)?\n?/m, '').replace(/\n?```$/m, '').trim();

    if (!script.includes('async function run') || !script.includes('module.exports')) {
      log.warn('desktop-autopilot', 'LLM script refinement produced invalid output, falling back to mechanical');
      return generateScript(history, task);
    }

    return script;
  } catch (err) {
    log.warn('desktop-autopilot', 'LLM script refinement failed, falling back to mechanical', { error: err.message });
    return generateScript(history, task);
  }
}

module.exports = {
  hashTask,
  lookup,
  generateScript,
  generateScriptWithLLM,
  refineScriptWithLLM,
  store,
  execute,
  invalidate,
  list,
  clearAll,
  getScript,
  CACHE_DIR,
};
