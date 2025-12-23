/**
 * WaveformCache - Memory and disk caching for waveform data
 * Handles tiered caching, peak storage, and rendered images
 */
export class WaveformCache {
  constructor(appContext) {
    this.app = appContext;
    
    // Cache state
    this.cachePath = null;     // Current video path being cached
    this.tiers = {};           // Tier-specific peak data
    this.images = {};          // Rendered image data URLs
    this.masterPeaks = null;   // High-resolution master peaks
    this.duration = 0;         // Cached video duration
  }

  /**
   * Check if cache is valid for the given video path
   */
  isValidFor(videoPath) {
    return this.cachePath === videoPath && this.masterPeaks !== null;
  }

  /**
   * Get cached image if available
   * @param {string} imageKey - Key like "spectrogram_100"
   * @returns {string|null} Data URL or null
   */
  getImage(imageKey) {
    return this.images?.[imageKey] || null;
  }

  /**
   * Store rendered image in memory cache
   */
  setImage(imageKey, dataUrl) {
    if (!this.images) this.images = {};
    this.images[imageKey] = dataUrl;
    console.log('[WaveformCache] Cached image in memory:', imageKey);
  }

  /**
   * Get cached tier peaks
   * @param {number} samplesPerSec - Tier resolution
   * @returns {Float32Array|null}
   */
  getTierPeaks(samplesPerSec) {
    const tierKey = `tier_${samplesPerSec}`;
    return this.tiers?.[tierKey] || null;
  }

  /**
   * Store tier peaks
   */
  setTierPeaks(samplesPerSec, peaks) {
    const tierKey = `tier_${samplesPerSec}`;
    if (!this.tiers) this.tiers = {};
    this.tiers[tierKey] = peaks;
    console.log('[WaveformCache] Stored tier:', tierKey, 'with', peaks.length, 'samples');
  }

  /**
   * Clear all caches (call when loading new video)
   */
  clear() {
    this.tiers = {};
    this.images = {};
    this.masterPeaks = null;
    this.cachePath = null;
    this.duration = 0;
    console.log('[WaveformCache] Cleared all caches');
  }

  /**
   * Initialize cache for a new video
   */
  initForVideo(videoPath, duration) {
    this.clear();
    this.cachePath = videoPath;
    this.duration = duration;
  }

  /**
   * Store master peaks (highest resolution)
   */
  setMasterPeaks(peaks) {
    this.masterPeaks = peaks;
    console.log('[WaveformCache] Stored master peaks:', peaks.length);
  }

  /**
   * Load cached image from disk
   * @returns {Promise<{exists: boolean, dataUrl?: string}>}
   */
  async loadImageFromDisk(videoPath, imageKey) {
    if (!window.videoEditor?.loadWaveformImage) {
      return { exists: false };
    }
    
    try {
      const result = await window.videoEditor.loadWaveformImage(videoPath, imageKey);
      if (result.exists && result.dataUrl) {
        // Also store in memory
        this.setImage(imageKey, result.dataUrl);
        console.log('[WaveformCache] Loaded from disk:', imageKey);
      }
      return result;
    } catch (e) {
      console.log('[WaveformCache] Disk load failed:', e.message);
      return { exists: false };
    }
  }

  /**
   * Save rendered image to disk
   */
  async saveImageToDisk(videoPath, imageKey, dataUrl) {
    if (!window.videoEditor?.saveWaveformImage) {
      return { success: false };
    }
    
    try {
      const result = await window.videoEditor.saveWaveformImage(videoPath, imageKey, dataUrl);
      if (result.success) {
        console.log('[WaveformCache] Saved to disk:', imageKey);
      }
      return result;
    } catch (e) {
      console.warn('[WaveformCache] Disk save failed:', e.message);
      return { success: false };
    }
  }

  /**
   * Load master peaks from disk cache
   */
  async loadMasterPeaksFromDisk(videoPath) {
    if (!window.videoEditor?.loadWaveformCache) {
      return { exists: false };
    }
    
    try {
      const result = await window.videoEditor.loadWaveformCache(videoPath);
      if (result.exists && result.masterPeaks) {
        this.masterPeaks = new Float32Array(result.masterPeaks);
        console.log('[WaveformCache] Loaded master peaks from disk:', this.masterPeaks.length);
        return { exists: true, peaks: this.masterPeaks };
      }
      return { exists: false };
    } catch (e) {
      console.log('[WaveformCache] No disk cache available');
      return { exists: false };
    }
  }

  /**
   * Save master peaks to disk
   */
  async saveMasterPeaksToDisk(videoPath, duration) {
    if (!window.videoEditor?.saveWaveformCache || !this.masterPeaks) {
      return { success: false };
    }
    
    try {
      const result = await window.videoEditor.saveWaveformCache(videoPath, {
        masterPeaks: Array.from(this.masterPeaks),
        duration: duration,
        timestamp: Date.now()
      });
      if (result.success) {
        console.log('[WaveformCache] Master peaks saved to disk');
      }
      return result;
    } catch (e) {
      console.warn('[WaveformCache] Could not save peaks to disk:', e.message);
      return { success: false };
    }
  }

  /**
   * Delete all disk cache for a video
   */
  async deleteDiskCache(videoPath) {
    if (!window.videoEditor?.deleteWaveformCache) {
      return { success: false };
    }
    
    try {
      const result = await window.videoEditor.deleteWaveformCache(videoPath);
      console.log('[WaveformCache] Disk cache deleted:', result);
      return result;
    } catch (e) {
      console.warn('[WaveformCache] Could not delete disk cache:', e.message);
      return { success: false };
    }
  }

  /**
   * Downsample peaks using max-pooling (preserves peaks for word gaps)
   */
  downsamplePeaks(masterPeaks, targetCount) {
    if (!masterPeaks || masterPeaks.length <= targetCount) {
      return masterPeaks;
    }
    
    const result = new Float32Array(targetCount);
    const ratio = masterPeaks.length / targetCount;
    
    for (let i = 0; i < targetCount; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.floor((i + 1) * ratio);
      let max = 0;
      for (let j = start; j < end && j < masterPeaks.length; j++) {
        if (masterPeaks[j] > max) max = masterPeaks[j];
      }
      result[i] = max;
    }
    
    return result;
  }
}


















