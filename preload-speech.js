/**
 * Shared Speech/Voice preload module
 * Provides: speechBridge, realtimeSpeech, micManager, voiceTTS
 *
 * Used by: preload.js, preload-spaces.js
 * Pattern: Same as preload-hud-api.js and preload-orb-control.js
 */

const { ipcRenderer } = require('electron');

/**
 * Returns the speechBridge API methods (ElevenLabs transcription)
 */
function getSpeechBridgeMethods() {
  return {
    isAvailable: () => ipcRenderer.invoke('speech:is-available'),
    transcribe: (options) => ipcRenderer.invoke('speech:transcribe', options),
    transcribeFile: (options) => ipcRenderer.invoke('speech:transcribe-file', options),
    getApiKey: () => ipcRenderer.invoke('speech:get-api-key'),
    blobToBase64: async (blob) => {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64 = reader.result.split(',')[1];
          resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    },
    requestMicPermission: () => ipcRenderer.invoke('speech:request-mic-permission'),
  };
}

/**
 * Returns the realtimeSpeech API methods (OpenAI Realtime API streaming)
 */
function getRealtimeSpeechMethods() {
  return {
    connect: () => ipcRenderer.invoke('realtime-speech:connect'),
    disconnect: () => ipcRenderer.invoke('realtime-speech:disconnect'),
    isConnected: () => ipcRenderer.invoke('realtime-speech:is-connected'),
    sendAudio: (base64Audio) => ipcRenderer.invoke('realtime-speech:send-audio', base64Audio),
    commit: () => ipcRenderer.invoke('realtime-speech:commit'),
    clear: () => ipcRenderer.invoke('realtime-speech:clear'),
    onEvent: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('realtime-speech:event', handler);
      return () => ipcRenderer.removeListener('realtime-speech:event', handler);
    },
    startStreaming: async function (onTranscript, _options = {}) {
      await ipcRenderer.invoke('speech:request-mic-permission');

      const connectResult = await this.connect();
      if (!connectResult.success) {
        throw new Error(connectResult.error || 'Failed to connect');
      }

      const removeListener = this.onEvent((event) => {
        if (event.type === 'transcript' || event.type === 'transcript_delta') {
          onTranscript(event.text, event.isFinal);
        }
      });

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 24000, echoCancellation: true, noiseSuppression: true },
      });

      const audioContext = new AudioContext({ sampleRate: 24000 });
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const sendAudio = this.sendAudio.bind(this);

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const int16Data = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        const uint8Array = new Uint8Array(int16Data.buffer);
        let binary = '';
        for (let i = 0; i < uint8Array.length; i++) {
          binary += String.fromCharCode(uint8Array[i]);
        }
        sendAudio(btoa(binary));
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
      console.log('[speech] Realtime speech streaming started');

      return {
        stop: async () => {
          processor.disconnect();
          source.disconnect();
          audioContext.close();
          stream.getTracks().forEach((t) => t.stop());
          removeListener();
          await this.disconnect();
          console.log('[speech] Realtime speech streaming stopped');
        },
      };
    },
  };
}

/**
 * Returns the micManager API methods (centralized mic access)
 * Each call creates an independent state -- call once per preload.
 */
function getMicManagerMethods() {
  const state = {
    stream: null,
    audioContext: null,
    source: null,
    processor: null,
    activeConsumer: null,
    acquiredAt: null,
  };

  const defaultConstraints = {
    channelCount: 1,
    sampleRate: 24000,
    echoCancellation: true,
    noiseSuppression: true,
  };

  return {
    acquire: async (consumerId, constraints = {}) => {
      if (state.stream && state.activeConsumer !== consumerId) {
        console.warn(`[MicManager] Mic in use by "${state.activeConsumer}", requested by "${consumerId}"`);
        return null;
      }
      if (state.stream && state.activeConsumer === consumerId) {
        console.log(`[MicManager] Mic already held by "${consumerId}"`);
        return { stream: state.stream, audioContext: state.audioContext };
      }

      try {
        const audioConstraints = { ...defaultConstraints, ...constraints };
        const sampleRate = audioConstraints.sampleRate || 24000;
        await ipcRenderer.invoke('speech:request-mic-permission');
        state.stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
        state.audioContext = new AudioContext({ sampleRate });
        state.activeConsumer = consumerId;
        state.acquiredAt = Date.now();
        console.log(`[MicManager] Mic acquired by "${consumerId}"`);
        return { stream: state.stream, audioContext: state.audioContext };
      } catch (error) {
        console.error('[MicManager] Failed to acquire mic:', error);
        throw error;
      }
    },

    release: async (consumerId) => {
      if (state.activeConsumer !== consumerId) {
        if (state.activeConsumer) {
          console.warn(`[MicManager] "${consumerId}" tried to release mic owned by "${state.activeConsumer}"`);
        }
        return;
      }
      if (state.processor) {
        state.processor.disconnect();
        state.processor = null;
      }
      if (state.source) {
        state.source.disconnect();
        state.source = null;
      }
      if (state.audioContext) {
        await state.audioContext.close();
        state.audioContext = null;
      }
      if (state.stream) {
        state.stream.getTracks().forEach((t) => t.stop());
        state.stream = null;
      }
      const duration = state.acquiredAt ? Date.now() - state.acquiredAt : 0;
      state.activeConsumer = null;
      state.acquiredAt = null;
      console.log(`[MicManager] Mic released by "${consumerId}" (held for ${duration}ms)`);
    },

    forceRelease: async () => {
      const consumer = state.activeConsumer || 'unknown';
      console.warn(`[MicManager] Force releasing mic (was held by "${consumer}")`);
      if (state.processor) state.processor.disconnect();
      if (state.source) state.source.disconnect();
      if (state.audioContext) await state.audioContext.close();
      if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
      state.processor = null;
      state.source = null;
      state.audioContext = null;
      state.stream = null;
      state.activeConsumer = null;
      state.acquiredAt = null;
    },

    isInUse: () => !!state.stream,
    getActiveConsumer: () => state.activeConsumer,
    getStatus: () => ({
      inUse: !!state.stream,
      consumer: state.activeConsumer,
      acquiredAt: state.acquiredAt,
      duration: state.acquiredAt ? Date.now() - state.acquiredAt : null,
    }),
  };
}

/**
 * Returns the voiceTTS API methods (ElevenLabs TTS)
 */
function getVoiceTTSMethods() {
  return {
    speak: (text, voice = 'Rachel') => ipcRenderer.invoke('voice:speak', text, voice),
    stop: () => ipcRenderer.invoke('voice:stop'),
    isAvailable: () => ipcRenderer.invoke('voice:is-available'),
    listVoices: () => ipcRenderer.invoke('voice:list-voices'),
  };
}

module.exports = {
  getSpeechBridgeMethods,
  getRealtimeSpeechMethods,
  getMicManagerMethods,
  getVoiceTTSMethods,
};
