/**
 * Playbooks Launch Agent
 *
 * Opens WISER Playbooks with the user's request pre-filled and (if supported)
 * auto-submitted. Uses AI to pick the best Space for the request.
 *
 * This is a "launcher" agent -- it opens the Playbooks UI rather than
 * executing playbooks headlessly (that's playbook-agent's job).
 */

'use strict';

const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

const SPACES_API = 'http://127.0.0.1:47291';
const CONFIDENCE_THRESHOLD = 0.6;

const playbooksLaunchAgent = {
  id: 'playbooks-launch-agent',
  name: 'Playbooks Launcher',
  description:
    'Opens WISER Playbooks with your request pre-filled -- handles planning, skill creation, project setup, and playbook authoring.',
  voice: 'alloy',
  acks: ['Opening Playbooks for you.', 'Let me get that started.'],
  categories: ['productivity', 'planning'],
  keywords: [
    'plan',
    'playbook',
    'create a skill',
    'create a project',
    'plan a step',
    'make a playbook',
    'plan out',
    'launch playbooks',
    'open playbooks',
    'wiser playbooks',
    'start a plan',
    'build a plan',
    'design a workflow',
    'create a plan',
    'plan this',
    'I need to plan',
    'make a plan',
  ],
  executionType: 'action',
  estimatedExecutionMs: 4000,

  prompt: `Playbooks Launcher opens WISER Playbooks with the user's request ready to go.

Capabilities:
- Open WISER Playbooks for planning, skill creation, project setup
- Auto-select the best Space for the request using AI
- Pass the user's full request to Playbooks as context

Use this agent when the user wants to create something (a plan, skill, project, playbook, workflow) that requires the Playbooks UI. This agent does NOT execute playbooks headlessly -- it launches the interactive UI.

IMPORTANT: This agent does NOT handle tickets, ticketing, or the ticketing app. If the user mentions tickets or ticketing, the tickets-agent should handle it instead.`,

  async execute(task) {
    const query = (task.content || task.text || task.query || '').trim();
    if (!query) return { success: true, message: 'What would you like to plan? Tell me and I\'ll open Playbooks for you.' };

    try {
      // Find the Playbooks web tool
      const toolInfo = await this._findPlaybooksTool();
      if (!toolInfo) {
        return {
          success: true,
          message: 'WISER Playbooks is not installed as a web tool. Add it via Tools > Manage Web Tools.',
        };
      }

      // AI-match the best Space
      const spaceMatch = await this._matchSpace(query);

      // Build the deep-link URL
      const params = new URLSearchParams();
      params.set('prompt', query);
      params.set('autoSubmit', 'true');
      if (spaceMatch && spaceMatch.spaceId) {
        params.set('spaceId', spaceMatch.spaceId);
      }
      const deepLink = `${toolInfo.url}?${params.toString()}`;

      // Open the Playbooks web tool with the deep link
      this._openWebTool(toolInfo.id, deepLink);

      const spaceMsg = spaceMatch?.spaceName
        ? ` in the "${spaceMatch.spaceName}" space`
        : '';

      return {
        success: true,
        message: `Opening Playbooks${spaceMsg} with your request.`,
      };
    } catch (err) {
      log.error('playbooks-launch-agent', 'Execute failed', { error: err.message });
      return { success: true, message: `Could not open Playbooks: ${err.message}` };
    }
  },

  async _findPlaybooksTool() {
    try {
      const { ipcMain: _ipcMain } = require('electron');
      if (global.moduleManager) {
        const tools = global.moduleManager.getWebTools();
        const pb = (tools || []).find((t) => /playbook/i.test(t.name));
        if (pb) return pb;
      }
    } catch (err) {
      log.warn('playbooks-launch-agent', 'Could not query web tools via moduleManager', { error: err.message });
    }

    // Fallback: try IPC
    try {
      const tools = await require('electron').ipcMain.handle?.('module:get-web-tools');
      const pb = (tools || []).find((t) => /playbook/i.test(t.name));
      if (pb) return pb;
    } catch {
      // ignore
    }

    return null;
  },

  _openWebTool(toolId, url) {
    try {
      if (global.moduleManager) {
        global.moduleManager.openWebTool(toolId, { url });
        log.info('playbooks-launch-agent', 'Opened Playbooks web tool', { url: url.substring(0, 100) });
        return;
      }
    } catch (err) {
      log.warn('playbooks-launch-agent', 'moduleManager.openWebTool failed', { error: err.message });
    }

    // Fallback: open in the app's tabbed browser
    if (global.mainWindow && !global.mainWindow.isDestroyed()) {
      global.mainWindow.webContents.send('open-in-new-tab', url);
      log.info('playbooks-launch-agent', 'Opened Playbooks in browser tab', { url: url.substring(0, 100) });
      return;
    }

    log.error('playbooks-launch-agent', 'No window available to open Playbooks');
    throw new Error('Could not open the Playbooks web tool -- main window not available.');
  },

  async _matchSpace(query) {
    let spaces;
    try {
      const resp = await fetch(`${SPACES_API}/api/spaces`);
      if (!resp.ok) return null;
      spaces = await resp.json();
    } catch {
      log.info('playbooks-launch-agent', 'Spaces API not reachable, skipping space match');
      return null;
    }

    if (!Array.isArray(spaces) || spaces.length === 0) return null;

    const spaceList = spaces
      .slice(0, 30)
      .map((s, i) => `${i + 1}. "${s.name || 'Untitled'}" (id: ${s.id})`)
      .join('\n');

    try {
      const result = await ai.json(
        `Given these Spaces and the user's request, pick the best Space to work in.

Spaces:
${spaceList}

User request: "${query}"

Return JSON:
{
  "spaceId": "<id of the best matching Space, or null if none fit>",
  "spaceName": "<name of the matched Space, or null>",
  "confidence": <0.0 to 1.0, how confident this Space fits the request>
}

Rules:
- Match by topic, project name, or domain relevance
- If the request mentions a Space name directly, confidence should be high (0.9+)
- If no Space is relevant, return spaceId: null and confidence: 0
- Prefer Spaces that sound like workspaces or projects over generic ones`,
        { profile: 'fast', feature: 'playbooks-launch-space-match' },
      );

      if (result.spaceId && result.confidence >= CONFIDENCE_THRESHOLD) {
        log.info('playbooks-launch-agent', 'Matched Space', {
          spaceId: result.spaceId,
          spaceName: result.spaceName,
          confidence: result.confidence,
        });
        return result;
      }
    } catch (err) {
      log.warn('playbooks-launch-agent', 'AI space match failed', { error: err.message });
    }

    return null;
  },
};

module.exports = playbooksLaunchAgent;
