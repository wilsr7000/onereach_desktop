/**
 * Sound Effects Agent -- plays sound effects and manages ambient soundscapes.
 *
 * Explicit use: "play a drumroll", "fanfare", "make it sound like rain"
 * Ambient control: "set the mood for focus", "cafe atmosphere", "stop ambient"
 * Custom SFX: "play the sound of a spaceship taking off" (ElevenLabs generation)
 *
 * Synthesized sounds (Web Audio) are dispatched to the orb renderer via soundCue.
 * ElevenLabs-generated SFX are cached by prompt hash and sent as base64 audio.
 */

const BaseAgent = require('./base-agent');
const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

const SYNTH_SOUNDS = [
  'morning-motif', 'meeting-chime', 'streak-ding', 'whoosh', 'rain-light',
  'rain-heavy', 'memory-warm', 'transition', 'alert-chime', 'focus-start',
  'brief-complete',
];

const AMBIENT_SCENES = [
  'rain-light', 'rain-heavy', 'cafe', 'focus', 'nature', 'night', 'morning',
];

module.exports = BaseAgent.create({
  id: 'sound-effects-agent',
  name: 'Sound Designer',
  description: 'Plays sound effects, manages ambient soundscapes, and adds atmospheric audio to the orb experience',

  prompt: `Sound Designer plays sound effects and manages ambient atmosphere for the voice orb.

HIGH CONFIDENCE (0.85+):
- Explicit SFX: "play a drumroll", "sound effect: tada", "fanfare", "play a whoosh"
- Ambient scenes: "make it sound like a cafe", "rain sounds", "set the mood for focus"
- Atmosphere: "ambient sounds on", "set the atmosphere", "background sounds"
- Stop: "stop the ambient", "turn off background sounds", "silence"
- Custom SFX: "play the sound of a spaceship", "make the sound of thunder"

MEDIUM CONFIDENCE (0.5-0.7):
- Mood setting (overlaps with DJ): "set the mood" (Sound Designer handles atmosphere, DJ handles music)
- "I need to focus" (might want focus ambient OR focus music)

LOW CONFIDENCE (0.0-0.2):
- Music requests (DJ Agent handles those)
- Voice/TTS requests
- Informational queries about sounds
- Recording requests (Recorder Agent)

This agent controls the orb's sound layers: synthesized tones, ambient textures (rain, cafe, focus, nature, night, morning), and one-shot sound effects. It can also generate custom sound effects using ElevenLabs when the user asks for something not in the built-in library.`,

  capabilities: [
    'Play synthesized sound effects (whoosh, chime, fanfare, etc.)',
    'Generate custom sound effects from text descriptions',
    'Set ambient soundscapes (rain, cafe, nature, focus, night, morning)',
    'Temporarily blend atmospheric sounds',
    'Control ambient volume and settings',
  ],

  categories: ['media', 'entertainment', 'mood', 'ambient'],
  keywords: [
    'sound effect', 'sfx', 'ambient', 'atmosphere', 'soundscape',
    'drumroll', 'fanfare', 'whoosh', 'chime', 'rain sounds',
    'cafe sounds', 'focus sounds', 'nature sounds', 'background sounds',
    'set the mood', 'atmosphere', 'ambient on', 'ambient off',
  ],

  voice: 'shimmer',
  acks: ['On it.', 'Setting the scene.', 'Got it.'],

  executionType: 'action',

  async onExecute(task) {
    const request = (task.content || '').trim();
    if (!request) {
      return { success: false, message: 'What sound would you like?' };
    }

    const classification = await this._classifyRequest(request);
    log.info('agent', 'Sound request classified', { action: classification.action, sound: classification.sound });

    switch (classification.action) {
      case 'ambient-start':
        return this._startAmbient(classification.scene, classification.message);

      case 'ambient-stop':
        return {
          success: true,
          message: classification.message || 'Ambient stopped.',
          soundCue: { type: 'ambient-stop' },
        };

      case 'play-synth':
        return {
          success: true,
          message: classification.message || 'Here you go.',
          soundCue: {
            type: 'one-shot',
            name: classification.sound,
            volume: classification.volume || 0.5,
          },
        };

      case 'generate-sfx':
        return this._generateCustomSfx(classification.prompt, classification.message);

      default:
        return { success: false, message: "I'm not sure what sound you want. Try something like 'play a drumroll' or 'set the mood for focus'." };
    }
  },

  async _classifyRequest(request) {
    const result = await ai.chat({
      profile: 'fast',
      system: `You classify sound/ambient requests. Return JSON only.

AVAILABLE SYNTHESIZED SOUNDS: ${SYNTH_SOUNDS.join(', ')}
AVAILABLE AMBIENT SCENES: ${AMBIENT_SCENES.join(', ')}

Return one of:
1. Ambient start: {"action":"ambient-start","scene":"<scene-name>","message":"brief response"}
2. Ambient stop: {"action":"ambient-stop","message":"brief response"}
3. Play built-in sound: {"action":"play-synth","sound":"<sound-name>","volume":0.5,"message":"brief response"}
4. Generate custom SFX: {"action":"generate-sfx","prompt":"<description for AI SFX generator>","message":"brief response"}

MAPPING HINTS:
- "drumroll" / "fanfare" / "tada" → generate-sfx (not in synth library)
- "whoosh" / "chime" / "ding" → play-synth
- "rain" / "cafe" / "focus" / "nature" / "night" → ambient-start
- "stop" / "silence" / "off" → ambient-stop
- "sound of X" / "make it sound like X" → generate-sfx if not an ambient scene
- For ambient scenes, match to closest: rain-light, rain-heavy, cafe, focus, nature, night, morning
- When user says "set the mood for focus/work/studying" → ambient-start with "focus"
- When user says "rain sounds" → ambient-start with "rain-light"

Keep messages brief and warm -- 3-8 words.`,
      messages: [{ role: 'user', content: request }],
      temperature: 0.3,
      maxTokens: 150,
      jsonMode: true,
      feature: 'sound-effects-agent',
    });

    try {
      return JSON.parse(result.content);
    } catch (_) {
      log.warn('agent', 'Failed to parse sound classification', { raw: result.content });
      return { action: 'unknown' };
    }
  },

  _startAmbient(scene, message) {
    if (!AMBIENT_SCENES.includes(scene)) {
      const closest = AMBIENT_SCENES.find((s) => scene && s.includes(scene)) || 'nature';
      scene = closest;
    }
    return {
      success: true,
      message: message || `${scene} ambient started.`,
      soundCue: {
        type: 'ambient-blend',
        name: scene,
        volume: 0.3,
      },
    };
  },

  async _generateCustomSfx(prompt, message) {
    try {
      const ElevenLabsService = require('../../src/video/audio/ElevenLabsService');
      const service = new ElevenLabsService();

      const apiKey = service.getApiKey();
      if (!apiKey) {
        return {
          success: true,
          message: 'I can play built-in sounds, but custom sound generation needs an ElevenLabs API key in Settings.',
          soundCue: { type: 'one-shot', name: 'alert-chime', volume: 0.4 },
        };
      }

      const outputPath = await service.generateSoundEffect(prompt, {
        durationSeconds: 3,
        promptInfluence: 0.7,
      });

      const fs = require('fs');
      const audioData = fs.readFileSync(outputPath);
      const base64 = audioData.toString('base64');

      const cacheKey = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);

      return {
        success: true,
        message: message || 'Here it is.',
        soundCue: {
          type: 'generated-sfx',
          name: cacheKey,
          base64,
          volume: 0.5,
        },
      };
    } catch (err) {
      log.error('agent', 'Custom SFX generation failed', { error: err.message });
      return {
        success: false,
        message: `I couldn't generate that sound: ${err.message}`,
      };
    }
  },
});
