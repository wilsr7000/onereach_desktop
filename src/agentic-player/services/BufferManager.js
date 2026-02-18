/**
 * BufferManager - Manages video preloading
 * @module src/agentic-player/services/BufferManager
 */

const { getLogQueue } = require('../../../lib/log-event-queue');
const log = getLogQueue();
/**
 * Buffer manager class
 */
export class BufferManager {
  constructor() {
    this.preloadedVideo = null;
    this.preloadedClip = null;
  }

  /**
   * Preload next video for seamless transition
   * @param {Object} clip - Clip to preload
   * @returns {Promise<HTMLVideoElement>} Preloaded video element
   */
  async preloadNextVideo(clip) {
    if (!clip) return null;

    const videoUrl = clip.videoUrl || clip.videoSrc;
    if (!videoUrl) {
      log.warn('agent', '[BufferManager] No video URL for clip');
      return null;
    }

    // Clean up existing preload
    this.clearPreloaded();

    // Create hidden video element for preloading
    const preload = document.createElement('video');
    preload.src = videoUrl;
    preload.preload = 'auto';
    preload.muted = true;
    preload.style.display = 'none';
    preload.crossOrigin = 'anonymous';

    // Add to DOM (required for some browsers)
    document.body.appendChild(preload);

    // Start loading
    preload.load();

    return new Promise((resolve, reject) => {
      preload.addEventListener(
        'loadeddata',
        () => {
          log.info('agent', '[BufferManager] Preloaded:', { v0: clip.name });
          this.preloadedVideo = preload;
          this.preloadedClip = clip;
          resolve(preload);
        },
        { once: true }
      );

      preload.addEventListener(
        'error',
        (e) => {
          log.error('agent', '[BufferManager] Preload error', { error: e });
          preload.remove();
          reject(e);
        },
        { once: true }
      );
    });
  }

  /**
   * Get preloaded video if matches clip
   * @param {Object} clip - Clip to check
   * @returns {HTMLVideoElement|null} Preloaded video or null
   */
  getPreloadedVideo(clip) {
    if (!this.preloadedVideo || !this.preloadedClip) return null;

    const clipUrl = clip.videoUrl || clip.videoSrc;
    if (this.preloadedVideo.src.includes(clipUrl)) {
      return this.preloadedVideo;
    }

    return null;
  }

  /**
   * Transfer preloaded video to main player
   * @param {HTMLVideoElement} mainVideo - Main video element
   * @param {number} startTime - Start time
   */
  transferToMain(mainVideo, startTime = 0) {
    if (!this.preloadedVideo) return false;

    try {
      mainVideo.src = this.preloadedVideo.src;
      mainVideo.currentTime = startTime;
      mainVideo.muted = false;

      this.clearPreloaded();
      log.info('agent', '[BufferManager] Transfer complete');
      return true;
    } catch (error) {
      log.error('agent', '[BufferManager] Transfer error', { error: error });
      this.clearPreloaded();
      return false;
    }
  }

  /**
   * Clear preloaded video
   */
  clearPreloaded() {
    if (this.preloadedVideo) {
      this.preloadedVideo.pause();
      this.preloadedVideo.src = '';
      this.preloadedVideo.remove();
      this.preloadedVideo = null;
      this.preloadedClip = null;
    }
  }

  /**
   * Check if a clip is preloaded
   * @param {Object} clip - Clip to check
   * @returns {boolean} True if preloaded
   */
  isPreloaded(clip) {
    if (!this.preloadedClip) return false;
    return this.preloadedClip.id === clip.id;
  }
}
