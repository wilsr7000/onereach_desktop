/**
 * WaveformRenderer - Main waveform rendering orchestrator
 * Handles canvas setup, peak extraction, and drawing coordination
 */
import { WaveformCache } from './WaveformCache.js';
import { WaveformTypes } from './WaveformTypes.js';

// Cross-platform helper to convert file path to file:// URL
function pathToFileUrl(filePath) {
  if (!filePath) return '';
  if (filePath.startsWith('file://') || filePath.startsWith('data:')) return filePath;
  let normalized = filePath.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(normalized)) normalized = '/' + normalized;
  const encoded = normalized.split('/').map(c => encodeURIComponent(c).replace(/%3A/g, ':')).join('/');
  return 'file://' + encoded;
}

export class WaveformRenderer {
  constructor(appContext) {
    this.app = appContext;
    
    // Sub-modules
    this.cache = new WaveformCache(appContext);
    this.types = new WaveformTypes(appContext);
    
    // State
    this.type = 'spectrogram';  // 'bars', 'line', 'mirror', 'spectrogram'
    this.audioBuffer = null;
    this.audioContext = null;
    this.isAudioLoaded = false;
    
    // Tier definitions (samples per second for each zoom level)
    this.tierDefs = [
      { maxZoom: 1, samplesPerSec: 50 },
      { maxZoom: 2, samplesPerSec: 100 },
      { maxZoom: 5, samplesPerSec: 200 },
      { maxZoom: 10, samplesPerSec: 350 },
      { maxZoom: 20, samplesPerSec: 500 },
    ];
    
    // Loading animation
    this._loadingAnimation = null;
    this._regenerateTimeout = null;
  }

  /**
   * Get current waveform type
   */
  getType() {
    return this.type;
  }

  /**
   * Set waveform visualization type
   */
  setType(type) {
    this.type = type;
    
    // Update UI
    document.querySelectorAll('.waveform-option-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.type === type);
    });
    
    // Expand track for spectrogram
    const audioTrack = document.getElementById('audioTrackContainer');
    if (audioTrack) {
      audioTrack.classList.toggle('expanded', type === 'spectrogram');
    }
    
    // Regenerate waveform
    this.generate();
  }

  /**
   * Open waveform settings modal
   */
  openSettings() {
    const modal = document.getElementById('waveformSettingsModal');
    if (modal) {
      modal.style.display = 'flex';
      requestAnimationFrame(() => {
        modal.classList.add('visible');
      });
      document.querySelectorAll('.waveform-option-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.type === this.type);
      });
      modal.onclick = (e) => {
        if (e.target === modal) this.closeSettings();
      };
      window.logging.info('video', 'Waveform Settings modal opened');
    }
  }

  /**
   * Close waveform settings modal
   */
  closeSettings() {
    const modal = document.getElementById('waveformSettingsModal');
    if (modal) {
      modal.classList.remove('visible');
      setTimeout(() => {
        modal.style.display = 'none';
      }, 200);
    }
  }

  /**
   * Clear all caches
   */
  clearCache() {
    this.cache.clear();
    this.audioBuffer = null;
    this.isAudioLoaded = false;
  }

  /**
   * Force regenerate waveform (clears all caches)
   */
  async forceRegenerate() {
    window.logging.info('video', 'Waveform Force regenerating - clearing all caches..');
    
    this.clearCache();
    
    // Clear disk cache
    if (this.app.videoPath) {
      await this.cache.deleteDiskCache(this.app.videoPath);
    }
    
    return this.generate(true);
  }

  /**
   * Debounced regeneration for zoom changes
   */
  debouncedRegenerate() {
    if (this._regenerateTimeout) {
      clearTimeout(this._regenerateTimeout);
    }
    this._regenerateTimeout = setTimeout(() => {
      window.logging.info('video', 'Waveform Regenerating for new zoom tier');
      this.generate();
    }, 150);
  }

  /**
   * Check if zoom tier changed
   */
  didTierChange(oldZoom, newZoom) {
    const oldTier = this.tierDefs.find(t => oldZoom <= t.maxZoom);
    const newTier = this.tierDefs.find(t => newZoom <= t.maxZoom);
    return oldTier?.samplesPerSec !== newTier?.samplesPerSec;
  }

  /**
   * Main generate function
   * @param {boolean} forceRegenerate - Skip all caches
   */
  async generate(forceRegenerate = false) {
    if (forceRegenerate) {
      window.logging.info('video', 'Waveform Force regeneration requested');
      this.clearCache();
    }
    
    if (!this.app.videoPath) return;

    const canvas = document.getElementById('audioWaveform');
    const ctx = canvas.getContext('2d');

    // Get dimensions and alignment info
    const alignInfo = this._getAlignmentInfo(canvas);
    const { width, height, rulerWidth, offsetX } = alignInfo;
    const duration = this.app.videoInfo?.duration || 0;

    // Setup canvas for retina
    this._setupCanvas(canvas, ctx, width, height);

    // Get current tier
    const currentZoom = this.app.zoom || 1;
    const tier = this.tierDefs.find(t => currentZoom <= t.maxZoom) || 
                 this.tierDefs[this.tierDefs.length - 1];

    // Cap samples
    const maxSamples = width * 2;
    const rawSamples = Math.floor(duration * tier.samplesPerSec);
    const numSamples = Math.min(maxSamples, Math.max(width, rawSamples));
    window.logging.info('video', 'Waveform zoom', { zoom: currentZoom + 'x', samples: numSamples });

    // Try cached image first (include DPR to invalidate when display changes)
    const dpr = window.devicePixelRatio || 1;
    const imageKey = `${this.type}_${tier.samplesPerSec}_dpr${dpr}`;
    
    if (!forceRegenerate) {
      // Check memory cache
      const cachedImage = this.cache.getImage(imageKey);
      if (this.cache.isValidFor(this.app.videoPath) && cachedImage) {
        await this._drawCachedImage(ctx, cachedImage, width, height);
        return;
      }
      
      // Check disk cache
      const diskResult = await this.cache.loadImageFromDisk(this.app.videoPath, imageKey);
      if (diskResult.exists && diskResult.dataUrl) {
        await this._drawCachedImage(ctx, diskResult.dataUrl, width, height);
        return;
      }
    }

    // Show loading state
    canvas.classList.add('loading');
    canvas.classList.remove('ready');
    this._startLoadingAnimation(ctx, width, height);

    try {
      let peaks = null;
      let method = 'unknown';

      // Check for cached tier peaks
      if (this.cache.isValidFor(this.app.videoPath)) {
        peaks = this.cache.getTierPeaks(tier.samplesPerSec);
        if (peaks) {
          method = 'cached';
          window.logging.info('video', 'Waveform Using cached tier peaks');
        }
      }

      // Generate if not cached
      if (!peaks) {
        // Initialize cache for new video
        if (!this.cache.isValidFor(this.app.videoPath)) {
          this.cache.initForVideo(this.app.videoPath, duration);
          
          // Try disk cache for master peaks
          const diskMaster = await this.cache.loadMasterPeaksFromDisk(this.app.videoPath);
          if (diskMaster.exists) {
            method = 'disk-cache';
          }
        }

        // Generate master peaks if needed
        if (!this.cache.masterPeaks) {
          const rawMasterSamples = Math.floor(duration * 500);
          const masterSamples = Math.min(50000, rawMasterSamples);
          window.logging.info('video', 'Waveform Generating master peaks', { data: masterSamples });

          try {
            this.cache.setMasterPeaks(await this._extractPeaksWebAudio(masterSamples));
            method = 'webaudio';
          } catch (e) {
            window.logging.warn('video', 'Waveform Web Audio failed', { data: e.message });
            try {
              this.cache.setMasterPeaks(await this._extractPeaksFromVideo(masterSamples));
              method = 'video-element';
            } catch (e2) {
              window.logging.warn('video', 'Waveform Video element failed', { data: e2.message });
              const result = await window.videoEditor.getWaveform(this.app.videoPath, { samples: masterSamples });
              if (result.error) throw new Error(result.error);
              this.cache.setMasterPeaks(result.peaks || []);
              method = 'ffmpeg';
            }
          }

          // Save to disk
          this.cache.saveMasterPeaksToDisk(this.app.videoPath, duration);
        }

        // Downsample to current tier
        peaks = this.cache.downsamplePeaks(this.cache.masterPeaks, numSamples);
        this.cache.setTierPeaks(tier.samplesPerSec, peaks);
      }

      // Stop loading animation
      this._stopLoadingAnimation();
      canvas.classList.remove('loading');
      canvas.classList.add('ready');

      // Draw based on type
      const drawAlignInfo = { rulerWidth: width, offsetX, canvasWidth: width };
      await this._draw(ctx, width, height, peaks, duration, method, drawAlignInfo);

      // Cache rendered image
      try {
        const dataUrl = canvas.toDataURL('image/png');
        this.cache.setImage(imageKey, dataUrl);
        this.cache.saveImageToDisk(this.app.videoPath, imageKey, dataUrl);
      } catch (e) {
        window.logging.warn('video', 'Waveform Could not cache image', { data: e.message });
      }

    } catch (error) {
      window.logging.error('video', 'Waveform Generation failed', { error: error.message || error });
      this._stopLoadingAnimation();
      this.types.drawError(ctx, width, height, 'Could not analyze audio');
    }
  }

  /**
   * Get canvas alignment info relative to ruler
   */
  _getAlignmentInfo(canvas) {
    const rulerMarks = document.getElementById('rulerMarks');
    const audioClip = canvas.closest('.timeline-clip');
    const height = canvas.offsetHeight;
    
    let rulerWidth = canvas.offsetWidth;
    let offsetX = 0;
    
    if (rulerMarks && audioClip) {
      const rulerRect = rulerMarks.getBoundingClientRect();
      const clipRect = audioClip.getBoundingClientRect();
      rulerWidth = rulerRect.width;
      offsetX = rulerRect.left - clipRect.left;
    }
    
    const maxCanvasWidth = 16000;
    const width = Math.min(Math.ceil(rulerWidth), maxCanvasWidth);
    
    window.logging.info('video', 'Waveform Alignment - Canvas', { data: width, 'Ruler:', rulerWidth.toFixed(0 }), 'Offset:', offsetX.toFixed(1));
    
    return { width, height, rulerWidth, offsetX };
  }

  /**
   * Setup canvas for retina/HiDPI display
   */
  _setupCanvas(canvas, ctx, width, height) {
    const dpr = window.devicePixelRatio || 1;
    
    // Set buffer size (actual pixels)
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    
    // Set display size (CSS pixels)
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    
    // Scale context to match devicePixelRatio
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * Draw cached image to canvas
   */
  _drawCachedImage(ctx, dataUrl, width, height) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = ctx.canvas;
        // Reset transform and draw at actual canvas buffer size to avoid blur
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        ctx.restore();
        canvas.classList.remove('loading');
        canvas.classList.add('ready');
        window.logging.info('video', 'Waveform Used cached image');
        resolve();
      };
      img.src = dataUrl;
    });
  }

  /**
   * Main draw dispatcher
   */
  async _draw(ctx, width, height, peaks, duration, method, alignInfo) {
    switch (this.type) {
      case 'line':
        this.types.drawLine(ctx, width, height, peaks, duration, method, alignInfo);
        break;
      case 'mirror':
        this.types.drawMirror(ctx, width, height, peaks, duration, method, alignInfo);
        break;
      case 'spectrogram':
        await this.types.drawSpectrogram(ctx, width, height, duration, this.audioBuffer, alignInfo);
        break;
      default:
        this.types.drawBars(ctx, width, height, peaks, duration, method, alignInfo);
    }

    // Text overlays removed for cleaner visualization
  }

  /**
   * Draw transcript words on waveform
   */
  _drawTranscript(ctx, width, height, duration, alignInfo = {}) {
    if (!this.app.transcriptSegments?.length) return;
    
    const { rulerWidth = width, offsetX = 0 } = alignInfo;
    
    ctx.save();
    
    // Get words from teleprompter module or expand directly
    const words = this.app.teleprompter?.expandTranscriptToWords(this.app.transcriptSegments) || 
                  this._expandTranscriptToWords(this.app.transcriptSegments);
    
    window.logging.info('video', 'Waveform Drawing', { data: words.length, 'words' });
    
    ctx.font = 'bold 10px system-ui, -apple-system, sans-serif';
    ctx.textBaseline = 'middle';
    
    let lastWordEndX = -100;
    const minGap = 4;
    
    words.forEach((wordData) => {
      const startTime = wordData.start || 0;
      const endTime = wordData.end || (startTime + 0.3);
      const text = (wordData.text || '').trim();
      
      if (!text) return;
      
      const startX = (startTime / duration) * rulerWidth + offsetX;
      const endX = (endTime / duration) * rulerWidth + offsetX;
      const segmentWidth = Math.max(endX - startX, 20);
      
      if (startX < lastWordEndX + minGap) return;
      
      const textWidth = ctx.measureText(text).width;
      
      // Background
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fillRect(startX, height - 20, Math.min(textWidth + 6, segmentWidth), 16);
      
      // Text
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.textAlign = 'left';
      ctx.fillText(text, startX + 3, height - 12, segmentWidth - 6);
      
      lastWordEndX = startX + textWidth + 6;
    });
    
    ctx.restore();
  }

  /**
   * Expand transcript segments to individual words
   */
  _expandTranscriptToWords(segments) {
    const words = [];
    segments.forEach(segment => {
      const text = (segment.text || segment.word || '').trim();
      const startTime = segment.start || 0;
      const endTime = segment.end || (startTime + 1);
      
      if (!text.includes(' ')) {
        if (text.length > 0) {
          words.push({ text, start: startTime, end: endTime });
        }
        return;
      }
      
      const segmentWords = text.split(/\s+/).filter(w => w.length > 0);
      const wordDuration = (endTime - startTime) / segmentWords.length;
      
      segmentWords.forEach((word, i) => {
        words.push({
          text: word,
          start: startTime + (i * wordDuration),
          end: startTime + ((i + 1) * wordDuration)
        });
      });
    });
    return words;
  }

  /**
   * Extract audio peaks using Web Audio API
   */
  async _extractPeaksWebAudio(numSamples) {
    const video = document.getElementById('videoPlayer');
    if (!video?.src) throw new Error('No video source');
    
    await this._initAudioContext();
    
    const response = await fetch(video.src);
    if (!response.ok) throw new Error('Fetch failed');
    
    const arrayBuffer = await response.arrayBuffer();
    const decodedBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
    
    window.logging.info('video', 'Waveform decoded audio', {
      duration: decodedBuffer.duration.toFixed(2) + 's',
      sampleRate: decodedBuffer.sampleRate,
      channels: decodedBuffer.numberOfChannels
    });
    
    // Store for scrubbing and spectrogram
    this.audioBuffer = decodedBuffer;
    this.isAudioLoaded = true;
    window.logging.info('video', 'Waveform Audio buffer shared for scrubbing');
    this.app.showToast?.('success', 'Audio scrubbing ready');
    
    // Get channel data
    let channelData;
    if (decodedBuffer.numberOfChannels === 1) {
      channelData = decodedBuffer.getChannelData(0);
    } else {
      const left = decodedBuffer.getChannelData(0);
      const right = decodedBuffer.getChannelData(1);
      channelData = new Float32Array(left.length);
      for (let i = 0; i < left.length; i++) {
        channelData[i] = (left[i] + right[i]) / 2;
      }
    }
    
    return this._calculatePeaks(channelData, numSamples);
  }

  /**
   * Extract peaks from video element
   */
  async _extractPeaksFromVideo(numSamples) {
    const video = document.getElementById('videoPlayer');
    if (!video) throw new Error('No video element');
    
    return new Promise((resolve, reject) => {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      
      try {
        const source = audioCtx.createMediaElementSource(video);
        source.connect(analyser);
        analyser.connect(audioCtx.destination);
        
        const peaks = [];
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        
        const duration = video.duration;
        const interval = duration / numSamples;
        let currentSample = 0;
        
        const collectSample = () => {
          if (currentSample >= numSamples) {
            source.disconnect();
            audioCtx.close();
            resolve(peaks);
            return;
          }
          
          analyser.getByteTimeDomainData(dataArray);
          
          let max = 0;
          for (let i = 0; i < bufferLength; i++) {
            const val = Math.abs(dataArray[i] - 128) / 128;
            if (val > max) max = val;
          }
          
          peaks.push(max);
          currentSample++;
          video.currentTime = currentSample * interval;
        };
        
        video.addEventListener('seeked', collectSample, { once: false });
        video.currentTime = 0;
        
      } catch (e) {
        audioCtx.close();
        reject(e);
      }
    });
  }

  /**
   * Calculate peaks from raw audio data
   */
  _calculatePeaks(channelData, numSamples) {
    const samplesPerPeak = Math.max(1, Math.floor(channelData.length / numSamples));
    const peaks = new Float32Array(numSamples);

    for (let i = 0; i < numSamples; i++) {
      const start = i * samplesPerPeak;
      const end = Math.min(start + samplesPerPeak, channelData.length);

      let max = 0;
      for (let j = start; j < end; j++) {
        const abs = Math.abs(channelData[j]);
        if (abs > max) max = abs;
      }
      peaks[i] = max;
    }

    // Normalize using 95th percentile
    const sorted = Array.from(peaks).sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
    const normalizer = p95 > 0.01 ? p95 : 1;

    for (let i = 0; i < numSamples; i++) {
      peaks[i] = Math.min(1, peaks[i] / normalizer * 0.8);
    }

    return peaks;
  }

  /**
   * Initialize shared audio context
   */
  async _initAudioContext() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  /**
   * Start loading animation
   */
  _startLoadingAnimation(ctx, width, height) {
    this._stopLoadingAnimation();
    
    let pulsePhase = 0;
    const animate = () => {
      pulsePhase += 0.05;
      this.types.drawLoading(ctx, width, height, 'Analyzing audio...', pulsePhase);
      this._loadingAnimation = requestAnimationFrame(animate);
    };
    animate();
  }

  /**
   * Stop loading animation
   */
  _stopLoadingAnimation() {
    if (this._loadingAnimation) {
      cancelAnimationFrame(this._loadingAnimation);
      this._loadingAnimation = null;
    }
  }

  /**
   * Render waveform for an individual audio track
   * @param {string} trackId - Track ID
   * @param {string} audioPath - Path to the audio file
   * @param {HTMLElement} container - Container element to render into
   * @param {Object} options - Rendering options
   */
  async renderTrackWaveform(trackId, audioPath, container, options = {}) {
    if (!audioPath || !container) {
      window.logging.error('video', 'Waveform renderTrackWaveform: Missing audioPath or container');
      return;
    }

    const {
      height = 60,
      color = '#4a9eff',
      backgroundColor = '#1a1a2e',
      type = 'bars', // 'bars', 'line', 'mirror'
      clipStartTime = 0,
      clipDuration = null
    } = options;

    // Create or get canvas
    let canvas = container.querySelector(`canvas[data-track-id="${trackId}"]`);
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.dataset.trackId = trackId;
      canvas.className = 'track-waveform-canvas';
      container.appendChild(canvas);
    }

    // Size canvas to container
    const width = container.offsetWidth || 200;
    canvas.width = width * (window.devicePixelRatio || 1);
    canvas.height = height * (window.devicePixelRatio || 1);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);

    // Clear canvas
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, width, height);

    // Show loading state
    ctx.fillStyle = '#666';
    ctx.font = '10px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('Loading...', width / 2, height / 2);

    try {
      // Check cache first
      const cacheKey = `track_${trackId}_${audioPath}`;
      let peaks = this.cache.get(cacheKey);

      if (!peaks) {
        // Load audio file and generate peaks
        await this._initAudioContext();
        
        // Fetch audio data (cross-platform)
        const response = await fetch(pathToFileUrl(audioPath));
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);

        // Generate peaks for the clip portion
        const startSample = Math.floor(clipStartTime * audioBuffer.sampleRate);
        const numSamples = clipDuration 
          ? Math.floor(clipDuration * audioBuffer.sampleRate)
          : audioBuffer.length - startSample;

        peaks = this._generatePeaksForRange(audioBuffer, startSample, numSamples, width);
        
        // Cache the result
        this.cache.set(cacheKey, peaks);
      }

      // Clear and draw
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, width, height);

      // Draw based on type
      this._drawTrackWaveform(ctx, peaks, width, height, color, type);

    } catch (error) {
      window.logging.error('video', 'Waveform renderTrackWaveform error', { error: error.message || error });
      
      // Show error state
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#ef4444';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('Failed to load', width / 2, height / 2);
    }
  }

  /**
   * Generate peaks for a specific range of the audio buffer
   */
  _generatePeaksForRange(audioBuffer, startSample, numSamples, numPeaks) {
    const channelData = audioBuffer.getChannelData(0);
    const peaks = new Float32Array(numPeaks);
    const samplesPerPeak = Math.floor(numSamples / numPeaks);

    for (let i = 0; i < numPeaks; i++) {
      const start = startSample + (i * samplesPerPeak);
      const end = Math.min(start + samplesPerPeak, channelData.length);

      let max = 0;
      for (let j = start; j < end; j++) {
        if (j >= 0 && j < channelData.length) {
          const abs = Math.abs(channelData[j]);
          if (abs > max) max = abs;
        }
      }
      peaks[i] = max;
    }

    // Normalize
    const sorted = Array.from(peaks).sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
    const normalizer = p95 > 0.01 ? p95 : 1;

    for (let i = 0; i < numPeaks; i++) {
      peaks[i] = Math.min(1, peaks[i] / normalizer * 0.8);
    }

    return peaks;
  }

  /**
   * Draw waveform for track
   */
  _drawTrackWaveform(ctx, peaks, width, height, color, type) {
    const barWidth = Math.max(1, width / peaks.length);
    const midY = height / 2;

    ctx.fillStyle = color;

    switch (type) {
      case 'bars':
        for (let i = 0; i < peaks.length; i++) {
          const x = i * barWidth;
          const barHeight = peaks[i] * height * 0.9;
          ctx.fillRect(x, midY - barHeight / 2, Math.max(1, barWidth - 1), barHeight);
        }
        break;

      case 'line':
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, midY);
        for (let i = 0; i < peaks.length; i++) {
          const x = i * barWidth;
          const y = midY - (peaks[i] * height * 0.45);
          ctx.lineTo(x, y);
        }
        ctx.stroke();
        
        ctx.beginPath();
        ctx.moveTo(0, midY);
        for (let i = 0; i < peaks.length; i++) {
          const x = i * barWidth;
          const y = midY + (peaks[i] * height * 0.45);
          ctx.lineTo(x, y);
        }
        ctx.stroke();
        break;

      case 'mirror':
        for (let i = 0; i < peaks.length; i++) {
          const x = i * barWidth;
          const barHeight = peaks[i] * height * 0.45;
          // Top half
          ctx.fillRect(x, midY - barHeight, Math.max(1, barWidth - 1), barHeight);
          // Bottom half (slightly dimmer)
          ctx.globalAlpha = 0.6;
          ctx.fillRect(x, midY, Math.max(1, barWidth - 1), barHeight);
          ctx.globalAlpha = 1;
        }
        break;

      default:
        // Default to bars
        for (let i = 0; i < peaks.length; i++) {
          const x = i * barWidth;
          const barHeight = peaks[i] * height * 0.9;
          ctx.fillRect(x, midY - barHeight / 2, Math.max(1, barWidth - 1), barHeight);
        }
    }
  }

  /**
   * Render waveforms for all clips on a track
   * @param {Object} track - Track object with clips array
   */
  async renderTrackClipWaveforms(track) {
    if (!track || !track.clips || track.clips.length === 0) {
      return;
    }

    const trackEl = document.querySelector(`#track-${track.id} .track-clips-container`);
    if (!trackEl) {
      window.logging.warn('video', 'Waveform Track clips container not found', { data: track.id });
      return;
    }

    // Render waveform for each clip
    for (const clip of track.clips) {
      const clipEl = trackEl.querySelector(`[data-clip-id="${clip.id}"]`);
      if (clipEl && clip.path) {
        await this.renderTrackWaveform(
          clip.id,
          clip.path,
          clipEl,
          {
            color: clip.color || track.color || '#4a9eff',
            clipStartTime: clip.offset || 0,
            clipDuration: clip.duration
          }
        );
      }
    }
  }
}


















