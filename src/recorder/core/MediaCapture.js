/**
 * MediaCapture - Camera and screen capture handling
 * @module src/recorder/core/MediaCapture
 */

/**
 * Media capture class
 */
export class MediaCapture {
  constructor() {
    this.cameraStream = null;
    this.screenStream = null;
    this.combinedStream = null;
  }

  /**
   * Request camera access
   * @param {Object} options - Camera options
   * @returns {Promise<MediaStream>} Camera stream
   */
  async requestCamera(options = {}) {
    const {
      video = true,
      audio = true,
      width = 1920,
      height = 1080
    } = options;

    try {
      this.cameraStream = await navigator.mediaDevices.getUserMedia({
        video: video ? {
          width: { ideal: width },
          height: { ideal: height },
          facingMode: 'user'
        } : false,
        audio: audio
      });

      console.log('[MediaCapture] Camera stream acquired');
      return this.cameraStream;

    } catch (error) {
      console.error('[MediaCapture] Camera access denied:', error);
      throw error;
    }
  }

  /**
   * Request screen capture
   * @param {Object} options - Screen options
   * @returns {Promise<MediaStream>} Screen stream
   */
  async requestScreen(options = {}) {
    const {
      audio = true,
      systemAudio = true
    } = options;

    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always'
        },
        audio: systemAudio
      });

      console.log('[MediaCapture] Screen stream acquired');
      return this.screenStream;

    } catch (error) {
      console.error('[MediaCapture] Screen capture denied:', error);
      throw error;
    }
  }

  /**
   * Combine camera and screen streams
   * @returns {MediaStream} Combined stream
   */
  combineStreams() {
    if (!this.cameraStream && !this.screenStream) {
      throw new Error('No streams to combine');
    }

    const tracks = [];

    // Add video tracks
    if (this.screenStream) {
      const screenVideo = this.screenStream.getVideoTracks()[0];
      if (screenVideo) tracks.push(screenVideo);
    }
    if (this.cameraStream) {
      const cameraVideo = this.cameraStream.getVideoTracks()[0];
      if (cameraVideo) tracks.push(cameraVideo);
    }

    // Add audio tracks
    if (this.cameraStream) {
      const cameraAudio = this.cameraStream.getAudioTracks()[0];
      if (cameraAudio) tracks.push(cameraAudio);
    }
    if (this.screenStream) {
      const screenAudio = this.screenStream.getAudioTracks()[0];
      if (screenAudio) tracks.push(screenAudio);
    }

    this.combinedStream = new MediaStream(tracks);
    console.log('[MediaCapture] Streams combined:', tracks.length, 'tracks');
    return this.combinedStream;
  }

  /**
   * Get available devices
   * @returns {Promise<Object>} Device lists
   */
  async getDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    
    return {
      cameras: devices.filter(d => d.kind === 'videoinput'),
      microphones: devices.filter(d => d.kind === 'audioinput'),
      speakers: devices.filter(d => d.kind === 'audiooutput')
    };
  }

  /**
   * Stop all streams
   */
  stopAll() {
    this.stopCamera();
    this.stopScreen();
    this.combinedStream = null;
  }

  /**
   * Stop camera stream
   */
  stopCamera() {
    if (this.cameraStream) {
      this.cameraStream.getTracks().forEach(track => track.stop());
      this.cameraStream = null;
      console.log('[MediaCapture] Camera stopped');
    }
  }

  /**
   * Stop screen stream
   */
  stopScreen() {
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(track => track.stop());
      this.screenStream = null;
      console.log('[MediaCapture] Screen stopped');
    }
  }

  /**
   * Check if has active streams
   */
  get hasActiveStreams() {
    return !!(this.cameraStream || this.screenStream);
  }
}
















