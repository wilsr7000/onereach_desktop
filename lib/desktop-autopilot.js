'use strict';

/**
 * Desktop Autopilot — Unified Facade
 *
 * Combines three automation engines under a single, settings-gated API:
 *   1. Browser automation (browser-use npm package + Playwright)
 *   2. App control (action-executor.js — 143+ actions)
 *   3. System control (AppleScript, mouse, keyboard — macOS)
 *
 * Every public method checks the master toggle and relevant sub-toggle
 * before executing. Disabled by default; users opt in via Settings.
 */

const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

let _browserUseAgent = null;
let _browserSession = null;
let _actionExecutor = null;
let _applescriptHelper = null;

function getSettings() {
  if (global.settingsManager) return global.settingsManager;
  return null;
}

function getSetting(key, defaultValue) {
  const mgr = getSettings();
  if (!mgr) return defaultValue;
  const val = mgr.get(key);
  return val !== undefined && val !== null ? val : defaultValue;
}

function isEnabled() {
  return getSetting('desktopAutopilotEnabled', false) === true;
}

function isBrowserEnabled() {
  return isEnabled() && getSetting('desktopAutopilotBrowser', true) !== false;
}

function isAppControlEnabled() {
  return isEnabled() && getSetting('desktopAutopilotAppControl', true) !== false;
}

function isSystemEnabled() {
  return isEnabled() && getSetting('desktopAutopilotSystem', false) === true;
}

function gateCheck(subsystem) {
  if (!isEnabled()) {
    return { success: false, error: 'Desktop Autopilot is disabled. Enable it in Settings > Automation.' };
  }
  if (subsystem === 'browser' && !isBrowserEnabled()) {
    return { success: false, error: 'Browser automation is disabled in Desktop Autopilot settings.' };
  }
  if (subsystem === 'app' && !isAppControlEnabled()) {
    return { success: false, error: 'App control is disabled in Desktop Autopilot settings.' };
  }
  if (subsystem === 'system' && !isSystemEnabled()) {
    return {
      success: false,
      error: 'System control (AppleScript/mouse/keyboard) is disabled. Enable it in Settings > Automation > System Control.',
    };
  }
  return null;
}

// ==================== BROWSER (browser-use) ====================

function getActionExecutor() {
  if (!_actionExecutor) _actionExecutor = require('../action-executor');
  return _actionExecutor;
}

function getApplescriptHelper() {
  if (!_applescriptHelper) {
    try {
      _applescriptHelper = require('../packages/agents/applescript-helper');
    } catch (e) {
      log.warn('desktop-autopilot', 'AppleScript helper not available', { error: e.message });
      _applescriptHelper = null;
    }
  }
  return _applescriptHelper;
}

let _sessionHeadless = null;

async function _ensureBrowserSession(opts = {}) {
  const requestedHeadless = opts.headless !== undefined
    ? opts.headless
    : getSetting('browserAutomationHeadless', 'on') !== 'off';

  if (_browserSession && _sessionHeadless !== requestedHeadless) {
    try { await _browserSession.close(); } catch { /* ignore */ }
    _browserSession = null;
  }

  if (_browserSession) return _browserSession;
  try {
    const { BrowserSession, BrowserProfile } = require('browser-use');

    const blockedStr = getSetting('browserAutomationBlockedDomains', '');
    const blockedDomains = blockedStr
      ? blockedStr
          .split('\n')
          .map((d) => d.trim())
          .filter(Boolean)
      : [];

    const disallowed = blockedDomains.length > 0 ? blockedDomains : undefined;

    const profile = new BrowserProfile({
      headless: requestedHeadless,
      viewport: { width: 1280, height: 720 },
      disallowed_domains: disallowed,
      highlight_elements: false,
    });

    _browserSession = new BrowserSession({ browser_profile: profile });
    _sessionHeadless = requestedHeadless;
    return _browserSession;
  } catch (e) {
    log.error('desktop-autopilot', 'Failed to create browser session', { error: e.message });
    throw e;
  }
}

function _getLLM() {
  const mgr = getSettings();
  const provider = mgr ? mgr.get('llmProvider') || 'anthropic' : 'anthropic';

  if (provider === 'openai') {
    const { ChatOpenAI } = require('browser-use/llm/openai');
    const apiKey = mgr ? mgr.get('openaiApiKey') : process.env.OPENAI_API_KEY;
    const model = mgr ? mgr.get('llmModel') || 'gpt-4o' : 'gpt-4o';
    return new ChatOpenAI({ model, apiKey, temperature: 0.1 });
  }

  const { ChatAnthropic } = require('browser-use/llm/anthropic');
  const apiKey = mgr ? mgr.get('anthropicApiKey') : process.env.ANTHROPIC_API_KEY;
  const model = mgr ? mgr.get('llmModel') || 'claude-sonnet-4-20250514' : 'claude-sonnet-4-20250514';
  return new ChatAnthropic({ model, apiKey, temperature: 0.1 });
}

const browser = {
  /**
   * Run a natural-language browser task.
   *
   * Three-tier hybrid flow:
   *   Tier 1: Cached script replay (~2.5s, $0)
   *   Tier 2: Claude writes a script directly (~5-10s, ~$0.01)
   *   Tier 3: browser-use explores + Claude refines (~3-5min, ~$0.15)
   *
   * Each tier falls through to the next on failure.
   * Pass opts.skipCache = true to skip tier 1.
   * Pass opts.skipDirect = true to also skip tier 2 (force browser-use).
   */
  async runTask(task, opts = {}) {
    const blocked = gateCheck('browser');
    if (blocked) return blocked;

    const scriptCache = require('./autopilot-script-cache');
    const headless = opts.headless !== undefined ? opts.headless : true;

    // ==================== TIER 1: Cached script replay ====================
    if (!opts.skipCache) {
      const cached = scriptCache.lookup(task);
      if (cached) {
        log.info('desktop-autopilot', `Tier 1 cache hit: "${task.slice(0, 60)}"`, { hash: cached.hash, hits: cached.hits });
        cached._headless = headless;

        const cacheResult = await scriptCache.execute(cached);

        if (cacheResult.success) {
          return {
            success: true,
            tier: 1,
            cached: true,
            finalResult: cacheResult.finalResult,
            steps: cacheResult.steps,
            elapsed: cacheResult.elapsed,
          };
        }

        log.warn('desktop-autopilot', `Tier 1 failed, invalidating`, {
          hash: cached.hash,
          reason: cacheResult.reason || cacheResult.error,
        });
        scriptCache.invalidate(task);
      }
    }

    // ==================== TIER 2: Claude writes script directly ====================
    if (!opts.skipDirect) {
      log.info('desktop-autopilot', `Tier 2: Claude generating script for: "${task.slice(0, 60)}"`);

      const directScript = await scriptCache.generateScriptWithLLM(task);

      if (directScript) {
        const hash = scriptCache.hashTask(task);
        scriptCache.store(task, directScript, null);

        const cached = scriptCache.lookup(task);
        if (cached) {
          cached._headless = headless;
          const directResult = await scriptCache.execute(cached);

          if (directResult.success) {
            log.info('desktop-autopilot', `Tier 2 succeeded in ${directResult.elapsed}ms`, { hash });
            return {
              success: true,
              tier: 2,
              cached: true,
              finalResult: directResult.finalResult,
              steps: directResult.steps,
              elapsed: directResult.elapsed,
            };
          }

          log.warn('desktop-autopilot', `Tier 2 script failed, falling through to Tier 3`, {
            reason: directResult.reason || directResult.error,
          });
          scriptCache.invalidate(task);
        }
      }
    }

    // ==================== TIER 3: browser-use explores + Claude refines ====================
    log.info('desktop-autopilot', `Tier 3: browser-use exploring for: "${task.slice(0, 60)}"`);

    try {
      const { Agent } = require('browser-use');
      const session = await _ensureBrowserSession({ headless: opts.headless });
      const maxActions = getSetting('browserAutomationMaxActions', 20);

      const agentOpts = {
        task,
        llm: _getLLM(),
        browser_session: session,
        max_actions_per_step: 10,
        max_failures: 5,
        use_vision: opts.useVision === false ? false : true,
        generate_gif: opts.recordGif || false,
      };

      if (opts.sensitiveData) {
        agentOpts.sensitive_data = opts.sensitiveData;
      }

      agentOpts.register_new_step_callback = (summary, output, step) => {
        const url = summary?.url || '';
        const title = summary?.title || '';
        log.info('desktop-autopilot', `Step ${step}: ${url}`, { title, step });
      };

      const agent = new Agent(agentOpts);
      _browserUseAgent = agent;

      const history = await agent.run(opts.maxSteps || maxActions);

      const finalResult = history.final_result ? history.final_result() : null;
      const isDone = history.is_done ? history.is_done() : false;

      let allExtracted = [];
      if (history.history) {
        for (const step of history.history) {
          if (step.result) {
            for (const r of step.result) {
              if (r.extracted_content) allExtracted.push(r.extracted_content);
            }
          }
        }
      }

      const result = {
        success: true,
        tier: 3,
        cached: false,
        finalResult: finalResult || (allExtracted.length > 0 ? allExtracted.join('\n') : null),
        isDone,
        steps: history.history ? history.history.length : 0,
      };

      // Cache a Claude-refined script for next time
      if (result.steps > 0) {
        try {
          const script = await scriptCache.refineScriptWithLLM(task, history);
          if (script) {
            scriptCache.store(task, script, history);
            result.scriptCached = true;
            log.info('desktop-autopilot', 'Claude refined and cached script from browser-use history');
          }
        } catch (cacheErr) {
          log.warn('desktop-autopilot', 'Script caching failed', { error: cacheErr.message });
        }
      }

      log.info('desktop-autopilot', `Tier 3 completed: ${task.slice(0, 80)}`, { steps: result.steps });

      return result;
    } catch (e) {
      log.error('desktop-autopilot', 'All tiers failed', { error: e.message, task: task.slice(0, 80) });
      return { success: false, error: e.message };
    }
  },

  async navigate(url, opts = {}) {
    const blocked = gateCheck('browser');
    if (blocked) return blocked;
    try {
      const session = await _ensureBrowserSession({ headless: opts.headless });
      await session.navigate_to(url);
      return { success: true, url };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  async screenshot(opts = {}) {
    const blocked = gateCheck('browser');
    if (blocked) return blocked;
    try {
      const session = await _ensureBrowserSession();
      const page = session.current_page;
      if (!page) return { success: false, error: 'No active page' };
      const buf = await page.screenshot({ fullPage: opts.fullPage || false });
      return { success: true, data: buf.toString('base64'), encoding: 'base64' };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  async getState() {
    const blocked = gateCheck('browser');
    if (blocked) return blocked;
    try {
      const session = await _ensureBrowserSession();
      const state = await session.get_state();
      return {
        success: true,
        url: state?.url || '',
        title: state?.title || '',
        tabs: state?.tabs || [],
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  async extractContent(opts = {}) {
    const blocked = gateCheck('browser');
    if (blocked) return blocked;
    try {
      const session = await _ensureBrowserSession();
      const page = session.current_page;
      if (!page) return { success: false, error: 'No active page' };

      if (opts.selector) {
        const text = await page.$eval(opts.selector, (el) => el.textContent);
        return { success: true, content: text };
      }
      const text = await page.evaluate(() => document.body.innerText);
      return { success: true, content: text.slice(0, opts.maxLength || 10000) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  async evaluate(script) {
    const blocked = gateCheck('browser');
    if (blocked) return blocked;
    try {
      const session = await _ensureBrowserSession();
      const page = session.current_page;
      if (!page) return { success: false, error: 'No active page' };
      const result = await page.evaluate(script);
      return { success: true, result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  async close() {
    try {
      if (_browserUseAgent) {
        await _browserUseAgent.close();
        _browserUseAgent = null;
      }
      if (_browserSession) {
        await _browserSession.close();
        _browserSession = null;
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  status() {
    return {
      enabled: isBrowserEnabled(),
      sessionActive: !!_browserSession,
      agentRunning: !!_browserUseAgent,
    };
  },
};

// ==================== APP CONTROL (action-executor) ====================

const app = {
  async execute(actionId, params = {}) {
    const blocked = gateCheck('app');
    if (blocked) return blocked;
    try {
      const executor = getActionExecutor();
      const result = await executor.executeAction(actionId, params);
      return result;
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  list() {
    const blocked = gateCheck('app');
    if (blocked) return blocked;
    const executor = getActionExecutor();
    return { success: true, actions: executor.listActions() };
  },

  async situation() {
    const blocked = gateCheck('app');
    if (blocked) return blocked;
    try {
      const executor = getActionExecutor();
      return await executor.executeAction('app-situation', {});
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  hasAction(actionId) {
    const executor = getActionExecutor();
    return executor.hasAction(actionId);
  },
};

// ==================== SYSTEM CONTROL (AppleScript, mouse, keyboard) ====================

const BLOCKED_APPLESCRIPT_PATTERNS = [
  /do shell script.*rm\s+(-rf?|--recursive)\s+[\/~]/i,
  /do shell script.*sudo\b/i,
  /do shell script.*mkfs\b/i,
  /do shell script.*dd\s+if=/i,
];

function isAppleScriptSafe(script) {
  for (const pat of BLOCKED_APPLESCRIPT_PATTERNS) {
    if (pat.test(script)) return false;
  }
  return true;
}

let _robot = null;
function getRobot() {
  if (_robot !== undefined && _robot !== null) return _robot;
  try {
    _robot = require('robotjs');
  } catch {
    _robot = null;
  }
  return _robot;
}

const system = {
  async applescript(script) {
    const blocked = gateCheck('system');
    if (blocked) return blocked;

    if (!isAppleScriptSafe(script)) {
      return { success: false, error: 'AppleScript blocked by safety filter: contains dangerous shell operations' };
    }

    try {
      const helper = getApplescriptHelper();
      if (!helper) return { success: false, error: 'AppleScript helper not available' };
      return await helper.runScript(script);
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  mouseMove(x, y) {
    const blocked = gateCheck('system');
    if (blocked) return blocked;
    const robot = getRobot();
    if (!robot) return { success: false, error: 'robotjs not available — mouse control requires robotjs' };
    robot.moveMouse(x, y);
    return { success: true, position: { x, y } };
  },

  mouseClick(button = 'left', double = false) {
    const blocked = gateCheck('system');
    if (blocked) return blocked;
    const robot = getRobot();
    if (!robot) return { success: false, error: 'robotjs not available' };
    robot.mouseClick(button, double);
    return { success: true, button, double };
  },

  mouseScroll(x = 0, y = 0) {
    const blocked = gateCheck('system');
    if (blocked) return blocked;
    const robot = getRobot();
    if (!robot) return { success: false, error: 'robotjs not available' };
    robot.scrollMouse(x, y);
    return { success: true };
  },

  getMousePosition() {
    const blocked = gateCheck('system');
    if (blocked) return blocked;
    const robot = getRobot();
    if (!robot) {
      const { screen } = require('electron');
      const display = screen.getPrimaryDisplay();
      return {
        success: true,
        position: {
          x: Math.floor(display.workAreaSize.width / 2),
          y: Math.floor(display.workAreaSize.height / 2),
        },
        source: 'fallback',
      };
    }
    const pos = robot.getMousePos();
    return { success: true, position: { x: pos.x, y: pos.y } };
  },

  keyType(text) {
    const blocked = gateCheck('system');
    if (blocked) return blocked;
    const robot = getRobot();
    if (!robot) return { success: false, error: 'robotjs not available' };
    robot.typeString(text);
    return { success: true, typed: text.length };
  },

  keyPress(key, modifiers = {}) {
    const blocked = gateCheck('system');
    if (blocked) return blocked;
    const robot = getRobot();
    if (!robot) return { success: false, error: 'robotjs not available' };
    const mods = [];
    if (modifiers.shift) mods.push('shift');
    if (modifiers.control) mods.push('control');
    if (modifiers.alt) mods.push('alt');
    if (modifiers.meta || modifiers.command) mods.push('command');
    robot.keyTap(key, mods.length > 0 ? mods : undefined);
    return { success: true, key, modifiers: mods };
  },
};

// ==================== INTROSPECTION ====================

function getCapabilities() {
  return {
    enabled: isEnabled(),
    browser: {
      enabled: isBrowserEnabled(),
      engine: 'browser-use',
      sessionActive: !!_browserSession,
    },
    appControl: {
      enabled: isAppControlEnabled(),
      engine: 'action-executor',
    },
    system: {
      enabled: isSystemEnabled(),
      applescript: process.platform === 'darwin',
      mouse: !!getRobot(),
      keyboard: !!getRobot(),
    },
  };
}

function status() {
  return {
    success: true,
    ...getCapabilities(),
  };
}

module.exports = {
  browser,
  app,
  system,
  isEnabled,
  isBrowserEnabled,
  isAppControlEnabled,
  isSystemEnabled,
  getCapabilities,
  status,
};
