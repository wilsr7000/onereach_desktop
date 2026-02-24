'use strict';

let _browsingAPI, _errorDetector;
function getBrowsingAPI() { if (!_browsingAPI) _browsingAPI = require('./browsing-api'); return _browsingAPI; }
function getErrorDetector() { if (!_errorDetector) _errorDetector = require('./browse-error-detector'); return _errorDetector; }

const MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_MAX_ACTIONS = 20;
const DEFAULT_TIMEOUT = 60000;

const DEFAULT_VISION_THRESHOLD = 3;
const DEFAULT_MAX_VISION_STEPS = 5;

function buildSystemPrompt(task, visionActive) {
  return `You are a browser automation agent. You navigate web pages to complete tasks.

TASK: ${task}

You receive an accessibility snapshot of the current page showing interactive elements with ref numbers.${visionActive ? '\nA SCREENSHOT of the page is also attached. Use it to understand the visual layout and identify elements the snapshot may have missed.' : ''}
Respond with a single JSON object describing your next action.

AVAILABLE ACTIONS:
- {"action":"click","ref":N} — click element with ref N
- {"action":"fill","ref":N,"value":"text"} — type text into input ref N
- {"action":"select","ref":N,"value":"option"} — select dropdown option
- {"action":"scroll","value":"up|down|top|bottom"} — scroll the page
- {"action":"press","ref":N,"value":"Enter|Tab|Escape"} — press a key
- {"action":"navigate","url":"https://..."} — go to a URL
- {"action":"submit","ref":N} — submit the form containing element ref N
- {"action":"extract","mode":"readability"} — extract page content
- {"action":"done","result":{...}} — task complete, return result
- {"action":"error","message":"..."} — cannot complete task

OPTIONAL STRATEGY:
Add "strategy" to any action to control HOW it executes:
- "fast" — direct DOM property write, skips event dispatch. Use for simple forms on known sites.
- "default" — synthetic DOM events (click(), dispatchEvent). Works on most SPAs. This is the default.
- "stealth" — native input simulation producing trusted events. Use when a site ignores synthetic clicks.
- "auto" — tries default first, falls back to stealth if the action appears to have no effect.
Example: {"action":"click","ref":5,"strategy":"stealth"}

CONTEXT PROVIDED:
- PAGE ELEMENTS: Accessibility snapshot with ref numbers for interactive elements.
- CONSOLE OUTPUT: Browser console warnings/errors from the page (if any). Use these to diagnose failed actions.
- NETWORK ERRORS: HTTP requests that returned 4xx/5xx or failed (if any). Use these to understand server-side failures.

AUTH HANDLING:
- If you see "AUTH WALL DETECTED" in the context, the page requires login and auto-fill was attempted.
- If auto-fill succeeded, look for a submit/sign-in button and click it.
- If auto-fill failed (no saved credentials), use "error" with message "login-required: <domain>" so the orchestrator can prompt the user.
- For MFA/2FA pages, use "error" with message "mfa-required: <domain>" — the user must complete this step.
- For OAuth consent screens, look for an "Allow" or "Authorize" button and click it if the task requires it.
- NEVER type passwords or sensitive data directly. Credentials are handled via the auto-fill system.

RULES:
- Respond with ONLY a JSON object, no other text.
- Use ref numbers from the snapshot to target elements.
- One action per response.
- If you need to fill a form, fill each field separately.
- After clicking a link or submitting a form, wait for the new page before acting.
- When the task is complete, use "done" with the extracted data.
- If you see console errors or network failures, use that information to decide your next action.
- If a form submission returned a 4xx error, check console for validation messages before retrying.
- If a click or fill had no visible effect, retry with "strategy":"stealth" to produce trusted events.
- If you're stuck after 3 failed actions, use "error" to report why.`;
}

const CONSOLE_LEVELS = ['verbose', 'info', 'warn', 'error'];

function buildActionPrompt(snapshot, history, url, title, opts = {}) {
  const consoleLogs = opts.consoleLogs || [];
  const networkLog = opts.networkLog || [];

  let prompt = `CURRENT PAGE: ${title}\nURL: ${url}\n\n`;

  if (history.length > 0) {
    const recent = history.slice(-5);
    prompt += 'RECENT ACTIONS:\n';
    for (const h of recent) {
      let line = `- ${h.action}${h.ref ? ' ref=' + h.ref : ''}${h.value ? ' value="' + h.value + '"' : ''}`;
      if (h.strategy && h.strategy !== 'default') line += ` [${h.strategy}]`;
      line += ` → ${h.success ? 'OK' : 'FAILED: ' + (h.error || 'unknown')}`;
      if (h.fallback) line += ` (fell back to ${h.fallback})`;
      prompt += line + '\n';
    }
    prompt += '\n';
  }

  if (consoleLogs.length > 0) {
    const relevant = consoleLogs.filter((l) => l.level >= 2);
    if (relevant.length > 0) {
      prompt += 'CONSOLE OUTPUT (since last action):\n';
      for (const log of relevant.slice(-10)) {
        const levelStr = CONSOLE_LEVELS[log.level] || 'log';
        const src = log.source ? `  (${log.source}${log.line ? ':' + log.line : ''})` : '';
        prompt += `[${levelStr}] ${log.message}${src}\n`;
      }
      prompt += '\n';
    }
  }

  if (networkLog.length > 0) {
    prompt += 'NETWORK ERRORS (since last action):\n';
    for (const entry of networkLog.slice(-8)) {
      if (entry.error) {
        prompt += `${entry.method} ${entry.url} -> ${entry.error}\n`;
      } else {
        prompt += `${entry.method} ${entry.url} -> ${entry.status}\n`;
      }
    }
    prompt += '\n';
  }

  if (opts.authContext) {
    const ac = opts.authContext;
    prompt += 'AUTH WALL DETECTED:\n';
    prompt += `- Detection: ${ac.detectionType}\n`;
    if (ac.autoFillAttempted) {
      prompt += `- Auto-fill: ${ac.autoFillResult?.filled ? 'succeeded' : 'failed'} (${ac.autoFillResult?.reason || 'credentials applied'})\n`;
      if (ac.autoFillResult?.filled) {
        prompt += '- Action needed: find and click the sign-in / submit button\n';
      } else {
        prompt += '- Action needed: report "login-required" error — no saved credentials\n';
      }
    }
    if (ac.detectionType === 'mfa') {
      prompt += '- Action needed: report "mfa-required" error — user must complete verification\n';
    }
    if (ac.detectionType === 'oauth') {
      prompt += '- This is an OAuth consent screen. Look for Allow/Authorize/Continue button.\n';
    }
    prompt += '\n';
  }

  if (opts.visionActive) {
    prompt += '[SCREENSHOT ATTACHED — use it to understand visual layout, element positions, and non-standard components]\n\n';
  }

  prompt += 'PAGE ELEMENTS:\n';
  const refs = snapshot.refs || [];
  for (const ref of refs.slice(0, 80)) {
    let line = `[${ref.ref}] ${ref.role}`;
    if (ref.name) line += ` "${ref.name}"`;
    if (ref.value) line += ` value="${ref.value}"`;
    if (ref.type) line += ` type=${ref.type}`;
    if (ref.checked !== undefined) line += ` checked=${ref.checked}`;
    if (ref.disabled) line += ' DISABLED';
    if (ref.href) line += ` href=${ref.href.slice(0, 80)}`;
    prompt += line + '\n';
  }

  if (refs.length === 0 && opts.visionActive) {
    prompt += '(No interactive elements found in accessibility snapshot — use the screenshot to identify elements)\n';
  }

  if (refs.length > 80) {
    prompt += `\n... and ${refs.length - 80} more elements (scroll to see more)\n`;
  }

  prompt += '\nWhat is your next action? Respond with JSON only.';
  return prompt;
}

function parseActionResponse(text) {
  try {
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1) return null;
    return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

async function run(opts = {}) {
  const {
    task,
    profile = 'fast',
    maxActions = DEFAULT_MAX_ACTIONS,
    timeout = DEFAULT_TIMEOUT,
    sessionConfig = { mode: 'auto-promote' },
    startUrl = null,
    onAction = null,
    useVision = 'auto',
    visionThreshold = DEFAULT_VISION_THRESHOLD,
    maxVisionSteps = DEFAULT_MAX_VISION_STEPS,
    _deps = {},
  } = opts;

  const api = _deps.browsingAPI || getBrowsingAPI();
  const errDet = _deps.errorDetector || getErrorDetector();

  let ai;
  try {
    ai = _deps.ai || require('./ai-service');
  } catch {
    return { success: false, error: 'AI service not available' };
  }

  const startTime = Date.now();
  const history = [];
  const checkpoints = [];
  let sessionId = null;
  let currentProfile = profile;
  let consecutiveFailures = 0;
  let visionCallCount = 0;

  try {
    const sess = await api.createSession({ ...sessionConfig, timeout, maxActions });
    sessionId = sess.sessionId;

    if (startUrl) {
      await api.navigate(sessionId, startUrl);
    }

    for (let step = 0; step < maxActions; step++) {
      if (Date.now() - startTime > timeout) {
        return formatResult('timeout', history, checkpoints, startTime, sessionId);
      }

      const snapshot = await api.snapshot(sessionId);
      const sessInfo = api.getSession(sessionId);
      const url = sessInfo?.url || '';
      const title = sessInfo?.title || '';

      let consoleLogs = [];
      let networkLog = [];
      try {
        if (typeof api.getConsoleLogs === 'function') consoleLogs = api.getConsoleLogs(sessionId, { clear: true });
        if (typeof api.getNetworkLog === 'function') networkLog = api.getNetworkLog(sessionId, { clear: true });
      } catch (_) { /* observation enrichment is optional */ }

      checkpoints.push({ step, url, refsCount: snapshot.refs?.length || 0, consoleLogs: consoleLogs.length, networkErrors: networkLog.length, visionUsed: false, timestamp: Date.now() });

      let authContext = null;
      try {
        if (typeof api.checkAuthState === 'function') {
          let authState = await api.checkAuthState(sessionId, { spaSettle: 0 });
          if (authState.blocked) {
            // Try silent auto-auth (pool/tab/chrome cookies) before bothering the user
            if (typeof api._tryAutoAuth === 'function') {
              const autoResult = await api._tryAutoAuth(sessionId, api._getSession(sessionId), url, { type: authState.detectionType, blocked: true });
              if (autoResult) {
                history.push({ action: 'auto-auth', source: autoResult.source, success: true, timestamp: Date.now() });
                if (onAction) onAction({ step, action: { action: 'auto-auth', source: autoResult.source }, url, title });
                authState = await api.checkAuthState(sessionId, { spaSettle: 0 });
              }
            }
          }

          if (authState.blocked) {
            authContext = { detectionType: authState.detectionType, autoFillAttempted: false };
            checkpoints[checkpoints.length - 1].authDetected = authState.detectionType;

            if (authState.authWall && typeof api.autoFillCredentials === 'function') {
              authContext.autoFillAttempted = true;
              authContext.autoFillResult = await api.autoFillCredentials(sessionId, url);
            }

            if ((authState.captcha || authState.mfa) && typeof api.waitForUser === 'function') {
              history.push({
                action: 'hitl-wait', reason: authState.detectionType,
                success: true, timestamp: Date.now(),
              });
              if (onAction) onAction({ step, action: { action: 'hitl-wait', reason: authState.detectionType }, url, title });

              const waitResult = await api.waitForUser(sessionId, {
                waitFor: 'navigation',
                timeout: Math.min(timeout - (Date.now() - startTime), 120000),
              });

              if (waitResult.resumed) {
                history.push({
                  action: 'hitl-resumed', url: waitResult.url,
                  success: true, timestamp: Date.now(),
                });
                authContext = null;
                continue;
              } else {
                return formatResult('hitl-timeout', history, checkpoints, startTime, sessionId,
                  `User did not complete ${authState.detectionType} within timeout`);
              }
            }
          }
        }
      } catch (_) { /* auth check is best-effort */ }

      const refsCount = snapshot.refs?.length || 0;
      const shouldUseVision =
        useVision === 'always' ||
        (useVision === 'auto' && refsCount < visionThreshold);
      const visionActive = shouldUseVision && visionCallCount < maxVisionSteps;

      let screenshotBase64 = null;
      if (visionActive) {
        try {
          const shot = await api.screenshot(sessionId, { format: 'jpeg', quality: 60 });
          if (shot?.base64) screenshotBase64 = shot.base64;
        } catch (_) { /* screenshot is best-effort */ }
      }
      const usingVision = visionActive && screenshotBase64;
      if (usingVision) visionCallCount++;

      if (usingVision) checkpoints[checkpoints.length - 1].visionUsed = true;

      const systemPrompt = buildSystemPrompt(task, usingVision);
      const userPrompt = buildActionPrompt(snapshot, history, url, title, { consoleLogs, networkLog, authContext, visionActive: usingVision });

      let actionPlan;
      try {
        let response;
        if (usingVision) {
          response = await ai.vision(screenshotBase64, userPrompt, {
            system: systemPrompt,
            maxTokens: 400,
            temperature: 0.1,
            feature: 'browsing-task-runner-vision',
          });
          if (typeof response === 'string') response = { content: response };
        } else {
          response = await ai.chat({
            profile: currentProfile,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
            maxTokens: 300,
            temperature: 0.1,
            feature: 'browsing-task-runner',
          });
        }

        actionPlan = parseActionResponse(response.content);
      } catch (err) {
        history.push({ action: 'llm-error', error: err.message, success: false, timestamp: Date.now() });
        consecutiveFailures++;

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          return formatResult('llm-failed', history, checkpoints, startTime, sessionId);
        }
        continue;
      }

      if (!actionPlan) {
        history.push({ action: 'parse-error', success: false, timestamp: Date.now() });
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          return formatResult('parse-failed', history, checkpoints, startTime, sessionId);
        }
        continue;
      }

      if (onAction) onAction({ step, action: actionPlan, url, title });

      if (actionPlan.action === 'done') {
        history.push({ action: 'done', result: actionPlan.result, success: true, visionUsed: usingVision, timestamp: Date.now() });
        return {
          success: true,
          data: actionPlan.result,
          history,
          checkpoints,
          latencyMs: Date.now() - startTime,
          steps: step + 1,
          sessionId,
          visionCalls: visionCallCount,
        };
      }

      if (actionPlan.action === 'error') {
        history.push({ action: 'error', error: actionPlan.message, success: false, timestamp: Date.now() });
        return formatResult('agent-error', history, checkpoints, startTime, sessionId, actionPlan.message);
      }

      let result;
      try {
        if (actionPlan.action === 'navigate' && actionPlan.url) {
          result = await api.navigate(sessionId, actionPlan.url);
        } else if (actionPlan.action === 'extract') {
          result = await api.extract(sessionId, { mode: actionPlan.mode || 'readability' });
          history.push({ action: 'extract', success: true, resultLength: result.text?.length || 0, timestamp: Date.now() });
          consecutiveFailures = 0;
          continue;
        } else if (actionPlan.action === 'scroll') {
          await api.act(sessionId, { action: 'scroll', value: actionPlan.value || 'down' });
          result = { success: true };
        } else {
          const actPayload = {
            action: actionPlan.action,
            ref: actionPlan.ref,
            value: actionPlan.value,
          };
          if (actionPlan.strategy) actPayload.strategy = actionPlan.strategy;
          result = await api.act(sessionId, actPayload);

          if (!result.success && !actionPlan.strategy && (actionPlan.action === 'click' || actionPlan.action === 'fill')) {
            const retried = await api.act(sessionId, { ...actPayload, strategy: 'stealth' });
            if (retried.success) {
              result = retried;
              result.fallback = 'stealth';
            }
          }
        }

        const success = result && (result.success !== false);
        history.push({
          action: actionPlan.action, ref: actionPlan.ref, value: actionPlan.value,
          strategy: result?.strategy || actionPlan.strategy,
          success, error: result?.error, urlChanged: result?.urlChanged,
          fallback: result?.fallback || null, visionUsed: usingVision, timestamp: Date.now(),
        });

        if (success) consecutiveFailures = 0;
        else consecutiveFailures++;

        if (consecutiveFailures >= 2 && currentProfile === 'fast') currentProfile = 'standard';

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          try {
            const partial = await api.extract(sessionId, { mode: 'readability' });
            return {
              success: false, error: 'Max consecutive failures reached',
              partial: partial?.text || null, history, checkpoints,
              latencyMs: Date.now() - startTime, steps: step + 1, sessionId,
            };
          } catch {
            return formatResult('max-failures', history, checkpoints, startTime, sessionId);
          }
        }

        if (result?.urlChanged && api.sessions) {
          const sess = api.sessions.get(sessionId);
          if (sess?.window?.webContents) {
            const detection = await errDet.detect(sess.window.webContents);
            if (detection?.type === 'consent') {
              await errDet.dismissConsent(sess.window.webContents);
            }
          }
        }
      } catch (err) {
        history.push({ action: actionPlan.action, success: false, error: err.message, timestamp: Date.now() });
        consecutiveFailures++;
      }
    }

    return formatResult('max-actions', history, checkpoints, startTime, sessionId);
  } catch (err) {
    return {
      success: false, error: err.message,
      history, checkpoints, latencyMs: Date.now() - startTime, sessionId,
    };
  }
}

function formatResult(reason, history, checkpoints, startTime, sessionId, message) {
  return {
    success: false,
    error: message || `Task ended: ${reason}`,
    reason,
    history,
    checkpoints,
    latencyMs: Date.now() - startTime,
    steps: history.length,
    sessionId,
  };
}

module.exports = { run, buildSystemPrompt, buildActionPrompt, parseActionResponse, DEFAULT_VISION_THRESHOLD, DEFAULT_MAX_VISION_STEPS };
