/**
 * RecordingController - Controls recording state
 * @module src/recorder/core/RecordingController
 */

/**
 * Recording controller class
 */
export class RecordingController {
  constructor() {
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.isRecording = false;
    this.isPaused = false;
    this.startTime = null;
    this.duration = 0;
    this.durationInterval = null;
    
    this.onDataAvailable = null;
    this.onStop = null;
    this.onDurationUpdate = null;
  }

  /**
   * Start recording
   * @param {MediaStream} stream - Stream to record
   * @param {Object} options - Recording options
   */
  start(stream, options = {}) {
    const {
      mimeType = 'video/webm;codecs=vp9,opus',
      videoBitsPerSecond = 5000000
    } = options;

    // Check for supported MIME type
    const supportedMimeType = this.getSupportedMimeType(mimeType);
    
    this.mediaRecorder = new MediaRecorder(stream, {
      mimeType: supportedMimeType,
      videoBitsPerSecond
    });

    this.recordedChunks = [];

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.recordedChunks.push(event.data);
        if (this.onDataAvailable) {
          this.onDataAvailable(event.data);
        }
      }
    };

    this.mediaRecorder.onstop = () => {
      this.stopDurationTracking();
      if (this.onStop) {
        const blob = this.getBlob();
        this.onStop(blob);
      }
    };

    this.mediaRecorder.start(1000); // Collect data every second
    this.isRecording = true;
    this.isPaused = false;
    this.startTime = Date.now();
    this.duration = 0;
    
    this.startDurationTracking();

    console.log('[RecordingController] Started recording');
  }

  /**
   * Get supported MIME type
   * @param {string} preferred - Preferred MIME type
   * @returns {string} Supported MIME type
   */
  getSupportedMimeType(preferred) {
    const types = [
      preferred,
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4'
    ];

    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        console.log('[RecordingController] Using MIME type:', type);
        return type;
      }
    }

    throw new Error('No supported MIME type found');
  }

  /**
   * Pause recording
   */
  pause() {
    if (this.mediaRecorder && this.isRecording && !this.isPaused) {
      this.mediaRecorder.pause();
      this.isPaused = true;
      console.log('[RecordingController] Paused');
    }
  }

  /**
   * Resume recording
   */
  resume() {
    if (this.mediaRecorder && this.isRecording && this.isPaused) {
      this.mediaRecorder.resume();
      this.isPaused = false;
      console.log('[RecordingController] Resumed');
    }
  }

  /**
   * Stop recording
   * @returns {Promise<Blob>} Recorded blob
   */
  stop() {
    return new Promise((resolve) => {
      if (!this.mediaRecorder || !this.isRecording) {
        resolve(null);
        return;
      }

      this.mediaRecorder.onstop = () => {
        this.stopDurationTracking();
        this.isRecording = false;
        this.isPaused = false;
        
        const blob = this.getBlob();
        console.log('[RecordingController] Stopped, size:', blob.size);
        
        if (this.onStop) {
          this.onStop(blob);
        }
        resolve(blob);
      };

      this.mediaRecorder.stop();
    });
  }

  /**
   * Get recorded blob
   * @returns {Blob} Video blob
   */
  getBlob() {
    if (this.recordedChunks.length === 0) return null;
    return new Blob(this.recordedChunks, { 
      type: this.mediaRecorder?.mimeType || 'video/webm' 
    });
  }

  /**
   * Start duration tracking
   */
  startDurationTracking() {
    this.durationInterval = setInterval(() => {
      if (!this.isPaused) {
        this.duration = Math.floor((Date.now() - this.startTime) / 1000);
        if (this.onDurationUpdate) {
          this.onDurationUpdate(this.duration);
        }
      }
    }, 1000);
  }

  /**
   * Stop duration tracking
   */
  stopDurationTracking() {
    if (this.durationInterval) {
      clearInterval(this.durationInterval);
      this.durationInterval = null;
    }
  }

  /**
   * Get current state
   */
  get state() {
    return {
      isRecording: this.isRecording,
      isPaused: this.isPaused,
      duration: this.duration
    };
  }
}
















