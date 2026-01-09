/**
 * WaveformRenderer - Renders waveforms on audio clips
 * 
 * Features:
 * - Render waveform visualization for clips
 * - Caching for performance
 * - Customizable colors and styles
 */

export class WaveformRenderer {
  constructor(options = {}) {
    this.cache = new Map();
    this.maxCacheSize = options.maxCacheSize || 100;
    
    // Default styling
    this.colors = {
      waveform: options.waveformColor || '#4CAF50',
      waveformMuted: options.waveformMutedColor || '#666666',
      background: options.backgroundColor || 'transparent',
      centerLine: options.centerLineColor || 'rgba(255,255,255,0.1)'
    };
    
    console.log('[WaveformRenderer] Initialized');
  }
  
  /**
   * Render waveform for a clip on a canvas
   * @param {AudioBuffer} audioBuffer - Source audio buffer
   * @param {object} clip - Clip with sourceIn, sourceOut properties
   * @param {HTMLCanvasElement} canvas - Target canvas element
   * @param {object} options - { muted, color }
   */
  async renderClipWaveform(audioBuffer, clip, canvas, options = {}) {
    if (!audioBuffer || !canvas) return;
    
    const ctx = canvas.getContext('2d');
    const width = canvas.width || canvas.clientWidth;
    const height = canvas.height || canvas.clientHeight;
    
    if (width <= 0 || height <= 0) return;
    
    // Check cache
    const cacheKey = this.getCacheKey(clip, width, height);
    if (this.cache.has(cacheKey)) {
      const cachedImageData = this.cache.get(cacheKey);
      ctx.putImageData(cachedImageData, 0, 0);
      return;
    }
    
    // Clear canvas
    ctx.clearRect(0, 0, width, height);
    
    // Get audio data for clip's time range
    const sourceIn = clip.sourceIn ?? 0;
    const sourceOut = clip.sourceOut ?? audioBuffer.duration;
    
    const sampleRate = audioBuffer.sampleRate;
    const startSample = Math.floor(sourceIn * sampleRate);
    const endSample = Math.floor(sourceOut * sampleRate);
    const numSamples = endSample - startSample;
    
    if (numSamples <= 0) return;
    
    // Get channel data (use first channel or mix)
    const channelData = audioBuffer.getChannelData(0);
    
    // Determine color
    const color = options.muted ? this.colors.waveformMuted : (options.color || this.colors.waveform);
    
    // Draw waveform
    ctx.fillStyle = color;
    const samplesPerPixel = Math.ceil(numSamples / width);
    const centerY = height / 2;
    
    for (let i = 0; i < width; i++) {
      const sampleStart = startSample + (i * samplesPerPixel);
      const sampleEnd = Math.min(sampleStart + samplesPerPixel, endSample);
      
      // Find min/max in this pixel's sample range
      let min = 1;
      let max = -1;
      
      for (let j = sampleStart; j < sampleEnd && j < channelData.length; j++) {
        const sample = channelData[j];
        if (sample < min) min = sample;
        if (sample > max) max = sample;
      }
      
      // Draw the waveform bar
      const y1 = centerY + (min * centerY * 0.9); // 0.9 for padding
      const y2 = centerY + (max * centerY * 0.9);
      const barHeight = Math.max(1, y2 - y1);
      
      ctx.fillRect(i, y1, 1, barHeight);
    }
    
    // Draw center line
    ctx.strokeStyle = this.colors.centerLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(width, centerY);
    ctx.stroke();
    
    // Cache the result
    this.cacheWaveform(cacheKey, ctx.getImageData(0, 0, width, height));
  }
  
  /**
   * Generate a cache key for a clip
   */
  getCacheKey(clip, width, height) {
    return `${clip.id || 'clip'}-${clip.sourceIn?.toFixed(2)}-${clip.sourceOut?.toFixed(2)}-${width}x${height}`;
  }
  
  /**
   * Cache a waveform image
   */
  cacheWaveform(key, imageData) {
    // Enforce max cache size
    if (this.cache.size >= this.maxCacheSize) {
      // Remove oldest entry
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    this.cache.set(key, imageData);
  }
  
  /**
   * Clear the waveform cache
   */
  clearCache() {
    this.cache.clear();
    console.log('[WaveformRenderer] Cache cleared');
  }
  
  /**
   * Invalidate cache for a specific clip
   */
  invalidateClip(clipId) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(clipId + '-')) {
        this.cache.delete(key);
      }
    }
  }
  
  /**
   * Render waveforms for all clips in a track
   * @param {AudioBuffer} audioBuffer - Source audio buffer
   * @param {Array} clips - Array of clip objects
   * @param {HTMLElement} container - Container element with clip canvases
   */
  async renderTrackWaveforms(audioBuffer, clips, container) {
    if (!audioBuffer || !clips || !container) return;
    
    for (const clip of clips) {
      const canvas = container.querySelector(`[data-clip-id="${clip.id}"] .clip-waveform`);
      if (canvas) {
        await this.renderClipWaveform(audioBuffer, clip, canvas);
      }
    }
  }
  
  /**
   * Set waveform colors
   */
  setColors(colors) {
    Object.assign(this.colors, colors);
  }
  
  /**
   * Dispose of resources
   */
  dispose() {
    this.cache.clear();
    console.log('[WaveformRenderer] Disposed');
  }
}









