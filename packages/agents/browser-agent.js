/**
 * Browser Agent
 *
 * Autonomous browser automation agent that uses LLM reasoning to
 * navigate, interact with, and extract data from web pages.
 *
 * Architecture:
 * - Receives natural language tasks via the task exchange
 * - Uses AI service to plan browser actions step-by-step
 * - Executes actions via lib/browser-automation.js (Playwright)
 * - Returns results with screenshots and extracted data
 *
 * Safety guardrails:
 * - Max actions per task (default 20)
 * - Max execution time (60s)
 * - Domain blocklist
 * - No password entry without explicit user confirmation
 * - Screenshot audit trail
 * - Heartbeat on every action for progress visibility
 */

const ai = require('../../lib/ai-service');
const { getAgentMemory } = require('../../lib/agent-memory-store');
const { renderAgentUI } = require('../../lib/agent-ui-renderer');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

// Lazy-load browser automation service (main process only)
let browserService = null;
function getBrowser() {
  if (!browserService) {
    try {
      browserService = require('../../lib/browser-automation');
    } catch (e) {
      log.error('agent', 'Browser automation service not available', { error: e.message });
      return null;
    }
  }
  return browserService;
}

// ==================== CONSTANTS ====================

const MAX_ACTIONS = 20;
const MAX_EXECUTION_MS = 60000; // 60 seconds
const SNAPSHOT_MAX_CHARS = 6000; // Truncate snapshot for LLM context

// System prompt for the action planning LLM
const ACTION_PLANNER_SYSTEM = `You are a browser automation agent. You control a real web browser to complete tasks for the user.

You receive a snapshot of the current page (accessibility tree with numbered refs) and decide what action to take next.

Available actions (respond with EXACTLY ONE JSON object):

Navigation & interaction:
{ "action": "navigate", "url": "https://..." }
{ "action": "click", "ref": <number> }
{ "action": "fill", "ref": <number>, "value": "text to type" }
{ "action": "select", "ref": <number>, "value": "option value" }
{ "action": "press", "ref": <number>, "value": "Enter" }
{ "action": "hover", "ref": <number> }
{ "action": "drag", "sourceRef": <number>, "targetRef": <number> }
{ "action": "scroll", "direction": "down" }
{ "action": "scroll", "direction": "up" }

File operations:
{ "action": "upload", "ref": <number>, "filePath": "/path/to/file" }
{ "action": "download", "ref": <number>, "saveAs": "filename.pdf" }

Waiting:
{ "action": "wait", "selector": ".loading" }
{ "action": "waitForFunction", "expression": "window.loaded===true" }

Data extraction:
{ "action": "extract" }
{ "action": "extractElement", "ref": <number> }
{ "action": "screenshot" }
{ "action": "screenshotElement", "ref": <number> }

Dialog handling (call BEFORE the click that triggers a dialog):
{ "action": "handleDialog", "accept": false }
{ "action": "handleDialog", "accept": true, "promptText": "answer" }

Completion:
{ "action": "done", "summary": "What was accomplished" }
{ "action": "error", "message": "Why the task cannot be completed" }

Rules:
- Respond with a single JSON object, nothing else.
- Use ref numbers from the snapshot to target elements.
- After filling a form field, you may need to click a submit button or press Enter.
- If the page doesn't have what you need, navigate to the right URL.
- Use "done" when the task is complete. Include a clear summary.
- Use "error" if the task is impossible or you're stuck after retrying.
- NEVER enter passwords unless the user explicitly included them in the task.
- If you need to scroll to find elements, use "scroll" then take another look at the snapshot.
- Use "handleDialog" BEFORE clicking a button that opens an alert/confirm/prompt.
- For file uploads, use "upload" with the ref of the file input or button.
- For downloads, use "download" with the ref of the download link/button.
- Keep actions minimal -- do the simplest thing that works.`;

// ==================== AGENT DEFINITION ====================

const browserAgent = {
  id: 'browser-agent',
  name: 'Browser Agent',
  description:
    'Automates web browser tasks -- navigates to websites, fills forms, clicks buttons, extracts information, takes screenshots, and completes multi-step web workflows autonomously',
  voice: 'echo',
  acks: ['Opening the browser.', 'Working on that now.', 'Let me handle that.'],
  categories: ['browser', 'automation', 'web', 'scraping'],
  keywords: [
    'browser',
    'navigate',
    'go to',
    'open website',
    'visit',
    'click',
    'fill',
    'form',
    'submit',
    'type',
    'screenshot',
    'capture',
    'scrape',
    'extract',
    'web page',
    'website',
    'URL',
    'link',
    'login',
    'sign in',
    'search on',
    'look up on',
    'download from',
    'check website',
    'browse',
  ],
  executionType: 'action',
  dataSources: ['browser-automation', 'web'],
  estimatedExecutionMs: 15000,
  capabilities: [
    'navigate to URLs',
    'click buttons and links',
    'fill forms and text inputs',
    'take screenshots (full page or specific elements)',
    'extract page content and data',
    'multi-step web workflows',
    'scroll and interact with page elements',
    'tab management',
    'file upload and download',
    'handle dialogs (alert, confirm, prompt)',
    'drag and drop elements',
    'device emulation (mobile, tablet)',
    'network request inspection',
    'geolocation and timezone spoofing',
  ],

  prompt: `Browser Agent handles tasks that require controlling a web browser to interact with websites.

HIGH CONFIDENCE (0.85+) - BID when the user wants to:
- Navigate to a specific website: "Go to github.com", "Open twitter.com"
- Interact with a web page: "Click the sign-up button on X", "Fill out the contact form on Y"
- Extract data from a website: "Get the headlines from CNN", "Scrape the price from Amazon"
- Complete a multi-step web workflow: "Go to the store and add the first item to cart"
- Take a screenshot of a website: "Screenshot the homepage of example.com"
- Check website status: "Is example.com loading properly?"
- Search on a specific website: "Search for 'AI tools' on Product Hunt"
- Fill out web forms: "Submit a support ticket on the help page"

MEDIUM CONFIDENCE (0.50-0.84) - BID when:
- General web browsing tasks that might need interaction
- Tasks involving checking specific content on a page
- "Download the PDF from..." (navigate + click download)

LOW CONFIDENCE (0.00-0.20) - DO NOT BID:
- General web searches without a target site (search agent handles those)
- Questions that can be answered from knowledge (smalltalk/search agents)
- Non-web tasks: calendar, email, weather, time, music
- File operations that don't involve a browser
- "Search for X" without a specific website target

KEY DISTINCTION: This agent drives a REAL BROWSER. It clicks, types, navigates. 
The search agent answers questions FROM search results. If the user wants to 
interact WITH a website, this agent handles it.`,

  // Memory instance
  memory: null,

  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory('browser-agent', { displayName: 'Browser Agent' });
      await this.memory.load();
      this._ensureMemorySections();
    }
    return this.memory;
  },

  _ensureMemorySections() {
    const sections = this.memory.getSectionNames();

    if (!sections.includes('Recent Tasks')) {
      this.memory.updateSection('Recent Tasks', '*Recent browser tasks will appear here*');
    }
    if (!sections.includes('Learned Sites')) {
      this.memory.updateSection('Learned Sites', '*Frequently visited sites and patterns*');
    }
    if (this.memory.isDirty()) {
      this.memory.save();
    }
  },

  /**
   * Execute a browser automation task.
   * @param {Object} task - { content, metadata, ... }
   * @param {Object} context - { heartbeat, taskId, agentId, submitSubtask }
   * @returns {Object} - { success, message, html?, data? }
   */
  async execute(task, context = {}) {
    const { heartbeat = () => {} } = context;
    const startTime = Date.now();
    const taskDescription = task.content || task.text || '';
    const actions = [];
    let lastScreenshot = null;

    log.info('agent', `Browser agent executing: "${taskDescription.substring(0, 80)}"`);

    // Initialize memory
    if (!this.memory) {
      await this.initialize();
    }

    // Get the browser service
    const browser = getBrowser();
    if (!browser) {
      return {
        success: false,
        message: 'Browser automation is not available. The service could not be loaded.',
      };
    }

    // Load config from settings
    const browserConfig = _loadBrowserSettings();
    if (browserConfig) {
      browser.configure(browserConfig);
    }

    // Check if browser automation is enabled
    const status = browser.status();
    if (!status.running) {
      heartbeat('Starting browser...');
      const startResult = await browser.start();
      if (!startResult.success) {
        return {
          success: false,
          message: `Could not start the browser: ${startResult.error}`,
        };
      }
    }

    try {
      // Check if the task contains a URL to navigate to first
      const initialUrl = _extractUrl(taskDescription);
      if (initialUrl) {
        heartbeat(`Navigating to ${_shortenUrl(initialUrl)}...`);
        const navResult = await browser.navigate(initialUrl);
        if (!navResult.success) {
          return {
            success: false,
            message: `Could not navigate to ${initialUrl}: ${navResult.error}`,
          };
        }
        actions.push({ action: 'navigate', url: initialUrl, success: true });
      }

      // Main action loop
      for (let step = 0; step < MAX_ACTIONS; step++) {
        // Check execution time
        if (Date.now() - startTime > MAX_EXECUTION_MS) {
          log.warn('agent', 'Browser agent hit execution timeout');
          // Take final screenshot before bailing
          lastScreenshot = await _safeScreenshot(browser);
          return _buildResult(
            true,
            'I ran out of time, but here is what I accomplished so far.',
            actions,
            lastScreenshot
          );
        }

        // Take a snapshot of the current page
        heartbeat(`Analyzing page (step ${step + 1})...`);
        const snap = await browser.snapshot();
        if (!snap.success) {
          return _buildResult(false, `Could not read the page: ${snap.error}`, actions, lastScreenshot);
        }

        // Ask LLM what to do next
        const nextAction = await _planNextAction(taskDescription, snap, actions, step);
        if (!nextAction) {
          return _buildResult(false, 'I could not determine what to do next.', actions, lastScreenshot);
        }

        log.info('agent', `Step ${step + 1}: ${nextAction.action}`, {
          ref: nextAction.ref,
          value: nextAction.value?.substring?.(0, 30),
        });

        // Execute the planned action
        switch (nextAction.action) {
          case 'navigate': {
            heartbeat(`Navigating to ${_shortenUrl(nextAction.url)}...`);
            const result = await browser.navigate(nextAction.url);
            actions.push({ ...nextAction, success: result.success, error: result.error });
            if (!result.success) {
              return _buildResult(false, `Navigation failed: ${result.error}`, actions, lastScreenshot);
            }
            break;
          }

          case 'click': {
            const refInfo = snap.refs[nextAction.ref];
            heartbeat(`Clicking ${refInfo?.name || `element ${nextAction.ref}`}...`);
            const result = await browser.act(nextAction.ref, 'click');
            actions.push({ ...nextAction, success: result.success, error: result.error });
            break;
          }

          case 'fill': {
            const refInfo = snap.refs[nextAction.ref];
            heartbeat(`Filling ${refInfo?.name || 'field'}...`);
            const result = await browser.act(nextAction.ref, 'fill', nextAction.value);
            actions.push({ ...nextAction, success: result.success, error: result.error });
            break;
          }

          case 'select': {
            const result = await browser.act(nextAction.ref, 'select', nextAction.value);
            actions.push({ ...nextAction, success: result.success, error: result.error });
            break;
          }

          case 'press': {
            const result = await browser.act(nextAction.ref, 'press', nextAction.value || 'Enter');
            actions.push({ ...nextAction, success: result.success, error: result.error });
            break;
          }

          case 'scroll': {
            heartbeat('Scrolling...');
            const result = await browser.scroll(nextAction.direction || 'down');
            actions.push({ ...nextAction, success: result.success });
            break;
          }

          case 'wait': {
            heartbeat('Waiting for page to update...');
            const result = await browser.waitFor({
              selector: nextAction.selector,
              text: nextAction.text,
              timeout: nextAction.timeout || 5000,
            });
            actions.push({ ...nextAction, success: result.success });
            break;
          }

          case 'hover': {
            const refInfo = snap.refs[nextAction.ref];
            heartbeat(`Hovering over ${refInfo?.name || `element ${nextAction.ref}`}...`);
            const result = await browser.act(nextAction.ref, 'hover');
            actions.push({ ...nextAction, success: result.success, error: result.error });
            break;
          }

          case 'drag': {
            heartbeat('Dragging element...');
            const result = await browser.drag(nextAction.sourceRef, nextAction.targetRef);
            actions.push({ ...nextAction, success: result.success, error: result.error });
            break;
          }

          case 'upload': {
            heartbeat('Uploading file...');
            const result = await browser.uploadViaChooser(nextAction.ref, nextAction.filePath);
            actions.push({ ...nextAction, success: result.success, error: result.error });
            break;
          }

          case 'download': {
            heartbeat('Downloading file...');
            const result = await browser.download(nextAction.ref, nextAction.saveAs);
            actions.push({ ...nextAction, success: result.success, filename: result.filename, error: result.error });
            break;
          }

          case 'handleDialog': {
            browser.handleDialog({ accept: nextAction.accept, promptText: nextAction.promptText });
            actions.push({ ...nextAction, success: true });
            break;
          }

          case 'waitForFunction': {
            heartbeat('Waiting for page condition...');
            const result = await browser.waitForFunction(nextAction.expression, nextAction.timeout || 10000);
            actions.push({ ...nextAction, success: result.success, error: result.error });
            break;
          }

          case 'extract': {
            heartbeat('Extracting page content...');
            const result = await browser.extractText(nextAction.selector);
            actions.push({ ...nextAction, success: result.success, text: result.text?.substring(0, 2000) });
            break;
          }

          case 'extractElement': {
            heartbeat('Extracting element...');
            // Use evaluate on the ref's text content
            const refInfo2 = snap.refs[nextAction.ref];
            const text = refInfo2?.name || '';
            actions.push({ action: 'extractElement', ref: nextAction.ref, success: true, text });
            break;
          }

          case 'screenshot': {
            heartbeat('Taking screenshot...');
            lastScreenshot = await _safeScreenshot(browser);
            actions.push({ action: 'screenshot', success: !!lastScreenshot });
            break;
          }

          case 'screenshotElement': {
            heartbeat('Capturing element...');
            const result = await browser.screenshotElement(nextAction.ref);
            if (result.success) lastScreenshot = result.image;
            actions.push({ action: 'screenshotElement', ref: nextAction.ref, success: result.success });
            break;
          }

          case 'done': {
            // Task complete -- take final screenshot
            lastScreenshot = await _safeScreenshot(browser);

            // Track in memory
            _trackInMemory(this.memory, taskDescription, nextAction.summary, actions.length);

            return _buildResult(true, nextAction.summary, actions, lastScreenshot);
          }

          case 'error': {
            lastScreenshot = await _safeScreenshot(browser);
            return _buildResult(false, nextAction.message || 'Task could not be completed.', actions, lastScreenshot);
          }

          default: {
            log.warn('agent', `Unknown action: ${nextAction.action}`);
            actions.push({ action: nextAction.action, success: false, error: 'Unknown action' });
          }
        }
      }

      // Ran out of actions
      lastScreenshot = await _safeScreenshot(browser);
      return _buildResult(
        true,
        `I completed ${actions.length} steps. The task may need more interaction.`,
        actions,
        lastScreenshot
      );
    } catch (error) {
      log.error('agent', 'Browser agent error', { error: error.message });
      lastScreenshot = await _safeScreenshot(browser);
      return _buildResult(false, `An error occurred: ${error.message}`, actions, lastScreenshot);
    }
  },
};

// ==================== HELPER FUNCTIONS ====================

/**
 * Ask the LLM to plan the next browser action.
 */
async function _planNextAction(taskDescription, snap, previousActions, step) {
  // Build the action history summary
  const historyLines = previousActions
    .slice(-5)
    .map((a, i) => {
      const success = a.success ? 'OK' : 'FAILED';
      let detail = a.action;
      if (a.url) detail += ` ${a.url}`;
      if (a.ref) detail += ` ref=${a.ref}`;
      if (a.value) detail += ` "${a.value.substring(0, 30)}"`;
      if (a.error) detail += ` (${a.error})`;
      return `  ${i + 1}. [${success}] ${detail}`;
    })
    .join('\n');

  // Truncate the snapshot tree for context window management
  let tree = snap.tree || '';
  if (tree.length > SNAPSHOT_MAX_CHARS) {
    tree = tree.substring(0, SNAPSHOT_MAX_CHARS) + '\n... (truncated)';
  }

  const userPrompt = `Task: ${taskDescription}

Current page: ${snap.url || 'about:blank'}
Title: ${snap.title || '(none)'}

Page snapshot (elements with [ref] numbers):
${tree || '(empty page)'}

${previousActions.length > 0 ? `Previous actions:\n${historyLines}\n` : ''}Step ${step + 1} of ${MAX_ACTIONS}. What is the next action?`;

  try {
    const result = await ai.json(userPrompt, {
      profile: 'fast',
      system: ACTION_PLANNER_SYSTEM,
      temperature: 0.1,
      maxTokens: 300,
      feature: 'browser-agent',
    });

    if (result && result.action) {
      return result;
    }

    log.warn('agent', 'LLM returned invalid action plan', { result });
    return null;
  } catch (error) {
    log.error('agent', 'Action planning LLM call failed', { error: error.message });
    return null;
  }
}

/**
 * Take a screenshot safely (never throws).
 */
async function _safeScreenshot(browser) {
  try {
    const result = await browser.screenshot();
    return result.success ? result.image : null;
  } catch {
    return null;
  }
}

/**
 * Build a result object with optional HTML panel.
 */
function _buildResult(success, message, actions, screenshot) {
  const _actionSummary = actions
    .map((a, i) => {
      const icon = a.success ? 'OK' : 'ERR';
      let desc = a.action;
      if (a.url) desc += ` ${_shortenUrl(a.url)}`;
      if (a.ref) desc += ` [${a.ref}]`;
      if (a.value) desc += ` "${a.value.substring(0, 30)}"`;
      return `${i + 1}. [${icon}] ${desc}`;
    })
    .join('\n');

  const result = {
    success,
    message,
    data: {
      actions,
      actionCount: actions.length,
      screenshot,
    },
  };

  // Build HTML panel via declarative spec if we have a screenshot or action list
  if (screenshot || actions.length > 0) {
    result.html = renderAgentUI(_buildUISpec(message, actions, screenshot));
  }

  return result;
}

/**
 * Build a declarative UI spec for the Command HUD.
 * The spec is passed to renderAgentUI() which produces safe, escaped HTML.
 */
function _buildUISpec(message, actions, screenshot) {
  return {
    type: 'panel',
    message,
    actions: actions.map((a) => ({
      action: a.action,
      url: a.url,
      ref: a.ref,
      value: a.value ? a.value.substring(0, 40) : undefined,
      success: a.success,
    })),
    screenshot: screenshot || undefined,
  };
}

/**
 * Extract a URL from task text.
 */
function _extractUrl(text) {
  // Match explicit URLs
  const urlMatch = text.match(/https?:\/\/[^\s,)]+/i);
  if (urlMatch) return urlMatch[0];

  // Match domain-like patterns: "go to github.com", "open example.com"
  const domainMatch = text.match(
    /(?:go to|open|visit|navigate to|browse to|check)\s+([a-z0-9][-a-z0-9]*\.(?:com|org|net|io|dev|ai|co|edu|gov|app|me|info|biz|us|uk|ca|de|fr|jp|au|site|tech|xyz|page|blog|shop|store)[^\s,)]*)/i
  );
  if (domainMatch) return `https://${domainMatch[1]}`;

  return null;
}

/**
 * Shorten a URL for display.
 */
function _shortenUrl(url) {
  try {
    const parsed = new URL(url);
    const pathPart = parsed.pathname.length > 30 ? parsed.pathname.substring(0, 27) + '...' : parsed.pathname;
    return parsed.hostname + (pathPart === '/' ? '' : pathPart);
  } catch {
    return url.substring(0, 50);
  }
}

/**
 * Escape HTML for safe display.
 */
function _escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Track completed task in agent memory.
 */
async function _trackInMemory(memory, task, summary, actionCount) {
  if (!memory) return;
  try {
    const timestamp = new Date().toISOString().split('T')[0];
    memory.appendToSection(
      'Recent Tasks',
      `- ${timestamp}: "${task.substring(0, 50)}" (${actionCount} actions) -- ${summary?.substring(0, 80) || 'done'}`,
      20
    );
    await memory.save();
  } catch {
    // Non-fatal
  }
}

/**
 * Load browser settings from the settings manager.
 */
function _loadBrowserSettings() {
  try {
    const { getSettingsManager } = require('../../settings-manager');
    const settings = getSettingsManager();
    if (!settings) return null;

    const allSettings = settings.getAll();
    const cfg = {};

    if (allSettings.browserAutomationHeadless !== undefined) {
      cfg.headless = allSettings.browserAutomationHeadless !== 'off';
    }
    if (allSettings.browserAutomationMaxActions) {
      cfg.maxActionsPerTask = parseInt(allSettings.browserAutomationMaxActions, 10) || MAX_ACTIONS;
    }
    if (allSettings.browserAutomationIdleTimeout) {
      cfg.idleShutdownMs = (parseInt(allSettings.browserAutomationIdleTimeout, 10) || 5) * 60 * 1000;
    }
    if (allSettings.browserAutomationBlockedDomains) {
      cfg.blockedDomains = allSettings.browserAutomationBlockedDomains
        .split('\n')
        .map((d) => d.trim())
        .filter((d) => d.length > 0);
    }
    if (allSettings.browserAutomationMaxTabs) {
      cfg.maxConcurrentTabs = parseInt(allSettings.browserAutomationMaxTabs, 10) || 3;
    }

    return Object.keys(cfg).length > 0 ? cfg : null;
  } catch {
    return null;
  }
}

module.exports = browserAgent;
