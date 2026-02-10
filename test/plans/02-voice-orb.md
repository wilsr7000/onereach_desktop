# Voice Orb Test Plan

## Prerequisites

- App running (`npm start`)
- Voice Orb enabled in Settings (`voiceOrbEnabled: true`)
- Microphone available (for voice tests)
- ElevenLabs API key configured (for TTS fallback tests)

## Features Documentation

The Voice Orb (`orb.html`) is a floating always-on-top window that provides voice input, text chat, and task submission. It uses Realtime Speech API for voice input, the Voice Task SDK for intent classification and task routing, and supports text-to-speech via OpenAI Realtime or ElevenLabs. The orb integrates with the Command HUD for displaying task results and the Agent Composer for relaying voice commands.

**Key files:** `orb.html`, `preload-orb.js`, `realtime-speech.js`, `voice-listener.js`, `voice-speaker.js`
**Window:** Toggled via `global.toggleOrbWindow()` or Cmd+Shift+O
**APIs exposed:** `window.realtimeSpeech`, `window.voiceTask`, `window.tts`, `window.commandHUD`, `window.orbWindow`, `window.agentHUD`

## Checklist

### Window Lifecycle
- [ ] `[A]` Orb window toggles on via `global.toggleOrbWindow()` without errors
- [ ] `[A]` Orb window toggles off via second `global.toggleOrbWindow()` call
- [ ] `[A]` No error-level logs produced during orb open/close cycle
- [ ] `[M]` Orb appears as floating circle in bottom-right corner
- [ ] `[M]` Orb is always-on-top (stays above other windows)

### Positioning and Interaction
- [ ] `[M]` Drag orb to new position -- position persists after toggle off/on
- [ ] `[M]` Click-through works on transparent areas (clicks pass to desktop)
- [ ] `[M]` Click on orb itself registers (orb responds to click)

### Chat Panel
- [ ] `[M]` Click orb to expand chat panel (window resizes to 380x520)
- [ ] `[M]` Type text in chat input, submit -- text appears in chat history
- [ ] `[M]` Collapse chat panel -- window returns to small orb size

### Voice Input
- [ ] `[M]` Microphone permission prompt appears on first use
- [ ] `[M]` Speaking into mic shows transcription in real-time
- [ ] `[M]` Completed utterance submits to Voice Task SDK for classification

### Text-to-Speech
- [ ] `[M]` TTS response plays audio through speakers (after successful task)
- [ ] `[M]` ElevenLabs fallback works when OpenAI Realtime unavailable

## Automation Notes

- **Existing coverage:** `test/e2e/window-smoke.spec.js` (1 test: orb toggles without errors)
- **Gaps:** Position persistence, chat panel expand/collapse, voice and TTS (hardware-dependent)
- **Spec file:** Most items are `[M]` due to hardware (mic/speaker) and visual verification requirements
- **Potential automation:** Position save/restore could be tested via `electronApp.evaluate` checking stored position
