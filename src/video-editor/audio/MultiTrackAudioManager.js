/**
 * MultiTrackAudioManager - Handles multi-track audio playback synchronized with video
 * 
 * Features:
 * - Independent audio buffers per track
 * - Synchronized playback with video element
 * - Per-track volume, mute, and solo controls
 * - Seamless seeking across all tracks
 */

// Cross-platform helper to convert file path to file:// URL
function pathToFileUrl(filePath) {
  if (!filePath) return '';
  if (filePath.startsWith('file://') || filePath.startsWith('data:')) return filePath;
  let normalized = filePath.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(normalized)) normalized = '/' + normalized;
  const encoded = normalized.split('/').map(c => encodeURIComponent(c).replace(/%3A/g, ':')).join('/');
  return 'file://' + encoded;
}

export class MultiTrackAudioManager {
  constructor(appContext) {
    this.app = appContext;
    
    // Web Audio API context (shared)
    this.audioContext = null;
    this.masterGain = null;
    
    // Track audio state: { trackId: { buffer, source, gain, muted, solo, volume } }
    this.trackAudio = new Map();
    
    // Playback state
    this.isPlaying = false;
    this.lastSeekTime = 0;
    
    // Reference to video element
    this.videoElement = null;
    
    console.log('[MultiTrackAudio] Manager initialized');
  }

  /**
   * Initialize the audio context (must be called after user interaction)
   */
  async init() {
    if (this.audioContext) {
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      return;
    }
    
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    // Master gain node for overall volume
    this.masterGain = this.audioContext.createGain();
    this.masterGain.connect(this.audioContext.destination);
    
    // Get video element reference
    this.videoElement = document.getElementById('videoPlayer');
    
    // Set up video event listeners for sync
    this._setupVideoSync();
    
    console.log('[MultiTrackAudio] Audio context initialized');
  }

  /**
   * Set up synchronization with video element
   */
  _setupVideoSync() {
    if (!this.videoElement) return;
    
    // Store original muted state
    this._originalVideoMuted = this.videoElement.muted;
    this._multiTrackActive = false;
    
    // Sync on play
    this.videoElement.addEventListener('play', () => {
      // Only use multi-track if we have loaded tracks
      if (this.trackAudio.size > 0) {
        this._enableMultiTrack();
        this.startAllTracks(this.videoElement.currentTime);
      }
    });
    
    // Sync on pause
    this.videoElement.addEventListener('pause', () => {
      this.stopAllTracks();
    });
    
    // Sync on seek
    this.videoElement.addEventListener('seeked', () => {
      if (this.isPlaying && this._multiTrackActive) {
        this.stopAllTracks();
        this.startAllTracks(this.videoElement.currentTime);
      }
    });
    
    // Handle video ended
    this.videoElement.addEventListener('ended', () => {
      this.stopAllTracks();
    });
    
    console.log('[MultiTrackAudio] Video sync listeners attached');
  }
  
  /**
   * Enable multi-track mode (mutes video's native audio)
   */
  _enableMultiTrack() {
    if (!this._multiTrackActive && this.videoElement) {
      this._originalVideoMuted = this.videoElement.muted;
      this.videoElement.muted = true;
      this._multiTrackActive = true;
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'MultiTrackAudioManager.js:_enableMultiTrack',message:'Multi-track enabled - VIDEO MUTED',data:{originalMuted:this._originalVideoMuted,videoNowMuted:true,trackCount:this.trackAudio.size},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1-H3'})}).catch(()=>{});
      // #endregion
      console.log('[MultiTrackAudio] Multi-track mode enabled, video native audio muted');
    }
  }
  
  /**
   * Disable multi-track mode (restores video's native audio)
   */
  _disableMultiTrack() {
    if (this._multiTrackActive && this.videoElement) {
      this.videoElement.muted = this._originalVideoMuted || false;
      this._multiTrackActive = false;
      console.log('[MultiTrackAudio] Multi-track mode disabled, video native audio restored');
    }
  }
  
  /**
   * Check if multi-track playback is active
   */
  isActive() {
    return this._multiTrackActive && this.trackAudio.size > 0;
  }
  
  /**
   * Restore video's native audio (when multi-track is disabled)
   */
  restoreVideoAudio() {
    this._disableMultiTrack();
  }

  /**
   * Load audio for a track from a file path or the video source
   * @param {string} trackId - Track identifier
   * @param {string} audioSource - Path to audio file, or null to use video audio
   * @param {object} options - { volume, muted, solo }
   */
  async loadTrackAudio(trackId, audioSource = null, options = {}) {
    await this.init();
    
    const { volume = 1.0, muted = false, solo = false } = options;
    
    try {
      let audioBuffer;
      
      if (audioSource) {
        // Load from file path
        audioBuffer = await this._loadAudioFromFile(audioSource);
      } else if (this.videoElement?.src) {
        // Use video's audio - check if we already have it cached
        if (this.app.audioBuffer) {
          audioBuffer = this.app.audioBuffer;
          console.log('[MultiTrackAudio] Using cached video audio buffer for track:', trackId);
        } else {
          audioBuffer = await this._loadAudioFromVideo();
          // Cache it for other tracks
          this.app.audioBuffer = audioBuffer;
        }
      } else {
        throw new Error('No audio source available');
      }
      
      // Create gain node for this track
      const trackGain = this.audioContext.createGain();
      trackGain.gain.value = muted ? 0 : volume;
      trackGain.connect(this.masterGain);
      
      // Store track audio data
      this.trackAudio.set(trackId, {
        buffer: audioBuffer,
        source: null, // Created on play
        gain: trackGain,
        volume: volume,
        muted: muted,
        solo: solo
      });
      
      console.log('[MultiTrackAudio] Loaded audio for track:', trackId, {
        duration: audioBuffer.duration.toFixed(2) + 's',
        channels: audioBuffer.numberOfChannels
      });
      
      return true;
      
    } catch (error) {
      console.error('[MultiTrackAudio] Failed to load audio for track:', trackId, error);
      return false;
    }
  }

  /**
   * Load audio buffer from a file path
   * For long videos (>10min), uses chunked loading for better performance
   */
  async _loadAudioFromFile(filePath) {
    const response = await fetch(pathToFileUrl(filePath));
    if (!response.ok) throw new Error('Failed to fetch audio file');
    
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
    
    // Check if we should use chunked loading for long audio
    const CHUNK_THRESHOLD = 600; // 10 minutes
    if (audioBuffer.duration > CHUNK_THRESHOLD) {
      console.log('[MultiTrackAudio] Long audio detected, enabling chunked mode:', audioBuffer.duration.toFixed(0) + 's');
      // Store full buffer but flag for chunked playback
      this._useChunkedPlayback = true;
      this._chunkDuration = 120; // 2 minute chunks
    }
    
    return audioBuffer;
  }

  /**
   * Load audio buffer from the video element
   */
  async _loadAudioFromVideo() {
    if (!this.videoElement?.src) throw new Error('No video source');
    
    const response = await fetch(this.videoElement.src);
    if (!response.ok) throw new Error('Failed to fetch video');
    
    const arrayBuffer = await response.arrayBuffer();
    return await this.audioContext.decodeAudioData(arrayBuffer);
  }
  
  /**
   * Load audio buffer for a specific time range (for chunked loading)
   * @param {string} filePath - Audio file path
   * @param {number} startTime - Start time in seconds
   * @param {number} duration - Duration in seconds
   */
  async _loadAudioRange(filePath, startTime, duration) {
    // For now, we load the full buffer and slice it
    // Future optimization: use FFmpeg to extract range server-side
    const fullBuffer = await this._loadAudioFromFile(filePath);
    
    const sampleRate = fullBuffer.sampleRate;
    const startSample = Math.floor(startTime * sampleRate);
    const numSamples = Math.floor(duration * sampleRate);
    const endSample = Math.min(startSample + numSamples, fullBuffer.length);
    
    // Create a new buffer for the range
    const rangeBuffer = this.audioContext.createBuffer(
      fullBuffer.numberOfChannels,
      endSample - startSample,
      sampleRate
    );
    
    // Copy channel data
    for (let channel = 0; channel < fullBuffer.numberOfChannels; channel++) {
      const sourceData = fullBuffer.getChannelData(channel);
      const destData = rangeBuffer.getChannelData(channel);
      for (let i = 0; i < destData.length; i++) {
        destData[i] = sourceData[startSample + i];
      }
    }
    
    return rangeBuffer;
  }
  
  /**
   * Preload adjacent audio chunks for smooth playback
   * @param {string} trackId - Track identifier
   * @param {number} currentTime - Current playback time
   */
  async preloadAdjacentChunks(trackId, currentTime) {
    const trackData = this.trackAudio.get(trackId);
    if (!trackData || !trackData.audioPath || !this._useChunkedPlayback) return;
    
    const chunkDuration = this._chunkDuration || 120;
    const preloadAhead = chunkDuration * 0.5; // Preload when 50% through current chunk
    
    const currentChunkStart = Math.floor(currentTime / chunkDuration) * chunkDuration;
    const nextChunkStart = currentChunkStart + chunkDuration;
    
    // Check if we're close to the next chunk and it's not loaded
    if (currentTime > currentChunkStart + preloadAhead) {
      const cacheKey = `${trackId}-${nextChunkStart}`;
      if (!this._chunkCache?.has(cacheKey)) {
        console.log('[MultiTrackAudio] Preloading next chunk:', nextChunkStart);
        // Preload in background (non-blocking)
        this._loadAudioRange(trackData.audioPath, nextChunkStart, chunkDuration)
          .then(buffer => {
            if (!this._chunkCache) this._chunkCache = new Map();
            this._chunkCache.set(cacheKey, buffer);
          })
          .catch(err => console.warn('[MultiTrackAudio] Chunk preload failed:', err));
      }
    }
  }

  /**
   * Create a gain envelope for a clip (handles fade in/out and crossfades)
   * @param {object} clip - Clip with fadeIn, fadeOut, gain properties
   * @param {number} clipDuration - Duration of the clip in seconds
   * @returns {GainNode} Configured gain node with envelope
   */
  createClipEnvelope(clip, clipDuration) {
    const gain = this.audioContext.createGain();
    const now = this.audioContext.currentTime;
    
    const fadeIn = clip.fadeIn || 0;
    const fadeOut = clip.fadeOut || 0;
    const clipGain = clip.gain ?? 1.0;
    
    // Set initial gain (0 if fading in, else clip gain)
    if (fadeIn > 0) {
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(clipGain, now + fadeIn);
    } else {
      gain.gain.setValueAtTime(clipGain, now);
    }
    
    // Schedule fade out
    if (fadeOut > 0) {
      const fadeStart = now + clipDuration - fadeOut;
      gain.gain.setValueAtTime(clipGain, fadeStart);
      gain.gain.linearRampToValueAtTime(0, fadeStart + fadeOut);
    }
    
    return gain;
  }
  
  /**
   * Play a clip with optional crossfade envelope
   * @param {object} clip - Clip object with sourceIn, sourceOut, fadeIn, fadeOut
   * @param {GainNode} trackGain - Track's gain node
   * @param {number} scheduleTime - When to start (audioContext.currentTime)
   * @returns {AudioBufferSourceNode} The source node
   */
  playClip(clip, trackGain, scheduleTime = 0) {
    const source = this.audioContext.createBufferSource();
    source.buffer = this.audioBuffer;
    
    const duration = (clip.sourceOut ?? 0) - (clip.sourceIn ?? 0);
    
    // Create envelope if clip has fades
    if (clip.fadeIn > 0 || clip.fadeOut > 0 || clip.gain !== undefined) {
      const envelope = this.createClipEnvelope(clip, duration);
      source.connect(envelope);
      envelope.connect(trackGain);
    } else {
      source.connect(trackGain);
    }
    
    // Start the clip at the specified time
    const offset = clip.sourceIn ?? 0;
    source.start(scheduleTime, offset, duration);
    
    return source;
  }

  /**
   * Start playback for all tracks from a specific time
   * @param {number} startTime - Time in seconds to start from
   */
  startAllTracks(startTime = 0) {
    this.isPlaying = true;
    this.lastSeekTime = startTime;
    
    // Update solo state before starting
    this._updateSoloState();
    
    this.trackAudio.forEach((trackData, trackId) => {
      this._startTrack(trackId, trackData, startTime);
    });
    
    console.log('[MultiTrackAudio] Started all tracks at:', startTime.toFixed(2) + 's');
  }

  /**
   * Start a single track
   */
  _startTrack(trackId, trackData, startTime) {
    // Stop any existing source
    if (trackData.source) {
      try {
        trackData.source.stop();
      } catch (e) {
        // Ignore - source may already be stopped
      }
    }
    
    // Don't play if no buffer
    if (!trackData.buffer) return;
    
    // Create new source
    const source = this.audioContext.createBufferSource();
    source.buffer = trackData.buffer;
    source.connect(trackData.gain);
    
    // Start from the specified time
    const safeStart = Math.max(0, Math.min(startTime, trackData.buffer.duration - 0.01));
    source.start(0, safeStart);
    
    // Store reference
    trackData.source = source;
  }

  /**
   * Stop playback for all tracks
   */
  stopAllTracks() {
    this.isPlaying = false;
    
    this.trackAudio.forEach((trackData, trackId) => {
      if (trackData.source) {
        try {
          trackData.source.stop();
        } catch (e) {
          // Ignore - source may already be stopped
        }
        trackData.source = null;
      }
    });
    
    console.log('[MultiTrackAudio] Stopped all tracks');
  }

  /**
   * Set volume for a track
   * @param {string} trackId - Track identifier
   * @param {number} volume - Volume level (0.0 to 1.0)
   */
  setTrackVolume(trackId, volume) {
    const trackData = this.trackAudio.get(trackId);
    if (!trackData) return;
    
    trackData.volume = volume;
    
    // Apply volume if not muted
    if (!trackData.muted && !this._isTrackSilencedBySolo(trackId)) {
      trackData.gain.gain.value = volume;
    }
    
    console.log('[MultiTrackAudio] Set volume for track:', trackId, volume);
  }

  /**
   * Toggle mute for a track
   * @param {string} trackId - Track identifier
   * @returns {boolean} New muted state
   */
  toggleTrackMute(trackId) {
    const trackData = this.trackAudio.get(trackId);
    if (!trackData) return false;
    
    trackData.muted = !trackData.muted;
    
    // Update gain
    this._updateTrackGain(trackId, trackData);
    
    console.log('[MultiTrackAudio] Toggle mute for track:', trackId, trackData.muted);
    return trackData.muted;
  }

  /**
   * Set mute state for a track
   */
  setTrackMute(trackId, muted) {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'MultiTrackAudioManager.js:setTrackMute',message:'setTrackMute called',data:{trackId,muted,hasTrackData:this.trackAudio.has(trackId),videoMuted:this.videoElement?.muted,multiTrackActive:this._multiTrackActive},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1-H3'})}).catch(()=>{});
    // #endregion
    const trackData = this.trackAudio.get(trackId);
    if (!trackData) {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'MultiTrackAudioManager.js:setTrackMute:noTrackData',message:'Track not found in manager',data:{trackId,availableTrackIds:[...this.trackAudio.keys()]},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1'})}).catch(()=>{});
      // #endregion
      return;
    }

    trackData.muted = muted;
    this._updateTrackGain(trackId, trackData);
  }

  /**
   * Toggle solo for a track
   * @param {string} trackId - Track identifier
   * @returns {boolean} New solo state
   */
  toggleTrackSolo(trackId) {
    const trackData = this.trackAudio.get(trackId);
    if (!trackData) return false;
    
    trackData.solo = !trackData.solo;
    
    // Update all track gains (solo affects other tracks)
    this._updateSoloState();
    
    console.log('[MultiTrackAudio] Toggle solo for track:', trackId, trackData.solo);
    return trackData.solo;
  }

  /**
   * Update gain for a single track
   */
  _updateTrackGain(trackId, trackData) {
    const silencedBySolo = this._isTrackSilencedBySolo(trackId);
    const shouldMute = trackData.muted || silencedBySolo;
    const previousGain = trackData.gain?.gain?.value;
    
    if (shouldMute) {
      trackData.gain.gain.value = 0;
    } else {
      trackData.gain.gain.value = trackData.volume;
    }
  }

  /**
   * Check if any track has solo enabled
   */
  _hasSoloTracks() {
    for (const [, trackData] of this.trackAudio) {
      if (trackData.solo) return true;
    }
    return false;
  }

  /**
   * Check if a track should be silenced due to other tracks being soloed
   */
  _isTrackSilencedBySolo(trackId) {
    if (!this._hasSoloTracks()) return false;
    
    const trackData = this.trackAudio.get(trackId);
    return trackData && !trackData.solo;
  }

  /**
   * Update all track gains based on solo state
   */
  _updateSoloState() {
    this.trackAudio.forEach((trackData, trackId) => {
      this._updateTrackGain(trackId, trackData);
    });
  }

  /**
   * Remove a track from the audio manager
   * @param {string} trackId - Track identifier
   */
  removeTrack(trackId) {
    const trackData = this.trackAudio.get(trackId);
    if (!trackData) return;
    
    // Stop playback
    if (trackData.source) {
      try {
        trackData.source.stop();
      } catch (e) {}
    }
    
    // Disconnect gain node
    if (trackData.gain) {
      trackData.gain.disconnect();
    }
    
    this.trackAudio.delete(trackId);
    console.log('[MultiTrackAudio] Removed track:', trackId);
  }

  /**
   * Get current state of a track
   */
  getTrackState(trackId) {
    const trackData = this.trackAudio.get(trackId);
    if (!trackData) return null;
    
    return {
      volume: trackData.volume,
      muted: trackData.muted,
      solo: trackData.solo,
      hasAudio: !!trackData.buffer
    };
  }

  /**
   * Load track audio directly from a file path
   * Convenience method for the Guide + Master architecture
   * @param {string} trackId - Track identifier (e.g., 'master')
   * @param {string} filePath - Path to the audio file
   * @param {object} options - { volume, muted, solo }
   */
  async loadTrackFromFile(trackId, filePath, options = {}) {
    if (!filePath) {
      console.warn('[MultiTrackAudio] loadTrackFromFile called without filePath');
      return false;
    }
    
    console.log('[MultiTrackAudio] Loading track from file:', trackId, filePath);
    
    try {
      return await this.loadTrackAudio(trackId, filePath, options);
    } catch (error) {
      console.error('[MultiTrackAudio] Failed to load track from file:', trackId, error);
      return false;
    }
  }
  
  /**
   * Render mixed audio from all tracks using OfflineAudioContext
   * @param {Array} tracks - Array of track objects with clips
   * @param {number} duration - Total duration in seconds
   * @param {AudioBuffer} sourceBuffer - Source audio buffer
   * @returns {Promise<AudioBuffer>} Rendered audio buffer
   */
  async renderMixedAudio(tracks, duration, sourceBuffer) {
    if (!tracks || tracks.length === 0) {
      throw new Error('No tracks to render');
    }
    
    const sampleRate = sourceBuffer?.sampleRate || 44100;
    const channels = sourceBuffer?.numberOfChannels || 2;
    
    // Create offline context for rendering
    const offlineCtx = new OfflineAudioContext(
      channels,
      Math.ceil(sampleRate * duration),
      sampleRate
    );
    
    console.log('[MultiTrackAudio] Starting offline render:', {
      duration: duration.toFixed(2) + 's',
      tracks: tracks.length,
      sampleRate,
      channels
    });
    
    // Render each track
    for (const track of tracks) {
      // Skip guide track (uses video's embedded audio)
      if (track.type === 'guide') continue;
      
      // Skip muted tracks
      if (track.muted) continue;
      
      // Get track buffer
      const trackData = this.trackAudio.get(track.id);
      const buffer = trackData?.buffer || sourceBuffer;
      if (!buffer) continue;
      
      // Create track gain
      const trackGain = offlineCtx.createGain();
      trackGain.gain.value = track.volume ?? 1.0;
      trackGain.connect(offlineCtx.destination);
      
      // Render each clip in the track
      const clips = track.clips || [{ sourceIn: 0, sourceOut: duration, timelineStart: 0 }];
      
      for (const clip of clips) {
        const source = offlineCtx.createBufferSource();
        source.buffer = buffer;
        
        const clipDuration = (clip.sourceOut ?? duration) - (clip.sourceIn ?? 0);
        
        // Apply clip envelope if fades are present
        if (clip.fadeIn > 0 || clip.fadeOut > 0) {
          const envelope = offlineCtx.createGain();
          const startTime = clip.timelineStart ?? 0;
          
          // Fade in
          if (clip.fadeIn > 0) {
            envelope.gain.setValueAtTime(0, startTime);
            envelope.gain.linearRampToValueAtTime(clip.gain ?? 1.0, startTime + clip.fadeIn);
          } else {
            envelope.gain.setValueAtTime(clip.gain ?? 1.0, startTime);
          }
          
          // Fade out
          if (clip.fadeOut > 0) {
            const fadeStart = startTime + clipDuration - clip.fadeOut;
            envelope.gain.setValueAtTime(clip.gain ?? 1.0, fadeStart);
            envelope.gain.linearRampToValueAtTime(0, fadeStart + clip.fadeOut);
          }
          
          source.connect(envelope);
          envelope.connect(trackGain);
        } else {
          // Apply clip gain directly if no fades
          if (clip.gain !== undefined && clip.gain !== 1.0) {
            const clipGain = offlineCtx.createGain();
            clipGain.gain.value = clip.gain;
            source.connect(clipGain);
            clipGain.connect(trackGain);
          } else {
            source.connect(trackGain);
          }
        }
        
        // Schedule clip playback
        source.start(clip.timelineStart ?? 0, clip.sourceIn ?? 0, clipDuration);
      }
    }
    
    // Render to buffer
    const renderedBuffer = await offlineCtx.startRendering();
    console.log('[MultiTrackAudio] Offline render complete:', renderedBuffer.duration.toFixed(2) + 's');
    
    return renderedBuffer;
  }
  
  /**
   * Export audio buffer to a WAV file (returns array buffer)
   * @param {AudioBuffer} buffer - Audio buffer to export
   * @returns {ArrayBuffer} WAV file data
   */
  audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const length = buffer.length;
    const bytesPerSample = 2; // 16-bit
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = length * blockAlign;
    const headerSize = 44;
    const totalSize = headerSize + dataSize;
    
    const arrayBuffer = new ArrayBuffer(totalSize);
    const view = new DataView(arrayBuffer);
    
    // RIFF header
    this._writeString(view, 0, 'RIFF');
    view.setUint32(4, totalSize - 8, true);
    this._writeString(view, 8, 'WAVE');
    
    // fmt chunk
    this._writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // chunk size
    view.setUint16(20, 1, true); // PCM format
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bytesPerSample * 8, true);
    
    // data chunk
    this._writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);
    
    // Interleave channels and convert to 16-bit
    const channelData = [];
    for (let ch = 0; ch < numChannels; ch++) {
      channelData.push(buffer.getChannelData(ch));
    }
    
    let offset = 44;
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = Math.max(-1, Math.min(1, channelData[ch][i]));
        const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        view.setInt16(offset, intSample, true);
        offset += 2;
      }
    }
    
    return arrayBuffer;
  }
  
  _writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }
  
  /**
   * Clean up all resources
   */
  dispose() {
    this.stopAllTracks();
    
    // Restore video's native audio
    this._disableMultiTrack();
    
    this.trackAudio.forEach((trackData, trackId) => {
      if (trackData.gain) {
        trackData.gain.disconnect();
      }
    });
    
    this.trackAudio.clear();
    
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    
    console.log('[MultiTrackAudio] Disposed');
  }
  
  /**
   * Get the number of loaded tracks
   */
  getTrackCount() {
    return this.trackAudio.size;
  }
}











