/**
 * Live Translate Agent
 *
 * Voice-controlled live translation. Wins on intents like:
 *   - "Translate what I'm saying to Spanish"
 *   - "Start live translation from French to English"
 *   - "Stop translating"
 *   - "Switch translation to German"
 *
 * On execute(), classifies start vs stop vs switch via the fast LLM, then
 * calls into lib/live-translate-service to open or close the dedicated
 * `/v1/realtime/translations` WebSocket session. Translated captions are
 * pushed to any subscribers (recorder window, future caption surfaces).
 *
 * Note: this agent only controls the session lifecycle. The recorder
 * (and any other UI) subscribes to the service directly for caption
 * events.
 */

const { getAgentMemory } = require('../../lib/agent-memory-store');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

const _defaultDeps = {
  aiJson: async (...args) => {
    const { getAIService } = require('../../lib/ai-service');
    return getAIService().json(...args);
  },
  service: () => {
    const svc = require('../../lib/live-translate-service');
    return svc.getLiveTranslateService();
  },
};

const liveTranslateAgent = {
  id: 'live-translate-agent',
  name: 'Live Translate Agent',
  description: 'Starts and stops live speech translation between languages',
  voice: 'sage',
  acks: ['Setting up translation.'],
  categories: ['system', 'translation', 'language'],
  keywords: ['translate', 'translation', 'language', 'interpret', 'subtitle'],
  executionType: 'action',
  estimatedExecutionMs: 1500,

  prompt: `Live Translate Agent starts and stops live speech translation between languages.

HIGH confidence (this agent wins):
- "Translate what I'm saying to Spanish" / "translate this meeting to English"
- "Start live translation from French to English"
- "Stop translating" / "end translation" / "turn off live translate"
- "Switch translation to German" / "translate to Japanese now"

LOW confidence (other agents win):
- "How do you say hello in French?" -- single-shot phrase lookup, smalltalk-agent
- "Translate this document" -- file-based, smart-export or similar
- "What does this Spanish word mean?" -- vocabulary lookup, not live session

The agent only controls the session lifecycle. Captions appear in the
recorder window and any other UI subscribed to the translation service.`,

  memory: null,
  _deps: _defaultDeps,

  __setDeps(deps) {
    this._deps = { ..._defaultDeps, ...(deps || {}) };
  },

  __resetDeps() {
    this._deps = _defaultDeps;
  },

  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory('live-translate-agent', { displayName: 'Live Translate Agent' });
      await this.memory.load();
    }
    return this.memory;
  },

  async execute(task) {
    try {
      if (!this.memory) await this.initialize();

      const service = this._deps.service();
      if (!service) {
        return { success: false, message: 'Translation service unavailable.' };
      }

      const classifyPrompt = `Classify the user's request and extract the language(s). Respond with strict JSON only.

User said: "${task.content}"

Schema:
{
  "action": "start" | "stop" | "switch" | "status" | "unknown",
  "sourceLang": "<ISO 639-1 code or 'auto'>" | null,
  "targetLang": "<ISO 639-1 code>" | null,
  "reason": "<short>"
}

Examples:
- "translate to Spanish" -> { "action": "start", "sourceLang": "auto", "targetLang": "es" }
- "stop translating" -> { "action": "stop" }
- "switch translation to German" -> { "action": "switch", "sourceLang": "auto", "targetLang": "de" }
- "translate French to English" -> { "action": "start", "sourceLang": "fr", "targetLang": "en" }`;

      const parsed = await this._deps.aiJson(classifyPrompt, {
        profile: 'fast',
        feature: 'live-translate-agent.classify',
        maxTokens: 200,
      });

      const action = parsed && parsed.action;

      if (action === 'stop') {
        service.stop();
        return { success: true, message: 'Live translation stopped.' };
      }

      if (action === 'status') {
        const s = service.getStatus();
        if (!s.active) return { success: true, message: 'Live translation is off.' };
        const from = s.sourceLang || 'auto';
        return {
          success: true,
          message: `Translating from ${from} to ${s.targetLang}.`,
        };
      }

      if (action === 'start' || action === 'switch') {
        const targetLang = parsed.targetLang;
        if (!targetLang) {
          return { success: false, message: 'Which language should I translate to?' };
        }
        const sourceLang = parsed.sourceLang || 'auto';

        // Switch is just stop+start so the target language updates.
        if (action === 'switch' && service.isActive()) {
          service.stop();
        }

        const result = await service.start({ sourceLang, targetLang });
        if (!result.success) {
          return result;
        }
        const from = sourceLang === 'auto' ? 'speech' : sourceLang;
        return {
          success: true,
          message: `Live translation started. Speak ${from} and I will show ${targetLang} captions.`,
        };
      }

      return {
        success: false,
        message: parsed?.reason || 'I am not sure what translation action you meant.',
      };
    } catch (err) {
      log.error('agent', '[live-translate] execute error', { error: err.message });
      return { success: false, message: err.message || 'Translation control failed.' };
    }
  },
};

module.exports = liveTranslateAgent;
