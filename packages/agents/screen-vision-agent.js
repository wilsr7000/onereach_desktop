/**
 * Screen Vision Agent
 *
 * Bidder agent that captures what's currently on screen and answers
 * questions about it via ai.vision. Sits alongside time-agent /
 * weather-agent / etc. in the unified-bidder.
 *
 * Behavior:
 *   - Wins on visual-referent intents ("what is this error?", "read this",
 *     "what is on my screen?", "summarize this article").
 *   - Loses on factual/non-visual intents ("what time is it", "weather in
 *     Boston") -- the bidder routes those to time-agent / weather-agent.
 *   - On execute(), captures the screen the orb is on via desktopCapturer,
 *     base64-encodes the thumbnail, and calls ai.vision with the user's
 *     transcript as the question.
 *
 * Voice-activated by design: no orb UI affordance, no IPC plumbing, no
 * realtime-session image input. The unified-bidder is the activation surface.
 *
 * Dependencies are wrapped in __setDeps so tests can stub electron's
 * desktopCapturer + screen-service + ai.vision without the brittle
 * vi.mock interception of lazy CJS requires.
 */

const { getAgentMemory } = require('../../lib/agent-memory-store');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

const _defaultDeps = {
  /** @returns {Promise<{ source: object, display: object }>} */
  captureScreenSource: async () => {
    const { desktopCapturer, BrowserWindow } = require('electron');
    const screenService = require('../../lib/screen-service');

    // Pick the orb's display if we can find the orb window; else primary.
    let display = null;
    try {
      const orbWindow = BrowserWindow.getAllWindows().find((w) => {
        try {
          const url = w.webContents && w.webContents.getURL();
          return url && url.includes('orb.html');
        } catch (_err) {
          return false;
        }
      });
      display = screenService.getDisplayForWindow(orbWindow);
    } catch (_err) { /* fall through to primary */ }

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1600, height: 1000 },
    });
    if (!sources || sources.length === 0) {
      throw new Error('No screen sources available');
    }

    // Match by display_id when available, else first.
    const source =
      (display && sources.find((s) => s.display_id === String(display.id))) ||
      sources[0];
    return { source, display };
  },
  /**
   * @param {string} base64Image - raw base64 (no `data:` prefix)
   * @param {string} prompt
   * @returns {Promise<string>} text answer
   */
  visionAnswer: async (base64Image, prompt) => {
    const { getAIService } = require('../../lib/ai-service');
    const result = await getAIService().vision(base64Image, prompt, {
      feature: 'screen-vision-agent',
      maxTokens: 500,
    });
    return result?.content || '';
  },
};

const screenVisionAgent = {
  id: 'screen-vision-agent',
  name: 'Screen Vision Agent',
  description: 'Looks at what is on the user screen and answers questions about it',
  voice: 'sage',
  acks: ['Taking a look.', 'Let me see.'],
  categories: ['system', 'vision'],
  keywords: ['screen', 'this', 'that', 'see', 'visible', 'showing', 'window', 'error', 'message'],
  executionType: 'action',
  estimatedExecutionMs: 2500,

  prompt: `Screen Vision Agent captures the user's current focused screen and uses vision AI to answer questions about what is visible.

HIGH confidence (this agent wins):
- "What is this error?" / "what does this say?" / "read this"
- "What is on my screen?" / "describe what you see"
- "Summarize this article" / "what is in the window?"
- Any request where the user references "this", "that", "here", "the screen", "the window" without other context

LOW confidence (other agents win):
- "What time is it?" / "weather in Boston" -- factual, no visual referent
- "Open my calendar" -- action, not visual
- "Search the web for X" -- explicit web search, not local screen
- "Call alice" -- communication intent`,

  memory: null,
  _deps: _defaultDeps,

  /**
   * Test seam -- swap in stubs for desktopCapturer + ai.vision.
   */
  __setDeps(deps) {
    this._deps = { ..._defaultDeps, ...(deps || {}) };
  },

  __resetDeps() {
    this._deps = _defaultDeps;
  },

  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory('screen-vision-agent', { displayName: 'Screen Vision Agent' });
      await this.memory.load();
    }
    return this.memory;
  },

  async execute(task) {
    try {
      if (!this.memory) await this.initialize();

      // 1. Capture a screen thumbnail.
      let captureResult;
      try {
        captureResult = await this._deps.captureScreenSource();
      } catch (err) {
        log.error('agent', '[screen-vision] capture failed', { error: err.message });
        return {
          success: false,
          message: 'I could not capture your screen. Check that screen recording is permitted in System Settings.',
        };
      }

      // 2. Convert source.thumbnail to raw base64 (strip the data: prefix).
      const source = captureResult.source;
      const dataUrl =
        typeof source.thumbnail?.toDataURL === 'function'
          ? source.thumbnail.toDataURL()
          : source.dataUrl || source.thumbnail || '';
      const comma = dataUrl.indexOf(',');
      const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
      if (!base64) {
        return { success: false, message: 'I captured your screen but the image was empty.' };
      }

      // 3. Ask the vision model.
      const prompt = `User asked: "${task.content}". Answer concisely based on what is visible on the screen. If you cannot see what the user is asking about, say so plainly.`;
      let answer;
      try {
        answer = await this._deps.visionAnswer(base64, prompt);
      } catch (err) {
        log.error('agent', '[screen-vision] vision call failed', { error: err.message });
        return { success: false, message: 'Vision analysis failed. Try again in a moment.' };
      }

      if (!answer || typeof answer !== 'string') {
        return { success: false, message: 'No answer from the vision model.' };
      }
      return { success: true, message: answer.trim() };
    } catch (err) {
      log.error('agent', '[screen-vision] execute error', { error: err.message });
      return { success: false, message: err.message || 'Screen vision failed.' };
    }
  },
};

module.exports = screenVisionAgent;
