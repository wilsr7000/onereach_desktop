/**
 * PlaybackController - Controls video playback
 * @module src/agentic-player/core/PlaybackController
 */

/**
 * Playback controller class
 */
export class PlaybackController {
  constructor(videoElement) {
    this.video = videoElement;
    this.currentClip = null;
    this.currentEndTime = null;
    
    this.onClipEnd = null; // Callback when clip ends
    this.onTimeUpdate = null; // Callback for time updates
  }

  /**
   * Setup video event listeners
   */
  setupEvents() {
    this.video.addEventListener('timeupdate', () => this.handleTimeUpdate());
    this.video.addEventListener('ended', () => this.handleEnded());
    this.video.addEventListener('play', () => this.handlePlayStateChange());
    this.video.addEventListener('pause', () => this.handlePlayStateChange());
    this.video.addEventListener('error', (e) => this.handleError(e));
  }

  /**
   * Load and play a clip
   * @param {Object} clip - Clip to play
   * @param {boolean} fromPreload - Whether using preloaded video
   */
  loadClip(clip, fromPreload = false) {
    this.currentClip = clip;
    this.currentEndTime = clip.outTime;

    const videoUrl = clip.videoUrl || clip.videoSrc;
    const startTime = clip.inTime || 0;

    console.log(`[PlaybackController] Loading: "${clip.name}" from ${videoUrl}`);

    if (fromPreload) {
      // Already loaded, just set time
      this.video.currentTime = startTime;
      this.play();
      return;
    }

    // Check if we need to change source
    const needsNewSource = !this.video.src || 
      (videoUrl.startsWith('http') ? this.video.src !== videoUrl : !this.video.src.endsWith(videoUrl));

    if (needsNewSource) {
      this.video.src = videoUrl;
      this.video.addEventListener('loadedmetadata', () => {
        this.video.currentTime = startTime;
        this.play();
      }, { once: true });
    } else {
      this.video.currentTime = startTime;
      this.play();
    }
  }

  /**
   * Play video
   */
  play() {
    this.video.play().catch(e => console.warn('[PlaybackController] Autoplay blocked:', e));
  }

  /**
   * Pause video
   */
  pause() {
    this.video.pause();
  }

  /**
   * Toggle play/pause
   */
  togglePlay() {
    if (this.video.paused) {
      this.play();
    } else {
      this.pause();
    }
  }

  /**
   * Toggle mute
   */
  toggleMute() {
    this.video.muted = !this.video.muted;
    return this.video.muted;
  }

  /**
   * Handle time update
   */
  handleTimeUpdate() {
    const currentTime = this.video.currentTime;
    
    // Check if clip should end
    if (this.currentEndTime && currentTime >= this.currentEndTime - 0.1) {
      this.handleEnded();
      return;
    }

    // Notify listeners
    if (this.onTimeUpdate) {
      this.onTimeUpdate({
        currentTime,
        duration: this.video.duration,
        remainingInClip: this.currentEndTime ? this.currentEndTime - currentTime : null
      });
    }
  }

  /**
   * Handle video ended
   */
  handleEnded() {
    const clip = this.currentClip;
    this.currentClip = null;
    this.currentEndTime = null;

    if (this.onClipEnd) {
      this.onClipEnd(clip);
    }
  }

  /**
   * Handle play state change
   */
  handlePlayStateChange() {
    // Can be overridden or subscribed to
  }

  /**
   * Handle video error
   */
  handleError(e) {
    console.error('[PlaybackController] Video error:', e);
  }

  /**
   * Skip current clip
   */
  skipClip() {
    this.currentEndTime = null;
    this.handleEnded();
  }

  /**
   * Get current state
   */
  get state() {
    return {
      isPlaying: !this.video.paused,
      isMuted: this.video.muted,
      currentTime: this.video.currentTime,
      duration: this.video.duration,
      currentClip: this.currentClip
    };
  }
}
















